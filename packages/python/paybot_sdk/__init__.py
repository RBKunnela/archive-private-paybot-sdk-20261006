"""paybot-sdk Python port — entry module.

Mirrors the TS `src/index.ts` exports. The runtime is shipped: EIP-3009 signing
in `PayBotClient.pay()` (via the `signing` extra) and `verify_webhook_signature`
are both available.
"""
from .client import PayBotClient
from .errors import PayBotApiError, get_error_message
from .networks import EIP712_DOMAINS, EIP3009_TYPES, NETWORKS, NetworkConfig
from .receipts import canonicalize, receipt_signing_payload, sign_receipt, verify_receipt
from .webhook import verify_webhook_signature
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

__version__ = "0.1.0"  # runtime release: EIP-3009 signing + webhook verification

__all__ = [
    "PayBotClient",
    "verify_webhook_signature",
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
