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

// Semantic painter. Given the files of a viewed scope, it infers a facet per *extent*
// with a small/fast model, writes them to the per-project sub-facet store, and derives
// each file's own facet from the result. It is the *only* place tokens are spent in the
// Aperture feature, and since O3 the only painter at all — file-level painting is not a
// separate pass but the coarse end of this one.
//
// Granularity is the cost dial (PLAN.md O3). A file is cut either into ONE whole-file
// extent — described exactly as file-level painting described it, at exactly its price —
// or into one extent per top-level declaration, which measured ~5.8x. Which one it gets
// is decided by granularityOf from the config dial plus the caller's interest signal, so
// always-on painting costs the old floor and only files in view / edited / in the working
// set pay the refinement. Nothing classifies a file independently of its extents, which
// is what makes it impossible for a file's colour to contradict its parts'.
//
// Frugality otherwise comes from two rules:
//   1. Stale-only, per extent — an extent is (re)painted only when it has no stored entry
//      or its own text changed, so an edit to one function repaints that function and
//      nothing else, and re-displaying unchanged code spends nothing.
//   2. Minimal context — a fine block is a declaration's signature + leading comment; a
//      coarse block is the path, parsed import specifiers, and the leading comment.
//      Agent-authored code is rarely named pathologically, so that's usually enough to
//      place a file. A Lens whose facets need the code's *shape* (e.g. "code smells",
//      "god files") opts into `medium`, which adds a cheap structural skeleton — exported
//      names, the file's line count, and each top-level declaration's signature + length —
//      never a function body, so cost scales with declaration count, not file size. The
//      mode is per-Lens (Lens.context); a global config override (aperture.painter.context)
//      can force one mode across all Lenses for experimentation.
//
// Failure is soft: any read/model/parse error leaves existing semantics intact
// and publishes nothing, so the structure bar always keeps working.

const log = Log.create({ service: "aperture.painter" })

// Caps so a large window can never blow up a prompt or a single request: read at
// most this many stale files per pass, binned into dir-coherent groups of at most
// EXTENT_BATCH block-weight and classified with up to FACET_FANOUT model calls in flight.
const MAX_PER_PASS = 960
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

// Bin budget in *block weight* rather than file count (O3), replacing the flat
// 30-files-per-bin of the pre-merge file painter. A coarse block is a whole file
// (describeFile — imports + comment, optionally a skeleton); a fine block is one
// declaration's signature + leading comment, roughly half that. Weighting them 2:1
// against a budget of 60 makes a coarse-only bin exactly those same 30 files, so the
// whole-repo sweep's prompts and per-call latency are unchanged by the merge, while a
// fine bin carries ~60 declarations for a comparable input size.
const EXTENT_BATCH = 60
const COARSE_BLOCK_WEIGHT = 2
const FINE_BLOCK_WEIGHT = 1
// Secondary cap, on extents rather than files: MAX_PER_PASS alone can't bound a pass
// whose files are cut per-declaration. Truncation is on FILE boundaries so a file is
// never half-painted, and the dropped tail simply stays stale for the next trigger.
// A coarse pass can't reach this (MAX_PER_PASS files × 1 extent each < 2400), which is
// why the background sweep's BG_BATCH contract with MAX_PER_PASS still holds.
const MAX_EXTENTS_PER_PASS = 2400

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

// Whether a drill-down's parent has MOVED this file to a different facet since it was
// last painted. Invisible to a content hash — the file didn't change, its *domain* did —
// which is why entries carry `via`. It forces every extent of the file to repaint,
// because their facets were chosen under a domain that no longer holds.
//
// Content staleness is NOT this function's job: since O3 that is decided per extent, by
// the extent's own content hash, so an edit to one function repaints only that function.
// Absence is likewise not "moved" — a never-painted file has no extents stored either, so
// it is already stale by hash and needs no special case here.
export function domainMoved(entry: ApertureSemanticStore.Entry | undefined, witness: string | undefined): boolean {
  return witness !== undefined && entry !== undefined && entry.via !== witness
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
  // What put these files in the interest set — "drill" | "working-set" | "window" |
  // "file-changed" | "lens-switch" | "sweep". Recorded so the cost of each trigger is
  // attributable, which is what makes widening the granularity dial an evidence-based
  // call. Distinct from `trigger` above, which names a *Lens*, not a reason.
  readonly source?: string
}

// A file to paint, and whether the caller considers it interesting enough to cut per
// declaration. The painter turns that into a granularity — honouring the high-water rule
// that a file already cut finely is never coarsened back (see granularityOf).
export interface PaintTarget {
  readonly node: FileNode
  readonly interested?: boolean
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

// Paint any stale *extent* of any file in `targets` and persist the result. Requires
// only FSUtil from context (provided at the fork site); all other services are passed
// in so callers keep a clean `R = never` return type.
//
// Since O3 this is the ONLY painter. The unit of work is an extent, and a file's
// granularity decides how many extents it has: a cold file is one WHOLE extent described
// exactly as file-level painting described it (same prompt, same cost), an interesting
// one is cut per declaration. A file's own facet is never classified independently — it
// is *derived* from the extent mix in the post-pass below, which is what makes it
// impossible for a file's colour and its parts' colours to disagree.
export const paintStale = Effect.fn("Aperture.paintStale")(function* (
  deps: Deps,
  directory: string,
  projectID: string,
  // The viewed windows to invalidate once tiles are coloured. Plural because a file at
  // a/b/c.ts is drawn in window "a" as well as "a/b" (VIEW_DEPTH is 2), so publishing
  // only to its own parent directory under-notifies.
  scopes: ReadonlyArray<string>,
  targets: ReadonlyArray<PaintTarget>,
  origin: Origin,
  lens: Lens,
  options: PaintOptions = {},
) {
  if (targets.length === 0) return
  const { domain, publish = true, trigger, source } = options

  const store = yield* ApertureSemanticStore.read(deps.storage, projectID, lens.id)
  const subStore = yield* ApertureSubfacetStore.read(deps.storage, projectID, lens.id)
  // Read for the granularity high-water mark as well as the write below: a file already
  // cut per-declaration has a mix with more than one extent in it.
  const priorMixes = yield* ApertureSubfacetStore.readMixes(deps.storage, projectID, lens.id)
  const granularityMode = yield* painterGranularity(deps.config)

  // Read each candidate. Files we can't read are simply skipped.
  const fs = yield* FSUtil.Service
  const read = yield* Effect.forEach(
    targets,
    (target) =>
      fs.readFileStringSafe(path.join(directory, target.node.path)).pipe(
        Effect.map((content) => ({ target, content }) as { target: PaintTarget; content: string | undefined }),
        Effect.orElseSucceed(() => ({ target, content: undefined as string | undefined })),
      ),
    { concurrency: READ_CONCURRENCY },
  )

  // Cut each readable file into extents once (the regex walk is re-run three times a pass
  // otherwise) and note whether its whole classification has to be re-opened because its
  // domain moved under it.
  const files = read
    .filter((r): r is { target: PaintTarget; content: string } => typeof r.content === "string")
    .slice(0, MAX_PER_PASS)
    .map((r) => {
      const node = r.target.node
      const granularity = granularityOf(r.target, priorMixes, granularityMode)
      return {
        node,
        content: r.content,
        hash: hashContent(r.content),
        granularity,
        extents: ApertureExtents.extentsOf(r.content, granularity),
        reopen: domainMoved(store[node.id], domain?.witness.get(node.id)),
        // Witnessed by the parent, but by a facet outside this drill-down's scope. Read
        // from the domain rather than from the pass's bucketing, because it has to hold on
        // a pass where the file has nothing stale left to bucket: it may still carry
        // sub-facets from when it WAS in domain, and deriving a facet from those would
        // quietly undo the NONE that greys it (and bleed them into every ancestor's
        // composition, which is precisely what a drill-down exists to prevent).
        outOfDomain: domain !== undefined && domain.witness.has(node.id) && !domain.allowed.has(node.id),
      }
    })

  // Flatten to the extent work list, budgeted on file boundaries so a file is never left
  // half-painted purely by truncation. Records carry the FILE's node, which is what lets
  // splitDirs bin them dir-coherently and partitionByDomain gate them by file.
  const budgeted: typeof files = []
  let extentCount = 0
  for (const file of files) {
    if (extentCount >= MAX_EXTENTS_PER_PASS) break
    budgeted.push(file)
    extentCount += file.extents.length
  }
  if (budgeted.length < files.length)
    yield* appendPerfEvent(directory, origin, "truncated", {
      reason: "extent-budget",
      painted: budgeted.length,
      dropped: files.length - budgeted.length,
    })

  const byNode = new Map(budgeted.map((f) => [f.node.id, f]))
  const reopened = new Set(budgeted.filter((f) => f.reopen).map((f) => f.node.id))
  const stale = budgeted
    .flatMap((file) =>
      file.extents.map((extent) => {
        const coarse = extent.name === ApertureExtents.WHOLE
        const text = coarse ? file.content : ApertureExtents.extentText(file.content, extent)
        return {
          node: file.node,
          name: extent.name,
          // A coarse block is labelled with the bare path, exactly as file-level painting
          // labelled it; only a per-declaration block carries the `#name` suffix.
          label: coarse ? file.node.path : `${file.node.path}#${extent.name}`,
          id: ApertureExtents.subNodeID(file.node.path, extent.name),
          content: file.content,
          coarse,
          text,
          hash: hashContent(text),
        }
      }),
    )
    // Stale-only, per extent: an edit to one declaration repaints that declaration and
    // nothing else. `reopen` overrides it for the whole file when its domain moved.
    .filter((r) => reopened.has(r.node.id) || subStore[r.id]?.hash !== r.hash)

  if (stale.length === 0) {
    // Nothing to classify, but a file's mix may still be missing or stale (it is
    // re-derived every pass, free, so a file painted before mixes existed heals itself).
    // Publish only if that backfill actually changed something, or the self-heal becomes
    // a paint→refetch→paint cycle.
    yield* appendPerfEvent(directory, origin, "skip", { reason: "no-stale", candidates: targets.length })
    const changed = yield* syncDerived(deps, projectID, lens, budgeted, subStore, store, domain)
    if (changed && publish) yield* publishInvalidated(deps, directory, scopes)
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
  // An out-of-domain file gets NO extents (finalize greys its tiles deterministically) and
  // one NONE entry at file level. Keyed by file, so the several extents a file contributes
  // to `bucket` collapse to the one entry its file deserves.
  const direct: ApertureSemanticStore.Store = {}
  for (const r of bucket)
    direct[r.node.id] = {
      facet: NONE_FACET,
      hash: byNode.get(r.node.id)!.hash,
      via: domain!.witness.get(r.node.id)!,
    }
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
    log.info("no small model available; skipping paint pass", { projectID, scopes })
    yield* appendPerfEvent(directory, origin, "skip", { reason: "no-language", stale: classifiable.length })
    // The out-of-domain bucketing below needs no model, so it still lands.
  }

  const facetSchema = buildFacetSchema(lens)
  const system = buildSystemPrompt(lens, domain?.parent)

  // Block label → the extent it belongs to, so the model's echo maps back to a sub-node
  // id. A coarse block's label is the bare path; a fine one's is `path#name`.
  const byLabel = new Map(classifiable.map((r) => [r.label, r]))

  // Dir-coherent binning (the "dirsplit" perf-eval winner): one bin per directory, big
  // dirs split into same-dir chunks — maximally coherent prompts. Budgeted by block
  // weight rather than record count so a coarse-only bin is still exactly FACET_BATCH
  // files. Bins are classified up to `fanout`-wide; a single failed bin soft-fails to
  // "paint nothing" (catch inside the worker) without interrupting its siblings.
  const bins = language
    ? splitDirs(classifiable, EXTENT_BATCH, (r) => (r.coarse ? COARSE_BLOCK_WEIGHT : FINE_BLOCK_WEIGHT))
    : []
  const fanout = yield* painterConcurrency(deps.config)
  const classifyBin = (bin: typeof classifiable) =>
    Effect.gen(function* () {
      const blocks = bin
        .map((r) =>
          r.coarse ? describeFile(r.node.path, r.content, context) : describeExtent(r.node.path, r.name, r.text),
        )
        .join("\n\n")
      const { files: assignments, usage } = yield* classifyWithRetry(language!, blocks, facetSchema, system, lens).pipe(
        Effect.catchCause((cause) => {
          log.error("classify failed", { projectID, scopes, cause })
          return Effect.succeed<ClassifyResult>(EMPTY_CLASSIFY)
        }),
      )
      return { blocks, assignments, usage }
    })
  const results = yield* Effect.forEach(bins, classifyBin, { concurrency: fanout })

  // Sequential post-pass: the perf log's byte counter (writePerfLine) and every store
  // write happen here, not inside the concurrent workers, so the fan-out never races the
  // counter or interleaves appends — and each store is written exactly once per pass
  // however many bins the pass spanned. That is what decouples bin boundaries from file
  // boundaries: a bin may span several files, and a file several bins, with no effect on
  // the writes below.
  const painted: ApertureSubfacetStore.Store = {}
  let painterInput = 0
  let painterOutput = 0
  for (const { blocks, assignments, usage } of results) {
    painterInput += usage.inputTokens
    painterOutput += usage.outputTokens
    yield* appendPerfLog(directory, origin, lens.id, blocks, assignments)
    for (const a of assignments) {
      const record = byLabel.get(a.path)
      if (!record) continue
      painted[record.id] = { facet: a.facet, hash: record.hash }
    }
  }

  // Aperture study logging: painter token spend, kept separate from conversation
  // tokens. Attributed to the most-recently-active session (painter is not
  // session-scoped). `trigger` is set when this pass is an ancestor fill forced by a
  // drill-down, so the drill-down's true cost isn't hidden in its parent's column;
  // `source` names the interest heuristic that scheduled it, and `extents`/`files` are
  // what make the granularity dial's cost measurable.
  if (painterInput > 0 || painterOutput > 0)
    yield* StudyLog.recordPainter({
      origin,
      lens: lens.id,
      files: budgeted.length,
      extents: classifiable.length,
      coarse: classifiable.filter((r) => r.coarse).length,
      inputTokens: painterInput,
      outputTokens: painterOutput,
      ...(source ? { source } : {}),
      ...(trigger && trigger !== lens.id ? { trigger } : {}),
    })

  if (Object.keys(painted).length > 0) yield* ApertureSubfacetStore.upsert(deps.storage, projectID, lens.id, painted)
  if (Object.keys(direct).length > 0) yield* ApertureSemanticStore.upsert(deps.storage, projectID, lens.id, direct)

  // Derive each file's mix and its file-level facet from the extents now on record.
  const changed = yield* syncDerived(
    deps,
    projectID,
    lens,
    budgeted,
    { ...subStore, ...painted },
    { ...store, ...direct },
    domain,
  )
  log.info("painted", {
    projectID,
    lens: lens.id,
    files: budgeted.length,
    extents: Object.keys(painted).length,
  })
  if (!publish) return
  // Only now that something actually changed do we nudge the live view to refetch
  // and re-merge — the guard that keeps a paint→refetch→paint cycle from forming
  // (the next pass finds matching hashes and publishes nothing).
  if (changed || Object.keys(direct).length > 0) yield* publishInvalidated(deps, directory, scopes)
}, Effect.provide(FSUtil.defaultLayer))

// A file's granularity: the configured dial, the caller's interest signal, OR — the
// high-water rule — the fact that it is already cut per declaration, which the stored mix
// records as more than one extent. Inferred rather than stored, and monotone: a file is
// never coarsened back, so granularity can't oscillate and paint is never thrown away
// twice. That last clause holds even at "file", where the dial only stops NEW promotions;
// re-coarsening an already-fine file would cost tokens to lose information.
export function granularityOf(
  target: PaintTarget,
  mixes: ApertureSubfacetStore.Mixes,
  mode: GranularityMode,
): ApertureExtents.Granularity {
  if (mode === "declaration") return "declaration"
  if (mode === "interest" && target.interested) return "declaration"
  return (mixes[target.node.path]?.subtreeCount ?? 0) > 1 ? "declaration" : "file"
}

// The cost dial (aperture.painter.granularity). "file" paints every file once as a whole —
// the floor, priced exactly like the pre-O3 file-level pass. "interest" additionally
// promotes files the user is looking at, editing, or has uncommitted changes in.
// "declaration" promotes the whole repository (~5.8x).
export type GranularityMode = "file" | "interest" | "declaration"

function painterGranularity(config: Config.Interface) {
  return config.get().pipe(
    Effect.map((cfg) => {
      const mode = cfg.aperture?.painter?.granularity
      return (mode === "file" || mode === "declaration" ? mode : "interest") as GranularityMode
    }),
    Effect.catchCause(() => Effect.succeed("interest" as GranularityMode)),
  )
}

// Re-derive each file's byte-weighted facet mix AND its file-level facet from the extents
// on record, and persist both. This is the projection that makes a file's colour a pure
// function of its parts: `attributeFileBytes` is the very function directory composition
// uses, so a file's tile and its band in the parent directory's treemap cannot disagree.
// Nothing else writes a painted file's facet.
//
// Run for every file in the pass, not just repainted ones — it costs no tokens — so a file
// painted before mixes existed, or whose extents shifted without any one of them changing,
// heals itself. Returns whether anything actually changed, which is the guard that stops
// that self-heal becoming a paint→refetch→paint cycle.
const syncDerived = (
  deps: Deps,
  projectID: string,
  lens: Lens,
  files: ReadonlyArray<{
    readonly node: FileNode
    readonly content: string
    readonly hash: string
    readonly granularity: ApertureExtents.Granularity
    readonly extents: ReadonlyArray<ApertureExtents.Extent>
    readonly outOfDomain: boolean
  }>,
  entries: ApertureSubfacetStore.Store,
  semantics: ApertureSemanticStore.Store,
  domain: Domain | undefined,
) =>
  Effect.gen(function* () {
    const mixes: ApertureSubfacetStore.Mixes = {}
    const derived: ApertureSemanticStore.Store = {}
    for (const file of files) {
      if (file.outOfDomain) {
        // Grey, wholly and durably. An EMPTY mix is not the same as no mix: it makes
        // `attributeFileBytes` fall back to the file-level facet (the NONE just written)
        // for all of the file's bytes, so any mix left over from when it was in domain
        // stops contributing to its directory's composition.
        mixes[file.node.path] = { weights: [], totalCount: 0, totalBytes: 0, subtreeCount: 0, subtreeBytes: 0 }
        continue
      }
      const facetByName = new Map<string, string>()
      for (const extent of file.extents) {
        const entry = entries[ApertureExtents.subNodeID(file.node.path, extent.name)]
        if (entry) facetByName.set(extent.name, entry.facet)
      }
      if (facetByName.size === 0) continue
      const mix = ApertureExtents.fileComposition(file.content, facetByName, file.granularity)
      mixes[file.node.path] = mix
      // No independent file-level facet to fall back on any more, so the remainder (an
      // unpainted extent) is simply not attributed and the plurality of what IS painted
      // wins. A half-painted file therefore shows its dominant known facet rather than grey.
      const dominant = ApertureExtents.attributeFileBytes(Buffer.byteLength(file.content), mix, undefined).dominant
      if (dominant === undefined) continue
      const via = domain?.witness.get(file.node.id)
      derived[file.node.id] = { facet: dominant, hash: file.hash, ...(via !== undefined ? { via } : {}) }
    }
    const mixChanged = yield* ApertureSubfacetStore.upsertMixes(deps.storage, projectID, lens.id, mixes)
    const facetChanged = Object.entries(derived).filter(
      ([id, entry]) => JSON.stringify(semantics[id]) !== JSON.stringify(entry),
    )
    if (facetChanged.length > 0)
      yield* ApertureSemanticStore.upsert(deps.storage, projectID, lens.id, Object.fromEntries(facetChanged))
    return mixChanged.length > 0 || facetChanged.length > 0
  })

// Nudge every viewed window to refetch. The location is attached explicitly: this runs in
// a forked fiber with no ambient Location.Service, so without it the HTTP /event SSE
// filter (event.location.directory === instance.directory) drops the event and the VSCode
// extension never refetches.
const publishInvalidated = (deps: Deps, directory: string, scopes: ReadonlyArray<string>) =>
  Effect.forEach(
    new Set(scopes),
    (scope) =>
      deps.events
        .publish(ApertureEvent.Event.Invalidated, { scope }, { location: { directory: AbsolutePath.make(directory) } })
        .pipe(Effect.ignore),
    { discard: true },
  )

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
  const status =
    (raw as { statusCode?: unknown; status?: unknown })?.statusCode ?? (raw as { status?: unknown })?.status
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
    // declaration — is already covered by imports/comment; WHOLE means the file has no
    // declarations to skeletonize). Each becomes one skeleton line: its signature (first
    // non-blank line) + its span, so a long function or a file with too many
    // responsibilities is visible at a glance.
    const decls = ApertureExtents.extentsOf(capped).filter(
      (e) => e.name !== ApertureExtents.PREAMBLE && e.name !== ApertureExtents.WHOLE,
    )
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

const EXPORT_DECL =
  /^export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/gm
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
// never merging across directories; a directory whose records exceed `budget` is split
// into same-directory chunks. Every bin is thus records from a single directory —
// coherent prompts — and the union of bins is exactly the input.
//
// `weightOf` lets the budget be measured in prompt blocks rather than records, so bins
// stay a consistent prompt size when a coarse (whole-file) block and a fine
// (per-declaration) block cost different amounts. It defaults to 1, i.e. plain record
// count. A record heavier than the whole budget still gets a bin of its own rather than
// being dropped. Sorting by path keeps binning deterministic, and Array.sort is stable,
// so several records from one file stay in file order.
export function splitDirs<T extends { readonly node: FileNode }>(
  records: ReadonlyArray<T>,
  budget: number,
  weightOf: (record: T) => number = () => 1,
): T[][] {
  const byDir = new Map<string, T[]>()
  for (const r of records) {
    const d = posixDir(r.node.path)
    const bucket = byDir.get(d) ?? []
    bucket.push(r)
    byDir.set(d, bucket)
  }
  const bins: T[][] = []
  for (const dirFiles of byDir.values()) {
    const sorted = [...dirFiles].sort((a, b) => (a.node.path < b.node.path ? -1 : a.node.path > b.node.path ? 1 : 0))
    let bin: T[] = []
    let weight = 0
    for (const r of sorted) {
      const w = weightOf(r)
      if (bin.length > 0 && weight + w > budget) {
        bins.push(bin)
        bin = []
        weight = 0
      }
      bin.push(r)
      weight += w
    }
    if (bin.length > 0) bins.push(bin)
  }
  return bins
}

export * as AperturePainter from "./painter"
