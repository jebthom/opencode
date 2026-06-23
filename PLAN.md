# Aperture

A persistent, fast, high-altitude **View** of the repository that an agent
paints with user-defined **Lenses** (each a set of **Facets**) during planning,
prompting, exploration, and review. Structure is deterministic (directory tree +
syntax, stable ids, cached layout) so it never reflows distractingly; semantics
are malleable and async — an agent attaches a Facet (and its hue) to each file
over time. The first idiom is a wide top-bar above the chat showing a 2-level
window of the View that the user can drill into.

A recent large speedup of Facet painting changed how people will engage with
Aperture: Lenses are now cheap enough to **define-and-explore live** rather than
wait on a slow background paint. This shifts the final sprint to two archetypal
workflows — **Sensemaking** (understand an existing repo) and **Building**
(create a new feature) — and the work below is organized around them.

## Vocabulary

The project was previously "codegraph". It is now **Aperture**, with renamed
domain terms throughout:

| Old | New |
| --- | --- |
| codegraph (feature, dir `codegraph/`, `CodeGraph.Service`, slot `codegraph_top`, env `OPENCODE_CODEGRAPH_LAYOUT`, route `/codegraph*`, event `codegraph.invalidated`, config `codegraph.*`) | **Aperture** / **View** |
| tag collection / `TagCollection` / "collection" | **Lens** |
| tag (a semantic category) / `TagDef` | **Facet** |
| the graph / top-bar visualization | **View** |
| `/tag` command, `tag` agent | **`/lens`**, **lens** agent |
| a Facet's color | **hue** (term unchanged) |

Rename decisions (recorded here, executed as Task 0):
- **Clean break.** Rename wire/persistence strings too — storage keys, config
  keys, the env var, HTTP routes, the `*.invalidated` event, the
  `tag_collection_*` tool names, and the SDK gen. Accept orphaned cached Views /
  Lenses; the project is pre-release, so no migration shim.
- **Lenses become project-scoped on disk.** Today they persist in global durable
  KV keyed by projectID (`["codegraph", projectID, "collections"]`). Move them
  into the project directory so a Lens is shareable/committable and an agent can
  read it directly (this underpins Sensemaking task **A3**). The clean break was
  going to touch these keys anyway.
- **"tagger".** The engine that paints Facets — decide during the refactor
  whether to keep the name or rename to "painter". The renames that matter for
  the contract are the data-model symbols (`TagCollection`→Lens, `TagDef`→Facet,
  stored `tag`→`facet`); the engine name is cosmetic, so flag it but don't block.

## Final sprint

The sprint leads with the rename, then is framed by the two workflows. Each
workflow lists a short example dialogue, then the concrete tasks it requires.

### Task 0 — Rename refactor (Aperture / View / Lens / Facet, clean break)

Mechanical except for the project-scope Lens storage move. Touch points
(inventoried):
- Core: dir `codegraph/`, `CodeGraph.Service`, `payload.ts`, `extract.ts`,
  `tagger.ts`, `collections.ts` + `collection-store.ts` (+ the storage-location
  move), `semantic-store.ts`, `deterministic.ts`, `event.ts`, `semantics.ts`,
  `treemap.ts`, `activity.ts`, `dump.ts`.
- Tools: `tool/tag-collection-{create,list,select,edit,merge-tags}.ts`, the
  `/tag-delete` command, and their tool-name strings; `tool/registry.ts`.
- Agent / command / prompts: `agent/agent.ts` (`tag` agent), `agent/prompt/tag.txt`,
  `command/index.ts` + `command/template/tag.txt`, the `session/system.ts`
  build/plan tagging-awareness block.
- TUI: `feature-plugins/system/codegraph.tsx` (+ `codegraph-activity.ts`), the
  `codegraph_top` slot (`plugin/src/tui.ts`), `OPENCODE_CODEGRAPH_LAYOUT`,
  slot placement in `routes/session/index.tsx`, plugin id in `plugin/internal.ts`.
- HTTP / SDK: `server/routes/instance/httpapi/{groups,handlers}/codegraph.ts`,
  `server.ts`/`api.ts` registration, the `/codegraph*` routes, the
  `codegraph.invalidated` event, regenerate `packages/sdk/js` gen.
- Config: `core/src/v1/config/config.ts` (`codegraph.tagger.*`).
- Tests under `test/codegraph/`.

### Workflow A — Sensemaking Flow (understand an existing repo)

Example dialogue:
> **User:** What are the UI/UX features and components in this repo?
> *(agent suggests a UI/UX Lens, paints it while exploring)*
> **User:** I want a more detailed look at the TUI components.
> *(agent suggests a TUI Lens)*
> **User:** Okay, `<component-a>` is what I'm interested in — what can you tell
> me about those files? How do they solve this problem?
> *(agent lists the files carrying that Facet and explores them, writes an
> overview of each file's concern)*
> **User:** Let's investigate `<file-a>` together.

Tasks:
- **A1 — Paint + explore in parallel.** When a sensemaking question warrants a
  new Lens, the agent kicks off Facet painting (the tagger) **and** exploration
  concurrently, so the Lens fills in while explore runs (today it paints, then
  explores serially).
- **A2 — A new way of organizing Lenses.** *[OPEN DESIGN QUESTION — logged, to be
  settled during the sprint, not now.]* Sensemaking accumulates many Lenses; the
  flat list + ◀/▶ cycle won't scale. Brainstorm candidates: grouping/folders,
  nesting, search/filter.
- **A3 — View + Lenses live in the project, with agent access.** Persist the
  View/Lenses in the project directory (the clean-break storage move), add
  guidance, and provide a **helper tool** so the agent can list every file
  carrying a given Facet (or set of Facets) and read them. This is what powers
  "tell me about `<component-a>`'s files".
- **A4 — Click-to-navigate from chat.** Clicking a file or directory reference in
  the chat re-roots / changes the View in the top bar.
- **A5 — On-demand function-level Facets (drill-in sub-file resolution).** The one
  non-trivial task. Design already sketched in
  `docs/codegraph-subfile-resolution.md` — drill-in-gated, line-delimited extents
  (no parsing), top priority on the single-permit tagger
  (`drill-in > foreground view > background sweep`), painting-not-reading. Follow
  that doc rather than restating it here.

### Workflow B — Building Flow (create a new feature)

Example dialogue:
> **User:** I want to create `<feature-x>`.
> *(plan agent plans the feature and suggests a Lens)*
> **User:** Yeah that sounds great.
> *(build agent creates the Lens first, writes the task-tracking list, then works
> through the tasks; on completion, summarizes the build referencing the Lens)*

Tasks:
- **B1 — Plan suggests a Lens with the plan.** The plan agent proposes a Lens
  alongside the feature plan (the two-way channel already supports opportunistic
  Lens creation; confirm/extend for this flow).
- **B2 — Build creates the Lens first, then the task list, then works.** Sequence
  the build agent: Lens → task-tracking list → execution.
- **B3 — Task list references the Lens / hues.** Task-tracking items reference the
  Lens and its Facet hues; the build summary references the Lens too. (This
  supersedes the old plan-overlay idea — see Parked.)

## Completed features & components (reference)

Everything below is built and in place (terms updated; the prior "what diverged"
narrative is dropped — this is the catalog of what exists).

- **View structure extractor** (`extract.ts`) — deterministic scoped 2-level
  window walk (one glob per layer, bounded by `MAX_FILES`/`MAX_FILE_BYTES`/
  `READ_CONCURRENCY`); stable content-hash node ids (`n_` + sha256(path)), sorted
  nodes/edges/layout so identical disk state ⇒ byte-identical payload; whole-repo
  DFS enumerator (`listFilesDfs`) for the background painter; relative-import
  parsing (TS/JS + Python), intra-repo edges only.
- **Facet tagger** (`tagger.ts` + drivers in `codegraph.ts`) — small/fast-model
  painter assigning one Facet per file from the active Lens's vocabulary via
  structured output. Two drivers (**foreground** viewed-window + boundary,
  **background** whole-repo DFS sweep) share one `Semaphore(1)` so the API is
  never hit concurrently; frugality (stale-only by content hash, minimal
  context); soft-fail leaves existing Facets intact; 429/overload backoff;
  deterministic per-batch perf trace (`perf/tagger.log`).
- **Lens system** (`collections.ts`, `collection-store.ts`) — data model
  (categorical palettes, `MAX_TAGS = 6`, the `none` escape Facet, system-prompt
  builder, closed enum); durable per-project store + active pointer;
  additive-only creates (fresh id per Lens, existing results never mutated/lost);
  `/lens` agent + command + tools (list / create / select / edit / merge / delete).
- **Deterministic built-in Lenses** (`deterministic.ts`) — `GIT_CHANGED`
  (changed-since-last-commit from `git status`) and `MTIME_RECENCY` (six
  equal-span mtime buckets, cool→warm); computed from the repo with no model
  call (zero tokens, always fresh); availability-gated (git Lens hidden outside a
  work tree).
- **Two-way agent channel** (`session/system.ts`, `session/prompt.ts`) — a
  tagging-awareness block injected for the `build`/`plan` agents only; lets a
  primary agent *show* the user something by introducing/switching a Lens; the
  opportunistic path delegates to the lens subagent and uses an `activate` flag so
  it doesn't disturb the current view.
- **Renderer — top-bar View** (`feature-plugins/system/codegraph.tsx`) — `grid`
  and `column` layouts (column default), treemap composition blocks encoding
  subtree make-up, scrollable bar, kind-by-corner-shape, hue paint with
  structural fallback, mouse navigation + breadcrumb, legend with ◀/▶ Lens
  cycle. Lives above chat in the `codegraph_top` slot; hidden for subagent
  sessions / short terminals.
- **Edges** (`extract.ts`, `payload.ts`, `codegraph.tsx`) — containment
  connectors (parent→child drops), in-window import **hover-highlight**
  (adjacency map, neighbors tinted by their own hue), and one-hop **boundary
  tiles** for off-window relative imports (bounded `fs.stat` resolution, click to
  re-root). Follow-ups parked.
- **Activity / agent tracking (basic)** (`activity.ts`, `codegraph-activity.ts`)
  — per-turn action glyphs (read=circle, create=square, edit=diamond),
  agent-colored, solid on the touched file and outline propagated up its
  directories; hover shows agent/action/relative-time; resets per prompt.
  Graceful no-op when the experimental event system is off. Polish parked.
- **Live update model** (`codegraph.ts`) — recompute-on-display (TUI always
  fetches `refresh=true`), visibility-gated invalidation (only cached scopes
  whose window contains a changed file), shell-mutation catch-all refetch.
- **Wiring** — HTTP payload channel `GET /codegraph` + Lens cycle/delete
  endpoints; the `codegraph.invalidated` event (server → TUI); SDK gen; durable
  KV layout (structure caches, Lens store namespaced per Lens id). Payload is the
  stable contract — bump `PAYLOAD_VERSION` whenever the extractor's output shape
  changes (currently 5).

### Architecture: four separated concerns

```
[1] Structure extractor (deterministic) ──┐
                                          ├──> [3] View payload (cached, stable IDs)
[2] Facet painter (agent, async)        ──┘            │
                                                       ▼
                                   [4] TUI renderer (pluggable layout strategy)
```

The payload (#3) is the seam: the extractor and painter never know whether the
View is a top-bar or a sidebar, so layout placement is low-commitment and
reversible.

## Parked (not this sprint)

- **Plan-overlay** (old step 8) — dashed proposed-file blocks parsed from plan
  markdown. Superseded by **B3** (the task list references the Lens directly).
- **Agent-tracking polish** (old step 7) — multi-agent legend, sub-agent grouping
  under the spawner, richer reactive hover. Basic glyphs already landed.
- **Edges follow-ups** (old step 6) — per-child boundary tiles, incoming
  cross-window edges, routed in-window connector lines. Core edges done.
- **Full-screen zoom route** (old step 5) — detail route for a single
  node/subgraph.

Other non-blocking follow-ups kept on the back burner: durable provenance +
timeline (activity is in-memory today), deeper edge extraction (LSP-backed
call/type edges, path-alias resolution), and background-sweep re-walk cost
(skip-ahead cursor / wake-scoped re-walk on large mostly-painted repos).

## ⚠️ Catastrophic failure mode (learned the hard way)

Symptom: Aperture runs fine for a while, then RAM climbs without bound
(~30MB/s, seen via VmmemWSL) while completely idle — no prompting, no
navigation. The top bar never paints. CPU is busy.

Root cause: a slot renderer that reads a `createResource` accessor **directly in
the render/tracking scope**. In SolidJS, calling the accessor (`graph()`) while
the resource is in its **error** state *re-throws synchronously inside render*.
That trips the slot's error boundary (see @opentui/solid `Slot`, which
re-renders on a version signal and reports via `onPluginError`), which
re-renders, which re-reads, which throws again — a tight render → catch →
re-render loop. Every cycle allocates, so memory grows unbounded. Gating UI with
`<Show when={(graph()?.nodes.length ?? 0) > 0}>` is the same trap: the condition
calls the accessor.

Why it hid: the loop only runs when the resource is in error AND something keeps
re-rendering. A small/idle directory produces little store churn; the opencode
tree (LSP, watcher, snapshots) drives constant re-renders, so the same code there
leaks fast. **A bug that reproduces only in busy directories is the tell.**

Fix (in `feature-plugins/system/codegraph.tsx`): never call a resource accessor
unguarded in render. Check `resource.error` first and return a fallback *without*
calling the accessor; route every read through a helper that short-circuits on
error (`const nodes = () => graph.error ? [] : graph()?.nodes ?? []`, and
`hueOf`/`summary` likewise). Keep the bar frame always mounted (fixed height)
rather than gating it behind `<Show when={graph()...}>`.

How it was localized (use this for render/leak bugs): dewire the data path →
hardcode a static bar → add back the fetch + a count readout only → add back the
per-node `For` with guarded reads. Bisecting one variable at a time beats reading
code. Also isolate the instance-under-test (scratch dir / git worktree) so your
own edits don't confound the memory reading.

Two upstream contributors, both fixed: (1) the extractor used to walk `**/*` and
read every file (node_modules included) — now single-layer/scoped with caps; (2)
a stale durable cache from an old extractor was served because `PAYLOAD_VERSION`
wasn't bumped — bump the version whenever the payload shape or extractor
semantics change.

## Frozen reference — verified extension points

TUI stack: TypeScript + SolidJS + OpenTUI under
`packages/opencode/src/cli/cmd/tui/` (NOT Go/bubbletea). OpenTUI runs a 60fps
flexbox render loop; you mutate SolidJS signals, never write a draw loop.

UI extension surfaces: routes (full-screen), slots (named injection points),
dialogs (modals). opencode's own UI is built as internal "feature-plugins"
(`feature-plugins/`) using the same public `TuiPluginApi` a third party gets.

Mouse is first-class: `<box>`/`<text>` accept onMouseDown/Up/Over/Out/Move +
onClick. The View bar uses onMouseDown for drill-in/navigation; more examples at
`sidebar/files.tsx`, `routes/session/index.tsx`.

Aperture files (current names; renamed under Task 0):
- Server: `packages/opencode/src/codegraph/` — `payload.ts` (contract),
  `extract.ts` (deterministic walk, carries file mtime), `codegraph.ts` (service:
  cache + window math + events + painter drivers), `tagger.ts` (Facet paint),
  `semantic-store.ts`, `semantics.ts` (built-in layer hue vocabulary),
  `collections.ts` + `collection-store.ts` (Lens model + store),
  `deterministic.ts` (git/mtime built-in compute), `event.ts`
  (`codegraph.invalidated`), `dump.ts` (CLI verify).
- HTTP: `server/routes/instance/httpapi/groups/codegraph.ts` (+ `handlers/`,
  registered in `server.ts` and `api.ts`).
- TUI: `feature-plugins/system/codegraph.tsx` (+ `codegraph-activity.ts`);
  registered in `cli/cmd/tui/plugin/internal.ts`; slot placed in
  `routes/session/index.tsx`.
- Tests: `packages/opencode/test/codegraph/`.

Slots:
- Host slot map: `packages/plugin/src/tui.ts` (`TuiHostSlotMap` — `codegraph_top`).
- Slot placement / top-bar height + visibility math: `routes/session/index.tsx`.
- Sidebar slot template: `feature-plugins/sidebar/files.tsx`.
- Full-screen route template: `feature-plugins/system/diff-viewer.tsx`.

Events (server → TUI):
- `codegraph.invalidated`: defined in `codegraph/event.ts`; registered by
  importing that module from the route group (before `api.ts` snapshots the
  EventV2 registry into the SDK union). TUI subscribes via
  `api.event.on("codegraph.invalidated", …)`.
- File events feeding invalidation: `file.edited` (`packages/core/src/filesystem.ts`),
  `file.watcher.updated` (`packages/core/src/filesystem/watcher.ts`).
- `session.next.shell.ended` (experimental) — the shell-mutation refetch.

HTTP payload channel:
- `GET /codegraph?scope=&refresh=` → `CodeGraphPayload.Payload`. Middleware:
  InstanceContext + WorkspaceRouting + Authorization. Consumed via
  `api.client.codegraph.get(...)`. SDK types regenerate into
  `packages/sdk/js/src/v2/gen/`.

Persistence:
- Durable KV: `packages/opencode/src/storage/storage.ts` (string[] keys).
  Current keys: structure caches under `["codegraph", projectID, "structure",
  scopeKey]`; Lenses under `["codegraph", projectID, "collections"]`; active
  pointer under `["codegraph", projectID, "active-collection"]`; Facet results
  namespaced per Lens id. `storage.update` is atomic read-modify-write under a
  write lock. **Task 0 moves Lens persistence into the project directory.**
- Per-open-project in-memory state: the service's `caches` Map keyed by
  directory; cleaned via `registerDisposer` on instance disposal.

Provider / model (painter):
- `provider.defaultModel` → `getSmallModel(providerID)` → `getLanguage(small)`.
  Returns undefined when no small model is available; the painter then skips the
  pass. Provider/Config are provided to the Aperture layer (forked painter keeps
  R = never, mirroring `Agent.defaultLayer`).

Config:
- Schema: `packages/core/src/v1/config/config.ts` — `codegraph.tagger.context`
  ("minimal" | "medium") and `codegraph.tagger.concurrency`. JSONC supported.

Module/style conventions: see `AGENTS.md` (flat exports + self-reexport, Effect
v4 rules, snake_case Drizzle, run `bun typecheck` from package dirs).
