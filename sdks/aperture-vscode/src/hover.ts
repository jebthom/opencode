// Hover markdown for the gutter and the tree. VSCode-free so it can be unit tested.
//
// Colour is the point of the interface, so the ■ is the facet's exact hex rather than an emoji
// approximation. VSCode's markdown sanitizer keeps a span's style only in the exact form
// `color:#hex;` (trailing semicolon included), and only when the MarkdownString has
// `supportHtml` set — every caller must set it.

export type HoverLegendEntry = {
  facet: string
  label: string
  color: string
  what?: string
  why?: string
  queries?: ReadonlyArray<string>
}

// The tags covering one line: which facet, the query of the rule that marked it, and that rule's
// note (which part of the concern it marks).
export type HoverTag = { facet?: string; query?: string; note?: string }

export function swatch(hex: string): string {
  return `<span style="color:${hex};">■</span>`
}

// Every facet on a line, in legend order: `■ Label — what`, then `Why: why`, then the rules that
// marked THIS line (not every rule on the facet — the gutter answers "why is this line here"), each
// as its query and note.
export function lineHover(tags: ReadonlyArray<HoverTag>, legend: ReadonlyArray<HoverLegendEntry>): string {
  return legend
    .filter((entry) => tags.some((t) => t.facet === entry.facet))
    .map((entry) => {
      const rules = [
        ...new Set(
          tags
            .filter((t) => t.facet === entry.facet && t.query)
            .map((t) => `\`${t.query!.replaceAll("`", "'")}\`` + (t.note ? ` — ${escapeMarkdown(t.note)}` : "")),
        ),
      ]
      const what = entry.what ? ` — ${escapeMarkdown(entry.what)}` : ""
      return [
        `${swatch(entry.color)} **${escapeMarkdown(entry.label)}**${what}`,
        ...(entry.why ? [`*Why:* ${escapeMarkdown(entry.why)}`] : []),
        ...rules,
      ].join("  \n")
    })
    .join("\n\n")
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!<>|~]/g, "\\$&")
}
