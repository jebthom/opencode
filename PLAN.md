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
   Linux saw hues collapse toward each other. Real, and it needed fixing before
   the final experiment — but it's a rendering-fidelity bug, not a design
   question, and it blocked nothing else. Fixed in Track C, where it turned out
   to be a straightforward palette bug (two of `pastel`'s six colours were
   literally identical in a 256-colour terminal) rather than the terminal-palette
   reprojection it looked like.

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

G1 ✅ (activity data) ──► G2 (block render) ──► G3 (placement/timeline)

                                         C1 (colour fidelity) ──► ✅ independent
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
Theme-role tokens (the architecture Lens, `NONE_HUE`/`UNTAGGED_HUE`) still fell
through `THEME_ROLE_COLORS` at this point, which is where C1 later found the
cross-surface mismatch: the token table here and the one in `chip.ts` disagreed
with each other and with the TUI. C1 deleted both and made the server ship hex.
The one cost, unchanged: a contributed colour is a fixed hex, not theme-adaptive,
so the palette does not soften on a light editor theme (the tradeoff the TUI
already has, now taken deliberately across both surfaces).

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

Built as **one suppressed set on the server, applied once per client at its
facet→colour map**. The set lives in memory per directory (never on disk — it is a
way of looking at a Lens, not part of one) and is cleared on a Lens switch, since a
filter is only meaningful in the vocabulary it was expressed against. The TUI's
legend click and the extension's picker both `POST /aperture/facet-filter`; the
server echoes `aperture.facets.filtered` over SSE, and the set also rides the graph
payload and the facet map so a client that reconnects or starts late recovers it
from an ordinary fetch instead of painting unfiltered.

Each client applies it in exactly one place — `colorByFacet` in the TUI, the derived
`facetLegend` in the extension — so the treemap blocks, file bands, tree chips,
Explorer pips and editor gutter all grey without knowing the filter exists. Colours
stay *true* on the wire, so a click repaints on the next frame with no round trip and
untoggling needs no refetch. Weights are never touched, which is what preserves area.
Multi-select, with a `↺` reset affordance that appears only while a filter is on
(and is charged for in the legend row's trim budget).

Shared with Search Lenses (**S4** is the same code path, less useful there) —
build once, in `aperture.tsx`.

**Also feeds the Explorer**, and the gutter: O2's stopgap QuickPick now posts to the
same authority rather than owning its own set, so filtering from either surface
filters both in one gesture. The editor gutter — the one surface that had no
suppression at all — greys a suppressed function's stripe by resolving its
`extent.facet` through the filtered legend rather than trusting the `hue` the server
resolved before it knew about the filter.

**Decided:** off-facets *keep* their area and grey in place. Layout stability is the
thing we've consistently protected, and keeping the area is what lets two directories
stay comparable across a click — which is the whole reason to filter rather than to
search. The one exception is the Explorer pip, which subtracts instead: a one-colour
pip has to choose a facet, so subtraction is the only filtering it can express.

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

### G0 — Sidebar occupancy audit and space budget

G3's placement question needs a written inventory of what already lives in the
sidebar before an Activity View can be sized against it. This is that inventory,
plus the budget the rest of the track builds to.

**The container.** `routes/session/sidebar.tsx` — one `<box>`, `width={42}`,
`height="100%"`, padding 1/2/1/2, holding a `<scrollbox flexGrow={1}>` (which
contains `sidebar_title`, then `sidebar_content`, wrapped in a
`flexShrink={0} gap={1} paddingRight={1}` box) above a fixed
`<box flexShrink={0} paddingTop={1}>` holding `sidebar_footer`.

- **Width: 36 columns of drawable text.** 42 − 4 padding = 38; the content
  wrapper's `paddingRight={1}` leaves 37; the vertical scrollbar takes the last
  column once content overflows. `files.tsx:35` already hard-codes `36` as its
  truncation width, so 36 is the house number — use it rather than inventing
  another.
- **Height: `terminalHeight − 2 − 4`** — outer padding, then the footer (wrapper
  `paddingTop` 1 + the footer's own gap + path/branch line + version line). The
  getting-started card in `sidebar/footer.tsx` adds ~9 rows more, but only while
  no paid provider is configured and `dismissed_getting_started` is unset.
- `42` is duplicated in `sidebar.tsx:29` and `routes/session/index.tsx:257`
  (`contentWidth`); the two must move together if the column is ever widened.

**Visibility gates** (`routes/session/index.tsx:238–244`, `1320–1339`):

- **Hidden outright for subagent sessions** (`session()?.parentID`). This is the
  gate that bites Track G — a sidebar Activity View is unavailable inside exactly
  the sessions where sub-agent attribution is most interesting. The top bar has
  the identical gate (`index.tsx:253`), so it does not favour one placement over
  the other, but it is a real limit on both.
- `wide()` = width > 120. Auto-shows when wide; below that the *same* `<Sidebar>`
  renders as an overlay over the chat behind an `RGBA.fromInts(0,0,0,70)` scrim —
  same width, same content.
- Toggle `session.sidebar.toggle` / `<leader>b` (`config/keybind.ts:80,279`), kv
  `sidebar` = `"auto" | "hide"` plus a transient `sidebarOpen` signal.

**Slot inventory.** All five internal sections come from
`feature-plugins/sidebar/*.tsx`, registered in `plugin/internal.ts:30–35`.
`sidebar_content` renders in the slot library's **append** mode: every registrant
draws, sorted by ascending `order` (ties → registration order → plugin id),
separated by `gap={1}`.

| order | section | file | shown when | rows |
| --- | --- | --- | --- | --- |
| 100 | **Context** | `sidebar/context.tsx` | always | 4 — header, tokens, % used, $ spent |
| 200 | **MCP** | `sidebar/mcp.tsx` | ≥1 server | 1 + N, word-wrapped; collapsible above 2 (collapsed header shows `(n active, m errors)`) |
| 300 | **LSP** | `sidebar/lsp.tsx` | always — the box is unconditional | 1 + max(1, N); placeholder line when empty |
| 400 | **Todo** | `sidebar/todo.tsx` | ≥1 todo, not all completed | 1 + N, wrapping |
| 500 | **Modified Files** | `sidebar/files.tsx` | session diff non-empty | 1 + N |

`sidebar_title` (`single_winner`, host default at `sidebar.tsx:55–82`): bold
title, session id when `InstallationChannel !== "latest"`, `WorkspaceLabel` when
the session has a workspace, share URL when shared — **1–4 rows**.
`sidebar_footer` (`single_winner`): the host default is 2 lines;
`sidebar/footer.tsx` (order 100) wins it.

Nothing else registers a sidebar slot today — Aperture holds `aperture_top` only.
The one other registrant is `.opencode/plugins/tui-smoke.tsx:833`, a dev smoke
plugin that pushes several bordered blocks in; it interleaves by order, which is
worth knowing when the sidebar mysteriously grows panels. Third-party plugins can
register `sidebar_content` freely (`specs/tui-plugins.md:433–444`), so no order
value is exclusively ours.

**Steady state on this repo:** title 3 + Context 4 + LSP 4 + Todo 6 + Modified
Files 9 + gaps ≈ **31 rows**, plus 4 footer and 2 chrome ≈ 37. On a 40-row
terminal the column is already full; on a 30-row terminal ~24 rows are visible.

**Scrolling — the finding that decides the budget.** The sidebar **already scrolls
independently of the chat**: `ScrollBoxRenderable.onMouseEvent` handles wheel
`scroll` itself, hit-tested to the hovered element, so scrolling over the sidebar
moves only the sidebar (shared `getScrollAcceleration(tuiConfig)`, same as chat).
There is no keyboard path — nothing focuses or key-binds it, so it is mouse-only.
Two consequences:

1. **A new section cannot push existing ones off-screen.** One scrollbox holds all
   of `sidebar_content`, so added height costs scroll depth, not visibility. There
   is no crowding-out collision of the kind the top bar has — only an
   above/below-the-fold ordering question, and ordering is fully ours.
2. **A shared scrollbox cannot give a sub-section its own viewport.** An
   append-only log wants to stay pinned to its newest turn, and `stickyScroll` on
   the shared box would pin the *whole sidebar* to its bottom. So an Activity View
   that scrolls or sticks on its own needs a **nested `<scrollbox>` with an
   explicit height** — which is also what caps its contribution at a constant.

**Budget:**

- **36 columns**, matching `files.tsx`.
- **A fixed `ACTIVITY_ROWS` (default 10) inside a nested `<scrollbox>`, plus a
  1-row header = 11 rows.** Constant contribution however many turns accumulate,
  and the nested box can carry `stickyScroll` without dragging the sidebar along.
- **`order: 150`** — directly below Context, above MCP/LSP/Todo/Files. The block
  then begins around row 10 of the scroll region even with a 4-row title, so it is
  above the fold on any terminal tall enough to show the sidebar at all, while
  Context (the other always-present section) keeps the top slot.
- Follow the section idiom so it reads as native: bold header row, `▼`/`▶` toggle
  appearing only above 2 items and flipping on `onMouseDown`, `theme().textMuted`
  body, `•` status dots, and `props.api.theme.current` rather than the host
  `useTheme`.

**Reuse — superseded by G1.** This section originally proposed lifting
`createActivityTracker` (`feature-plugins/system/aperture-activity.ts`) out of the
`aperture_top` slot's `View` so a sidebar slot could share one tracker instead of
building a second with its own subscriptions. G1 found the tracker recorded
*nothing* (its `session.next.*` events are gated behind
`OPENCODE_EXPERIMENTAL_EVENT_SYSTEM`, default off) and deleted it: activity is now
derived server-side from the message store and fetched over
`GET /aperture/activity`, so there is no client-side tracker to share and the
double-instantiation trap is moot. Facet colouring still comes from
`colorByFacet` in `aperture.tsx`, which is also where O4's filter is applied —
and the endpoint ships the same `{t, w:[{f,p}]}` weights that function reads.

### G1 — Activity data model ✅

Per-turn, per-agent read/edit/write actions with the facet of each touched file
under the **currently active Lens** — so switching Lens recolours history
without re-recording it. **Implemented.**

**The old display is gone.** The top bar's per-turn glyph strip (`●○` read, `■□`
create, `◆◇` edit; solid on the touched file, outline on a containing directory)
and its legend row are deleted, along with `OverlayRow`, `overlaysFor`, the
`Overlay` type, the agent-colour palette and the hover line's trailing "agent
edited X 3m ago" clause. `TOP_BAR_HEIGHT` 14 → 13 (the glyph row was one of the
four header rows). `aperture-activity.ts` is deleted outright.

**Resolved — activity is *derived*, not recorded.** The in-memory tracker
subscribed to the `session.next.*` family, which
`OPENCODE_EXPERIMENTAL_EVENT_SYSTEM` gates and which defaults to **false** — so
it recorded nothing for anyone, and G0's "most of G1's substrate exists" was
optimistic. Rather than fix and lift it, the read model is now a *view* of the
durable message store: every tool call already persists as a `ToolPart` with its
tool, its input and its timings; user messages are the turn boundary; assistant
messages carry the acting agent.

The consequences are the point. There is no write path, no ring to evict and no
second source of truth that can drift. Per-session durability is free, history
from before the feature landed is readable, and "switching Lens recolours history
without re-recording it" is trivially true because nothing is recorded at all —
verified live: cycling the Lens returns `turns` **byte-identical** while
`facets`/`files` recolour.

- **A turn is a non-*synthetic* user message.** Tool-result injections,
  background sub-agent completions and compaction all arrive as synthetic user
  messages; splitting on those would shatter one prompt into a dozen one-entry
  turns, which is the single most damaging thing the derivation could get wrong.
- **Sub-agent work folds into the parent turn** at `depth: 1`, found by walking a
  `task` part's `state.metadata.sessionId` (`tool/task.ts`) into the child
  session. This is the only place it can ever be seen — G0 established that the
  sidebar is hidden outright *inside* subagent sessions. Capped at depth 1 and 16
  children per turn so a fan-out turn can't make a sidebar refresh unbounded.
- **Entries are filtered to files the view knows about** (`subtreeFor`). Two
  different cases sit behind that one filter. Gitignored, binary and
  since-deleted paths genuinely have no node, size or facet, so a block for one
  could only be an uncolourable hole in the waffle. **Directories are not that
  case** — Aperture aggregates them, which is what the whole top bar is made of —
  and they are dropped for a rendering reason that belongs to **G2**: a turn's
  reads collapse into one block, so admitting a directory would aggregate an
  aggregate. See G2 for the argument and for what to try if that changes. A file
  that survives but is *unpainted* is a third case and is kept — that's the
  honest grey the treemap already draws.
- **The facet half is shaped exactly like `FacetMap`**: same `facets` vocabulary,
  same `{t, w:[{f,p}]}` weights, same `suppressed`, the whole mix rather than a
  pre-reduced dominant (O2's decision, so O4's filter stays a pure client-side
  function of (mix, focus)). Attribution runs through the same
  `computeFacetMapFiles`, filtered *at its input* to the touched paths — so the
  sidebar doesn't pay a 2265-file reduction to colour twenty blocks, and an
  Activity View block, an Explorer pip and a treemap band for one file cannot
  disagree. Verified against `/aperture/facets`: identical vocabulary, identical
  weights.
- **Reading is bounded**: `MessageV2.page` walks backwards until the requested
  turn count is seen, so a months-old session costs what a fresh one does.
  `Aperture.defaultLayer` gains `Database.defaultLayer` (the `Todo`/`Account`
  idiom); `message-v2.ts` imports nothing under `aperture/`, so no cycle.

**Landed:** `aperture/activity.ts` (vocabulary + wire shapes, still
dependency-free), `aperture/activity-model.ts` (pure `deriveTurns` /
`mergeChildEntries` / `toRepoRelative`, structurally typed so it tests from
fixtures), `Aperture.activity()`, `GET /aperture/activity`, and
`test/aperture/activity.test.ts` (12 cases, including the synthetic-message trap
and facet agreement). No `PAYLOAD_VERSION` bump — derived at the read boundary.
No new SSE event: G2 refetches off `session.status` idle, exactly as the top bar
already does, which is a core event and so fires with the experimental event
system off.

**Not verified live:** sub-agent folding — no session in this repo has ever
called the `task` tool, so it rests on the unit test alone.

### G2 — Block rendering

A treemap/waffle of the turn's actions, coloured by active-Lens facet.

**Reads are less important than edits and writes.** Reads aggregate into one
block, optionally expandable to per-file; edits and writes are always expanded.
This is the core information-density decision and should survive contact with
the experiment.

**Open — directory reads are excluded, and the reason belongs to this step.** The
`read` tool takes a *directory* as happily as a file, and agents use it that way
constantly (a live session showed 4 of 6 reads were directories). G1 filters
those out at the service, and the justification given there — "no node, no size,
no facet" — is **wrong on its face**: a directory is exactly the thing Aperture
*does* have an aggregation for. Its treemap band is the composition of everything
beneath it.

The real reason is that G2 aggregates. A turn's reads collapse into one block, so
admitting a directory would fold an aggregate *into* an aggregate: one `read` of
`packages/` would outweigh nine reads of individual files, and the block would
report the facet mix of code the agent never opened. Whatever the block is
measuring — "what did the agent actually look at" — a directory listing is not an
instance of it.

So the exclusion stands, but it is a **G2 rendering decision that G1 happens to
implement**, and it should be revisited if the answer to "reads aggregate into
what?" changes. Two things worth trying if it does: give directory reads their
own non-aggregating mark (a navigation trace rather than a facet block), or lift
them out of the waffle entirely into a per-turn "looked around in" line. The data
to do either is one filter away — `Aperture.activity` drops these against
`subtreeFor`, so restoring them is deleting a `.filter`, not re-deriving anything.

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

## Track C — Colour fidelity ✅

### C1 — Hue collapse in 256-colour terminals ✅

**Symptom.** On some Mac and Linux terminals, distinct Lens hues rendered as
near-identical colours; participants could not tell facets apart. Separately,
once O2 put facet glyphs in the VSCode tree, its colours did not match the TUI
legend either.

**The original hypothesis was wrong**, and usefully so — the truth is much
smaller. It assumed OpenTUI reprojects our colours onto the terminal's *own*
themed palette (Solarized/Nord/Dracula), which would have meant resolving hues
against the detected palette at render time. In fact:

- `NATIVE_PALETTE_QUERY_SIZE = 16` (`@opentui/core/index-jx0p1c2f.js:22091`).
  OpenTUI queries only indices **0–15** over OSC 4;
  `normalizeTerminalPalette` fills **16–255 from the standard xterm cube and
  grey ramp** unconditionally. A terminal colour scheme only ever perturbs 16
  slots.
- Measured across 8 terminal themes, the theme barely moves the minimum
  pairwise CIEDE2000 of a palette at all.

**The actual bug was palette-internal, against the *standard* cube.** The guard
test only ever checked each colour against grey, never against the other five.
Quantised to xterm-256:

| palette | min ΔE2000 | |
|---|---|---|
| **pastel** (the default) | **0.0** | `#F7C8A0` and `#F5E1A4` both → idx 223 — *the same colour* |
| pastel-ordinal | 9.0 | `#79C7C1` → 115, `#9BCF8F` → 114 |
| earthy | 11.9 | |
| bright | 16.4 | |

And the TUI/VSCode mismatch was a third thing again: the server shipped
theme-role *tokens* (`info`, `textMuted`, `border`) rather than colour, and each
surface resolved them for itself. `info` was `#56b6c2` in the TUI and `#3794FF`
in the chip; `textMuted` and `border` both collapsed onto `descriptionForeground`
in the gutter, so "Other" and "Non-code" were one colour there and two in the
chips; `primary` was missing from the extension's table entirely and went
unpainted.

**Resolution: one closed universe of eight hexes, every one an exact xterm-256
entry.** A colour that *is* a palette entry quantises to itself, so a 256-colour
terminal shows bit-identical RGB to a truecolor one, which is bit-identical to
what VSCode paints. No capability detection, no render-time palette search,
nothing to reconcile.

- Six categorical colours, chosen by max-min dispersion search over the 216 cube
  cells under L\* 45–75 / C\* 30–75: `#D7005F` `#AF5F00` `#AFAF00` `#00875F`
  `#00AFD7` `#5F5FD7`. Min pairwise ΔE2000 **32.3** (was 16.4 for `bright`).
- The ordinal palette is those six **reversed** — Lab hue rotates monotonically
  299°→8°, a cool→warm rank ramp — so the whole product holds six hues, not 42.
  `CHANGE_COLORS` and `BUS_FACTOR_COLORS` are slices of it.
- Greys: "Other" `#8A8A8A` (ramp idx 245), "Non-code" `#444444` (idx 238).
- `LAYER_HUE` (Architecture Lens) pinned to five of the six. `DIRECTORY_HUE`
  deliberately stays a theme role — it is TUI-only chrome, and painting it a
  facet colour would make directories read as a facet.

**One trap worth remembering:** exactness is necessary but not sufficient.
`#808080` is in the table *twice* — grey-ramp 244 and system 8 — and a quantiser
taking the lower index lands it in the re-themable range, where Solarized paints
a slate blue. The obvious mid-grey was the wrong grey. `collidesWithSystemColor`
in `aperture/color-256.ts` guards this; it was caught by the diagnostic, not by
reasoning.

**Landed:**

1. `aperture/lenses.ts` — two palettes replacing seven, greys and ramps pinned to
   hex, and the rule written down: every paintable colour is an exact xterm-256
   entry outside 0–15.
2. `aperture/color-256.ts` (new) — quantisation + CIEDE2000, shared by the guard
   test and the diagnostic so they can't disagree.
3. `aperture/lens-store.ts` — legacy palette ids map forward on read, and facet
   colour is re-derived from `(palette, index)` on every read instead of being
   stored. Stored colour was a second source of truth that went stale whenever
   the palettes changed.
4. Extension — `THEME_ROLE_HEX` and `THEME_ROLE_COLORS` both deleted; contributed
   colour ids go 39 → 8; chip segments are now theme-independent, so the tree
   computes one set instead of two.
5. `opencode debug aperture-colors` — prints each facet's requested hex beside
   the swatch it quantises to, so the fix can be *seen* on a participant's
   machine rather than argued about.
6. Guard tests: exact-entry, no-system-collision, and min pairwise ΔE ≥ 20 over
   palettes + built-in ramps + both greys.

**Dropped from the original plan:** the terminal survey table (the theme turns
out not to matter), and choosing facet colours against the detected palette at
render time (exact cube cells make it moot). Open decision #7 — fix truecolor
detection upstream in OpenTUI or locally — is resolved as **neither**.

**Accepted tradeoff:** no facet colour adapts to light vs dark any more. That is
deliberate — consistency across surfaces is the whole point — but `#444444`
"Non-code" reads as a dark bar rather than receding on a light background. Any
`aperture.cXXXXXX` id can be retuned via `workbench.colorCustomizations`.

**Still to do:** verify by eye on a real Mac and a real Linux machine, which is
the one claim the tests cannot make.

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
the most speculative track, so it should not block the others. G0 and G1 are
done; **G2** is next and is now unblocked by data — it consumes
`GET /aperture/activity` and needs no further backend work.

**Track C** is done. C1 landed after O1–O4, once O2's tree glyphs made the
cross-surface half of the problem visible.

**Natural split by surface:**
- *Terminal renderer* (`aperture.tsx`): O1, O4, G2, G3
- *VSCode extension* (`sdks/aperture-vscode`): O2, S3, S5's reveal path
- *Server/data* (`aperture/`, tools, payload): O3, S1, S2, G1, the bulk endpoint
- *Cross-cutting*: C1 ✅

---

## Open decisions (to be made deliberately)

| # | Decision | Track |
| --- | --- | --- |
| 1 | ~~Extent painting always-on vs. widened heuristic, given ~5.8× cost~~ — **decided:** always-on, with granularity (not coverage) as the cost dial; one painter, one classification per file, semantic store demoted to a derived projection | O3 ✅ |
| 1b | ~~How the Explorer pip carries colour + a multi-facet mix under VSCode's one-colour/one-glyph budget~~ — **decided:** one contributed colour id per exact palette hex (exact legend hue, no facet-count limit); colour = focused facet, shade glyph = its byte share; `focus` a parameter, defaulting to dominant | O2 ✅ |
| 2 | ~~What dimension replaces the file tier in the top bar~~ — **decided:** the child list goes, leaving one row of directory blocks; the scope's own files return as a packed alphabetical grid of one-line tiles, each banded by its *own* facet mix (the only surface that shows a file's minority facets — the Explorer pip is dominant-only) | O1 ✅ |
| 3 | ~~Whether filtered-off facets keep their treemap area~~ — **decided:** keep it, greying in place; weights are never touched, so no surface re-flows on a filter click. The Explorer pip is the deliberate exception (one colour, so it must subtract) | O4 ✅ |
| 4 | Line-tag anchoring mechanism (composite recommended) | S1 |
| 5 | Search Lens as a distinct type on the model vs. a flag | S1 |
| 6 | Activity View in the sidebar vs. the top bar — **not a space contest**: G0 establishes that the sidebar is one shared scrollbox, so a new section costs scroll depth rather than pushing anything off-screen, and `order` is ours to pick. Both surfaces are equally unavailable in subagent sessions. G1 has since *emptied* the top bar of activity, so this is now a placement choice with no incumbent | G3 (G0 ✅, G1 ✅) |
| 8 | ~~Where activity data comes from and how it gains per-session durability~~ — **decided:** derived from the durable message store on every read, never recorded. The `session.next.*` tracker was dead by default and in-memory; deriving makes durability, retroactive history and Lens-switch recolouring free, and removes the second source of truth | G1 ✅ |
| 7 | ~~Whether to fix truecolor detection upstream in OpenTUI or locally~~ — **decided:** neither. Putting every paintable colour on an exact xterm-256 entry makes quantisation a no-op, so truecolor stops mattering for colour *identity* | C1 ✅ |

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
  `event.ts`, `dump.ts`, `study-log.ts`, `activity.ts` (G1 vocabulary + wire
  shapes, dependency-free) + `activity-model.ts` (the pure turn derivation over
  stored messages).
- Tools: `tool/lens-{create,list,select,edit,merge-facets,facet-files}.ts`,
  registered in `tool/registry.ts`.
- HTTP: `server/routes/instance/httpapi/groups/aperture.ts` (+ `handlers/`),
  registered in `server.ts` and `api.ts`. Routes: `get`, `facets` (O2's bulk
  whole-repo file→facet-mix map), `activity` (G1's per-turn agent activity for a
  session), `lens/cycle`, `lens/delete`, `lens/list`, `lens/select`,
  `facet-filter`, `scope` (host → bar re-root), `interaction`.
- TUI: `feature-plugins/system/aperture.tsx` (+ `aperture-lens-picker.tsx`);
  registered in `cli/cmd/tui/plugin/internal.ts`; slot placed in
  `routes/session/index.tsx`.
- VSCode: `sdks/aperture-vscode/src/extension.ts` (gutter strips via
  `createTextEditorDecorationType`, SSE on `/event`, `tui.file.open` reveal,
  `tui.directory.reveal` → `TreeView.reveal`, and the reciprocal
  `onDidExpandElement` → `POST /aperture/scope`).
- Tests: `packages/opencode/test/aperture/`.

Slots: host slot map at `packages/plugin/src/tui.ts` (`TuiHostSlotMap`). Aperture's
own slot is `aperture_top`; the sidebar exposes three more — `sidebar_title` and
`sidebar_footer` (both `single_winner`, so a registrant *replaces* the host
default) and `sidebar_content` (append mode, all registrants draw in ascending
`order`). Slot modes are listed in `specs/tui-plugins.md`. Placement +
height/visibility math in `routes/session/index.tsx`; sidebar container in
`routes/session/sidebar.tsx`; section template `feature-plugins/sidebar/files.tsx`;
full-screen route template `feature-plugins/system/diff-viewer.tsx`. **G0 has the
full sidebar occupancy audit and space budget.**

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

Events (host editor → TUI): `aperture.scope.focused` (defined in
`aperture/event.ts`, routed `groups/aperture.ts` → `handlers/aperture.ts` as
`POST /aperture/scope`) — the reciprocal of `tui.directory.reveal`. The extension
posts it when the user expands a folder in the Aperture tree; the top bar adopts
the path as its scope, so a directory opened in either surface is the directory
both of them show. Two guards keep the round trip from echoing: the extension
holds a "the bar asked for this" flag across a TUI-driven reveal (which expands
the whole ancestor chain, one event per level) and debounces expansions to the
deepest one, and the bar ignores a scope it is already at.

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
