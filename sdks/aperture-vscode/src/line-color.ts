// The colours a gutter line paints when several tags cover it. VSCode-free so it can be unit
// tested.
//
// A line carries one bar, split into horizontal bands when facets overlap, and one overview-ruler
// mark. Three rules:
//   - an active facet always beats the muted hue, so a filtered-out (or "Other") tag can never
//     hide a facet the user is looking at;
//   - several distinct active facets each get a band in their exact hex, ordered by the legend so
//     a run of overlapping lines stripes regularly instead of flipping band order line to line;
//   - the ruler can only take one colour per mark, so there the bands blend into their average.

// NONE_HUE from the server's lenses.ts: what a suppressed facet paints, and "Other"'s own hue.
// Duplicated as a literal for the same reason as in chip.ts.
export const MUTED_HEX = "#8A8A8A"

// More than three facets on one line almost never happens, and a fourth band is too thin to read.
export const MAX_BANDS = 3

// `order` is the legend's colours, top first; a hex it doesn't carry sorts after it, by value.
export function lineBands(hexes: Iterable<string>, order: readonly string[] = []): string[] {
  const distinct = [...new Set([...hexes].map((h) => h.toUpperCase()))]
  const active = distinct.filter((h) => h !== MUTED_HEX)
  if (active.length === 0) return distinct.slice(0, 1)
  const ranked = order.map((h) => h.toUpperCase())
  const rank = (h: string) => (ranked.includes(h) ? ranked.indexOf(h) : ranked.length)
  return active.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, MAX_BANDS)
}

export function blend(hexes: readonly string[]): string {
  const rgbs = hexes.map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)))
  return (
    "#" +
    [0, 1, 2]
      .map((c) =>
        Math.round(rgbs.reduce((sum, rgb) => sum + rgb[c], 0) / rgbs.length)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
      .toUpperCase()
  )
}
