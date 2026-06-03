# Code-Graph Visualization for the opencode TUI

## Goal
A graph/dependency visualization that stays visible during planning, prompting,
execution, and review. Structure is deterministic (derived from directory tree +
syntax, with stable IDs and cached layout) so it doesn't reflow distractingly.
Semantics are malleable and async — an agent attaches tags/hues (architectural
layer, language, "critical logic", etc.) over time. First idiom: graph/dependency
view, rendered initially as a wide top-bar above the chat.

## Architecture: four separated concerns

    [1] Structure extractor (deterministic) ──┐
                                              ├──> [3] Graph payload (cached, stable IDs)
    [2] Semantic tagger (agent, async)      ──┘            │
                                                           ▼
                                       [4] TUI renderer (pluggable layout strategy)

The payload (#3) is the seam. The producer and extractor never know whether the
graph is rendered as a top-bar or a sidebar, so layout placement is low-commitment
and reversible.

### 1. Structure extractor — deterministic, server-side
- Build graph from directory tree + lightweight syntactic info (imports/requires →
  edges; files/dirs → nodes). Stable, content-independent node IDs (hash of
  repo-relative path).
- Cache computed layout durably via Storage.Service, keyed
  [ctx.project.id, "codegraph", ...] so structure persists across runs.
- Recompute incrementally on file.watcher.updated / file.edited.

### 2. Semantic tagger — agent-driven, async, two paths
- Batch review: an agent/skill/subagent walks the codebase and writes tags/hues
  into graph metadata, stored per node ID so semantics update without disturbing
  structure.
- Incremental on edit: inject system-prompt guidance so the dev agent tags files
  it creates/edits. Prefer config-only first (AGENTS.md or config.instructions);
  escalate to the experimental.chat.system.transform hook if needed.
- The agent emits a tag payload via a plugin tool; it rides
  session.next.tool.success.structured over SSE to the TUI. Alternatively hook
  tool.execute.after filtered to edit/write to detect changed files and queue them.

### 3. Graph payload — the stable contract

    { version,
      nodes: [{ id, path, kind, size, layer, position }],
      edges: [{ from, to, kind }],
      semantics: { [nodeId]: { tags: string[], hue: string } } }

- position/layer computed deterministically by the extractor.
- hue maps to the theme palette at render time (api.theme.current), respecting the
  active theme.
- semantics is separate from nodes so tags update asynchronously without touching
  structure.

### 4. TUI renderer — plugin + a new core slot (fork)
- Add codegraph_top: {} to TuiHostSlotMap; place
  <TuiPluginRuntime.Slot name="codegraph_top" .../> above chat content in
  routes/session/index.tsx; reserve height via the content-height math.
- Renderer plugin fills the slot, reads payload via api.state / api.event.on(...),
  draws nodes/edges with box-drawing chars in absolutely-positioned <box> children.
- Pluggable layout strategy from day one: layout(payload, { width, height,
  orientation }) with horizontal (top-bar) now and vertical (sidebar) stub. Moving
  to a sidebar later = swap the <Slot/> location + select the vertical strategy;
  payload/extractor/tagger untouched.

## Build order
1. Payload schema + structure extractor + Storage caching (no UI; verify via dump).
2. New codegraph_top slot in core + renderer plugin (horizontal layout, structure
   only, single hue).
3. Incremental recompute on file events.
4. Semantic layer: batch tagger + per-edit tagging instruction (config-first),
   tags→hues mapping.
5. Optional: full-screen "zoom" route for detail.

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

Fix (now in feature-plugins/system/codegraph.tsx): never call a resource
accessor unguarded in render. Check `resource.error` first and return a fallback
*without* calling the accessor; route every read through a helper that
short-circuits on error (e.g. `const nodes = () => graph.error ? [] :
graph()?.nodes ?? []`). Keep the bar frame always mounted (fixed height) rather
than gating it behind `<Show when={graph()...}>`.

How it was localized (use this method for render/leak bugs): dewire the data
path entirely → hardcode a static bar (stable + visible confirms slot/layout is
sound) → add back the fetch + a count readout only (stable confirms fetch/
resource is sound) → add back the per-node `For` rendering with guarded reads
(stable = done). Bisecting one variable at a time beats reading code. Also
isolate the instance-under-test (run against a scratch dir or a git worktree) so
your own edits to the watched tree don't confound the memory reading.

Two upstream contributors that made errors more likely, both fixed: (1) the
extractor used to walk `**/*` and read every file (node_modules included),
exhausting memory during compute — now single-layer with caps; (2) a stale
durable cache from the old extractor was served because `PAYLOAD_VERSION` wasn't
bumped — bump the version (or clear storage/codegraph) whenever the payload
shape or extractor semantics change.

## Open follow-ups (not blockers)
- Edge extraction depth: import/require parsing first, or LSP-backed call/type
  edges later (api.state.lsp()).
- Tag vocabulary: fixed enum (predictable hues) vs free-form (needs hue policy).
- Worktree/subsession behavior: hide the bar for child sessions like the sidebar?

## Frozen reference — verified extension points

TUI stack: TypeScript + SolidJS + OpenTUI under
packages/opencode/src/cli/cmd/tui/ (NOT Go/bubbletea). OpenTUI runs a 60fps
flexbox render loop; you mutate SolidJS signals, never write a draw loop.

UI extension surfaces: routes (full-screen), slots (named injection points),
dialogs (modals). opencode's own UI is built as internal "feature-plugins"
(feature-plugins/) using the same public TuiPluginApi a third party gets.

Slots:
- Host slot map: packages/plugin/src/tui.ts:455 (TuiHostSlotMap)
- Slot placement in session view: routes/session/index.tsx ~:1285; layout/size
  math at routes/session/index.tsx:238-245
- Sidebar slot template: feature-plugins/sidebar/files.tsx:54
- Full-screen route template: feature-plugins/system/diff-viewer.tsx:934
- Sidebar container (fixed 42 cols, auto-hides narrow/subsession):
  routes/session/sidebar.tsx:29, routes/session/index.tsx:238-243

Structured data channel (agent → TUI):
- Schema: packages/core/src/tool-output.ts:18 (Structured = Record<String, Any>)
- Producer: packages/opencode/src/session/processor.ts:480 (publishes
  session.next.tool.success with structured)
- Consumer (TUI store): cli/cmd/tui/context/sync-v2.tsx:191
- Read on a part: part.state.structured

File events:
- file.edited: packages/core/src/filesystem.ts:80
- file.watcher.updated: packages/core/src/filesystem/watcher.ts:24
- Tool publishes: packages/opencode/src/tool/write.ts:68,
  packages/opencode/src/tool/edit.ts:111 and :155
- Real watcher publishes: packages/core/src/filesystem/watcher.ts:94

System-prompt injection:
- Assembly: packages/opencode/src/session/prompt.ts:1438-1446 then
  packages/opencode/src/session/llm/request.ts:56-78
- Hook experimental.chat.system.transform: invoked at
  session/llm/request.ts:69; type at packages/plugin/src/index.ts:291
  (mutable { system: string[] })
- Message-transform hook: prompt.ts:1436; type plugin/src/index.ts:282
- Config-based instructions (auto-loaded): AGENTS.md/CLAUDE.md at
  session/instruction.ts:62-66; config.instructions globbed/loaded at
  session/instruction.ts:133-167

Tool hooks:
- tool.execute.before/after wrapping: packages/opencode/src/session/tools.ts:90
  and :105; type packages/plugin/src/index.ts:274 (filter input.tool ===
  "edit"|"write")

Persistence:
- Durable KV: packages/opencode/src/storage/storage.ts:55 (read/write/update/
  remove/list, string[] keys); files under Global.Path.data/storage
  (storage.ts:226, global.ts:20). Key by ctx.project.id for per-project stability.
- Per-open-project in-memory state: InstanceState
  (packages/opencode/src/effect/instance-state.ts), per-directory ScopedCache,
  cleaned on disposal.

Config & loading:
- Config schema: packages/core/src/config.ts (instructions :88, skills :85,
  references :91, plugins). JSONC supported.
- Plugin tool contract: packages/plugin/src/tool.ts; registration
  packages/opencode/src/tool/registry.ts:140-219 (plugin tools + filesystem
  auto-discovery of tool/ or tools/ dirs).
- TUI plugin API: packages/plugin/src/tui.ts:581 (TuiPluginApi); TUI plugin
  runtime/loader: cli/cmd/tui/plugin/runtime.ts, internal list
  cli/cmd/tui/plugin/internal.ts.

Module/style conventions: see AGENTS.md (flat exports + self-reexport, Effect v4
rules, snake_case Drizzle, run bun typecheck from package dirs).
