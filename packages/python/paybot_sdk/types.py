"""Public SDK types for paybot-sdk (Python port).

Mirrors the TypeScript types in `src/types.ts` so consumers can move between
SDKs without retyping. Where TS uses string literals for union types (e.g.
`'pending' | 'forwarded' | 'deferred'`), Python uses Literal.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional


CommissionStatus = Literal["pending", "forwarded", "deferred"]
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


@dataclass
class PaymentRequest:
    resource: str
    amount: str  # human-readable USDC, e.g. "0.05"
    pay_to: str
    token_contract: Optional[str] = None
    network: Optional[str] = None  # CAIP-2 id, default eip155:84532


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
