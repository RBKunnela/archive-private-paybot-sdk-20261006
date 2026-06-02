"""Public SDK types for paybot-sdk (Python port).

Mirrors the TypeScript types in `src/types.ts` so consumers can move between
SDKs without retyping. Where TS uses string literals for union types (e.g.
`'pending' | 'forwarded' | 'deferred'`), Python uses Literal.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Dict, List, Literal, Optional

if TYPE_CHECKING:
    from .telemetry import TelemetryConfig


CommissionStatus = Literal["pending", "forwarded", "deferred"]
TrustLevel = Literal[0, 1, 2, 3, 4, 5]
ReceiptSignerRole = Literal["facilitator", "payer"]

# x402 v2 protocol enums (mirrors types.ts:126, 151).
PaymentProtocol = Literal["x402", "mpp", "dual"]
PaymentScheme = Literal["exact", "max", "range", "upto"]


@dataclass
class PayBotConfig:
    """SDK constructor config. Mirrors `PayBotConfig` in `src/types.ts`."""

    api_key: str
    bot_id: str
    facilitator_url: Optional[str] = None  # default: https://api.paybotcore.com
    operator_id: Optional[str] = None
    wallet_private_key: Optional[str] = None  # hex with 0x prefix
    max_retries: int = 1
    timeout_ms: int = 30_000
    # Optional, opt-in OpenTelemetry tracing. When omitted, telemetry is a
    # complete no-op with zero overhead (types.ts:28).
    telemetry: Optional["TelemetryConfig"] = None


@dataclass
class PaymentRequest:
    resource: str
    amount: str  # human-readable USDC, e.g. "0.05"
    pay_to: str
    token_contract: Optional[str] = None
    network: Optional[str] = None  # CAIP-2 id, default eip155:84532
    # Token ticker symbol to pay with (e.g. "USDC", "EURC"). Default "USDC".
    # Unknown symbol -> PaymentResult success:false code UNSUPPORTED_TOKEN (types.ts:48).
    token: Optional[str] = None
    # Optional idempotency key. When set, pay() sends X-Idempotency-Key and
    # caches the successful result per PayBotClient instance (types.ts:57).
    idempotency_key: Optional[str] = None


@dataclass
class PaymentResult:
    success: bool
    gross_amount: str
    net_amount: str
    commission_amount: str
    commission_rate: float
    tx_hash: Optional[str] = None
    network: Optional[str] = None
    error: Optional[str] = None
    error_code: Optional[str] = None
    error_details: Optional[Dict[str, Any]] = None
    signed_receipt: Optional["SignedReceipt"] = None


@dataclass
class ReceiptAgent:
    bot_id: str
    wallet_address: Optional[str] = None
    service_card_ref: Optional[str] = None


@dataclass
class ReceiptCapability:
    id: str
    descriptor: Optional[str] = None
    request_hash: Optional[str] = None


@dataclass
class ReceiptSettlement:
    tx_hash: str
    network: str
    gross_amount: str
    net_amount: str
    timestamp: str


@dataclass
class ReceiptArtifact:
    hash: str
    content_type: Optional[str] = None
    uri: Optional[str] = None


@dataclass
class ReceiptReputationPointer:
    registry_uri: str
    payee_record_id: Optional[str] = None


@dataclass
class UnsignedReceipt:
    version: Literal["1.0"]
    receipt_id: str
    payer: ReceiptAgent
    payee: ReceiptAgent
    capability: ReceiptCapability
    settlement: ReceiptSettlement
    signed_by: ReceiptSignerRole
    artifact: Optional[ReceiptArtifact] = None
    reputation: Optional[ReceiptReputationPointer] = None
    signer_address: Optional[str] = None


@dataclass
class SignedReceipt(UnsignedReceipt):
    signer_address: str = ""
    signature: str = ""


@dataclass
class BalanceResult:
    bot_id: str
    trust_level: int
    trust_level_name: str
    daily_spent_usd: float
    daily_limit_usd: float
    daily_remaining_usd: float
    hourly_transactions: int
    hourly_limit: int


@dataclass
class TransactionHistoryItem:
    event_id: str
    timestamp: str
    event_type: str
    action: str
    details: Dict[str, Any]


@dataclass
class LimitsConfig:
    max_transaction_usd: Optional[float] = None
    max_daily_spend_usd: Optional[float] = None
    max_transactions_per_hour: Optional[int] = None
    allowed_recipients: Optional[List[str]] = None


@dataclass
class RegisterResult:
    success: bool
    bot_id: str
    trust_level: int


@dataclass
class HealthResult:
    status: str
    version: str
    uptime: float
    timestamp: str
    extra: Dict[str, Any] = field(default_factory=dict)


# --- Auth types (onboarding) ---


@dataclass
class SignupResult:
    operator_id: str
    api_key: str
    bot_id: str
    message: str


@dataclass
class OperatorRef:
    id: str
    email: str
    tier: str
    display_name: Optional[str] = None


@dataclass
class LoginResult:
    access_token: str
    refresh_token: str
    expires_in: int
    operator: OperatorRef


@dataclass
class ApiKeyResult:
    id: str
    key: str
    key_prefix: str
    operator_id: str
    permissions: str
    rate_limit: int
    created_at: str
    label: Optional[str] = None


@dataclass
class ApiKeyListItem:
    id: str
    key_prefix: str
    operator_id: str
    permissions: str
    rate_limit: int
    active: bool
    created_at: str
    label: Optional[str] = None
    last_used_at: Optional[str] = None


# --- Commission types ---


@dataclass
class CommissionSummary:
    total_earned: str  # base units
    pending: str
    forwarded: str
    deferred: str
    commission_rate: float  # decimal (0.025 = 2.5%)
    entry_count: int


@dataclass
class CommissionLedgerFilter:
    status: Optional[CommissionStatus] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    limit: int = 50
    offset: int = 0


@dataclass
class CommissionEntry:
    id: str
    tx_hash: str
    gross_amount: str
    net_amount: str
    commission_amount: str
    commission_rate: float
    status: CommissionStatus
    created_at: str
    forwarded_at: Optional[str] = None


# ===== x402 v2 Protocol Types (mirrors types.ts:117-286) =====


@dataclass
class PaymentRequirements:
    """Payment requirements negotiated between agent and merchant (types.ts:156-179)."""

    scheme: PaymentScheme
    network: str  # CAIP-2 identifier (e.g. eip155:8453)
    asset: str  # asset identifier (e.g. eip155:8453/erc20:0x...)
    amount: str  # base units
    pay_to: str
    max_timeout_seconds: int
    min_amount: Optional[str] = None  # for range scheme
    max_amount: Optional[str] = None  # for range / upto scheme
    token: Optional[str] = None  # token ticker; selects EIP-712 domain (default USDC)


@dataclass
class MerchantInfo:
    """Merchant information for transparency (types.ts:184)."""

    name: str
    url: str
    domain: Optional[str] = None


@dataclass
class PaymentMetadata:
    """Payment metadata (types.ts:196)."""

    description: Optional[str] = None
    order_id: Optional[str] = None
    custom: Optional[Dict[str, Any]] = None


@dataclass
class PaymentIntent:
    """x402 v2 core payment negotiation structure (types.ts:122-139)."""

    intent_id: str
    protocol: PaymentProtocol  # x402 (native), mpp (Stripe/Tempo), dual (both)
    requirements: PaymentRequirements
    version: str
    created_at: str
    expires_at: str
    merchant: Optional[MerchantInfo] = None
    meta: Optional[PaymentMetadata] = None


@dataclass
class PaymentPayload:
    """Payment payload from an HTTP 402 response (types.ts:208)."""

    payment_intent: PaymentIntent
    requirements: PaymentRequirements
    merchant: Optional[MerchantInfo] = None
    meta: Optional[PaymentMetadata] = None


@dataclass
class PaymentRequiredResponse:
    """HTTP 402 Payment Required response (types.ts:222)."""

    status: int  # always 402
    headers: Dict[str, str]
    body: Any


@dataclass
class SignedPayment:
    """Signed payment ready for submission (types.ts:234)."""

    protocol: PaymentProtocol
    signed_data: Dict[str, Any]
    signature: str
    timestamp: int  # epoch ms (matches TS Date.now())


@dataclass
class Receipt:
    """Payment receipt after successful settlement (types.ts:248).

    ``confirmed_at`` is kept as an ISO-8601 string (NOT a ``datetime``); see the
    PARITY-SPEC divergence note — Python returns the ISO string to avoid lossy
    round-trips while TS hands back a ``Date``.
    """

    receipt_id: str
    status: Literal["pending", "confirmed", "failed"]
    amount: str
    network: str
    transaction_id: Optional[str] = None
    confirmed_at: Optional[str] = None  # ISO-8601 string
    block_number: Optional[int] = None
    gas_used: Optional[str] = None


@dataclass
class PaymentResponseConfirmation:
    """Parsed settlement confirmation from a PAYMENT-RESPONSE header (types.ts:279)."""

    receipt_id: str
    status: Literal["pending", "confirmed", "failed"]
    transaction_id: Optional[str] = None
