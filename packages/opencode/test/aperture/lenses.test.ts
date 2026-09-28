import { describe, expect, test } from "bun:test"
import {
  type Lens,
  COLOR_NAMES,
  PALETTES,
  PALETTE_IDS,
  ORDINAL_PALETTE_IDS,
  MAX_FACETS,
  assignColors,
  isGitRule,
  isValidFacet,
  isValidFinder,
  concernRoster,
  describeFinder,
  finderProblem,
  whereProblem,
  NONE_HUE,
  UNTAGGED_HUE,
  legend,
  facetsWithin,
  findFacet,
  slugify,
} from "@/aperture/lenses"
import { XTERM_256, collidesWithSystemColor, deltaE, hexFromRgb, isExact, nearestIndex } from "@/aperture/color-256"

const LENS: Lens = {
  id: "retry-handling-0000",
  name: "Retry Handling",
  description: "where retries happen",
  palette: "categorical",
  owner: "user",
  facets: assignColors("categorical", [
    { id: "retry-path", label: "retry-path", description: "the retry path", owner: "user" },
    { id: "backoff", label: "Backoff", description: "backoff math", owner: "agent", createdBy: "build" },
  ]),
  rules: [{ id: "retry-path-abc", facet: "retry-path", find: { kind: "pattern", pattern: "withRetry\\(" } }],
}

describe("aperture lenses — palettes", () => {
  test("exactly two palettes, each MAX_FACETS colours", () => {
    expect(PALETTE_IDS.sort()).toEqual(["categorical", "ordinal"])
    expect(PALETTES.categorical.kind).toBe("categorical")
    expect(PALETTES.ordinal.kind).toBe("ordinal")
    expect(ORDINAL_PALETTE_IDS).toEqual(["ordinal"])
    for (const id of PALETTE_IDS) {
      expect(PALETTES[id].colors.length).toBeGreaterThanOrEqual(MAX_FACETS)
      for (const c of PALETTES[id].colors) expect(c).toMatch(/^#[0-9A-Fa-f]{6}$/)
    }
  })

  test("the ordinal palette is the categorical palette reversed", () => {
    expect([...PALETTES.ordinal.colors]).toEqual([...PALETTES.categorical.colors].reverse())
  })

  // --- the C1 colour-fidelity contract ---------------------------------------
  //
  // Every colour Aperture can paint must be an *exact* xterm-256 entry, and no two may sit
  // perceptually close. Together those two properties are what make a facet's hue mean the same
  // thing in the TUI and in VSCode, on a truecolor terminal and a 256-colour one, under any
  // terminal colour theme. See the note on PALETTES in lenses.ts.
  test("the xterm-256 table matches the standard formulae", () => {
    expect(XTERM_256).toHaveLength(256)
    expect(XTERM_256[0]).toEqual([0, 0, 0])
    expect(XTERM_256[15]).toEqual([255, 255, 255])
    expect(XTERM_256[16]).toEqual([0, 0, 0])
    expect(XTERM_256[231]).toEqual([255, 255, 255])
    expect(XTERM_256[232]).toEqual([8, 8, 8])
    expect(XTERM_256[255]).toEqual([238, 238, 238])
    expect(hexFromRgb(XTERM_256[244]!)).toBe("#808080")
    expect(hexFromRgb(XTERM_256[238]!)).toBe("#444444")
    expect(hexFromRgb(XTERM_256[161]!)).toBe("#D7005F")
  })

  const everyColor = (): Array<{ where: string; hex: string }> => [
    ...PALETTE_IDS.flatMap((id) => PALETTES[id].colors.map((hex) => ({ where: `palette "${id}"`, hex }))),
    { where: "NONE_HUE", hex: NONE_HUE },
    { where: "UNTAGGED_HUE", hex: UNTAGGED_HUE },
  ]

  test("every paintable colour is an exact xterm-256 entry", () => {
    for (const { where, hex } of everyColor())
      if (!isExact(hex))
        throw new Error(
          `${where} colour ${hex} is not an exact xterm-256 entry — a 256-colour terminal would show ${hexFromRgb(XTERM_256[nearestIndex(hex)]!)} instead.`,
        )
  })

  test("no paintable colour coincides with a re-themable system colour (0-15)", () => {
    for (const { where, hex } of everyColor())
      if (collidesWithSystemColor(hex))
        throw new Error(`${where} colour ${hex} is also an xterm system colour (index 0-15), which themes repaint.`)
  })

  test("no two paintable colours are perceptually close", () => {
    const MIN_DELTA_E = 20
    const unique = [...new Map(everyColor().map((c) => [c.hex, c])).values()]
    for (let i = 0; i < unique.length; i++)
      for (let j = i + 1; j < unique.length; j++) {
        const d = deltaE(unique[i]!.hex, unique[j]!.hex)
        if (d < MIN_DELTA_E)
          throw new Error(`${unique[i]!.hex} and ${unique[j]!.hex} are only ΔE2000 ${d.toFixed(1)} apart`)
      }
  })

  test("assignColors pairs facets with palette colours in order", () => {
    const out = assignColors("categorical", [
      { id: "a", label: "A", description: "first", owner: "user" },
      { id: "b", label: "B", description: "second", owner: "agent" },
    ])
    expect(out.map((t) => t.color)).toEqual([PALETTES.categorical.colors[0], PALETTES.categorical.colors[1]])
  })

  // KNOWN AND DELIBERATE: facet colour is derived from array position, so removing a facet
  // re-hues every facet after it. lens_unmark reports the shift rather than persisting a colour
  // slot, which would be a second source of truth.
  test("removing a middle facet re-colours the ones after it", () => {
    const three = assignColors("categorical", [
      { id: "a", label: "a", description: "", owner: "user" },
      { id: "b", label: "b", description: "", owner: "user" },
      { id: "c", label: "c", description: "", owner: "user" },
    ])
    const without = assignColors(
      "categorical",
      three.filter((t) => t.id !== "b"),
    )
    expect(without.find((t) => t.id === "a")!.color).toBe(three[0]!.color)
    expect(without.find((t) => t.id === "c")!.color).toBe(three[1]!.color)
  })
})

describe("aperture lenses — helpers", () => {
  test("isValidFacet and findFacet resolve by id, and findFacet also by label", () => {
    expect(isValidFacet(LENS, "retry-path")).toBe(true)
    expect(isValidFacet(LENS, "nope")).toBe(false)
    expect(isValidFacet(LENS, 5)).toBe(false)
    expect(findFacet(LENS, "backoff")?.id).toBe("backoff")
    expect(findFacet(LENS, " BACKOFF ")?.id).toBe("backoff")
    expect(findFacet(LENS, "nope")).toBeUndefined()
  })

  test("legend exposes facet/label/colour per facet", () => {
    expect(legend(LENS)[1]).toEqual({ facet: "backoff", label: "Backoff", color: LENS.facets[1]!.color })
  })

  // The guard on the legend filter (O4): a filter is only meaningful in the vocabulary it was
  // expressed against, and facet ids are slugs that unrelated Lenses can share.
  test("facetsWithin keeps only the Lens's own facets", () => {
    expect(facetsWithin(LENS, ["backoff", "not-a-facet", "backoff"])).toEqual(new Set(["backoff"]))
    expect(facetsWithin(LENS, [])).toEqual(new Set())
  })

  test("concernRoster counts rules per concern, names the hue and the owner", () => {
    expect(concernRoster(LENS)).toEqual([
      {
        facet: "retry-path",
        label: "retry-path",
        color: PALETTES.categorical.colors[0]!,
        colorName: "crimson",
        owner: "user",
        rules: 1,
      },
      {
        facet: "backoff",
        label: "Backoff",
        color: PALETTES.categorical.colors[1]!,
        colorName: "amber",
        owner: "agent",
        rules: 0,
      },
    ])
    for (const hex of PALETTES.categorical.colors) expect(COLOR_NAMES[hex]).toBeTruthy()
  })

  test("slugify produces kebab ids", () => {
    expect(slugify("Auth Flow!")).toBe("auth-flow")
    expect(slugify("  --weird__Name  ")).toBe("weird-name")
    expect(slugify("")).toBe("lens")
  })
})

describe("aperture lenses — finders and git filters", () => {
  test("finderProblem names the fix, and isValidFinder agrees with it", () => {
    const ok: unknown[] = [
      { kind: "pattern", pattern: "x" },
      { kind: "pattern", pattern: "x", glob: ["a/**"], caseSensitive: false },
      { kind: "symbol", name: "retryWithBackoff" },
      { kind: "symbol", name: "f", path: "packages/opencode" },
      { kind: "structural", pattern: "$A.get($$$B)", language: "ts" },
      { kind: "diff" },
      { kind: "diff", ref: "HEAD~1..HEAD", glob: ["src/**"] },
    ]
    for (const find of ok) {
      expect(finderProblem(find)).toBeUndefined()
      expect(isValidFinder(find)).toBe(true)
    }

    // Each message names the missing field: lens_mark takes a flat struct precisely so these
    // land inside execute() instead of as an opaque schema-decode failure.
    const bad: Array<[unknown, string]> = [
      [{ kind: "pattern" }, "pattern"],
      [{ kind: "pattern", pattern: "x", glob: "a/**" }, "glob"],
      [{ kind: "symbol" }, "name"],
      [{ kind: "symbol", name: "f", path: 3 }, "path"],
      [{ kind: "structural", pattern: "x" }, "language"],
      [{ kind: "diff", ref: "" }, "ref"],
      [{ kind: "regex", pattern: "x" }, "regex"],
      [{}, "kind"],
      [null, "object"],
    ]
    for (const [find, mentions] of bad) {
      expect(finderProblem(find), JSON.stringify(find)).toContain(mentions)
      expect(isValidFinder(find)).toBe(false)
    }
  })

  test("whereProblem accepts absent or string filters and refuses option-shaped values", () => {
    expect(whereProblem(undefined)).toBeUndefined()
    expect(whereProblem({ changed: "HEAD~1..HEAD", author: "ada", since: "2 weeks ago" })).toBeUndefined()
    expect(whereProblem({ changed: "" })).toContain("changed")
    expect(whereProblem({ author: 3 })).toContain("author")
    expect(whereProblem({ since: "--all" })).toContain("since")
    expect(whereProblem("HEAD")).toContain("object")
  })

  test("isGitRule is true for a diff finder or any git filter, and only then", () => {
    expect(isGitRule({ find: { kind: "pattern", pattern: "x" } })).toBe(false)
    expect(isGitRule({ find: { kind: "pattern", pattern: "x" }, where: {} })).toBe(false)
    expect(isGitRule({ find: { kind: "pattern", pattern: "x" }, where: { author: "ada" } })).toBe(true)
    expect(isGitRule({ find: { kind: "diff" } })).toBe(true)
  })

  test("describeFinder reads the finder and its filter as one line", () => {
    expect(describeFinder({ kind: "pattern", pattern: "x\\(", glob: ["src/**"] }, { changed: "HEAD" })).toBe(
      "pattern /x\\(/ glob src/** changed in HEAD",
    )
    expect(describeFinder({ kind: "diff" })).toBe("lines changed vs HEAD")
    expect(describeFinder({ kind: "symbol", name: "f" }, { author: "ada", since: "1 week ago" })).toBe(
      "symbol f by ada since 1 week ago",
    )
  })
})
