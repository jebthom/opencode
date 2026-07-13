import { Effect, Schema } from "effect"
import { Aperture } from "@/aperture/aperture"
import { ApertureLensStore } from "@/aperture/lens-store"
import { ApertureLenses } from "@/aperture/lenses"
import * as Tool from "./tool"

// Lists the Aperture Lenses available in this project (the global
// built-ins plus any the user has defined) and which one is active, along with the
// predefined colour palettes. The `/lens` flow uses this to let the user pick an
// existing Lens or to inform a new schema proposal.

export const Parameters = Schema.Struct({})

export const LensListTool = Tool.define(
  "lens_list",
  Effect.gen(function* () {
    const aperture = yield* Aperture.Service

    return {
      description:
        "List the Aperture Lenses for this project (built-in + user-defined), the active one, and the available colour palettes.",
      parameters: Parameters,
      execute: (_params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const all = yield* aperture.lenses()
          const active = yield* aperture.activeLens()
          const palettes = ApertureLensStore.paletteSummary()

          const byId = new Map(all.map((c) => [c.id, c]))
          const lenses = all.map((c) => {
            const marker = c.id === active.id ? " (active)" : ""
            // Facet *ids* as well as labels: a drill-down's scope names facet ids, so a
            // listing that only showed labels couldn't be acted on.
            const facets = c.facets.map((t) => `${t.label} [${t.id}]`).join(", ")
            const lines = [`- ${c.name} [${c.id}] (${c.scope})${marker}: ${c.description}`]
            if (c.parent) {
              const parent = byId.get(c.parent.lens)
              const scope = ApertureLenses.scopeLabels(parent ?? c, c.parent.facets).join(", ")
              lines.push(`    drill-down of ${parent?.name ?? c.parent.lens} [${c.parent.lens}] — scoped to: ${scope}`)
            }
            lines.push(`    facets: ${facets}`)
            return lines.join("\n")
          })

          return {
            title: `${all.length} Lens(es)`,
            metadata: { active: active.id, count: all.length },
            output: [
              "Lenses:",
              ...lenses,
              "",
              `Active Lens: ${active.name} [${active.id}]`,
              "",
              "Palettes (each categorical, ~6 colours):",
              ...palettes.map((p) => `- ${p.id}: ${p.label} (${p.swatches} colours)`),
            ].join("\n"),
          }
        }),
    }
  }),
)
