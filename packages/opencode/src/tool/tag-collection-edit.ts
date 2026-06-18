import { Effect, Schema } from "effect"
import { CodeGraph } from "@/codegraph/codegraph"
import { MAX_TAGS } from "@/codegraph/collections"
import * as Tool from "./tool"

// Edit a user-defined collection in place. Cosmetic changes (name, description,
// palette, tag labels, directories) re-paint instantly. Structural changes — adding
// or removing a tag, changing a tag's definition, or changing the tagging prompt —
// clear the collection's inferred tags so the background sweep re-tags from scratch
// (this costs tokens). To merely combine two existing tags, use
// tag_collection_merge_tags instead (deterministic and free). Built-ins can't be edited.

export const Parameters = Schema.Struct({
  collection: Schema.String.annotate({
    description: "The id or name of the user collection to edit (see tag_collection_list).",
  }),
  name: Schema.optional(Schema.String).annotate({ description: "New collection name (optional)." }),
  description: Schema.optional(Schema.String).annotate({ description: "New one-line description (optional)." }),
  palette: Schema.optional(Schema.Literals(["pastel", "dark", "bright", "earthy"])).annotate({
    description: "New colour palette (optional). Cosmetic — re-colours without re-tagging.",
  }),
  prompt: Schema.optional(Schema.String).annotate({
    description: "New tagging prompt (optional). Changing it re-tags the whole repo from scratch.",
  }),
  tags: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.optional(Schema.String).annotate({
          description: "Existing tag id to keep (preserves its already-tagged files). Omit for a brand-new tag.",
        }),
        label: Schema.String.annotate({ description: "Short tag name shown in the legend." }),
        description: Schema.String.annotate({ description: "Definition the tagging model applies." }),
      }),
    ),
  ).annotate({
    description: `The COMPLETE desired tag list (replaces the current one), 1–${MAX_TAGS}. Pass each surviving tag's id to keep its files; adding/removing/redefining tags re-tags from scratch. Do NOT include a catch-all/"other" tag — one is added automatically.`,
  }),
  directories: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "New repo-relative focus directories the tagger paints first (optional). Cosmetic — no re-tag.",
  }),
})

export const TagCollectionEditTool = Tool.define(
  "tag_collection_edit",
  Effect.gen(function* () {
    const codegraph = yield* CodeGraph.Service

    return {
      description: [
        "Edit a user-defined code-graph collection in place. Cosmetic changes (name, description, palette, tag",
        "labels, directories) re-paint instantly; structural changes (add/remove a tag, redefine a tag, or change",
        "the prompt) re-tag the whole repo from scratch (costs tokens). To combine two existing tags use",
        "tag_collection_merge_tags instead. Built-in collections cannot be edited.",
      ].join(" "),
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (params.tags && (params.tags.length === 0 || params.tags.length > MAX_TAGS)) {
            return {
              title: "Invalid collection",
              metadata: {},
              output: `A collection needs between 1 and ${MAX_TAGS} tags (got ${params.tags.length}).`,
            }
          }
          const result = yield* codegraph.editCollection({
            collection: params.collection,
            name: params.name,
            description: params.description,
            palette: params.palette,
            prompt: params.prompt,
            tags: params.tags?.map((t) => ({ id: t.id, label: t.label, description: t.description })),
            directories: params.directories,
          })
          switch (result.status) {
            case "not-found":
              return {
                title: "Unknown collection",
                metadata: {},
                output: `No user collection matches "${params.collection}". Run tag_collection_list to see the options.`,
              }
            case "builtin":
              return {
                title: "Built-in collection",
                metadata: {},
                output: `"${params.collection}" is a built-in collection and can't be edited. Create a new collection instead.`,
              }
            case "unknown-tag":
              return {
                title: "Unknown tag",
                metadata: {},
                output: `Tag "${result.tag}" isn't in that collection.`,
              }
            case "ok":
              return {
                title: `Edited ${result.collection.name}`,
                metadata: {},
                output: [
                  `Updated "${result.collection.name}". Tags:`,
                  ...result.collection.tags.map((t) => `- ${t.label} [${t.id}]: ${t.description}`),
                  "",
                  result.structural
                    ? "This was a structural change — the collection's tags were cleared and the background tagger will re-tag the repo from scratch."
                    : "This was a cosmetic change — the code graph re-paints immediately, no re-tagging needed.",
                ].join("\n"),
              }
          }
        }),
    }
  }),
)
