import { Effect, Schedule, Schema } from "effect"
import path from "path"
import { createHash } from "crypto"
import { appendFile, mkdir, writeFile } from "fs/promises"
import { generateObject } from "ai"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AbsolutePath } from "@opencode-ai/core/schema"
import * as Log from "@opencode-ai/core/util/log"
import type { EventV2 } from "@opencode-ai/core/event"
import * as StudyLog from "./study-log"
import type { Storage } from "@/storage/storage"
import type { Provider } from "@/provider/provider"
import type { Config } from "@/config/config"
import { ApertureSemanticStore } from "./semantic-store"
import { ApertureSubfacetStore } from "./subfacet-store"
import { ApertureEvent } from "./event"
import { type Lens, isAssignableFacet, facetEnumIds, buildSystemPrompt, NONE_FACET } from "./lenses"
import { ApertureExtract } from "./extract"
import { ApertureExtents } from "./extents"

// Semantic painter (PLAN.md step 4). Given the file nodes of a viewed scope, it
// infers one facet per file with a small/fast model and writes the
// result to the per-project semantic store. It is the *only* place tokens are
// spent in the Aperture feature.
//
// Frugality is the whole point and comes from two rules:
//   1. Stale-only — a file is (re)painted only when it has no stored entry or its
//      content hash changed. Re-displaying unchanged files spends nothing.
//   2. Minimal context — by default the model sees only the path, parsed import
//      specifiers, and the leading comment; agent-authored code is rarely named
//      pathologically, so that's usually enough to place a file. A Lens whose facets
//      need the code's *shape* (e.g. "code smells", "god files") opts into `medium`,
//      which adds a cheap structural skeleton — exported names, the file's line count,
//      and each top-level declaration's signature + length — never a function body, so
//      cost scales with declaration count, not file size. The mode is per-Lens
//      (Lens.context); a global config override (aperture.painter.context) can force one
//      mode across all Lenses for experimentation.
//
// Failure is soft: any read/model/parse error leaves existing semantics intact
// and publishes nothing, so the structure bar always keeps working.

const log = Log.create({ service: "aperture.painter" })

// Caps so a large window can never blow up a prompt or a single request: read at
// most this many stale files per pass, binned into dir-coherent groups of at most
// FACET_BATCH files and classified with up to FACET_FANOUT model calls in flight.
const MAX_PER_PASS = 960
// Max files per directory bin: a directory with more is split into same-dir chunks
// of this size (see splitDirs). Each chunk is one model call.
const FACET_BATCH = 30
// Default number of dir-bins classified concurrently within a single pass. The perf
// sweep (the dirsplit eval harness under perf/) proved dirsplit fastest with no
// throttling, and on a ~2400-file repo at minimal context a sweep uses only ~26% req /
// ~20% output-token rate limit at peak — total work is fixed and fits in one 60s window,
// so that peak doesn't rise with worker count. 64 is the knee: it saturates
// small/foreground passes (bottlenecked by bin count + the per-call latency floor, not
// workers) and nearly matches wider settings on the big sweep without the burst-529 tail
// that can make e.g. 96-wide occasionally *slower*. Overridable per-tier via config
// (aperture.painter.concurrency, clamped 1-128 to leave headroom for experimentation).
const FACET_FANOUT = 64
// Rate-limit (429/overloaded) retries before a batch soft-fails to "paint nothing".
// Spacing the background sweep avoids most bounceback; this catches the rest.
const BG_MAX_RETRIES = 4
const READ_CONCURRENCY = 24
const MAX_FILE_BYTES = 512 * 1024
const MAX_COMMENT_CHARS = 240
// `medium` skeleton caps: at most this many top-level declarations are listed (the rest
// collapse to a "+N more" line so a huge file can't blow up a prompt), each signature
// trimmed to this many chars. Bounds the extra input tokens medium spends per file.
const MAX_SKELETON_DECLS = 40
const SKELETON_SIG_CHARS = 120

export interface FileNode {
  readonly id: string
  readonly path: string
}

// The resolved domain of a *drill-down* Lens, handed to the painter by the caller (the
// service owns resolution — it needs git and the whole-repo subtree, which the painter's
// Deps deliberately lack). This is what makes a drill-down trustworthy: the model is only
// ever shown in-domain files, so it cannot pull a file that wasn't in the drilled facet
// into one of the child's facets. Everything else is bucketed out *deterministically*.
export interface Domain {
  // The parent Lens, for the system prompt's domain note.
  readonly parent: Lens
  // nodeID → the parent facet the file carries (its "witness"). A node ABSENT from this map
  // has not been placed by the parent yet — it is neither in nor out of the domain, and the
  // painter must leave it entirely alone (see the fail-closed note in paintStale).
  readonly witness: ReadonlyMap<string, string>
  // The nodeIDs whose witness falls in the drill-down's scoped subset.
  readonly allowed: ReadonlySet<string>
}

// Whether a node needs (re)deciding: never painted, its content changed, or — for a
// drill-down — the parent moved it to a different facet. That last case is invisible to a
// content hash (the file didn't change, its *domain* did), which is why entries carry `via`.
export function isStale(
  entry: ApertureSemanticStore.Entry | undefined,
  hash: string,
  witness: string | undefined,
): boolean {
  if (!entry) return true
  if (entry.hash !== hash) return true
  return witness !== undefined && entry.via !== witness
}

export interface Partition<T> {
  // In-domain: the only files the model ever sees.
  readonly classify: T[]
  // Out-of-domain: bucketed into NONE_FACET with no model call.
  readonly bucket: T[]
  // Unwitnessed — the parent hasn't placed them even after the fill. Left completely
  // untouched and retried next sweep; bucketing them would be permanent (see paintStale).
  readonly skip: T[]
}

// Split stale files three ways by domain membership. Pure and exported so the guarantee the
// whole feature rests on — an out-of-domain file is NEVER handed to the model — is directly
// testable, rather than only reachable through a live painter.
export function partitionByDomain<T extends { readonly node: FileNode }>(
  stale: ReadonlyArray<T>,
  domain: Domain | undefined,
): Partition<T> {
  if (!domain) return { classify: [...stale], bucket: [], skip: [] }
  const classify: T[] = []
  const bucket: T[] = []
  const skip: T[] = []
  for (const r of stale) {
    if (domain.witness.get(r.node.id) === undefined) skip.push(r)
    else if (domain.allowed.has(r.node.id)) classify.push(r)
    else bucket.push(r)
  }
  return { classify, bucket, skip }
}

export interface PaintOptions {
  // Set when `lens` is a drill-down; absent for a root Lens (paint the whole repo).
  readonly domain?: Domain
  // Whether to publish an invalidation when something was painted. False for a nested
  // parent-fill: the store it writes isn't the one being viewed, and the child's own pass
  // publishes a moment later anyway — so publishing here only buys a wasted refetch.
  readonly publish?: boolean
  // The Lens whose sweep *caused* this pass, when that isn't `lens` itself (i.e. a parent
  // fill forced by a drill-down). Study logging attributes the spend to both, so a
  // drill-down's true cost — its own paint plus the ancestor fills it forced — is visible.
  readonly trigger?: string
}

export interface Deps {
  readonly storage: Storage.Interface
  readonly events: EventV2.Interface
  readonly provider: Provider.Interface
  readonly config: Config.Interface
}

// Built per-pass from the active Lens's facet ids: the model must echo one of
// the Lens's facets for each file. `Schema.Literals` over the Lens ids
// constrains the structured output to valid facets.
function buildFacetSchema(lens: Lens) {
  // Includes the NONE_FACET escape so the model can opt a file out of every facet.
  return Schema.Struct({
    files: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        facet: Schema.Literals(facetEnumIds(lens)),
      }),
    ),
  })
}

// Which painter drove a pass — recorded in the perf log so foreground (current view)
// and background (whole-repo sweep) requests can be told apart after the fact.
export type Origin = "fg" | "bg"

// Paint any stale file node in `fileNodes` and persist the result. Requires only
// FSUtil from context (provided at the fork site); all other services are passed
// in so callers keep a clean `R = never` return type.
export const paintStale = Effect.fn("Aperture.paintStale")(function* (
  deps: Deps,
  directory: string,
  projectID: string,
  scope: string,
  fileNodes: ReadonlyArray<FileNode>,
  origin: Origin,
  lens: Lens,
  options: PaintOptions = {},
) {
  if (fileNodes.length === 0) return
  const { domain, publish = true, trigger } = options

  const store = yield* ApertureSemanticStore.read(deps.storage, projectID, lens.id)

  // Read + hash each candidate, keeping only those whose content changed (or were
  // never painted). Files we can't read are simply skipped.
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
    // Keyed on the witness as well as the content hash: when a parent re-paints a file into
    // a different facet the file's *content* is unchanged, so a hash-only check would freeze
    // it at a facet its domain no longer supports.
    .filter((r) => isStale(store[r.node.id], r.hash, domain?.witness.get(r.node.id)))
    .slice(0, MAX_PER_PASS)

  if (stale.length === 0) {
    yield* appendPerfEvent(directory, origin, "skip", { reason: "no-stale", candidates: fileNodes.length })
    return
  }

  // Domain gate. Every stale file lands in exactly one of three buckets:
  //
  //   in-domain     — its witness is one of the scoped parent facets. Classified below.
  //   out-of-domain — witnessed, but by a facet outside the scope. Bucketed straight into
  //                   NONE_FACET here, with NO model call. This is the guarantee the whole
  //                   feature rests on: the stochastic painter never even sees these files,
  //                   so it can't pull one into a drill-down facet.
  //   unwitnessed   — the parent hasn't placed it yet, *even after* the caller's parent
  //                   fill: a bin soft-failed, no model was available, the file was
  //                   unreadable, or the model just omitted the path from its echo. FAIL
  //                   CLOSED — skip it entirely and retry next sweep. Writing NONE here
  //                   would be permanent: the entry's hash would match forever after, and
  //                   the file would never be reconsidered.
  const { classify: classifiable, bucket, skip } = partitionByDomain(stale, domain)
  const direct: ApertureSemanticStore.Store = {}
  for (const r of bucket) direct[r.node.id] = { facet: NONE_FACET, hash: r.hash, via: domain!.witness.get(r.node.id)! }
  if (domain)
    yield* appendPerfEvent(directory, origin, "domain", {
      lens: lens.id,
      parent: domain.parent.id,
      inDomain: classifiable.length,
      outOfDomain: bucket.length,
      unwitnessed: skip.length,
    })

  const context = yield* contextMode(deps.config, lens)
  const language = classifiable.length === 0 ? undefined : yield* resolveLanguage(deps.provider)
  if (classifiable.length > 0 && !language) {
    log.info("no small model available; skipping paint pass", { projectID, scope })
    yield* appendPerfEvent(directory, origin, "skip", { reason: "no-language", stale: classifiable.length })
    // The out-of-domain bucketing below needs no model, so it still lands.
  }

  const facetSchema = buildFacetSchema(lens)
  const system = buildSystemPrompt(lens, domain?.parent)

  // Path → its hash so we can record freshness on whatever the model returns.
  const hashByPath = new Map(classifiable.map((r) => [r.node.path, r.hash]))
  const idByPath = new Map(classifiable.map((r) => [r.node.path, r.node.id]))

  // Dir-coherent binning (the "dirsplit" perf-eval winner): one bin per directory,
  // big dirs split into same-dir chunks of FACET_BATCH — maximally coherent prompts.
  // Bins are classified up to `fanout`-wide; a single failed bin soft-fails to "paint
  // nothing" (catch inside the worker) without interrupting its siblings.
  const bins = language ? splitDirs(classifiable, FACET_BATCH) : []
  const fanout = yield* painterConcurrency(deps.config)
  const classifyBin = (bin: typeof classifiable) =>
    Effect.gen(function* () {
      const blocks = bin.map((r) => describeFile(r.node.path, r.content, context)).join("\n\n")
      const { files: assignments, usage } = yield* classifyWithRetry(language!, blocks, facetSchema, system, lens).pipe(
        Effect.catchCause((cause) => {
          log.error("classify failed", { projectID, scope, cause })
          return Effect.succeed<ClassifyResult>(EMPTY_CLASSIFY)
        }),
      )
      return { blocks, assignments, usage }
    })
  const results = yield* Effect.forEach(bins, classifyBin, { concurrency: fanout })

  // Sequential post-pass: the perf log's byte counter (writePerfLine) and the painted
  // store are written here, not inside the concurrent workers, so the fan-out
  // never races the counter or interleaves appends. Seeded with the out-of-domain
  // bucketing so both halves land in one atomic upsert and one invalidation.
  const painted: ApertureSemanticStore.Store = { ...direct }
  let painterInput = 0
  let painterOutput = 0
  for (const { blocks, assignments, usage } of results) {
    painterInput += usage.inputTokens
    painterOutput += usage.outputTokens
    yield* appendPerfLog(directory, origin, lens.id, blocks, assignments)
    for (const a of assignments) {
      const id = idByPath.get(a.path)
      const hash = hashByPath.get(a.path)
      if (!id || !hash) continue
      // Carry the witness onto the entry so a later parent re-paint re-opens this file.
      const via = domain?.witness.get(id)
      painted[id] = { facet: a.facet, hash, ...(via !== undefined ? { via } : {}) }
    }
  }

  // Aperture study logging: painter token spend, kept separate from conversation
  // tokens. Attributed to the most-recently-active session (painter is not
  // session-scoped). `trigger` is set when this pass is an ancestor fill forced by a
  // drill-down, so the drill-down's true cost isn't hidden in its parent's column.
  if (painterInput > 0 || painterOutput > 0)
    yield* StudyLog.recordPainter({
      origin,
      lens: lens.id,
      inputTokens: painterInput,
      outputTokens: painterOutput,
      ...(trigger && trigger !== lens.id ? { trigger } : {}),
    })

  const count = Object.keys(painted).length
  if (count === 0) return

  yield* ApertureSemanticStore.upsert(deps.storage, projectID, lens.id, painted)
  log.info("painted", { projectID, scope, lens: lens.id, count })
  if (!publish) return

  // Only now that something actually changed do we nudge the live view to refetch
  // and re-merge — the guard that keeps a paint→refetch→paint cycle from forming
  // (the next pass finds matching hashes and publishes nothing). Attach the location
  // explicitly: this runs in a forked fiber with no ambient Location.Service, so
  // without it the HTTP /event SSE filter (event.location.directory === instance
  // .directory) drops the event and the VSCode extension never refetches.
  yield* deps.events.publish(ApertureEvent.Event.Invalidated, { scope }, { location: { directory: AbsolutePath.make(directory) } }).pipe(Effect.ignore)
}, Effect.provide(FSUtil.defaultLayer))

// --- sub-file (drill-in) painter -------------------------------------------

// Paint the top-level declarations of a single drilled-into file (A5). The unit of
// work is a function-level extent (extents.ts), classified with the *same* Lens
// vocabulary as file-level painting but minimal per-function context (signature +
// leading comment). Stale-only by the extent's content hash, so re-drilling an
// unedited file spends nothing. Writes the per-function facet store; soft-fails to
// "paint nothing". Strictly a drill-in refinement — never on the critical path of
// defining or filling a Lens (see docs/codegraph-subfile-resolution.md). The caller
// schedules this on the shared single-permit gate at drill-in priority.
export const paintExtentsStale = Effect.fn("Aperture.paintExtentsStale")(function* (
  deps: Deps,
  directory: string,
  projectID: string,
  relPath: string,
  lens: Lens,
  // Scope to publish the invalidation for once tiles are coloured — the window the
  // user is viewing, so the drilled band live-fills regardless of the file's own dir.
  scope: string,
  // The resolved parent Lens when `lens` is a drill-down, for the prompt's domain note.
  // The domain *gate* is the caller's job (scheduleExtentPaint refuses to function-paint an
  // out-of-domain file at all), so by the time we get here the file is known in-domain.
  parent?: Lens,
) {
  const fs = yield* FSUtil.Service
  const content = yield* fs
    .readFileStringSafe(path.join(directory, relPath))
    .pipe(Effect.orElseSucceed(() => undefined as string | undefined))
  if (typeof content !== "string") return

  // A file with no top-level declaration (a single whole-file preamble tile) needs
  // no function painting — file-level already suffices there.
  const paintable = ApertureExtents.extentsOf(content).filter((e) => e.name !== ApertureExtents.PREAMBLE)
  if (paintable.length === 0) return

  const store = yield* ApertureSubfacetStore.read(deps.storage, projectID, lens.id)

  // Fold the file's function facets into a byte-weighted mix and persist it. Directory
  // composition attributes this file's bytes to its *function* facets from that mix
  // (superseding the coarser file-level facet), and it can't recompute it at read time —
  // that would mean re-reading every file in the repo on every payload read. We have the
  // content here, so we measure it here. Re-derived on every pass, not just when a
  // function was repainted, so a file painted before mixes existed — or one whose extents
  // shifted without any function's text changing — heals without spending a token.
  const syncMix = (entries: ApertureSubfacetStore.Store) =>
    Effect.gen(function* () {
      const facetByName = new Map<string, string>()
      for (const extent of ApertureExtents.extentsOf(content)) {
        const entry = entries[ApertureExtents.subNodeID(relPath, extent.name)]
        if (entry) facetByName.set(extent.name, entry.facet)
      }
      const mix = ApertureExtents.fileComposition(content, facetByName)
      return yield* ApertureSubfacetStore.upsertMix(deps.storage, projectID, lens.id, relPath, mix)
    })

  const stale = paintable
    .map((extent) => {
      const text = ApertureExtents.extentText(content, extent)
      return { extent, id: ApertureExtents.subNodeID(relPath, extent.name), text, hash: hashContent(text) }
    })
    .filter((r) => store[r.id]?.hash !== r.hash)
  if (stale.length === 0) {
    // Nothing to paint, but the mix may still be missing or stale. Publish only if that
    // backfill actually changed something, so the paint→refetch→paint guard still holds.
    const mixChanged = yield* syncMix(store)
    yield* appendPerfEvent(directory, "fg", "skip", { reason: "no-stale-extents", file: relPath })
    if (mixChanged)
      yield* deps.events
        .publish(ApertureEvent.Event.Invalidated, { scope }, { location: { directory: AbsolutePath.make(directory) } })
        .pipe(Effect.ignore)
    return
  }

  const language = yield* resolveLanguage(deps.provider)
  if (!language) return

  const facetSchema = buildFacetSchema(lens)
  const system = buildSystemPrompt(lens, parent)
  // Each extent is one classify "block", labelled `relPath#name` so the model echoes
  // an identifier that maps back to the sub-node id.
  const blocks = stale.map((r) => describeExtent(relPath, r.extent.name, r.text)).join("\n\n")
  const idByLabel = new Map(stale.map((r) => [`${relPath}#${r.extent.name}`, r.id]))
  const hashByLabel = new Map(stale.map((r) => [`${relPath}#${r.extent.name}`, r.hash]))

  const { files: assignments, usage } = yield* classifyWithRetry(language, blocks, facetSchema, system, lens).pipe(
    Effect.catchCause((cause) => {
      log.error("classify extents failed", { projectID, file: relPath, cause })
      return Effect.succeed<ClassifyResult>(EMPTY_CLASSIFY)
    }),
  )
  yield* appendPerfLog(directory, "fg", lens.id, blocks, assignments)
  // Aperture study logging: drill-in (function-level) painter token spend.
  yield* StudyLog.recordPainter({
    origin: "fg",
    lens: lens.id,
    scope: relPath,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  })

  const painted: ApertureSubfacetStore.Store = {}
  for (const a of assignments) {
    const id = idByLabel.get(a.path)
    const hash = hashByLabel.get(a.path)
    if (!id || !hash) continue
    painted[id] = { facet: a.facet, hash }
  }
  if (Object.keys(painted).length === 0) return

  yield* ApertureSubfacetStore.upsert(deps.storage, projectID, lens.id, painted)
  yield* syncMix({ ...store, ...painted })
  log.info("painted extents", { projectID, file: relPath, lens: lens.id, count: Object.keys(painted).length })
  // Nudge the viewed scope to re-merge the drilled file's now-coloured tiles. Attach
  // the location (forked fiber → no ambient Location.Service) or the HTTP /event SSE
  // filter drops it and the extension's drilled file never fills in.
  yield* deps.events.publish(ApertureEvent.Event.Invalidated, { scope }, { location: { directory: AbsolutePath.make(directory) } }).pipe(Effect.ignore)
}, Effect.provide(FSUtil.defaultLayer))

// Minimal per-extent context: its path label, the declaration's signature (first
// non-blank line), and any leading comment. Mirrors the file-level `minimal` mode.
function describeExtent(relPath: string, name: string, text: string): string {
  const signature = firstNonBlank(text).slice(0, 200)
  const comment = leadingComment(text)
  const lines = [`path: ${relPath}#${name}`]
  if (signature) lines.push(`signature: ${signature}`)
  if (comment) lines.push(`comment: ${comment}`)
  return lines.join("\n")
}

// --- perf log --------------------------------------------------------------

// Deterministic, code-written (never agent-written) trace of every model request:
// one JSON line per batch with the painter identity (fg/bg), a timestamp, the exact
// prompt input, and the structured output. Written under <repo>/perf so the two
// painters' API traffic can be inspected after the fact. Fresh per run and capped in
// size (see writePerfLine), so it can't grow without bound. Written from the
// sequential post-pass in paintStale (not the concurrent classify fan-out), so appends
// never interleave and the byte counter never races. Failure is swallowed — logging
// must never break or slow painting.
function appendPerfLog(
  directory: string,
  origin: Origin,
  lens: string,
  input: string,
  output: ReadonlyArray<{ path: string; facet: string }>,
) {
  return writePerfLine(directory, { painter: origin, lens, timestamp: new Date().toISOString(), input, output })
}

// Diagnostic counterpart to appendPerfLog: records lifecycle/skip events (pass
// start, empty enumeration, no stale files, no small model) so a painter that
// produces no request lines can still be traced. Same file, distinguished by the
// `event` field.
export function appendPerfEvent(directory: string, origin: Origin, event: string, detail?: Record<string, unknown>) {
  return writePerfLine(directory, { painter: origin, timestamp: new Date().toISOString(), event, ...detail })
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
    const file = path.join(dir, "painter.log")
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

type FacetSchema = ReturnType<typeof buildFacetSchema>

const classify = (
  language: Parameters<typeof generateObject>[0]["model"],
  blocks: string,
  facetSchema: FacetSchema,
  system: string,
  lens: Lens,
) =>
  Effect.tryPromise(() =>
    generateObject({
      model: language,
      temperature: 0,
      schema: Object.assign(Schema.toStandardSchemaV1(facetSchema), Schema.toStandardJSONSchemaV1(facetSchema)),
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Classify these files:\n\n${blocks}` },
      ],
    }).then((r) => {
      const result = r.object as typeof facetSchema.Type
      const files = result.files.filter((f): f is { path: string; facet: string } => isAssignableFacet(lens, f.facet))
      // Surface token usage so the study log can account for the painter's model
      // spend separately from conversation tokens. AI-SDK v5 uses input/outputTokens.
      const u = r.usage as
        | { inputTokens?: number; outputTokens?: number; promptTokens?: number; completionTokens?: number }
        | undefined
      const usage = {
        inputTokens: u?.inputTokens ?? u?.promptTokens ?? 0,
        outputTokens: u?.outputTokens ?? u?.completionTokens ?? 0,
      }
      return { files, usage }
    }),
  )

// One classify call's outcome: the assignable facets + the model token spend.
type ClassifyResult = {
  files: ReadonlyArray<{ path: string; facet: string }>
  usage: { inputTokens: number; outputTokens: number }
}
const EMPTY_CLASSIFY: ClassifyResult = { files: [], usage: { inputTokens: 0, outputTokens: 0 } }

// Retry a classify call on rate-limit / overload errors with exponential backoff +
// jitter, capped at BG_MAX_RETRIES. Only retries bounceback (429/5xx/overloaded);
// parse and other errors fall straight through to the soft-fail handler so a
// genuinely bad batch never wedges the loop. Effect.tryPromise wraps the thrown SDK
// error in an UnknownException whose `.error` holds the original.
const classifyWithRetry = (
  language: Parameters<typeof generateObject>[0]["model"],
  blocks: string,
  facetSchema: FacetSchema,
  system: string,
  lens: Lens,
) =>
  classify(language, blocks, facetSchema, system, lens).pipe(
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

// Resolve the effective per-file context mode for a paint pass. The global config, when
// explicitly set, wins (a deliberate override for A/B-ing a mode across every Lens);
// otherwise each Lens decides via `lens.context`, defaulting to "minimal".
function contextMode(config: Config.Interface, lens: Lens) {
  const fromLens: "minimal" | "medium" = lens.context === "medium" ? "medium" : "minimal"
  return config.get().pipe(
    Effect.map((cfg) => {
      const override = cfg.aperture?.painter?.context
      return (override === "medium" || override === "minimal" ? override : fromLens) as "minimal" | "medium"
    }),
    Effect.catchCause(() => Effect.succeed(fromLens)),
  )
}

// How many dir-bins to classify concurrently within a pass. Honors the config
// override (clamped to a sane range) and falls back to FACET_FANOUT on read failure.
function painterConcurrency(config: Config.Interface) {
  return config.get().pipe(
    Effect.map((cfg) => clamp(cfg.aperture?.painter?.concurrency ?? FACET_FANOUT, 1, 128)),
    Effect.catchCause(() => Effect.succeed(FACET_FANOUT)),
  )
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.trunc(n)))
}

// Compact textual context for one file. `minimal` = path + imports + leading comment.
// `medium` additionally sends a *structural skeleton* — exported names, the file's line
// count, and each top-level declaration's signature + length — so a Lens can judge the
// code's size and shape without ever shipping a function body (cost scales with the
// declaration count, not the file size). Exported for the painter test.
export function describeFile(rel: string, content: string, mode: "minimal" | "medium"): string {
  const capped = content.length > MAX_FILE_BYTES ? content.slice(0, MAX_FILE_BYTES) : content
  const imports = ApertureExtract.parseImports(rel, capped)
  const comment = leadingComment(capped)
  const lines = [`path: ${rel}`]
  if (imports.length) lines.push(`imports: ${imports.slice(0, 20).join(", ")}`)
  if (comment) lines.push(`comment: ${comment}`)
  if (mode === "medium") {
    const exports = exportedNames(capped)
    if (exports.length) lines.push(`exports: ${exports.slice(0, 20).join(", ")}`)
    lines.push(`lines: ${lineCount(capped)}`)
    // Top-level declarations only (the preamble — imports/top-level code before the first
    // declaration — is already covered by imports/comment). Each becomes one skeleton
    // line: its signature (first non-blank line) + its span, so a long function or a file
    // with too many responsibilities is visible at a glance.
    const decls = ApertureExtents.extentsOf(capped).filter((e) => e.name !== ApertureExtents.PREAMBLE)
    if (decls.length) {
      lines.push("decls:")
      for (const e of decls.slice(0, MAX_SKELETON_DECLS)) {
        const sig = firstNonBlank(ApertureExtents.extentText(capped, e)).slice(0, SKELETON_SIG_CHARS)
        lines.push(`- ${sig}  [${e.endLine - e.startLine + 1} lines]`)
      }
      if (decls.length > MAX_SKELETON_DECLS) lines.push(`- (+${decls.length - MAX_SKELETON_DECLS} more)`)
    }
  }
  return lines.join("\n")
}

// Line count of a (possibly empty) string: 0 for "", else one per newline-delimited line.
function lineCount(content: string): number {
  return content.length === 0 ? 0 : content.split("\n").length
}

// First non-blank line of a block, trimmed. "" when the block is all whitespace.
function firstNonBlank(text: string): string {
  return (text.split("\n").find((l) => l.trim() !== "") ?? "").trim()
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

// "dirsplit" binning (the perf-eval winner): one bin per immediate directory,
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

export * as AperturePainter from "./painter"
