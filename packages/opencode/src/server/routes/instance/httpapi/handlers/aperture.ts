import { Aperture } from "@/aperture/aperture"
import { legend } from "@/aperture/lenses"
import * as StudyLog from "@/aperture/study-log"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import type { InteractionInput } from "../groups/aperture"

export const apertureHandlers = HttpApiBuilder.group(InstanceHttpApi, "aperture", (handlers) =>
  Effect.gen(function* () {
    const aperture = yield* Aperture.Service

    const get = Effect.fn("ApertureHttpApi.get")(function* (ctx: {
      query: { scope?: string; refresh?: "true" | "false"; drill?: string }
    }) {
      // Drilling supersedes refresh/get: the drilled file's content is re-read each
      // call, so its extents are always fresh while the window structure is reused.
      if (ctx.query.drill) return yield* aperture.drill(ctx.query.drill, ctx.query.scope)
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

    const listLenses = Effect.fn("ApertureHttpApi.listLenses")(function* () {
      const all = yield* aperture.lenses()
      const active = yield* aperture.activeLens()
      return all.map((lens) => ({
        id: lens.id,
        name: lens.name,
        description: lens.description,
        scope: lens.scope,
        builtin: lens.scope === "global",
        active: lens.id === active.id,
      }))
    })

    const selectLens = Effect.fn("ApertureHttpApi.selectLens")(function* (ctx: { query: { lens: string } }) {
      const found = yield* aperture.selectLens(ctx.query.lens)
      if (!found) return { status: "not-found" as const }
      return { status: "ok" as const, active: { id: found.id, name: found.name, legend: legend(found) } }
    })

    const interaction = Effect.fn("ApertureHttpApi.interaction")(function* (ctx: {
      payload: typeof InteractionInput.Type
    }) {
      const p = ctx.payload
      yield* StudyLog.record(p.sessionID, {
        type: "click",
        interaction: p.interaction,
        ...(p.scope !== undefined ? { scope: p.scope } : {}),
        ...(p.drill !== undefined ? { drill: p.drill } : {}),
        ...(p.lens !== undefined ? { lens: p.lens } : {}),
        ...(p.detail !== undefined ? { detail: p.detail } : {}),
      })
      return true
    })

    return handlers
      .handle("get", get)
      .handle("cycleLens", cycleLens)
      .handle("deleteLens", deleteLens)
      .handle("listLenses", listLenses)
      .handle("selectLens", selectLens)
      .handle("interaction", interaction)
  }),
)
