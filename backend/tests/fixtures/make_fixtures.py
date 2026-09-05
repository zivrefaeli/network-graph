"""Writes the .pcapng fixtures this suite asserts against.

Nothing is downloaded. The files are built byte by byte here so they are tiny,
deterministic, reproducible from source, and reviewable -- and so the timestamps
carry real nanosecond precision, which is the thing the backend claims not to
lose and therefore has to be tested against.

Regenerate with::

    uv run python -m tests.fixtures.make_fixtures

The committed files must not drift from this script; ``test_fixtures.py``
rebuilds them in a temp directory and compares the bytes.
"""

import struct
from pathlib import Path

HERE = Path(__file__).parent

# -- the cast ---------------------------------------------------------------

MAC_WORKSTATION = "00:1a:2b:3c:4d:5e"
MAC_GATEWAY = "c8:d7:19:04:aa:31"
MAC_NAS = "00:11:32:8a:c4:7d"
MAC_SCANNER = "6a:3f:11:9d:02:c8"  # locally administered: a randomized MAC
MAC_BROADCAST = "ff:ff:ff:ff:ff:ff"

IP_WORKSTATION = "10.20.30.50"
IP_GATEWAY = "10.20.30.1"
IP_NAS = "10.20.30.20"
IP_SCANNER = "10.20.30.77"
IP_REMOTE = "96.7.128.175"

#: 2026-09-05T09:15:00Z, with nanoseconds that are not a whole microsecond so a
#: microsecond-precision path would visibly truncate them.
BASE_NS = 1_788_513_300_000_000_000 + 123_456_789

ETHERTYPE_IPV4 = 0x0800
ETHERTYPE_ARP = 0x0806
PROTO_TCP = 6
PROTO_UDP = 17

TCP_FIN = 0x01
TCP_SYN = 0x02
TCP_RST = 0x04
TCP_PSH = 0x08
TCP_ACK = 0x10


# -- pcapng ------------------------------------------------------------------


def _pad4(payload: bytes) -> bytes:
    return payload + b"\x00" * (-len(payload) % 4)


def _block(block_type: int, body: bytes) -> bytes:
    """A pcapng block: type, length, body, length again."""
    padded = _pad4(body)
    total = len(padded) + 12
    return struct.pack("<II", block_type, total) + padded + struct.pack("<I", total)


def _option(code: int, value: bytes) -> bytes:
    return struct.pack("<HH", code, len(value)) + _pad4(value)


def section_header() -> bytes:
    body = struct.pack("<IHHq", 0x1A2B3C4D, 1, 0, -1)
    body += _option(3, b"network-graph test fixture")  # shb_os
    body += _option(4, b"tests/fixtures/make_fixtures.py")  # shb_userappl
    body += struct.pack("<HH", 0, 0)  # opt_endofopt
    return _block(0x0A0D0D0A, body)


def interface_description(*, snaplen: int = 262144) -> bytes:
    body = struct.pack("<HHI", 1, 0, snaplen)  # LINKTYPE_ETHERNET
    body += _option(2, b"eth0")  # if_name
    # if_tsresol = 9 means timestamps count nanoseconds. This is the whole
    # reason the backend carries integer nanoseconds instead of a datetime.
    body += _option(9, bytes([9]))
    body += struct.pack("<HH", 0, 0)
    return _block(0x00000001, body)


def enhanced_packet(data: bytes, epoch_ns: int) -> bytes:
    body = struct.pack("<I", 0)  # interface id
    body += struct.pack("<II", epoch_ns >> 32, epoch_ns & 0xFFFFFFFF)
    body += struct.pack("<II", len(data), len(data))
    body += _pad4(data)
    return _block(0x00000006, body)


def write_pcapng(path: Path, frames: list[tuple[bytes, int]]) -> None:
    blocks = [section_header(), interface_description()]
    blocks += [enhanced_packet(data, ts) for data, ts in frames]
    path.write_bytes(b"".join(blocks))


# -- frames ------------------------------------------------------------------


def mac_bytes(mac: str) -> bytes:
    return bytes(int(part, 16) for part in mac.split(":"))


def ip_bytes(address: str) -> bytes:
    return bytes(int(part) for part in address.split("."))


def ethernet(dst: str, src: str, ethertype: int, payload: bytes) -> bytes:
    return mac_bytes(dst) + mac_bytes(src) + struct.pack("!H", ethertype) + payload


def _checksum(data: bytes) -> int:
    if len(data) % 2:
        data += b"\x00"
    # struct.unpack is typed as tuple[Any, ...], so the sum is annotated to
    # keep the Any from leaking out of this function.
    total: int = sum(struct.unpack(f"!{len(data) // 2}H", data))
    while total >> 16:
        total = (total & 0xFFFF) + (total >> 16)
    return (~total) & 0xFFFF


def ipv4(src: str, dst: str, protocol: int, payload: bytes, *, ident: int = 0) -> bytes:
    total_length = 20 + len(payload)
    header = (
        struct.pack("!BBHHHBBH", 0x45, 0, total_length, ident, 0x4000, 64, protocol, 0)
        + ip_bytes(src)
        + ip_bytes(dst)
    )
    checksum = _checksum(header)
    return header[:10] + struct.pack("!H", checksum) + header[12:] + payload


def _l4_checksum(src: str, dst: str, protocol: int, segment: bytes) -> int:
    pseudo = ip_bytes(src) + ip_bytes(dst) + struct.pack("!BBH", 0, protocol, len(segment))
    return _checksum(pseudo + segment)


def tcp(
    src: str,
    dst: str,
    src_port: int,
    dst_port: int,
    *,
    flags: int,
    seq: int = 1,
    ack: int = 0,
    payload: bytes = b"",
) -> bytes:
    header = struct.pack("!HHIIBBHHH", src_port, dst_port, seq, ack, 0x50, flags, 8192, 0, 0)
    segment = header + payload
    checksum = _l4_checksum(src, dst, PROTO_TCP, segment)
    segment = segment[:16] + struct.pack("!H", checksum) + segment[18:]
    return ipv4(src, dst, PROTO_TCP, segment)


def udp(src: str, dst: str, src_port: int, dst_port: int, payload: bytes) -> bytes:
    header = struct.pack("!HHHH", src_port, dst_port, 8 + len(payload), 0)
    datagram = header + payload
    checksum = _l4_checksum(src, dst, PROTO_UDP, datagram)
    datagram = datagram[:6] + struct.pack("!H", checksum or 0xFFFF) + datagram[8:]
    return ipv4(src, dst, PROTO_UDP, datagram)


def arp(opcode: int, sender_mac: str, sender_ip: str, target_mac: str, target_ip: str) -> bytes:
    return (
        struct.pack("!HHBBH", 1, ETHERTYPE_IPV4, 6, 4, opcode)
        + mac_bytes(sender_mac)
        + ip_bytes(sender_ip)
        + mac_bytes(target_mac)
        + ip_bytes(target_ip)
    )


def dns_name(name: str) -> bytes:
    """A DNS name in wire form: length-prefixed labels, then a zero byte."""
    out = b""
    for label in name.rstrip(".").split("."):
        encoded = label.encode("ascii")
        out += bytes([len(encoded)]) + encoded
    return out + b"\x00"


def dns_query(query_name: str, *, transaction: int = 0x1234) -> bytes:
    """A minimal DNS PTR question: one query, no answers.

    Built as its own message rather than sliced out of the response -- a
    response header declares an answer count, and reusing it produces a frame
    Wireshark rightly calls malformed.
    """
    header = struct.pack("!HHHHHH", transaction, 0x0100, 1, 0, 0, 0)
    return header + dns_name(query_name) + struct.pack("!HH", 12, 1)  # PTR, IN


def dns_ptr_response(query_name: str, answer: str, *, transaction: int = 0x1234) -> bytes:
    """A minimal DNS response with one PTR answer.

    This is what gives an address a ``dns_ptr`` hostname, which is the
    highest-confidence name for something the capture never saw introduce
    itself.
    """
    header = struct.pack("!HHHHHH", transaction, 0x8180, 1, 1, 0, 0)
    question = dns_name(query_name) + struct.pack("!HH", 12, 1)  # PTR, IN
    rdata = dns_name(answer)
    record = dns_name(query_name) + struct.pack("!HHIH", 12, 1, 300, len(rdata)) + rdata
    return header + question + record


def arpa_name(address: str) -> str:
    return ".".join(reversed(address.split("."))) + ".in-addr.arpa"


# -- the fixtures ------------------------------------------------------------


def build_tiny() -> list[tuple[bytes, int]]:
    """A small, complete segment: ARP, a LAN transfer, DNS, and the internet.

    The load-bearing part is the last group. Traffic to ``96.7.128.175`` is
    L2-addressed to the gateway, so an implementation that terminated edges on
    MACs would show the gateway holding all of it. Here it must appear as a
    conversation between the workstation and the remote address, with the
    gateway carrying only its own DNS.
    """
    frames: list[tuple[bytes, int]] = []
    clock = BASE_NS

    def at(step_ns: int, frame: bytes) -> None:
        nonlocal clock
        clock += step_ns
        frames.append((frame, clock))

    # ARP: the workstation asks who the gateway is and is told. The reply is
    # the strongest binding evidence there is, and it also proves both
    # addresses are on this segment.
    at(
        0,
        ethernet(
            MAC_BROADCAST,
            MAC_WORKSTATION,
            ETHERTYPE_ARP,
            arp(1, MAC_WORKSTATION, IP_WORKSTATION, "00:00:00:00:00:00", IP_GATEWAY),
        ),
    )
    at(
        1_200_000,
        ethernet(
            MAC_WORKSTATION,
            MAC_GATEWAY,
            ETHERTYPE_ARP,
            arp(2, MAC_GATEWAY, IP_GATEWAY, MAC_WORKSTATION, IP_WORKSTATION),
        ),
    )
    at(
        900_000,
        ethernet(
            MAC_BROADCAST,
            MAC_NAS,
            ETHERTYPE_ARP,
            arp(1, MAC_NAS, IP_NAS, "00:00:00:00:00:00", IP_WORKSTATION),
        ),
    )
    at(
        700_000,
        ethernet(
            MAC_NAS,
            MAC_WORKSTATION,
            ETHERTYPE_ARP,
            arp(2, MAC_WORKSTATION, IP_WORKSTATION, MAC_NAS, IP_NAS),
        ),
    )

    # DNS to the gateway: a PTR lookup that names the remote address.
    at(
        2_000_000,
        ethernet(
            MAC_GATEWAY,
            MAC_WORKSTATION,
            ETHERTYPE_IPV4,
            udp(IP_WORKSTATION, IP_GATEWAY, 51_514, 53, dns_query(arpa_name(IP_REMOTE))),
        ),
    )
    at(
        3_100_000,
        ethernet(
            MAC_WORKSTATION,
            MAC_GATEWAY,
            ETHERTYPE_IPV4,
            udp(
                IP_GATEWAY,
                IP_WORKSTATION,
                53,
                51_514,
                dns_ptr_response(arpa_name(IP_REMOTE), "example.com"),
            ),
        ),
    )

    # SMB to the NAS: a full handshake, a large upload, small acknowledgements
    # back. Asymmetric on purpose -- "who sent 4 GB to whom" is the question
    # the tool answers, so a fixture where both directions match proves less.
    at(
        1_500_000,
        ethernet(
            MAC_NAS,
            MAC_WORKSTATION,
            ETHERTYPE_IPV4,
            tcp(IP_WORKSTATION, IP_NAS, 49_601, 445, flags=TCP_SYN),
        ),
    )
    at(
        400_000,
        ethernet(
            MAC_WORKSTATION,
            MAC_NAS,
            ETHERTYPE_IPV4,
            tcp(IP_NAS, IP_WORKSTATION, 445, 49_601, flags=TCP_SYN | TCP_ACK, ack=2),
        ),
    )
    at(
        300_000,
        ethernet(
            MAC_NAS,
            MAC_WORKSTATION,
            ETHERTYPE_IPV4,
            tcp(IP_WORKSTATION, IP_NAS, 49_601, 445, flags=TCP_ACK, seq=2, ack=2),
        ),
    )
    for index in range(6):
        at(
            250_000,
            ethernet(
                MAC_NAS,
                MAC_WORKSTATION,
                ETHERTYPE_IPV4,
                tcp(
                    IP_WORKSTATION,
                    IP_NAS,
                    49_601,
                    445,
                    flags=TCP_ACK | TCP_PSH,
                    seq=2 + index * 512,
                    ack=2,
                    payload=bytes(512),
                ),
            ),
        )
        at(
            120_000,
            ethernet(
                MAC_WORKSTATION,
                MAC_NAS,
                ETHERTYPE_IPV4,
                tcp(
                    IP_NAS,
                    IP_WORKSTATION,
                    445,
                    49_601,
                    flags=TCP_ACK,
                    seq=2,
                    ack=2 + (index + 1) * 512,
                ),
            ),
        )

    # HTTPS to the internet. Every one of these frames is L2-addressed to the
    # gateway, and none of them is a conversation with it.
    at(
        2_400_000,
        ethernet(
            MAC_GATEWAY,
            MAC_WORKSTATION,
            ETHERTYPE_IPV4,
            tcp(IP_WORKSTATION, IP_REMOTE, 49_602, 443, flags=TCP_SYN),
        ),
    )
    at(
        18_000_000,
        ethernet(
            MAC_WORKSTATION,
            MAC_GATEWAY,
            ETHERTYPE_IPV4,
            tcp(IP_REMOTE, IP_WORKSTATION, 443, 49_602, flags=TCP_SYN | TCP_ACK, ack=2),
        ),
    )
    at(
        400_000,
        ethernet(
            MAC_GATEWAY,
            MAC_WORKSTATION,
            ETHERTYPE_IPV4,
            tcp(
                IP_WORKSTATION,
                IP_REMOTE,
                49_602,
                443,
                flags=TCP_ACK | TCP_PSH,
                seq=2,
                ack=2,
                payload=bytes(220),
            ),
        ),
    )
    for index in range(4):
        at(
            2_000_000,
            ethernet(
                MAC_WORKSTATION,
                MAC_GATEWAY,
                ETHERTYPE_IPV4,
                tcp(
                    IP_REMOTE,
                    IP_WORKSTATION,
                    443,
                    49_602,
                    flags=TCP_ACK | TCP_PSH,
                    seq=2 + index * 1400,
                    ack=222,
                    payload=bytes(1400),
                ),
            ),
        )
    at(
        900_000,
        ethernet(
            MAC_GATEWAY,
            MAC_WORKSTATION,
            ETHERTYPE_IPV4,
            tcp(IP_WORKSTATION, IP_REMOTE, 49_602, 443, flags=TCP_ACK | TCP_FIN, seq=222, ack=5602),
        ),
    )

    # The gateway's own upstream traffic: NTP. It gets a modest circle, not
    # everyone else's bytes.
    at(
        1_100_000,
        ethernet(
            MAC_GATEWAY,
            MAC_WORKSTATION,
            ETHERTYPE_IPV4,
            udp(IP_WORKSTATION, IP_GATEWAY, 51_515, 123, bytes(48)),
        ),
    )
    at(
        700_000,
        ethernet(
            MAC_WORKSTATION,
            MAC_GATEWAY,
            ETHERTYPE_IPV4,
            udp(IP_GATEWAY, IP_WORKSTATION, 123, 51_515, bytes(48)),
        ),
    )
    return frames


def build_scan() -> list[tuple[bytes, int]]:
    """A port scan: many SYNs, not one SYN/ACK, no payload at all.

    Nearly free in bytes, so a byte-weighted line width would draw it as the
    thinnest line on the canvas. ``tcp_health`` is what makes it visible.
    """
    frames: list[tuple[bytes, int]] = []
    clock = BASE_NS
    ports = [21, 22, 23, 25, 53, 80, 110, 143, 443, 445, 993, 995, 3306, 3389, 5432, 8080]

    for index, port in enumerate(ports):
        clock += 900_000
        frames.append(
            (
                ethernet(
                    MAC_WORKSTATION,
                    MAC_SCANNER,
                    ETHERTYPE_IPV4,
                    tcp(IP_SCANNER, IP_WORKSTATION, 40_000 + index, port, flags=TCP_SYN),
                ),
                clock,
            )
        )
        clock += 200_000
        # Answered with a reset, not a SYN/ACK: nothing was listening.
        frames.append(
            (
                ethernet(
                    MAC_SCANNER,
                    MAC_WORKSTATION,
                    ETHERTYPE_IPV4,
                    tcp(
                        IP_WORKSTATION,
                        IP_SCANNER,
                        port,
                        40_000 + index,
                        flags=TCP_RST | TCP_ACK,
                        ack=2,
                    ),
                ),
                clock,
            )
        )
    return frames


def main() -> None:
    write_pcapng(HERE / "tiny.pcapng", build_tiny())
    write_pcapng(HERE / "scan.pcapng", build_scan())
    for name in ("tiny.pcapng", "scan.pcapng"):
        print(f"wrote {name}: {(HERE / name).stat().st_size} bytes")


if __name__ == "__main__":
    main()
