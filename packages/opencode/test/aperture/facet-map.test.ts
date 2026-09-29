import { describe, expect, test } from "bun:test"
import { computeFacetMapFiles } from "@/aperture/aperture"
import { capColumns, groupByCombination, packColumns, type MarkedFile } from "@/aperture/facet-grid"

const hit = (facet: string, ranges: Array<readonly [number, number]>, lines: number) => ({
  rule: `${facet}-rule`,
  facet,
  ranges,
  lines,
  bytes: lines * 10,
})

describe("computeFacetMapFiles", () => {
  const FACETS = ["a", "b", "c"]

  test("reports marked lines per facet, ascending by index, with the first marked line", () => {
    const files = computeFacetMapFiles(
      new Map([
        [
          "src/x.ts",
          [
            hit("c", [[40, 41]], 2),
            hit(
              "a",
              [
                [12, 12],
                [3, 5],
              ],
              4,
            ),
          ],
        ],
      ]),
      FACETS,
    )
    expect(files["src/x.ts"]).toEqual({
      m: [
        { f: 0, l: 4, b: 40 },
        { f: 2, l: 2, b: 20 },
      ],
      line: 3,
    })
  })

  test("sums two rules on the same facet", () => {
    const files = computeFacetMapFiles(new Map([["x.ts", [hit("b", [[1, 1]], 1), hit("b", [[9, 10]], 2)]]]), FACETS)
    expect(files["x.ts"]!.m).toEqual([{ f: 1, l: 3, b: 30 }])
  })

  test("skips hits on a facet outside the vocabulary, and omits a file left with nothing", () => {
    expect(computeFacetMapFiles(new Map([["x.ts", [hit("gone", [[1, 1]], 1)]]]), FACETS)).toEqual({})
  })
})

describe("groupByCombination", () => {
  const file = (path: string, facets: number[], line = 1): MarkedFile => ({
    path,
    marks: facets.map((f) => ({ f, l: 1 })),
    line,
  })

  test("orders groups most-specific first, then lexicographically: abc, ab, ac, bc, a, b, c", () => {
    const groups = groupByCombination(
      [
        file("c.ts", [2]),
        file("ab.ts", [0, 1]),
        file("a.ts", [0]),
        file("bc.ts", [1, 2]),
        file("abc.ts", [2, 1, 0]),
        file("b.ts", [1]),
        file("ac.ts", [0, 2]),
      ],
      new Set(),
    )
    expect(groups.map((g) => g.key.join(""))).toEqual(["012", "01", "02", "12", "0", "1", "2"])
  })

  test("places each file in exactly one group, the one for its exact facet set", () => {
    const groups = groupByCombination([file("x.ts", [0, 1]), file("y.ts", [0]), file("z.ts", [0, 1])], new Set())
    expect(groups.map((g) => g.files.map((f) => f.path))).toEqual([["x.ts", "z.ts"], ["y.ts"]])
  })

  test("a suppressed facet leaves every key, re-slicing the files by what remains", () => {
    const groups = groupByCombination([file("x.ts", [0, 1]), file("y.ts", [0]), file("z.ts", [1])], new Set([1]))
    expect(groups.map((g) => [g.key, g.files.map((f) => f.path)])).toEqual([[[0], ["x.ts", "y.ts"]]])
  })

  test("a facet with zero marked lines does not count toward the key", () => {
    const groups = groupByCombination(
      [
        {
          path: "x.ts",
          marks: [
            { f: 0, l: 3 },
            { f: 1, l: 0 },
          ],
          line: 1,
        },
      ],
      new Set(),
    )
    expect(groups[0]!.key).toEqual([0])
  })

  test("files sharing a parent directory form one run, even when a sibling directory sorts between them", () => {
    const groups = groupByCombination(
      [file("a/c.ts", [0]), file("a/b/x.ts", [0]), file("a/b.ts", [0]), file("root.ts", [0])],
      new Set(),
    )
    expect(groups[0]!.runs.map((r) => [r.dir, r.files.map((f) => f.path)])).toEqual([
      ["", ["root.ts"]],
      ["a", ["a/b.ts", "a/c.ts"]],
      ["a/b", ["a/b/x.ts"]],
    ])
  })

  test("changed files come first in their group, agent changes before other working-tree ones", () => {
    const groups = groupByCombination(
      [
        file("a/x.ts", [0]),
        { ...file("m/t.ts", [0]), changed: "tree" },
        { ...file("z/y.ts", [0]), changed: "agent" },
        file("a/w.ts", [0, 1]),
      ],
      new Set(),
    )
    expect(groups.map((g) => g.files.map((f) => f.path))).toEqual([["a/w.ts"], ["z/y.ts", "m/t.ts", "a/x.ts"]])
  })

  test("keepUnmarked puts files with no marks in a trailing empty-key group", () => {
    const groups = groupByCombination([file("u.ts", []), file("x.ts", [0])], new Set(), { keepUnmarked: true })
    expect(groups.map((g) => [g.key, g.files.map((f) => f.path)])).toEqual([
      [[0], ["x.ts"]],
      [[], ["u.ts"]],
    ])
    expect(groupByCombination([file("u.ts", [])], new Set())).toEqual([])
  })

  test("keepUnmarked still drops a file whose every facet is suppressed", () => {
    expect(groupByCombination([file("x.ts", [0])], new Set([0]), { keepUnmarked: true })).toEqual([])
  })
})

describe("packColumns", () => {
  const run = (dir: string, n: number) => ({
    dir,
    files: Array.from({ length: n }, (_, i) => ({ path: `${dir}/f${i}.ts`, marks: [{ f: 0, l: 1 }], line: 1 })),
  })

  test("stacks runs in a column while they fit, counting two border rows each", () => {
    // 9 rows: a run of 3 (5 rows) and a run of 2 (4 rows) share one column.
    const columns = packColumns([run("a", 3), run("b", 2)], 9)
    expect(columns.map((c) => c.map((s) => [s.dir, s.files.length]))).toEqual([
      [
        ["a", 3],
        ["b", 2],
      ],
    ])
  })

  test("splits a run too tall for the space left, continuing it in the next column", () => {
    const columns = packColumns([run("a", 2), run("b", 8)], 9)
    expect(columns.map((c) => c.map((s) => [s.dir, s.files.length, s.continued]))).toEqual([
      [
        ["a", 2, false],
        ["b", 3, false],
      ],
      [["b", 5, true]],
    ])
  })

  test("never loses or duplicates a file", () => {
    const runs = [run("a", 13), run("b", 1), run("c", 7)]
    const packed = packColumns(runs, 9).flatMap((c) => c.flatMap((s) => s.files.map((f) => f.path)))
    expect(packed).toEqual(runs.flatMap((r) => r.files.map((f) => f.path)))
  })

  test("terminates even when the height could not hold a bordered file", () => {
    expect(packColumns([run("a", 2)], 1).flat().length).toBe(2)
  })
})

describe("capColumns", () => {
  const column = (n: number) => [
    { dir: "", files: Array.from({ length: n }, (_, i) => ({ path: `f${i}`, marks: [], line: 1 })), continued: false },
  ]

  test("keeps the first columns and counts the files in the rest", () => {
    const capped = capColumns([column(3), column(2), column(4), column(1)], 2)
    expect(capped.columns.length).toBe(2)
    expect(capped.hidden).toBe(5)
  })

  test("hides nothing when the group already fits", () => {
    expect(capColumns([column(3)], 2)).toEqual({ columns: [column(3)], hidden: 0 })
  })
})
