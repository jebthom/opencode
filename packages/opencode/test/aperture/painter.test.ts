import { describe, expect, it } from "bun:test"
import { splitDirs } from "@/aperture/painter"

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
})
