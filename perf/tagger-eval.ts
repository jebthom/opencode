#!/usr/bin/env bun
/**
 * Tagger context eval (throwaway, perf/). Standalone — deliberately does NOT use
 * opencode's Effect/Provider stack; it talks to Anthropic directly with
 * ANTHROPIC_API_KEY and a hard-coded Haiku model. It recreates the semantic
 * tagger's prompt construction and runs it over a repo under three context modes
 * to compare token usage:
 *
 *   minimal — path + imports + leading comment   (the production-active mode)
 *   medium  — minimal + exports + file head       (built, currently inactive)
 *   full    — path + entire file body             (naive baseline, no engineering)
 *
 * The only variable across modes is the per-file context block; the SYSTEM prompt
 * and output schema are identical, so the measured token delta is attributable to
 * context content alone. No stale/hash skip and no per-pass cap: every non-ignored
 * source file is tagged.
 *
 * Batching is per directory level (all files whose immediate parent is the same
 * directory go in one request) — this keeps request counts low without the fixed
 * 30-file chunk, and is the batching we intend to port back into the tagger. A
 * directory that still overflows the model context is bisected automatically.
 *
 * Source of truth for the recreated logic:
 *   packages/opencode/src/codegraph/{tagger,extract,semantics}.ts
 * The taxonomy (LAYERS/LAYER_DESCRIPTION) is imported from semantics.ts (which is
 * dependency-free) so it can never drift; everything else is a faithful copy kept
 * inline to keep this script self-contained.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... bun perf/tagger-eval.ts [dir] [--all|--minimal|--medium|--full] [--limit N] [--model ID]
 *     dir     directory to scan (default: current working directory)
 *     --all   run all three modes (default when no mode flag is given)
 *     --minimal/--medium/--full   run only the named mode(s); combinable
 *     --limit N   operator smoke-test cap on files scanned (NOT the tagger's skip;
 *                 the tagger's own skipping is fully disabled). Default: unlimited.
 *     --model ID  override the model id (default below)
 *
 * Examples (run from the opencode repo root, with ANTHROPIC_API_KEY exported):
 *   # full run — every non-ignored source file in projects/opencode, all 3 modes
 *   bun perf/tagger-eval.ts . --all
 *
 *   # small sanity check — just the codegraph dir (~9 files), all 3 modes (~3 calls)
 *   bun perf/tagger-eval.ts packages/opencode/src/codegraph --all
 *
 * Results are written to perf/logs/tagger-eval-<timestamp>.log so runs never
 * overwrite each other; a summary is also printed to stdout.
 */

import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { LAYERS, LAYER_DESCRIPTION } from "../packages/opencode/src/codegraph/semantics"

// Talks to the Anthropic Messages API over fetch directly — no `ai`/`@ai-sdk`/zod
// (those resolve only inside packages/opencode), so the script stays self-contained
// and resolvable from perf/. Structured output is obtained with a single forced
// tool whose input_schema mirrors the tagger's TagResult; usage is read straight
// off the API response. The schema's token contribution is tiny and constant
// across modes, so it doesn't distort the minimal/medium/full comparison.
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"

// --- config (copied from tagger.ts / extract.ts) ---------------------------

let MODEL_ID = "claude-haiku-4-5"
const SOURCE_EXTS = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "py"]
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv", "venv"])
const MAX_FILE_BYTES = 512 * 1024
const HEAD_LINES = 30
const MAX_COMMENT_CHARS = 240
const RETRY_ATTEMPTS = 4

type Mode = "minimal" | "medium" | "full"
const ALL_MODES: Mode[] = ["minimal", "medium", "full"]

// --- CLI --------------------------------------------------------------------

const argv = process.argv.slice(2)
let dir: string | undefined
let limit: number | undefined
const selected = new Set<Mode>()
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!
  if (a === "--all") for (const m of ALL_MODES) selected.add(m)
  else if (a === "--minimal" || a === "--medium" || a === "--full") selected.add(a.slice(2) as Mode)
  else if (a === "--limit") limit = Number.parseInt(argv[++i] ?? "", 10)
  else if (a === "--model") MODEL_ID = argv[++i] ?? MODEL_ID
  else if (!a.startsWith("--")) dir = a
}
const modes = selected.size > 0 ? ALL_MODES.filter((m) => selected.has(m)) : ALL_MODES
const root = path.resolve(dir ?? process.cwd())

const apiKey = process.env.ANTHROPIC_API_KEY
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY is not set.")
  process.exit(1)
}

// --- recreated tagger context construction ---------------------------------

const SYSTEM = [
  "You assign each source file to exactly one architectural layer of a codebase.",
  "Layers:",
  ...LAYERS.map((l) => `- ${l}: ${LAYER_DESCRIPTION[l]}`),
  "Infer the layer from the file path, its imports, and its leading comment.",
  "Return one entry per input file, echoing its exact path.",
].join("\n")

// Mirrors tagger.ts TagResult; used as the forced tool's input_schema.
const TOOL = {
  name: "record_layers",
  description: "Record the architectural layer assigned to each input file.",
  input_schema: {
    type: "object",
    properties: {
      files: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            layer: { type: "string", enum: [...LAYERS] },
          },
          required: ["path", "layer"],
        },
      },
    },
    required: ["files"],
  },
} as const

// Per-file context block. minimal/medium mirror tagger.ts `describe`; full is the
// naive baseline that dumps the whole (capped) file under the same SYSTEM prompt.
function describe(rel: string, content: string, mode: Mode): string {
  const capped = content.length > MAX_FILE_BYTES ? content.slice(0, MAX_FILE_BYTES) : content
  if (mode === "full") return [`path: ${rel}`, "content:", capped].join("\n")
  const imports = parseImports(rel, capped)
  const comment = leadingComment(capped)
  const lines = [`path: ${rel}`]
  if (imports.length) lines.push(`imports: ${imports.slice(0, 20).join(", ")}`)
  if (comment) lines.push(`comment: ${comment}`)
  if (mode === "medium") {
    const exports = exportedNames(capped)
    if (exports.length) lines.push(`exports: ${exports.slice(0, 20).join(", ")}`)
    lines.push("head:", capped.split("\n").slice(0, HEAD_LINES).join("\n"))
  }
  return lines.join("\n")
}

// import parsing — copied from extract.ts
const TS_FROM = /\bfrom\s*["']([^"']+)["']/g
const TS_REQUIRE = /require\(\s*["']([^"']+)["']\s*\)/g
const TS_DYNAMIC = /import\(\s*["']([^"']+)["']\s*\)/g
const PY_FROM = /^\s*from\s+([.\w]+)\s+import\s+/gm
const PY_IMPORT = /^\s*import\s+([.\w]+)/gm
function parseImports(file: string, content: string): string[] {
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

// leading comment + exported names — copied from tagger.ts
function leadingComment(content: string): string {
  const out: string[] = []
  for (const raw of content.split("\n")) {
    const line = raw.trim()
    if (line === "" && out.length === 0) continue
    const stripped = line
      .replace(/^\/\/+/, "")
      .replace(/^\/\*+/, "")
      .replace(/\*+\/$/, "")
      .replace(/^\*+/, "")
      .replace(/^#+/, "")
      .trim()
    const isComment = /^(\/\/|\/\*|\*|#)/.test(line)
    if (!isComment && line !== "") break
    if (stripped) out.push(stripped)
    if (out.join(" ").length > MAX_COMMENT_CHARS) break
  }
  return out.join(" ").slice(0, MAX_COMMENT_CHARS)
}

const EXPORT_DECL = /^export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/gm
const EXPORT_LIST = /^export\s*\{([^}]*)\}/gm
function exportedNames(content: string): string[] {
  const names = new Set<string>()
  for (const m of content.matchAll(EXPORT_DECL)) names.add(m[1]!)
  for (const m of content.matchAll(EXPORT_LIST)) {
    for (const part of m[1]!.split(",")) names.add(part.trim().replace(/\s+as\s+.*/, "").trim())
  }
  names.delete("")
  return [...names]
}

// --- repo walk --------------------------------------------------------------

async function walkFiles(rootDir: string): Promise<string[]> {
  const glob = new Bun.Glob(`**/*.{${SOURCE_EXTS.join(",")}}`)
  const out: string[] = []
  for await (const rel of glob.scan({ cwd: rootDir, onlyFiles: true, dot: false })) {
    const posix = rel.split(path.sep).join("/")
    if (posix.split("/").some((seg) => IGNORED_DIRS.has(seg))) continue
    out.push(posix)
  }
  return out.toSorted()
}

function posixDir(p: string): string {
  const i = p.lastIndexOf("/")
  return i === -1 ? "" : p.slice(0, i)
}

// --- model call + batch runner ----------------------------------------------

interface Acc {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  classified: number
  calls: number
  bisects: number
  failures: string[]
  wallclockMs: number
  // rel path → assigned layer, for the cross-mode per-file comparison table.
  tags: Map<string, string>
}
const freshAcc = (): Acc => ({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  classified: 0,
  calls: 0,
  bisects: 0,
  failures: [],
  wallclockMs: 0,
  tags: new Map(),
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class ApiError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
  }
}

// One Messages API call with a forced tool. Returns the classified files plus raw
// input/output token usage. Throws ApiError(retryable) so the caller can back off
// (rate limit / overload / 5xx) or bisect (4xx context overflow).
async function classify(blocks: string, maxTokens: number) {
  let res: Response
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey!,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL_ID,
        max_tokens: maxTokens,
        temperature: 0,
        system: SYSTEM,
        messages: [{ role: "user", content: `Classify these files:\n\n${blocks}` }],
        tools: [TOOL],
        tool_choice: { type: "tool", name: TOOL.name },
      }),
    })
  } catch (e) {
    throw new ApiError(`network: ${e instanceof Error ? e.message : String(e)}`, true)
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    const retryable = res.status === 429 || res.status === 529 || res.status >= 500
    throw new ApiError(`${res.status} ${body.slice(0, 300)}`, retryable)
  }
  const json = (await res.json()) as {
    content?: Array<{ type: string; name?: string; input?: { files?: Array<{ path: string; layer: string }> } }>
    usage?: { input_tokens?: number; output_tokens?: number }
  }
  const tool = json.content?.find((c) => c.type === "tool_use" && c.name === TOOL.name)
  const files = tool?.input?.files ?? []
  return {
    files,
    inputTokens: json.usage?.input_tokens ?? 0,
    outputTokens: json.usage?.output_tokens ?? 0,
  }
}

// Retry transient errors with backoff; rethrow non-retryable ones immediately so
// the caller can bisect instead of hammering a request that can never fit.
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown
  for (let i = 0; i < RETRY_ATTEMPTS; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      const retryable = e instanceof ApiError && e.retryable
      if (!retryable || i === RETRY_ATTEMPTS - 1) throw e
      await sleep(500 * 2 ** i)
    }
  }
  throw last
}

type Item = { rel: string; content: string }

async function runBatch(items: Item[], mode: Mode, acc: Acc): Promise<void> {
  if (items.length === 0) return
  const blocks = items.map((it) => describe(it.rel, it.content, mode)).join("\n\n")
  const maxTokens = Math.min(8192, items.length * 64 + 256)
  try {
    const { files, inputTokens, outputTokens } = await withRetry(() => classify(blocks, maxTokens))
    acc.inputTokens += inputTokens
    acc.outputTokens += outputTokens
    acc.totalTokens += inputTokens + outputTokens
    acc.classified += files.length
    acc.calls += 1
    for (const f of files) acc.tags.set(f.path, f.layer)
  } catch (e) {
    if (items.length === 1) {
      acc.failures.push(`${items[0]!.rel}: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    acc.bisects += 1
    const mid = Math.ceil(items.length / 2)
    await runBatch(items.slice(0, mid), mode, acc)
    await runBatch(items.slice(mid), mode, acc)
  }
}

async function runMode(mode: Mode, byDir: Map<string, Item[]>): Promise<Acc> {
  const acc = freshAcc()
  const t0 = performance.now()
  for (const items of byDir.values()) await runBatch(items, mode, acc)
  acc.wallclockMs = performance.now() - t0
  return acc
}

// --- report -----------------------------------------------------------------

function fmtModeReport(mode: Mode, acc: Acc, readable: number, batches: number): string {
  const perFile = readable ? (acc.totalTokens / readable).toFixed(1) : "0"
  const lines = [
    `[${mode}]`,
    `  files scanned     : ${readable}`,
    `  files classified  : ${acc.classified}${acc.classified === readable ? " (ok)" : " (MISMATCH — sanity check)"}`,
    `  directory batches : ${batches}`,
    `  model calls       : ${acc.calls}${acc.bisects ? ` (+${acc.bisects} bisects)` : ""}`,
    `  input tokens      : ${acc.inputTokens}`,
    `  output tokens     : ${acc.outputTokens}`,
    `  total tokens      : ${acc.totalTokens}  (${perFile}/file)`,
    `  wallclock         : ${(acc.wallclockMs / 1000).toFixed(1)}s`,
  ]
  if (acc.failures.length) {
    lines.push(`  hard failures     : ${acc.failures.length}`)
    for (const f of acc.failures) lines.push(`    - ${f}`)
  }
  return lines.join("\n")
}

// Per-file layer assignments side by side across the modes that ran (rows = files,
// columns = modes), so the reduced-context modes can be judged against `full`. A
// trailing "≠" flags rows where the modes disagree; "—" marks a file a mode never
// returned (e.g. a hard-failed batch). Log-only — too wide for the console.
function fmtTagTable(results: { mode: Mode; acc: Acc }[], files: string[]): string {
  const pad = (s: string, w: number) => s.padEnd(w)
  const showDiff = results.length >= 2
  const cell = (i: number, rel: string) => results[i]!.acc.tags.get(rel) ?? "—"
  const pathW = Math.max("File".length, ...files.map((f) => f.length))
  const colW = results.map((r, i) => Math.max(r.mode.length, ...files.map((f) => cell(i, f).length)))

  const headerRow =
    pad("File", pathW) + "  " + results.map((r, i) => pad(r.mode, colW[i]!)).join("  ") + (showDiff ? "  diff" : "")
  const rows = files.map((f) => {
    const vals = results.map((_, i) => cell(i, f))
    const diff = showDiff && new Set(vals).size > 1 ? "≠" : ""
    return pad(f, pathW) + "  " + vals.map((v, i) => pad(v, colW[i]!)).join("  ") + (showDiff ? "  " + diff : "")
  })
  return ["Per-file tags (rows = files, columns = modes):", "", headerRow, "-".repeat(headerRow.length), ...rows].join(
    "\n",
  )
}

// --- main -------------------------------------------------------------------

async function main() {
  const started = new Date()
  console.log(`Scanning ${root} …`)
  const enumerated = await walkFiles(root)
  const capped = limit !== undefined && Number.isFinite(limit) ? enumerated.slice(0, limit) : enumerated

  // Read once, reuse across modes; unreadable files are dropped (as the tagger
  // does). Reading happens outside the timed sections so wallclock is model time.
  const contents = new Map<string, string>()
  for (const rel of capped) {
    const file = Bun.file(path.join(root, rel))
    try {
      contents.set(rel, await file.text())
    } catch {
      /* skip unreadable */
    }
  }

  const byDir = new Map<string, Item[]>()
  for (const [rel, content] of contents) {
    const d = posixDir(rel)
    const bucket = byDir.get(d) ?? []
    bucket.push({ rel, content })
    byDir.set(d, bucket)
  }
  const batches = byDir.size

  const header = [
    `tagger context eval — ${started.toISOString()}`,
    `target      : ${root}`,
    `model       : ${MODEL_ID}`,
    `modes       : ${modes.join(", ")}`,
    `files       : ${enumerated.length} enumerated, ${contents.size} readable${
      limit !== undefined ? ` (limited to ${limit})` : ""
    }`,
    `directories : ${batches} (one request per directory level, bisected on overflow)`,
    "",
  ].join("\n")
  console.log("\n" + header)

  const reports: string[] = []
  const results: { mode: Mode; acc: Acc }[] = []
  for (const mode of modes) {
    console.log(`Running ${mode} …`)
    const acc = await runMode(mode, byDir)
    const report = fmtModeReport(mode, acc, contents.size, batches)
    reports.push(report)
    console.log(report + "\n")
    results.push({ mode, acc })
  }

  // The per-file tag table is log-only (wide and long); stdout keeps the summaries.
  const table = fmtTagTable(results, [...contents.keys()].toSorted())

  const stamp = started.toISOString().replace(/[:.]/g, "-")
  const logDir = path.join(import.meta.dir, "logs")
  await mkdir(logDir, { recursive: true })
  const logPath = path.join(logDir, `tagger-eval-${stamp}.log`)
  await writeFile(logPath, header + "\n" + reports.join("\n\n") + "\n\n" + table + "\n")
  console.log(`Wrote ${logPath}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
