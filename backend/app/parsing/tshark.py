"""Invoking tshark, and decoding what it prints.

Dissection goes through tshark as a subprocess rather than scapy or pyshark:
the whole value here is Wireshark's protocol coverage -- the same L7 names a
user would see in the GUI -- and tshark is what produces them.

The cost of that decision, handled rather than ignored: tshark is an external
binary, so it is checked for at startup and fails loudly there instead of at
the first upload.
"""

import asyncio
import re
import subprocess
from collections.abc import Callable, Iterator
from dataclasses import replace
from pathlib import Path
from typing import Final, Literal

from app.parsing.records import HostnameClaim, PacketRecord
from app.parsing.timestamps import epoch_ns_from_tshark

#: Reads one column out of the line being decoded. Bound per line in
#: :func:`_decode_line`, so the helpers below take it rather than the raw list.
type Getter = Callable[[str], str]

#: Column order handed to ``-e``. The decoder reads by index into this, so the
#: order here and the parsing below are one unit -- change both or neither.
FIELDS: Final[tuple[str, ...]] = (
    "frame.number",
    "frame.time_epoch",
    "frame.len",
    "frame.protocols",
    "frame.interface_name",
    "eth.src",
    "eth.dst",
    "eth.src.oui_resolved",
    "eth.dst.oui_resolved",
    "vlan.id",
    "ip.src",
    "ip.dst",
    "ipv6.src",
    "ipv6.dst",
    "tcp.srcport",
    "tcp.dstport",
    "tcp.len",
    "tcp.flags.syn",
    "tcp.flags.ack",
    "tcp.flags.reset",
    "tcp.analysis.retransmission",
    "udp.srcport",
    "udp.dstport",
    "udp.length",
    "icmp.type",
    "icmpv6.type",
    "arp.opcode",
    "arp.src.hw_mac",
    "arp.src.proto_ipv4",
    "icmpv6.nd.na.target_address",
    "icmpv6.nd.ns.target_address",
    "icmpv6.opt.linkaddr",
    "dhcp.option.dhcp",
    "dhcp.ip.your",
    "dhcp.hw.mac_addr",
    "dhcp.option.hostname",
    "tls.handshake.extensions_server_name",
    "http.host",
    "dns.qry.name",
    "dns.a",
    "dns.ptr.domain_name",
    "nbns.name",
)

_INDEX: Final[dict[str, int]] = {name: i for i, name in enumerate(FIELDS)}

#: Field separator. Tab is not legal inside any value tshark emits here.
SEPARATOR: Final[str] = "\t"
#: Separator for a field that occurred more than once in one frame.
AGGREGATOR: Final[str] = "|"

#: Layers that are framing rather than a service, and so are not l7_protocols.
_NOT_L7: Final[frozenset[str]] = frozenset(
    {"eth", "ethertype", "vlan", "ip", "ipv6", "tcp", "udp", "icmp", "icmpv6", "sll", "arp"}
)

#: A DHCP message type of 5 is ACK -- the point at which a lease is granted and
#: an address is genuinely bound to a MAC.
_DHCP_ACK: Final[str] = "5"

#: ICMPv6 type 135, a Neighbor Solicitation. Type 136 is the advertisement that
#: answers it, and only that one carries the target's own link-layer address.
_NDP_SOLICITATION: Final[str] = "135"

_UNSPECIFIED_IPV4: Final[str] = "0.0.0.0"  # noqa: S104 - compared against, never bound


class TsharkError(RuntimeError):
    """tshark could not dissect the file, or did not run at all."""


class TsharkNotFoundError(TsharkError):
    """The binary is missing. Raised at startup, not at the first upload."""


def tshark_version(binary: str) -> str:
    """Return tshark's version string, for the health endpoint.

    Raises:
        TsharkNotFoundError: if the binary is absent or not executable.
    """
    try:
        completed = subprocess.run(  # noqa: S603 - fixed argv, no shell, no user input
            [binary, "--version"],
            capture_output=True,
            check=True,
            timeout=15,
        )
    except FileNotFoundError as error:
        raise TsharkNotFoundError(
            f"tshark not found at {binary!r}. This service dissects captures with "
            "Wireshark's own engine and cannot start without it; run it in the "
            "container built by backend/Dockerfile, or set NG_TSHARK_BIN."
        ) from error
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        raise TsharkNotFoundError(
            f"tshark at {binary!r} did not report a version: {error}"
        ) from error

    first_line = completed.stdout.decode("utf-8", "replace").splitlines()
    return first_line[0].strip() if first_line else "unknown"


def build_argv(binary: str, path: Path) -> list[str]:
    """The exact argument list handed to the subprocess.

    Never a shell string. The filename comes from an uploaded file and is
    hostile input; an argument list with ``shell=False`` gives it nowhere to go.
    """
    argv = [
        binary,
        "-r",
        str(path),
        # -n disables network/transport name resolution, which would otherwise
        # fire DNS queries while parsing an untrusted file. -N m re-enables the
        # one resolver that is purely local: the manuf table, which is where
        # the vendor comes from.
        "-n",
        "-N",
        "m",
        "-T",
        "fields",
        "-E",
        f"separator={SEPARATOR}",
        "-E",
        "occurrence=a",
        "-E",
        f"aggregator={AGGREGATOR}",
        "-E",
        "quote=n",
    ]
    for name in FIELDS:
        argv += ["-e", name]
    return argv


async def run_tshark(binary: str, path: Path, *, timeout_seconds: float) -> str:
    """Dissect ``path`` and return tshark's stdout.

    The subprocess is blocking and the aggregation that follows is CPU-bound,
    so both are handed to a worker thread. An ``async def`` route that blocked
    here would stall every other request on the server.
    """
    try:
        completed = await asyncio.to_thread(
            # Passed by reference, so the argv is the one build_argv made:
            # a list, shell=False, with an explicit timeout.
            subprocess.run,
            build_argv(binary, path),
            capture_output=True,
            check=False,
            timeout=timeout_seconds,
        )
    except FileNotFoundError as error:
        raise TsharkNotFoundError(f"tshark not found at {binary!r}") from error
    except subprocess.TimeoutExpired as error:
        raise TsharkError(
            f"tshark did not finish within {timeout_seconds:g}s and was killed"
        ) from error

    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", "replace").strip()
        raise TsharkError(detail or f"tshark exited {completed.returncode}")

    return completed.stdout.decode("utf-8", "replace")


def decode(output: str) -> Iterator[PacketRecord]:
    """Turn tshark's field output into records, one per frame.

    A line tshark could not produce a usable timestamp or length for is skipped
    rather than aborting the whole capture: one malformed frame in a million is
    a fact about the file, not a reason to refuse it.
    """
    for line in output.splitlines():
        if not line.strip():
            continue
        record = _decode_line(line)
        if record is not None:
            yield record


def _decode_line(line: str) -> PacketRecord | None:
    columns = line.split(SEPARATOR)
    # tshark emits every requested field, so a short line is a truncated one.
    if len(columns) < len(FIELDS):
        columns = columns + [""] * (len(FIELDS) - len(columns))

    def get(name: str) -> str:
        return columns[_INDEX[name]].strip()

    def first(name: str) -> str:
        """The first occurrence, for a field that may repeat within a frame."""
        return get(name).split(AGGREGATOR)[0].strip()

    number = _as_int(first("frame.number"))
    frame_len = _as_int(first("frame.len"))
    if number is None or frame_len is None:
        return None
    try:
        epoch_ns = epoch_ns_from_tshark(first("frame.time_epoch"))
    except ValueError:
        return None

    ip_src, ip_dst, ip_version = _addresses(
        first("ip.src"), first("ip.dst"), first("ipv6.src"), first("ipv6.dst")
    )
    transport, src_port, dst_port, payload_len = _transport(get, first)

    record = PacketRecord(
        number=number,
        epoch_ns=epoch_ns,
        frame_len=frame_len,
        eth_src=_as_mac(first("eth.src")),
        eth_dst=_as_mac(first("eth.dst")),
        eth_src_vendor=_as_vendor(first("eth.src.oui_resolved")),
        eth_dst_vendor=_as_vendor(first("eth.dst.oui_resolved")),
        vlan_id=_as_int(first("vlan.id")),
        ip_src=ip_src,
        ip_dst=ip_dst,
        ip_version=ip_version,
        transport=transport,
        src_port=src_port,
        dst_port=dst_port,
        payload_len=payload_len,
        tcp_syn=_as_flag(first("tcp.flags.syn")),
        tcp_ack=_as_flag(first("tcp.flags.ack")),
        tcp_rst=_as_flag(first("tcp.flags.reset")),
        tcp_retransmission=bool(get("tcp.analysis.retransmission")),
        protocols=_as_protocols(first("frame.protocols")),
        interface=first("frame.interface_name") or None,
    )
    record = _with_bindings(record, first)
    return replace(record, hostnames=_hostnames(record, get, first))


def _addresses(
    ipv4_src: str, ipv4_dst: str, ipv6_src: str, ipv6_dst: str
) -> tuple[str | None, str | None, Literal[4, 6] | None]:
    if ipv4_src and ipv4_dst:
        return ipv4_src, ipv4_dst, 4
    if ipv6_src and ipv6_dst:
        return ipv6_src, ipv6_dst, 6
    return None, None, None


def _transport(
    get: Getter, first: Getter
) -> tuple[Literal["tcp", "udp", "icmp"] | None, int | None, int | None, int]:
    tcp_src = _as_int(first("tcp.srcport"))
    if tcp_src is not None:
        return "tcp", tcp_src, _as_int(first("tcp.dstport")), _as_int(first("tcp.len")) or 0

    udp_src = _as_int(first("udp.srcport"))
    if udp_src is not None:
        # udp.length covers the 8-byte header as well, which payload_bytes
        # must not: that is a frame_bytes concern.
        length = _as_int(first("udp.length")) or 0
        return "udp", udp_src, _as_int(first("udp.dstport")), max(length - 8, 0)

    if get("icmp.type") or get("icmpv6.type"):
        return "icmp", None, None, 0
    return None, None, None, 0


def _binding_pair(
    ip: str, mac: str | None, *, reject_unspecified: bool = True
) -> tuple[str, str] | None:
    """Both halves of a binding, or nothing. Half an assertion is not evidence."""
    address = ip.strip()
    if not address or mac is None:
        return None
    if reject_unspecified and address == _UNSPECIFIED_IPV4:
        return None
    return address, mac


def _with_bindings(record: PacketRecord, first: Getter) -> PacketRecord:
    """Attach address-to-machine evidence found in this frame.

    Nothing here decides that a binding is *true* -- that is aggregation's job,
    and it applies the locality guard that stops the router being credited with
    every address on the internet. This only records what the frame asserted.
    """
    # Any ARP frame names its own sender, and ARP does not cross a router, so
    # the sender is on this segment whatever the opcode.
    sender = _binding_pair(first("arp.src.proto_ipv4"), _as_mac(first("arp.src.hw_mac")))
    # Opcode 2 is a reply: an unprompted assertion of "this address is at this
    # hardware address", and the strongest evidence there is.
    arp = sender if first("arp.opcode") == "2" else None

    # ICMPv6 type 136 is a Neighbor Advertisement, the IPv6 equivalent. The
    # unspecified-address guard is IPv4-shaped, so it does not apply.
    ndp = (
        _binding_pair(
            first("icmpv6.nd.na.target_address"),
            _as_mac(first("icmpv6.opt.linkaddr")),
            reject_unspecified=False,
        )
        if first("icmpv6.type") == "136"
        else None
    )

    dhcp = (
        _binding_pair(first("dhcp.ip.your"), _as_mac(first("dhcp.hw.mac_addr")))
        if first("dhcp.option.dhcp") == _DHCP_ACK
        else None
    )

    # Type 135 is a Neighbor Solicitation, and one is only ever sent for an
    # on-link target -- so it places that address on this segment. It stays out
    # of the binding pairs above on purpose: the link-layer option in a
    # solicitation is the sender's address, not the target's.
    solicited = (
        first("icmpv6.nd.ns.target_address").strip()
        if first("icmpv6.type") == _NDP_SOLICITATION
        else ""
    )

    if sender is None and arp is None and ndp is None and dhcp is None and not solicited:
        return record

    return replace(
        record,
        arp_sender_ip=sender[0] if sender else None,
        arp_sender_mac=sender[1] if sender else None,
        arp_reply_ip=arp[0] if arp else None,
        arp_reply_mac=arp[1] if arp else None,
        ndp_advertised_ip=ndp[0] if ndp else None,
        ndp_advertised_mac=ndp[1] if ndp else None,
        dhcp_assigned_ip=dhcp[0] if dhcp else None,
        dhcp_assigned_mac=dhcp[1] if dhcp else None,
        ndp_solicited_ip=solicited or None,
    )


def _hostnames(record: PacketRecord, get: Getter, first: Getter) -> tuple[HostnameClaim, ...]:
    """Names asserted in this frame, each attached to the address it describes.

    Which address a name belongs to is the whole difficulty: an SNI names the
    server the client is dialling, a DHCP hostname names the client itself, and
    a PTR answer names whatever address the question asked about.
    """
    claims: list[HostnameClaim] = []

    # SNI and Host: name the destination -- the server being connected to.
    if record.ip_dst is not None:
        sni = first("tls.handshake.extensions_server_name")
        if sni:
            claims.append(HostnameClaim(record.ip_dst, sni, "tls_sni"))
        host = first("http.host")
        if host:
            claims.append(HostnameClaim(record.ip_dst, host, "http_host"))

    # A DHCP hostname option names the client, which is the address being
    # leased if this is the ACK, or the source otherwise.
    dhcp_name = first("dhcp.option.hostname")
    if dhcp_name:
        subject = record.dhcp_assigned_ip or record.ip_src
        if subject is not None and subject != _UNSPECIFIED_IPV4:
            claims.append(HostnameClaim(subject, dhcp_name, "dhcp_option_12"))

    # NBNS names the host that registered it.
    nbns = first("nbns.name")
    if nbns and record.ip_src is not None:
        claims.append(HostnameClaim(record.ip_src, nbns.rstrip("<>0123456789 "), "nbns"))

    claims.extend(_dns_claims(record, get))
    return tuple(claims)


def _dns_claims(record: PacketRecord, get: Getter) -> Iterator[HostnameClaim]:
    """Names carried in a DNS or mDNS answer.

    A PTR answer names the address its question asked about, which is encoded
    in the ``in-addr.arpa`` query name. An A answer names an address directly.
    mDNS is the same wire format on port 5353, and gets its own source because
    a ``.local`` name means something different from a public PTR.
    """
    is_mdns = "mdns" in record.protocols or record.dst_port == 5353 or record.src_port == 5353
    source: Literal["mdns", "dns_ptr"] = "mdns" if is_mdns else "dns_ptr"

    queries = [q for q in get("dns.qry.name").split(AGGREGATOR) if q]
    ptr_names = [p for p in get("dns.ptr.domain_name").split(AGGREGATOR) if p]
    a_records = [a for a in get("dns.a").split(AGGREGATOR) if a]

    # PTR: pair each answer with the address its query encodes. tshark lists
    # queries and answers in order, so index alignment is the best available
    # pairing without re-parsing the whole message.
    for index, name in enumerate(ptr_names):
        query = queries[index] if index < len(queries) else (queries[0] if queries else "")
        address = _address_from_arpa(query)
        if address is not None:
            yield HostnameClaim(address, name, source)

    # A/AAAA: the answered address takes the queried name. Only meaningful for
    # mDNS here -- a public forward lookup is not one of the schema's sources.
    if is_mdns and queries:
        for address in a_records:
            yield HostnameClaim(address, queries[0], "mdns")


_ARPA_V4 = re.compile(r"^((?:\d{1,3}\.){4})in-addr\.arpa\.?$", re.IGNORECASE)


def _address_from_arpa(query: str) -> str | None:
    """``2.30.20.10.in-addr.arpa`` -> ``10.20.30.2``."""
    match = _ARPA_V4.match(query.strip())
    if match is None:
        return None
    octets = match.group(1).rstrip(".").split(".")
    if len(octets) != 4 or not all(o.isdigit() and int(o) < 256 for o in octets):
        return None
    return ".".join(reversed(octets))


def _as_int(value: str) -> int | None:
    text = value.strip()
    if not text:
        return None
    try:
        # tshark prints some numeric fields in hex when the dissector does.
        return int(text, 16) if text.lower().startswith("0x") else int(text)
    except ValueError:
        return None


def _as_flag(value: str) -> bool:
    """tshark renders a boolean field as ``1``/``0``, or ``True``/``False``."""
    return value.strip().lower() in {"1", "true"}


def _as_mac(value: str) -> str | None:
    text = value.strip().lower()
    return text or None


def _as_vendor(value: str) -> str | None:
    """The manuf lookup, or None when Wireshark had no entry.

    A randomized MAC has no vendor by construction, and Wireshark returns the
    bare OUI bytes for one. Those are not a vendor name and are dropped.
    """
    text = value.strip()
    if not text or re.fullmatch(r"[0-9a-fA-F]{2}([:-][0-9a-fA-F]{2})*", text):
        return None
    return text


def _as_protocols(value: str) -> tuple[str, ...]:
    return tuple(part for part in value.strip().split(":") if part)


def l7_protocols(protocols: tuple[str, ...]) -> tuple[str, ...]:
    """The service layers of a dissection chain, framing removed.

    ``eth:ethertype:ip:tcp:tls:http2`` -> ``("tls", "http2")``.
    """
    return tuple(name for name in protocols if name not in _NOT_L7)
