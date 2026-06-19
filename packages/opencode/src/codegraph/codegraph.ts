import { Effect, Layer, Context, Stream, Queue, Semaphore } from "effect"
import path from "path"
import { createHash } from "crypto"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import * as Log from "@opencode-ai/core/util/log"
import { FSUtil } from "@opencode-ai/core/fs-util"
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
import { CodeGraphPayload } from "./payload"
import { CodeGraphExtract } from "./extract"
import { CodeGraphEvent } from "./event"
import { CodeGraphSemanticStore } from "./semantic-store"
import { CodeGraphTagger } from "./tagger"
import { CodeGraphCollectionStore } from "./collection-store"
import { CodeGraphDeterministic } from "./deterministic"
import { Git } from "@/git"
import { type TagCollection, type PaletteId, legend as collectionLegend, NONE_TAG, NONE_HUE, ARCHITECTURE_ID, isBuiltinCollection, isDeterministic } from "./collections"

// Server-side code-graph service (PLAN.md steps 1 + 2.5). Owns the deterministic
// payload, but unlike step 1 the graph is a *2-level window* rooted at a scope
// (a repo-relative directory the TUI is viewing). The view is built on demand:
// each scope the user navigates to is extracted, cached per project, and reused.
//
// Recompute is visibility-gated (the merge of step 3). We subscribe to file
// events and only mark a cached scope dirty when the changed file falls within
// that scope's window — a file buried in an unopened directory dirties nothing.
// When a *currently cached* scope goes dirty we also publish codegraph.invalidated
// so the live view refetches just that scope; recompute itself still happens
// lazily on the next get(). Caches and the dirty set live per project directory.
//
// Two exploration scopes coexist. Per-scope (get/refresh) keeps the live view of
// the *viewed window* fresh as the user navigates — cheap, and the path that
// catches local edits/creations. The whole-repo `sweep` runs on open and on each
// turn completion: the deterministic walk enumerates every file in the repo and
// the tagger paints all of them, so semantics fill in beyond the viewed window.
// Both layers keep their skip checks — a scope already cached + clean isn't
// recomputed, and a file whose content hash is unchanged isn't re-tagged — so the
// sweep only spends work on what's new or actually changed.

const log = Log.create({ service: "codegraph" })

// Shared concurrency gate across the foreground (per-scope window) and background
// (whole-repo) taggers: at most this many model calls in flight at once, so the two
// never collide on the API. The background loop holds a permit only for one batch
// and releases it during its inter-batch pause, so a foreground tag always wins a
// permit promptly — that's how the visible view stays prioritized.
const TAG_CONCURRENCY = 1
// Files handed to one background tagStale call; = MAX_PER_PASS in the tagger so each
// call fully consumes the slice rather than leaving a remainder for the next pass.
const BG_BATCH = 60
// Pause between background batches, held *outside* the permit so a foreground tag
// arriving mid-pause acquires immediately. Spaces requests to avoid rate-limit
// bounceback when painting a large repo.
const BG_BATCH_DELAY = "1000 millis"

// Storage key: ["codegraph", <projectID>, "structure", <scopeKey>]. Per project
// and per scope so each navigated directory keeps its own durable subgraph.
function storageKey(projectID: string, scope: string) {
  const scopeKey = scope === "" ? "root" : "s_" + createHash("sha256").update(scope).digest("hex").slice(0, 16)
  return ["codegraph", projectID, "structure", scopeKey]
}

interface DirCache {
  readonly projectID: string
  readonly scopes: Map<string, CodeGraphPayload.Payload>
  readonly dirty: Set<string>
}

export interface CreateCollectionInput {
  readonly name: string
  readonly description: string
  readonly palette: PaletteId
  readonly prompt: string
  readonly tags: ReadonlyArray<{ readonly label: string; readonly description: string }>
  // Optional repo-relative directories the tagger front-loads (see TagCollection).
  readonly directories?: ReadonlyArray<string>
  // Whether to make the new collection active (switching the viewed collection and
  // starting the tagger on it). Defaults to true — the interactive /tag behaviour.
  // Pass false to create without disturbing the user's current view (the new
  // collection then stays untagged until it is selected).
  readonly activate?: boolean
}

export interface EditCollectionInput {
  // Id or name of the collection to edit (must be a user/project collection).
  readonly collection: string
  readonly name?: string
  readonly description?: string
  readonly palette?: PaletteId
  readonly prompt?: string
  // The complete desired tag list (like create). Tags keep their id — and thus their
  // existing tagged files — when an id or label matches; new labels mint new tags.
  readonly tags?: ReadonlyArray<{ readonly id?: string; readonly label: string; readonly description: string }>
  readonly directories?: ReadonlyArray<string>
}

// Outcome of an edit/merge/delete: a resolved collection or why it was refused. The
// built-in (global) collections are immutable, so they refuse with "builtin".
export type CollectionMutation =
  | { readonly status: "ok"; readonly collection: TagCollection; readonly structural: boolean }
  | { readonly status: "not-found" }
  | { readonly status: "builtin" }
  | { readonly status: "unknown-tag"; readonly tag: string }

// Outcome of a delete: the now-active collection (after falling back to Architecture
// when the deleted one was active) or why it was refused.
export type DeleteOutcome =
  | { readonly status: "ok"; readonly active: CodeGraphPayload.CollectionInfo }
  | { readonly status: "not-found" }
  | { readonly status: "builtin" }

export interface Interface {
  // Cached payload for `scope` (default repo root); computes + persists on a miss
  // or when the scope has been marked dirty by a file change in its window.
  readonly get: (scope?: string) => Effect.Effect<CodeGraphPayload.Payload>
  // Recompute `scope` from disk, persist, and refresh the in-memory copy.
  readonly refresh: (scope?: string) => Effect.Effect<CodeGraphPayload.Payload>
  // Built-in + project-defined tag collections, and the active one.
  readonly collections: () => Effect.Effect<TagCollection[]>
  readonly activeCollection: () => Effect.Effect<TagCollection>
  // Define a new per-project collection (additive — never overwrites), make it
  // active, and kick off tagging.
  readonly createCollection: (input: CreateCollectionInput) => Effect.Effect<TagCollection>
  // Switch the active collection by id or name; re-paints from cache and tags any
  // not-yet-tagged files. Returns the resolved collection, or undefined if unknown.
  readonly selectCollection: (idOrName: string) => Effect.Effect<TagCollection | undefined>
  // Step one collection forward ("next") or back ("prev") in the list (built-ins +
  // user-defined), wrapping at the ends, and re-paint. Returns the newly-active
  // collection's info. Drives the top-bar's ◀/▶ arrows.
  readonly cycleCollection: (direction: "next" | "prev") => Effect.Effect<CodeGraphPayload.CollectionInfo>
  // Edit a user collection in place. A structural change (tags added/removed/redefined
  // or prompt changed) clears that collection's tags so the sweep re-tags from scratch;
  // a cosmetic change (name/label/palette/directories) just re-paints. Built-ins refuse.
  readonly editCollection: (input: EditCollectionInput) => Effect.Effect<CollectionMutation>
  // Deterministically fold one tag into another for a user collection (no re-tag, no
  // tokens): drops `from` and re-labels its files as `into`. Both id or label.
  readonly mergeTags: (collection: string, from: string, into: string) => Effect.Effect<CollectionMutation>
  // Delete a user collection (and its tags), falling back to the built-in active
  // collection when the deleted one was active. Not exposed to the tagging agent.
  readonly deleteCollection: (idOrName: string) => Effect.Effect<DeleteOutcome>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CodeGraph") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const events = yield* EventV2.Service
    // Provider/Config are not self-provided (see defaultLayer) — they ride the
    // server's merged layer like Session does. Captured here so the forked tagger
    // keeps a clean R = never and `get`/`refresh` expose no extra requirements.
    const provider = yield* Provider.Service
    const config = yield* Config.Service
    // Drives the deterministic "Changed since last commit" built-in (git status). Like
    // Provider/Config it's self-provided in defaultLayer so the layer stays R = never.
    const git = yield* Git.Service

    // Shared by the foreground and background taggers (see TAG_CONCURRENCY).
    const tagGate = yield* Semaphore.make(TAG_CONCURRENCY)
    // The layer-construction scope: background loops fork into it (not the per-get
    // request scope) so they live for the service's lifetime and are interrupted
    // when it's released, while keeping get()/refresh() at R = never.
    const serviceScope = yield* Effect.scope

    const empty = {
      version: CodeGraphPayload.PAYLOAD_VERSION,
      nodes: [],
      edges: [],
      semantics: {},
    } satisfies CodeGraphPayload.Payload

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
    const subtreeCache = new Map<string, ReadonlyArray<CodeGraphDeterministic.SubtreeFile>>()
    const subtreeFor = (directory: string) =>
      Effect.gen(function* () {
        const cached = subtreeCache.get(directory)
        if (cached) return cached
        const files = yield* CodeGraphExtract.listSubtree(directory, "").pipe(
          Effect.catch((cause) => {
            log.error("listSubtree failed", { directory, cause })
            return Effect.succeed([] as ReadonlyArray<CodeGraphDeterministic.SubtreeFile>)
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
    const gitStatusCache = new Map<string, CodeGraphDeterministic.GitChanged>()
    const gitChangedFor = (directory: string) =>
      Effect.gen(function* () {
        const cached = gitStatusCache.get(directory)
        if (cached) return cached
        const items = yield* git.status(directory)
        const prefix = yield* git.prefix(directory)
        const resolved: CodeGraphDeterministic.GitChanged = { prefix, changed: new Set(items.map((i) => i.file)) }
        gitStatusCache.set(directory, resolved)
        return resolved
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
    // git work tree. A collection whose prerequisite isn't met is hidden everywhere a
    // collection is chosen or listed (collections()/cycle/select), so the user can never
    // land on a meaningless view — git-changed simply doesn't exist in a non-git folder.
    const isAvailable = (collection: TagCollection, directory: string): Effect.Effect<boolean> =>
      collection.deterministic === "git-changed" ? isRepoFor(directory) : Effect.succeed(true)

    // The active+listed collections minus any whose prerequisite is unmet for this directory.
    const listAvailable = (directory: string, projectID: string) =>
      Effect.gen(function* () {
        const all = yield* CodeGraphCollectionStore.list(storage, projectID)
        const keep: TagCollection[] = []
        for (const collection of all) if (yield* isAvailable(collection, directory)) keep.push(collection)
        return keep
      })

    const off = registerDisposer(async (directory) => {
      caches.delete(directory)
      subtreeCache.delete(directory)
      gitStatusCache.delete(directory)
      isRepoCache.delete(directory)
      // The loop fiber itself is interrupted when the instance scope closes
      // (forkScoped); drop the map entry so a later reopen can start a fresh one.
      bgTaggers.delete(directory)
    })
    yield* Effect.addFinalizer(() => Effect.sync(off))

    // FS failures degrade to an empty payload rather than crashing the UI.
    const compute = Effect.fn("CodeGraph.compute")(
      function* (directory: string, projectID: string, scope: string) {
        const payload = yield* CodeGraphExtract.extract(directory, { scope }).pipe(
          Effect.catch((cause) => {
            log.error("extract failed", { projectID, scope, cause })
            return Effect.succeed(empty)
          }),
        )
        yield* storage.write(storageKey(projectID, scope), payload).pipe(Effect.ignore)
        log.info("computed", { projectID, scope, nodes: payload.nodes.length, edges: payload.edges.length })
        return payload
      },
      Effect.provide(FSUtil.defaultLayer),
    )

    // The structure cache (container.scopes + storage) stays pure: semantics are
    // merged onto a copy at the read boundary from the separate per-project store,
    // so the deterministic structure is never mutated by the async paint. Every
    // read path runs through finalize so the merge + background tagging happen
    // exactly once regardless of where the structure came from (memory, disk,
    // recompute).
    const inFlight = new Set<string>()

    const scheduleTag = (
      directory: string,
      projectID: string,
      scope: string,
      nodes: CodeGraphPayload.Payload["nodes"],
      boundaries: readonly CodeGraphPayload.Boundary[],
      collection: TagCollection,
    ) =>
      Effect.gen(function* () {
        // Tag in-window files *and* the one-hop boundary targets (step 6): a
        // boundary's tile is painted from its target's layer, so the target must be
        // tagged even though it falls outside the current window. The store is keyed
        // by stable node id, so this tag is reused when the file is later viewed
        // in-window. stale-only dedup in the tagger keeps the extra files cheap.
        const fileNodes = [...nodes.filter((n) => n.kind === "file"), ...boundaries.filter((b) => b.kind === "file")].map(
          (n) => ({ id: n.id, path: n.path }),
        )
        if (fileNodes.length === 0) return
        // Key by collection too: a foreground pass for a freshly-switched collection
        // must not be deduped against an in-flight pass for the previous one.
        const key = directory + " " + scope + " " + collection.id
        if (inFlight.has(key)) return
        inFlight.add(key)
        yield* CodeGraphTagger.tagStale(
          { storage, events, provider, config },
          directory,
          projectID,
          scope,
          fileNodes,
          "fg",
          collection,
        ).pipe(
          tagGate.withPermits(1),
          Effect.ensuring(Effect.sync(() => inFlight.delete(key))),
          Effect.forkDetach,
        )
      })

    const finalize = (ctx: InstanceContext, scope: string, structure: CodeGraphPayload.Payload) =>
      Effect.gen(function* () {
        // Paint with the *active* collection: its tag store, its legend (tag → colour),
        // and its name travel out on the payload so the renderer needs no hard-coded
        // vocabulary. Switching collections re-paints from that collection's own
        // (cached) store — no other collection's work is touched.
        const collection = yield* CodeGraphCollectionStore.getActive(storage, ctx.project.id)
        // Whole-repo membership (full depth), needed both for directory composition and —
        // for the deterministic built-ins — as the file set whose tags we synthesize.
        const subtree = yield* subtreeFor(ctx.directory)
        // Deterministic built-ins (git-changed / mtime-buckets) compute their tags from the
        // repo instead of reading the persisted store: no tagger, no tokens, always fresh.
        const det = isDeterministic(collection)
        const store = det
          ? CodeGraphDeterministic.computeStore(
              collection.deterministic!,
              subtree,
              collection.deterministic === "git-changed" ? yield* gitChangedFor(ctx.directory) : undefined,
            )
          : yield* CodeGraphSemanticStore.read(storage, ctx.project.id, collection.id)
        const colorByTag = new Map(collection.tags.map((t) => [t.id, t.color]))
        const semantics: Record<string, CodeGraphPayload.Semantic> = {}
        // The store holds only the semantic (tag); hue/tags are derived here, so
        // palette/vocabulary changes apply without a re-tag. Boundaries (step 6) are
        // painted from the same store so an out-of-window tile shows its target's hue
        // once that target has been tagged.
        const applySemantic = (id: string) => {
          const entry = store[id]
          if (entry) semantics[id] = { tags: [entry.tag], hue: entry.tag === NONE_TAG ? NONE_HUE : colorByTag.get(entry.tag) }
        }
        for (const node of structure.nodes) applySemantic(node.id)
        for (const boundary of structure.boundaries ?? []) applySemantic(boundary.id)
        // Paint each in-window directory as its subtree's tag composition: bucket every
        // descendant source file (full depth, from the cached membership) by its tagged
        // tag, summing both a file count and a byte sum so the renderer can pick either
        // metric. Derived here alongside `semantics` so the structure cache stays pure.
        const composition = computeComposition(structure.nodes, subtree, store, collection)
        // Deterministic collections are fully painted above; only semantic ones schedule
        // the foreground tagger for the in-window files + boundary targets.
        if (!det)
          yield* scheduleTag(ctx.directory, ctx.project.id, scope, structure.nodes, structure.boundaries ?? [], collection)
        const collectionInfo: CodeGraphPayload.CollectionInfo = {
          id: collection.id,
          name: collection.name,
          legend: collectionLegend(collection),
        }
        return { ...structure, semantics, composition, collection: collectionInfo }
      })

    // Background whole-repo tagger (vs. the per-scope window of get/refresh). One
    // self-rescheduling loop per directory walks every source file in DFS order
    // (so directories light up from the root outward), painting BG_BATCH files per
    // step under the shared gate with a pause between steps. When a full pass is
    // done it parks until a file change / turn completion wakes it, then re-walks —
    // picking up created/deleted files. The stale-hash skip in the tagger makes
    // every re-walk cheap (unchanged files spend nothing). forkScoped binds the loop
    // to the instance scope so it dies with the TUI; the bgTaggers map dedups starts
    // and the dropping(1) wake queue coalesces a burst of changes into one rescan.
    const bgTaggers = new Map<string, { readonly wake: Queue.Queue<void> }>()
    // Per-directory counter bumped whenever the active collection changes
    // (onCollectionChanged). The bg loop snapshots it at pass start and abandons an
    // in-flight sweep when it changes, so a freshly-selected collection starts filling
    // in immediately instead of waiting for the previous collection's sweep to finish.
    const collectionEpoch = new Map<string, number>()

    const backgroundLoop = (directory: string, projectID: string, wake: Queue.Queue<void>) =>
      Effect.gen(function* () {
        while (true) {
          // Re-read the active collection each pass so a switch (which wakes this loop)
          // re-walks the repo tagging for the *new* collection; cached entries make a
          // re-walk of an already-tagged collection free.
          const collection = yield* CodeGraphCollectionStore.getActive(storage, projectID)
          // Deterministic built-ins are painted synchronously in finalize — there's nothing
          // for the whole-repo sweep to do. Park until a collection switch (or file change)
          // wakes us; the next pass re-reads the active collection and resumes the sweep if
          // it's switched back to a semantic one.
          if (isDeterministic(collection)) {
            yield* Queue.take(wake)
            continue
          }
          const epoch = collectionEpoch.get(directory) ?? 0
          const files = yield* CodeGraphExtract.listFilesDfs(directory).pipe(
            Effect.catchCause((cause) => {
              log.error("background enumerate failed", { projectID, cause })
              return Effect.succeed<ReadonlyArray<{ id: string; path: string }>>([])
            }),
            Effect.provide(FSUtil.defaultLayer),
          )
          // Front-load the collection's relevant directories (if any): tag files under
          // them first, in their existing DFS order, then the rest of the repo. The
          // sweep still covers everything; this only changes the order so the targeted
          // area lights up first. Already-tagged files in the tail are stale-skipped.
          const ordered = orderByDirectories(files, collection.directories)
          // Always-written diagnostic so a bg loop that produces no request lines is
          // still visible in the perf log (distinguishes "loop never ran" from
          // "ran but every slice was already tagged / no model").
          yield* CodeGraphTagger.appendPerfEvent(directory, "bg", "pass-start", { files: ordered.length, collection: collection.id })
          let interrupted = false
          for (let cursor = 0; cursor < ordered.length; cursor += BG_BATCH) {
            const slice = ordered.slice(cursor, cursor + BG_BATCH)
            // scope "" — the tag store is keyed by stable node id, so a file tagged
            // here is reused in every window it later appears in. The permit is held
            // only for the batch; the pause below runs without it so foreground wins.
            yield* CodeGraphTagger.tagStale({ storage, events, provider, config }, directory, projectID, "", slice, "bg", collection).pipe(
              tagGate.withPermits(1),
              Effect.catchCause((cause) =>
                Effect.sync(() => log.error("background batch failed", { projectID, cause })),
              ),
            )
            yield* Effect.sleep(BG_BATCH_DELAY)
            // Abandon the rest of this sweep when the active collection changed under
            // us, so the new collection takes over without finishing the old one.
            if ((collectionEpoch.get(directory) ?? 0) !== epoch) {
              interrupted = true
              break
            }
          }
          // On interruption, drain the switch's own wake signal and re-loop immediately
          // (the next pass re-reads the now-active collection). Otherwise park until a
          // file change / turn completion / collection switch wakes us.
          if (interrupted) yield* Queue.poll(wake)
          else yield* Queue.take(wake)
        }
      })

    const startBackgroundTagger = (directory: string, projectID: string) =>
      Effect.gen(function* () {
        if (bgTaggers.has(directory)) return
        const wake = yield* Queue.dropping<void>(1)
        bgTaggers.set(directory, { wake })
        yield* backgroundLoop(directory, projectID, wake).pipe(
          Effect.catchCause((cause) => Effect.sync(() => log.error("background loop crashed", { projectID, cause }))),
          (loop) => Effect.forkIn(loop, serviceScope),
        )
      })

    // Nudge a parked background loop to re-enumerate and re-walk. dropping(1) makes a
    // burst of file events / repeated turn completions coalesce into a single rescan.
    const wakeBackground = (directory: string) =>
      Effect.gen(function* () {
        const entry = bgTaggers.get(directory)
        if (!entry) return
        yield* Queue.offer(entry.wake, void 0).pipe(Effect.ignore)
      })

    const load = Effect.fn("CodeGraph.load")(function* (scope?: string) {
      const ctx = yield* InstanceState.context
      const container = containerFor(ctx.directory, ctx.project.id)
      // On open (first get for this directory) start the background whole-repo tagger
      // so semantics fill in past the initially-viewed window without the user having
      // to navigate. Idempotent per directory; file changes / turn completion wake it
      // to re-walk (the subscriptions below).
      yield* startBackgroundTagger(ctx.directory, ctx.project.id)
      const norm = CodeGraphExtract.normalizeScope(scope ?? "")

      if (!container.dirty.has(norm)) {
        const inMemory = container.scopes.get(norm)
        if (inMemory) return yield* finalize(ctx, norm, inMemory)
        const cached = yield* storage
          .read<CodeGraphPayload.Payload>(storageKey(ctx.project.id, norm))
          .pipe(Effect.catch(() => Effect.void))
        if (cached && cached.version === CodeGraphPayload.PAYLOAD_VERSION) {
          container.scopes.set(norm, cached)
          return yield* finalize(ctx, norm, cached)
        }
      }

      const payload = yield* compute(ctx.directory, ctx.project.id, norm)
      container.scopes.set(norm, payload)
      container.dirty.delete(norm)
      return yield* finalize(ctx, norm, payload)
    })

    const refresh = Effect.fn("CodeGraph.refresh")(function* (scope?: string) {
      const ctx = yield* InstanceState.context
      const container = containerFor(ctx.directory, ctx.project.id)
      // The TUI fetches with refresh=true, so this — not load — is the path that
      // actually runs on open; start the background tagger here too (idempotent per
      // directory) or it would never kick off.
      yield* startBackgroundTagger(ctx.directory, ctx.project.id)
      const norm = CodeGraphExtract.normalizeScope(scope ?? "")
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
            .publish(CodeGraphEvent.Event.Invalidated, { scope }, location ? { location } : undefined)
            .pipe(Effect.ignore)
        }
        // Wake the background tagger so the change is (re)tagged even when it falls
        // outside every viewed window — the stale-hash skip keeps the re-walk cheap.
        yield* wakeBackground(directory)
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
    // turn) wake the background tagger so files created/changed during the turn get
    // tagged. Gated on an existing cache so we only touch repos whose graph is open —
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
      })
    yield* Effect.forkScoped(
      events.subscribe(SessionStatus.Event.Status).pipe(
        Stream.runForEach((event) =>
          event.data.status.type === "idle" ? onSessionIdle(event.location) : Effect.void,
        ),
      ),
    )

    // Re-paint every viewed scope after the active collection changes: mark each
    // cached scope dirty so the next get re-runs finalize with the new collection, and
    // publish an invalidation so the live view refetches. The bg tagger is woken so the
    // new collection also fills in beyond the viewed window.
    const onCollectionChanged = (directory: string) =>
      Effect.gen(function* () {
        const container = caches.get(directory)
        if (container) {
          for (const scope of container.scopes.keys()) {
            container.dirty.add(scope)
            yield* events.publish(CodeGraphEvent.Event.Invalidated, { scope }).pipe(Effect.ignore)
          }
        }
        // Bump the epoch so an in-flight background sweep abandons the old collection
        // and restarts for the new one (the wake below re-runs the parked loop).
        collectionEpoch.set(directory, (collectionEpoch.get(directory) ?? 0) + 1)
        yield* wakeBackground(directory)
      })

    const collections = Effect.fn("CodeGraph.collections")(function* () {
      const ctx = yield* InstanceState.context
      // Hide deterministic built-ins whose prerequisite is unmet (git-changed off-git).
      return yield* listAvailable(ctx.directory, ctx.project.id)
    })

    const activeCollection = Effect.fn("CodeGraph.activeCollection")(function* () {
      const ctx = yield* InstanceState.context
      return yield* CodeGraphCollectionStore.getActive(storage, ctx.project.id)
    })

    const createCollection = Effect.fn("CodeGraph.createCollection")(function* (input: CreateCollectionInput) {
      const ctx = yield* InstanceState.context
      const collection = yield* CodeGraphCollectionStore.create(storage, ctx.project.id, input)
      // Default: activate the new collection (switch the view, start the tagger on
      // it). When activate is false the collection is only persisted — the active
      // collection and its in-flight sweep are left untouched, so the user's current
      // view is undisturbed (the new one paints later if/when it is selected).
      if (input.activate !== false) {
        yield* CodeGraphCollectionStore.setActive(storage, ctx.project.id, collection.id)
        yield* onCollectionChanged(ctx.directory)
      }
      return collection
    })

    const selectCollection = Effect.fn("CodeGraph.selectCollection")(function* (idOrName: string) {
      const ctx = yield* InstanceState.context
      // Resolve only against *available* collections so an unavailable built-in (e.g.
      // git-changed in a non-git folder) reports as unknown rather than activating a
      // collection that can't paint anything meaningful.
      const all = yield* listAvailable(ctx.directory, ctx.project.id)
      const needle = idOrName.toLowerCase()
      const found = all.find((c) => c.id === idOrName || c.name.toLowerCase() === needle)
      if (!found) return undefined
      yield* CodeGraphCollectionStore.setActive(storage, ctx.project.id, found.id)
      yield* onCollectionChanged(ctx.directory)
      return found
    })

    const cycleCollection = Effect.fn("CodeGraph.cycleCollection")(function* (direction: "next" | "prev") {
      const ctx = yield* InstanceState.context
      // Cycle only through available collections so the arrows skip a hidden built-in
      // (e.g. git-changed in a non-git folder) instead of landing the user on it.
      const all = yield* listAvailable(ctx.directory, ctx.project.id)
      const activeId = yield* CodeGraphCollectionStore.getActiveId(storage, ctx.project.id)
      const idx = all.findIndex((c) => c.id === activeId)
      const len = all.length
      // Wrap at both ends so the arrows loop through the list rather than stopping.
      // An unresolved active id (-1) starts from the head so a click still moves.
      const base = idx === -1 ? 0 : idx
      const next = all[(base + (direction === "next" ? 1 : len - 1)) % len]!
      yield* CodeGraphCollectionStore.setActive(storage, ctx.project.id, next.id)
      yield* onCollectionChanged(ctx.directory)
      return { id: next.id, name: next.name, legend: collectionLegend(next) }
    })

    // Resolve a collection by id or (case-insensitive) name. Used by edit/merge/delete
    // to find the target and refuse the immutable built-ins.
    const resolveCollection = (all: ReadonlyArray<TagCollection>, idOrName: string) => {
      const needle = idOrName.toLowerCase()
      return all.find((c) => c.id === idOrName || c.name.toLowerCase() === needle)
    }

    const editCollection = Effect.fn("CodeGraph.editCollection")(function* (input: EditCollectionInput) {
      const ctx = yield* InstanceState.context
      const all = yield* CodeGraphCollectionStore.list(storage, ctx.project.id)
      const found = resolveCollection(all, input.collection)
      if (!found) return { status: "not-found" } as const
      if (isBuiltinCollection(found)) return { status: "builtin" } as const
      const result = yield* CodeGraphCollectionStore.update(storage, ctx.project.id, found.id, {
        name: input.name,
        description: input.description,
        palette: input.palette,
        prompt: input.prompt,
        tags: input.tags,
        directories: input.directories,
      })
      if (!result) return { status: "not-found" } as const
      // Structural edits invalidate the inferred tags — clear them so the sweep
      // re-tags from scratch. Cosmetic edits keep the tags and just re-paint.
      if (result.structural) yield* CodeGraphSemanticStore.clear(storage, ctx.project.id, found.id)
      yield* onCollectionChanged(ctx.directory)
      return { status: "ok", collection: result.collection, structural: result.structural } as const
    })

    const mergeTags = Effect.fn("CodeGraph.mergeTags")(function* (collection: string, from: string, into: string) {
      const ctx = yield* InstanceState.context
      const all = yield* CodeGraphCollectionStore.list(storage, ctx.project.id)
      const found = resolveCollection(all, collection)
      if (!found) return { status: "not-found" } as const
      if (isBuiltinCollection(found)) return { status: "builtin" } as const
      // Accept either a tag id or its (case-insensitive) label for both ends.
      const resolveTag = (ref: string) =>
        found.tags.find((t) => t.id === ref || t.label.toLowerCase() === ref.toLowerCase())?.id
      const fromId = resolveTag(from)
      const intoId = resolveTag(into)
      if (!fromId) return { status: "unknown-tag", tag: from } as const
      if (!intoId) return { status: "unknown-tag", tag: into } as const
      const updated = yield* CodeGraphCollectionStore.mergeTags(storage, ctx.project.id, found.id, fromId, intoId)
      if (!updated) return { status: "not-found" } as const
      yield* CodeGraphSemanticStore.mergeTag(storage, ctx.project.id, found.id, fromId, intoId)
      yield* onCollectionChanged(ctx.directory)
      return { status: "ok", collection: updated, structural: false } as const
    })

    const deleteCollection = Effect.fn("CodeGraph.deleteCollection")(function* (idOrName: string) {
      const ctx = yield* InstanceState.context
      const all = yield* CodeGraphCollectionStore.list(storage, ctx.project.id)
      const found = resolveCollection(all, idOrName)
      if (!found) return { status: "not-found" } as const
      if (isBuiltinCollection(found)) return { status: "builtin" } as const
      const activeId = yield* CodeGraphCollectionStore.getActiveId(storage, ctx.project.id)
      yield* CodeGraphCollectionStore.remove(storage, ctx.project.id, found.id)
      yield* CodeGraphSemanticStore.clear(storage, ctx.project.id, found.id)
      if (activeId === found.id) yield* CodeGraphCollectionStore.setActive(storage, ctx.project.id, ARCHITECTURE_ID)
      yield* onCollectionChanged(ctx.directory)
      const active = yield* CodeGraphCollectionStore.getActive(storage, ctx.project.id)
      return {
        status: "ok",
        active: { id: active.id, name: active.name, legend: collectionLegend(active) },
      } as const
    })

    return Service.of({
      get: (scope) => load(scope),
      refresh: (scope) => refresh(scope),
      collections: () => collections(),
      activeCollection: () => activeCollection(),
      createCollection: (input) => createCollection(input),
      selectCollection: (idOrName) => selectCollection(idOrName),
      cycleCollection: (direction) => cycleCollection(direction),
      editCollection: (input) => editCollection(input),
      mergeTags: (collection, from, into) => mergeTags(collection, from, into),
      deleteCollection: (idOrName) => deleteCollection(idOrName),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Storage.defaultLayer),
  Layer.provide(EventV2.defaultLayer),
  // Self-provided (Provider's own stack is self-contained) so the layer stays
  // R = never, mirroring Agent.defaultLayer — the tagger needs both to resolve a
  // small model and read the context flag.
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Config.defaultLayer),
  // Self-provided so the layer stays R = never; drives the git-changed built-in.
  Layer.provide(Git.defaultLayer),
)

// Reorder the enumerated files so any under the collection's relevant directories
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
// source files by tagged layer into a count + byte sum. A file under nested
// directories counts toward each of its in-window ancestors (each directory reflects
// its own full subtree). Every descendant file also feeds the directory's `subtree*`
// totals regardless of tagging, so a directory with no tagged files still reports its
// real size (the renderer sizes its grey block from that rather than painting it
// full-bleed). Pure: a function of the window's directories, the subtree file set,
// and the semantic store.
function computeComposition(
  nodes: CodeGraphPayload.Payload["nodes"],
  files: ReadonlyArray<{ id: string; path: string; size: number }>,
  store: CodeGraphSemanticStore.Store,
  collection: TagCollection,
): Record<string, CodeGraphPayload.Composition> {
  const dirs = nodes.filter((n) => n.kind === "directory").map((d) => ({ id: d.id, prefix: d.path + "/" }))
  if (dirs.length === 0) return {}
  const tagged = new Map<string, Map<string, { count: number; bytes: number }>>()
  const subtree = new Map<string, { count: number; bytes: number }>()
  for (const file of files) {
    const tag = store[file.id]?.tag
    for (const dir of dirs) {
      if (!file.path.startsWith(dir.prefix)) continue
      const s = subtree.get(dir.id) ?? { count: 0, bytes: 0 }
      s.count += 1
      s.bytes += file.size
      subtree.set(dir.id, s)
      if (!tag) continue
      let byTag = tagged.get(dir.id)
      if (!byTag) tagged.set(dir.id, (byTag = new Map()))
      const w = byTag.get(tag) ?? { count: 0, bytes: 0 }
      w.count += 1
      w.bytes += file.size
      byTag.set(tag, w)
    }
  }
  // Emit an entry for every directory that has any descendant file, even when none
  // are tagged (empty `weights`) — that's the grey case the renderer sizes by subtree.
  const order = [...collection.tags.map((t) => t.id), NONE_TAG]
  const result: Record<string, CodeGraphPayload.Composition> = {}
  for (const [id, s] of subtree) {
    const byTag = tagged.get(id)
    // Weights in the collection's tag order so the payload is stable and the
    // renderer's colour bands are consistent.
    const weights = byTag ? order.filter((t) => byTag.has(t)).map((tag) => ({ tag, ...byTag.get(tag)! })) : []
    const totalCount = weights.reduce((sum, w) => sum + w.count, 0)
    const totalBytes = weights.reduce((sum, w) => sum + w.bytes, 0)
    result[id] = { weights, totalCount, totalBytes, subtreeCount: s.count, subtreeBytes: s.bytes }
  }
  return result
}

// --- window math -----------------------------------------------------------

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
  return relativeDepth >= 0 && relativeDepth < CodeGraphExtract.VIEW_DEPTH
}

export * as CodeGraph from "./codegraph"
