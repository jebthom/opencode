import { Effect } from "effect"
import { effectCmd } from "../../effect-cmd"
import { ApertureLensStore } from "@/aperture/lens-store"
import { NONE_HUE, NONE_LABEL, UNTAGGED_HUE, UNTAGGED_LABEL, type Facet } from "@/aperture/lenses"
import {
  XTERM_256,
  collidesWithSystemColor,
  deltaE,
  hexFromRgb,
  isExact,
  nearestIndex,
  rgbFromHex,
} from "@/aperture/color-256"

// Prove — on the machine actually running the study — that Aperture's facet colours survive
// the terminal.
//
// Aperture encodes meaning in hue, so a terminal that flattens two facets into one colour
// silently destroys the thing being measured. That is what participants hit: the old
// `pastel` palette had two colours that quantised to the same xterm-256 entry, so on any
// non-truecolor terminal they were literally identical. The fix (PLAN C1) was to put every
// paintable colour on an exact xterm-256 entry, which makes quantisation a no-op.
//
// This command exists to *demonstrate* that rather than assert it. The two swatch rows are
// the real test: the first is written as truecolor RGB, the second as the palette index the
// colour quantises to. If your terminal supports truecolor they are the same colour because
// the RGB is the same; if it doesn't, the first row degrades to the second — and because
// each colour IS its own palette entry, that degradation changes nothing. Rows that look
// alike mean the encoding is intact. Two swatches in either row that look alike mean it is not.

function truecolorSwatch(hex: string): string {
  const [r, g, b] = rgbFromHex(hex)
  return `\x1b[48;2;${r};${g};${b}m      \x1b[0m`
}

function indexedSwatch(hex: string): string {
  return `\x1b[48;5;${nearestIndex(hex)}m      \x1b[0m`
}

interface Row {
  label: string
  hex: string
}

function report(title: string, rows: ReadonlyArray<Row>) {
  if (rows.length === 0) return
  console.log(`\n${title}`)
  const labelWidth = Math.max(...rows.map((r) => r.label.length))
  for (const { label, hex } of rows) {
    const index = nearestIndex(hex)
    const actual = hexFromRgb(XTERM_256[index]!)
    // DRIFT: a 256-colour terminal shows `actual` where the TUI's truecolor path and VSCode
    // both show `hex`, so the two surfaces disagree for this facet.
    // THEMED: the colour is exact but lands in indices 0-15, the range a terminal colour
    // scheme repaints — so it renders as whatever Solarized/Nord/Dracula put there.
    const verdict = !isExact(hex) ? `DRIFT -> ${actual}` : collidesWithSystemColor(hex) ? "THEMED (idx 0-15)" : "OK"
    console.log(
      `  ${label.padEnd(labelWidth)}  ${hex}  ${truecolorSwatch(hex)}${indexedSwatch(hex)}  idx ${String(index).padStart(3)}  ${verdict}`,
    )
  }

  // The closest pair is what decides whether the *set* is readable, so report it rather than
  // every pair. Below ~20 two facets start to read as one.
  let worst: { a: Row; b: Row; d: number } | undefined
  for (let i = 0; i < rows.length; i++)
    for (let j = i + 1; j < rows.length; j++) {
      const d = deltaE(rows[i]!.hex, rows[j]!.hex)
      if (!worst || d < worst.d) worst = { a: rows[i]!, b: rows[j]!, d }
    }
  if (worst)
    console.log(
      `  closest pair: ${worst.a.label} / ${worst.b.label} at ΔE2000 ${worst.d.toFixed(1)}` +
        (worst.d < 20 ? "  <-- too close, these will read as one facet" : ""),
    )
}

export const ApertureColorsCommand = effectCmd({
  command: "aperture-colors",
  describe: "check Aperture's facet colours survive this terminal",
  builder: (yargs) =>
    yargs.option("directory", {
      type: "string",
      describe: "project directory whose active Lens to check (default: cwd)",
    }),
  handler: Effect.fn("Cli.debug.apertureColors")(function* (args: { directory?: string }) {
    const directory = args.directory ?? process.cwd()

    console.log("terminal")
    for (const key of ["TERM", "TERM_PROGRAM", "COLORTERM", "TMUX"] as const) {
      console.log(`  ${key.padEnd(12)} ${process.env[key] ?? "(unset)"}`)
    }
    // COLORTERM is the usual reason a capable terminal is treated as 256-only: it is
    // commonly lost over ssh and unset by several Linux terminal defaults. It no longer
    // matters for colour *identity* — that is the point of the exact-entry rule — but it
    // still decides which of the two swatch rows the TUI actually emits.
    const truecolor = process.env["COLORTERM"] === "truecolor" || process.env["COLORTERM"] === "24bit"
    console.log(`  truecolor advertised: ${truecolor ? "yes" : "no (the TUI will emit indexed colour)"}`)

    const lens = yield* ApertureLensStore.getActive(directory)
    console.log(`\nactive Lens: ${lens.name} (${lens.id})${lens.palette ? `, palette "${lens.palette}"` : ""}`)

    const facetRows = lens.facets.map((f: Facet) => ({ label: f.label, hex: f.color }))
    report("facets — truecolor swatch, then the swatch after 256-colour quantisation", [
      ...facetRows,
      { label: NONE_LABEL, hex: NONE_HUE },
      { label: UNTAGGED_LABEL, hex: UNTAGGED_HUE },
    ])

    const all = [...facetRows, { label: NONE_LABEL, hex: NONE_HUE }, { label: UNTAGGED_LABEL, hex: UNTAGGED_HUE }]
    const bad = all
      .filter((r) => !r.hex.startsWith("#") || !isExact(r.hex) || collidesWithSystemColor(r.hex))
      .map((r) => r.label)
    console.log(
      bad.length === 0
        ? "\nevery colour is an exact xterm-256 entry outside the re-themable 0-15 range: this Lens renders identically in the TUI and in VSCode, on any terminal, under any terminal colour scheme."
        : `\n${bad.length} colour(s) will not survive a 256-colour terminal intact: ${bad.join(", ")}`,
    )
  }),
})
