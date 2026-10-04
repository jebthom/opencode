import { Effect, Schema } from "effect"
import { Aperture } from "@/aperture/aperture"
import * as Tool from "./tool"
import { slugify } from "@/aperture/lenses"
import { concernsOf, rosterLines, type Concern } from "./lens-mark"
import { actorOf, withConsent } from "./lens-consent"

// Rename a Lens, or relabel/redefine its concerns. Changes no rule, so nothing is re-derived and
// the marks stay exactly where they are. Concerns are added and removed only by lens_mark and
// lens_unmark, which is what keeps every concern backed by at least one rule.

export const Parameters = Schema.Struct({
  lens: Schema.String.annotate({
    description: "The id or name of the Lens to edit (see lens_list).",
  }),
  name: Schema.optional(Schema.String).annotate({ description: "New Lens name." }),
  description: Schema.optional(Schema.String).annotate({ description: "New one-line Lens description." }),
  palette: Schema.optional(Schema.Literals(["categorical", "ordinal"])).annotate({
    description:
      'New colour palette. Both hold the same six colours: "categorical" for unordered concerns, "ordinal" only when the concerns have a natural order (listed lowest-first).',
  }),
  facets: Schema.optional(
    Schema.Array(
      Schema.Struct({
        facet: Schema.String.annotate({ description: "Existing concern id or label." }),
        label: Schema.optional(Schema.String).annotate({ description: "New legend label." }),
        description: Schema.optional(Schema.String).annotate({ description: "New one-line definition." }),
        facetReason: Schema.optional(Schema.String).annotate({
          description: "New reason: one sentence on how this concern helps the user understand the current task.",
        }),
      }),
    ),
  ).annotate({
    description: "Concerns to relabel, redefine or re-reason. Concerns not listed are unchanged.",
  }),
  reason: Schema.optional(Schema.String).annotate({
    description: "Why you are making this change, recorded in the Lens history the user can review.",
  }),
  requestedByUser: Schema.optional(Schema.Boolean).annotate({
    description: "True ONLY when the user explicitly asked for this edit in this conversation.",
  }),
})

export const LensEditTool = Tool.define(
  "lens_edit",
  Effect.gen(function* () {
    const aperture = yield* Aperture.Service

    return {
      description: [
        "Rename an Aperture Lens, change its palette, or relabel/redefine its concerns. Free, and the",
        "marks do not move. To add or remove a concern use lens_mark / lens_unmark. Editing one of the",
        "user's own Lenses asks them first.",
      ].join(" "),
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          // One metadata shape across every return, as the other lens tools do.
          const metadata: { lens?: string; concerns?: Concern[] } = {}
          const input = {
            lens: params.lens,
            ...(params.name ? { name: params.name } : {}),
            ...(params.description !== undefined ? { description: params.description } : {}),
            ...(params.palette ? { palette: params.palette } : {}),
            ...(params.facets
              ? {
                  facets: params.facets.map((f) => ({
                    ref: f.facet,
                    ...(f.label ? { label: f.label } : {}),
                    ...(f.description ? { description: f.description } : {}),
                    ...(f.facetReason ? { reason: f.facetReason } : {}),
                  })),
                }
              : {}),
          }
          const actor = actorOf(ctx, params)
          const first = yield* aperture.editLens(input, actor)
          const result =
            first.status === "needs-consent"
              ? yield* aperture.editLens(input, yield* withConsent(ctx, actor, first.lens, `edit "${first.lens.name}"`))
              : first

          switch (result.status) {
            case "not-found":
              return {
                title: "Unknown Lens",
                metadata,
                output: `No Lens matches "${params.lens}". Run lens_list to see the options.`,
              }
            case "needs-consent":
              return {
                title: "Not changed",
                metadata,
                output: `"${result.lens.name}" belongs to the user, and the edit was not approved.`,
              }
            case "unknown-facet":
              return {
                title: "Unknown concern",
                metadata,
                output: [
                  `"${result.facet}" isn't a concern on "${result.lens.name}".`,
                  ...rosterLines(result.lens),
                ].join("\n"),
              }
            case "ok":
              return {
                title: `Edited ${result.lens.name}`,
                metadata: Object.assign(metadata, {
                  lens: result.lens.id,
                  concerns: concernsOf(
                    result.lens.facets.filter((f) =>
                      params.facets?.some((e) => [f.id, f.label].includes(e.facet) || slugify(e.facet) === f.id),
                    ),
                  ),
                }),
                output: [
                  `Updated "${result.lens.name}" [${result.lens.id}].`,
                  ...(result.written
                    ? []
                    : ["WARNING: the write to .opencode/aperture/lenses.json failed, so this edit may not persist."]),
                  "",
                  "Concerns:",
                  ...rosterLines(result.lens),
                ].join("\n"),
              }
          }
        }),
    }
  }),
)
