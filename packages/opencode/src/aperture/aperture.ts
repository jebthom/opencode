import { Effect, Layer, Context, Stream, Queue, Semaphore } from "effect"
import path from "path"
import { createHash } from "crypto"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import * as Log from "@opencode-ai/core/util/log"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { EventV2 } from "@opencode-ai/core/event"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { SessionStatus } from "@/session/status"
import { Storage } from "@/storage/storage"
import { Provider } from "@/provider/provider"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import type { InstanceContext } from "@/project/instance-context"
import { registerDisposer } from "@/effect/instance-registry"
import { AperturePayload } from "./payload"
import { ApertureExtract } from "./extract"
import { ApertureEvent } from "./event"
import { ApertureSemanticStore } from "./semantic-store"
import { ApertureSubfacetStore } from "./subfacet-store"
import { ApertureExtents } from "./extents"
import { AperturePainter } from "./painter"
import { ApertureLensStore } from "./lens-store"
import { ApertureDeterministic } from "./deterministic"
import { Git } from "@/git"
import { type Lens, type PaletteId, legend as lensLegend, NONE_FACET, NONE_HUE, ARCHITECTURE_ID, isBuiltinLens, isDeterministic } from "./lenses"

// Server-side Aperture service (PLAN.md steps 1 + 2.5). Owns the deterministic
// payload, but unlike step 1 the graph is a *2-level window* rooted at a scope
// (a repo-relative directory the TUI is viewing). The view is built on demand:
// each scope the user navigates to is extracted, cached per project, and reused.
//
// Recompute is visibility-gated (the merge of step 3). We subscribe to file
// events and only mark a cached scope dirty when the changed file falls within
// that scope's window — a file buried in an unopened directory dirties nothing.
// When a *currently cached* scope goes dirty we also publish aperture.invalidated
// so the live view refetches just that scope; recompute itself still happens
// lazily on the next get(). Caches and the dirty set live per project directory.
//
// Two exploration scopes coexist. Per-scope (get/refresh) keeps the live view of
// the *viewed window* fresh as the user navigates — cheap, and the path that
// catches local edits/creations. The whole-repo `sweep` runs on open and on each
// turn completion: the deterministic walk enumerates every file in the repo and
// the painter paints all of them, so semantics fill in beyond the viewed window.
// Both layers keep their skip checks — a scope already cached + clean isn't
// recomputed, and a file whose content hash is unchanged isn't re-painted — so the
// sweep only spends work on what's new or actually changed.

const log = Log.create({ service: "aperture" })

// Shared concurrency gate across the foreground (per-scope window) and background
// (whole-repo) painters: at most this many painter *passes* in flight at once, so the
// two never collide on the API. Each pass internally fans its dir-bins out up to
// FACET_FANOUT-wide (see painter.ts); the gate serializes whole passes, not individual
// model calls. The background loop holds a permit only for one batch and releases it
// during its inter-batch pause, so a foreground paint always wins a permit promptly —
// that's how the visible view stays prioritized.
const PAINT_CONCURRENCY = 1
// Files handed to one background paintStale call; must equal MAX_PER_PASS in the painter
// so each call fully consumes the slice (a smaller MAX_PER_PASS would silently drop the
// slice's tail). Sized so the pass has ~2x as many dir-bins as workers — enough
// oversubscription to keep the FACET_FANOUT-wide pool busy through uneven bin latencies.
const BG_BATCH = 960
// Pause between background batches, held *outside* the permit so a foreground paint
// arriving mid-pause acquires immediately. Short because each batch already self-spaces
// via its concurrent calls; just enough to yield the gate between waves.
const BG_BATCH_DELAY = "250 millis"

// Storage key: ["aperture", <projectID>, "structure", <scopeKey>]. Per project
// and per scope so each navigated directory keeps its own durable subgraph.
function storageKey(projectID: string, scope: string) {
  const scopeKey = scope === "" ? "root" : "s_" + createHash("sha256").update(scope).digest("hex").slice(0, 16)
  return ["aperture", projectID, "structure", scopeKey]
}

interface DirCache {
  readonly projectID: string
  readonly scopes: Map<string, AperturePayload.Payload>
  readonly dirty: Set<string>
}

export interface CreateLensInput {
  readonly name: string
  readonly description: string
  readonly palette: PaletteId
  readonly prompt: string
  readonly facets: ReadonlyArray<{ readonly label: string; readonly description: string }>
  // Optional repo-relative directories the painter front-loads (see Lens).
  readonly directories?: ReadonlyArray<string>
  // Whether to make the new Lens active (switching the viewed Lens and
  // starting the painter on it). Defaults to true — the interactive /lens behaviour.
  // Pass false to create without disturbing the user's current view (the new
  // Lens then stays unpainted until it is selected).
  readonly activate?: boolean
}

export interface EditLensInput {
  // Id or name of the Lens to edit (must be a user/project Lens).
  readonly lens: string
  readonly name?: string
  readonly description?: string
  readonly palette?: PaletteId
  readonly prompt?: string
  // The complete desired facet list (like create). Facets keep their id — and thus their
  // existing painted files — when an id or label matches; new labels mint new facets.
  readonly facets?: ReadonlyArray<{ readonly id?: string; readonly label: string; readonly description: string }>
  readonly directories?: ReadonlyArray<string>
}

// Outcome of an edit/merge/delete: a resolved Lens or why it was refused. The
// built-in (global) Lenses are immutable, so they refuse with "builtin".
export type LensMutation =
  | { readonly status: "ok"; readonly lens: Lens; readonly structural: boolean }
  | { readonly status: "not-found" }
  | { readonly status: "builtin" }
  | { readonly status: "unknown-facet"; readonly facet: string }

// Outcome of a delete: the now-active Lens (after falling back to Architecture
// when the deleted one was active) or why it was refused.
export type DeleteOutcome =
  | { readonly status: "ok"; readonly active: AperturePayload.LensInfo }
  | { readonly status: "not-found" }
  | { readonly status: "builtin" }

// Files carrying one or more Facets of a Lens, grouped by Facet (A3 helper tool).
// Powers "tell me about <component>'s files": the agent gets the paths under a
// Facet and reads them itself. Built from the painted store joined against the
// repo file listing (the store is keyed by an un-invertible path hash).
export type FacetFilesOutcome =
  | {
      readonly status: "ok"
      readonly lens: { readonly id: string; readonly name: string }
      readonly groups: ReadonlyArray<{ readonly facet: string; readonly label: string; readonly paths: ReadonlyArray<string> }>
      readonly unknownFacets: ReadonlyArray<string>
    }
  | { readonly status: "not-found" }

export interface Interface {
  // Cached payload for `scope` (default repo root); computes + persists on a miss
  // or when the scope has been marked dirty by a file change in its window.
  readonly get: (scope?: string) => Effect.Effect<AperturePayload.Payload>
  // Recompute `scope` from disk, persist, and refresh the in-memory copy.
  readonly refresh: (scope?: string) => Effect.Effect<AperturePayload.Payload>
  // Built-in + project-defined Lenses, and the active one.
  readonly lenses: () => Effect.Effect<Lens[]>
  readonly activeLens: () => Effect.Effect<Lens>
  // Define a new per-project Lens (additive — never overwrites), make it
  // active, and kick off painting.
  readonly createLens: (input: CreateLensInput) => Effect.Effect<Lens>
  // Switch the active Lens by id or name; re-paints from cache and paints any
  // not-yet-painted files. Returns the resolved Lens, or undefined if unknown.
  readonly selectLens: (idOrName: string) => Effect.Effect<Lens | undefined>
  // Step one Lens forward ("next") or back ("prev") in the list (built-ins +
  // user-defined), wrapping at the ends, and re-paint. Returns the newly-active
  // Lens's info. Drives the top-bar's ◀/▶ arrows.
  readonly cycleLens: (direction: "next" | "prev") => Effect.Effect<AperturePayload.LensInfo>
  // Edit a user Lens in place. A structural change (facets added/removed/redefined
  // or prompt changed) clears that Lens's facets so the sweep re-paints from scratch;
  // a cosmetic change (name/label/palette/directories) just re-paints. Built-ins refuse.
  readonly editLens: (input: EditLensInput) => Effect.Effect<LensMutation>
  // Deterministically fold one facet into another for a user Lens (no re-paint, no
  // tokens): drops `from` and re-labels its files as `into`. Both id or label.
  readonly mergeFacets: (lens: string, from: string, into: string) => Effect.Effect<LensMutation>
  // Delete a user Lens (and its facets), falling back to the built-in active
  // Lens when the deleted one was active. Not exposed to the lens agent.
  readonly deleteLens: (idOrName: string) => Effect.Effect<DeleteOutcome>
  // List the files carrying the given Facet(s) of a Lens, grouped by Facet. `lens`
  // is an id/name (or undefined for the active Lens); `facets` are facet ids or
  // labels (empty = every Facet in the Lens). Returns not-found when the Lens is
  // unknown. Used by the `lens_facet_files` tool for sensemaking.
  readonly facetFiles: (lens: string | undefined, facets: ReadonlyArray<string>) => Effect.Effect<FacetFilesOutcome>
  // Drill into a file (A5): like `get`, but the payload also carries `extents` —
  // the file's function-level tiles, coloured from the per-function store — and a
  // drill-in paint pass is scheduled at top priority to fill any not-yet-painted
  // functions. `scope` is the surrounding window (default repo root).
  readonly drill: (file: string, scope?: string) => Effect.Effect<AperturePayload.Payload>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Aperture") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const events = yield* EventV2.Service
    // Provider/Config are not self-provided (see defaultLayer) — they ride the
    // server's merged layer like Session does. Captured here so the forked painter
    // keeps a clean R = never and `get`/`refresh` expose no extra requirements.
    const provider = yield* Provider.Service
    const config = yield* Config.Service
    // Drives the deterministic "Changed since last commit" built-in (git status). Like
    // Provider/Config it's self-provided in defaultLayer so the layer stays R = never.
    const git = yield* Git.Service

    // Shared by the foreground and background painters (see PAINT_CONCURRENCY).
    const paintGate = yield* Semaphore.make(PAINT_CONCURRENCY)
    // The layer-construction scope: background loops fork into it (not the per-get
    // request scope) so they live for the service's lifetime and are interrupted
    // when it's released, while keeping get()/refresh() at R = never.
    const serviceScope = yield* Effect.scope

    const empty = {
      version: AperturePayload.PAYLOAD_VERSION,
      nodes: [],
      edges: [],
      semantics: {},
    } satisfies AperturePayload.Payload

    // Per-directory caches. Created lazily on first get(); the file-event
    // subscription only ever touches directories that already have a cache, so
    // unopened projects cost nothing. Cleaned on instance disposal.
    const caches = new Map<string, DirCache>()
    const containerFor = (directory: string, projectID: string): DirCache => {
      const existing = caches.get(directory)
      if (existing) return existing
      const created: DirCache = { projectID, scopes: new Map(), dirty: new Set() }
      caches.set(directory, created)
      return created
    }

    // Whole-repo source-file membership (path + size) per directory, used to compute
    // recursive per-directory composition in finalize. Cached because the TUI force-
    // refreshes every fetch (so finalize runs constantly) but the file set only changes
    // when files change — we drop the entry from the same file-event / turn-completion
    // subscriptions that already fire below, so it rebuilds lazily on the next read.
    const subtreeCache = new Map<string, ReadonlyArray<ApertureDeterministic.SubtreeFile>>()
    // Read a repo-relative file's text (or undefined when unreadable). Self-provides
    // the FS layer so callers keep R = never. Used by finalize for drill-in extents.
    const readFileText = (directory: string, rel: string) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        return yield* fs
          .readFileStringSafe(path.join(directory, rel))
          .pipe(Effect.orElseSucceed(() => undefined as string | undefined))
      }).pipe(Effect.provide(FSUtil.defaultLayer))

    const subtreeFor = (directory: string) =>
      Effect.gen(function* () {
        const cached = subtreeCache.get(directory)
        if (cached) return cached
        const files = yield* ApertureExtract.listSubtree(directory, "").pipe(
          Effect.catch((cause) => {
            log.error("listSubtree failed", { directory, cause })
            return Effect.succeed([] as ReadonlyArray<ApertureDeterministic.SubtreeFile>)
          }),
          Effect.provide(FSUtil.defaultLayer),
        )
        subtreeCache.set(directory, files)
        return files
      })

    // Working-tree change set for the deterministic "Changed since last commit" built-in,
    // cached per directory because the TUI refetches constantly (so finalize runs often)
    // but git state only moves when files change. Dropped from the same file-event /
    // turn-completion hooks that invalidate subtreeCache below, so it rebuilds lazily.
    const gitStatusCache = new Map<string, ApertureDeterministic.GitChanged>()
    const gitChangedFor = (directory: string) =>
      Effect.gen(function* () {
        const cached = gitStatusCache.get(directory)
        if (cached) return cached
        const items = yield* git.status(directory)
        const prefix = yield* git.prefix(directory)
        const resolved: ApertureDeterministic.GitChanged = { prefix, changed: new Set(items.map((i) => i.file)) }
        gitStatusCache.set(directory, resolved)
        return resolved
      })

    // Changed line ranges (in the current file) for the git-changed Lens at function
    // granularity: `git diff --unified=0 HEAD -- <file>` parsed to hunk ranges. Empty
    // for an unchanged or untracked file (the caller falls back to the file-level
    // changed result). Soft-fails to "no ranges" so a git hiccup never breaks drill-in.
    const changedRangesFor = (directory: string, relPath: string) =>
      Effect.gen(function* () {
        const result = yield* git
          .run(["diff", "--unified=0", "HEAD", "--", relPath], { cwd: directory })
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!result || result.exitCode !== 0) return [] as Array<[number, number]>
        return ApertureExtents.parseHunkRanges(result.text())
      })

    // Whether the directory is a git work tree, cached because it almost never changes
    // (only `git init`). Cleared on turn completion (an agent may have run `git init`) and
    // on disposal. Gates the git-changed built-in's availability below.
    const isRepoCache = new Map<string, boolean>()
    const isRepoFor = (directory: string) =>
      Effect.gen(function* () {
        const cached = isRepoCache.get(directory)
        if (cached !== undefined) return cached
        const repo = yield* git.isRepo(directory)
        isRepoCache.set(directory, repo)
        return repo
      })

    // A deterministic built-in can have an environmental prerequisite: git-changed needs a
    // git work tree. A Lens whose prerequisite isn't met is hidden everywhere a
    // Lens is chosen or listed (lenses()/cycle/select), so the user can never
    // land on a meaningless view — git-changed simply doesn't exist in a non-git folder.
    const isAvailable = (lens: Lens, directory: string): Effect.Effect<boolean> =>
      lens.deterministic === "git-changed" ? isRepoFor(directory) : Effect.succeed(true)

    // The active+listed Lenses minus any whose prerequisite is unmet for this directory.
    const listAvailable = (directory: string, projectID: string) =>
      Effect.gen(function* () {
        const all = yield* ApertureLensStore.list(directory)
        const keep: Lens[] = []
        for (const lens of all) if (yield* isAvailable(lens, directory)) keep.push(lens)
        return keep
      })

    const off = registerDisposer(async (directory) => {
      caches.delete(directory)
      subtreeCache.delete(directory)
      gitStatusCache.delete(directory)
      isRepoCache.delete(directory)
      // The loop fiber itself is interrupted when the instance scope closes
      // (forkScoped); drop the map entry so a later reopen can start a fresh one.
      bgPainters.delete(directory)
    })
    yield* Effect.addFinalizer(() => Effect.sync(off))

    // FS failures degrade to an empty payload rather than crashing the UI.
    const compute = Effect.fn("Aperture.compute")(
      function* (directory: string, projectID: string, scope: string) {
        const payload = yield* ApertureExtract.extract(directory, { scope }).pipe(
          Effect.catch((cause) => {
            log.error("extract failed", { projectID, scope, cause })
            return Effect.succeed(empty)
          }),
        )
        yield* storage.write(storageKey(projectID, scope), payload).pipe(Effect.ignore)
        log.info("computed", { projectID, scope, nodes: payload.nodes.length, edges: payload.edges.length })
        return payload
      },
      Effect.provide(FSUtil.defaultLayer),
    )

    // The structure cache (container.scopes + storage) stays pure: semantics are
    // merged onto a copy at the read boundary from the separate per-project store,
    // so the deterministic structure is never mutated by the async paint. Every
    // read path runs through finalize so the merge + background painting happen
    // exactly once regardless of where the structure came from (memory, disk,
    // recompute).
    const inFlight = new Set<string>()
    // Directories with an in-flight drill-in (function-level) paint. The background
    // loop checks this between batches and yields the shared permit a beat longer so
    // a user's drill-in wins over the whole-repo sweep (A5 priority approximation).
    const drillActive = new Set<string>()
    // Repo-relative files that have been function-painted, per directory. A change to
    // one re-runs the drill-in painter (onFileChanged) so its tiles stay fresh; the
    // per-extent hash scopes that repaint to the functions that actually changed.
    const drilledFiles = new Map<string, Set<string>>()

    const schedulePaint = (
      directory: string,
      projectID: string,
      scope: string,
      nodes: AperturePayload.Payload["nodes"],
      boundaries: readonly AperturePayload.Boundary[],
      lens: Lens,
    ) =>
      Effect.gen(function* () {
        // Paint in-window files *and* the one-hop boundary targets (step 6): a
        // boundary's tile is painted from its target's facet, so the target must be
        // painted even though it falls outside the current window. The store is keyed
        // by stable node id, so this paint is reused when the file is later viewed
        // in-window. stale-only dedup in the painter keeps the extra files cheap.
        const fileNodes = [...nodes.filter((n) => n.kind === "file"), ...boundaries.filter((b) => b.kind === "file")].map(
          (n) => ({ id: n.id, path: n.path }),
        )
        if (fileNodes.length === 0) return
        // Key by Lens too: a foreground pass for a freshly-switched Lens
        // must not be deduped against an in-flight pass for the previous one.
        const key = JSON.stringify([directory, scope, lens.id])
        if (inFlight.has(key)) return
        inFlight.add(key)
        yield* AperturePainter.paintStale(
          { storage, events, provider, config },
          directory,
          projectID,
          scope,
          fileNodes,
          "fg",
          lens,
        ).pipe(
          paintGate.withPermits(1),
          Effect.ensuring(Effect.sync(() => inFlight.delete(key))),
          Effect.forkDetach,
        )
      })

    // Drill-in (A5) function-level paint. Forked onto the *shared* single-permit
    // gate, so the API is never hit concurrently with the foreground/background
    // file painters. `drillActive` is bumped around the schedule so the background
    // loop yields the permit between batches to the more-recent user action —
    // approximating the `drill-in > foreground > background` priority without a
    // second gate. Deduped per (directory, file, lens) while a pass is in flight.
    const extentInFlight = new Set<string>()
    const scheduleExtentPaint = (directory: string, projectID: string, relPath: string, scope: string) =>
      Effect.gen(function* () {
        // Remember the file so a later edit re-refreshes its tiles (onFileChanged).
        let files = drilledFiles.get(directory)
        if (!files) drilledFiles.set(directory, (files = new Set()))
        files.add(relPath)
        const lens = yield* ApertureLensStore.getActive(directory)
        // Deterministic built-ins are fully computed; nothing to model-paint.
        if (isDeterministic(lens)) return
        const key = JSON.stringify([directory, relPath, lens.id])
        if (extentInFlight.has(key)) return
        extentInFlight.add(key)
        drillActive.add(directory)
        yield* AperturePainter.paintExtentsStale(
          { storage, events, provider, config },
          directory,
          projectID,
          relPath,
          lens,
          scope,
        ).pipe(
          paintGate.withPermits(1),
          Effect.ensuring(
            Effect.sync(() => {
              extentInFlight.delete(key)
              drillActive.delete(directory)
            }),
          ),
          Effect.forkDetach,
        )
      })

    const finalize = (ctx: InstanceContext, scope: string, structure: AperturePayload.Payload, drillFile?: string) =>
      Effect.gen(function* () {
        // Paint with the *active* Lens: its facet store, its legend (facet → colour),
        // and its name travel out on the payload so the renderer needs no hard-coded
        // vocabulary. Switching Lenses re-paints from that Lens's own
        // (cached) store — no other Lens's work is touched.
        const lens = yield* ApertureLensStore.getActive(ctx.directory)
        // Whole-repo membership (full depth), needed both for directory composition and —
        // for the deterministic built-ins — as the file set whose facets we synthesize.
        const subtree = yield* subtreeFor(ctx.directory)
        // Deterministic built-ins (git-changed / mtime-buckets) compute their facets from the
        // repo instead of reading the persisted store: no painter, no tokens, always fresh.
        const det = isDeterministic(lens)
        const store = det
          ? ApertureDeterministic.computeStore(
              lens.deterministic!,
              subtree,
              lens.deterministic === "git-changed" ? yield* gitChangedFor(ctx.directory) : undefined,
            )
          : yield* ApertureSemanticStore.read(storage, ctx.project.id, lens.id)
        const colorByFacet = new Map(lens.facets.map((t) => [t.id, t.color]))
        const semantics: Record<string, AperturePayload.Semantic> = {}
        // The store holds only the semantic (facet); hue/facets are derived here, so
        // palette/vocabulary changes apply without a re-paint. Boundaries (step 6) are
        // painted from the same store so an out-of-window tile shows its target's hue
        // once that target has been painted.
        const applySemantic = (id: string) => {
          const entry = store[id]
          if (entry) semantics[id] = { facets: [entry.facet], hue: entry.facet === NONE_FACET ? NONE_HUE : colorByFacet.get(entry.facet) }
        }
        for (const node of structure.nodes) applySemantic(node.id)
        for (const boundary of structure.boundaries ?? []) applySemantic(boundary.id)
        // Paint each in-window directory as its subtree's facet composition: bucket every
        // descendant source file (full depth, from the cached membership) by its painted
        // facet, summing both a file count and a byte sum so the renderer can pick either
        // metric. Derived here alongside `semantics` so the structure cache stays pure.
        const composition = computeComposition(structure.nodes, subtree, store, lens)
        // Deterministic Lenses are fully painted above; only semantic ones schedule
        // the foreground painter for the in-window files + boundary targets.
        if (!det)
          yield* schedulePaint(ctx.directory, ctx.project.id, scope, structure.nodes, structure.boundaries ?? [], lens)
        const lensInfo: AperturePayload.LensInfo = {
          id: lens.id,
          name: lens.name,
          legend: lensLegend(lens),
        }
        // Drill-in (A5): attach function-level tiles for every file that has been
        // drilled in this directory AND is in the current window — not just the file the
        // user just clicked. Once a file is function-painted it keeps its measured band
        // as the user drills siblings or navigates away and back (the paint persists in
        // the per-function store; it supersedes the single file-level hue). Without this,
        // only the actively-drilled file carried extents, so every other tile snapped
        // back to file-level paint on the next click / refetch. Semantic Lenses colour
        // tiles from that store (unpainted stay grey until the scheduled drill paint fills
        // them in); the git-changed built-in colours them deterministically from `git
        // diff` hunks; mtime-recency can't subdivide a file, so it carries no extents.
        const supportsExtents = !det || lens.deterministic === "git-changed"
        let extents: Record<string, ReadonlyArray<AperturePayload.Extent>> | undefined
        if (supportsExtents) {
          // In-window file nodes by path; a drilled file that's off-window is skipped
          // (its tiles would render on no tile).
          const idByPath = new Map<string, string>()
          for (const n of structure.nodes) if (n.kind === "file") idByPath.set(n.path, n.id)
          const targets = new Set<string>()
          for (const f of drilledFiles.get(ctx.directory) ?? []) if (idByPath.has(f)) targets.add(f)
          // The freshly-clicked file is already in drilledFiles (the drill path adds it
          // before finalize), but include it defensively against ordering changes.
          if (drillFile && idByPath.has(drillFile)) targets.add(drillFile)
          if (targets.size) {
            // Semantic Lenses read the per-function store once for all targets.
            const subStore = det ? undefined : yield* ApertureSubfacetStore.read(storage, ctx.project.id, lens.id)
            const built: Record<string, ReadonlyArray<AperturePayload.Extent>> = {}
            for (const file of targets) {
              const fileId = idByPath.get(file)!
              const content = yield* readFileText(ctx.directory, file)
              if (content === undefined) continue
              const exs = ApertureExtents.extentsOf(content)
              // name → facet id for this file's extents.
              let facetByName: Map<string, string>
              if (det) {
                // git-changed: overlap each extent with the diff's changed line ranges,
                // falling back to the file-level changed result for an untracked file.
                const ranges = yield* changedRangesFor(ctx.directory, file)
                const fileChanged = store[fileId]?.facet === "changed"
                facetByName = ApertureExtents.extentChangeFacets(content, ranges, fileChanged)
              } else {
                facetByName = new Map()
                for (const e of exs) {
                  const entry = subStore![ApertureExtents.subNodeID(file, e.name)]
                  if (entry) facetByName.set(e.name, entry.facet)
                }
              }
              built[fileId] = exs.map((e): AperturePayload.Extent => {
                const facet = facetByName.get(e.name)
                const hue = facet ? (facet === NONE_FACET ? NONE_HUE : colorByFacet.get(facet)) : undefined
                return {
                  name: e.name,
                  startLine: e.startLine,
                  endLine: e.endLine,
                  ...(facet ? { facet } : {}),
                  ...(hue ? { hue } : {}),
                }
              })
            }
            if (Object.keys(built).length) extents = built
          }
        }
        return { ...structure, semantics, composition, lens: lensInfo, ...(extents ? { extents } : {}) }
      })

    // Background whole-repo painter (vs. the per-scope window of get/refresh). One
    // self-rescheduling loop per directory walks every source file in DFS order
    // (so directories light up from the root outward), painting BG_BATCH files per
    // step under the shared gate with a pause between steps. When a full pass is
    // done it parks until a file change / turn completion wakes it, then re-walks —
    // picking up created/deleted files. The stale-hash skip in the painter makes
    // every re-walk cheap (unchanged files spend nothing). forkScoped binds the loop
    // to the instance scope so it dies with the TUI; the bgPainters map dedups starts
    // and the dropping(1) wake queue coalesces a burst of changes into one rescan.
    const bgPainters = new Map<string, { readonly wake: Queue.Queue<void> }>()
    // Per-directory counter bumped whenever the active Lens changes
    // (onLensChanged). The bg loop snapshots it at pass start and abandons an
    // in-flight sweep when it changes, so a freshly-selected Lens starts filling
    // in immediately instead of waiting for the previous Lens's sweep to finish.
    const lensEpoch = new Map<string, number>()

    const backgroundLoop = (directory: string, projectID: string, wake: Queue.Queue<void>) =>
      Effect.gen(function* () {
        while (true) {
          // Re-read the active Lens each pass so a switch (which wakes this loop)
          // re-walks the repo painting for the *new* Lens; cached entries make a
          // re-walk of an already-painted Lens free.
          const lens = yield* ApertureLensStore.getActive(directory)
          // Deterministic built-ins are painted synchronously in finalize — there's nothing
          // for the whole-repo sweep to do. Park until a Lens switch (or file change)
          // wakes us; the next pass re-reads the active Lens and resumes the sweep if
          // it's switched back to a semantic one.
          if (isDeterministic(lens)) {
            yield* Queue.take(wake)
            continue
          }
          const epoch = lensEpoch.get(directory) ?? 0
          const files = yield* ApertureExtract.listFilesDfs(directory).pipe(
            Effect.catchCause((cause) => {
              log.error("background enumerate failed", { projectID, cause })
              return Effect.succeed<ReadonlyArray<{ id: string; path: string }>>([])
            }),
            Effect.provide(FSUtil.defaultLayer),
          )
          // Front-load the Lens's relevant directories (if any): paint files under
          // them first, in their existing DFS order, then the rest of the repo. The
          // sweep still covers everything; this only changes the order so the targeted
          // area lights up first. Already-painted files in the tail are stale-skipped.
          const ordered = orderByDirectories(files, lens.directories)
          // Always-written diagnostic so a bg loop that produces no request lines is
          // still visible in the perf log (distinguishes "loop never ran" from
          // "ran but every slice was already painted / no model").
          yield* AperturePainter.appendPerfEvent(directory, "bg", "pass-start", { files: ordered.length, lens: lens.id })
          let interrupted = false
          for (let cursor = 0; cursor < ordered.length; cursor += BG_BATCH) {
            const slice = ordered.slice(cursor, cursor + BG_BATCH)
            // scope "" — the facet store is keyed by stable node id, so a file painted
            // here is reused in every window it later appears in. The permit is held
            // only for the batch; the pause below runs without it so foreground wins.
            yield* AperturePainter.paintStale({ storage, events, provider, config }, directory, projectID, "", slice, "bg", lens).pipe(
              paintGate.withPermits(1),
              Effect.catchCause((cause) =>
                Effect.sync(() => log.error("background batch failed", { projectID, cause })),
              ),
            )
            yield* Effect.sleep(BG_BATCH_DELAY)
            // Hold off (permit released) while a drill-in paint is in flight for this
            // directory, so the user's function-level request takes the permit first.
            while (drillActive.has(directory)) yield* Effect.sleep(BG_BATCH_DELAY)
            // Abandon the rest of this sweep when the active Lens changed under
            // us, so the new Lens takes over without finishing the old one.
            if ((lensEpoch.get(directory) ?? 0) !== epoch) {
              interrupted = true
              break
            }
          }
          // On interruption, drain the switch's own wake signal and re-loop immediately
          // (the next pass re-reads the now-active Lens). Otherwise park until a
          // file change / turn completion / Lens switch wakes us.
          if (interrupted) yield* Queue.poll(wake)
          else yield* Queue.take(wake)
        }
      })

    const startBackgroundPainter = (directory: string, projectID: string) =>
      Effect.gen(function* () {
        if (bgPainters.has(directory)) return
        const wake = yield* Queue.dropping<void>(1)
        bgPainters.set(directory, { wake })
        yield* backgroundLoop(directory, projectID, wake).pipe(
          Effect.catchCause((cause) => Effect.sync(() => log.error("background loop crashed", { projectID, cause }))),
          (loop) => Effect.forkIn(loop, serviceScope),
        )
      })

    // Nudge a parked background loop to re-enumerate and re-walk. dropping(1) makes a
    // burst of file events / repeated turn completions coalesce into a single rescan.
    const wakeBackground = (directory: string) =>
      Effect.gen(function* () {
        const entry = bgPainters.get(directory)
        if (!entry) return
        yield* Queue.offer(entry.wake, void 0).pipe(Effect.ignore)
      })

    // The deterministic structure for `norm`: served from memory, then the durable
    // cache (when fresh), else recomputed. Shared by load/drill so both run the same
    // cache logic before finalize merges semantics/composition/extents.
    const structureFor = (ctx: InstanceContext, norm: string) =>
      Effect.gen(function* () {
        const container = containerFor(ctx.directory, ctx.project.id)
        if (!container.dirty.has(norm)) {
          const inMemory = container.scopes.get(norm)
          if (inMemory) return inMemory
          const cached = yield* storage
            .read<AperturePayload.Payload>(storageKey(ctx.project.id, norm))
            .pipe(Effect.catch(() => Effect.void))
          if (cached && cached.version === AperturePayload.PAYLOAD_VERSION) {
            container.scopes.set(norm, cached)
            return cached
          }
        }
        const payload = yield* compute(ctx.directory, ctx.project.id, norm)
        container.scopes.set(norm, payload)
        container.dirty.delete(norm)
        return payload
      })

    const load = Effect.fn("Aperture.load")(function* (scope?: string) {
      const ctx = yield* InstanceState.context
      // On open (first get for this directory) start the background whole-repo painter
      // so semantics fill in past the initially-viewed window without the user having
      // to navigate. Idempotent per directory; file changes / turn completion wake it
      // to re-walk (the subscriptions below).
      yield* startBackgroundPainter(ctx.directory, ctx.project.id)
      const norm = ApertureExtract.normalizeScope(scope ?? "")
      const structure = yield* structureFor(ctx, norm)
      return yield* finalize(ctx, norm, structure)
    })

    const drill = Effect.fn("Aperture.drill")(function* (file: string, scope?: string) {
      const ctx = yield* InstanceState.context
      yield* startBackgroundPainter(ctx.directory, ctx.project.id)
      const norm = ApertureExtract.normalizeScope(scope ?? "")
      // The file is a repo-relative path; normalizeScope trims stray slashes.
      const rel = ApertureExtract.normalizeScope(file)
      const structure = yield* structureFor(ctx, norm)
      // Kick the drill-in paint pass (top priority) so not-yet-painted functions fill
      // in, then return the window payload with the file's current tiles attached. The
      // paint completion invalidates `norm` (the viewed scope) so the band live-fills.
      yield* scheduleExtentPaint(ctx.directory, ctx.project.id, rel, norm)
      return yield* finalize(ctx, norm, structure, rel)
    })

    const refresh = Effect.fn("Aperture.refresh")(function* (scope?: string) {
      const ctx = yield* InstanceState.context
      const container = containerFor(ctx.directory, ctx.project.id)
      // The TUI fetches with refresh=true, so this — not load — is the path that
      // actually runs on open; start the background painter here too (idempotent per
      // directory) or it would never kick off.
      yield* startBackgroundPainter(ctx.directory, ctx.project.id)
      const norm = ApertureExtract.normalizeScope(scope ?? "")
      // A deterministic built-in (mtime / git-changed) paints from live disk state that
      // finalize reads via subtreeCache / gitStatusCache. Those caches otherwise only drop on
      // a file event or turn completion, so a manual IDE edit while one is already on screen
      // stays stale until the next turn. refresh is the path every TUI fetch takes — the
      // turn-end refetch, the manual ⟳, and the periodic poll — so dropping the inputs here
      // recomputes them fresh on each, picking up watcher-missed changes. The whole-repo walk
      // + git status are cheap, and this only fires while a deterministic Lens is the
      // active view; semantic Lenses read the persisted facet store and keep their caches.
      const active = yield* ApertureLensStore.getActive(ctx.directory)
      if (isDeterministic(active)) {
        subtreeCache.delete(ctx.directory)
        gitStatusCache.delete(ctx.directory)
      }
      const payload = yield* compute(ctx.directory, ctx.project.id, norm)
      container.scopes.set(norm, payload)
      container.dirty.delete(norm)
      return yield* finalize(ctx, norm, payload)
    })

    // A changed file marks every cached scope whose visible window contains it as
    // dirty, and (for scopes actually cached, i.e. being viewed) publishes an
    // invalidation routed to the originating instance so the TUI refetches.
    const onFileChanged = (absFile: string, location: EventV2.Payload["location"]) =>
      Effect.gen(function* () {
        const directory = location?.directory
        if (!directory) return
        const container = caches.get(directory)
        if (!container) return
        const rel = toRepoRelative(directory, absFile)
        if (rel === undefined) return
        // A changed file may have a new size or be new/removed, so the cached subtree
        // membership (and thus composition) is stale — rebuild it on the next read. The
        // git change set is likewise stale (the edit may have changed what's modified).
        subtreeCache.delete(directory)
        gitStatusCache.delete(directory)
        for (const scope of container.scopes.keys()) {
          if (!isWithinWindow(scope, rel)) continue
          container.dirty.add(scope)
          yield* events
            .publish(ApertureEvent.Event.Invalidated, { scope }, location ? { location } : undefined)
            .pipe(Effect.ignore)
        }
        // Wake the background painter so the change is (re)painted even when it falls
        // outside every viewed window — the stale-hash skip keeps the re-walk cheap.
        yield* wakeBackground(directory)
        // If the changed file has function-level paint, re-run the drill-in painter so
        // its tiles stay current. The per-extent content hash scopes the actual model
        // calls to the functions that changed — a free, diff-shaped repaint. Invalidate
        // the file's own directory window; viewers of it refetch and re-merge.
        if (drilledFiles.get(directory)?.has(rel))
          yield* scheduleExtentPaint(
            directory,
            container.projectID,
            rel,
            rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "",
          )
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

    // Turn completion: when a session goes idle (the agent returned from a building
    // turn) wake the background painter so files created/changed during the turn get
    // painted. Gated on an existing cache so we only touch repos whose graph is open —
    // an unopened project stays inert, matching the lazy-cache philosophy.
    const onSessionIdle = (location: EventV2.Payload["location"]) =>
      Effect.gen(function* () {
        const directory = location?.directory
        if (!directory) return
        const container = caches.get(directory)
        if (!container) return
        // Shell commands (rm/mv/scaffolding) mutate the tree without file events, so a
        // completed turn may have changed the file set — drop membership to rebuild it.
        // A turn may also have staged/committed/edited files, so the git set is stale too,
        // and a `git init` during the turn can flip the repo gate — drop both.
        subtreeCache.delete(directory)
        gitStatusCache.delete(directory)
        isRepoCache.delete(directory)
        yield* wakeBackground(directory)
      })
    yield* Effect.forkScoped(
      events.subscribe(SessionStatus.Event.Status).pipe(
        Stream.runForEach((event) =>
          event.data.status.type === "idle" ? onSessionIdle(event.location) : Effect.void,
        ),
      ),
    )

    // Re-paint every viewed scope after the active Lens changes: mark each
    // cached scope dirty so the next get re-runs finalize with the new Lens, and
    // publish an invalidation so the live view refetches. The bg painter is woken so the
    // new Lens also fills in beyond the viewed window.
    const onLensChanged = (directory: string) =>
      Effect.gen(function* () {
        const container = caches.get(directory)
        if (container) {
          for (const scope of container.scopes.keys()) {
            container.dirty.add(scope)
            // Attach the location: this runs in a forked fiber with no ambient
            // Location.Service, so without it the HTTP /event SSE filter drops the
            // event and the VSCode extension never refetches the freshly-switched Lens.
            yield* events.publish(ApertureEvent.Event.Invalidated, { scope }, { location: { directory: AbsolutePath.make(directory) } }).pipe(Effect.ignore)
          }
        }
        // Bump the epoch so an in-flight background sweep abandons the old Lens
        // and restarts for the new one (the wake below re-runs the parked loop).
        lensEpoch.set(directory, (lensEpoch.get(directory) ?? 0) + 1)
        yield* wakeBackground(directory)
      })

    const lenses = Effect.fn("Aperture.lenses")(function* () {
      const ctx = yield* InstanceState.context
      // Hide deterministic built-ins whose prerequisite is unmet (git-changed off-git).
      return yield* listAvailable(ctx.directory, ctx.project.id)
    })

    const activeLens = Effect.fn("Aperture.activeLens")(function* () {
      const ctx = yield* InstanceState.context
      return yield* ApertureLensStore.getActive(ctx.directory)
    })

    const createLens = Effect.fn("Aperture.createLens")(function* (input: CreateLensInput) {
      const ctx = yield* InstanceState.context
      const lens = yield* ApertureLensStore.create(ctx.directory, input)
      // Default: activate the new Lens (switch the view, start the painter on
      // it). When activate is false the Lens is only persisted — the active
      // Lens and its in-flight sweep are left untouched, so the user's current
      // view is undisturbed (the new one paints later if/when it is selected).
      if (input.activate !== false) {
        yield* ApertureLensStore.setActive(ctx.directory,lens.id)
        yield* onLensChanged(ctx.directory)
      }
      return lens
    })

    const selectLens = Effect.fn("Aperture.selectLens")(function* (idOrName: string) {
      const ctx = yield* InstanceState.context
      // Resolve only against *available* Lenses so an unavailable built-in (e.g.
      // git-changed in a non-git folder) reports as unknown rather than activating a
      // Lens that can't paint anything meaningful.
      const all = yield* listAvailable(ctx.directory, ctx.project.id)
      const needle = idOrName.toLowerCase()
      const found = all.find((c) => c.id === idOrName || c.name.toLowerCase() === needle)
      if (!found) return undefined
      yield* ApertureLensStore.setActive(ctx.directory,found.id)
      yield* onLensChanged(ctx.directory)
      return found
    })

    const cycleLens = Effect.fn("Aperture.cycleLens")(function* (direction: "next" | "prev") {
      const ctx = yield* InstanceState.context
      // Cycle only through available Lenses so the arrows skip a hidden built-in
      // (e.g. git-changed in a non-git folder) instead of landing the user on it.
      const all = yield* listAvailable(ctx.directory, ctx.project.id)
      const activeId = yield* ApertureLensStore.getActiveId(ctx.directory)
      const idx = all.findIndex((c) => c.id === activeId)
      const len = all.length
      // Wrap at both ends so the arrows loop through the list rather than stopping.
      // An unresolved active id (-1) starts from the head so a click still moves.
      const base = idx === -1 ? 0 : idx
      const next = all[(base + (direction === "next" ? 1 : len - 1)) % len]!
      yield* ApertureLensStore.setActive(ctx.directory,next.id)
      yield* onLensChanged(ctx.directory)
      return { id: next.id, name: next.name, legend: lensLegend(next) }
    })

    // Resolve a Lens by id or (case-insensitive) name. Used by edit/merge/delete
    // to find the target and refuse the immutable built-ins.
    const resolveLens = (all: ReadonlyArray<Lens>, idOrName: string) => {
      const needle = idOrName.toLowerCase()
      return all.find((c) => c.id === idOrName || c.name.toLowerCase() === needle)
    }

    const editLens = Effect.fn("Aperture.editLens")(function* (input: EditLensInput) {
      const ctx = yield* InstanceState.context
      const all = yield* ApertureLensStore.list(ctx.directory)
      const found = resolveLens(all, input.lens)
      if (!found) return { status: "not-found" } as const
      if (isBuiltinLens(found)) return { status: "builtin" } as const
      const result = yield* ApertureLensStore.update(ctx.directory, found.id, {
        name: input.name,
        description: input.description,
        palette: input.palette,
        prompt: input.prompt,
        facets: input.facets,
        directories: input.directories,
      })
      if (!result) return { status: "not-found" } as const
      // Structural edits invalidate the inferred facets — clear them so the sweep
      // re-paints from scratch. Cosmetic edits keep the facets and just re-paint.
      if (result.structural) {
        yield* ApertureSemanticStore.clear(storage, ctx.project.id, found.id)
        yield* ApertureSubfacetStore.clear(storage, ctx.project.id, found.id)
      }
      yield* onLensChanged(ctx.directory)
      return { status: "ok", lens: result.lens, structural: result.structural } as const
    })

    const mergeFacets = Effect.fn("Aperture.mergeFacets")(function* (lens: string, from: string, into: string) {
      const ctx = yield* InstanceState.context
      const all = yield* ApertureLensStore.list(ctx.directory)
      const found = resolveLens(all, lens)
      if (!found) return { status: "not-found" } as const
      if (isBuiltinLens(found)) return { status: "builtin" } as const
      // Accept either a facet id or its (case-insensitive) label for both ends.
      const resolveFacet = (ref: string) =>
        found.facets.find((t) => t.id === ref || t.label.toLowerCase() === ref.toLowerCase())?.id
      const fromId = resolveFacet(from)
      const intoId = resolveFacet(into)
      if (!fromId) return { status: "unknown-facet", facet: from } as const
      if (!intoId) return { status: "unknown-facet", facet: into } as const
      const updated = yield* ApertureLensStore.mergeFacets(ctx.directory, found.id, fromId, intoId)
      if (!updated) return { status: "not-found" } as const
      yield* ApertureSemanticStore.mergeFacet(storage, ctx.project.id, found.id, fromId, intoId)
      yield* ApertureSubfacetStore.mergeFacet(storage, ctx.project.id, found.id, fromId, intoId)
      yield* onLensChanged(ctx.directory)
      return { status: "ok", lens: updated, structural: false } as const
    })

    const deleteLens = Effect.fn("Aperture.deleteLens")(function* (idOrName: string) {
      const ctx = yield* InstanceState.context
      const all = yield* ApertureLensStore.list(ctx.directory)
      const found = resolveLens(all, idOrName)
      if (!found) return { status: "not-found" } as const
      if (isBuiltinLens(found)) return { status: "builtin" } as const
      const activeId = yield* ApertureLensStore.getActiveId(ctx.directory)
      yield* ApertureLensStore.remove(ctx.directory, found.id)
      yield* ApertureSemanticStore.clear(storage, ctx.project.id, found.id)
      yield* ApertureSubfacetStore.clear(storage, ctx.project.id, found.id)
      if (activeId === found.id) yield* ApertureLensStore.setActive(ctx.directory,ARCHITECTURE_ID)
      yield* onLensChanged(ctx.directory)
      const active = yield* ApertureLensStore.getActive(ctx.directory)
      return {
        status: "ok",
        active: { id: active.id, name: active.name, legend: lensLegend(active) },
      } as const
    })

    const facetFiles = Effect.fn("Aperture.facetFiles")(function* (
      lens: string | undefined,
      facets: ReadonlyArray<string>,
    ) {
      const ctx = yield* InstanceState.context
      const all = yield* ApertureLensStore.list(ctx.directory)
      const resolved = lens ? resolveLens(all, lens) : yield* ApertureLensStore.getActive(ctx.directory)
      if (!resolved) return { status: "not-found" } as const

      // Same store source as finalize: deterministic built-ins compute their facets
      // from the repo; semantic Lenses read the painted store.
      const subtree = yield* subtreeFor(ctx.directory)
      const store = isDeterministic(resolved)
        ? ApertureDeterministic.computeStore(
            resolved.deterministic!,
            subtree,
            resolved.deterministic === "git-changed" ? yield* gitChangedFor(ctx.directory) : undefined,
          )
        : yield* ApertureSemanticStore.read(storage, ctx.project.id, resolved.id)

      // The store is keyed by stable node id (an un-invertible path hash), so recover
      // paths by joining against the repo file listing.
      const pathById = new Map(subtree.map((f) => [f.id, f.path]))
      const pathsByFacet = new Map<string, string[]>()
      for (const [id, entry] of Object.entries(store)) {
        const path = pathById.get(id)
        if (!path) continue
        const list = pathsByFacet.get(entry.facet) ?? []
        list.push(path)
        pathsByFacet.set(entry.facet, list)
      }

      // Resolve each requested ref (facet id or case-insensitive label) to a facet id;
      // an empty request means every Facet in the Lens.
      const resolveFacet = (ref: string) =>
        resolved.facets.find((t) => t.id === ref || t.label.toLowerCase() === ref.toLowerCase())
      const requested = facets.length ? facets : resolved.facets.map((t) => t.id)
      const groups: { facet: string; label: string; paths: string[] }[] = []
      const unknownFacets: string[] = []
      const seen = new Set<string>()
      for (const ref of requested) {
        const facet = resolveFacet(ref)
        if (!facet) {
          unknownFacets.push(ref)
          continue
        }
        if (seen.has(facet.id)) continue
        seen.add(facet.id)
        groups.push({ facet: facet.id, label: facet.label, paths: (pathsByFacet.get(facet.id) ?? []).sort() })
      }
      return { status: "ok", lens: { id: resolved.id, name: resolved.name }, groups, unknownFacets } as const
    })

    return Service.of({
      get: (scope) => load(scope),
      refresh: (scope) => refresh(scope),
      lenses: () => lenses(),
      activeLens: () => activeLens(),
      createLens: (input) => createLens(input),
      selectLens: (idOrName) => selectLens(idOrName),
      cycleLens: (direction) => cycleLens(direction),
      editLens: (input) => editLens(input),
      mergeFacets: (lens, from, into) => mergeFacets(lens, from, into),
      deleteLens: (idOrName) => deleteLens(idOrName),
      facetFiles: (lens, facets) => facetFiles(lens, facets),
      drill: (file, scope) => drill(file, scope),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Storage.defaultLayer),
  Layer.provide(EventV2.defaultLayer),
  // Self-provided (Provider's own stack is self-contained) so the layer stays
  // R = never, mirroring Agent.defaultLayer — the painter needs both to resolve a
  // small model and read the context flag.
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Config.defaultLayer),
  // Self-provided so the layer stays R = never; drives the git-changed built-in.
  Layer.provide(Git.defaultLayer),
)

// Reorder the enumerated files so any under the Lens's relevant directories
// come first (keeping each group's existing DFS order), then the rest of the repo.
// Returns the input unchanged when no directories are set. The targeted dirs are
// repo-relative with no leading/trailing slashes (normalized at create/edit time);
// a file matches when its path equals a dir or sits under it.
function orderByDirectories(
  files: ReadonlyArray<{ id: string; path: string }>,
  directories: ReadonlyArray<string> | undefined,
): ReadonlyArray<{ id: string; path: string }> {
  if (!directories?.length) return files
  const isPriority = (rel: string) => directories.some((d) => rel === d || rel.startsWith(d + "/"))
  const priority = files.filter((f) => isPriority(f.path))
  if (priority.length === 0 || priority.length === files.length) return files
  return [...priority, ...files.filter((f) => !isPriority(f.path))]
}

// --- composition -----------------------------------------------------------

// Per-directory subtree composition: for every directory node, tally its descendant
// source files by painted facet into a count + byte sum. A file under nested
// directories counts toward each of its in-window ancestors (each directory reflects
// its own full subtree). Every descendant file also feeds the directory's `subtree*`
// totals regardless of painting, so a directory with no painted files still reports its
// real size (the renderer sizes its grey block from that rather than painting it
// full-bleed). Pure: a function of the window's directories, the subtree file set,
// and the semantic store.
function computeComposition(
  nodes: AperturePayload.Payload["nodes"],
  files: ReadonlyArray<{ id: string; path: string; size: number }>,
  store: ApertureSemanticStore.Store,
  lens: Lens,
): Record<string, AperturePayload.Composition> {
  const dirs = nodes.filter((n) => n.kind === "directory").map((d) => ({ id: d.id, prefix: d.path + "/" }))
  if (dirs.length === 0) return {}
  const painted = new Map<string, Map<string, { count: number; bytes: number }>>()
  const subtree = new Map<string, { count: number; bytes: number }>()
  for (const file of files) {
    const facet = store[file.id]?.facet
    for (const dir of dirs) {
      if (!file.path.startsWith(dir.prefix)) continue
      const s = subtree.get(dir.id) ?? { count: 0, bytes: 0 }
      s.count += 1
      s.bytes += file.size
      subtree.set(dir.id, s)
      if (!facet) continue
      let byFacet = painted.get(dir.id)
      if (!byFacet) painted.set(dir.id, (byFacet = new Map()))
      const w = byFacet.get(facet) ?? { count: 0, bytes: 0 }
      w.count += 1
      w.bytes += file.size
      byFacet.set(facet, w)
    }
  }
  // Emit an entry for every directory that has any descendant file, even when none
  // are painted (empty `weights`) — that's the grey case the renderer sizes by subtree.
  const order = [...lens.facets.map((t) => t.id), NONE_FACET]
  const result: Record<string, AperturePayload.Composition> = {}
  for (const [id, s] of subtree) {
    const byFacet = painted.get(id)
    // Weights in the Lens's facet order so the payload is stable and the
    // renderer's colour bands are consistent.
    const weights = byFacet ? order.filter((t) => byFacet.has(t)).map((facet) => ({ facet, ...byFacet.get(facet)! })) : []
    const totalCount = weights.reduce((sum, w) => sum + w.count, 0)
    const totalBytes = weights.reduce((sum, w) => sum + w.bytes, 0)
    result[id] = { weights, totalCount, totalBytes, subtreeCount: s.count, subtreeBytes: s.bytes }
  }
  return result
}

// --- window math -----------------------------------------------------------

// Repo-relative POSIX path for an absolute file under `directory`, or undefined
// if it escapes the directory (file events carry absolute paths).
function toRepoRelative(directory: string, absFile: string): string | undefined {
  const rel = path.relative(directory, absFile)
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined
  return rel.split(path.sep).join("/")
}

// True if `rel` is within the 2-level window rooted at `scope` (i.e. it is one
// of the nodes the view actually draws). Mirrors the extractor's layer math.
function isWithinWindow(scope: string, rel: string): boolean {
  if (scope !== "" && rel !== scope && !rel.startsWith(scope + "/")) return false
  const scopeSegments = scope === "" ? 0 : scope.split("/").length
  const relativeDepth = rel.split("/").length - scopeSegments - 1
  return relativeDepth >= 0 && relativeDepth < ApertureExtract.VIEW_DEPTH
}

export * as Aperture from "./aperture"
