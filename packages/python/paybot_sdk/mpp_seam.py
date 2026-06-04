"""Thin MPP (Machine Payments Protocol — Stripe/Tempo) capability seam.
Mirrors ``src/mpp-seam.ts``. This is deliberately NOT a client.

WHY a seam and not a client:
    At time of writing, Stripe/Tempo MPP is still in PREVIEW: version-pinned and
    bound to the Tempo L1, sharing NO signing code with our EIP-3009 core. Our
    x402 signing path (EIP-3009 ``TransferWithAuthorization`` over EVM) does not
    transfer to MPP — MPP uses a different challenge/credential model. So building
    a full MPP client now would mean committing to a moving, preview-stage target
    with a separate crypto stack.

    Instead, this module provides the *shape* of MPP support: it can DETECT
    whether a server advertises MPP (so a caller can negotiate/route), and it
    exposes a ``settle`` entry point that LOUDLY raises ``MPP_NOT_IMPLEMENTED``.
    When MPP exits preview, the real settlement path slots in behind this seam
    without changing the public surface.

Dependencies: ./errors (PayBotApiError).
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Dict, Literal, NoReturn, Optional

from .errors import PayBotApiError

#: Header names that, when present, indicate a server advertises MPP. Compared
#: case-insensitively. ``WWW-Authenticate`` only counts when its value mentions
#: a payment challenge (see :func:`detect_mpp_capability`).
MPP_VERSION_HEADERS = ("mpp-version", "stripe-version")


@dataclass
class MppCapability:
    """The result of probing a server for MPP support (mpp-seam.ts:35-44).

    - ``mode='none'``        — no MPP advertisement seen; not supported.
    - ``mode='detect-only'`` — MPP advertised; we can detect/route but NOT settle.
    - ``mode='preview'``     — reserved for a future preview-grade settlement path.

    :param supported: Whether any MPP advertisement was detected.
    :param mode: Capability mode. Today only ``'none'``/``'detect-only'`` are produced.
    :param spec_version: The advertised spec/version string, when provided.
    :param reason: Human-readable reason, populated when ``supported`` is ``False``.
    """

    supported: bool
    mode: Literal["none", "detect-only", "preview"]
    spec_version: Optional[str] = None
    reason: Optional[str] = None


def _read_header_ci(headers: Dict[str, str], name: str) -> Optional[str]:
    """Read a header value case-insensitively from a plain dict (mpp-seam.ts:60)."""
    target = name.lower()
    for key in headers:
        if key.lower() == target:
            return headers[key]
    return None


def detect_mpp_capability(server_headers: Optional[Dict[str, str]] = None) -> MppCapability:
    """Detect whether response headers advertise MPP support (mpp-seam.ts:92).

    Detection is purely passive — this NEVER signs or settles. It inspects, case
    insensitively, for either an ``MPP-Version`` / ``Stripe-Version`` header
    (value becomes ``spec_version``), or a ``WWW-Authenticate`` challenge whose
    value mentions ``Payment``.

    :param server_headers: Response headers to inspect. Omitted/empty → not supported.
    :returns: ``MppCapability(supported=True, mode='detect-only', spec_version=...)``
        when advertised; otherwise ``MppCapability(supported=False, mode='none', reason=...)``.
    """
    if not server_headers or len(server_headers) == 0:
        return MppCapability(supported=False, mode="none", reason="no MPP advertisement")

    for header_name in MPP_VERSION_HEADERS:
        value = _read_header_ci(server_headers, header_name)
        if value and len(value) > 0:
            return MppCapability(supported=True, mode="detect-only", spec_version=value)

    challenge = _read_header_ci(server_headers, "www-authenticate")
    if challenge and re.search(r"payment", challenge, re.IGNORECASE):
        return MppCapability(supported=True, mode="detect-only", spec_version=challenge)

    return MppCapability(supported=False, mode="none", reason="no MPP advertisement")


class MppAdapter:
    """The shape of an MPP adapter (mpp-seam.ts:119).

    ``detect`` is real; ``settle`` is intentionally a dead-end (raises) until MPP
    exits preview — see :func:`create_mpp_seam`.
    """

    def detect(self, headers: Optional[Dict[str, str]] = None) -> MppCapability:
        """Detect MPP support from response headers."""
        return detect_mpp_capability(headers)

    def settle(self, *args: object, **kwargs: object) -> NoReturn:
        """Settle via MPP. NOT implemented — always raises ``MPP_NOT_IMPLEMENTED`` (501).

        :raises PayBotApiError: always, with code ``MPP_NOT_IMPLEMENTED`` and HTTP 501.
        """
        raise PayBotApiError(
            "MPP settlement is not implemented: full MPP support is deferred until "
            "MPP exits preview. The EIP-3009 signing path does not transfer to "
            "MPP (different challenge/credential model); this seam exists to "
            "detect and route, not to pay.",
            "MPP_NOT_IMPLEMENTED",
            501,
        )


def create_mpp_seam() -> MppAdapter:
    """Create the MPP capability seam (mpp-seam.ts:145).

    The returned adapter can DETECT MPP advertisements but cannot settle: its
    :meth:`MppAdapter.settle` raises ``MPP_NOT_IMPLEMENTED`` (501).

    :returns: An :class:`MppAdapter` whose ``settle`` always raises.
    """
    return MppAdapter()
