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
  palette: Schema.Literals([
    "pastel",
    "dark",
    "bright",
    "earthy",
    "pastel-ordinal",
    "bright-ordinal",
    "dark-ordinal",
  ]).annotate({
    description:
      "Colour palette. Use a CATEGORICAL palette (pastel, dark, bright, earthy) for unordered facets — each facet gets a distinct hue. Use an ORDINAL palette (pastel-ordinal, bright-ordinal, dark-ordinal) ONLY when the facets have a natural order (e.g. low→high, few→many, small→large): these run a cool→warm ramp so a facet's colour encodes its rank, and the facets MUST be listed in that order.",
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
  context: Schema.optional(Schema.Literals(["minimal", "medium"])).annotate({
    description:
      "How much per-file context the painter sends the model. 'minimal' (default) uses the path, imports, and leading comment — enough to place a file by WHAT IT IS (its role/feature/layer). Choose 'medium' ONLY when the facets require judging the code's SHAPE or QUALITY (e.g. code smells, complexity, god files, test coverage): it additionally sends a cheap structural skeleton (exported names, file line count, and each top-level declaration's signature + length) — never a function body. Medium costs more input tokens per file, so prefer minimal unless the facets genuinely can't be decided from path/imports/comment alone.",
  }),
  activate: Schema.optional(Schema.Boolean).annotate({
    description:
      "Whether to make this the active Lens. Defaults to true: the Aperture view switches to it and the painter begins painting. Pass false to create without changing what the user is currently viewing — the Lens is persisted but stays unpainted until it is selected. Use false when creating a Lens opportunistically (not at the user's explicit request) so their current view is undisturbed.",
  }),
  parent: Schema.optional(
    Schema.Struct({
      lens: Schema.String.annotate({ description: "Id (or name) of the Lens to drill into." }),
      facets: Schema.Array(Schema.String).annotate({
        description:
          'The facets of that Lens whose files this Lens is scoped to — facet ids or labels (get them from lens_list). Use "Other" to drill into the files the parent Lens covered with none of its facets.',
      }),
    }),
  ).annotate({
    description:
      'Makes this a DRILL-DOWN of an existing Lens: its domain is exactly the files that Lens painted into the named facets. Only those files are shown to the painter; every other file in the repo is bucketed into "Other" with no model call, so a drill-down can never include a file that was not in the facet you drilled into. Set this whenever the user wants to look more closely INSIDE part of an existing Lens (e.g. "dive into the Likely facet of my bottlenecks Lens"). Your facets must draw distinctions WITHIN that domain — never restate the parent\'s criterion.',
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

          const result = yield* aperture.createLens({
            name: params.name,
            description: params.description,
            palette: params.palette,
            prompt: params.prompt,
            facets: params.facets.map((t) => ({ label: t.label, description: t.description })),
            directories: params.directories,
            context: params.context,
            activate: params.activate,
            parent: params.parent,
          })

          // A drill-down scope that doesn't resolve is refused rather than silently dropped:
          // creating the Lens anyway would paint the whole repo, which is precisely the
          // confusion the user asked to avoid.
          if (result.status !== "ok") {
            const reason =
              result.status === "unknown-parent"
                ? `No Lens matches "${result.parent}". Call lens_list and use an exact id.`
                : result.status === "unknown-facet"
                  ? `That Lens has no facet(s): ${result.facets.join(", ")}. Call lens_list for its facet ids, or use "Other".`
                  : result.status === "empty-scope"
                    ? "A drill-down needs at least one parent facet to scope to."
                    : `Drill-downs can only nest ${result.max} deep.`
            return { title: "Invalid Lens", metadata: {}, output: `Lens not created. ${reason}` }
          }

          const created = result.lens
          const activated = params.activate !== false
          const scope = created.parent
            ? `Scoped to ${created.parent.facets.length} facet(s) of [${created.parent.lens}] — every file outside them is bucketed into "Other" without a model call.`
            : undefined
          return {
            title: `Created Lens: ${created.name}`,
            metadata: {},
            output: [
              activated
                ? `Created and activated Lens "${created.name}" (id: ${created.id}, palette: ${created.palette}).`
                : `Created Lens "${created.name}" (id: ${created.id}, palette: ${created.palette}) without activating it — the user's current view is unchanged.`,
              ...(scope ? [scope] : []),
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
