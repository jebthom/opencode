import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  type Lens,
  COLOR_NAMES,
  PALETTES,
  PALETTE_IDS,
  ORDINAL_PALETTE_IDS,
  MAX_FACETS,
  ARCHITECTURE,
  ARCHITECTURE_ID,
  BUILTIN_LENSES,
  GIT_CHANGED,
  MTIME_RECENCY,
  RECENCY_FACET_IDS,
  CHANGE_FACET_IDS,
  changeBucketIndex,
  assignColors,
  bucketIndex,
  isBuiltinLens,
  isDeterministic,
  isValidFacet,
  isValidFinder,
  isAssignableFacet,
  usesPainter,
  paintedFacets,
  concernRoster,
  finderProblem,
  facetEnumIds,
  NONE_FACET,
  NONE_HUE,
  UNTAGGED_HUE,
  legend,
  facetsWithin,
  buildSystemPrompt,
  slugify,
} from "@/aperture/lenses"
import { LAYERS, LAYER_HUE } from "@/aperture/semantics"
import { XTERM_256, collidesWithSystemColor, deltaE, hexFromRgb, isExact, nearestIndex } from "@/aperture/color-256"
import { AperturePayload } from "@/aperture/payload"

describe("aperture lenses", () => {
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

  // The ordinal palette is the categorical six reversed, not a second set of hexes. Keeping
  // one closed colour universe is what lets the VSCode extension contribute a colour id per
  // hue instead of approximating (see gen-colors.ts).
  test("the ordinal palette is the categorical palette reversed", () => {
    expect([...PALETTES.ordinal.colors]).toEqual([...PALETTES.categorical.colors].reverse())
  })

  test("the ordinal palette is the source for the Edit recency heat-map colours", () => {
    expect(MTIME_RECENCY.facets.map((f) => f.color)).toEqual([...PALETTES.ordinal.colors])
  })

  // --- the C1 colour-fidelity contract ---------------------------------------
  //
  // Every colour Aperture can paint must be an *exact* xterm-256 entry, and no two may sit
  // perceptually close. Together those two properties are what make a facet's hue mean the
  // same thing in the TUI and in VSCode, on a truecolor terminal and a 256-colour one, under
  // any terminal colour theme. See the note on PALETTES in lenses.ts for the full argument.
  //
  // The predecessor of these tests only checked each colour against *grey*, never against
  // the other five — which is why `pastel` shipped with #F7C8A0 and #F5E1A4 both quantising
  // to xterm idx 223, i.e. literally the same colour on any 256-colour terminal.

  // The quantisation maths lives in aperture/color-256.ts because `opencode debug
  // aperture-colors` needs the same answers on a participant's machine. Spot-check the table
  // against the published xterm-256 formulae first, so a bug in the shared module can't make
  // the guards below vacuously pass.
  test("the xterm-256 table matches the standard formulae", () => {
    expect(XTERM_256).toHaveLength(256)
    expect(XTERM_256[0]).toEqual([0, 0, 0])
    expect(XTERM_256[15]).toEqual([255, 255, 255])
    expect(XTERM_256[16]).toEqual([0, 0, 0]) // cube origin
    expect(XTERM_256[231]).toEqual([255, 255, 255]) // cube corner
    expect(XTERM_256[232]).toEqual([8, 8, 8]) // grey ramp start
    expect(XTERM_256[255]).toEqual([238, 238, 238]) // grey ramp end
    // The two cells the greys are meant to land on, and one the palette uses.
    expect(hexFromRgb(XTERM_256[244]!)).toBe("#808080")
    expect(hexFromRgb(XTERM_256[238]!)).toBe("#444444")
    expect(hexFromRgb(XTERM_256[161]!)).toBe("#D7005F")
  })

  // Every hex the product can emit, tagged with where it came from so a failure names it.
  const everyColor = (): Array<{ where: string; hex: string }> => [
    ...PALETTE_IDS.flatMap((id) => PALETTES[id].colors.map((hex) => ({ where: `palette "${id}"`, hex }))),
    ...BUILTIN_LENSES.flatMap((lens) =>
      lens.facets
        .filter((f) => f.color.startsWith("#"))
        .map((f) => ({ where: `lens "${lens.id}" facet "${f.id}"`, hex: f.color })),
    ),
    { where: "NONE_HUE", hex: NONE_HUE },
    { where: "UNTAGGED_HUE", hex: UNTAGGED_HUE },
  ]

  test("every paintable colour is an exact xterm-256 entry", () => {
    for (const { where, hex } of everyColor()) {
      if (!isExact(hex))
        throw new Error(
          `${where} colour ${hex} is not an exact xterm-256 entry — a 256-colour terminal would show ${hexFromRgb(XTERM_256[nearestIndex(hex)]!)} instead, so the TUI and VSCode would disagree. Pick a cube cell (channels from 0/95/135/175/215/255) or a grey-ramp cell (8+10k).`,
        )
    }
  })

  // Being an exact entry is necessary but not sufficient: entries 0-15 are the ones a
  // terminal theme repaints, so a colour that coincides with one is themed away even though
  // it quantises "exactly". #808080 is the trap — it is both grey-ramp 244 and system 8.
  test("no paintable colour coincides with a re-themable system colour (0-15)", () => {
    for (const { where, hex } of everyColor())
      if (collidesWithSystemColor(hex))
        throw new Error(
          `${where} colour ${hex} is also an xterm system colour (index 0-15), the range a terminal colour theme overrides — Solarized/Nord/Dracula would repaint it and it would stop matching VSCode. Move it one step along the grey ramp or into the colour cube.`,
        )
  })

  test("no two paintable colours are perceptually close", () => {
    // The closest legitimate pairs are the greys against the palette (ΔE ~23) and the two
    // greys against each other (26.4) — "Other" and "Non-code" are meant to read as
    // neighbouring greys, just separable ones. The palette's own minimum is 32.3.
    const MIN_DELTA_E = 20
    const all = everyColor()
    // Dedupe: the ramps are slices of the ordinal palette, so the same hex appears more than
    // once by design and comparing it with itself would trivially fail.
    const unique = [...new Map(all.map((c) => [c.hex, c])).values()]
    for (let i = 0; i < unique.length; i++)
      for (let j = i + 1; j < unique.length; j++) {
        const a = unique[i]!
        const b = unique[j]!
        const d = deltaE(a.hex, b.hex)
        if (d < MIN_DELTA_E)
          throw new Error(
            `${a.where} ${a.hex} and ${b.where} ${b.hex} are only ΔE2000 ${d.toFixed(1)} apart (need ${MIN_DELTA_E}) — they would read as the same facet colour.`,
          )
      }
  })

  test("architecture layer hues are drawn from the categorical palette", () => {
    // semantics.ts can't import PALETTES (lenses.ts imports semantics.ts), so its literals
    // are kept honest here instead.
    for (const layer of LAYERS) expect(PALETTES.categorical.colors).toContain(LAYER_HUE[layer])
  })

  test("assignColors pairs facets with palette colours in order", () => {
    const facets = [
      { id: "a", label: "A", description: "first" },
      { id: "b", label: "B", description: "second" },
    ]
    const out = assignColors("categorical", facets)
    expect(out.map((t) => t.color)).toEqual([PALETTES.categorical.colors[0], PALETTES.categorical.colors[1]])
  })

  test("architecture is the global built-in mirroring LAYERS with literal hex colours", () => {
    expect(ARCHITECTURE.id).toBe(ARCHITECTURE_ID)
    expect(ARCHITECTURE.scope).toBe("global")
    expect(ARCHITECTURE.facets.map((t) => t.id)).toEqual([...LAYERS])
    // Hex, not theme roles: the roles resolved differently in the TUI and in VSCode, which
    // made this Lens the worst cross-surface colour mismatch in the product (PLAN C1).
    for (const t of ARCHITECTURE.facets) expect(t.color).toMatch(/^#[0-9A-Fa-f]{6}$/)
  })

  test("isValidFacet only accepts ids in the Lens", () => {
    expect(isValidFacet(ARCHITECTURE, "domain")).toBe(true)
    expect(isValidFacet(ARCHITECTURE, "nope")).toBe(false)
    expect(isValidFacet(ARCHITECTURE, 5)).toBe(false)
  })

  test("legend exposes facet/label/colour per facet", () => {
    const l = legend(ARCHITECTURE)
    expect(l.length).toBe(ARCHITECTURE.facets.length)
    expect(l[0]).toEqual({
      facet: ARCHITECTURE.facets[0]!.id,
      label: ARCHITECTURE.facets[0]!.label,
      color: ARCHITECTURE.facets[0]!.color,
    })
  })

  test("buildSystemPrompt includes the prompt, every facet id, and the none escape", () => {
    const sys = buildSystemPrompt(ARCHITECTURE)
    expect(sys).toContain(ARCHITECTURE.prompt)
    for (const t of ARCHITECTURE.facets) expect(sys).toContain(`- ${t.id}:`)
    expect(sys).toContain(`- ${NONE_FACET}:`)
    expect(sys).toContain("echoing its exact path")
  })

  test("buildSystemPrompt tells the model about the skeleton only in medium context", () => {
    const minimal = buildSystemPrompt(ARCHITECTURE)
    expect(minimal).toContain("Infer the facet from the file path, its imports, and its leading comment.")
    expect(minimal).not.toContain("declaration skeleton")

    const medium = buildSystemPrompt({ ...ARCHITECTURE, context: "medium" })
    expect(medium).toContain("declaration skeleton")
    expect(medium).toContain("signature and length in lines")
  })

  test("the none escape is assignable/enumerable but not a real facet", () => {
    // The model may pick `none`, but it is never a defined facet or legend entry.
    expect(isValidFacet(ARCHITECTURE, NONE_FACET)).toBe(false)
    expect(isAssignableFacet(ARCHITECTURE, NONE_FACET)).toBe(true)
    expect(isAssignableFacet(ARCHITECTURE, "domain")).toBe(true)
    expect(isAssignableFacet(ARCHITECTURE, "bogus")).toBe(false)
    const ids = facetEnumIds(ARCHITECTURE)
    expect(ids).toContain(NONE_FACET)
    for (const t of ARCHITECTURE.facets) expect(ids).toContain(t.id)
    expect(legend(ARCHITECTURE).some((e) => e.facet === NONE_FACET)).toBe(false)
  })

  // The guard on the legend filter (O4): a filter is only ever meaningful in the vocabulary
  // it was expressed against, and facet ids are slugs that unrelated Lenses can share.
  test("facetsWithin keeps only the active Lens's facets, plus Other", () => {
    const own = ARCHITECTURE.facets.map((t) => t.id)
    expect(facetsWithin(ARCHITECTURE, own)).toEqual(new Set(own))
    // "Other" is filterable — it is a real stored facet, just never a legend entry.
    expect(facetsWithin(ARCHITECTURE, [NONE_FACET])).toEqual(new Set([NONE_FACET]))
    // An id from some other Lens is dropped rather than left to grey a facet later.
    expect(facetsWithin(ARCHITECTURE, ["not-a-facet"])).toEqual(new Set())
    expect(facetsWithin(ARCHITECTURE, [own[0]!, "not-a-facet", own[0]!])).toEqual(new Set([own[0]!]))
    expect(facetsWithin(ARCHITECTURE, [])).toEqual(new Set())
  })

  test("slugify produces kebab ids", () => {
    expect(slugify("Auth Flow!")).toBe("auth-flow")
    expect(slugify("  --weird__Name  ")).toBe("weird-name")
    expect(slugify("")).toBe("lens")
  })
})

// S2. `usesPainter` is the predicate behind every painter gate in aperture.ts, and rule-owned
// facets are what let a marked concern live on a painted Lens for free. Both are single points
// of truth for behaviour that is otherwise spread across a dozen call sites, so they are pinned
// here rather than left to an integration test that needs the whole layer.
describe("aperture lenses — search rules (S2)", () => {
  const SEARCH: Lens = {
    id: "retry-handling-0000",
    name: "Retry Handling",
    description: "where retries happen",
    palette: "categorical",
    prompt: "",
    scope: "project",
    search: true,
    facets: assignColors("categorical", [
      { id: "retry-path", label: "retry-path", description: "the retry path", ruleOnly: true },
    ]),
    rules: [{ id: "retry-path-abc", facet: "retry-path", find: { kind: "pattern", pattern: "withRetry\\(" } }],
  }

  test("usesPainter is false for exactly the Lenses that cost no tokens", () => {
    // The whole point: before S2 every gate tested isDeterministic alone, so a Search Lens
    // would have triggered a whole-repo model sweep the moment it was activated.
    expect(usesPainter(ARCHITECTURE)).toBe(true)
    for (const builtin of [GIT_CHANGED, MTIME_RECENCY]) expect(usesPainter(builtin)).toBe(false)
    expect(usesPainter(SEARCH)).toBe(false)
    expect(usesPainter({ ...SEARCH, deterministic: "git-changed" })).toBe(false)
    expect(usesPainter({ search: undefined, deterministic: undefined })).toBe(true)
  })

  test("a rule-owned facet is in the legend and the palette but not the painter's vocabulary", () => {
    const mixed: Lens = {
      ...ARCHITECTURE,
      facets: assignColors("categorical", [
        ...ARCHITECTURE.facets.slice(0, 2).map((t) => ({ id: t.id, label: t.label, description: t.description })),
        { id: "any-casts", label: "any-casts", description: "casts to any", ruleOnly: true },
      ]),
    }
    // Excluded from the painter, which is what makes minting one owe no repaint — and what
    // stops the painter assigning "any-casts" to a file by judgement.
    expect(facetEnumIds(mixed)).not.toContain("any-casts")
    expect(buildSystemPrompt(mixed)).not.toContain("any-casts")
    expect(isAssignableFacet(mixed, "any-casts")).toBe(false)
    // Present everywhere the *user* meets a facet.
    expect(paintedFacets(mixed).map((t) => t.id)).toEqual(mixed.facets.slice(0, 2).map((t) => t.id))
    expect(legend(mixed).map((e) => e.facet)).toContain("any-casts")
    expect(facetsWithin(mixed, ["any-casts"])).toEqual(new Set(["any-casts"]))
    expect(mixed.facets.find((t) => t.id === "any-casts")!.color).toBe(PALETTES.categorical.colors[2])
    // Still a facet of the Lens — `isValidFacet` answers membership, not paintability.
    expect(isValidFacet(mixed, "any-casts")).toBe(true)
  })

  test("a Search Lens offers the painter nothing but the escape facet", () => {
    expect(facetEnumIds(SEARCH)).toEqual([NONE_FACET])
    expect(paintedFacets(SEARCH)).toEqual([])
  })

  test("concernRoster counts rules per concern and names the hue", () => {
    const roster = concernRoster(SEARCH)
    expect(roster).toEqual([
      {
        facet: "retry-path",
        label: "retry-path",
        color: PALETTES.categorical.colors[0]!,
        colorName: "crimson",
        ruleOnly: true,
        rules: 1,
      },
    ])
    // A concern with no rules yet still shows, at 0 — that state is reachable via lens_unmark
    // by rule id, and it is exactly what the agent needs to see to reuse rather than mint.
    expect(concernRoster({ facets: SEARCH.facets, rules: [] })[0]!.rules).toBe(0)
    for (const hex of PALETTES.categorical.colors) expect(COLOR_NAMES[hex]).toBeTruthy()
  })

  test("finderProblem names the fix, and isValidFinder agrees with it", () => {
    const ok: unknown[] = [
      { kind: "pattern", pattern: "x" },
      { kind: "pattern", pattern: "x", glob: ["a/**"], caseSensitive: false },
      { kind: "symbol", name: "retryWithBackoff" },
      { kind: "symbol", name: "f", path: "packages/opencode" },
      { kind: "structural", pattern: "$A.get($$$B)", language: "ts" },
    ]
    for (const find of ok) {
      expect(finderProblem(find)).toBeUndefined()
      expect(isValidFinder(find)).toBe(true)
    }

    // Each message has to name the missing field, because this is the *only* place a shape
    // mistake can be reported: lens_mark takes a flat struct precisely so these land inside
    // execute() instead of as an opaque schema-decode failure the tool can't intercept.
    const bad: Array<[unknown, string]> = [
      [{ kind: "pattern" }, "pattern"],
      [{ kind: "pattern", pattern: "" }, "pattern"],
      [{ kind: "pattern", pattern: "x", glob: "a/**" }, "glob"],
      [{ kind: "symbol" }, "name"],
      [{ kind: "symbol", name: "f", path: 3 }, "path"],
      [{ kind: "structural", pattern: "x" }, "language"],
      [{ kind: "structural", language: "ts" }, "pattern"],
      [{ kind: "regex", pattern: "x" }, "regex"],
      [{}, "kind"],
      [null, "object"],
      ["nope", "object"],
    ]
    for (const [find, mentions] of bad) {
      const problem = finderProblem(find)
      expect(problem, JSON.stringify(find)).toContain(mentions)
      expect(isValidFinder(find)).toBe(false)
    }
  })

  // KNOWN AND DELIBERATE: facet colour is derived from array position, so removing a facet
  // re-hues every facet after it. lens_unmark reports the shift (see UnmarkResult.recolored)
  // rather than persisting a colour slot, which would be a second source of truth and a wire
  // change through payload.ts and the extension's generated colour ids. Pinned here so nobody
  // "fixes" it silently and quietly breaks that contract.
  test("removing a middle facet re-colours the ones after it", () => {
    const three = assignColors("categorical", [
      { id: "a", label: "a", description: "" },
      { id: "b", label: "b", description: "" },
      { id: "c", label: "c", description: "" },
    ])
    const without = assignColors(
      "categorical",
      three.filter((t) => t.id !== "b"),
    )
    expect(without.find((t) => t.id === "a")!.color).toBe(three[0]!.color)
    expect(without.find((t) => t.id === "c")!.color).toBe(three[1]!.color)
    expect(without.find((t) => t.id === "c")!.color).not.toBe(three[2]!.color)
  })
})

describe("aperture deterministic built-ins", () => {
  test("git-changed and edit-recency are global, immutable, deterministic built-ins", () => {
    for (const c of [GIT_CHANGED, MTIME_RECENCY]) {
      expect(BUILTIN_LENSES).toContain(c)
      expect(c.scope).toBe("global")
      expect(isBuiltinLens(c)).toBe(true)
      expect(isDeterministic(c)).toBe(true)
    }
    // The semantic built-in stays non-deterministic (still painter-driven).
    expect(isDeterministic(ARCHITECTURE)).toBe(false)
  })

  test("git-changed has five change-magnitude buckets + unchanged; edit-recency has the six ordinal recency facets", () => {
    expect(GIT_CHANGED.facets.map((t) => t.id)).toEqual([...CHANGE_FACET_IDS, "unchanged"])
    expect(CHANGE_FACET_IDS.length).toBe(5)
    // Five buckets + unchanged fills MAX_FACETS exactly.
    expect(GIT_CHANGED.facets.length).toBe(MAX_FACETS)
    // The five buckets carry a cold→hot slice of the ordinal ramp; "unchanged" recedes to
    // the same grey as "Other", so a file with no changes reads as "not what you're looking at".
    expect(GIT_CHANGED.facets.slice(0, 5).map((t) => t.color)).toEqual([...PALETTES.ordinal.colors].slice(1))
    expect(GIT_CHANGED.facets.find((t) => t.id === "unchanged")!.color).toBe(NONE_HUE)
    expect(MTIME_RECENCY.facets.map((t) => t.id)).toEqual([...RECENCY_FACET_IDS])
    expect(RECENCY_FACET_IDS.length).toBe(6)
    // Recency colours are concrete hex (an ordinal ramp), not theme roles.
    for (const t of MTIME_RECENCY.facets) expect(t.color).toMatch(/^#[0-9A-Fa-f]{6}$/)
  })

  test("changeBucketIndex maps line churn to the right band (edges lower-inclusive of the next)", () => {
    expect(changeBucketIndex(0)).toBe(0)
    expect(changeBucketIndex(9)).toBe(0)
    expect(changeBucketIndex(10)).toBe(1)
    expect(changeBucketIndex(24)).toBe(1)
    expect(changeBucketIndex(25)).toBe(2)
    expect(changeBucketIndex(49)).toBe(2)
    expect(changeBucketIndex(50)).toBe(3)
    expect(changeBucketIndex(99)).toBe(3)
    expect(changeBucketIndex(100)).toBe(4)
    expect(changeBucketIndex(5000)).toBe(4)
  })

  test("git-changed heat-ramp colours never quantise onto the 256-colour grey ramp", () => {
    // Same nearest-cube check the palette-grey test applies; the warm ramp lives on GIT_CHANGED
    // rather than a palette, so guard it here. Reuses a minimal cube-cell membership check:
    // every channel must be an exact colour-cube level, with at least two distinct levels.
    const cube = new Set([0, 95, 135, 175, 215, 255])
    for (const id of CHANGE_FACET_IDS) {
      const hex = GIT_CHANGED.facets.find((t) => t.id === id)!.color
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
      expect(cube.has(r) && cube.has(g) && cube.has(b)).toBe(true)
      expect(new Set([r, g, b]).size).toBeGreaterThan(1)
    }
  })

  test("bucketIndex splits [min,max] into equal time spans, clamping the top edge", () => {
    // Range 0..600 over 6 buckets → width 100; values land in their span, max clamps to 5.
    expect(bucketIndex(0, 0, 600)).toBe(0)
    expect(bucketIndex(50, 0, 600)).toBe(0)
    expect(bucketIndex(150, 0, 600)).toBe(1)
    expect(bucketIndex(550, 0, 600)).toBe(5)
    expect(bucketIndex(600, 0, 600)).toBe(5)
  })

  test("bucketIndex collapses a degenerate range (all-equal / single file) to bucket 0", () => {
    expect(bucketIndex(1000, 1000, 1000)).toBe(0)
    expect(bucketIndex(5, 10, 0)).toBe(0)
  })
})

describe("aperture payload v7", () => {
  test("decodes a Lens payload (string facets + legend)", async () => {
    const payload = {
      version: AperturePayload.PAYLOAD_VERSION,
      nodes: [{ id: "n1", path: "src/a.ts", kind: "file", size: 10, position: { layer: 0, index: 0 } }],
      edges: [],
      semantics: { n1: { facets: ["auth"], hue: "#4E79A7" } },
      composition: {
        d1: {
          weights: [{ facet: "auth", count: 1, bytes: 10 }],
          totalCount: 1,
          totalBytes: 10,
          subtreeCount: 1,
          subtreeBytes: 10,
        },
      },
      lens: { id: "auth-x", name: "Auth", legend: [{ facet: "auth", label: "Auth", color: "#4E79A7" }] },
    }
    const decoded = await Effect.runPromise(AperturePayload.decodeUnknown(payload))
    expect(decoded.lens?.id).toBe("auth-x")
    expect(decoded.composition?.["d1"]!.weights[0]!.facet).toBe("auth")
    expect(decoded.semantics["n1"]!.facets[0]).toBe("auth")
  })

  test("version is 7 and a payload without extents still decodes (omitted when not drilled)", async () => {
    expect(AperturePayload.PAYLOAD_VERSION).toBe(7)
    const decoded = await Effect.runPromise(
      AperturePayload.decodeUnknown({
        version: AperturePayload.PAYLOAD_VERSION,
        nodes: [],
        edges: [],
        semantics: {},
      }),
    )
    expect(decoded.extents).toBeUndefined()
  })

  test("decodes drill-in extents keyed by file node id, painted and unpainted tiles", async () => {
    const decoded = await Effect.runPromise(
      AperturePayload.decodeUnknown({
        version: AperturePayload.PAYLOAD_VERSION,
        nodes: [{ id: "n1", path: "src/a.ts", kind: "file", size: 10, position: { layer: 0, index: 0 } }],
        edges: [],
        semantics: {},
        extents: {
          n1: [
            { name: "(preamble)", startLine: 1, endLine: 2 },
            { name: "login", startLine: 3, endLine: 9, facet: "auth", hue: "#4E79A7" },
          ],
        },
      }),
    )
    const tiles = decoded.extents?.["n1"]!
    expect(tiles).toHaveLength(2)
    // Unpainted preamble carries no facet/hue; the painted function does.
    expect(tiles[0]!.facet).toBeUndefined()
    expect(tiles[1]).toEqual({ name: "login", startLine: 3, endLine: 9, facet: "auth", hue: "#4E79A7" })
  })
})
