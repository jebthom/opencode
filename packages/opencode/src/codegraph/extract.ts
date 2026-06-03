import { Effect } from "effect"
import path from "path"
import { createHash } from "crypto"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CodeGraphPayload } from "./payload"

// Deterministic structure extractor. Produces a CodeGraphPayload from a
// directory tree plus lightweight import parsing for TS/JS and Python. No agent
// involvement here — the output depends only on the files on disk, so the same
// repo state always yields the same payload (see PLAN.md, step 1).

// Single-layer walk: only the immediate children of the root are enumerated.
// Top-level source files become file nodes; top-level directories become
// collapsed directory nodes whose contents are never walked or read. Recursing
// the whole tree (and reading every file) was exhausting memory on large repos,
// so we deliberately stop after one layer — this is plenty for the current view.
const SOURCE_GLOB = "*.{ts,tsx,js,jsx,mjs,cjs,mts,cts,py}"
const ENTRY_GLOB = "*"

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

export const extract = Effect.fn("CodeGraph.extract")(function* (root: string) {
  const fs = yield* FSUtil.Service

  // Top-level source files only (no recursion).
  const files = yield* fs.glob(SOURCE_GLOB, {
    cwd: root,
    include: "file",
    dot: false,
    ignore: IGNORE_GLOBS,
  })

  // Top-level entries (files + dirs) so we can pick out immediate directories.
  // These are collapsed nodes — we never descend into them.
  const entries = yield* fs.glob(ENTRY_GLOB, {
    cwd: root,
    include: "all",
    dot: false,
    ignore: IGNORE_GLOBS,
  })

  // Stable set of repo-relative POSIX paths, sorted for determinism, capped.
  const relFiles = files
    .map((f) => toPosix(path.relative(root, path.isAbsolute(f) ? f : path.join(root, f))))
    .toSorted()
    .slice(0, MAX_FILES)

  // Directory nodes: immediate children of root that are directories and not
  // ignored. Anything containing a "/" is below the first layer and skipped. We
  // stat each candidate to tell directories apart from non-source top-level
  // files (which we don't render).
  const fileSet = new Set(relFiles)
  const candidates = [
    ...new Set(
      entries
        .map((e) => toPosix(path.relative(root, path.isAbsolute(e) ? e : path.join(root, e))))
        .filter((rel) => rel !== "" && !rel.includes("/") && !fileSet.has(rel) && !IGNORED_DIR_SET.has(rel)),
    ),
  ]
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

  const positions = layout(relFiles, [...dirSet])

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
// always maps to the same id across runs.
function nodeID(relPath: string) {
  return "n_" + createHash("sha256").update(relPath).digest("hex").slice(0, 16)
}

// --- deterministic layout --------------------------------------------------

// Layer = directory depth (root files at layer 0). Index = stable position
// within a layer, assigned by sorted path order. Orientation-agnostic; the
// renderer maps (layer, index) to screen coordinates per its strategy.
function layout(files: string[], dirs: string[]) {
  const all = [...dirs, ...files].toSorted()
  const byLayer = new Map<number, string[]>()
  for (const p of all) {
    const depth = p === "" ? 0 : p.split("/").length - 1
    const bucket = byLayer.get(depth) ?? []
    bucket.push(p)
    byLayer.set(depth, bucket)
  }
  const positions = new Map<string, CodeGraphPayload.Position>()
  for (const [layer, members] of byLayer) {
    members.toSorted().forEach((p, index) => positions.set(p, { layer, index }))
  }
  return positions
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
