import { describe, expect, it } from "bun:test"
import { splitDirs, describeFile, granularityOf } from "@/aperture/painter"
import type { ApertureSubfacetStore } from "@/aperture/subfacet-store"

// Records mirror the painter's stale shape; splitDirs only reads `node.path`.
const rec = (path: string) => ({ node: { id: path, path } })
const recs = (...paths: string[]) => paths.map(rec)

// Every record in a bin shares the same immediate parent directory.
const dirOf = (p: string) => {
  const i = p.lastIndexOf("/")
  return i === -1 ? "" : p.slice(0, i)
}

describe("splitDirs", () => {
  it("makes one bin per directory and keeps each bin single-directory", () => {
    const bins = splitDirs(recs("a/x.ts", "a/y.ts", "b/z.ts"), 30)
    expect(bins.length).toBe(2)
    for (const bin of bins) {
      const dirs = new Set(bin.map((r) => dirOf(r.node.path)))
      expect(dirs.size).toBe(1)
    }
  })

  it("splits a directory larger than maxFiles into ceil(n/maxFiles) same-dir bins", () => {
    const paths = Array.from({ length: 65 }, (_, i) => `big/f${String(i).padStart(2, "0")}.ts`)
    const bins = splitDirs(recs(...paths), 30)
    expect(bins.length).toBe(3) // ceil(65/30)
    expect(bins.map((b) => b.length)).toEqual([30, 30, 5])
    for (const bin of bins) expect(new Set(bin.map((r) => dirOf(r.node.path))).size).toBe(1)
    // Records are sorted by path within the directory.
    const flat = bins.flat().map((r) => r.node.path)
    expect(flat).toEqual([...paths].sort())
  })

  it("loses no records — the union of bins equals the input", () => {
    const paths = ["a/x.ts", "a/y.ts", "a/z.ts", "b/p.ts", "c/q.ts", "c/r.ts"]
    const bins = splitDirs(recs(...paths), 2)
    const got = bins
      .flat()
      .map((r) => r.node.path)
      .sort()
    expect(got).toEqual([...paths].sort())
  })

  it("groups root-level files together (empty dir)", () => {
    const bins = splitDirs(recs("a.ts", "b.ts", "sub/c.ts"), 30)
    const rootBin = bins.find((b) => b.every((r) => dirOf(r.node.path) === ""))
    expect(rootBin?.map((r) => r.node.path).sort()).toEqual(["a.ts", "b.ts"])
  })

  it("returns [] for empty input and a single bin for one file", () => {
    expect(splitDirs([], 30)).toEqual([])
    const one = splitDirs(recs("a/x.ts"), 30)
    expect(one.length).toBe(1)
    expect(one[0]!.length).toBe(1)
  })

  it("is deterministic regardless of input order", () => {
    const paths = ["b/z.ts", "a/y.ts", "a/x.ts", "b/a.ts"]
    const a = splitDirs(recs(...paths), 30).map((b) => b.map((r) => r.node.path))
    const b = splitDirs(recs(...[...paths].reverse()), 30).map((b) => b.map((r) => r.node.path))
    expect(a).toEqual(b)
  })

  // O3: bins are budgeted in prompt-block weight, not record count, so a coarse
  // (whole-file) block and a fine (per-declaration) block can share a budget.
  describe("weighted binning", () => {
    it("fills a bin to the weight budget, not the record count", () => {
      // 8 records of weight 2 against a budget of 6 → bins of 3 records each.
      const paths = Array.from({ length: 8 }, (_, i) => `d/f${i}.ts`)
      const bins = splitDirs(recs(...paths), 6, () => 2)
      expect(bins.map((b) => b.length)).toEqual([3, 3, 2])
    })

    it("makes a coarse-only bin exactly 30 files at the extent budget", () => {
      // The claim the whole O3 cost story rests on: at weight 2 against EXTENT_BATCH=60,
      // an all-coarse pass bins 30 files per model call — the pre-merge file-painter batch.
      const paths = Array.from({ length: 90 }, (_, i) => `d/f${String(i).padStart(2, "0")}.ts`)
      const bins = splitDirs(recs(...paths), 60, () => 2)
      expect(bins.map((b) => b.length)).toEqual([30, 30, 30])
    })

    it("mixes weights within a bin without exceeding the budget", () => {
      // Alternating coarse (2) and fine (1) against a budget of 4.
      const paths = Array.from({ length: 6 }, (_, i) => `d/f${i}.ts`)
      const weightOf = (r: { node: { path: string } }) => (Number(r.node.path.match(/f(\d)/)![1]) % 2 === 0 ? 2 : 1)
      const bins = splitDirs(recs(...paths), 4, weightOf)
      for (const bin of bins) expect(bin.reduce((s, r) => s + weightOf(r), 0)).toBeLessThanOrEqual(4)
      expect(bins.flat().length).toBe(6)
    })

    it("gives a record heavier than the whole budget its own bin rather than dropping it", () => {
      const bins = splitDirs(recs("d/a.ts", "d/b.ts"), 1, () => 5)
      expect(bins.map((b) => b.map((r) => r.node.path))).toEqual([["d/a.ts"], ["d/b.ts"]])
    })

    it("defaults to plain record count when no weight is given", () => {
      const paths = Array.from({ length: 5 }, (_, i) => `d/f${i}.ts`)
      expect(splitDirs(recs(...paths), 2).map((b) => b.length)).toEqual([2, 2, 1])
    })
  })
})

describe("describeFile", () => {
  const SAMPLE = [
    "// user store",
    "import { db } from './db'",
    "",
    "export function load(id: string) {",
    "  return db.get(id)",
    "}",
    "",
    "export const CACHE = new Map()",
  ].join("\n")

  it("minimal sends only path + imports + leading comment (no skeleton)", () => {
    const out = describeFile("src/store.ts", SAMPLE, "minimal")
    expect(out).toContain("path: src/store.ts")
    expect(out).toContain("imports: ./db")
    expect(out).toContain("comment: user store")
    expect(out).not.toContain("decls:")
    expect(out).not.toContain("lines:")
    expect(out).not.toContain("exports:")
  })

  it("medium adds exports, line count, and a per-declaration signature + span skeleton", () => {
    const out = describeFile("src/store.ts", SAMPLE, "medium")
    // Keeps the minimal signal…
    expect(out).toContain("path: src/store.ts")
    expect(out).toContain("imports: ./db")
    // …and layers the structural skeleton on top.
    expect(out).toContain("exports: load, CACHE")
    expect(out).toContain(`lines: ${SAMPLE.split("\n").length}`)
    expect(out).toContain("decls:")
    // Span runs to the line before the next declaration (the trailing blank folds in).
    expect(out).toContain("- export function load(id: string) {  [4 lines]")
    expect(out).toContain("- export const CACHE = new Map()  [1 lines]")
    // Never ships a function body.
    expect(out).not.toContain("return db.get(id)")
  })

  it("medium caps the skeleton at 40 declarations with a +N-more line", () => {
    const many = Array.from({ length: 50 }, (_, i) => `export const v${i} = ${i}`).join("\n")
    const out = describeFile("src/many.ts", many, "medium")
    const declLines = out.split("\n").filter((l) => l.startsWith("- "))
    // 40 listed declarations + one "(+N more)" summary line.
    expect(declLines.length).toBe(41)
    expect(out).toContain("- (+10 more)")
  })

  it("medium on a declaration-free file emits no decls section", () => {
    const out = describeFile("src/data.json", '{ "a": 1 }', "medium")
    expect(out).not.toContain("decls:")
  })
})

// O3's cost dial. Every file is painted at least as one whole-file extent (the floor,
// priced like the pre-O3 file-level pass); the dial decides which files are additionally
// re-cut per top-level declaration, which measured ~5.8x.
describe("granularityOf", () => {
  const target = (path: string, interested?: boolean) => ({ node: { id: path, path }, interested })
  // A stored mix records how many extents the file was last cut into; >1 means "finely".
  const mixes = (path: string, subtreeCount: number): ApertureSubfacetStore.Mixes => ({
    [path]: { weights: [], totalCount: 0, totalBytes: 0, subtreeCount, subtreeBytes: 100 },
  })
  const none: ApertureSubfacetStore.Mixes = {}

  it("defaults an uninteresting, never-painted file to the whole-file floor", () => {
    expect(granularityOf(target("a.ts"), none, "interest")).toBe("file")
  })

  it("promotes an interesting file only in 'interest' mode", () => {
    expect(granularityOf(target("a.ts", true), none, "interest")).toBe("declaration")
    expect(granularityOf(target("a.ts", true), none, "file")).toBe("file")
  })

  it("promotes everything in 'declaration' mode, interesting or not", () => {
    expect(granularityOf(target("a.ts"), none, "declaration")).toBe("declaration")
    expect(granularityOf(target("a.ts", true), none, "declaration")).toBe("declaration")
  })

  it("is monotone: an already-finely-cut file is never coarsened back", () => {
    // Not interesting, and the dial is at its cheapest — it still stays fine, because
    // re-coarsening would spend tokens to LOSE information.
    expect(granularityOf(target("a.ts"), mixes("a.ts", 7), "file")).toBe("declaration")
    expect(granularityOf(target("a.ts"), mixes("a.ts", 7), "interest")).toBe("declaration")
  })

  it("treats a single-extent mix as the coarse floor, not as prior fine cutting", () => {
    // extentsOf collapses a <2-extent declaration cut to WHOLE, so subtreeCount === 1 is
    // exactly the coarse case and must not read as "already promoted".
    expect(granularityOf(target("a.ts"), mixes("a.ts", 1), "interest")).toBe("file")
  })
})
