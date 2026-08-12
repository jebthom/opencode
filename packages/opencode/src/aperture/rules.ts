import { Effect } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { createHash } from "crypto"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/filesystem/ripgrep"
import { ApertureExtents } from "./extents"
import { MAX_RULE_HITS, type Finder, type Rule } from "./lenses"

// Evaluation of a Lens's search rules (S1) into sparse line ranges.
//
// The premise, from S0: a line tag is a *query*, not a location. Nothing about a hit is
// persisted — the finder lives on the Lens and the lines are re-derived here at every
// payload read, exactly as `extentsOf` re-cuts a file's extents from disk content. That is
// what makes a deleted usage lose its paint and a new one gain it with no user action, and
// it is why there is no anchor, no "lost" state and no durable line-tag store anywhere in
// the codebase.
//
// **Every finder is a pure function of one file's content.** Nothing here resolves an
// import, follows a re-export or consults a symbol table. That is a real coverage limit
// (see the `references` gap in PLAN.md S1) but it is also the property that makes the
// caller's per-file memo *correct* rather than merely convenient: re-evaluating one changed
// file can never invalidate another file's result, so an edit costs one file's work instead
// of a whole-repo pass.
//
// The output feeds `lineTags` in the payload and NOTHING else. Line tags are sparse and do
// not tile a file, so they must never enter `attributeFileBytes` / `computeComposition` —
// the byte contract the treemap, the directory bands and the Explorer pip all depend on
// would stop summing (see the note on LineTag in payload.ts).

// One rule's hits inside one file. `ranges` are 1-based inclusive line ranges, already
// clamped to the file and merged, so a range is one visual gutter strip and the hit count
// is not inflated by adjacency.
export interface RuleHit {
  readonly rule: string
  readonly facet: string
  readonly note?: string
  readonly ranges: ReadonlyArray<readonly [number, number]>
}

// What a rule did, for the caller to report rather than silently swallow. This is the whole
// safety mechanism of the rule model: an agent that writes a loose regex sees `412 lines
// across 87 files` and narrows it, instead of repainting a third of the repo unnoticed.
export interface RuleDiagnostic {
  readonly rule: string
  readonly hits: number
  readonly files: number
  // Set when the rule exceeded MAX_RULE_HITS. It is still *stored* — only not painted.
  readonly overCap?: true
  // Set when the finder itself failed (uncompilable regex, unparseable pattern, backend
  // unavailable). The message is meant to be handed back to the authoring agent verbatim.
  readonly error?: string
}

export interface RuleResult {
  // Repo-relative path → the hits of every rule that matched in it.
  readonly byFile: ReadonlyMap<string, ReadonlyArray<RuleHit>>
  readonly diagnostics: ReadonlyArray<RuleDiagnostic>
}

export const EMPTY: RuleResult = { byFile: new Map(), diagnostics: [] }

// Stable identity of a rule *set*, used as the caller's memo key.
//
// Order-insensitive (sorted by rule id) because reordering rules in a hand-edited
// lenses.json changes nothing about what they match, and thrashing a whole-repo memo over a
// cosmetic reshuffle is exactly the kind of avoidable cost the memo exists to prevent.
// Sensitive to every field that affects hits; `note` and `createdBy` are excluded because
// they are carried through to the payload but never evaluated.
export function rulesHash(rules: ReadonlyArray<Rule>): string {
  const material = rules
    .map((r) => JSON.stringify({ id: r.id, facet: r.facet, find: r.find }))
    .sort()
    .join("\n")
  return createHash("sha256").update(material).digest("hex").slice(0, 16)
}

// Evaluate `rules` over a repo. `files`, when given, restricts evaluation to those
// repo-relative paths — the incremental path taken when a handful of files changed. Omit it
// for the whole-repo pass.
//
// Never fails: a finder that throws is caught into that rule's diagnostic and the remaining
// rules still evaluate. One bad regex must not blank the payload, and during an unattended
// participant session a crashed read boundary is a lost session rather than a bug report.
export const evaluate = (
  directory: string,
  rules: ReadonlyArray<Rule>,
  files?: ReadonlyArray<string>,
): Effect.Effect<RuleResult> =>
  Effect.gen(function* () {
    if (rules.length === 0 || (files && files.length === 0)) return EMPTY
    const byFile = new Map<string, RuleHit[]>()
    const diagnostics: RuleDiagnostic[] = []

    for (const rule of rules) {
      const outcome = yield* evaluateOne(directory, rule, files).pipe(
        Effect.catchCause(
          (cause): Effect.Effect<Outcome> => Effect.succeed({ perFile: new Map(), error: messageOf(cause) }),
        ),
      )
      let hits = 0
      for (const ranges of outcome.perFile.values()) hits += ranges.length
      // An over-cap rule is stored but never painted, so its hits are dropped here rather
      // than at the emit site: that keeps "too broad ⇒ invisible" in one place and lets a
      // caller hand `byFile` straight to the payload.
      const over = outcome.overCap !== undefined || hits > MAX_RULE_HITS
      if (!over) {
        for (const [file, ranges] of outcome.perFile) {
          if (ranges.length === 0) continue
          const list = byFile.get(file) ?? []
          list.push({ rule: rule.id, facet: rule.facet, ...(rule.note ? { note: rule.note } : {}), ranges })
          byFile.set(file, list)
        }
      }
      diagnostics.push({
        rule: rule.id,
        hits: outcome.overCap?.hits ?? hits,
        files: outcome.overCap?.files ?? outcome.perFile.size,
        ...(over ? { overCap: true as const } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
      })
    }

    return { byFile, diagnostics }
  })

interface Outcome {
  readonly perFile: Map<string, Array<readonly [number, number]>>
  readonly error?: string
  // Raw match totals, set ONLY when a backend bailed out early because the rule was already
  // past MAX_RULE_HITS. `perFile` is then empty — not because nothing matched, but because
  // far too much did — so the caller must report these counts rather than zero.
  readonly overCap?: { readonly hits: number; readonly files: number }
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  const text = String(cause)
  return text.length > 300 ? text.slice(0, 300) + "…" : text
}

// The failure type stays declared rather than swallowed here: `evaluate` above is the single
// place that turns a failure into a diagnostic, so it has to be visible all the way up to it.
const evaluateOne = (
  directory: string,
  rule: Rule,
  files: ReadonlyArray<string> | undefined,
): Effect.Effect<Outcome, PlatformError | Error> => {
  switch (rule.find.kind) {
    case "pattern":
      return patternHits(directory, rule.find, files)
    case "symbol":
      return symbolHits(directory, rule.find, files)
    case "structural":
      // S1b. Reported rather than thrown so the rule survives on the Lens and the agent gets
      // an actionable message the moment the backend lands.
      return Effect.succeed({
        perFile: new Map(),
        error: "structural rules need the ast-grep backend, which is not installed yet (PLAN.md S1b)",
      })
  }
}

// --- pattern ---------------------------------------------------------------

// A ripgrep regex. Span is the matched line: `pattern` is the language-agnostic finder, so
// it has no notion of a node to widen to, and S0 measured and rejected widening in general.
//
// Two traps, both found by reading `Ripgrep.searchArgs`:
//   - `SearchInput.limit` becomes `--max-count`, which caps matches PER FILE. It therefore
//     cannot enforce MAX_RULE_HITS (a rule matching 3 lines in 400 files is exactly the
//     degenerate case the cap exists for), so the cap is counted by the caller instead and
//     `limit` is left unset.
//   - There is no case-sensitivity flag on the service. Rather than widen a shared core
//     API for one caller, case-insensitivity rides as rust-regex's own `(?i)` inline flag,
//     which is scoped to the pattern and needs no plumbing.
const patternHits = (
  directory: string,
  find: Extract<Finder, { kind: "pattern" }>,
  files: ReadonlyArray<string> | undefined,
) =>
  Effect.gen(function* () {
    const rg = yield* Ripgrep.Service
    const result = yield* rg.search({
      cwd: directory,
      pattern: find.caseSensitive === false ? `(?i)${find.pattern}` : find.pattern,
      ...(find.glob?.length ? { glob: [...find.glob] } : {}),
      ...(files ? { file: [...files] } : {}),
    })
    const perFile = new Map<string, Array<readonly [number, number]>>()
    let raw = 0
    for (const item of result.items) {
      const rel = normalize(item.path.text)
      const list = perFile.get(rel) ?? []
      list.push([item.line_number, item.line_number])
      perFile.set(rel, list)
      raw++
    }
    // Ripgrep exits 2 for "I could not do what you asked" — most importantly an
    // uncompilable pattern, but also unreadable files — and the service maps that to
    // `partial: true` with an EMPTY item list. Discarding it would report a broken regex as
    // `0 hits`, which an agent reads as "the code isn't there" and acts on. Found by probing
    // `([unclosed` against this repo; it is the single most misleading thing this module
    // could do, since the whole point of the return value is that a bad query is visible.
    //
    // Not pre-validated with `new RegExp` instead: ripgrep speaks rust-regex, which accepts
    // inline flags like the `(?i)` generated just above and which JS rejects, so a JS
    // pre-check would reject valid patterns.
    if (result.partial)
      return {
        perFile,
        error: `ripgrep rejected this pattern or could not read some files (exit 2) — check the regex syntax`,
      }
    // Bail before touching the disk when the rule is already too broad. `clampAll` reads
    // every matched file, and a rule matching 30,960 lines across 2,300 files (measured:
    // `const ` on this repo) spent ~1.2s reading files whose ranges are then thrown away
    // unpainted. The count reported is raw matched lines rather than merged ranges, which is
    // also the more faithful reading of a cap whose job is to catch "this paints a third of
    // the repo" — merging only ever shrinks it.
    if (raw > MAX_RULE_HITS) return { perFile: new Map(), overCap: { hits: raw, files: perFile.size } }
    return { perFile: yield* clampAll(directory, perFile) }
  }).pipe(Effect.provide(Ripgrep.defaultLayer))

// --- symbol ----------------------------------------------------------------

// A top-level declaration by NAME, painted at its own extent.
//
// This is not a widening of a point hit — it is the finder choosing its unit, the same way a
// structural pattern matching a `catch` clause chooses the clause. The declaration is the
// thing the rule names, so the declaration is what it paints.
//
// Why this exists alongside `structural`, which looks strictly more powerful: idiom
// blindness. `extentsOf`'s dumb column-0 regex finds `paintStale` whether it is written as a
// const-arrow, a generator or a function declaration, because it never inspects the
// right-hand side. This codebase is Effect-shaped — `aperture.ts` holds 153 arrow functions,
// 60 function expressions, 52 generators and 8 function declarations — so an agent writing
// the obvious `function $F($$$P) { $$$B }` structural pattern to find "all the functions"
// silently finds 3% of them. The two finders answer different questions.
//
// Candidate files come from a grep for the bare name rather than from walking the repo: the
// name must appear textually in any file that declares it, so the grep is a sound prefilter
// and it means we read only the handful of files that could possibly match.
const symbolHits = (
  directory: string,
  find: Extract<Finder, { kind: "symbol" }>,
  files: ReadonlyArray<string> | undefined,
) =>
  Effect.gen(function* () {
    const under = find.path ? normalize(find.path).replace(/\/+$/, "") : undefined
    const inScope = (rel: string) => !under || rel === under || rel.startsWith(under + "/")

    let candidates: string[]
    if (files) {
      candidates = files.map(normalize).filter(inScope)
    } else {
      const rg = yield* Ripgrep.Service
      // \b so `paintStale` doesn't drag in `paintStaleExtents`; escaped because a symbol
      // name is a literal, not a pattern the author is offering us.
      const found = yield* rg.search({ cwd: directory, pattern: `\\b${escapeRegex(find.name)}\\b` })
      candidates = [...new Set(found.items.map((i) => normalize(i.path.text)))].filter(inScope)
    }

    const fs = yield* FSUtil.Service
    const perFile = new Map<string, Array<readonly [number, number]>>()
    for (const rel of candidates) {
      const content = yield* fs
        .readFileStringSafe(path.join(directory, rel))
        .pipe(Effect.orElseSucceed(() => undefined as string | undefined))
      if (content === undefined) continue
      // Declaration granularity, and only the extents whose name IS the symbol. `extentsOf`
      // suffixes duplicates within a file (`foo~2`), so match the base name too or a
      // shadowed re-declaration would be invisible.
      const ranges: Array<readonly [number, number]> = []
      for (const extent of ApertureExtents.extentsOf(content, "declaration")) {
        if (extent.name !== find.name && !extent.name.startsWith(find.name + "~")) continue
        ranges.push([extent.startLine, extent.endLine])
      }
      if (ranges.length) perFile.set(rel, ApertureExtents.clampRanges(ranges, content))
    }
    return { perFile }
  }).pipe(Effect.provide(Ripgrep.defaultLayer), Effect.provide(FSUtil.defaultLayer))

// --- shared ----------------------------------------------------------------

// Normalise every range against the file it refers to. `clampRanges` drops ranges past the
// end of the file (ripgrep and this read can disagree if a write lands between them, which
// would otherwise decorate a line the buffer doesn't have) and merges adjacent ones, so two
// hits on consecutive lines are one strip and count once rather than twice.
const clampAll = (directory: string, perFile: Map<string, Array<readonly [number, number]>>) =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const out = new Map<string, Array<readonly [number, number]>>()
    for (const [rel, ranges] of perFile) {
      const content = yield* fs
        .readFileStringSafe(path.join(directory, rel))
        .pipe(Effect.orElseSucceed(() => undefined as string | undefined))
      if (content === undefined) continue
      const clamped = ApertureExtents.clampRanges(ranges, content)
      if (clamped.length) out.set(rel, clamped)
    }
    return out
  }).pipe(Effect.provide(FSUtil.defaultLayer))

// Ripgrep already strips a leading "./" (see `clean`), but it reports native separators on
// Windows while every path in the payload is "/"-joined repo-relative.
function normalize(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "")
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export * as ApertureRules from "./rules"
