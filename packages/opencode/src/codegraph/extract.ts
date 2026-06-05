import { Effect } from "effect"
import path from "path"
import { createHash } from "crypto"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CodeGraphPayload } from "./payload"

// Deterministic structure extractor. Produces a CodeGraphPayload from a
// directory tree plus lightweight import parsing for TS/JS and Python. No agent
// involvement here — the output depends only on the files on disk, so the same
// repo state always yields the same payload (see PLAN.md, step 1).

// Bounded, scoped walk (PLAN.md step 2.5): the graph is always a 2-level window
// rooted at the requested `scope` (a repo-relative directory, "" = repo root).
// We enumerate only entries within `depth` layers below the scope — never the
// whole tree — so memory stays bounded as the user drills in. Directories at the
// deepest visible layer are collapsed nodes whose contents are the *next* scope.
// The blanket `**/*` recursion that used to exhaust memory on large repos is
// gone; we glob one pattern per layer so the walk can't descend past the window.
const SOURCE_GLOB = "*.{ts,tsx,js,jsx,mjs,cjs,mts,cts,py}"
const ENTRY_GLOB = "*"

// How many layers below the scope the view shows: the scope's direct children
// (layer 0) plus their children (layer 1). Also the window the service uses to
// decide whether a file change is visible (see codegraph.ts).
export const VIEW_DEPTH = 2

// Directories that never carry useful structure and would otherwise dominate the
// graph. Pruned during the glob walk so trees like node_modules never appear.
const IGNORED_DIRS = ["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv", "venv"]
const IGNORE_GLOBS = IGNORED_DIRS.map((dir) => `**/${dir}/**`)
const IGNORED_DIR_SET = new Set(IGNORED_DIRS)

// Hard caps so a pathological repo can never exhaust memory: cap the node count
// and skip files too large to parse cheaply. Reads run with bounded concurrency.
const MAX_FILES = 5000
const MAX_FILE_BYTES = 512 * 1024
const READ_CONCURRENCY = 24

export const extract = Effect.fn("CodeGraph.extract")(function* (
  root: string,
  options?: { scope?: string; depth?: number },
) {
  const fs = yield* FSUtil.Service
  const scope = normalizeScope(options?.scope ?? "")
  const depth = options?.depth ?? VIEW_DEPTH
  const base = scope === "" ? root : path.join(root, scope)

  // A stale or non-directory scope (e.g. the dir was deleted while the view
  // pointed at it) yields an empty payload rather than an error the UI must
  // handle. The root is always assumed valid.
  if (scope !== "") {
    const ok = yield* fs.stat(base).pipe(
      Effect.map((s) => s.type === "Directory"),
      Effect.catch(() => Effect.succeed(false)),
    )
    if (!ok) return emptyPayload()
  }

  // One glob per layer (1..depth) so the walk never descends past the window.
  // `*/`-prefixed patterns reach successively deeper layers below the scope.
  const layerPrefix = (layer: number) => "*/".repeat(layer)
  const sourceGlobs = Array.from({ length: depth }, (_, i) => layerPrefix(i) + SOURCE_GLOB)
  const entryGlobs = Array.from({ length: depth }, (_, i) => layerPrefix(i) + ENTRY_GLOB)

  const fileLists = yield* Effect.forEach(sourceGlobs, (pattern) =>
    fs.glob(pattern, { cwd: base, include: "file", dot: false, ignore: IGNORE_GLOBS }),
  )
  // Entries (files + dirs) within the window so we can pick out directories.
  const entryLists = yield* Effect.forEach(entryGlobs, (pattern) =>
    fs.glob(pattern, { cwd: base, include: "all", dot: false, ignore: IGNORE_GLOBS }),
  )

  // Paths are emitted repo-relative (so node ids stay stable across scopes), but
  // globbed relative to `base`; reattach the scope prefix here.
  const toRepoRel = (p: string) => {
    const relToBase = toPosix(path.relative(base, path.isAbsolute(p) ? p : path.join(base, p)))
    return scope === "" ? relToBase : `${scope}/${relToBase}`
  }

  // Stable set of repo-relative POSIX paths, sorted for determinism, capped.
  const relFiles = [...new Set(fileLists.flat().map(toRepoRel))]
    .filter((rel) => rel !== "" && !isIgnoredPath(rel))
    .toSorted()
    .slice(0, MAX_FILES)

  // Directory-node candidates: any entry in the window that isn't a known source
  // file and isn't under an ignored segment. Non-directory entries (e.g. a stray
  // README) survive the filter but are dropped after the stat below.
  const fileSet = new Set(relFiles)
  const candidates = [
    ...new Set(
      entryLists
        .flat()
        .map(toRepoRel)
        .filter((rel) => rel !== "" && !fileSet.has(rel) && !isIgnoredPath(rel)),
    ),
  ].slice(0, MAX_FILES)
  const candidateKinds = yield* Effect.forEach(
    candidates,
    (rel) =>
      fs.stat(path.join(root, rel)).pipe(
        Effect.map((stat) => [rel, stat.type === "Directory"] as const),
        Effect.catch(() => Effect.succeed([rel, false] as const)),
      ),
    { concurrency: READ_CONCURRENCY },
  )
  const dirSet = new Set(candidateKinds.filter(([, isDir]) => isDir).map(([rel]) => rel))

  const sizes = yield* Effect.forEach(
    relFiles,
    (f) =>
      fs.stat(path.join(root, f)).pipe(
        Effect.map((stat) => [f, stat.type === "File" ? Number(stat.size) : 0] as const),
        Effect.catch(() => Effect.succeed([f, 0] as const)),
      ),
    { concurrency: READ_CONCURRENCY },
  )
  const fileSizes = new Map(sizes)

  // Edges: parse imports per file and resolve to known file nodes. Files larger
  // than MAX_FILE_BYTES are skipped to avoid loading huge blobs into memory.
  const knownFiles = new Set(relFiles)
  const parsed = yield* Effect.forEach(
    relFiles,
    (f) => {
      if ((fileSizes.get(f) ?? 0) > MAX_FILE_BYTES) return Effect.succeed([f, undefined] as const)
      return fs
        .readFileStringSafe(path.join(root, f))
        .pipe(Effect.map((content) => [f, content] as const), Effect.orElseSucceed(() => [f, undefined] as const))
    },
    { concurrency: READ_CONCURRENCY },
  )

  const edges: CodeGraphPayload.Edge[] = []
  const seenEdges = new Set<string>()
  for (const [f, content] of parsed) {
    if (!content) continue
    for (const spec of parseImports(f, content)) {
      const target = resolveImport(f, spec, knownFiles)
      if (!target || target === f) continue
      const key = f + "\u0000" + target
      if (seenEdges.has(key)) continue
      seenEdges.add(key)
      edges.push({ from: nodeID(f), to: nodeID(target), kind: "import" })
    }
  }

  const positions = layout(relFiles, [...dirSet], scope)

  const nodes: CodeGraphPayload.Node[] = [
    ...[...dirSet].map((d) => ({
      id: nodeID(d),
      path: d,
      kind: "directory" as const,
      // Collapsed node: contents aren't walked at this layer, so size is unknown.
      size: 0,
      position: positions.get(d)!,
    })),
    ...relFiles.map((f) => ({
      id: nodeID(f),
      path: f,
      kind: "file" as const,
      size: fileSizes.get(f) ?? 0,
      position: positions.get(f)!,
    })),
  ].toSorted((a, b) => a.id.localeCompare(b.id))

  edges.sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to))

  return {
    version: CodeGraphPayload.PAYLOAD_VERSION,
    nodes,
    edges,
    semantics: {},
  } satisfies CodeGraphPayload.Payload
})

// --- deterministic node identity ------------------------------------------

// Content-independent: a stable hash of the repo-relative path. The same file
// always maps to the same id across runs and across scopes.
function nodeID(relPath: string) {
  return "n_" + createHash("sha256").update(relPath).digest("hex").slice(0, 16)
}

// --- deterministic layout --------------------------------------------------

// Layer = depth relative to the scope (a direct child of the scope is layer 0).
// Index = stable position within a layer, assigned by sorted path order.
// Orientation-agnostic; the renderer maps (layer, index) to screen coordinates.
function layout(files: string[], dirs: string[], scope: string) {
  const scopeSegments = scope === "" ? 0 : scope.split("/").length
  const all = [...dirs, ...files].toSorted()
  const byLayer = new Map<number, string[]>()
  for (const p of all) {
    const layer = p.split("/").length - scopeSegments - 1
    const bucket = byLayer.get(layer) ?? []
    bucket.push(p)
    byLayer.set(layer, bucket)
  }
  const positions = new Map<string, CodeGraphPayload.Position>()
  for (const [layer, members] of byLayer) {
    members.toSorted().forEach((p, index) => positions.set(p, { layer, index }))
  }
  return positions
}

// --- scope + path helpers --------------------------------------------------

// Canonical scope form: POSIX separators, no leading/trailing slashes, no "."
// or empty segments. "" means the repo root.
export function normalizeScope(scope: string) {
  return toPosix(scope)
    .split("/")
    .filter((seg) => seg !== "" && seg !== ".")
    .join("/")
}

// True if any path segment is an always-ignored directory. The glob `ignore`
// already prunes these during the walk; this is a cheap belt-and-suspenders
// guard for entries that slip through (e.g. an ignored dir named at the scope).
function isIgnoredPath(rel: string) {
  return rel.split("/").some((seg) => IGNORED_DIR_SET.has(seg))
}

function emptyPayload(): CodeGraphPayload.Payload {
  return { version: CodeGraphPayload.PAYLOAD_VERSION, nodes: [], edges: [], semantics: {} }
}

// --- import parsing --------------------------------------------------------

// `from "x"` covers static import/export-from; the `[^"']*?` is bounded to a
// single quote span (no greedy `[\s\S]*?`) so it can't backtrack catastrophically.
const TS_FROM = /\bfrom\s*["']([^"']+)["']/g
const TS_REQUIRE = /require\(\s*["']([^"']+)["']\s*\)/g
const TS_DYNAMIC = /import\(\s*["']([^"']+)["']\s*\)/g
const PY_FROM = /^\s*from\s+([.\w]+)\s+import\s+/gm
const PY_IMPORT = /^\s*import\s+([.\w]+)/gm

function parseImports(file: string, content: string) {
  const specs = new Set<string>()
  const ext = path.extname(file)
  if (ext === ".py") {
    for (const m of content.matchAll(PY_FROM)) specs.add(m[1]!)
    for (const m of content.matchAll(PY_IMPORT)) specs.add(m[1]!)
    return [...specs]
  }
  for (const m of content.matchAll(TS_FROM)) specs.add(m[1]!)
  for (const m of content.matchAll(TS_REQUIRE)) specs.add(m[1]!)
  for (const m of content.matchAll(TS_DYNAMIC)) specs.add(m[1]!)
  return [...specs]
}

const TS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]

// Resolve an import specifier to a known file node, or undefined for externals.
// Only intra-repo relative (TS/JS) and dotted-relative (Python) imports become
// edges; bare/package specifiers are intentionally dropped.
function resolveImport(from: string, spec: string, known: Set<string>): string | undefined {
  if (from.endsWith(".py")) return resolvePython(from, spec, known)
  if (!spec.startsWith(".")) return undefined
  const base = toPosix(path.posix.join(posixDir(from), spec))
  return matchWithExtensions(base, known, TS_EXTS)
}

function resolvePython(from: string, spec: string, known: Set<string>): string | undefined {
  if (!spec.startsWith(".")) return undefined
  // Leading dots = relative levels: one dot is the current package.
  const dots = spec.match(/^\.+/)![0].length
  const tail = spec.slice(dots).replace(/\./g, "/")
  let dir = posixDir(from)
  for (let i = 1; i < dots; i++) dir = posixDir(dir)
  const base = toPosix(path.posix.join(dir, tail))
  return matchWithExtensions(base, known, [".py"])
}

function matchWithExtensions(base: string, known: Set<string>, exts: string[]): string | undefined {
  if (known.has(base)) return base
  for (const ext of exts) {
    if (known.has(base + ext)) return base + ext
  }
  for (const ext of exts) {
    const index = toPosix(path.posix.join(base, "index" + ext))
    if (known.has(index)) return index
    const initFile = toPosix(path.posix.join(base, "__init__" + ext))
    if (known.has(initFile)) return initFile
  }
  return undefined
}

// --- path helpers ----------------------------------------------------------

function toPosix(p: string) {
  return p.split(path.sep).join("/")
}

function posixDir(p: string) {
  const idx = p.lastIndexOf("/")
  return idx === -1 ? "" : p.slice(0, idx)
}

export * as CodeGraphExtract from "./extract"
