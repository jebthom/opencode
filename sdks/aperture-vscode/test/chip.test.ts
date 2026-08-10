import { describe, expect, test } from "bun:test"
import {
  CHIP_CELLS,
  chipSegments,
  chipSvg,
  hexFor,
  MIN_SEGMENT_FRAC,
  THEME_ROLE_HEX,
  type LegendEntry,
} from "../src/chip"

// The chip is the whole reason the tree exists: a FileDecoration could say *which* facet
// and *how much*, but not the mix. These tests pin the two things the mix depends on —
// that the cells always fill the frame, and that the biggest facet is never the one that
// rounds away.

const LEGEND: LegendEntry[] = [
  { facet: "parsing", label: "Parsing", color: "#4E79A7" },
  { facet: "server", label: "Server", color: "#F28E2B" },
  { facet: "tui", label: "TUI", color: "#59A14F" },
]
const FACETS = ["parsing", "server", "tui", "none"]

const bar = (weights: Array<{ f: number; p: number }>, extra = {}) =>
  chipSegments(weights, FACETS, LEGEND, { layout: "bar6", theme: "dark", ...extra })

describe("chipSegments — quantized", () => {
  test("an un-mixed file is six cells of one colour", () => {
    const segments = bar([{ f: 0, p: 100 }])
    expect(segments).toHaveLength(CHIP_CELLS)
    expect(new Set(segments.map((s) => s.color))).toEqual(new Set(["#4E79A7"]))
  })

  test("cells always fill the frame exactly, whatever the mix", () => {
    const mixes = [
      [{ f: 0, p: 100 }],
      [
        { f: 0, p: 60 },
        { f: 1, p: 40 },
      ],
      [
        { f: 0, p: 34 },
        { f: 1, p: 33 },
        { f: 2, p: 33 },
      ],
      [
        { f: 0, p: 70 },
        { f: 1, p: 20 },
        { f: 2, p: 10 },
      ],
      [
        { f: 0, p: 26 },
        { f: 1, p: 25 },
        { f: 2, p: 25 },
        { f: 3, p: 24 },
      ],
    ]
    for (const mix of mixes) {
      const segments = bar(mix)
      expect(segments).toHaveLength(CHIP_CELLS)
      expect(segments.reduce((sum, s) => sum + s.frac, 0)).toBeCloseTo(1, 10)
    }
  })

  test("the dominant facet always survives quantization", () => {
    // Six facets at ~17% each is the worst case for a six-cell bar: every exact share
    // floors to zero and the whole allocation falls to the remainders.
    const even = [16, 17, 17, 17, 17, 16].map((p, f) => ({ f, p }))
    const facets = ["a", "b", "c", "d", "e", "f"]
    const legend = facets.map((facet, i) => ({ facet, label: facet, color: `#00000${i}` }))
    const segments = chipSegments(even, facets, legend, { layout: "bar6", theme: "dark" })
    expect(segments).toHaveLength(CHIP_CELLS)
    expect(new Set(segments.map((s) => s.color)).size).toBe(6)
  })

  test("a sliver quantizes away without emptying the file", () => {
    const segments = bar([
      { f: 0, p: 96 },
      { f: 1, p: 4 },
    ])
    expect(segments).toHaveLength(CHIP_CELLS)
    // 4% of six cells is 0.24 — below the 0.76 remainder of the dominant, so it loses.
    expect(new Set(segments.map((s) => s.color))).toEqual(new Set(["#4E79A7"]))
  })

  test("an unpainted node gets no segments at all, not an empty bar", () => {
    expect(bar([])).toEqual([])
    expect(bar([{ f: 0, p: 0 }])).toEqual([])
  })

  test("a facet outside the legend greys rather than vanishing", () => {
    // index 3 is NONE_FACET, which is a real stored value but never a legend entry.
    const segments = bar([{ f: 3, p: 100 }])
    expect(segments[0]!.color).toBe(THEME_ROLE_HEX["textMuted"]!.dark)
  })
})

describe("chipSegments — suppression (PLAN O4)", () => {
  test("a suppressed facet greys in place, keeping its area", () => {
    const mix = [
      { f: 0, p: 50 },
      { f: 1, p: 50 },
    ]
    const before = bar(mix)
    const after = bar(mix, { suppressed: new Set(["parsing"]) })
    expect(after).toHaveLength(before.length)
    // Same three cells as before, now grey; the other three are untouched.
    expect(after.filter((s) => s.color === THEME_ROLE_HEX["textMuted"]!.dark)).toHaveLength(3)
    expect(after.filter((s) => s.color === "#F28E2B")).toHaveLength(3)
  })

  test("suppressing everything still renders a full grey bar", () => {
    const segments = bar([{ f: 0, p: 100 }], { suppressed: new Set(["parsing", "server", "tui"]) })
    expect(segments).toHaveLength(CHIP_CELLS)
  })
})

describe("chipSegments — proportional", () => {
  const prop = (weights: Array<{ f: number; p: number }>) =>
    chipSegments(weights, FACETS, LEGEND, { layout: "bar-proportional", theme: "dark" })

  test("segment widths are the real shares and still fill the bar", () => {
    const segments = prop([
      { f: 0, p: 70 },
      { f: 1, p: 30 },
    ])
    expect(segments.map((s) => s.frac)).toEqual([0.7, 0.3])
    expect(segments.reduce((sum, s) => sum + s.frac, 0)).toBeCloseTo(1, 10)
  })

  test("a sliver is floored to a visible width, taken back from the rest", () => {
    const segments = prop([
      { f: 0, p: 99 },
      { f: 1, p: 1 },
    ])
    // 1% of the bar is a fraction of a pixel — invisible without the floor.
    expect(segments[1]!.frac).toBeCloseTo(MIN_SEGMENT_FRAC, 6)
    expect(segments.reduce((sum, s) => sum + s.frac, 0)).toBeCloseTo(1, 10)
  })
})

describe("hexFor", () => {
  test("a palette hex passes through untouched — it IS the identity matched to the TUI", () => {
    expect(hexFor("#4E79A7", "dark")).toBe("#4E79A7")
  })

  test("a theme-role token resolves per theme", () => {
    expect(hexFor("info", "light")).toBe("#1A85FF")
    expect(hexFor("info", "dark")).toBe("#3794FF")
  })

  test("an unknown token falls back to the muted grey rather than to nothing", () => {
    expect(hexFor("no-such-role", "dark")).toBe(THEME_ROLE_HEX["textMuted"]!.dark)
    expect(hexFor(undefined, "dark")).toBe(THEME_ROLE_HEX["textMuted"]!.dark)
  })
})

describe("chipSvg", () => {
  test("renders a 16x16 document — the box VSCode gives a tree icon", () => {
    const svg = chipSvg(bar([{ f: 0, p: 100 }]), "bar6", "dark")
    expect(svg).toStartWith('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">')
    expect(svg).toEndWith("</svg>")
  })

  test("every segment's colour reaches the output", () => {
    const svg = chipSvg(
      bar([
        { f: 0, p: 50 },
        { f: 1, p: 50 },
      ]),
      "bar6",
      "dark",
    )
    expect(svg).toContain("#4E79A7")
    expect(svg).toContain("#F28E2B")
  })

  test("mosaic renders one cell per cell, inside the same clipped frame as the bar", () => {
    const svg = chipSvg(bar([{ f: 0, p: 100 }]), "mosaic6", "dark")
    const cells = svg.slice(svg.indexOf("<g "), svg.indexOf("</g>"))
    expect(cells.match(/<rect /g)).toHaveLength(CHIP_CELLS)
    expect(svg).toContain('clip-path="url(#c)"')
  })

  test("mosaic fills column-major, so a facet stays contiguous instead of wrapping a row", () => {
    // 4/1/1 over three columns of two: the dominant facet should be the two whole left
    // columns. Row-major would give it the top row plus one bottom-left cell — an L.
    const svg = chipSvg(
      bar([
        { f: 0, p: 67 },
        { f: 1, p: 17 },
        { f: 2, p: 16 },
      ]),
      "mosaic6",
      "dark",
    )
    // Coordinates are emitted rounded to 3dp, so compare on that.
    const column = Math.round((16 / 3) * 1000) / 1000
    const xs = [...svg.matchAll(/<rect x="([\d.]+)"[^>]*fill="#4E79A7"/g)].map((m) => Number(m[1]))
    expect(xs).toEqual([0, 0, column, column])
  })

  test("the grid ignores a cell-count override, which would leave its last row short", () => {
    const segments = chipSegments([{ f: 0, p: 100 }], FACETS, LEGEND, {
      layout: "mosaic6",
      theme: "dark",
      cells: 4,
    })
    expect(segments).toHaveLength(CHIP_CELLS)
  })
})
