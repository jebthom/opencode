import { Effect, Schema } from "effect"
import { CodeGraph } from "@/codegraph/codegraph"
import * as Tool from "./tool"

// Deterministically combine two tags of a user-defined collection: every file tagged
// `from` is re-labelled `into` and the `from` tag is dropped from the legend. This is
// a pure rewrite of the stored tags — it costs no tokens and runs instantly, unlike an
// add/remove edit (which re-tags from scratch). Built-in collections can't be edited.

export const Parameters = Schema.Struct({
  collection: Schema.String.annotate({
    description: "The id or name of the user collection to edit (see tag_collection_list).",
  }),
  from: Schema.String.annotate({
    description: "The tag to fold away (id or label). Its files are re-labelled as `into` and it leaves the legend.",
  }),
  into: Schema.String.annotate({
    description: "The surviving tag (id or label) that `from`'s files are merged into.",
  }),
})

export const TagCollectionMergeTagsTool = Tool.define(
  "tag_collection_merge_tags",
  Effect.gen(function* () {
    const codegraph = yield* CodeGraph.Service

    return {
      description: [
        "Combine two tags of a user-defined code-graph collection deterministically:",
        "fold the `from` tag into `into`, re-labelling all of `from`'s files and removing it from the legend.",
        "Instant and free (no re-tagging). Use this to simplify a collection (e.g. merge Infra into Data)",
        "instead of editing — an add/remove edit re-tags the whole repo. Built-in collections cannot be edited.",
      ].join(" "),
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const result = yield* codegraph.mergeTags(params.collection, params.from, params.into)
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
                output: `Tag "${result.tag}" isn't in that collection. Run tag_collection_list / tag_collection_select to see its tags.`,
              }
            case "ok":
              return {
                title: `Merged into ${result.collection.name}`,
                metadata: {},
                output: [
                  `Combined "${params.from}" into "${params.into}" in "${result.collection.name}".`,
                  "Remaining tags:",
                  ...result.collection.tags.map((t) => `- ${t.label} [${t.id}]`),
                  "",
                  "The code graph re-paints immediately — no re-tagging needed.",
                ].join("\n"),
              }
          }
        }),
    }
  }),
)
