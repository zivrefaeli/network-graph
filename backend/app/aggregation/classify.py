"""Deciding what an address *is*: scope, locality, and node type.

Everything here is an inference, and everything here returns the basis for it
alongside the answer, because the UI is required to display one.
"""

import ipaddress
from dataclasses import dataclass
from typing import Literal

type AddressScope = Literal["private", "public", "link_local", "loopback", "multicast"]
type NodeType = Literal["host", "router", "broadcast", "multicast", "external"]

BROADCAST_MAC = "ff:ff:ff:ff:ff:ff"

#: An IPv4 address of all ones, and the IPv6 all-nodes groups.
_IPV4_BROADCAST = ipaddress.IPv4Address("255.255.255.255")


def parse_address(text: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    try:
        return ipaddress.ip_address(text)
    except ValueError:
        return None


def scope_of(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> AddressScope:
    """Which class of address this is, in the schema's vocabulary."""
    if address.is_multicast:
        return "multicast"
    if address.is_loopback:
        return "loopback"
    if address.is_link_local:
        return "link_local"
    if address.is_private:
        return "private"
    return "public"


def mac_is_randomized(mac: str) -> bool:
    """Read the locally-administered bit of the first octet.

    When it is set the MAC identifies one association rather than a device, so
    there is no vendor behind it and a device that rotates mid-capture
    legitimately appears as two machines.

    The broadcast and IPv4/IPv6 multicast MACs have the bit set too, but they
    are not devices at all, so they are excluded rather than mislabelled.
    """
    octet = _first_octet(mac)
    if octet is None or is_group_mac(mac):
        return False
    return bool(octet & 0b10)


def is_group_mac(mac: str) -> bool:
    """Broadcast or multicast at L2 -- a destination, never a device."""
    if mac == BROADCAST_MAC:
        return True
    octet = _first_octet(mac)
    return octet is not None and bool(octet & 0b1)


def oui_of(mac: str) -> str | None:
    """The first three octets, or None when the MAC identifies no manufacturer."""
    parts = mac.split(":")
    if len(parts) != 6 or mac_is_randomized(mac) or is_group_mac(mac):
        return None
    return ":".join(parts[:3])


def _first_octet(mac: str) -> int | None:
    head = mac.split(":")[0] if ":" in mac else ""
    try:
        return int(head, 16)
    except ValueError:
        return None


@dataclass(frozen=True, slots=True)
class Locality:
    """Whether an address sits on the captured segment, and how we know."""

    is_local: bool
    basis: str


def classify_locality(
    address: ipaddress.IPv4Address | ipaddress.IPv6Address,
    *,
    on_segment: bool,
    bound_to_non_router: bool,
) -> Locality:
    """Decide locality, strongest evidence first.

    ``on_segment`` means the address appeared in ARP or NDP, which only travel
    within one broadcast domain -- the strongest signal there is. Failing that,
    a private address that was seen sourcing frames from a MAC that is *not*
    the router's is local too.

    The router guard is the load-bearing half. Every packet arriving from the
    internet carries the router's MAC as its *source*, so "was seen as a source
    with a MAC" on its own would mark the whole internet local and attribute it
    to the gateway. README.md says binding is source-side only; source-side is
    necessary but not sufficient, and this is the missing half.
    """
    if address.is_loopback:
        return Locality(True, "loopback")
    if address.is_multicast:
        return Locality(False, "multicast_group_not_a_host")
    if on_segment:
        return Locality(True, "observed_in_arp_or_ndp_on_this_segment")
    if address.is_link_local:
        return Locality(True, "link_local_by_definition")
    if address.is_private and bound_to_non_router:
        return Locality(True, "private_and_sourced_from_a_local_mac")
    if address.is_private:
        return Locality(False, "private_but_never_seen_on_this_segment")
    return Locality(False, "not_private_and_routed_via_gateway")


def classify_node_type(
    address: ipaddress.IPv4Address | ipaddress.IPv6Address,
    *,
    is_local: bool,
    is_router: bool,
) -> NodeType:
    """Colour the circle honestly.

    Broadcast and multicast are pseudo-nodes, not machines, and must never read
    as one.
    """
    if address.is_multicast:
        return "multicast"
    if isinstance(address, ipaddress.IPv4Address) and address == _IPV4_BROADCAST:
        return "broadcast"
    if is_router:
        return "router"
    if not is_local:
        return "external"
    return "host"
