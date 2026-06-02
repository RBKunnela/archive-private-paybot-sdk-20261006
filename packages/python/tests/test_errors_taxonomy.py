"""Tests for the 8-class error taxonomy. Mirrors ``tests/errors-taxonomy.test.ts``.

Per Quality Foundation (happy / error / edge per function):
- each subclass instantiates with its documented defaults
- every subclass satisfies ``isinstance(e, PayBotApiError)`` + ``PayBotError``
- ``map_http_error`` routes Policy / Auth / base correctly
- ``POLICY_ERROR_CODES`` membership
- back-compat: existing positional ``PayBotApiError(msg, code, status)`` works
"""
from __future__ import annotations

import pytest

from paybot_sdk import (
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


# ── PayBotError root ──────────────────────────────────────────────────────


def test_paybot_error_carries_code_and_details():
    e = PayBotError("boom", "SOME_CODE", {"k": "v"})
    assert e.code == "SOME_CODE"
    assert e.details == {"k": "v"}
    assert str(e) == "boom"


def test_paybot_error_details_default_none():
    e = PayBotError("boom", "SOME_CODE")
    assert e.details is None


def test_paybot_error_is_exception():
    assert isinstance(PayBotError("x", "C"), Exception)


# ── PayBotApiError back-compat anchor ─────────────────────────────────────


def test_api_error_positional_signature():
    # Existing call sites pass (message, code, status_code) positionally.
    e = PayBotApiError("not found", "HTTP_ERROR", 404)
    assert e.code == "HTTP_ERROR"
    assert e.status_code == 404
    assert e.details is None


def test_api_error_with_details():
    e = PayBotApiError("bad", "X", 400, {"field": "amount"})
    assert e.details == {"field": "amount"}


def test_api_error_is_paybot_error():
    assert isinstance(PayBotApiError("x", "C", 0), PayBotError)


# ── Subclass defaults (mirror errors.ts constructor defaults) ─────────────


def test_network_error_defaults():
    e = PayBotNetworkError("conn refused")
    assert e.code == "NETWORK_ERROR"
    assert e.status_code == 0


def test_network_error_override():
    e = PayBotNetworkError("dns", "DNS_FAIL", 0)
    assert e.code == "DNS_FAIL"


def test_timeout_error_defaults():
    e = PayBotTimeoutError("too slow")
    assert e.code == "TIMEOUT"
    assert e.status_code == 0


def test_auth_error_defaults():
    e = PayBotAuthError("no")
    assert e.code == "AUTHENTICATION_FAILED"
    assert e.status_code == 401


def test_auth_error_403_override():
    e = PayBotAuthError("forbidden", "FORBIDDEN", 403)
    assert e.status_code == 403


def test_policy_error_defaults():
    e = PayBotPolicyError("trust")
    assert e.code == "POLICY_VIOLATION"
    assert e.status_code == 403


def test_policy_error_preserves_server_code():
    e = PayBotPolicyError("Trust violation", "TRUST_VIOLATION")
    assert e.code == "TRUST_VIOLATION"
    assert e.status_code == 403  # picked up the default


def test_signature_error_defaults():
    e = PayBotSignatureError("bad sig")
    assert e.code == "SIGNATURE_FAILED"
    assert e.status_code == 0


def test_settlement_error_defaults():
    e = PayBotSettlementError("chain reject")
    assert e.code == "SETTLEMENT_FAILED"
    assert e.status_code == 502


# ── isinstance chain — every subclass is a PayBotApiError ──────────────────


@pytest.mark.parametrize(
    "cls",
    [
        PayBotNetworkError,
        PayBotTimeoutError,
        PayBotAuthError,
        PayBotPolicyError,
        PayBotSignatureError,
        PayBotSettlementError,
    ],
)
def test_every_subclass_is_api_error(cls):
    e = cls("msg")
    assert isinstance(e, PayBotApiError)
    assert isinstance(e, PayBotError)
    assert isinstance(e, Exception)


def test_except_paybot_api_error_catches_subclass():
    # The behavior the spec preserves: existing `except PayBotApiError` blocks.
    caught = False
    try:
        raise PayBotPolicyError("trust", "TRUST_VIOLATION")
    except PayBotApiError as e:
        caught = True
        assert e.code == "TRUST_VIOLATION"
    assert caught


# ── POLICY_ERROR_CODES ────────────────────────────────────────────────────


def test_policy_error_codes_membership():
    assert "TRUST_VIOLATION" in POLICY_ERROR_CODES
    assert "AML_BLOCKED" in POLICY_ERROR_CODES
    assert "DAILY_LIMIT_EXCEEDED" in POLICY_ERROR_CODES
    assert "SPENDING_ENVELOPE" in POLICY_ERROR_CODES


def test_policy_error_codes_excludes_random():
    assert "HTTP_ERROR" not in POLICY_ERROR_CODES


def test_policy_error_codes_is_frozen():
    assert isinstance(POLICY_ERROR_CODES, frozenset)


# ── map_http_error routing ─────────────────────────────────────────────────


def test_map_http_error_policy_code_wins():
    e = map_http_error("Trust violation", "TRUST_VIOLATION", 403)
    assert isinstance(e, PayBotPolicyError)
    assert e.code == "TRUST_VIOLATION"


def test_map_http_error_policy_code_even_at_non_403():
    # Policy code precedence over the status check.
    e = map_http_error("limit", "DAILY_LIMIT_EXCEEDED", 429)
    assert isinstance(e, PayBotPolicyError)


def test_map_http_error_401_to_auth():
    e = map_http_error("unauthorized", "AUTHENTICATION_FAILED", 401)
    assert isinstance(e, PayBotAuthError)


def test_map_http_error_403_to_auth_when_not_policy():
    e = map_http_error("forbidden", "FORBIDDEN", 403)
    assert isinstance(e, PayBotAuthError)
    assert not isinstance(e, PayBotPolicyError)


def test_map_http_error_other_to_base():
    e = map_http_error("not found", "HTTP_ERROR", 404)
    assert type(e) is PayBotApiError


def test_map_http_error_preserves_details():
    e = map_http_error("x", "HTTP_ERROR", 500, {"trace": "abc"})
    assert e.details == {"trace": "abc"}


# ── get_error_message ──────────────────────────────────────────────────────


def test_get_error_message_from_exception():
    assert get_error_message(ValueError("oops")) == "oops"


def test_get_error_message_from_string():
    assert get_error_message("plain") == "plain"


def test_get_error_message_fallback():
    assert get_error_message(12345) == "Unknown error"


def test_get_error_message_empty_exception_uses_class_name():
    assert get_error_message(ValueError()) == "ValueError"
