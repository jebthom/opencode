import { describe, expect, test } from "bun:test"
import { blend, lineBands, MAX_BANDS, MUTED_HEX } from "../src/line-color"

describe("lineBands", () => {
  test("a single facet paints its exact hex", () => {
    expect(lineBands(["#4E79A7"])).toEqual(["#4E79A7"])
  })

  test("an active facet overdraws the muted hue whichever order they arrive in", () => {
    expect(lineBands(["#4E79A7", MUTED_HEX])).toEqual(["#4E79A7"])
    expect(lineBands([MUTED_HEX, "#4e79a7"])).toEqual(["#4E79A7"])
  })

  test("a line with only muted tags stays muted", () => {
    expect(lineBands([MUTED_HEX, MUTED_HEX.toLowerCase()])).toEqual([MUTED_HEX])
  })

  test("distinct active facets each keep their exact hex, ignoring the muted hue and duplicates", () => {
    expect(lineBands(["#FF0000", "#0000FF", MUTED_HEX])).toEqual(["#0000FF", "#FF0000"])
    expect(lineBands(["#FF0000", "#ff0000", "#0000FF"])).toEqual(["#0000FF", "#FF0000"])
  })

  test("bands follow legend order whichever order the tags arrive in", () => {
    const order = ["#ff0000", "#00FF00", "#0000FF"]
    expect(lineBands(["#0000FF", "#FF0000"], order)).toEqual(["#FF0000", "#0000FF"])
    expect(lineBands(["#FF0000", "#0000FF"], order)).toEqual(["#FF0000", "#0000FF"])
    expect(lineBands(["#123456", "#0000FF"], order)).toEqual(["#0000FF", "#123456"])
  })

  test("caps at MAX_BANDS, keeping the legend's earliest facets", () => {
    const order = ["#000001", "#000002", "#000003", "#000004"]
    expect(lineBands([...order].reverse(), order)).toEqual(order.slice(0, MAX_BANDS))
  })

  test("no tags, no bands", () => {
    expect(lineBands([])).toEqual([])
  })
})

describe("blend", () => {
  test("averages the bands for the overview ruler", () => {
    expect(blend(["#FF0000", "#0000FF"])).toBe("#800080")
    expect(blend(["#4E79A7"])).toBe("#4E79A7")
  })
})
