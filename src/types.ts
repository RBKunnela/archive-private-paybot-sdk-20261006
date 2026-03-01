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
