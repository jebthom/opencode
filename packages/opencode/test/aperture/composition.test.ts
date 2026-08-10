import { describe, expect, test } from "bun:test"
import { computeComposition } from "@/aperture/aperture"
import { fileComposition } from "@/aperture/extents"
import type { Lens } from "@/aperture/lenses"

// Directory composition is the payload the treemap renders a directory from. The
// contract under test: once a file's functions have been painted, its bytes are
// attributed to *those* facets — the closer-to-the-code paint supersedes the coarse
// file-level one — so a directory stops reporting the file-level tag its files have
// outgrown.

const facet = (id: string, label: string, color: string) => ({ id, label, description: label, color })

const LENS: Lens = {
  id: "perf",
  name: "Terminal Performance Bottlenecks",
  description: "",
  prompt: "",
  facets: [facet("likely", "Likely", "#f00"), facet("hot", "Hot path", "#0f0"), facet("cold", "Cold", "#00f")],
  scope: "project",
}

const DIR = {
  id: "d_1",
  path: "src/prompt-input",
  kind: "directory" as const,
  size: 0,
  position: { layer: 0, index: 0 },
}
const nodes = [DIR]

// A 100-byte file: one 60-byte function, a 40-byte preamble.
const file = { id: "n_a", path: "src/prompt-input/a.ts", size: 100 }
const weightOf = (comp: ReturnType<typeof computeComposition>, facet: string) =>
  comp[DIR.id]!.weights.find((w) => w.facet === facet)

describe("computeComposition (directory treemap weights)", () => {
  test("an un-drilled file puts its whole byte mass on its file-level facet", () => {
    const comp = computeComposition(nodes, [file], { n_a: { facet: "likely", hash: "h" } }, {}, LENS)
    expect(comp[DIR.id]!.weights).toEqual([{ facet: "likely", count: 1, bytes: 100 }])
    expect(comp[DIR.id]!.totalBytes).toBe(100)
    expect(comp[DIR.id]!.subtreeBytes).toBe(100)
  })

  test("function facets supersede the file-level facet once the file is painted", () => {
    const mix = {
      "src/prompt-input/a.ts": {
        weights: [{ facet: "hot", count: 1, bytes: 60 }],
        totalCount: 1,
        totalBytes: 60,
        subtreeCount: 2,
        subtreeBytes: 100,
      },
    }
    const comp = computeComposition(nodes, [file], { n_a: { facet: "likely", hash: "h" } }, mix, LENS)
    // The painted function's 60 bytes move to "hot"; "likely" keeps only the 40 bytes of
    // preamble the drill-in painter never reaches. Before the fix all 100 were "likely".
    expect(weightOf(comp, "hot")).toEqual({ facet: "hot", count: 1, bytes: 60 })
    expect(weightOf(comp, "likely")).toEqual({ facet: "likely", count: 0, bytes: 40 })
    // The file still counts as exactly one file, toward its dominant facet.
    expect(comp[DIR.id]!.totalCount).toBe(1)
    // And the partition contract holds: painted bytes never exceed the subtree's.
    expect(comp[DIR.id]!.totalBytes).toBe(100)
    expect(comp[DIR.id]!.subtreeBytes).toBe(100)
  })

  test("weights come back in Lens facet order, whatever order the mix measured them in", () => {
    const mix = {
      "src/prompt-input/a.ts": {
        weights: [
          { facet: "cold", count: 1, bytes: 20 },
          { facet: "hot", count: 1, bytes: 40 },
        ],
        totalCount: 2,
        totalBytes: 60,
        subtreeCount: 3,
        subtreeBytes: 100,
      },
    }
    const comp = computeComposition(nodes, [file], { n_a: { facet: "likely", hash: "h" } }, mix, LENS)
    expect(comp[DIR.id]!.weights.map((w) => w.facet)).toEqual(["likely", "hot", "cold"])
  })

  test("end to end from a real file's text: measured mix → directory weights", () => {
    const content = [
      `import { x } from "y"`, // preamble
      ``,
      `export function render() {`,
      `  return x`,
      `}`,
      `export function measure() {`,
      `  return 2`,
      `}`,
      ``,
    ].join("\n")
    // What the drill-in painter persists after painting the two functions.
    const measured = fileComposition(
      content,
      new Map([
        ["render", "hot"],
        ["measure", "cold"],
      ]),
    )
    const real = { id: "n_a", path: "src/prompt-input/a.ts", size: Buffer.byteLength(content) }
    const comp = computeComposition(
      nodes,
      [real],
      { n_a: { facet: "likely", hash: "h" } },
      { "src/prompt-input/a.ts": measured },
      LENS,
    )
    const bytes = (facet: string) => weightOf(comp, facet)?.bytes ?? 0
    expect(bytes("hot")).toBeGreaterThan(0)
    expect(bytes("cold")).toBeGreaterThan(0)
    // Only the import preamble is left to the file-level facet, and every byte of the
    // file is accounted for exactly once.
    expect(bytes("likely")).toBe(Buffer.byteLength(content) - measured.totalBytes)
    expect(bytes("hot") + bytes("cold") + bytes("likely")).toBe(real.size)
  })

  test("a file with no facet at all stays unattributed (the renderer's grey block)", () => {
    const comp = computeComposition(nodes, [file], {}, {}, LENS)
    expect(comp[DIR.id]!.weights).toEqual([])
    expect(comp[DIR.id]!.totalBytes).toBe(0)
    expect(comp[DIR.id]!.subtreeBytes).toBe(100)
  })
})
