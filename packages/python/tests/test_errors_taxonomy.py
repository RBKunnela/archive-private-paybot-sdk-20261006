"""Tests for the PayBot error taxonomy. Mirrors tests/errors-taxonomy.test.ts.

>=3 per public function/class (happy / error / edge) per Quality Foundation.
"""
from __future__ import annotations

import pytest

from paybot_sdk.errors import (
    POLICY_ERROR_CODES,
    PayBotApiError,
    PayBotAuthError,
    PayBotError,
    PayBotNetworkError,
    PayBotPolicyError,
    PayBotSettlementError,
    PayBotSignatureError,
    PayBotTimeoutError,
    PayBotUnsupportedSigningMethodError,
    get_error_message,
    map_http_error,
)

ALL_SUBCLASSES = [
    PayBotNetworkError,
    PayBotTimeoutError,
    PayBotAuthError,
    PayBotPolicyError,
    PayBotSignatureError,
    PayBotSettlementError,
    PayBotUnsupportedSigningMethodError,
]


# ── back-compat: every subclass IS a PayBotApiError ──────────────────────


@pytest.mark.parametrize("cls", ALL_SUBCLASSES)
def test_subclass_is_apierror_and_error(cls):
    e = cls("boom")
    assert isinstance(e, PayBotApiError)
    assert isinstance(e, PayBotError)
    assert isinstance(e, Exception)


@pytest.mark.parametrize("cls", ALL_SUBCLASSES)
def test_subclass_carries_code_and_status(cls):
    e = cls("boom")
    assert isinstance(e.code, str) and len(e.code) > 0
    assert isinstance(e.status_code, int)


def test_default_codes_and_status():
    assert PayBotNetworkError("x").code == "NETWORK_ERROR"
    assert PayBotNetworkError("x").status_code == 0
    assert PayBotTimeoutError("x").code == "TIMEOUT"
    assert PayBotAuthError("x").status_code == 401
    assert PayBotPolicyError("x").status_code == 403
    assert PayBotSignatureError("x").status_code == 0
    assert PayBotSettlementError("x").status_code == 502
    assert PayBotUnsupportedSigningMethodError("x").status_code == 400


# ── map_http_error dispatch ──────────────────────────────────────────────


def test_map_http_error_policy_code_to_policy_error():
    for code in POLICY_ERROR_CODES:
        e = map_http_error("nope", code, 403)
        assert isinstance(e, PayBotPolicyError)
        assert isinstance(e, PayBotApiError)
        assert e.code == code  # server code preserved


def test_map_http_error_401_403_to_auth_error():
    assert isinstance(map_http_error("a", "BAD", 401), PayBotAuthError)
    assert isinstance(map_http_error("a", "BAD", 403), PayBotAuthError)


def test_map_http_error_other_to_base_apierror():
    e = map_http_error("a", "HTTP_ERROR", 404)
    assert isinstance(e, PayBotApiError)
    assert not isinstance(e, PayBotAuthError)
    assert not isinstance(e, PayBotPolicyError)


def test_map_http_error_policy_beats_status_precedence():
    # Policy code wins even on a 403 (would otherwise be auth).
    e = map_http_error("trust", "TRUST_VIOLATION", 403)
    assert isinstance(e, PayBotPolicyError)


# ── get_error_message ─────────────────────────────────────────────────────


def test_get_error_message_from_exception():
    assert get_error_message(ValueError("kaboom")) == "kaboom"


def test_get_error_message_from_string():
    assert get_error_message("plain") == "plain"


def test_get_error_message_unknown():
    assert get_error_message(12345) == "Unknown error"


def test_get_error_message_empty_exception_falls_back_to_classname():
    assert get_error_message(ValueError("")) == "ValueError"


# ── details propagation ───────────────────────────────────────────────────


def test_details_propagate_through_taxonomy():
    e = PayBotPolicyError("d", "DAILY_LIMIT_EXCEEDED", 403, {"limit": 100})
    assert e.details == {"limit": 100}
