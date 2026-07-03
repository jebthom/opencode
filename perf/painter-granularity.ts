#!/usr/bin/env bun
/**
 * Painter granularity eval (throwaway, perf/). Compares the two tagging
 * granularities the Aperture painter actually ships:
 *
 *   file     one facet per source FILE          (AperturePainter.paintStale)
 *   function one facet per top-level DECLARATION (AperturePainter.paintExtentsStale)
 *
 * Both are run *exactly* as deployed except that they are put on an equal
 * parallelization footing so the comparison is apples-to-apples:
 *   - identical dir-coherent binning (splitDirs → one bin per directory, big dirs
 *     split into same-dir chunks of FACET_BATCH units),
 *   - identical fan-out (FACET_FANOUT model calls in flight),
 *   - identical model, system prompt, and forced-tool output schema.
 * The only variable is the *unit*: a whole file (described by `describe`, minimal
 * context = path + imports + leading comment) vs a single top-level declaration
 * (described by `describeExtent`, context = path#name + signature + leading
 * comment). So the measured deltas — input tokens, output tokens, wallclock — are
 * attributable to granularity alone.
 *
 * Accuracy/consistency are NOT measured (they aren't comparable across
 * granularities — the two produce different numbers of tags over different units).
 * Only cost is: input/output token usage and clocktime.
 *
 * Standalone by design: like tagger-eval.ts it does NOT boot opencode's
 * Effect/Provider stack. It talks to the Anthropic Messages API directly with
 * ANTHROPIC_API_KEY and a hard-coded Haiku-class model, obtaining structured output
 * via a single forced tool whose enum mirrors the painter's facet schema. To avoid
 * drift, the pieces that CAN be imported dependency-free are imported from the live
 * source (extent extraction, the Lens vocabulary + system prompt); the per-unit
 * context builders (describe/describeExtent/leadingComment) and import parsing live
 * in painter.ts/extract.ts, which pull in Effect and can't resolve from perf/, so
 * they are faithful inline copies kept in sync with:
 *   packages/opencode/src/aperture/{painter,extract}.ts
 *
 * The comparison is driven with the built-in ARCHITECTURE Lens: the on-disk active
 * lens is often a deterministic built-in (git-changed / edit-recency) that spends no
 * tokens, so it can't stand in for a semantic painter. ARCHITECTURE is the
 * representative model-painted vocabulary and the one the file-level path shipped
 * with.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... bun perf/painter-granularity.ts [dir] [--file] [--function]
 *     dir            directory to scan (default: current working directory)
 *     --file         run only the file-granularity strategy
 *     --function     run only the function-granularity strategy
 *                    (default: run both)
 *     --concurrency N   in-flight model calls (default 64 = FACET_FANOUT)
 *     --batch N      units per dir-chunk (default 30 = FACET_BATCH)
 *     --repeat N     rerun each strategy N times; wallclock/token spread is averaged
 *     --limit N      cap files scanned (smoke test). Default: unlimited.
 *     --model ID     override the model id (default claude-haiku-4-5)
 *     --dry-run      build bins and print unit/bin/token estimates only; no API calls
 *
 * Examples (run from the opencode repo root, ANTHROPIC_API_KEY exported):
 *   # whole repo, both granularities
 *   bun perf/painter-granularity.ts .
 *
 *   # small sanity check — just the aperture dir, both granularities
 *   bun perf/painter-granularity.ts packages/opencode/src/aperture
 *
 *   # plan bins without spending tokens
 *   bun perf/painter-granularity.ts packages/opencode/src/aperture --dry-run
 *
 * Results are written to perf/logs/painter-granularity-<timestamp>.log; a summary is
 * printed to stdout.
 */

import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { extentsOf, extentText, PREAMBLE } from "../packages/opencode/src/aperture/extents"
import {
  ARCHITECTURE,
  buildSystemPrompt,
  facetEnumIds,
  isAssignableFacet,
  type Lens,
} from "../packages/opencode/src/aperture/lenses"

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"

// --- config (mirrors painter.ts) -------------------------------------------

let MODEL_ID = "claude-haiku-4-5"
const SOURCE_EXTS = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "py"]
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv", "venv"])
const MAX_FILE_BYTES = 512 * 1024
const MAX_COMMENT_CHARS = 240
// painter.ts: FACET_BATCH (units per dir-chunk), FACET_FANOUT (in-flight calls).
const FACET_BATCH = 30
const FACET_FANOUT = 64
const RETRY_ATTEMPTS = 4
// Chars per input token — a free, reproducible bin-size estimate. Same constant the
// tagger-eval calibrated over packages/opencode TS/JS (~3.6). Only used for the
// dry-run/plan estimate; real token counts come from the API.
const TOKENS_PER_CHAR = 1 / 3.6

type Strategy = "file" | "function"
const ALL_STRATEGIES: Strategy[] = ["file", "function"]

// The semantic Lens driving the comparison. See header — the on-disk active lens may
// be a deterministic (token-free) built-in, so we use the architecture vocabulary.
const LENS: Lens = ARCHITECTURE

// --- CLI --------------------------------------------------------------------

const argv = process.argv.slice(2)
let dir: string | undefined
let limit: number | undefined
let concurrency = FACET_FANOUT
let batch = FACET_BATCH
let repeat = 1
let dryRun = false
const selected = new Set<Strategy>()
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!
  if (a === "--file") selected.add("file")
  else if (a === "--function") selected.add("function")
  else if (a === "--limit") limit = Number.parseInt(argv[++i] ?? "", 10)
  else if (a === "--model") MODEL_ID = argv[++i] ?? MODEL_ID
  else if (a === "--concurrency") concurrency = Math.max(1, Number.parseInt(argv[++i] ?? "64", 10))
  else if (a === "--batch") batch = Math.max(1, Number.parseInt(argv[++i] ?? "30", 10))
  else if (a === "--repeat") repeat = Math.max(1, Number.parseInt(argv[++i] ?? "1", 10))
  else if (a === "--dry-run") dryRun = true
  else if (!a.startsWith("--")) dir = a
}
const strategies = selected.size > 0 ? ALL_STRATEGIES.filter((s) => selected.has(s)) : ALL_STRATEGIES
const root = path.resolve(dir ?? process.cwd())

const apiKey = process.env.ANTHROPIC_API_KEY
if (!apiKey && !dryRun) {
  console.error("ANTHROPIC_API_KEY is not set.")
  process.exit(1)
}

// --- system prompt + forced tool (from the live Lens) ----------------------

const SYSTEM = buildSystemPrompt(LENS)

// Mirrors the painter's structured output (buildFacetSchema): one {path, facet} per
// input unit, facet constrained to the Lens's facet ids + the NONE escape.
const TOOL = {
  name: "record_facets",
  description: "Record the facet assigned to each input unit.",
  input_schema: {
    type: "object",
    properties: {
      files: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            facet: { type: "string", enum: facetEnumIds(LENS) },
          },
          required: ["path", "facet"],
        },
      },
    },
    required: ["files"],
  },
} as const

// --- per-unit context builders (faithful copies of painter.ts) --------------

// File-level minimal context: path + parsed import specifiers + leading comment.
// Copy of painter.ts `describe` (minimal branch only; medium is not compared here).
function describe(rel: string, content: string): string {
  const capped = content.length > MAX_FILE_BYTES ? content.slice(0, MAX_FILE_BYTES) : content
  const imports = parseImports(rel, capped)
  const comment = leadingComment(capped)
  const lines = [`path: ${rel}`]
  if (imports.length) lines.push(`imports: ${imports.slice(0, 20).join(", ")}`)
  if (comment) lines.push(`comment: ${comment}`)
  return lines.join("\n")
}

// Function-level context: path#name label, the declaration's signature (first
// non-blank line), and any leading comment. Copy of painter.ts `describeExtent`.
function describeExtent(relPath: string, name: string, text: string): string {
  const signature = (text.split("\n").find((l) => l.trim() !== "") ?? "").trim().slice(0, 200)
  const comment = leadingComment(text)
  const lines = [`path: ${relPath}#${name}`]
  if (signature) lines.push(`signature: ${signature}`)
  if (comment) lines.push(`comment: ${comment}`)
  return lines.join("\n")
}

// Copy of painter.ts `leadingComment`.
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

// Copy of extract.ts `parseImports` (extract.ts imports Effect/FSUtil, so it can't
// resolve from perf/).
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

// Immediate parent directory of a repo-relative POSIX path; "" for a root-level file.
// For a function unit ("src/foo.ts#bar") the "#name" is after the last "/", so this
// still returns the file's directory — the same dir-coherence painter.ts relies on.
function posixDir(p: string): string {
  const i = p.lastIndexOf("/")
  return i === -1 ? "" : p.slice(0, i)
}

// --- units + binning --------------------------------------------------------

// One classifiable unit: an echo `path` (a file path, or `file#decl`) and the
// per-unit context block sent to the model.
type Unit = { path: string; block: string }

// File granularity: one unit per readable file, described minimally.
function fileUnits(contents: Map<string, string>): Unit[] {
  return [...contents].map(([rel, content]) => ({ path: rel, block: describe(rel, content) }))
}

// Function granularity: one unit per top-level declaration. Mirrors paintExtentsStale
// — extentsOf minus the PREAMBLE residual (a declaration-less file yields only a
// preamble, so it produces no function units and is left to file-level tagging).
function functionUnits(contents: Map<string, string>): Unit[] {
  const units: Unit[] = []
  for (const [rel, content] of contents) {
    for (const extent of extentsOf(content)) {
      if (extent.name === PREAMBLE) continue
      units.push({ path: `${rel}#${extent.name}`, block: describeExtent(rel, extent.name, extentText(content, extent)) })
    }
  }
  return units
}

// "dirsplit" binning — the exact scheme painter.ts ships (splitDirs): one bin per
// immediate directory, never merged across directories; a directory with more than
// `maxFiles` units is split into same-directory chunks of that size. Each bin is one
// model call.
function splitDirs(units: Unit[], maxFiles: number): Unit[][] {
  const byDir = new Map<string, Unit[]>()
  for (const u of units) {
    const d = posixDir(u.path)
    const bucket = byDir.get(d) ?? []
    bucket.push(u)
    byDir.set(d, bucket)
  }
  const bins: Unit[][] = []
  for (const dirUnits of byDir.values()) {
    const sorted = [...dirUnits].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    for (let i = 0; i < sorted.length; i += maxFiles) bins.push(sorted.slice(i, i + maxFiles))
  }
  return bins
}

function buildUnits(strategy: Strategy, contents: Map<string, string>): Unit[] {
  return strategy === "file" ? fileUnits(contents) : functionUnits(contents)
}

function estimateBinTokens(bin: Unit[]): number {
  const chars = bin.map((u) => u.block).join("\n\n").length
  return Math.ceil(chars * TOKENS_PER_CHAR)
}

// --- model call + batch runner ----------------------------------------------

interface Acc {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  classified: number
  calls: number
  bisects: number
  retries: number
  backoffMs: number
  failures: string[]
  wallclockMs: number
}
const freshAcc = (): Acc => ({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  classified: 0,
  calls: 0,
  bisects: 0,
  retries: 0,
  backoffMs: 0,
  failures: [],
  wallclockMs: 0,
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

// One Messages API call with a forced tool; returns classified units + raw usage.
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
    content?: Array<{ type: string; name?: string; input?: { files?: Array<{ path: string; facet: string }> } }>
    usage?: { input_tokens?: number; output_tokens?: number }
  }
  const tool = json.content?.find((c) => c.type === "tool_use" && c.name === TOOL.name)
  const files = (tool?.input?.files ?? []).filter((f) => isAssignableFacet(LENS, f.facet))
  return {
    files,
    inputTokens: json.usage?.input_tokens ?? 0,
    outputTokens: json.usage?.output_tokens ?? 0,
  }
}

async function withRetry<T>(fn: () => Promise<T>, stats?: { retries: number; backoffMs: number }): Promise<T> {
  let last: unknown
  for (let i = 0; i < RETRY_ATTEMPTS; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      const retryable = e instanceof ApiError && e.retryable
      if (!retryable || i === RETRY_ATTEMPTS - 1) throw e
      const wait = 500 * 2 ** i
      if (stats) {
        stats.retries += 1
        stats.backoffMs += wait
      }
      await sleep(wait)
    }
  }
  throw last
}

async function runBin(bin: Unit[], acc: Acc): Promise<void> {
  if (bin.length === 0) return
  const blocks = bin.map((u) => u.block).join("\n\n")
  const maxTokens = Math.min(8192, bin.length * 64 + 256)
  try {
    const { files, inputTokens, outputTokens } = await withRetry(() => classify(blocks, maxTokens), acc)
    acc.inputTokens += inputTokens
    acc.outputTokens += outputTokens
    acc.totalTokens += inputTokens + outputTokens
    acc.classified += files.length
    acc.calls += 1
  } catch (e) {
    // Non-retryable (context overflow): bisect the bin, exactly like runBatch.
    if (bin.length === 1) {
      acc.failures.push(`${bin[0]!.path}: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    acc.bisects += 1
    const mid = Math.ceil(bin.length / 2)
    await runBin(bin.slice(0, mid), acc)
    await runBin(bin.slice(mid), acc)
  }
}

// Run a worker over the bins with at most `limit` in flight — the painter's fan-out.
async function runPool(bins: Unit[][], limit: number, worker: (b: Unit[]) => Promise<void>): Promise<void> {
  let next = 0
  const run = async (): Promise<void> => {
    while (next < bins.length) {
      const i = next++
      await worker(bins[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, bins.length) }, run))
}

async function runBins(bins: Unit[][]): Promise<Acc> {
  const acc = freshAcc()
  const t0 = performance.now()
  await runPool(bins, concurrency, (bin) => runBin(bin, acc))
  acc.wallclockMs = performance.now() - t0
  return acc
}

// --- report -----------------------------------------------------------------

function fmtReport(strategy: Strategy, units: number, bins: Unit[][], acc: Acc, files: number): string {
  const binSizes = bins.map((b) => b.length)
  const avgFiles = bins.length ? (binSizes.reduce((s, v) => s + v, 0) / bins.length).toFixed(1) : "0"
  const maxBin = bins.length ? Math.max(...binSizes) : 0
  const perFile = files ? (acc.totalTokens / files).toFixed(1) : "0"
  const perUnit = units ? (acc.totalTokens / units).toFixed(1) : "0"
  const avgCallMs = acc.calls ? (acc.wallclockMs / acc.calls).toFixed(0) : "0"
  const lines = [
    `[${strategy}]`,
    `  files scanned     : ${files}`,
    `  units (${strategy === "file" ? "files" : "declarations"})   : ${units}`,
    `  units classified  : ${acc.classified}${acc.classified === units ? " (ok)" : " (MISMATCH — sanity check)"}`,
    `  bins              : ${bins.length} (avg ${avgFiles} units/bin, max ${maxBin})`,
    `  model calls       : ${acc.calls}${acc.bisects ? ` (+${acc.bisects} bisects)` : ""}`,
    `  input tokens      : ${acc.inputTokens}`,
    `  output tokens     : ${acc.outputTokens}`,
    `  total tokens      : ${acc.totalTokens}  (${perFile}/file, ${perUnit}/unit)`,
    `  wallclock         : ${(acc.wallclockMs / 1000).toFixed(1)}s  (concurrency ${concurrency}, avg ${avgCallMs}ms/call)`,
    `  throttle          : ${acc.retries} retries, ${acc.backoffMs}ms cumulative backoff`,
  ]
  if (acc.failures.length) {
    lines.push(`  hard failures     : ${acc.failures.length}`)
    for (const f of acc.failures) lines.push(`    - ${f}`)
  }
  return lines.join("\n")
}

function fmtBinPlan(strategy: Strategy, units: number, bins: Unit[][], files: number): string {
  const sizes = bins.map((b) => b.length)
  const toks = bins.map((b) => estimateBinTokens(b))
  return [
    `[${strategy}]`,
    `  files scanned : ${files}`,
    `  units         : ${units} (${strategy === "file" ? "files" : "declarations"})`,
    `  bins          : ${bins.length}`,
    `  units/bin     : avg ${bins.length ? (units / bins.length).toFixed(1) : "0"}, max ${bins.length ? Math.max(...sizes) : 0}`,
    `  est tok/bin   : avg ${bins.length ? Math.round(toks.reduce((s, v) => s + v, 0) / bins.length) : 0}, max ${bins.length ? Math.max(...toks) : 0}`,
    `  est input tok : ${toks.reduce((s, v) => s + v, 0)} (block-only; per-call SYSTEM+schema overhead not counted)`,
  ].join("\n")
}

// --- main -------------------------------------------------------------------

async function main() {
  const started = new Date()
  console.log(`Scanning ${root} …`)
  const enumerated = await walkFiles(root)
  const capped = limit !== undefined && Number.isFinite(limit) ? enumerated.slice(0, limit) : enumerated

  const contents = new Map<string, string>()
  for (const rel of capped) {
    try {
      contents.set(rel, await Bun.file(path.join(root, rel)).text())
    } catch {
      /* skip unreadable */
    }
  }

  if (dryRun) {
    console.log(`\nDry run — ${strategies.join(", ")}, ${contents.size} files (no API calls):\n`)
    for (const strat of strategies) {
      const units = buildUnits(strat, contents)
      console.log(fmtBinPlan(strat, units.length, splitDirs(units, batch), contents.size) + "\n")
    }
    return
  }

  const header = [
    `painter granularity eval — ${started.toISOString()}`,
    `target      : ${root}`,
    `model       : ${MODEL_ID}`,
    `lens        : ${LENS.id} (${LENS.facets.length} facets)`,
    `strategies  : ${strategies.join(", ")}`,
    `params      : batch ${batch} units/chunk, concurrency ${concurrency}`,
    `repeat      : ${repeat}`,
    `files       : ${enumerated.length} enumerated, ${contents.size} readable${
      limit !== undefined ? ` (limited to ${limit})` : ""
    }`,
    "",
  ].join("\n")
  console.log("\n" + header)

  const reports: string[] = []
  for (const strat of strategies) {
    const units = buildUnits(strat, contents)
    const bins = splitDirs(units, batch)
    for (let run = 1; run <= repeat; run++) {
      const label = `${strat}${repeat > 1 ? ` #${run}` : ""}`
      console.log(`Running ${label} …`)
      const acc = await runBins(bins)
      const report = fmtReport(strat, units.length, bins, acc, contents.size)
      reports.push(repeat > 1 ? report.replace(`[${strat}]`, `[${label}]`) : report)
      console.log(report + "\n")
    }
  }

  const stamp = started.toISOString().replace(/[:.]/g, "-")
  const logDir = path.join(import.meta.dir, "logs")
  await mkdir(logDir, { recursive: true })
  const logPath = path.join(logDir, `painter-granularity-${stamp}.log`)
  await writeFile(logPath, [header, reports.join("\n\n")].join("\n") + "\n")
  console.log(`Wrote ${logPath}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
