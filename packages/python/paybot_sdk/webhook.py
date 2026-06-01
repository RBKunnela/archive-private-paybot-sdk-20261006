"""Webhook signature verification.

Mirrors the TS SDK's ``verifyWebhookSignature`` (``src/webhook.ts``) byte-for-byte
so a webhook signed by the PayBot server verifies identically in TypeScript and
Python.

Header convention::

    Paybot-Signature: t=<unix_ts>,v1=<hex>

where ``<hex>`` is ``HMAC-SHA256(secret, f"{t}.{payload}")`` rendered as
lowercase hex. The signing string is the timestamp, a literal ``.``, then the
raw request body. A replay guard rejects timestamps outside ``tolerance``
seconds of now.
"""
from __future__ import annotations

import hashlib
import hmac
import time
from typing import Union


def _parse_signature_header(header: str) -> tuple[str, str]:
    """Parse a ``Paybot-Signature`` header into ``(timestamp, v1_hex)``.

    :param header: Raw header value, e.g. ``"t=1700000000,v1=abc123"``.
    :returns: Tuple of the ``t`` and ``v1`` values as strings.
    :raises ValueError: if the header is malformed or missing either field.
    """
    timestamp: str | None = None
    v1: str | None = None
    for part in header.split(","):
        part = part.strip()
        if "=" not in part:
            raise ValueError("malformed signature header segment")
        key, _, value = part.partition("=")
        key = key.strip()
        value = value.strip()
        if key == "t":
            timestamp = value
        elif key == "v1":
            v1 = value
    if not timestamp or not v1:
        raise ValueError("signature header missing t or v1")
    return timestamp, v1


def verify_webhook_signature(
    payload: Union[str, bytes],
    signature: str,
    secret: str,
    tolerance: int = 300,
) -> bool:
    """Verify a PayBot webhook signature.

    Recomputes ``HMAC-SHA256(secret, f"{t}.{payload}")`` and compares it against
    the ``v1`` value carried in the ``signature`` header using a constant-time
    comparison. The timestamp ``t`` must be within ``tolerance`` seconds of the
    current time, which guards against replayed deliveries.

    The signing string (``f"{t}.{payload}"``) and the header format match the TS
    SDK's ``verifyWebhookSignature`` exactly, so a signature produced by the
    server verifies identically across both runtimes.

    :param payload: Raw webhook request body (the exact bytes/text the server
        signed). ``bytes`` are decoded as UTF-8 before signing.
    :param signature: Value of the ``Paybot-Signature`` header, of the form
        ``"t=<unix_ts>,v1=<hex>"``.
    :param secret: Shared webhook signing secret.
    :param tolerance: Maximum allowed age (and future skew) of the timestamp in
        seconds. Defaults to 300.
    :returns: ``True`` if the signature is valid and fresh, ``False`` otherwise.
        Never raises on malformed input — a bad header returns ``False``.

    :example:
        >>> verify_webhook_signature(body, "t=1700000000,v1=...", "whsec_x")
        True
    """
    if isinstance(payload, bytes):
        payload_str = payload.decode("utf-8")
    else:
        payload_str = payload

    try:
        timestamp, provided_v1 = _parse_signature_header(signature)
    except ValueError:
        return False

    # Replay guard: timestamp must be a valid integer within tolerance of now.
    try:
        ts_int = int(timestamp)
    except (TypeError, ValueError):
        return False
    if abs(int(time.time()) - ts_int) > tolerance:
        return False

    signing_string = f"{timestamp}.{payload_str}"
    expected_v1 = hmac.new(
        secret.encode("utf-8"),
        signing_string.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    # Constant-time comparison to avoid timing oracles.
    return hmac.compare_digest(expected_v1, provided_v1)
