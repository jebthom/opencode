import {
  CodeRenderable,
  TextAttributes,
  TextTableRenderable,
  type OnChunksCallback,
  type Renderable,
  type TextChunk,
  type TextTableContent,
} from "@opentui/core"
import { hexToRgba, type LegendEntry } from "./aperture-colors"

// Facet tokens in chat prose. The agent writes `■ retry-path` (a ■, then a concern's id or label,
// optionally in backticks). The raw text already reads as "square + name" in any other client; the
// TUI paints the ■ in the concern's exact legend hex and bolds the name, the same pairing the top
// bar's detail region uses. Unknown names are left alone, so a stray ■ is just a ■.
//
// opentui's markdown only lets a caller replace whole top-level blocks (`renderNode`), not inline
// tokens, and a `renderNode` makes it destroy and rebuild the changed block on every streamed
// delta. A fresh streaming block draws nothing until its async highlight lands, so the reply
// flickers. Instead this runs as the markdown's `renderAfter`: after the markdown has settled its
// blocks for the frame and before any child renders, it hooks the styled chunks of each paragraph,
// heading and list item (a CodeRenderable whose `onChunks` runs after highlighting and conceal) and
// tints table cells. opentui updates blocks in place, so a hook stays on until the block is
// replaced, and a replacement is hooked before its first highlight.

export const FACET_TOKEN = "■"

const hooked = new WeakMap<
  CodeRenderable,
  { legend: ReadonlyArray<LegendEntry>; prior?: OnChunksCallback; hook: OnChunksCallback }
>()
const tinted = new WeakMap<TextTableRenderable, { legend: ReadonlyArray<LegendEntry>; content: TextTableContent }>()

export function tintFacetBlocks(node: Renderable, legend: ReadonlyArray<LegendEntry>) {
  if (node instanceof CodeRenderable) {
    if (!node.content.includes(FACET_TOKEN)) return
    const state = hooked.get(node)
    if (state && state.legend === legend && node.onChunks === state.hook) return
    // A hook from an earlier legend wraps the markdown's own callback (link detection); keep that.
    const prior = state && node.onChunks === state.hook ? state.prior : node.onChunks
    const hook: OnChunksCallback = async (chunks, ctx) =>
      tintFacetTokens((await prior?.(chunks, ctx)) ?? chunks, legend)
    hooked.set(node, { legend, prior, hook })
    node.onChunks = hook
    return
  }
  // A table's cells are chunks already; markdown replaces `content` whenever the table changes.
  if (node instanceof TextTableRenderable) {
    const state = tinted.get(node)
    if (state && state.legend === legend && state.content === node.content) return
    const content = node.content.map((row) => row.map((cell) => cell && tintFacetTokens(cell, legend)))
    tinted.set(node, { legend, content })
    node.content = content
    return
  }
  node.getChildren().forEach((child) => tintFacetBlocks(child as Renderable, legend))
}

export function tintFacetTokens(chunks: TextChunk[], legend: ReadonlyArray<LegendEntry>): TextChunk[] {
  const text = chunks.map((c) => c.text).join("")
  if (!text.includes(FACET_TOKEN)) return chunks
  // Longest name first, so "retry-path-v2" is not read as "retry-path".
  const names = legend
    .flatMap((e) => [e.facet, e.label].map((name) => ({ name: name.toLowerCase(), color: e.color })))
    .toSorted((a, b) => b.name.length - a.name.length)
  const spans = [...text.matchAll(/■[ \t]*`?/g)].flatMap((match) => {
    const start = match.index + match[0].length
    const hit = names.find(
      (n) =>
        text.slice(start, start + n.name.length).toLowerCase() === n.name &&
        !/[\w-]/.test(text[start + n.name.length] ?? ""),
    )
    if (!hit) return []
    return [
      { start: match.index, end: match.index + 1, fg: hexToRgba(hit.color) },
      { start, end: start + hit.name.length, bold: true },
    ]
  })
  if (spans.length === 0) return chunks
  return restyle(chunks, spans)
}

type Span = { start: number; end: number; fg?: TextChunk["fg"]; bold?: boolean }

// Split chunks at span edges and apply each span's style to the pieces inside it.
function restyle(chunks: TextChunk[], spans: Span[]): TextChunk[] {
  const offsets = chunks.reduce<number[]>((acc, c) => [...acc, acc.at(-1)! + c.text.length], [0])
  return chunks.flatMap((chunk, i) => {
    const from = offsets[i]!
    const to = offsets[i + 1]!
    const cuts = [
      ...new Set([from, ...spans.flatMap((s) => [s.start, s.end]).filter((n) => n > from && n < to), to]),
    ].toSorted((a, b) => a - b)
    return cuts.slice(0, -1).map((start, k) => {
      const span = spans.find((s) => s.start <= start && start < s.end)
      const text = chunk.text.slice(start - from, cuts[k + 1]! - from)
      if (!span) return { ...chunk, text }
      return {
        ...chunk,
        text,
        ...(span.fg ? { fg: span.fg } : {}),
        ...(span.bold ? { attributes: (chunk.attributes ?? 0) | TextAttributes.BOLD } : {}),
      }
    })
  })
}
