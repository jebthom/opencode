// The top bar's facet-combination grid (v3), as pure data.
//
// Every marked file is shown exactly once, in the group for the exact SET of facets it carries,
// so the grid answers "which files have a and b but not c?" at a glance. Groups run from the most
// specific combination to the least — for facets a, b, c: abc, ab, ac, bc, a, b, c — because the
// files carrying several concerns at once are usually the ones at issue.
//
// Within a group, files the agent changed this session come first, then other uncommitted changes
// in the working tree, then everything by directory and name. Consecutive files sharing an immediate parent directory form a *run*, which the
// renderer draws inside one containment border. Runs are cut *after* that sort, so a directory
// holding both changed and unchanged files appears twice in a group — once among the changed runs
// at the front, once in its usual place. That is the only directory structure the grid keeps: a
// slice through the repo should cut across directories, not be organised by them.
//
// Dependency-free so the TUI can import it without dragging server code into its bundle, and so the
// grouping is unit-tested rather than only eyeballed.

export interface MarkedFile {
  readonly path: string
  // Marked lines per facet index. A file's facet set is every index with `l > 0`.
  readonly marks: ReadonlyArray<{ readonly f: number; readonly l: number }>
  // The first marked line, where a click should open the file.
  readonly line: number
  // Changed by the agent this session (`agent`), or otherwise uncommitted in the working tree
  // (`tree`: shell commands, manual edits). Orthogonal to the facets, so it orders files within a
  // group rather than forming a group of its own — a file still appears exactly once.
  readonly changed?: "agent" | "tree"
}

export interface Run {
  // The files' shared parent directory ("" for the repo root).
  readonly dir: string
  readonly files: ReadonlyArray<MarkedFile>
}

export interface Group {
  // Facet indices, ascending.
  readonly key: ReadonlyArray<number>
  readonly files: ReadonlyArray<MarkedFile>
  readonly runs: ReadonlyArray<Run>
}

// Group `files` by the exact set of (unsuppressed) facets they carry. A suppressed facet is
// dropped from every key rather than greyed in place: the grid is a scoping tool, so turning a
// concern off in the legend should re-slice the files by the concerns still in play. A file whose
// every facet is suppressed leaves the grid.
//
// `keepUnmarked` admits files with no marks at all into a trailing group with an empty key — for
// when the caller has narrowed to files that matter for another reason (the agent changed them),
// and silently dropping the unmarked ones would hide exactly the changes the user asked to see.
// A file whose facets are all *suppressed* still leaves: the user turned those concerns off.
export function groupByCombination(
  files: ReadonlyArray<MarkedFile>,
  suppressed: ReadonlySet<number>,
  options: { keepUnmarked?: boolean } = {},
): Group[] {
  const byKey = new Map<string, { key: number[]; files: MarkedFile[] }>()
  for (const file of files) {
    const key = [...new Set(file.marks.filter((m) => m.l > 0 && !suppressed.has(m.f)).map((m) => m.f))].sort(
      (a, b) => a - b,
    )
    if (key.length === 0 && !(options.keepUnmarked && file.marks.every((m) => m.l <= 0))) continue
    const id = key.join(",")
    const group = byKey.get(id) ?? { key, files: [] }
    group.files.push(file)
    byKey.set(id, group)
  }
  return [...byKey.values()]
    .sort((a, b) => b.key.length - a.key.length || compareKeys(a.key, b.key))
    .map((group) => {
      const sorted = group.files.toSorted(
        (a, b) =>
          changeRank(b) - changeRank(a) ||
          dirname(a.path).localeCompare(dirname(b.path)) ||
          basename(a.path).localeCompare(basename(b.path)),
      )
      return { key: group.key, files: sorted, runs: runsOf(sorted) }
    })
}

// One column of the rendered grid: a stack of run segments that fits in `rows` rows. A segment
// costs its files plus two border rows.
export interface Segment {
  readonly dir: string
  readonly files: ReadonlyArray<MarkedFile>
  // True when this segment continues a run begun in the previous column.
  readonly continued: boolean
}

export const SEGMENT_BORDER_ROWS = 2

// Pack a group's runs into columns of at most `rows` rows, greedily and in order. A run too tall
// for the space left in a column is split, and its tail continues at the top of the next column,
// so a directory's border never has to be taller than the strip. A column never opens a segment
// it cannot put at least one file in.
export function packColumns(runs: ReadonlyArray<Run>, rows: number): Segment[][] {
  // A column must fit at least one bordered file, or nothing could ever be placed.
  const height = Math.max(rows, SEGMENT_BORDER_ROWS + 1)
  const columns: Segment[][] = []
  let column: Segment[] = []
  let used = 0
  for (const run of runs) {
    let rest = run.files
    let continued = false
    while (rest.length > 0) {
      const room = height - used - SEGMENT_BORDER_ROWS
      if (room < 1) {
        columns.push(column)
        column = []
        used = 0
        continue
      }
      const take = Math.min(rest.length, room)
      column.push({ dir: run.dir, files: rest.slice(0, take), continued })
      used += take + SEGMENT_BORDER_ROWS
      rest = rest.slice(take)
      continued = true
    }
  }
  if (column.length) columns.push(column)
  return columns
}

// Keep a group's first `max` columns, and count the files in the rest so the renderer can offer
// them. Capping is what stops one huge group from pushing every other group off the strip.
export function capColumns(columns: ReadonlyArray<Segment[]>, max: number): { columns: Segment[][]; hidden: number } {
  return {
    columns: columns.slice(0, max),
    hidden: columns.slice(max).reduce((n, column) => n + column.reduce((m, s) => m + s.files.length, 0), 0),
  }
}

function changeRank(file: MarkedFile) {
  if (file.changed === "agent") return 2
  if (file.changed === "tree") return 1
  return 0
}

function runsOf(files: ReadonlyArray<MarkedFile>): Run[] {
  const runs: { dir: string; files: MarkedFile[] }[] = []
  for (const file of files) {
    const dir = dirname(file.path)
    const last = runs[runs.length - 1]
    if (last && last.dir === dir) last.files.push(file)
    else runs.push({ dir, files: [file] })
  }
  return runs
}

// Lexicographic order over ascending index lists: [0,1] < [0,2] < [1,2].
function compareKeys(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!
  return a.length - b.length
}

export function dirname(path: string): string {
  const i = path.lastIndexOf("/")
  return i === -1 ? "" : path.slice(0, i)
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1)
}

export * as ApertureFacetGrid from "./facet-grid"
