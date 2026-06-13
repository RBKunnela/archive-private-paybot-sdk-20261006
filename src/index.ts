export { PayBotClient, mapPendingEnvelope, amountToBaseUnitsUsd } from './client.js';
export { PayBotClientPool } from './client-pool.js';
export type {
  PayBotClientPoolConfig,
  PoolBotOptions,
  PoolBotStats,
} from './client-pool.js';
export { createX402Handler } from './x402-handler.js';
export { paybot402 } from './middleware.js';
export { X402Handler } from './x402-v2.js';
export { MicropaymentEngine } from './micropayment-engine.js';
export {
  PayBotError,
  PayBotApiError,
  PayBotNetworkError,
  PayBotTimeoutError,
  PayBotAuthError,
  PayBotPolicyError,
  PayBotSignatureError,
  PayBotSettlementError,
} from './errors.js';
export type { X402HandlerConfig } from './x402-handler.js';
export type { Paybot402Config } from './middleware.js';
export type {
  PayBotConfig,
  PaymentRequest,
  PaymentResult,
  BalanceResult,
  TransactionHistoryItem,
  LimitsConfig,
  TrustLevel,
  RegisterResult,
  HealthResult,
  SignupResult,
  LoginResult,
  ApiKeyResult,
  ApiKeyListItem,
  CommissionSummary,
  CommissionLedgerFilter,
  CommissionEntry,
  AgentIdentity,
  // x402 v2 types
  PaymentIntent,
  PaymentPayload,
  SignedPayment,
  Receipt,
  PaymentRequiredResponse,
  PaymentRequirements,
  PaymentScheme,
  PaymentResponseConfirmation,
  MerchantInfo,
  PaymentMetadata,
  PaymentIntentHeader,
  // Micropayment Batching Engine types
  MicropaymentQueueItem,
  BatchedSettlement,
  SettlementOptions,
  BatchStatistics,
} from './types.js';
export {
  agentIdentityFromConfig,
  agentIdentityFromRegisterResult,
} from './types.js';
export type {
  PayBotTracer,
  PayBotSpan,
  TelemetryConfig,
} from './telemetry.js';
export type { NetworkConfig, Caip2, TokenConfig } from './networks.js';
export {
  NETWORKS,
  USDC_CONFIG,
  getNetwork,
  getSupportedNetworks,
  parseCaip2,
  isSupportedCaip2,
  EIP712_DOMAINS,
  EIP3009_TYPES,
  TOKENS,
  getToken,
  getTokenAddress,
  resolveTokenAddress,
  getSupportedTokens,
  getEip712Domain,
} from './networks.js';
export {
  ap2MandateToPaymentRequirements,
  isAp2Mandate,
  Ap2Adapter,
} from './ap2.js';
export type {
  Ap2PaymentMandate,
  Ap2SettleOptions,
  Ap2SettleVcOptions,
} from './ap2.js';
export {
  verifyMandate,
  computeMandateHash,
  canonicalizeJcs,
  decodeBase58btc,
  resolveDidKey,
  resolveDidDocument,
  isTrustedIssuer,
  getMandateId,
  getCartHash,
  InMemoryReplayStore,
  AP2_VERIFY_ERROR_CODES,
  AP2_MANDATE_TYPES,
  VC_V2_CONTEXT,
  MAX_VC_BYTES,
  MAX_VC_DEPTH,
  MAX_CLOCK_SKEW_MS,
} from './ap2-vc.js';
export type {
  Ap2MandateVc,
  Ap2Proof,
  Ap2DataIntegrityProof,
  Ap2SdJwtProof,
  Ap2MandateType,
  Ap2VerifyOptions,
  Ap2VerifyResult,
  Ap2VerifyErrorCode,
  DidDocument,
  DidVerificationMethod,
  ReplayStore,
} from './ap2-vc.js';
export {
  detectMppCapability,
  createMppSeam,
} from './mpp-seam.js';
export type {
  MppCapability,
  MppAdapter,
} from './mpp-seam.js';
export {
  verifyWebhookSignature,
  signWebhookPayload,
} from './webhook.js';
export type {
  VerifyWebhookSignatureOptions,
  SignWebhookPayloadOptions,
} from './webhook.js';
// Wire contract (issue #118, B1) — the sdk's typed mirrors of core's response
// shapes, pinned to core's vendored snapshot by the conformance tests.
// Slice 1: pending-approval envelope. Slice 2: /verify + /settle success.
export type {
  PendingEnvelopeWire,
  WireFieldType,
  WireFieldDescriptor,
  WireObjectDescriptor,
  VerifyResponseWire,
  SettleResponseWire,
  RequirementsWire,
  CommissionWire,
} from './wire-contract.js';
export {
  PENDING_ENVELOPE_WIRE_FIELDS,
  VERIFY_RESPONSE_WIRE_FIELDS,
  VERIFY_RESPONSE_REQUIRED_FIELDS,
  SETTLE_RESPONSE_WIRE_FIELDS,
  SETTLE_RESPONSE_REQUIRED_FIELDS,
} from './wire-contract.js';
