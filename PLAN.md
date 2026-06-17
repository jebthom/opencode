# Code-Graph Visualization for the opencode TUI

## Goal
A graph/dependency visualization that stays visible during planning, prompting,
execution, and review. Structure is deterministic (derived from directory tree +
syntax, with stable IDs and cached layout) so it doesn't reflow distractingly.
Semantics are malleable and async — an agent attaches a layer/hue to each file
over time. First idiom: a wide top-bar above the chat showing a 2-level window of
the graph that the user can drill into.

## Status (steps 1–4, A, B, 6 done)

Implemented and in place: deterministic structure extraction, a top-bar renderer
with drill-down + mouse navigation, live recompute on file/shell events, a
two-tier async semantic tagger (a foreground view tagger + a background whole-repo
DFS sweep) that paints files by architectural layer, and the edge layer
(step 6): containment connectors, hover dependency-highlights, and clickable
out-of-window boundary tiles painted by their target's layer.

    [done] 1. Payload schema + structure extractor + Storage caching + `dump.ts`.
    [done] 2. `codegraph_top` core slot + renderer plugin (horizontal layout).
    [done] 2.5 Scoped 2-level window + drill-down navigation (mouse).
    [done] 3. Live recompute: visibility-gated invalidation + recompute-on-display.
    [done] 4. Semantic layer: async per-file tagger (small model) → layer → hue.
    [done] A. Foundation A: node-overlay render layer (glyphs + hover line).
    [done] B. Foundation B: activity substrate + provenance contract.
    [done] 6. Edges: containment connectors + hover highlights + boundary tiles.
    [wip ] 7. Agent tracking: basic glyphs/hover landed with B; polish remains.
    [next] 8. Planning representation: plan-mode overlay (dashed proposed files).
    [shelved] 5. Optional: full-screen "zoom" route for detail.

The next features (6–8) are scoped in "## Next features (planned)" below.

### What diverged from the original plan (read before extending)
- **Scoped window, not one big graph.** The payload is a 2-level window rooted at
  a `scope` (a repo-relative directory; `""` = repo root): the scope's direct
  children (layer 0) and their children (layer 1). Drilling into a directory
  re-roots the view. Keeps the walk and the render bounded on large repos.
  `PAYLOAD_VERSION` is now **3** for this scope-relative shape.
- **Semantics live in a separate per-project store, not in the structure cache.**
  The store (`semantic-store.ts`) is keyed by node id and holds only
  `{ layer, hash }`. `hue`/`tags` are *derived* from `layer` at the read boundary
  (`LAYER_HUE`), so palette/vocabulary changes need no re-tag. Structure caches
  are never mutated by the paint.
- **HTTP API, not the structured-tool SSE channel.** The TUI reads the payload
  via `GET /codegraph?scope=&refresh=`. The tagger writes to the store and
  publishes a `codegraph.invalidated` event; the renderer refetches on it. The
  `session.next.tool.success.structured` channel from the original sketch was not
  used.
- **Fixed layer vocabulary (resolves the "fixed vs free-form tags" follow-up).**
  Five layers — interface / application / domain / data / infrastructure — each
  mapped to a distinct *status* theme hue. See `semantics.ts`.
- **A dedicated small-model tagger, not system-prompt injection.** Step 4's
  original "inject guidance so the dev agent self-tags" idea was dropped in favor
  of a frugal standalone tagger (stale-only, minimal context, forked, soft fail).
  The prompt-injection extension points are still listed below if we revisit it.
- **Two taggers now — foreground + background — sharing one gate.** The original
  single forked tag pass became two drivers (`codegraph.ts`): a **foreground** pass
  for the viewed window + one-hop boundary, and a **background** DFS loop that walks
  the *whole repo from the root* (`listFilesDfs`) so semantics fill in without the
  user navigating. They share a `Semaphore(1)` so the API is never hit concurrently;
  the background loop releases the permit during a 1s inter-batch pause so the
  foreground always wins it promptly. The background loop is started from
  **`refresh()`** (the path the TUI actually uses — it always sends `refresh=true`),
  not `load()`. Paced with 429/overload backoff. Details in §2.
- **Hybrid treemap/graph idiom, not plain bordered boxes.** The renderer no longer
  draws a directory as an empty bordered box: a directory is a *treemap block* whose
  bordered grid of layer-colored cells encodes its subtree composition (per-layer
  file count or bytes), and a layer-1 child directory paints a single-row
  composition bar behind its name. This needed a server-side `composition` field on
  the payload (per-directory recursive `{ layer, count, bytes }` weights + subtree
  totals; additive, optional — no version bump) and `codegraph/treemap.ts`
  (`allocateCells`/`buildGrid`/`coalesce`). Files stay tiles; kind is still corner
  shape. See renderer section #4 — its "bordered boxes" prose is superseded by this.
- **Scrollable top bar.** Layer-0 children render in an unbounded horizontal strip
  inside a `scrollbox`; a directory's child grid can be expanded past
  `MAX_CHILDREN` in place (the `…` overflow tile). Horizontal panning doesn't touch
  `scope`, so an expanded directory stays expanded while you pan.
- **Action glyphs propagate up the tree with a solid/outline fill axis (today).**
  The overlay glyph for a file action is drawn *solid* on the file actually touched
  and *outline* on every ancestor directory that contains it, so a parent/grandparent
  shows what changed beneath it without drilling in. Three actions, one shape each —
  read = circle, create = square, edit = diamond — each with a solid and outline
  form (all single-width U+25xx geometric glyphs). The `write` tool (whole-file
  write / new file) maps to `create`; a second legend row (beneath the layer
  swatches) shows the solid+outline glyph pair per action. See Foundation A.

## Architecture: four separated concerns

    [1] Structure extractor (deterministic) ──┐
                                              ├──> [3] Graph payload (cached, stable IDs)
    [2] Semantic tagger (agent, async)      ──┘            │
                                                           ▼
                                       [4] TUI renderer (pluggable layout strategy)

The payload (#3) is the seam. The extractor and tagger never know whether the
graph is rendered as a top-bar or a sidebar, so layout placement is
low-commitment and reversible.

### 1. Structure extractor — deterministic, server-side
`packages/opencode/src/codegraph/extract.ts`
- Builds the payload from the directory tree + lightweight import parsing
  (TS/JS: relative `from`/`require`/dynamic-import; Python: dotted-relative
  `from`/`import`). Bare/package specifiers are intentionally dropped — only
  intra-repo edges.
- **Bounded scoped walk:** one glob *per layer* (never `**/*`), capped by
  `MAX_FILES` (20000), `MAX_FILE_BYTES` (512KB skip-for-parse), and
  `READ_CONCURRENCY` (24). `IGNORED_DIRS` (node_modules, .git, dist, …) pruned in
  the glob and again by a belt-and-suspenders path check.
- **Whole-repo enumerators for the background tagger:** `listFiles` (flat) and
  `listFilesDfs` (DFS pre-order via a pure segment-aware `dfsCompare`, so a
  directory's files emit contiguously before sibling subtrees). Same glob / ignore /
  cap / node-id scheme as the scoped walk; the cap is applied *after* the DFS sort so
  the kept files are the root-most ones.
- **Determinism is the core invariant:** node id = `n_` + sha256(repo-relative
  path) slice — content-independent, so the same file is the same node across runs
  and scopes. Nodes sorted by id, edges sorted by `from+to`, layout assigned by
  sorted path order. Identical disk state ⇒ byte-identical payload.
- `normalizeScope`, `VIEW_DEPTH`, and `parseImports` are exported (reused by the
  service's window math and by the tagger's context builder).

### 2. Semantic tagger — agent-driven, async, frugal
The pass lives in `packages/opencode/src/codegraph/tagger.ts`; the two **drivers**
that feed it live in `codegraph.ts`.
- `tagStale(deps, dir, projectID, scope, fileNodes, origin)` infers **one
  architectural layer per file** with the small/fast model (`provider.getSmallModel`,
  Haiku-class; honors `small_model`), via `generateObject` with a fixed-enum schema,
  and writes `{ layer, hash }` to the per-project store. `origin` (`"fg"`/`"bg"`)
  only tags the perf trace.
- **The only place tokens are spent.** Two frugality rules: (1) *stale-only* —
  a file is (re)tagged only if it has no entry or its content hash changed, so
  re-displaying/navigating unchanged files costs nothing; (2) *minimal context* —
  the model sees path + parsed imports + leading comment. Config
  `codegraph.tagger.context: "medium"` additionally sends exported names + file
  head for tuning.
- **Soft failure:** any read/model/parse error leaves existing semantics intact
  and publishes nothing, so the bar always keeps working. Rate-limit/overload
  (429/5xx) errors are retried around the model call with exponential + jittered
  backoff (`BG_MAX_RETRIES` 4); on exhaustion the batch soft-fails (tags nothing).
- Caps: `MAX_PER_PASS` 60 files read per pass, `TAG_BATCH` 30 per model call (≈low-
  thousands of input tokens — minimal context keeps a 30-file request small).
- **Two concurrent drivers, one shared gate** (`tagGate = Semaphore(1)`, so the two
  never hit the API at once and never double-tag — collision is otherwise free since
  both write the same node-id-keyed store, so whichever reaches a file first wins and
  the other no-ops on the matching hash):
  - **Foreground** (`scheduleTag`, origin `"fg"`) — tags the viewed window's files +
    one-hop boundary targets. Forked `forkDetach` off the read path (`finalize`); an
    `inFlight` set dedupes concurrent passes per `directory+scope`.
  - **Background** (`startBackgroundTagger`/`backgroundLoop`, origin `"bg"`) — a
    self-rescheduling per-directory loop that DFS-walks the **whole repo from the
    root** (`listFilesDfs`) in `BG_BATCH` (60) slices, so semantics fill in past the
    viewed window without the user navigating. After a model batch it sleeps
    `BG_BATCH_DELAY` (1s) **outside** the permit (this is the foreground-priority
    mechanism *and* the rate-limit spacing). When a full pass tags nothing new it
    parks on a coalescing `dropping(1)` **wake** queue; file changes / turn
    completion offer to that queue to re-walk. **No persisted cursor** — the
    content-hash store IS its "done" memory, so each pass restarts from the root and
    cheaply skips already-tagged slices (disk read + hash, zero tokens); the
    in-memory cursor resets per pass. Forked `forkIn(serviceScope)` so it lives for
    the service's lifetime (same scope as the file-event subscriptions) and is
    interrupted on instance disposal; `bgTaggers` map dedupes starts.
  - **Started from `refresh()`**, not just `load()` — the TUI always fetches
    `refresh=true` (→ `refresh()`), so kicking the loop off only in `load()` (which
    the TUI never calls) left it dead while the foreground, driven from the shared
    `finalize`, worked. Start is idempotent per directory.
- On success publishes `codegraph.invalidated` so the live view re-merges. A bg batch
  that tags files therefore triggers a TUI refetch → a (usually no-stale, no-token)
  foreground pass; that coupling is by design (the view repaints as bg colors it in).
  The stale-only guard prevents a tag→refetch→tag cycle (the next pass finds matching
  hashes and publishes nothing).
- **Deterministic perf trace** (`<repo>/perf/tagger.log`, written in code, never by
  the agent): one JSON line per model batch — `{ tagger, timestamp, input, output }`
  — plus `event` lines (`pass-start` with file count, `skip` with `no-stale`/
  `no-language` reason) so a driver that produces no batches is still traceable.
  Appends are race-free because `tagGate` serializes the two drivers.

### 3. Graph payload — the stable contract
`packages/opencode/src/codegraph/payload.ts` (Effect `Schema`)

    { version,
      nodes:    [{ id, path, kind: "file"|"directory", size, position: { layer, index } }],
      edges:    [{ from, to, kind: "import" }],
      semantics:{ [nodeId]: { tags: string[], hue?: string, layer?: Layer } } }

- `position.layer` is **scope-relative** depth (0 = direct child of the scope);
  `position.index` is the stable slot within a layer. Renderers map (layer, index)
  to screen coords per orientation — the payload is orientation-agnostic.
- `size` is bytes for files; **0 for directories** (collapsed nodes whose contents
  are the *next* scope, so not walked at this layer).
- `semantics` is keyed separately from `nodes` so it updates asynchronously
  without touching structure. Adding the optional `layer` field was backward
  compatible (older caches decode with an empty map) — **no version bump needed
  for additive optional semantics fields.**
- **Bump `PAYLOAD_VERSION` whenever the extractor's output shape/semantics change**
  — `codegraph.ts` gates cache reads on an exact version match, so a stale cache
  from an older extractor is never served. (v2 = single-layer walk replacing the
  old recursive `**/*`; v3 = scope-relative window, cached per scope.)

### 4. TUI renderer — plugin + a core slot (fork)
`feature-plugins/system/codegraph.tsx`, slot wired in `routes/session/index.tsx`
- `codegraph_top` slot lives above chat content. `TOP_BAR_HEIGHT = 14`, fixed.
  Toggle via the `session.codegraph.toggle` command (kv signal `"codegraph"`).
  Hidden for subagent sessions (`parentID`) and terminals shorter than 20 rows.
- Draws layer-0 children as bordered boxes with their layer-1 children beneath
  (grouped by path prefix, capped at `MAX_CHILDREN` 4 with a `…` overflow tile).
  **Kind is encoded by corner shape** (directories square, files rounded) so
  border/background stay free; **hue is the painted layer color**, falling back to
  structural colors (dirs accented, files muted) until tagged.
- **Navigation (mouse-first):** click a directory box to re-root; `⟳` refresh,
  `⌂` root, `◀` up, and a clickable breadcrumb walk back out. A legend row shows
  the fixed layer vocabulary + a Directory swatch.
- **Pluggable layout was the design intent** but only the horizontal strategy
  exists today; (layer, index) in the payload is what a future vertical/sidebar
  strategy would consume. Moving to a sidebar later = swap the `<Slot/>` location
  + a vertical layout; payload/extractor/tagger untouched.

### 3.5 Live update model (how the view stays current)
`packages/opencode/src/codegraph/codegraph.ts` (the `CodeGraph` service)
- **Recompute-on-display:** the TUI fetches with `refresh=true`, so every scope it
  shows (navigation, manual `⟳`, live invalidation) is recomputed from disk. The
  2-level walk is cheap and keeps a drilled-in view consistent with its parent.
- **Visibility-gated invalidation:** the service subscribes to `Watcher.Updated` +
  `FileSystem.Edited`; a changed file marks dirty (and publishes
  `codegraph.invalidated`) only for **already-cached** scopes whose 2-level window
  (`isWithinWindow`) contains it. A file in an unopened directory costs nothing.
  Caches + the dirty set live per project directory, cleaned on instance disposal.
- **Shell-mutation catch-all:** shell commands (rm, mv, git, scaffolding) mutate
  the tree without firing `file.edited`, so the renderer also refetches on
  `session.next.shell.ended` for its own session. Inert when the experimental
  event system is off; manual `⟳` / navigation still cover it.
- The structure cache stays pure: `finalize` merges semantics onto a *copy* at the
  read boundary and schedules the **foreground** tag pass, so all read paths (memory,
  disk, recompute) share one merge+tag site. The **background** whole-repo DFS loop is
  a separate driver started (idempotently) from `load`/`refresh` and runs on its own
  fiber regardless of navigation (see §2).

## ⚠️ Catastrophic failure mode (learned the hard way, step 2)

Symptom: opencode runs fine for a while, then RAM climbs without bound
(~30MB/s, seen via VmmemWSL) while completely idle — no prompting, no
navigation. The code-graph top bar never paints. CPU is busy.

Root cause: a slot renderer that reads a `createResource` accessor **directly in
the render/tracking scope**. In SolidJS, calling the accessor (`graph()`) while
the resource is in its **error** state *re-throws synchronously inside render*.
That trips the slot's error boundary (see @opentui/solid `Slot`, which
re-renders on a version signal and reports via `onPluginError`), which
re-renders, which re-reads, which throws again — a tight render → catch →
re-render loop. Every cycle allocates (VNodes, error objects, OpenTUI text/
layout renderables), so memory grows unbounded. Gating UI with
`<Show when={(graph()?.nodes.length ?? 0) > 0}>` is the same trap: the condition
calls the accessor.

Why it hid: the loop only runs when the resource is in error AND something keeps
re-rendering. A small/empty/idle working directory produces almost no store
churn, so the component barely re-renders and the leak is invisible. The
opencode tree (LSP, file watcher, snapshots → constant store updates) drives
constant re-renders, so the same code there leaks at ~30MB/s. **A bug that
reproduces only in busy directories is the tell.**

Fix (in feature-plugins/system/codegraph.tsx): never call a resource accessor
unguarded in render. Check `resource.error` first and return a fallback *without*
calling the accessor; route every read through a helper that short-circuits on
error (the live code: `const nodes = () => graph.error ? [] : graph()?.nodes ??
[]`, and `hueOf`/`summary` likewise). Keep the bar frame always mounted (fixed
height) rather than gating it behind `<Show when={graph()...}>`.

How it was localized (use this method for render/leak bugs): dewire the data
path entirely → hardcode a static bar (stable + visible confirms slot/layout is
sound) → add back the fetch + a count readout only (stable confirms fetch/
resource is sound) → add back the per-node `For` rendering with guarded reads
(stable = done). Bisecting one variable at a time beats reading code. Also
isolate the instance-under-test (run against a scratch dir or a git worktree) so
your own edits to the watched tree don't confound the memory reading.

Two upstream contributors that made errors more likely, both fixed: (1) the
extractor used to walk `**/*` and read every file (node_modules included),
exhausting memory during compute — now single-layer/scoped with caps; (2) a
stale durable cache from the old extractor was served because `PAYLOAD_VERSION`
wasn't bumped — bump the version (or clear storage/codegraph) whenever the
payload shape or extractor semantics change.

## Next features (planned) — steps 6–8

Three capabilities come next: **edges** (6), **agent tracking** (7), and
**planning representation** (8). They are deliberately scoped around two shared
foundations so the work compounds instead of duplicating.

### Findings that shape the design (verified)
- **Plan mode is the `plan` agent** (`agent/agent.ts:142`): entered by an agent
  switch, exited by the `plan_exit` tool → switch to `build` (`tool/plan.ts`).
  Both transitions emit **`session.next.agent.switched`**
  (`core/src/session/event.ts:41`, `data.agent` = `"plan"`/`"build"`). That single
  event is the plan/build signal.
- **Plans are freeform markdown** at `.opencode/plans/*.md` (`Session.plan(...)`);
  there is **no structured representation of proposed file ops**, and plan mode
  *denies* edits, so the agent emits **no planned-edit tool calls** — only
  reads/greps/globs are observable. Proposed new files must be recovered by parsing
  the plan markdown.
- **Live agent actions** ride `session.next.tool.*` (`core/src/session/event.ts`):
  `tool.called` = `{ callID, tool, input }` (file tools expose `input.filePath`),
  `tool.success/failed` carry results + `time`. **Turn boundary** =
  `session.next.prompted`. **Agent attribution** = resolve `sessionID` → session
  `agent`/`parentID`. ⚠️ This family is gated behind
  `OPENCODE_EXPERIMENTAL_EVENT_SYSTEM` (`effect/runtime-flags.ts:48`); the plugin
  already leans on `session.next.shell.ended`, so absence degrades gracefully (no
  glyphs). Non-experimental fallback (later): the always-on message-part stream in
  `context/sync-v2.tsx` carries the same tool state.
- **The extractor only resolves imports inside the window today** (`extract.ts`
  `resolveImport` matches `knownFiles`), so cross-window imports are dropped.

### Decisions locked in
- **Edges = window + immediate dependency surface, not repo-wide.** Resolve a
  file's relative imports; if a target falls outside the window, include *that*
  file (or its directory) as a one-hop **boundary node** via bounded `fs.stat`
  checks — never recurse, never glob the whole repo.
- **Proposed-file paths come from a prompt instruction, not inference.** Add one
  line to `session/prompt/plan-mode.txt` telling the agent to reference each new
  file's **full repo-root-relative path at least once**; parse the plan markdown
  for code-file paths. Chosen because its failure mode is *silent omission* (path
  not drawn), never a hallucinated node.
- **Provenance is in-memory now, contract-ready.** Define the activity/provenance
  schema now; the TUI keeps a per-turn ring in memory for the live view. Durable
  server-side persistence + the full timeline UI come later without reshaping data.

### Dependency map / build order
```
  Foundation A: node-overlay render layer (glyph vocab + one hover-info line + setScope nav)
        │ shared by ALL three
        ├── Foundation B: activity substrate (events → per-turn, multi-agent; Provenance contract)
        │        ├── [7] retrospective agent tracking
        │        └── [8] planning: plan-mode reads (same data, plan-agent = prospective styling)
        └── [6] edges (extractor boundary nodes + hover-highlight + link-out)   ← DONE
  [8] also needs: plan-mode detection (agent.switched) + plan-overlay (md parse + prompt line)
```
Order: **A → (6 ‖ B) → 7 → 8.** 6 and B shared no data and were built in parallel
after A; **6 is done**, B/7 basic is done. Remaining: 7 polish, then 8.

### Foundation A — node-overlay render layer (shared, pure renderer) — DONE
Implemented in `codegraph.tsx` + `codegraph/activity.ts` (data-free vocabulary,
sibling to `semantics.ts`): `Action = read|create|edit`, `ACTION_GLYPH`, a
`Style = actual|planned` axis, and a `Fill = solid|outline` axis. **`ACTION_GLYPH`
is now one shape per action with two fills** — read = circle (`●`/`○`), create =
square (`■`/`□`), edit = diamond (`◆`/`◇`); all single-width U+25xx geometric
glyphs, so solid and outline forms render in the same terminals. (`create` covers
the `write` tool — whole-file write or new file; `actionFromTool` maps `write` →
`create`.) **Solid marks the node an agent acted on directly; outline marks an
ancestor directory that contains a touched file** — the glyph propagates up the
tree. The renderer has: a reactive **hover-info line** in the header (`hovered`
signal; shows a node's path/size on `onMouseOver`, falls back to the summary), and
an **`OverlayRow`** glyph slot on every tile (file tiles, layer-0 dir blocks, and
layer-1 child dir tiles) fed by a single `overlaysFor(node)` accessor — a file
emits solid glyphs for its own actions; a directory emits outline glyphs for any
action on a descendant (a direct/solid action wins over a containment/outline one
for the same action). Planned overlays dim; actual ones use the producer's color.
Step 8 only fills `overlaysFor` with `style: "planned"` + sets `hovered`; no
render-tree changes. No payload change.

### Foundation B — activity substrate + Provenance contract (client) — DONE
Contract added to `codegraph/activity.ts` (data-free, persistence-ready):
`ActivityEntry = { path, action, agent, sessionID, callID, timestamp }`,
`Turn = { promptedAt, entries[] }`, and `actionFromTool(tool)`. The reactive
tracker lives in `feature-plugins/system/codegraph-activity.ts`
(`createActivityTracker(api, sessionID)`): subscribes to `prompted` (→ new turn,
own session only), `step.started`/`agent.switched` (→ current agent per session),
and `tool.called` (read/edit/write → entry; `input.filePath` normalized to
repo-relative). Keeps a `MAX_TURNS`-deep ring in memory; exposes
`entriesFor(path)` (via a per-path memo), `current()`, `history()`, `agents()`.
Graceful no-op when `OPENCODE_EXPERIMENTAL_EVENT_SYSTEM` is off.

A **thin step-7 render rode along** so B is verifiable: `overlaysFor` emits one
glyph per distinct action on a node, colored per agent (`agentColor`, hashed
status palette), and the hover line appends `<agent> <action> <relTime>`. The
tracker indexes each entry under both its exact path and every ancestor directory
(`descendantsFor`), so a directory tile shows the **outline** form of the glyphs
for actions on files anywhere beneath it (propagated up to parents/grandparents);
the touched file itself shows the **solid** form. Sub-agent activity is captured
(entries carry `sessionID`) but not yet visually grouped.

### [6] Edges — DONE
Two edge *types*, split by what the flexbox top-bar can draw (a horizontal row of
parent columns, children in a row beneath — no cell coordinates to route arbitrary
lines, so only local/fixed geometry gets a literal connector). All three idioms
below shipped and are verified in the TUI.

- **Containment (directory → child):** a purely-visual white `│` drop per child in
  a 1-row connector strip between a parent box and its children row. Children render
  at a **fixed width** (`CHILD_W`; truncate label with `…`, full name on hover) so
  every drop aligns to its child's center regardless of name length — the drop strip
  reuses the same `CHILD_W`+gap `For`, so alignment is structural, not computed.
- **Import (in-window):** *not* drawable as a literal line between arbitrary boxes
  (deferred — costly in 14 rows). Represented by **hover-highlight**: a `hoveredId`
  signal + a memoized `adjacency` map (both directions, boundary edges excluded);
  hovering a node recolors the node itself (bright `text`) and its importers/
  importees, each tinted by **its own** layer hue. Hover line lists out-of-window
  targets (`→ a.ts b.ts`).
- **Import (out-of-window / boundary):** each off-window relative import becomes a
  **boundary tile** — a square glyph `▪` (distinct from the `◌◆●◈` action glyphs),
  width `TILE_W`, beneath the importing node, joined by a white `│` drop, `fg` = the
  target's layer hue. Click → `setScope(dir-of(boundary.path))`. Capped per node
  with a `…` overflow, like child tiles.

As built:
- **Extractor (`extract.ts`):** a *second* import pass. Pass 1 resolves against the
  in-window `knownFiles` (unchanged). Pass 2: a relative spec that didn't resolve
  in-window is recorded as a probe (deduped by candidate base + ext set) and
  resolved one hop on disk via bounded `fs.stat` over `diskCandidates` (base, then
  `+ext`, then `index`/`__init__`). Guards enforce the depth bound: **never parse
  the resolved file** (no transitive edges), never glob, drop targets that escape
  the repo root (`..`) or hit an ignored dir, and skip a probe that resolved back
  into the window (already a pass-1 edge). `resolveImport`/`importTargetBase`/
  `diskCandidates` are the shared source of truth so in-window and on-disk
  resolution agree. Boundaries sorted by id; edges (incl. boundary edges) sorted —
  determinism preserved.
- **Payload (`payload.ts`):** new optional `boundaries: [{ id, path, kind }]` (no
  `position` — kept out of the layer grid); an `Edge.to` may reference a boundary
  id. **`PAYLOAD_VERSION` → 4.** The extractor always emits `boundaries` (possibly
  `[]`) for byte-stable output; the field is optional only so decoders tolerate its
  absence. Also fixed `Semantic` to carry the `layer?` field added in step 4.
- **Boundary coloring (`codegraph.ts`):** `finalize` derives hue for boundary ids
  from the *same* semantic store as nodes (factored into one `applySemantic`), and
  `scheduleTag` hands the tagger in-window files **plus** boundary `file` targets —
  so an out-of-window dependency gets tagged on first view (keyed by stable id, so
  the tag is reused when the file is later opened in-window), then `Invalidated`
  fires for the viewed scope and the tile repaints. Additive — no version bump.
- **Renderer (`codegraph.tsx`):** `boundaryById` / `boundariesFor` / `adjacency`
  memos over guarded accessors (all reads short-circuit on `graph.error`, per the
  catastrophic-leak rule); `borderColorFor` + `enterNode`/`leaveNode` drive the
  hover highlight; fixed-width children + containment/boundary `│` drop strips.
- **Tests (`extract.test.ts`):** one-hop boundary appears (not as a placed node) and
  the second hop is excluded; in-window relative imports stay normal edges; a
  no-boundary case asserts `boundaries: []`.

**Known v1 limitations (tracked in Open follow-ups):**
- **Boundary tiles render for layer-0 nodes only.** A nested file's off-window
  imports surface via the hover line; drilling into its directory promotes it to
  layer-0 and the tile appears. Per-child boundary strips were skipped to stay in
  the 14-row budget.
- **Incoming cross-window edges are invisible** (window-only parsing): hovering a
  node shows what *it* imports out-of-window, not who imports *it* from outside.
- Boundary coloring depends on the target being a `SOURCE_GLOB` file and a small
  model being configured; both degrade silently to grey.

**Not done (out of scope, handled separately):** SDK regen — `packages/sdk/js`
`gen/` is produced out-of-band (`bun run build` → live OpenAPI dump) and is not
hand-edited; the renderer casts `result.data`, so it's unaffected. Regenerate to
pick up `boundaries` (and the still-missing `layer`).

### [7] Agent tracking (retrospective) — basic version landed with B
Working today: per-turn glyphs on touched nodes, agent-colored, hover shows
agent/action/relative-time, reset on new prompt. Each action has its own shape
(read = circle, create = square, edit = diamond, shown in the legend), and the
glyph propagates up the directory tree — solid on the touched file, outline on its
containing directories. **Remaining polish:** a multi-agent legend (agent colors)
+ sub-agent grouping under the spawner, and a richer
(reactive) hover that updates while still pointed at a node.

### [8] Planning representation
1. **Detect plan mode** via B's current-agent tracking → switch the view to
   planning styling.
2. **Planned reads:** reuse B entries whose agent is `plan`, rendered with the
   `planned` style axis.
3. **Proposed files (plan-overlay):** parse the active plan markdown for
   code-file paths (reuse `SOURCE_GLOB` extensions) → **dashed-border blocks** at
   their tree location (+ dashed glyphs for planned edits to existing files).
   Recommend producing this **server-side** in the codegraph service (it has FS +
   project context + `Session.plan(...)` and already watches `file.edited`),
   exposed as an additive optional payload field (no version bump) refreshed via
   the existing invalidation path. Plus the one-line `plan-mode.txt` edit.

### Critical files (steps 6–8)
- `feature-plugins/system/codegraph.tsx` — Foundations A/B, render for 6/7/8.
- `codegraph/extract.ts`, `codegraph/payload.ts` — boundary nodes + version bump (6).
- `codegraph/activity.ts` (new) — glyph vocabulary + `ActivityEntry`/`Turn` types.
- `codegraph/codegraph.ts` — boundary semantic merge + tag boundary targets (6,
  `finalize`/`scheduleTag`); + small new module for the plan-overlay producer (8).
- `session/prompt/plan-mode.txt` — full-path instruction for new files (8).
- HTTP/SDK regen if a field/endpoint is added (`httpapi/groups/codegraph.ts`,
  `sdk/js/src/v2/gen/`).
- Reference (no change): `core/src/session/event.ts`, `tool/plan.ts`,
  `agent/agent.ts`, `context/sync-v2.tsx` (fallback source).

### Verification (steps 6–8)
- `bun typecheck` per package; extend `test/codegraph/extract.test.ts` for
  boundary resolution.
- **6 (DONE, verified):** in a repo with cross-dir imports, hover highlights
  neighbors + lists out-of-window targets; clicking a boundary tile re-roots to the
  target's dir; the tile repaints in the target's layer hue once tagged. Note the
  layer-0-only tile limitation: drill into a directory to see a nested file's tiles.
- **7:** with `OPENCODE_EXPERIMENTAL_EVENT_SYSTEM=true`, have an agent read/edit a
  few files → glyphs appear, hover shows agent + timestamp, new prompt resets the
  set; confirm no-glyph graceful degrade with the flag off.
- **8:** switch to the `plan` agent → planning styling; plan-mode reads show
  prospective; after the agent writes a plan referencing a full-path new code file,
  a dashed block appears; a path written without a full root-relative form is
  simply omitted (no phantom node).
- Memory guard (above): keep all resource/accessor reads guarded; watch RAM flat
  in a busy tree.

## Open follow-ups (not blockers)
- **Edge extraction depth.** Regex import/require parsing today; LSP-backed
  call/type edges later (`api.state.lsp()`). No re-export/alias resolution. Step 6
  added one-hop boundary resolution but stays regex-based and resolves only
  *relative* specs (tsconfig path aliases / bare specifiers are still dropped).
- **Boundary tiles are layer-0-only; incoming cross-window edges are invisible.**
  Both fall out of window-only parsing (only in-window files are read). A richer
  pass — per-child boundary strips, and parsing a thin ring *just outside* the
  window to discover importers — would lift both, at a bounded cost.
- **Connector lines for in-window imports.** Arbitrary node→node import lines stay
  deferred (no cell coordinates in the 14-row flexbox); hover-highlight stands in.
  A future vertical/sidebar layout could afford real routed edges.
- **SDK regen for step 6.** `packages/sdk/js/gen/` still lacks `boundaries` and the
  step-4 `layer` field; run `bun run build` in that package to refresh (renderer is
  unaffected as it casts the response).
- **Directory size is always 0.** Collapsed dir nodes could carry a descendant
  byte-sum if we want size-weighted layout, at the cost of a deeper walk.
- **Durable provenance + timeline.** Step 7 keeps activity in memory; a later
  server-side per-project provenance log (like the semantic store) + a timeline UI
  would give cross-restart history. Contract is designed to allow it.
- **Structured plan ops.** Step 8 recovers proposed files by parsing markdown; a
  future core change could have the plan workflow emit structured ops directly.
- **Per-edit self-tagging (the dropped step-4 path).** If the standalone tagger
  proves too slow/costly, revisit injecting tagging guidance so the dev agent
  tags files it edits (config-first via AGENTS.md, then the system-transform
  hook). Extension points preserved below.
- **Tag vocabulary growth.** Fixed enum today. Free-form tags or metrics would
  extend the `Semantic` shape additively (optional fields, no version bump) and
  need a hue policy for unknown tags. The two-tagger substrate (foreground view +
  background whole-repo sweep) is the intended base for *user-defined* tags later.
- **Background sweep re-walk cost.** The background loop restarts from the root each
  pass and re-reads+re-hashes already-tagged files (no tokens, but disk I/O) before
  reaching new work. Two optional tightenings if it matters on a large mostly-tagged
  repo: a **skip-ahead cursor** (remember the furthest fully-tagged index in a
  generation so a wake doesn't re-hash everything) and a **wake-scoped re-walk** (on a
  file-change wake, walk only the changed subtree; turn-idle still does a full sweep).
  Also: the per-bg-batch invalidation drives a TUI refetch (a no-token foreground
  pass + scope recompute) — debounceable if the refetch storm ever shows up.
- **Full-screen zoom route (step 5, shelved).** A detail route for a single node /
  subgraph; template at feature-plugins/system/diff-viewer.tsx.

## Frozen reference — verified extension points

TUI stack: TypeScript + SolidJS + OpenTUI under
packages/opencode/src/cli/cmd/tui/ (NOT Go/bubbletea). OpenTUI runs a 60fps
flexbox render loop; you mutate SolidJS signals, never write a draw loop.

UI extension surfaces: routes (full-screen), slots (named injection points),
dialogs (modals). opencode's own UI is built as internal "feature-plugins"
(feature-plugins/) using the same public TuiPluginApi a third party gets.

Mouse is first-class: `<box>`/`<text>` accept onMouseDown/Up/Over/Out/Move +
onClick (MouseEvent with target+coords). The code-graph bar uses onMouseDown for
drill-in/navigation; more examples at sidebar/files.tsx:22,
routes/session/index.tsx:2011.

Code-graph files (this feature):
- Server: packages/opencode/src/codegraph/ — payload.ts (contract),
  extract.ts (deterministic walk), codegraph.ts (service: cache + window math +
  events), tagger.ts (semantic paint), semantic-store.ts, semantics.ts
  (layer/hue vocabulary), event.ts (codegraph.invalidated), dump.ts (CLI verify).
- HTTP: server/routes/instance/httpapi/groups/codegraph.ts (+ handlers/,
  registered in server.ts and api.ts).
- TUI: feature-plugins/system/codegraph.tsx; registered in
  cli/cmd/tui/plugin/internal.ts; slot placed in routes/session/index.tsx:1155.
- Tests: packages/opencode/test/codegraph/extract.test.ts.

Slots:
- Host slot map: packages/plugin/src/tui.ts (TuiHostSlotMap — `codegraph_top`
  added here).
- Slot placement in session view: routes/session/index.tsx:1155 (gated by
  `codegraphVisible`, :248); top-bar height/visibility math at :246-252.
- Sidebar slot template: feature-plugins/sidebar/files.tsx:54
- Full-screen route template: feature-plugins/system/diff-viewer.tsx:934
- Sidebar container (fixed 42 cols, auto-hides narrow/subsession):
  routes/session/sidebar.tsx:29, routes/session/index.tsx:238-243

Events (server → TUI):
- codegraph.invalidated: defined packages/opencode/src/codegraph/event.ts;
  registered by importing that module from the route group (before api.ts
  snapshots the EventV2 registry into the SDK Event union). TUI subscribes via
  `api.event.on("codegraph.invalidated", …)`.
- File events that feed invalidation: file.edited
  (packages/core/src/filesystem.ts:80), file.watcher.updated
  (packages/core/src/filesystem/watcher.ts:24).
- session.next.shell.ended (experimental) — used as the shell-mutation refetch.

HTTP payload channel:
- GET /codegraph?scope=&refresh= → CodeGraphPayload.Payload. Middleware:
  InstanceContext + WorkspaceRouting + Authorization. Consumed in the TUI via
  `api.client.codegraph.get(...)`. SDK types regenerate into
  packages/sdk/js/src/v2/gen/.

System-prompt injection (only if revisiting per-edit self-tagging):
- Assembly: packages/opencode/src/session/prompt.ts:1438-1446 then
  packages/opencode/src/session/llm/request.ts:56-78
- Hook experimental.chat.system.transform: invoked at
  session/llm/request.ts:69; type at packages/plugin/src/index.ts:291
  (mutable { system: string[] })
- Config-based instructions (auto-loaded): AGENTS.md/CLAUDE.md at
  session/instruction.ts:62-66; config.instructions globbed/loaded at
  session/instruction.ts:133-167

Tool hooks (alternative changed-file detection):
- tool.execute.before/after wrapping: packages/opencode/src/session/tools.ts:90
  and :105; type packages/plugin/src/index.ts:274 (filter input.tool ===
  "edit"|"write")

Persistence:
- Durable KV: packages/opencode/src/storage/storage.ts:55 (read/write/update/
  remove/list, string[] keys). Code-graph keys: structure caches under
  ["codegraph", projectID, "structure", scopeKey]; semantics under
  ["codegraph", projectID, "semantics"]. `storage.update` is atomic read-modify-
  write under a write lock (used by semantic-store upsert so concurrent scope tag
  passes don't clobber each other).
- Per-open-project in-memory state: the service's `caches` Map keyed by directory;
  cleaned via registerDisposer on instance disposal.

Provider / model (tagger):
- provider.defaultModel → getSmallModel(providerID) → getLanguage(small). Returns
  undefined when no small model is available; the tagger then skips the pass.
- Provider/Config are provided to the CodeGraph layer (see defaultLayer) so the
  forked tagger keeps R = never, mirroring Agent.defaultLayer.

Config:
- Schema: packages/core/src/v1/config/config.ts — `codegraph.tagger.context`
  ("minimal" | "medium"). JSONC supported.

Module/style conventions: see AGENTS.md (flat exports + self-reexport, Effect v4
rules, snake_case Drizzle, run bun typecheck from package dirs).
