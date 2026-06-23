// Pure treemap-grid math for the Aperture renderer. Dependency-free (no Solid/
// OpenTUI/theme) so it can be unit-tested and imported by the TUI without dragging
// render code into tests. The renderer feeds these per-layer weights + a cell budget
// and draws the returned grid; nothing here knows about colors or terminals.

// Split `cells` across the weighted entries using largest-remainder (Hamilton)
// rounding so the parts sum to exactly `cells` and a dominant entry is never lost to
// flooring. When there's room (cells ≥ #entries) every entry with weight > 0 is
// guaranteed at least one cell by stealing from the current largest — so a small but
// real slice still shows. Input order is preserved, so a caller passing entries in a
// fixed order (e.g. architectural layers) gets stable color bands.
export function allocateCells<T extends string>(
  weights: ReadonlyArray<{ key: T; value: number }>,
  cells: number,
): { key: T; n: number }[] {
  const total = weights.reduce((s, w) => s + w.value, 0)
  if (total <= 0 || cells <= 0) return []
  const parts = weights.map((w) => {
    const exact = (cells * w.value) / total
    const n = Math.floor(exact)
    return { key: w.key, n, frac: exact - n }
  })
  let remainder = cells - parts.reduce((s, p) => s + p.n, 0)
  for (const p of [...parts].sort((a, b) => b.frac - a.frac)) {
    if (remainder <= 0) break
    p.n++
    remainder--
  }
  if (cells >= parts.length) {
    for (const p of parts) {
      if (p.n > 0) continue
      const big = parts.reduce((m, x) => (x.n > m.n ? x : m), parts[0]!)
      if (big.n > 1) {
        big.n--
        p.n++
      }
    }
  }
  return parts.filter((p) => p.n > 0).map((p) => ({ key: p.key, n: p.n }))
}

// Lay a flat, band-ordered cell list into a `rows`-tall grid that grows
// horizontally, filled bottom row first, left→right (bottom-aligned: the footing
// stays full and the partial cells land on the top row). Rows are padded with nulls
// to a common width so the block is rectangular. Returns rows top→bottom.
export function buildGrid<T>(flat: ReadonlyArray<T>, rows: number): (T | null)[][] {
  if (flat.length === 0 || rows <= 0) return []
  const cols = Math.ceil(flat.length / rows)
  const grid: (T | null)[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => null as T | null))
  let i = 0
  for (let fromBottom = 0; fromBottom < rows; fromBottom++) {
    const row = rows - 1 - fromBottom
    for (let col = 0; col < cols && i < flat.length; col++) grid[row]![col] = flat[i++]!
  }
  return grid
}

// Collapse a row of cells into contiguous same-value runs so each run can draw as a
// single element (null = empty padding).
export function coalesce<T>(row: ReadonlyArray<T | null>): { value: T | null; len: number }[] {
  const runs: { value: T | null; len: number }[] = []
  for (const cell of row) {
    const last = runs[runs.length - 1]
    if (last && last.value === cell) last.len++
    else runs.push({ value: cell, len: 1 })
  }
  return runs
}

export * as ApertureTreemap from "./treemap"
