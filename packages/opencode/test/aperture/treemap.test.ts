import { describe, it, expect } from "bun:test"
import { allocateCells, buildGrid, coalesce } from "@/aperture/treemap"

describe("ApertureTreemap.allocateCells", () => {
  it("splits cells proportionally and sums to exactly the budget", () => {
    const alloc = allocateCells(
      [
        { key: "a", value: 75 },
        { key: "b", value: 25 },
      ],
      100,
    )
    expect(alloc).toEqual([
      { key: "a", n: 75 },
      { key: "b", n: 25 },
    ])
    expect(alloc.reduce((s, a) => s + a.n, 0)).toBe(100)
  })

  it("uses largest-remainder rounding so the parts still sum to the budget", () => {
    // 3 equal layers over 10 cells: ideal 3.33 each → floors 3,3,3 (=9), one
    // leftover handed to the first by remainder order. Total stays 10.
    const alloc = allocateCells(
      [
        { key: "a", value: 1 },
        { key: "b", value: 1 },
        { key: "c", value: 1 },
      ],
      10,
    )
    expect(alloc.reduce((s, a) => s + a.n, 0)).toBe(10)
    expect(alloc.map((a) => a.n).toSorted()).toEqual([3, 3, 4])
  })

  it("never drops a present layer to zero when there is room", () => {
    // A dominant layer would otherwise floor the tiny one out; the steal guarantees
    // the small slice keeps a cell, and the total is preserved.
    const alloc = allocateCells(
      [
        { key: "big", value: 999 },
        { key: "tiny", value: 1 },
      ],
      8,
    )
    expect(alloc.find((a) => a.key === "tiny")!.n).toBeGreaterThanOrEqual(1)
    expect(alloc.reduce((s, a) => s + a.n, 0)).toBe(8)
  })

  it("preserves input order so color bands are stable", () => {
    const alloc = allocateCells(
      [
        { key: "x", value: 10 },
        { key: "y", value: 20 },
        { key: "z", value: 30 },
      ],
      12,
    )
    expect(alloc.map((a) => a.key)).toEqual(["x", "y", "z"])
  })

  it("returns nothing for an empty or zero-weight composition", () => {
    expect(allocateCells([], 10)).toEqual([])
    expect(allocateCells([{ key: "a", value: 0 }], 10)).toEqual([])
    expect(allocateCells([{ key: "a", value: 5 }], 0)).toEqual([])
  })
})

describe("ApertureTreemap.buildGrid", () => {
  it("bottom-aligns: the footing row is full, the partial cells land on top", () => {
    // 5 cells, 3 rows → 2 cols. The left column fills bottom-up (3), the right one takes
    // the remainder (2) from the bottom, so the single null is the top-right.
    const grid = buildGrid(["a", "a", "a", "a", "a"], 3)
    expect(grid).toEqual([
      ["a", null],
      ["a", "a"],
      ["a", "a"],
    ])
  })

  it("fills column-major, so a band of `rows` cells is one whole column", () => {
    // 6 cells, 3 rows → 2 cols: "a" takes the left column entire, "b" the right one.
    // Row-major would have striped both bands across all three rows.
    const grid = buildGrid(["a", "a", "a", "b", "b", "b"], 3)
    expect(grid).toEqual([
      ["a", "b"],
      ["a", "b"],
      ["a", "b"],
    ])
  })

  it("starts the first band at the bottom left, as the tree chip's mosaic does", () => {
    const grid = buildGrid(["a", "b", "c", "d"], 2)
    expect(grid).toEqual([
      ["b", "d"],
      ["a", "c"],
    ])
  })

  it("keeps every row the same width (rectangular block)", () => {
    const grid = buildGrid(["a", "b", "c", "d", "e", "f", "g"], 3)
    const widths = new Set(grid.map((r) => r.length))
    expect(widths.size).toBe(1)
  })

  it("returns no rows for an empty cell list", () => {
    expect(buildGrid([], 3)).toEqual([])
  })
})

describe("ApertureTreemap.coalesce", () => {
  it("collapses contiguous same-value runs, including null padding", () => {
    expect(coalesce(["a", "a", "b", null, null])).toEqual([
      { value: "a", len: 2 },
      { value: "b", len: 1 },
      { value: null, len: 2 },
    ])
  })
})
