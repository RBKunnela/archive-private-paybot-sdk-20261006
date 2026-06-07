/**
 * Public SDK types for paybot-sdk.
 * These are the types bot developers interact with.
 */

import type { TelemetryConfig } from './telemetry.js';

export interface PayBotConfig {
  /** PayBot API key for authentication */
  apiKey: string;
  /** PayBot facilitator URL (default: https://api.paybotcore.com) */
  facilitatorUrl?: string;
  /** Bot identifier */
  botId: string;
  /** Operator identifier */
  operatorId?: string;
  /** Bot wallet private key for EIP-3009 signing (hex with 0x prefix) */
  walletPrivateKey?: string;
  /** Maximum number of retries on network errors or 5xx responses (default: 1) */
  maxRetries?: number;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /**
   * Optional operator-supplied token contract addresses, keyed
   * `tokenSymbol → caip2Network → address` (e.g.
   * `{ EURC: { 'eip155:8453': '0x...' } }`).
   *
   * The public open-core registry ({@link TOKENS}) ships only addresses that are
   * safe to distribute (e.g. testnet deployments). Mainnet addresses for
   * regulated tokens are NOT hardcoded in the public SDK — the operator injects
   * them here at runtime. During payment, the SDK resolves a token address as:
   * explicit `PaymentRequest.tokenContract` → this override map → the public
   * registry → otherwise a `TOKEN_ADDRESS_NOT_CONFIGURED` failure.
   */
  tokenAddressOverrides?: Record<string, Record<string, string>>;
  /**
   * Optional, opt-in OpenTelemetry tracing. Inject your own tracer (e.g.
   * `trace.getTracer('my-bot')`). When omitted, telemetry is a complete no-op
   * with zero overhead and the SDK adds no OpenTelemetry runtime dependency.
   */
  telemetry?: TelemetryConfig;
}

export interface PaymentRequest {
  /** URL of the resource to pay for */
  resource: string;
  /** Amount in USDC (human-readable, e.g., '0.05') */
  amount: string;
  /** Recipient wallet address */
  payTo: string;
  /** Token contract (defaults to USDC on Base) */
  tokenContract?: string;
  /**
   * Token ticker symbol to pay with (e.g. `'USDC'`, `'EURC'`). Default `'USDC'`.
   * When set, the SDK resolves the token's address-on-network for the `asset`
   * field, uses its decimals for base-unit conversion, and signs against its
   * token-specific EIP-712 domain. An explicit {@link PaymentRequest.tokenContract}
   * still overrides the resolved address. Unknown symbol → PaymentResult
   * `success:false` with code `UNSUPPORTED_TOKEN`.
   */
  token?: string;
  /** Network CAIP-2 ID (default: eip155:84532 Base Sepolia) */
  network?: string;
  /**
   * Optional idempotency key. When provided, the SDK sends an
   * `X-Idempotency-Key` header and caches the successful result per
   * PayBotClient instance: a repeat pay() with the same key returns the cached
   * PaymentResult without a second network round-trip.
   */
  idempotencyKey?: string;
}

export interface PaymentResult {
  success: boolean;
  txHash?: string;
  grossAmount: string;
  netAmount: string;
  commissionAmount: string;
  commissionRate: number;
  network?: string;
  error?: string;
  /** Machine-readable error code from the server (e.g. 'TRUST_VIOLATION') */
  errorCode?: string;
  /** Additional error context from the server */
  errorDetails?: Record<string, unknown>;
  /**
   * Settlement-status discriminator (A5 HITL approval band). OPTIONAL →
   * non-breaking: a consumer that reads only {@link PaymentResult.success}
   * keeps working unchanged.
   *
   * - `'settled'`          — the payment completed (money moved); `success:true`.
   * - `'pending_approval'` — the server placed the payment in the approval band
   *   and a human must decide. `success` is **`false`** (money did not move),
   *   but this distinguishes a *pause* from a real failure. The bot may
   *   {@link "./client".PayBotClient.waitForApproval} on {@link PaymentResult.approvalId}.
   * - `'denied'`           — a human (or TTL expiry, fail-closed) refused the
   *   payment; `success:false`.
   *
   * When absent, the result is a plain success/failure (legacy behavior).
   */
  status?: 'settled' | 'pending_approval' | 'denied';
  /**
   * The server-issued approval handle. Present when
   * `status === 'pending_approval'`. Pass it to `waitForApproval()` or poll
   * {@link PaymentResult.pollUrl} directly.
   */
  approvalId?: string;
  /**
   * The relative poll path for this pending approval (e.g. `/approvals/ap_…`).
   * Present when `status === 'pending_approval'`.
   */
  pollUrl?: string;
  /**
   * ISO-8601 timestamp at which the server's approval record expires
   * (fail-closed → treated as denied). Present when
   * `status === 'pending_approval'`; useful for the caller's own timeout math.
   */
  expiresAt?: string;
}

export interface BalanceResult {
  botId: string;
  trustLevel: number;
  trustLevelName: string;
  dailySpentUsd: number;
  dailyLimitUsd: number;
  dailyRemainingUsd: number;
  hourlyTransactions: number;
  hourlyLimit: number;
}

export interface TransactionHistoryItem {
  eventId: string;
  timestamp: string;
  eventType: string;
  action: string;
  details: Record<string, unknown>;
}

export interface LimitsConfig {
  maxTransactionUsd?: number;
  maxDailySpendUsd?: number;
  maxTransactionsPerHour?: number;
  allowedRecipients?: string[];
}

export interface RegisterResult {
  success: boolean;
  botId: string;
  trustLevel: number;
}

export interface HealthResult {
  status: string;
  version: string;
  uptime: number;
  timestamp: string;
  [key: string]: unknown;
}

export type TrustLevel = 0 | 1 | 2 | 3 | 4 | 5;

// ===== x402 v2 Protocol Types =====

/**
 * Payment-Intent - x402 v2 core payment negotiation structure
 */
export interface PaymentIntent {
  /** Unique payment intent identifier */
  intentId: string;
  /** Protocol mode: x402 (native), mpp (Stripe/Tempo), dual (both) */
  protocol: 'x402' | 'mpp' | 'dual';
  /** Payment requirements from merchant */
  requirements: PaymentRequirements;
  /** Optional merchant information */
  merchant?: MerchantInfo;
  /** Optional metadata about the payment */
  meta?: PaymentMetadata;
  /** Protocol version */
  version: string;
  /** When the payment intent was created */
  createdAt: string;
  /** When the payment intent expires */
  expiresAt: string;
}

/**
 * x402 payment scheme.
 *
 * - `exact` — pay a fixed amount (x402 v1/v2 core scheme).
 * - `max`   — legacy capped scheme (kept for back-compat).
 * - `range` — legacy min/max scheme (kept for back-compat).
 * - `upto`  — x402 v2 metered/usage (streaming) billing: the payer signs an
 *             EIP-3009 authorization for the MAXIMUM amount, authorizing the
 *             merchant to capture UP TO that max. See {@link X402Handler.signUpto}.
 */
export type PaymentScheme = 'exact' | 'max' | 'range' | 'upto';

/**
 * Payment requirements negotiated between agent and merchant
 */
export interface PaymentRequirements {
  /** Payment scheme: exact, max, range, or upto (x402 v2 metered billing) */
  scheme: PaymentScheme;
  /** Network CAIP-2 identifier (e.g., eip155:8453) */
  network: string;
  /** Asset identifier (e.g., eip155:8453/erc20:0x...) */
  asset: string;
  /** Amount in base units */
  amount: string;
  /** Recipient address */
  payTo: string;
  /** Maximum timeout in seconds */
  maxTimeoutSeconds: number;
  /** Optional minimum amount for range scheme */
  minAmount?: string;
  /** Optional max amount for range scheme */
  maxAmount?: string;
  /**
   * Optional token ticker symbol (e.g. `'USDC'`, `'EURC'`). Selects the
   * token-specific EIP-712 signing domain. Defaults to `'USDC'` when absent,
   * preserving legacy single-token behavior byte-for-byte.
   */
  token?: string;
}

/**
 * Merchant information for transparency
 */
export interface MerchantInfo {
  /** Merchant name or identifier */
  name: string;
  /** Merchant URL */
  url: string;
  /** Merchant domain for verification */
  domain?: string;
}

/**
 * Payment metadata
 */
export interface PaymentMetadata {
  /** Description of what's being paid for */
  description?: string;
  /** Order or transaction reference */
  orderId?: string;
  /** Additional custom metadata */
  custom?: Record<string, unknown>;
}

/**
 * Payment payload from HTTP 402 response
 */
export interface PaymentPayload {
  /** Parsed payment intent */
  paymentIntent: PaymentIntent;
  /** Payment requirements */
  requirements: PaymentRequirements;
  /** Optional merchant info */
  merchant?: MerchantInfo;
  /** Optional metadata */
  meta?: PaymentMetadata;
}

/**
 * HTTP 402 Payment Required response
 */
export interface PaymentRequiredResponse {
  /** HTTP status code (always 402) */
  status: 402;
  /** Response headers (including Payment-Intent) */
  headers: Record<string, string>;
  /** Response body with payment details */
  body: unknown;
}

/**
 * Signed payment ready for submission
 */
export interface SignedPayment {
  /** Protocol used for signing */
  protocol: 'x402' | 'mpp' | 'dual';
  /** Signed payment data structure */
  signedData: Record<string, unknown>;
  /** Cryptographic signature */
  signature: string;
  /** Signing timestamp */
  timestamp: number;
}

/**
 * Payment receipt after successful settlement
 */
export interface Receipt {
  /** Unique receipt identifier */
  receiptId: string;
  /** Blockchain transaction ID (if on-chain) */
  transactionId?: string;
  /** Receipt status */
  status: 'pending' | 'confirmed' | 'failed';
  /** When payment was confirmed (if confirmed) */
  confirmedAt?: Date;
  /** Amount paid */
  amount: string;
  /** Network used for payment */
  network: string;
  /** Block number (if on-chain) */
  blockNumber?: number;
  /** Gas used for transaction (if on-chain) */
  gasUsed?: string;
}

/**
 * Payment-Intent header value
 */
export type PaymentIntentHeader = string;

/**
 * Parsed settlement confirmation read from an x402 v2 `PAYMENT-RESPONSE`
 * header (base64-encoded JSON). A receipt-ish projection: only the fields a
 * client needs to correlate the settlement with its submitted payment.
 *
 * @see X402Handler.parsePaymentResponseHeader
 */
export interface PaymentResponseConfirmation {
  /** Server-issued receipt identifier. */
  receiptId: string;
  /** Settlement status reported by the facilitator. */
  status: 'pending' | 'confirmed' | 'failed';
  /** On-chain transaction id, when settled on-chain. */
  transactionId?: string;
}

/**
 * Snapshot of who an agent is. Umbrella type derived from PayBotConfig +
 * RegisterResult, used across signed receipts and cross-SDK identity exchange.
 *
 * Mirrors `paybot_sdk.types.AgentIdentity` in the Python port.
 */
export interface AgentIdentity {
  botId: string;
  operatorId?: string;
  walletAddress?: string;
  trustLevel?: TrustLevel;
}

/** Construct an AgentIdentity from a PayBotConfig (pre-registration view). */
export function agentIdentityFromConfig(cfg: PayBotConfig): AgentIdentity {
  return {
    botId: cfg.botId,
    operatorId: cfg.operatorId,
  };
}

/** Construct an AgentIdentity from a RegisterResult (post-registration view). */
export function agentIdentityFromRegisterResult(r: RegisterResult): AgentIdentity {
  return {
    botId: r.botId,
    trustLevel: r.trustLevel as TrustLevel,
  };
}

// --- Auth types (onboarding) ---

export interface SignupResult {
  operatorId: string;
  apiKey: string;
  botId: string;
  message: string;
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  operator: {
    id: string;
    email: string;
    tier: string;
    displayName?: string;
  };
}

export interface ApiKeyResult {
  id: string;
  key: string;
  keyPrefix: string;
  operatorId: string;
  label?: string;
  permissions: string;
  rateLimit: number;
  createdAt: string;
}

export interface ApiKeyListItem {
  id: string;
  keyPrefix: string;
  operatorId: string;
  label?: string;
  permissions: string;
  rateLimit: number;
  active: boolean;
  createdAt: string;
  lastUsedAt?: string;
}

// --- Commission types ---

export interface CommissionSummary {
  /** Total commission earned (base units) */
  totalEarned: string;
  /** Commission pending settlement */
  pending: string;
  /** Commission forwarded to collection wallet */
  forwarded: string;
  /** Commission deferred (below minimum threshold) */
  deferred: string;
  /** Commission rate as decimal (e.g. 0.025 = 2.5%) */
  commissionRate: number;
  /** Number of commission entries */
  entryCount: number;
}

export interface CommissionLedgerFilter {
  /** Filter by status: pending, forwarded, deferred */
  status?: 'pending' | 'forwarded' | 'deferred';
  /** Start date (ISO 8601) */
  startDate?: string;
  /** End date (ISO 8601) */
  endDate?: string;
  /** Maximum entries to return (default: 50) */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
}

export interface CommissionEntry {
  id: string;
  /** Related payment transaction hash */
  txHash: string;
  /** Gross payment amount (base units) */
  grossAmount: string;
  /** Net amount after commission (base units) */
  netAmount: string;
  /** Commission amount (base units) */
  commissionAmount: string;
  /** Commission rate applied */
  commissionRate: number;
  /** Entry status */
  status: 'pending' | 'forwarded' | 'deferred';
  /** When this entry was created */
  createdAt: string;
  /** When commission was forwarded (if applicable) */
  forwardedAt?: string;
}

// ===== Micropayment Batching Engine Types =====

/**
 * Item in the batching queue
 */
export interface MicropaymentQueueItem {
  paymentId: string;
  recipient: string;
  amountUsd: string;
  amountBaseUnits: string; // USDC uses 6 decimals
  queuedAt: number;
  status: 'queued' | 'pending' | 'settled';
  metadata?: Record<string, unknown>;
}

/**
 * Result of batching multiple payments
 */
export interface BatchedSettlement {
  batchId: string;
  paymentIds: string[];
  recipientCount: number;
  totalAmountUsd: string;
  totalAmountBaseUnits: string;
  averageAmountUsd: string;
  gasEstimateUsd: string;
  gasPerPaymentUsd: string;
  signedSettlement: {
    signature: string;
    from: string;
    nonce: string;
    expiresAt: string;
    payments: Array<{
      recipient: string;
      amount: string;
      paymentId: string;
    }>;
  };
  createdAt: number;
  expiresAt: number;
}

/**
 * Options for settlement
 */
export interface SettlementOptions {
  forceSettle?: boolean; // Force settlement even if thresholds not met
  skipGasEstimate?: boolean; // Skip gas estimation for speed
}

/**
 * Statistics about the current queue
 */
export interface BatchStatistics {
  totalPayments: number;
  totalUsd: number;
  pendingCount: number;
  queuedCount: number;
  uniqueRecipients: number;
  paymentsByRecipient: Record<string, number>;
  activeWindows: number;
  averageUsdPerPayment: number;
  shouldSettle: boolean;
}
