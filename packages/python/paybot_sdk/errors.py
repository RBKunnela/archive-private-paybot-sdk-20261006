"""SDK errors. Mirrors `src/errors.ts`."""
from __future__ import annotations

from typing import Any, Dict, Optional


class PayBotApiError(Exception):
    """Raised by PayBotClient methods on non-2xx HTTP responses."""

    def __init__(
        self,
        message: str,
        code: str,
        status_code: int,
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code
        self.details = details


def get_error_message(error: Any) -> str:
    """Extract a string message from any exception-like value."""
    if isinstance(error, BaseException):
        return str(error) or error.__class__.__name__
    if isinstance(error, str):
        return error
    return "Unknown error"
