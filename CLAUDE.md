# network-graph

Turns a Wireshark capture into an interactive map of who talked to whom. The
node and edge JSON schemas live in [README.md](./README.md) and are the
contract between the capture pipeline and the frontend. Read them before
touching rendering code.

## Repo layout

| Path | What it is |
| --- | --- |
| `README.md` | The schema spec. Source of truth for every field name. |
| `frontend/` | React + TypeScript UI. See [Frontend](#frontend). |
| `backend/` | FastAPI service that turns a capture into a schema document. See [Backend](#backend). |

The schema in `README.md` is the seam between the two. Neither side owns it, and
a change to it lands on both sides in the same commit or not at all.

---

## The node model: machines and interfaces

**A machine is one circle. Its addresses are circles inside it.**

An earlier draft keyed every node by IP, which turned one PC with three
addresses into three unrelated circles that happened to sit near each other.
The replacement:

| Kind | Id | What it is |
| --- | --- | --- |
| Machine | `mac:00:1a:2b:3c:4d:5e` | One physical host on the local segment. The outer circle. |
| Interface | `ip:192.168.1.50` | One address, belonging to a machine. A small circle inside it. |
| Remote | `ip:93.184.216.34` | An address past the gateway, with no machine of its own. A plain circle. |

**Edges always terminate on an address, never on a machine.** This is the
load-bearing rule, and it is what stops the gateway becoming a false hub: the
router's MAC appears on every frame headed off-segment, so grouping by MAC
would collapse the whole internet onto the router. It does not, because MAC is
used *only to group local addresses into machines* — the conversation itself is
still between two IPs. Anyone "simplifying" edges to terminate on machines has
reintroduced the bug the L3 design existed to avoid.

Consequences that follow, and that both sides must implement consistently:

- **A machine with exactly one address draws no sub-circle.** One child inside
  one parent is noise. Draw a single circle, labelled with the machine.
- **Sizing.** A single-address machine, and a collapsed machine, is one circle
  sized by packet volume under the usual √ rule. An *expanded* multi-address
  machine is a container: the children carry the volume encoding and the parent
  is sized to fit them. Say which is which in the legend, because a container
  circle is not volume-honest and must not be read as though it were.
- **Machines are collapsible.** Collapsed, the machine is one volume-sized
  circle and its edges re-terminate on it, merging per-address conversations to
  the same peer. A host with twenty aliases is unreadable otherwise.
- **Dragging moves the machine.** Children are positioned relative to the parent
  centre, so the existing drag already carries them and their edges. Children
  are not independently draggable.
- **Selection has two levels.** Click the machine for identity and aggregate
  traffic; click an address for that address's own conversations. Both are
  reachable by keyboard.
- **`(MAC, VLAN)` is the machine key, not MAC alone.** The same MAC on two VLANs
  stays two machines, as the schema already says.

### Binding an address to a machine

An address joins a machine only on evidence, and the evidence rules matter more
than they look:

- Bind from frames where the address is the **source**. The destination MAC of a
  frame is routinely the gateway's, so binding on destination attributes half
  the internet to the router.
- ARP and NDP replies are the strongest evidence. Prefer them.
- **An address seen with two different source MACs is not an error to resolve by
  picking one.** It is DHCP reassignment, MAC randomisation, or spoofing — all
  three are worth seeing. Record every binding with its time range and surface
  the conflict.
- **No binding observed means no machine.** The address stays a standalone
  circle carrying an `inference` basis that says why. Never invent a parent.
- A randomised MAC that rotates mid-capture legitimately produces two machines.
  That is the truth of what was on the wire; `mac_is_randomized` explains it.

---

# Frontend

## Stack

React + Vite + TypeScript. `d3-force` for layout — the force module only, not
the `d3` meta-package and not `d3-drag`. Dragging uses native pointer events,
because React owns this DOM and `d3-drag` fights it for control.

No CSS framework. No component library. No state management library until
something actually needs it.

## TypeScript

Everything is `.ts` / `.tsx`. No `.js` or `.jsx` files in `frontend/`, including
config.

`tsconfig.json` runs `strict: true` plus:

```jsonc
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,   // graph lookups by id return T | undefined
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "verbatimModuleSyntax": true,       // import type { Node } from ...
    "erasableSyntaxOnly": true          // no enums, no parameter properties
  }
}
```

Rules:

- **No `any`.** Use `unknown` at boundaries and narrow. If you genuinely cannot
  type something, write `// TODO(types):` with the reason.
- **No non-null `!`.** `noUncheckedIndexedAccess` exists to force the check.
  A dangling edge endpoint is a real condition in merged captures — handle it.
- **Union types, not enums.** `type NodeType = 'host' | 'router' | ...`.
- **`import type`** for type-only imports.
- **Discriminated unions for state.** `Selection` is
  `{ kind: 'node'; id: NodeId } | { kind: 'edge'; id: EdgeId } | null`, never
  two loose optional fields.

## Functions

A component or hook is declared with `function` and exported by name. Anything
declared *inside* one is a `const` arrow function.

```tsx
export function MachineGroup({ body, onSelect }: MachineGroupProps) {
  const select = (): void => {
    onSelect(body.id)
  }

  return <circle onClick={select} r={body.radius} />
}
```

The split is not cosmetic, and it is the hoisting that decides it.

A `function` declaration is hoisted to the top of its block, so a nested one
can be *called* before a `const` it closes over has been initialised, and the
result is a `ReferenceError` from the temporal dead zone at run time, pointing
at the closure rather than at the ordering mistake that caused it. An arrow
bound to a `const` cannot be used above its own declaration, so the same
mistake is a compile error on the line that made it.

The outer declaration is a `function` for the opposite reason: it is what makes
a component greppable by name, and what React DevTools shows in the tree.

Two things follow:

- **Annotate the return type** unless the body is a single expression. An arrow
  makes it easy to leave off, and nothing in `strict` requires it.
- **A helper that closes over nothing belongs outside the component**, as a
  module-level `function`. If it only reads its arguments it is a `lib/`
  candidate: test it there rather than rebuild it on every render.

## Imports

Absolute, through the `@/` alias, which points at `frontend/src/`.

```ts
import { NodeCircle } from '@/components/NodeCircle'
import { makeRadiusScale } from '@/lib/scales'
import type { GraphNode } from '@/types/graph'
```

**Never** `../` or `../../`. A same-directory `./` is fine only for a file's
own colocated test or stylesheet.

The alias has to be declared twice — TypeScript resolves types, Vite resolves
the bundle, and they do not read each other's config:

```jsonc
// tsconfig.json
{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] } } }
```

```ts
// vite.config.ts
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
})
```

If an import resolves in the editor but breaks at build time, or vice versa,
one of those two is out of date.

**Named exports only.** `export function NodeCircle(...)`, never
`export default`. A default export lets every call site invent its own name for
the same component, which makes `@/components/NodeCircle` unsearchable.

## Directory shape under `frontend/src/`

```
components/   presentational React components, one per file, named for the file
hooks/        use*.ts — stateful logic with no markup
lib/          pure functions: scales, formatting, graph queries. No React.
types/        graph.ts and friends. Types only, no runtime values.
api/          fetching and parsing capture documents
```

Anything in `lib/` must be testable without rendering. If a helper needs a hook,
it belongs in `hooks/`.

## Schema types

`@/types/graph.ts` is a direct transcription of README.md. When the schema
changes, that file changes in the same commit.

**Keep the wire field names exactly as the schema spells them** — `frame_bytes`,
`packets_sent`, `mac_is_randomized`. Do not camelCase them on the way in. A
rename layer means every bug report has to be translated between two
vocabularies, and the schema doc stops being greppable against the code.

```ts
export type MachineId = `mac:${string}`
export type AddressId = `ip:${string}`
export type NodeId = MachineId | AddressId
export type EdgeId = `edge_${string}`

// Edges terminate on addresses. A MachineId here is a type error, not a
// runtime check, which is the whole point of splitting the two.
export type EdgeEndpoints = readonly [AddressId, AddressId]

export type NodeType = 'host' | 'router' | 'broadcast' | 'multicast' | 'external'
export type Layer = 'l3' | 'l2'
export type Transport = 'tcp' | 'udp' | 'icmp'
export type AddressScope = 'private' | 'public' | 'link_local' | 'loopback' | 'multicast'
export type HostnameSource =
  | 'dns_ptr' | 'mdns' | 'nbns' | 'dhcp_option_12' | 'tls_sni' | 'http_host'

export interface Counters {
  packets: number
  frame_bytes: number
  payload_bytes: number
}
```

Template-literal `NodeId` is not decoration: it stops a bare `'192.168.1.50'`
from being passed where a namespaced id is required.

Fields the schema marks as inferred (`hostnames`, `vendor`, `is_local`,
`node_type`) are guesses. Type them so they can be absent, and never render one
without its `inference` basis or confidence beside it.

## Rendering rules

These are correctness requirements, not preferences. Each one exists because
the obvious alternative actively misleads the person reading the graph.

- **Circle area encodes volume, so radius scales with `Math.sqrt`.** Scaling
  radius directly makes 4× the packets look 16× bigger. Every size mapping goes
  through the shared scale in `@/lib/scales`; no component computes its own.
- **Edges are undirected.** The pair is `endpoints[0]`/`endpoints[1]`, sorted.
  `forward` means `endpoints[0] → endpoints[1]`. Never draw an arrowhead off an
  undirected edge, and never assume `endpoints[0]` is the initiator — it is not.
- **Show both directions.** "Who sent 4 GB to whom" is the question this tool
  answers. A single merged byte total is a regression.
- **`frame_bytes` and `payload_bytes` are different numbers.** Label which one
  is on screen. Never sum them.
- **Line width tracks bytes, but a scan must stay visible.** A port scan is
  nearly free in bytes and would otherwise be the thinnest line on the canvas.
  Flag `syn_count > 0 && syn_ack_count === 0` distinctly regardless of width.
- **`node_type` drives colour**, so broadcast and multicast pseudo-nodes never
  read as machines.
- **Machines contain addresses; edges attach to addresses.** See
  [The node model](#the-node-model-machines-and-interfaces). The √ sizing rule
  applies to whatever circle an edge can land on — an address inside an expanded
  machine, or the machine itself when it is collapsed or has one address. An
  expanded machine's outer circle is a container and is sized to fit its
  children, so never label it as encoding volume.
- **L2 edges are opt-in and visually separated.** Grouping local addresses by
  MAC is not the same as drawing L2 conversations, and conflating the two turns
  the gateway into a false hub.

## Force layout

`@/hooks/useForceLayout.ts` owns the simulation. Rules that came out of the
prototype and should not be relitigated:

- Hand `d3-force` **copies** of the document. It mutates whatever it is given.
- `forceCollide` must use the same radius function the renderer uses, or
  circles overlap.
- Pointer coordinates go through `getScreenCTM().inverse()`, never raw
  `clientX`/`clientY`. Raw coordinates break the moment the SVG is scaled or
  zoomed.
- Drag pins: set `fx`/`fy` on pointerdown and **leave them set** on pointerup so
  the node keeps where it was dropped. Provide an explicit release gesture.
- A press that moves less than ~4px is a click, not a drag. Without that
  threshold, finishing a drag also selects the node.

**Performance ceiling.** A React re-render per tick is fine up to roughly 150
nodes. Beyond that, stop re-rendering and write `transform` straight onto
element refs. Beyond a few thousand, SVG itself is the wrong renderer — move to
canvas. Real captures reach both thresholds, so leave the switch points
commented where they apply rather than discovering them under load.

## Interaction and accessibility

Selection lives in one place and is passed down; components do not each hold
their own idea of what is selected.

Every clickable SVG element needs a keyboard path — `tabIndex`, a `role`, an
accessible name, and Enter/Space activation. A graph that can only be
driven by mouse is not shippable.

## Styling

Plain CSS with custom properties for the palette, colocated with the component
or in a single `styles.css` for shared tokens. Colour decisions that carry
meaning — `node_type`, the scan warning — are defined once as tokens and
referenced by name, never as inline hex in a component.

## Testing

Vitest. Colocate as `scales.test.ts` beside `scales.ts`.

Cover the pure layer properly: scales, formatting, scan detection, graph
queries. For components, assert what the schema guarantees — every node type
and every edge shape renders without `undefined` or `NaN` reaching the DOM.

## Before calling frontend work done

1. `npm run build` passes — that is the type check, not just the bundle.
2. No `any`, no `!`, no `../` imports anywhere in the diff, and no `function`
   declared inside a component or hook.
3. Field names in the diff match README.md exactly.
4. Any new size or width mapping goes through `@/lib/scales`.
5. New interactive elements are keyboard-reachable.
6. If the schema had to bend to make something render, say so — that is a
   finding about README.md, not something to paper over in the component.

---

# Backend

A small FastAPI service. It takes a capture file, runs Wireshark's dissectors
over it, aggregates the result into the document described in README.md, and
serves it. It is a parser with an HTTP surface, not an application — resist
growing it into one.

## Stack

Python 3.12, FastAPI, Pydantic v2, uvicorn. Ruff and mypy are not optional; see
[the gate](#before-calling-backend-work-done).

**`uv` is the package manager.** Not pip, not poetry, not conda. Dependencies
live in `pyproject.toml`; `uv.lock` is committed and is what CI installs from.

```
uv sync                      # create/refresh .venv from the lock file
uv add fastapi               # add a dependency and update the lock
uv add --dev pytest          # dev-only dependency
uv run <cmd>                 # run inside the project env
```

Never `pip install` into the venv and never activate it by hand — both leave
`uv.lock` describing an environment that no longer exists. Every command in this
section is written `uv run ...` for that reason.

**Dissection goes through `tshark`, invoked as a subprocess.** Not `scapy`, not
`pyshark`. The whole value here is Wireshark's protocol coverage — the same L7
names a user would see in the GUI — and `tshark` is what produces them. `scapy`
re-implements dissection in pure Python, slowly and with far less coverage;
`pyshark` is a thin wrapper over this same subprocess that adds an event-loop
footgun and little else.

The cost of that decision, which must be handled rather than ignored: `tshark`
is an external binary. Check for it at startup and fail loudly with an
actionable message, never at the first upload.

## Layout

```
backend/
  pyproject.toml
  app/
    main.py           app factory, router registration, startup checks
    api/              routers, one module per resource
    schemas/          Pydantic models. graph.py mirrors README.md exactly.
    parsing/          tshark invocation and output decoding
    aggregation/      packets -> nodes and edges. Pure, no I/O.
    settings.py       pydantic-settings, env-driven
  tests/
```

`aggregation/` must be importable and testable without FastAPI, without
`tshark`, and without touching the filesystem. It takes decoded packet records
and returns schema models. That boundary is what makes the counting rules
below testable at all, so do not let subprocess or request handling leak into
it.

## Pydantic models are the contract

`app/schemas/graph.py` is a direct transcription of README.md, and it is what
FastAPI serialises. The frontend's `@/types/graph.ts` is the same contract in
the other language; the two change together.

Python is the lucky side here — the schema is already snake_case, so there is
no alias layer and no translation. Do not introduce one. `frame_bytes` stays
`frame_bytes`.

```python
from typing import Annotated, Literal
from pydantic import BaseModel, ConfigDict, Field

NodeType = Literal["host", "router", "broadcast", "multicast", "external"]
Layer = Literal["l3", "l2"]
Transport = Literal["tcp", "udp", "icmp"]


class Counters(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    packets: Annotated[int, Field(ge=0)]
    frame_bytes: Annotated[int, Field(ge=0)]
    payload_bytes: Annotated[int, Field(ge=0)]
```

Rules:

- `extra="forbid"` on every model. A typo in a field name must fail loudly, not
  round-trip silently into a document the frontend then ignores.
- `frozen=True` on the schema models. They are a result, not a workspace.
  Aggregate into plain accumulator objects and construct the model once.
- `Literal` unions, mirroring the frontend's string unions. No `Enum` — it
  serialises to something the schema does not describe unless you fight it.
- Constrain what the schema constrains: counts are `ge=0`, `hostname_confidence`
  is `ge=0, le=1`, `endpoints` is a 2-item list.
- Serialise with `model_dump(mode="json")`. FastAPI does this for you; scripts
  and fixtures must do it explicitly or timestamps come out as `datetime`
  objects.

**Timestamps need care.** The schema promises RFC 3339 with fractional seconds
at the capture's native resolution. Python's `datetime` is microsecond-precision,
so a nanosecond pcapng silently loses three digits by passing through it. Carry
the value as integer nanoseconds since the epoch internally and format it to a
string at the edge. Every timestamp is UTC and tz-aware; a naive `datetime`
anywhere in the backend is a bug.

## Counting rules

These mirror the frontend's rendering rules and exist for the same reason: the
obvious implementation produces a graph that misleads.

- **Emit machines and addresses, per
  [the node model](#the-node-model-machines-and-interfaces).** Local addresses
  are grouped under a `mac:` machine on source-side evidence; addresses with no
  observed binding stand alone with a basis explaining why. Emit `l2` edges only
  for traffic with no IP header.
- **Edge endpoints are addresses.** Never a `mac:` id. Every external packet is
  L2-addressed to the router, so an edge that terminates on a MAC collapses the
  internet onto the gateway.
- **A machine's `traffic` is the sum of its addresses'**, and each address's is
  the sum of its edges'. Both levels are asserted in tests; the second is the
  one that catches double-counting.
- **Edges are undirected.** Sort the endpoint pair, derive the id from the
  sorted pair, and record `forward` as `endpoints[0] → endpoints[1]`. The same
  conversation must produce the same edge id regardless of who spoke first.
- **`frame_bytes` is on-the-wire including L2 headers; `payload_bytes` is L4
  payload only.** Two separate accumulators. Never derive one from the other.
- **A node's `traffic` block must equal the sum of its edges' counters.** This
  is a cheap, high-value invariant — assert it in tests over every fixture.
- **`flow_count` is distinct 5-tuples.** It is what separates one long TLS
  session from five thousand short connections at similar byte counts, and it
  is what makes a scan legible. Do not approximate it with a packet count.
- **The server-side port is chosen per flow**, and `transport` disambiguates —
  TCP/53 and UDP/53 are different services.
- **Mark what is inferred.** Hostnames, vendor, locality, and `node_type` are
  guesses. Emit the basis or confidence alongside, because the UI is required
  to display it.

## API surface

Keep it small. Every endpoint is typed by a response model; no bare `dict`
returns anywhere.

```
GET  /health              liveness, plus whether tshark was found and its version
POST /captures            upload a capture, parse it, return the document
GET  /captures/{id}       the document for an earlier upload
```

FastAPI-specific rules:

- **Blocking work goes through `asyncio.to_thread`.** `tshark` is a subprocess
  and aggregation is CPU-bound; an `async def` route that blocks stalls every
  other request on the server. Routes stay `async def` and hand the work off:

  ```python
  import asyncio
  import subprocess

  async def run_tshark(path: Path) -> bytes:
      completed = await asyncio.to_thread(
          subprocess.run,
          [tshark_bin, "-r", str(path), "-T", "ek"],
          capture_output=True,
          check=True,
          timeout=TSHARK_TIMEOUT_SECONDS,
      )
      return completed.stdout
  ```

  `to_thread` is `run_in_executor` with the ceremony removed — prefer it, and do
  not reach for `run_in_executor` or a bare `def` route instead. Aggregation gets
  the same treatment for the same reason.
- **Never read an upload into memory.** Captures are routinely gigabytes.
  Stream `UploadFile` to a temp path in chunks, cap the accepted size, and
  delete the temp file in a `finally`.
- **Never build a shell command from user input.** `subprocess.run([...])` with
  an argument list, `shell=False`, and an explicit timeout. The filename comes
  from an uploaded file and is hostile input.
- Parsing failures are `422` with the reason. A missing capture is `404`. A
  crashed or timed-out `tshark` is `500` and logs its stderr.

Note in review, not in code comments: `tshark` dissectors have a long CVE
history and this service runs them over untrusted files. That is an accepted
risk for a local tool and a real one for a hosted deployment.

## Tooling

Ruff for both lint and format — it replaces black, isort and flake8, so do not
add those. Mypy in strict mode.

```toml
[project]
requires-python = ">=3.12"

[tool.ruff]
target-version = "py312"
line-length = 100

[tool.ruff.lint]
select = ["E", "F", "I", "N", "UP", "B", "A", "C4", "SIM", "TC", "ANN", "ASYNC", "S", "RUF"]

[tool.ruff.lint.per-file-ignores]
"tests/*" = ["S101"]  # pytest asserts

[tool.mypy]
python_version = "3.12"
strict = true
warn_unreachable = true
disallow_any_explicit = true
plugins = ["pydantic.mypy"]
```

Python 3.12 idiom, enforced by ruff's `UP` rules: `X | None` rather than
`Optional[X]`, builtin generics rather than `typing.List`, and the `type`
statement for aliases. Annotate every function, including tests and returns —
`ANN` is on for a reason, and `disallow_any_explicit` mirrors the frontend's
ban on `any`.

## Testing

Pytest. `TestClient` for route behaviour, direct calls for `aggregation/`.

Check in one or two genuinely tiny `.pcapng` fixtures and assert against them
end to end: the emitted document validates against the Pydantic models, node
`traffic` totals equal the sum of edge counters, endpoint pairs come out
sorted, and a capture containing a scan produces `syn_count > 0` with
`syn_ack_count == 0`. Aggregation tests must not require `tshark` — feed them
decoded records directly.

## Before calling backend work done

Run all three, from `backend/`, and paste the result. Not one of them, and not
"it should pass":

```
uv sync
uv run ruff check .
uv run ruff format --check .
uv run mypy .
uv run pytest
```

Then:

1. Every check clean. A failing one is not done, and neither is one silenced
   with `# noqa` or `# type: ignore` — if one is genuinely warranted, the
   comment says why on the same line.
2. Field names in the diff match README.md exactly, and match
   `frontend/src/types/graph.ts`.
3. No naive datetimes, no `shell=True`, no whole-file reads of an upload, and no
   blocking call left on the event loop — subprocess and aggregation go through
   `asyncio.to_thread`.
4. `uv.lock` is committed and in step with `pyproject.toml`. If a dependency
   changed, `uv sync` on a clean checkout reproduces the environment.
5. Both totals invariants hold on every fixture: address totals equal their edge
   sums, machine totals equal their address sums.
6. No `l3` edge terminates on a `mac:` id. (`l2` edges connect machines by
   definition — ARP has no address to attach to.)
5. If the capture contained something the schema cannot express, say so — that
   is a finding about README.md, not a field to quietly invent.
