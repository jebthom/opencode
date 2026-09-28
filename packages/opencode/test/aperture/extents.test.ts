import { describe, expect, test } from "bun:test"
import { clampRanges, extentsOf, parseHunkRanges, PREAMBLE, WHOLE, type Extent } from "@/aperture/extents"

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

  test("declaration-free file is a single whole-file tile", () => {
    const noDecl = "1 + 1\nconsole.log('hi')"
    const extents = extentsOf(noDecl)
    expect(extents).toEqual([{ name: WHOLE, startLine: 1, endLine: 2 }])
    assertTiles(extents, 2)
  })

  test('"file" granularity is always exactly one whole-file extent', () => {
    const content = ["import x", "function a() {}", "function b() {}"].join("\n")
    expect(extentsOf(content, "declaration").map((e) => e.name)).toEqual([PREAMBLE, "a", "b"])
    expect(extentsOf(content, "file")).toEqual([{ name: WHOLE, startLine: 1, endLine: 3 }])
    assertTiles(extentsOf(content, "file"), 3)
    // An empty file has no extents at either granularity.
    expect(extentsOf("", "file")).toEqual([])
  })

  test("a declaration cut that yields fewer than two extents collapses to WHOLE", () => {
    // The two granularities must agree on such a file, so promoting it to declaration
    // granularity never repaints the same span under a different name.
    const oneDecl = ["function only() {", "  return 1", "}"].join("\n")
    expect(extentsOf(oneDecl, "declaration")).toEqual(extentsOf(oneDecl, "file"))
    const noDecl = "1 + 1"
    expect(extentsOf(noDecl, "declaration")).toEqual(extentsOf(noDecl, "file"))
    // Two declarations is the first cut that actually refines.
    const twoDecls = ["function a() {}", "function b() {}"].join("\n")
    expect(extentsOf(twoDecls, "declaration").map((e) => e.name)).toEqual(["a", "b"])
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
    // Two declarations, so the <2-extent collapse to WHOLE doesn't mask the result.
    const content = ["function only() {", "  return 1", "}", "const after = 1"].join("\n")
    const extents = extentsOf(content)
    expect(extents.map((e) => e.name)).toEqual(["only", "after"])
    assertTiles(extents, 4)
  })

  test("indented (non-top-level) declarations are ignored", () => {
    const content = ["class Outer {", "  method() {}", "  const inner = 1", "}", "const after = 1"].join("\n")
    const extents = extentsOf(content)
    // Only the top-level `class Outer` and `const after` count; the class is one unit,
    // and neither `method` nor the indented `inner` becomes an extent.
    expect(extents.map((e) => e.name)).toEqual(["Outer", "after"])
    assertTiles(extents, 5)
  })

  test("python def/class at column 0 are recognised", () => {
    const content = ["import os", "", "def handler():", "    return 1", "", "class Thing:", "    pass"].join("\n")
    const extents = extentsOf(content)
    expect(extents.map((e) => e.name)).toEqual([PREAMBLE, "handler", "Thing"])
    assertTiles(extents, 7)
  })

  test("duplicate declaration names are disambiguated", () => {
    const content = ["type T = number", "type T = string"].join("\n")
    const extents = extentsOf(content)
    expect(extents.map((e) => e.name)).toEqual(["T", "T~2"])
  })

  describe("parseHunkRanges", () => {
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
  })

  // Sparse line ranges — these deliberately do NOT tile, so assertTiles must not be applied to them.
  describe("clampRanges", () => {
    // 5 lines.
    const five = "a\nb\nc\nd\ne"

    test("passes through ranges already inside the file", () => {
      expect(clampRanges([[2, 3]], five)).toEqual([[2, 3]])
    })

    test("clamps a range running past the end of the file", () => {
      // git reported a hunk against content newer than what finalize read from disk.
      expect(clampRanges([[4, 99]], five)).toEqual([[4, 5]])
    })

    test("drops a range entirely beyond the file", () => {
      expect(clampRanges([[80, 99]], five)).toEqual([])
    })

    test("merges overlapping and adjacent ranges into one strip", () => {
      // [1,2] and [3,4] merge on adjacency; [2,3] overlaps both.
      expect(
        clampRanges(
          [
            [1, 2],
            [3, 4],
          ],
          five,
        ),
      ).toEqual([[1, 4]])
      expect(
        clampRanges(
          [
            [1, 3],
            [2, 3],
          ],
          five,
        ),
      ).toEqual([[1, 3]])
    })

    test("keeps a genuine gap unmerged", () => {
      expect(
        clampRanges(
          [
            [1, 1],
            [4, 4],
          ],
          five,
        ),
      ).toEqual([
        [1, 1],
        [4, 4],
      ])
    })

    test("sorts out-of-order input", () => {
      expect(
        clampRanges(
          [
            [5, 5],
            [1, 1],
          ],
          five,
        ),
      ).toEqual([
        [1, 1],
        [5, 5],
      ])
    })

    test("normalizes a reversed range and a sub-1 start", () => {
      expect(clampRanges([[3, 2]], five)).toEqual([[2, 3]])
      expect(clampRanges([[0, 2]], five)).toEqual([[1, 2]])
    })

    test("an empty file has no tags however many ranges are reported", () => {
      expect(clampRanges([[1, 5]], "")).toEqual([])
    })
  })
})
