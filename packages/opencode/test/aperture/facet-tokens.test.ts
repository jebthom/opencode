import { describe, expect, test } from "bun:test"
import { RGBA, TextAttributes, type TextChunk } from "@opentui/core"
import { tintFacetTokens } from "../../src/cli/cmd/tui/feature-plugins/system/aperture-tokens"

const legend = [
  { facet: "retry-path", label: "retry-path", color: "#AF5F00" },
  { facet: "retry-path-v2", label: "Retry path v2", color: "#00875F" },
]
const muted = RGBA.fromInts(128, 128, 128)
const chunk = (text: string, attributes = 0): TextChunk => ({ __isChunk: true, text, fg: muted, attributes })
const hex = (c: TextChunk) =>
  c.fg
    ?.toInts()
    .slice(0, 3)
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()

describe("tintFacetTokens", () => {
  test("paints the square in the facet's exact hex and bolds the name", () => {
    const out = tintFacetTokens([chunk("I marked ■ retry-path, where it loops.")], legend)
    expect(out.map((c) => c.text).join("")).toBe("I marked ■ retry-path, where it loops.")
    const square = out.find((c) => c.text === "■")!
    expect(hex(square)).toBe("AF5F00")
    const name = out.find((c) => c.text === "retry-path")!
    expect(name.attributes! & TextAttributes.BOLD).toBeTruthy()
    expect(hex(out[0]!)).toBe("808080")
  })

  test("matches across chunks, by label, case-insensitively, longest name first", () => {
    const out = tintFacetTokens([chunk("see ■ "), chunk("retry path V2", 4), chunk(" next")], legend)
    expect(hex(out.find((c) => c.text === "■")!)).toBe("00875F")
    expect(out.find((c) => c.text === "retry path V2")!.attributes).toBe(4 | TextAttributes.BOLD)
  })

  test("prefers the longer id when one name prefixes another", () => {
    const out = tintFacetTokens([chunk("■retry-path-v2 and ■ `retry-path`")], legend)
    expect(out.filter((c) => c.text === "■").map(hex)).toEqual(["00875F", "AF5F00"])
  })

  test("leaves unknown names and partial words alone", () => {
    const input = [chunk("■ retry-paths and ■ other")]
    expect(tintFacetTokens(input, legend)).toBe(input)
  })
})
