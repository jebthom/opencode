import { Effect, Schema } from "effect"
import { Aperture } from "@/aperture/aperture"
import * as Tool from "./tool"

// Deterministically combine two facets of a user-defined Lens: every file painted
// `from` is re-labelled `into` and the `from` facet is dropped from the legend. This is
// a pure rewrite of the stored facets — it costs no tokens and runs instantly, unlike an
// add/remove edit (which re-paints from scratch). Built-in Lenses can't be edited.

export const Parameters = Schema.Struct({
  lens: Schema.String.annotate({
    description: "The id or name of the user Lens to edit (see lens_list).",
  }),
  from: Schema.String.annotate({
    description: "The facet to fold away (id or label). Its files are re-labelled as `into` and it leaves the legend.",
  }),
  into: Schema.String.annotate({
    description: "The surviving facet (id or label) that `from`'s files are merged into.",
  }),
})

export const LensMergeFacetsTool = Tool.define(
  "lens_merge_facets",
  Effect.gen(function* () {
    const aperture = yield* Aperture.Service

    return {
      description: [
        "Combine two facets of a user-defined Aperture Lens deterministically:",
        "fold the `from` facet into `into`, re-labelling all of `from`'s files and removing it from the legend.",
        "Instant and free (no re-painting). Use this to simplify a Lens (e.g. merge Infra into Data)",
        "instead of editing — an add/remove edit re-paints the whole repo. Built-in Lenses cannot be edited.",
      ].join(" "),
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const result = yield* aperture.mergeFacets(params.lens, params.from, params.into)
          switch (result.status) {
            case "not-found":
              return {
                title: "Unknown Lens",
                metadata: {},
                output: `No user Lens matches "${params.lens}". Run lens_list to see the options.`,
              }
            case "builtin":
              return {
                title: "Built-in Lens",
                metadata: {},
                output: `"${params.lens}" is a built-in Lens and can't be edited. Create a new Lens instead.`,
              }
            case "unknown-facet":
              return {
                title: "Unknown facet",
                metadata: {},
                output: `Facet "${result.facet}" isn't in that Lens. Run lens_list / lens_select to see its facets.`,
              }
            case "ok":
              return {
                title: `Merged into ${result.lens.name}`,
                metadata: {},
                output: [
                  `Combined "${params.from}" into "${params.into}" in "${result.lens.name}".`,
                  "Remaining facets:",
                  ...result.lens.facets.map((t) => `- ${t.label} [${t.id}]`),
                  "",
                  "The Aperture view re-paints immediately — no re-painting needed.",
                ].join("\n"),
              }
          }
        }),
    }
  }),
)
