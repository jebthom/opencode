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
// - 4: edges (step 6) gained out-of-window `boundaries` — one-hop import targets
//   resolved on disk beyond the window. Edges may now target a boundary id, so a
//   v3 cache (no boundaries, edges window-internal only) describes a thinner graph.
// - 5: semantics generalized from the fixed architectural-layer enum to arbitrary
//   tag-collection tags. `Semantic.layer` is gone (tag lives in `tags[0]`),
//   composition weights are keyed by a free-form `tag`, and the payload now carries
//   the active `collection` legend. A v4 cache describes a single-collection graph.
export const PAYLOAD_VERSION = 5

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
// independently of structure. `tags[0]` is the inferred tag (a tag id from the
// active collection); `hue` is its resolved colour (hex or theme-key) from the
// collection legend, applied at the read boundary so the palette can change without
// a re-tag.
export const Semantic = Schema.Struct({
  tags: Schema.Array(Schema.String),
  hue: Schema.optional(Schema.String),
})
export type Semantic = typeof Semantic.Type

// The active tag collection's legend, carried on the payload so the renderer paints
// tags → colours and draws the swatch row without any hard-coded vocabulary.
export const LegendEntry = Schema.Struct({
  tag: Schema.String,
  label: Schema.String,
  color: Schema.String,
})
export type LegendEntry = typeof LegendEntry.Type

export const CollectionInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  legend: Schema.Array(LegendEntry),
})
export type CollectionInfo = typeof CollectionInfo.Type

// Recursive subtree composition for a directory node, used to paint the directory
// as a treemap of tag colors. Derived (like `semantics`) at the read boundary from
// the semantic store — never part of the deterministic structure cache — so it
// carries both a file `count` and a `bytes` sum per tag and lets the renderer pick
// which metric drives the treemap. Tags with zero weight are omitted; `total*` are
// the sums across all present tags.
export const TagWeight = Schema.Struct({
  tag: Schema.String,
  count: Schema.Int,
  bytes: Schema.Int,
})
export type TagWeight = typeof TagWeight.Type

export const Composition = Schema.Struct({
  weights: Schema.Array(TagWeight),
  totalCount: Schema.Int,
  totalBytes: Schema.Int,
  // Totals over *every* descendant source file, tagged or not (`total*` count only
  // the tagged files that make up `weights`). A fully-untagged directory therefore
  // has empty `weights` and zero `total*` but non-zero `subtree*`, which lets the
  // renderer size its grey "uncategorized" block by real size instead of painting it
  // full-bleed.
  subtreeCount: Schema.Int,
  subtreeBytes: Schema.Int,
})
export type Composition = typeof Composition.Type

export const Payload = Schema.Struct({
  version: Schema.Int,
  nodes: Schema.Array(Node),
  edges: Schema.Array(Edge),
  // Out-of-window one-hop import targets (step 6). Optional so a decoder tolerates
  // its absence, but the extractor always emits an array (possibly empty) to keep
  // output byte-stable. The version bump already prevents serving older caches.
  boundaries: Schema.optional(Schema.Array(Boundary)),
  semantics: Schema.Record(Schema.String, Semantic),
  // Per-directory subtree composition, keyed by directory node id. Optional and
  // derived (merged in alongside `semantics` at the read boundary), so adding it is
  // backward compatible with older structure caches — no PAYLOAD_VERSION bump.
  composition: Schema.optional(Schema.Record(Schema.String, Composition)),
  // The active tag collection + its legend, merged in at the read boundary. Optional
  // so older/empty payloads still decode; the renderer falls back to no legend.
  collection: Schema.optional(CollectionInfo),
})
export type Payload = typeof Payload.Type

export const decodeUnknown = Schema.decodeUnknownEffect(Payload)

export * as CodeGraphPayload from "./payload"
