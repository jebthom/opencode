import { Aperture } from "@/aperture/aperture"
import { ApertureEvent } from "@/aperture/event"
import { USER } from "@/aperture/lens-history"
import * as StudyLog from "@/aperture/study-log"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import type { FacetFilterInput, InteractionInput } from "../groups/aperture"

// Every mutation arriving over HTTP is the user's own action (a click in the top bar or the
// VSCode extension), so it is recorded in the Lens history as `USER`.
export const apertureHandlers = HttpApiBuilder.group(InstanceHttpApi, "aperture", (handlers) =>
  Effect.gen(function* () {
    const aperture = yield* Aperture.Service
    const events = yield* EventV2Bridge.Service

    const lines = Effect.fn("ApertureHttpApi.lines")(function* (ctx: { query: { path: string } }) {
      return yield* aperture.lines(ctx.query.path)
    })

    const history = Effect.fn("ApertureHttpApi.history")(function* (ctx: {
      query: { since?: number; sessionID?: string; turnID?: string; lens?: string; limit?: number }
    }) {
      return yield* aperture.history(ctx.query)
    })

    const facetMap = Effect.fn("ApertureHttpApi.facetMap")(function* () {
      return yield* aperture.facetMap()
    })

    const activity = Effect.fn("ApertureHttpApi.activity")(function* (ctx: {
      query: { sessionID: string; turns?: number }
    }) {
      return yield* aperture.activity(ctx.query.sessionID, ctx.query.turns)
    })

    const cycleLens = Effect.fn("ApertureHttpApi.cycleLens")(function* (ctx: {
      query: { direction: "next" | "prev" }
    }) {
      const active = yield* aperture.cycleLens(ctx.query.direction, USER)
      return active ? { active } : {}
    })

    const deleteLens = Effect.fn("ApertureHttpApi.deleteLens")(function* (ctx: { query: { lens: string } }) {
      const result = yield* aperture.deleteLens(ctx.query.lens, USER)
      if (result.status !== "ok") return { status: result.status }
      return { status: "ok" as const, ...(result.active ? { active: result.active } : {}) }
    })

    const listLenses = Effect.fn("ApertureHttpApi.listLenses")(function* () {
      const all = yield* aperture.lenses()
      const active = yield* aperture.activeLens()
      return all.map((lens) => ({
        id: lens.id,
        name: lens.name,
        description: lens.description,
        owner: lens.owner,
        active: lens.id === active?.id,
        facets: lens.facets.length,
        rules: lens.rules?.length ?? 0,
      }))
    })

    const selectLens = Effect.fn("ApertureHttpApi.selectLens")(function* (ctx: { query: { lens: string } }) {
      const result = yield* aperture.selectLens(ctx.query.lens, USER)
      if (result.status !== "ok") return { status: result.status }
      return { status: "ok" as const, active: Aperture.lensInfo(result.lens) }
    })

    // Replace the legend filter and tell the other surfaces (O4). The publish happens *inside the
    // request* on purpose: that is what has EventV2Bridge stamp the event's `location` from the
    // ambient instance, and without it the /event SSE filter drops the event and the VSCode
    // extension silently never greys.
    const facetFilter = Effect.fn("ApertureHttpApi.facetFilter")(function* (ctx: {
      payload: typeof FacetFilterInput.Type
    }) {
      const facets = yield* aperture.setFacetFilter(ctx.payload.facets)
      yield* events.publish(ApertureEvent.Event.FacetsFiltered, { facets })
      return facets
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
      .handle("lines", lines)
      .handle("history", history)
      .handle("facetMap", facetMap)
      .handle("activity", activity)
      .handle("cycleLens", cycleLens)
      .handle("deleteLens", deleteLens)
      .handle("listLenses", listLenses)
      .handle("selectLens", selectLens)
      .handle("facetFilter", facetFilter)
      .handle("interaction", interaction)
  }),
)
