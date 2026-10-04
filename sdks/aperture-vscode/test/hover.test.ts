import { describe, expect, test } from "bun:test"
import { lineHover, swatch } from "../src/hover"

const LEGEND = [
  { facet: "retry", label: "retry-path", color: "#AF5F00", reason: "Where a failed send re-enters the queue." },
  { facet: "flags", label: "flag_reads", color: "#00875F", reason: "" },
  { facet: "unused", label: "unused", color: "#5F5FD7" },
]

describe("swatch", () => {
  // VSCode's sanitizer keeps the style only in exactly this form, trailing semicolon included.
  test("is a span in the exact hex the sanitizer allows", () => {
    expect(swatch("#D7005F")).toBe('<span style="color:#D7005F;">■</span>')
  })
})

describe("lineHover", () => {
  test("lists every facet on the line in legend order, with its reason and this line's queries", () => {
    const hover = lineHover(
      [
        { facet: "flags", query: "pattern /flag\\(/" },
        { facet: "retry", query: "symbol retry" },
        { facet: "retry", query: "diff HEAD" },
        { facet: "retry", query: "symbol retry" },
      ],
      LEGEND,
    )
    expect(hover).toBe(
      [
        '<span style="color:#AF5F00;">■</span> **retry\\-path** — Where a failed send re\\-enters the queue\\.  \n`symbol retry`  \n`diff HEAD`',
        '<span style="color:#00875F;">■</span> **flag\\_reads**  \n`pattern /flag\\(/`',
      ].join("\n\n"),
    )
  })

  test("keeps a backtick in a query from closing its code span", () => {
    expect(lineHover([{ facet: "flags", query: "pattern /`x`/" }], LEGEND)).toContain("`pattern /'x'/`")
  })

  test("a line with no known facet has no hover", () => {
    expect(lineHover([{ facet: "gone" }], LEGEND)).toBe("")
  })
})
