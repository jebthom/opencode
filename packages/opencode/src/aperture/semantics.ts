// Architectural-layer vocabulary for the Aperture semantic layer (PLAN.md
// step 4). Deliberately dependency-free (no Effect/Schema) so it is safe to
// import from both the server-side painter/payload and the TUI renderer without
// dragging server code into the TUI bundle.
//
// The structure of the graph is deterministic; this is the *paint*. Each file
// node is painted with one fixed layer, and `LAYER_HUE` maps that layer to a
// literal hex. The renderer resolves a node's `hue` (aperture.tsx `hueColor`)
// and passes hex straight through, so painting a node is just a matter of
// storing the colour here — no renderer-side color logic.

// Fixed enum → predictable, stable hues and a legend that never reflows. Ordered
// roughly outside-in (what the program presents → what it runs on).
export const LAYERS = ["interface", "application", "domain", "data", "infrastructure"] as const
export type Layer = (typeof LAYERS)[number]

// Five of the six categorical palette hues, in palette order minus amber. Written as
// literals rather than imported because lenses.ts imports *this* file — the test
// "architecture layer hues are drawn from the categorical palette" is what keeps the two
// honest, so change these only by copying from PALETTES.categorical in lenses.ts.
//
// These were theme-role keys (info/success/warning/accent/error) until C1. The roles
// resolved against whatever theme each surface happened to have, so "interface" was cyan
// #56b6c2 in the TUI and blue #3794FF in the VSCode chip — the Architecture Lens was the
// worst cross-surface mismatch in the product. Literal hex ends that: see the note on
// PALETTES in lenses.ts for why every facet colour is now a fixed xterm-256 cell.
export const LAYER_HUE: Record<Layer, string> = {
  interface: "#00AFD7", // cyan
  application: "#00875F", // emerald
  domain: "#AFAF00", // chartreuse
  data: "#5F5FD7", // indigo
  infrastructure: "#D7005F", // crimson
}

// Directories aren't a semantic layer — they're structural drill-in targets — but they
// share the legend, so they get a 6th hue. Deliberately still a *theme role*, not a
// palette colour: this one never leaves the TUI (it is a directory-label fallback at
// aperture.tsx `hueColor`, and the VSCode extension has no directory hue at all), and
// painting it a facet colour would make directories read as a facet.
export const DIRECTORY_HUE = "primary"
export const DIRECTORY_LABEL = "Directory"

// Short human label for the legend.
export const LAYER_LABEL: Record<Layer, string> = {
  interface: "Interface",
  application: "Application",
  domain: "Domain",
  data: "Data",
  infrastructure: "Infra",
}

// One-line guidance handed to the painter model so it can place a file without
// reading much of it. Kept terse — the model gets path + comments + imports too.
export const LAYER_DESCRIPTION: Record<Layer, string> = {
  interface: "user-facing surface: UI, TUI, CLI, HTTP routes, rendering, input handling",
  application: "orchestration: sessions, agents, command/request handling, workflow wiring",
  domain: "core business/problem logic and rules, independent of I/O and frameworks",
  data: "persistence and data shape: storage, database, schema, serialization, caches",
  infrastructure: "external integration and platform glue: providers, network, filesystem, processes",
}

// Consumed by the renderer's legend row; also a convenient single source for the
// model's allowed values.
export const LEGEND: ReadonlyArray<{ layer: Layer; label: string; hue: string }> = LAYERS.map((layer) => ({
  layer,
  label: LAYER_LABEL[layer],
  hue: LAYER_HUE[layer],
}))

export function isLayer(value: unknown): value is Layer {
  return typeof value === "string" && (LAYERS as readonly string[]).includes(value)
}

export * as ApertureSemantics from "./semantics"
