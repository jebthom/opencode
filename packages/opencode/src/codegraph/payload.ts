import { Schema } from "effect"

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
export const PAYLOAD_VERSION = 3

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

// Async, agent-supplied semantics keyed by node id. Empty in step 1; populated
// later by the semantic tagger. Kept separate from `nodes` so it can update
// independently of structure.
export const Semantic = Schema.Struct({
  tags: Schema.Array(Schema.String),
  hue: Schema.optional(Schema.String),
})
export type Semantic = typeof Semantic.Type

export const Payload = Schema.Struct({
  version: Schema.Int,
  nodes: Schema.Array(Node),
  edges: Schema.Array(Edge),
  semantics: Schema.Record(Schema.String, Semantic),
})
export type Payload = typeof Payload.Type

export const decodeUnknown = Schema.decodeUnknownEffect(Payload)

export * as CodeGraphPayload from "./payload"
