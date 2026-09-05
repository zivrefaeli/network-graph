# frontend

The UI. React + Vite + TypeScript, rendering the capture document described in
[../README.md](../README.md).

```
npm install
npm run dev          # http://localhost:5173, /api proxied to the backend
npm run build        # the type check, not just the bundle
npm run test         # vitest
```

`npm run test` and `npm run build` run on every pull request
([../.github/workflows/ci.yml](../.github/workflows/ci.yml)), alongside the
backend's own gate.

`dist/` is ignored, not committed: the Pages workflow
([../.github/workflows/static.yml](../.github/workflows/static.yml)) runs
`npm ci && npm run build` on the runner and uploads the output from there. So a
change reaches the published page by landing on `main` -- a local `dist/` is
yours alone, and pushing one is neither needed nor possible.

The graph, the panel and `.json` uploads need no server. Dissecting a capture
does, so for that:

```
docker compose up --build    # from the repo root; frontend on :5173
```

## Talking to the backend

Everything goes through `@/api/client`, and there are exactly two ways in.

| File picked | What happens |
| --- | --- |
| `.json` | Parsed and validated **in the browser**. No server involved. |
| `.pcap`, `.pcapng` | Uploaded to `POST /captures`; the backend dissects it. |

Requests go to `VITE_API_BASE_URL`, defaulting to `/api`, which Vite's dev
server proxies to the backend. That makes every request same-origin, so local
development involves no CORS at all — `settings.cors_origins` on the backend
exists only for a deployment where a browser calls the API directly.

**Uploads use `XMLHttpRequest`, not `fetch`.** The one and only reason is that
`fetch` cannot report upload progress, and a multi-gigabyte capture with no
progress bar is indistinguishable from a hung browser.

**Everything the backend returns still goes through `parseCaptureDocument`.**
That is not paranoia about the network. `app/schemas/graph.py` and
`@/types/graph.ts` are one contract in two languages, and a drift between them
is exactly the bug worth catching at the boundary rather than three components
deep as a `NaN`.

### No backend is a supported state

The build published to GitHub Pages has no backend behind it, so
"nothing is answering" is a normal condition rather than a failure:

- The health strip says **No backend** and offers a retry.
- The sample renders, and `.json` uploads still work.
- Picking a capture file is refused up front with what to do about it, rather
  than failing halfway through an upload as an opaque network error.

A backend that answers `/health` but reports `tshark_available: false` is
treated differently — that is a broken deployment, and it warns, because it
would otherwise look healthy right up until the first upload failed.

## The picture

A machine is one circle. The addresses it answered to sit inside it, and
conversations attach to the address that carried them.

```
              ┌─────────────────────────────┐
              │       workstation-01        │   machine  mac:00:1a:2b:3c:4d:5e
              │                             │   container -- sized to fit, NOT
   10.20.30.1├──● 10.20.30.50             │   a volume encoding
   (gateway)  │                             │
   10.20.30.20──●                          │
              │                             │
              │            ● 10.10.0.6 ──────┼── 10.10.0.1   (the VPN tunnel)
              │                       └─────┼── 96.7.128.175
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

## Interaction

The canvas is driven by pointer only — mouse, trackpad, pen and touch all go
through the same `pointerdown`/`pointermove`/`pointerup` path, so a finger drags
a machine exactly as a mouse does. Nothing on the canvas is in the tab order.

| Gesture | What it does |
| --- | --- |
| Press and move a machine | Drags it. Children and their lines follow. |
| Release | It stays where it was dropped; a dashed ring says so. |
| Double-click / double-tap | Hands it back to the layout. |
| Click a machine | Selects the machine. |
| Click a line | Selects that conversation. |
| Click empty canvas | Clears the selection. |

**Sub-circles are inert.** An address inside a machine takes no pointer events
at all, so a press anywhere within the ring — including on top of a child —
reaches the machine and drags it. Addresses are selected from the panel, which
lists them and links to each; the canvas still draws a halo on whichever one is
selected. An address with no machine is a body in its own right, so it is
clickable: it is the only thing there to click.

The pointer path itself: `getScreenCTM().inverse()` rather than raw
`clientX`/`clientY`, so a drag stays under the finger however the viewBox is
scaled to the window; `setPointerCapture` so a fast drag that leaves the circle
keeps tracking; `touch-action: none` and `user-select: none` on the SVG so a
drag never turns into a page scroll or a text selection.

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

## Layout

```
src/
  types/             graph.ts and health.ts, mirroring the backend. Types only.
  lib/               pure: scales, ring geometry, formatting. No React.
  hooks/             useForceLayout -- the simulation and the drag
                     useHealth     -- whether a backend is there
  api/               client.ts (the only place this app fetches), parse.ts
                     (the boundary), mock.ts (the sample document)
  components/        one per file, named for the file
dist/                the build GitHub Pages serves. Written by `npm run build`,
                     git-ignored, and rebuilt by CI on every deploy.
```

Imports are absolute through `@/`, which is declared twice: `paths` in
`tsconfig.json` for types and `resolve.alias` in `vite.config.ts` for the
bundle. If an import resolves in the editor but not at build time, those two
have drifted.

## Findings against the specs

Recorded rather than papered over:

- The backend serialises `hostname_confidence` and `is_local_basis` as JSON
  `null` rather than omitting them, so typing them `?: number` and testing
  `!== undefined` let a `null` through and rendered it as `0%`. They are now
  `?: number | null` with `!= null` checks. Worth deciding once whether the
  wire format omits absent inferences or sends null, because the two ask for
  different types.

- `CLAUDE.md` prescribes `"baseUrl": "."` alongside `paths`. TypeScript 7
  removed `baseUrl` (`error TS5102`), and `paths` is now resolved relative to
  the `tsconfig.json` that declares it. `tsconfig.json` carries a comment where
  the `baseUrl` line would have gone.
- `CLAUDE.md` requires a keyboard path on every clickable SVG element. That was
  built and then removed on request: this graph is pointer-driven, and nothing
  on the canvas is focusable. The panel and the upload control are real
  buttons and remain keyboard-operable. `CLAUDE.md` still says otherwise and
  needs updating.
- Nothing in the schema had to bend to render. The one place it is thin is
  `machine.properties.vlan_id`, which is nullable in practice — an untagged
  segment has no VLAN — but `README.md` shows only the tagged case.
