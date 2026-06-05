import { CodeGraph } from "@/codegraph/codegraph"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const codegraphHandlers = HttpApiBuilder.group(InstanceHttpApi, "codegraph", (handlers) =>
  Effect.gen(function* () {
    const codegraph = yield* CodeGraph.Service

    const get = Effect.fn("CodeGraphHttpApi.get")(function* (ctx: {
      query: { scope?: string; refresh?: "true" | "false" }
    }) {
      if (ctx.query.refresh === "true") return yield* codegraph.refresh(ctx.query.scope)
      return yield* codegraph.get(ctx.query.scope)
    })

    return handlers.handle("get", get)
  }),
)
