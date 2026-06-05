import { Effect, Layer, Context, Stream } from "effect"
import path from "path"
import { createHash } from "crypto"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import * as Log from "@opencode-ai/core/util/log"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EventV2 } from "@opencode-ai/core/event"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Storage } from "@/storage/storage"
import { InstanceState } from "@/effect/instance-state"
import { registerDisposer } from "@/effect/instance-registry"
import { CodeGraphPayload } from "./payload"
import { CodeGraphExtract } from "./extract"
import { CodeGraphEvent } from "./event"

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

const log = Log.create({ service: "codegraph" })

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

    const off = registerDisposer(async (directory) => {
      caches.delete(directory)
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

    const load = Effect.fn("CodeGraph.load")(function* (scope?: string) {
      const ctx = yield* InstanceState.context
      const container = containerFor(ctx.directory, ctx.project.id)
      const norm = CodeGraphExtract.normalizeScope(scope ?? "")

      if (!container.dirty.has(norm)) {
        const inMemory = container.scopes.get(norm)
        if (inMemory) return inMemory
        const cached = yield* storage
          .read<CodeGraphPayload.Payload>(storageKey(ctx.project.id, norm))
          .pipe(Effect.catch(() => Effect.void))
        if (cached && cached.version === CodeGraphPayload.PAYLOAD_VERSION) {
          container.scopes.set(norm, cached)
          return cached
        }
      }

      const payload = yield* compute(ctx.directory, ctx.project.id, norm)
      container.scopes.set(norm, payload)
      container.dirty.delete(norm)
      return payload
    })

    const refresh = Effect.fn("CodeGraph.refresh")(function* (scope?: string) {
      const ctx = yield* InstanceState.context
      const container = containerFor(ctx.directory, ctx.project.id)
      const norm = CodeGraphExtract.normalizeScope(scope ?? "")
      const payload = yield* compute(ctx.directory, ctx.project.id, norm)
      container.scopes.set(norm, payload)
      container.dirty.delete(norm)
      return payload
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
        for (const scope of container.scopes.keys()) {
          if (!isWithinWindow(scope, rel)) continue
          container.dirty.add(scope)
          yield* events
            .publish(CodeGraphEvent.Event.Invalidated, { scope }, location ? { location } : undefined)
            .pipe(Effect.ignore)
        }
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

    return Service.of({
      get: (scope) => load(scope),
      refresh: (scope) => refresh(scope),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Storage.defaultLayer), Layer.provide(EventV2.defaultLayer))

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
