"""PayBot error taxonomy. Mirrors ``src/errors.ts``.

Hierarchy (every concrete subclass stays ``isinstance(e, PayBotApiError)`` for
back-compat — existing code that catches ``PayBotApiError`` keeps working)::

    Exception
     └─ PayBotError              (abstract root: code + optional details)
         └─ PayBotApiError       (message, code, status_code, details?)  ← back-compat anchor
             ├─ PayBotNetworkError              (connection/DNS/refused)
             ├─ PayBotTimeoutError              (request timeout)
             ├─ PayBotAuthError                 (401/403)
             ├─ PayBotPolicyError               (trust/AML/limit)
             ├─ PayBotSignatureError            (EIP-3009/EIP-712 signing)
             ├─ PayBotSettlementError           (chain rejected the tx)
             └─ PayBotUnsupportedSigningMethodError  (token signing method unsupported)
"""
from __future__ import annotations

from typing import Any, Dict, FrozenSet, Optional


class PayBotError(Exception):
    """Abstract root of the PayBot error taxonomy.

    Carries a machine-readable :attr:`code` and optional structured
    :attr:`details`. Not raised directly — concrete subclasses extend
    :class:`PayBotApiError`.

    :param message: Human-readable error message.
    :param code: Machine-readable error code (e.g. ``'NETWORK_ERROR'``).
    :param details: Optional structured error context.
    """

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
    """SDK-facing error raised by PayBotClient methods on non-2xx HTTP responses.

    Back-compat anchor: every specialized subtype extends this class, so
    ``isinstance(e, PayBotApiError)`` and reads of ``.code`` / ``.status_code`` /
    ``.details`` keep working unchanged.

    :param message: Human-readable error message.
    :param code: Machine-readable error code.
    :param status_code: HTTP status code (0 for transport-level errors).
    :param details: Optional structured error context.
    """

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
    """Connection-level failure (DNS resolution, connection refused, socket reset).

    :param message: Human-readable error message.
    :param code: Machine-readable code (default ``'NETWORK_ERROR'``).
    :param status_code: HTTP status (default ``0`` — no response received).
    :param details: Optional structured error context.
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

    :param message: Human-readable error message.
    :param code: Machine-readable code (default ``'TIMEOUT'``).
    :param status_code: HTTP status (default ``0`` — request never completed).
    :param details: Optional structured error context.
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

    :param message: Human-readable error message.
    :param code: Machine-readable code (default ``'AUTHENTICATION_FAILED'``).
    :param status_code: HTTP status (default ``401``).
    :param details: Optional structured error context.
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
    """Policy rejection — trust violation, AML block, spending limit, or envelope
    breach. The server-provided ``code`` is preserved (e.g. ``'TRUST_VIOLATION'``).

    :param message: Human-readable error message.
    :param code: Server policy code (preserved; default ``'POLICY_VIOLATION'``).
    :param status_code: HTTP status (default ``403``).
    :param details: Optional structured error context.
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
    """EIP-3009 / EIP-712 signing failed (bad key, malformed domain, signer error).

    :param message: Human-readable error message.
    :param code: Machine-readable code (default ``'SIGNATURE_FAILED'``).
    :param status_code: HTTP status (default ``0`` — failure is local, pre-network).
    :param details: Optional structured error context.
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

    :param message: Human-readable error message.
    :param code: Machine-readable code (default ``'SETTLEMENT_FAILED'``).
    :param status_code: HTTP status (default ``502``).
    :param details: Optional structured error context.
    """

    def __init__(
        self,
        message: str,
        code: str = "SETTLEMENT_FAILED",
        status_code: int = 502,
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        super().__init__(message, code, status_code, details)


class PayBotUnsupportedSigningMethodError(PayBotApiError):
    """The token's configured signing method is not implemented by this SDK.

    Raised when a token in the registry declares a ``signing_method`` that the
    Python SDK does not implement (e.g. ``'eip2612'`` permit-style tokens such as
    RLUSD/DAI — documented as a deliberate rejection until EIP-2612 support lands).

    :param message: Human-readable error message.
    :param code: Machine-readable code (default ``'UNSUPPORTED_SIGNING_METHOD'``).
    :param status_code: HTTP status (default ``400`` — caller-side configuration).
    :param details: Optional structured error context.
    """

    def __init__(
        self,
        message: str,
        code: str = "UNSUPPORTED_SIGNING_METHOD",
        status_code: int = 400,
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        super().__init__(message, code, status_code, details)


# Server policy codes that map to :class:`PayBotPolicyError`. Exported so the
# client and tests share a single source of truth (mirrors POLICY_ERROR_CODES).
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
    """Construct the most specific :class:`PayBotApiError` subclass for an HTTP
    error response, based on status code and server-provided error code.

    Mapping (mirrors ``mapHttpError`` in errors.ts):

    - policy codes (see :data:`POLICY_ERROR_CODES`) → :class:`PayBotPolicyError`
    - 401/403 → :class:`PayBotAuthError`
    - everything else → :class:`PayBotApiError`

    :param message: Human-readable error message.
    :param code: Server-provided machine-readable code.
    :param status_code: HTTP status code.
    :param details: Optional structured error context.
    :returns: The most specific matching error instance (always an instance of
        :class:`PayBotApiError`).

    :example:
        >>> e = map_http_error("Trust violation", "TRUST_VIOLATION", 403)
        >>> isinstance(e, PayBotPolicyError)
        True
        >>> isinstance(e, PayBotApiError)
        True
    """
    if code in POLICY_ERROR_CODES:
        return PayBotPolicyError(message, code, status_code, details)
    if status_code in (401, 403):
        return PayBotAuthError(message, code, status_code, details)
    return PayBotApiError(message, code, status_code, details)


def get_error_message(error: Any) -> str:
    """Extract a string message from any exception-like value.

    :param error: The thrown value (exception, string, or anything).
    :returns: A best-effort message string.
    """
    if isinstance(error, BaseException):
        return str(error) or error.__class__.__name__
    if isinstance(error, str):
        return error
    return "Unknown error"
