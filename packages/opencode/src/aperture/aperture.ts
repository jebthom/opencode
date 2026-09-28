import { Context, Effect, Layer, Stream } from "effect"
import path from "path"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import * as Log from "@opencode-ai/core/util/log"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { EventV2 } from "@opencode-ai/core/event"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Database } from "@opencode-ai/core/database/database"
import { SessionStatus } from "@/session/status"
import { MessageV2 } from "@/session/message-v2"
import type { SessionID } from "@/session/schema"
import { InstanceState } from "@/effect/instance-state"
import { registerDisposer } from "@/effect/instance-registry"
import { Git } from "@/git"
import { AperturePayload } from "./payload"
import { ApertureEvent } from "./event"
import { ApertureGitLookup } from "./git-lookup"
import { ApertureFiles } from "./files"
import { ApertureRules } from "./rules"
import { ApertureLensStore } from "./lens-store"
import { ApertureLensHistory, type Actor } from "./lens-history"
import { ApertureActivityModel, type DerivedTurn } from "./activity-model"
import { modeOf, type Turn as ActivityTurn, type ActivityEntry } from "./activity"
import {
  type Facet,
  type Finder,
  type GitFilter,
  type Lens,
  type Rule,
  facetsWithin,
  findFacet,
  isGitRule,
  legend as lensLegend,
} from "./lenses"

// Server-side Aperture service (v3).
//
// A Lens is a named collection of facets, and every facet is owned by *rules*: deterministic
// finders re-evaluated against the files on disk. There is no painter, no model call and no
// persisted classification anywhere in this service — the only durable state is the rules
// themselves (lens-store) and the history of how they changed (lens-history). Everything a
// surface shows is derived at the read boundary from the active Lens's rule hits, memoized per
// directory and re-derived per file as files change.
//
// Three reads serve every surface:
//   - facetMap: every marked file in the repo with its per-facet line counts (the top-bar grid,
//     the VSCode tree chips);
//   - lines: one file's line tags (the editor gutter);
//   - activity: a session's recent turns, with the facets of the files each touched (sidebar).

const log = Log.create({ service: "aperture" })

// How many matched lines `lens_mark` echoes back, and how wide. The sample lets an agent see
// that its query matched the *wrong* thing; the hit count is what tells it the query is too
// broad. Bounded because each sample costs a file read.
const MARK_SAMPLE_FILES = 5
const MARK_SAMPLE_CHARS = 120

// --- activity (G1) ---------------------------------------------------------
const ACTIVITY_TURNS_DEFAULT = 20
const ACTIVITY_TURNS_MAX = 100
const ACTIVITY_PAGE_SIZE = 50
const ACTIVITY_MESSAGE_CAP = 1000
const ACTIVITY_MAX_DEPTH = 1
const ACTIVITY_MAX_CHILDREN = 16
const ACTIVITY_CHILD_TURNS = 1

export interface MarkLensInput {
  // Id or name of the Lens. A name that resolves to nothing creates a Lens with that name, owned
  // by the actor.
  readonly lens: string
  // The concern: an existing facet id/label (add another rule to it) or a new name (mint it).
  readonly facet: string
  readonly definition?: string
  // Lens description, used only when this call creates the Lens.
  readonly about?: string
  readonly find: Finder
  readonly where?: GitFilter
  readonly note?: string
  // Switch the user's view to this Lens. An agent switching away from a user's Lens needs
  // consent; such a request is reported back as `activation: "needs-consent"` rather than done.
  readonly activate?: boolean
}

// One matched line, for the sample `lens_mark` shows the agent.
export interface MarkSample {
  readonly file: string
  readonly line: number
  readonly text: string
}

export type MarkOutcome =
  | {
      readonly status: "ok"
      readonly lens: Lens
      readonly facet: Facet
      readonly rule: Rule
      readonly createdLens: boolean
      readonly minted: boolean
      readonly replaced?: Rule
      // The finder as evaluated over the whole repo. The hit count is the safety mechanism: an
      // agent that sees "4,182 lines across 903 files" narrows the query.
      readonly diagnostic: ApertureRules.RuleDiagnostic
      readonly samples: ReadonlyArray<MarkSample>
      readonly activation: "switched" | "already-active" | "not-requested" | "needs-consent"
      // False when the write to lenses.json failed — the caller must not claim it landed.
      readonly written: boolean
    }
  // The finder can never paint (uncompilable regex, bad ref, absent structural backend). Nothing
  // was stored, and `detail` is the evaluator's own message so the agent can self-correct.
  | { readonly status: "dead-rule"; readonly detail: string }
  // Matched nothing. Also not stored: a mistyped symbol name would otherwise become a
  // permanently invisible concern that looks installed.
  | { readonly status: "no-hits" }
  | Exclude<ApertureLensStore.MarkResult, { readonly status: "ok" }>

export type SelectOutcome =
  | { readonly status: "ok"; readonly lens: Lens }
  | { readonly status: "not-found" }
  // An agent tried to switch the view away from a Lens the user owns.
  | { readonly status: "needs-consent"; readonly lens: Lens }

export type DeleteOutcome =
  | { readonly status: "ok"; readonly active?: AperturePayload.LensInfo }
  | { readonly status: "not-found" }
  | { readonly status: "needs-consent"; readonly lens: Lens }

// Files carrying one or more facets of a Lens, grouped by facet — so an agent can read the
// marked files of a concern itself.
export type FacetFilesOutcome =
  | {
      readonly status: "ok"
      readonly lens: { readonly id: string; readonly name: string }
      readonly groups: ReadonlyArray<{
        readonly facet: string
        readonly label: string
        readonly paths: ReadonlyArray<string>
      }>
      readonly unknownFacets: ReadonlyArray<string>
    }
  | { readonly status: "not-found" }

// One marked file: `m` is its marks per facet — `f` indexes the response's `facets`, `l` is marked
// lines and `b` marked bytes — ascending by `f` so the output is byte-stable (the extension's
// compare-before-fire guard against tree flicker depends on it). Raw counts rather than
// percentages because a count rolls up by plain summation: a folder chip adds its descendants'
// marks with no denominator and nothing can be rounded away on the way up. `line` is the first
// marked line, so a click can open the file where the marks start.
export interface FacetMapFile {
  readonly m: ReadonlyArray<{ readonly f: number; readonly l: number; readonly b: number }>
  readonly line: number
}

export interface FacetMap {
  readonly lens?: AperturePayload.LensInfo
  // Facet ids in legend order, so `f` indexes into this.
  readonly facets: ReadonlyArray<string>
  // Every file with at least one marked line, keyed by repo-relative path.
  readonly files: Record<string, FacetMapFile>
  // The facets toggled off in the legend (O4), so a late or reconnecting client paints the same
  // filter the others are painting.
  readonly suppressed: ReadonlyArray<string>
}

// A session's agent activity, per turn, with the marks of every touched file under the ACTIVE
// Lens (PLAN.md G1). Nothing here is recorded: `turns` is derived from the durable message store
// at the read boundary, and the facets are resolved on the way out, so a Lens switch recolours
// history without re-recording it. The facet half is shaped exactly like `FacetMap`.
export interface Activity {
  readonly lens?: AperturePayload.LensInfo
  readonly facets: ReadonlyArray<string>
  readonly turns: ReadonlyArray<ActivityTurn>
  // Marks per *touched* path, deduped across turns. Unmarked paths are absent.
  readonly files: Record<string, FacetMapFile>
  readonly suppressed: ReadonlyArray<string>
}

export interface Interface {
  readonly lenses: () => Effect.Effect<Lens[]>
  readonly activeLens: () => Effect.Effect<Lens | undefined>
  readonly selectLens: (idOrName: string, actor: Actor) => Effect.Effect<SelectOutcome>
  // Step one Lens forward ("next") or back ("prev"), wrapping at the ends. Drives the top bar's
  // ◀/▶ arrows. Undefined when there are no Lenses.
  readonly cycleLens: (direction: "next" | "prev", actor: Actor) => Effect.Effect<AperturePayload.LensInfo | undefined>
  // Rename a Lens or relabel/redefine its facets. Changes no rule, so nothing is re-derived.
  readonly editLens: (
    input: ApertureLensStore.UpdateInput & { readonly lens: string },
    actor: Actor,
  ) => Effect.Effect<ApertureLensStore.UpdateResult>
  // Install a rule, minting its concern and the Lens itself if needed. Evaluates the finder once
  // over the whole repo and returns the hit count plus a sample; refuses to store a rule that
  // cannot paint.
  readonly markLens: (input: MarkLensInput, actor: Actor) => Effect.Effect<MarkOutcome>
  // Remove one rule by id, or a whole concern with every rule naming it.
  readonly unmarkLens: (
    input: { readonly lens: string; readonly rule?: string; readonly facet?: string },
    actor: Actor,
  ) => Effect.Effect<ApertureLensStore.UnmarkResult>
  readonly deleteLens: (idOrName: string, actor: Actor) => Effect.Effect<DeleteOutcome>
  // The marked files of the given facets of a Lens (default: the active one; empty facets = all).
  readonly facetFiles: (lens: string | undefined, facets: ReadonlyArray<string>) => Effect.Effect<FacetFilesOutcome>
  readonly facetMap: () => Effect.Effect<FacetMap>
  readonly lines: (file: string) => Effect.Effect<AperturePayload.Lines>
  readonly activity: (sessionID: string, turns?: number) => Effect.Effect<Activity>
  readonly history: (query: ApertureLensHistory.Query) => Effect.Effect<ApertureLensHistory.Entry[]>
  // The legend filter (O4): facet ids the user has toggled off, which every surface paints grey.
  // View-only and in-memory. `setFacetFilter` replaces the whole set and returns what was kept.
  readonly facetFilter: () => Effect.Effect<string[]>
  readonly setFacetFilter: (facets: ReadonlyArray<string>) => Effect.Effect<string[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Aperture") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const git = yield* Git.Service
    // Captured here so `activity`'s message reads keep the service's R = never.
    const database = yield* Database.Service

    // Directories some surface has read from. File and turn events for any other directory are
    // ignored, so an unopened project costs nothing.
    const opened = new Set<string>()

    // The repo's source-file set per directory, for `activity`. Dropped on file and turn events.
    const filesCache = new Map<string, ReadonlySet<string>>()
    const filesFor = (directory: string) =>
      Effect.gen(function* () {
        const cached = filesCache.get(directory)
        if (cached) return cached
        const files = new Set(
          yield* ApertureFiles.listFiles(directory).pipe(
            Effect.catch((cause) => {
              log.error("listFiles failed", { directory, cause })
              return Effect.succeed([] as string[])
            }),
            Effect.provide(FSUtil.defaultLayer),
          ),
        )
        filesCache.set(directory, files)
        return files
      })

    const readFileText = (directory: string, rel: string) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        return yield* fs
          .readFileStringSafe(path.join(directory, rel))
          .pipe(Effect.orElseSucceed(() => undefined as string | undefined))
      }).pipe(Effect.provide(FSUtil.defaultLayer))

    // --- git --------------------------------------------------------------

    // Whether the directory is a git work tree, cached because it almost never changes (only
    // `git init`). Dropped on turn completion, since an agent may have run `git init`.
    const isRepoCache = new Map<string, boolean>()
    const isRepoFor = (directory: string) =>
      Effect.gen(function* () {
        const cached = isRepoCache.get(directory)
        if (cached !== undefined) return cached
        const repo = yield* git.isRepo(directory)
        isRepoCache.set(directory, repo)
        return repo
      })

    const headOf = (directory: string) =>
      git
        .run(["rev-parse", "HEAD"], { cwd: directory })
        .pipe(Effect.map((result) => (result.exitCode === 0 ? result.text().trim() : "none")))

    // A fresh GitLookup for one evaluation (see git-lookup.ts), or undefined outside a work tree.
    const gitLookupFor = (directory: string) =>
      isRepoFor(directory).pipe(Effect.map((repo) => (repo ? ApertureGitLookup.make(git, directory) : undefined)))

    // --- rule hits --------------------------------------------------------

    // Evaluated rules per directory. Line tags are *derived* — never persisted — so this is the
    // only thing standing between the read boundary and a fresh whole-repo grep on every fetch.
    //
    // Keyed on (lensID, key) as fields rather than as a map key: exactly one entry per directory,
    // replaced wholesale when either changes, so switching Lens or editing a rule can never leak
    // an entry. `key` is the rules hash, plus HEAD when any rule is git-shaped — a commit moves
    // what `diff` and `where` mean without touching a single file the watcher would report.
    interface RuleMemo {
      readonly lensID: string
      readonly key: string
      readonly byFile: Map<string, ReadonlyArray<ApertureRules.RuleHit>>
      // Rule ids the last FULL pass found too broad. Carried because the incremental path
      // re-evaluates single files, where a rule matching a third of the repo looks perfectly
      // narrow — without this, one edit would un-suppress it.
      readonly overCap: ReadonlySet<string>
      // Files edited since the last evaluation, re-derived lazily on the next read.
      readonly stale: Set<string>
    }
    const ruleMemo = new Map<string, RuleMemo>()

    // The Lens's rule hits, whole-repo, memoized. The incremental path is the point of the
    // structure: every content finder is a pure function of one file's content, so a changed file
    // is re-derived alone.
    const ruleHitsFor = (directory: string, lens: Lens) =>
      Effect.gen(function* () {
        const rules = lens.rules ?? []
        if (rules.length === 0) return new Map<string, ReadonlyArray<ApertureRules.RuleHit>>()
        const gitShaped = rules.some(isGitRule)
        const key = ApertureRules.rulesHash(rules) + (gitShaped ? ":" + (yield* headOf(directory)) : "")
        const lookup = gitShaped ? yield* gitLookupFor(directory) : undefined
        const memo = ruleMemo.get(directory)
        if (!memo || memo.lensID !== lens.id || memo.key !== key) {
          const result = yield* ApertureRules.evaluate(directory, rules, undefined, lookup)
          const overCap = new Set(result.diagnostics.filter((d) => d.overCap).map((d) => d.rule))
          ruleMemo.set(directory, { lensID: lens.id, key, byFile: new Map(result.byFile), overCap, stale: new Set() })
          for (const d of result.diagnostics)
            if (d.overCap || d.error) log.warn("rule not painted", { lens: lens.id, ...d })
          return result.byFile
        }
        if (memo.stale.size) {
          const files = [...memo.stale]
          memo.stale.clear()
          const result = yield* ApertureRules.evaluate(directory, rules, files, lookup)
          // Delete first, then re-add: a file whose last matching line was just deleted has no
          // entry in the new result at all. This is where "a deleted usage loses its paint"
          // actually happens.
          for (const file of files) memo.byFile.delete(file)
          for (const [file, hits] of result.byFile) {
            const kept = hits.filter((h) => !memo.overCap.has(h.rule))
            if (kept.length) memo.byFile.set(file, kept)
          }
        }
        return memo.byFile
      })

    // --- view state and invalidation -------------------------------------

    // Facets the user has toggled off in the legend, per directory (O4). Held server-side so the
    // TUI and the VSCode extension filter as one. In-memory and never persisted: it is a way of
    // *looking* at a Lens, not part of one.
    const suppressedFacets = new Map<string, Set<string>>()

    const off = registerDisposer(async (directory) => {
      opened.delete(directory)
      filesCache.delete(directory)
      ruleMemo.delete(directory)
      isRepoCache.delete(directory)
      suppressedFacets.delete(directory)
    })
    yield* Effect.addFinalizer(() => Effect.sync(off))

    // Tell every surface to refetch. The location is mandatory: this often runs in a forked fiber
    // with no ambient Location.Service, and the /event SSE filter drops a location-less event, so
    // without it the VSCode extension would silently never repaint (A6).
    const publishInvalidated = (directory: string) =>
      events
        .publish(
          ApertureEvent.Event.Invalidated,
          { scope: "" },
          { location: { directory: AbsolutePath.make(directory) } },
        )
        .pipe(Effect.ignore)

    // The active Lens changed. A legend filter is expressed in the outgoing Lens's vocabulary, so
    // it means nothing under the incoming one — carrying it over would silently grey out facets
    // the user has never filtered.
    const onLensChanged = (directory: string) =>
      Effect.gen(function* () {
        if (suppressedFacets.delete(directory))
          yield* events
            .publish(
              ApertureEvent.Event.FacetsFiltered,
              { facets: [] },
              { location: { directory: AbsolutePath.make(directory) } },
            )
            .pipe(Effect.ignore)
        yield* publishInvalidated(directory)
      })

    // A file changed: re-derive that file's hits on the next read. Not a whole-memo drop — every
    // content finder is a pure function of one file's content, so an edit costs one file's work.
    const onFileChanged = (absFile: string, location: EventV2.Payload["location"]) =>
      Effect.gen(function* () {
        const directory = location?.directory
        if (!directory || !opened.has(directory)) return
        const rel = toRepoRelative(directory, absFile)
        if (rel === undefined) return
        filesCache.delete(directory)
        const memo = ruleMemo.get(directory)
        if (!memo) return
        memo.byFile.delete(rel)
        memo.stale.add(rel)
        yield* publishInvalidated(directory)
      })

    yield* Effect.forkScoped(
      events
        .subscribe(Watcher.Event.Updated)
        .pipe(Stream.runForEach((event) => onFileChanged(event.data.file, event.location))),
    )
    yield* Effect.forkScoped(
      events
        .subscribe(FileSystem.Event.Edited)
        .pipe(Stream.runForEach((event) => onFileChanged(event.data.file, event.location))),
    )

    // Turn completion. Shell commands (mv/rm/scaffolding, git checkout/commit) change the tree
    // without firing a single file event, so after a turn the per-file staleness set can't be
    // trusted: drop the whole memo and the file set, and let the next read re-derive.
    const onSessionIdle = (location: EventV2.Payload["location"]) =>
      Effect.gen(function* () {
        const directory = location?.directory
        if (!directory || !opened.has(directory)) return
        filesCache.delete(directory)
        isRepoCache.delete(directory)
        ruleMemo.delete(directory)
        yield* publishInvalidated(directory)
      })
    yield* Effect.forkScoped(
      events
        .subscribe(SessionStatus.Event.Status)
        .pipe(
          Stream.runForEach((event) =>
            event.data.status.type === "idle" ? onSessionIdle(event.location) : Effect.void,
          ),
        ),
    )

    // --- lenses -----------------------------------------------------------

    const lenses = Effect.fn("Aperture.lenses")(function* () {
      const ctx = yield* InstanceState.context
      return yield* ApertureLensStore.list(ctx.directory)
    })

    const activeLens = Effect.fn("Aperture.activeLens")(function* () {
      const ctx = yield* InstanceState.context
      return yield* ApertureLensStore.getActive(ctx.directory)
    })

    // Whether `actor` switching the view away from `current` needs the user's say-so.
    const switchNeedsConsent = (actor: Actor, current: Lens | undefined, next: Lens) =>
      actor.kind === "agent" &&
      !actor.consented &&
      current !== undefined &&
      current.id !== next.id &&
      current.owner === "user"

    const selectLens = Effect.fn("Aperture.selectLens")(function* (idOrName: string, actor: Actor) {
      const ctx = yield* InstanceState.context
      const found = ApertureLensStore.resolve(yield* ApertureLensStore.list(ctx.directory), idOrName)
      if (!found) return { status: "not-found" } as const
      const current = yield* ApertureLensStore.getActive(ctx.directory)
      if (switchNeedsConsent(actor, current, found)) return { status: "needs-consent", lens: current! } as const
      yield* ApertureLensStore.setActive(ctx.directory, found, actor)
      yield* onLensChanged(ctx.directory)
      return { status: "ok", lens: found } as const
    })

    const cycleLens = Effect.fn("Aperture.cycleLens")(function* (direction: "next" | "prev", actor: Actor) {
      const ctx = yield* InstanceState.context
      const all = yield* ApertureLensStore.list(ctx.directory)
      if (all.length === 0) return undefined
      const current = yield* ApertureLensStore.getActive(ctx.directory)
      const idx = Math.max(
        0,
        all.findIndex((c) => c.id === current?.id),
      )
      const next = all[(idx + (direction === "next" ? 1 : all.length - 1)) % all.length]!
      yield* ApertureLensStore.setActive(ctx.directory, next, actor)
      yield* onLensChanged(ctx.directory)
      return lensInfo(next)
    })

    const editLens = Effect.fn("Aperture.editLens")(function* (
      input: ApertureLensStore.UpdateInput & { readonly lens: string },
      actor: Actor,
    ) {
      const ctx = yield* InstanceState.context
      const found = ApertureLensStore.resolve(yield* ApertureLensStore.list(ctx.directory), input.lens)
      if (!found) return { status: "not-found" } as const
      const result = yield* ApertureLensStore.update(ctx.directory, found.id, input, actor)
      if (result.status === "ok") yield* publishInvalidated(ctx.directory)
      return result
    })

    // Install a rule. The ORDER here is the design: resolve the Lens, EVALUATE the finder before
    // touching the store, and only then persist. Evaluating first keeps a rule that can never
    // paint out of a committed lenses.json, and means a refused mark leaves nothing behind — no
    // freshly-minted empty concern and no empty Lens created for a call that then failed.
    const markLens = Effect.fn("Aperture.markLens")(function* (input: MarkLensInput, actor: Actor) {
      const ctx = yield* InstanceState.context
      const found = ApertureLensStore.resolve(yield* ApertureLensStore.list(ctx.directory), input.lens)

      // Evaluated under a provisional id — the store mints the real one, and the hit set depends
      // on neither.
      const probe: Rule = {
        id: "probe",
        facet: "probe",
        find: input.find,
        ...(input.where ? { where: input.where } : {}),
      }
      const lookup = isGitRule(probe) ? yield* gitLookupFor(ctx.directory) : undefined
      const result = yield* ApertureRules.evaluate(ctx.directory, [probe], undefined, lookup)
      const diagnostic = result.diagnostics[0]
      if (!diagnostic || diagnostic.error)
        return { status: "dead-rule", detail: diagnostic?.error ?? "the finder could not be evaluated" } as const
      if (diagnostic.hits === 0) return { status: "no-hits" } as const

      // Over-cap is NOT a refusal: the rule stores and is reported as too broad rather than
      // painted, so the agent can narrow it or drop it deliberately.
      const mark: ApertureLensStore.MarkInput = {
        facet: input.facet,
        ...(input.definition ? { definition: input.definition } : {}),
        find: input.find,
        ...(input.where ? { where: input.where } : {}),
        ...(input.note ? { note: input.note } : {}),
        hits: { lines: diagnostic.hits, files: diagnostic.files, ...(diagnostic.overCap ? { overCap: true } : {}) },
      }
      const stored = found
        ? yield* ApertureLensStore.mark(ctx.directory, found.id, mark, actor)
        : yield* ApertureLensStore.create(
            ctx.directory,
            { ...mark, name: input.lens, description: input.about?.trim() || `Marks for ${input.lens}.` },
            actor,
          )
      if (stored.status !== "ok") return stored

      // Samples come from the evaluated hits, which carry ranges only — the text is read here.
      const samples: MarkSample[] = []
      for (const [file, hits] of result.byFile) {
        if (samples.length >= MARK_SAMPLE_FILES) break
        const first = hits[0]?.ranges[0]
        if (!first) continue
        const content = yield* readFileText(ctx.directory, file)
        const text = content?.split("\n")[first[0] - 1]?.trim()
        if (text) samples.push({ file, line: first[0], text: text.slice(0, MARK_SAMPLE_CHARS) })
      }

      const current = yield* ApertureLensStore.getActive(ctx.directory)
      const activation = yield* Effect.gen(function* () {
        if (current?.id === stored.lens.id) {
          // Same Lens, new rules: publish and nothing else. Routing this through onLensChanged
          // would wipe the user's legend filter on every mark — and marking is the act most
          // likely to happen while a filter is on.
          yield* publishInvalidated(ctx.directory)
          return "already-active" as const
        }
        if (!input.activate) return "not-requested" as const
        if (switchNeedsConsent(actor, current, stored.lens)) return "needs-consent" as const
        yield* ApertureLensStore.setActive(ctx.directory, stored.lens, actor)
        yield* onLensChanged(ctx.directory)
        return "switched" as const
      })

      return {
        status: "ok",
        lens: stored.lens,
        facet: stored.facet,
        rule: stored.rule,
        createdLens: stored.createdLens,
        minted: stored.minted,
        ...(stored.replaced ? { replaced: stored.replaced } : {}),
        diagnostic,
        samples,
        activation,
        written: stored.written,
      } as const
    })

    const unmarkLens = Effect.fn("Aperture.unmarkLens")(function* (
      input: { readonly lens: string; readonly rule?: string; readonly facet?: string },
      actor: Actor,
    ) {
      const ctx = yield* InstanceState.context
      const found = ApertureLensStore.resolve(yield* ApertureLensStore.list(ctx.directory), input.lens)
      if (!found) return { status: "not-found" } as const
      const result = yield* ApertureLensStore.unmark(ctx.directory, found.id, input, actor)
      if (result.status !== "ok") return result
      // The memo is keyed by rules hash, so the next read replaces it — except when the last rule
      // went, since `ruleHitsFor` returns early for a rule-less Lens before consulting the memo.
      if (!result.lens.rules?.length) ruleMemo.delete(ctx.directory)
      yield* publishInvalidated(ctx.directory)
      return result
    })

    const deleteLens = Effect.fn("Aperture.deleteLens")(function* (idOrName: string, actor: Actor) {
      const ctx = yield* InstanceState.context
      const found = ApertureLensStore.resolve(yield* ApertureLensStore.list(ctx.directory), idOrName)
      if (!found) return { status: "not-found" } as const
      const removed = yield* ApertureLensStore.remove(ctx.directory, found.id, actor)
      if (removed.status !== "ok") return removed
      // A deleted active Lens needs no pointer rewrite: `getActive` falls back to the first Lens.
      yield* onLensChanged(ctx.directory)
      const active = yield* ApertureLensStore.getActive(ctx.directory)
      return { status: "ok", ...(active ? { active: lensInfo(active) } : {}) } as const
    })

    // --- reads ------------------------------------------------------------

    // The active Lens and its hits — the start of every read. Marks the directory as opened so
    // file and turn events start invalidating it.
    const viewed = (directory: string) =>
      Effect.gen(function* () {
        opened.add(directory)
        const lens = yield* ApertureLensStore.getActive(directory)
        const hits = lens
          ? yield* ruleHitsFor(directory, lens)
          : new Map<string, ReadonlyArray<ApertureRules.RuleHit>>()
        return { lens, hits }
      })

    const facetFiles = Effect.fn("Aperture.facetFiles")(function* (
      lensRef: string | undefined,
      facets: ReadonlyArray<string>,
    ) {
      const ctx = yield* InstanceState.context
      const lens = lensRef
        ? ApertureLensStore.resolve(yield* ApertureLensStore.list(ctx.directory), lensRef)
        : yield* ApertureLensStore.getActive(ctx.directory)
      if (!lens) return { status: "not-found" } as const
      const hits = yield* ruleHitsFor(ctx.directory, lens)
      const requested = facets.length ? facets : lens.facets.map((t) => t.id)
      const resolved = requested.map((ref) => ({ ref, facet: findFacet(lens, ref) }))
      const groups = [
        ...new Map(resolved.flatMap((r) => (r.facet ? [[r.facet.id, r.facet] as const] : []))).values(),
      ].map((facet) => ({
        facet: facet.id,
        label: facet.label,
        paths: [...hits]
          .filter(([, fileHits]) => fileHits.some((h) => h.facet === facet.id))
          .map(([file]) => file)
          .sort(),
      }))
      return {
        status: "ok",
        lens: { id: lens.id, name: lens.name },
        groups,
        unknownFacets: resolved.filter((r) => !r.facet).map((r) => r.ref),
      } as const
    })

    const facetMap = Effect.fn("Aperture.facetMap")(function* () {
      const ctx = yield* InstanceState.context
      const { lens, hits } = yield* viewed(ctx.directory)
      const facets = lens?.facets.map((t) => t.id) ?? []
      return {
        ...(lens ? { lens: lensInfo(lens) } : {}),
        facets,
        files: computeFacetMapFiles(hits, facets),
        suppressed: [...(suppressedFacets.get(ctx.directory) ?? [])],
      }
    })

    const lines = Effect.fn("Aperture.lines")(function* (file: string) {
      const ctx = yield* InstanceState.context
      const rel = ApertureFiles.normalizePath(file)
      const { lens, hits } = yield* viewed(ctx.directory)
      const colorByFacet = new Map(lens?.facets.map((t) => [t.id, t.color]))
      const tags = (hits.get(rel) ?? []).flatMap((hit) =>
        hit.ranges.map(
          ([startLine, endLine]): AperturePayload.LineTag => ({
            startLine,
            endLine,
            facet: hit.facet,
            ...(colorByFacet.get(hit.facet) ? { hue: colorByFacet.get(hit.facet)! } : {}),
            rule: hit.rule,
            ...(hit.note ? { note: hit.note } : {}),
          }),
        ),
      )
      return {
        ...(lens ? { lens: lensInfo(lens) } : {}),
        path: rel,
        tags,
        suppressed: [...(suppressedFacets.get(ctx.directory) ?? [])],
      }
    })

    // Per-turn agent activity for a session, facet-resolved under the active Lens (G1).
    const activity = Effect.fn("Aperture.activity")(function* (sessionID: string, turnCount?: number) {
      const ctx = yield* InstanceState.context
      const maxTurns = Math.max(1, Math.min(turnCount ?? ACTIVITY_TURNS_DEFAULT, ACTIVITY_TURNS_MAX))
      const derived = yield* readTurns(ctx.directory, sessionID, maxTurns)
      const known = yield* filesFor(ctx.directory)

      // Settle what each path-bearing entry actually points at, against the same source-file set
      // every other surface uses:
      //  - a path in the file set is a `file`;
      //  - a path *above* a known file is a `place` (a directory read or a search scope): counted
      //    as navigation, contributing no cells;
      //  - a *mutation* to anything else (package.json, a migration, a README) is kept anyway as
      //    a `file` — it is unambiguously a lasting change to the repo, and dropping it would
      //    silently omit exactly what the Activity Path exists to show;
      //  - anything else is dropped.
      const places = new Set<string>([""])
      for (const file of known)
        for (let i = file.indexOf("/"); i !== -1; i = file.indexOf("/", i + 1)) places.add(file.slice(0, i))
      const classify = (entry: ActivityEntry): ActivityEntry | undefined => {
        if (entry.path === undefined) return entry
        if (known.has(entry.path)) return entry.target === "file" ? entry : { ...entry, target: "file" }
        if (places.has(entry.path)) return entry.target === "place" ? entry : { ...entry, target: "place" }
        if (modeOf(entry.action) === "mutate" && !ApertureFiles.isIgnoredPath(entry.path))
          return { ...entry, target: "file" }
        return undefined
      }
      const turns = derived.map((turn) => ({
        promptedAt: turn.promptedAt,
        agent: turn.agent,
        entries: turn.entries.flatMap((entry) => {
          const settled = classify(entry)
          return settled ? [settled] : []
        }),
      }))

      const touched = new Set(
        turns.flatMap((turn) => turn.entries.flatMap((e) => (e.target === "file" && e.path ? [e.path] : []))),
      )
      const { lens, hits } = yield* viewed(ctx.directory)
      const facets = lens?.facets.map((t) => t.id) ?? []
      return {
        ...(lens ? { lens: lensInfo(lens) } : {}),
        facets,
        turns,
        files: computeFacetMapFiles(new Map([...hits].filter(([file]) => touched.has(file))), facets),
        suppressed: [...(suppressedFacets.get(ctx.directory) ?? [])],
      }
    })

    // Walk a session's messages newest-first until `maxTurns` prompts have been seen, fold them
    // into turns, then fold each turn's sub-agent sessions in beneath it. Paging backwards keeps
    // this bounded: a months-old session costs the same as a fresh one.
    const readTurns = (
      directory: string,
      sessionID: string,
      maxTurns: number,
      depth = 0,
    ): Effect.Effect<DerivedTurn[]> =>
      Effect.gen(function* () {
        const messages = yield* recentMessages(sessionID, maxTurns)
        const turns = ApertureActivityModel.deriveTurns(messages, { directory, sessionID, depth, maxTurns })
        // Sub-agent work lives in its own session, and the sidebar is hidden inside those — so
        // folding it into the parent's turn is the only way it is ever seen. Bounded in depth and
        // fan-out so one heavily-parallel turn can't make a refresh unbounded.
        if (depth >= ACTIVITY_MAX_DEPTH) return turns
        for (const turn of turns) {
          for (const child of turn.children.slice(0, ACTIVITY_MAX_CHILDREN)) {
            const childTurns = yield* readTurns(directory, child.sessionID, ACTIVITY_CHILD_TURNS, depth + 1)
            // Anchored to the `task` call: the child's own parts live in a session this
            // transcript does not render, so the call that spawned them is the only click target.
            for (const childTurn of childTurns)
              ApertureActivityModel.mergeChildEntries(turn, childTurn.entries, {
                messageID: child.messageID,
                partID: child.partID,
              })
          }
        }
        return turns
      })

    // The tail of a session's messages, oldest-first, holding at least `maxTurns` prompts.
    const recentMessages = (sessionID: string, maxTurns: number) =>
      Effect.gen(function* () {
        const collected: ApertureActivityModel.MessageLike[] = []
        let before: string | undefined
        let prompts = 0
        while (prompts <= maxTurns && collected.length < ACTIVITY_MESSAGE_CAP) {
          const page = yield* MessageV2.page({
            sessionID: sessionID as SessionID,
            limit: ACTIVITY_PAGE_SIZE,
            before,
          }).pipe(
            Effect.provideService(Database.Service, database),
            Effect.catch(() => Effect.succeed(undefined)),
          )
          if (!page || page.items.length === 0) break
          collected.unshift(...page.items)
          prompts += page.items.filter((m) => m.info.role === "user").length
          if (!page.more || !page.cursor) break
          before = page.cursor
        }
        return collected
      })

    const history = Effect.fn("Aperture.history")(function* (query: ApertureLensHistory.Query) {
      const ctx = yield* InstanceState.context
      return yield* ApertureLensHistory.read(ctx.directory, query)
    })

    // Read/replace the legend filter (O4). Replace rather than toggle: the caller owns a set (the
    // TUI's legend, the extension's picker), so sending it whole keeps the surfaces in step.
    const facetFilter = Effect.fn("Aperture.facetFilter")(function* () {
      const ctx = yield* InstanceState.context
      return [...(suppressedFacets.get(ctx.directory) ?? [])]
    })

    const setFacetFilter = Effect.fn("Aperture.setFacetFilter")(function* (facets: readonly string[]) {
      const ctx = yield* InstanceState.context
      const lens = yield* ApertureLensStore.getActive(ctx.directory)
      const next = lens ? facetsWithin(lens, facets) : new Set<string>()
      if (next.size === 0) suppressedFacets.delete(ctx.directory)
      else suppressedFacets.set(ctx.directory, next)
      return [...next]
    })

    return Service.of({
      lenses: () => lenses(),
      activeLens: () => activeLens(),
      selectLens: (idOrName, actor) => selectLens(idOrName, actor),
      cycleLens: (direction, actor) => cycleLens(direction, actor),
      editLens: (input, actor) => editLens(input, actor),
      markLens: (input, actor) => markLens(input, actor),
      unmarkLens: (input, actor) => unmarkLens(input, actor),
      deleteLens: (idOrName, actor) => deleteLens(idOrName, actor),
      facetFiles: (lens, facets) => facetFiles(lens, facets),
      facetMap: () => facetMap(),
      lines: (file) => lines(file),
      activity: (sessionID, turns) => activity(sessionID, turns),
      history: (query) => history(query),
      facetFilter: () => facetFilter(),
      setFacetFilter: (facets) => setFacetFilter(facets),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(EventV2.defaultLayer),
  // Self-provided so the layer stays R = never. `activity` derives turns from the durable message
  // store; message-v2 imports nothing under aperture/, so this adds no cycle.
  Layer.provide(Database.defaultLayer),
  Layer.provide(Git.defaultLayer),
)

export function lensInfo(lens: Lens): AperturePayload.LensInfo {
  return { id: lens.id, name: lens.name, legend: lensLegend(lens), owner: lens.owner }
}

// Every marked file's per-facet line counts. Pure, and exported so it can be tested directly.
// `facets` is the id → index vocabulary the emitted `f` refers to; a hit on a facet outside it
// (a rule whose facet was just removed) is skipped rather than mis-indexed.
//
// Two rules on one facet can overlap (nothing dedupes across rules — last-writer-wins is the
// whole resolution model), so a line can be counted twice. Accepted: the magnitude only decides
// how much area a mark claims beyond its guaranteed cell.
export function computeFacetMapFiles(
  hits: ReadonlyMap<string, ReadonlyArray<ApertureRules.RuleHit>>,
  facets: ReadonlyArray<string>,
): Record<string, FacetMapFile> {
  const indexByFacet = new Map(facets.map((id, i) => [id, i]))
  const result: Record<string, FacetMapFile> = {}
  for (const [file, fileHits] of hits) {
    const byFacet = new Map<number, { l: number; b: number }>()
    let line = Number.POSITIVE_INFINITY
    for (const hit of fileHits) {
      const f = indexByFacet.get(hit.facet)
      if (f === undefined || hit.lines <= 0) continue
      const m = byFacet.get(f) ?? { l: 0, b: 0 }
      m.l += hit.lines
      m.b += hit.bytes
      byFacet.set(f, m)
      for (const [start] of hit.ranges) line = Math.min(line, start)
    }
    if (byFacet.size === 0) continue
    result[file] = {
      m: [...byFacet.entries()].sort((a, b) => a[0] - b[0]).map(([f, m]) => ({ f, ...m })),
      line: Number.isFinite(line) ? line : 1,
    }
  }
  return result
}

// Repo-relative POSIX path for an absolute file under `directory`, or undefined if it escapes the
// directory (file events carry absolute paths).
function toRepoRelative(directory: string, absFile: string): string | undefined {
  const rel = path.relative(directory, absFile)
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined
  return rel.split(path.sep).join("/")
}

export * as Aperture from "./aperture"
