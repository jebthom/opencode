import { CodeGraph } from "@/codegraph/codegraph"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const codegraphHandlers = HttpApiBuilder.group(InstanceHttpApi, "codegraph", (handlers) =>
  Effect.gen(function* () {
    const codegraph = yield* CodeGraph.Service

    const get = Effect.fn("CodeGraphHttpApi.get")(function* () {
      return yield* codegraph.get()
    })

    return handlers.handle("get", get)
  }),
)
