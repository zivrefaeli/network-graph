"""Integer-nanosecond time, and the one place it becomes a string.

Python's :class:`datetime.datetime` is microsecond-precision. A nanosecond
pcapng routed through one silently loses its low three digits, and the schema
promises the capture's *native* resolution. So time is carried as an ``int``
count of nanoseconds since the epoch everywhere inside the backend, and
formatted to RFC 3339 exactly once, at the edge.

The same reasoning rules out ``float``: at 2026 epoch magnitudes a float64 has
roughly 2^-52 * 1.8e18 ~= 400ns of resolution, so ``float(t)`` would round away
more than the nanoseconds it was meant to preserve.
"""

from datetime import UTC, datetime

NS_PER_SECOND = 1_000_000_000


def epoch_ns_from_tshark(value: str) -> int:
    """Parse tshark's ``frame.time_epoch`` into integer nanoseconds.

    The field arrives as decimal text -- ``"1757012345.123456789"`` -- and is
    split on the point rather than parsed as a float, which is the whole point
    of this module. Fractional digits are padded or truncated to nanoseconds.

    Raises:
        ValueError: if the field is not a decimal number.
    """
    text = value.strip()
    if not text:
        raise ValueError("empty frame.time_epoch")

    negative = text.startswith("-")
    if negative or text.startswith("+"):
        text = text[1:]

    whole, _, fraction = text.partition(".")
    if not whole.isdigit() or (fraction and not fraction.isdigit()):
        raise ValueError(f"not a decimal epoch time: {value!r}")

    # Pad "123456" to "123456000"; truncate anything finer than a nanosecond,
    # which no capture format carries anyway.
    nanos = int(f"{fraction:<09s}"[:9]) if fraction else 0
    total = int(whole) * NS_PER_SECOND + nanos
    return -total if negative else total


def format_rfc3339(epoch_ns: int, *, digits: int = 9) -> str:
    """Render integer nanoseconds as RFC 3339 UTC with fractional seconds.

    Args:
        epoch_ns: Nanoseconds since the Unix epoch.
        digits: Fractional digits to emit, 1-9. This is the capture's native
            resolution, decided once per document from the interface's
            timestamp resolution -- not per timestamp, or two fields from one
            capture would disagree about how precise the clock was.
    """
    if not 1 <= digits <= 9:
        raise ValueError(f"fractional digits must be 1-9, got {digits}")

    seconds, nanos = divmod(epoch_ns, NS_PER_SECOND)
    # divmod floors, so a negative epoch borrows correctly rather than
    # producing a negative fraction.
    moment = datetime.fromtimestamp(seconds, tz=UTC)
    fraction = f"{nanos:09d}"[:digits]
    return f"{moment.strftime('%Y-%m-%dT%H:%M:%S')}.{fraction}Z"


def resolution_digits(nanos_per_tick: int) -> int:
    """Fractional digits that express a tick without inventing precision.

    A microsecond pcap gets 6 digits, a nanosecond pcapng 9. Emitting 9 for a
    microsecond capture would claim a precision the file does not have.
    """
    digits = 9
    tick = max(nanos_per_tick, 1)
    while digits > 1 and tick % 10 == 0:
        tick //= 10
        digits -= 1
    return digits
