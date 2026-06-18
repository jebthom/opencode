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

    const cycleCollection = Effect.fn("CodeGraphHttpApi.cycleCollection")(function* (ctx: {
      query: { direction: "next" | "prev" }
    }) {
      return yield* codegraph.cycleCollection(ctx.query.direction)
    })

    const deleteCollection = Effect.fn("CodeGraphHttpApi.deleteCollection")(function* (ctx: {
      query: { collection: string }
    }) {
      const result = yield* codegraph.deleteCollection(ctx.query.collection)
      return result.status === "ok" ? { status: "ok" as const, active: result.active } : { status: result.status }
    })

    return handlers
      .handle("get", get)
      .handle("cycleCollection", cycleCollection)
      .handle("deleteCollection", deleteCollection)
  }),
)
