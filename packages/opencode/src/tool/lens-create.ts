import { Effect, Schema } from "effect"
import { Aperture } from "@/aperture/aperture"
import { MAX_FACETS } from "@/aperture/lenses"
import * as Tool from "./tool"

// Defines a new per-project Lens from a proposed schema and makes it
// active. Additive only — a fresh Lens id is minted and no existing
// Lens (or its painted results) is ever overwritten. Used by the `/lens` flow
// once the user approves a proposed schema; the painter then paints
// the Aperture view for the new Lens.

export const Parameters = Schema.Struct({
  name: Schema.String.annotate({ description: 'Short human name for the Lens, e.g. "Auth flow".' }),
  description: Schema.String.annotate({ description: "One-line summary of what this Lens captures." }),
  palette: Schema.Literals(["pastel", "dark", "bright", "earthy"]).annotate({
    description: "Colour palette — one of the four predefined categorical palettes (pastel, dark, bright, earthy).",
  }),
  prompt: Schema.String.annotate({
    description:
      "Instruction sentence(s) handed to the painter model describing how to classify each file into this Lens's facets.",
  }),
  facets: Schema.Array(
    Schema.Struct({
      label: Schema.String.annotate({ description: "Short facet name shown in the legend." }),
      description: Schema.String.annotate({
        description: "Definition the painter model uses to decide whether a file belongs to this facet.",
      }),
    }),
  ).annotate({
    description: `The Lens's facets. Between 1 and ${MAX_FACETS} (the palette size). Do NOT include a catch-all/"other"/"misc"/"none" facet — a universal "Other" bucket is added automatically for files matching no facet.`,
  }),
  directories: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Optional repo-relative directories (no leading slash) most relevant to this Lens — e.g. those surfaced while exploring. The painter paints these first, then the rest of the repo; it never restricts the sweep. Omit when there's no obvious focus area.",
  }),
  activate: Schema.optional(Schema.Boolean).annotate({
    description:
      "Whether to make this the active Lens. Defaults to true: the Aperture view switches to it and the painter begins painting. Pass false to create without changing what the user is currently viewing — the Lens is persisted but stays unpainted until it is selected. Use false when creating a Lens opportunistically (not at the user's explicit request) so their current view is undisturbed.",
  }),
})

export const LensCreateTool = Tool.define(
  "lens_create",
  Effect.gen(function* () {
    const aperture = yield* Aperture.Service

    return {
      description: [
        "Define a new per-project Aperture Lens from an approved schema and make it active.",
        `Provide a name, description, one of the four palettes, the painter prompt, and 1–${MAX_FACETS} facets`,
        "(each with a label and a definition). Existing Lenses are never overwritten. After creation the",
        "Aperture view re-paints with this Lens and the painter begins classifying files.",
      ].join(" "),
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (params.facets.length === 0 || params.facets.length > MAX_FACETS) {
            return {
              title: "Invalid Lens",
              metadata: {},
              output: `A Lens needs between 1 and ${MAX_FACETS} facets (got ${params.facets.length}). Trim or merge facets and try again.`,
            }
          }

          const created = yield* aperture.createLens({
            name: params.name,
            description: params.description,
            palette: params.palette,
            prompt: params.prompt,
            facets: params.facets.map((t) => ({ label: t.label, description: t.description })),
            directories: params.directories,
            activate: params.activate,
          })

          const activated = params.activate !== false
          return {
            title: `Created Lens: ${created.name}`,
            metadata: {},
            output: [
              activated
                ? `Created and activated Lens "${created.name}" (id: ${created.id}, palette: ${created.palette}).`
                : `Created Lens "${created.name}" (id: ${created.id}, palette: ${created.palette}) without activating it — the user's current view is unchanged.`,
              "Facets:",
              ...created.facets.map((t) => `- ${t.label} [${t.id}] ${t.color}: ${t.description}`),
              "",
              activated
                ? "The Aperture view will re-paint with this Lens and painting will run in the background."
                : "The Lens stays unpainted until it is selected; it will paint once the user switches to it.",
            ].join("\n"),
          }
        }),
    }
  }),
)
