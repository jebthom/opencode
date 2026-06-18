import { Effect, Schema } from "effect"
import { CodeGraph } from "@/codegraph/codegraph"
import { MAX_TAGS } from "@/codegraph/collections"
import * as Tool from "./tool"

// Defines a new per-project tag collection from a proposed schema and makes it
// active. Additive only — a fresh collection id is minted and no existing
// collection (or its tagged results) is ever overwritten. Used by the `/tag` flow
// once the user approves a proposed schema; the existing tagging agent then paints
// the code graph for the new collection.

export const Parameters = Schema.Struct({
  name: Schema.String.annotate({ description: 'Short human name for the collection, e.g. "Auth flow".' }),
  description: Schema.String.annotate({ description: "One-line summary of what this collection captures." }),
  palette: Schema.Literals(["pastel", "dark", "bright", "earthy"]).annotate({
    description: "Colour palette — one of the four predefined categorical palettes (pastel, dark, bright, earthy).",
  }),
  prompt: Schema.String.annotate({
    description:
      "Instruction sentence(s) handed to the tagging model describing how to classify each file into this collection's tags.",
  }),
  tags: Schema.Array(
    Schema.Struct({
      label: Schema.String.annotate({ description: "Short tag name shown in the legend." }),
      description: Schema.String.annotate({
        description: "Definition the tagging model uses to decide whether a file belongs to this tag.",
      }),
    }),
  ).annotate({
    description: `The collection's tags. Between 1 and ${MAX_TAGS} (the palette size). Do NOT include a catch-all/"other"/"misc"/"none" tag — a universal "Other" bucket is added automatically for files matching no tag.`,
  }),
  directories: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Optional repo-relative directories (no leading slash) most relevant to this collection — e.g. those surfaced while exploring. The tagger paints these first, then the rest of the repo; it never restricts the sweep. Omit when there's no obvious focus area.",
  }),
  activate: Schema.optional(Schema.Boolean).annotate({
    description:
      "Whether to make this the active collection. Defaults to true: the code graph switches to it and the tagger begins painting. Pass false to create without changing what the user is currently viewing — the collection is persisted but stays untagged until it is selected. Use false when creating a collection opportunistically (not at the user's explicit request) so their current view is undisturbed.",
  }),
})

export const TagCollectionCreateTool = Tool.define(
  "tag_collection_create",
  Effect.gen(function* () {
    const codegraph = yield* CodeGraph.Service

    return {
      description: [
        "Define a new per-project code-graph tag collection from an approved schema and make it active.",
        `Provide a name, description, one of the four palettes, the tagging prompt, and 1–${MAX_TAGS} tags`,
        "(each with a label and a definition). Existing collections are never overwritten. After creation the",
        "code graph re-paints with this collection and the tagging agent begins classifying files.",
      ].join(" "),
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (params.tags.length === 0 || params.tags.length > MAX_TAGS) {
            return {
              title: "Invalid collection",
              metadata: {},
              output: `A collection needs between 1 and ${MAX_TAGS} tags (got ${params.tags.length}). Trim or merge tags and try again.`,
            }
          }

          const created = yield* codegraph.createCollection({
            name: params.name,
            description: params.description,
            palette: params.palette,
            prompt: params.prompt,
            tags: params.tags.map((t) => ({ label: t.label, description: t.description })),
            directories: params.directories,
            activate: params.activate,
          })

          const activated = params.activate !== false
          return {
            title: `Created collection: ${created.name}`,
            metadata: {},
            output: [
              activated
                ? `Created and activated collection "${created.name}" (id: ${created.id}, palette: ${created.palette}).`
                : `Created collection "${created.name}" (id: ${created.id}, palette: ${created.palette}) without activating it — the user's current view is unchanged.`,
              "Tags:",
              ...created.tags.map((t) => `- ${t.label} [${t.id}] ${t.color}: ${t.description}`),
              "",
              activated
                ? "The code graph will re-paint with this collection and tagging will run in the background."
                : "The collection stays untagged until it is selected; it will paint once the user switches to it.",
            ].join("\n"),
          }
        }),
    }
  }),
)
