import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
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
  isAssignableFacet,
  facetEnumIds,
  NONE_FACET,
  legend,
  buildSystemPrompt,
  slugify,
} from "@/aperture/lenses"
import { LAYERS } from "@/aperture/semantics"
import { AperturePayload } from "@/aperture/payload"

describe("aperture lenses", () => {
  test("categorical + ordinal palettes, each at least MAX_FACETS colours", () => {
    expect(PALETTE_IDS.sort()).toEqual([
      "bright",
      "bright-ordinal",
      "dark",
      "dark-ordinal",
      "earthy",
      "pastel",
      "pastel-ordinal",
    ])
    const categorical = PALETTE_IDS.filter((id) => PALETTES[id].kind === "categorical")
    const ordinal = PALETTE_IDS.filter((id) => PALETTES[id].kind === "ordinal")
    expect(categorical.sort()).toEqual(["bright", "dark", "earthy", "pastel"])
    expect(ordinal.sort()).toEqual(["bright-ordinal", "dark-ordinal", "pastel-ordinal"])
    expect(ORDINAL_PALETTE_IDS.sort()).toEqual(["bright-ordinal", "dark-ordinal", "pastel-ordinal"])
    for (const id of PALETTE_IDS) {
      expect(PALETTES[id].colors.length).toBeGreaterThanOrEqual(MAX_FACETS)
      for (const c of PALETTES[id].colors) expect(c).toMatch(/^#[0-9A-Fa-f]{6}$/)
    }
  })

  test("bright-ordinal palette is the source for the Edit recency heat-map colours", () => {
    expect(MTIME_RECENCY.facets.map((f) => f.color)).toEqual([...PALETTES["bright-ordinal"].colors])
  })

  // A palette colour that is dark *and* desaturated quantises onto the xterm-256 grey ramp
  // in a non-truecolor terminal, where it reads as — and collides with — the "Other"/Non-code
  // greys. Guard every categorical palette against that so a muted palette can't silently
  // regress to grey. See the note on PALETTES in lenses.ts.
  test("no categorical palette colour collapses to grey in 256-colour space", () => {
    // The xterm-256 palette: 16 system colours, a 6×6×6 colour cube, then a 24-step grey ramp.
    const cubeLevel = (i: number) => (i === 0 ? 0 : 55 + 40 * i)
    const xterm256: [number, number, number][] = [
      [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0], [0, 0, 128], [128, 0, 128],
      [0, 128, 128], [192, 192, 192], [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
      [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
    ]
    for (let r = 0; r < 6; r++)
      for (let g = 0; g < 6; g++)
        for (let b = 0; b < 6; b++) xterm256.push([cubeLevel(r), cubeLevel(g), cubeLevel(b)])
    for (let i = 0; i < 24; i++) xterm256.push([8 + 10 * i, 8 + 10 * i, 8 + 10 * i])

    const nearest = (hex: string): [number, number, number] => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
      let best = Infinity
      let winner = xterm256[0]!
      for (const p of xterm256) {
        const d = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2 + (c[2] - p[2]) ** 2
        if (d < best) [best, winner] = [d, p]
      }
      return winner
    }

    for (const id of PALETTE_IDS)
      for (const hex of PALETTES[id].colors) {
        const [r, g, b] = nearest(hex)
        const isGrey = r === g && g === b
        if (isGrey) throw new Error(`palette "${id}" colour ${hex} quantises to grey rgb(${r},${g},${b}) in 256-colour`)
        expect(isGrey).toBe(false)
      }
  })

  test("assignColors pairs facets with palette colours in order", () => {
    const facets = [
      { id: "a", label: "A", description: "first" },
      { id: "b", label: "B", description: "second" },
    ]
    const out = assignColors("bright", facets)
    expect(out.map((t) => t.color)).toEqual([PALETTES.bright.colors[0], PALETTES.bright.colors[1]])
  })

  test("architecture is the global built-in mirroring LAYERS with theme-role colours", () => {
    expect(ARCHITECTURE.id).toBe(ARCHITECTURE_ID)
    expect(ARCHITECTURE.scope).toBe("global")
    expect(ARCHITECTURE.facets.map((t) => t.id)).toEqual([...LAYERS])
    // Architecture keeps theme-role keys (not hex) so it stays theme-adaptive.
    for (const t of ARCHITECTURE.facets) expect(t.color.startsWith("#")).toBe(false)
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

  test("slugify produces kebab ids", () => {
    expect(slugify("Auth Flow!")).toBe("auth-flow")
    expect(slugify("  --weird__Name  ")).toBe("weird-name")
    expect(slugify("")).toBe("lens")
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
    // The five buckets carry a warm hex heat ramp; "unchanged" is a muted theme role.
    for (const id of CHANGE_FACET_IDS) {
      const facet = GIT_CHANGED.facets.find((t) => t.id === id)!
      expect(facet.color).toMatch(/^#[0-9A-Fa-f]{6}$/)
    }
    expect(GIT_CHANGED.facets.find((t) => t.id === "unchanged")!.color).toBe("textMuted")
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
        d1: { weights: [{ facet: "auth", count: 1, bytes: 10 }], totalCount: 1, totalBytes: 10, subtreeCount: 1, subtreeBytes: 10 },
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
