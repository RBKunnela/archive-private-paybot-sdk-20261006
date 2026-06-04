"""Optional, dependency-free OpenTelemetry hooks for the PayBot SDK.

Mirrors ``src/telemetry.ts``. The SDK does NOT depend on ``opentelemetry``.
Instead it defines minimal structural Protocols (:class:`PayBotTracer` /
:class:`PayBotSpan`) that are duck-compatible with a real OTel ``Tracer``/``Span``.
Callers who want tracing inject their own tracer; callers who do not pass a
tracer pay zero overhead — :func:`with_span` runs the wrapped function directly
with no span allocation.

OTel duck-compat win: the real Python ``opentelemetry.trace.Span`` uses
snake_case (``set_attribute``, ``record_exception``, ``end``), which directly
satisfies the snake_case Protocol below — no adapter needed (unlike the JS OTel
``Span`` which uses ``setAttribute``).

Dependencies: none (structural typing only).
Used by: ``client.py`` (PayBotClient.pay instrumentation), ``client_pool.py``.

Example::

    from opentelemetry import trace
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

#: OpenTelemetry ``SpanStatusCode.OK``.
STATUS_OK = 1
#: OpenTelemetry ``SpanStatusCode.ERROR``.
STATUS_ERROR = 2
#: Default span-name prefix when :attr:`TelemetryConfig.prefix` is omitted.
DEFAULT_PREFIX = "paybot."


@runtime_checkable
class PayBotSpan(Protocol):
    """Minimal structural span, duck-compatible with an OpenTelemetry ``Span``.

    Only the methods the SDK actually calls are declared, so a real OTel span
    (a superset of this surface) satisfies the Protocol directly (telemetry.ts:31-57).
    """

    def set_attribute(self, key: str, value: Union[str, int, float, bool]) -> None:
        """Attach a single attribute to the span."""
        ...

    def set_status(self, status: Dict[str, Any]) -> None:
        """Set the span status. ``code`` follows SpanStatusCode (1=OK, 2=ERROR)."""
        ...

    def record_exception(self, err: Any) -> None:
        """Record an exception on the span."""
        ...

    def end(self) -> None:
        """End the span. Must always be called exactly once."""
        ...


@runtime_checkable
class PayBotTracer(Protocol):
    """Minimal structural tracer, duck-compatible with an OTel ``Tracer`` (telemetry.ts:62-71)."""

    def start_span(self, name: str, options: Any = None) -> PayBotSpan:
        """Start a new span with the (already prefix-qualified) ``name``."""
        ...


@dataclass
class TelemetryConfig:
    """Telemetry configuration accepted by ``PayBotConfig.telemetry`` (telemetry.ts:76-81).

    :param tracer: The tracer the SDK emits spans on. Injected by the caller.
    :param prefix: Span-name prefix (default ``'paybot.'``).
    """

    tracer: PayBotTracer
    prefix: Optional[str] = None


async def with_span(
    telemetry: Optional[TelemetryConfig],
    name: str,
    attrs: Dict[str, Union[str, int, float, bool]],
    fn: Callable[[Optional[PayBotSpan]], Awaitable[T]],
) -> T:
    """Run ``fn`` inside a telemetry span, if telemetry is configured (telemetry.ts:123-151).

    When ``telemetry`` is ``None``, ``fn`` is invoked directly with NO span
    allocation and zero overhead (the no-op path). When configured, a span named
    ``f"{prefix}{name}"`` is started, the supplied ``attrs`` are attached, and:

    - on success the span status is set to OK and the resolved value returned;
    - on a raised exception the exception is recorded, status is set to ERROR,
      and the error is re-raised (control flow preserved exactly);
    - the span is always ended in a ``finally`` block (no leaks).

    A returned value is never inspected — a function that resolves with a
    "failure" object (e.g. ``PaymentResult(success=False)``) still produces an OK
    span, because nothing was raised. Only raised exceptions mark the span ERROR.

    :param telemetry: Telemetry config, or ``None`` for the no-op path.
    :param name: Unprefixed span name (e.g. ``'client.pay'``).
    :param attrs: Attributes to set on the span.
    :param fn: The async body to run. Receives the span (or ``None`` on the
        no-op path) so callers can attach late attributes like ``tx_hash``.
    :returns: Whatever ``fn`` resolves to.
    :raises: Re-raises any exception raised by ``fn`` after recording it.

    :example:
        >>> async def body(span):
        ...     return "ok"
        >>> await with_span(None, "client.pay", {}, body)
        'ok'
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
        span.set_status({"code": STATUS_OK})
        return result
    except BaseException as error:  # noqa: BLE001 — record then re-raise
        span.record_exception(error)
        span.set_status({"code": STATUS_ERROR, "message": str(error)})
        raise
    finally:
        span.end()
