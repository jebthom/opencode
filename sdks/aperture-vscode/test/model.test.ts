import { describe, expect, test } from "bun:test"
import { buildModel, type FacetFiles } from "../src/model"

// The tree's contract with the server: a folder's chip is the byte-weighted rollup of its
// subtree, so it names the same dominant facet the TUI's directory treemap does over the
// same folder. That is what `t` is on the wire for — see the matching assertion in
// packages/opencode/test/aperture/facet-map.test.ts.

const PATHS = ["src/aperture/chip.ts", "src/aperture/model.ts", "src/server/http.ts", "README.md"]

const FILES: FacetFiles = {
  "src/aperture/chip.ts": { t: 1000, w: [{ f: 0, p: 100 }] },
  "src/aperture/model.ts": { t: 500, w: [{ f: 1, p: 100 }] },
  "src/server/http.ts": { t: 200, w: [{ f: 1, p: 100 }] },
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

  test("an unpainted file is still in the tree — it just has no chip", () => {
    expect(model.has("README.md")).toBe(true)
    expect(model.weights("README.md", false)).toBeUndefined()
  })

  test("a path with an empty segment is dropped, not turned into a self-child root", () => {
    // An empty segment is the root, so `child("", {rel: "", …})` would make the root its own
    // child and getChildren would descend forever. A URI outside the workspace folder is how
    // asRelativePath could hand us one.
    const model = buildModel(["/abs/x.ts", "a//b.ts", "ok.ts", ""], {}, FACET_COUNT)
    expect(model.children("").map((e) => e.rel)).toEqual(["ok.ts"])
  })

  test("isDir is tracked, not inferred from having children", () => {
    expect(model.isDir("src/aperture")).toBe(true)
    expect(model.isDir("README.md")).toBe(false)
    // The root is always a directory even before anything has been enumerated.
    expect(buildModel([], {}, 0).isDir("")).toBe(true)
  })

  test("a newly created empty directory appears, and knows it is one", () => {
    // Directories are derived from file paths, so a folder with nothing in it can only get
    // into the tree by being named — otherwise "New Folder" creates something invisible.
    const model = buildModel(PATHS, FILES, FACET_COUNT, ["src/aperture/fixtures"])
    expect(model.children("src/aperture").map((e) => e.name)).toEqual(["fixtures", "chip.ts", "model.ts"])
    expect(model.isDir("src/aperture/fixtures")).toBe(true)
    expect(model.children("src/aperture/fixtures")).toEqual([])
  })

  test("an extra dir that already exists as a real one is not duplicated", () => {
    const model = buildModel(PATHS, FILES, FACET_COUNT, ["src/server"])
    expect(model.children("src").filter((e) => e.name === "server")).toHaveLength(1)
    // ...and it keeps the file it actually contains.
    expect(model.children("src/server").map((e) => e.name)).toEqual(["http.ts"])
  })
})

describe("buildModel — byte rollup", () => {
  const model = buildModel(PATHS, FILES, FACET_COUNT)

  test("a folder's mix is byte-weighted, not file-count-weighted", () => {
    // src/aperture holds one 1000-byte facet-0 file and one 500-byte facet-1 file.
    // Byte-weighted that is 67/33 toward facet 0; counted by files it would be a 50/50 tie.
    expect(model.weights("src/aperture", true)).toEqual([
      { f: 0, p: 67 },
      { f: 1, p: 33 },
    ])
  })

  test("the rollup reaches every ancestor, including the root", () => {
    // 1000 bytes facet 0, 700 bytes facet 1 across the whole tree.
    expect(model.weights("", true)).toEqual([
      { f: 0, p: 59 },
      { f: 1, p: 41 },
    ])
    expect(model.weights("src", true)).toEqual([
      { f: 0, p: 59 },
      { f: 1, p: 41 },
    ])
  })

  test("a leaf directory reports its one file's mix", () => {
    expect(model.weights("src/server", true)).toEqual([{ f: 1, p: 100 }])
  })

  test("a directory with nothing painted below it gets no chip", () => {
    const model = buildModel(["docs/notes.md"], {}, FACET_COUNT)
    expect(model.weights("docs", true)).toBeUndefined()
  })

  test("a mixed file contributes to each of its facets separately", () => {
    const model = buildModel(
      ["a/one.ts"],
      {
        "a/one.ts": {
          t: 100,
          w: [
            { f: 0, p: 60 },
            { f: 1, p: 40 },
          ],
        },
      },
      FACET_COUNT,
    )
    expect(model.weights("a", true)).toEqual([
      { f: 0, p: 60 },
      { f: 1, p: 40 },
    ])
  })

  test("a painted file VSCode is hiding does not inflate its ancestors", () => {
    // node_modules is in files.exclude, so findFiles never returned it — but the server,
    // which walks the repo itself, may still have painted something under it.
    const files: FacetFiles = { ...FILES, "node_modules/pkg/index.js": { t: 999999, w: [{ f: 2, p: 100 }] } }
    const model = buildModel(PATHS, files, FACET_COUNT)
    expect(model.weights("", true)!.some((w) => w.f === 2)).toBe(false)
  })

  test("a facet index beyond the vocabulary is ignored rather than thrown on", () => {
    // A facet map fetched under one Lens can race a legend from the next one.
    const model = buildModel(["a/one.ts"], { "a/one.ts": { t: 100, w: [{ f: 99, p: 100 }] } }, FACET_COUNT)
    expect(model.weights("a", true)).toBeUndefined()
  })
})

// S3. A Search rule marks a handful of lines and the tree has to show that facet's colour on
// the file and on every folder above it, whatever the proportions say. The rollup is by plain
// summation of raw counts — the reason the wire carries `l`/`b` rather than percentages.
describe("buildModel — marks", () => {
  test("a one-line mark in a huge file survives to the file's own chip", () => {
    const model = buildModel(
      ["src/big.ts"],
      { "src/big.ts": { t: 100_000, w: [{ f: 0, p: 100 }], m: [{ f: 1, l: 1, b: 30 }] } },
      FACET_COUNT,
    )
    // 30 bytes against 100,000 is 0.03% — floored to 1% rather than rounded away, which is
    // what lets `apportion` give it a slot.
    expect(model.weights("src/big.ts", false)).toEqual([
      { f: 0, p: 100 },
      { f: 1, p: 1 },
    ])
  })

  test("...and to every folder above it", () => {
    const model = buildModel(
      ["src/deep/big.ts"],
      { "src/deep/big.ts": { t: 100_000, w: [{ f: 0, p: 100 }], m: [{ f: 1, l: 1, b: 30 }] } },
      FACET_COUNT,
    )
    for (const dir of ["", "src", "src/deep"]) {
      expect(model.weights(dir, true)!.some((w) => w.f === 1)).toBe(true)
    }
  })

  test("marks merge by max, never additively", () => {
    // The whole file is facet 1 AND 40 of its bytes are marked facet 1. Adding would report
    // 140 bytes of a 100-byte file; max reports the truth, which is 100.
    const model = buildModel(
      ["a/one.ts"],
      { "a/one.ts": { t: 100, w: [{ f: 1, p: 100 }], m: [{ f: 1, l: 2, b: 40 }] } },
      FACET_COUNT,
    )
    expect(model.weights("a", true)).toEqual([{ f: 1, p: 100 }])
  })

  test("a file with marks and nothing painted still gets a chip", () => {
    const model = buildModel(
      ["config.yaml"],
      { "config.yaml": { t: 0, w: [], m: [{ f: 2, l: 3, b: 60 }] } },
      FACET_COUNT,
    )
    expect(model.weights("config.yaml", false)).toEqual([{ f: 2, p: 100 }])
    expect(model.weights("", true)).toEqual([{ f: 2, p: 100 }])
  })

  test("marked lines roll up as exact counts, for the tooltip the chip cannot carry", () => {
    const model = buildModel(
      ["src/a.ts", "src/b.ts"],
      {
        "src/a.ts": { t: 100, w: [{ f: 0, p: 100 }], m: [{ f: 1, l: 3, b: 30 }] },
        "src/b.ts": { t: 100, w: [{ f: 0, p: 100 }], m: [{ f: 1, l: 4, b: 40 }] },
      },
      FACET_COUNT,
    )
    expect(model.marks("src", true)).toEqual([{ f: 1, l: 7 }])
    expect(model.marks("src/a.ts", false)).toEqual([{ f: 1, l: 3 }])
    expect(model.marks("src/b.ts", false)).toEqual([{ f: 1, l: 4 }])
  })

  test("an unmarked node reports no marks", () => {
    const model = buildModel(PATHS, FILES, FACET_COUNT)
    expect(model.marks("src", true)).toBeUndefined()
    expect(model.marks("src/aperture/chip.ts", false)).toBeUndefined()
  })
})
