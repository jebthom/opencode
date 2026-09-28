import { Effect, Schema } from "effect"
import { Aperture } from "@/aperture/aperture"
import * as Tool from "./tool"
import { actorOf, withConsent } from "./lens-consent"

// Switch the active Aperture Lens by id or name. Instant: a Lens's marks are derived from its
// rules on read, so there is nothing to wait for. Switching the view away from one of the user's
// own Lenses asks them first.

export const Parameters = Schema.Struct({
  lens: Schema.String.annotate({
    description: "The id or name of the Lens to activate (see lens_list).",
  }),
  reason: Schema.optional(Schema.String).annotate({
    description: "Why you are switching, recorded in the Lens history the user can review.",
  }),
  requestedByUser: Schema.optional(Schema.Boolean).annotate({
    description: "True ONLY when the user explicitly asked for this switch in this conversation.",
  }),
})

export const LensSelectTool = Tool.define(
  "lens_select",
  Effect.gen(function* () {
    const aperture = yield* Aperture.Service

    return {
      description:
        "Switch the active Aperture Lens by id or name. Instant. Switching away from one of the user's own Lenses asks them first.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const actor = actorOf(ctx, params)
          const first = yield* aperture.selectLens(params.lens, actor)
          const result =
            first.status === "needs-consent"
              ? yield* aperture.selectLens(
                  params.lens,
                  yield* withConsent(ctx, actor, first.lens, `switch the view away from "${first.lens.name}"`),
                )
              : first
          if (result.status === "ok")
            return {
              title: `Active Lens: ${result.lens.name}`,
              metadata: {},
              output: `Switched the active Lens to "${result.lens.name}" (id: ${result.lens.id}).`,
            }
          if (result.status === "needs-consent")
            return {
              title: "Not switched",
              metadata: {},
              output: `The user's Lens "${result.lens.name}" stays active; the switch was not approved.`,
            }
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
        }),
    }
  }),
)
