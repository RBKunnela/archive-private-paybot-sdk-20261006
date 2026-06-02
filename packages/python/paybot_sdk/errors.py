"""PayBot error taxonomy. Mirrors ``src/errors.ts``.

Hierarchy (all subclasses of :class:`PayBotApiError` stay ``isinstance``
``PayBotApiError`` for back-compat)::

    Exception
     └─ PayBotError          (abstract root: code + optional details)
         └─ PayBotApiError   (message, code, status_code, details?)  <- back-compat anchor
             ├─ PayBotNetworkError     (connection/DNS/refused)
             ├─ PayBotTimeoutError     (request timeout)
             ├─ PayBotAuthError        (401/403)
             ├─ PayBotPolicyError      (trust/AML/limit)
             ├─ PayBotSignatureError   (EIP-3009/EIP-712 signing)
             └─ PayBotSettlementError  (chain rejected the tx)

The Python port keeps the existing ``PayBotApiError(message, code, status_code,
details=None)`` positional signature unchanged so the ~96 existing call sites in
``client.py`` keep working. The 7 new subclasses are additive.
"""
from __future__ import annotations

from typing import Any, Dict, FrozenSet, Optional


class PayBotError(Exception):
    """Abstract root of the PayBot error taxonomy.

    Carries a machine-readable :attr:`code` and optional structured
    :attr:`details`. Not raised directly — concrete subclasses extend
    :class:`PayBotApiError`. Mirrors the TS ``PayBotError`` (errors.ts:27-39).

    :param message: Human-readable error message.
    :param code: Machine-readable error code (e.g. ``'NETWORK_ERROR'``).
    :param details: Optional structured error context.
    """

    code: str
    details: Optional[Dict[str, Any]]

    def __init__(
        self,
        message: str,
        code: str,
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.details = details


class PayBotApiError(PayBotError):
    """SDK-facing error raised by PayBotClient methods on non-2xx responses.

    The back-compat anchor: every specialized subtype extends this class, so
    ``isinstance(e, PayBotApiError)`` and reads of ``.code`` / ``.status_code`` /
    ``.details`` keep working unchanged. Mirrors errors.ts:53-66.

    :param message: Human-readable error message.
    :param code: Machine-readable error code.
    :param status_code: HTTP status code (0 for transport-level errors).
    :param details: Optional structured error context.
    """

    status_code: int

    def __init__(
        self,
        message: str,
        code: str,
        status_code: int,
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        super().__init__(message, code, details)
        self.status_code = status_code


class PayBotNetworkError(PayBotApiError):
    """Connection-level failure (DNS, connection refused, socket reset).

    Mirrors errors.ts:76. Defaults: ``code='NETWORK_ERROR'``, ``status_code=0``.
    """

    def __init__(
        self,
        message: str,
        code: str = "NETWORK_ERROR",
        status_code: int = 0,
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        super().__init__(message, code, status_code, details)


class PayBotTimeoutError(PayBotApiError):
    """Request exceeded the configured timeout and was aborted.

    Mirrors errors.ts:96. Defaults: ``code='TIMEOUT'``, ``status_code=0``.
    """

    def __init__(
        self,
        message: str,
        code: str = "TIMEOUT",
        status_code: int = 0,
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        super().__init__(message, code, status_code, details)


class PayBotAuthError(PayBotApiError):
    """Authentication / authorization failure (HTTP 401 or 403).

    Mirrors errors.ts:116. Defaults: ``code='AUTHENTICATION_FAILED'``,
    ``status_code=401``.
    """

    def __init__(
        self,
        message: str,
        code: str = "AUTHENTICATION_FAILED",
        status_code: int = 401,
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        super().__init__(message, code, status_code, details)


class PayBotPolicyError(PayBotApiError):
    """Policy rejection — trust violation, AML block, spending limit, envelope.

    The server-provided ``code`` is preserved (e.g. ``'TRUST_VIOLATION'``).
    Mirrors errors.ts:137. Defaults: ``code='POLICY_VIOLATION'``,
    ``status_code=403``.
    """

    def __init__(
        self,
        message: str,
        code: str = "POLICY_VIOLATION",
        status_code: int = 403,
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        super().__init__(message, code, status_code, details)


class PayBotSignatureError(PayBotApiError):
    """EIP-3009 / EIP-712 signing failed (bad key, malformed domain, signer).

    Mirrors errors.ts:157. Defaults: ``code='SIGNATURE_FAILED'``,
    ``status_code=0`` (failure is local, pre-network).
    """

    def __init__(
        self,
        message: str,
        code: str = "SIGNATURE_FAILED",
        status_code: int = 0,
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        super().__init__(message, code, status_code, details)


class PayBotSettlementError(PayBotApiError):
    """On-chain settlement failure — the chain rejected the transaction.

    Mirrors errors.ts:177. Defaults: ``code='SETTLEMENT_FAILED'``,
    ``status_code=502``.
    """

    def __init__(
        self,
        message: str,
        code: str = "SETTLEMENT_FAILED",
        status_code: int = 502,
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        super().__init__(message, code, status_code, details)


#: Server policy codes that map to :class:`PayBotPolicyError` (errors.ts:194-199).
POLICY_ERROR_CODES: FrozenSet[str] = frozenset(
    {
        "TRUST_VIOLATION",
        "AML_BLOCKED",
        "DAILY_LIMIT_EXCEEDED",
        "SPENDING_ENVELOPE",
    }
)


def map_http_error(
    message: str,
    code: str,
    status_code: int,
    details: Optional[Dict[str, Any]] = None,
) -> PayBotApiError:
    """Construct the most specific :class:`PayBotApiError` subclass for an HTTP error.

    Mapping (mirrors errors.ts:221-234):

    - policy codes (see :data:`POLICY_ERROR_CODES`) -> :class:`PayBotPolicyError`
    - 401/403 -> :class:`PayBotAuthError`
    - everything else -> :class:`PayBotApiError`

    Policy codes take precedence over the 403 status check so a
    ``TRUST_VIOLATION`` at 403 maps to :class:`PayBotPolicyError`, not
    :class:`PayBotAuthError`.

    :param message: Human-readable error message.
    :param code: Server-provided machine-readable code.
    :param status_code: HTTP status code.
    :param details: Optional structured error context.
    :returns: The most specific matching error instance (always
        ``isinstance(..., PayBotApiError)``).

    :example:
        >>> err = map_http_error("Trust violation", "TRUST_VIOLATION", 403)
        >>> isinstance(err, PayBotPolicyError)
        True
    """
    if code in POLICY_ERROR_CODES:
        return PayBotPolicyError(message, code, status_code, details)
    if status_code in (401, 403):
        return PayBotAuthError(message, code, status_code, details)
    return PayBotApiError(message, code, status_code, details)


def get_error_message(error: Any) -> str:
    """Extract a string message from any exception-like value (errors.ts:239)."""
    if isinstance(error, BaseException):
        return str(error) or error.__class__.__name__
    if isinstance(error, str):
        return error
    return "Unknown error"
