import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { RGBA } from "@opentui/core"
import { NONE_FACET, NONE_HUE, UNTAGGED_HUE } from "@/aperture/lenses"

// The one place a facet id becomes a colour, shared by every TUI surface that paints one.
//
// Extracted from the top bar when the sidebar Activity View arrived (PLAN.md G2). The
// codebase repeatedly warns that "the same facet greying to two different colours across
// two surfaces would read as a bug in one of them" — a second copy of this logic is
// exactly how that happens, so the top bar's treemap blocks, its file-tile bands, its
// legend swatches and the Activity path all resolve through this module.

// The hue a facet takes while it is filtered out of the legend (O4). Must match
// SUPPRESSED_HUE in extension.ts and MUTED_HEX in chip.ts — since C1 all three are the
// same literal hex rather than a token each surface resolves for itself.
//
// It is NONE_HUE, not the dimmer UNTAGGED_HUE: a facet you turned off is still *code*, so
// it should sit where "Other" sits rather than dropping to the grey that means "nothing to
// see here".
export const SUPPRESSED_HUE = NONE_HUE

// Cell sentinel for an empty / fully-untagged directory: painted light grey so a bordered
// box reads as a real-but-uninhabited directory rather than a black void. The leading
// space is deliberate — it keeps this distinct from any real tag id (slugs are trimmed
// kebab-case and can never start with a space), so don't "tidy" it to "grey".
export const GREY_CELL = " grey"

export interface LegendEntry {
  readonly facet: string
  readonly label: string
  readonly color: string
}

export interface FacetColors {
  // A facet id → colour. The NONE_FACET escape paints the "Other" grey; a real facet
  // paints its legend colour (hex palette or theme role).
  readonly facetColor: (key: string) => TuiThemeCurrent["text"]
  // A treemap/band cell key → colour: the grey sentinel → the dimmer non-code grey; a
  // facet id (incl. NONE_FACET) → its facet colour; null padding → the panel background.
  readonly colorFor: (key: string | null) => TuiThemeCurrent["text"]
}

// Build the pair of resolvers for one legend + filter + theme.
//
// The legend filter (O4) is applied *here* and nowhere else: a suppressed facet is handed
// the untagged grey at this boundary, so every surface downstream greys without knowing
// the filter exists. Callers must keep painting from the **unfiltered** weights — that is
// what preserves a suppressed facet's area, so nothing re-flows and two directories stay
// comparable across a click, which is the whole reason to filter rather than to search.
export function facetColors(
  legend: ReadonlyArray<LegendEntry>,
  suppressed: ReadonlySet<string>,
  theme: TuiThemeCurrent,
): FacetColors {
  const byFacet = new Map(legend.map((e) => [e.facet, suppressed.has(e.facet) ? SUPPRESSED_HUE : e.color]))
  const facetColor = (key: string): TuiThemeCurrent["text"] =>
    key === NONE_FACET ? resolveColor(theme, NONE_HUE) : resolveColor(theme, byFacet.get(key))
  const colorFor = (key: string | null): TuiThemeCurrent["text"] => {
    if (key === GREY_CELL) return resolveColor(theme, UNTAGGED_HUE)
    if (key) return facetColor(key)
    return theme.backgroundPanel
  }
  return { facetColor, colorFor }
}

// Resolve a collection colour: a literal "#RRGGBB" (user palettes) → RGBA, or a theme
// role key (architecture collection) → the theme's colour. Unknown/absent → muted.
export function resolveColor(theme: TuiThemeCurrent, color: string | undefined): TuiThemeCurrent["text"] {
  if (!color) return theme.textMuted
  if (color.startsWith("#")) return hexToRgba(color)
  return color in theme ? (theme[color as keyof TuiThemeCurrent] as TuiThemeCurrent["text"]) : theme.textMuted
}

// Resolve a theme role key (e.g. "info") to a theme colour — the architecture
// collection's hues and the agent palette use these.
export function themeColor(theme: TuiThemeCurrent, key: string): TuiThemeCurrent["text"] {
  return key in theme ? (theme[key as keyof TuiThemeCurrent] as TuiThemeCurrent["text"]) : theme.textMuted
}

export function hexToRgba(hex: string): TuiThemeCurrent["text"] {
  const h = hex.replace("#", "")
  return RGBA.fromInts(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16))
}
