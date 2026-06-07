"""Public SDK types for paybot-sdk (Python port).

Mirrors the TypeScript types in `src/types.ts` so consumers can move between
SDKs without retyping. Where TS uses string literals for union types (e.g.
`'pending' | 'forwarded' | 'deferred'`), Python uses Literal.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Dict, List, Literal, Optional

if TYPE_CHECKING:  # pragma: no cover - typing-only import, avoids a runtime cycle
    from .telemetry import TelemetryConfig


CommissionStatus = Literal["pending", "forwarded", "deferred"]
# x402 payment scheme. ``upto`` is x402 v2 metered/streaming billing — the payer
# signs for the MAX amount, authorizing capture UP TO that max.
PaymentScheme = Literal["exact", "max", "range", "upto"]
PaymentProtocol = Literal["x402", "mpp", "dual"]
TrustLevel = Literal[0, 1, 2, 3, 4, 5]
ReceiptSignerRole = Literal["facilitator", "payer"]


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
    # Operator-supplied token contract addresses, keyed
    # ``token_symbol → caip2_network → address``. The public open-core registry
    # ships only safe-to-distribute addresses (testnet); mainnet addresses for
    # regulated tokens are injected here at runtime. Resolution precedence during
    # pay(): explicit ``PaymentRequest.token_contract`` → this map → public
    # registry → otherwise a ``TOKEN_ADDRESS_NOT_CONFIGURED`` failure.
    token_address_overrides: Optional[Dict[str, Dict[str, str]]] = None
    # Optional, opt-in tracer. Inject any object structurally matching
    # ``paybot_sdk.telemetry.PayBotTracer``. When ``None``, telemetry is a
    # complete no-op with zero overhead and no OpenTelemetry dependency.
    telemetry: Optional["TelemetryConfig"] = None


@dataclass
class PaymentRequest:
    resource: str
    # Human-readable decimal amount in the token's own units, e.g. "0.05".
    # Token-agnostic: for USDC this is USD, for EURC it is EUR, etc. The token
    # is selected by `token` (default "USDC") and its decimals drive base-unit
    # conversion (CodeRabbit #13).
    amount: str
    pay_to: str
    token_contract: Optional[str] = None
    # Token ticker symbol to pay with (e.g. "USDC", "EURC"). Default "USDC".
    # Resolves the token's address-on-network for the asset field, uses its
    # decimals for base-unit conversion, and signs against its token-specific
    # EIP-712 domain. An explicit token_contract still overrides the resolved
    # address. Unknown symbol → PaymentResult success=False, UNSUPPORTED_TOKEN.
    token: Optional[str] = None
    network: Optional[str] = None  # CAIP-2 id, default eip155:84532
    # Optional idempotency key. When provided, the SDK sends an
    # X-Idempotency-Key header and caches the successful result per client
    # instance: a repeat pay() with the same key returns the cached result
    # without a second network round-trip.
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


# --- Refund types ---


@dataclass
class RefundResult:
    """Result of a refund request. Returned by ``PayBotClient.refund`` which never
    raises — failures surface as ``success=False`` with an ``error``/``error_code``.
    """

    success: bool
    refund_id: Optional[str] = None
    tx_hash: Optional[str] = None
    amount: Optional[str] = None
    status: Optional[str] = None  # 'pending' | 'confirmed' | 'failed'
    error: Optional[str] = None
    error_code: Optional[str] = None
    error_details: Optional[Dict[str, Any]] = None


# ===== x402 v2 Protocol Types =====


@dataclass
class MerchantInfo:
    """Merchant information for transparency."""

    name: str
    url: str
    domain: Optional[str] = None


@dataclass
class PaymentMetadata:
    """Payment metadata."""

    description: Optional[str] = None
    order_id: Optional[str] = None
    custom: Optional[Dict[str, Any]] = None


@dataclass
class PaymentRequirements:
    """Payment requirements negotiated between agent and merchant.

    Mirrors ``PaymentRequirements`` in ``src/types.ts``. ``token`` selects the
    token-specific EIP-712 signing domain (default ``'USDC'``).
    """

    scheme: PaymentScheme
    network: str
    asset: str
    amount: str
    pay_to: str
    max_timeout_seconds: int
    min_amount: Optional[str] = None
    max_amount: Optional[str] = None
    token: Optional[str] = None


@dataclass
class PaymentIntent:
    """Payment-Intent — x402 v2 core payment negotiation structure."""

    intent_id: str
    protocol: PaymentProtocol
    requirements: PaymentRequirements
    version: str
    created_at: str
    expires_at: str
    merchant: Optional[MerchantInfo] = None
    meta: Optional[PaymentMetadata] = None


@dataclass
class PaymentPayload:
    """Payment payload parsed from an HTTP 402 response."""

    payment_intent: PaymentIntent
    requirements: PaymentRequirements
    merchant: Optional[MerchantInfo] = None
    meta: Optional[PaymentMetadata] = None


@dataclass
class PaymentRequiredResponse:
    """HTTP 402 Payment Required response (input to ``X402Handler.on_402_response``)."""

    status: int  # always 402
    headers: Dict[str, str]
    body: Any


@dataclass
class SignedPayment:
    """Signed payment ready for submission."""

    protocol: PaymentProtocol
    signed_data: Dict[str, Any]
    signature: str
    timestamp: int  # epoch ms


@dataclass
class Receipt:
    """Payment receipt after a successful settlement."""

    receipt_id: str
    status: Literal["pending", "confirmed", "failed"]
    amount: str
    network: str
    transaction_id: Optional[str] = None
    confirmed_at: Optional[str] = None
    block_number: Optional[int] = None
    gas_used: Optional[str] = None


@dataclass
class PaymentResponseConfirmation:
    """Parsed settlement confirmation from an x402 v2 ``PAYMENT-RESPONSE`` header."""

    receipt_id: str
    status: Literal["pending", "confirmed", "failed"]
    transaction_id: Optional[str] = None


# ===== Micropayment Batching Engine Types =====


MicropaymentStatus = Literal["queued", "pending", "settled"]


@dataclass
class MicropaymentQueueItem:
    """Item in the micropayment batching queue."""

    payment_id: str
    recipient: str
    amount_usd: str
    amount_base_units: str  # USDC uses 6 decimals
    queued_at: int  # epoch ms
    status: MicropaymentStatus
    metadata: Optional[Dict[str, Any]] = None


@dataclass
class BatchStatistics:
    """Statistics about the current batching queue."""

    total_payments: int
    total_usd: float
    pending_count: int
    queued_count: int
    unique_recipients: int
    payments_by_recipient: Dict[str, int]
    active_windows: int
    average_usd_per_payment: float
    should_settle: bool


@dataclass
class SettlementOptions:
    """Options for batch settlement."""

    force_settle: bool = False
    skip_gas_estimate: bool = False


@dataclass
class BatchedSettlement:
    """Result of batching multiple payments into a single signed settlement."""

    batch_id: str
    payment_ids: List[str]
    recipient_count: int
    total_amount_usd: str
    total_amount_base_units: str
    average_amount_usd: str
    gas_estimate_usd: str
    gas_per_payment_usd: str
    signed_settlement: Dict[str, Any]
    created_at: int
    expires_at: int
