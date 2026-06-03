import { Effect, Layer, Context } from "effect"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import * as Log from "@opencode-ai/core/util/log"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Storage } from "@/storage/storage"
import { InstanceState } from "@/effect/instance-state"
import { CodeGraphPayload } from "./payload"
import { CodeGraphExtract } from "./extract"

// Server-side code-graph service (PLAN.md step 1). Owns the deterministic
// payload: computes it from the working directory, caches it durably per project
// via Storage, and keeps a per-instance in-memory copy via InstanceState.
//
// Structure is stable across runs because the storage key is the project id and
// node ids are path-derived. The async `semantics` layer is overlaid later
// without recomputing structure.

const log = Log.create({ service: "codegraph" })

// Storage key: ["codegraph", <projectID>, "structure"]. Keyed by project id so
// each project keeps its own stable graph.
function storageKey(projectID: string) {
  return ["codegraph", projectID, "structure"]
}

export interface Interface {
  // Cached payload for the active instance; computes + persists on first miss.
  readonly get: () => Effect.Effect<CodeGraphPayload.Payload>
  // Recompute from disk, persist, and update the in-memory copy.
  readonly refresh: () => Effect.Effect<CodeGraphPayload.Payload>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CodeGraph") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const storage = yield* Storage.Service

    const empty = {
      version: CodeGraphPayload.PAYLOAD_VERSION,
      nodes: [],
      edges: [],
      semantics: {},
    } satisfies CodeGraphPayload.Payload

    // FS failures degrade to an empty payload rather than crashing the UI.
    const compute = Effect.fn("CodeGraph.compute")(
      function* (directory: string, projectID: string) {
        const payload = yield* CodeGraphExtract.extract(directory).pipe(
          Effect.catch((cause) => {
            log.error("extract failed", { projectID, cause })
            return Effect.succeed(empty)
          }),
        )
        yield* storage.write(storageKey(projectID), payload).pipe(Effect.ignore)
        log.info("computed", { projectID, nodes: payload.nodes.length, edges: payload.edges.length })
        return payload
      },
      Effect.provide(FSUtil.defaultLayer),
    )

    const state = yield* InstanceState.make(
      Effect.fn("CodeGraph.state")(function* (ctx) {
        const cached = yield* storage
          .read<CodeGraphPayload.Payload>(storageKey(ctx.project.id))
          .pipe(Effect.catch(() => Effect.void))
        if (cached && cached.version === CodeGraphPayload.PAYLOAD_VERSION) return cached
        return yield* compute(ctx.directory, ctx.project.id)
      }),
    )

    return Service.of({
      get: () => InstanceState.get(state),
      refresh: () =>
        Effect.gen(function* () {
          const ctx = yield* InstanceState.context
          const payload = yield* compute(ctx.directory, ctx.project.id)
          yield* InstanceState.invalidate(state)
          return payload
        }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Storage.defaultLayer))

export * as CodeGraph from "./codegraph"
