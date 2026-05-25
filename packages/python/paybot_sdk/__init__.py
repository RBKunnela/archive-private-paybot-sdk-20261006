"""paybot-sdk Python port — entry module.

Mirrors the TS `src/index.ts` exports. Once the runtime port lands (PR-2),
the `x402_handler` factory will be re-exported from here too.
"""
from .client import PayBotClient
from .errors import PayBotApiError, get_error_message
from .networks import EIP712_DOMAINS, EIP3009_TYPES, NETWORKS, NetworkConfig
from .receipts import canonicalize, receipt_signing_payload, sign_receipt, verify_receipt
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
    OperatorRef,
    PayBotConfig,
    PaymentRequest,
    PaymentResult,
    ReceiptAgent,
    ReceiptArtifact,
    ReceiptCapability,
    ReceiptReputationPointer,
    ReceiptSettlement,
    ReceiptSignerRole,
    RegisterResult,
    SignedReceipt,
    SignupResult,
    TransactionHistoryItem,
    TrustLevel,
    UnsignedReceipt,
)

__version__ = "0.1.0a1"  # scaffold release; runtime in 0.1.0

__all__ = [
    "PayBotClient",
    "PayBotApiError",
    "get_error_message",
    "canonicalize",
    "receipt_signing_payload",
    "sign_receipt",
    "verify_receipt",
    "NETWORKS",
    "NetworkConfig",
    "EIP712_DOMAINS",
    "EIP3009_TYPES",
    "PayBotConfig",
    "PaymentRequest",
    "PaymentResult",
    "ReceiptSignerRole",
    "ReceiptAgent",
    "ReceiptCapability",
    "ReceiptSettlement",
    "ReceiptArtifact",
    "ReceiptReputationPointer",
    "UnsignedReceipt",
    "SignedReceipt",
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
