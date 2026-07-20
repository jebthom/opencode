import { Schema } from "effect"

// The Aperture payload is the stable contract between the deterministic
// structure extractor (server-side) and the TUI renderer. See PLAN.md.
//
// Determinism is the core invariant: identical inputs must produce a
// byte-identical payload. Node IDs are content-independent (derived from the
// repo-relative path) so the same file always maps to the same node across
// runs, and `nodes`/`edges` are emitted in a stable sorted order. This lets the
// async `semantics` layer (facets/hues inferred by an agent) change without ever
// disturbing the structure the developer relies on for comprehension.

// Bump whenever the extractor's output semantics change so stale caches written
// by an older extractor are never served (aperture.ts gates reads on this).
// - 2: single-layer walk replacing the old recursive (`**/*`) extractor.
// - 3: scoped drill-down walk. `layer` is now scope-relative (see Position) and
//   payloads are cached per scope, so v2 caches describe a different graph.
// - 4: edges (step 6) gained out-of-window `boundaries` — one-hop import targets
//   resolved on disk beyond the window. Edges may now target a boundary id, so a
//   v3 cache (no boundaries, edges window-internal only) describes a thinner graph.
// - 5: semantics generalized from the fixed architectural-layer enum to arbitrary
//   Lens facets. `Semantic.layer` is gone (the facet lives in `facets[0]`),
//   composition weights are keyed by a free-form `facet`, and the payload now carries
//   the active `lens` legend. A v4 cache describes a single-Lens graph.
// - 6: Aperture rename (codegraph → aperture). Wire field names changed
//   (`collection` → `lens`, `tags` → `facets`, weight `tag` → `facet`); a v5 cache
//   uses the old field names and decodes to a thinner graph.
// - 7: sub-file resolution (A5). The payload may carry `extents` — per-function
//   line-delimited tiles for a drilled-into file, each with its own facet/hue.
//   Optional and derived at the read boundary (like `composition`), so it doesn't
//   change the structure cache; the bump is conservative so no v6 cache lingers.
export const PAYLOAD_VERSION = 7

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
// painter (step 4) fills it. Kept separate from `nodes` so it can update
// independently of structure. `facets[0]` is the inferred facet (a facet id from the
// active Lens); `hue` is its resolved colour (hex or theme-key) from the
// Lens legend, applied at the read boundary so the palette can change without
// a re-paint.
export const Semantic = Schema.Struct({
  facets: Schema.Array(Schema.String),
  hue: Schema.optional(Schema.String),
})
export type Semantic = typeof Semantic.Type

// The active Lens's legend, carried on the payload so the renderer paints
// facets → colours and draws the swatch row without any hard-coded vocabulary.
export const LegendEntry = Schema.Struct({
  facet: Schema.String,
  label: Schema.String,
  color: Schema.String,
})
export type LegendEntry = typeof LegendEntry.Type

export const LensInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  legend: Schema.Array(LegendEntry),
  // True for the built-in Lenses whose facets are computed deterministically from the
  // repo (git-changed / edit-recency / bus-factor) rather than by the painter. Lets a
  // client suppress editor-gutter painting for these: two are fundamentally file-level,
  // and git-changed duplicates VSCode's own diff gutter while its whole-file function
  // strips bury the added/removed markers. The TUI ignores it (it still tiles their
  // composition/extents); the VSCode extension skips gutter paint when it's set.
  deterministic: Schema.optional(Schema.Boolean),
})
export type LensInfo = typeof LensInfo.Type

// Recursive subtree composition for a directory node, used to paint the directory
// as a treemap of facet colors. Derived (like `semantics`) at the read boundary from
// the semantic store — never part of the deterministic structure cache — so it
// carries both a file `count` and a `bytes` sum per facet and lets the renderer pick
// which metric drives the treemap. Facets with zero weight are omitted; `total*` are
// the sums across all present facets.
export const FacetWeight = Schema.Struct({
  facet: Schema.String,
  count: Schema.Int,
  bytes: Schema.Int,
})
export type FacetWeight = typeof FacetWeight.Type

export const Composition = Schema.Struct({
  weights: Schema.Array(FacetWeight),
  totalCount: Schema.Int,
  totalBytes: Schema.Int,
  // Totals over *every* descendant source file, painted or not (`total*` count only
  // the painted files that make up `weights`). A fully-unpainted directory therefore
  // has empty `weights` and zero `total*` but non-zero `subtree*`, which lets the
  // renderer size its grey "uncategorized" block by real size instead of painting it
  // full-bleed.
  subtreeCount: Schema.Int,
  subtreeBytes: Schema.Int,
})
export type Composition = typeof Composition.Type

// One sub-file tile (A5): a top-level declaration's line-delimited extent within a
// file, with its own inferred facet/hue. Produced on drill-in only (painting, not
// reading). Lines are 1-based inclusive; the extents of a file tile it exhaustively
// (see extents.ts), so a file's facet mix is a true aggregation of its functions.
// `facet`/`hue` are absent until the drill-in painter colours the function.
export const Extent = Schema.Struct({
  name: Schema.String,
  startLine: Schema.Int,
  endLine: Schema.Int,
  facet: Schema.optional(Schema.String),
  hue: Schema.optional(Schema.String),
})
export type Extent = typeof Extent.Type

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
  // The active Lens + its legend, merged in at the read boundary. Optional
  // so older/empty payloads still decode; the renderer falls back to no legend.
  lens: Schema.optional(LensInfo),
  // Sub-file tiles (A5), keyed by *file* node id. Present only for a drilled-into
  // file (at most one key in practice); derived at the read boundary like
  // `composition`, so it's backward compatible with structure caches.
  extents: Schema.optional(Schema.Record(Schema.String, Schema.Array(Extent))),
})
export type Payload = typeof Payload.Type

export const decodeUnknown = Schema.decodeUnknownEffect(Payload)

export * as AperturePayload from "./payload"
