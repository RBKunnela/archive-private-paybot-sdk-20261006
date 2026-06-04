"""paybot-sdk Python port — entry module.

Mirrors the TS `src/index.ts` exports. The runtime is shipped: EIP-3009 signing
in `PayBotClient.pay()` (via the `signing` extra) and `verify_webhook_signature`
are both available. v0.2.0 adds the full x402 v2 protocol layer (dual-mode
signing, AP2 adapter, MPP seam), the 8-class error taxonomy, the multi-token
registry (USDC + EURC), telemetry hooks, idempotency, the multi-bot client pool,
the framework middleware, and the static auth helpers (`signup`/`login`).
"""
from .ap2 import (
    Ap2Adapter,
    Ap2PaymentMandate,
    Ap2SettleOptions,
    ap2_mandate_to_payment_requirements,
    is_ap2_mandate,
)
from .client import PayBotClient
from .client_pool import (
    PayBotClientPool,
    PayBotClientPoolConfig,
    PoolBotOptions,
    PoolBotStats,
)
from .errors import (
    POLICY_ERROR_CODES,
    PayBotApiError,
    PayBotAuthError,
    PayBotError,
    PayBotNetworkError,
    PayBotPolicyError,
    PayBotSettlementError,
    PayBotSignatureError,
    PayBotTimeoutError,
    get_error_message,
    map_http_error,
)
from .middleware import (
    Paybot402Config,
    Paybot402Middleware,
    paybot_402_dependency,
)
from .mpp_seam import (
    MppAdapter,
    MppCapability,
    create_mpp_seam,
    detect_mpp_capability,
)
from .networks import (
    EIP3009_TYPES,
    EIP712_DOMAINS,
    NETWORKS,
    TOKENS,
    Caip2,
    NetworkConfig,
    TokenConfig,
    get_eip712_domain,
    get_network,
    get_supported_networks,
    get_supported_tokens,
    get_token,
    get_token_address,
    is_supported_caip2,
    parse_caip2,
    resolve_token_address,
)
from .receipts import canonicalize, receipt_signing_payload, sign_receipt, verify_receipt
from .telemetry import (
    PayBotSpan,
    PayBotTracer,
    TelemetryConfig,
    with_span,
)
from .webhook import verify_webhook_signature
from .x402 import X402Handler
from .types import (
    ApiKeyListItem,
    ApiKeyResult,
    BalanceResult,
    CommissionEntry,
    CommissionLedgerFilter,
    CommissionStatus,
    CommissionSummary,
    HealthResult,
    LimitsConfig,
    LoginResult,
    MerchantInfo,
    OperatorRef,
    PayBotConfig,
    PaymentIntent,
    PaymentMetadata,
    PaymentPayload,
    PaymentProtocol,
    PaymentRequest,
    PaymentRequiredResponse,
    PaymentRequirements,
    PaymentResponseConfirmation,
    PaymentResult,
    PaymentScheme,
    ReceiptAgent,
    ReceiptArtifact,
    ReceiptCapability,
    ReceiptReputationPointer,
    ReceiptSettlement,
    ReceiptSignerRole,
    Receipt,
    RegisterResult,
    SignedPayment,
    SignedReceipt,
    SignupResult,
    TransactionHistoryItem,
    TrustLevel,
    UnsignedReceipt,
)

__version__ = "0.2.0"  # x402 v2 parity bundle

__all__ = [
    "PayBotClient",
    "verify_webhook_signature",
    # errors
    "PayBotError",
    "PayBotApiError",
    "PayBotNetworkError",
    "PayBotTimeoutError",
    "PayBotAuthError",
    "PayBotPolicyError",
    "PayBotSignatureError",
    "PayBotSettlementError",
    "POLICY_ERROR_CODES",
    "map_http_error",
    "get_error_message",
    # receipts
    "canonicalize",
    "receipt_signing_payload",
    "sign_receipt",
    "verify_receipt",
    # networks + tokens
    "NETWORKS",
    "NetworkConfig",
    "EIP712_DOMAINS",
    "EIP3009_TYPES",
    "TOKENS",
    "TokenConfig",
    "Caip2",
    "get_token",
    "get_token_address",
    "resolve_token_address",
    "get_supported_tokens",
    "get_eip712_domain",
    "get_network",
    "get_supported_networks",
    "parse_caip2",
    "is_supported_caip2",
    # x402 v2
    "X402Handler",
    "Ap2Adapter",
    "Ap2PaymentMandate",
    "Ap2SettleOptions",
    "ap2_mandate_to_payment_requirements",
    "is_ap2_mandate",
    "detect_mpp_capability",
    "create_mpp_seam",
    "MppCapability",
    "MppAdapter",
    # telemetry
    "PayBotTracer",
    "PayBotSpan",
    "TelemetryConfig",
    "with_span",
    # client pool
    "PayBotClientPool",
    "PayBotClientPoolConfig",
    "PoolBotOptions",
    "PoolBotStats",
    # middleware
    "Paybot402Config",
    "Paybot402Middleware",
    "paybot_402_dependency",
    # config + payment types
    "PayBotConfig",
    "PaymentRequest",
    "PaymentResult",
    "PaymentProtocol",
    "PaymentScheme",
    "PaymentRequirements",
    "MerchantInfo",
    "PaymentMetadata",
    "PaymentIntent",
    "PaymentPayload",
    "PaymentRequiredResponse",
    "SignedPayment",
    "Receipt",
    "PaymentResponseConfirmation",
    # receipt types
    "ReceiptSignerRole",
    "ReceiptAgent",
    "ReceiptCapability",
    "ReceiptSettlement",
    "ReceiptArtifact",
    "ReceiptReputationPointer",
    "UnsignedReceipt",
    "SignedReceipt",
    # misc result types
    "BalanceResult",
    "TransactionHistoryItem",
    "LimitsConfig",
    "RegisterResult",
    "HealthResult",
    "TrustLevel",
    "CommissionStatus",
    "CommissionSummary",
    "CommissionLedgerFilter",
    "CommissionEntry",
    "ApiKeyResult",
    "ApiKeyListItem",
    "SignupResult",
    "LoginResult",
    "OperatorRef",
]
