import { describe, expect, test } from "bun:test"
import { computeComposition, computeFacetMapFiles } from "@/aperture/aperture"
import { NONE_FACET, type Lens } from "@/aperture/lenses"

// The facet map is what paints the VSCode Explorer's per-file pips (O2). Its contract is
// agreement: a file's pip and the treemap band it contributes to its parent directory are
// two views of ONE attribution, so anything that makes them disagree is the class of bug
// O3's single-classification model exists to prevent.

const facet = (id: string, label: string, color: string) => ({ id, label, description: label, color })

const LENS: Lens = {
  id: "perf",
  name: "Terminal Performance Bottlenecks",
  description: "",
  prompt: "",
  facets: [facet("likely", "Likely", "#f00"), facet("hot", "Hot path", "#0f0"), facet("cold", "Cold", "#00f")],
  scope: "project",
}

// The vocabulary the emitted `f` indexes into, built the way the service builds it.
const FACETS = [...LENS.facets.map((t) => t.id), NONE_FACET]

const DIR = { id: "d_1", path: "src", kind: "directory" as const, size: 0, position: { layer: 0, index: 0 } }
const file = { id: "n_a", path: "src/a.ts", size: 100 }

describe("computeFacetMapFiles (Explorer pip weights)", () => {
  test("an un-mixed file is one weight at 100%", () => {
    const files = computeFacetMapFiles([file], { n_a: { facet: "likely", hash: "h" } }, {}, FACETS)
    expect(files["src/a.ts"]).toEqual([{ f: 0, p: 100 }])
  })

  test("a function-painted file reports its mix, descending, summing to 100", () => {
    // 100 bytes: a 60-byte "hot" function, the 40-byte remainder falling to the file facet.
    const mixes = {
      "src/a.ts": {
        weights: [{ facet: "hot", count: 1, bytes: 60 }],
        totalCount: 1,
        totalBytes: 60,
        subtreeCount: 2,
        subtreeBytes: 100,
      },
    }
    const weights = computeFacetMapFiles([file], { n_a: { facet: "likely", hash: "h" } }, mixes, FACETS)["src/a.ts"]!
    expect(weights).toEqual([
      { f: 1, p: 60 },
      { f: 0, p: 40 },
    ])
    expect(weights.reduce((sum, w) => sum + w.p, 0)).toBe(100)
  })

  test("the head weight is the facet the directory treemap counts the file toward", () => {
    // The pip's colour and the file's `count` band in its parent must name the same facet.
    const mixes = {
      "src/a.ts": {
        weights: [{ facet: "cold", count: 1, bytes: 90 }],
        totalCount: 1,
        totalBytes: 90,
        subtreeCount: 2,
        subtreeBytes: 100,
      },
    }
    const store = { n_a: { facet: "likely", hash: "h" } }
    const head = computeFacetMapFiles([file], store, mixes, FACETS)["src/a.ts"]![0]!
    const counted = computeComposition([DIR], [file], store, mixes, LENS)[DIR.id]!.weights.find((w) => w.count === 1)!
    expect(FACETS[head.f]).toBe(counted.facet)
  })

  test("an unpainted file is absent entirely, not present-and-empty", () => {
    expect(computeFacetMapFiles([file], {}, {}, FACETS)).toEqual({})
  })

  test('a file bucketed "Other" maps to the appended index', () => {
    const files = computeFacetMapFiles([file], { n_a: { facet: NONE_FACET, hash: "h" } }, {}, FACETS)
    expect(files["src/a.ts"]).toEqual([{ f: FACETS.length - 1, p: 100 }])
  })

  test("a sliver that rounds to 0% is dropped, never emptying the file", () => {
    // 1000 bytes: a 3-byte "hot" function (0.3%) and the rest on the file facet.
    const mixes = {
      "src/big.ts": {
        weights: [{ facet: "hot", count: 1, bytes: 3 }],
        totalCount: 1,
        totalBytes: 3,
        subtreeCount: 2,
        subtreeBytes: 1000,
      },
    }
    const big = { id: "n_b", path: "src/big.ts", size: 1000 }
    expect(computeFacetMapFiles([big], { n_b: { facet: "likely", hash: "h" } }, mixes, FACETS)["src/big.ts"]).toEqual([
      { f: 0, p: 100 },
    ])
  })

  test("a zero-byte file contributes nothing", () => {
    const empty = { id: "n_c", path: "src/empty.ts", size: 0 }
    expect(computeFacetMapFiles([empty], { n_c: { facet: "likely", hash: "h" } }, {}, FACETS)).toEqual({})
  })
})

// The TUI paints a file *tile* as a band of its own facet mix (O1's file grid), which it
// reads from the same `composition` map the directory treemaps come from. Same contract as
// above, one level down: the band, the pip and the parent's treemap are one attribution.
describe("computeComposition (per-file entries)", () => {
  const FILE_NODE = { id: "n_a", path: "src/a.ts", kind: "file" as const, size: 100, position: { layer: 0, index: 0 } }
  // 100 bytes: a 60-byte "hot" function, the 40-byte remainder falling to the file facet.
  const MIXES = {
    "src/a.ts": {
      weights: [{ facet: "hot", count: 1, bytes: 60 }],
      totalCount: 1,
      totalBytes: 60,
      subtreeCount: 2,
      subtreeBytes: 100,
    },
  }
  const STORE = { n_a: { facet: "likely", hash: "h" } }

  test("a file node gets its own mix as a subtree of one", () => {
    const comp = computeComposition([FILE_NODE], [file], STORE, MIXES, LENS)[FILE_NODE.id]!
    // Lens facet order (likely, hot, cold, none), not attributeFileBytes's facet-id order.
    expect(comp.weights.map((w) => w.facet)).toEqual(["likely", "hot"])
    expect(comp.weights.find((w) => w.facet === "hot")!.bytes).toBe(60)
    expect(comp.subtreeCount).toBe(1)
    expect(comp.subtreeBytes).toBe(100)
    // Counts "files", not functions: the file counts once, toward its dominant facet.
    expect(comp.totalCount).toBe(1)
    expect(comp.weights.filter((w) => w.count === 1)).toHaveLength(1)
  })

  test("the file's band and its Explorer pip name the same dominant facet", () => {
    const head = computeFacetMapFiles([file], STORE, MIXES, FACETS)["src/a.ts"]![0]!
    const comp = computeComposition([FILE_NODE], [file], STORE, MIXES, LENS)[FILE_NODE.id]!
    expect(FACETS[head.f]).toBe(comp.weights.find((w) => w.count === 1)!.facet)
  })

  test("an unpainted file still reports its size, so the band greys rather than vanishing", () => {
    const comp = computeComposition([FILE_NODE], [file], {}, {}, LENS)[FILE_NODE.id]!
    expect(comp.weights).toEqual([])
    expect(comp.totalBytes).toBe(0)
    // compositionBands derives the grey remainder from subtreeBytes − totalBytes.
    expect(comp.subtreeBytes).toBe(100)
  })

  test("file entries survive a window with no directories — the leaf case they exist for", () => {
    const result = computeComposition([FILE_NODE], [file], STORE, MIXES, LENS)
    expect(Object.keys(result)).toEqual([FILE_NODE.id])
  })
})
