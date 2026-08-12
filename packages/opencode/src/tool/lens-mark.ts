import { Effect, Schema } from "effect"
import { Aperture } from "@/aperture/aperture"
import {
  type Finder,
  type Lens,
  concernRoster,
  describeFinder,
  finderProblem,
  MAX_FACETS,
  MAX_RULE_HITS,
} from "@/aperture/lenses"
import * as StudyLog from "@/aperture/study-log"
import * as Tool from "./tool"

// Mark lines in the repo with a named *concern* on an Aperture Lens (S2). The persisted thing
// is the QUERY, not the lines: a finder is re-evaluated from disk at every payload read, so a
// deleted usage silently loses its paint and a new one gains it, with no anchoring and no
// "lost" state. See `aperture/lenses.ts` for the Finder union and `aperture/rules.ts` for the
// evaluator.
//
// Deterministic — no model call, no repaint, no tokens. The return value is the safety
// mechanism: an agent that writes a loose regex sees the hit count and narrows it instead of
// silently colouring a third of the repo.

// The finder is taken as a FLAT struct with a `kind` discriminator rather than a
// `Schema.Union` of the three shapes. A union mismatch fails during *decode*, upstream of
// `execute`, where the harness reports the generic "Please rewrite the input so it satisfies
// the expected schema" — uninterceptable, and telling the agent nothing about what was wrong.
// Flat means every shape mistake lands inside `execute`, where `finderProblem` can say
// `kind "symbol" needs "name"` out loud. (No tool in this repo uses Schema.Union;
// Schema.Literals is the house discriminator, and nested anyOf is the weakest part of
// JSON-Schema support across providers.)
export const Parameters = Schema.Struct({
  lens: Schema.String.annotate({
    description: [
      "Id or name of the Lens to mark on (see lens_list). A name that doesn't exist creates a",
      "Search Lens with that name — so give it a descriptive one ('Retry Handling', not 'search'),",
      "and check lens_list first so you add to an existing Lens instead of making a near-duplicate.",
    ].join(" "),
  }),
  facet: Schema.String.annotate({
    description: [
      "The concern these lines belong to, kebab-case: 'retry-path', 'any-casts', 'feature-flag-reads'.",
      "An existing facet id or label adds another rule to that concern; a new name mints one",
      `(up to ${MAX_FACETS} per Lens). NEVER a generic name like 'hit', 'match' or 'result' — this is`,
      "what the user reads in the legend, so it has to say what the lines have in common.",
    ].join(" "),
  }),
  kind: Schema.Literals(["pattern", "symbol", "structural"]).annotate({
    description: [
      "How to find the lines. 'pattern' is a ripgrep regex, painting each matched LINE:",
      "language-agnostic (config, YAML, markup) but it also matches comments and strings.",
      "'symbol' names a top-level declaration and paints its whole extent: coarser, but",
      "idiom-blind — it finds a const-arrow, a generator and a function declaration alike, which",
      "matters in a codebase where most callables are not `function` declarations.",
      "'structural' is an ast-grep pattern (precise, exact ranges) but its backend is not",
      "installed yet, so it will be refused; prefer 'pattern' or 'symbol'.",
    ].join(" "),
  }),
  pattern: Schema.optional(Schema.String).annotate({
    description: "Required for kind 'pattern' (a rust-regex, as ripgrep takes it) and kind 'structural'.",
  }),
  name: Schema.optional(Schema.String).annotate({
    description: "Required for kind 'symbol': the exact top-level declaration name, e.g. 'retryWithBackoff'.",
  }),
  path: Schema.optional(Schema.String).annotate({
    description: "kind 'symbol' only: restrict to this repo-relative file or directory prefix.",
  }),
  language: Schema.optional(Schema.String).annotate({
    description: "Required for kind 'structural', e.g. 'ts', 'tsx', 'js', 'py'.",
  }),
  glob: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: [
      "Repo-relative globs restricting the search, e.g. ['packages/*/src/**/*.ts'].",
      "The cheapest way to narrow a rule that matched too much.",
    ].join(" "),
  }),
  caseSensitive: Schema.optional(Schema.Boolean).annotate({
    description: "kind 'pattern' only. Matching is case-sensitive unless you pass false.",
  }),
  note: Schema.optional(Schema.String).annotate({
    description: [
      "One line on WHY these lines matter, shown to the user on hover. This is where your",
      "judgement lives — the finder can only match text, so 'this is the retry path' has to be",
      "said here rather than encoded in the query.",
    ].join(" "),
  }),
  definition: Schema.optional(Schema.String).annotate({
    description: "One-line definition of the concern for the legend. Used only when minting a new concern.",
  }),
  about: Schema.optional(Schema.String).annotate({
    description: "One line describing the Lens. Used only when this call creates it.",
  }),
  activate: Schema.optional(Schema.Boolean).annotate({
    description: [
      "Switch the user's view to this Lens. Defaults to false, and marks are invisible until the",
      "Lens is active — so the right move is to tell the user it exists and offer lens_select,",
      "not to switch the view they are looking at out from under them.",
    ].join(" "),
  }),
})

export const LensMarkTool = Tool.define(
  "lens_mark",
  Effect.gen(function* () {
    const aperture = yield* Aperture.Service

    return {
      description: [
        "Mark lines in the repo with a named concern on an Aperture Lens, so 'where do we handle X?'",
        "leaves a persistent, paintable answer behind instead of scrolling out of the conversation.",
        "What is stored is the QUERY (a regex, or a declaration name), not the line numbers — it is",
        "re-run against the files on every read, so the paint follows the code as it changes.",
        "Free and instant: no model call, no repainting. Returns the hit count, a sample of matched",
        "lines and the concern's colour. Check the count AND read the samples — the count catches a",
        "query that is too broad, the samples catch one that matched the wrong thing (a 'pattern'",
        "rule matches comments and strings, so a small plausible count can still be all prose).",
        "Several unrelated concerns can live on one Lens; the user filters the legend down to the",
        "ones they care about.",
      ].join(" "),
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          // Declared up front (rather than inlined per branch) so every return shares one
          // metadata shape — the same reason lens_facet_files does it.
          const metadata: {
            lens?: string
            facet?: string
            rule?: string
            hits?: number
            files?: number
            minted?: boolean
            createdLens?: boolean
            overCap?: boolean
          } = {}
          // Assemble the finder from the flat params, then validate — so a missing field is
          // reported as prose the agent can act on rather than as a decode failure.
          const find = {
            kind: params.kind,
            ...(params.pattern !== undefined ? { pattern: params.pattern } : {}),
            ...(params.name !== undefined ? { name: params.name } : {}),
            ...(params.path !== undefined ? { path: params.path } : {}),
            ...(params.language !== undefined ? { language: params.language } : {}),
            ...(params.glob !== undefined ? { glob: params.glob } : {}),
            ...(params.caseSensitive !== undefined ? { caseSensitive: params.caseSensitive } : {}),
          }
          const problem = finderProblem(find)
          if (problem)
            return {
              title: "Invalid finder",
              metadata,
              output: `Nothing was marked: ${problem}.`,
            }
          // Narrowed by the check above, which is the whole point of validating here rather than
          // letting a Schema.Union reject it upstream of this function.
          const finder = find as Finder

          const result = yield* aperture.markLens({
            lens: params.lens,
            facet: params.facet,
            ...(params.definition ? { definition: params.definition } : {}),
            ...(params.about ? { about: params.about } : {}),
            find: finder,
            ...(params.note ? { note: params.note } : {}),
            ...(ctx.agent ? { agent: ctx.agent } : {}),
            ...(params.activate !== undefined ? { activate: params.activate } : {}),
          })

          // Rule content + hit count at creation, and the authoring agent. The tool is the only
          // place that has both — ctx.agent/ctx.sessionID don't reach the service — and the
          // count is the measure of query *quality* that a bare tool-call tally cannot see.
          const log = (op: string, extra: Record<string, unknown> = {}) =>
            StudyLog.record(ctx.sessionID, {
              type: "rule",
              op,
              agent: ctx.agent,
              lens: params.lens,
              facet: params.facet,
              find,
              ...extra,
            })

          switch (result.status) {
            case "dead-rule":
              yield* log("rejected-dead", { error: result.detail })
              return {
                title: "Rule not stored",
                metadata,
                output: [`Nothing was stored. ${result.detail}`, "Fix the finder and call lens_mark again."].join("\n"),
              }
            case "no-hits":
              yield* log("rejected-no-hits", { hits: 0, files: 0 })
              return {
                title: "No matches",
                metadata,
                output: [
                  "Nothing was stored: that finder matched 0 lines.",
                  "Either the query is wrong or the code isn't there — check with grep before marking again.",
                ].join("\n"),
              }
            case "builtin":
              return {
                title: "Built-in Lens",
                metadata,
                output: `"${params.lens}" is a built-in Lens and can't carry rules. Name a user Lens, or a new name to create a Search Lens.`,
              }
            case "not-found":
              return {
                title: "Unknown Lens",
                metadata,
                output: `No Lens matches "${params.lens}" and it could not be created. Run lens_list to see the options.`,
              }
            case "facet-cap":
              yield* log("rejected-cap")
              return {
                title: "Concern limit reached",
                metadata,
                output: [
                  `"${result.lens.name}" already has ${result.max} concerns, which is the maximum (one per palette colour).`,
                  ...rosterLines(result.lens),
                  "",
                  "Either add this rule to one of the concerns above, or free a slot with lens_unmark.",
                ].join("\n"),
              }
            case "rule-cap":
              yield* log("rejected-cap")
              return {
                title: "Rule limit reached",
                metadata,
                output: [
                  `"${result.lens.name}" already has ${result.max} rules, which is the maximum.`,
                  "Remove one with lens_unmark before adding another.",
                ].join("\n"),
              }
            case "ok": {
              const { diagnostic, facet, rule, lens } = result
              const colour = concernRoster(lens).find((c) => c.facet === facet.id)
              const swatch = `${facet.color}${colour ? ` ${colour.colorName}` : ""}`
              yield* log(diagnostic.overCap ? "over-cap" : result.replaced ? "replaced" : "created", {
                rule: rule.id,
                facet: facet.id,
                minted: result.minted,
                hits: diagnostic.hits,
                files: diagnostic.files,
                ...(diagnostic.overCap ? { overCap: true } : {}),
              })

              const head = diagnostic.overCap
                ? [
                    `NOT PAINTED: that finder matched ${diagnostic.hits} lines across ${diagnostic.files} files, past the ${MAX_RULE_HITS}-line cap.`,
                    `The rule is stored on "${lens.name}" as "${facet.label}" but paints nowhere.`,
                    "Narrow it — add a glob, anchor the regex, or use kind 'symbol' — and call lens_mark again",
                    `with the same facet; or drop it with lens_unmark rule ${rule.id}.`,
                  ]
                : [
                    `Marked ${diagnostic.hits} lines across ${diagnostic.files} files as "${facet.label}" [${facet.id}] (${swatch})`,
                    `on Lens "${lens.name}" [${lens.id}]${result.createdLens ? " — created by this call" : ""}.`,
                  ]

              return {
                title: diagnostic.overCap
                  ? `Too broad: ${diagnostic.hits} lines`
                  : `${diagnostic.hits} lines · ${facet.label}`,
                metadata: Object.assign(metadata, {
                  lens: lens.id,
                  facet: facet.id,
                  rule: rule.id,
                  hits: diagnostic.hits,
                  files: diagnostic.files,
                  minted: result.minted,
                  createdLens: result.createdLens,
                  overCap: diagnostic.overCap === true,
                }),
                output: [
                  ...head,
                  ...(result.replaced ? ["", "This replaced an identical rule already on that concern."] : []),
                  ...(result.written
                    ? []
                    : [
                        "",
                        "WARNING: the write to .opencode/aperture/lenses.json failed, so this mark will not survive a restart.",
                      ]),
                  "",
                  `rule:   ${rule.id}`,
                  `finder: ${describeFinder(finder)}`,
                  ...(result.samples.length
                    ? [
                        "samples:",
                        ...result.samples.map((s) => `  ${s.file}:${s.line}  ${s.text}`),
                        ...(diagnostic.hits > result.samples.length
                          ? [`  ... (${result.samples.length} of ${diagnostic.hits} shown)`]
                          : []),
                      ]
                    : []),
                  "",
                  `Concerns on "${lens.name}":`,
                  ...rosterLines(lens),
                  "",
                  ...visibility(result.activated, result.isActive, lens.name),
                ].join("\n"),
              }
            }
          }
        }),
    }
  }),
)

// The Lens's concerns, one per line — shipped on success AND on every refusal. See
// `concernRoster` for why.
export function rosterLines(lens: Pick<Lens, "facets" | "rules">): string[] {
  const roster = concernRoster(lens)
  if (roster.length === 0) return ["  (none yet — nothing is marked, so the whole repo reads as unmarked grey)"]
  return roster.map(
    (c) =>
      `  - ${c.label} [${c.facet}] ${c.color} ${c.colorName} — ${c.rules} rule${c.rules === 1 ? "" : "s"}` +
      (c.ruleOnly ? "" : " (painter-owned)"),
  )
}

function visibility(activated: boolean, isActive: boolean, name: string): string[] {
  if (activated) return [`Switched the view to "${name}", so the marks are visible now.`]
  if (isActive) return ["That Lens is active, so the marks are visible in the view and the editor gutter now."]
  return [
    `"${name}" is not the active Lens, so the user cannot see these marks yet.`,
    `Tell them it exists and ask before switching (lens_select "${name}").`,
  ]
}
