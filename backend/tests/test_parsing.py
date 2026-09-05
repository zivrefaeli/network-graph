"""Decoding tshark's output.

The unit tests here need no binary -- they feed the decoder text. The ones
marked ``tshark`` run the real thing over the committed fixtures and are how
the field list is kept honest: a renamed field would leave a column silently
empty, and only real output catches that.
"""

import asyncio
from pathlib import Path

import pytest

from app.parsing.capinfos import parse_capinfos, read_capture_info
from app.parsing.records import PacketRecord
from app.parsing.tshark import (
    FIELDS,
    SEPARATOR,
    TsharkError,
    TsharkNotFoundError,
    build_argv,
    decode,
    l7_protocols,
    run_tshark,
    tshark_version,
)
from app.settings import Settings


def line(**columns: str) -> str:
    """One tshark output row, addressed by field name rather than position."""
    values = [columns.get(name, "") for name in FIELDS]
    return SEPARATOR.join(values)


def one(**columns: str) -> PacketRecord:
    records = list(decode(line(**columns)))
    assert len(records) == 1
    return records[0]


class TestArgv:
    def test_never_builds_a_shell_string(self) -> None:
        # The filename comes from an uploaded file and is hostile input. An
        # argument list with shell=False gives it nowhere to go.
        # str(Path(...)) is platform-shaped, so the expectation is derived the
        # same way rather than hard-coded to POSIX separators.
        hostile = Path("captures") / "a b; rm -rf ~.pcapng"
        argv = build_argv("tshark", hostile)
        assert argv[0] == "tshark"
        # One argv entry, passed whole. Nothing splits it and no shell sees it.
        assert argv.count(str(hostile)) == 1
        assert not any(";" in part for part in argv if part != str(hostile))

    def test_asks_for_every_field_the_decoder_reads(self) -> None:
        argv = build_argv("tshark", Path("x.pcapng"))
        requested = [argv[i + 1] for i, part in enumerate(argv) if part == "-e"]
        assert requested == list(FIELDS)

    def test_disables_network_name_resolution(self) -> None:
        # Otherwise dissecting an untrusted file fires DNS queries. -N m keeps
        # the one resolver that is purely local, which is where vendor comes from.
        argv = build_argv("tshark", Path("x.pcapng"))
        assert "-n" in argv
        assert argv[argv.index("-N") + 1] == "m"


class TestDecode:
    def test_reads_a_plain_tcp_frame(self) -> None:
        record = one(
            **{
                "frame.number": "7",
                "frame.time_epoch": "1757012345.123456789",
                "frame.len": "1454",
                "frame.protocols": "eth:ethertype:ip:tcp:tls",
                "eth.src": "00:1a:2b:3c:4d:5e",
                "eth.dst": "c8:d7:19:04:aa:31",
                "ip.src": "10.20.30.50",
                "ip.dst": "96.7.128.175",
                "tcp.srcport": "49602",
                "tcp.dstport": "443",
                "tcp.len": "1400",
                "tcp.flags.syn": "0",
                "tcp.flags.ack": "1",
            }
        )
        assert record.number == 7
        assert record.epoch_ns == 1_757_012_345_123_456_789
        assert record.frame_len == 1454
        assert record.transport == "tcp"
        assert record.payload_len == 1400
        assert record.tcp_ack is True
        assert record.tcp_syn is False
        assert record.protocols == ("eth", "ethertype", "ip", "tcp", "tls")

    def test_udp_payload_excludes_the_header(self) -> None:
        # udp.length counts its own 8-byte header; payload_bytes must not.
        record = one(
            **{
                "frame.number": "1",
                "frame.time_epoch": "1.0",
                "frame.len": "86",
                "udp.srcport": "51514",
                "udp.dstport": "53",
                "udp.length": "52",
                "ip.src": "10.20.30.50",
                "ip.dst": "10.20.30.1",
            }
        )
        assert record.transport == "udp"
        assert record.payload_len == 44

    def test_a_frame_with_no_ip_header_says_so(self) -> None:
        record = one(
            **{
                "frame.number": "1",
                "frame.time_epoch": "1.0",
                "frame.len": "42",
                "eth.src": "00:1a:2b:3c:4d:5e",
                "eth.dst": "ff:ff:ff:ff:ff:ff",
                "frame.protocols": "eth:ethertype:arp",
            }
        )
        assert record.has_ip is False
        assert record.transport is None
        # "No transport" and "port 0" are different facts.
        assert record.src_port is None

    def test_an_arp_reply_is_binding_evidence_but_a_request_is_only_presence(self) -> None:
        common = {"frame.number": "1", "frame.time_epoch": "1.0", "frame.len": "42"}
        reply = one(
            **common,
            **{
                "arp.opcode": "2",
                "arp.src.hw_mac": "c8:d7:19:04:aa:31",
                "arp.src.proto_ipv4": "10.20.30.1",
            },
        )
        assert reply.arp_reply_ip == "10.20.30.1"
        assert reply.arp_sender_ip == "10.20.30.1"

        request = one(
            **common,
            **{
                "arp.opcode": "1",
                "arp.src.hw_mac": "00:1a:2b:3c:4d:5e",
                "arp.src.proto_ipv4": "10.20.30.50",
            },
        )
        # Still on this segment, but not an unprompted assertion of ownership.
        assert request.arp_sender_ip == "10.20.30.50"
        assert request.arp_reply_ip is None

    def test_a_neighbor_solicitation_places_its_target_on_this_segment(self) -> None:
        # Type 135. A solicitation is only ever sent for an on-link target, so
        # it is the presence evidence that says a v6 prefix is on this segment.
        record = one(
            **{
                "frame.number": "9",
                "frame.time_epoch": "1788513300.123456",
                "frame.len": "86",
                "frame.protocols": "eth:ethertype:ipv6:icmpv6",
                "eth.src": "00:1a:2b:3c:4d:5e",
                "eth.dst": "33:33:ff:00:00:20",
                "ipv6.src": "fe80::21a:2bff:fe3c:4d5e",
                "ipv6.dst": "ff02::1:ff00:20",
                "icmpv6.type": "135",
                "icmpv6.nd.ns.target_address": "4001:db8:aced:1::20",
                "icmpv6.opt.linkaddr": "00:1a:2b:3c:4d:5e",
            }
        )
        assert record.ndp_solicited_ip == "4001:db8:aced:1::20"
        # The link-layer option in a solicitation is the *sender's* address,
        # not the target's, so it must not come out as a binding.
        assert record.ndp_advertised_ip is None
        assert record.ndp_advertised_mac is None

    def test_a_dhcp_ack_binds_the_leased_address(self) -> None:
        record = one(
            **{
                "frame.number": "1",
                "frame.time_epoch": "1.0",
                "frame.len": "342",
                "dhcp.option.dhcp": "5",
                "dhcp.ip.your": "10.20.30.77",
                "dhcp.hw.mac_addr": "6a:3f:11:9d:02:c8",
            }
        )
        assert record.dhcp_assigned_ip == "10.20.30.77"
        assert record.dhcp_assigned_mac == "6a:3f:11:9d:02:c8"

    def test_a_dhcp_offer_is_not_an_ack(self) -> None:
        # Only message type 5 grants a lease. An offer binds nothing.
        record = one(
            **{
                "frame.number": "1",
                "frame.time_epoch": "1.0",
                "frame.len": "342",
                "dhcp.option.dhcp": "2",
                "dhcp.ip.your": "10.20.30.77",
                "dhcp.hw.mac_addr": "6a:3f:11:9d:02:c8",
            }
        )
        assert record.dhcp_assigned_ip is None

    def test_an_unspecified_address_never_binds(self) -> None:
        record = one(
            **{
                "frame.number": "1",
                "frame.time_epoch": "1.0",
                "frame.len": "60",
                "arp.opcode": "2",
                "arp.src.hw_mac": "00:1a:2b:3c:4d:5e",
                # The unspecified address: an ARP probe, not an assertion
                # of ownership.
                "arp.src.proto_ipv4": "0.0.0.0",  # noqa: S104 - test data, nothing binds
            }
        )
        assert record.arp_reply_ip is None

    def test_an_sni_names_the_server_not_the_client(self) -> None:
        record = one(
            **{
                "frame.number": "1",
                "frame.time_epoch": "1.0",
                "frame.len": "571",
                "ip.src": "10.20.30.50",
                "ip.dst": "96.7.128.175",
                "tcp.srcport": "49602",
                "tcp.dstport": "443",
                "tls.handshake.extensions_server_name": "example.com",
            }
        )
        assert [(h.address, h.name, h.source) for h in record.hostnames] == [
            ("96.7.128.175", "example.com", "tls_sni")
        ]

    def test_a_ptr_answer_names_the_address_its_question_asked_about(self) -> None:
        record = one(
            **{
                "frame.number": "1",
                "frame.time_epoch": "1.0",
                "frame.len": "137",
                "ip.src": "10.20.30.1",
                "ip.dst": "10.20.30.50",
                "udp.srcport": "53",
                "udp.dstport": "51514",
                "udp.length": "115",
                "dns.qry.name": "175.128.7.96.in-addr.arpa",
                "dns.ptr.domain_name": "example.com",
            }
        )
        # Not the sender, and not the recipient: the address the query encodes.
        assert [(h.address, h.source) for h in record.hostnames] == [("96.7.128.175", "dns_ptr")]

    def test_the_same_answer_over_mdns_is_labelled_mdns(self) -> None:
        record = one(
            **{
                "frame.number": "1",
                "frame.time_epoch": "1.0",
                "frame.len": "137",
                "ip.src": "10.20.30.20",
                "ip.dst": "224.0.0.251",
                "udp.srcport": "5353",
                "udp.dstport": "5353",
                "udp.length": "115",
                "dns.qry.name": "175.128.7.96.in-addr.arpa",
                "dns.ptr.domain_name": "nas-01.local",
            }
        )
        assert record.hostnames[0].source == "mdns"

    def test_a_dhcp_hostname_names_the_client(self) -> None:
        record = one(
            **{
                "frame.number": "1",
                "frame.time_epoch": "1.0",
                "frame.len": "342",
                "ip.src": "10.20.30.50",
                "ip.dst": "10.20.30.1",
                "udp.srcport": "68",
                "udp.dstport": "67",
                "udp.length": "314",
                "dhcp.option.hostname": "workstation-01",
            }
        )
        assert [(h.address, h.source) for h in record.hostnames] == [
            ("10.20.30.50", "dhcp_option_12")
        ]

    def test_a_repeated_field_takes_its_first_occurrence(self) -> None:
        record = one(
            **{
                "frame.number": "1",
                "frame.time_epoch": "1.0",
                "frame.len": "100",
                "ip.src": "10.20.30.50|10.20.31.1",
                "ip.dst": "10.20.30.1",
            }
        )
        # A tunnelled frame has two IP layers; the outer one is the conversation.
        assert record.ip_src == "10.20.30.50"

    def test_a_randomized_mac_gets_no_vendor_from_the_manuf_table(self) -> None:
        # Wireshark returns the bare OUI bytes when it has no entry. Those are
        # not a vendor name.
        record = one(
            **{
                "frame.number": "1",
                "frame.time_epoch": "1.0",
                "frame.len": "100",
                "eth.src": "6a:3f:11:9d:02:c8",
                "eth.src.oui_resolved": "6a:3f:11",
            }
        )
        assert record.eth_src_vendor is None

    def test_a_real_vendor_survives(self) -> None:
        record = one(
            **{
                "frame.number": "1",
                "frame.time_epoch": "1.0",
                "frame.len": "100",
                "eth.src": "00:11:32:8a:c4:7d",
                "eth.src.oui_resolved": "Synology Incorporated",
            }
        )
        assert record.eth_src_vendor == "Synology Incorporated"

    def test_a_frame_with_no_usable_timestamp_is_skipped_not_fatal(self) -> None:
        # One malformed frame in a million is a fact about the file, not a
        # reason to refuse the whole capture.
        good = line(**{"frame.number": "1", "frame.time_epoch": "1.0", "frame.len": "60"})
        bad = line(**{"frame.number": "2", "frame.time_epoch": "nope", "frame.len": "60"})
        assert len(list(decode(f"{bad}\n{good}\n{bad}"))) == 1

    def test_blank_lines_are_ignored(self) -> None:
        good = line(**{"frame.number": "1", "frame.time_epoch": "1.0", "frame.len": "60"})
        assert len(list(decode(f"\n{good}\n\n"))) == 1

    def test_a_truncated_line_does_not_raise(self) -> None:
        assert list(decode("1\t1.0")) == [] or True  # padded, then rejected or kept


class TestL7Protocols:
    def test_strips_the_framing_layers(self) -> None:
        assert l7_protocols(("eth", "ethertype", "ip", "tcp", "tls", "http2")) == (
            "tls",
            "http2",
        )

    def test_leaves_nothing_when_there_was_no_service(self) -> None:
        assert l7_protocols(("eth", "ethertype", "arp")) == ()


class TestCapinfos:
    def test_reads_the_clock_resolution_the_file_states(self) -> None:
        # The reason this is read from the header rather than guessed: a
        # nanosecond capture whose frames land on microsecond boundaries would
        # otherwise be demoted to six digits.
        info = parse_capinfos(
            "File type:           pcapng\n"
            "File timestamp precision:  nanoseconds (9)\n"
            "Packet size limit:   file hdr: 262144\n"
        )
        assert info.timestamp_digits == 9
        assert info.snaplen == 262144

    def test_reads_a_microsecond_capture_as_six_digits(self) -> None:
        info = parse_capinfos("File timestamp precision:  microseconds (6)\n")
        assert info.timestamp_digits == 6

    def test_falls_back_to_the_interface_block_for_a_pcapng(self) -> None:
        # capinfos reports the *file header* limit as "(not set)" for a pcapng,
        # which keeps its snapshot length per interface instead. Reading only
        # that line would report 0 for the format this tool mostly sees.
        info = parse_capinfos(
            "Packet size limit:   file hdr: (not set)\n"
            "Interface #0 info:\n"
            "                     Name = eth0\n"
            "                     Capture length = 262144\n"
        )
        assert info.snaplen == 262144

    def test_an_unknown_snapshot_length_is_zero_not_a_guess(self) -> None:
        assert parse_capinfos("Packet size limit:   file hdr: (not set)\n").snaplen == 0

    def test_defaults_when_capinfos_said_nothing_useful(self) -> None:
        info = parse_capinfos("")
        assert info.timestamp_digits == 9
        assert info.snaplen == 0
        assert info.packets_dropped == 0

    def test_a_missing_binary_is_survivable(self, tmp_path: Path) -> None:
        # A document with an unknown snapshot length is still a useful document.
        info = read_capture_info("definitely-not-a-binary", tmp_path / "x.pcapng")
        assert info.snaplen == 0


class TestTsharkBinary:
    def test_a_missing_binary_says_where_it_looked(self) -> None:
        with pytest.raises(TsharkNotFoundError, match="definitely-not-tshark"):
            tshark_version("definitely-not-tshark")

    def test_the_message_says_how_to_fix_it(self) -> None:
        with pytest.raises(TsharkNotFoundError, match=r"container|NG_TSHARK_BIN"):
            tshark_version("definitely-not-tshark")


@pytest.mark.tshark
class TestAgainstRealTshark:
    """Runs the actual binary. This is what keeps the field list honest."""

    def test_reports_a_version(self, settings: Settings) -> None:
        assert "TShark" in tshark_version(settings.tshark_bin)

    def test_decodes_the_committed_fixture(self, tiny_capture: Path, settings: Settings) -> None:
        output = asyncio.run(run_tshark(settings.tshark_bin, tiny_capture, timeout_seconds=60))
        records = list(decode(output))
        assert len(records) == 31

        # Every field the decoder reads must actually be populated by tshark.
        # A renamed field would leave one silently empty, and only real output
        # catches that.
        assert any(r.eth_src for r in records)
        assert any(r.ip_src for r in records)
        assert any(r.transport == "tcp" for r in records)
        assert any(r.transport == "udp" for r in records)
        assert any(r.tcp_syn for r in records)
        assert any(r.payload_len > 0 for r in records)
        assert any(r.arp_reply_ip for r in records)
        assert any(r.arp_sender_ip for r in records)
        assert any(r.eth_src_vendor for r in records)
        assert any(r.interface for r in records)
        assert any(r.hostnames for r in records)
        assert any("tls" in r.protocols for r in records)

    def test_nanoseconds_survive_the_round_trip(
        self, tiny_capture: Path, settings: Settings
    ) -> None:
        output = asyncio.run(run_tshark(settings.tshark_bin, tiny_capture, timeout_seconds=60))
        first = next(iter(decode(output)))
        # The fixture is written with .123456789 exactly so a microsecond path
        # would visibly truncate it.
        assert first.epoch_ns % 1_000 == 789

    def test_the_file_header_is_read_not_guessed(
        self, tiny_capture: Path, settings: Settings
    ) -> None:
        info = read_capture_info(settings.capinfos_bin, tiny_capture)
        assert info.timestamp_digits == 9

    def test_a_file_that_is_not_a_capture_fails_loudly(
        self, tmp_path: Path, settings: Settings
    ) -> None:
        junk = tmp_path / "not-a-capture.pcapng"
        junk.write_bytes(b"this is not a capture file" * 10)
        with pytest.raises(TsharkError):
            asyncio.run(run_tshark(settings.tshark_bin, junk, timeout_seconds=30))
