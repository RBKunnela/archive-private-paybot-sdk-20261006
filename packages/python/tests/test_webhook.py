"""Tests for `verify_webhook_signature`.

Covers, per Quality Foundation (>=3 per function — happy / error / edge):
- valid signature passes
- tampered payload fails (HMAC mismatch)
- tampered/forged signature value fails
- expired timestamp fails (replay guard)
- future timestamp beyond tolerance fails
- malformed header fails (no t, no v1, junk, empty)
- bytes payload verifies identically to str payload
- custom tolerance honored
- signing string contract: matches f"{t}.{payload}" exactly (TS parity)
"""
from __future__ import annotations

import hashlib
import hmac
import time

from paybot_sdk import verify_webhook_signature
from paybot_sdk.webhook import _parse_signature_header

SECRET = "whsec_test_secret"


def _sign(payload: str, secret: str = SECRET, t: int | None = None) -> str:
    """Produce a header the same way the PayBot server / TS SDK does:
    Paybot-Signature: t=<ts>,v1=<hmac_sha256_hex(f"{t}.{payload}")>."""
    if t is None:
        t = int(time.time())
    mac = hmac.new(
        secret.encode("utf-8"), f"{t}.{payload}".encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return f"t={t},v1={mac}"


# ── happy path ────────────────────────────────────────────────────────────


def test_valid_signature_passes():
    payload = '{"event":"payment.settled","id":"evt_1"}'
    assert verify_webhook_signature(payload, _sign(payload), SECRET) is True


def test_bytes_payload_verifies_like_str():
    payload = '{"event":"payment.settled"}'
    header = _sign(payload)
    assert verify_webhook_signature(payload.encode("utf-8"), header, SECRET) is True


def test_custom_tolerance_allows_older_timestamp():
    payload = "body"
    old_t = int(time.time()) - 1000
    header = _sign(payload, t=old_t)
    # default 300 rejects it; a wide tolerance accepts it
    assert verify_webhook_signature(payload, header, SECRET, tolerance=300) is False
    assert verify_webhook_signature(payload, header, SECRET, tolerance=2000) is True


# ── error: tampering ──────────────────────────────────────────────────────


def test_tampered_payload_fails():
    payload = '{"amount":"1.00"}'
    header = _sign(payload)
    tampered = '{"amount":"9999.00"}'
    assert verify_webhook_signature(tampered, header, SECRET) is False


def test_forged_signature_value_fails():
    payload = "body"
    t = int(time.time())
    header = f"t={t},v1={'0' * 64}"
    assert verify_webhook_signature(payload, header, SECRET) is False


def test_wrong_secret_fails():
    payload = "body"
    header = _sign(payload, secret="whsec_other")
    assert verify_webhook_signature(payload, header, SECRET) is False


# ── error: replay guard ───────────────────────────────────────────────────


def test_expired_timestamp_fails():
    payload = "body"
    header = _sign(payload, t=int(time.time()) - 301)
    assert verify_webhook_signature(payload, header, SECRET, tolerance=300) is False


def test_future_timestamp_beyond_tolerance_fails():
    payload = "body"
    header = _sign(payload, t=int(time.time()) + 600)
    assert verify_webhook_signature(payload, header, SECRET, tolerance=300) is False


# ── edge: malformed headers ───────────────────────────────────────────────


def test_malformed_header_missing_v1_fails():
    payload = "body"
    assert verify_webhook_signature(payload, f"t={int(time.time())}", SECRET) is False


def test_malformed_header_missing_t_fails():
    payload = "body"
    assert verify_webhook_signature(payload, "v1=deadbeef", SECRET) is False


def test_malformed_header_junk_fails():
    payload = "body"
    assert verify_webhook_signature(payload, "not-a-signature", SECRET) is False


def test_empty_header_fails():
    assert verify_webhook_signature("body", "", SECRET) is False


def test_non_integer_timestamp_fails():
    payload = "body"
    # well-formed structurally but t is not an int
    mac = hmac.new(
        SECRET.encode(), f"abc.{payload}".encode(), hashlib.sha256
    ).hexdigest()
    assert verify_webhook_signature(payload, f"t=abc,v1={mac}", SECRET) is False


# ── contract: signing string / header parsing (TS parity) ─────────────────


def test_signing_string_is_t_dot_payload():
    """Guards the cross-language contract: the signed bytes MUST be
    f"{t}.{payload}" — if this changes, TS and Python diverge."""
    payload = "hello"
    t = 1_700_000_000
    expected = hmac.new(
        SECRET.encode(), f"{t}.{payload}".encode(), hashlib.sha256
    ).hexdigest()
    header = f"t={t},v1={expected}"
    assert verify_webhook_signature(payload, header, SECRET, tolerance=10**12) is True


def test_parse_signature_header_extracts_fields():
    t, v1 = _parse_signature_header("t=123,v1=abcdef")
    assert t == "123"
    assert v1 == "abcdef"
