import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  PALETTES,
  PALETTE_IDS,
  MAX_TAGS,
  ARCHITECTURE,
  ARCHITECTURE_ID,
  assignColors,
  isValidTag,
  isAssignableTag,
  tagEnumIds,
  NONE_TAG,
  legend,
  buildSystemPrompt,
  slugify,
} from "@/codegraph/collections"
import { LAYERS } from "@/codegraph/semantics"
import { CodeGraphPayload } from "@/codegraph/payload"

describe("codegraph collections", () => {
  test("four categorical palettes, each at least MAX_TAGS colours", () => {
    expect(PALETTE_IDS.sort()).toEqual(["bright", "dark", "earthy", "pastel"])
    for (const id of PALETTE_IDS) {
      expect(PALETTES[id].colors.length).toBeGreaterThanOrEqual(MAX_TAGS)
      for (const c of PALETTES[id].colors) expect(c).toMatch(/^#[0-9A-Fa-f]{6}$/)
    }
  })

  test("assignColors pairs tags with palette colours in order", () => {
    const tags = [
      { id: "a", label: "A", description: "first" },
      { id: "b", label: "B", description: "second" },
    ]
    const out = assignColors("bright", tags)
    expect(out.map((t) => t.color)).toEqual([PALETTES.bright.colors[0], PALETTES.bright.colors[1]])
  })

  test("architecture is the global built-in mirroring LAYERS with theme-role colours", () => {
    expect(ARCHITECTURE.id).toBe(ARCHITECTURE_ID)
    expect(ARCHITECTURE.scope).toBe("global")
    expect(ARCHITECTURE.tags.map((t) => t.id)).toEqual([...LAYERS])
    // Architecture keeps theme-role keys (not hex) so it stays theme-adaptive.
    for (const t of ARCHITECTURE.tags) expect(t.color.startsWith("#")).toBe(false)
  })

  test("isValidTag only accepts ids in the collection", () => {
    expect(isValidTag(ARCHITECTURE, "domain")).toBe(true)
    expect(isValidTag(ARCHITECTURE, "nope")).toBe(false)
    expect(isValidTag(ARCHITECTURE, 5)).toBe(false)
  })

  test("legend exposes tag/label/colour per tag", () => {
    const l = legend(ARCHITECTURE)
    expect(l.length).toBe(ARCHITECTURE.tags.length)
    expect(l[0]).toEqual({
      tag: ARCHITECTURE.tags[0]!.id,
      label: ARCHITECTURE.tags[0]!.label,
      color: ARCHITECTURE.tags[0]!.color,
    })
  })

  test("buildSystemPrompt includes the prompt, every tag id, and the none escape", () => {
    const sys = buildSystemPrompt(ARCHITECTURE)
    expect(sys).toContain(ARCHITECTURE.prompt)
    for (const t of ARCHITECTURE.tags) expect(sys).toContain(`- ${t.id}:`)
    expect(sys).toContain(`- ${NONE_TAG}:`)
    expect(sys).toContain("echoing its exact path")
  })

  test("the none escape is assignable/enumerable but not a real tag", () => {
    // The model may pick `none`, but it is never a defined tag or legend entry.
    expect(isValidTag(ARCHITECTURE, NONE_TAG)).toBe(false)
    expect(isAssignableTag(ARCHITECTURE, NONE_TAG)).toBe(true)
    expect(isAssignableTag(ARCHITECTURE, "domain")).toBe(true)
    expect(isAssignableTag(ARCHITECTURE, "bogus")).toBe(false)
    const ids = tagEnumIds(ARCHITECTURE)
    expect(ids).toContain(NONE_TAG)
    for (const t of ARCHITECTURE.tags) expect(ids).toContain(t.id)
    expect(legend(ARCHITECTURE).some((e) => e.tag === NONE_TAG)).toBe(false)
  })

  test("slugify produces kebab ids", () => {
    expect(slugify("Auth Flow!")).toBe("auth-flow")
    expect(slugify("  --weird__Name  ")).toBe("weird-name")
    expect(slugify("")).toBe("collection")
  })
})

describe("codegraph payload v5", () => {
  test("decodes a tag-collection payload (string tags + legend)", async () => {
    const payload = {
      version: CodeGraphPayload.PAYLOAD_VERSION,
      nodes: [{ id: "n1", path: "src/a.ts", kind: "file", size: 10, position: { layer: 0, index: 0 } }],
      edges: [],
      semantics: { n1: { tags: ["auth"], hue: "#4E79A7" } },
      composition: {
        d1: { weights: [{ tag: "auth", count: 1, bytes: 10 }], totalCount: 1, totalBytes: 10, subtreeCount: 1, subtreeBytes: 10 },
      },
      collection: { id: "auth-x", name: "Auth", legend: [{ tag: "auth", label: "Auth", color: "#4E79A7" }] },
    }
    const decoded = await Effect.runPromise(CodeGraphPayload.decodeUnknown(payload))
    expect(decoded.collection?.id).toBe("auth-x")
    expect(decoded.composition?.["d1"]!.weights[0]!.tag).toBe("auth")
    expect(decoded.semantics["n1"]!.tags[0]).toBe("auth")
  })
})
