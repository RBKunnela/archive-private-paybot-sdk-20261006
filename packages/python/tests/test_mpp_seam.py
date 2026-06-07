"""Tests for the MPP capability seam. Mirrors tests/mpp-seam.test.ts.

detect_mpp_capability is real (header probe); settle is a loud dead-end raising
MPP_NOT_IMPLEMENTED (501). Full MPP is deferred to GA.
"""
from __future__ import annotations

import pytest

from paybot_sdk.errors import PayBotApiError
from paybot_sdk.mpp_seam import (
    MppCapability,
    create_mpp_seam,
    detect_mpp_capability,
)


# ── detect_mpp_capability ─────────────────────────────────────────────────


def test_detect_mpp_version_header():
    cap = detect_mpp_capability({"MPP-Version": "2024-09-preview"})
    assert isinstance(cap, MppCapability)
    assert cap.supported is True
    assert cap.mode == "detect-only"
    assert cap.spec_version == "2024-09-preview"


def test_detect_stripe_version_header_case_insensitive():
    cap = detect_mpp_capability({"stripe-version": "2024-06-20"})
    assert cap.supported is True
    assert cap.spec_version == "2024-06-20"


def test_detect_www_authenticate_payment_challenge():
    cap = detect_mpp_capability({"WWW-Authenticate": "Payment realm=mpp"})
    assert cap.supported is True
    assert cap.mode == "detect-only"
    assert "Payment" in cap.spec_version


def test_detect_no_headers_not_supported():
    cap = detect_mpp_capability(None)
    assert cap.supported is False
    assert cap.mode == "none"
    assert cap.reason == "no MPP advertisement"


def test_detect_empty_headers_not_supported():
    cap = detect_mpp_capability({})
    assert cap.supported is False
    assert cap.mode == "none"


def test_detect_unrelated_www_authenticate_not_supported():
    # A non-payment challenge is not MPP.
    cap = detect_mpp_capability({"WWW-Authenticate": "Bearer realm=api"})
    assert cap.supported is False
    assert cap.mode == "none"


# ── create_mpp_seam ───────────────────────────────────────────────────────


def test_seam_detect_delegates():
    seam = create_mpp_seam()
    assert seam.detect({"MPP-Version": "x"}).supported is True
    assert seam.detect({}).supported is False


def test_seam_settle_raises_not_implemented():
    seam = create_mpp_seam()
    with pytest.raises(PayBotApiError) as exc:
        seam.settle()
    assert exc.value.code == "MPP_NOT_IMPLEMENTED"
    assert exc.value.status_code == 501


def test_seam_settle_raises_with_any_args():
    # Edge: the dead-end raises regardless of arguments.
    seam = create_mpp_seam()
    with pytest.raises(PayBotApiError) as exc:
        seam.settle("a", "b", key="value")
    assert exc.value.code == "MPP_NOT_IMPLEMENTED"
