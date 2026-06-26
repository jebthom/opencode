import { describe, expect, test } from "bun:test"
import {
  extentsOf,
  extentText,
  fileComposition,
  extentChangeFacets,
  parseHunkRanges,
  subNodeID,
  PREAMBLE,
  type Extent,
} from "@/aperture/extents"

// Assert a set of extents tiles [1, total] exhaustively: sorted, contiguous, no
// gaps, no overlaps, starting at 1 and ending at total. This is the byte contract.
function assertTiles(extents: Extent[], total: number) {
  if (total === 0) {
    expect(extents).toEqual([])
    return
  }
  const sorted = [...extents].sort((a, b) => a.startLine - b.startLine)
  expect(sorted[0]!.startLine).toBe(1)
  expect(sorted[sorted.length - 1]!.endLine).toBe(total)
  for (let i = 0; i < sorted.length; i++) {
    expect(sorted[i]!.startLine).toBeLessThanOrEqual(sorted[i]!.endLine)
    if (i + 1 < sorted.length) expect(sorted[i + 1]!.startLine).toBe(sorted[i]!.endLine + 1)
  }
}

describe("aperture extents (sub-file resolution)", () => {
  test("empty file yields no extents", () => {
    expect(extentsOf("")).toEqual([])
  })

  test("declaration-free file is a single whole-file preamble tile", () => {
    const content = "const a = 1\nconsole.log(a)\n"
    // No top-level *declaration keyword at column 0* beyond `const a` — wait, const a IS one.
    const noDecl = "1 + 1\nconsole.log('hi')"
    const extents = extentsOf(noDecl)
    expect(extents).toEqual([{ name: PREAMBLE, startLine: 1, endLine: 2 }])
    assertTiles(extents, 2)
  })

  test("imports + functions: preamble then one extent per declaration, tiling exactly", () => {
    const content = [
      `import { x } from "./x"`, // 1
      ``, // 2
      `export function alpha() {`, // 3
      `  return 1`, // 4
      `}`, // 5
      ``, // 6
      `const beta = () => {`, // 7
      `  return 2`, // 8
      `}`, // 9
      `class Gamma {}`, // 10
    ].join("\n")
    const extents = extentsOf(content)
    expect(extents.map((e) => e.name)).toEqual([PREAMBLE, "alpha", "beta", "Gamma"])
    expect(extents).toEqual([
      { name: PREAMBLE, startLine: 1, endLine: 2 },
      { name: "alpha", startLine: 3, endLine: 6 },
      { name: "beta", startLine: 7, endLine: 9 },
      { name: "Gamma", startLine: 10, endLine: 10 },
    ])
    assertTiles(extents, 10)
  })

  test("a declaration on line 1 produces no preamble", () => {
    const content = ["function only() {", "  return 1", "}"].join("\n")
    const extents = extentsOf(content)
    expect(extents.map((e) => e.name)).toEqual(["only"])
    assertTiles(extents, 3)
  })

  test("indented (non-top-level) declarations are ignored", () => {
    const content = ["class Outer {", "  method() {}", "  const inner = 1", "}"].join("\n")
    const extents = extentsOf(content)
    // Only the top-level `class Outer` counts; the class is one unit.
    expect(extents.map((e) => e.name)).toEqual(["Outer"])
    assertTiles(extents, 4)
  })

  test("python def/class at column 0 are recognised", () => {
    const content = ["import os", "", "def handler():", "    return 1", "", "class Thing:", "    pass"].join("\n")
    const extents = extentsOf(content)
    expect(extents.map((e) => e.name)).toEqual([PREAMBLE, "handler", "Thing"])
    assertTiles(extents, 7)
  })

  test("duplicate declaration names are disambiguated for stable ids", () => {
    const content = ["type T = number", "type T = string"].join("\n")
    const extents = extentsOf(content)
    expect(extents.map((e) => e.name)).toEqual(["T", "T~2"])
    // Distinct names → distinct sub-node ids.
    expect(subNodeID("a.ts", "T")).not.toBe(subNodeID("a.ts", "T~2"))
  })

  test("extentText returns the exact lines of an extent", () => {
    const content = ["import x", "function f() {", "  return 1", "}"].join("\n")
    const extents = extentsOf(content)
    const fExtent = extents.find((e) => e.name === "f")!
    expect(extentText(content, fExtent)).toBe(["function f() {", "  return 1", "}"].join("\n"))
  })

  test("sub-node id is stable, path+name scoped, and distinct from the file id", () => {
    expect(subNodeID("src/a.ts", "alpha")).toBe(subNodeID("src/a.ts", "alpha"))
    expect(subNodeID("src/a.ts", "alpha")).not.toBe(subNodeID("src/b.ts", "alpha"))
    expect(subNodeID("src/a.ts", "alpha")).toMatch(/^n_[0-9a-f]{16}$/)
  })

  describe("fileComposition (byte-weighted facet mix from functions)", () => {
    const content = [
      `import x`, //         1  preamble (1 line)
      `function a() {`, //   2  a (3 lines)
      `  return 1`, //       3
      `}`, //                4
      `function b() {`, //   5  b (2 lines)
      `}`, //                6
      `function c() {`, //   7  c (2 lines)
      `}`, //                8
    ].join("\n")

    test("aggregates painted functions by facet; unpainted count toward subtree only", () => {
      // a,b → "core"; c unpainted; preamble unpainted.
      const comp = fileComposition(content, new Map([["a", "core"], ["b", "core"]]))
      expect(comp.weights).toEqual([{ facet: "core", count: 2, bytes: comp.weights[0]!.bytes }])
      expect(comp.totalCount).toBe(2)
      // All four extents (preamble + a + b + c) make up the subtree.
      expect(comp.subtreeCount).toBe(4)
      expect(comp.subtreeBytes).toBe(Buffer.byteLength(content))
      // Painted bytes are a strict subset of the file's bytes.
      expect(comp.totalBytes).toBeLessThan(comp.subtreeBytes)
    })

    test("a mixed file yields multiple weights in stable facet order", () => {
      const comp = fileComposition(content, new Map([["a", "zeta"], ["b", "alpha"], ["c", "alpha"]]))
      expect(comp.weights.map((w) => w.facet)).toEqual(["alpha", "zeta"])
      expect(comp.weights.find((w) => w.facet === "alpha")!.count).toBe(2)
      expect(comp.totalCount).toBe(3)
    })

    test("an all-unpainted file has empty weights but non-zero subtree totals", () => {
      const comp = fileComposition(content, new Map())
      expect(comp.weights).toEqual([])
      expect(comp.totalCount).toBe(0)
      expect(comp.subtreeBytes).toBe(Buffer.byteLength(content))
    })
  })

  describe("git-changed at function granularity", () => {
    const content = [
      `import x`, //        1
      `function a() {`, //  2  a: 2-4
      `  return 1`, //      3
      `}`, //               4
      `function b() {`, //  5  b: 5-7
      `  return 2`, //      6
      `}`, //               7
    ].join("\n")

    test("parseHunkRanges reads new-file line ranges from unified=0 hunks", () => {
      const patch = [
        `diff --git a/f.ts b/f.ts`,
        `--- a/f.ts`,
        `+++ b/f.ts`,
        `@@ -3,1 +3,1 @@`,
        `-  return 0`,
        `+  return 1`,
        `@@ -10,0 +11,2 @@`,
        `+added`,
        `+lines`,
      ].join("\n")
      expect(parseHunkRanges(patch)).toEqual([
        [3, 3],
        [11, 12],
      ])
    })

    test("a pure deletion hunk (d=0) flags its adjacent line", () => {
      expect(parseHunkRanges(`@@ -5,2 +5,0 @@`)).toEqual([[5, 5]])
    })

    test("only the extent overlapping a changed range is 'changed'", () => {
      // Change lands on line 3 → inside function a (2-4), not b (5-7).
      const facets = extentChangeFacets(content, [[3, 3]], false)
      expect(facets.get("a")).toBe("changed")
      expect(facets.get("b")).toBe("unchanged")
      expect(facets.get(PREAMBLE)).toBe("unchanged")
    })

    test("no ranges + fileChangedFallback marks every extent changed (untracked file)", () => {
      const facets = extentChangeFacets(content, [], true)
      expect([...facets.values()].every((f) => f === "changed")).toBe(true)
    })

    test("no ranges + no fallback marks every extent unchanged", () => {
      const facets = extentChangeFacets(content, [], false)
      expect([...facets.values()].every((f) => f === "unchanged")).toBe(true)
    })
  })
})
