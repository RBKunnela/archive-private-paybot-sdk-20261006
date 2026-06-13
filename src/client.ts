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
  CommissionSummary,
  CommissionLedgerFilter,
  CommissionEntry,
} from './types.js';
import {
  getErrorMessage,
  PayBotApiError,
  PayBotNetworkError,
  PayBotTimeoutError,
  mapHttpError,
} from './errors.js';
import { generateEIP3009Nonce } from './crypto.js';
import { EIP3009_TYPES, getToken, getEip712Domain, resolveTokenAddress } from './networks.js';
import { withSpan, type TelemetryConfig } from './telemetry.js';
import type {
  PendingEnvelopeWire,
  VerifyResponseWire,
  SettleResponseWire,
} from './wire-contract.js';
import { privateKeyToAccount } from 'viem/accounts';

/** Default maximum number of cached idempotent results per client instance. */
const IDEMPOTENCY_CACHE_CAP = 256;

/**
 * Minimal bounded LRU cache backed by a single Map.
 *
 * Insertion order in a JS Map is recency order for our purposes: on a cache
 * hit we delete-then-reinsert the key to mark it most-recently-used; on insert
 * past capacity we evict the oldest key (the first one the Map iterator yields).
 *
 * Used per-PayBotClient-instance to dedupe idempotent calls. Not thread-safe,
 * but the SDK runs single-threaded per instance.
 *
 * @typeParam V - The cached value type.
 */
class LruCache<V> {
  private readonly store = new Map<string, V>();

  /**
   * @param capacity - Maximum number of entries before eviction kicks in.
   */
  constructor(private readonly capacity: number) {}

  /**
   * Look up a key, marking it most-recently-used on a hit.
   *
   * @param key - The cache key.
   * @returns The cached value, or `undefined` if absent.
   */
  get(key: string): V | undefined {
    if (!this.store.has(key)) return undefined;
    const value = this.store.get(key) as V;
    // Re-insert to move to the most-recently-used position.
    this.store.delete(key);
    this.store.set(key, value);
    return value;
  }

  /**
   * Insert or update a key, evicting the least-recently-used entry if the
   * cache is at capacity.
   *
   * @param key - The cache key.
   * @param value - The value to cache.
   */
  set(key: string, value: V): void {
    // Update-in-place should also refresh recency.
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.capacity) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) {
        this.store.delete(oldest);
      }
    }
    this.store.set(key, value);
  }

  /** Current number of cached entries (primarily for tests). */
  get size(): number {
    return this.store.size;
  }
}

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
  /**
   * Operator-supplied token address overrides (`symbol → caip2 → address`).
   * Lets the operator inject mainnet addresses that are intentionally absent
   * from the public open-core registry. See {@link PayBotConfig.tokenAddressOverrides}.
   */
  private tokenAddressOverrides?: Record<string, Record<string, string>>;
  private maxRetries: number;
  private timeout: number;
  /** Opt-in telemetry config; undefined means tracing is a complete no-op. */
  private telemetry?: TelemetryConfig;
  /** Per-instance LRU of idempotent pay() results (only success:true cached). */
  private payIdempotencyCache = new LruCache<PaymentResult>(IDEMPOTENCY_CACHE_CAP);
  /** Per-instance LRU of idempotent register() results. */
  private registerIdempotencyCache = new LruCache<RegisterResult>(IDEMPOTENCY_CACHE_CAP);
  /**
   * In-flight Promise maps keyed by idempotency key (CodeRabbit #5).
   * Concurrent callers with the same key share ONE Promise instead of each
   * issuing a duplicate network call. Entries are evicted on rejection and on a
   * `success:false` result (coherent with #6 — only a real success is cached).
   */
  private payInflight = new Map<string, Promise<PaymentResult>>();
  private registerInflight = new Map<string, Promise<RegisterResult>>();

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
    this.tokenAddressOverrides = config.tokenAddressOverrides;
    this.maxRetries = config.maxRetries ?? 1;
    this.timeout = config.timeout ?? 30_000;
    this.telemetry = config.telemetry;
  }

  /**
   * Shared fetch wrapper with auth headers, timeout, and retry on network errors / 5xx.
   */
  private async _request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      query?: Record<string, string>;
      headers?: Record<string, string>;
    } = {}
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
    if (options.headers) {
      Object.assign(headers, options.headers);
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

      // Don't retry on 4xx (client errors). Map to the most specific subclass
      // (auth/policy) while keeping `instanceof PayBotApiError` true for callers.
      if (response.status >= 400 && response.status < 500) {
        const errorData = await response.json().catch(() => ({})) as Record<string, unknown>;
        throw mapHttpError(
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

    // All retries exhausted. A PayBotApiError here is already specific
    // (e.g. PayBotTimeoutError from fetchWithTimeout, or a 5xx PayBotApiError).
    if (lastError instanceof PayBotApiError) {
      throw lastError;
    }
    throw new PayBotNetworkError(
      `Network error: ${getErrorMessage(lastError)}`
    );
  }

  private async fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new PayBotTimeoutError(
          `Request timed out after ${this.timeout}ms`
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
    const idempotencyKey = request.idempotencyKey;

    // No idempotency key → plain one-shot call.
    if (idempotencyKey === undefined) {
      return this._payOnce(request);
    }

    // Idempotency: share an in-flight Promise + cache successful results so a
    // concurrent or repeat call with the same key short-circuits without a
    // duplicate network round-trip (CodeRabbit #5/#6). Only success:true results
    // are cached, so a cache hit is always a real prior success.
    return this.runIdempotent(
      idempotencyKey,
      this.payInflight,
      this.payIdempotencyCache,
      () => this._payOnce(request),
    );
  }

  /**
   * Execute a single pay() network round-trip (no idempotency dedup/caching).
   *
   * @param request - The payment request.
   * @returns A PaymentResult; `success:false` on failure (never throws).
   */
  private async _payOnce(request: PaymentRequest): Promise<PaymentResult> {
    const network = request.network ?? 'eip155:84532';
    const idempotencyKey = request.idempotencyKey;

    // Wrap the whole pay() body in the top-level span. A returned failure
    // PaymentResult is reported as an OK span with success=false (nothing was
    // thrown); only thrown errors mark the span ERROR (handled in withSpan).
    return withSpan(
      this.telemetry,
      'client.pay',
      {
        network,
        amount: request.amount,
        bot_id: this.config.botId,
      },
      async (paySpan): Promise<PaymentResult> => {
        try {
          const symbol = request.token ?? 'USDC';

          // Resolve the token from the registry. An unknown symbol short-circuits
          // to a failure PaymentResult (mirrors the UNSUPPORTED_NETWORK pattern).
          const token = getToken(symbol);
          if (!token) {
            paySpan?.setAttribute('success', false);
            return {
              success: false,
              grossAmount: '0',
              netAmount: '0',
              commissionAmount: '0',
              commissionRate: 0,
              error: `Unsupported token: ${symbol}`,
              errorCode: 'UNSUPPORTED_TOKEN',
            };
          }

          // Token contract precedence:
          //   1. explicit request.tokenContract
          //   2. operator-injected override (config.tokenAddressOverrides)
          //   3. the public open-core registry (token.addressByNetwork)
          // If none resolves (e.g. EURC mainnet, which is operator-private and
          // intentionally absent from the public registry), fail loudly with
          // TOKEN_ADDRESS_NOT_CONFIGURED rather than signing against a wrong or
          // absent address.
          const tokenContract =
            request.tokenContract ??
            resolveTokenAddress(symbol, network, this.tokenAddressOverrides);
          if (!tokenContract) {
            paySpan?.setAttribute('success', false);
            return {
              success: false,
              grossAmount: '0',
              netAmount: '0',
              commissionAmount: '0',
              commissionRate: 0,
              error:
                `No contract address configured for token ${symbol} on network ${network}. ` +
                `Provide it via PayBotConfig.tokenAddressOverrides[${symbol}][${network}].`,
              errorCode: 'TOKEN_ADDRESS_NOT_CONFIGURED',
            };
          }

          // Convert using the token's decimals (USDC and EURC both use 6).
          const amountBaseUnits = this.amountToBaseUnits(request.amount, token.decimals);

          const payloadString = await withSpan(
            this.telemetry,
            'x402.sign',
            { network },
            () => this.buildPaymentPayload(request.payTo, amountBaseUnits, network, symbol, tokenContract)
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

          // Step 1: Verify (challenge)
          let verifyData: Record<string, unknown>;
          try {
            verifyData = await withSpan(
              this.telemetry,
              'x402.challenge',
              {},
              () => this._request<Record<string, unknown>>('/verify', {
                method: 'POST',
                body: {
                  botId: this.config.botId,
                  payload: payloadBody,
                  requirements,
                },
                headers: idempotencyKey !== undefined
                  ? { 'X-Idempotency-Key': idempotencyKey }
                  : undefined,
              })
            );
          } catch (error: unknown) {
            if (error instanceof PayBotApiError) {
              paySpan?.setAttribute('success', false);
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

          // A5 HITL: when the server places the payment in the approval band,
          // /verify returns a pending envelope (`status:'pending_approval'`)
          // instead of a settlement token. Do NOT settle — return a pending
          // PaymentResult so the bot stays responsive (never-throws preserved).
          // The SDK keys off `status`, not the HTTP code (a pending is a
          // decision, mirroring how the core returns 200 for a deny).
          if (verifyData.status === 'pending_approval') {
            paySpan?.setAttribute('success', false);
            paySpan?.setAttribute('status', 'pending_approval');
            // Boundary narrow: the wire is untyped JSON (`Record<string,unknown>`);
            // here we conform it to the typed contract (issue #118, B1 slice 1).
            // `mapPendingEnvelope` stays defensive about missing/odd fields, so a
            // single contract type guards every downstream read.
            return mapPendingEnvelope(
              verifyData as Readonly<Partial<PendingEnvelopeWire>>,
              request.amount
            );
          }

          // Boundary narrow: past the pending branch this is the /verify SUCCESS
          // wire response (issue #118, B1 slice 2). `Partial` keeps the read
          // defensive — a non-conforming server degrades gracefully — while the
          // field NAMES and TYPES are now contract-checked (a core rename breaks
          // this at compile time; the conformance test pins it to core's snapshot).
          const verify = verifyData as Readonly<Partial<VerifyResponseWire>>;

          const settlementToken = verify.settlementToken;
          if (!settlementToken) {
            paySpan?.setAttribute('success', false);
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
            settleData = await withSpan(
              this.telemetry,
              'x402.settle',
              {},
              () => this._request<Record<string, unknown>>('/settle', {
                method: 'POST',
                body: {
                  botId: this.config.botId,
                  settlementToken,
                  payload: payloadBody,
                  requirements: verify.modifiedRequirements ?? requirements,
                  commission: verify.commission,
                },
              })
            );
          } catch (error: unknown) {
            if (error instanceof PayBotApiError) {
              paySpan?.setAttribute('success', false);
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

          // Boundary narrow: the /settle SUCCESS wire response (issue #118, slice 2).
          const settle = settleData as Readonly<Partial<SettleResponseWire>>;
          const commissionData = verify.commission;
          const txHash = settle.transaction;

          paySpan?.setAttribute('success', true);
          if (txHash) {
            paySpan?.setAttribute('tx_hash', txHash);
          }

          const result: PaymentResult = {
            success: true,
            txHash,
            grossAmount: String(commissionData?.grossAmount ?? '0'),
            netAmount: String(commissionData?.netAmount ?? '0'),
            commissionAmount: String(commissionData?.commissionAmount ?? '0'),
            commissionRate: Number(commissionData?.commissionRate ?? 0),
            network: settle.network,
          };

          // Caching is handled by runIdempotent() (only success:true results
          // are cached); _payOnce intentionally does NOT cache here.
          return result;
        } catch (error: unknown) {
          paySpan?.setAttribute('success', false);
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
    );
  }

  /**
   * Wait for a pending HITL approval to reach a terminal decision (A5 §3.2).
   *
   * Polls the core poll endpoint (`GET /approvals/{id}`) every `intervalMs`
   * until the approval resolves (SETTLED / DENIED / EXPIRED) or `timeoutMs`
   * elapses. Resolves to a {@link PaymentResult}; **never throws** — a poll
   * error or a local timeout is surfaced as a returned result, not an
   * exception.
   *
   * On local timeout the returned result keeps `status:'pending_approval'`:
   * the SDK giving up does NOT cancel or settle the approval — the core record
   * stays authoritative and live, so the caller may call this again.
   *
   * @param approvalId - The approval handle from a pending {@link PaymentResult}.
   * @param opts - Optional `timeoutMs` (default 15 min, aligned to the core TTL)
   *   and `intervalMs` (default 3 s poll cadence).
   * @returns A terminal `PaymentResult` (settled/denied), an expired-as-denied
   *   result, or — on local timeout / unrecoverable poll error — a result that
   *   still carries `status:'pending_approval'` so the caller may retry.
   *
   * @example
   * const r = await client.pay({ resource, amount: '500', payTo });
   * if (r.status === 'pending_approval') {
   *   const final = await client.waitForApproval(r.approvalId!);
   *   if (final.success) console.log('settled', final.txHash);
   * }
   */
  async waitForApproval(
    approvalId: string,
    opts?: { timeoutMs?: number; intervalMs?: number }
  ): Promise<PaymentResult> {
    if (!approvalId || typeof approvalId !== 'string') {
      // Defensive: an empty handle can never resolve. Return a non-throwing
      // failure rather than polling a malformed URL forever.
      return {
        success: false,
        grossAmount: '0',
        netAmount: '0',
        commissionAmount: '0',
        commissionRate: 0,
        error: 'waitForApproval: approvalId is required',
        errorCode: 'INVALID_APPROVAL_ID',
      };
    }

    const timeoutMs = opts?.timeoutMs ?? 15 * 60_000; // 15 min, aligned to core TTL
    const intervalMs = opts?.intervalMs ?? 3_000;
    const deadline = Date.now() + timeoutMs;

    // Track the last-seen pending shape so a local timeout returns a faithful
    // pending result (approvalId/pollUrl/expiresAt preserved). Seeded from the
    // first successful poll; never lost across iterations.
    let lastPending: PaymentResult = {
      success: false,
      grossAmount: '0',
      netAmount: '0',
      commissionAmount: '0',
      commissionRate: 0,
      status: 'pending_approval',
      approvalId,
      pollUrl: `/approvals/${approvalId}`,
    };

    for (;;) {
      let poll: Record<string, unknown> | undefined;
      try {
        poll = await this._request<Record<string, unknown>>(`/approvals/${approvalId}`);
      } catch (error: unknown) {
        // Never throw: surface the poll error. While the outcome is still
        // ambiguous we keep status:'pending_approval' so the caller may retry.
        // If the deadline has also passed, fall through to the timeout return.
        if (Date.now() >= deadline) {
          return {
            ...lastPending,
            error: `waitForApproval: poll timed out (last error: ${getErrorMessage(error)})`,
            errorCode: 'APPROVAL_POLL_TIMEOUT',
          };
        }
        lastPending = {
          ...lastPending,
          error: getErrorMessage(error),
          ...(error instanceof PayBotApiError ? { errorCode: error.code } : {}),
        };
        await this.delay(intervalMs);
        continue;
      }

      const decision = poll.decision as string | undefined;

      // Terminal decisions → resolved PaymentResult.
      if (decision === 'APPROVED') {
        const state = poll.state as string | undefined;
        if (state === 'SETTLED') {
          return {
            success: true,
            txHash: poll.tx_hash as string | undefined,
            grossAmount: amountToBaseUnitsUsd(poll.amount_usd),
            netAmount: amountToBaseUnitsUsd(poll.amount_usd),
            commissionAmount: '0',
            commissionRate: 0,
            status: 'settled',
            approvalId,
          };
        }
        // APPROVED but settle failed (or not yet recorded) → fail-closed result.
        return {
          success: false,
          grossAmount: '0',
          netAmount: '0',
          commissionAmount: '0',
          commissionRate: 0,
          status: 'denied',
          approvalId,
          error: (poll.error as string | undefined) ?? 'Approved payment failed to settle',
          errorCode: 'APPROVAL_SETTLE_FAILED',
        };
      }

      if (decision === 'DENIED' || decision === 'EXPIRED') {
        // EXPIRED == denied (fail-closed). Both are terminal refusals.
        return {
          success: false,
          grossAmount: '0',
          netAmount: '0',
          commissionAmount: '0',
          commissionRate: 0,
          status: 'denied',
          approvalId,
          error:
            (poll.error as string | undefined) ??
            (decision === 'EXPIRED' ? 'Approval expired' : 'Approval denied'),
          errorCode: decision === 'EXPIRED' ? 'APPROVAL_EXPIRED' : 'APPROVAL_DENIED',
        };
      }

      // Still PENDING — refresh the snapshot and either wait or time out.
      lastPending = {
        success: false,
        grossAmount: '0',
        netAmount: '0',
        commissionAmount: '0',
        commissionRate: 0,
        status: 'pending_approval',
        approvalId,
        pollUrl: `/approvals/${approvalId}`,
        ...(typeof poll.expires_at === 'string' ? { expiresAt: poll.expires_at } : {}),
      };

      if (Date.now() >= deadline) {
        // Local timeout: return pending. The CORE record stays live — the SDK
        // timing out never cancels or settles. The caller may poll again.
        return lastPending;
      }
      await this.delay(intervalMs);
    }
  }

  /**
   * Build the payment payload string.
   * If walletPrivateKey is set, signs an EIP-3009 authorization.
   * Otherwise, uses mock format.
   *
   * @param payTo - Recipient wallet address.
   * @param amountBaseUnits - Amount in the token's base units (decimal string).
   * @param network - CAIP-2 network id (e.g. `'eip155:8453'`).
   * @param symbol - Token ticker to sign for (default `'USDC'`). Selects the
   *   token-specific EIP-712 domain (name + verifyingContract). USDC remains
   *   byte-identical to the legacy `EIP712_DOMAINS[network]` domain.
   * @param verifyingContract - The resolved token contract address to sign
   *   against. Passed through to the EIP-712 domain's `verifyingContract` so an
   *   operator-injected address (absent from the public registry, e.g. EURC
   *   mainnet) signs correctly. When omitted, the public registry address is used.
   * @returns The payload string: mock `payer:<botId>` when no wallet key is set,
   *   otherwise a JSON EIP-3009 signed authorization.
   * @throws {Error} when the token has no EIP-712 domain on the given network.
   */
  private async buildPaymentPayload(
    payTo: string,
    amountBaseUnits: string,
    network: string,
    symbol = 'USDC',
    verifyingContract?: string
  ): Promise<string> {
    if (!this.config.walletPrivateKey) {
      return `payer:${this.config.botId}`;
    }

    const domain = getEip712Domain(network, symbol, verifyingContract);
    if (!domain) {
      throw new Error(`No EIP-712 domain for network: ${network} / token: ${symbol}`);
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
   *
   * @param trustLevel - Initial trust level for the bot (default 1).
   * @param idempotencyKey - Optional key. When provided, sends
   *   `X-Idempotency-Key` and caches the result per-instance so a repeat call
   *   with the same key returns the cached RegisterResult without a second
   *   network round-trip. Only successful registrations are cached.
   */
  async register(trustLevel?: TrustLevel, idempotencyKey?: string): Promise<RegisterResult> {
    const doRegister = async (): Promise<RegisterResult> =>
      this._request<RegisterResult>('/bots', {
        method: 'POST',
        body: { botId: this.config.botId, trustLevel: trustLevel ?? 1 },
        headers: idempotencyKey !== undefined
          ? { 'X-Idempotency-Key': idempotencyKey }
          : undefined,
      });

    // No idempotency key → plain one-shot call, no sharing/caching.
    if (idempotencyKey === undefined) {
      return doRegister();
    }

    return this.runIdempotent(
      idempotencyKey,
      this.registerInflight,
      this.registerIdempotencyCache,
      doRegister,
    );
  }

  /**
   * Run `factory()` at most once per `idempotencyKey` under concurrency.
   *
   * Concurrent callers with the same key share ONE in-flight Promise (CodeRabbit
   * #5): the first caller creates and registers the Promise synchronously
   * (before any await), so a second caller arriving while the first is still
   * awaiting joins the same Promise instead of issuing a duplicate network call.
   * On completion: a result whose `success` is truthy is cached and the in-flight
   * entry cleared; a rejection OR a `success:false` result evicts the in-flight
   * entry so a later retry can run again (coherent with #6 — only real successes
   * are cached/shared long-term).
   *
   * @param idempotencyKey - The dedup key.
   * @param inflight - The per-operation in-flight Promise map.
   * @param cache - The per-operation success-result LRU cache.
   * @param factory - Produces the underlying network Promise.
   * @returns The shared/cached result.
   */
  private runIdempotent<T extends { success?: boolean }>(
    idempotencyKey: string,
    inflight: Map<string, Promise<T>>,
    cache: LruCache<T>,
    factory: () => Promise<T>,
  ): Promise<T> {
    // A late-arriving caller may find a cached success placed by a Promise that
    // already settled — re-check before joining the in-flight Promise.
    const cached = cache.get(idempotencyKey);
    if (cached !== undefined) {
      return Promise.resolve(cached);
    }

    const existing = inflight.get(idempotencyKey);
    if (existing !== undefined) {
      return existing;
    }

    // Create and register the shared Promise SYNCHRONOUSLY (no await between the
    // cache/in-flight check above and this set), so concurrent callers cannot
    // each start a duplicate network call.
    const promise = (async (): Promise<T> => {
      const result = await factory();
      if (result.success) {
        cache.set(idempotencyKey, result);
      }
      return result;
    })();

    inflight.set(idempotencyKey, promise);

    // Evict the in-flight entry once the Promise settles, whether it resolved
    // (success or failure) or rejected — never pin a failure for future callers.
    // Swallow on this bookkeeping chain only; the real result/rejection is still
    // delivered to callers via the returned `promise`.
    void promise.finally(() => {
      if (inflight.get(idempotencyKey) === promise) {
        inflight.delete(idempotencyKey);
      }
    }).catch(() => {
      /* rejection is surfaced to awaiters of `promise`; ignore here */
    });

    return promise;
  }

  /**
   * Check facilitator health.
   * Throws PayBotApiError if the server is unreachable.
   */
  async health(): Promise<HealthResult> {
    return this._request<HealthResult>('/health');
  }

  /**
   * Convert a human-readable amount string to a token's base units.
   *
   * Generalizes the conversion over the token's decimal count (USDC and EURC
   * both use 6). The fractional part is right-padded then truncated to exactly
   * `decimals` digits, leading zeros are stripped, and an all-zero result
   * normalizes to `'0'`.
   *
   * @param amount - Human-readable decimal amount (e.g. `'0.05'`, `'10'`).
   * @param decimals - The token's base-unit decimals (e.g. 6 for USDC/EURC).
   * @returns The amount in base units as a decimal string (e.g. `'50000'`).
   * @throws {Error} when `amount` is not a non-empty string or not a valid
   *   non-negative decimal.
   *
   * @example
   *   amountToBaseUnits('0.05', 6); // '50000'
   *   amountToBaseUnits('10', 6);   // '10000000'
   */
  private amountToBaseUnits(amount: string, decimals: number): string {
    if (!amount || typeof amount !== 'string') {
      throw new Error('Amount must be a non-empty string');
    }
    if (!/^\d+\.?\d*$/.test(amount)) {
      throw new Error(`Invalid USD amount: ${amount}`);
    }
    const parts = amount.split('.');
    const whole = parts[0] ?? '0';
    const fraction = (parts[1] ?? '').padEnd(decimals, '0').slice(0, decimals);
    return `${whole}${fraction}`.replace(/^0+/, '') || '0';
  }

  // --- Commission queries ---

  /**
   * Get aggregated commission summary (total earned, pending, forwarded, deferred).
   * Throws PayBotApiError on non-2xx responses.
   */
  async commissionSummary(): Promise<CommissionSummary> {
    return this._request<CommissionSummary>('/commission/summary');
  }

  /**
   * Get paginated commission ledger entries with optional filters.
   * Throws PayBotApiError on non-2xx responses.
   */
  async commissionLedger(filters?: CommissionLedgerFilter): Promise<CommissionEntry[]> {
    const query: Record<string, string> = {};
    if (filters?.status) query.status = filters.status;
    if (filters?.startDate) query.startDate = filters.startDate;
    if (filters?.endDate) query.endDate = filters.endDate;
    if (filters?.limit !== undefined) query.limit = String(filters.limit);
    if (filters?.offset !== undefined) query.offset = String(filters.offset);

    return this._request<CommissionEntry[]>('/commission/ledger', { query });
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

/**
 * Convert a USD amount (as returned by the core approval record, e.g. `500`)
 * into USDC base units (6 decimals) as a decimal string, matching the base-unit
 * convention {@link PayBotClient.pay} uses for `grossAmount`/`netAmount`.
 *
 * Pending/approved results carry the *requested* amount for gross/net (the
 * money fields are REQUIRED on {@link PaymentResult}); commission stays `'0'`
 * because no commission applies until/unless the payment settles with one.
 *
 * @param amountUsd - The USD amount from the core record (number or string).
 * @returns The amount in USDC base units as a decimal string (e.g. `'500000000'`),
 *   or `'0'` when the input is missing or not a finite number.
 */
export function amountToBaseUnitsUsd(amountUsd: unknown): string {
  const n = typeof amountUsd === 'number' ? amountUsd : Number(amountUsd);
  if (!Number.isFinite(n) || n <= 0) return '0';
  // 6 decimals (USDC). Round to avoid float drift on fractional cents.
  return String(Math.round(n * 1e6));
}

/**
 * Map a core `pending_approval` envelope (from `/verify`, contract §2a) into a
 * never-throws {@link PaymentResult}.
 *
 * The result is `success:false` (money did not move) but `status:'pending_approval'`
 * — so a consumer that ignores `status` degrades safely to "not done yet", while
 * a consumer that reads it can `waitForApproval(approvalId)`. The REQUIRED money
 * fields are populated per the existing pattern: gross/net = the requested amount
 * (in base units), commission `'0'`/`0`.
 *
 * The `envelope` parameter is typed against {@link PendingEnvelopeWire} — the
 * sdk's hand-declared mirror of core's `pendingEnvelopeSchema` (issue #118, B1).
 * A core-side field rename now breaks this read at compile time, and the
 * contract-conformance test pins {@link PendingEnvelopeWire} to core's vendored
 * snapshot. `Partial` is intentional: the wire is untyped JSON at runtime, so the
 * function stays defensive (a non-conforming server degrades gracefully rather
 * than throwing) while the field NAMES and TYPES remain contract-checked.
 *
 * @param envelope - The parsed `/verify` pending envelope (see {@link PendingEnvelopeWire}).
 * @param requestedAmount - The human-readable USD amount the bot requested,
 *   used as a fallback for gross/net when the envelope omits `amount_usd`.
 * @returns A pending `PaymentResult`.
 */
export function mapPendingEnvelope(
  envelope: Readonly<Partial<PendingEnvelopeWire>>,
  requestedAmount: string
): PaymentResult {
  // Prefer the server's amount_usd (authoritative); fall back to the request.
  const baseUnits =
    envelope.amount_usd !== undefined
      ? amountToBaseUnitsUsd(envelope.amount_usd)
      : amountToBaseUnitsUsd(requestedAmount);

  return {
    success: false,
    grossAmount: baseUnits,
    netAmount: baseUnits,
    commissionAmount: '0',
    commissionRate: 0,
    status: 'pending_approval',
    approvalId: envelope.approval_id,
    pollUrl: envelope.poll_url,
    expiresAt: envelope.expires_at,
    ...(typeof envelope.reason === 'string' ? { error: envelope.reason } : {}),
  };
}
