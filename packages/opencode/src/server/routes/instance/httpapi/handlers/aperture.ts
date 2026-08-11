import { Aperture } from "@/aperture/aperture"
import { ApertureEvent } from "@/aperture/event"
import { legend, orderForest } from "@/aperture/lenses"
import * as StudyLog from "@/aperture/study-log"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import type { FacetFilterInput, InteractionInput, ScopeFocusInput } from "../groups/aperture"

export const apertureHandlers = HttpApiBuilder.group(InstanceHttpApi, "aperture", (handlers) =>
  Effect.gen(function* () {
    const aperture = yield* Aperture.Service
    const events = yield* EventV2Bridge.Service

    const get = Effect.fn("ApertureHttpApi.get")(function* (ctx: {
      query: { scope?: string; refresh?: "true" | "false"; drill?: string }
    }) {
      // Drilling supersedes refresh/get: the drilled file's content is re-read each
      // call, so its extents are always fresh while the window structure is reused.
      if (ctx.query.drill) return yield* aperture.drill(ctx.query.drill, ctx.query.scope)
      if (ctx.query.refresh === "true") return yield* aperture.refresh(ctx.query.scope)
      return yield* aperture.get(ctx.query.scope)
    })

    const facetMap = Effect.fn("ApertureHttpApi.facetMap")(function* () {
      return yield* aperture.facetMap()
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
      // `all` is already in DFS-forest order; orderForest re-derives each Lens's depth and
      // the scope of its root ancestor, which is what the picker indents and groups on.
      return orderForest(all).map(({ lens, depth, rootScope }) => ({
        id: lens.id,
        name: lens.name,
        description: lens.description,
        scope: lens.scope,
        builtin: lens.scope === "global",
        active: lens.id === active.id,
        ...(lens.parent ? { parent: lens.parent.lens } : {}),
        depth,
        rootScope,
      }))
    })

    const selectLens = Effect.fn("ApertureHttpApi.selectLens")(function* (ctx: { query: { lens: string } }) {
      const found = yield* aperture.selectLens(ctx.query.lens)
      if (!found) return { status: "not-found" as const }
      return { status: "ok" as const, active: { id: found.id, name: found.name, legend: legend(found) } }
    })

    // Replace the legend filter and tell the other surfaces (O4). The publish happens
    // *inside the request* on purpose: that's what has EventV2Bridge stamp the event's
    // `location` from the ambient instance, and without it the /event SSE filter drops the
    // event and the VSCode extension silently never greys (the same trap as
    // aperture.invalidated — see painter.ts publishInvalidated).
    const facetFilter = Effect.fn("ApertureHttpApi.facetFilter")(function* (ctx: {
      payload: typeof FacetFilterInput.Type
    }) {
      const facets = yield* aperture.setFacetFilter(ctx.payload.facets)
      yield* events.publish(ApertureEvent.Event.FacetsFiltered, { facets })
      return facets
    })

    // Re-root the view somewhere else, on behalf of a host surface. Publishes and nothing
    // more: the bar refetches because its scope changed, which is the same path a click on a
    // directory block takes. Published inside the request for the same reason facetFilter is
    // — that is what stamps the event's `location`, without which the /event SSE filter drops
    // it before any other surface sees it.
    const focusScope = Effect.fn("ApertureHttpApi.focusScope")(function* (ctx: {
      payload: typeof ScopeFocusInput.Type
    }) {
      yield* events.publish(ApertureEvent.Event.ScopeFocused, { scope: ctx.payload.scope })
      return true
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
      .handle("facetMap", facetMap)
      .handle("cycleLens", cycleLens)
      .handle("deleteLens", deleteLens)
      .handle("listLenses", listLenses)
      .handle("selectLens", selectLens)
      .handle("facetFilter", facetFilter)
      .handle("focusScope", focusScope)
      .handle("interaction", interaction)
  }),
)
