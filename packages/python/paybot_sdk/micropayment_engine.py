"""Micropayment batching engine — Python port of ``src/micropayment-engine.ts``.

Gas-free batched settlement for sub-cent agent payments: pools payments, settles
in a single transaction, amortizes gas across thousands of micro-transactions.

- Gas-free transfers down to ``$0.000001`` per payment after batching
- Instant verification via EIP-3009 signed messages (here a ``BatchSettlement``
  EIP-712 typed-data signature)
- Settlement optimization — batch when ``>=`` ``min_payment_count`` payments OR
  ``>=`` ``min_total_usd`` total

Dependencies: ``eth-account`` (batch signing, ``signing`` extra), ``secrets``.
"""
from __future__ import annotations

import secrets
import time
from typing import Any, Dict, List, Optional

from .crypto import generate_eip3009_nonce
from .types import BatchedSettlement, BatchStatistics, MicropaymentQueueItem, SettlementOptions


# BatchSettlement EIP-712 typed-data structure (mirrors the TS `types` object).
_BATCH_TYPES = {
    "BatchSettlement": [
        {"name": "from", "type": "address"},
        {"name": "nonce", "type": "bytes32"},
        {"name": "expiresAt", "type": "uint256"},
        {"name": "totalAmount", "type": "uint256"},
        {"name": "paymentCount", "type": "uint256"},
        {"name": "payments", "type": "Payment[]"},
    ],
    "Payment": [
        {"name": "recipient", "type": "address"},
        {"name": "amount", "type": "uint256"},
        {"name": "paymentId", "type": "string"},
    ],
}

# Domain for the batch settlement signature (mirrors the TS constant).
_BATCH_DOMAIN = {
    "name": "PayBot",
    "version": "1",
    "chainId": 8453,
    "verifyingContract": "0x50b0f7224fFC5F4F7685DbcE1B8b7e7B8b8A4A23",
}


def _now_ms() -> int:
    return int(time.time() * 1000)


def _usd_to_base_units(usd_amount: str) -> str:
    """Convert a human-readable USD amount to USDC base units (6 decimals).

    :param usd_amount: Human-readable decimal amount (e.g. ``'0.05'``).
    :returns: The amount in base units as a decimal string (e.g. ``'50000'``).
    :raises ValueError: when ``usd_amount`` is not a non-empty valid decimal string.
    """
    if not usd_amount or not isinstance(usd_amount, str):
        raise ValueError("Amount must be a non-empty string")
    import re

    if not re.fullmatch(r"\d+\.?\d*", usd_amount):
        raise ValueError(f"Invalid USD amount: {usd_amount}")
    parts = usd_amount.split(".")
    whole = parts[0] if parts[0] else "0"
    raw_fraction = parts[1] if len(parts) > 1 else ""
    # USDC has 6 decimals. Silently truncating extra precision (the old [:6])
    # made the payer underpay vs. what they asked for (CodeRabbit #7). Reject
    # any amount finer than 6 decimals — ignoring trailing zeros, which carry
    # no value (e.g. "0.0010000000" is fine; "0.0000009" is not).
    if len(raw_fraction.rstrip("0")) > 6:
        raise ValueError(
            f"USD amount exceeds USDC precision (6 decimals): {usd_amount}"
        )
    fraction = raw_fraction.ljust(6, "0")[:6]
    return f"{whole}{fraction}".lstrip("0") or "0"


class MicropaymentEngine:
    """Batching system for agent micropayments.

    :param wallet_private_key: Hex (``0x``-prefixed) wallet key used to sign batches.
    :param batch_window_ms: Batching window in ms (default ``60000``).
    :param min_payment_count: Settlement trigger by count (default ``100``).
    :param min_total_usd: Settlement trigger by total USD (default ``1.0``).
    :raises ValueError: when ``wallet_private_key`` is not ``0x``-prefixed.
    """

    def __init__(
        self,
        wallet_private_key: str,
        batch_window_ms: int = 60_000,
        min_payment_count: int = 100,
        min_total_usd: float = 1.0,
    ) -> None:
        if not wallet_private_key.startswith("0x"):
            raise ValueError("MicropaymentEngine: wallet_private_key must start with 0x")
        self._wallet_private_key = wallet_private_key
        self._batch_window_ms = batch_window_ms
        self._min_payment_count = min_payment_count
        self._min_total_usd = min_total_usd
        # window key -> list of queue items
        self._queue: Dict[str, List[MicropaymentQueueItem]] = {}

    async def queue_payment(
        self,
        recipient: str,
        amount_usd: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> str:
        """Queue a micropayment, auto-settling the window when thresholds are met.

        :param recipient: Recipient wallet address.
        :param amount_usd: Human-readable USD amount (e.g. ``'0.001'``).
        :param metadata: Optional opaque metadata carried with the item.
        :returns: The generated ``payment_id``.
        :raises ValueError: when ``amount_usd`` is not a valid decimal string.
        """
        payment_id = f"mp_{_now_ms()}_{secrets.token_hex(5)}"
        item = MicropaymentQueueItem(
            payment_id=payment_id,
            recipient=recipient,
            amount_usd=amount_usd,
            amount_base_units=_usd_to_base_units(amount_usd),
            queued_at=_now_ms(),
            status="queued",
            metadata=metadata,
        )
        window_key = self._batch_window_key()
        self._queue.setdefault(window_key, []).append(item)
        await self._check_auto_settle(window_key)
        return payment_id

    async def batch_payments(
        self, payment_ids: List[str], options: Optional[SettlementOptions] = None
    ) -> BatchedSettlement:
        """Batch the named queued payments into one signed settlement.

        :param payment_ids: Ids of payments to include.
        :param options: Optional settlement options (``skip_gas_estimate``).
        :returns: A :class:`BatchedSettlement`.
        :raises ValueError: when no queued payment matches the given ids.
        """
        # Index every known item by id, then resolve each requested id exactly
        # once. Previously this silently dropped unknown ids and happily batched
        # already-pending/settled items (CodeRabbit #8). We now include ONLY
        # queued items and fail loudly listing what could not be batched.
        by_id: Dict[str, MicropaymentQueueItem] = {}
        for items in self._queue.values():
            for item in items:
                by_id[item.payment_id] = item

        payments: List[MicropaymentQueueItem] = []
        missing_ids: List[str] = []
        non_queued: List[str] = []
        for pid in payment_ids:
            item = by_id.get(pid)
            if item is None:
                missing_ids.append(pid)
            elif item.status != "queued":
                non_queued.append(f"{pid} (status={item.status})")
            else:
                payments.append(item)

        if missing_ids or non_queued:
            problems: List[str] = []
            if missing_ids:
                problems.append(f"missing: {', '.join(missing_ids)}")
            if non_queued:
                problems.append(f"not queued: {', '.join(non_queued)}")
            raise ValueError(f"Cannot batch payments - {'; '.join(problems)}")

        if not payments:
            raise ValueError("No payments found with given IDs")

        total_usd = sum(float(p.amount_usd) for p in payments)
        total_base_units = sum(int(p.amount_base_units) for p in payments)

        signed_settlement = self._sign_batch_settlement(payments)
        for payment in payments:
            payment.status = "pending"

        recipient_set = {p.recipient for p in payments}
        gas_estimate_usd = (
            0.0
            if (options is not None and options.skip_gas_estimate)
            # Price gas from THIS batch's recipients, not the whole queue
            # (CodeRabbit #9).
            else self._estimate_gas_cost(len(payments), len(recipient_set))
        )
        gas_per_payment_usd = gas_estimate_usd / len(payments)

        return BatchedSettlement(
            batch_id=f"batch_{_now_ms()}_{secrets.token_hex(5)}",
            payment_ids=[p.payment_id for p in payments],
            recipient_count=len(recipient_set),
            total_amount_usd=f"{total_usd:.6f}",
            total_amount_base_units=str(total_base_units),
            average_amount_usd=f"{total_usd / len(payments):.6f}",
            gas_estimate_usd=f"{gas_estimate_usd:.6f}",
            gas_per_payment_usd=f"{gas_per_payment_usd:.6f}",
            signed_settlement=signed_settlement,
            created_at=_now_ms(),
            expires_at=_now_ms() + 300_000,
        )

    def get_gas_estimate(self, payment_count: int) -> str:
        """Return the per-payment gas estimate (USD) for a given count, formatted."""
        return f"{self._estimate_gas_cost(payment_count):.6f}"

    def set_batch_window(self, seconds: int) -> None:
        """Set the batching window length in seconds."""
        self._batch_window_ms = seconds * 1000

    def get_queue_statistics(self) -> BatchStatistics:
        """Compute statistics across all queued/pending items in the engine."""
        total_payments = 0
        total_usd = 0.0
        pending_count = 0
        queued_count = 0
        payments_by_recipient: Dict[str, int] = {}

        for items in self._queue.values():
            for item in items:
                total_payments += 1
                total_usd += float(item.amount_usd)
                if item.status == "queued":
                    queued_count += 1
                elif item.status == "pending":
                    pending_count += 1
                payments_by_recipient[item.recipient] = (
                    payments_by_recipient.get(item.recipient, 0) + 1
                )

        return BatchStatistics(
            total_payments=total_payments,
            total_usd=total_usd,
            pending_count=pending_count,
            queued_count=queued_count,
            unique_recipients=len(payments_by_recipient),
            payments_by_recipient=payments_by_recipient,
            active_windows=len(self._queue),
            average_usd_per_payment=(total_usd / total_payments) if total_payments > 0 else 0.0,
            should_settle=(
                total_payments >= self._min_payment_count or total_usd >= self._min_total_usd
            ),
        )

    def clear_old_payments(self, minutes_old: float) -> int:
        """Drop ``settled`` items older than ``minutes_old`` minutes.

        :returns: The number of items cleared.
        """
        cutoff = _now_ms() - int(minutes_old * 60 * 1000)
        cleared = 0
        for key in list(self._queue.keys()):
            kept: List[MicropaymentQueueItem] = []
            for item in self._queue[key]:
                if item.queued_at < cutoff and item.status == "settled":
                    cleared += 1
                else:
                    kept.append(item)
            if not kept:
                del self._queue[key]
            else:
                self._queue[key] = kept
        return cleared

    def get_payment_status(self, payment_id: str) -> Optional[MicropaymentQueueItem]:
        """Look up a queued item by id, or ``None`` when not present."""
        for items in self._queue.values():
            for item in items:
                if item.payment_id == payment_id:
                    return item
        return None

    # ── Internals ────────────────────────────────────────────────────────

    def _sign_batch_settlement(
        self, payments: List[MicropaymentQueueItem]
    ) -> Dict[str, Any]:
        """Sign the EIP-712 ``BatchSettlement`` over the given payments."""
        from eth_account import Account

        account = Account.from_key(self._wallet_private_key)
        nonce = generate_eip3009_nonce()
        now_seconds = int(time.time())
        expires_at = now_seconds + 300

        payments_data = [
            {
                "recipient": p.recipient,
                "amount": int(p.amount_base_units),
                "paymentId": p.payment_id,
            }
            for p in payments
        ]
        total_amount = sum(int(p.amount_base_units) for p in payments)

        message = {
            "from": account.address,
            "nonce": nonce,
            "expiresAt": expires_at,
            "totalAmount": total_amount,
            "paymentCount": len(payments),
            "payments": payments_data,
        }
        signed = Account.sign_typed_data(
            self._wallet_private_key, _BATCH_DOMAIN, _BATCH_TYPES, message
        )
        sig_hex = signed.signature.hex()
        signature = sig_hex if sig_hex.startswith("0x") else "0x" + sig_hex

        # `amount` is stringified in the returned payload for JSON-safe transport.
        return {
            "signature": signature,
            "from": account.address,
            "nonce": nonce,
            "expiresAt": str(expires_at),
            "payments": [
                {
                    "recipient": p.recipient,
                    "amount": p.amount_base_units,
                    "paymentId": p.payment_id,
                }
                for p in payments
            ],
        }

    def _estimate_gas_cost(
        self, payment_count: int, unique_recipients: Optional[int] = None
    ) -> float:
        """Estimate the per-payment gas cost (USD), amortized across unique recipients.

        :param payment_count: Number of payments to amortize the cost across.
        :param unique_recipients: Distinct recipients to price gas for. When
            ``None`` (the public ``get_gas_estimate`` path), falls back to the
            whole-queue recipient count. ``batch_payments`` passes the batch's
            own recipient count so a batch is never charged for unrelated queued
            recipients (CodeRabbit #9).
        """
        base_gas = 21_000
        gas_per_recipient = 5_000
        if unique_recipients is None:
            unique_recipients = self.get_queue_statistics().unique_recipients
        total_gas = base_gas + unique_recipients * gas_per_recipient

        gwei_price = 5
        wei_per_gwei = 1_000_000_000
        gas_price_wei = gwei_price * wei_per_gwei
        gas_cost_wei = total_gas * gas_price_wei

        eth_price_usd = 3000
        wei_per_eth = 1_000_000_000_000_000_000

        gas_cost_eth = gas_cost_wei / wei_per_eth
        gas_cost_usd = gas_cost_eth * eth_price_usd
        return gas_cost_usd / payment_count

    async def _check_auto_settle(self, window_key: str) -> None:
        """Auto-settle ``window_key`` when ITS OWN queued items cross a threshold.

        The decision is scoped to the target window's own queued items, NOT the
        engine-wide aggregate (CodeRabbit #10). Previously ``should_settle`` came
        from :meth:`get_queue_statistics` (all windows + pending items), so once
        historical/pending items pushed the engine-wide total over a threshold,
        queueing a single payment into a fresh window would settle only that new
        sub-threshold window while the genuinely-full window sat unsettled.
        """
        if self._window_should_settle(window_key):
            payment_ids = self._payment_ids_for_window(window_key)
            if payment_ids:
                await self.batch_payments(payment_ids)

    def _window_should_settle(self, window_key: str) -> bool:
        """Whether a window's OWN queued items meet a settlement threshold.

        Mirrors the engine-wide ``should_settle`` rule (count OR total USD) but
        over only this window's ``queued`` items, so a window settles on its own
        contents independent of other windows or pending items (CodeRabbit #10).
        """
        items = self._queue.get(window_key)
        if not items:
            return False
        queued = [item for item in items if item.status == "queued"]
        if not queued:
            return False
        count = len(queued)
        total_usd = sum(float(item.amount_usd) for item in queued)
        return count >= self._min_payment_count or total_usd >= self._min_total_usd

    def _batch_window_key(self) -> str:
        """Compute the current batch-window key from the wall clock."""
        window_start = (_now_ms() // self._batch_window_ms) * self._batch_window_ms
        return f"window_{window_start}"

    def _payment_ids_for_window(self, window_key: str) -> List[str]:
        items = self._queue.get(window_key)
        return [p.payment_id for p in items] if items else []
