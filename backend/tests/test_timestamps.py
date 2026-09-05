"""The nanosecond path, which is the thing this backend claims not to lose."""

import pytest

from app.parsing.timestamps import (
    epoch_ns_from_tshark,
    format_rfc3339,
    resolution_digits,
)


class TestEpochNsFromTshark:
    def test_keeps_all_nine_digits(self) -> None:
        assert epoch_ns_from_tshark("1757012345.123456789") == 1_757_012_345_123_456_789

    def test_pads_a_shorter_fraction_rather_than_misreading_it(self) -> None:
        # "123456" is 123456 *micro*seconds, not 123456 nanoseconds.
        assert epoch_ns_from_tshark("1757012345.123456") == 1_757_012_345_123_456_000

    def test_survives_a_whole_second(self) -> None:
        assert epoch_ns_from_tshark("1757012345") == 1_757_012_345_000_000_000

    def test_truncates_beyond_a_nanosecond(self) -> None:
        # No capture format carries picoseconds; the extra digit is dropped
        # rather than rounding the nanosecond it sits under.
        assert epoch_ns_from_tshark("1.1234567891") == 1_123_456_789

    def test_beats_the_float_it_replaces(self) -> None:
        # The reason this module exists: at 2026 epoch magnitudes a float64 has
        # roughly 400ns of resolution, so parsing as a float would round away
        # more than the nanoseconds it was meant to preserve.
        text = "1757012345.123456789"
        assert epoch_ns_from_tshark(text) != int(float(text) * 1e9)

    @pytest.mark.parametrize("bad", ["", "   ", "not-a-time", "12.34.56", "1.2e9"])
    def test_rejects_what_it_cannot_parse(self, bad: str) -> None:
        with pytest.raises(ValueError, match="epoch"):
            epoch_ns_from_tshark(bad)


class TestFormatRfc3339:
    def test_round_trips_a_nanosecond_timestamp(self) -> None:
        text = "1757012345.123456789"
        assert format_rfc3339(epoch_ns_from_tshark(text)) == "2025-09-04T18:59:05.123456789Z"

    def test_emits_only_the_precision_the_file_carries(self) -> None:
        stamp = format_rfc3339(1_757_012_345_123_456_789, digits=6)
        assert stamp == "2025-09-04T18:59:05.123456Z"

    def test_is_always_utc_with_a_z(self) -> None:
        assert format_rfc3339(0).startswith("1970-01-01T00:00:00.")
        assert format_rfc3339(0).endswith("Z")

    def test_matches_the_pattern_the_schema_enforces(self) -> None:
        import re

        pattern = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$"
        for digits in range(1, 10):
            assert re.match(pattern, format_rfc3339(1_757_012_345_123_456_789, digits=digits))

    def test_borrows_correctly_before_the_epoch(self) -> None:
        # divmod floors, so a negative epoch must not produce a negative
        # fraction like "1969-12-31T23:59:59.-500000000Z".
        assert format_rfc3339(-500_000_000) == "1969-12-31T23:59:59.500000000Z"

    @pytest.mark.parametrize("digits", [0, 10, -1])
    def test_refuses_a_precision_that_is_not_a_precision(self, digits: int) -> None:
        with pytest.raises(ValueError, match="1-9"):
            format_rfc3339(0, digits=digits)


class TestResolutionDigits:
    @pytest.mark.parametrize(
        ("nanos_per_tick", "expected"),
        [(1, 9), (1_000, 6), (1_000_000, 3), (1_000_000_000, 1)],
    )
    def test_expresses_a_tick_without_inventing_precision(
        self, nanos_per_tick: int, expected: int
    ) -> None:
        assert resolution_digits(nanos_per_tick) == expected
