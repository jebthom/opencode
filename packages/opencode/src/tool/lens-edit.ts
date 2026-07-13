import { Effect, Schema } from "effect"
import { Aperture } from "@/aperture/aperture"
import { MAX_FACETS } from "@/aperture/lenses"
import * as Tool from "./tool"

// Edit a user-defined Lens in place. Cosmetic changes (name, description,
// palette, facet labels, directories) re-paint instantly. Structural changes — adding
// or removing a facet, changing a facet's definition, or changing the painter prompt —
// clear the Lens's inferred facets so the background sweep re-paints from scratch
// (this costs tokens). To merely combine two existing facets, use
// lens_merge_facets instead (deterministic and free). Built-ins can't be edited.

export const Parameters = Schema.Struct({
  lens: Schema.String.annotate({
    description: "The id or name of the user Lens to edit (see lens_list).",
  }),
  name: Schema.optional(Schema.String).annotate({ description: "New Lens name (optional)." }),
  description: Schema.optional(Schema.String).annotate({ description: "New one-line description (optional)." }),
  palette: Schema.optional(
    Schema.Literals(["pastel", "dark", "bright", "earthy", "pastel-ordinal", "bright-ordinal", "dark-ordinal"]),
  ).annotate({
    description:
      "New colour palette (optional). Cosmetic — re-colours without re-painting. Categorical (pastel/dark/bright/earthy) for unordered facets; ordinal (*-ordinal) only when facets have a natural order.",
  }),
  prompt: Schema.optional(Schema.String).annotate({
    description: "New painter prompt (optional). Changing it re-paints the whole repo from scratch.",
  }),
  facets: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.optional(Schema.String).annotate({
          description: "Existing facet id to keep (preserves its already-painted files). Omit for a brand-new facet.",
        }),
        label: Schema.String.annotate({ description: "Short facet name shown in the legend." }),
        description: Schema.String.annotate({ description: "Definition the painter model applies." }),
      }),
    ),
  ).annotate({
    description: `The COMPLETE desired facet list (replaces the current one), 1–${MAX_FACETS}. Pass each surviving facet's id to keep its files; adding/removing/redefining facets re-paints from scratch. Do NOT include a catch-all/"other" facet — one is added automatically.`,
  }),
  directories: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "New repo-relative focus directories the painter paints first (optional). Cosmetic — no re-paint.",
  }),
  context: Schema.optional(Schema.Literals(["minimal", "medium"])).annotate({
    description:
      "New per-file painter context mode (optional). 'minimal' = path + imports + comment; 'medium' also sends a structural skeleton (exports, line count, per-declaration signatures + lengths) for Lenses that judge the code's shape/quality. Changing it re-paints the whole repo from scratch.",
  }),
})

export const LensEditTool = Tool.define(
  "lens_edit",
  Effect.gen(function* () {
    const aperture = yield* Aperture.Service

    return {
      description: [
        "Edit a user-defined Aperture Lens in place. Cosmetic changes (name, description, palette, facet",
        "labels, directories) re-paint instantly; structural changes (add/remove a facet, redefine a facet, or change",
        "the prompt) re-paint the whole repo from scratch (costs tokens). To combine two existing facets use",
        "lens_merge_facets instead. Built-in Lenses cannot be edited.",
      ].join(" "),
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (params.facets && (params.facets.length === 0 || params.facets.length > MAX_FACETS)) {
            return {
              title: "Invalid Lens",
              metadata: {},
              output: `A Lens needs between 1 and ${MAX_FACETS} facets (got ${params.facets.length}).`,
            }
          }
          const result = yield* aperture.editLens({
            lens: params.lens,
            name: params.name,
            description: params.description,
            palette: params.palette,
            prompt: params.prompt,
            facets: params.facets?.map((t) => ({ id: t.id, label: t.label, description: t.description })),
            directories: params.directories,
            context: params.context,
          })
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
                output: `Facet "${result.facet}" isn't in that Lens.`,
              }
            case "facet-in-use":
              return {
                title: "Facet in use",
                metadata: {},
                output: [
                  `Can't remove facet "${result.facet}": the drill-down Lens(es) ${result.lenses.map((l) => `"${l}"`).join(", ")} are scoped to it, and would be left with a domain that no longer exists.`,
                  "Either keep that facet, fold it into another with lens_merge_facets (which re-scopes the drill-downs onto the survivor), or delete the drill-downs first.",
                ].join(" "),
              }
            case "ok":
              return {
                title: `Edited ${result.lens.name}`,
                metadata: {},
                output: [
                  `Updated "${result.lens.name}". Facets:`,
                  ...result.lens.facets.map((t) => `- ${t.label} [${t.id}]: ${t.description}`),
                  "",
                  result.structural
                    ? "This was a structural change — the Lens's facets were cleared and the background painter will re-paint the repo from scratch."
                    : "This was a cosmetic change — the Aperture view re-paints immediately, no re-painting needed.",
                ].join("\n"),
              }
          }
        }),
    }
  }),
)
