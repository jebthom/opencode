import { Effect, Layer, Context, Stream, Queue, Semaphore } from "effect"
import path from "path"
import { createHash } from "crypto"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import * as Log from "@opencode-ai/core/util/log"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { EventV2 } from "@opencode-ai/core/event"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { SessionStatus } from "@/session/status"
import { Storage } from "@/storage/storage"
import { Provider } from "@/provider/provider"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import type { InstanceContext } from "@/project/instance-context"
import { registerDisposer } from "@/effect/instance-registry"
import { AperturePayload } from "./payload"
import { ApertureExtract } from "./extract"
import { ApertureEvent } from "./event"
import { ApertureSemanticStore } from "./semantic-store"
import { ApertureSubfacetStore } from "./subfacet-store"
import { ApertureExtents } from "./extents"
import { AperturePainter } from "./painter"
import { ApertureLensStore } from "./lens-store"
import { ApertureDeterministic } from "./deterministic"
import { Git } from "@/git"
import {
  type Lens,
  type LensParent,
  type PaletteId,
  legend as lensLegend,
  orderForest,
  inDomain,
  NONE_FACET,
  NONE_HUE,
  NONE_LABEL,
  ARCHITECTURE,
  ARCHITECTURE_ID,
  BUS_FACTOR,
  BUS_FACTOR_ID,
  MAX_LENS_DEPTH,
  isBuiltinLens,
  isDeterministic,
  dependsOnDeterministic,
} from "./lenses"

// Server-side Aperture service (PLAN.md steps 1 + 2.5). Owns the deterministic
// payload, but unlike step 1 the graph is a *2-level window* rooted at a scope
// (a repo-relative directory the TUI is viewing). The view is built on demand:
// each scope the user navigates to is extracted, cached per project, and reused.
//
// Recompute is visibility-gated (the merge of step 3). We subscribe to file
// events and only mark a cached scope dirty when the changed file falls within
// that scope's window — a file buried in an unopened directory dirties nothing.
// When a *currently cached* scope goes dirty we also publish aperture.invalidated
// so the live view refetches just that scope; recompute itself still happens
// lazily on the next get(). Caches and the dirty set live per project directory.
//
// Two exploration scopes coexist. Per-scope (get/refresh) keeps the live view of
// the *viewed window* fresh as the user navigates — cheap, and the path that
// catches local edits/creations. The whole-repo `sweep` runs on open and on each
// turn completion: the deterministic walk enumerates every file in the repo and
// the painter paints all of them, so semantics fill in beyond the viewed window.
// Both layers keep their skip checks — a scope already cached + clean isn't
// recomputed, and a file whose content hash is unchanged isn't re-painted — so the
// sweep only spends work on what's new or actually changed.

const log = Log.create({ service: "aperture" })

// Shared concurrency gate across the foreground (per-scope window) and background
// (whole-repo) painters: at most this many painter *passes* in flight at once, so the
// two never collide on the API. Each pass internally fans its dir-bins out up to
// FACET_FANOUT-wide (see painter.ts); the gate serializes whole passes, not individual
// model calls. The background loop holds a permit only for one batch and releases it
// during its inter-batch pause, so a foreground paint always wins a permit promptly —
// that's how the visible view stays prioritized.
const PAINT_CONCURRENCY = 1
// Files handed to one background paintStale call; must equal MAX_PER_PASS in the painter
// so each call fully consumes the slice (a smaller MAX_PER_PASS would silently drop the
// slice's tail). Sized so the pass has ~2x as many dir-bins as workers — enough
// oversubscription to keep the FACET_FANOUT-wide pool busy through uneven bin latencies.
const BG_BATCH = 960
// Pause between background batches, held *outside* the permit so a foreground paint
// arriving mid-pause acquires immediately. Short because each batch already self-spaces
// via its concurrent calls; just enough to yield the gate between waves.
const BG_BATCH_DELAY = "250 millis"
// Ceiling on how many git working-set files we proactively function-paint per pass.
// Function-level painting is the expensive path (see the aperture-function-tagging-cost
// finding: ~5.8× the file-level token cost), so it stays scoped to the working set —
// the deterministic "interest" heuristic that supersedes click-to-drill. The cap guards
// the degenerate case: a repo with no commits reports *every* file as untracked (the whole
// tree is "changed"), which without a limit would turn this into an eager whole-repo
// function paint. Above the cap the proactive pass is skipped; those files still paint
// on-demand when drilled.
const WORKING_SET_PAINT_CAP = 200
// Files handed to one batched extent pass. Sized to roughly one fan-out wave so a slice
// doesn't hold the single paint permit long enough to stall a foreground pass; the drainer
// releases the permit and pauses between slices. Must not exceed the painter's own
// per-pass file cap (MAX_PER_PASS) or the tail of a slice would be silently dropped.
const EXTENT_DRAIN_BATCH = 240

// Storage key: ["aperture", <projectID>, "structure", <scopeKey>]. Per project
// and per scope so each navigated directory keeps its own durable subgraph.
function storageKey(projectID: string, scope: string) {
  const scopeKey = scope === "" ? "root" : "s_" + createHash("sha256").update(scope).digest("hex").slice(0, 16)
  return ["aperture", projectID, "structure", scopeKey]
}

interface DirCache {
  readonly projectID: string
  readonly scopes: Map<string, AperturePayload.Payload>
  readonly dirty: Set<string>
}

export interface CreateLensInput {
  readonly name: string
  readonly description: string
  readonly palette: PaletteId
  readonly prompt: string
  readonly facets: ReadonlyArray<{ readonly label: string; readonly description: string }>
  // Optional repo-relative directories the painter front-loads (see Lens).
  readonly directories?: ReadonlyArray<string>
  // Whether to make the new Lens active (switching the viewed Lens and
  // starting the painter on it). Defaults to true — the interactive /lens behaviour.
  // Pass false to create without disturbing the user's current view (the new
  // Lens then stays unpainted until it is selected).
  readonly activate?: boolean
  // Per-file painter context mode for this Lens (see Lens.context). Defaults to
  // "minimal"; pass "medium" only for Lenses that must judge the code's shape.
  readonly context?: "minimal" | "medium"
  // Makes this a *drill-down*: the Lens is scoped to the files another Lens painted into
  // the named facets, and every other file in the repo is bucketed into "Other" without a
  // model call. Both refs are permissive — the Lens by id or name, the facets by id or
  // label (plus "Other"/`none` to drill into what the parent didn't cover) — and are
  // resolved to ids by createLens.
  readonly parent?: { readonly lens: string; readonly facets: ReadonlyArray<string> }
}

export interface EditLensInput {
  // Id or name of the Lens to edit (must be a user/project Lens).
  readonly lens: string
  readonly name?: string
  readonly description?: string
  readonly palette?: PaletteId
  readonly prompt?: string
  // The complete desired facet list (like create). Facets keep their id — and thus their
  // existing painted files — when an id or label matches; new labels mint new facets.
  readonly facets?: ReadonlyArray<{ readonly id?: string; readonly label: string; readonly description: string }>
  readonly directories?: ReadonlyArray<string>
  // New per-file painter context mode (see Lens.context). Changing it re-paints the
  // whole repo from scratch (it re-classifies every file).
  readonly context?: "minimal" | "medium"
}

// Outcome of an edit/merge/delete: a resolved Lens or why it was refused. The
// built-in (global) Lenses are immutable, so they refuse with "builtin".
export type LensMutation =
  | { readonly status: "ok"; readonly lens: Lens; readonly structural: boolean }
  | { readonly status: "not-found" }
  | { readonly status: "builtin" }
  | { readonly status: "unknown-facet"; readonly facet: string }
  // The edit would drop a facet that a drill-down is scoped to, leaving it with a domain
  // that no longer exists. Names the dependents so the caller can re-scope or delete them.
  | { readonly status: "facet-in-use"; readonly facet: string; readonly lenses: ReadonlyArray<string> }

// Outcome of creating a Lens: the new Lens, or why the requested drill-down scope was
// refused. A root Lens (no `parent`) can only ever succeed.
export type CreateOutcome =
  | { readonly status: "ok"; readonly lens: Lens }
  | { readonly status: "unknown-parent"; readonly parent: string }
  | { readonly status: "unknown-facet"; readonly facets: ReadonlyArray<string> }
  | { readonly status: "empty-scope" }
  | { readonly status: "too-deep"; readonly max: number }

// Outcome of a delete: the now-active Lens (after falling back to Architecture
// when the deleted one was active) or why it was refused.
export type DeleteOutcome =
  | { readonly status: "ok"; readonly active: AperturePayload.LensInfo }
  | { readonly status: "not-found" }
  | { readonly status: "builtin" }

// Files carrying one or more Facets of a Lens, grouped by Facet (A3 helper tool).
// Powers "tell me about <component>'s files": the agent gets the paths under a
// Facet and reads them itself. Built from the painted store joined against the
// repo file listing (the store is keyed by an un-invertible path hash).
export type FacetFilesOutcome =
  | {
      readonly status: "ok"
      readonly lens: { readonly id: string; readonly name: string }
      readonly groups: ReadonlyArray<{
        readonly facet: string
        readonly label: string
        readonly paths: ReadonlyArray<string>
      }>
      readonly unknownFacets: ReadonlyArray<string>
    }
  | { readonly status: "not-found" }

export interface Interface {
  // Cached payload for `scope` (default repo root); computes + persists on a miss
  // or when the scope has been marked dirty by a file change in its window.
  readonly get: (scope?: string) => Effect.Effect<AperturePayload.Payload>
  // Recompute `scope` from disk, persist, and refresh the in-memory copy.
  readonly refresh: (scope?: string) => Effect.Effect<AperturePayload.Payload>
  // Built-in + project-defined Lenses, and the active one.
  readonly lenses: () => Effect.Effect<Lens[]>
  readonly activeLens: () => Effect.Effect<Lens>
  // Define a new per-project Lens (additive — never overwrites), make it
  // active, and kick off painting. Refuses only when a requested drill-down scope
  // (input.parent) doesn't resolve.
  readonly createLens: (input: CreateLensInput) => Effect.Effect<CreateOutcome>
  // Switch the active Lens by id or name; re-paints from cache and paints any
  // not-yet-painted files. Returns the resolved Lens, or undefined if unknown.
  readonly selectLens: (idOrName: string) => Effect.Effect<Lens | undefined>
  // Step one Lens forward ("next") or back ("prev") in the list (built-ins +
  // user-defined), wrapping at the ends, and re-paint. Returns the newly-active
  // Lens's info. Drives the top-bar's ◀/▶ arrows.
  readonly cycleLens: (direction: "next" | "prev") => Effect.Effect<AperturePayload.LensInfo>
  // Edit a user Lens in place. A structural change (facets added/removed/redefined
  // or prompt changed) clears that Lens's facets so the sweep re-paints from scratch;
  // a cosmetic change (name/label/palette/directories) just re-paints. Built-ins refuse.
  readonly editLens: (input: EditLensInput) => Effect.Effect<LensMutation>
  // Deterministically fold one facet into another for a user Lens (no re-paint, no
  // tokens): drops `from` and re-labels its files as `into`. Both id or label.
  readonly mergeFacets: (lens: string, from: string, into: string) => Effect.Effect<LensMutation>
  // Delete a user Lens (and its facets), falling back to the built-in active
  // Lens when the deleted one was active. Not exposed to the lens agent.
  readonly deleteLens: (idOrName: string) => Effect.Effect<DeleteOutcome>
  // List the files carrying the given Facet(s) of a Lens, grouped by Facet. `lens`
  // is an id/name (or undefined for the active Lens); `facets` are facet ids or
  // labels (empty = every Facet in the Lens). Returns not-found when the Lens is
  // unknown. Used by the `lens_facet_files` tool for sensemaking.
  readonly facetFiles: (lens: string | undefined, facets: ReadonlyArray<string>) => Effect.Effect<FacetFilesOutcome>
  // Drill into a file (A5): like `get`, but the payload also carries `extents` —
  // the file's function-level tiles, coloured from the per-function store — and a
  // drill-in paint pass is scheduled at top priority to fill any not-yet-painted
  // functions. `scope` is the surrounding window (default repo root).
  readonly drill: (file: string, scope?: string) => Effect.Effect<AperturePayload.Payload>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Aperture") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const events = yield* EventV2.Service
    // Provider/Config are not self-provided (see defaultLayer) — they ride the
    // server's merged layer like Session does. Captured here so the forked painter
    // keeps a clean R = never and `get`/`refresh` expose no extra requirements.
    const provider = yield* Provider.Service
    const config = yield* Config.Service
    // Drives the deterministic "Changed since last commit" built-in (git status). Like
    // Provider/Config it's self-provided in defaultLayer so the layer stays R = never.
    const git = yield* Git.Service

    // Shared by the foreground and background painters (see PAINT_CONCURRENCY).
    const paintGate = yield* Semaphore.make(PAINT_CONCURRENCY)
    // The layer-construction scope: background loops fork into it (not the per-get
    // request scope) so they live for the service's lifetime and are interrupted
    // when it's released, while keeping get()/refresh() at R = never.
    const serviceScope = yield* Effect.scope

    const empty = {
      version: AperturePayload.PAYLOAD_VERSION,
      nodes: [],
      edges: [],
      semantics: {},
    } satisfies AperturePayload.Payload

    // Per-directory caches. Created lazily on first get(); the file-event
    // subscription only ever touches directories that already have a cache, so
    // unopened projects cost nothing. Cleaned on instance disposal.
    const caches = new Map<string, DirCache>()
    const containerFor = (directory: string, projectID: string): DirCache => {
      const existing = caches.get(directory)
      if (existing) return existing
      const created: DirCache = { projectID, scopes: new Map(), dirty: new Set() }
      caches.set(directory, created)
      return created
    }

    // Whole-repo source-file membership (path + size) per directory, used to compute
    // recursive per-directory composition in finalize. Cached because the TUI force-
    // refreshes every fetch (so finalize runs constantly) but the file set only changes
    // when files change — we drop the entry from the same file-event / turn-completion
    // subscriptions that already fire below, so it rebuilds lazily on the next read.
    const subtreeCache = new Map<string, ReadonlyArray<ApertureDeterministic.SubtreeFile>>()
    // Read a repo-relative file's text (or undefined when unreadable). Self-provides
    // the FS layer so callers keep R = never. Used by finalize for drill-in extents.
    const readFileText = (directory: string, rel: string) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        return yield* fs
          .readFileStringSafe(path.join(directory, rel))
          .pipe(Effect.orElseSucceed(() => undefined as string | undefined))
      }).pipe(Effect.provide(FSUtil.defaultLayer))

    const subtreeFor = (directory: string) =>
      Effect.gen(function* () {
        const cached = subtreeCache.get(directory)
        if (cached) return cached
        const files = yield* ApertureExtract.listSubtree(directory, "").pipe(
          Effect.catch((cause) => {
            log.error("listSubtree failed", { directory, cause })
            return Effect.succeed([] as ReadonlyArray<ApertureDeterministic.SubtreeFile>)
          }),
          Effect.provide(FSUtil.defaultLayer),
        )
        subtreeCache.set(directory, files)
        return files
      })

    // Working-tree change set for the deterministic "Changed since last commit" built-in,
    // cached per directory because the TUI refetches constantly (so finalize runs often)
    // but git state only moves when files change. Dropped from the same file-event /
    // turn-completion hooks that invalidate subtreeCache below, so it rebuilds lazily.
    const gitStatusCache = new Map<string, ApertureDeterministic.GitChanged>()
    // Above this many untracked files we skip per-file line counting (they fall to churn 0 =
    // the smallest bucket). The degenerate case is a repo with no commits, which reports the
    // *whole tree* as untracked; without this bound that would fan out into one `git diff`
    // per file on every fetch. Mirrors WORKING_SET_PAINT_CAP's protection of the same case.
    const UNTRACKED_STAT_CAP = 200
    const gitChangedFor = (directory: string) =>
      Effect.gen(function* () {
        const cached = gitStatusCache.get(directory)
        if (cached) return cached
        const prefix = yield* git.prefix(directory)
        const hasHead = yield* git.hasHead(directory)
        // status = the membership set (modified/staged/untracked); stats = per-file numstat
        // churn for *tracked* changes vs HEAD (staged + unstaged). Untracked files have no
        // HEAD baseline, so numstat omits them — count their whole size via statUntracked.
        const [items, stats] = yield* Effect.all(
          [git.status(directory), hasHead ? git.stats(directory, "HEAD") : Effect.succeed([] as Git.Stat[])],
          { concurrency: 2 },
        )
        const churnByPath = new Map<string, number>()
        for (const s of stats) churnByPath.set(s.file, s.additions + s.deletions)
        const untracked = items.filter((i) => i.status === "added" && !churnByPath.has(i.file))
        if (untracked.length <= UNTRACKED_STAT_CAP)
          yield* Effect.forEach(
            untracked,
            (i) =>
              git
                .statUntracked(directory, i.file)
                .pipe(Effect.map((stat) => churnByPath.set(i.file, stat ? stat.additions + stat.deletions : 0))),
            { concurrency: 8 },
          )
        // Membership is exactly the status set (as before); attach the churn where known,
        // defaulting the rest to 0 (→ smallest bucket) so a change with no line delta — a
        // mode-only edit, or an uncounted mass-untracked file — still reads as changed.
        const changed = new Map<string, number>()
        for (const i of items) changed.set(i.file, churnByPath.get(i.file) ?? 0)
        const resolved: ApertureDeterministic.GitChanged = { prefix, changed }
        gitStatusCache.set(directory, resolved)
        return resolved
      })

    // Per-author line churn for the deterministic "Bus factor" built-in, cached per
    // directory but — unlike gitStatusCache — keyed by HEAD sha, because a full
    // `git log --numstat` is far too expensive to re-run on every TUI fetch. Authorship
    // only moves when a commit lands (HEAD moves), never on working-tree edits, so the
    // cheap `git.head` check below lets constant refetches reuse the cached pass. This is
    // why busFactorCache is NOT dropped in the refresh/file-event/idle hooks (only on
    // disposal) — those fire on edits that don't change history.
    const busFactorCache = new Map<string, { head: string | undefined; value: ApertureDeterministic.GitAuthorship }>()
    // Slim log (author + line counts only, no messages) with a generous cap; a truncated or
    // failed log soft-fails to empty authorship (all files grey) rather than biased counts.
    const BUS_FACTOR_MAX_OUTPUT = 64 * 1024 * 1024
    const EMPTY_AUTHORSHIP: ApertureDeterministic.GitAuthorship = {
      prefix: "",
      byPath: new Map<string, ReadonlyMap<string, number>>(),
    }
    const busFactorFor = (directory: string) =>
      Effect.gen(function* () {
        // Cheap HEAD read each call so constant refetches reuse the cached log until a commit
        // lands; undefined (no commits / not a repo) still keys the cache coherently.
        const rev = yield* git.run(["rev-parse", "HEAD"], { cwd: directory })
        const head = rev.exitCode === 0 ? rev.text().trim() : undefined
        const cached = busFactorCache.get(directory)
        if (cached && cached.head === head) return cached.value
        const prefix = yield* git.prefix(directory)
        const result = yield* git.run(["log", "--no-merges", "--use-mailmap", "--numstat", "--format=%x01%aN"], {
          cwd: directory,
          maxOutputBytes: BUS_FACTOR_MAX_OUTPUT,
        })
        if (result.truncated) log.warn("bus-factor git log truncated; painting empty", { directory })
        const value =
          result.exitCode !== 0 || result.truncated
            ? EMPTY_AUTHORSHIP
            : ApertureDeterministic.parseAuthorship(result.text(), prefix)
        busFactorCache.set(directory, { head, value })
        return value
      })

    // Resolve a deterministic Lens's facet store, fetching whichever pre-resolved IO its kind
    // needs (git-changed's working-tree set, bus-factor's authorship; mtime needs none) and
    // handing it to the pure computeStore. Single source of the per-kind wiring, shared by
    // finalize and facetFiles.
    const deterministicStoreFor = (
      lens: Lens,
      directory: string,
      subtree: ReadonlyArray<ApertureDeterministic.SubtreeFile>,
    ) =>
      Effect.gen(function* () {
        switch (lens.deterministic) {
          case "git-changed":
            return ApertureDeterministic.computeStore(lens.deterministic, subtree, {
              git: yield* gitChangedFor(directory),
            })
          case "bus-factor":
            return ApertureDeterministic.computeStore(lens.deterministic, subtree, {
              authorship: yield* busFactorFor(directory),
            })
          default:
            return ApertureDeterministic.computeStore(lens.deterministic!, subtree, {})
        }
      })

    // --- drill-down domain gate ---------------------------------------------

    // A Lens's facet store as seen by its children — the "witness" store. Mirrors finalize's
    // three-way branch exactly: the cheap deterministic built-ins (git-changed / mtime) are
    // computed inline, everything else is read from the persisted semantic store. Bus-factor
    // is the trap — it is deterministic but its store is *persisted* precisely because
    // computing it means a whole-history `git log` (~10s), so it must be READ here. Sending
    // it through deterministicStoreFor would fire that walk inside every paint batch.
    const witnessStoreFor = (lens: Lens, directory: string, projectID: string) =>
      Effect.gen(function* () {
        if (isDeterministic(lens) && lens.deterministic !== "bus-factor") {
          const subtree = yield* subtreeFor(directory)
          return yield* deterministicStoreFor(lens, directory, subtree)
        }
        const store = yield* ApertureSemanticStore.read(storage, projectID, lens.id)
        // A cold bus-factor store witnesses nothing, so a drill-down of it paints nothing
        // this pass (fail closed) — kick the background refresh and let the next sweep place
        // the files once it lands.
        if (lens.deterministic === "bus-factor" && Object.keys(store).length === 0)
          yield* forkProactivePaint("bus-factor refresh failed", projectID, refreshBusFactor(directory, projectID))
        return store
      })

    // Resolve a drill-down Lens's domain over `files`: which of them fall inside the parent
    // facets it is scoped to, and the parent facet ("witness") each one carries. The painter
    // then classifies only the in-domain files and buckets the rest straight into
    // NONE_FACET — that is what makes a drill-down trustworthy.
    //
    // Two rules make this correct:
    //
    //  * We read only the IMMEDIATE parent's store, never the whole ancestor chain, because
    //    a drill-down's store is itself a complete domain-restricted painting (its
    //    out-of-domain files are stored NONE_FACET, and NONE_FACET is never one of a Lens's
    //    own facets — so a file excluded by the parent can't be admitted by the child).
    //    `via` is what keeps that honest when a child is scoped to its parent's *"Other"*:
    //    it separates the parent's out-of-domain greys from its genuine "fits no facet" greys.
    //  * A file the parent hasn't placed yet is filled in HERE, by painting it under the
    //    parent Lens first (recursively — the parent may be a drill-down too). That spend is
    //    never wasted: it lands in the parent's own store and is reused forever.
    //
    // MUST NOT acquire paintGate. This runs inside a permit its caller already holds
    // (schedulePaint / backgroundLoop / scheduleExtentPaint) and Effect semaphores are not
    // reentrant — re-acquiring here would block the fiber against itself and wedge both
    // painters until the process restarts.
    const resolveDomain = (
      lens: Lens,
      directory: string,
      projectID: string,
      files: ReadonlyArray<AperturePainter.FileNode>,
      origin: AperturePainter.Origin,
      depth = 0,
    ): Effect.Effect<AperturePainter.Domain | undefined> =>
      Effect.gen(function* () {
        const scoped = lens.parent
        if (!scoped) return undefined

        const parent = yield* ApertureLensStore.get(directory, scoped.lens)
        // Orphaned (parent deleted) or a chain deeper than we allow. listAvailable already
        // hides such a Lens, so this is belt-and-braces — and it fails *closed*: an empty
        // domain paints nothing, rather than silently painting the whole repo unfiltered.
        if (!parent || depth >= MAX_LENS_DEPTH) {
          log.error("drill-down has no usable parent", { lens: lens.id, parent: scoped.lens, depth })
          return { parent: parent ?? lens, witness: new Map(), allowed: new Set() }
        }

        let store = yield* witnessStoreFor(parent, directory, projectID)
        // Fill the files the parent hasn't placed yet. Only a semantic parent can be filled;
        // a deterministic store already covers every file in the subtree by construction.
        const pending = files.filter((f) => store[f.id] === undefined)
        if (pending.length > 0 && !isDeterministic(parent)) {
          const parentDomain = yield* resolveDomain(parent, directory, projectID, pending, origin, depth + 1)
          yield* AperturePainter.paintStale(
            { storage, events, provider, config },
            directory,
            projectID,
            [""],
            // Coarse: the fill only has to place these files in the parent's domain, which
            // is a whole-file question. Any of them the child then paints finely is
            // promoted on its own account.
            pending.map((node) => ({ node })),
            origin,
            parent,
            // Silent: this writes the *parent's* store, which isn't the one being viewed, and
            // our own pass publishes a moment later anyway. `trigger` keeps the spend
            // attributable to the drill-down that forced it.
            { domain: parentDomain, publish: false, trigger: lens.id, source: "parent-fill" },
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => log.error("parent fill failed", { lens: lens.id, parent: parent.id, cause })),
            ),
          )
          store = yield* ApertureSemanticStore.read(storage, projectID, parent.id)
        }

        const subset = new Set(scoped.facets)
        const parentScope = parent.parent ? new Set(parent.parent.facets) : undefined
        const witness = new Map<string, string>()
        const allowed = new Set<string>()
        for (const file of files) {
          const entry = store[file.id]
          // Unwitnessed even after the fill (a bin soft-failed, the model omitted the path,
          // the file was unreadable). Left out of `witness` entirely so the painter skips it
          // and retries next sweep — never bucketed, which would be permanent.
          if (!entry) continue
          witness.set(file.id, entry.facet)
          if (inDomain(entry, subset, parentScope)) allowed.add(file.id)
        }
        return { parent, witness, allowed }
      })

    // Changed line ranges (in the current file) for the git-changed Lens at function
    // granularity: `git diff --unified=0 HEAD -- <file>` parsed to hunk ranges. Empty
    // for an unchanged or untracked file (the caller falls back to the file-level
    // changed result). Soft-fails to "no ranges" so a git hiccup never breaks drill-in.
    const changedRangesFor = (directory: string, relPath: string) =>
      Effect.gen(function* () {
        const result = yield* git
          .run(["diff", "--unified=0", "HEAD", "--", relPath], { cwd: directory })
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!result || result.exitCode !== 0) return [] as Array<[number, number]>
        return ApertureExtents.parseHunkRanges(result.text())
      })

    // Whether the directory is a git work tree, cached because it almost never changes
    // (only `git init`). Cleared on turn completion (an agent may have run `git init`) and
    // on disposal. Gates the git-changed built-in's availability below.
    const isRepoCache = new Map<string, boolean>()
    const isRepoFor = (directory: string) =>
      Effect.gen(function* () {
        const cached = isRepoCache.get(directory)
        if (cached !== undefined) return cached
        const repo = yield* git.isRepo(directory)
        isRepoCache.set(directory, repo)
        return repo
      })

    // A deterministic built-in can have an environmental prerequisite: git-changed needs a
    // git work tree. A Lens whose prerequisite isn't met is hidden everywhere a
    // Lens is chosen or listed (lenses()/cycle/select), so the user can never
    // land on a meaningless view — git-changed simply doesn't exist in a non-git folder.
    const isAvailable = (lens: Lens, directory: string): Effect.Effect<boolean> =>
      lens.deterministic === "git-changed" || lens.deterministic === "bus-factor"
        ? isRepoFor(directory)
        : Effect.succeed(true)

    // The active+listed Lenses minus any whose prerequisite is unmet for this directory.
    // Keeps the store's DFS-forest order, so callers get parent → children for free.
    const listAvailable = (directory: string, projectID: string) =>
      Effect.gen(function* () {
        const all = yield* ApertureLensStore.list(directory)
        const byId = new Map(all.map((l) => [l.id, l]))
        const keep: Lens[] = []
        for (const lens of all) {
          if (!(yield* isAvailable(lens, directory))) continue
          // A drill-down is only usable while its *whole* ancestor chain resolves and is
          // itself available: its domain is read out of the parent's store, so a missing or
          // unusable ancestor means no domain, which means it paints nothing at all. Hide it
          // rather than strand the user on a Lens that can only ever show a grey repo. (The
          // chain is walked with a visited set — lenses.json is hand-editable.)
          let usable = true
          let cur = lens
          const seen = new Set([lens.id])
          while (cur.parent) {
            const up = byId.get(cur.parent.lens)
            if (!up || seen.has(up.id) || !(yield* isAvailable(up, directory))) {
              usable = false
              break
            }
            seen.add(up.id)
            cur = up
          }
          if (usable) keep.push(lens)
        }
        return keep
      })

    // The active Lens, falling back to Architecture when it isn't usable here — an unmet
    // prerequisite (git-changed in a non-git folder) or a drill-down whose ancestry is
    // broken. Without this a stale active.json strands the view on a Lens that can never
    // paint, and the repo just renders grey with no explanation.
    const activeUsable = (directory: string, projectID: string) =>
      Effect.gen(function* () {
        const active = yield* ApertureLensStore.getActive(directory)
        const available = yield* listAvailable(directory, projectID)
        if (available.some((l) => l.id === active.id)) return active
        return available.find((l) => l.id === ARCHITECTURE_ID) ?? ARCHITECTURE
      })

    const off = registerDisposer(async (directory) => {
      caches.delete(directory)
      subtreeCache.delete(directory)
      gitStatusCache.delete(directory)
      busFactorCache.delete(directory)
      busFactorHead.delete(directory)
      busFactorInFlight.delete(directory)
      isRepoCache.delete(directory)
      // The loop fiber itself is interrupted when the instance scope closes
      // (forkScoped); drop the map entry so a later reopen can start a fresh one.
      bgPainters.delete(directory)
    })
    yield* Effect.addFinalizer(() => Effect.sync(off))

    // FS failures degrade to an empty payload rather than crashing the UI.
    const compute = Effect.fn("Aperture.compute")(function* (directory: string, projectID: string, scope: string) {
      const payload = yield* ApertureExtract.extract(directory, { scope }).pipe(
        Effect.catch((cause) => {
          log.error("extract failed", { projectID, scope, cause })
          return Effect.succeed(empty)
        }),
      )
      yield* storage.write(storageKey(projectID, scope), payload).pipe(Effect.ignore)
      log.info("computed", { projectID, scope, nodes: payload.nodes.length, edges: payload.edges.length })
      return payload
    }, Effect.provide(FSUtil.defaultLayer))

    // The structure cache (container.scopes + storage) stays pure: semantics are
    // merged onto a copy at the read boundary from the separate per-project store,
    // so the deterministic structure is never mutated by the async paint. Every
    // read path runs through finalize so the merge + background painting happen
    // exactly once regardless of where the structure came from (memory, disk,
    // recompute).
    const inFlight = new Set<string>()
    // Directories with an in-flight drill-in (function-level) paint. The background
    // loop checks this between batches and yields the shared permit a beat longer so
    // a user's drill-in wins over the whole-repo sweep (A5 priority approximation).
    const drillActive = new Set<string>()
    // Repo-relative files that have been function-painted, per directory. A change to
    // one re-runs the drill-in painter (onFileChanged) so its tiles stay fresh; the
    // per-extent hash scopes that repaint to the functions that actually changed.
    const drilledFiles = new Map<string, Set<string>>()

    const schedulePaint = (
      directory: string,
      projectID: string,
      scope: string,
      nodes: AperturePayload.Payload["nodes"],
      boundaries: readonly AperturePayload.Boundary[],
      lens: Lens,
    ) =>
      Effect.gen(function* () {
        // Paint in-window files *and* the one-hop boundary targets (step 6): a
        // boundary's tile is painted from its target's facet, so the target must be
        // painted even though it falls outside the current window. The store is keyed
        // by stable node id, so this paint is reused when the file is later viewed
        // in-window. stale-only dedup in the painter keeps the extra files cheap.
        // In-window files are the widest of the O3 interest heuristics: the user is looking
        // at them, so they are promoted to per-declaration granularity (subject to the
        // aperture.painter.granularity dial). Boundary targets are NOT — they are one-hop
        // references drawn as a single tile, not code in view, so they stay at the cheap
        // whole-file floor.
        const fileNodes = [
          ...nodes
            .filter((n) => n.kind === "file")
            .map((n) => ({ node: { id: n.id, path: n.path }, interested: true })),
          ...boundaries.filter((b) => b.kind === "file").map((b) => ({ node: { id: b.id, path: b.path } })),
        ]
        if (fileNodes.length === 0) return
        // Key by Lens too: a foreground pass for a freshly-switched Lens
        // must not be deduped against an in-flight pass for the previous one.
        const key = JSON.stringify([directory, scope, lens.id])
        if (inFlight.has(key)) return
        inFlight.add(key)
        // The domain gate resolves *inside* the permit (and never re-acquires it — see
        // resolveDomain), so the ancestor fill it may trigger is serialized with every other
        // painter pass rather than racing them on the API.
        yield* Effect.gen(function* () {
          const domain = yield* resolveDomain(
            lens,
            directory,
            projectID,
            fileNodes.map((t) => t.node),
            "fg",
          )
          yield* AperturePainter.paintStale(
            { storage, events, provider, config },
            directory,
            projectID,
            publishScopes(directory, scope),
            fileNodes,
            "fg",
            lens,
            { domain, source: "window" },
          )
        }).pipe(paintGate.withPermits(1), Effect.ensuring(Effect.sync(() => inFlight.delete(key))), Effect.forkDetach)
      })

    // Promote files to per-declaration granularity (O3). Forked onto the *shared*
    // single-permit gate, so the API is never hit concurrently with the background sweep.
    //
    // Callers enqueue; ONE drainer fiber per directory does the work. That is what
    // coalesces a burst — the ten `?drill=` requests the VSCode extension makes when it
    // warms ten editor tabs become one pass — and it needs no timer, because the single
    // permit already serialises everything: whatever piled up while the previous slice
    // held the permit goes out in the next one.
    const extentInFlight = new Set<string>()
    // relPath → the interest heuristic that queued it. Per file, not per drain, so a slice
    // that coalesces several triggers reports all of them: attributing a coalesced pass to
    // whichever trigger happened to start the drainer would make the per-trigger cost
    // measurements (the whole point of recording `source`) misleading.
    const extentPending = new Map<string, Map<string, string>>()
    const extentDraining = new Set<string>()

    const scheduleExtentPaint = (
      directory: string,
      projectID: string,
      relPaths: ReadonlyArray<string>,
      scope: string,
      source: string,
    ) =>
      Effect.gen(function* () {
        if (relPaths.length === 0) return
        // Remember the files so a later edit re-refreshes their tiles (onFileChanged).
        let files = drilledFiles.get(directory)
        if (!files) drilledFiles.set(directory, (files = new Set()))
        for (const rel of relPaths) files.add(rel)
        const lens = yield* activeUsable(directory, projectID)
        // Deterministic built-ins are fully computed; nothing to model-paint.
        if (isDeterministic(lens)) return
        let pending = extentPending.get(directory)
        if (!pending) extentPending.set(directory, (pending = new Map()))
        // Per-file dedup against what a slice is already painting, preserved from the
        // pre-batch scheduler.
        for (const rel of relPaths)
          if (!extentInFlight.has(JSON.stringify([directory, rel, lens.id]))) pending.set(rel, source)
        if (pending.size === 0 || extentDraining.has(directory)) return
        extentDraining.add(directory)
        yield* drainExtentPaints(directory, projectID, scope).pipe(
          Effect.catchCause((cause) => Effect.sync(() => log.error("extent drain failed", { projectID, cause }))),
          Effect.ensuring(Effect.sync(() => extentDraining.delete(directory))),
          Effect.forkDetach,
        )
      })

    const drainExtentPaints = (directory: string, projectID: string, scope: string) =>
      Effect.gen(function* () {
        while ((extentPending.get(directory)?.size ?? 0) > 0) {
          // Re-read the Lens each slice (like backgroundLoop) so switching mid-drain takes
          // effect on the next one rather than painting into the previous Lens's store.
          const lens = yield* activeUsable(directory, projectID)
          if (isDeterministic(lens)) return
          const pending = extentPending.get(directory)!
          const entries = [...pending].slice(0, EXTENT_DRAIN_BATCH)
          const slice = entries.map(([rel]) => rel)
          const source = [...new Set(entries.map(([, s]) => s))].sort().join("+")
          for (const rel of slice) pending.delete(rel)
          const keys = slice.map((rel) => JSON.stringify([directory, rel, lens.id]))
          for (const key of keys) extentInFlight.add(key)
          // Held around the PERMIT, not the whole drainer: the background sweep parks while
          // this is set, and once the interest set is wide a drainer is nearly always alive,
          // so holding it for the drainer's lifetime would starve the sweep outright. One
          // drainer per directory also means no overlapping add/delete, which is what made
          // this a race when it was a plain Set shared by concurrent per-file passes.
          drillActive.add(directory)
          yield* Effect.gen(function* () {
            // The domain gate is enforced here as well as inside the painter because a
            // file's function mix SUPERSEDES its file-level facet in directory composition
            // (extents.ts attributeFileBytes). One resolve for the whole slice: resolveDomain
            // already takes a node array, and the domain's `parent` is a property of the
            // Lens, not of a file — so this also collapses N ancestor fills into one. It
            // runs inside the permit and never re-acquires it (see resolveDomain).
            //
            // Fail closed: a file the parent hasn't placed yet isn't function-painted
            // either. Promotion therefore lags the sweep for a drill-down Lens, and catches
            // up once the parent's store covers the file.
            const nodes = slice.map((rel) => ({ id: ApertureExtract.nodeID(rel), path: rel }))
            const domain = yield* resolveDomain(lens, directory, projectID, nodes, "fg")
            const targets = (lens.parent ? nodes.filter((n) => domain?.allowed.has(n.id)) : nodes).map((node) => ({
              node,
              // `interested` is what promotes to per-declaration granularity — the whole
              // point of a drill / edit / working-set / in-window trigger.
              interested: true,
            }))
            if (targets.length === 0) return
            yield* AperturePainter.paintStale(
              { storage, events, provider, config },
              directory,
              projectID,
              publishScopes(directory, scope),
              targets,
              "fg",
              lens,
              { domain, source },
            )
          }).pipe(
            paintGate.withPermits(1),
            Effect.ensuring(
              Effect.sync(() => {
                for (const key of keys) extentInFlight.delete(key)
                drillActive.delete(directory)
              }),
            ),
          )
          // Outside the permit, so a queued foreground pass wins it between slices — the
          // same fairness pattern the background loop uses.
          if ((extentPending.get(directory)?.size ?? 0) > 0) yield* Effect.sleep(BG_BATCH_DELAY)
        }
      })

    // Every window that should refetch after a paint: the scope that triggered it plus every
    // window currently being viewed. A file at a/b/c.ts is drawn in window "a" as well as
    // "a/b" (VIEW_DEPTH is 2), so publishing only to its own parent directory silently
    // misses viewers. Mirrors the invalidation broadcasts elsewhere in this service.
    const publishScopes = (directory: string, scope: string) => [
      ...new Set([scope, ...(caches.get(directory)?.scopes.keys() ?? [])]),
    ]

    // Proactively function-paint the git working set (files with uncommitted changes) under
    // the active Lens, so their tiles are ready before the user looks — the deterministic
    // "interest" heuristic that replaces click-to-drill (clicking was only ever a proxy for
    // interest, and the working set is a better, free one). Reuses the per-file drill path
    // (scheduleExtentPaint): dedup, stale-skip, the shared gate, and drilledFiles bookkeeping
    // all apply, and switching Lens re-paints from that Lens alone. Capped (WORKING_SET_PAINT_CAP)
    // so an uncommitted repo can't turn this into a whole-repo function paint. Deterministic
    // Lenses compute their function tiles offline in finalize, so there's nothing to model-paint.
    const scheduleWorkingSetPaint = (directory: string, projectID: string) =>
      Effect.gen(function* () {
        const lens = yield* activeUsable(directory, projectID)
        if (isDeterministic(lens)) return
        // No git work tree → no working set (and git.status would error). Bail quietly.
        if (!(yield* isRepoFor(directory))) return
        const git = yield* gitChangedFor(directory)
        if (git.changed.size === 0) return
        // git reports repo-root-relative paths; the subtree is directory-relative. Bridging
        // with the repo prefix also filters the change set down to source files (the subtree's
        // only members) as the directory-relative paths scheduleExtentPaint expects.
        const subtree = yield* subtreeFor(directory)
        const workingSet = subtree.filter((f) => git.changed.has(git.prefix + f.path)).map((f) => f.path)
        if (workingSet.length === 0 || workingSet.length > WORKING_SET_PAINT_CAP) return
        yield* scheduleExtentPaint(directory, projectID, workingSet, "", "working-set")
      })

    // Re-paint every already-function-painted file under the now-active Lens. Function tiles
    // are per-(lens, extent-hash), so a freshly-selected Lens has an empty sub-facet store and
    // its drilled files would render bare until re-painted. Mirrors the file-level policy —
    // active Lens only, never a fan-out over every Lens (see aperture-a5 lens decision).
    const repaintDrilledFiles = (directory: string, projectID: string) =>
      scheduleExtentPaint(directory, projectID, [...(drilledFiles.get(directory) ?? [])], "", "lens-switch")

    // Fork a best-effort proactive paint (working-set seed / lens repaint) into the service
    // scope so it never blocks a fetch and its failure only logs; the inner per-file
    // scheduleExtentPaint calls are already detached + gated.
    const forkProactivePaint = <E>(label: string, projectID: string, eff: Effect.Effect<void, E>) =>
      eff.pipe(
        Effect.catchCause((cause) => Effect.sync(() => log.error(label, { projectID, cause }))),
        (e) => Effect.forkIn(e, serviceScope),
        Effect.asVoid,
      )

    // --- bus-factor persistence (background, HEAD-keyed) --------------------
    // Bus-factor's facets come from a whole-history `git log --numstat` — a multi-second walk
    // on a large repo. Computing it inline on every view (like the cheap git-changed/mtime
    // built-ins) meant a ~10s block each time the Lens was selected AND on every fresh process
    // (the in-memory authorship cache dies with the process, so a reopen was always a cold
    // miss). Instead we persist the *computed facet store* in the same durable semantic store
    // the painted Lenses use, and recompute it in the background only when HEAD moves. Viewing
    // the Lens is then a cheap store read; the walk happens off the view path, keyed by commit.

    // The commit the persisted bus-factor store reflects. Persisted (survives restart, so a
    // reopen at the same HEAD reuses the store instead of re-walking) with an in-memory mirror
    // to skip the storage read on the hot path. `busFactorInFlight` dedups concurrent triggers
    // (open + turn-completion + a viewer's finalize) onto a single git-log walk.
    const busFactorHead = new Map<string, string | undefined>()
    const busFactorInFlight = new Set<string>()
    const busFactorHeadKey = (projectID: string) => ["aperture", projectID, "semantics", "bus-factor:head"]

    const persistedBusFactorHead = (directory: string, projectID: string) =>
      Effect.gen(function* () {
        if (busFactorHead.has(directory)) return busFactorHead.get(directory)
        const rec = yield* storage
          .read<{ head?: string }>(busFactorHeadKey(projectID))
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
        const head = rec?.head
        busFactorHead.set(directory, head)
        return head
      })

    // Recompute the bus-factor facet store from git history and persist it (store + HEAD
    // marker), then invalidate viewed scopes so the live view refetches the filled store.
    // HEAD-gated (skips when the persisted store already reflects the current commit) and
    // deduped. Always forked, never awaited on the view path — the Lens renders whatever is
    // persisted (empty/grey on first ever, or the previous commit's facets) and fills in when
    // this completes. Bounded to a git work tree (the Lens is unavailable off-git anyway).
    const refreshBusFactor = (directory: string, projectID: string) =>
      Effect.gen(function* () {
        if (!(yield* isRepoFor(directory))) return
        const rev = yield* git.run(["rev-parse", "HEAD"], { cwd: directory })
        const head = rev.exitCode === 0 ? rev.text().trim() : undefined
        if ((yield* persistedBusFactorHead(directory, projectID)) === head) return
        if (busFactorInFlight.has(directory)) return
        busFactorInFlight.add(directory)
        yield* Effect.gen(function* () {
          const subtree = yield* subtreeFor(directory)
          // Reuse the pure deterministic wiring: this resolves authorship (the expensive
          // git-log, HEAD-cached in busFactorCache) and buckets every file by author count.
          const store = yield* deterministicStoreFor(BUS_FACTOR, directory, subtree)
          yield* ApertureSemanticStore.replace(storage, projectID, BUS_FACTOR_ID, store)
          yield* storage.write(busFactorHeadKey(projectID), { head }).pipe(Effect.ignore)
          busFactorHead.set(directory, head)
          const container = caches.get(directory)
          for (const scope of container?.scopes.keys() ?? [])
            yield* events
              .publish(
                ApertureEvent.Event.Invalidated,
                { scope },
                { location: { directory: AbsolutePath.make(directory) } },
              )
              .pipe(Effect.ignore)
        }).pipe(Effect.ensuring(Effect.sync(() => busFactorInFlight.delete(directory))))
      })

    // --- function-mix backfill (background, once per Lens) -------------------
    // A file's mix is measured by the drill-in painter, so a file function-painted before
    // mixes existed — or in a previous process, since the painter only revisits files the
    // user touches — has facets in the sub-facet store but no mix, and its directory would
    // keep showing the superseded file-level facet until it happened to be repainted. The
    // sub-facet store is keyed by a path+name *hash*, so there's no way to ask it which
    // files it covers: the only way to find them is to re-derive each file's extent ids and
    // look them up. That means reading the subtree once — far too much I/O for the read
    // path (composition runs on every payload read), but fine as a one-shot background pass:
    // it's pure I/O and regex, no model, no tokens. Skipped entirely when the Lens has no
    // function paints at all, which is the common case.
    const mixBackfilled = new Set<string>()
    const backfillMixes = (directory: string, projectID: string, lens: Lens) =>
      Effect.gen(function* () {
        const key = JSON.stringify([directory, lens.id])
        if (mixBackfilled.has(key)) return
        mixBackfilled.add(key)
        const subStore = yield* ApertureSubfacetStore.read(storage, projectID, lens.id)
        if (Object.keys(subStore).length === 0) return
        const mixes = yield* ApertureSubfacetStore.readMixes(storage, projectID, lens.id)
        const subtree = yield* subtreeFor(directory)
        // Derive every missing mix first, then write them all in one locked update — a
        // per-file write would take the storage write lock once per subtree file.
        const derived: ApertureSubfacetStore.Mixes = {}
        for (const file of subtree) {
          if (mixes[file.path]) continue
          const content = yield* readFileText(directory, file.path)
          if (content === undefined) continue
          const facetByName = new Map<string, string>()
          for (const extent of ApertureExtents.extentsOf(content)) {
            const entry = subStore[ApertureExtents.subNodeID(file.path, extent.name)]
            if (entry) facetByName.set(extent.name, entry.facet)
          }
          if (facetByName.size === 0) continue
          derived[file.path] = ApertureExtents.fileComposition(content, facetByName)
        }
        const written = yield* ApertureSubfacetStore.upsertMixes(storage, projectID, lens.id, derived)
        if (written.length === 0) return
        log.info("backfilled function mixes", { projectID, lens: lens.id, files: written.length })
        const container = caches.get(directory)
        for (const viewed of container?.scopes.keys() ?? [])
          yield* events
            .publish(
              ApertureEvent.Event.Invalidated,
              { scope: viewed },
              { location: { directory: AbsolutePath.make(directory) } },
            )
            .pipe(Effect.ignore)
      })

    const finalize = (ctx: InstanceContext, scope: string, structure: AperturePayload.Payload, drillFile?: string) =>
      Effect.gen(function* () {
        // Paint with the *active* Lens: its facet store, its legend (facet → colour),
        // and its name travel out on the payload so the renderer needs no hard-coded
        // vocabulary. Switching Lenses re-paints from that Lens's own
        // (cached) store — no other Lens's work is touched.
        const lens = yield* activeUsable(ctx.directory, ctx.project.id)
        // Whole-repo membership (full depth), needed both for directory composition and —
        // for the deterministic built-ins — as the file set whose facets we synthesize.
        const subtree = yield* subtreeFor(ctx.directory)
        // Deterministic built-ins (git-changed / mtime-buckets) compute their facets from the
        // repo instead of reading the persisted store: no painter, no tokens, always fresh.
        const det = isDeterministic(lens)
        // Bus-factor is deterministic but *expensive* (a whole-history git log), so unlike the
        // cheap git-changed/mtime built-ins it isn't computed inline here — its facets are
        // persisted in the semantic store (like a painted Lens) and refreshed in the background
        // keyed by HEAD (refreshBusFactor). Reading it is a cheap store read; the fork below
        // fills it on first ever view and self-heals a stale store, non-blocking.
        const busFactor = lens.deterministic === "bus-factor"
        const store =
          det && !busFactor
            ? yield* deterministicStoreFor(lens, ctx.directory, subtree)
            : yield* ApertureSemanticStore.read(storage, ctx.project.id, lens.id)
        if (busFactor)
          yield* forkProactivePaint(
            "bus-factor refresh failed",
            ctx.project.id,
            refreshBusFactor(ctx.directory, ctx.project.id),
          )
        const colorByFacet = new Map(lens.facets.map((t) => [t.id, t.color]))
        const semantics: Record<string, AperturePayload.Semantic> = {}
        // The store holds only the semantic (facet); hue/facets are derived here, so
        // palette/vocabulary changes apply without a re-paint. Boundaries (step 6) are
        // painted from the same store so an out-of-window tile shows its target's hue
        // once that target has been painted.
        const applySemantic = (id: string) => {
          const entry = store[id]
          if (entry)
            semantics[id] = {
              facets: [entry.facet],
              hue: entry.facet === NONE_FACET ? NONE_HUE : colorByFacet.get(entry.facet),
            }
        }
        for (const node of structure.nodes) applySemantic(node.id)
        for (const boundary of structure.boundaries ?? []) applySemantic(boundary.id)
        // Paint each in-window directory as its subtree's facet composition: bucket every
        // descendant source file (full depth, from the cached membership) by its painted
        // facet, summing both a file count and a byte sum so the renderer can pick either
        // metric. Derived here alongside `semantics` so the structure cache stays pure.
        //
        // A file that has been function-painted is bucketed by the *mix* of its function
        // facets instead (the drill-in painter measures and persists it): those facets were
        // assigned with the code in view, so they supersede the file-level one the coarse
        // painter guessed from the path — otherwise a directory keeps showing the coarse
        // tags long after its files have been refined. Deterministic Lenses carry no
        // sub-facet store (git-changed derives its function tiles offline from the diff,
        // and its file-level facet already describes the whole file's heat), so they keep
        // the plain file-level attribution.
        const mixes = det ? {} : yield* ApertureSubfacetStore.readMixes(storage, ctx.project.id, lens.id)
        const composition = computeComposition(structure.nodes, subtree, store, mixes, lens)
        // Fill in the mixes of files function-painted before this ran (see backfillMixes):
        // forked, so the view renders from what's persisted now and re-merges when it lands.
        if (!det)
          yield* forkProactivePaint(
            "mix backfill failed",
            ctx.project.id,
            backfillMixes(ctx.directory, ctx.project.id, lens),
          )
        // Deterministic Lenses are fully painted above; only semantic ones schedule
        // the foreground painter for the in-window files + boundary targets.
        if (!det)
          yield* schedulePaint(ctx.directory, ctx.project.id, scope, structure.nodes, structure.boundaries ?? [], lens)
        const lensInfo: AperturePayload.LensInfo = {
          id: lens.id,
          name: lens.name,
          legend: lensLegend(lens),
          // Signals a deterministic built-in (git/mtime, no painter) so a client can
          // suppress editor-gutter painting for it — see LensInfo in payload.ts.
          ...(det ? { deterministic: true } : {}),
        }
        // Drill-in (A5): attach function-level tiles for every file that has been
        // drilled in this directory AND is in the current window — not just the file the
        // user just clicked. Once a file is function-painted it keeps its measured band
        // as the user drills siblings or navigates away and back (the paint persists in
        // the per-function store; it supersedes the single file-level hue). Without this,
        // only the actively-drilled file carried extents, so every other tile snapped
        // back to file-level paint on the next click / refetch. Semantic Lenses colour
        // tiles from that store (unpainted stay grey until the scheduled drill paint fills
        // them in); the git-changed built-in colours them deterministically from `git
        // diff` hunks; mtime-recency can't subdivide a file, so it carries no extents.
        const supportsExtents = !det || lens.deterministic === "git-changed"
        let extents: Record<string, ReadonlyArray<AperturePayload.Extent>> | undefined
        if (supportsExtents) {
          // In-window file nodes by path; a drilled file that's off-window is skipped
          // (its tiles would render on no tile).
          const idByPath = new Map<string, string>()
          for (const n of structure.nodes) if (n.kind === "file") idByPath.set(n.path, n.id)
          const targets = new Set<string>()
          for (const f of drilledFiles.get(ctx.directory) ?? []) if (idByPath.has(f)) targets.add(f)
          // The freshly-clicked file is already in drilledFiles (the drill path adds it
          // before finalize), but include it defensively against ordering changes.
          if (drillFile && idByPath.has(drillFile)) targets.add(drillFile)
          if (targets.size) {
            // Semantic Lenses read the per-function store once for all targets.
            const subStore = det ? undefined : yield* ApertureSubfacetStore.read(storage, ctx.project.id, lens.id)
            const built: Record<string, ReadonlyArray<AperturePayload.Extent>> = {}
            for (const file of targets) {
              const fileId = idByPath.get(file)!
              const content = yield* readFileText(ctx.directory, file)
              if (content === undefined) continue
              // Cut at the granularity the STORE reflects, or no extent name would match:
              // a file the painter cut coarsely has one entry keyed WHOLE, not one per
              // declaration. The mix records which (more than one extent ⇒ finely cut) —
              // the same high-water rule the painter applies. Deterministic Lenses carry no
              // mix and derive their tiles from the diff, so they always cut per declaration.
              const granularity: ApertureExtents.Granularity =
                det || (mixes[file]?.subtreeCount ?? 0) > 1 ? "declaration" : "file"
              const exs = ApertureExtents.extentsOf(content, granularity)
              // name → facet id for this file's extents.
              let facetByName: Map<string, string>
              if (det) {
                // git-changed: overlap each extent with the diff's changed line ranges,
                // falling back to the file-level result for an untracked file. A changed
                // function inherits the file's magnitude bucket (so the whole file tiles at
                // one heat level); unchanged functions stay muted.
                const ranges = yield* changedRangesFor(ctx.directory, file)
                const fileFacet = store[fileId]?.facet ?? "unchanged"
                const fileChanged = fileFacet !== "unchanged"
                facetByName = ApertureExtents.extentChangeFacets(content, ranges, fileChanged, {
                  changed: fileFacet,
                  unchanged: "unchanged",
                })
              } else if (lens.parent && store[fileId]?.facet === NONE_FACET) {
                // Out of a drill-down's domain: the file is greyed at file level and the gate
                // refuses to function-paint it, so paint its tiles the same "Other" grey
                // rather than leaving them the *unpainted* grey — which would read as "not
                // swept yet" and invite the user to wait for a paint that will never come.
                facetByName = new Map(exs.map((e) => [e.name, NONE_FACET]))
              } else {
                facetByName = new Map()
                for (const e of exs) {
                  const entry = subStore![ApertureExtents.subNodeID(file, e.name)]
                  if (entry) facetByName.set(e.name, entry.facet)
                }
              }
              built[fileId] = exs.map((e): AperturePayload.Extent => {
                const facet = facetByName.get(e.name)
                const hue = facet ? (facet === NONE_FACET ? NONE_HUE : colorByFacet.get(facet)) : undefined
                return {
                  name: e.name,
                  startLine: e.startLine,
                  endLine: e.endLine,
                  ...(facet ? { facet } : {}),
                  ...(hue ? { hue } : {}),
                }
              })
            }
            if (Object.keys(built).length) extents = built
          }
        }
        return { ...structure, semantics, composition, lens: lensInfo, ...(extents ? { extents } : {}) }
      })

    // Background whole-repo painter (vs. the per-scope window of get/refresh). One
    // self-rescheduling loop per directory walks every source file in DFS order
    // (so directories light up from the root outward), painting BG_BATCH files per
    // step under the shared gate with a pause between steps. When a full pass is
    // done it parks until a file change / turn completion wakes it, then re-walks —
    // picking up created/deleted files. The stale-hash skip in the painter makes
    // every re-walk cheap (unchanged files spend nothing). forkScoped binds the loop
    // to the instance scope so it dies with the TUI; the bgPainters map dedups starts
    // and the dropping(1) wake queue coalesces a burst of changes into one rescan.
    const bgPainters = new Map<string, { readonly wake: Queue.Queue<void> }>()
    // Per-directory counter bumped whenever the active Lens changes
    // (onLensChanged). The bg loop snapshots it at pass start and abandons an
    // in-flight sweep when it changes, so a freshly-selected Lens starts filling
    // in immediately instead of waiting for the previous Lens's sweep to finish.
    const lensEpoch = new Map<string, number>()

    const backgroundLoop = (directory: string, projectID: string, wake: Queue.Queue<void>) =>
      Effect.gen(function* () {
        while (true) {
          // Re-read the active Lens each pass so a switch (which wakes this loop)
          // re-walks the repo painting for the *new* Lens; cached entries make a
          // re-walk of an already-painted Lens free.
          const lens = yield* activeUsable(directory, projectID)
          // Deterministic built-ins are painted synchronously in finalize — there's nothing
          // for the whole-repo sweep to do. Park until a Lens switch (or file change)
          // wakes us; the next pass re-reads the active Lens and resumes the sweep if
          // it's switched back to a semantic one.
          if (isDeterministic(lens)) {
            yield* Queue.take(wake)
            continue
          }
          const epoch = lensEpoch.get(directory) ?? 0
          const files = yield* ApertureExtract.listFilesDfs(directory).pipe(
            Effect.catchCause((cause) => {
              log.error("background enumerate failed", { projectID, cause })
              return Effect.succeed<ReadonlyArray<{ id: string; path: string }>>([])
            }),
            Effect.provide(FSUtil.defaultLayer),
          )
          // Front-load the Lens's relevant directories (if any): paint files under
          // them first, in their existing DFS order, then the rest of the repo. The
          // sweep still covers everything; this only changes the order so the targeted
          // area lights up first. Already-painted files in the tail are stale-skipped.
          const ordered = orderByDirectories(files, lens.directories)
          // Always-written diagnostic so a bg loop that produces no request lines is
          // still visible in the perf log (distinguishes "loop never ran" from
          // "ran but every slice was already painted / no model").
          yield* AperturePainter.appendPerfEvent(directory, "bg", "pass-start", {
            files: ordered.length,
            lens: lens.id,
          })
          let interrupted = false
          for (let cursor = 0; cursor < ordered.length; cursor += BG_BATCH) {
            const slice = ordered.slice(cursor, cursor + BG_BATCH)
            // scope "" — the facet store is keyed by stable node id, so a file painted
            // here is reused in every window it later appears in. The permit is held
            // only for the batch; the pause below runs without it so foreground wins.
            yield* Effect.gen(function* () {
              // Resolved inside the permit; it may fill unpainted ancestors for a drill-down
              // (never re-acquiring the gate — see resolveDomain).
              const domain = yield* resolveDomain(lens, directory, projectID, slice, "bg")
              yield* AperturePainter.paintStale(
                { storage, events, provider, config },
                directory,
                projectID,
                [""],
                // The sweep is the coarse FLOOR: one whole-file extent each, which costs
                // exactly what file-level painting cost. Files the interest heuristics have
                // already promoted keep their per-declaration cut (granularityOf), so a
                // re-walk never coarsens them back.
                slice.map((node) => ({ node })),
                "bg",
                lens,
                { domain, source: "sweep" },
              )
            }).pipe(
              paintGate.withPermits(1),
              Effect.catchCause((cause) =>
                Effect.sync(() => log.error("background batch failed", { projectID, cause })),
              ),
            )
            yield* Effect.sleep(BG_BATCH_DELAY)
            // Hold off (permit released) while a drill-in paint is in flight for this
            // directory, so the user's function-level request takes the permit first.
            while (drillActive.has(directory)) yield* Effect.sleep(BG_BATCH_DELAY)
            // Abandon the rest of this sweep when the active Lens changed under
            // us, so the new Lens takes over without finishing the old one.
            if ((lensEpoch.get(directory) ?? 0) !== epoch) {
              interrupted = true
              break
            }
          }
          // On interruption, drain the switch's own wake signal and re-loop immediately
          // (the next pass re-reads the now-active Lens). Otherwise park until a
          // file change / turn completion / Lens switch wakes us.
          if (interrupted) yield* Queue.poll(wake)
          else yield* Queue.take(wake)
        }
      })

    const startBackgroundPainter = (directory: string, projectID: string) =>
      Effect.gen(function* () {
        if (bgPainters.has(directory)) return
        const wake = yield* Queue.dropping<void>(1)
        bgPainters.set(directory, { wake })
        yield* backgroundLoop(directory, projectID, wake).pipe(
          Effect.catchCause((cause) => Effect.sync(() => log.error("background loop crashed", { projectID, cause }))),
          (loop) => Effect.forkIn(loop, serviceScope),
        )
        // Seed the working-set function paint once per open, so files with pre-existing
        // uncommitted changes light up at function granularity without a manual drill.
        // Forked so its git status / subtree IO never delays the first fetch.
        yield* forkProactivePaint("working-set seed failed", projectID, scheduleWorkingSetPaint(directory, projectID))
        // Warm the bus-factor store on open (HEAD-gated + deduped): its whole-history git-log
        // walk is too slow to run inline when the Lens is selected, so we compute it here and on
        // every HEAD change, and the view just reads the persisted store. Covers commits made
        // while the process was closed (the persisted marker won't match the current HEAD).
        yield* forkProactivePaint("bus-factor refresh failed", projectID, refreshBusFactor(directory, projectID))
      })

    // Nudge a parked background loop to re-enumerate and re-walk. dropping(1) makes a
    // burst of file events / repeated turn completions coalesce into a single rescan.
    const wakeBackground = (directory: string) =>
      Effect.gen(function* () {
        const entry = bgPainters.get(directory)
        if (!entry) return
        yield* Queue.offer(entry.wake, void 0).pipe(Effect.ignore)
      })

    // The deterministic structure for `norm`: served from memory, then the durable
    // cache (when fresh), else recomputed. Shared by load/drill so both run the same
    // cache logic before finalize merges semantics/composition/extents.
    const structureFor = (ctx: InstanceContext, norm: string) =>
      Effect.gen(function* () {
        const container = containerFor(ctx.directory, ctx.project.id)
        if (!container.dirty.has(norm)) {
          const inMemory = container.scopes.get(norm)
          if (inMemory) return inMemory
          const cached = yield* storage
            .read<AperturePayload.Payload>(storageKey(ctx.project.id, norm))
            .pipe(Effect.catch(() => Effect.void))
          if (cached && cached.version === AperturePayload.PAYLOAD_VERSION) {
            container.scopes.set(norm, cached)
            return cached
          }
        }
        const payload = yield* compute(ctx.directory, ctx.project.id, norm)
        container.scopes.set(norm, payload)
        container.dirty.delete(norm)
        return payload
      })

    const load = Effect.fn("Aperture.load")(function* (scope?: string) {
      const ctx = yield* InstanceState.context
      // On open (first get for this directory) start the background whole-repo painter
      // so semantics fill in past the initially-viewed window without the user having
      // to navigate. Idempotent per directory; file changes / turn completion wake it
      // to re-walk (the subscriptions below).
      yield* startBackgroundPainter(ctx.directory, ctx.project.id)
      const norm = ApertureExtract.normalizeScope(scope ?? "")
      const structure = yield* structureFor(ctx, norm)
      return yield* finalize(ctx, norm, structure)
    })

    const drill = Effect.fn("Aperture.drill")(function* (file: string, scope?: string) {
      const ctx = yield* InstanceState.context
      yield* startBackgroundPainter(ctx.directory, ctx.project.id)
      const norm = ApertureExtract.normalizeScope(scope ?? "")
      // The file is a repo-relative path; normalizeScope trims stray slashes.
      const rel = ApertureExtract.normalizeScope(file)
      const structure = yield* structureFor(ctx, norm)
      // Kick the drill-in paint pass (top priority) so not-yet-painted functions fill
      // in, then return the window payload with the file's current tiles attached. The
      // paint completion invalidates `norm` (the viewed scope) so the band live-fills.
      yield* scheduleExtentPaint(ctx.directory, ctx.project.id, [rel], norm, "drill")
      return yield* finalize(ctx, norm, structure, rel)
    })

    const refresh = Effect.fn("Aperture.refresh")(function* (scope?: string) {
      const ctx = yield* InstanceState.context
      const container = containerFor(ctx.directory, ctx.project.id)
      // The TUI fetches with refresh=true, so this — not load — is the path that
      // actually runs on open; start the background painter here too (idempotent per
      // directory) or it would never kick off.
      yield* startBackgroundPainter(ctx.directory, ctx.project.id)
      const norm = ApertureExtract.normalizeScope(scope ?? "")
      // A view painted from live repo state (see dependsOnDeterministic) reads that state via
      // subtreeCache / gitStatusCache. Those caches otherwise only drop on a file event or turn
      // completion, so a change that fires neither — a manual IDE edit, or a `git commit` in the
      // user's own terminal (the watcher reports only .git/HEAD, which a commit doesn't touch) —
      // stays stale until the next turn. refresh is the path every TUI fetch takes (the turn-end
      // refetch, the manual ⟳, and the periodic poll), so dropping the inputs here recomputes
      // them fresh on each. The whole-repo walk + git status are cheap.
      //
      // Resolved from ONE `list` rather than getActive + list: both read lenses.json off disk
      // uncached, and this runs on every fetch. An unresolvable active id is left alone
      // deliberately — getActive would fall back to architecture, which isn't deterministic and
      // so wouldn't drop the caches either.
      const activeId = yield* ApertureLensStore.getActiveId(ctx.directory)
      const all = yield* ApertureLensStore.list(ctx.directory)
      const active = all.find((l) => l.id === activeId)
      if (active && dependsOnDeterministic(active, new Map(all.map((l) => [l.id, l])))) {
        subtreeCache.delete(ctx.directory)
        gitStatusCache.delete(ctx.directory)
      }
      const payload = yield* compute(ctx.directory, ctx.project.id, norm)
      container.scopes.set(norm, payload)
      container.dirty.delete(norm)
      return yield* finalize(ctx, norm, payload)
    })

    // A changed file marks every cached scope whose visible window contains it as
    // dirty, and (for scopes actually cached, i.e. being viewed) publishes an
    // invalidation routed to the originating instance so the TUI refetches.
    const onFileChanged = (absFile: string, location: EventV2.Payload["location"]) =>
      Effect.gen(function* () {
        const directory = location?.directory
        if (!directory) return
        const container = caches.get(directory)
        if (!container) return
        const rel = toRepoRelative(directory, absFile)
        if (rel === undefined) return
        // A changed file may have a new size or be new/removed, so the cached subtree
        // membership (and thus composition) is stale — rebuild it on the next read. The
        // git change set is likewise stale (the edit may have changed what's modified).
        subtreeCache.delete(directory)
        gitStatusCache.delete(directory)
        for (const scope of container.scopes.keys()) {
          if (!isWithinWindow(scope, rel)) continue
          container.dirty.add(scope)
          yield* events
            .publish(ApertureEvent.Event.Invalidated, { scope }, location ? { location } : undefined)
            .pipe(Effect.ignore)
        }
        // Wake the background painter so the change is (re)painted even when it falls
        // outside every viewed window — the stale-hash skip keeps the re-walk cheap.
        yield* wakeBackground(directory)
        // A changed *source* file is, by definition, part of the working set, so proactively
        // (re)paint its function tiles — the deterministic interest heuristic keeps the slice
        // fresh with no manual drill. Already-painted files repaint too (the per-extent content
        // hash scopes the model calls to the functions that actually changed — a diff-shaped
        // repaint); a non-source file has no extents to paint, and only files already drilled
        // fall through to keep their tiles current. Invalidate the file's own directory window;
        // viewers of it refetch and re-merge.
        if (isPaintableSource(rel) || drilledFiles.get(directory)?.has(rel))
          yield* scheduleExtentPaint(directory, container.projectID, [rel], parentScope(rel), "file-changed")
      })

    yield* Effect.forkScoped(
      events
        .subscribe(Watcher.Event.Updated)
        .pipe(Stream.runForEach((event) => onFileChanged(event.data.file, event.location))),
    )
    yield* Effect.forkScoped(
      events
        .subscribe(FileSystem.Event.Edited)
        .pipe(Stream.runForEach((event) => onFileChanged(event.data.file, event.location))),
    )

    // Turn completion: when a session goes idle (the agent returned from a building
    // turn) wake the background painter so files created/changed during the turn get
    // painted. Gated on an existing cache so we only touch repos whose graph is open —
    // an unopened project stays inert, matching the lazy-cache philosophy.
    const onSessionIdle = (location: EventV2.Payload["location"]) =>
      Effect.gen(function* () {
        const directory = location?.directory
        if (!directory) return
        const container = caches.get(directory)
        if (!container) return
        // Shell commands (rm/mv/scaffolding) mutate the tree without file events, so a
        // completed turn may have changed the file set — drop membership to rebuild it.
        // A turn may also have staged/committed/edited files, so the git set is stale too,
        // and a `git init` during the turn can flip the repo gate — drop both.
        subtreeCache.delete(directory)
        gitStatusCache.delete(directory)
        isRepoCache.delete(directory)
        yield* wakeBackground(directory)
        // A turn may have changed the working set via shell ops that fire no file event
        // (mv/rm/scaffolding, git add/commit); with the git cache dropped above, re-seed the
        // working-set function paint so the current changed slice stays covered.
        yield* forkProactivePaint(
          "working-set seed failed",
          container.projectID,
          scheduleWorkingSetPaint(directory, container.projectID),
        )
        // A turn may have committed (HEAD moved) — recompute the bus-factor store in the
        // background so the next view is a cheap read rather than a ~10s walk, even when it
        // isn't the active Lens. HEAD-gated, so a turn that didn't commit costs only a rev-parse.
        yield* forkProactivePaint(
          "bus-factor refresh failed",
          container.projectID,
          refreshBusFactor(directory, container.projectID),
        )
      })
    yield* Effect.forkScoped(
      events
        .subscribe(SessionStatus.Event.Status)
        .pipe(
          Stream.runForEach((event) =>
            event.data.status.type === "idle" ? onSessionIdle(event.location) : Effect.void,
          ),
        ),
    )

    // Re-paint every viewed scope after the active Lens changes: mark each
    // cached scope dirty so the next get re-runs finalize with the new Lens, and
    // publish an invalidation so the live view refetches. The bg painter is woken so the
    // new Lens also fills in beyond the viewed window.
    const onLensChanged = (directory: string) =>
      Effect.gen(function* () {
        const container = caches.get(directory)
        if (container) {
          for (const scope of container.scopes.keys()) {
            container.dirty.add(scope)
            // Attach the location: this runs in a forked fiber with no ambient
            // Location.Service, so without it the HTTP /event SSE filter drops the
            // event and the VSCode extension never refetches the freshly-switched Lens.
            yield* events
              .publish(
                ApertureEvent.Event.Invalidated,
                { scope },
                { location: { directory: AbsolutePath.make(directory) } },
              )
              .pipe(Effect.ignore)
          }
          // Function tiles are per-(lens, extent-hash), so the freshly-selected Lens has an
          // empty sub-facet store. Two forked passes fill it (both stale-skipped, deduped, and
          // gated), mirroring the file-level sweep's per-active-Lens repaint (cached per
          // (lens, hash), so flipping back is free):
          //   - repaintDrilledFiles: everything already function-painted (open VSCode tabs the
          //     client warmed, manually drilled files, working set seen under a prior Lens);
          //   - scheduleWorkingSetPaint: the current git working set, which catches files never
          //     yet in drilledFiles — e.g. pre-existing changes when the prior Lens was
          //     deterministic (so its seed was skipped). Overlap is deduped in scheduleExtentPaint.
          const projectID = container.projectID
          yield* forkProactivePaint(
            "lens repaint failed",
            projectID,
            Effect.gen(function* () {
              yield* repaintDrilledFiles(directory, projectID)
              yield* scheduleWorkingSetPaint(directory, projectID)
            }),
          )
        }
        // Bump the epoch so an in-flight background sweep abandons the old Lens
        // and restarts for the new one (the wake below re-runs the parked loop).
        lensEpoch.set(directory, (lensEpoch.get(directory) ?? 0) + 1)
        yield* wakeBackground(directory)
      })

    const lenses = Effect.fn("Aperture.lenses")(function* () {
      const ctx = yield* InstanceState.context
      // Hide deterministic built-ins whose prerequisite is unmet (git-changed off-git).
      return yield* listAvailable(ctx.directory, ctx.project.id)
    })

    const activeLens = Effect.fn("Aperture.activeLens")(function* () {
      const ctx = yield* InstanceState.context
      return yield* activeUsable(ctx.directory, ctx.project.id)
    })

    const createLens = Effect.fn("Aperture.createLens")(function* (input: CreateLensInput) {
      const ctx = yield* InstanceState.context

      // Resolve the drill-down scope, if any, into ids. Everything here fails *loudly*: a
      // drill-down whose scope silently mis-resolved would paint the wrong domain, which is
      // exactly the confusion the feature exists to remove.
      let parent: LensParent | undefined
      if (input.parent) {
        const available = yield* listAvailable(ctx.directory, ctx.project.id)
        const target = resolveLens(available, input.parent.lens)
        if (!target) return { status: "unknown-parent", parent: input.parent.lens } as const
        const depth = orderForest(available).find((e) => e.lens.id === target.id)?.depth ?? 0
        if (depth + 1 > MAX_LENS_DEPTH) return { status: "too-deep", max: MAX_LENS_DEPTH } as const
        const facets: string[] = []
        const unknown: string[] = []
        for (const ref of input.parent.facets) {
          // "Other" is a legitimate thing to drill into ("what did my Lens miss?"), and it
          // is a real stored facet — but it is never in lens.facets, so match it by hand.
          const id =
            ref === NONE_FACET || ref.toLowerCase() === NONE_LABEL.toLowerCase()
              ? NONE_FACET
              : target.facets.find((f) => f.id === ref || f.label.toLowerCase() === ref.toLowerCase())?.id
          if (!id) unknown.push(ref)
          else if (!facets.includes(id)) facets.push(id)
        }
        if (unknown.length) return { status: "unknown-facet", facets: unknown } as const
        if (facets.length === 0) return { status: "empty-scope" } as const
        parent = { lens: target.id, facets }
      }

      const lens = yield* ApertureLensStore.create(ctx.directory, { ...input, parent })
      // Default: activate the new Lens (switch the view, start the painter on
      // it). When activate is false the Lens is only persisted — the active
      // Lens and its in-flight sweep are left untouched, so the user's current
      // view is undisturbed (the new one paints later if/when it is selected).
      if (input.activate !== false) {
        yield* ApertureLensStore.setActive(ctx.directory, lens.id)
        yield* onLensChanged(ctx.directory)
      }
      return { status: "ok", lens } as const
    })

    const selectLens = Effect.fn("Aperture.selectLens")(function* (idOrName: string) {
      const ctx = yield* InstanceState.context
      // Resolve only against *available* Lenses so an unavailable built-in (e.g.
      // git-changed in a non-git folder) reports as unknown rather than activating a
      // Lens that can't paint anything meaningful.
      const all = yield* listAvailable(ctx.directory, ctx.project.id)
      const needle = idOrName.toLowerCase()
      const found = all.find((c) => c.id === idOrName || c.name.toLowerCase() === needle)
      if (!found) return undefined
      yield* ApertureLensStore.setActive(ctx.directory, found.id)
      yield* onLensChanged(ctx.directory)
      return found
    })

    const cycleLens = Effect.fn("Aperture.cycleLens")(function* (direction: "next" | "prev") {
      const ctx = yield* InstanceState.context
      // Cycle only through available Lenses so the arrows skip a hidden built-in
      // (e.g. git-changed in a non-git folder) instead of landing the user on it.
      const all = yield* listAvailable(ctx.directory, ctx.project.id)
      const activeId = yield* ApertureLensStore.getActiveId(ctx.directory)
      const idx = all.findIndex((c) => c.id === activeId)
      const len = all.length
      // Wrap at both ends so the arrows loop through the list rather than stopping.
      // An unresolved active id (-1) starts from the head so a click still moves.
      const base = idx === -1 ? 0 : idx
      const next = all[(base + (direction === "next" ? 1 : len - 1)) % len]!
      yield* ApertureLensStore.setActive(ctx.directory, next.id)
      yield* onLensChanged(ctx.directory)
      return { id: next.id, name: next.name, legend: lensLegend(next) }
    })

    // Resolve a Lens by id or (case-insensitive) name. Used by edit/merge/delete
    // to find the target and refuse the immutable built-ins.
    const resolveLens = (all: ReadonlyArray<Lens>, idOrName: string) => {
      const needle = idOrName.toLowerCase()
      return all.find((c) => c.id === idOrName || c.name.toLowerCase() === needle)
    }

    const editLens = Effect.fn("Aperture.editLens")(function* (input: EditLensInput) {
      const ctx = yield* InstanceState.context
      const all = yield* ApertureLensStore.list(ctx.directory)
      const found = resolveLens(all, input.lens)
      if (!found) return { status: "not-found" } as const
      if (isBuiltinLens(found)) return { status: "builtin" } as const

      // Refuse to drop a facet a drill-down is scoped to: its domain would name a facet that
      // no longer exists, and it would quietly paint nothing forever. Merging the facet away
      // is the supported path (mergeFacets re-scopes its children onto the survivor); this
      // just names the dependents so they can be deleted or re-scoped first.
      const children = yield* ApertureLensStore.childrenOf(ctx.directory, found.id)
      if (input.facets && children.length) {
        // Mirror resolveFacets' id-carrying rule: a facet survives when the edit names its
        // id, or names its label (case-insensitively).
        const surviving = new Set<string>()
        for (const raw of input.facets) {
          const carried =
            (raw.id && found.facets.find((f) => f.id === raw.id)?.id) ??
            found.facets.find((f) => f.label.toLowerCase() === raw.label.toLowerCase())?.id
          if (carried) surviving.add(carried)
        }
        for (const child of children) {
          // A scope on NONE_FACET ("Other") survives any edit — it isn't one of the Lens's
          // own facets, so it can't be edited away.
          const lost = child.parent!.facets.find((f) => f !== NONE_FACET && !surviving.has(f))
          if (!lost) continue
          const dependents = children.filter((c) => c.parent!.facets.includes(lost)).map((c) => c.name)
          return { status: "facet-in-use", facet: lost, lenses: dependents } as const
        }
      }

      const result = yield* ApertureLensStore.update(ctx.directory, found.id, {
        name: input.name,
        description: input.description,
        palette: input.palette,
        prompt: input.prompt,
        facets: input.facets,
        directories: input.directories,
        context: input.context,
      })
      if (!result) return { status: "not-found" } as const
      // Structural edits invalidate the inferred facets — clear them so the sweep
      // re-paints from scratch. Cosmetic edits keep the facets and just re-paint.
      if (result.structural) {
        yield* ApertureSemanticStore.clear(storage, ctx.project.id, found.id)
        yield* ApertureSubfacetStore.clear(storage, ctx.project.id, found.id)
        // Every drill-down beneath it was placed by facts that no longer hold — its files
        // were bucketed in or out by a classification we just threw away. Clear them too;
        // they refill as the parent repaints.
        for (const descendant of yield* ApertureLensStore.descendantsOf(ctx.directory, found.id)) {
          yield* ApertureSemanticStore.clear(storage, ctx.project.id, descendant.id)
          yield* ApertureSubfacetStore.clear(storage, ctx.project.id, descendant.id)
        }
      }
      yield* onLensChanged(ctx.directory)
      return { status: "ok", lens: result.lens, structural: result.structural } as const
    })

    const mergeFacets = Effect.fn("Aperture.mergeFacets")(function* (lens: string, from: string, into: string) {
      const ctx = yield* InstanceState.context
      const all = yield* ApertureLensStore.list(ctx.directory)
      const found = resolveLens(all, lens)
      if (!found) return { status: "not-found" } as const
      if (isBuiltinLens(found)) return { status: "builtin" } as const
      // Accept either a facet id or its (case-insensitive) label for both ends.
      const resolveFacet = (ref: string) =>
        found.facets.find((t) => t.id === ref || t.label.toLowerCase() === ref.toLowerCase())?.id
      const fromId = resolveFacet(from)
      const intoId = resolveFacet(into)
      if (!fromId) return { status: "unknown-facet", facet: from } as const
      if (!intoId) return { status: "unknown-facet", facet: into } as const
      // Snapshot the drill-downs *before* the merge re-scopes them (lens-store rewrites any
      // scope naming `from` onto `into`), so we can still see which side each one was on.
      const children = yield* ApertureLensStore.childrenOf(ctx.directory, found.id)
      const updated = yield* ApertureLensStore.mergeFacets(ctx.directory, found.id, fromId, intoId)
      if (!updated) return { status: "not-found" } as const
      yield* ApertureSemanticStore.mergeFacet(storage, ctx.project.id, found.id, fromId, intoId)
      yield* ApertureSubfacetStore.mergeFacet(storage, ctx.project.id, found.id, fromId, intoId)

      // Fold the merge through each drill-down's painted store. This is why entries carry
      // `via`: a merge is deterministic and free for the Lens itself, and it stays free for
      // its drill-downs too — no re-paint unless the merge actually moved the domain.
      for (const child of children) {
        const scope = child.parent!.facets
        const hadFrom = scope.includes(fromId)
        const hadInto = scope.includes(intoId)
        if (!hadFrom && !hadInto) continue
        // When the child was scoped to exactly one side, the merge *widens* its domain: the
        // files witnessed by the other side were bucketed out (grey, `via` = that facet) and
        // are now inside. Drop precisely those entries — deleting an entry is what re-opens
        // a file for the next sweep — and leave every other grey alone, since those are
        // genuine "fits no facet" results that cost tokens to produce. Must run BEFORE the
        // remap below, which would otherwise make the two indistinguishable.
        if (hadFrom !== hadInto)
          yield* ApertureSemanticStore.dropWhereVia(storage, ctx.project.id, child.id, hadFrom ? intoId : fromId)
        // Survivors' witnesses follow the fold, or `via` would name a facet that no longer
        // exists and every one of those files would look stale on every sweep, forever.
        yield* ApertureSemanticStore.remapVia(storage, ctx.project.id, child.id, fromId, intoId)
      }

      yield* onLensChanged(ctx.directory)
      return { status: "ok", lens: updated, structural: false } as const
    })

    const deleteLens = Effect.fn("Aperture.deleteLens")(function* (idOrName: string) {
      const ctx = yield* InstanceState.context
      const all = yield* ApertureLensStore.list(ctx.directory)
      const found = resolveLens(all, idOrName)
      if (!found) return { status: "not-found" } as const
      if (isBuiltinLens(found)) return { status: "builtin" } as const
      const activeId = yield* ApertureLensStore.getActiveId(ctx.directory)
      // Cascades: a drill-down's domain is defined by its parent's facets, so deleting the
      // parent leaves it meaningless and unable to ever repaint. `remove` returns everything
      // it took (the Lens and its whole subtree) so we can clear each one's painted stores.
      const removed = yield* ApertureLensStore.remove(ctx.directory, found.id)
      for (const id of removed) {
        yield* ApertureSemanticStore.clear(storage, ctx.project.id, id)
        yield* ApertureSubfacetStore.clear(storage, ctx.project.id, id)
      }
      if (removed.includes(activeId)) yield* ApertureLensStore.setActive(ctx.directory, ARCHITECTURE_ID)
      yield* onLensChanged(ctx.directory)
      const active = yield* ApertureLensStore.getActive(ctx.directory)
      return {
        status: "ok",
        active: { id: active.id, name: active.name, legend: lensLegend(active) },
      } as const
    })

    const facetFiles = Effect.fn("Aperture.facetFiles")(function* (
      lens: string | undefined,
      facets: ReadonlyArray<string>,
    ) {
      const ctx = yield* InstanceState.context
      const all = yield* ApertureLensStore.list(ctx.directory)
      const resolved = lens ? resolveLens(all, lens) : yield* ApertureLensStore.getActive(ctx.directory)
      if (!resolved) return { status: "not-found" } as const

      // Same store source as finalize: cheap deterministic built-ins compute their facets
      // from the repo inline; bus-factor and semantic Lenses read the persisted store (the
      // former filled in the background — kick a refresh so a stale/empty one self-heals).
      const subtree = yield* subtreeFor(ctx.directory)
      const busFactor = resolved.deterministic === "bus-factor"
      const store =
        isDeterministic(resolved) && !busFactor
          ? yield* deterministicStoreFor(resolved, ctx.directory, subtree)
          : yield* ApertureSemanticStore.read(storage, ctx.project.id, resolved.id)
      if (busFactor)
        yield* forkProactivePaint(
          "bus-factor refresh failed",
          ctx.project.id,
          refreshBusFactor(ctx.directory, ctx.project.id),
        )

      // The store is keyed by stable node id (an un-invertible path hash), so recover
      // paths by joining against the repo file listing.
      const pathById = new Map(subtree.map((f) => [f.id, f.path]))
      const pathsByFacet = new Map<string, string[]>()
      for (const [id, entry] of Object.entries(store)) {
        const path = pathById.get(id)
        if (!path) continue
        const list = pathsByFacet.get(entry.facet) ?? []
        list.push(path)
        pathsByFacet.set(entry.facet, list)
      }

      // Resolve each requested ref (facet id or case-insensitive label) to a facet id;
      // an empty request means every Facet in the Lens. "Other" is requestable by name even
      // though it is not one of the Lens's facets — it is a real stored value, and asking
      // "what did this Lens NOT cover?" is exactly how you decide whether to drill into it.
      const resolveFacet = (ref: string): { id: string; label: string } | undefined =>
        ref === NONE_FACET || ref.toLowerCase() === NONE_LABEL.toLowerCase()
          ? { id: NONE_FACET, label: NONE_LABEL }
          : resolved.facets.find((t) => t.id === ref || t.label.toLowerCase() === ref.toLowerCase())
      const requested = facets.length ? facets : resolved.facets.map((t) => t.id)
      const groups: { facet: string; label: string; paths: string[] }[] = []
      const unknownFacets: string[] = []
      const seen = new Set<string>()
      for (const ref of requested) {
        const facet = resolveFacet(ref)
        if (!facet) {
          unknownFacets.push(ref)
          continue
        }
        if (seen.has(facet.id)) continue
        seen.add(facet.id)
        groups.push({ facet: facet.id, label: facet.label, paths: (pathsByFacet.get(facet.id) ?? []).sort() })
      }
      return { status: "ok", lens: { id: resolved.id, name: resolved.name }, groups, unknownFacets } as const
    })

    return Service.of({
      get: (scope) => load(scope),
      refresh: (scope) => refresh(scope),
      lenses: () => lenses(),
      activeLens: () => activeLens(),
      createLens: (input) => createLens(input),
      selectLens: (idOrName) => selectLens(idOrName),
      cycleLens: (direction) => cycleLens(direction),
      editLens: (input) => editLens(input),
      mergeFacets: (lens, from, into) => mergeFacets(lens, from, into),
      deleteLens: (idOrName) => deleteLens(idOrName),
      facetFiles: (lens, facets) => facetFiles(lens, facets),
      drill: (file, scope) => drill(file, scope),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Storage.defaultLayer),
  Layer.provide(EventV2.defaultLayer),
  // Self-provided (Provider's own stack is self-contained) so the layer stays
  // R = never, mirroring Agent.defaultLayer — the painter needs both to resolve a
  // small model and read the context flag.
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Config.defaultLayer),
  // Self-provided so the layer stays R = never; drives the git-changed built-in.
  Layer.provide(Git.defaultLayer),
)

// Reorder the enumerated files so any under the Lens's relevant directories
// come first (keeping each group's existing DFS order), then the rest of the repo.
// Returns the input unchanged when no directories are set. The targeted dirs are
// repo-relative with no leading/trailing slashes (normalized at create/edit time);
// a file matches when its path equals a dir or sits under it.
function orderByDirectories(
  files: ReadonlyArray<{ id: string; path: string }>,
  directories: ReadonlyArray<string> | undefined,
): ReadonlyArray<{ id: string; path: string }> {
  if (!directories?.length) return files
  const isPriority = (rel: string) => directories.some((d) => rel === d || rel.startsWith(d + "/"))
  const priority = files.filter((f) => isPriority(f.path))
  if (priority.length === 0 || priority.length === files.length) return files
  return [...priority, ...files.filter((f) => !isPriority(f.path))]
}

// --- composition -----------------------------------------------------------

// Per-directory subtree composition: for every directory node, tally its descendant
// source files by painted facet into a count + byte sum. A file under nested
// directories counts toward each of its in-window ancestors (each directory reflects
// its own full subtree). Every descendant file also feeds the directory's `subtree*`
// totals regardless of painting, so a directory with no painted files still reports its
// real size (the renderer sizes its grey block from that rather than painting it
// full-bleed). Pure: a function of the window's directories, the subtree file set,
// the semantic store, and the function-level mixes.
//
// A file's bytes are attributed by `attributeFileBytes`: whole-file to its file-level
// facet normally, but split across its function facets once it has a mix — the
// finer-grained paint supersedes the coarse one. `count` stays whole-file (the file
// counts once, toward the facet holding most of its bytes) so the count metric keeps
// meaning "files", not "functions".
export function computeComposition(
  nodes: AperturePayload.Payload["nodes"],
  files: ReadonlyArray<{ id: string; path: string; size: number }>,
  store: ApertureSemanticStore.Store,
  mixes: ApertureSubfacetStore.Mixes,
  lens: Lens,
): Record<string, AperturePayload.Composition> {
  const dirs = nodes.filter((n) => n.kind === "directory").map((d) => ({ id: d.id, prefix: d.path + "/" }))
  if (dirs.length === 0) return {}
  const painted = new Map<string, Map<string, { count: number; bytes: number }>>()
  const subtree = new Map<string, { count: number; bytes: number }>()
  for (const file of files) {
    const attribution = ApertureExtents.attributeFileBytes(file.size, mixes[file.path], store[file.id]?.facet)
    for (const dir of dirs) {
      if (!file.path.startsWith(dir.prefix)) continue
      const s = subtree.get(dir.id) ?? { count: 0, bytes: 0 }
      s.count += 1
      s.bytes += file.size
      subtree.set(dir.id, s)
      if (attribution.weights.length === 0) continue
      let byFacet = painted.get(dir.id)
      if (!byFacet) painted.set(dir.id, (byFacet = new Map()))
      for (const weight of attribution.weights) {
        const w = byFacet.get(weight.facet) ?? { count: 0, bytes: 0 }
        if (weight.facet === attribution.dominant) w.count += 1
        w.bytes += weight.bytes
        byFacet.set(weight.facet, w)
      }
    }
  }
  // Emit an entry for every directory that has any descendant file, even when none
  // are painted (empty `weights`) — that's the grey case the renderer sizes by subtree.
  const order = [...lens.facets.map((t) => t.id), NONE_FACET]
  const result: Record<string, AperturePayload.Composition> = {}
  for (const [id, s] of subtree) {
    const byFacet = painted.get(id)
    // Weights in the Lens's facet order so the payload is stable and the
    // renderer's colour bands are consistent.
    const weights = byFacet
      ? order.filter((t) => byFacet.has(t)).map((facet) => ({ facet, ...byFacet.get(facet)! }))
      : []
    const totalCount = weights.reduce((sum, w) => sum + w.count, 0)
    const totalBytes = weights.reduce((sum, w) => sum + w.bytes, 0)
    result[id] = { weights, totalCount, totalBytes, subtreeCount: s.count, subtreeBytes: s.bytes }
  }
  return result
}

// --- window math -----------------------------------------------------------

// Parent directory of a repo-relative path — the window scope whose viewers should be
// invalidated when the file's function tiles repaint; "" for a root-level file.
function parentScope(rel: string): string {
  const i = rel.lastIndexOf("/")
  return i === -1 ? "" : rel.slice(0, i)
}

// The source extensions the extractor walks (SOURCE_GLOB in extract.ts). Only these can
// carry function-level extents, so a changed file with any other extension has nothing to
// function-paint and is left out of the working-set trigger.
const PAINTABLE_EXTS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "py"])
function isPaintableSource(rel: string): boolean {
  const i = rel.lastIndexOf(".")
  return i !== -1 && PAINTABLE_EXTS.has(rel.slice(i + 1))
}

// Repo-relative POSIX path for an absolute file under `directory`, or undefined
// if it escapes the directory (file events carry absolute paths).
function toRepoRelative(directory: string, absFile: string): string | undefined {
  const rel = path.relative(directory, absFile)
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined
  return rel.split(path.sep).join("/")
}

// True if `rel` is within the 2-level window rooted at `scope` (i.e. it is one
// of the nodes the view actually draws). Mirrors the extractor's layer math.
function isWithinWindow(scope: string, rel: string): boolean {
  if (scope !== "" && rel !== scope && !rel.startsWith(scope + "/")) return false
  const scopeSegments = scope === "" ? 0 : scope.split("/").length
  const relativeDepth = rel.split("/").length - scopeSegments - 1
  return relativeDepth >= 0 && relativeDepth < ApertureExtract.VIEW_DEPTH
}

export * as Aperture from "./aperture"
