# backend

A small FastAPI service. It takes a capture file, runs Wireshark's dissectors
over it, aggregates the result into the document described in
[../README.md](../README.md), and serves it. A parser with an HTTP surface, not
an application.

## Running it

`tshark` is a Wireshark install, not a Python package, so the service runs in a
container that has one:

```
docker compose up --build          # from the repo root; serves on :8000
```

```
GET  /health              liveness, plus whether tshark was found and its version
POST /captures            upload a capture, parse it, return the document
GET  /captures/{id}       the document for an earlier upload
```

## Working on it

`app/aggregation/` is pure — no FastAPI, no `tshark`, no filesystem. It takes
decoded packet records and returns schema models, which is what makes the
counting rules testable without a capture file. Those tests run on a bare host:

```
cd backend
uv sync
uv run ruff check . && uv run ruff format --check .
uv run mypy .
uv run pytest                      # 116 pass, 15 skip (they need tshark)
```

The 15 skipped ones dissect the committed fixtures with the real binary. They
run in the container:

```
docker compose run --rm --no-deps backend pytest    # 131 pass
```

CI runs all 131 on every pull request: `.github/workflows/ci.yml` installs
`tshark` from apt on the runner, so nothing skips there. The same job runs the
lint, format and type gates above, in that order.

Regenerate the fixtures after changing what they contain:

```
uv run python -m tests.fixtures.make_fixtures
```

`tests/test_fixtures.py` rebuilds them in a temp directory and compares bytes,
so a committed file cannot drift from the script that writes it.

## The shape of it

```
app/
  main.py            app factory, router registration, the startup tshark check
  settings.py        pydantic-settings, every NG_-prefixed knob
  store.py           where a document lives between POST and GET. A dict.
  api/               one module per resource, every response typed
  schemas/graph.py   Pydantic mirror of ../README.md. extra=forbid, frozen.
  parsing/           tshark and capinfos invocation, and decoding their output
  aggregation/       packets -> nodes and edges. Pure.
tests/fixtures/      make_fixtures.py, and the .pcapng files it writes
```

The seam is `parsing/records.py`. Parsing produces `PacketRecord`s; aggregation
consumes them and knows nothing else.

## Decisions worth not relitigating

**Dissection goes through `tshark`, as a subprocess.** Not `scapy`, not
`pyshark`. The value here is Wireshark's protocol coverage — the same L7 names
a user would see in the GUI — and `tshark` is what produces them. The cost is
an external binary, which is checked at startup and reported by `/health`
rather than discovered at the first upload.

**`-T fields`, not `-T ek`.** `CLAUDE.md` illustrates the call with `-T ek`,
which emits the full dissection tree as ndjson and is enormous on a real
capture. An explicit `-e` list is a fraction of the size, and
`frame.protocols` (`eth:ethertype:ip:tcp:tls`) supplies `l7_protocols`
directly. `FIELDS` in `parsing/tshark.py` and the decoder below it are one
unit: change both or neither, and `test_decodes_the_committed_fixture` asserts
every field still comes back populated from the real binary.

**`-n -N m`.** Name resolution is off, because dissecting an untrusted file
must not fire DNS queries. `-N m` re-enables the one resolver that is purely
local — the `manuf` table — which is where `vendor` comes from, so no OUI
database is bundled.

**Time is an `int` count of nanoseconds, everywhere.** Python's `datetime` is
microsecond-precision, so a nanosecond pcapng loses three digits by passing
through one, and a `float` is worse: at 2026 epoch magnitudes a float64 has
about 400 ns of resolution. `frame.time_epoch` arrives as decimal text and is
split on the point. Formatting happens once, at the edge, at the resolution
`capinfos` says the file carries — not guessed from the values, because a
nanosecond capture whose frames land on microsecond boundaries would otherwise
be demoted.

**The gateway is not a hub, and the guard is locality.** `README.md` says an
address joins a machine only on source-side evidence. That is necessary and
*not sufficient*: every packet arriving from the internet carries the router's
MAC as its **source**, so source-side evidence alone would bind the entire
internet to the gateway — the exact bug the L3 design exists to avoid. So:

- A MAC that forwards traffic for off-segment addresses is a router.
  Identifying it *does* look at destination MACs, legitimately — "which MAC is
  the next hop" is precisely what a destination MAC answers.
- `source_mac` evidence is accepted only for an address seen in ARP/NDP on this
  segment, or one that is private/link-local and arrived from a MAC that is not
  a router.
- ARP and NDP do not cross a router, so anything named in one is on-segment by
  construction. That is the strongest locality signal and it does not depend on
  address ranges at all.

`test_a_public_address_never_binds_to_the_router` is the regression test.

**The store is a dictionary, and says so.** `GET /captures/{id}` needs
somewhere to read from. It is bounded (documents are large), thread-safe
(`asyncio.to_thread` means writes really do arrive from several threads), and
process-local — restart the server and the captures are gone. The 404 says so
in as many words. Giving it a real home means changing `store.py` and nothing
else.

## Findings against the specs

Recorded rather than papered over, as `CLAUDE.md` asks.

**1. The machine id cannot express the machine key.** `README.md` keys a
machine by MAC *and* VLAN — "the same MAC seen on two VLANs is two machines" —
but spells the id `mac:<address>`, which has nowhere to put the VLAN. This
build uses the plain form whenever a MAC appeared on one VLAN (the common case,
and exactly what the schema's examples show) and appends `@vlan<n>` /
`@untagged` only where a MAC genuinely appeared on more than one, so the two
machines the key demands get two ids. The schema should say which it wants.

**2. `Machine` has no `node_type`, so an L2 broadcast destination cannot be
typed.** `Node` has `broadcast` and `multicast` precisely so pseudo-nodes never
read as machines, but `l2` edges terminate on machines and ARP is broadcast. A
group MAC is emitted as a machine with an honest label (`broadcast`) because
dropping it would leave every broadcast `l2` edge pointing at an id the
document does not carry. `Machine` wants the same `node_type` field `Node` has.

**3. `l2` traffic is invisible in every total.** `README.md` says a node's
`traffic` is the sum of its edges and a machine's is the sum of its nodes.
`l2` edges terminate on machines, not nodes, so their bytes belong to neither
sum — an ARP-only host correctly has a machine and correctly reports zero
traffic. Both rollup invariants hold; the schema simply has no place to put
frame-level bytes.

**4. `mac_is_randomized` is ambiguous for group MACs.** The locally-administered
bit is set on `ff:ff:ff:ff:ff:ff` and on every IPv4 multicast MAC, so a literal
reading marks them randomized. They are not devices at all, so this build
excludes them; the schema should say so.

**5. `disallow_any_explicit` cannot hold with Pydantic.**
`pydantic.BaseModel.__init__` is `(**data: Any)`, so every model subclassing it
trips the check on a signature this code never wrote. `CLAUDE.md` mandates both.
Suppressed for `app.schemas.*` and `app.settings` only, in `pyproject.toml`,
with the reason inline — a hand-written `Any` anywhere else still fails.

**6. The whole capture is held in memory.** `tshark`'s output is read as one
string and one `PacketRecord` is kept per packet. Uploads stream to disk and
never do this, but aggregation does. `NG_MAX_PACKETS` (default 2,000,000)
refuses a larger capture with a reason rather than exhausting the machine.
Making this stream is a change to `parsing/` alone — `aggregation` already
consumes an iterable.

## Security note

`tshark`'s dissectors have a long CVE history, and this service runs them over
untrusted files. That is an accepted risk for a local tool and a real one for a
hosted deployment. What is done about it here: the subprocess is an argument
list with `shell=False` and an explicit timeout, name resolution is off, the
uploaded filename never touches the filesystem, uploads are size-capped and
deleted in a `finally`, and `tshark`'s stderr is logged rather than returned to
the client because it can name server paths.
