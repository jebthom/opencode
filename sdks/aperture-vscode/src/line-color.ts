// The one colour a gutter line paints when several tags cover it. VSCode-free so it can be unit
// tested.
//
// A line carries one bar and one overview-ruler mark, so overlapping tags have to resolve to a
// single hex. Two rules:
//   - an active facet always beats the muted hue, so a filtered-out (or "Other") tag can never
//     hide a facet the user is looking at;
//   - several distinct active facets blend into their average, so an overlap reads as a colour
//     no single facet has — a cue to filter down and see which concerns meet there. A line with
//     one facet still paints that facet's exact hex.

// NONE_HUE from the server's lenses.ts: what a suppressed facet paints, and "Other"'s own hue.
// Duplicated as a literal for the same reason as in chip.ts.
export const MUTED_HEX = "#8A8A8A"

export function lineColor(hexes: Iterable<string>): string | undefined {
  const distinct = [...new Set([...hexes].map((h) => h.toUpperCase()))]
  const active = distinct.filter((h) => h !== MUTED_HEX)
  if (active.length === 0) return distinct[0]
  if (active.length === 1) return active[0]
  const rgbs = active.map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)))
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
