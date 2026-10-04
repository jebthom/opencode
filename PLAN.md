# Aperture — v3: deterministic facets, the combination grid, agent-curated Lenses

A persistent view of *where things are* in the repository. A **Lens** is a named set of up to six
**facets** (concerns); each facet marks the exact lines matched by deterministic **rules**. The
build/plan agent curates Lenses as it works, and the user can always check why a line is marked.

Sprint 1 (rename, workflows, VSCode gutter) is archived at
`docs/plan-archive/2026-08-10-sprint-1-rename-and-workflows.md`. Sprint 2 (Overview/Search Lenses,
the painter, the treemap top bar, the Activity Path) is archived at
`docs/plan-archive/2026-09-28-sprint-2-overview-and-search-lenses.md`. That document is still the
reference for the rule model (S0–S3), the colour contract (C1) and the Activity Path (G1–G4),
all of which carry forward unchanged.

---

## What the probe changed

Participants got little from the overview (the painter's extent-level partition shown as a
directory treemap). They leaned on deterministic marking instead: it is line-granular, it can be
verified by reading the query, and it is instant. The painter was used less because it painted
whole extents, its choices were hard to explain, and a pass took seconds.

So v3 removes inference from the view entirely:

| Kept | Removed |
| --- | --- |
| Rule model (`pattern`, `symbol`, `structural` stub), `lens_mark` / `lens_unmark` | The LLM painter, semantic/sub-facet stores, `painter.granularity` config, `debug aperture-cost` |
| VSCode gutter (now marks only) and the rebuilt Explorer TreeView with chips | Overview Lenses, drill-downs, built-in Lenses (architecture, git-changed, edit-recency, bus-factor) |
| Legend filter (O4), Activity Path (G) | The `lens` subagent and `/lens`; `lens_create`, `lens_merge_facets` |
| Colour contract (C1) | The treemap top bar, scope navigation, TreeView↔bar scope sync, Explorer pips |

## What was built

**Model (`aperture/lenses.ts`, `lens-store.ts`).** Every facet is rule-owned. `Facet.owner` and
`Lens.owner` are `"user" | "agent"`. Finders gained `diff` (lines changed against a ref — the
replacement for the git-changed built-in) and rules gained `where: { changed, author, since }`,
which narrows a finder's hits at line level (`git diff --unified=0` hunks; `git blame --porcelain`
per candidate file, after `changed` has narrowed them). v2 `lenses.json` is migrated on read:
painter fields and painter-owned facets are dropped, rule-owned concerns become the user's.

**Ownership.** An agent acting on its own initiative may change only agent-owned Lenses and facets.
Touching a user's returns `needs-consent`; the tool asks through the `lens_consent` permission
(default `ask` for every agent, so `"*": "allow"` cannot approve it) and retries. An agent that says
the user asked (`requestedByUser: true`) acts as the user.

**History (`aperture/lens-history.ts`).** An append-only `.opencode/aperture/lens-history.jsonl`,
written inside the lens-store mutex. Each entry carries `seq`, `op`, before/after snapshots, hit
counts at creation, and an actor with `sessionID`, `turnID` (the user message that opened the chat
turn — every assistant message's `parentID`), `messageID`, `callID` and `reason`. Served by
`GET /aperture/history?turnID=…` so a chat turn maps one-to-one onto the Lens changes it made.

**Reads.** `GET /aperture/facets` (every marked file: lines per facet + first marked line),
`GET /aperture/lines?path=` (one file's line tags, for the gutter), `GET /aperture/activity`.
The window payload, `POST /aperture/scope` and `aperture.scope.focused` are gone.

**Top bar (`cli/cmd/tui/feature-plugins/system/aperture.tsx`, `aperture/facet-grid.ts`).** A flat,
repo-wide grid: one group per exact combination of facets, most specific first (for a, b, c:
abc, ab, ac, bc, a, b, c). Within a group, files sharing a parent directory are boxed in one
containment border titled with the directory. Each tile is the filename over a band proportional
to its marked lines per facet; clicking opens the file at its first marked line. Suppressing a
facet in the legend removes it from every key, re-slicing the files by what remains.

**VSCode.** The gutter paints line tags only. Tree chips are sized by marked lines in the subtree,
and every facet present keeps at least one cell, so one marked line deep in the tree shows at the
root.

**Agent curation (`session/system.ts`, `session/prompt.ts`).** The `<aperture>` system block is
static (cache-stable) and tells build/plan to keep an agent-owned Lens for the task and curate it
at milestones, preferring marks that verify the change (`diff`, `changed:"HEAD"`), always with a
`reason`. The live state — Lenses, concerns, owners, the latest history — arrives once per user
turn as an `<aperture-state>` reminder on the turn's user message.

**Multi-part tasks (milestones).** A multi-part task keeps ONE agent Lens that evolves part by
part, rather than a Lens per part. The per-part trace for review is derived from history instead:
when `todowrite` marks a todo `completed`, a `milestone` entry snapshots the active Lens
(`after: { view }`). Nothing extra is asked of the agent. Curation cadence follows the agent's own
plan, and no monitor model is involved. The steps after a milestone get an `APERTURE MILESTONE`
reminder (`SystemPrompt.apertureNudge`) naming the completed todo, the files edited since the last
Lens change, and the next todo. With no todos, edits to 3 distinct files with no Lens change get a
one-off nudge instead. Nudges are spliced in mid-turn, are never persisted, and are re-spliced in
place so the prompt prefix stays stable. The end-of-turn check now also fires when a todo was
completed after the turn's last Lens change.

## Verification status

- Unit: `test/aperture` (lens-store ownership/migration/history, facet-grid grouping and packing,
  facet map, git rules against a real repository) and the extension's `test/model.test.ts` /
  `test/chip.test.ts`. Typecheck clean in `packages/opencode` and `sdks/aperture-vscode`.
- **Not yet verified live:** the grid's layout in a real terminal (border titles, column packing
  at 9 rows, horizontal scroll), the consent prompt's rendering, and an end-to-end build-agent
  task that curates a Lens across several turns.

## v3.1 milestones (triaged 2026-10-04)

**Reason** is a new per-facet field: one sentence on how the facet's query helps the user understand
the current task. It is separate from `Facet.description` (what the facet is), `Rule.note` (why a rule
exists) and `actor.reason` (why a call was made).

**Exact-colour invariant.** Colour is the point of the interface, so every surface renders a facet in
its exact palette hex, taken from the server's facet `color`. No surface keeps its own colour table,
and approximations such as emoji squares are not allowed. The palette uses xterm-256 values, so
256-colour terminals show them exactly.

**Deprecated for now:** all Lens-history UI. That covers a sidebar history list, preview-then-adopt
of a past Lens (with a diff of reasons, queries and groups), and milestone step-through. The data and
route stay; open decision #3 stays open.

| Milestone | Scope |
| --- | --- |
| **M1 Data foundation** — *done* | `Facet.reason`: lens_mark's `facetReason` sets it, and an agent must give one when it mints a concern (`needs-reason` otherwise). A user marking from the TUI is not asked. Passing it for an existing concern replaces it as a `facet.edit`, and lens_edit `facets[].facetReason` revises it. Every legend entry (`/aperture/facets`, `/aperture/lines`, activity) carries `reason` and `queries` (the facet's rules via `describeFinder`), and each line tag carries its rule's `query`. The SDK is regenerated. **Stable colours:** `assignColors` keeps a facet's stored colour and gives new facets the lowest free slot, so a removal no longer re-hues the survivors, and `lens_unmark` no longer reports a recolour. A palette switch keeps each facet's slot (`repaletteColors`). The `<aperture>` prompt asks for name, colour word and Reason in chat; M3 adds the colour token. `<aperture-state>` and the tool roster list each reason. |
| **M2 TUI surfaces** — *done* | **Top bar:** a fixed 2-row detail region (`DETAIL_ROWS`) sits under the legend, and the title row now always shows the summary. When idle it shows affordance hints. Hovering a legend entry or a single `■` in a group header shows `■ Full name  query: …` and `reason: …`. Each square stops its over-event from bubbling, so it overrides the header's combination detail. Hovering a header shows "N files marked by exactly A + B". Hovering a file shows its path, its per-facet lines and "click to open at line N". The session route's minimum height to show the bar is 18. **Sidebar:** proportional bands are replaced by a name plus containment squares. There is one fixed slot per legend facet, packed without gaps because the sidebar is 36 columns wide. Every row's squares start at the same column, and a row with no marks shows `□`. Facets filtered out of the legend drop out, as they do in the top bar's groups. Opening a file from the sidebar passes its first marked line. **Live-checked** in tmux: hovers over the legend, square, header and tile; exact hex (`38;2;175;95;0` for amber); slot alignment; a 90-column width. Open decision #6 (grid density) is still to tune. |
| **M3 Chat** — *done* | **Token:** the agent writes `■ facet-id` (or the label, optionally in backticks). The raw text reads as "square + name" in any client. The TUI paints the `■` in the facet's exact hex and bolds the name; unknown names are left alone. opentui's `renderNode` replaces only whole top-level blocks, so `aperture-tokens.ts` keeps the default rendering and hooks it: each CodeRenderable (paragraphs, headings, list items) gets an `onChunks` hook that runs after conceal, and table cells are tinted directly. `renderNode` is set only on messages that contain a `■`, because it turns off in-place block updates while streaming. **Colour source:** the active Lens's legend (`/aperture/facets`, refetched on `aperture.invalidated`, compared by value). A facet removed since falls back to the colour recorded in the session's lens tool metadata. **Tool rows:** lens_mark, lens_unmark and lens_edit put `concerns: {facet,label,color,reason}[]` in their metadata, and `LensTool` renders one row per concern as `■ Label · N lines in F files / removed / edited · reason`. Refusals fall back to `⚙ tool · title`. **Prompt:** the `<aperture>` block and lens_mark's output ask for `■ id` instead of a colour word. **Live-checked:** Haiku used the token unprompted. The tokens in prose, the tool rows and the legend all render `38;2;95;95;215` (#5F5FD7), and the prose token for a removed facet keeps its colour after a reload. Lists and tables are tinted too. |
| **M4 VSCode** — *done, live check pending* | **Exact colour:** `hover.ts` (VSCode-free and tested) renders the `■` as `<span style="color:#hex;">`. This is the only style form VSCode's sanitizer keeps, and only with `supportHtml`. **Line hover:** each marked line's decoration now spans the line's text, because VSCode raises a hover over text and never over the gutter icon. Its `hoverMessage` lists every facet on the line in legend order as `■ **Label** — reason`, followed by the queries of the rules that marked that line. The colour follows the filtered legend, so it matches the stripe. **Tree and Open Editors tooltips:** each facet's line count gets its `■`. **Reveal:** `revealFile` calls `revealRange(InCenterIfOutsideViewport)` after `showTextDocument`, so an editor that is already open scrolls too. `tui.directory.reveal` expands and selects the directory in the Aperture tree, though no TUI surface publishes it yet. **Not yet checked in a real VSCode** (no GUI here): that the sanitizer keeps the span colour in tree tooltips and in decoration hovers, and the scroll on an already-open editor. |
| **M5 Live end-to-end** | Consent prompt rendering. A multi-turn, multi-part build task (open decision #7) that checks the Reason and colour tokens appear in chat and that colours match across all surfaces. Settle open decisions #1, #2 and #4. |

Order: M1 comes first. After it, M2, M3 and M4 can be done in any order. M5 comes last. S1b (#5) is
still deferred.

## Open decisions

| # | Decision | Notes |
| --- | --- | --- |
| 1 | Whether the per-turn `<aperture-state>` reminder should also carry hit counts | Needs the Aperture service in `SystemPrompt`; today it carries rule counts only. |
| 2 | Whether an agent may add its own concern to a user's Lens without consent | Currently no: any change to a user-owned Lens asks. Revisit if it proves noisy. |
| 3 | History UI in the sidebar / explorer — **deprecated for v3.1** | Data and route exist (`/aperture/history`); no surface renders it yet. `milestone` entries carry a full Lens snapshot, so a "step through the task's parts" review view is a pure replay. |
| 7 | Milestone nudge tuning | The nudge threshold (3 files) and whether a nudge should also fire on `in_progress` transitions (to mark the *next* part up front) have not been checked in a live multi-part session. |
| 4 | `since` semantics | Uses `git blame --since` (commit-date boundary). Author date may be what users expect. |
| 5 | S1b — the ast-grep structural backend | Unchanged from sprint 2: stored, reported as unsupported. |
| 6 | Grid density | 22-column tiles, 9 grid rows; tune after the live check. |
