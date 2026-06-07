"""Thin MPP (Machine Payments Protocol — Stripe/Tempo) capability seam.

Python port of ``src/mpp-seam.ts``. This is deliberately NOT a client.

WHY a seam and not a client: at time of writing, Stripe/Tempo MPP is still in
PREVIEW — version-pinned, bound to the Tempo L1, and sharing NO signing code with
our EIP-3009 core (MPP uses a different challenge/credential model). Building a
full MPP client now would mean committing to a moving, preview-stage target with a
separate crypto stack.

Instead this module provides the *shape* of MPP support: it can DETECT whether a
server advertises MPP (so a caller can negotiate/route), and exposes a ``settle``
entry point that LOUDLY raises ``MPP_NOT_IMPLEMENTED`` (HTTP 501). When MPP exits
preview, the real settlement path slots in behind this seam without changing the
public surface. Full MPP is deferred to GA.

Dependencies: ``paybot_sdk.errors`` (PayBotApiError).
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Callable, Dict, Literal, Optional

from .errors import PayBotApiError


@dataclass
class MppCapability:
    """The result of probing a server for MPP support.

    :param supported: Whether any MPP advertisement was detected.
    :param mode: ``'none'`` | ``'detect-only'`` | ``'preview'`` (today only the
        first two are produced).
    :param spec_version: The advertised spec/version string, when provided.
    :param reason: Human-readable reason, populated when ``supported`` is ``False``.
    """

    supported: bool
    mode: Literal["none", "detect-only", "preview"]
    spec_version: Optional[str] = None
    reason: Optional[str] = None


# Header names that, when present, indicate a server advertises MPP. Compared
# case-insensitively.
_MPP_VERSION_HEADERS = ("mpp-version", "stripe-version")


def _read_header_ci(headers: Dict[str, str], name: str) -> Optional[str]:
    """Read a header value by name, case-insensitively. ``None`` when absent."""
    target = name.lower()
    for key, value in headers.items():
        if key.lower() == target:
            return value
    return None


def detect_mpp_capability(
    server_headers: Optional[Dict[str, str]] = None,
) -> MppCapability:
    """Detect whether response headers advertise MPP support.

    Detection is purely passive — this NEVER signs or settles. It inspects, case
    insensitively, for either an ``MPP-Version`` / ``Stripe-Version`` header
    (value becomes ``spec_version``) or a ``WWW-Authenticate`` challenge whose
    value mentions ``Payment`` (an MPP-style 402 challenge).

    :param server_headers: Response headers to inspect. ``None``/empty → not supported.
    :returns: An :class:`MppCapability`.

    :example:
        >>> detect_mpp_capability({"MPP-Version": "2024-09-preview"}).supported
        True
        >>> detect_mpp_capability({}).supported
        False
    """
    if not server_headers:
        return MppCapability(supported=False, mode="none", reason="no MPP advertisement")

    for header_name in _MPP_VERSION_HEADERS:
        value = _read_header_ci(server_headers, header_name)
        if value:
            return MppCapability(supported=True, mode="detect-only", spec_version=value)

    challenge = _read_header_ci(server_headers, "www-authenticate")
    if challenge and re.search(r"payment", challenge, re.IGNORECASE):
        return MppCapability(supported=True, mode="detect-only", spec_version=challenge)

    return MppCapability(supported=False, mode="none", reason="no MPP advertisement")


@dataclass
class MppAdapter:
    """The shape of an MPP adapter. ``detect`` is real; ``settle`` is a dead-end
    that always raises ``MPP_NOT_IMPLEMENTED`` until MPP exits preview.
    """

    detect: Callable[..., MppCapability]
    settle: Callable[..., Any]


def create_mpp_seam() -> MppAdapter:
    """Create the MPP capability seam.

    The returned adapter can DETECT MPP advertisements but cannot settle: its
    ``settle`` raises :class:`PayBotApiError` ``MPP_NOT_IMPLEMENTED`` (HTTP 501).
    This keeps the seam's shape real and testable while keeping the unbuilt
    settlement path loud rather than silently broken.

    :returns: An :class:`MppAdapter` whose ``settle`` always raises.

    :example:
        >>> seam = create_mpp_seam()
        >>> seam.detect({"MPP-Version": "x"}).supported
        True
    """

    def _detect(headers: Optional[Dict[str, str]] = None) -> MppCapability:
        return detect_mpp_capability(headers)

    def _settle(*_args: Any, **_kwargs: Any):
        raise PayBotApiError(
            "MPP settlement is not implemented: full MPP support is deferred until "
            "MPP exits preview. The EIP-3009 signing path does not transfer to MPP "
            "(different challenge/credential model); this seam exists to detect and "
            "route, not to pay.",
            "MPP_NOT_IMPLEMENTED",
            501,
        )

    return MppAdapter(detect=_detect, settle=_settle)
