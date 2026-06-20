import { Effect, Schedule, Schema } from "effect"
import path from "path"
import { createHash } from "crypto"
import { appendFile, mkdir, writeFile } from "fs/promises"
import { generateObject } from "ai"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as Log from "@opencode-ai/core/util/log"
import type { EventV2 } from "@opencode-ai/core/event"
import type { Storage } from "@/storage/storage"
import type { Provider } from "@/provider/provider"
import type { Config } from "@/config/config"
import { CodeGraphSemanticStore } from "./semantic-store"
import { CodeGraphEvent } from "./event"
import { type TagCollection, isAssignableTag, tagEnumIds, buildSystemPrompt } from "./collections"
import { CodeGraphExtract } from "./extract"

// Semantic tagger (PLAN.md step 4). Given the file nodes of a viewed scope, it
// infers one architectural layer per file with a small/fast model and writes the
// result to the per-project semantic store. It is the *only* place tokens are
// spent in the code-graph feature.
//
// Frugality is the whole point and comes from two rules:
//   1. Stale-only — a file is (re)tagged only when it has no stored entry or its
//      content hash changed. Re-displaying unchanged files spends nothing.
//   2. Minimal context — by default the model sees only the path, parsed import
//      specifiers, and the leading comment; agent-authored code is rarely named
//      pathologically, so that's usually enough to place a file. The `medium`
//      flag (config) adds exported names + the file head when tuning.
//
// Failure is soft: any read/model/parse error leaves existing semantics intact
// and publishes nothing, so the structure bar always keeps working.

const log = Log.create({ service: "codegraph.tagger" })

// Caps so a large window can never blow up a prompt or a single request: read at
// most this many stale files per pass, binned into dir-coherent groups of at most
// TAG_BATCH files and classified with up to TAG_FANOUT model calls in flight.
const MAX_PER_PASS = 960
// Max files per directory bin: a directory with more is split into same-dir chunks
// of this size (see splitDirs). Each chunk is one model call.
const TAG_BATCH = 30
// Default number of dir-bins classified concurrently within a single pass. The perf
// sweep (perf/tagger-eval.ts) proved dirsplit fastest with no throttling, and on a
// ~2400-file repo at minimal context a sweep uses only ~26% req / ~20% output-token
// rate limit at peak — total work is fixed and fits in one 60s window, so that peak
// doesn't rise with worker count. 64 is the knee: it saturates small/foreground passes
// (bottlenecked by bin count + the per-call latency floor, not workers) and nearly
// matches wider settings on the big sweep without the burst-529 tail that can make
// e.g. 96-wide occasionally *slower*. Overridable per-tier via config
// (codegraph.tagger.concurrency, clamped 1-128 to leave headroom for experimentation).
const TAG_FANOUT = 64
// Rate-limit (429/overloaded) retries before a batch soft-fails to "tag nothing".
// Spacing the background sweep avoids most bounceback; this catches the rest.
const BG_MAX_RETRIES = 4
const READ_CONCURRENCY = 24
const MAX_FILE_BYTES = 512 * 1024
const HEAD_LINES = 30
const MAX_COMMENT_CHARS = 240

export interface FileNode {
  readonly id: string
  readonly path: string
}

export interface Deps {
  readonly storage: Storage.Interface
  readonly events: EventV2.Interface
  readonly provider: Provider.Interface
  readonly config: Config.Interface
}

// Built per-pass from the active collection's tag ids: the model must echo one of
// the collection's tags for each file. `Schema.Literals` over the collection ids
// constrains the structured output to valid tags.
function buildTagSchema(collection: TagCollection) {
  // Includes the NONE_TAG escape so the model can opt a file out of every tag.
  return Schema.Struct({
    files: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        tag: Schema.Literals(tagEnumIds(collection)),
      }),
    ),
  })
}

// Which tagger drove a pass — recorded in the perf log so foreground (current view)
// and background (whole-repo sweep) requests can be told apart after the fact.
export type Origin = "fg" | "bg"

// Tag any stale file node in `fileNodes` and persist the result. Requires only
// FSUtil from context (provided at the fork site); all other services are passed
// in so callers keep a clean `R = never` return type.
export const tagStale = Effect.fn("CodeGraph.tagStale")(function* (
  deps: Deps,
  directory: string,
  projectID: string,
  scope: string,
  fileNodes: ReadonlyArray<FileNode>,
  origin: Origin,
  collection: TagCollection,
) {
  if (fileNodes.length === 0) return

  const store = yield* CodeGraphSemanticStore.read(deps.storage, projectID, collection.id)

  // Read + hash each candidate, keeping only those whose content changed (or were
  // never tagged). Files we can't read are simply skipped.
  const fs = yield* FSUtil.Service
  const read = yield* Effect.forEach(
    fileNodes,
    (node) =>
      fs
        .readFileStringSafe(path.join(directory, node.path))
        .pipe(
          Effect.map((content) => ({ node, content }) as { node: FileNode; content: string | undefined }),
          Effect.orElseSucceed(() => ({ node, content: undefined as string | undefined })),
        ),
    { concurrency: READ_CONCURRENCY },
  )

  const stale = read
    .filter((r): r is { node: FileNode; content: string } => typeof r.content === "string")
    .map((r) => ({ ...r, hash: hashContent(r.content) }))
    .filter((r) => store[r.node.id]?.hash !== r.hash)
    .slice(0, MAX_PER_PASS)

  if (stale.length === 0) {
    yield* appendPerfEvent(directory, origin, "skip", { reason: "no-stale", candidates: fileNodes.length })
    return
  }

  const context = yield* contextMode(deps.config)
  const language = yield* resolveLanguage(deps.provider)
  if (!language) {
    log.info("no small model available; skipping tag pass", { projectID, scope })
    yield* appendPerfEvent(directory, origin, "skip", { reason: "no-language", stale: stale.length })
    return
  }

  const tagSchema = buildTagSchema(collection)
  const system = buildSystemPrompt(collection)

  // Path → its hash so we can record freshness on whatever the model returns.
  const hashByPath = new Map(stale.map((r) => [r.node.path, r.hash]))
  const idByPath = new Map(stale.map((r) => [r.node.path, r.node.id]))

  // Dir-coherent binning (perf/tagger-eval.ts "dirsplit"): one bin per directory,
  // big dirs split into same-dir chunks of TAG_BATCH — maximally coherent prompts.
  // Bins are classified up to `fanout`-wide; a single failed bin soft-fails to "tag
  // nothing" (catch inside the worker) without interrupting its siblings.
  const bins = splitDirs(stale, TAG_BATCH)
  const fanout = yield* taggerConcurrency(deps.config)
  const classifyBin = (bin: typeof stale) =>
    Effect.gen(function* () {
      const blocks = bin.map((r) => describe(r.node.path, r.content, context)).join("\n\n")
      const assignments = yield* classifyWithRetry(language, blocks, tagSchema, system, collection).pipe(
        Effect.catchCause((cause) => {
          log.error("classify failed", { projectID, scope, cause })
          return Effect.succeed<ReadonlyArray<{ path: string; tag: string }>>([])
        }),
      )
      return { blocks, assignments }
    })
  const results = yield* Effect.forEach(bins, classifyBin, { concurrency: fanout })

  // Sequential post-pass: the perf log's byte counter (writePerfLine) and the tagged
  // store are written here, not inside the concurrent workers, so the 16-wide fan-out
  // never races the counter or interleaves appends.
  const tagged: CodeGraphSemanticStore.Store = {}
  for (const { blocks, assignments } of results) {
    yield* appendPerfLog(directory, origin, collection.id, blocks, assignments)
    for (const a of assignments) {
      const id = idByPath.get(a.path)
      const hash = hashByPath.get(a.path)
      if (!id || !hash) continue
      tagged[id] = { tag: a.tag, hash }
    }
  }

  const count = Object.keys(tagged).length
  if (count === 0) return

  yield* CodeGraphSemanticStore.upsert(deps.storage, projectID, collection.id, tagged)
  log.info("tagged", { projectID, scope, collection: collection.id, count })

  // Only now that something actually changed do we nudge the live view to refetch
  // and re-merge — the guard that keeps a tag→refetch→tag cycle from forming
  // (the next pass finds matching hashes and publishes nothing).
  yield* deps.events.publish(CodeGraphEvent.Event.Invalidated, { scope }).pipe(Effect.ignore)
}, Effect.provide(FSUtil.defaultLayer))

// --- perf log --------------------------------------------------------------

// Deterministic, code-written (never agent-written) trace of every model request:
// one JSON line per batch with the tagger identity (fg/bg), a timestamp, the exact
// prompt input, and the structured output. Written under <repo>/perf so the two
// taggers' API traffic can be inspected after the fact. Fresh per run and capped in
// size (see writePerfLine), so it can't grow without bound. Written from the
// sequential post-pass in tagStale (not the concurrent classify fan-out), so appends
// never interleave and the byte counter never races. Failure is swallowed — logging
// must never break or slow tagging.
function appendPerfLog(
  directory: string,
  origin: Origin,
  collection: string,
  input: string,
  output: ReadonlyArray<{ path: string; tag: string }>,
) {
  return writePerfLine(directory, { tagger: origin, collection, timestamp: new Date().toISOString(), input, output })
}

// Diagnostic counterpart to appendPerfLog: records lifecycle/skip events (pass
// start, empty enumeration, no stale files, no small model) so a tagger that
// produces no request lines can still be traced. Same file, distinguished by the
// `event` field.
export function appendPerfEvent(directory: string, origin: Origin, event: string, detail?: Record<string, unknown>) {
  return writePerfLine(directory, { tagger: origin, timestamp: new Date().toISOString(), event, ...detail })
}

// Hard cap so the trace can never grow without bound. When a write would exceed it
// the file is reset (a `log-reset` marker line precedes the new content). Old lines
// are dropped rather than rotated — this is a debug trace, not durable history.
const PERF_LOG_MAX_BYTES = 1024 * 1024
// Per-file byte tally (process-local). An unset entry means we haven't written this
// run yet, so the first write *truncates* — each run starts from a clean log.
const perfLogBytes = new Map<string, number>()

function writePerfLine(directory: string, record: Record<string, unknown>) {
  return Effect.tryPromise(async () => {
    const dir = path.join(directory, "perf")
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, "tagger.log")
    const line = JSON.stringify(record) + "\n"
    const size = Buffer.byteLength(line)
    const prior = perfLogBytes.get(file)
    if (prior === undefined) {
      // First write this run: start fresh (truncate any log left by a prior run).
      await writeFile(file, line)
      perfLogBytes.set(file, size)
    } else if (prior + size > PERF_LOG_MAX_BYTES) {
      // Cap reached: reset, dropping older lines so the file stays bounded.
      const marker = JSON.stringify({ event: "log-reset", timestamp: new Date().toISOString() }) + "\n"
      await writeFile(file, marker + line)
      perfLogBytes.set(file, Buffer.byteLength(marker) + size)
    } else {
      await appendFile(file, line)
      perfLogBytes.set(file, prior + size)
    }
  }).pipe(Effect.ignore)
}

// --- model -----------------------------------------------------------------

// Resolve the small/fast model (Haiku-class by default, honors `small_model`).
function resolveLanguage(provider: Provider.Interface) {
  return Effect.gen(function* () {
    const def = yield* provider.defaultModel()
    const small = yield* provider.getSmallModel(def.providerID)
    if (!small) return undefined
    return yield* provider.getLanguage(small)
  }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
}

type TagSchema = ReturnType<typeof buildTagSchema>

const classify = (
  language: Parameters<typeof generateObject>[0]["model"],
  blocks: string,
  tagSchema: TagSchema,
  system: string,
  collection: TagCollection,
) =>
  Effect.tryPromise(() =>
    generateObject({
      model: language,
      temperature: 0,
      schema: Object.assign(Schema.toStandardSchemaV1(tagSchema), Schema.toStandardJSONSchemaV1(tagSchema)),
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Classify these files:\n\n${blocks}` },
      ],
    }).then((r) => {
      const result = r.object as typeof tagSchema.Type
      return result.files.filter((f): f is { path: string; tag: string } => isAssignableTag(collection, f.tag))
    }),
  )

// Retry a classify call on rate-limit / overload errors with exponential backoff +
// jitter, capped at BG_MAX_RETRIES. Only retries bounceback (429/5xx/overloaded);
// parse and other errors fall straight through to the soft-fail handler so a
// genuinely bad batch never wedges the loop. Effect.tryPromise wraps the thrown SDK
// error in an UnknownException whose `.error` holds the original.
const classifyWithRetry = (
  language: Parameters<typeof generateObject>[0]["model"],
  blocks: string,
  tagSchema: TagSchema,
  system: string,
  collection: TagCollection,
) =>
  classify(language, blocks, tagSchema, system, collection).pipe(
    Effect.retry({
      schedule: Schedule.exponential("500 millis").pipe(Schedule.jittered),
      times: BG_MAX_RETRIES,
      while: isRateLimitError,
    }),
  )

function isRateLimitError(error: unknown): boolean {
  const raw = (error as { error?: unknown })?.error ?? error
  const status = (raw as { statusCode?: unknown; status?: unknown })?.statusCode ?? (raw as { status?: unknown })?.status
  if (status === 429 || status === 503 || status === 529) return true
  const message = (raw as { message?: unknown })?.message
  if (typeof message !== "string") return false
  const lower = message.toLowerCase()
  return (
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("overloaded") ||
    lower.includes("rate increased too quickly")
  )
}

// --- per-file context ------------------------------------------------------

function contextMode(config: Config.Interface) {
  return config.get().pipe(
    Effect.map((cfg) => (cfg.codegraph?.tagger?.context === "medium" ? "medium" : "minimal") as "minimal" | "medium"),
    Effect.catchCause(() => Effect.succeed("minimal" as const)),
  )
}

// How many dir-bins to classify concurrently within a pass. Honors the config
// override (clamped to a sane range) and falls back to TAG_FANOUT on read failure.
function taggerConcurrency(config: Config.Interface) {
  return config.get().pipe(
    Effect.map((cfg) => clamp(cfg.codegraph?.tagger?.concurrency ?? TAG_FANOUT, 1, 128)),
    Effect.catchCause(() => Effect.succeed(TAG_FANOUT)),
  )
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.trunc(n)))
}

// Compact textual context for one file. `minimal` = path + imports + leading
// comment; `medium` additionally includes exported names and the file head.
function describe(rel: string, content: string, mode: "minimal" | "medium"): string {
  const capped = content.length > MAX_FILE_BYTES ? content.slice(0, MAX_FILE_BYTES) : content
  const imports = CodeGraphExtract.parseImports(rel, capped)
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

// First contiguous run of leading comments (// or /* */ or #), flattened.
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
    for (const part of m[1]!.split(","))
      names.add(
        part
          .trim()
          .replace(/\s+as\s+.*/, "")
          .trim(),
      )
  }
  names.delete("")
  return [...names]
}

// --- helpers ---------------------------------------------------------------

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16)
}

// Immediate parent directory of a repo-relative POSIX path; "" for a root-level file.
function posixDir(p: string): string {
  const i = p.lastIndexOf("/")
  return i === -1 ? "" : p.slice(0, i)
}

// "dirsplit" binning (perf/tagger-eval.ts winner): one bin per immediate directory,
// never merging across directories; a directory with more than `maxFiles` files is
// split into ceil(n/maxFiles) same-directory chunks. Every bin is thus files from a
// single directory — coherent prompts — and the union of bins is exactly the input.
export function splitDirs<T extends { readonly node: FileNode }>(records: ReadonlyArray<T>, maxFiles: number): T[][] {
  const byDir = new Map<string, T[]>()
  for (const r of records) {
    const d = posixDir(r.node.path)
    const bucket = byDir.get(d) ?? []
    bucket.push(r)
    byDir.set(d, bucket)
  }
  const bins: T[][] = []
  for (const dirFiles of byDir.values()) {
    const sorted = [...dirFiles].sort((a, b) =>
      a.node.path < b.node.path ? -1 : a.node.path > b.node.path ? 1 : 0,
    )
    for (let i = 0; i < sorted.length; i += maxFiles) bins.push(sorted.slice(i, i + maxFiles))
  }
  return bins
}

export * as CodeGraphTagger from "./tagger"
