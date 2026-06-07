"""Optional, dependency-free OpenTelemetry hooks for the paybot SDK.

Mirrors ``src/telemetry.ts``. The SDK does NOT depend on OpenTelemetry. Instead
it defines minimal structural :class:`~typing.Protocol` interfaces
(:class:`PayBotTracer` / :class:`PayBotSpan`) that a real OTel ``Tracer`` /
``Span`` satisfies (their surface is a superset). Callers who want tracing inject
their own tracer; callers who do not pass a tracer pay zero overhead —
:func:`with_span` runs the wrapped function directly with no span allocation.

Span STATUS is the one place the two worlds differ: a real OTel ``Span.set_status``
requires a ``Status`` object, NOT a bare dict. When OpenTelemetry is importable
the SDK sets a real ``Status`` (see :func:`_ok_status` / :func:`_error_status`);
otherwise it falls back to a ``{'code': int, 'message'?: str}`` dict for the
structural stub spans used in tests.

Dependencies: none (structural typing only — ``typing.Protocol``).
Used by: ``paybot_sdk.client`` (``PayBotClient.pay`` instrumentation).

:example:
    from opentelemetry import trace
    from paybot_sdk import PayBotClient, PayBotConfig
    from paybot_sdk.telemetry import TelemetryConfig

    client = PayBotClient(PayBotConfig(
        api_key="pb_test_...",
        bot_id="my-bot",
        telemetry=TelemetryConfig(tracer=trace.get_tracer("my-bot")),
    ))
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import (
    Any,
    Awaitable,
    Callable,
    Dict,
    Optional,
    Protocol,
    TypeVar,
    Union,
    runtime_checkable,
)

T = TypeVar("T")

AttrValue = Union[str, int, float, bool]

# OpenTelemetry ``SpanStatusCode`` numeric values (used by the dict fallback
# shape when OpenTelemetry is NOT installed).
STATUS_OK = 1
STATUS_ERROR = 2

# Default span-name prefix when ``TelemetryConfig.prefix`` is omitted.
DEFAULT_PREFIX = "paybot."


# Real OpenTelemetry Status/StatusCode when available, so spans emitted onto a
# genuine OTel tracer carry the type OTel expects (CodeRabbit #12). When OTel is
# absent we fall back to the legacy dict shape, which suits the SDK's structural
# stub spans. `set_status` on a real OTel Span requires a `Status` object — a
# bare dict was NOT duck-compatible despite the old docstring's claim.
try:  # pragma: no cover - import availability is environment-dependent
    from opentelemetry.trace import Status as _OTelStatus
    from opentelemetry.trace import StatusCode as _OTelStatusCode

    _OTEL = True
except Exception:  # noqa: BLE001 - any import failure → dict fallback
    _OTelStatus = None  # type: ignore[assignment]
    _OTelStatusCode = None  # type: ignore[assignment]
    _OTEL = False


def _ok_status() -> Any:
    """OK span status: a real OTel ``Status`` when available, else the dict shape."""
    if _OTEL:
        return _OTelStatus(_OTelStatusCode.OK)
    return {"code": STATUS_OK}


def _error_status(message: str) -> Any:
    """ERROR span status: a real OTel ``Status`` when available, else the dict shape."""
    if _OTEL:
        return _OTelStatus(_OTelStatusCode.ERROR, message)
    return {"code": STATUS_ERROR, "message": message}


@runtime_checkable
class PayBotSpan(Protocol):
    """Minimal structural span, duck-compatible with an OpenTelemetry ``Span``.

    Only the methods the SDK actually calls are declared, so a real OTel span
    (a superset of this surface) satisfies the protocol directly.
    """

    def set_attribute(self, key: str, value: AttrValue) -> None:
        """Attach a single attribute to the span."""

    def set_status(self, status: Any) -> None:
        """Set the span status. Accepts a real OpenTelemetry ``Status`` (when OTel
        is installed) or the dict fallback shape ``{'code': int, 'message'?: str}``
        used by the SDK's structural stub spans."""

    def record_exception(self, err: Any) -> None:
        """Record an exception on the span."""

    def end(self) -> None:
        """End the span. Must always be called exactly once."""


@runtime_checkable
class PayBotTracer(Protocol):
    """Minimal structural tracer, duck-compatible with an OpenTelemetry ``Tracer``."""

    def start_span(self, name: str, options: Optional[Any] = None) -> PayBotSpan:
        """Start and return a new span named ``name``."""


@dataclass
class TelemetryConfig:
    """Telemetry configuration accepted by ``PayBotConfig.telemetry``.

    :param tracer: The tracer the SDK emits spans on (caller-injected).
    :param prefix: Span-name prefix (default ``'paybot.'``).
    """

    tracer: PayBotTracer
    prefix: Optional[str] = None


def _error_message(error: Any) -> str:
    """Best-effort human-readable message from an arbitrary thrown value."""
    if isinstance(error, BaseException):
        return str(error) or error.__class__.__name__
    return str(error)


async def with_span(
    telemetry: Optional[TelemetryConfig],
    name: str,
    attrs: Dict[str, AttrValue],
    fn: Callable[[Optional[PayBotSpan]], Awaitable[T]],
) -> T:
    """Run ``fn`` inside a telemetry span, if telemetry is configured.

    When ``telemetry`` is ``None``, ``fn`` is invoked directly with NO span
    allocation and zero overhead (the no-op path). When configured, a span named
    ``f"{prefix}{name}"`` is started, the supplied ``attrs`` are attached, and:

    - on success the span status is set to OK and the resolved value returned;
    - on a raised exception it is recorded, status is set to ERROR, and the
      exception is re-raised (control flow preserved exactly);
    - the span is always ended in a ``finally`` block (no leaks).

    A returned value is never inspected — a coroutine that resolves with a
    "failure" object (e.g. a ``PaymentResult`` with ``success=False``) still
    produces an OK span, because nothing was raised. Only raised exceptions mark
    the span ERROR.

    :param telemetry: Telemetry config, or ``None`` for the no-op path.
    :param name: Unprefixed span name (e.g. ``'client.pay'``).
    :param attrs: Attributes to set on the span.
    :param fn: The async body to run. Receives the span (or ``None`` on the
        no-op path) so callers can attach late attributes such as ``tx_hash``.
    :returns: Whatever ``fn`` resolves to.
    :raises Exception: Re-raises any exception raised by ``fn`` after recording it.

    :example:
        async def body(span):
            result = await do_work()
            if span is not None:
                span.set_attribute("success", result.success)
            return result
        await with_span(telemetry, "client.pay", {"network": net}, body)
    """
    if telemetry is None:
        # No-op path: zero overhead, no span allocated.
        return await fn(None)

    prefix = telemetry.prefix if telemetry.prefix is not None else DEFAULT_PREFIX
    span = telemetry.tracer.start_span(f"{prefix}{name}")
    for key, value in attrs.items():
        span.set_attribute(key, value)

    try:
        result = await fn(span)
        span.set_status(_ok_status())
        return result
    except BaseException as error:  # noqa: BLE001 - record then re-raise unchanged
        span.record_exception(error)
        span.set_status(_error_status(_error_message(error)))
        raise
    finally:
        span.end()
