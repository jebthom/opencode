import { Effect } from "effect"
import path from "path"
import { createHash } from "crypto"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CodeGraphPayload } from "./payload"

// Deterministic structure extractor. Produces a CodeGraphPayload from a
// directory tree plus lightweight import parsing for TS/JS and Python. No agent
// involvement here — the output depends only on the files on disk, so the same
// repo state always yields the same payload (see PLAN.md, step 1).

const SOURCE_GLOB = "**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts,py}"

// Directories that never carry useful structure and would otherwise dominate the
// graph. Excluded from the file walk.
const IGNORED_DIRS = ["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv", "venv"]

export const extract = Effect.fn("CodeGraph.extract")(function* (root: string) {
  const fs = yield* FSUtil.Service
  const files = yield* fs.glob(SOURCE_GLOB, {
    cwd: root,
    include: "file",
    dot: false,
  })

  // Stable set of repo-relative POSIX paths, sorted for determinism.
  const relFiles = files
    .map((f) => toPosix(path.relative(root, path.isAbsolute(f) ? f : path.join(root, f))))
    .filter((f) => !f.split("/").some((seg) => IGNORED_DIRS.includes(seg)))
    .toSorted()

  // Build the node set: every file, plus every ancestor directory.
  const dirSet = new Set<string>()
  for (const f of relFiles) {
    let dir = posixDir(f)
    while (dir !== "" && !dirSet.has(dir)) {
      dirSet.add(dir)
      dir = posixDir(dir)
    }
  }

  const fileSizes = new Map<string, number>()
  for (const f of relFiles) {
    const stat = yield* fs.stat(path.join(root, f)).pipe(Effect.catch(() => Effect.void))
    fileSizes.set(f, stat?.type === "File" ? Number(stat.size) : 0)
  }

  // Edges: parse imports per file and resolve to known file nodes.
  const knownFiles = new Set(relFiles)
  const edges: CodeGraphPayload.Edge[] = []
  const seenEdges = new Set<string>()
  for (const f of relFiles) {
    const content = yield* fs.readFileStringSafe(path.join(root, f)).pipe(Effect.orElseSucceed(() => undefined))
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
      size: directorySize(d, fileSizes),
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

function directorySize(dir: string, fileSizes: Map<string, number>) {
  let total = 0
  const prefix = dir + "/"
  for (const [file, size] of fileSizes) {
    if (file.startsWith(prefix)) total += size
  }
  return total
}

// --- import parsing --------------------------------------------------------

const TS_IMPORT = /(?:import|export)[\s\S]*?from\s*["']([^"']+)["']/g
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
  for (const m of content.matchAll(TS_IMPORT)) specs.add(m[1]!)
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
