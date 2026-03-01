import type {
  PayBotConfig,
  PaymentRequest,
  PaymentResult,
  BalanceResult,
  TransactionHistoryItem,
  LimitsConfig,
  RegisterResult,
  HealthResult,
  TrustLevel,
  SignupResult,
  LoginResult,
  ApiKeyResult,
  ApiKeyListItem,
} from './types.js';
import { getErrorMessage, PayBotApiError } from './errors.js';
import { generateEIP3009Nonce } from './crypto.js';
import { EIP712_DOMAINS, EIP3009_TYPES, NETWORKS } from './networks.js';
import { privateKeyToAccount } from 'viem/accounts';

/**
 * PayBotClient — the SDK entry point for bot developers.
 *
 * Usage (mock mode):
 * ```typescript
 * const client = new PayBotClient({
 *   apiKey: 'pb_test_...',
 *   botId: 'my-bot',
 * });
 * ```
 *
 * Usage (real mode — signs EIP-3009 authorizations):
 * ```typescript
 * const client = new PayBotClient({
 *   apiKey: 'pb_test_...',
 *   botId: 'my-bot',
 *   walletPrivateKey: '0x...',
 * });
 * ```
 */
export class PayBotClient {
  private config: Required<Pick<PayBotConfig, 'apiKey' | 'facilitatorUrl' | 'botId' | 'operatorId'>> & { walletPrivateKey?: string };
  private maxRetries: number;
  private timeout: number;

  constructor(config: PayBotConfig) {
    if (!config.apiKey || typeof config.apiKey !== 'string') {
      throw new Error('PayBotClient: apiKey is required and must be a non-empty string');
    }
    if (!config.botId || typeof config.botId !== 'string') {
      throw new Error('PayBotClient: botId is required and must be a non-empty string');
    }
    if (config.facilitatorUrl !== undefined) {
      try {
        new URL(config.facilitatorUrl);
      } catch {
        throw new Error(`PayBotClient: facilitatorUrl is not a valid URL: ${config.facilitatorUrl}`);
      }
    }
    if (config.walletPrivateKey !== undefined && !config.walletPrivateKey.startsWith('0x')) {
      throw new Error('PayBotClient: walletPrivateKey must start with 0x');
    }

    this.config = {
      apiKey: config.apiKey,
      facilitatorUrl: config.facilitatorUrl ?? 'https://api.paybotcore.com',
      botId: config.botId,
      operatorId: config.operatorId ?? 'default-operator',
      walletPrivateKey: config.walletPrivateKey,
    };
    this.maxRetries = config.maxRetries ?? 1;
    this.timeout = config.timeout ?? 30_000;
  }

  /**
   * Shared fetch wrapper with auth headers, timeout, and retry on network errors / 5xx.
   */
  private async _request<T>(
    path: string,
    options: { method?: string; body?: unknown; query?: Record<string, string> } = {}
  ): Promise<T> {
    const url = new URL(path, this.config.facilitatorUrl);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        url.searchParams.set(key, value);
      }
    }

    const headers: Record<string, string> = {
      'X-API-Key': this.config.apiKey,
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const fetchOptions: RequestInit = {
      method: options.method ?? 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    };

    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        await this.delay(100 * Math.pow(2, attempt - 1));
      }

      let response: Response;
      try {
        response = await this.fetchWithTimeout(url.toString(), fetchOptions);
      } catch (error: unknown) {
        lastError = error;
        continue; // retry on network errors
      }

      // Don't retry on 4xx (client errors)
      if (response.status >= 400 && response.status < 500) {
        const errorData = await response.json().catch(() => ({})) as Record<string, unknown>;
        throw new PayBotApiError(
          (errorData.error as string) ?? `HTTP ${response.status}`,
          (errorData.code as string) ?? 'HTTP_ERROR',
          response.status,
          errorData.details as Record<string, unknown> | undefined
        );
      }

      // Retry on 5xx
      if (response.status >= 500) {
        lastError = new PayBotApiError(
          `HTTP ${response.status}`,
          'HTTP_ERROR',
          response.status
        );
        continue;
      }

      return response.json() as Promise<T>;
    }

    // All retries exhausted
    if (lastError instanceof PayBotApiError) {
      throw lastError;
    }
    throw new PayBotApiError(
      `Network error: ${getErrorMessage(lastError)}`,
      'NETWORK_ERROR',
      0
    );
  }

  private async fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new PayBotApiError(
          `Request timed out after ${this.timeout}ms`,
          'TIMEOUT',
          0
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Execute a payment through the PayBot facilitator.
   * Returns a PaymentResult with `success: false` on failure (never throws).
   */
  async pay(request: PaymentRequest): Promise<PaymentResult> {
    try {
      const network = request.network ?? 'eip155:84532';
      const networkConfig = NETWORKS[network];
      const tokenContract = request.tokenContract ?? networkConfig?.usdcAddress ?? '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
      const amountBaseUnits = this.usdToBaseUnits(request.amount);

      const payloadString = await this.buildPaymentPayload(
        request.payTo,
        amountBaseUnits,
        network
      );

      const payloadBody = {
        x402Version: 1,
        resource: request.resource,
        accepted: true,
        payload: payloadString,
      };

      const requirements = {
        scheme: 'exact',
        network,
        asset: `${network}/erc20:${tokenContract}`,
        amount: amountBaseUnits,
        payTo: request.payTo,
        maxTimeoutSeconds: 300,
      };

      // Step 1: Verify
      let verifyData: Record<string, unknown>;
      try {
        verifyData = await this._request<Record<string, unknown>>('/verify', {
          method: 'POST',
          body: {
            botId: this.config.botId,
            payload: payloadBody,
            requirements,
          },
        });
      } catch (error: unknown) {
        if (error instanceof PayBotApiError) {
          return {
            success: false,
            grossAmount: '0',
            netAmount: '0',
            commissionAmount: '0',
            commissionRate: 0,
            error: error.message,
            errorCode: error.code,
            errorDetails: error.details,
          };
        }
        throw error;
      }

      const settlementToken = verifyData.settlementToken as string | undefined;
      if (!settlementToken) {
        return {
          success: false,
          grossAmount: '0',
          netAmount: '0',
          commissionAmount: '0',
          commissionRate: 0,
          error: 'Verify response missing settlement token',
        };
      }

      // Step 2: Settle
      let settleData: Record<string, unknown>;
      try {
        settleData = await this._request<Record<string, unknown>>('/settle', {
          method: 'POST',
          body: {
            botId: this.config.botId,
            settlementToken,
            payload: payloadBody,
            requirements: verifyData.modifiedRequirements ?? requirements,
            commission: verifyData.commission,
          },
        });
      } catch (error: unknown) {
        if (error instanceof PayBotApiError) {
          return {
            success: false,
            grossAmount: '0',
            netAmount: '0',
            commissionAmount: '0',
            commissionRate: 0,
            error: error.message,
            errorCode: error.code,
            errorDetails: error.details,
          };
        }
        throw error;
      }

      const commissionData = verifyData.commission as Record<string, unknown> | undefined;

      return {
        success: true,
        txHash: settleData.transaction as string | undefined,
        grossAmount: String(commissionData?.grossAmount ?? '0'),
        netAmount: String(commissionData?.netAmount ?? '0'),
        commissionAmount: String(commissionData?.commissionAmount ?? '0'),
        commissionRate: Number(commissionData?.commissionRate ?? 0),
        network: settleData.network as string | undefined,
      };
    } catch (error: unknown) {
      return {
        success: false,
        grossAmount: '0',
        netAmount: '0',
        commissionAmount: '0',
        commissionRate: 0,
        error: getErrorMessage(error),
      };
    }
  }

  /**
   * Build the payment payload string.
   * If walletPrivateKey is set, signs an EIP-3009 authorization.
   * Otherwise, uses mock format.
   */
  private async buildPaymentPayload(
    payTo: string,
    amountBaseUnits: string,
    network: string
  ): Promise<string> {
    if (!this.config.walletPrivateKey) {
      return `payer:${this.config.botId}`;
    }

    const domain = EIP712_DOMAINS[network];
    if (!domain) {
      throw new Error(`No EIP-712 domain for network: ${network}`);
    }

    const account = privateKeyToAccount(this.config.walletPrivateKey as `0x${string}`);
    const nonce = generateEIP3009Nonce();
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
    const validAfter = 0n;
    const validBefore = nowSeconds + 3600n; // 1 hour from now

    const value = BigInt(amountBaseUnits);

    const signature = await account.signTypedData({
      domain,
      types: EIP3009_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: account.address,
        to: payTo as `0x${string}`,
        value,
        validAfter,
        validBefore,
        nonce,
      },
    });

    return JSON.stringify({
      from: account.address,
      to: payTo,
      value: value.toString(),
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce,
      signature,
    });
  }

  /**
   * Get the current trust status and remaining budget for this bot.
   * Throws PayBotApiError on non-2xx responses.
   */
  async balance(): Promise<BalanceResult> {
    return this._request<BalanceResult>('/balance', {
      query: { botId: this.config.botId },
    });
  }

  /**
   * Get transaction history for this bot.
   * Throws PayBotApiError on non-2xx responses.
   */
  async history(limit: number = 50): Promise<TransactionHistoryItem[]> {
    return this._request<TransactionHistoryItem[]>('/history', {
      query: { botId: this.config.botId, limit: String(limit) },
    });
  }

  /**
   * Update spending limits for this bot.
   * Throws PayBotApiError on non-2xx responses.
   */
  async setLimits(limits: LimitsConfig): Promise<void> {
    await this._request<{ success: boolean }>('/limits', {
      method: 'PUT',
      body: { botId: this.config.botId, ...limits },
    });
  }

  /**
   * Register a new bot with the PayBot facilitator.
   * Throws PayBotApiError on non-2xx responses (e.g. 409 if already registered).
   */
  async register(trustLevel?: TrustLevel): Promise<RegisterResult> {
    return this._request<RegisterResult>('/bots', {
      method: 'POST',
      body: { botId: this.config.botId, trustLevel: trustLevel ?? 1 },
    });
  }

  /**
   * Check facilitator health.
   * Throws PayBotApiError if the server is unreachable.
   */
  async health(): Promise<HealthResult> {
    return this._request<HealthResult>('/health');
  }

  /**
   * Convert USD amount string to USDC base units (6 decimals).
   */
  private usdToBaseUnits(usdAmount: string): string {
    if (!usdAmount || typeof usdAmount !== 'string') {
      throw new Error('Amount must be a non-empty string');
    }
    if (!/^\d+\.?\d*$/.test(usdAmount)) {
      throw new Error(`Invalid USD amount: ${usdAmount}`);
    }
    const parts = usdAmount.split('.');
    const whole = parts[0] ?? '0';
    const fraction = (parts[1] ?? '').padEnd(6, '0').slice(0, 6);
    return `${whole}${fraction}`.replace(/^0+/, '') || '0';
  }

  // --- Auth: static methods (pre-client-creation) ---

  /**
   * One-call signup: register -> login -> create API key -> register default bot.
   * Returns everything needed to start using the SDK.
   */
  static async signup(
    email: string,
    password: string,
    options?: { facilitatorUrl?: string; botId?: string }
  ): Promise<SignupResult> {
    const baseUrl = options?.facilitatorUrl ?? 'https://api.paybotcore.com';
    const botId = options?.botId ?? 'default';

    // 1. Register operator
    const registerRes = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const registerData = await registerRes.json() as Record<string, unknown>;
    if (!registerRes.ok) {
      throw new PayBotApiError(
        (registerData.error as string) ?? 'Registration failed',
        (registerData.code as string) ?? 'REGISTRATION_FAILED',
        registerRes.status,
        registerData.details as Record<string, unknown>,
      );
    }
    const operatorId = registerData.operatorId as string;

    // 2. Login to get JWT
    const loginRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const loginData = await loginRes.json() as Record<string, unknown>;
    if (!loginRes.ok) {
      throw new PayBotApiError(
        (loginData.error as string) ?? 'Login failed',
        (loginData.code as string) ?? 'LOGIN_FAILED',
        loginRes.status,
      );
    }
    const accessToken = loginData.accessToken as string;

    // 3. Create API key
    const keyRes = await fetch(`${baseUrl}/api-keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ operatorId, label: 'default', permissions: 'all' }),
    });
    const keyData = await keyRes.json() as Record<string, unknown>;
    if (!keyRes.ok) {
      throw new PayBotApiError(
        (keyData.error as string) ?? 'API key creation failed',
        (keyData.code as string) ?? 'KEY_CREATION_FAILED',
        keyRes.status,
      );
    }
    const apiKey = keyData.key as string;

    // 4. Register default bot
    const botRes = await fetch(`${baseUrl}/bots`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      body: JSON.stringify({ botId, trustLevel: 1 }),
    });
    if (!botRes.ok) {
      const botData = await botRes.json() as Record<string, unknown>;
      throw new PayBotApiError(
        (botData.error as string) ?? 'Bot registration failed',
        (botData.code as string) ?? 'BOT_REGISTRATION_FAILED',
        botRes.status,
      );
    }

    return {
      operatorId,
      apiKey,
      botId,
      message: 'Save your API key — it is shown only once. Use it to create a PayBotClient.',
    };
  }

  /**
   * Login with email and password. Returns JWT tokens for management operations.
   */
  static async login(
    email: string,
    password: string,
    options?: { facilitatorUrl?: string }
  ): Promise<LoginResult> {
    const baseUrl = options?.facilitatorUrl ?? 'https://api.paybotcore.com';

    const res = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok) {
      throw new PayBotApiError(
        (data.error as string) ?? 'Login failed',
        (data.code as string) ?? 'LOGIN_FAILED',
        res.status,
      );
    }

    const operator = data.operator as Record<string, unknown>;
    return {
      accessToken: data.accessToken as string,
      refreshToken: data.refreshToken as string,
      expiresIn: data.expiresIn as number,
      operator: {
        id: operator.id as string,
        email: operator.email as string,
        tier: operator.tier as string,
        displayName: operator.displayName as string | undefined,
      },
    };
  }

  // --- Auth: instance methods (API key management) ---

  /**
   * Create a new API key. Requires a JWT access token from login().
   */
  async createApiKey(options: { label?: string; accessToken: string }): Promise<ApiKeyResult> {
    const res = await fetch(`${this.config.facilitatorUrl}/api-keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${options.accessToken}`,
      },
      body: JSON.stringify({
        operatorId: this.config.operatorId,
        label: options.label,
        permissions: 'all',
      }),
    });
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok) {
      throw new PayBotApiError(
        (data.error as string) ?? 'API key creation failed',
        (data.code as string) ?? 'KEY_CREATION_FAILED',
        res.status,
      );
    }
    return data as unknown as ApiKeyResult;
  }

  /**
   * List all API keys for the operator. Returns metadata only, never raw keys.
   */
  async listApiKeys(accessToken: string): Promise<ApiKeyListItem[]> {
    const res = await fetch(`${this.config.facilitatorUrl}/api-keys`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    const data = await res.json();
    if (!res.ok) {
      const errData = data as Record<string, unknown>;
      throw new PayBotApiError(
        (errData.error as string) ?? 'Failed to list API keys',
        (errData.code as string) ?? 'LIST_KEYS_FAILED',
        res.status,
      );
    }
    return data as ApiKeyListItem[];
  }

  /**
   * Revoke (deactivate) an API key by ID.
   */
  async revokeApiKey(keyId: string, accessToken: string): Promise<{ success: boolean; keyId: string; active: boolean }> {
    const res = await fetch(`${this.config.facilitatorUrl}/api-keys/${keyId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok) {
      throw new PayBotApiError(
        (data.error as string) ?? 'Failed to revoke API key',
        (data.code as string) ?? 'REVOKE_KEY_FAILED',
        res.status,
      );
    }
    return data as { success: boolean; keyId: string; active: boolean };
  }
}
