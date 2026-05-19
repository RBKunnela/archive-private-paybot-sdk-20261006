/**
 * Public SDK types for paybot-sdk.
 * These are the types bot developers interact with.
 */

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
  /** Network CAIP-2 ID (default: eip155:84532 Base Sepolia) */
  network?: string;
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
 * Payment requirements negotiated between agent and merchant
 */
export interface PaymentRequirements {
  /** Payment scheme: exact, max, range */
  scheme: 'exact' | 'max' | 'range';
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
