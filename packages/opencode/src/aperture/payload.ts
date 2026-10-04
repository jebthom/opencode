import { Schema } from "effect"

// Wire shapes shared by the Aperture routes and their clients (the TUI top bar, the sidebar and
// the VSCode extension).
//
// v3 retired the window payload (nodes, edges, composition, extents): every facet is now a rule
// hit, so the surfaces need only two reads — the whole-repo facet map, and one file's line tags.

// The active Lens's legend, so a renderer paints facets → colours and draws the swatch row
// without any hard-coded vocabulary. `what` (what the marked lines are), `why` (why they matter
// for the task now) and `queries` (its rules, as readable one-liners) are what the hover surfaces
// explain a facet with.
export const LegendEntry = Schema.Struct({
  facet: Schema.String,
  label: Schema.String,
  color: Schema.String,
  what: Schema.String,
  why: Schema.String,
  queries: Schema.Array(Schema.String),
})
export type LegendEntry = typeof LegendEntry.Type

export const LensInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  legend: Schema.Array(LegendEntry),
  owner: Schema.Literals(["user", "agent"]),
})
export type LensInfo = typeof LensInfo.Type

// One line-level facet assignment: a *sparse* range produced by a rule. Lines are 1-based
// inclusive, clamped to the file's real line count. `facet`/`hue` are resolved server-side
// against the active Lens's legend; `rule` names the rule that produced the hit, `query` is that
// rule as a readable one-liner, and `note` carries the authoring agent's per-rule note.
export const LineTag = Schema.Struct({
  startLine: Schema.Int,
  endLine: Schema.Int,
  facet: Schema.String,
  hue: Schema.optional(Schema.String),
  rule: Schema.optional(Schema.String),
  query: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
})
export type LineTag = typeof LineTag.Type

// One file's line tags under the active Lens — the editor gutter's read.
export const Lines = Schema.Struct({
  // Absent when there is no Lens at all.
  lens: Schema.optional(LensInfo),
  path: Schema.String,
  tags: Schema.Array(LineTag),
  // Facets toggled off in the legend (O4). Carried with the colours it modifies so a client
  // that missed the filter event still paints the same filter.
  suppressed: Schema.Array(Schema.String),
})
export type Lines = typeof Lines.Type

export * as AperturePayload from "./payload"
