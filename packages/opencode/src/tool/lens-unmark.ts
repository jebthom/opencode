import { Effect, Schema } from "effect"
import { Aperture } from "@/aperture/aperture"
import { MAX_FACETS } from "@/aperture/lenses"
import * as StudyLog from "@/aperture/study-log"
import * as Tool from "./tool"
import { concernsOf, rosterLines, type Concern } from "./lens-mark"
import { actorOf, withConsent } from "./lens-consent"

// Remove a rule, or a whole concern, from an Aperture Lens — the counterpart to lens_mark, and the
// other half of the agent's curation. Deterministic and free, like every rule operation.
//
// Note that *hiding* a concern is a different thing and needs no tool: clicking its legend
// entry greys it out non-destructively, which is what makes several unrelated concerns on one
// Lens workable. Unmark is for a rule that is actually wrong (or too broad to paint).

export const Parameters = Schema.Struct({
  lens: Schema.String.annotate({
    description: "Id or name of the Lens to remove from (see lens_list).",
  }),
  rule: Schema.optional(Schema.String).annotate({
    description: "Rule id to remove — lens_mark returns it, and lens_list shows a Lens's rules.",
  }),
  facet: Schema.optional(Schema.String).annotate({
    description: [
      "Concern to remove ENTIRELY, with every rule pointing at it (id or label).",
      `Use this to free a slot when the Lens is at the ${MAX_FACETS}-concern cap.`,
    ].join(" "),
  }),
  reason: Schema.optional(Schema.String).annotate({
    description: "Why you are removing it, recorded in the Lens history the user can review.",
  }),
  requestedByUser: Schema.optional(Schema.Boolean).annotate({
    description: "True ONLY when the user explicitly asked for this removal in this conversation.",
  }),
})

export const LensUnmarkTool = Tool.define(
  "lens_unmark",
  Effect.gen(function* () {
    const aperture = yield* Aperture.Service

    return {
      description: [
        "Remove a rule from an Aperture Lens by rule id, or remove a whole concern along with every",
        "rule pointing at it. Instant and free. Use it for a rule that matched the wrong thing or is",
        "too broad to paint, to free a concern slot, or to retire a concern of yours that no longer",
        "helps the user. Removing one of the user's own concerns asks them first. To merely hide a",
        "concern, don't remove it: the user can grey it out by clicking its legend entry.",
      ].join(" "),
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          // One metadata shape across every return, as lens_facet_files does.
          const metadata: { lens?: string; removed?: number; facet?: string; concerns?: Concern[] } = {}
          // Exactly one target. Both or neither is a genuine ambiguity about what to delete, and
          // guessing at a destructive operation is the wrong default.
          if (!params.rule === !params.facet)
            return {
              title: "Nothing specified",
              metadata,
              output: "Pass exactly one of `rule` (a rule id) or `facet` (a concern and all its rules).",
            }

          const input = {
            lens: params.lens,
            ...(params.rule ? { rule: params.rule } : {}),
            ...(params.facet ? { facet: params.facet } : {}),
          }
          const actor = actorOf(ctx, params)
          const first = yield* aperture.unmarkLens(input, actor)
          const result =
            first.status === "needs-consent"
              ? yield* aperture.unmarkLens(
                  input,
                  yield* withConsent(
                    ctx,
                    actor,
                    first.lens,
                    params.facet
                      ? `remove the concern "${first.facet?.label ?? params.facet}" from "${first.lens.name}"`
                      : `remove rule ${params.rule} from "${first.lens.name}"`,
                  ),
                )
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
                output: `"${result.lens.name}" belongs to the user, and the removal was not approved.`,
              }
            case "unknown-rule":
              return {
                title: "Unknown rule",
                metadata,
                output: [
                  `"${params.rule}" isn't a rule on "${result.lens.name}".`,
                  ...rosterLines(result.lens),
                  "",
                  "Run lens_list to see the Lens's rules.",
                ].join("\n"),
              }
            case "unknown-facet":
              return {
                title: "Unknown concern",
                metadata,
                output: [
                  `"${params.facet}" isn't a concern on "${result.lens.name}".`,
                  ...rosterLines(result.lens),
                ].join("\n"),
              }
            case "ok": {
              const { lens, removedRules, removedFacet } = result
              yield* StudyLog.record(ctx.sessionID, {
                type: "rule",
                op: removedFacet ? "removed-facet" : "removed",
                agent: ctx.agent,
                lens: lens.id,
                ...(removedFacet ? { facet: removedFacet.id } : {}),
                rules: removedRules.map((r) => r.id),
              })
              return {
                title: removedFacet ? `Removed ${removedFacet.label}` : "Removed rule",
                metadata: Object.assign(metadata, {
                  lens: lens.id,
                  removed: removedRules.length,
                  ...(removedFacet ? { facet: removedFacet.id } : {}),
                  concerns: concernsOf(
                    removedFacet ? [removedFacet] : lens.facets.filter((f) => f.id === removedRules[0]?.facet),
                  ),
                }),
                output: [
                  removedFacet
                    ? `Removed the concern "${removedFacet.label}" [${removedFacet.id}] and its ${removedRules.length} rule${removedRules.length === 1 ? "" : "s"} from "${lens.name}".`
                    : `Removed rule ${removedRules[0]?.id} from "${lens.name}".`,
                  ...(result.written
                    ? []
                    : [
                        "",
                        "WARNING: the write to .opencode/aperture/lenses.json failed, so this removal may not persist.",
                      ]),
                  "",
                  `Concerns on "${lens.name}":`,
                  ...rosterLines(lens),
                ].join("\n"),
              }
            }
          }
        }),
    }
  }),
)
