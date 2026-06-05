// Architectural-layer vocabulary for the code-graph semantic layer (PLAN.md
// step 4). Deliberately dependency-free (no Effect/Schema) so it is safe to
// import from both the server-side tagger/payload and the TUI renderer without
// dragging server code into the TUI bundle.
//
// The structure of the graph is deterministic; this is the *paint*. Each file
// node is tagged with one fixed layer, and `LAYER_HUE` maps that layer to a
// named theme color. The renderer already resolves a node's `hue` against the
// active theme (codegraph.tsx `hueColor`), so painting a node is just a matter
// of storing the layer's theme-key here — no renderer-side color logic.

// Fixed enum → predictable, stable hues and a legend that never reflows. Ordered
// roughly outside-in (what the program presents → what it runs on).
export const LAYERS = ["interface", "application", "domain", "data", "infrastructure"] as const
export type Layer = (typeof LAYERS)[number]

// Each layer maps to a distinct key on TuiThemeCurrent (packages/plugin/src/tui.ts).
// We deliberately use the theme's *qualitative* status roles (info/success/warning/
// accent/error ≈ blue/green/yellow/purple/red) rather than primary/secondary: those
// two are tuned as low-contrast siblings in most themes and were perceptually
// colliding (interface↔infra, application↔data). The status rainbow is kept
// mutually distinct by virtually every theme. These strings MUST stay valid theme
// keys — `hueColor` falls back to a structural color otherwise.
export const LAYER_HUE: Record<Layer, string> = {
  interface: "info", // blue
  application: "success", // green
  domain: "warning", // yellow/orange
  data: "accent", // purple
  infrastructure: "error", // red
}

// Directories aren't a semantic layer — they're structural drill-in targets — but
// they share the legend, so they get the 6th distinct hue: the theme's brand color.
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

// One-line guidance handed to the tagger model so it can place a file without
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

export * as CodeGraphSemantics from "./semantics"
