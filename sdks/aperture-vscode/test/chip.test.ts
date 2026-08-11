import { describe, expect, test } from "bun:test"
import {
  CHIP_CELLS,
  chipSegments,
  chipSvg,
  hexFor,
  MIN_SEGMENT_FRAC,
  MOSAIC_CELL_COUNT,
  type LegendEntry,
} from "../src/chip"

// The chip is the whole reason the tree exists: a FileDecoration could say *which* facet
// and *how much*, but not the mix. These tests pin the three things the mix depends on —
// that the cells always fill the frame, that the biggest facet is never the one that rounds
// away, and that no facet present is ever apportioned to nothing.

const LEGEND: LegendEntry[] = [
  { facet: "parsing", label: "Parsing", color: "#4E79A7" },
  { facet: "server", label: "Server", color: "#F28E2B" },
  { facet: "tui", label: "TUI", color: "#59A14F" },
]
const FACETS = ["parsing", "server", "tui", "none"]

const bar = (weights: Array<{ f: number; p: number }>, extra = {}) =>
  chipSegments(weights, FACETS, LEGEND, { layout: "bar6", ...extra })
const mosaic = (weights: Array<{ f: number; p: number }>, extra = {}) =>
  chipSegments(weights, FACETS, LEGEND, { layout: "mosaic6", ...extra })

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
    const segments = chipSegments(even, facets, legend, { layout: "bar6" })
    expect(segments).toHaveLength(CHIP_CELLS)
    expect(new Set(segments.map((s) => s.color)).size).toBe(6)
  })

  test("a sliver keeps a cell rather than rounding away", () => {
    const segments = bar([
      { f: 0, p: 96 },
      { f: 1, p: 4 },
    ])
    expect(segments).toHaveLength(CHIP_CELLS)
    // 4% of six cells is 0.24, so largest-remainder gave this cell to the dominant and the
    // file read as pure. Existence outranks proportion here: one cell overstates 4% as 17%,
    // which is the trade the chip is for.
    expect(segments.map((s) => s.color)).toEqual(["#4E79A7", "#4E79A7", "#4E79A7", "#4E79A7", "#4E79A7", "#F28E2B"])
  })

  test("no facet present is ever apportioned to nothing, however small", () => {
    for (const p of [4, 1, 0.4, 0.01]) {
      const segments = bar([
        { f: 0, p: 100 - p },
        { f: 1, p },
      ])
      expect(segments).toHaveLength(CHIP_CELLS)
      expect(segments.filter((s) => s.color === "#F28E2B")).toHaveLength(1)
    }
  })

  test("the row widens past six rather than dropping a seventh band", () => {
    // A six-facet Lens plus NONE_FACET is seven bands — one more than the six cells the
    // layout was named for, so a fixed six could not give them one each.
    const facets = ["a", "b", "c", "d", "e", "f", "none"]
    const legend = facets.map((facet, i) => ({ facet, label: facet, color: `#00000${i}` }))
    const weights = facets.map((_, f) => ({ f, p: f === 0 ? 94 : 1 }))
    const segments = chipSegments(weights, facets, legend, { layout: "bar6" })
    expect(segments).toHaveLength(7)
    expect(new Set(segments.map((s) => s.color)).size).toBe(7)
    expect(segments.reduce((sum, s) => sum + s.frac, 0)).toBeCloseTo(1, 10)
  })

  test("an unpainted node gets no segments at all, not an empty bar", () => {
    expect(bar([])).toEqual([])
    expect(bar([{ f: 0, p: 0 }])).toEqual([])
  })

  test("a facet outside the legend greys rather than vanishing", () => {
    // index 3 is NONE_FACET, which is a real stored value but never a legend entry.
    const segments = bar([{ f: 3, p: 100 }])
    expect(segments[0]!.color).toBe("#8A8A8A")
  })
})

describe("chipSegments — ordering", () => {
  test("segments run in Lens facet order, not in the descending-share order they arrive in", () => {
    // The wire order is by share (tui 60 before parsing 40); the chip lays parsing first
    // because it comes first in the Lens, so two files with these facets read alike.
    const segments = bar([
      { f: 2, p: 60 },
      { f: 0, p: 40 },
    ])
    expect(segments.map((s) => s.color)).toEqual(["#4E79A7", "#4E79A7", "#59A14F", "#59A14F", "#59A14F", "#59A14F"])
  })

  test("the off-legend facet lands at the far end, where the TUI puts its untagged grey", () => {
    // f 3 is NONE_FACET — appended after the Lens's own facets, so it sorts last.
    const segments = bar([
      { f: 3, p: 50 },
      { f: 0, p: 50 },
    ])
    expect(segments.slice(0, 3).map((s) => s.color)).toEqual(["#4E79A7", "#4E79A7", "#4E79A7"])
    expect(new Set(segments.slice(3).map((s) => s.color))).toEqual(new Set(["#8A8A8A"]))
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
    expect(after.filter((s) => s.color === "#8A8A8A")).toHaveLength(3)
    expect(after.filter((s) => s.color === "#F28E2B")).toHaveLength(3)
  })

  test("suppressing everything still renders a full grey bar", () => {
    const segments = bar([{ f: 0, p: 100 }], { suppressed: new Set(["parsing", "server", "tui"]) })
    expect(segments).toHaveLength(CHIP_CELLS)
  })

  // The extension no longer threads `suppressed` through each paint site: it derives one
  // legend whose suppressed entries already carry the muted hue, and every surface — chip,
  // pip, gutter — reads colour from that. These pin the two paths as interchangeable, so the
  // derivation can't quietly diverge from what the chip's own suppression does.
  test("a legend pre-greyed by the filter paints the same as the suppressed set", () => {
    const mix = [
      { f: 0, p: 50 },
      { f: 1, p: 50 },
    ]
    const greyed: LegendEntry[] = LEGEND.map((e) => (e.facet === "parsing" ? { ...e, color: "#8A8A8A" } : e))
    const viaSet = bar(mix, { suppressed: new Set(["parsing"]) })
    const viaLegend = chipSegments(mix, FACETS, greyed, { layout: "bar6" })
    expect(viaLegend).toEqual(viaSet)
  })

  test("the two paths agree when they overlap, so applying both is not double-greying", () => {
    const mix = [
      { f: 0, p: 34 },
      { f: 1, p: 33 },
      { f: 2, p: 33 },
    ]
    const greyed: LegendEntry[] = LEGEND.map((e) => (e.facet === "tui" ? { ...e, color: "#8A8A8A" } : e))
    const both = chipSegments(mix, FACETS, greyed, { layout: "bar6", suppressed: new Set(["tui"]) })
    expect(both).toEqual(bar(mix, { suppressed: new Set(["tui"]) }))
  })
})

describe("chipSegments — proportional", () => {
  const prop = (weights: Array<{ f: number; p: number }>) =>
    chipSegments(weights, FACETS, LEGEND, { layout: "bar-proportional" })

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
    expect(hexFor("#D7005F")).toBe("#D7005F")
  })

  // Since PLAN C1 the server sends a literal hex for every facet colour, including the two
  // greys and the Architecture Lens's layers. A token arriving here means version skew with
  // an older server, and the muted grey is a better answer than an invented colour.
  test("a non-hex hue falls back to the muted grey rather than to nothing", () => {
    expect(hexFor("info")).toBe("#8A8A8A")
    expect(hexFor(undefined)).toBe("#8A8A8A")
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
    const svg = chipSvg(mosaic([{ f: 0, p: 100 }]), "mosaic6", "dark")
    const cells = svg.slice(svg.indexOf("<g "), svg.indexOf("</g>"))
    expect(cells.match(/<rect /g)).toHaveLength(MOSAIC_CELL_COUNT)
    expect(svg).toContain('clip-path="url(#c)"')
  })

  test("mosaic fills column-major, so a facet stays contiguous instead of wrapping a row", () => {
    // 4/2/2 over the eight slots: the dominant facet should be the two whole left columns,
    // and the two minor facets a half-column each of the split third. Row-major would give
    // the dominant the top row plus one bottom-left cell — an L.
    const svg = chipSvg(
      mosaic([
        { f: 0, p: 67 },
        { f: 1, p: 17 },
        { f: 2, p: 16 },
      ]),
      "mosaic6",
      "dark",
    )
    // Coordinates are emitted rounded to 3dp, so compare on that.
    const at = (thirds: number) => Math.round((16 / 3) * thirds * 1000) / 1000
    const xsFor = (hex: string) =>
      [...svg.matchAll(new RegExp(`<rect x="([\\d.]+)"[^>]*fill="${hex}"`, "g"))].map((m) => Number(m[1]))
    expect(xsFor("#4E79A7")).toEqual([at(0), at(0), at(1), at(1)])
    expect(xsFor("#F28E2B")).toEqual([at(2), at(2)])
    expect(xsFor("#59A14F")).toEqual([at(2.5), at(2.5)])
  })

  test("mosaic fills bottom-up, so the first facet starts in the bottom-left cell", () => {
    // 1/7 over the eight slots: parsing's single cell is the first one placed, and the fill
    // starts at the bottom of the left column — the TUI treemap's direction.
    const svg = chipSvg(
      mosaic([
        { f: 0, p: 17 },
        { f: 1, p: 83 },
      ]),
      "mosaic6",
      "dark",
    )
    // BAR_Y is 1 and a cell is BAR_H/2 = 7 tall, so the bottom row starts at y=8.
    expect(svg).toContain('<rect x="0" y="8"')
    expect(svg).toMatch(/<rect x="0" y="8"[^>]*fill="#4E79A7"/)
  })

  test("the grid ignores a cell-count override, which would leave its last row short", () => {
    const segments = chipSegments([{ f: 0, p: 100 }], FACETS, LEGEND, { layout: "mosaic6", cells: 4 })
    expect(segments).toHaveLength(MOSAIC_CELL_COUNT)
  })
})

describe("chipSegments — mosaic", () => {
  test("the split third costs a minor facet a sliver, not a sixth of the chip", () => {
    // Every cell is a Segment whose frac is its true share of the bar: four whole cells at a
    // sixth and four narrow ones at a twelfth.
    const segments = mosaic([{ f: 0, p: 100 }])
    expect(segments).toHaveLength(MOSAIC_CELL_COUNT)
    expect(segments.map((s) => s.frac)).toEqual([1 / 6, 1 / 6, 1 / 6, 1 / 6, 1 / 12, 1 / 12, 1 / 12, 1 / 12])
    expect(segments.reduce((sum, s) => sum + s.frac, 0)).toBeCloseTo(1, 10)
  })

  test("slots are apportioned by area, so an even mix draws even", () => {
    // The trap the split third sets: four slots each is 67/33 by area, not 50/50. Splitting
    // by area instead of by slot count puts the boundary after the second whole column.
    const segments = mosaic([
      { f: 0, p: 50 },
      { f: 1, p: 50 },
    ])
    const share = (hex: string) => segments.filter((s) => s.color === hex).reduce((sum, s) => sum + s.frac, 0)
    expect(share("#4E79A7")).toBeCloseTo(0.5, 10)
    expect(share("#F28E2B")).toBeCloseTo(0.5, 10)
  })

  test("all seven bands of a full Lens fit, which six cells could not do", () => {
    const facets = ["a", "b", "c", "d", "e", "f", "none"]
    const legend = facets.map((facet, i) => ({ facet, label: facet, color: `#00000${i}` }))
    const weights = facets.map((_, f) => ({ f, p: f === 0 ? 94 : 1 }))
    const segments = chipSegments(weights, facets, legend, { layout: "mosaic6" })
    expect(segments).toHaveLength(MOSAIC_CELL_COUNT)
    expect(new Set(segments.map((s) => s.color)).size).toBe(7)
  })

  test("a sliver survives in the mosaic too, not only in the proportional bar", () => {
    const segments = mosaic([
      { f: 0, p: 99.6 },
      { f: 1, p: 0.4 },
    ])
    expect(segments.filter((s) => s.color === "#F28E2B")).toHaveLength(1)
    // ...and it lands in the narrow third, so it costs the dominant a twelfth rather than a
    // sixth of the chip.
    expect(segments.at(-1)!.frac).toBeCloseTo(1 / 12, 10)
  })
})
