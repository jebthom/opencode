// The Aperture tree's data model: a path trie over the workspace's visible files, plus the
// per-directory facet rollup that gives a folder row its chip.
//
// Pure — no `vscode` import — so the rollup can be tested against the server's own
// attribution (test/model.test.ts). The file *set* comes from VSCode (findFiles), but once
// it is a list of relative paths this module owns everything.

import type { FacetWeight } from "./chip"

// One file's entry in GET /aperture/facets: `t` is its attributed byte total and `w` its
// mix as integer percentages of that total, descending.
//
// `m` is its Search-rule marks (S3): `l` marked lines and `b` marked bytes per facet, as raw
// counts. Counts rather than percentages precisely so this module can roll them up by plain
// summation — the drift `t` exists to absorb never arises, and nothing can be rounded away on
// the way to a folder chip. A file can carry `m` with an empty `w`: a rule can glob a file
// the extractor never walks, and its mark still has to reach the tree.
export type FacetMark = { f: number; l: number; b: number }
export type FacetFile = { t: number; w: ReadonlyArray<FacetWeight>; m?: ReadonlyArray<FacetMark> }
export type FacetFiles = Record<string, FacetFile>

export interface Entry {
  // Workspace-relative, forward-slashed. "" is the root, which is never an Entry.
  readonly rel: string
  readonly name: string
  readonly dir: boolean
}

export interface TreeModel {
  // Children of a directory, folders first then case-insensitive alphabetical — the
  // Explorer's `explorer.sortOrder: default`.
  readonly children: (rel: string) => ReadonlyArray<Entry>
  // A node's facet mix: the file's own for a file, the subtree rollup for a directory.
  // undefined = nothing painted below here, so the row gets no chip.
  readonly weights: (rel: string, dir: boolean) => ReadonlyArray<FacetWeight> | undefined
  // Marked lines per facet below this node (S3), for the tooltip. The chip itself reads
  // `weights`, which already has the marks merged in — this is only the exact count, which
  // the chip necessarily rounds up to a whole cell.
  readonly marks: (rel: string, dir: boolean) => ReadonlyArray<{ f: number; l: number }> | undefined
  readonly has: (rel: string) => boolean
  // Tracked explicitly rather than inferred from "has no children": a directory the user
  // just created is real and empty, and guessing would call it a file.
  readonly isDir: (rel: string) => boolean
  readonly fileCount: number
}

export function buildModel(
  paths: ReadonlyArray<string>,
  files: FacetFiles,
  facetCount: number,
  // Directories that exist but contain no file. They cannot be derived from `paths`, so a
  // folder the user just created through the tree would silently not appear — the caller
  // remembers those and passes them here.
  extraDirs: ReadonlyArray<string> = [],
): TreeModel {
  const children = new Map<string, Entry[]>()
  const dirs = new Set<string>()
  const seen = new Set<string>()

  const child = (parent: string, entry: Entry) => {
    const list = children.get(parent)
    if (list) list.push(entry)
    else children.set(parent, [entry])
  }

  // Materialise a directory and every ancestor of it. Every prefix of a file path is a
  // directory, so directories are derived rather than enumerated — which is what lets the
  // whole tree come from one flat findFiles result with no recursive walk. The cost is
  // that an empty directory only exists if someone names it, hence `extraDirs`.
  const makeDir = (rel: string) => {
    const parts = rel.split("/")
    let parent = ""
    for (const part of parts) {
      const path = parent === "" ? part : `${parent}/${part}`
      if (!seen.has(path)) {
        seen.add(path)
        dirs.add(path)
        child(parent, { rel: path, name: part, dir: true })
      }
      parent = path
    }
  }

  for (const rel of extraDirs) makeDir(rel)

  for (const path of paths) {
    // A leading slash, a doubled slash, or a trailing one yields an empty segment, and an
    // empty segment is the root — which would make the root a child of itself and give the
    // tree an infinite descent. Nothing should produce such a path (a URI outside the
    // workspace folder is the way it could happen), so drop it rather than repair it.
    if (path === "" || path.split("/").some((segment) => segment === "")) continue
    const slash = path.lastIndexOf("/")
    if (slash !== -1) makeDir(path.slice(0, slash))
    if (seen.has(path)) continue
    seen.add(path)
    child(slash === -1 ? "" : path.slice(0, slash), {
      rel: path,
      name: path.slice(slash + 1),
      dir: false,
    })
  }

  for (const list of children.values()) {
    list.sort((a, b) =>
      a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : a.dir ? -1 : 1,
    )
  }

  // Directory rollup. For every painted file, its facet bytes are added into every
  // ancestor's accumulator — `t * p / 100`, which is `attributeFileBytes`'s own per-facet
  // byte split re-derived from what the wire could carry. Percentages alone would weight
  // every file equally and put this chip at odds with the TUI's byte-weighted treemap over
  // the same directory, which is the disagreement O3's single-classification model exists
  // to prevent.
  //
  // O(files x depth) once per facet-map fetch; ~2300 files at depth ~5 is nothing.
  //
  // Marks (S3) roll up alongside in their own accumulators, never into the byte one: they are
  // sparse and would break the partition `bytes` reports. The two meet in `toWeights` below.
  const bytes = new Map<string, Float64Array>()
  const markBytes = new Map<string, Float64Array>()
  const markLines = new Map<string, Float64Array>()
  const accumulator = (into: Map<string, Float64Array>, rel: string) => {
    let acc = into.get(rel)
    if (!acc) {
      acc = new Float64Array(facetCount)
      into.set(rel, acc)
    }
    return acc
  }
  for (const [path, entry] of Object.entries(files)) {
    // A painted file VSCode is hiding (files.exclude / .gitignore) must not inflate its
    // ancestors — the tree can only be honest about what it shows.
    if (!seen.has(path)) continue
    let parent = ""
    const add = (rel: string) => {
      const acc = accumulator(bytes, rel)
      for (const w of entry.w) if (w.f < facetCount) acc[w.f]! += (entry.t * w.p) / 100
      if (!entry.m?.length) return
      const mb = accumulator(markBytes, rel)
      const ml = accumulator(markLines, rel)
      for (const m of entry.m) {
        if (m.f >= facetCount) continue
        mb[m.f]! += m.b
        ml[m.f]! += m.l
      }
    }
    add("")
    const parts = path.split("/")
    for (let i = 0; i < parts.length - 1; i++) {
      parent = parent === "" ? parts[i]! : `${parent}/${parts[i]}`
      add(parent)
    }
  }

  // Converting an accumulator to percentages is the same reduction the server runs per
  // file, so a folder chip and a file chip are read the same way.
  //
  // Marks overlay it by `max` per facet, never additively: an Overview Lens has already
  // counted the marked lines' bytes under whatever facet their extent had, so adding would
  // count them twice. On a Search Lens the composition is entirely "Other" and every mark
  // band is new, which is the case this exists for.
  const toWeights = (acc: Float64Array | undefined, marks: Float64Array | undefined) => {
    if (!acc && !marks) return undefined
    const merged = new Float64Array(facetCount)
    let total = 0
    for (let f = 0; f < facetCount; f++) {
      merged[f] = Math.max(acc?.[f] ?? 0, marks?.[f] ?? 0)
      total += merged[f]!
    }
    if (total <= 0) return undefined
    const weights: FacetWeight[] = []
    for (let f = 0; f < facetCount; f++) {
      // Floored at 1% for any facet with bytes under the folder, matching the per-file
      // reduction on the server: a folder chip must not drop a facet its own children's
      // chips are showing. Rounding alone hid one small painted file in a large folder — and
      // a mark is the extreme of that case, routinely one line in a thousand.
      if (merged[f]! > 0) weights.push({ f, p: Math.max(1, Math.round((merged[f]! / total) * 100)) })
    }
    weights.sort((a, b) => b.p - a.p || a.f - b.f)
    return weights.length ? weights : undefined
  }

  const rolled = new Map<string, ReadonlyArray<FacetWeight> | undefined>()
  const dirWeights = (rel: string) => {
    if (rolled.has(rel)) return rolled.get(rel)
    const result = toWeights(bytes.get(rel), markBytes.get(rel))
    rolled.set(rel, result)
    return result
  }

  // A file's own bytes, re-derived from what the wire carries, so the same `max` merge runs
  // for a file row as for a folder row. Without it a file's chip would show the extent
  // partition alone and disagree with the folder above it about the same mark.
  const fileWeights = (rel: string) => {
    const entry = files[rel]
    if (!entry) return undefined
    if (!entry.m?.length) return entry.w.length ? entry.w : undefined
    const acc = new Float64Array(facetCount)
    for (const w of entry.w) if (w.f < facetCount) acc[w.f]! += (entry.t * w.p) / 100
    const marks = new Float64Array(facetCount)
    for (const m of entry.m) if (m.f < facetCount) marks[m.f]! += m.b
    return toWeights(acc, marks)
  }

  const markCounts = (acc: Float64Array | undefined) => {
    if (!acc) return undefined
    const out: { f: number; l: number }[] = []
    for (let f = 0; f < facetCount; f++) if (acc[f]! > 0) out.push({ f, l: acc[f]! })
    return out.length ? out : undefined
  }

  return {
    children: (rel) => children.get(rel) ?? [],
    weights: (rel, dir) => (dir ? dirWeights(rel) : fileWeights(rel)),
    marks: (rel, dir) =>
      dir
        ? markCounts(markLines.get(rel))
        : files[rel]?.m?.length
          ? files[rel]!.m!.map((m) => ({ f: m.f, l: m.l }))
          : undefined,
    has: (rel) => rel === "" || seen.has(rel),
    isDir: (rel) => rel === "" || dirs.has(rel),
    fileCount: paths.length,
  }
}
