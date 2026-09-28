import { describe, expect, test } from "bun:test"
import { buildModel, type FacetFiles } from "../src/model"

// The tree's model: a path trie over the workspace's files, and a rollup of marked lines per
// facet up every folder — so a folder's chip is sized by how much of each concern lives below it.

const mark = (f: number, l: number) => ({ f, l, b: l * 10 })

const PATHS = ["src/aperture/chip.ts", "src/aperture/model.ts", "src/server/http.ts", "README.md"]

const FILES: FacetFiles = {
  "src/aperture/chip.ts": { m: [mark(0, 20)], line: 1 },
  "src/aperture/model.ts": { m: [mark(1, 10)], line: 4 },
  "src/server/http.ts": { m: [mark(1, 4)], line: 2 },
}
const FACET_COUNT = 3

describe("buildModel — structure", () => {
  const model = buildModel(PATHS, FILES, FACET_COUNT)

  test("directories are derived from path segments", () => {
    expect(model.children("").map((e) => e.name)).toEqual(["src", "README.md"])
    expect(model.children("src").map((e) => e.name)).toEqual(["aperture", "server"])
    expect(model.children("src/aperture").map((e) => e.rel)).toEqual(["src/aperture/chip.ts", "src/aperture/model.ts"])
  })

  test("folders sort before files, then alphabetically case-insensitively", () => {
    const model = buildModel(["b.ts", "A.ts", "zdir/x.ts", "Adir/y.ts"], {}, FACET_COUNT)
    expect(model.children("").map((e) => e.name)).toEqual(["Adir", "zdir", "A.ts", "b.ts"])
  })

  test("a repeated directory prefix is created once", () => {
    expect(model.children("src").filter((e) => e.name === "aperture")).toHaveLength(1)
  })

  test("an unmarked file is still in the tree — it just has no chip", () => {
    expect(model.has("README.md")).toBe(true)
    expect(model.weights("README.md", false)).toBeUndefined()
  })

  test("a path with an empty segment is dropped, not turned into a self-child root", () => {
    const model = buildModel(["/abs/x.ts", "a//b.ts", "ok.ts", ""], {}, FACET_COUNT)
    expect(model.children("").map((e) => e.rel)).toEqual(["ok.ts"])
  })

  test("isDir is tracked, not inferred from having children", () => {
    expect(model.isDir("src/aperture")).toBe(true)
    expect(model.isDir("README.md")).toBe(false)
    expect(buildModel([], {}, 0).isDir("")).toBe(true)
  })

  test("a newly created empty directory appears, and knows it is one", () => {
    const model = buildModel(PATHS, FILES, FACET_COUNT, ["src/aperture/fixtures"])
    expect(model.children("src/aperture").map((e) => e.name)).toEqual(["fixtures", "chip.ts", "model.ts"])
    expect(model.isDir("src/aperture/fixtures")).toBe(true)
    expect(model.children("src/aperture/fixtures")).toEqual([])
  })

  test("an extra dir that already exists as a real one is not duplicated", () => {
    const model = buildModel(PATHS, FILES, FACET_COUNT, ["src/server"])
    expect(model.children("src").filter((e) => e.name === "server")).toHaveLength(1)
    expect(model.children("src/server").map((e) => e.name)).toEqual(["http.ts"])
  })
})

describe("buildModel — marked-line rollup", () => {
  const model = buildModel(PATHS, FILES, FACET_COUNT)

  test("a folder's mix is weighted by marked lines", () => {
    // src/aperture: 20 lines of facet 0, 10 of facet 1.
    expect(model.weights("src/aperture", true)).toEqual([
      { f: 0, p: 67 },
      { f: 1, p: 33 },
    ])
  })

  test("the rollup reaches every ancestor, including the root", () => {
    // 20 lines facet 0, 14 lines facet 1 across the whole tree.
    expect(model.weights("", true)).toEqual([
      { f: 0, p: 59 },
      { f: 1, p: 41 },
    ])
    expect(model.weights("src", true)).toEqual(model.weights("", true))
  })

  test("a directory with nothing marked below it gets no chip", () => {
    const model = buildModel(["docs/notes.md"], {}, FACET_COUNT)
    expect(model.weights("docs", true)).toBeUndefined()
  })

  test("a file marked with several facets contributes to each", () => {
    const model = buildModel(["a/one.ts"], { "a/one.ts": { m: [mark(0, 6), mark(1, 4)], line: 1 } }, FACET_COUNT)
    expect(model.weights("a/one.ts", false)).toEqual([
      { f: 0, p: 60 },
      { f: 1, p: 40 },
    ])
    expect(model.weights("a", true)).toEqual(model.weights("a/one.ts", false))
  })

  test("a single marked line deep in the tree keeps a cell at every level, however small", () => {
    const model = buildModel(
      ["src/deep/big.ts", "src/other.ts"],
      { "src/deep/big.ts": { m: [mark(1, 1)], line: 9 }, "src/other.ts": { m: [mark(0, 5000)], line: 1 } },
      FACET_COUNT,
    )
    // 1 line against 5000 rounds to 0% — floored to 1% rather than dropped, which is what lets
    // `apportion` give it a slot.
    for (const dir of ["", "src"]) expect(model.weights(dir, true)).toContainEqual({ f: 1, p: 1 })
    expect(model.weights("src/deep", true)).toEqual([{ f: 1, p: 100 }])
  })

  test("a marked file VSCode is hiding does not inflate its ancestors", () => {
    const files: FacetFiles = { ...FILES, "node_modules/pkg/index.js": { m: [mark(2, 999)], line: 1 } }
    const model = buildModel(PATHS, files, FACET_COUNT)
    expect(model.weights("", true)!.some((w) => w.f === 2)).toBe(false)
  })

  test("a facet index beyond the vocabulary is ignored rather than thrown on", () => {
    // A facet map fetched under one Lens can race a legend from the next one.
    const model = buildModel(["a/one.ts"], { "a/one.ts": { m: [mark(99, 3)], line: 1 } }, FACET_COUNT)
    expect(model.weights("a", true)).toBeUndefined()
  })

  test("marked lines roll up as exact counts, for the tooltip the chip cannot carry", () => {
    expect(model.marks("src", true)).toEqual([
      { f: 0, l: 20 },
      { f: 1, l: 14 },
    ])
    expect(model.marks("src/server/http.ts", false)).toEqual([{ f: 1, l: 4 }])
    expect(model.marks("README.md", false)).toBeUndefined()
  })
})
