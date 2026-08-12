// The facet composition chip — the multi-colour bar that replaces the single-colour
// FileDecoration pip in the Aperture tree view.
//
// A FileDecoration gives one ThemeColor and a <=2-char badge, so O2 had to spend its whole
// budget saying *which* facet (colour) and *how much* (shade glyph). A TreeItem's iconPath
// is a URI, so we can hand VSCode a generated SVG instead and show the mix itself.
//
// Nothing here imports `vscode`: this is the pure reduction from "a file's facet weights"
// to "an SVG string", so it is unit-testable (test/chip.test.ts) and the layout can be
// swapped without touching the tree.

export type ChipLayout = "bar6" | "bar-proportional" | "mosaic6"
export type Theme = "light" | "dark"

export type FacetWeight = { f: number; p: number }
export type LegendEntry = { facet: string; label: string; color: string }

// One block of colour in the chip. `frac` is its share of the bar and the fracs sum to 1,
// so a quantized layout and a proportional one are the same shape and render through the
// same code — only how the fracs were derived differs.
export type Segment = { color: string; frac: number }

// Cells in the single-row quantized layout (`bar6`). Six is the *floor*, not a cap: a Lens
// can hold MAX_FACETS = 6 facets (lenses.ts) and NONE_FACET is appended after them, so a
// node can carry seven bands and a fixed six cells could not give them one each. Six was
// picked as "one cell per Lens facet" and then quietly failed the case it was picked for;
// `chipSegments` now widens the row to the band count when there are more than six.
export const CHIP_CELLS = 6

// The mosaic's cells, in fill order (each column bottom→top, then left to right — see
// `mosaicRects`). `cx`/`cw` are in units of one third of the bar's width, `row` in units of
// half its height (0 = top).
//
// Columns 0 and 1 are whole cells; column 2 is cut vertically into two half-width columns,
// so the chip is a 3x2 grid whose right third has four narrow cells instead of two wide
// ones. That asymmetry is the point: the left two thirds stay big enough to read the
// dominant facet at a glance, while the eight-slot budget is what makes "every facet present
// gets a cell" affordable for a node carrying all seven bands. A minor facet costs a sliver
// of the right third rather than a sixth of the whole chip.
const MOSAIC_CELLS: ReadonlyArray<{ cx: number; cw: number; row: number }> = [
  { cx: 0, cw: 1, row: 1 },
  { cx: 0, cw: 1, row: 0 },
  { cx: 1, cw: 1, row: 1 },
  { cx: 1, cw: 1, row: 0 },
  { cx: 2, cw: 0.5, row: 1 },
  { cx: 2, cw: 0.5, row: 0 },
  { cx: 2.5, cw: 0.5, row: 1 },
  { cx: 2.5, cw: 0.5, row: 0 },
]
export const MOSAIC_CELL_COUNT = MOSAIC_CELLS.length
const MOSAIC_COLS = 3
const MOSAIC_ROWS = 2
// Each cell's share of the bar: a whole cell is a third by a half, a narrow one half that.
// They sum to 1, so a mosaic Segment's `frac` means the same thing a bar Segment's does.
const mosaicFrac = (cell: (typeof MOSAIC_CELLS)[number]) => cell.cw / (MOSAIC_COLS * MOSAIC_ROWS)

// SVG geometry. VSCode renders a tree item's icon in a 16x16 CSS-pixel box, and a wider
// viewBox is only scaled back down into it — so 16px is a hard ceiling on the chip's width,
// and six cells can never be more than ~2.7px each. (It is vector, so on a HiDPI display
// that is 32 device pixels and stays crisp; the limit is perceptual width, not resolution.)
//
// Given the width is fixed, the bar takes the whole box rather than sitting inset in it.
// Height is the only dimension with any slack, and a bar that fills it reads as a block in
// the 22px row instead of as a sliver.
const BOX = 16
const BAR_X = 0
const BAR_W = 16
const BAR_H = 14
const BAR_Y = (BOX - BAR_H) / 2
const BAR_R = 2
// A proportional segment narrower than this is invisible; floor it and take the width back
// from the rest, so a 3% facet still registers as "there is a third colour here". Exported
// as a fraction of the bar so callers and tests read it off the geometry rather than
// restating it — the two drifted apart the first time the bar was resized.
const MIN_SEGMENT_PX = 1.5
export const MIN_SEGMENT_FRAC = MIN_SEGMENT_PX / BAR_W
// Cells overlap their neighbour by this much rather than abutting exactly. At 16px the
// renderer lands cell edges on fractional device pixels, and a sub-pixel gap shows up as a
// pale hairline between two colours.
const SEAM = 0.35

// Every hue the server sends is a literal `#RRGGBB` — user palettes, the deterministic
// ramps, the Architecture Lens's layer hues, and both greys (PLAN C1). There used to be a
// THEME_ROLE_HEX table here translating opencode theme-role tokens ("info", "textMuted") to
// per-theme hexes, mirrored by a THEME_ROLE_COLORS table in extension.ts that translated the
// same tokens to VSCode ThemeColor ids. The two disagreed with each other *and* with the TUI
// — "interface" was #3794FF here and #56b6c2 in the TUI — which is exactly the mismatch C1
// removed by making the server ship colour rather than a name for a colour.
//
// NONE_HUE from lenses.ts. Duplicated as a literal rather than imported because this file is
// bundled into the extension and deliberately has no dependency on the server package; it is
// only ever a fallback for a hue the server didn't send, since "Other" arrives over the wire
// with this exact value on it.
const MUTED_HEX = "#8A8A8A"

export function hexFor(hue: string | undefined): string {
  return hue?.startsWith("#") ? hue : MUTED_HEX
}

export interface SegmentOptions {
  readonly layout: ChipLayout
  // Facets toggled off in the legend. A suppressed facet greys **in place** rather than
  // being dropped: keeping its area is what lets two rows stay comparable, which is the
  // whole reason to filter rather than to search (PLAN O4).
  readonly suppressed?: ReadonlySet<string>
  readonly cells?: number
}

// Reduce a file's (or a rolled-up directory's) facet weights to the chip's segments.
//
// `weights` arrive descending by share, `f` indexing into `facets`. Returns [] for an
// unpainted node, which the caller renders as no icon at all rather than as an empty bar.
//
// Segments come out in **Lens facet order** (ascending `f`), not in the descending-share
// order the weights arrive in. Share order would put the dominant facet first and make
// every chip a different reading — the same two facets swap ends between two files, so
// the eye has to re-read the colours on every row instead of learning one layout. Facet
// order is the order the legend prints in and the order the TUI's treemap bands lay down
// (aperture.ts builds its Composition weights from `[...lens.facets, NONE_FACET]`), so a
// directory's chip, its block in the TUI bar, and the legend all sequence alike. It also
// lands NONE_FACET — the highest index, appended after the Lens's own facets — at the far
// end, which is where the TUI puts its untagged grey.
export function chipSegments(
  weights: ReadonlyArray<FacetWeight>,
  facets: ReadonlyArray<string>,
  legend: ReadonlyArray<LegendEntry>,
  opts: SegmentOptions,
): Segment[] {
  const colored: Array<{ color: string; p: number }> = []
  for (const w of [...weights].sort((a, b) => a.f - b.f)) {
    if (w.p <= 0) continue
    const id = facets[w.f]
    const suppressed = id !== undefined && opts.suppressed?.has(id)
    // An id outside the legend is "Other" (NONE_FACET is appended to `facets` but never
    // appears in the legend), which greys for the same reason a suppressed facet does.
    const hue = suppressed ? MUTED_HEX : legend.find((e) => e.facet === id)?.color
    colored.push({ color: hexFor(hue), p: w.p })
  }
  if (colored.length === 0) return []

  const total = colored.reduce((sum, c) => sum + c.p, 0)
  if (total <= 0) return []

  if (opts.layout === "bar-proportional") {
    const floor = MIN_SEGMENT_FRAC
    const fracs = colored.map((c) => Math.max(c.p / total, floor))
    // Flooring the slivers overshoots 1; take the excess back from the segments that are
    // above the floor, proportionally, so the bar still fills exactly.
    const sum = fracs.reduce((a, b) => a + b, 0)
    const slack = fracs.reduce((a, f) => a + Math.max(f - floor, 0), 0)
    const excess = sum - 1
    return colored.map((c, i) => ({
      color: c.color,
      frac: slack > 0 ? fracs[i]! - (Math.max(fracs[i]! - floor, 0) / slack) * excess : fracs[i]!,
    }))
  }

  // mosaic6 is a fixed grid, so its cell count is not negotiable — an override would leave
  // the last row short or overflow it.
  if (opts.layout === "mosaic6") {
    return apportion(
      colored,
      MOSAIC_CELLS.map((c) => c.cw),
    ).map((owner, i) => ({ color: colored[owner]!.color, frac: mosaicFrac(MOSAIC_CELLS[i]!) }))
  }
  // One row of equal cells, never fewer than there are bands: `apportion` can only give
  // every facet a cell when there are cells to give, and a seventh band (NONE_FACET after a
  // full six-facet Lens) would otherwise be the one that falls off. Six stays the floor, so
  // the row only ever grows in the case that used to lose information.
  const cells = Math.max(opts.cells ?? CHIP_CELLS, colored.length)
  return apportion(
    colored,
    Array.from({ length: cells }, () => 1),
  ).map((owner) => ({ color: colored[owner]!.color, frac: 1 / cells }))
}

// Hand each slot to one of `colored`, returning the owning index per slot. `slots` are the
// slot *areas* in any consistent unit, in fill order; every slot is assigned, so the cells
// always fill the frame exactly (a bar with a hole in it reads as a rendering bug).
//
// Two properties, in priority order:
//
//  1. **Every facet present gets at least one slot** — whenever there are slots to go round.
//     For these chips existence beats proportion: at ~16px a cell is a coarse enough unit
//     that no apportionment is truthful anyway, and "this directory contains some parsing
//     code" is the reading the chip is for. A pure largest-remainder apportionment (what
//     this replaced) failed that — a 4% facet lost its cell to the dominant's remainder and
//     the file read as pure. The TUI's treemap has always had the guarantee (`allocateCells`
//     in aperture/treemap.ts steals a cell for any band that floored to zero), so the two
//     surfaces disagreed about the same file; this is that guarantee in slot form.
//  2. Subject to (1), a facet's slots approximate its share *by area*. Area, not slot count,
//     because the mosaic's slots are deliberately unequal — apportioning eight slots by
//     count would give a 50/50 file four slots each and draw it as 67/33, since the first
//     four slots are the two wide columns.
//
// The walk is sequential and monotone: facets are laid down in the order given (Lens facet
// order, see the caller), each taking slots while the slot's *midpoint* still falls inside
// its cumulative share — i.e. while it owns the majority of that slot — and always taking at
// least one. `slot + later < slots.length` is the reservation that makes (1) hold: never
// take a slot that a facet still to come would need. Rounding leftovers fall to the last
// facet, whose boundary is the end of the bar.
//
// If there are somehow more facets than slots the tail goes unpainted, which is why the
// caller sizes the bar to the band count; the mosaic's eight slots already cover the seven
// bands a six-facet Lens plus NONE_FACET can produce.
function apportion(colored: ReadonlyArray<{ p: number }>, slots: ReadonlyArray<number>): number[] {
  const total = colored.reduce((sum, c) => sum + c.p, 0)
  const units = slots.reduce((sum, s) => sum + s, 0)
  const owners: number[] = []
  let slot = 0
  let used = 0
  let boundary = 0
  for (let f = 0; f < colored.length; f++) {
    boundary += (colored[f]!.p / total) * units
    const later = colored.length - 1 - f
    let taken = 0
    while (
      slot < slots.length &&
      (taken === 0 || (slot + later < slots.length && used + slots[slot]! / 2 <= boundary))
    ) {
      owners.push(f)
      used += slots[slot]!
      slot++
      taken++
    }
  }
  while (slot < slots.length) {
    owners.push(colored.length - 1)
    slot++
  }
  return owners
}

// Render segments as a standalone 16x16 SVG document.
//
// Ids inside the document (the clip path) are scoped to it — VSCode loads each chip as its
// own image, so identical ids across chips never collide.
export function chipSvg(segments: ReadonlyArray<Segment>, layout: ChipLayout, theme: Theme): string {
  const cells = layout === "mosaic6" ? mosaicRects(segments) : barRects(segments)
  // The outline keeps the chip legible when a facet colour is close to the tree's own
  // background — without it a pale pastel bar on a light theme has no edge at all.
  const outline = theme === "light" ? "#00000026" : "#FFFFFF26"
  // Both layouts fill and are clipped by the same rounded rect, so they read as the same
  // object with the cells arranged differently — not as two different chips.
  //
  // Ids inside the document (the clip path) are scoped to it: VSCode loads each chip as its
  // own image, so identical ids across chips never collide.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${BOX}" height="${BOX}" viewBox="0 0 ${BOX} ${BOX}">` +
    `<clipPath id="c"><rect x="${BAR_X}" y="${BAR_Y}" width="${BAR_W}" height="${BAR_H}" rx="${BAR_R}"/></clipPath>` +
    `<g clip-path="url(#c)">${cells.join("")}</g>` +
    `<rect x="${BAR_X + 0.25}" y="${BAR_Y + 0.25}" width="${BAR_W - 0.5}" height="${BAR_H - 0.5}" rx="${BAR_R}" fill="none" stroke="${outline}" stroke-width="0.5"/>` +
    `</svg>`
  )
}

// The hollow chip: the chip's frame with nothing in it, worn by a folder that has nothing
// painted below it. It exists for alignment rather than for information — see the note in
// tree.ts — but it also says the true thing, so the empty slot reads as "no facets here"
// rather than as a chip that failed to draw.
//
// `chipSvg` with no segments is already exactly this drawing (no cells, just the clip and
// the outline), so this is that call rather than a second geometry to keep in step with it.
// Layout is immaterial when there are no cells; `bar6` is passed as the arbitrary one.
export const EMPTY_CHIP_KEY = "empty"
export function emptyChipSvg(theme: Theme): string {
  return chipSvg([], "bar6", theme)
}

// One row of N. Widths come straight from the fracs, so this serves both the quantized and
// the proportional layouts.
function barRects(segments: ReadonlyArray<Segment>): string[] {
  const rects: string[] = []
  let x = BAR_X
  segments.forEach((seg, i) => {
    // Overshoot each segment's right edge by a hair so neighbouring rects overlap instead
    // of leaving a seam: at 16px the renderer lands edges on fractional device pixels and
    // a sub-pixel gap shows up as a light hairline between colours.
    const w = seg.frac * BAR_W + (i === segments.length - 1 ? 0 : SEAM)
    rects.push(`<rect x="${round(x)}" y="${BAR_Y}" width="${round(w)}" height="${BAR_H}" fill="${seg.color}"/>`)
    x += seg.frac * BAR_W
  })
  return rects
}

// The bar folded into 3 columns x 2 rows, with the right-hand column cut vertically into two
// half-width columns (see MOSAIC_CELLS). 16px is a hard ceiling on the chip's width, so six
// cells in one row are 2.7px slivers; folding trades horizontal resolution for cells of
// 5.3 x 7px, which is roughly six times the area and actually perceptible. The split third
// buys back two extra slots at 2.7 x 7px — still twice the area of a `bar6` cell — which is
// what lets every facet present get a slot without shrinking the two columns that carry the
// reading.
//
// Filled **column-major from the bottom left** — up, then across, and within the split third
// up the left half before the right. That keeps the left-to-right ordering the single-row
// bar has, and a facet with an even cell count lands on whole columns: 4/2/2 is two solid
// columns plus a split third, and 2/2/2/2 is four clean columns. Row-major would make the 4
// an L wrapping the row end, and would tear a middle facet into two opposite corners.
//
// Bottom-up rather than top-down so this is the TUI treemap block's fill exactly (see
// `buildGrid` in aperture/treemap.ts): the two are different sizes and can never draw the
// same picture, but a directory's chip and its block in the Aperture bar grow the same way,
// so one habit reads both. The TUI's reason for bottom-up is that its blocks are sized by
// directory size and a partial column at the top reads as a smaller directory sitting on a
// full footing; the mosaic always spends all its cells, so nothing here is ever partial and
// the direction costs it nothing.
//
// The cost, stated plainly: an *odd* cell count cannot align to a 2-row column, so 3/5
// staircases (one facet takes a column and a half). Row-major would render that particular
// case as two clean rows. There is no fill order that wins both; this one favours the
// dominant-plus-remainder shape that real files actually have.
//
// No gaps between cells, deliberately: adjacent cells of one facet must merge into a single
// block, so a pure file reads as one solid chip rather than as eight tiles.
function mosaicRects(segments: ReadonlyArray<Segment>): string[] {
  const cw = BAR_W / MOSAIC_COLS
  const ch = BAR_H / MOSAIC_ROWS
  return segments.slice(0, MOSAIC_CELLS.length).map((seg, i) => {
    const cell = MOSAIC_CELLS[i]!
    const x = BAR_X + cell.cx * cw
    const y = BAR_Y + cell.row * ch
    // Overshoot into the neighbour below and to the right, where there is one, for the same
    // sub-pixel-seam reason `barRects` does. A cell on the bar's right or bottom edge has no
    // neighbour to overlap and is left exact so the clip has nothing to trim.
    const w = cell.cw * cw + (cell.cx + cell.cw < MOSAIC_COLS ? SEAM : 0)
    const h = ch + (cell.row < MOSAIC_ROWS - 1 ? SEAM : 0)
    return `<rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" fill="${seg.color}"/>`
  })
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

// Identity of a rendered chip, for the icon cache. Two nodes with the same segments get the
// same URI and VSCode reuses the image. Theme isn't part of the identity: it selects the
// outline inside chipSvg, and one cache entry holds the {light,dark} pair.
export function chipKey(segments: ReadonlyArray<Segment>, layout: ChipLayout): string {
  return `${layout}:${segments.map((s) => `${s.color}@${round(s.frac)}`).join(",")}`
}

// The hover text: the full breakdown, which is the detail the chip necessarily rounds off.
//
// `marks` (S3) lead, and in *lines* rather than percent. A mark's share is exactly the part
// the chip rounds up to a whole cell — a guaranteed minimum says nothing about how much was
// found — so this is the only place the real count can be read, and "3 lines" is the number
// a probe is asked for anyway.
export function chipTooltip(
  weights: ReadonlyArray<FacetWeight>,
  facets: ReadonlyArray<string>,
  legend: ReadonlyArray<LegendEntry>,
  marks?: ReadonlyArray<{ f: number; l: number }>,
): string {
  const labelOf = (index: number) => legend.find((e) => e.facet === facets[index])?.label ?? facets[index] ?? "?"
  const marked = (marks ?? []).map((m) => `${labelOf(m.f)} ${m.l} line${m.l === 1 ? "" : "s"} marked`)
  return [...marked, ...weights.map((w) => `${labelOf(w.f)} ${w.p}%`)].join(" · ")
}
