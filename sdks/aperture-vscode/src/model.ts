// The Aperture tree's data model: a path trie over the workspace's visible files, plus the
// per-directory facet rollup that gives a folder row its chip.
//
// Pure — no `vscode` import — so the rollup is unit-tested (test/model.test.ts). The file *set* comes from VSCode (findFiles), but once
// it is a list of relative paths this module owns everything.

import type { FacetWeight } from "./chip"

// One file's entry in GET /aperture/facets: `m` is its marks — `l` marked lines and `b` marked
// bytes per facet — as raw counts, so this module rolls them up by plain summation and nothing
// can be rounded away on the way to a folder chip. `line` is the first marked line.
export type FacetMark = { f: number; l: number; b: number }
export type FacetFile = { m: ReadonlyArray<FacetMark>; line: number }
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
  // A node's facet mix as percentages of its marked lines: the file's own for a file, the
  // subtree rollup for a directory. undefined = nothing marked below here, so the row gets no
  // chip.
  readonly weights: (rel: string, dir: boolean) => ReadonlyArray<FacetWeight> | undefined
  // Marked lines per facet below this node, for the tooltip — the exact count the chip
  // necessarily rounds to whole cells.
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

  // Directory rollup: every marked file's lines per facet are summed into each ancestor. A
  // folder chip is therefore sized by how much of each concern lives below it, and — because
  // every facet with any marked line keeps a cell (the 1% floor here, then `apportion`) — a single
  // marked line deep in the tree still shows at the root. O(files x depth) per facet-map fetch.
  const lines = new Map<string, Float64Array>()
  const accumulator = (rel: string) => {
    let acc = lines.get(rel)
    if (!acc) {
      acc = new Float64Array(facetCount)
      lines.set(rel, acc)
    }
    return acc
  }
  for (const [path, entry] of Object.entries(files)) {
    // A marked file VSCode is hiding (files.exclude / .gitignore) must not inflate its
    // ancestors — the tree can only be honest about what it shows.
    if (!seen.has(path)) continue
    const add = (rel: string) => {
      const acc = accumulator(rel)
      for (const m of entry.m) if (m.f < facetCount) acc[m.f]! += m.l
    }
    add("")
    const parts = path.split("/")
    let parent = ""
    for (let i = 0; i < parts.length - 1; i++) {
      parent = parent === "" ? parts[i]! : `${parent}/${parts[i]}`
      add(parent)
    }
  }

  // Lines per facet → integer percentages, each present facet floored at 1% so a folder chip can
  // never drop a facet its own children's chips are showing.
  const toWeights = (acc: Float64Array | undefined) => {
    if (!acc) return undefined
    const total = acc.reduce((sum, v) => sum + v, 0)
    if (total <= 0) return undefined
    const weights: FacetWeight[] = []
    for (let f = 0; f < facetCount; f++)
      if (acc[f]! > 0) weights.push({ f, p: Math.max(1, Math.round((acc[f]! / total) * 100)) })
    weights.sort((a, b) => b.p - a.p || a.f - b.f)
    return weights
  }

  const fileLines = (rel: string) => {
    const entry = files[rel]
    if (!entry?.m.length) return undefined
    const acc = new Float64Array(facetCount)
    for (const m of entry.m) if (m.f < facetCount) acc[m.f]! += m.l
    return acc
  }

  const counts = (acc: Float64Array | undefined) => {
    if (!acc) return undefined
    const out: { f: number; l: number }[] = []
    for (let f = 0; f < facetCount; f++) if (acc[f]! > 0) out.push({ f, l: acc[f]! })
    return out.length ? out : undefined
  }

  const rolled = new Map<string, ReadonlyArray<FacetWeight> | undefined>()
  const dirWeights = (rel: string) => {
    if (!rolled.has(rel)) rolled.set(rel, toWeights(lines.get(rel)))
    return rolled.get(rel)
  }

  return {
    children: (rel) => children.get(rel) ?? [],
    weights: (rel, dir) => (dir ? dirWeights(rel) : toWeights(fileLines(rel))),
    marks: (rel, dir) => counts(dir ? lines.get(rel) : fileLines(rel)),
    has: (rel) => rel === "" || seen.has(rel),
    isDir: (rel) => rel === "" || dirs.has(rel),
    fileCount: paths.length,
  }
}
