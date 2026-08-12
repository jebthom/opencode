import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { ApertureRules } from "@/aperture/rules"
import { MAX_RULE_HITS, type Rule } from "@/aperture/lenses"

// S1: a line tag is a persisted *query*, not a location. These exercise the evaluator that
// turns a Lens's finders into sparse line ranges at the read boundary.

// A rule's facet names the CONCERN, never the search — S2 dropped the binary `hit` facet the
// track originally proposed, because the name is what the user reads in the legend.
const rule = (id: string, find: Rule["find"], extra: Partial<Rule> = {}): Rule => ({
  id,
  facet: "retry-path",
  find,
  ...extra,
})

const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)

// Deliberately Effect-shaped, mirroring this repo. `extentsOf` finds a top-level declaration
// by NAME whatever its right-hand side is, which is the property `symbol` exists for: an
// ast-grep pattern for `function $F($$$P)` would see only one of these three.
const IDIOMS = [
  `import { Effect } from "effect"`,
  ``,
  `export const arrowStyle = (a: number) => a + 1`,
  `  // body`,
  ``,
  `export const generatorStyle = Effect.fn(function* (a: number) {`,
  `  return a`,
  `})`,
  ``,
  `export function declarationStyle(a: number) {`,
  `  return a`,
  `}`,
].join("\n")

describe("aperture rules — rulesHash", () => {
  const a = rule("a", { kind: "pattern", pattern: "alpha" })
  const b = rule("b", { kind: "symbol", name: "beta" })

  test("is stable and order-insensitive", () => {
    expect(ApertureRules.rulesHash([a, b])).toBe(ApertureRules.rulesHash([b, a]))
  })

  test("changes when a finder changes", () => {
    const edited = rule("a", { kind: "pattern", pattern: "alphaX" })
    expect(ApertureRules.rulesHash([edited, b])).not.toBe(ApertureRules.rulesHash([a, b]))
  })

  test("changes when a rule's facet changes", () => {
    expect(ApertureRules.rulesHash([{ ...a, facet: "other" }])).not.toBe(ApertureRules.rulesHash([a]))
  })

  // `note` rides through to the payload for hover detail but is never evaluated, so folding
  // it into the key would throw away a whole-repo pass for a comment edit.
  test("ignores note and createdBy, which never affect hits", () => {
    const annotated = rule("a", { kind: "pattern", pattern: "alpha" }, { note: "the retry path", createdBy: "explore" })
    expect(ApertureRules.rulesHash([annotated])).toBe(ApertureRules.rulesHash([a]))
  })
})

describe("aperture rules — evaluation", () => {
  let dir: string

  beforeAll(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aperture-rules-")))
    await fs.mkdir(path.join(dir, "src"), { recursive: true })
    await fs.mkdir(path.join(dir, "other"), { recursive: true })
    await fs.writeFile(path.join(dir, "src", "idioms.ts"), IDIOMS)
    // Two matches on ADJACENT lines plus one apart, to pin the merge behaviour.
    await fs.writeFile(
      path.join(dir, "src", "hits.ts"),
      ["const one = needle", "const two = needle", "const three = 3", "const four = needle", ""].join("\n"),
    )
    await fs.writeFile(path.join(dir, "other", "elsewhere.ts"), "const five = needle\n")
    // A third declaration between the two `dup`s on purpose: extents tile the file, so two
    // *consecutive* same-named declarations yield adjacent ranges that clampRanges rightly
    // merges into one strip, which would hide whether both were found at all.
    await fs.writeFile(path.join(dir, "src", "shadowed.ts"), "const dup = 1\nconst between = 2\nconst dup = 3\n")
    // Over the cap. Non-adjacent so merging can't rescue it into range.
    await fs.writeFile(
      path.join(dir, "flood.ts"),
      Array.from({ length: MAX_RULE_HITS + 100 }, () => "flooded\n\n").join(""),
    )
  })

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("pattern hits are per-line, and adjacent hits merge into one strip", async () => {
    const res = await run(ApertureRules.evaluate(dir, [rule("r", { kind: "pattern", pattern: "needle" })]))
    // [1,2] merged from lines 1 and 2; [4,4] stayed separate.
    expect(res.byFile.get("src/hits.ts")?.[0]!.ranges).toEqual([
      [1, 2],
      [4, 4],
    ])
    expect(res.byFile.get("other/elsewhere.ts")?.[0]!.ranges).toEqual([[1, 1]])
    // Merging is also what keeps the reported hit count honest — 3 matched lines in hits.ts
    // are 2 strips, and the diagnostic counts strips.
    expect(res.diagnostics).toEqual([{ rule: "r", hits: 3, files: 2 }])
  })

  test("pattern honours a glob", async () => {
    const res = await run(
      ApertureRules.evaluate(dir, [rule("r", { kind: "pattern", pattern: "needle", glob: ["src/**"] })]),
    )
    expect([...res.byFile.keys()]).toEqual(["src/hits.ts"])
  })

  test("pattern is case-sensitive by default and case-insensitive on request", async () => {
    const sensitive = await run(ApertureRules.evaluate(dir, [rule("r", { kind: "pattern", pattern: "NEEDLE" })]))
    expect(sensitive.byFile.size).toBe(0)
    const insensitive = await run(
      ApertureRules.evaluate(dir, [rule("r", { kind: "pattern", pattern: "NEEDLE", caseSensitive: false })]),
    )
    expect(insensitive.byFile.size).toBe(2)
  })

  // The reason `symbol` survives alongside `structural`: it never inspects the right-hand
  // side, so a const-arrow, an Effect generator and a plain declaration are all findable by
  // the name the agent actually knows.
  test("symbol is idiom-blind across arrow, generator and declaration forms", async () => {
    for (const name of ["arrowStyle", "generatorStyle", "declarationStyle"]) {
      const res = await run(ApertureRules.evaluate(dir, [rule("r", { kind: "symbol", name })]))
      const hit = res.byFile.get("src/idioms.ts")
      expect(hit, `expected to find ${name}`).toBeDefined()
      expect(hit![0]!.ranges.length).toBe(1)
    }
  })

  test("symbol paints the declaration's whole extent, not the matched line", async () => {
    const res = await run(ApertureRules.evaluate(dir, [rule("r", { kind: "symbol", name: "generatorStyle" })]))
    const [start, end] = res.byFile.get("src/idioms.ts")![0]!.ranges[0]!
    expect(start).toBe(6)
    expect(end).toBeGreaterThan(start)
  })

  test("symbol does not match a longer name that merely contains it", async () => {
    const res = await run(ApertureRules.evaluate(dir, [rule("r", { kind: "symbol", name: "arrow" })]))
    expect(res.byFile.size).toBe(0)
  })

  // extentsOf suffixes a duplicate declaration `dup~2`; both must be found or a shadowed
  // re-declaration would be silently unpainted.
  test("symbol finds every declaration of a shadowed name", async () => {
    const res = await run(ApertureRules.evaluate(dir, [rule("r", { kind: "symbol", name: "dup" })]))
    expect(res.byFile.get("src/shadowed.ts")![0]!.ranges.length).toBe(2)
  })

  test("symbol honours a path scope", async () => {
    const scoped = await run(
      ApertureRules.evaluate(dir, [rule("r", { kind: "symbol", name: "arrowStyle", path: "other" })]),
    )
    expect(scoped.byFile.size).toBe(0)
  })

  test("a rule over MAX_RULE_HITS is reported but paints nothing", async () => {
    const res = await run(ApertureRules.evaluate(dir, [rule("r", { kind: "pattern", pattern: "flooded" })]))
    expect(res.byFile.size).toBe(0)
    expect(res.diagnostics[0]!.overCap).toBe(true)
    expect(res.diagnostics[0]!.hits).toBeGreaterThan(MAX_RULE_HITS)
  })

  // The single most misleading thing this module could do is report a broken regex as
  // "0 hits", which an agent reads as "the code isn't there" and acts on. Ripgrep exits 2
  // for an uncompilable pattern and the service turns that into `partial` with no items.
  test("an invalid pattern yields an error diagnostic, not a silent zero", async () => {
    const res = await run(ApertureRules.evaluate(dir, [rule("r", { kind: "pattern", pattern: "([unclosed" })]))
    expect(res.diagnostics[0]!.error).toBeDefined()
    expect(res.byFile.size).toBe(0)
  })

  test("one failing rule does not stop the others", async () => {
    const res = await run(
      ApertureRules.evaluate(dir, [
        rule("bad", { kind: "pattern", pattern: "([unclosed" }),
        rule("good", { kind: "pattern", pattern: "needle" }),
      ]),
    )
    expect(res.diagnostics.find((d) => d.rule === "bad")!.error).toBeDefined()
    expect(res.byFile.get("src/hits.ts")?.some((h) => h.rule === "good")).toBe(true)
  })

  test("structural reports the missing backend rather than throwing (S1b)", async () => {
    const res = await run(
      ApertureRules.evaluate(dir, [rule("r", { kind: "structural", pattern: "foo($$$A)", language: "ts" })]),
    )
    expect(res.diagnostics[0]!.error).toContain("ast-grep")
    expect(res.byFile.size).toBe(0)
  })

  // The incremental path the read boundary's memo depends on: every finder is a pure
  // function of one file's content, so restricting to a changed file must give exactly that
  // file's hits and nothing else.
  test("restricting to files evaluates only those files", async () => {
    const res = await run(
      ApertureRules.evaluate(dir, [rule("r", { kind: "pattern", pattern: "needle" })], ["src/hits.ts"]),
    )
    expect([...res.byFile.keys()]).toEqual(["src/hits.ts"])
  })

  test("an empty file restriction evaluates nothing", async () => {
    const res = await run(ApertureRules.evaluate(dir, [rule("r", { kind: "pattern", pattern: "needle" })], []))
    expect(res.byFile.size).toBe(0)
    expect(res.diagnostics).toEqual([])
  })

  test("a rule's facet and note ride through to its hits for the payload", async () => {
    const res = await run(
      ApertureRules.evaluate(dir, [
        rule("r", { kind: "pattern", pattern: "needle" }, { facet: "retry", note: "the retry path" }),
      ]),
    )
    const hit = res.byFile.get("src/hits.ts")![0]!
    expect(hit.facet).toBe("retry")
    expect(hit.note).toBe("the retry path")
    expect(hit.rule).toBe("r")
  })
})
