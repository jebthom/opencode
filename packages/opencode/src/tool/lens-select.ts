import { Effect, Schema } from "effect"
import { Aperture } from "@/aperture/aperture"
import * as Tool from "./tool"

// Switches the active Aperture Lens by id or name. The view re-paints
// from the selected Lens's own (cached) facet results — switching back to a
// previously-painted Lens is free (no tokens). Files not yet painted for the
// selected Lens are picked up by the foreground/background painters.

export const Parameters = Schema.Struct({
  lens: Schema.String.annotate({
    description: "The id or name of the Lens to activate (see lens_list).",
  }),
})

export const LensSelectTool = Tool.define(
  "lens_select",
  Effect.gen(function* () {
    const aperture = yield* Aperture.Service

    return {
      description:
        "Switch the active Aperture Lens by id or name. Re-paints from that Lens's cached facets; switching back to a previously-painted Lens costs nothing.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const found = yield* aperture.selectLens(params.lens)
          if (!found) {
            const all = yield* aperture.lenses()
            return {
              title: "Unknown Lens",
              metadata: {},
              output: [
                `No Lens matches "${params.lens}".`,
                "Available:",
                ...all.map((c) => `- ${c.name} [${c.id}]`),
              ].join("\n"),
            }
          }
          return {
            title: `Active Lens: ${found.name}`,
            metadata: {},
            output: `Switched the active Lens to "${found.name}" (id: ${found.id}). The Aperture view will re-paint.`,
          }
        }),
    }
  }),
)
