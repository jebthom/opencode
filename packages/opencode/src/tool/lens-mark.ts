import { Effect, Schema } from "effect"
import { Aperture } from "@/aperture/aperture"
import {
  type Facet,
  type Finder,
  type GitFilter,
  type Lens,
  concernRoster,
  describeFinder,
  finderProblem,
  whereProblem,
  MAX_FACETS,
} from "@/aperture/lenses"
import { ApertureRules } from "@/aperture/rules"
import * as StudyLog from "@/aperture/study-log"
import * as Tool from "./tool"
import { actorOf, withConsent } from "./lens-consent"

// Mark lines in the repo with a named *concern* on an Aperture Lens. The persisted thing is the
// QUERY, not the lines: a finder is re-evaluated from disk at every read, so a deleted usage
// silently loses its paint and a new one gains it, with no anchoring and no "lost" state. See
// `aperture/lenses.ts` for the Finder union and `aperture/rules.ts` for the evaluator.
//
// This is also the agent's curation tool (v3): the build/plan agent keeps its own Lens of the
// concerns that best help the user verify the current work, adding and removing facets as the
// task moves. Every call lands in the Lens history with the turn it came from.
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
      "Id or name of the Lens to mark on (see lens_list). A name that doesn't exist creates a Lens",
      "with that name — give it a descriptive one ('Retry Handling', not 'search'), and check",
      "lens_list first so you add to an existing Lens instead of making a near-duplicate.",
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
  kind: Schema.Literals(["pattern", "symbol", "diff", "structural"]).annotate({
    description: [
      "How to find the lines. 'pattern' is a ripgrep regex, painting each matched LINE:",
      "language-agnostic but it also matches comments and strings.",
      "'symbol' names a top-level declaration and paints its whole extent: coarser, but idiom-blind",
      "— it finds a const-arrow, a generator and a function declaration alike.",
      "'diff' marks the lines git reports as changed against `ref` (default HEAD = uncommitted",
      "changes; 'main' = changed since main; 'HEAD~1..HEAD' = the last commit).",
      "'structural' is an ast-grep pattern but its backend is not installed yet, so it is refused.",
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
  ref: Schema.optional(Schema.String).annotate({
    description: "kind 'diff' only: the git ref or 'A..B' range to compare against. Defaults to HEAD.",
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
  changed: Schema.optional(Schema.String).annotate({
    description: [
      "Keep only hits on lines git reports as changed against this ref or range — e.g. 'HEAD'",
      "(uncommitted), 'main', or 'HEAD~1..HEAD' (the last commit). Combine with a pattern to mark",
      "'every call to x() that this change touched'.",
    ].join(" "),
  }),
  author: Schema.optional(Schema.String).annotate({
    description:
      "Keep only hits on lines last changed by this author (case-insensitive substring of git blame's name or email).",
  }),
  since: Schema.optional(Schema.String).annotate({
    description: "Keep only hits on lines last changed after this date ('2 weeks ago', '2026-09-01'), per git blame.",
  }),
  note: Schema.optional(Schema.String).annotate({
    description: [
      "One line on WHY these lines matter, shown to the user on hover. This is where your judgement",
      "lives — the finder can only match text, so 'this is the retry path' has to be said here.",
    ].join(" "),
  }),
  definition: Schema.optional(Schema.String).annotate({
    description: "One-line definition of the concern for the legend. Used only when minting a new concern.",
  }),
  facetReason: Schema.optional(Schema.String).annotate({
    description: [
      "One sentence on how this concern helps the user understand the CURRENT TASK — not what the",
      "lines are (that is `definition`), but why looking at them matters now: 'every caller that",
      "must handle the new error type'. The user sees it beside the query whenever they hover the",
      "concern. REQUIRED when minting a concern; given for an existing one, it replaces the reason.",
    ].join(" "),
  }),
  about: Schema.optional(Schema.String).annotate({
    description: "One line describing the Lens. Used only when this call creates it.",
  }),
  reason: Schema.optional(Schema.String).annotate({
    description: [
      "Why you are making this change now (this call, not the concern — see `facetReason`),",
      "recorded in the Lens history the user can review.",
      "Always give one when curating on your own initiative.",
    ].join(" "),
  }),
  requestedByUser: Schema.optional(Schema.Boolean).annotate({
    description: [
      "True ONLY when the user explicitly asked for this mark in this conversation. The concern is",
      "then theirs, and you must not later change or remove it without asking. Leave it unset when",
      "you are curating the view on your own initiative.",
    ].join(" "),
  }),
  activate: Schema.optional(Schema.Boolean).annotate({
    description: [
      "Switch the user's view to this Lens. You may do this freely when the active Lens is one you",
      "curate (or there is none); switching away from a user's Lens asks them first.",
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
        "What is stored is the QUERY (a regex, a declaration name, or a git diff, optionally narrowed",
        "by git history — changed in a ref, by an author, since a date), not the line numbers — it is",
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
            concerns?: Concern[]
          } = {}
          // Assemble the finder from the flat params, then validate — so a missing field is
          // reported as prose the agent can act on rather than as a decode failure.
          const find = {
            kind: params.kind,
            ...(params.pattern !== undefined ? { pattern: params.pattern } : {}),
            ...(params.name !== undefined ? { name: params.name } : {}),
            ...(params.path !== undefined ? { path: params.path } : {}),
            ...(params.language !== undefined ? { language: params.language } : {}),
            ...(params.ref !== undefined ? { ref: params.ref } : {}),
            ...(params.glob !== undefined ? { glob: params.glob } : {}),
            ...(params.caseSensitive !== undefined ? { caseSensitive: params.caseSensitive } : {}),
          }
          const where = {
            ...(params.changed ? { changed: params.changed } : {}),
            ...(params.author ? { author: params.author } : {}),
            ...(params.since ? { since: params.since } : {}),
          }
          const problem = finderProblem(find) ?? whereProblem(where)
          if (problem)
            return {
              title: "Invalid finder",
              metadata,
              output: `Nothing was marked: ${problem}.`,
            }
          // Narrowed by the checks above, which is the whole point of validating here rather than
          // letting a Schema.Union reject it upstream of this function.
          const finder = find as Finder
          const filter: GitFilter | undefined = Object.keys(where).length ? where : undefined

          const input = {
            lens: params.lens,
            facet: params.facet,
            ...(params.definition ? { definition: params.definition } : {}),
            ...(params.facetReason ? { facetReason: params.facetReason } : {}),
            ...(params.about ? { about: params.about } : {}),
            find: finder,
            ...(filter ? { where: filter } : {}),
            ...(params.note ? { note: params.note } : {}),
            ...(params.activate !== undefined ? { activate: params.activate } : {}),
          }
          const actor = actorOf(ctx, params)
          const first = yield* aperture.markLens(input, actor)
          // An agent curating on its own initiative may change only its own Lenses. Touching the
          // user's asks them first; a rejection fails this call, which is what the agent should see.
          const result =
            first.status === "needs-consent"
              ? yield* aperture.markLens(
                  input,
                  yield* withConsent(
                    ctx,
                    actor,
                    first.lens,
                    `mark "${params.facet}" on "${first.lens.name}": ${describeFinder(finder, filter)}`,
                  ),
                )
              : first

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
              ...(filter ? { where: filter } : {}),
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
            case "not-found":
              return {
                title: "Unknown Lens",
                metadata,
                output: `No Lens matches "${params.lens}" and it could not be created. Run lens_list to see the options.`,
              }
            case "needs-consent":
              return {
                title: "Not changed",
                metadata,
                output: `"${result.lens.name}" belongs to the user, and the change was not approved.`,
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
            case "needs-reason":
              return {
                title: "Reason required",
                metadata,
                output: [
                  `Nothing was marked: "${result.facet}" is a new concern, and a new concern needs a \`facetReason\` —`,
                  "one sentence on how these lines help the user understand the current task. The user reads it",
                  "beside the query whenever they hover the concern. Call lens_mark again with it.",
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
                    `NOT PAINTED: that finder matched ${diagnostic.hits} lines across ${diagnostic.files} files, past the ${ApertureRules.capOf(finder)}-line cap.`,
                    `The rule is stored on "${lens.name}" as "${facet.label}" but paints nowhere.`,
                    "Narrow it — add a glob, anchor the regex, or use kind 'symbol' — and call lens_mark again",
                    `with the same facet; or drop it with lens_unmark rule ${rule.id}.`,
                  ]
                : [
                    `Marked ${diagnostic.hits} lines across ${diagnostic.files} files as "${facet.label}" [${facet.id}] (${swatch})`,
                    `on Lens "${lens.name}" [${lens.id}]${result.createdLens ? " — created by this call" : ""}.`,
                    `In chat, write it as ■ ${facet.id}; the user's view paints the square in its colour.`,
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
                  concerns: concernsOf([facet]),
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
                  `finder: ${describeFinder(finder, filter)}`,
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
                  ...visibility(result.activation, lens.name),
                ].join("\n"),
              }
            }
          }
        }),
    }
  }),
)

// The concerns a call touched, as the chat renders them: `■ Label` in the concern's exact colour,
// then its reason. Snapshotted into tool metadata so a removed concern still renders in the colour
// it had.
export interface Concern {
  readonly facet: string
  readonly label: string
  readonly color: string
  readonly reason: string
}

export function concernsOf(facets: ReadonlyArray<Facet>): Concern[] {
  return facets.map((f) => ({ facet: f.id, label: f.label, color: f.color, reason: f.reason }))
}

// The Lens's concerns, one per line — shipped on success AND on every refusal. See
// `concernRoster` for why.
export function rosterLines(lens: Pick<Lens, "facets" | "rules">): string[] {
  const roster = concernRoster(lens)
  if (roster.length === 0) return ["  (none yet — nothing is marked)"]
  return roster.flatMap((c) => [
    `  - ${c.label} [${c.facet}] ${c.color} ${c.colorName} — ${c.rules} rule${c.rules === 1 ? "" : "s"}` +
      (c.owner === "user" ? " (the user's — ask before changing)" : " (yours)"),
    `      reason: ${c.reason || "(none — give one with lens_edit facetReason)"}`,
  ])
}

function visibility(activation: "switched" | "already-active" | "not-requested" | "needs-consent", name: string) {
  if (activation === "switched") return [`Switched the view to "${name}", so the marks are visible now.`]
  if (activation === "already-active")
    return ["That Lens is active, so the marks are visible in the view and the editor gutter now."]
  if (activation === "needs-consent")
    return [
      `"${name}" is not active and the user's own Lens is, so the view was not switched.`,
      `Tell them it exists and ask before switching (lens_select "${name}").`,
    ]
  return [
    `"${name}" is not the active Lens, so the user cannot see these marks yet.`,
    `Tell them it exists, or switch to it with lens_select if the active Lens is one you curate.`,
  ]
}
