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
 * Batching is selectable with --batch (default `dir`, the legacy behaviour so
 * older perf/logs runs reproduce):
 *   fixed     the production tagger's batching: a fixed N files per request
 *             (chunkArray(stale, TAG_BATCH), TAG_BATCH = 30). The baseline the
 *             other strategies are measured against. Size via --fixed-size.
 *   dir       all files whose immediate parent is the same directory go in one
 *             request — low request count without a fixed 30-file chunk.
 *   dirsplit  one bin per directory, never merged across directories, but a
 *             directory over --max-files is split into same-directory chunks.
 *             Maximally coherent prompts; pair with --concurrency for the atomic-
 *             directory-concurrency test.
 *   ffd/bfd   token-budget bin-packing: estimate each file's block tokens, sort
 *             descending, and place into the first-fitting / best-fitting bin
 *             under --budget input tokens and --max-files files. Packs many tiny
 *             files into one fuller call to amortise per-call roundtrip overhead.
 *   locality  greedy fill in path order (keeps same-directory files adjacent),
 *             spilling to a new bin only on budget/file-cap overflow — the
 *             control case for "does size-sorting hurt tag quality?".
 *   dirpack   FFD over whole-directory atoms, merging only directories that share
 *             an immediate parent (siblings). Keeps each directory intact in one
 *             prompt for context coherence, but fills better than `dir` by packing
 *             sibling dirs together up to --budget / --max-files.
 *   balanced  split into N equal-load bins (LPT) for parallel execution, where N =
 *             --partitions (default --concurrency). Run with --concurrency it gives
 *             makespan ≈ a single bin's latency.
 * Any bin that still overflows the model context is bisected automatically.
 *
 * Token estimates use a fixed chars-per-token constant K (see TOKENS_PER_CHAR /
 * --calibrate); precision isn't critical because runBatch bisects on a real
 * overflow. Run --calibrate once on a representative dir to refit K.
 *
 * Source of truth for the recreated logic:
 *   packages/opencode/src/codegraph/{tagger,extract,semantics}.ts
 * The taxonomy (LAYERS/LAYER_DESCRIPTION) is imported from semantics.ts (which is
 * dependency-free) so it can never drift; everything else is a faithful copy kept
 * inline to keep this script self-contained.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... bun perf/tagger-eval.ts [dir] [modes] [--batch S] [--budget N] [--max-files N] [--repeat N] [--limit N] [--model ID] [--calibrate]
 *     dir     directory to scan (default: current working directory)
 *     --all   run all three modes (default when no mode flag is given)
 *     --minimal/--medium/--full   run only the named mode(s); combinable
 *     --batch dir|fixed|ffd|bfd|locality   batching strategy (default: dir).
 *                 Comma-separated or repeated to compare several in one run, e.g.
 *                 --batch fixed,dir,ffd — each becomes a column in the tag table.
 *     --budget N   per-bin input-token ceiling for ffd/bfd/locality (default 6000)
 *     --max-files N   per-bin file cap, bounds output length (default 40)
 *     --fixed-size N  files per chunk for --batch fixed (default 30, production value)
 *     --concurrency N  run bins through a pool of N workers (default 1 = sequential)
 *     --partitions N   bins for --batch balanced (default = --concurrency)
 *     --repeat N   rerun the strategy N times to gauge tag stability (default 1)
 *     --limit N   operator smoke-test cap on files scanned (NOT the tagger's skip;
 *                 the tagger's own skipping is fully disabled). Default: unlimited.
 *     --model ID  override the model id (default below)
 *     --calibrate run a calibration pass (fit K from real input_tokens) and exit
 *     --dry-run   pack bins and print fill stats only; no API calls (no key needed)
 *     --stress    probe the per-call file ceiling: send one bin of N files for each
 *                 N and count how many come back (largest N with 0 missing = ceiling)
 *     --stress-sizes N,N,…   sizes to probe (default 20,40,60,80,120,160,200,260)
 *
 * Examples (run from the opencode repo root, with ANTHROPIC_API_KEY exported):
 *   # full run — every non-ignored source file in projects/opencode, all 3 modes
 *   bun perf/tagger-eval.ts . --all
 *
 *   # small sanity check — just the codegraph dir (~9 files), all 3 modes (~3 calls)
 *   bun perf/tagger-eval.ts packages/opencode/src/codegraph --all
 *
 *   # compare the three batching methods (production fixed, dir, bin-packing)
 *   bun perf/tagger-eval.ts packages/opencode/src/codegraph --minimal --batch fixed,dir,ffd
 *
 *   # repeatability of a strategy (3 runs, stability summary in the log)
 *   bun perf/tagger-eval.ts packages/opencode/src/codegraph --minimal --batch ffd --repeat 3
 *
 *   # refit the chars-per-token constant
 *   bun perf/tagger-eval.ts packages/opencode/src/codegraph --calibrate
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
// Output-token ceiling requested in --stress. When a row's output_tokens hits this,
// the omission is the cap binding (raise it / model's own max), not a model failure.
const STRESS_MAX_OUTPUT = 8192

// Chars per input token for the per-file describe() blocks. Block text is
// deterministic, so a fixed ratio gives a free, reproducible size estimate for
// bin-packing; runBatch bisects if a real call still overflows, so the estimate
// only needs to be roughly right. Refit with --calibrate (least-squares slope of
// input_tokens vs block chars). Measured ~3.6 over packages/opencode TS/JS.
const TOKENS_PER_CHAR = 1 / 3.6

type Mode = "minimal" | "medium" | "full"
const ALL_MODES: Mode[] = ["minimal", "medium", "full"]

type Strategy = "dir" | "fixed" | "ffd" | "bfd" | "locality" | "dirpack" | "balanced" | "dirsplit"
const STRATEGIES: Strategy[] = ["dir", "fixed", "ffd", "bfd", "locality", "dirpack", "balanced", "dirsplit"]

// --- CLI --------------------------------------------------------------------

const argv = process.argv.slice(2)
let dir: string | undefined
let limit: number | undefined
const strategies: Strategy[] = []
let budget = 6000
let maxFiles = 40
let fixedSize = 30
let concurrency = 1
let partitions = 0
let repeat = 1
let calibrateOnly = false
let dryRun = false
let stress = false
let stressSizes = [20, 40, 60, 80, 120, 160, 200, 260]
const selected = new Set<Mode>()
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!
  if (a === "--all") for (const m of ALL_MODES) selected.add(m)
  else if (a === "--minimal" || a === "--medium" || a === "--full") selected.add(a.slice(2) as Mode)
  else if (a === "--limit") limit = Number.parseInt(argv[++i] ?? "", 10)
  else if (a === "--model") MODEL_ID = argv[++i] ?? MODEL_ID
  else if (a === "--batch") {
    // Comma-separated or repeated --batch: compare several strategies in one run.
    for (const s of (argv[++i] ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
      if (!STRATEGIES.includes(s as Strategy)) {
        console.error(`unknown --batch ${s}; expected one of ${STRATEGIES.join(", ")}`)
        process.exit(1)
      }
      if (!strategies.includes(s as Strategy)) strategies.push(s as Strategy)
    }
  } else if (a === "--budget") budget = Number.parseInt(argv[++i] ?? "", 10)
  else if (a === "--max-files") maxFiles = Number.parseInt(argv[++i] ?? "", 10)
  else if (a === "--fixed-size") fixedSize = Math.max(1, Number.parseInt(argv[++i] ?? "30", 10))
  else if (a === "--concurrency") concurrency = Math.max(1, Number.parseInt(argv[++i] ?? "1", 10))
  else if (a === "--partitions") partitions = Math.max(0, Number.parseInt(argv[++i] ?? "0", 10))
  else if (a === "--repeat") repeat = Math.max(1, Number.parseInt(argv[++i] ?? "1", 10))
  else if (a === "--calibrate") calibrateOnly = true
  else if (a === "--dry-run") dryRun = true
  else if (a === "--stress") stress = true
  else if (a === "--stress-sizes")
    stressSizes = (argv[++i] ?? "")
      .split(",")
      .map((x) => Number.parseInt(x.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0)
  else if (!a.startsWith("--")) dir = a
}
const modes = selected.size > 0 ? ALL_MODES.filter((m) => selected.has(m)) : ALL_MODES
if (strategies.length === 0) strategies.push("dir")
// `balanced` splits into this many equal-load bins. Defaults to the worker count
// (one bin per worker → makespan ≈ a single bin's latency); --partitions can
// oversubscribe (more bins than workers) for finer load smoothing.
const partitionCount = partitions > 0 ? partitions : Math.max(1, concurrency)
const root = path.resolve(dir ?? process.cwd())

// --dry-run only packs bins and prints fill stats; it never calls the API, so the
// key isn't required for it. Everything else (including --calibrate) needs it.
const apiKey = process.env.ANTHROPIC_API_KEY
if (!apiKey && !dryRun) {
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

// --- batching strategies ----------------------------------------------------

type Item = { rel: string; content: string }

// Free, deterministic estimate of a block's input tokens. Used only to pack bins;
// the real input_tokens come back from the API. See TOKENS_PER_CHAR.
function estimateBlockTokens(block: string): number {
  return Math.ceil(block.length * TOKENS_PER_CHAR)
}

// Estimate the tokens of a whole bin as it will actually be sent (blocks joined
// by the same "\n\n" runBatch uses). Excludes the constant SYSTEM+tool overhead,
// which is per-call and identical across strategies.
function estimateBinTokens(items: Item[], mode: Mode): number {
  return estimateBlockTokens(items.map((it) => describe(it.rel, it.content, mode)).join("\n\n"))
}

// Production parity: opencode's tagger batches with a fixed file count —
// chunkArray(stale, TAG_BATCH) with TAG_BATCH = 30 (tagger.ts). This mirrors it:
// items in path order sliced into fixed-size chunks, ignoring token size, so a
// chunk of large files can overflow and bisect — the exact risk bin-packing
// removes. This is the baseline the new strategies are measured against.
function chunkFixed(items: Item[], n: number): Item[][] {
  const sorted = [...items].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const bins: Item[][] = []
  for (let i = 0; i < sorted.length; i += n) bins.push(sorted.slice(i, i + n))
  return bins
}

// Legacy default: one bin per immediate parent directory, in path order. Matches
// the byDir batching used by prior perf/logs runs.
function batchByDir(items: Item[]): Item[][] {
  const byDir = new Map<string, Item[]>()
  for (const it of items) {
    const d = posixDir(it.rel)
    const bucket = byDir.get(d) ?? []
    bucket.push(it)
    byDir.set(d, bucket)
  }
  return [...byDir.values()]
}

// First-fit / best-fit decreasing bin-packing on estimated tokens. Items are
// sorted by descending estimate (tiebreak path, so packing is deterministic),
// then each is placed into a bin that keeps it under both `budget` tokens and
// `maxFiles` files. "first" takes the first such bin; "best" takes the fullest
// (tightest remaining space). A file bigger than `budget` lands alone — runBatch
// can't bisect a singleton, but the file is already MAX_FILE_BYTES-capped.
function pack(items: Item[], mode: Mode, fit: "first" | "best"): Item[][] {
  const sized = items
    .map((it) => ({ it, est: estimateBinTokens([it], mode) }))
    .sort((a, b) => b.est - a.est || (a.it.rel < b.it.rel ? -1 : 1))
  const bins: { items: Item[]; used: number }[] = []
  for (const { it, est } of sized) {
    let target: { items: Item[]; used: number } | null = null
    for (const bin of bins) {
      if (bin.items.length >= maxFiles || bin.used + est > budget) continue
      if (fit === "first") {
        target = bin
        break
      }
      if (!target || bin.used > target.used) target = bin
    }
    if (!target) {
      target = { items: [], used: 0 }
      bins.push(target)
    }
    target.items.push(it)
    target.used += est
  }
  return bins.map((b) => b.items)
}

// Locality-preserving greedy fill: walk files in path order (so same-directory
// files stay adjacent) and keep adding to the current bin until the next file
// breaks `budget` or `maxFiles`, then start a new bin. Trades a little fill
// efficiency for semantic coherence within each request.
function packLocality(items: Item[], mode: Mode): Item[][] {
  const sorted = [...items].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const bins: Item[][] = []
  let cur: Item[] = []
  let used = 0
  for (const it of sorted) {
    const est = estimateBinTokens([it], mode)
    if (cur.length > 0 && (used + est > budget || cur.length >= maxFiles)) {
      bins.push(cur)
      cur = []
      used = 0
    }
    cur.push(it)
    used += est
  }
  if (cur.length) bins.push(cur)
  return bins
}

// Directory-atom packing: treat each immediate directory as one indivisible unit
// (size = sum of its files' block tokens) and FFD-pack those atoms into bins — but
// only ever merge directories that share the same immediate parent, so a combined
// request stays topically related (e.g. routes/.../groups + routes/.../handlers,
// never routes/* with shared/*). Keeps whole directories in one prompt for context
// coherence while filling better than one-call-per-directory. A directory whose
// atom alone exceeds the budget/file cap becomes its own oversize bin and is
// bisected at runtime, exactly like `dir`/`fixed`.
function packDirAtoms(items: Item[], mode: Mode): Item[][] {
  // 1. files -> their immediate directory (the atoms we never split at plan time)
  const byDir = new Map<string, Item[]>()
  for (const it of items) {
    const d = posixDir(it.rel)
    const arr = byDir.get(d)
    if (arr) arr.push(it)
    else byDir.set(d, [it])
  }
  // 2. directories -> their parent; only siblings (same parent) may share a bin
  const byParent = new Map<string, string[]>()
  for (const d of byDir.keys()) {
    const parent = posixDir(d)
    const arr = byParent.get(parent)
    if (arr) arr.push(d)
    else byParent.set(parent, [d])
  }
  // 3. FFD the sibling directory-atoms within each parent group (largest first)
  const bins: Item[][] = []
  for (const dirs of byParent.values()) {
    const atoms = dirs
      .map((d) => ({ dir: d, files: byDir.get(d)!, est: estimateBinTokens(byDir.get(d)!, mode) }))
      .sort((a, b) => b.est - a.est || (a.dir < b.dir ? -1 : 1))
    const open: { files: Item[]; used: number }[] = []
    for (const atom of atoms) {
      let target: { files: Item[]; used: number } | null = null
      for (const bin of open) {
        if (bin.files.length + atom.files.length > maxFiles || bin.used + atom.est > budget) continue
        target = bin
        break
      }
      if (!target) {
        target = { files: [], used: 0 }
        open.push(target)
      }
      target.files.push(...atom.files)
      target.used += atom.est
    }
    for (const bin of open) bins.push(bin.files)
  }
  return bins
}

// Makespan-oriented partitioning for parallel execution: split into exactly k
// equal-load bins so that, run concurrently, wall ≈ one bin's latency. LPT greedy
// (longest-processing-time-first): sort by estimated tokens desc, drop each into
// the least-loaded bin. Unlike the budget packers this targets a fixed bin *count*
// (= worker count) and balances load rather than filling to a ceiling.
function partitionBalanced(items: Item[], mode: Mode, k: number): Item[][] {
  const n = Math.max(1, Math.min(k, items.length))
  const sized = items
    .map((it) => ({ it, est: estimateBinTokens([it], mode) }))
    .sort((a, b) => b.est - a.est || (a.it.rel < b.it.rel ? -1 : 1))
  const bins = Array.from({ length: n }, () => ({ items: [] as Item[], load: 0 }))
  for (const { it, est } of sized) {
    let target = bins[0]!
    for (const b of bins) if (b.load < target.load) target = b
    target.items.push(it)
    target.load += est
  }
  return bins.map((b) => b.items)
}

// Atomic-directory batching: one bin per immediate directory, never merging across
// directories; a directory with more than maxFiles files is split into
// ceil(n/maxFiles) same-directory chunks. Every bin is thus files from a single
// directory — maximally coherent prompts — at the cost of many small, underfilled
// calls (acceptable when run concurrently). Distinct from `dir` (no split, big dirs
// bisect at runtime) and `dirpack` (merges sibling dirs to fill).
function splitDirs(items: Item[]): Item[][] {
  const bins: Item[][] = []
  for (const dirFiles of batchByDir(items)) {
    const sorted = [...dirFiles].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
    for (let i = 0; i < sorted.length; i += maxFiles) bins.push(sorted.slice(i, i + maxFiles))
  }
  return bins
}

function buildBins(items: Item[], mode: Mode, strategy: Strategy): Item[][] {
  switch (strategy) {
    case "dir":
      return batchByDir(items)
    case "dirsplit":
      return splitDirs(items)
    case "fixed":
      return chunkFixed(items, fixedSize)
    case "ffd":
      return pack(items, mode, "first")
    case "bfd":
      return pack(items, mode, "best")
    case "locality":
      return packLocality(items, mode)
    case "dirpack":
      return packDirAtoms(items, mode)
    case "balanced":
      return partitionBalanced(items, mode, partitionCount)
  }
}

// --- model call + batch runner ----------------------------------------------

interface Acc {
  estInputTokens: number
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
  // rel path → assigned layer, for the cross-variant per-file comparison table.
  tags: Map<string, string>
}
const freshAcc = (): Acc => ({
  estInputTokens: 0,
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
// the caller can bisect instead of hammering a request that can never fit. When a
// stats sink is passed, count retries and cumulative backoff — the "bouncing"
// signal for the concurrency sweep (rate-limit 429/529/5xx that forced a wait).
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

async function runBatch(items: Item[], mode: Mode, acc: Acc): Promise<void> {
  if (items.length === 0) return
  const blocks = items.map((it) => describe(it.rel, it.content, mode)).join("\n\n")
  const maxTokens = Math.min(8192, items.length * 64 + 256)
  try {
    const { files, inputTokens, outputTokens } = await withRetry(() => classify(blocks, maxTokens), acc)
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

// Run an async worker over a list with at most `limit` in flight at once. Workers
// pull from a shared cursor, so uneven bin latencies still keep the pool busy.
async function runPool<T>(items: T[], limit: number, worker: (t: T) => Promise<void>): Promise<void> {
  let next = 0
  const run = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      await worker(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
}

async function runBins(bins: Item[][], mode: Mode): Promise<Acc> {
  const acc = freshAcc()
  for (const bin of bins) acc.estInputTokens += estimateBinTokens(bin, mode)
  const t0 = performance.now()
  // Bins run through a pool of `concurrency` workers; runBatch's own bisection
  // stays sequential within a bin. acc is mutated from several in-flight calls,
  // but each update is a synchronous += between awaits, so no races.
  if (concurrency <= 1) for (const bin of bins) await runBatch(bin, mode, acc)
  else await runPool(bins, concurrency, (bin) => runBatch(bin, mode, acc))
  acc.wallclockMs = performance.now() - t0
  return acc
}

// One-off: fit the chars-per-token constant K. Sends real (directory-sized)
// batches in minimal mode and records (block chars, API input_tokens) per call,
// then least-squares fits input_tokens ≈ a + b·chars. K = 1/b is the per-block
// ratio to hardcode in TOKENS_PER_CHAR; the intercept a is the constant per-call
// overhead (SYSTEM + tool schema + wrapper), a useful sanity check for --budget.
async function calibrate(items: Item[]): Promise<string> {
  const bins = batchByDir(items).filter((b) => b.length > 0)
  const samples: { chars: number; tokens: number }[] = []
  for (const bin of bins) {
    const blocks = bin.map((it) => describe(it.rel, it.content, "minimal")).join("\n\n")
    try {
      const { inputTokens } = await withRetry(() => classify(blocks, Math.min(8192, bin.length * 64 + 256)))
      if (inputTokens > 0) samples.push({ chars: blocks.length, tokens: inputTokens })
    } catch (e) {
      console.error(`  calibration call failed (${bin.length} files): ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (samples.length < 2) return `calibration: too few samples (${samples.length}); need >=2 batches`

  const n = samples.length
  const sx = samples.reduce((s, p) => s + p.chars, 0)
  const sy = samples.reduce((s, p) => s + p.tokens, 0)
  const sxx = samples.reduce((s, p) => s + p.chars * p.chars, 0)
  const sxy = samples.reduce((s, p) => s + p.chars * p.tokens, 0)
  const b = (n * sxy - sx * sy) / (n * sxx - sx * sx)
  const a = (sy - b * sx) / n
  const k = 1 / b
  const ratios = samples.map((p) => p.chars / p.tokens)
  const meanRatio = ratios.reduce((s, r) => s + r, 0) / n

  return [
    `calibration (${n} batches, minimal mode):`,
    `  fit            : input_tokens ≈ ${a.toFixed(0)} + ${b.toFixed(4)}·chars`,
    `  K (slope)      : ${k.toFixed(2)} chars/token  → set TOKENS_PER_CHAR = 1 / ${k.toFixed(2)}`,
    `  K (mean ratio) : ${meanRatio.toFixed(2)} chars/token  (block-chars ÷ input_tokens, incl. overhead)`,
    `  per-call overhead a : ~${a.toFixed(0)} tokens (SYSTEM + tool schema + wrapper)`,
    `  current TOKENS_PER_CHAR = 1 / ${(1 / TOKENS_PER_CHAR).toFixed(2)}`,
  ].join("\n")
}

// --- stress test ------------------------------------------------------------

// Build exactly n distinct items from the pool. Once the pool is exhausted we keep
// the real (varied) content but give each repeat a unique path via a `dupK/` prefix
// — so the model still sees n distinct paths to echo, letting N exceed the slice
// size. The prefix is added ahead of the path so the file extension (hence import
// parsing) is preserved.
function makeStressItems(pool: Item[], n: number): Item[] {
  const out: Item[] = []
  for (let i = 0; i < n; i++) {
    const base = pool[i % pool.length]!
    const k = Math.floor(i / pool.length)
    out.push({ rel: k === 0 ? base.rel : `dup${k}/${base.rel}`, content: base.content })
  }
  return out
}

// Stress the per-call file fan-out: for each N, send one bin of N distinct files
// and count how many the model echoes back. The ceiling is the largest N with
// missing == 0. minimal context (smallest blocks, so input is never the limit —
// the binding constraints are the model's instruction-following and the output cap).
async function runStress(pool: Item[]): Promise<string> {
  if (pool.length === 0) return "stress: empty file pool"
  const fmt = (c: Array<string | number>) =>
    String(c[0]).padStart(5) +
    "  " +
    String(c[1]).padStart(8) +
    "  " +
    String(c[2]).padStart(7) +
    "  " +
    String(c[3]).padStart(7) +
    "  " +
    String(c[4]).padStart(7) +
    "  " +
    String(c[5]).padStart(6) +
    "  " +
    String(c[6]).padStart(6) +
    "  " +
    String(c[7])
  const rows: string[] = [fmt(["N", "returned", "missing", "in_tok", "out_tok", "cap", "ms", "note"])]
  for (const n of stressSizes) {
    for (let r = 1; r <= repeat; r++) {
      const stItems = makeStressItems(pool, n)
      const blocks = stItems.map((it) => describe(it.rel, it.content, "minimal")).join("\n\n")
      const cap = Math.min(STRESS_MAX_OUTPUT, n * 64 + 256)
      const wanted = new Set(stItems.map((it) => it.rel))
      const t0 = performance.now()
      let returned = 0
      let inTok = 0
      let outTok = 0
      let errMsg = ""
      try {
        const res = await withRetry(() => classify(blocks, cap))
        const got = new Set<string>()
        for (const f of res.files) if (wanted.has(f.path)) got.add(f.path)
        returned = got.size
        inTok = res.inputTokens
        outTok = res.outputTokens
      } catch (e) {
        errMsg = e instanceof Error ? e.message : String(e)
      }
      const ms = Math.round(performance.now() - t0)
      const missing = n - returned
      const note = errMsg
        ? `ERROR ${errMsg.slice(0, 48)}`
        : missing > 0
          ? outTok >= cap
            ? "omission (output-cap-bound)"
            : "omission (model)"
          : "ok"
      rows.push(fmt([n, returned, missing, inTok, outTok, cap, ms, note]))
    }
  }
  return [
    "stress — one model call per row; each row is N distinct files in a single bin.",
    `pool = ${pool.length} real files; once exhausted, extra files reuse content under`,
    "unique dupK/ paths. Goal: the largest N still echoed back in full (missing == 0).",
    "'output-cap-bound' = output hit max_tokens (raise STRESS_MAX_OUTPUT or the model's",
    "own limit), i.e. a harness ceiling, not the model giving up.",
    "",
    ...rows,
  ].join("\n")
}

// --- report -----------------------------------------------------------------

function fmtModeReport(label: string, mode: Mode, acc: Acc, readable: number, bins: Item[][]): string {
  const perFile = readable ? (acc.totalTokens / readable).toFixed(1) : "0"
  const binCount = bins.length
  const binSizes = bins.map((b) => b.length)
  const binTokens = bins.map((b) => estimateBinTokens(b, mode))
  const avgFiles = binCount ? (binSizes.reduce((s, v) => s + v, 0) / binCount).toFixed(1) : "0"
  const maxBinFiles = binCount ? Math.max(...binSizes) : 0
  const estErr =
    acc.inputTokens > 0 ? `${(((acc.estInputTokens - acc.inputTokens) / acc.inputTokens) * 100).toFixed(0)}%` : "n/a"
  const avgCallMs = acc.calls ? (acc.wallclockMs / acc.calls).toFixed(0) : "0"
  const lines = [
    `[${label}]`,
    `  files scanned     : ${readable}`,
    `  files classified  : ${acc.classified}${acc.classified === readable ? " (ok)" : " (MISMATCH — sanity check)"}`,
    `  bins              : ${binCount} (avg ${avgFiles} files/bin, max ${maxBinFiles})`,
    `  model calls       : ${acc.calls}${acc.bisects ? ` (+${acc.bisects} bisects)` : ""}`,
    `  est input tokens  : ${acc.estInputTokens} (block-only; vs actual ${estErr})`,
    `  input tokens      : ${acc.inputTokens}`,
    `  output tokens     : ${acc.outputTokens}`,
    `  total tokens      : ${acc.totalTokens}  (${perFile}/file)`,
    `  est tokens/bin    : avg ${binCount ? Math.round(binTokens.reduce((s, v) => s + v, 0) / binCount) : 0}, max ${binCount ? Math.max(...binTokens) : 0} (budget ${budget})`,
    `  wallclock         : ${(acc.wallclockMs / 1000).toFixed(1)}s  (concurrency ${concurrency}${concurrency === 1 ? `, avg ${avgCallMs}ms/call` : ""})`,
    `  throttle          : ${acc.retries} retries, ${acc.backoffMs}ms cumulative backoff`,
  ]
  if (acc.failures.length) {
    lines.push(`  hard failures     : ${acc.failures.length}`)
    for (const f of acc.failures) lines.push(`    - ${f}`)
  }
  return lines.join("\n")
}

// --dry-run preview: the bins a strategy produces, with estimated fill, so you can
// judge call count and packing before spending any tokens. Flags bins that exceed
// the budget/file cap (a singleton oversize file, or — for `dir` — a fat directory
// that would be bisected at runtime).
function fmtBinPlan(mode: Mode, strategy: Strategy, bins: Item[][]): string {
  const sizes = bins.map((b) => b.length)
  const toks = bins.map((b) => estimateBinTokens(b, mode))
  const total = sizes.reduce((s, v) => s + v, 0)
  const over = bins.filter((b, i) => b.length > maxFiles || toks[i]! > budget).length
  const lines = [
    `[${mode}/${strategy}]`,
    `  files     : ${total}`,
    `  bins      : ${bins.length}`,
    `  files/bin : avg ${bins.length ? (total / bins.length).toFixed(1) : "0"}, max ${bins.length ? Math.max(...sizes) : 0}`,
    `  est tok/bin: avg ${bins.length ? Math.round(toks.reduce((s, v) => s + v, 0) / bins.length) : 0}, max ${bins.length ? Math.max(...toks) : 0} (budget ${budget})`,
    `  over budget/cap : ${over}${over ? " (bisected at runtime)" : ""}`,
  ]
  return lines.join("\n")
}

type Variant = { label: string; mode: Mode; acc: Acc }

// Per-file layer assignments side by side across the variants that ran (rows =
// files, columns = variants — each a mode/strategy or a repeat run). A trailing
// "≠" flags rows where the variants disagree; "—" marks a file a variant never
// returned (e.g. a hard-failed batch). Log-only — too wide for the console.
function fmtTagTable(results: Variant[], files: string[]): string {
  const pad = (s: string, w: number) => s.padEnd(w)
  const showDiff = results.length >= 2
  const cell = (i: number, rel: string) => results[i]!.acc.tags.get(rel) ?? "—"
  const pathW = Math.max("File".length, ...files.map((f) => f.length))
  const colW = results.map((r, i) => Math.max(r.label.length, ...files.map((f) => cell(i, f).length)))

  const headerRow =
    pad("File", pathW) + "  " + results.map((r, i) => pad(r.label, colW[i]!)).join("  ") + (showDiff ? "  diff" : "")
  const rows = files.map((f) => {
    const vals = results.map((_, i) => cell(i, f))
    const diff = showDiff && new Set(vals).size > 1 ? "≠" : ""
    return pad(f, pathW) + "  " + vals.map((v, i) => pad(v, colW[i]!)).join("  ") + (showDiff ? "  " + diff : "")
  })
  return ["Per-file tags (rows = files, columns = variants):", "", headerRow, "-".repeat(headerRow.length), ...rows].join(
    "\n",
  )
}

// Per-method repeatability verdict: within each mode/strategy, how many files got
// an identical tag across its N repeat runs (and which drifted). Grouped by method
// so an intended cross-method difference isn't miscounted as flakiness — this is
// the direct "as repeatable as the current method?" answer, one line per method.
function fmtStability(results: Variant[], files: string[]): string {
  const groups = new Map<string, Variant[]>()
  for (const r of results) {
    const key = r.label.replace(/#\d+$/, "")
    const arr = groups.get(key)
    if (arr) arr.push(r)
    else groups.set(key, [r])
  }
  const lines: string[] = []
  for (const [key, vs] of groups) {
    if (vs.length < 2) continue
    const varied: string[] = []
    for (const f of files) {
      const tags = new Set(vs.map((r) => r.acc.tags.get(f) ?? "—"))
      if (tags.size > 1) varied.push(f)
    }
    const stable = files.length - varied.length
    lines.push(
      `stability [${key}]: ${stable}/${files.length} identical across ${vs.length} runs` +
        (varied.length ? `\n  varied: ${varied.join(", ")}` : ""),
    )
  }
  return lines.join("\n")
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

  const items: Item[] = [...contents].map(([rel, content]) => ({ rel, content }))

  if (calibrateOnly) {
    console.log(`\nCalibrating K over ${items.length} files …`)
    const summary = await calibrate(items)
    console.log("\n" + summary)
    return
  }

  if (dryRun) {
    console.log(`\nDry run — ${strategies.join(", ")} batching, ${items.length} files (no API calls):\n`)
    for (const mode of modes)
      for (const strat of strategies) console.log(fmtBinPlan(mode, strat, buildBins(items, mode, strat)) + "\n")
    return
  }

  if (stress) {
    console.log(`\nStress test — sizes ${stressSizes.join(", ")}, ${repeat} run(s) each, pool ${items.length} files …\n`)
    const report = await runStress(items)
    console.log(report)
    const stamp = started.toISOString().replace(/[:.]/g, "-")
    const logDir = path.join(import.meta.dir, "logs")
    await mkdir(logDir, { recursive: true })
    const logPath = path.join(logDir, `tagger-stress-${stamp}.log`)
    await writeFile(logPath, report + "\n")
    console.log(`\nWrote ${logPath}`)
    return
  }

  const header = [
    `tagger context eval — ${started.toISOString()}`,
    `target      : ${root}`,
    `model       : ${MODEL_ID}`,
    `modes       : ${modes.join(", ")}`,
    `batch       : ${strategies.join(", ")}`,
    `params      : budget ${budget} tok, max ${maxFiles} files (ffd/bfd/locality); ${fixedSize} files/chunk (fixed)`,
    `concurrency : ${concurrency}${strategies.includes("balanced") ? ` (balanced → ${partitionCount} partitions)` : ""}`,
    `repeat      : ${repeat}`,
    `files       : ${enumerated.length} enumerated, ${contents.size} readable${
      limit !== undefined ? ` (limited to ${limit})` : ""
    }`,
    "",
  ].join("\n")
  console.log("\n" + header)

  const reports: string[] = []
  const results: Variant[] = []
  for (const mode of modes) {
    for (const strat of strategies) {
      const bins = buildBins(items, mode, strat)
      for (let run = 1; run <= repeat; run++) {
        const label = `${mode}/${strat}${repeat > 1 ? `#${run}` : ""}`
        console.log(`Running ${label} …`)
        const acc = await runBins(bins, mode)
        const report = fmtModeReport(label, mode, acc, contents.size, bins)
        reports.push(report)
        console.log(report + "\n")
        results.push({ label, mode, acc })
      }
    }
  }

  // The per-file tag table is log-only (wide and long); stdout keeps the summaries.
  const files = [...contents.keys()].toSorted()
  const table = fmtTagTable(results, files)
  const stability = fmtStability(results, files)
  if (stability) console.log(stability + "\n")

  const stamp = started.toISOString().replace(/[:.]/g, "-")
  const logDir = path.join(import.meta.dir, "logs")
  await mkdir(logDir, { recursive: true })
  const logPath = path.join(logDir, `tagger-eval-${stamp}.log`)
  const body = [header, reports.join("\n\n"), stability, table].filter(Boolean).join("\n\n")
  await writeFile(logPath, body + "\n")
  console.log(`Wrote ${logPath}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
