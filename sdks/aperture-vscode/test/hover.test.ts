import { describe, expect, test } from "bun:test"
import { lineHover, swatch } from "../src/hover"

const LEGEND = [
  {
    facet: "retry",
    label: "retry-path",
    color: "#AF5F00",
    what: "Every place a failed send is re-queued.",
    why: "The duplicate starts here.",
  },
  { facet: "flags", label: "flag_reads", color: "#00875F", what: "", why: "" },
  { facet: "unused", label: "unused", color: "#5F5FD7" },
]

describe("swatch", () => {
  // VSCode's sanitizer keeps the style only in exactly this form, trailing semicolon included.
  test("is a span in the exact hex the sanitizer allows", () => {
    expect(swatch("#D7005F")).toBe('<span style="color:#D7005F;">■</span>')
  })
})

describe("lineHover", () => {
  test("lists every facet on the line in legend order: what, why, then this line's rules and notes", () => {
    const hover = lineHover(
      [
        { facet: "flags", query: "pattern /flag\\(/" },
        { facet: "retry", query: "symbol retry", note: "the definition" },
        { facet: "retry", query: "diff HEAD" },
        { facet: "retry", query: "symbol retry", note: "the definition" },
      ],
      LEGEND,
    )
    expect(hover).toBe(
      [
        '<span style="color:#AF5F00;">■</span> **retry\\-path** — Every place a failed send is re\\-queued\\.  \n*Why:* The duplicate starts here\\.  \n`symbol retry` — the definition  \n`diff HEAD`',
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
