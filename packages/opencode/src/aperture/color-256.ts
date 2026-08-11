// xterm-256 colour maths, shared by the palette guard test and `opencode debug
// aperture-colors`. Pure and dependency-free, like its neighbours in this directory.
//
// This exists because of the contract described on PALETTES in lenses.ts: every colour
// Aperture paints must be an *exact* xterm-256 entry, so that quantisation in a
// non-truecolor terminal is a no-op and the TUI, the VSCode gutter and the tree chips all
// show the same RGB. Both the test that enforces that and the command that demonstrates it
// on a real terminal need the same two answers — "which entry would this quantise to" and
// "how far apart are two colours perceptually" — so they are written once, here.

// The xterm-256 palette: 16 system colours, a 6x6x6 colour cube, then a 24-step grey ramp.
// Built from the standard formulae rather than typed out, so it can't be subtly wrong.
function buildXterm256(): Array<[number, number, number]> {
  const table: Array<[number, number, number]> = [
    [0, 0, 0],
    [128, 0, 0],
    [0, 128, 0],
    [128, 128, 0],
    [0, 0, 128],
    [128, 0, 128],
    [0, 128, 128],
    [192, 192, 192],
    [128, 128, 128],
    [255, 0, 0],
    [0, 255, 0],
    [255, 255, 0],
    [0, 0, 255],
    [255, 0, 255],
    [0, 255, 255],
    [255, 255, 255],
  ]
  const level = (i: number) => (i === 0 ? 0 : 55 + 40 * i)
  for (let r = 0; r < 6; r++)
    for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) table.push([level(r), level(g), level(b)])
  for (let i = 0; i < 24; i++) table.push([8 + 10 * i, 8 + 10 * i, 8 + 10 * i])
  return table
}

export const XTERM_256: ReadonlyArray<readonly [number, number, number]> = buildXterm256()

export type RGB = [number, number, number]

export function rgbFromHex(hex: string): RGB {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB
}

export function hexFromRgb([r, g, b]: readonly [number, number, number]): string {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0").toUpperCase()).join("")}`
}

// The palette index a renderer would quantise this colour to. Squared RGB distance, not a
// perceptual metric, because that is what renderers actually use — the point is to predict
// what the terminal will do, not what it ought to do.
export function nearestIndex(hex: string): number {
  const c = rgbFromHex(hex)
  let best = Infinity
  let winner = 0
  for (let i = 0; i < XTERM_256.length; i++) {
    const p = XTERM_256[i]!
    const d = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2 + (c[2] - p[2]) ** 2
    if (d < best) [best, winner] = [d, i]
  }
  return winner
}

// True when the colour survives a 256-colour terminal unchanged — i.e. it *is* a palette
// entry, so quantising it is the identity. This is the property the whole colour contract
// rests on; see the note on PALETTES in lenses.ts.
export function isExact(hex: string): boolean {
  const [r, g, b] = rgbFromHex(hex)
  const [pr, pg, pb] = XTERM_256[nearestIndex(hex)]!
  return r === pr && g === pg && b === pb
}

// Indices 0-15 are the only ones a terminal colour theme overrides — OpenTUI queries
// exactly these over OSC 4 (NATIVE_PALETTE_QUERY_SIZE = 16) and fills 16-255 from the
// standard cube regardless. So "exact entry" is not on its own enough: a colour that
// coincides with a *system* slot inherits whatever Solarized/Nord/Dracula painted there.
//
// This is not hypothetical. #808080 is in the table twice — grey-ramp idx 244 and system
// idx 8 — and a quantiser that takes the lower index resolves it into the themed range.
// That is why NONE_HUE is #8A8A8A.
export function collidesWithSystemColor(hex: string): boolean {
  const [r, g, b] = rgbFromHex(hex)
  return XTERM_256.slice(0, 16).some(([sr, sg, sb]) => r === sr && g === sg && b === sb)
}

// sRGB -> CIE L*a*b* (D65).
export function toLab([r, g, b]: readonly [number, number, number]): RGB {
  const lin = (c: number) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4)
  const [R, G, B] = [lin(r), lin(g), lin(b)]
  const X = R * 0.4124564 + G * 0.3575761 + B * 0.1804375
  const Y = R * 0.2126729 + G * 0.7151522 + B * 0.072175
  const Z = R * 0.0193339 + G * 0.119192 + B * 0.9503041
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const [fx, fy, fz] = [f(X / 0.95047), f(Y), f(Z / 1.08883)]
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

// CIEDE2000 perceptual difference. Roughly: 1 is the just-noticeable difference under ideal
// conditions, 10 reads as "clearly a different colour", and Aperture's palette holds a
// minimum of 32 between any two facet colours.
export function ciede2000(c1: readonly [number, number, number], c2: readonly [number, number, number]): number {
  const rad = (d: number) => (d * Math.PI) / 180
  const deg = (r: number) => ((r * 180) / Math.PI + 360) % 360
  const [L1, a1, b1] = toLab(c1)
  const [L2, a2, b2] = toLab(c2)
  const C1 = Math.hypot(a1, b1)
  const C2 = Math.hypot(a2, b2)
  const Cbar = (C1 + C2) / 2
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)))
  const [a1p, a2p] = [(1 + G) * a1, (1 + G) * a2]
  const [C1p, C2p] = [Math.hypot(a1p, b1), Math.hypot(a2p, b2)]
  const h1p = a1p === 0 && b1 === 0 ? 0 : deg(Math.atan2(b1, a1p))
  const h2p = a2p === 0 && b2 === 0 ? 0 : deg(Math.atan2(b2, a2p))
  const dLp = L2 - L1
  const dCp = C2p - C1p
  let dhp = 0
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p
    if (dhp > 180) dhp -= 360
    else if (dhp < -180) dhp += 360
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp) / 2)
  const Lbp = (L1 + L2) / 2
  const Cbp = (C1p + C2p) / 2
  let hbp = h1p + h2p
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hbp = (h1p + h2p) / 2
    else hbp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2
  }
  const T =
    1 -
    0.17 * Math.cos(rad(hbp - 30)) +
    0.24 * Math.cos(rad(2 * hbp)) +
    0.32 * Math.cos(rad(3 * hbp + 6)) -
    0.2 * Math.cos(rad(4 * hbp - 63))
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2))
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7))
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2)
  const Sc = 1 + 0.045 * Cbp
  const Sh = 1 + 0.015 * Cbp * T
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh))
}

// Perceptual distance between two hexes.
export function deltaE(a: string, b: string): number {
  return ciede2000(rgbFromHex(a), rgbFromHex(b))
}
