import { Schema } from "effect"
import { LAYERS } from "./semantics"

// The code-graph payload is the stable contract between the deterministic
// structure extractor (server-side) and the TUI renderer. See PLAN.md.
//
// Determinism is the core invariant: identical inputs must produce a
// byte-identical payload. Node IDs are content-independent (derived from the
// repo-relative path) so the same file always maps to the same node across
// runs, and `nodes`/`edges` are emitted in a stable sorted order. This lets the
// async `semantics` layer (tags/hues inferred by an agent) change without ever
// disturbing the structure the developer relies on for comprehension.

// Bump whenever the extractor's output semantics change so stale caches written
// by an older extractor are never served (codegraph.ts gates reads on this).
// - 2: single-layer walk replacing the old recursive (`**/*`) extractor.
// - 3: scoped drill-down walk. `layer` is now scope-relative (see Position) and
//   payloads are cached per scope, so v2 caches describe a different graph.
// - 4: edges (step 6) gained out-of-window `boundaries` — one-hop import targets
//   resolved on disk beyond the window. Edges may now target a boundary id, so a
//   v3 cache (no boundaries, edges window-internal only) describes a thinner graph.
export const PAYLOAD_VERSION = 4

export const NodeKind = Schema.Literals(["file", "directory"])
export type NodeKind = typeof NodeKind.Type

export const EdgeKind = Schema.Literals(["import"])
export type EdgeKind = typeof EdgeKind.Type

// Deterministic placement computed by the extractor. `layer` is the depth
// relative to the requested scope (0 = a direct child of the scope, 1 = a
// grandchild); `index` is the stable position within a layer. Renderers map
// these onto screen coordinates per orientation.
export const Position = Schema.Struct({
  layer: Schema.Int,
  index: Schema.Int,
})
export type Position = typeof Position.Type

export const Node = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  kind: NodeKind,
  // Bytes for files; sum of descendant file bytes for directories.
  size: Schema.Int,
  position: Position,
})
export type Node = typeof Node.Type

export const Edge = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  kind: EdgeKind,
})
export type Edge = typeof Edge.Type

// A one-hop dependency target that falls *outside* the current 2-level window
// (step 6). Resolved on disk from an in-window file's relative import; deliberately
// has no `position` (it isn't placed in the layer grid) and is never recursed
// into. An `Edge.to` may reference a boundary id. Kept separate from `nodes` so the
// renderer can draw these as off-window affordances rather than placed tiles.
export const Boundary = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  kind: NodeKind,
})
export type Boundary = typeof Boundary.Type

// Async, agent-supplied semantics keyed by node id. Empty until the semantic
// tagger (step 4) fills it. Kept separate from `nodes` so it can update
// independently of structure. `layer` is the inferred architectural layer (the
// fixed CodeGraphSemantics vocabulary); `hue` is its theme-key color. Adding the
// optional `layer` field is backward compatible — older structure caches store an
// empty `semantics` map and still decode, so no PAYLOAD_VERSION bump is needed.
export const Semantic = Schema.Struct({
  tags: Schema.Array(Schema.String),
  hue: Schema.optional(Schema.String),
  layer: Schema.optional(Schema.Literals(LAYERS)),
})
export type Semantic = typeof Semantic.Type

export const Payload = Schema.Struct({
  version: Schema.Int,
  nodes: Schema.Array(Node),
  edges: Schema.Array(Edge),
  // Out-of-window one-hop import targets (step 6). Optional so a decoder tolerates
  // its absence, but the extractor always emits an array (possibly empty) to keep
  // output byte-stable. The version bump already prevents serving older caches.
  boundaries: Schema.optional(Schema.Array(Boundary)),
  semantics: Schema.Record(Schema.String, Semantic),
})
export type Payload = typeof Payload.Type

export const decodeUnknown = Schema.decodeUnknownEffect(Payload)

export * as CodeGraphPayload from "./payload"
