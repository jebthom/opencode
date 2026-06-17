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
import { LAYER_HUE, LAYERS, type Layer as SemanticLayer } from "./semantics"

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

export interface Interface {
  // Cached payload for `scope` (default repo root); computes + persists on a miss
  // or when the scope has been marked dirty by a file change in its window.
  readonly get: (scope?: string) => Effect.Effect<CodeGraphPayload.Payload>
  // Recompute `scope` from disk, persist, and refresh the in-memory copy.
  readonly refresh: (scope?: string) => Effect.Effect<CodeGraphPayload.Payload>
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
    const subtreeCache = new Map<string, ReadonlyArray<{ id: string; path: string; size: number }>>()
    const subtreeFor = (directory: string) =>
      Effect.gen(function* () {
        const cached = subtreeCache.get(directory)
        if (cached) return cached
        const files = yield* CodeGraphExtract.listSubtree(directory, "").pipe(
          Effect.catch((cause) => {
            log.error("listSubtree failed", { directory, cause })
            return Effect.succeed([] as ReadonlyArray<{ id: string; path: string; size: number }>)
          }),
          Effect.provide(FSUtil.defaultLayer),
        )
        subtreeCache.set(directory, files)
        return files
      })

    const off = registerDisposer(async (directory) => {
      caches.delete(directory)
      subtreeCache.delete(directory)
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
        const key = directory + " " + scope
        if (inFlight.has(key)) return
        inFlight.add(key)
        yield* CodeGraphTagger.tagStale({ storage, events, provider, config }, directory, projectID, scope, fileNodes, "fg").pipe(
          tagGate.withPermits(1),
          Effect.ensuring(Effect.sync(() => inFlight.delete(key))),
          Effect.forkDetach,
        )
      })

    const finalize = (ctx: InstanceContext, scope: string, structure: CodeGraphPayload.Payload) =>
      Effect.gen(function* () {
        const store = yield* CodeGraphSemanticStore.read(storage, ctx.project.id)
        const semantics: Record<string, CodeGraphPayload.Semantic> = {}
        // The store holds only the semantic (layer); hue and tags are derived here,
        // so palette/vocabulary changes apply without a re-tag. Boundaries (step 6)
        // are painted from the same store so an out-of-window tile shows its
        // target's layer hue once that target has been tagged.
        const applySemantic = (id: string) => {
          const entry = store[id]
          if (entry) semantics[id] = { tags: [entry.layer], hue: LAYER_HUE[entry.layer], layer: entry.layer }
        }
        for (const node of structure.nodes) applySemantic(node.id)
        for (const boundary of structure.boundaries ?? []) applySemantic(boundary.id)
        // Paint each in-window directory as its subtree's layer composition: bucket
        // every descendant source file (full depth, from the cached membership) by its
        // tagged layer, summing both a file count and a byte sum so the renderer can
        // pick either metric. Derived here alongside `semantics` so the structure cache
        // stays pure and untagged.
        const subtree = yield* subtreeFor(ctx.directory)
        const composition = computeComposition(structure.nodes, subtree, store)
        yield* scheduleTag(ctx.directory, ctx.project.id, scope, structure.nodes, structure.boundaries ?? [])
        return { ...structure, semantics, composition }
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

    const backgroundLoop = (directory: string, projectID: string, wake: Queue.Queue<void>) =>
      Effect.gen(function* () {
        while (true) {
          const files = yield* CodeGraphExtract.listFilesDfs(directory).pipe(
            Effect.catchCause((cause) => {
              log.error("background enumerate failed", { projectID, cause })
              return Effect.succeed<ReadonlyArray<{ id: string; path: string }>>([])
            }),
            Effect.provide(FSUtil.defaultLayer),
          )
          // Always-written diagnostic so a bg loop that produces no request lines is
          // still visible in the perf log (distinguishes "loop never ran" from
          // "ran but every slice was already tagged / no model").
          yield* CodeGraphTagger.appendPerfEvent(directory, "bg", "pass-start", { files: files.length })
          for (let cursor = 0; cursor < files.length; cursor += BG_BATCH) {
            const slice = files.slice(cursor, cursor + BG_BATCH)
            // scope "" — the tag store is keyed by stable node id, so a file tagged
            // here is reused in every window it later appears in. The permit is held
            // only for the batch; the pause below runs without it so foreground wins.
            yield* CodeGraphTagger.tagStale({ storage, events, provider, config }, directory, projectID, "", slice, "bg").pipe(
              tagGate.withPermits(1),
              Effect.catchCause((cause) =>
                Effect.sync(() => log.error("background batch failed", { projectID, cause })),
              ),
            )
            yield* Effect.sleep(BG_BATCH_DELAY)
          }
          yield* Queue.take(wake)
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
        // membership (and thus composition) is stale — rebuild it on the next read.
        subtreeCache.delete(directory)
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
        subtreeCache.delete(directory)
        yield* wakeBackground(directory)
      })
    yield* Effect.forkScoped(
      events.subscribe(SessionStatus.Event.Status).pipe(
        Stream.runForEach((event) =>
          event.data.status.type === "idle" ? onSessionIdle(event.location) : Effect.void,
        ),
      ),
    )

    return Service.of({
      get: (scope) => load(scope),
      refresh: (scope) => refresh(scope),
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
)

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
): Record<string, CodeGraphPayload.Composition> {
  const dirs = nodes.filter((n) => n.kind === "directory").map((d) => ({ id: d.id, prefix: d.path + "/" }))
  if (dirs.length === 0) return {}
  const tagged = new Map<string, Map<SemanticLayer, { count: number; bytes: number }>>()
  const subtree = new Map<string, { count: number; bytes: number }>()
  for (const file of files) {
    const layer = store[file.id]?.layer
    for (const dir of dirs) {
      if (!file.path.startsWith(dir.prefix)) continue
      const s = subtree.get(dir.id) ?? { count: 0, bytes: 0 }
      s.count += 1
      s.bytes += file.size
      subtree.set(dir.id, s)
      if (!layer) continue
      let byLayer = tagged.get(dir.id)
      if (!byLayer) tagged.set(dir.id, (byLayer = new Map()))
      const w = byLayer.get(layer) ?? { count: 0, bytes: 0 }
      w.count += 1
      w.bytes += file.size
      byLayer.set(layer, w)
    }
  }
  // Emit an entry for every directory that has any descendant file, even when none
  // are tagged (empty `weights`) — that's the grey case the renderer sizes by subtree.
  const result: Record<string, CodeGraphPayload.Composition> = {}
  for (const [id, s] of subtree) {
    const byLayer = tagged.get(id)
    // Weights in the fixed LAYERS order so the payload is stable and the renderer's
    // color bands are consistent.
    const weights = byLayer ? LAYERS.filter((l) => byLayer.has(l)).map((layer) => ({ layer, ...byLayer.get(layer)! })) : []
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
