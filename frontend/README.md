# frontend

The UI. React + Vite + TypeScript, rendering the capture document described in
[../README.md](../README.md).

```
npm install
npm run dev      # http://localhost:5173
npm run build    # the type check, not just the bundle
npm run test     # vitest
```

## What is here right now

Stage 1 of three. Everything renders from a mock document; there is no backend
yet. The upload control accepts a `.json` capture document and renders it for
real, and recognises a `.pcap`/`.pcapng` but says plainly that dissecting one
needs `tshark`, which lives in the backend.

## The picture

A machine is one circle. The addresses it answered to sit inside it, and
conversations attach to the address that carried them.

```
              ┌─────────────────────────────┐
              │       workstation-01        │   machine  mac:00:1a:2b:3c:4d:5e
              │                             │   container -- sized to fit, NOT
   192.168.1.1├──● 192.168.1.50             │   a volume encoding
   (gateway)  │                             │
   192.168.1.20──●                          │
              │                             │
              │            ● 10.8.0.6 ──────┼── 10.8.0.1   (the VPN tunnel)
              │                       └─────┼── 93.184.216.34
              └─────────────────────────────┘

   ● sub-circle = one address. Area = packets. Edges land here.
```

`workstation-01` is one physical PC holding a LAN address and a VPN address.
Four conversations belong to the first, two to the second. Grouping by MAC is
what makes it one circle; edges still connecting IPs is what stops the gateway
from swallowing the internet.

## How the drag works without a second simulation

`lib/layout.ts` splits the document into **bodies** and **placements**.

- A **body** is one thing the force simulation moves: a machine, or an address
  with no machine.
- Addresses inside a machine are **not** bodies. They are placed on a ring at a
  fixed offset from the parent centre.

So `positionOf(addressId)` is `body position + offset`, and edges read that.
Dragging a machine moves one simulation node; its sub-circles and every line
that terminates on them follow for free, with nothing to keep in sync.

Ring radius comes from the chord between adjacent children — `2R·sin(π/n)` —
solved for the pair that needs the most room, so no two neighbours touch and
everything fits inside the container.

## Rules worth knowing before editing

These are in [../CLAUDE.md](../CLAUDE.md) in full. The short version:

- **Circle area encodes packets, so radius goes through `Math.sqrt`.** Every
  size mapping goes through `@/lib/scales`; no component computes its own.
- **An expanded machine's ring is a container and does not encode volume.** It
  is drawn hollow, and the legend and panel both say so. A single-address or
  collapsed machine is one circle and *is* volume-honest.
- **Edges terminate on addresses.** `EdgeEndpoints` is
  `readonly [AddressId, AddressId]`, so a `MachineId` there is a type error.
- **Edges are undirected**, endpoints are sorted, and both directions are shown
  separately. No arrowheads, and never one merged byte total.
- **`frame_bytes` and `payload_bytes` are different numbers.** Labelled, never
  summed.
- **A scan is flagged regardless of line width**, because it is nearly free in
  bytes and would otherwise be the thinnest line on the canvas.
- **Wire field names stay as the schema spells them.** No camelCase layer.
- **Every clickable SVG element is keyboard-reachable** — `tabIndex`, `role`, an
  accessible name, Enter/Space.

## Layout

```
src/
  types/graph.ts     transcription of ../README.md. Types only.
  lib/               pure: scales, ring geometry, formatting. No React.
  hooks/             useForceLayout -- the simulation and the drag
  api/               the mock document, and the parse boundary
  components/        one per file, named for the file
```

Imports are absolute through `@/`, which is declared twice: `paths` in
`tsconfig.json` for types and `resolve.alias` in `vite.config.ts` for the
bundle. If an import resolves in the editor but not at build time, those two
have drifted.

## Findings against the specs

Recorded rather than papered over:

- `CLAUDE.md` prescribes `"baseUrl": "."` alongside `paths`. TypeScript 7
  removed `baseUrl` (`error TS5102`), and `paths` is now resolved relative to
  the `tsconfig.json` that declares it. `tsconfig.json` carries a comment where
  the `baseUrl` line would have gone.
- Nothing in the schema had to bend to render. The one place it is thin is
  `machine.properties.vlan_id`, which is nullable in practice — an untagged
  segment has no VLAN — but `README.md` shows only the tagged case.
