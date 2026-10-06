import { Effect } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { createHash } from "crypto"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/filesystem/ripgrep"
import { ApertureExtents } from "./extents"
import { MAX_DIFF_HITS, MAX_RULE_HITS, type Finder, type GitFilter, type Rule } from "./lenses"

// Evaluation of a Lens's search rules (S1) into sparse line ranges.
//
// The premise, from S0: a line tag is a *query*, not a location. Nothing about a hit is
// persisted — the finder lives on the Lens and the lines are re-derived here at every
// payload read, exactly as `extentsOf` re-cuts a file's extents from disk content. That is
// what makes a deleted usage lose its paint and a new one gain it with no user action, and
// it is why there is no anchor, no "lost" state and no durable line-tag store anywhere in
// the codebase.
//
// **Every content finder is a pure function of one file's content.** Nothing here resolves an
// import, follows a re-export or consults a symbol table. That is a real coverage limit (see the
// `references` gap in PLAN.md S1) but it is also the property that makes the caller's per-file
// memo *correct*: re-evaluating one changed file can never invalidate another file's result.
//
// The exception is anything git-shaped — the `diff` finder and every `where` filter — whose
// answer also depends on HEAD. Git access comes in through `GitLookup` rather than a Git service
// import, so this module stays pure and testable, and the caller keys its memo on HEAD for any
// rule `isGitRule` reports.

// One rule's hits inside one file. `ranges` are 1-based inclusive line ranges, already
// clamped to the file and merged, so a range is one visual gutter strip and the hit count
// is not inflated by adjacency.
//
// `lines`/`bytes` are the magnitude the aggregate surfaces need, measured over those same
// merged ranges so a line counts exactly once. `lines` is what a human reads ("14 lines
// marked") and what a client rolls up by plain summation.
export interface RuleHit {
  readonly rule: string
  readonly facet: string
  readonly note?: string
  readonly ranges: ReadonlyArray<readonly [number, number]>
  readonly lines: number
  readonly bytes: number
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
    .map((r) => JSON.stringify({ id: r.id, facet: r.facet, find: r.find, where: r.where }))
    .sort()
    .join("\n")
  return createHash("sha256").update(material).digest("hex").slice(0, 16)
}

// What the caller knows about git, for the `diff` finder and `where` filters. Paths are
// directory-relative, like every path here.
export interface GitLookup {
  // Changed line ranges (in each file's CURRENT content) against `ref` — a ref compares the
  // working tree to it, an "A..B" range compares two commits. "all" marks a file that is wholly
  // new (untracked). Files absent from the map did not change.
  readonly changes: (
    ref: string,
  ) => Effect.Effect<ReadonlyMap<string, ReadonlyArray<readonly [number, number]> | "all">, Error>
  // Per-line blame of the file's current contents (index = line - 1), or undefined when git has
  // nothing to say (untracked, binary, not a repo). With `since`, lines last changed before it
  // come back `recent: false`.
  readonly blame: (file: string, since?: string) => Effect.Effect<ReadonlyArray<BlameLine> | undefined>
}

export interface BlameLine {
  readonly author: string
  readonly mail: string
  readonly recent: boolean
}

// Blaming is one git process per file, so a filter that would blame the whole repo is refused
// with a message telling the agent to narrow it (a glob, or a `changed` filter, which is applied
// first and is one git call for the whole repo).
export const MAX_BLAME_FILES = 200
// A `where` filter is often what makes a broad finder narrow ("every call to x() — but only the
// changed ones"), so such a rule may match past MAX_RULE_HITS before filtering. It still has a
// ceiling, so the pre-filter pass cannot become a whole-repo read.
const MAX_PREFILTER_LINES = 20_000

// Evaluate `rules` over a repo. `files`, when given, restricts evaluation to those repo-relative
// paths — the incremental path taken when a handful of files changed. Omit it for the whole-repo
// pass. `git` is required only by git-shaped rules; without it they report an error.
//
// Never fails: a finder that throws is caught into that rule's diagnostic and the remaining rules
// still evaluate. One bad regex must not blank the view, and during an unattended participant
// session a crashed read is a lost session rather than a bug report.
export const evaluate = (
  directory: string,
  rules: ReadonlyArray<Rule>,
  files?: ReadonlyArray<string>,
  git?: GitLookup,
): Effect.Effect<RuleResult> =>
  Effect.gen(function* () {
    if (rules.length === 0 || (files && files.length === 0)) return EMPTY
    const byFile = new Map<string, RuleHit[]>()
    const diagnostics: RuleDiagnostic[] = []

    for (const rule of rules) {
      const outcome = yield* evaluateOne(directory, rule, files, git).pipe(
        Effect.catchCause(
          (cause): Effect.Effect<Outcome> => Effect.succeed({ perFile: new Map(), error: messageOf(cause) }),
        ),
      )
      let hits = 0
      for (const measured of outcome.perFile.values()) hits += measured.ranges.length
      // An over-cap rule is stored but never painted, so its hits are dropped here rather than at
      // the emit site: that keeps "too broad ⇒ invisible" in one place and lets a caller hand
      // `byFile` straight to the payload.
      const over = outcome.overCap !== undefined || hits > capOf(rule.find)
      if (!over) {
        for (const [file, measured] of outcome.perFile) {
          if (measured.ranges.length === 0) continue
          const list = byFile.get(file) ?? []
          list.push({ rule: rule.id, facet: rule.facet, ...(rule.note ? { note: rule.note } : {}), ...measured })
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

// Lines in `files` that a rule's finder matches but its scope leaves out — the rule with its
// whitelist globs (or symbol `path`) dropped — and that no rule of the same concern paints. Agents
// routinely glob a rule to the one file they were reading, so a new or edited file holding the
// same code shows as unmarked, and the user reads that as "the code isn't here". This is what lets
// the caller ask the agent to widen the rule or add one. Exclusion globs are kept: they record a
// deliberate "not these". `diff` rules are left out — unscoped, they mean every changed line.
//
// One Stray per concern and file: two rules of a concern often match the same lines, and listing
// them twice would spend the agent's context on a duplicate. `rules` names every rule involved.
export interface Stray {
  readonly rules: ReadonlyArray<string>
  readonly facet: string
  readonly file: string
  readonly ranges: ReadonlyArray<readonly [number, number]>
}

export const strays = (
  directory: string,
  rules: ReadonlyArray<Rule>,
  files: ReadonlyArray<string>,
  git?: GitLookup,
): Effect.Effect<Stray[]> =>
  Effect.gen(function* () {
    // Each rule runs widened over only the files its scope leaves out: an in-scope file's matches
    // are the rule's own paint, and a rule with nothing outside its scope costs no search at all.
    const found = (yield* Effect.forEach(rules, (rule) =>
      Effect.gen(function* () {
        const find = unscoped(rule.find)
        const inScope = inScopeOf(rule.find)
        const outside = find ? files.filter((file) => !inScope(file)) : []
        if (!find || outside.length === 0) return []
        const result = yield* evaluate(directory, [{ ...rule, find }], outside, git)
        return [...result.byFile].flatMap(([file, hits]) =>
          hits.map((hit) => ({ rule: hit.rule, facet: hit.facet, file, ranges: hit.ranges })),
        )
      }),
    )).flat()
    if (found.length === 0) return []
    const painted = yield* evaluate(
      directory,
      rules.filter((rule) => found.some((stray) => stray.facet === rule.facet)),
      [...new Set(found.map((stray) => stray.file))],
      git,
    )
    const grouped = new Map<string, { rules: string[]; facet: string; file: string; lines: Set<number> }>()
    for (const stray of found) {
      const covered = (painted.byFile.get(stray.file) ?? [])
        .filter((hit) => hit.facet === stray.facet)
        .flatMap((hit) => hit.ranges)
      const lines = stray.ranges.flatMap(([start, end]) =>
        Array.from({ length: end - start + 1 }, (_, i) => start + i).filter(
          (line) => !covered.some(([a, b]) => a <= line && line <= b),
        ),
      )
      if (lines.length === 0) continue
      const key = `${stray.facet}\0${stray.file}`
      const group = grouped.get(key) ?? { rules: [], facet: stray.facet, file: stray.file, lines: new Set<number>() }
      group.rules.push(stray.rule)
      for (const line of lines) group.lines.add(line)
      grouped.set(key, group)
    }
    return [...grouped.values()].map((group) => {
      const sorted = [...group.lines].sort((a, b) => a - b)
      return {
        rules: group.rules,
        facet: group.facet,
        file: group.file,
        ranges: runsOf(sorted[0]!, sorted[sorted.length - 1]!, (line) => group.lines.has(line)),
      }
    })
  })

// Whether a repo-relative file is inside the finder's scope (its globs, or a symbol's path).
function inScopeOf(find: Finder): (file: string) => boolean {
  if (find.kind === "symbol") {
    const under = find.path ? normalize(find.path).replace(/\/+$/, "") : undefined
    return (file) => !under || file === under || file.startsWith(under + "/")
  }
  if (find.kind === "pattern" && find.glob?.length) return globScope(find.glob)
  return () => true
}

// The finder with its scope removed, or undefined when it has none to remove.
function unscoped(find: Finder): Finder | undefined {
  if (find.kind === "symbol") return find.path ? { kind: "symbol", name: find.name } : undefined
  if (find.kind !== "pattern" || !find.glob?.some((g) => !g.startsWith("!"))) return undefined
  const exclusions = find.glob.filter((g) => g.startsWith("!"))
  return {
    kind: "pattern",
    pattern: find.pattern,
    ...(exclusions.length ? { glob: exclusions } : {}),
    ...(find.caseSensitive === false ? { caseSensitive: false } : {}),
  }
}

export function capOf(find: Finder): number {
  return find.kind === "diff" ? MAX_DIFF_HITS : MAX_RULE_HITS
}

// One file's hits for one rule, normalised and measured — the shape `RuleHit` spreads.
interface Measured {
  readonly ranges: ReadonlyArray<readonly [number, number]>
  readonly lines: number
  readonly bytes: number
}

interface Outcome {
  readonly perFile: Map<string, Measured>
  readonly error?: string
  // Raw match totals, set ONLY when a backend bailed out early because the rule was already past
  // its cap. `perFile` is then empty — not because nothing matched, but because far too much did
  // — so the caller must report these counts rather than zero.
  readonly overCap?: { readonly hits: number; readonly files: number }
}

// What a finder hands back before filtering and measurement: raw 1-based inclusive ranges per
// file, neither clamped nor merged.
type Raw = Map<string, Array<readonly [number, number]>>

interface Found {
  readonly raw: Raw
  readonly error?: string
  readonly overCap?: { readonly hits: number; readonly files: number }
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  const text = String(cause)
  return text.length > 300 ? text.slice(0, 300) + "…" : text
}

// Find → filter → measure. The failure type stays declared rather than swallowed here: `evaluate`
// above is the single place that turns a failure into a diagnostic.
const evaluateOne = (
  directory: string,
  rule: Rule,
  files: ReadonlyArray<string> | undefined,
  git: GitLookup | undefined,
): Effect.Effect<Outcome, PlatformError | Error> =>
  Effect.gen(function* () {
    const filtered = hasFilter(rule.where)
    if ((filtered || rule.find.kind === "diff") && !git)
      return { perFile: new Map(), error: "this rule needs git history, but the project is not a git repository" }
    const found = yield* find(directory, rule.find, files, git!, filtered ? MAX_PREFILTER_LINES : capOf(rule.find))
    if (found.overCap || (found.error && found.raw.size === 0))
      return {
        perFile: new Map(),
        ...(found.error ? { error: found.error } : {}),
        ...(found.overCap ? { overCap: found.overCap } : {}),
      }
    const narrowed = filtered ? yield* applyWhere(rule.where!, found.raw, git!) : { raw: found.raw }
    if (narrowed.error) return { perFile: new Map(), error: narrowed.error }
    return {
      perFile: yield* clampAll(directory, narrowed.raw),
      ...(found.error ? { error: found.error } : {}),
    }
  })

function hasFilter(where: GitFilter | undefined): where is GitFilter {
  return !!where && !!(where.changed || where.author || where.since)
}

const find = (
  directory: string,
  finder: Finder,
  files: ReadonlyArray<string> | undefined,
  git: GitLookup,
  cap: number,
): Effect.Effect<Found, PlatformError | Error> => {
  switch (finder.kind) {
    case "pattern":
      return patternHits(directory, finder, files, cap)
    case "symbol":
      return symbolHits(directory, finder, files)
    case "diff":
      return diffHits(finder, files, git, cap)
    case "structural":
      // S1b. Reported rather than thrown so the rule survives on the Lens and the agent gets an
      // actionable message the moment the backend lands.
      return Effect.succeed({
        raw: new Map(),
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
  cap: number,
): Effect.Effect<Found, PlatformError | Error> =>
  Effect.gen(function* () {
    // Ripgrep never applies `--glob` to a path named on its command line, so on the incremental
    // path the globs are applied here. Without this, a file outside a rule's glob gained the
    // rule's marks the moment it was edited and lost them on the next whole-repo pass.
    const inScope = find.glob?.length ? globScope(find.glob) : undefined
    const scoped = files && inScope ? files.filter((file) => inScope(normalize(file))) : files
    if (scoped && scoped.length === 0) return { raw: new Map() }
    const rg = yield* Ripgrep.Service
    const result = yield* rg.search({
      cwd: directory,
      pattern: find.caseSensitive === false ? `(?i)${find.pattern}` : find.pattern,
      ...(find.glob?.length ? { glob: [...find.glob] } : {}),
      ...(scoped ? { file: [...scoped] } : {}),
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
        // Normally empty (exit 2 comes back with no items at all), but a partial read that
        // still produced matches keeps them rather than discarding work the user can see.
        raw: perFile,
        error: `ripgrep rejected this pattern or could not read some files (exit 2) — check the regex syntax`,
      }
    // Bail before touching the disk when the rule is already too broad. `clampAll` reads
    // every matched file, and a rule matching 30,960 lines across 2,300 files (measured:
    // `const ` on this repo) spent ~1.2s reading files whose ranges are then thrown away
    // unpainted. The count reported is raw matched lines rather than merged ranges, which is
    // also the more faithful reading of a cap whose job is to catch "this paints a third of
    // the repo" — merging only ever shrinks it.
    if (raw > cap) return { raw: new Map(), overCap: { hits: raw, files: perFile.size } }
    return { raw: perFile }
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
): Effect.Effect<Found, PlatformError | Error> =>
  Effect.gen(function* () {
    const inScope = inScopeOf(find)

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
    const raw: Raw = new Map()
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
      if (ranges.length) raw.set(rel, ranges)
    }
    return { raw }
  }).pipe(Effect.provide(Ripgrep.defaultLayer), Effect.provide(FSUtil.defaultLayer))

// --- diff ------------------------------------------------------------------

// The lines git reports as changed against `ref`: what the retired "Changed since last commit"
// built-in showed, now as a rule, so it can be one concern among several on any Lens. A wholly
// new (untracked) file is marked end to end; `clampAll` trims the open range to its real length.
const diffHits = (
  find: Extract<Finder, { kind: "diff" }>,
  files: ReadonlyArray<string> | undefined,
  git: GitLookup,
  cap: number,
): Effect.Effect<Found, Error> =>
  Effect.gen(function* () {
    const changes = yield* git.changes(find.ref ?? "HEAD")
    const only = files ? new Set(files.map(normalize)) : undefined
    const inScope = find.glob?.length ? globScope(find.glob) : undefined
    const raw: Raw = new Map()
    let lines = 0
    for (const [file, ranges] of changes) {
      if (only && !only.has(file)) continue
      if (inScope && !inScope(file)) continue
      const list = ranges === "all" ? [[1, Number.MAX_SAFE_INTEGER] as const] : [...ranges]
      raw.set(file, list)
      // An untracked file's size is unknown until it is read, so it counts as one line here; the
      // cap in `evaluate` is applied again to the measured result.
      lines += ranges === "all" ? 1 : ranges.reduce((sum, [a, b]) => sum + b - a + 1, 0)
    }
    if (lines > cap) return { raw: new Map(), overCap: { hits: lines, files: raw.size } }
    return { raw }
  })

// --- where -----------------------------------------------------------------

// Narrow raw hits to the lines that also pass the rule's git filter. `changed` goes first because
// it is one git call for the whole repo and usually removes most files, which is what keeps the
// per-file blame behind `author`/`since` affordable.
const applyWhere = (where: GitFilter, raw: Raw, git: GitLookup): Effect.Effect<{ raw: Raw; error?: string }, Error> =>
  Effect.gen(function* () {
    const changes = where.changed ? yield* git.changes(where.changed) : undefined
    const afterChanged: Raw = new Map()
    for (const [file, ranges] of raw) {
      const changed = changes ? changes.get(file) : "all"
      if (!changed) continue
      const kept = changed === "all" ? ranges : intersect(ranges, changed)
      if (kept.length) afterChanged.set(file, kept)
    }
    if (!where.author && !where.since) return { raw: afterChanged }
    if (afterChanged.size > MAX_BLAME_FILES)
      return {
        raw: new Map(),
        error: `the author/since filter would blame ${afterChanged.size} files (limit ${MAX_BLAME_FILES}) — narrow the finder with a glob or add a "changed" filter`,
      }
    const author = where.author?.toLowerCase()
    const out: Raw = new Map()
    for (const [file, ranges] of afterChanged) {
      const blame = yield* git.blame(file, where.since)
      // No blame means git has never seen the file: every line is the user's own uncommitted
      // work. That is recent by definition, and attributable to no named author.
      const keep = (line: number) => {
        const entry = blame?.[line - 1]
        if (
          author &&
          !(entry && (entry.author.toLowerCase().includes(author) || entry.mail.toLowerCase().includes(author)))
        )
          return false
        return !where.since || !entry || entry.recent
      }
      const kept = ranges.flatMap(([start, end]) => runsOf(start, Math.min(end, blame?.length ?? end), keep))
      if (kept.length) out.set(file, kept)
    }
    return { raw: out }
  })

// Intersect two range lists (1-based inclusive). Neither needs to be sorted or merged.
function intersect(
  a: ReadonlyArray<readonly [number, number]>,
  b: ReadonlyArray<readonly [number, number]>,
): Array<readonly [number, number]> {
  return a.flatMap(([s1, e1]) =>
    b.flatMap(([s2, e2]): Array<readonly [number, number]> => {
      const start = Math.max(s1, s2)
      const end = Math.min(e1, e2)
      return start <= end ? [[start, end]] : []
    }),
  )
}

// The maximal runs of lines in [start, end] for which `keep` holds.
function runsOf(start: number, end: number, keep: (line: number) => boolean): Array<readonly [number, number]> {
  const runs: Array<readonly [number, number]> = []
  let open: number | undefined
  for (let line = start; line <= end; line++) {
    if (keep(line)) open ??= line
    else if (open !== undefined) {
      runs.push([open, line - 1])
      open = undefined
    }
  }
  if (open !== undefined) runs.push([open, end])
  return runs
}

// --- shared ----------------------------------------------------------------

// Normalise every range against the file it refers to. `clampRanges` drops ranges past the
// end of the file (ripgrep and this read can disagree if a write lands between them, which
// would otherwise decorate a line the buffer doesn't have) and merges adjacent ones, so two
// hits on consecutive lines are one strip and count once rather than twice.
const clampAll = (directory: string, perFile: Raw) =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const out = new Map<string, Measured>()
    for (const [rel, ranges] of perFile) {
      const content = yield* fs
        .readFileStringSafe(path.join(directory, rel))
        .pipe(Effect.orElseSucceed(() => undefined as string | undefined))
      if (content === undefined) continue
      const measured = measure(ranges, content)
      if (measured) out.set(rel, measured)
    }
    return out
  }).pipe(Effect.provide(FSUtil.defaultLayer))

// Clamp + merge one file's ranges and measure what they cover.
//
// Bytes are counted per line *including* its terminator. Returns undefined when nothing survives
// the clamp, which is the caller's signal to omit the file entirely.
function measure(ranges: ReadonlyArray<readonly [number, number]>, content: string): Measured | undefined {
  const clamped = ApertureExtents.clampRanges(ranges, content)
  if (clamped.length === 0) return undefined
  const rawLines = content.split("\n")
  const lineBytes = rawLines.map((l, i) => Buffer.byteLength(l) + (i < rawLines.length - 1 ? 1 : 0))
  let lines = 0
  let bytes = 0
  for (const [start, end] of clamped) {
    lines += end - start + 1
    for (let i = start - 1; i <= end - 1; i++) bytes += lineBytes[i] ?? 0
  }
  return { ranges: clamped, lines, bytes }
}

// A predicate deciding whether a repo-relative file is inside `globs`, read the way ripgrep reads
// `--glob` during a walk, so that filtering a file list agrees with searching the repo:
//   - a glob with no "/" matches the file's basename at any depth ("*.ts" matches "a/b.ts");
//   - any other glob is anchored at the root ("src/x.ts" never matches "pkg/src/x.ts"), and a
//     leading "/" only makes that explicit;
//   - "!" excludes, and the LAST glob that matches decides;
//   - a file no glob matches is in scope only when every glob is an exclusion.
// A directory glob ("src/aperture") does not match the files beneath it, in ripgrep or here.
function globScope(globs: ReadonlyArray<string>): (file: string) => boolean {
  const compiled = globs.map((glob) => {
    const exclude = glob.startsWith("!")
    const body = exclude ? glob.slice(1) : glob
    return {
      exclude,
      glob: new Bun.Glob(body.includes("/") ? body.replace(/^\/+/, "") : `**/${body}`),
    }
  })
  const fallback = compiled.every((c) => c.exclude)
  return (file) => {
    const last = compiled.findLast((c) => c.glob.match(file))
    return last ? !last.exclude : fallback
  }
}

// Ripgrep already strips a leading "./" (see `clean`), but it reports native separators on
// Windows while every path in the payload is "/"-joined repo-relative.
function normalize(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "")
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export * as ApertureRules from "./rules"
