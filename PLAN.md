# Aperture — Sprint 2 (post-study revision)

A persistent, fast, high-altitude **View** of the repository that an agent paints
with user-defined **Lenses** (each a set of **Facets**). Structure is
deterministic (directory tree + syntax, stable ids, cached layout) so it never
reflows distractingly; semantics are malleable and async.

Sprint 1 (rename to Aperture, Sensemaking + Building workflows, sub-file
resolution, VSCode gutter) is complete and archived at
`docs/plan-archive/2026-08-10-sprint-1-rename-and-workflows.md`. That document
remains the reference for what exists and why.

This plan comes out of a round of formative studies. It is deliberately written
before all details are settled: its job is to **order the work and split it up**,
and to record which decisions are still open so they get made deliberately rather
than by accident during implementation.

---

## What the studies changed

Three findings reshape the design:

1. **The top bar is trying to be a file browser and shouldn't be.** We're plugged
   into VSCode; recreating a folder tree in the terminal duplicates a better tool.
   What *was* valuable was the **aggregation** — seeing a directory's facet
   make-up at a glance. Keep the aggregation, drop the file list, push file-level
   viewing into the editor.
2. **A Lens is being used for two different jobs.** Some Lenses **partition** the
   codebase (every file gets one of N facets — an overview). Others are
   **binary/ternary probes** aimed at a single concern, used to scope a piece of
   work. These want different painting granularity, different interactions, and
   arguably different cost models. We now name them separately.
3. **Colour identity is not surviving the terminal.** Participants on Mac and
   Linux saw hues collapse toward each other. Real, and it needs fixing before
   the final experiment — but it's a rendering-fidelity bug, not a design
   question, and it blocks nothing else. Deferred to the end of the sprint
   (Track C) so the design work gets the thinking time.

## Vocabulary added this sprint

| Term | Meaning |
| --- | --- |
| **Overview Lens** | The existing Lens: partitions the codebase, ~4–6 facets, whole-repo paint, aggregated in the top bar. |
| **Search Lens** | A narrow binary/ternary Lens probing one concern. Painted at **line level**, populated opportunistically by Explore/Build agents rather than by a sweep. |
| **Line tag** | A syntax-anchored line-or-range facet assignment, the Search Lens's unit of data. |
| **Activity View** | A block/waffle rendering of an agent's read/edit/write actions, coloured by the active Lens. |

---

## Tracks

Four tracks. **O** (Overview Lens) is refinement of shipped surfaces. **S**
(Search Lens) is the largest new build and holds the hardest design question.
**G** (Activity View) is additive and the most experiment-shaped. **C** (colour)
is self-contained repair work, parked until the design tracks are through.

```
O3 ✅ (always-extent) ┬──► O1 ✅ (top bar simplify)
                      ├──► O2 ✅ (VSCode file-browser pips)
                      └──► S1 …
O4 (legend filter) ──────────────────────────────► shared with S4
                     └──► also drives O2's `focus` (Explorer pips)

S1 (line-tag store) ──► S2 (agent tool) ──► S3 (line painting) ──► S5 (open-all)

G1 (activity data) ──► G2 (block render) ──► G3 (placement/timeline)

                                         C1 (colour fidelity) ──► deferred, independent
```

---

## Track O — Overview Lens improvements

The existing Lens, refined. All four are changes to shipped surfaces.

### O3 — Extent-level painting by default *(do first in this track)*

Sequenced first because it unifies the data model that O1 and O2 both read, and
because it fixes a live bug.

**Motivation.** Participants found it confusing when a file's colour changed —
which happened because file-level facets and drill-in extent-level facets are
two separate stores that can disagree (`semantic-store.ts` vs
`subfacet-store.ts`). Painting extents always makes the file's colour a true
aggregation of its parts, so it changes only when its contents change.

**Work:** move extent painting off the drill-in gate; make a file's file-level
facet **derived** from its extent mix rather than independently painted; retire
or demote the conflicting file-level path.

**The cost question was the crux.** Whole-repo function-level tagging measured at
roughly **5.8× the cost and 2× the wall time** of file-level (output-dominated
and structural, so it won't shrink much with prompt tuning). Always-on across a
large repo therefore looked unaffordable.

**Resolved — always-on, with *granularity* as the cost dial rather than
*coverage*.** ✅ Implemented.

Every file is extent-painted, always. A cold file is cut into exactly **one
whole-file extent**, which is the old file-level paint — same `describeFile`
prompt, same 30-file bins, same price — re-homed into the extent store.
Interesting files are re-cut **per top-level declaration**. So the cost floor
equals what we already paid, and the 5.8× applies only to promoted files.

The file/extent dichotomy disappears because there is only ever one
classification of a file; the question is only how finely it was cut.

- `paintStale` and `paintExtentsStale` **merged into one painter** whose unit of
  work is an extent. File-level painting as an independent classification is
  retired.
- The **semantic store is now a derived projection** of the extent mix, written
  only by that painter via `attributeFileBytes(...).dominant` — the very function
  directory composition uses, so a file's tile and its band in the parent's
  treemap cannot disagree. It is kept (not deleted) because `resolveDomain`
  reads the *parent* Lens's store to compute a drill-down's domain, boundary
  tiles need facets for out-of-window files, and bus-factor persists there.
- **Promotion is monotone and inferred, not stored**: a mix with more than one
  extent *is* the "already fine" flag (`subtreeCount > 1`), and a file is never
  coarsened back. `extentsOf` collapses a declaration cut of fewer than two
  extents to the whole-file name, so the two granularities coincide exactly and
  promotion never repaints a span under a different name.
- Interest set: in-window files, edited files, the git working set, and open
  editor tabs (the extension already drills those). Dial:
  `aperture.painter.granularity` = `"file"` | `"interest"` (default) |
  `"declaration"`.
- Scheduling batches: one drainer fiber per directory over a pending set, with
  the single paint permit acting as the debounce (no timer). Ten warmed editor
  tabs become one pass.

*Rejected:* a middle "declaration group" tier (merge adjacent declarations to a
byte budget). Group names are not edit-stable — an edit mid-file shifts every
boundary below it and changes the downstream sub-node ids, forcing repaints that
per-declaration granularity would not. If the working set proves too expensive,
drop it from the interest set rather than adding an unstable tier.

**Done when:** a file's colour is a stable function of its content ✅; the
file/extent conflict is unreproducible ✅; the cost of the chosen policy on this
repo is measured and recorded — `opencode debug aperture-cost` breaks painter
spend down by lens / trigger / coarse-vs-fine blocks; **the measurement run at
each dial setting is still outstanding.**

### O1 — Simplify the top bar: drop files, keep aggregation ✅

Remove the file-level tier from the top bar and focus it on the
**waffle/treemap directory** representation — the aggregation participants
actually valued. File-level viewing moves into VSCode (O2 + existing gutter).
**Implemented.**

**Resolved — the *child list* goes, and files return as a packed grid.** The
reduction went further than "drop the file tiles": the per-directory child list
came out entirely, so the bar is one row of directory blocks plus a grid of the
scope's own files. Multi-level visibility is lost except through aggregation,
which is the trade that buys the simplicity and the height. `aperture.tsx` went
from ~1750 to ~1200 lines.

- **Deleted:** `ChildDirTile`, the child-list scroll window (`childOffset` /
  `COLUMN_CHILD_WINDOW` / the `↑ +N` markers), and the whole drill cluster —
  `drilledFile`, `toggleDrill`, `extentsForId`, `fileExtentColors`,
  `bandForFile`, `fileBg`/`fileFg`. The TUI no longer sends `drill=`, so it no
  longer schedules a drill-in paint; the extension already drills every
  visible/open editor, so nothing is lost. (`FileTile`/`NameRow` were deleted and
  then reinstated in simpler form for the grid — see below.)

- **Server: `composition` widened from per-directory to per-node.** A file tile's
  band needs the file's own facet mix, which nothing shipped: `computeComposition`
  filtered to `kind === "directory"`. It now also emits an entry per in-window
  *file* node — a subtree of one — from the **same `attributeFileBytes` call** the
  directory bands are built from, so a file's tile, its slice of its parent's
  treemap and its Explorer pip are three renderings of one attribution. Bounded by
  the window (tens of nodes), not the repo, which is why this is affordable inline
  where `/aperture/facets` needs a bulk endpoint to say the same thing repo-wide.
  Composition is derived at the read boundary, not cached in the structure, so
  **no `PAYLOAD_VERSION` bump**. Covered by four new cases in
  `test/aperture/facet-map.test.ts`, including that file entries survive a window
  with no directories — the leaf case they exist for, and the one an early
  `if (dirs.length === 0) return {}` would have silently eaten.
- **Also deleted: the `grid` layout.** It was reachable only via
  `OPENCODE_APERTURE_LAYOUT=grid` and doubled the surface of every edit. With it
  went the boundary-tile strip, the `OVERFLOW` expander and the `expanded` state
  — so the parked "Edges follow-ups" item shrinks: `edges`/`boundaries` now feed
  only the hover adjacency tint, a candidate for a later trim.
- **Files come back as a packed grid, not an aggregate.** The first cut collapsed
  a scope's own files into one synthetic composition block. That was wrong twice
  over: it averaged away per-file granularity, and it left *no* surface anywhere
  showing a file's minority facets — the VSCode Explorer pip is structurally
  dominant-only (a `FileDecoration` carries one colour), so a facet could appear
  in the aggregate and be invisible in both the tile and the editor.

  Instead the scope's files are drawn as **one-line tiles in a packed grid**:
  filename in dark text over a band of that file's *own facet mix*, sorted
  alphabetically and filled column-major, `FILE_GRID_ROWS` (= 3) tall so the grid
  is exactly as tall as a directory block. This is the finest-grained facet
  reading in the product — finer than the directory treemap, which averages the
  file into its parent, and finer than the Explorer pip. It also restores
  **click-to-open** (`tui.file.open`), which the aggregate had lost.

  The old file tier's problem was never the tiles; it was laying them in a single
  row to preserve payload ordering, which wasted most of the strip's height.
  Grouping the files is what buys the wrapping — once they aren't interleaved
  with directories, payload order means nothing and alphabetical is what makes a
  name findable.

  Measured on `packages/opencode/src/aperture` (0 child directories, 16 files):
  **9 of 16 are multi-facet**, and `painter.ts` carries four — `external-i-o`
  34%, `data-processing` 22%, `database-persistence` 5%, unrelated 39%. Its
  Explorer pip shows only the last of those.

  A flat directory of 200 files scrolls a long way, and that is left uncapped on
  purpose: grouping the files at the end preserves directory navigation whatever
  the count, alphabetical order makes a specific name findable, and colour makes
  visual search work — which is more than the Explorer offers for the same
  directory. Hiding files behind a "+N more" would give all three up.

- **Block size now follows painted area, and only painted area.** Width used to be
  scaled *separately* from cell count, with a "fewer than `COLUMN_FEW_THRESHOLD`
  items ⇒ draw every block at max width" rule on top. Between them a small
  directory got a big empty box — most visibly at `packages/opencode/test/cli`,
  where all seven children rendered full-size regardless of their real sizes.

  Now one number, `blockCells`, decides everything: cells come from
  `sqrt(subtree / biggest-sibling)` on an absolute `BLOCK_CELL_CAP` budget
  (floored at the band count so every present facet keeps a cell), and the width
  is `ceil(cells / COLUMN_ROWS)` — which is exactly what `buildGrid` draws. A box
  can no longer be wider than its contents. `COLUMN_COLS_MIN` 3 → 2 and
  `SCROLL_GAP` 2 → 0, so blocks pack at the same density as the file tiles; block
  labels are trimmed one column short so neighbouring names can't collide.

  | scope | strip width before → after |
  | --- | --- |
  | `packages/opencode/test/cli` | 112 → 60 cols |
  | `packages/opencode/src` | 396 → 248 cols |
  | repo root | 76 → 50 cols |
- **Height: `TOP_BAR_HEIGHT` 20 → 14**, now derived (`4 + (1 + 2 + COLUMN_ROWS) +
  1`) rather than a magic number. `routes/session/index.tsx`'s short-terminal gate
  moved 20 → 16 with it — on a 20-row terminal the old bar was 100% of the screen.

**Coupled requirement — done, in the directory idiom.** New `tui.directory.reveal`
event (`cli/cmd/tui/event.ts` → `groups/tui.ts` → `handlers/tui.ts` → SSE →
extension) carrying a repo-relative path, `""` = workspace root. Published from an
HTTP handler, so `EventV2Bridge` stamps `location` automatically and it clears the
`/event` SSE filter.

**Opening a directory means revealing a child of it, not the directory.** This is
the one genuinely non-obvious part of O1 and it cost two wrong attempts, so the
mechanism is worth recording. `revealInExplorer` takes any in-workspace URI with
**no file/folder discrimination** (verified in VSCode's current `fileCommands.ts`;
the old folder regression microsoft/vscode#160504 is closed) — but it leaves the
target folder **collapsed**, so clicking `src/` rooted the TUI inside src while the
Explorer still showed it shut.

The reason is in `ExplorerView.selectResource`, which walks *down* from the root:

```ts
while (item && item.resource.toString() !== resource.toString()) {
  await this.tree.expand(item)
```

It expands each ancestor and stops the moment it reaches the target, so the target
itself is never expanded. Revealing something *inside* `src` makes `src` an
ancestor, and the same loop opens it. So `revealDirectory` reveals
`firstVisibleChild(dir)` and then re-reveals `dir` to put the highlight back where
the TUI is rooted (revealing a folder never collapses it, so the sequence is
idempotent).

*Rejected:* `list.expand`, which looks like the obvious fix. It acts on the list
service's last-focused list, and on an already-open folder it walks focus onto the
first child rather than doing nothing — and in practice it did not expand at all.
There is no API to query expansion state (microsoft/vscode#327242).

*Caveat:* `firstVisibleChild` honours `files.exclude` (literal `**/`-prefixed names
only) but not `explorer.excludeGitIgnore`. Picking a hidden entry makes the reveal
a no-op, degrading to the old collapsed behaviour rather than misbehaving.

*Deliberate choices:* only **directory blocks** reveal — breadcrumbs, ⌂ and ◀
re-root the TUI without disturbing the editor, so backtracking doesn't yank the
Explorer around. The loose-files block reveals the current scope and does *not*
navigate (there is nothing to navigate into), which is what keeps the editor link
alive at leaves. `revealInExplorer` also **focuses** the Explorer, moving the
cursor out of the terminal; that is accepted rather than worked around, since
clicking a directory is a request to go look at it.

*Study-log note:* `tile.drill` / `tile.undrill` are gone and `drill` no longer
rides every interaction; `dir.reveal` is new. Interaction data changes shape here.

**Kept for S5:** `tui.file.open` and the extension's `revealFile` — the TUI is no
longer its publisher, but S5 is specified to consume it extended with a line.

**Still open (now with something to iterate on):** taller `COLUMN_ROWS`,
facet-major layout, more directory depth.

### O2 — Paint the VSCode file browser ✅

Add a pip/glyph in the VSCode Explorer showing each file's facet, so visual
search works in the file tree — this is what the top bar's file tier was
partly doing, relocated to where files belong. **Implemented.**

**Mechanism:** `vscode.FileDecorationProvider` in `sdks/aperture-vscode`, which
gives one `ThemeColor` and a ≤2-char badge *rendered in that same colour* per
URI. That budget — one colour, one glyph — is the whole design constraint: a
multi-colour pip row is not available in the API.

**Resolved — the ThemeColor constraint does NOT limit facet distinguishability.**
The original worry (arbitrary hex unavailable ⇒ few distinguishable facets) turned
out to be false, because Aperture's colour universe is *closed*: `assignColors`
(`lenses.ts`) is the only path that ever colours a facet and always takes
`PALETTES[palette].colors[i]`. That is 38 distinct hexes across all 7 palettes plus
the built-ins' hardcoded ramps, so we contribute **one colour id per exact hex**
(`#4E79A7` → `aperture.c4E79A7`), generated from `lenses.ts` by
`sdks/aperture-vscode/script/gen-colors.ts`. The pip is therefore the Lens's
*actual* legend hue for every Lens and every palette, not an approximation.
Theme-role tokens (the architecture Lens, `NONE_HUE`/`UNTAGGED_HUE`) still fall
through `THEME_ROLE_COLORS`. **C1 accordingly inherits the TUI's palettes verbatim
— there is no second, differently-limited Explorer palette to account for.** The
one cost: a contributed colour is a fixed hex, not theme-adaptive, so a `dark`
Lens reads low-contrast on a light editor theme (the tradeoff the TUI already has).

**Multi-facet encoding — colour says *which*, glyph says *how much*.** Since O3
every file is extent-painted, so files routinely span several facets. Colour = the
focused facet; badge = a shade glyph for its byte share (`█` ≥85% · `▓` 60–85% ·
`▒` 35–60% · `░` <35%); tooltip = the full breakdown. A pure file reads as a solid
pip, a grab-bag file as a faint one, at identical width.

**The `focus` parameter is the seam O4/S4 plug into.** The server ships each file's
*whole* mix, never a pre-reduced dominant, and the client-side reduction is a pure
function of (mix, focus facet). No focus ⇒ the plurality facet, which equals
`attributeFileBytes(...).dominant` so the pip and the TUI tile cannot disagree. A
focus set ⇒ that facet's share, and files without it lose their decoration
entirely. So legend filtering only ever changes what `focus` is — it never touches
this encoding. Set today by an `aperture.focusFacet` QuickPick; O4/S4 should drive
it from the TUI's legend filter over SSE instead.

**Server work:** `Aperture.facetMap` + `GET /aperture/facets` — whole-repo
`{path: [{f, p}]}` (facet index, percent) plus the legend. ~150KB for 2265 files.
Attribution runs through the same `attributeFileBytes` the directory treemap uses.
Extracted `facetStoreFor` for the lens→store branch (including bus-factor's
read-don't-compute trap) now shared by `finalize` / `facetFiles` / `facetMap`, and
`computeFacetMapFiles` as a pure exported function so the reduction is tested
against `computeComposition` in `test/aperture/facet-map.test.ts`.

**Flicker trap, found only by running it.** Firing `onDidChangeFileDecorations`
with `undefined` means "every decoration changed" — VSCode drops its whole cache
and re-queries every visible row, which paints the tree bare for the round trip.
Combined with an unconditional poll that was a full-tree flicker on a timer. Fixes:
compare the raw response body and bail before firing (the server's output is
byte-stable for an unchanged repo, verified), fire a **URI list** for partial
changes and reserve `undefined` for a genuine re-colouring, and give the map its
own slower poll (20s) since repaints arrive pushed over SSE.

**Done when:** opening a repo with an active Lens shows facet pips throughout
the Explorer, updating within a couple of seconds of a repaint. ✅ — verified live
against this repo (2265 painted files, 149 multi-facet), and the pips coexist with
git's own `M`/`U` badges rather than being suppressed by them.

### O4 — Filter facets by clicking the legend

Clicking a legend entry toggles that facet **off** — off-state renders as a
neutral grey/dark-brown rather than disappearing, so structure is preserved and
the remaining facets pop. Supports visual search ("show me only the parsing
code").

Client-side only: a set of suppressed facet ids in the renderer, applied at the
hue-resolution boundary (`hueOf` and the composition/treemap weights). No
server, no repaint. Multi-select, with a clear "reset" affordance.

Shared with Search Lenses (**S4** is the same code path, less useful there) —
build once, in `aperture.tsx`.

**Also feeds the Explorer.** O2's pips already take a `focus` facet and already
render "not this facet" as no decoration; the suppressed-facet set built here
should be pushed to the extension (over SSE, alongside `aperture.invalidated`)
rather than left to O2's stopgap QuickPick, so filtering the top bar filters the
file tree in the same gesture.

**Open:** whether off-facets keep their area in the treemap (preserves layout
stability, which is a core Aperture value) or collapse (maximises contrast for
what remains). Default to preserving area; layout stability is the thing we've
consistently protected.

---

## Track S — Search Lenses (new)

The largest new build. A Search Lens is a narrow binary/ternary probe used to
scope a piece of work — participants created these spontaneously and wanted them
at **line level**, which the VSCode gutter appears to promise.

**The key insight that makes this affordable:** we do not sweep. Line-level
painting across a whole codebase would be slow and expensive, but we already run
Explore and Build agents that read the code as part of their normal work. Give
them a **deterministic tool** to tag specific lines in specific files as they go,
and the Search Lens fills in as a by-product of work that was happening anyway.

Note the difference in kind from an Overview Lens: participants are often hunting
**specific usages**, which may not sit inside a named extent at all. Line tags
are therefore not a finer grade of extents — they're a separate, sparser layer,
with the compensating benefit of binding directly to syntax.

### S1 — Line-tag data model with syntax anchoring *(the hard part)*

A line tag must **survive edits elsewhere in the file**. A raw line number is
worthless the moment anything above it changes.

Anchor candidates, to be evaluated:
- **Enclosing symbol + offset within it** — reuses `extents.ts` (already
  computes named, line-delimited extents and stable `subNodeID(relPath, name)`
  hashes) and degrades gracefully: if the symbol survives, the tag survives.
  Weak for top-level/config code with no enclosing symbol.
- **Content hash of the tagged line(s)** + a search window — robust to movement,
  breaks on edit of the line itself, ambiguous when the line text recurs.
- **Tree-sitter node path** — most principled, and OpenTUI already bundles
  tree-sitter (`TreeSitterClient`), but ties us to per-language grammars.
- **Composite:** symbol + line-content hash + line number as a tiebreak, with a
  documented resolution order and an explicit "lost" state.

Recommendation: composite, since each anchor fails in a different direction and
the resolver can fall through. Make "lost" a first-class outcome — a stale tag
that silently paints the wrong line is worse than one that reports itself gone.

**Store:** new `line-tag-store.ts`, per-project, per-Lens, alongside
`subfacet-store.ts`. Unlike the sweep results these are **expensive to
regenerate** (they encode an agent's reasoning, not a re-runnable classification)
— so persist them in the **project directory** with the Lens defs, not global KV.
That also makes a Search Lens shareable and committable, which is the natural
extension of the sprint-1 decision to project-scope Lenses.

**Payload:** new optional `lineTags` keyed by file node id, derived at the read
boundary like `extents`/`composition`. Bump `PAYLOAD_VERSION` to 8.

**Open:** whether a Search Lens is a distinct type on the Lens model or an
Overview Lens with a flag. Leaning distinct type — different paint policy,
different interactions, different persistence, and the picker should group them
separately.

### S2 — Deterministic tagging tool for Explore/Build agents

New tool `lens_tag_lines` (mirroring `tool/lens-facet-files.ts` conventions,
registered in `tool/registry.ts`): takes a file path, a line or range, a facet id
from the active Search Lens, and an optional note. Deterministic — no model call,
it just resolves the anchor and writes the store.

**Prompt work:** the Aperture-awareness block in `session/system.ts` must teach
agents *when* to call it. The goal is that answering "where do we handle X?"
leaves a persistent, paintable Search Lens behind. Applies to Explore as well as
build/plan, which is a widening of the current injection (Aperture awareness is
currently injected for `build`/`plan` only).

**Also needed:** creating a Search Lens should be as light as creating an
Overview Lens — a binary probe shouldn't require the full Lens-design flow.

### S3 — Line-level painting in the editor and the View

Extend `sdks/aperture-vscode` to paint line tags as gutter strips. The decoration
machinery is already there (`decorationFor`, per-hue reused decoration types) —
the change is fetching `lineTags` alongside `extents`, and painting a
Search Lens's sparse tags rather than an Overview Lens's exhaustive extents.
Anchors resolve **in the extension** against live buffer content, which is the
edit-robust choice already established for extents.

In the TUI, a Search Lens's file/directory blocks show hit density rather than a
partition — the visual question is "where are the hits", not "what is this made
of".

### S4 — Legend filtering for Search Lenses

Falls out of **O4**. Less useful on a binary Lens; no extra work expected beyond
confirming it behaves on 2–3 facet Lenses.

### S5 — Open all files carrying a facet

Participants wanted richer interaction with a Lens: from the legend, open every
file with a given facet. Cap at **8–10 files** with a clear indication when the
set was truncated (and, ideally, an ordering rule better than alphabetical —
most tags, or most recently tagged).

Each file should open **scrolled to its first tagged line**, which is the payoff
for S1's anchoring. Mechanism: extend the existing `tui.file.open` event
(TUI → server → extension) with an optional line, and have the extension reveal
that range.

The file set comes from `lens_facet_files` / the bulk endpoint added in O2.

---

## Track G — Activity View (agent activity as blocks)

Bind agent activity to the same block/lens vocabulary as the rest of Aperture,
so a user can see **at a glance whether the agent visited the concerns they
expected**. Today's activity display is per-turn glyphs on the file tree
(`activity.ts`, `aperture-activity.ts`) — informative but not readable as a
shape.

### G1 — Activity data model

Per-turn, per-agent read/edit/write actions with the facet of each touched file
under the **currently active Lens** — so switching Lens recolours history
without re-recording it. Activity is in-memory today; this needs at least
per-session durability to be readable as a timeline.

### G2 — Block rendering

A treemap/waffle of the turn's actions, coloured by active-Lens facet.

**Reads are less important than edits and writes.** Reads aggregate into one
block, optionally expandable to per-file; edits and writes are always expanded.
This is the core information-density decision and should survive contact with
the experiment.

### G3 — Placement and timeline orientation

Either the right sidebar (vertical timeline, turns building downward) or the top
bar (horizontal). **Replacing the overview is possible but likely confusing** —
the two answer different questions, and a user mid-task wants both.

Structure: each turn builds along the timeline axis; within a turn, read / edit /
write (and sub-agent r/e/w) build orthogonally.

The sidebar is the safer default — it doesn't contend with the Overview Lens for
the top bar, and vertical suits an append-only log. But this is explicitly for
experiment; build the block renderer (G2) so it is orientation-agnostic and try
both.

Slot template: `feature-plugins/sidebar/files.tsx`. A new host slot may be
needed in `packages/plugin/src/tui.ts` (only `aperture_top` exists today).

---

## Track C — Colour fidelity (deferred)

Parked until the design tracks are through — it blocks nothing and is repair
work, not a design question. It does need to land **before the final
experiment**, since the hue encoding is the whole visual contract. Good work for
a day when the open decisions above need thinking time rather than typing.

Most of the diagnosis is already done (below), so picking it up cold is cheap.

### C1 — Diagnose and fix hue collapse in 256-colour terminals

**Symptom.** On some Mac and Linux terminals, distinct Lens hues render as near-
identical colours; participants could not tell facets apart and were confused
about what the View was showing.

**Leading hypothesis, established by reading the renderer** (OpenTUI core 0.3.1,
`index-jx0p1c2f.js`):

- `CliRenderer.shouldSyncNativePaletteState()` returns true iff the terminal
  advertises `ansi256` **and not** `rgb`.
- When true, OpenTUI queries the terminal's *actual* palette over **OSC 4** and
  pushes those 256 RGBA entries into the native renderer
  (`rendererSetPaletteState`). All output RGB is then quantised onto **the
  terminal theme's own colours** — Solarized, Nord, Dracula, Terminal.app
  defaults — not the standard xterm-256 colour cube.
- Our palettes in `aperture/lenses.ts` are hand-tuned to be safe against the
  **standard cube** (see the comment at `lenses.ts:133` and the "no … collapses
  to grey" test). That guarantee simply does not hold against an arbitrary
  themed palette, which typically offers far fewer distinct hues. Hence
  "projected into a different space, which flattened differences."
- Fallback only kicks in when OSC 4 detection *fails*
  (`normalizeTerminalPalette` → `getFallbackAnsi256Palette`), so a terminal that
  answers honestly is the *worse* case.

**Why it hit Mac/Linux and not us:** whether `rgb` is set comes from the native
`getTerminalCapabilities`. `COLORTERM=truecolor` is commonly lost over ssh, is
not set by several Linux terminal defaults, and Terminal.app genuinely has no
truecolor. tmux is explicitly special-cased in OpenTUI and is a strong suspect
for a second, independent path to the same failure.

**Work:**

1. **Diagnostic first.** Add `opencode debug aperture-colors` (extend
   `cli/cmd/debug/index.ts`, which already reports `TERM`/`TERM_PROGRAM`): print
   detected capabilities (`rgb`, `ansi256`, multiplexer), whether native palette
   sync is active, the detected OSC-4 palette, and — for each facet of the active
   Lens — the requested hex next to the colour it will actually resolve to, plus
   pairwise perceptual distance (CIEDE2000) between resolved facet colours.
   Everything else in this task is guesswork without this.
2. **Survey.** Run the diagnostic across the terminals a participant might
   plausibly use: macOS Terminal.app, iTerm2, Ghostty, WezTerm, Alacritty,
   GNOME Terminal, Konsole, xterm, VSCode integrated terminal, each bare and
   under tmux, each local and over ssh. Record capabilities + minimum pairwise
   distance in a table checked into `docs/`.
3. **Fix, in priority order:**
   - *Prefer truecolor where it's actually available.* Determine whether `rgb`
     is being under-detected (env not propagated, tmux passthrough, missing
     `COLORTERM`) and correct detection or set it ourselves where safe.
     Recovering truecolor makes the whole problem vanish for most terminals.
   - *When genuinely 256-only, choose facet colours against the detected
     palette instead of assuming the cube.* Resolve facet hues at render time by
     maximising minimum perceptual distance among the terminal's real entries,
     rather than shipping fixed hex and hoping. This is the substantive change
     and belongs next to the palette definitions in `lenses.ts`.
   - *Guarantee a floor.* If the detected palette cannot separate N facets
     acceptably, fall back to a redundant encoding rather than lying: reduce to
     fewer facets visually, or add a texture/glyph channel. Silently flattening
     is the worst outcome.
4. **Regression test.** Replace/extend the current cube-only test with one that
   takes a palette as input and asserts a minimum pairwise distance, then run it
   over the palettes captured in the survey.

**Open decisions:** whether to fix detection upstream in OpenTUI or work around
it locally; whether the fallback encoding is fewer-facets or texture.

**Done when:** every terminal in the survey table shows all facets of a 6-facet
Lens as mutually distinguishable, verified by the diagnostic and by eye on at
least one real Mac and one real Linux machine.

---

## Suggested ordering

**Done:** O3, then O2, then O1. O2 was taken before O1 deliberately — O1's premise
is that file-level viewing *moves into VSCode*, so stripping the top bar's file tier
before the Explorer could show facets would have left no file-level facet view
anywhere. O2 also produced the bulk endpoint S5 is specified to consume.

**Immediately:**
- **S1** — the anchoring design is the long pole of the sprint; start the design
  early even if implementation waits.

O4 whenever convenient — it's small, self-contained, immediately useful, and now
has a second consumer: it should drive O2's Explorer `focus` as well as the TUI.

**Then:** S2 → S3 → S5 in sequence, all gated on S1.

**Track G** is independent throughout and can run alongside from the start. It's
the most speculative track, so it should not block the others.

**Track C** is deferred: pick up C1 on a low-momentum day, or when the design
tracks are blocked on a decision. It must land before the final experiment, so it
shouldn't slide past the point where there's no slack left.

**Natural split by surface:**
- *Terminal renderer* (`aperture.tsx`): O1, O4, G2, G3
- *VSCode extension* (`sdks/aperture-vscode`): O2, S3, S5's reveal path
- *Server/data* (`aperture/`, tools, payload): O3, S1, S2, G1, the bulk endpoint
- *Cross-cutting, deferred*: C1

---

## Open decisions (to be made deliberately)

| # | Decision | Track |
| --- | --- | --- |
| 1 | ~~Extent painting always-on vs. widened heuristic, given ~5.8× cost~~ — **decided:** always-on, with granularity (not coverage) as the cost dial; one painter, one classification per file, semantic store demoted to a derived projection | O3 ✅ |
| 1b | ~~How the Explorer pip carries colour + a multi-facet mix under VSCode's one-colour/one-glyph budget~~ — **decided:** one contributed colour id per exact palette hex (exact legend hue, no facet-count limit); colour = focused facet, shade glyph = its byte share; `focus` a parameter, defaulting to dominant | O2 ✅ |
| 2 | ~~What dimension replaces the file tier in the top bar~~ — **decided:** the child list goes, leaving one row of directory blocks; the scope's own files return as a packed alphabetical grid of one-line tiles, each banded by its *own* facet mix (the only surface that shows a file's minority facets — the Explorer pip is dominant-only) | O1 ✅ |
| 3 | Whether filtered-off facets keep their treemap area | O4 |
| 4 | Line-tag anchoring mechanism (composite recommended) | S1 |
| 5 | Search Lens as a distinct type on the model vs. a flag | S1 |
| 6 | Activity View in the sidebar vs. the top bar | G3 |
| 7 | Whether to fix truecolor detection upstream in OpenTUI or locally | C1 *(deferred)* |

---

## Carried forward from Sprint 1

### ⚠️ Catastrophic failure mode

Symptom: Aperture runs fine, then RAM climbs without bound (~30MB/s) while
completely idle; the top bar never paints; CPU is busy.

Root cause: a slot renderer that reads a `createResource` accessor **directly in
the render/tracking scope**. In SolidJS, calling the accessor while the resource
is in its **error** state re-throws synchronously inside render, tripping the
slot's error boundary, which re-renders, which re-reads, which throws again.
Every cycle allocates. Gating with `<Show when={graph()?.nodes.length > 0}>` is
the same trap — the condition calls the accessor.

Fix: never call a resource accessor unguarded in render. Check `resource.error`
first and return a fallback *without* calling the accessor; route every read
through a helper that short-circuits on error. Keep the bar frame always mounted
at fixed height rather than gating it behind `<Show>`.

Why it hid: the loop needs the resource in error AND something driving
re-renders. **A bug that reproduces only in busy directories is the tell.**

Localizing render/leak bugs: dewire the data path → hardcode a static bar → add
back the fetch + a count readout → add back the per-node `For` with guarded
reads. Bisect one variable at a time. Isolate the instance under test (scratch
dir / worktree) so your own edits don't confound the reading.

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
reversible. **This is why Track G's placement question is cheap to defer.**

### Frozen reference — verified extension points

TUI stack: TypeScript + SolidJS + OpenTUI under
`packages/opencode/src/cli/cmd/tui/` (NOT Go/bubbletea). OpenTUI runs a 60fps
flexbox render loop; you mutate SolidJS signals, never write a draw loop. Mouse
is first-class (`onMouseDown/Up/Over/Out/Move`, `onClick`).

Note: this repo has **two** front-ends — `bun dev .` runs the terminal TUI
(`cli/cmd/tui`), not the SolidJS `packages/app`. Confirm which before editing UI.

Aperture files:
- Server: `packages/opencode/src/aperture/` — `payload.ts` (contract),
  `extract.ts` (deterministic walk), `aperture.ts` (service: cache + window math
  + events + painter drivers), `painter.ts`, `extents.ts` (line-delimited
  function extents), `semantic-store.ts` (file-level facets),
  `subfacet-store.ts` (function-level facets), `semantics.ts`, `lenses.ts` +
  `lens-store.ts`, `deterministic.ts` (git/mtime/bus-factor built-ins),
  `event.ts`, `dump.ts`, `study-log.ts`.
- Tools: `tool/lens-{create,list,select,edit,merge-facets,facet-files}.ts`,
  registered in `tool/registry.ts`.
- HTTP: `server/routes/instance/httpapi/groups/aperture.ts` (+ `handlers/`),
  registered in `server.ts` and `api.ts`. Routes: `get`, `facets` (O2's bulk
  whole-repo file→facet-mix map), `lens/cycle`, `lens/delete`, `lens/list`,
  `lens/select`, `interaction`.
- TUI: `feature-plugins/system/aperture.tsx` (+ `aperture-activity.ts`,
  `aperture-lens-picker.tsx`); registered in `cli/cmd/tui/plugin/internal.ts`;
  slot placed in `routes/session/index.tsx`.
- VSCode: `sdks/aperture-vscode/src/extension.ts` (gutter strips via
  `createTextEditorDecorationType`, SSE on `/event`, `tui.file.open` reveal,
  `tui.directory.reveal` → `revealInExplorer`).
- Tests: `packages/opencode/test/aperture/`.

Slots: host slot map at `packages/plugin/src/tui.ts` (`TuiHostSlotMap` —
currently only `aperture_top`); placement + height/visibility math in
`routes/session/index.tsx`; sidebar template `feature-plugins/sidebar/files.tsx`;
full-screen route template `feature-plugins/system/diff-viewer.tsx`.

Events (server → TUI): `aperture.invalidated` (defined in `aperture/event.ts`,
registered by importing that module from the route group before `api.ts`
snapshots the EventV2 registry into the SDK union). **It must carry a location**
— the VSCode extension is the only HTTP-SSE consumer and silently misses
repaints otherwise. Feeding it: `file.edited` (`packages/core/src/filesystem.ts`),
`file.watcher.updated` (`filesystem/watcher.ts`),
`session.next.shell.ended` (experimental shell-mutation refetch).

Events (TUI → host editor): `tui.file.open` and `tui.directory.reveal`, both
defined in `cli/cmd/tui/event.ts`, routed `groups/tui.ts` → `handlers/tui.ts`.
Published from inside an HTTP handler, so `EventV2Bridge` stamps `location`
automatically — only forked-fiber publishes (the painter) must pass it. A TUI
plugin has no emit API: `TuiEventBus` is subscribe-only, so publishing means
calling `props.api.client.tui.*`. Adding an event needs
`bun run --cwd packages/sdk/js build` to regenerate the client method and the
`Event` union; the VSCode extension parses raw SSE JSON and needs no SDK change.

Persistence:
- Project directory (`.opencode/aperture/`): Lens defs (`lenses.json`) + active
  pointer (`active.json`). Shareable/committable, agent-readable. **Line tags
  join these (S1).**
- Durable KV (`storage/storage.ts`, string[] keys): structure caches under
  `["aperture", projectID, "structure", scopeKey]`; file facets and sub-file
  facets namespaced per Lens id. Large, churny, free to regenerate.
  `storage.update` is atomic read-modify-write under a write lock.
- Bus-factor is persisted to the semantic store and background-refreshed
  HEAD-keyed (not computed inline like git-changed/mtime) — computing it inline
  blocked cold-open for ~10s.
- Per-open-project in-memory state: the service's `caches` Map keyed by
  directory, cleaned via `registerDisposer`.

Painter: `provider.defaultModel` → `getSmallModel(providerID)` →
`getLanguage(small)`; returns undefined when no small model exists and the
painter skips the pass. Foreground (viewed window) and background (whole-repo
DFS) drivers share one `Semaphore(1)`. Dir-coherent bins + wide fan-out — see
the concurrency notes before changing constants. Perf trace: `perf/painter.log`.

Config: `packages/core/src/v1/config/config.ts` — `aperture.painter.context`
("minimal" | "medium"), `aperture.painter.concurrency`. JSONC supported.

`PAYLOAD_VERSION` is currently **7**; bump it whenever the payload shape or
extractor semantics change (a stale cache from an older extractor being served
was a real, hard-to-find bug). S1 takes it to 8.

Module/style conventions: see `AGENTS.md` (flat exports + self-reexport, Effect
v4 rules, snake_case Drizzle, run `bun typecheck` from package dirs).

---

## Parked

- **Plan-overlay** — dashed proposed-file blocks parsed from plan markdown;
  superseded by task lists referencing the Lens.
- **Edges follow-ups** — per-child boundary tiles, incoming cross-window edges,
  routed in-window connector lines. Core edges done. Note that O1's removal of
  the file tier may retire parts of this outright.
- **Full-screen zoom route** — detail route for a single node/subgraph.
- **Durable provenance + timeline** — partly absorbed by G1.
- **Deeper edge extraction** — LSP-backed call/type edges, path-alias resolution.
- **Background-sweep re-walk cost** — skip-ahead cursor / wake-scoped re-walk on
  large mostly-painted repos. Worth revisiting if O3 lands as always-on.
- **Sprint-1 diagnostic logging** — `perf/autosession.log` instrumentation from
  the auto-create-session work should be stripped once the "Provider is
  overloaded" chat bug is resolved.
