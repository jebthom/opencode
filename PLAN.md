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
| **Activity View** | The vertical Activity Path: an agent's actions as one row per *step*, coloured by the active Lens. |

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

S0 ✅ (tag = query) ──► S1a ✅ (rule model) ──► S2 ✅ (lens_mark) ──► S3 (line painting, sparse
                    ├──► S3's sparse layer ✅ (line-level git-changed)      layer ✅) ──► S5
                    └──► S1b (ast-grep structural backend) — only S1 piece outstanding

G1 ✅ (activity data) ──► G2+G3 ✅ (the Activity Path) ──► ✅ track complete

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

Note the difference in kind from an Overview Lens: participants are often hunting
**specific usages**, which may not sit inside a named extent at all. Line tags
are therefore not a finer grade of extents — they're a separate, sparser layer,
with the compensating benefit of binding directly to syntax.

### S0 — What a line tag *is* ✅

The track originally proposed that an agent tag specific lines and that the tags
be persisted behind a **composite anchor** (enclosing symbol + line-content hash
+ line number tiebreak) so they could survive edits elsewhere in the file, with
"lost" as a first-class state. S1 was named "the hard part" and the anchoring
mechanism was open decision #4.

**Resolved — there is no anchor, because a tag is not a location. It is a
query.** Two findings turned this over.

**1. This codebase's existing answer to "surviving edits" is *don't store a
position*.** There is no anchor machinery anywhere in the repo — `grep -rn
"anchor"` over `aperture/` and `sdks/aperture-vscode/` returns nothing, and
nothing maps an old line number to a new one. What ships instead:

- `extentsOf(content)` re-cuts a file's extents from **disk content on every
  payload read** (`extents.ts:62`, from `finalize` at `aperture.ts:1180-1259`).
  Line numbers are always freshly computed and never persisted.
- `subNodeID(relPath, name)` (`extents.ts:265`) is durable precisely because it
  is content- *and* position-independent.
- `parseHunkRanges` / `extentChangeFacets` derive exact changed line ranges per
  read and throw them away.
- The VSCode extension resolves *nothing*. `fetchExtents` takes server-supplied
  `startLine`/`endLine` verbatim; nothing in `sdks/aperture-vscode/src/` calls
  `document.getText`, `lineAt` or `lineCount`. S3's original premise — "anchors
  resolve in the extension against live buffer content, which is the edit-robust
  choice already established for extents" — described something that did not
  exist.

**2. Deterministic re-evaluation is effectively free.** `Ripgrep.Service` already
exists (`packages/core/src/filesystem/ripgrep.ts`) returning `{path,
line_number, submatches:[{start,end}]}`, and `Ripgrep.defaultLayer` is
self-providable exactly like the `Git.defaultLayer` that `Aperture.defaultLayer`
already provides. Measured on this repo: **13,066 matches whole-repo in 67ms.**

The original "the key insight that makes this affordable: we do not sweep" was an
argument about **model** cost. It does not apply to a grep.

So: the agent's contribution is the judgment about *what to look for* and *what
facet it means* — not the enumeration of hits, which is the part a machine does
better and the part participants noticed the agent already did well. **Persist
the finder; derive the lines at the read boundary.** A deleted usage has one
fewer hit on the next evaluation and its paint disappears; a new usage is painted
with no user intervention. That is the behaviour the probe asked for, arriving as
a property of the model rather than as edit-tracking machinery. The anchoring
problem is not solved — it is deleted, by the same move the codebase already made
for extents.

**Coverage — what a rule-only model reaches, and what it doesn't.** This is the
analysis that decided against a judgment tier.

| Case | `pattern` | `symbol` | `structural` | |
| --- | --- | --- | --- | --- |
| Particular functions (`retryWithBackoff`) | over-matches call sites | exact | exact | **covered** |
| Method + particular argument | only when textually local | no | across lines/whitespace | **covered** |
| All uses of a class/module | textual; over-matches comments/strings, under-matches aliased imports and re-exports | no | identifier nodes, still not resolution-aware | **gap, named below** |
| Anti-patterns (empty `catch`, `await` in a loop, `any` casts) | brittle | no | what it is for | **covered** |
| Config/markup/YAML concerns | yes (language-agnostic) | no (`extentsOf` is TS/JS/Python) | needs a grammar | **covered** |
| "This is the retry path" / "assumes single-tenant" | no | no | no | **not covered** |
| "Everything that transitively depends on X" | no | no | no | **not covered** |

Two things make the uncovered set smaller than it looks. Judgment concerns
usually *have a name* — "the retry path" is normally a declaration called
`retryWithBackoff`, so `{kind:"symbol"}` plus a free-text `note` captures the
judgment with no anchoring, at that declaration's own granularity. And
natural-language judgment over code is **already served, at the
right granularity, by the Overview Lens** — a line-level LLM tier would be a
third mechanism competing with the painter, with a worse cost model and a "lost"
state to render.

**Decided: rule-only.** The frustration the study actually recorded was *"the
agents can grep and the paint can't"* — a query gap, not a judgment gap, and
rule-only closes it exactly. Every piece of the judgment tier (durable line-tag
store, composite anchor, "lost" state, background re-assessment) is machinery
rule-only never needs. The rule union has room for a fourth `kind` if real use
demands one, so the decision is reversible; building it now is not.

**Rejected: from/to beacon patterns** for the "flexible length" problem. A beacon
pair is a second query with the same fragility as the first, and the flexible
length turns out to be better supplied by the structural finder itself — a pattern
matching a `catch` clause paints the clause, one matching a call paints the call.
See the span policy in S1, where widening in general is measured and rejected.

### S1 — The rule model ✅ (S1a; structural backend outstanding as S1b)

**Split in two, risk-ordered.** `@ast-grep/napi` is the only part of S1 that can fail for
reasons unrelated to the design — a native addon, a 0.x package, a postinstall Bun's trust
policy blocks, and an all-platform install the standalone build needs. `pattern` and
`symbol` need no new dependency and exercise every other piece end-to-end, so **S1a**
(schema, persistence, evaluator, read-boundary wiring, tests) landed first and **S1b** (the
structural backend) is the only thing left. A `structural` rule is meanwhile stored,
validated and reported as an unsupported-backend diagnostic rather than silently ignored —
so S2 and S3 are unblocked either way.

**Landed:** `aperture/rules.ts` (new — hashing, evaluation, the two finders, per-rule
diagnostics), `Rule`/`Finder`/`isSearch`/`isValidFinder`/`MAX_RULES`/`MAX_RULE_HITS` on
`lenses.ts` (still dependency-free), rule normalisation in `lens-store.ts`'s existing
`migrate` pass, `LensInfo.search` on the wire, the memo + emit block in `aperture.ts`, and
19 evaluator cases + 5 store cases (`test/aperture/rules.test.ts`, `lens-store.test.ts`).

**Two things only running it could find.**

- **An invalid regex reported `0 hits` and no error.** Ripgrep exits 2 for an uncompilable
  pattern and `Ripgrep.search` maps that to `partial: true` with an *empty* item list, so
  discarding `partial` turned "your regex is broken" into "the code isn't there" — which is
  precisely the reading an agent would act on, and the exact failure the diagnostic exists to
  prevent. `partial` is now surfaced as the rule's `error`. Not pre-validated with
  `new RegExp` instead: ripgrep speaks rust-regex, which accepts the `(?i)` inline flag that
  `caseSensitive: false` generates and JS rejects, so a JS pre-check would reject valid
  patterns.
- **The cap has to be applied before touching the disk.** `clampRanges` needs each matched
  file's content, and the deliberately-loose probe (`const ` on this repo — 46,063 matched
  lines across 2,300 files) spent ~1.2s of the 1.4s pass reading files whose ranges were then
  thrown away unpainted. The over-cap check moved ahead of the reads, and reports *raw
  matched lines* rather than merged ranges — which is also the more faithful reading of a cap
  whose job is to catch "this paints a third of the repo", since merging only ever shrinks
  the number.

**Cost, measured on this repo:** a whole-repo pass over 6 rules ≈ 1.0s (dominated by the
degenerate rule above; the three realistic rules are a few hundred ms), one file ≈ 0.2s. The
memo is therefore not optional even before ast-grep, whose whole-repo pass is 240–285ms
against 17ms for a single file.

**Verified live** against this repo with a hand-authored Lens in `lenses.json` — which is
also the intended authoring path until S2: `lens.search` ships `true`; `lineTags` arrive
keyed by file node id carrying `facet`/`hue`/`rule`/`note`; a `pattern` rule marks exactly
its matched lines (`extents.ts:272`) while a `symbol` rule paints its declaration's whole
extent (`extentsOf`, lines 62–100) in the same payload; the over-cap rule paints nothing;
and `composition` still reports all 19 in-window nodes, unchanged — the assertion that the
sparse layer stayed out of `attributeFileBytes`. **No VSCode extension change was involved
at any point**, which is the real proof that S0's sparse layer generalised from git hunks to
rules.

**Not verified live: the per-file incremental invalidation.** `serve` never constructs the
file watcher (no `watcher backend` log line, and `Watcher.layer` needs a `Location.Service`
that a headless server doesn't stand up), so no `file.edited` reaches `onFileChanged` there.
The tell is that the *shipped* structure cache missed the same edits — a newly created file
never became a node — so this is the environment, not the wiring. What is verified: a cold
pass picks up an edit correctly, and `evaluate`'s `files` restriction (the thing the stale
set drives) is unit-tested. Exercising the hook itself needs the TUI, which does start the
watcher.

**One subtlety the incremental path forced.** A rule over the cap is dropped from the full
pass, so re-evaluating a *single* changed file would find it perfectly narrow and paint it.
The memo therefore carries the over-cap rule ids forward from the last full pass and filters
incremental results through them. A rule that only becomes too broad after edits stays
painted until the next full pass — accepted, since a full pass follows every turn.

Rules attach to `Lens` in `.opencode/aperture/lenses.json` (`lens-store.ts:31-43`)
— small, hand-authored, readable, diffable, committable, shareable. That is a
better justification than the original "expensive to regenerate": rule *hits* are
cheap to regenerate, and the *rule* is the thing worth keeping.

```ts
// lenses.ts — added to the existing Lens interface
readonly rules?: ReadonlyArray<Rule>
readonly search?: true   // rendering policy only — see below

interface Rule {
  readonly id: string
  readonly facet: string        // a facet id on this Lens
  readonly find: Finder
  readonly note?: string        // the agent's reason; shown on hover, never re-evaluated
  readonly createdBy?: string   // agent name, for the study log
}

type Finder =
  | { kind: "pattern"; pattern: string; glob?: ReadonlyArray<string>; caseSensitive?: boolean }
  | { kind: "symbol"; name: string; path?: string }
  | { kind: "structural"; pattern: string; language: string; glob?: ReadonlyArray<string> }
```

**`rules` and `search` are deliberately orthogonal.** A rule assigns a facet and
every Lens has facets, so a rule can contribute to an Overview Lens too. `search`
only says *how to render*: hit density and a sparse gutter rather than a
partition. The common case — a binary probe where everything is `NONE_FACET`
until a rule says otherwise — is a default the creation path sets up, not a type.

**Open decision #5 resolved: an optional field + an `isSearch()` predicate, not a
distinct type.** `deterministic?: DeterministicKind` is the shipped precedent for
"a Lens whose facets come from the repo rather than the painter", and it already
delivers everything a distinct type was wanted for — a different paint policy
(`supportsExtents`, `aperture.ts:1190`), different persistence (computed, not
stored), picker grouping, and a wire flag on `LensInfo` (`payload.ts:110`) so
clients switch behaviour. Taking the same shape keeps lens
list/select/cycle/edit, the legend and O4's filter working unchanged instead of
forking each of them.

**Span policy — `line` only in v1; `enclosing` is measured and rejected.** A
finder yields hit positions and `span` decides the painted region. `line` (the
matched line(s), and a structural match's full node range) is enough, because a
structural pattern already *chooses* its own extent: match the `catch` clause and
you get the clause, match the call and you get the call.

`enclosing` was meant to widen a point hit to something meaningful. Measured
against this repo's 21 changed lines in `aperture.ts`, the enclosing region is:

| widener | enclosing region | over-paint |
| --- | --- | --- |
| `extentsOf` (next-decl arithmetic) | `layer`, 1833 lines | 87× |
| smallest enclosing structural callable | `finalize`'s generator, 1113–1294 = 182 lines | 8.7× |

Structural is **10× tighter**, so the earlier framing that blamed `extentsOf`'s
regex was directionally right — but 8.7× is still not a useful paint. **The lesson
is that widening is the wrong policy, not that we picked the wrong widener**, which
is exactly what the git-changed probe concluded independently by emitting hunks
unwidened. So `span` ships as `line` alone; if a case later needs widening, it
should resolve through the structural backend with a max-size guard, never through
next-declaration arithmetic.

**The sparse-layer constraint — structural, and easy to get wrong.** Extents
**tile a file exhaustively**, and that byte contract is what `attributeFileBytes`
→ `computeComposition` → the treemap → the Explorer pip all depend on
(`extents.ts:167-220`). Line tags are sparse and do not tile, so **they must
never enter `attributeFileBytes` or `composition`.** They are a separate overlay:

- **Payload:** `lineTags?: Record<fileNodeID, LineTag[]>`, optional and derived at
  the read boundary alongside `extents`. **No `PAYLOAD_VERSION` bump** — the same
  posture that let `composition` widen from directories-only to per-node without
  one (`payload.ts:164-176`). The earlier "S1 takes it to 8" is superseded.
- **Gutter:** `decorationFor(hue)` + `rangesByColor` already builds one
  `vscode.Range(line,0,line,0)` per line (`extension.ts:204-240`) — exactly the
  shape sparse tags need, so S3's extension work is small. Where a file has both,
  **line tags win the lines they cover** and extents paint the rest.
- **TUI / tree chip:** superseded by S3. Marks aggregate as an *overlay* on the
  composition bands (`max` per facet, never additive), carried by a parallel
  `marks` record so they still never touch `attributeFileBytes`. A facet with any
  marked line always keeps a cell.
- **Explorer pip:** dropped — no longer used, and a one-colour budget cannot honour
  "never rounded away" without lying about the file's dominant facet (S3).

**Evaluation and freshness** — derived, memoized in memory, never persisted.
The read boundary (`finalize`) evaluates the active Lens's rules over the window,
memoized per `(lensID, rulesHash, scope)` in the existing per-directory cache; a
file change drops that file's memo (`onFileChanged` already reschedules on
`file.edited` / `file.watcher.updated`); adding or editing a rule drops the
Lens's memo. No new SSE event — `aperture.invalidated` already exists and already
carries the `location` the extension requires (A6).

**Guardrails.** A Search Lens is meant to be sparse and the failure mode is a
loose regex silently painting 30% of the repo. Cap hits per rule
(`MAX_RULE_HITS`, ~500) and rules per Lens (`MAX_RULES`, ~32); over the cap a
rule is stored but reported as too broad rather than painted.

The caps and the error paths are kept **in full**, despite this being a research
prototype rather than a shipping tool — the opposite of the usual prototype trade.
The reason is that the cost of a failure here is not a bug report, it is a lost
participant session: a flooded view or a crashed pass during a study run cannot be
re-run, and unattended participants are exactly who finds the degenerate cases.
Cross-platform handling stays for the same reason, since participants supply the
machines.

**Structural backend — decided: `@ast-grep/napi` (measured, see S0 probes).**
Note tree-sitter's availability is *not* a TUI-vs-editor question: the ~35
grammars in `parsers-config.ts` are fetched by OpenTUI at TUI startup for terminal
syntax highlighting, while rule evaluation runs in the **server** process, where
only `tree-sitter-bash` and `tree-sitter-powershell` wasm ship
(`tool/shell.ts:320-344`) and nothing under `src/aperture/` imports tree-sitter.

`@ast-grep/napi` 0.45.1 is a native NAPI addon whose nine per-platform
`optionalDependencies` mirror **`@parcel/watcher` 2.5.1, which
`packages/opencode` already ships** — so the packaging precedent exists. Measured
on this repo under Bun:

| | |
| --- | --- |
| whole-repo structural pass | **~240–285ms** (vs ripgrep's 67ms) — memoization is mandatory, not optional |
| single 130KB file | **14ms parse + 3ms query** — the file-change path is cheap |
| `.gitignore` | respected (0 `node_modules` hits scanning from the repo root) |
| invalid pattern | throws an actionable message ("Multiple AST nodes are detected"), which the tool returns so the agent self-corrects |

The base package covers TypeScript / Tsx / JavaScript / Html / Css directly.
**Python is included** via `@ast-grep/lang-python` + `registerDynamicLanguage`,
verified working (`requests.get($$$A)` and `def $F($$$P): $$$BODY` both match).
Two costs to note and accept: it is a 0.x package, and its postinstall is blocked
by Bun's default trust policy, so `packages/opencode/package.json` needs a
`trustedDependencies` entry. Study tasks span Python, so the coverage is worth it;
adding further languages (Go, Rust, Java, …) is the same `registerDynamicLanguage`
call against another `@ast-grep/lang-*` package.

**`symbol` is kept, but not for the reason first given.** The initial argument —
"it's ~20 lines over `extentsOf`, and it's what makes `span: enclosing` work" — is
wrong on both halves once `structural` is a dependency anyway and `enclosing` turns
out to be the weak part (below). The real reason is **idiom-blindness**, and it
took measuring this repo to see it.

`aperture.ts` contains 153 `arrow_function`, 60 `function` (expression), 52
`generator_function` and only **8** `function_declaration` nodes — because the
codebase is Effect-shaped: `Effect.fn(...)(function* ...)`, `Effect.gen(function*
...)`, `const x = (...) => ...`. So an agent writing the obvious structural pattern
`function $F($$$P) { $$$B }` to find "all the functions" finds **8 of 265** — a
silent 97% miss. `extentsOf`'s dumb column-0 regex finds `paintStale` by *name*
whether it is a const-arrow, a generator or a declaration, because it never looks
at the right-hand side.

The two finders therefore answer different questions and neither subsumes the
other: **`symbol` = "paint the thing I can name"** (robust, idiom-blind, coarse
span); **`structural` = "paint every instance of this shape"** (precise, exact
ranges, requires knowing the idiom). The hit-count in `lens_mark`'s return value is
what makes the structural hazard survivable — `8 hits` where the agent expected
hundreds is a visible signal to re-ask.

**Known gap, deliberately accepted.** `references` (LSP `textDocument/references`)
is not a v1 finder. `LSP.references` / `workspaceSymbol` / `documentSymbol` do
exist server-side (`lsp/lsp.ts:133-138`) and are the only correct answer to "all
uses of a class/module" through aliased imports and re-exports. Revisit if it
bites in use.

### S2 — `lens_mark` / `lens_unmark`, the rule-installation tools ✅

Supersedes the originally-planned `lens_tag_lines`, whose name no longer
describes what it does. Follows the `lens_*` conventions in
`tool/lens-facet-files.ts:11-28` (Effect `Schema.Struct` params with
`.annotate({description})`, an **inline** description string — no sibling `.txt`),
registered at the four sites in `tool/registry.ts`. `Aperture.Service` is already
in the layer's requirements, so no new layer wiring. **Implemented.**

Deterministic — no model call. It validates the finder, evaluates it once, and
**returns the hit count plus a sample of matched lines**. That return value is the
whole safety mechanism: an agent that writes a bad regex sees `412 lines across 87
files` and narrows it instead of silently repainting the repo.

**Two decisions revised the spec below before it was built.**

**Resolved — Explore agents get NO Lens tools.** The original plan added
`lens_mark` + `lens_list` to the `explore` allow-list and widened the prompt gate
to `explore`. Both cancelled. Three reasons, the first two concrete:

- **`lenses.json` is a plain read-modify-write.** Explore's whole purpose is
  parallel fan-out, and the loser of a race writes stale content — a rule vanishes
  with no error anywhere. (S2 added a per-directory mutex regardless, since the
  `lens` subagent holds the tool and tool calls serialize per *session*, not per
  instance. But fan-out is the case that makes it routine rather than rare.)
- **The facet vocabulary is a whole-task decision.** Concerns cap at 6. Three
  parallel Explores each minting from its own local view produce `retry`,
  `retry-path`, `retries` and burn the budget; only the main agent sees all three
  reports.
- It contradicts `agent/prompt/explore.txt:16` ("Do not create any files, or run
  bash commands that modify the user's system state in any way"), and marking
  repaints a view the user cannot watch from inside a subagent session (G0: the
  sidebar is hidden there outright).

So **Explore proposes and the main agent installs**: a `PROPOSED MARKS` section in
its report (`concern | kind | pattern or name | glob | reason`), conditionally
worded in `explore.txt` since that prompt is shared by every Explore call
including ones with no Aperture involvement. The *format* lives in `explore.txt`
(stable); the *vocabulary* rides in the task prompt (dynamic), which the main agent
has because `system.ts` now injects the Search Lens roster. `createdBy` still
records authorship, so the field already distinguishes `explore` if we ever widen.

This turned out to need **almost no `agent.ts` change**: `build`, `plan` and
`general` inherit `"*": "allow"` and get both tools free; `explore` is deny-all and
gets neither without an edit. The one change is the `lens` agent's allow-list,
which gains `lens_mark`, `lens_unmark` and — the flagged oversight, which is a
**live bug** — `lens_facet_files`, a tool `prompt/lens.txt` has told it to call
twice since it was written but which `Permission.disabled` *removed from the
request*.

**Resolved — a Search Lens is additive, not a binary `hit` probe.** The original
auto-create made two facets, `hit` + `NONE_FACET`. Instead every rule names a
**concern** (`retry-path`, `any-casts`) and either reuses an existing facet or mints
one, up to `MAX_FACETS`. `hit` appears nowhere: the facet name is what the user
reads in the legend, so a generic one says nothing. The base state is that every
extent is `NONE_FACET` — deliberately unmarked "Other" grey (`#8A8A8A`), *not*
unpainted "Non-code" grey (`#444444`), which is a visible difference on every
surface and the honest reading of "nothing marked yet".

The same mechanism therefore applies to an **Overview Lens**: rules overwrite its
extent partition on the lines they cover. What makes that free is a new
`Facet.ruleOnly` flag — a rule-owned facet is excluded from `facetEnumIds` and
`buildSystemPrompt`, so the painter's vocabulary is *literally unchanged* by
minting one and `lens_edit`'s `structural` wipe (a whole-repo repaint of the Lens
and every descendant) is not owed. It also stops the painter assigning `any-casts`
to a file by judgement, which would quietly break the rule's meaning.

O4's legend filter is what makes several loosely-related concerns on one Lens
workable, so **filtering, not unmarking, is the way to hide one**; `lens_unmark`
is for a rule that is actually wrong. Overlapping rules need no resolution
machinery: last-writer-wins in `lens.rules` order, which is what the extension's
`Map<line, hue>` already does.

**Four things only running the code found.**

- **The painter was gated only on `isDeterministic`, never `isSearch`** —
  `aperture.ts` had eleven such sites, including the *foreground* painter that
  fires on every window fetch. Nothing set `search: true` before S2, so the bug was
  latent and S2 is its first producer: activating a Search Lens would have swept the
  whole repo with the model to classify every file into a vocabulary that means
  nothing. Fixed with one shared predicate, `usesPainter(lens)` =
  `!isDeterministic && !isSearch`, so the next alternative facet source has one place
  to be added rather than eleven. `det` is kept *alongside* it in `finalize` because
  it still selects the git-changed hunk branches.
- **`onLensChanged` clears the O4 legend filter.** Routing a mark through it would
  wipe the filter on every mark — the exact mechanism the generalized design rests
  on, and marking is the act most likely to happen *while* a filter is on. Hence
  `onRulesChanged`, which marks the viewed scopes dirty and publishes (with a
  location) and does nothing else: no epoch bump, no sweep wake, no drilled-file
  repaint, since no facet definition moved.
- **`lens_edit` would have silently deleted every marked concern.** Its `facets`
  parameter is the complete replacement list and cannot express `ruleOnly`, so an
  agent editing a Lens — with no way to know a concern was marked on it — would drop
  the lot. `update` now preserves rule-owned facets across an edit (the same
  reasoning that makes `mergeFacets` rewrite `rule.facet` rather than orphan it), and
  `editLens` refuses over-cap with a new `facet-cap` variant on `LensMutation`
  because the two now share the palette. **Caught by a test, not by reading.**
- **`update` also died on zero facets**, which `unmark` makes reachable — so
  renaming a Search Lens whose last concern had been removed would have killed the
  fiber. Relaxed for `isSearch` only.

**Landed:** `Facet.ruleOnly` / `usesPainter` / `finderProblem` / `paintedFacets` /
`concernRoster` / `describeFinder` / `COLOR_NAMES` on `lenses.ts` (still
dependency-free); a per-directory mutex, `writeDocResult`, `createSearch`, `mark`,
`unmark` and `mintRuleId` on `lens-store.ts`; the gate swap, `searchBaseStore`,
the `!paint` extents branch, `onRulesChanged`, `markLens`/`unmarkLens` on
`aperture.ts`; `tool/lens-mark.ts` + `tool/lens-unmark.ts`; rules in `lens_list`'s
output; `Summary.rules` in `study-log.ts`; the roster + `MARKING CONCERNS` +
`DELEGATING EXPLORATION` prompt blocks; and 15 store cases + 6 lenses cases + 2
JSON-Schema snapshots.

**Parameters are a flat struct with a `Schema.Literals` discriminator, not a
`Schema.Union` over the three finder kinds** — and the reason is the
actionable-error requirement, not style. A union mismatch fails during *decode*,
upstream of the tool's `execute`, where the harness reports
`InvalidArgumentsError`'s generic *"Please rewrite the input so it satisfies the
expected schema"* — uninterceptable, and telling the agent nothing. Flat means every
shape mistake lands inside `execute`, where `finderProblem` can say `kind "symbol"
needs "name"` out loud. Corroborating: `Schema.Union` appears in **zero** tool
parameter schemas in this repo, and nested `anyOf` is the weakest part of
JSON-Schema support across providers. The snapshot in
`test/tool/parameters.test.ts` is what makes drift back toward it visible.

**Refusing to store is as important as storing.** `markLens` evaluates *before*
mutating, so a dead rule (uncompilable regex, absent structural backend) or a
0-hit finder persists nothing — no freshly-minted empty concern, no Search Lens
created for a call that then failed. An **over-cap** rule is the deliberate
exception: it stores and is reported as too broad, because the agent needs to be
able to narrow it or drop it by id.

**`activate` defaults to false.** The same prompt block already says *"Never switch
the active Lens (lens_select) without asking the user first"*, and a mark that
hijacked the view would contradict the instruction it is given in the same breath.

**Verified live** against this repo: a Search Lens created with three concerns;
`usesPainter` false and `facetEnumIds` = `["none"]`, so the painter is genuinely
off; three rules evaluated whole-repo in **406ms** (a `pattern` rule marking exact
lines in `github.handler.ts`, a `symbol` rule marking `paintStale`'s whole
222–480 extent in `painter.ts`); the deliberately-loose `const ` rule matching
**46,291 lines**, stored, reported over-cap and painted nowhere; `structural`
refused with the S1b message verbatim; and `unmark` taking a concern's rules with it
and reporting the survivor's recolour.

**Prompt.** `session/system.ts:86` gates the Aperture block on `agent.name ===
"build" || "plan"`. **The gate stays** (see Decision A), extended with three
blocks: the Search Lens roster, `MARKING CONCERNS`, and `DELEGATING EXPLORATION`.
`plan` **may** mark — a mark costs no model call, repaints nothing and changes no
code, and "where does X happen today?" is most of what planning asks — while the
prohibition on `lens_create` in plan mode stands.

**The editor gutter is verified live** — a `pattern` rule over
`packages/opencode/src/**/*` (168 hits, 53 files) paints its concern's colour on
exactly the matched lines. It needed **no extension change**: `extension.ts:247`
puts every tag's hue with no lens gating, courtesy of S0's git-changed probe. So a
mark is readable at line level from S2, while the *aggregate* "where are the hits"
reading stays S3.

*Debugging note for the next person, because it cost a false alarm:* the extension
must be rebuilt and reloaded, or marks appear as the uniform NONE grey of the
extents layer with no concern colour anywhere. That symptom is indistinguishable by
eye from a real emit failure. Check the server first and it is unambiguous — `curl
"…/aperture?drill=<file>&scope=<parent dir>"` and look for `lineTags` carrying a
`hue`; the payload is the seam, so if the hue is there the fault is downstream of
it. The extension's own `Aperture` output channel logs `N extents, N painted, N
line tags` per drill, which answers the same question from the client side.

**The painter gate is verified live**, and the timing is the evidence. `perf/painter.log`'s
last entry is `2026-08-12T16:43:28Z` under `lens: "architecture"` — **two seconds before**
`active.json` was rewritten to the Search Lens at `16:43:30` — and it stayed silent for the
following 13 minutes. Immediately before the switch the painter was demonstrably working: a
`bg pass-start` over 2288 files, real extent paints, and foreground `skip` probes on a steady
5-second cadence (`:53 :58 :03 :08 :13 :18 :23 :24 :28`) that stopped dead at the switch.

The control is what makes it conclusive rather than merely consistent: a `GET
/aperture?drill=…` **during** the silent window returned `lineTags` and `search: true`, so
`finalize` ran under the Search Lens and scheduled nothing. Without `usesPainter` on
`schedulePaint` that single fetch would have queued a foreground pass, and the background
loop would have opened a 2288-file sweep against a Lens whose only facet the painter is not
even allowed to assign.

**The legend filter survives a mark** — verified by hand (suppress a concern, mark another,
the suppression holds). That is the `onRulesChanged`-vs-`onLensChanged` distinction paying
off: routing a mark through `onLensChanged` would have cleared the filter on every mark, and
the failure would have been silent and easy to mistake for the user's own click. Not
unit-testable without the full layer, so the two-gesture manual check is the coverage.

S2 is therefore verified end to end: rule model, store, painter gate, editor gutter, and the
filter interaction.

**Study instrumentation — a first-class requirement, not an afterthought.**
Aperture is a research prototype supporting a paper, and the central claim of the
rule reframe is that *agents write good queries*. That is only arguable with data,
and it is the one thing the existing log cannot infer.

`study-log.ts` already carries most of the load for free: every tool call lands in
the unified `events.jsonl` as `type: "tool"` with an `aperture: true` flag and a
rolling `manifest.json` counter, so `lens_mark` invocation counts need no new code.
Two things it cannot see, both written through the existing
`ApertureStudyLog.record(sessionID, rec)` writer:

- **Rule content + hit count at creation** — finder `kind`, the pattern itself,
  facet, `span`, and how many lines across how many files it matched. This is the
  measure of query *quality*: a rule matching 3 lines and a rule matching 4,000
  are different events, and the difference is invisible in a tool-call count.
- **Rule lifecycle** — created / superseded / rejected-over-cap, with the
  authoring agent. The last field is what evidences whether widening the injection
  to Explore actually changed behaviour, which is otherwise an assumption.

*Not instrumented, deliberately:* hit-set drift across a session, and participant
clicks on painted hits. Both are cheap to add later if the analysis wants them —
drift especially, since re-evaluation already happens on every file change and
would only need the count recorded.

### S3 — Line-level painting in the editor and the View ✅

Extend `sdks/aperture-vscode` to paint line tags as gutter strips. The decoration
machinery is already there (`decorationFor`, per-hue reused decoration types) —
the change is fetching `lineTags` alongside `extents` and painting a Search Lens's
sparse tags rather than an Overview Lens's exhaustive extents. Resolution stays
**server-side against disk content**, which is the established pattern (S0
finding 1), not client-side against the buffer.

The gutter half landed with S0/S2. What remained — and is what S3 built — is the
**aggregate**: until now the top bar and the TreeView chips read only file/extent
facets, so a Search Lens's bar was uniformly "Other" grey and a concern marked onto
an Overview Lens was visible nowhere but the gutter of a file already open. A mark
you have to already be looking at is not a search affordance.

**Resolved — aggregate the facets; drop the positional approximation.** The
original note proposed that a file tile approximate where its hits sit. Cancelled:
it cannot apply to a TreeView glyph (a 16px chip has no room for a position) nor
to a rule-based facet on a regular Overview Lens, so it would have been a fourth
rendering rule for one of three surfaces. Marks aggregate exactly as extents do,
and *where* is already answered — precisely, at line level — by the gutter strip
and the overview-ruler mark the same decoration draws. Magnitude beyond the
guaranteed minimum is proportional, measured in marked lines.

**The one absolute: presence outranks proportion.** A single marked line must show
its facet's colour in the top bar's file *and* directory aggregates and in the
TreeView glyphs, and can never be eliminated by rounding. This is not a nicety —
`aperture.ts` carries **1 marked line in 162 KB** under the probe this was built
against, which is 0.0005%, and every reduction between the evaluator and the
renderer is a chance to round it to nothing.

**Marks are an overlay, never part of `composition`.** The `LineTag` contract holds
unchanged: nothing here enters `attributeFileBytes` or `Composition`, so the byte
partition and its tests are untouched. A parallel `marks` record ships alongside,
and each renderer merges the two at its own band-building step.

**The merge is `max` per facet, never additive.** On an Overview Lens the marked
lines' bytes are *already* counted under whatever facet their extent had, so adding
would count them twice; `max` says "at least this much of this facet is here",
which is also exactly right on a Search Lens, where the composition is entirely
`NONE_FACET` and every mark band is new. The grey remainder absorbs the difference,
so a block's size never changes with what is marked inside it.

**Where the floor lives, and why not on the wire.** Three reductions could each
lose a sliver, and each is handled where the information to handle it exists:

| reduction | rule |
| --- | --- |
| `RuleHit` → `marks` / `m` | **no floor** — raw `lines`/`bytes` counts. Counts roll up by plain summation, so a folder chip needs neither a `t`-style denominator nor a floor, and the drift `t` exists to absorb never arises |
| bytes → integer percent (`model.ts`) | `Math.max(1, round(...))`, the floor already there for O2's per-file reduction — a mark is simply the extreme of the case it was written for |
| share → cells (`allocateCells` / `apportion`) | the existing "every band with weight > 0 keeps a cell" guarantees, unchanged |

`compositionBands` deliberately floors nothing: the floor belongs where the cell
budget is known, or the two would have to agree about a number neither owns.
`blockCells` already floors the cell budget at the band count, which is what keeps
`allocateCells`'s steal loop inside its `cells >= parts.length` guard now that a
mark can add a band the composition does not carry.

**Two things only running it found.**

- **`RuleHit` had no magnitude, and neither finder could be measured after the
  fact.** `patternHits` normalises through `clampAll` while `symbolHits` called
  `clampRanges` inline against content it already held, so a measurement bolted onto
  either would have missed the other or read the file twice. Both now finish through
  one `measure(ranges, content)`, which is also the only place the "bytes include the
  line terminator" convention has to match `fileComposition`'s — and it must, or a
  mark and an extent covering the same lines would report different numbers onto the
  same band.
- **Merging two maps by insertion put NONE *first* on every Search Lens.** The
  composition contributes only `none`, so each concern arrived behind it and the one
  facet the user is not looking for took the whole left edge of every block. The
  VSCode chip never had the bug because it sorts by facet index and `NONE_FACET` is
  the appended last entry — so the fix is to make the TUI sort the same way, by an
  explicit facet-order vocabulary, with NONE ranked last *unconditionally* rather
  than by its position (an empty legend is `[NONE_FACET]`, which would otherwise
  rank it first again). Caught by eye in the running bar, not by a test.

**Landed:** `lines`/`bytes` on `RuleHit` + the shared `measure` (`rules.ts`);
`MarkWeight` + `Payload.marks` (`payload.ts`); `computeMarks`, the `hits` argument
to `computeFacetMapFiles` and the `FacetMapFile` type (`aperture.ts`); `m` on the
facet-map wire schema (`groups/aperture.ts`); `Graph.marks` / `marksOf` /
`facetOrder` and the merged, facet-ordered `compositionBands` (`aperture.tsx`);
`FacetFile.m`, the mark accumulators, `toWeights`, `fileWeights` and
`TreeModel.marks` (`model.ts`); marks on `chipTooltip` and both its callers. No
`PAYLOAD_VERSION` bump — `marks` is optional and derived at the read boundary, the
same posture as `composition` / `extents` / `lineTags`.

**Deliberately untouched: the Explorer pips.** No longer used — the tree chip sits
beside them and is multi-colour, and a one-colour budget could only honour "never
rounded away" by lying about the file's dominant facet.

**Verified live** against this repo under the `failure-modes` Search Lens (2 rules,
202 marked lines across 67 files). In the TUI: the repo-root `packages` block shows
one cell of each concern against grey; `packages/opencode/src` shows a concern cell
on 17 of its directory blocks; and in `src/aperture` the file tile for
**`aperture.ts` — 1 marked line in 162 KB — ends in a single `#D7005F` cell** while
every unmarked tile stays pure grey. Hover reports exact counts
(`… · failures 22 lines · error-throws 8 lines`), and after the ordering fix every
block leads with its concerns and ends with "Other". In VSCode the same file's chip
carries a `#D7005F` mosaic cell and both concerns reach every ancestor folder up to
the root. Legend filtering greys marks in place on both surfaces, area preserved.

**Test gap, stated rather than papered over:** `compositionBands` is module-private
to `aperture.tsx`, which has no test harness, so the band ordering and the `max`
merge are covered on the TUI side only by the live check and by
`allocateCells`'s own cases. The equivalent logic in `model.ts`/`chip.ts` *is* unit
tested. Moving `compositionBands` into `aperture/treemap.ts` (already dependency-free
and unit-tested) would close it, at the cost of plumbing `TREEMAP_METRIC` through.

**The sparse layer is built and verified, via line-level git-changed.** Chosen as
S0's second probe because it needs no rule code and is independently useful: the
whole path — sparse ranges → `lineTags` in the payload → `rangesByColor` in the
extension → both layers coexisting — is exercised before any of S1 exists.

`changedRangesFor` already had exact hunk ranges and `extentChangeFacets` was
widening them up to the enclosing declaration. Emitting them unwidened, at the
file's own magnitude heat, measured on this repo's working tree:

| file | lines actually changed | lines the extent striped | |
| --- | --- | --- | --- |
| `aperture.ts` | 21 | **1833** (`layer`, 344–2176) | 1% |
| `payload.ts` | 30 | 60 | 50% |
| `extents.ts` | 36 | 51 | 71% |

**The `aperture.ts` row is the finding.** `extentsOf` cuts top-level declarations
only, and `layer` is one 1833-line `Layer.effect(...)`, so 21 changed lines striped
87× their extent. That is not a rounding error, it is the gutter saying nothing —
and it is precisely why `extension.ts` had a blanket `if (data.lens?.deterministic)
return undefined`, whose comment blamed git-changed for *"whole-file strips
[burying] the added/removed markers"*. The concept was never the problem; the
widening was. The gate now returns line tags for deterministic Lenses while still
withholding extents, so git-changed paints exactly what changed and Edit
recency/Bus factor (which carry no tags, being file-level) still paint nothing.

Two implementation notes worth keeping:

- **`repaintEditor` resolves a hue per *line*, not ranges per hue.** The layers
  overlap by construction — extents tile, tags mark lines inside them — so a
  `Map<line, hue>` written extents-first and tags-second gives the "line tags win
  the lines they cover" precedence for free and dedupes on the way. Two decorations
  on one line would double-draw the `before` strip.
- **`clampRanges` (`extents.ts`) clamps, sorts and merges.** `git diff` reports
  hunks against the file *git* sees while `finalize` re-reads from disk, so a write
  landing between the two yields a range past the end — a decoration on a line the
  buffer does not have. Adjacent ranges merge because `[4,6]` + `[7,9]` is one
  visual strip, and leaving them split would double the hit count a Search Lens
  reports. 8 cases in `test/aperture/extents.test.ts`.

**Verified:** the composition partition contract still holds across all 19
in-window nodes (painted bytes ≤ subtree bytes, zero violations) with tags present,
and the existing composition/facet-map tests pass untouched — the assertion that
the sparse layer stayed out of `attributeFileBytes`.

### S4 — Legend filtering for Search Lenses

Falls out of **O4**. Less useful on a binary Lens; no extra work expected beyond
confirming it behaves on 2–3 facet Lenses.

### S5 — Open all files carrying a facet

Participants wanted richer interaction with a Lens: from the legend, open every
file with a given facet. Cap at **8–10 files** with a clear indication when the
set was truncated (and, ideally, an ordering rule better than alphabetical —
most hits, or most recently tagged).

Each file should open **scrolled to its first tagged line** — now a derived hit
rather than a stored anchor. Mechanism: extend the existing `tui.file.open` event
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
  aggregate. A file that survives but is *unpainted* is a third case and is kept —
  that's the honest grey the treemap already draws.
  **Superseded by G2+G3:** directories are no longer dropped. They are kept as
  *places* — counted as navigation, contributing no band cells — which honours the
  aggregate-into-an-aggregate argument without discarding most of a turn's
  gathering. Non-source *mutations* are kept too. See G2+G3 for both.
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

### G2 + G3 — The Activity Path ✅

Built together: both are rendering decisions over the same geometry, and the
orientation question turned out to be settled by the step rule rather than
independent of it. **Implemented.**

**A step is either (a) a maximal run of consecutive `survey` entries within one
`(turn, lane)`, or (b) a *single* non-survey entry.** That sentence is the whole
design; everything below follows from it.

- **Only gathering aggregates.** Aggregation asserts the individual acts need not
  be distinguished. That is true of gathering — "the agent looked at this much of
  this mix" is the useful reading, and which of twelve files it opened third is
  not — and false of anything that leaves a lasting effect. A mutation the user
  did not notice is the failure mode this view exists to prevent, so **every
  mutation and every external call is its own step**. Reads → write → reads is
  three steps; reads → *three* writes → reads is five; three edits to one file are
  three steps and are never deduped. Reads inside a run *are* deduped, with a count.
  This supersedes G2's original "reads aggregate, edits expand" with a sharper rule.
- **Mode is three-valued**, not read-vs-mutate: `survey` (reads, directory
  listings, searches), `mutate` (edits, writes, shell commands), `external` (web
  fetches, and any unrecognised tool — MCP registers as `client_tool` with no
  reserved prefix, so it cannot be identified by pattern, and "we don't know what
  it did and it wasn't a repo file" is exactly what external means). `bash` is
  `mutate` because an un-inspectable act is better treated as consequential; note
  it does not need that classification to split a survey run, since under the rule
  *any* non-survey entry already breaks one.
- **Lanes are structural, not cosmetic.** `mergeChildEntries` sorts the whole turn
  by timestamp, so parallel sub-agents arrive interleaved entry-by-entry —
  segmenting that merged sequence would shatter every run into alternating
  one-entry steps. Partitioning by `sessionID` *before* segmenting fixes it, and
  `agent` cannot do that job because two `Explore` agents share a name. This is
  also what delivers G3's "sub-agent activity builds orthogonally" as a
  consequence rather than as separate machinery.
- **One step is exactly one row**, which is what makes G0's budget legible:
  `ACTIVITY_ROWS` steps visible, in a nested `<scrollbox>` pinned to newest.
  The vertical axis is time; horizontal carries composition. A mutate step holds
  exactly one file, so it can afford to *name* it: identity is the whole point of
  showing a mutation. (Bands were originally area-scaled by `sqrt(n / nMax)`, the
  treemap's `scaleCells` idiom; G4.6 made them uniform — see there for why.)

**Resolved — directory reads are back, as places.** G1's justification for
dropping them ("no node, no size, no facet") was wrong on its face, and the real
reason was that G2 aggregates: admitting a directory would fold an aggregate into
an aggregate, so one `read` of `packages/` would outweigh nine real files and
report the mix of code the agent never opened. Both halves are now honoured — a
directory read or a search scope is kept and **counted as navigation** but
contributes **no band cells**, drawn as PLAN's own suggested alternative, a
`⌕ looked around ×n` line. A live session showed 4 of 6 reads were directories, so
the old filter was discarding most of a turn's gathering.

**Resolved — non-source mutations are visible.** `subtreeFor` globs source
extensions only, so a write to `package.json`, a migration, a README or a YAML
config had no node and was silently dropped. That is a class of unambiguously
lasting change, so a *mutation* to any non-ignored repo path is now kept as an
uncoloured file and painted the honest grey the treemap already draws for un-swept
code. *Reads* of such files stay dropped: gathering is aggregated anyway, so an
uncolourable read adds a number without adding a reading. Caught only by running
the thing — every unit test used `.ts` fixtures.

**Orientation: vertical, and the model stays orientation-free.** G3 proposed
building the renderer orientation-agnostic and trying both surfaces; that is
reversed. A row-per-step path is intrinsically vertical, and the top bar's budget
(13 rows, wide, already contending with the Overview Lens) wants a different
shape, so a shared component would collapse to a config blob. Segmentation instead
lives in `aperture/activity-steps.ts` — pure, tested, no Solid/theme/Effect, the
same posture as `treemap.ts` — and a horizontal variant would reuse the model
while writing its own drawing.

**Landed:** `aperture/activity-steps.ts` (lanes + segmentation + `stepWeight`),
`feature-plugins/sidebar/activity.tsx` (order 150, per G0), and
`feature-plugins/system/aperture-colors.ts` — the facet→colour path lifted out of
the top bar so the two surfaces cannot disagree about what a facet looks like,
which the codebase repeatedly warns is how one facet ends up greying to two
different colours. `ActivityEntry` gained `target` and an optional `path`;
`ACTIONS` gained `search`/`run`/`fetch`; `apply_patch` expands to one entry per
patched file from its result metadata (its *input* is patch text with no path
field, so patch edits were a blind spot). No new host slot was needed —
`sidebar_content` already appends by `order`.

**Verified live**, including the two things G1 could not be: cycling the Lens
recolours the bands (green→yellow) while the steps stay byte-identical, and a turn
launching two parallel sub-agents renders as **two indented lanes**, not
interleaved rows — the first time the `task` path has been exercised in this repo.

### G4 — Activity Path affordances

The path works end-to-end, so the next round is information density: it currently
spends a row per step to say very little, and nothing in it is clickable. Five
changes, ordered cheapest-first so the track degrades gracefully if it is cut short.

- [x] **1. Double the height.** `ACTIVITY_ROWS` 10 → 20. G0 sized the budget at 10
  rows on the assumption that a turn's activity was one block; one row per *step*
  spends rows much faster, and the section is the one the user is actually watching.
  Supersedes G0's "fixed `ACTIVITY_ROWS` (default 10), plus a 1-row header = 11
  rows" — the new contribution is 1 header + 20 body + 2 hover = **23 rows**, still
  constant however long the session runs, which is the property that mattered.

- [x] **2. Words, not glyphs.** Retire `●⌕◆■⚙↗` for `Read` / `Search` / `Edit` /
  `Write` / `Run` / `Fetch`. The glyph vocabulary was inherited from the top bar's
  deleted overlay row, where horizontal space was scarce; here it costs a legend the
  user has to hold in their head. Pad the verb to a fixed 6 columns so the bands
  still align into a column — the alignment is what makes two steps comparable at a
  glance, and it is worth more than the 5 columns it costs the band.

- [x] **3. Click a file to open it.** `api.client.tui.openFile({ path })`, exactly
  what a top-bar file tile does (`aperture.tsx` `openFile`), logged through
  `aperture.interaction` as `file.open` so the study log stays complete. Mouse-down
  is already spoken for on aggregated survey rows (see 4), which splits cleanly:
  **a row standing for one file opens it; a row standing for many expands.**

- [x] **4. Expand an aggregated survey row.** Clicking a survey step that stands for
  more than one target expands it in place, indented one level exactly as a
  sub-agent lane is, into one child row per file — name over its own facet band —
  followed by any places it visited. A `▸`/`▾` in the spine marks the affordance,
  the same idiom the sidebar sections already use for their own headers. This is the
  escape hatch the aggregation rule needs: reads collapse because *usually* nobody
  cares which twelve files, but when they do, the answer should be one click away
  rather than a different surface.

- [x] **5. Hover detail, from the titles we already store.** Two muted lines under
  the scrollbox, reserved always so the layout cannot jump, showing detail for the
  hovered row: the files a survey step read, the command a `Run` step actually ran,
  the target of a fetch.

  The natural-language half of this is **free**. Every tool result already persists
  a `title` on its completed part (`session/processor.ts`), and for `bash` that
  title *is* the model-written description the chat renders — `tool/shell.ts` sets
  `title: input.description`, so "Echoes the string smoke-three" is sitting in the
  message store already. Nothing is regenerated and no model is called; `title` just
  has to be carried through the derivation, the wire and the step accumulator, capped
  server-side so a pathological title cannot inflate the response.

**Found by running it.** A `Run` or `Fetch` step drew a full-width bar of untagged grey —
it has no file, so the band had nothing to paint, and a blank grey bar reads as an
*unpainted file* rather than as an act that touched none. Fixed by giving a step with no
files a zero-width band, which frees the row for its title: a shell command now reads
`Run  Echo smoke-three` inline, and the hover line carries the same text in full. This is
the case the G2+G3 live pass missed entirely, because it never exercised bash or fetch.

- [x] **6. Uniform band length.** Every band is now the same width, beginning and
  ending in the same columns on every row. Area-scaling the bar by file count made it
  carry magnitude, but destroyed the reading the band actually exists for: with ragged
  widths two steps' *proportions* cannot be compared by eye, which is the whole point of
  painting a mix rather than a dominant. Magnitude moves entirely to the trailing `×n`,
  which states it exactly instead of implying it. Indented lanes keep the shared right
  edge — the indent eats into the band, not past it.

- [x] **7. A wider verb column, and one that cannot be clipped.** `VERB_COLS` 6 → 8 for a
  clear gap after the longest verb. The actual bug was flexbox: the verb `<text>` had no
  `flexShrink={0}`, so a long path in the sibling label shrank it and clipped the verb —
  "Search" first, being the longest.

- [x] **8. A blank row above the hover line**, so it reads as a caption on the path rather
  than as one more entry in it. Contribution is now 1 header + 20 body + 1 spacer + 2
  hover = 24 rows.

**Not in scope.** Expanding a *mutation* row (it already stands for exactly one file,
so there is nothing to expand), and a keyboard path to any of this — the sidebar is
mouse-only today (G0), and giving one section focus semantics nothing else has would
be a bigger change than the rest of this track combined.

---

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
- **S0 ✅** — the anchoring design was expected to be the long pole of the sprint.
  It turned out to be a non-problem: a tag is a persisted *query*, not a location,
  so S1 shrank from "the hard part" to a schema plus a pure evaluator.

- **S1a ✅** — the rule model. Landed as a schema plus a pure evaluator, exactly the shape
  S0 predicted once anchoring was deleted.

- **S2 ✅** — `lens_mark` / `lens_unmark`. Two decisions revised the spec (Explore gets no
  Lens tools; a Search Lens is additive with named concerns rather than a binary `hit`
  probe), and the build found the missing `isSearch` painter gate — a latent whole-repo
  model sweep that S2 would have been the first thing to trigger.

O4 (already implemented — the diagram above lagged the code) drives O2's Explorer `focus`
as well as the TUI.

**Then:** S3 → S5 in sequence. **S1b** — the ast-grep structural backend — is independent of
that chain and can land whenever the native dependency is convenient to take; nothing
downstream waits on it. S3's first item is now clear: the TUI's aggregate hit-density
reading, since S2 leaves a Search Lens's top bar uniformly "Other" grey while the editor
gutter already paints its marks.

**Track G**: G0 → G1 → G2+G3 landed and the path is working end-to-end. **G4**
(affordances — height, words, click-to-open, expandable survey rows, hover detail) is
next and is ordered cheapest-first so it degrades gracefully if cut short.

**Track C** is done. C1 landed after O1–O4, once O2's tree glyphs made the
cross-surface half of the problem visible.

**Natural split by surface:**
- *Terminal renderer* (`aperture.tsx`, `sidebar/activity.tsx`): O1, O4, G2+G3 ✅
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
| 4 | ~~Line-tag anchoring mechanism (composite recommended)~~ — **decided: there is no anchor.** A tag is a persisted *query* (pattern / symbol / structural), and lines are derived at the read boundary, which is what `extentsOf` already does for extents. A deleted usage loses its paint and a new one gains it, with no edit-tracking, no "lost" state and no durable line-tag store | S0 ✅ |
| 5 | ~~Search Lens as a distinct type on the model vs. a flag~~ — **decided: an optional `search` field + an `isSearch()` predicate**, following the shipped `deterministic?: DeterministicKind` idiom, which already delivers a distinct paint policy, distinct persistence, picker grouping and a wire flag. `rules` is a *separate* field, so a rule can mark facets on any Lens | S0 ✅ |
| 5b | ~~Whether Explore agents can install rules~~ — **decided: no Lens tools for Explore at all.** It proposes (`PROPOSED MARKS` in its report) and build/plan/lens install. `lenses.json` is an unlocked RMW and Explore's purpose is parallel fan-out, so concurrent marks would lose rules silently; the 6-concern vocabulary is a whole-task decision only the main agent can make; and marking repaints a view the user cannot watch from inside a subagent session. Needed almost no permission change — build/plan inherit `"*": "allow"`, explore is deny-all | S2 ✅ |
| 5c | ~~What a light Search Lens starts as (`hit` + NONE_FACET)~~ — **decided: named concerns, minted on demand.** Base state is every extent at `NONE_FACET` ("Other" grey, not unpainted grey); each rule reuses or mints a concern up to `MAX_FACETS`; `hit` appears nowhere. `Facet.ruleOnly` excludes a minted concern from the painter's vocabulary, which is what lets the same mechanism mark an **Overview** Lens without owing `lens_edit`'s whole-repo repaint | S2 ✅ |
| 6 | ~~Activity View in the sidebar vs. the top bar~~ — **decided: the sidebar, vertically, and the orientation experiment is off.** One step is one row, so the path is intrinsically vertical; the top bar's 13-row wide budget wants a different shape and a shared renderer would collapse to a config blob. Segmentation stays pure and orientation-free in `activity-steps.ts`, so a horizontal variant could still reuse the model | G2+G3 ✅ |
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
  `rules.ts` (S1 — search-rule evaluation into sparse line ranges, each measured in
  lines and bytes for S3's aggregates; pure per file, memoized by the caller; rules are
  *written* by S2's `mark`/`unmark` in `lens-store.ts`, never here), `event.ts`,
  `dump.ts`, `study-log.ts`, `activity.ts` (G1 vocabulary + wire
  shapes, dependency-free) + `activity-model.ts` (the pure turn derivation over
  stored messages).
- Tools: `tool/lens-{create,list,select,edit,merge-facets,facet-files,mark,unmark}.ts`,
  registered in `tool/registry.ts` (four sites) **and** gated per agent in
  `agent/agent.ts` — the `lens` agent is `"*": "deny"` plus an allow-list, so a tool absent
  from it is *removed from the request* rather than refused at call time. `build`/`plan`
  inherit `"*": "allow"`; `explore` deliberately sees no lens tool at all (S2).
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
  pointer (`active.json`). Shareable/committable, agent-readable. **Search rules
  join these (S1)** — as a field on the Lens, not a store of their own. Line
  *tags* are never persisted anywhere: they are derived from the rules at the
  read boundary, like `extents`.
  Every mutation is a plain read-modify-write over the one `lenses.json`, now
  serialized by a **per-directory in-process mutex** (`withDoc`, S2). Marks made that
  necessary: they are frequent, several land per turn, and the `lens` subagent holds
  `lens_mark` too — tool calls serialize per *session*, not per instance, so the loser
  of a race would write stale content and lose a rule with no error anywhere.
  `mark`/`unmark` also use `writeDocResult` rather than the swallowing `writeDoc`, since
  reporting "14 lines marked" after a failed write is the worst available outcome. Cross-
  process concurrency remains out of scope, as it always has been here.
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
was a real, hard-to-find bug). **None of S1, S2 or S3 bumps it** — `lineTags` and
S3's `marks` are both optional and derived at the read boundary, the same posture
that let `composition` widen from directories-only to per-node without a bump.
`Facet.ruleOnly` (S2) travels on the Lens definition rather than the payload, and
`LensInfo.search` was already optional from S1, so nothing on the wire changed shape.

Painter gating: **one predicate, `usesPainter(lens)`** in `lenses.ts` —
`!isDeterministic && !isSearch`. Use it at every "should the model run" site (S2 fixed
eleven that tested `isDeterministic` alone, which is how a Search Lens would have swept
the whole repo). Keep `isDeterministic`/`isSearch` for branches that care *which*
alternative facet source it is — `finalize` needs both, since `det` still selects the
git-changed hunk path. `grep -n isDeterministic src/aperture/aperture.ts` is the review
check that a new site did not slip back.

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
