import { Aperture } from "@/aperture/aperture"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const apertureHandlers = HttpApiBuilder.group(InstanceHttpApi, "aperture", (handlers) =>
  Effect.gen(function* () {
    const aperture = yield* Aperture.Service

    const get = Effect.fn("ApertureHttpApi.get")(function* (ctx: {
      query: { scope?: string; refresh?: "true" | "false" }
    }) {
      if (ctx.query.refresh === "true") return yield* aperture.refresh(ctx.query.scope)
      return yield* aperture.get(ctx.query.scope)
    })

    const cycleLens = Effect.fn("ApertureHttpApi.cycleLens")(function* (ctx: {
      query: { direction: "next" | "prev" }
    }) {
      return yield* aperture.cycleLens(ctx.query.direction)
    })

    const deleteLens = Effect.fn("ApertureHttpApi.deleteLens")(function* (ctx: {
      query: { lens: string }
    }) {
      const result = yield* aperture.deleteLens(ctx.query.lens)
      return result.status === "ok" ? { status: "ok" as const, active: result.active } : { status: result.status }
    })

    return handlers
      .handle("get", get)
      .handle("cycleLens", cycleLens)
      .handle("deleteLens", deleteLens)
  }),
)
