#!/usr/bin/env bun
// Regenerate the `contributes.colors` block in package.json from Aperture's palettes.
//
// VSCode's FileDecoration.color takes a ThemeColor — a colour *id* — and there is no
// runtime API to hand it a hex. Contributed ids are the only way to paint the Explorer
// pips in a Lens's real legend hue rather than an approximation, so we contribute one id
// per hex Aperture can ever emit: `aperture.c4E79A7` defaulting to `#4E79A7`.
//
// That is only tractable because the colour universe is closed. `assignColors` in
// lenses.ts is the sole path that colours a user Lens's facet, and it always takes
// PALETTES[palette].colors[i] — there is no arbitrary user hex. The built-in Lenses carry
// their own ramps, which we read off the Lenses themselves rather than re-exporting the
// private arrays, so this can't drift from what a legend actually ships.
//
// Since C1 the universe is not just closed but *complete*: every colour Aperture can paint
// is a literal hex, including the two greys and the architecture Lens's layer hues, which
// used to be theme-role tokens each surface resolved for itself. Nothing resolves through
// an editor theme any more — that indirection was the mismatch, not the fix for it. So the
// ids generated here cover every colour, and the extension's remaining role fallback is a
// backstop for an unknown token rather than a parallel palette.
//
// Expect 8 ids: six palette colours (categorical and ordinal are the same six) plus the
// "Other" and "Non-code" greys.
//
// Run after changing a palette:  bun sdks/aperture-vscode/script/gen-colors.ts

import { PALETTES, BUILTIN_LENSES, NONE_HUE, UNTAGGED_HUE } from "../../../packages/opencode/src/aperture/lenses"

const hexes = new Set<string>()
for (const palette of Object.values(PALETTES)) for (const color of palette.colors) hexes.add(color.toUpperCase())
for (const lens of BUILTIN_LENSES)
  for (const facet of lens.facets) if (facet.color.startsWith("#")) hexes.add(facet.color.toUpperCase())
// The greys aren't reachable from a Lens's facets — "Other" and "Non-code" are synthesised
// by the renderer — so they have to be added explicitly or the pips silently fall back.
for (const grey of [NONE_HUE, UNTAGGED_HUE]) hexes.add(grey.toUpperCase())

// Sorted so a palette edit produces a minimal, reviewable diff rather than reshuffling.
const colors = [...hexes].sort().map((hex) => ({
  id: `aperture.c${hex.slice(1)}`,
  description: `Aperture facet colour ${hex}`,
  // The same value in every theme kind: the hex IS the identity being matched to the TUI,
  // so adapting it per theme would reintroduce exactly the mismatch this file exists to
  // remove. Users can retune any id via workbench.colorCustomizations.
  defaults: { dark: hex, light: hex, highContrast: hex, highContrastLight: hex },
}))

const file = Bun.file(new URL("../package.json", import.meta.url))
const manifest = await file.json()
manifest.contributes.colors = colors
await Bun.write(file, JSON.stringify(manifest, null, 2) + "\n")
console.log(`wrote ${colors.length} colour ids to package.json`)
