# network-graph

Turns a Wireshark capture into an interactive map of who talked to whom. The
node and edge JSON schemas live in [README.md](./README.md) and are the
contract between the capture pipeline and the frontend. Read them before
touching rendering code.

## Repo layout

| Path | What it is |
| --- | --- |
| `README.md` | The schema spec. Source of truth for every field name. |
| `frontend/` | The production frontend. Everything below applies here. |

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
export type NodeId = `ip:${string}` | `mac:${string}`
export type EdgeId = `edge_${string}`

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
- **The graph is L3 by default.** L2 edges are opt-in and visually separated;
  mixing the layers silently turns the gateway into a false hub.

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
accessible name, and Enter/Space activation. The prototype has none of this and
that is one of the reasons it is not production code. A graph that can only be
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
2. No `any`, no `!`, no `../` imports anywhere in the diff.
3. Field names in the diff match README.md exactly.
4. Any new size or width mapping goes through `@/lib/scales`.
5. New interactive elements are keyboard-reachable.
6. If the schema had to bend to make something render, say so — that is a
   finding about README.md, not something to paper over in the component.
