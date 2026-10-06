import { describe, expect, test } from "bun:test"
import { lineColor, MUTED_HEX } from "../src/line-color"

describe("lineColor", () => {
  test("a single facet paints its exact hex", () => {
    expect(lineColor(["#4E79A7"])).toBe("#4E79A7")
  })

  test("an active facet overdraws the muted hue whichever order they arrive in", () => {
    expect(lineColor(["#4E79A7", MUTED_HEX])).toBe("#4E79A7")
    expect(lineColor([MUTED_HEX, "#4e79a7"])).toBe("#4E79A7")
  })

  test("a line with only muted tags stays muted", () => {
    expect(lineColor([MUTED_HEX, MUTED_HEX.toLowerCase()])).toBe(MUTED_HEX)
  })

  test("distinct active facets blend, ignoring the muted hue and duplicates", () => {
    expect(lineColor(["#FF0000", "#0000FF", MUTED_HEX])).toBe("#800080")
    expect(lineColor(["#FF0000", "#ff0000", "#0000FF"])).toBe("#800080")
  })

  test("no tags, no colour", () => {
    expect(lineColor([])).toBeUndefined()
  })
})
