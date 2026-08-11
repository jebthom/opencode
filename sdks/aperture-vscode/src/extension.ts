import * as vscode from "vscode"
import type { ChipLayout } from "./chip"
import * as ops from "./commands"
import { ChipIcons, type IconDelivery } from "./icons"
import { buildModel, type FacetFile, type FacetFiles, type TreeModel } from "./model"
import { ApertureOpenEditors } from "./open-editors"
import { ApertureTree, type Node } from "./tree"

// Aperture — a slim client for the opencode server. It renders function-level Facet
// painting in the editor gutter, a facet-composition file tree, and reveals files the TUI
// drills into.
//
//  - Gutter (extension → server): GET /aperture?drill=<relPath> returns the focused
//    file's `extents` ({name,startLine,endLine,facet?,hue?}); we paint each as a colored
//    left-border strip + overview-ruler mark.
//  - Explorer pips (extension → server): GET /aperture/facets returns every painted file's
//    facet mix in one shot; we decorate each file row with a coloured shade glyph.
//  - Aperture tree (same fetch): our own TreeView in the activity bar, where each row's
//    icon is a generated SVG of the file's whole facet mix — the thing a FileDecoration's
//    one-colour budget cannot express — and folders roll their subtree up. See tree.ts.
//  - Open-in-editor (TUI → server → extension): we listen on the /event SSE stream for
//    `tui.file.open` (open a file) and `tui.directory.reveal` (show a directory in the
//    Explorer). The latter is what connects the TUI's top bar — which since PLAN O1 shows
//    only aggregated directory blocks, no files — to the files themselves.
//
// Connection is manual: the user runs `opencode --port <N>` and points us at it via the
// `aperture.port` / `aperture.host` settings. Everything is an inert no-op when there's
// no workspace folder or the server is unreachable.

const REPAINT_DEBOUNCE_MS = 150
const RECONNECT_DELAY_MS = 2000
// Low-frequency self-heal poll, mirroring the TUI's REFRESH_POLL_MS. Repaints are
// normally pushed via the aperture.invalidated SSE event, but a missed/dropped event
// (or a paint that lands between two editor changes) would otherwise leave stale
// colours on screen; the poll re-fetches the active file so the view stays honest.
const REFRESH_POLL_MS = 5000
// Width of the colored strip painted at the left of each function's lines, and the gap
// between that strip and the line's text (so the strip never sits under the leading chars).
const STRIP_WIDTH_PX = 4
const TEXT_GAP_PX = 4
// The Explorer's facet map is a whole-repo fetch, so it debounces longer than the gutter's
// single-file drill — a burst of invalidations during a paint sweep should cost one refetch.
const FACET_MAP_DEBOUNCE_MS = 400
// ...and it self-heals on a slower cadence than the gutter's REFRESH_POLL_MS. Repaints
// arrive pushed over SSE; this poll only covers a dropped event, and each tick costs the
// server a whole-repo attribution pass (~150KB response on a 2000-file repo), so paying
// that every 5s to almost always find nothing changed is a bad trade.
const FACET_MAP_POLL_MS = 20000
// The tree's file set changes far less often than its colours, and a create/delete storm
// (a branch switch, an install) should cost one re-enumeration rather than hundreds.
const FILE_SET_DEBOUNCE_MS = 500
// Hard ceiling on the enumerated file set. The excludes should keep a normal workspace two
// orders of magnitude below this; the cap exists so a workspace that somehow isn't degrades
// to a truncated tree instead of exhausting the extension host.
const MAX_TREE_FILES = 50000

// Since O3 every file is extent-painted, so a file routinely spans several facets. A
// FileDecoration gives exactly one ThemeColor and a <=2-char badge rendered in that colour,
// so a multi-coloured pip row isn't available: instead the colour says *which* facet and the
// glyph says *how much* of the file it is. A single-facet file reads as a solid pip; a
// grab-bag file reads as a faint one, at identical width.
const SHADES: ReadonlyArray<{ min: number; glyph: string }> = [
  { min: 85, glyph: "█" },
  { min: 60, glyph: "▓" },
  { min: 35, glyph: "▒" },
  { min: 0, glyph: "░" },
]

// A facet's `hue` is either a hex string (`#RRGGBB`, user/deterministic palettes) or an
// opencode theme-role token (the built-in Architecture Lens and the `none`/grey facets).
// The TUI resolves tokens against its loaded theme; we can't, so we map each known token to
// the nearest VSCode ThemeColor so the colour still adapts to the editor's theme. Unknown
// tokens resolve to undefined and are skipped (not painted).
// The hue a facet takes while it is filtered out of the legend (PLAN O4). The same token
// chip.ts falls back to, so the tree chip, the Explorer pip and the gutter stripe all grey
// to one colour — and one the TUI also reads as "off" rather than as a facet of its own.
const SUPPRESSED_HUE = "textMuted"

const THEME_ROLE_COLORS: Record<string, string> = {
  info: "charts.blue",
  success: "charts.green",
  warning: "charts.yellow",
  accent: "charts.purple",
  error: "charts.red",
  textMuted: "descriptionForeground",
  border: "descriptionForeground",
}

// One decoration type per hex color, created lazily and reused. Cleared (set to an empty
// range list) on every repaint for colors not present this pass, so stale strips vanish.
const decorationByColor = new Map<string, vscode.TextEditorDecorationType>()

let sse: { abort: () => void } | undefined
let repaintTimer: ReturnType<typeof setTimeout> | undefined
let pollTimer: ReturnType<typeof setInterval> | undefined
// Module-scoped (like the two above) so deactivate can clear them.
let facetMapTimer: ReturnType<typeof setTimeout> | undefined
let facetMapPollTimer: ReturnType<typeof setInterval> | undefined
let fileSetTimer: ReturnType<typeof setTimeout> | undefined
// True while a repaint's fetch is outstanding, so the poll skips a tick rather than
// stacking refetches behind a slow server walk.
let repainting = false

export function activate(context: vscode.ExtensionContext) {
  const out = vscode.window.createOutputChannel("Aperture")
  context.subscriptions.push(out)
  const log = (msg: string) => out.appendLine(`${new Date().toISOString().slice(11, 19)} ${msg}`)
  log("activated")

  const config = () => vscode.workspace.getConfiguration("aperture")
  const baseUrl = () => `http://${config().get<string>("host", "127.0.0.1")}:${config().get<number>("port", 4096)}`
  const workspaceFolder = () => vscode.workspace.workspaceFolders?.[0]
  const directory = () => workspaceFolder()?.uri.fsPath

  // ---- gutter painting -----------------------------------------------------

  function resolveHue(hue: string): string | vscode.ThemeColor | undefined {
    if (hue.startsWith("#")) return hue
    const role = THEME_ROLE_COLORS[hue]
    return role ? new vscode.ThemeColor(role) : undefined
  }

  // Keyed by the raw hue string (hex or token), so a token and a hex never collide and
  // each maps to one reused decoration type.
  function decorationFor(hue: string): vscode.TextEditorDecorationType {
    let deco = decorationByColor.get(hue)
    if (!deco) {
      const color = resolveHue(hue)
      // A colored block rendered *before* each line's text rather than a left border:
      // the block reserves its own width + a right-margin gap, so the text is pushed
      // clear of it instead of sitting underneath (as a border does).
      deco = vscode.window.createTextEditorDecorationType({
        before: {
          contentText: "",
          backgroundColor: color,
          width: `${STRIP_WIDTH_PX}px`,
          height: "100%",
          margin: `0 ${TEXT_GAP_PX}px 0 0`,
        },
        overviewRulerColor: color,
        overviewRulerLane: vscode.OverviewRulerLane.Left,
      })
      decorationByColor.set(hue, deco)
    }
    return deco
  }

  type Extent = { name: string; startLine: number; endLine: number; facet?: string; hue?: string }
  type GraphNode = { id: string; path: string; kind: string }

  // The colour a function's stripe paints, honouring the legend filter (PLAN O4).
  //
  // `ex.hue` is the server's own resolution of `ex.facet`, made before it knew about the
  // filter, so a suppressed facet would still arrive in its Lens colour. Preferring the
  // filtered legend — which is the same table with suppressed facets swapped to the muted
  // role — is what greys the gutter alongside the chips. `ex.hue` remains the fallback for
  // an extent whose facet isn't in the legend (notably "Other").
  function hueForExtent(ex: Extent): string | undefined {
    if (ex.facet === undefined) return ex.hue
    return facetLegend.find((e) => e.facet === ex.facet)?.color ?? ex.hue
  }

  async function fetchExtents(relPath: string): Promise<Extent[] | undefined> {
    const dir = directory()
    if (!dir) return undefined
    // Scope the window at the file's parent dir so the file's node is in-window and the
    // server attaches its extents (a root-scoped window omits deep files).
    const scope = relPath.split("/").slice(0, -1).join("/")
    const url = `${baseUrl()}/aperture?drill=${encodeURIComponent(relPath)}&scope=${encodeURIComponent(scope)}`
    const res = await fetch(url, { headers: { "x-opencode-directory": dir } })
    if (!res.ok) return undefined
    const data = (await res.json()) as {
      nodes?: GraphNode[]
      extents?: Record<string, Extent[]>
      lens?: { id: string; deterministic?: boolean }
    }
    // Deterministic built-in Lenses (Changed since last commit, Edit recency, Bus factor)
    // don't paint the gutter: git-changed duplicates VSCode's own diff gutter (and its
    // whole-file strips bury the added/removed markers), and the other two are file-level.
    // Returning undefined here both skips painting and clears any strips left from a
    // previously-active painted Lens.
    if (data.lens?.deterministic) return undefined
    // `extents` is keyed by file node id and carries EVERY drilled file still in the
    // window — not just the one we asked for. Select by this file's node id; taking the
    // first entry would paint a sibling's extents onto the current file.
    const node = data.nodes?.find((n) => n.kind === "file" && n.path === relPath)
    if (!node) return undefined
    return data.extents?.[node.id]
  }

  // Fetch one editor's file extents and (re)apply its gutter. The fetch also drills the
  // file server-side, so painting a visible editor is what schedules its server paint.
  async function repaintEditor(editor: vscode.TextEditor) {
    if (editor.document.uri.scheme !== "file") return
    const relPath = vscode.workspace.asRelativePath(editor.document.uri, false).replace(/\\/g, "/")

    let extents: Extent[] | undefined
    try {
      extents = await fetchExtents(relPath)
    } catch (e) {
      log(`fetch FAILED for ${relPath}: ${String(e)} (baseUrl=${baseUrl()} dir=${directory()})`)
      return
    }
    const painted = (extents ?? []).filter((e) => {
      const hue = hueForExtent(e)
      return hue !== undefined && resolveHue(hue) !== undefined
    }).length
    log(`drill ${relPath}: ${extents?.length ?? 0} extents, ${painted} painted`)

    // Group line ranges by hue; a painted function carries a hue we can resolve (hex or
    // a known theme-role token). Functions with no/unresolvable hue stay unpainted. One
    // range per line: the `before` strip only renders at a range's start, so a multi-line
    // range would leave every line but the first un-striped.
    const rangesByColor = new Map<string, vscode.Range[]>()
    for (const ex of extents ?? []) {
      const hue = hueForExtent(ex)
      if (!hue || resolveHue(hue) === undefined) continue
      const list = rangesByColor.get(hue) ?? []
      for (let line = ex.startLine - 1; line <= ex.endLine - 1; line++) {
        list.push(new vscode.Range(line, 0, line, 0))
      }
      rangesByColor.set(hue, list)
    }

    // Apply present colors and clear any cached color absent this pass.
    for (const color of new Set([...decorationByColor.keys(), ...rangesByColor.keys()])) {
      editor.setDecorations(decorationFor(color), rangesByColor.get(color) ?? [])
    }
  }

  // Repaint every *visible* editor, not just the focused one. A file you're reading in a
  // split pane — or while focus sits in the TUI/terminal — is visible but is not
  // `activeTextEditor`; painting only the active editor is why such a file stayed grey
  // until you clicked into it (the click made it active, firing the first drill). Driving
  // off `visibleTextEditors` makes the invariant "visible ⇒ drilled-and-painted", so the
  // click stops mattering. `repainting` gates the poll so it skips rather than stacking.
  async function repaintVisible() {
    repainting = true
    try {
      await Promise.all(vscode.window.visibleTextEditors.map((e) => repaintEditor(e)))
    } finally {
      repainting = false
    }
  }

  function scheduleRepaint() {
    if (repaintTimer) clearTimeout(repaintTimer)
    repaintTimer = setTimeout(() => void repaintVisible(), REPAINT_DEBOUNCE_MS)
  }

  // Pre-warm the server's function paint for open-but-hidden tabs. `repaintVisible` already
  // drills + paints every visible editor; warming covers the tabs you have open but aren't
  // looking at, so the server has already function-painted them and switching to one shows
  // colours immediately instead of the drill → wait → watch-the-colours-appear beat. Same
  // drill GET the gutter uses, result discarded (a hidden tab has no editor to decorate; the
  // fetch's side effect — scheduling the server-side paint — is the whole point). Deduped via
  // `warmed`: once per file per connection, since real edits repaint server-side and the
  // SSE/poll refresh the gutter.
  const warmed = new Set<string>()
  async function warmOpenTabs() {
    // Visible tabs are handled by repaintVisible; warm only the hidden ones.
    const visible = new Set(
      vscode.window.visibleTextEditors
        .filter((e) => e.document.uri.scheme === "file")
        .map((e) => vscode.workspace.asRelativePath(e.document.uri, false).replace(/\\/g, "/")),
    )
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input
        if (!(input instanceof vscode.TabInputText) || input.uri.scheme !== "file") continue
        const rel = vscode.workspace.asRelativePath(input.uri, false).replace(/\\/g, "/")
        if (visible.has(rel) || warmed.has(rel)) continue
        warmed.add(rel)
        try {
          await fetchExtents(rel)
        } catch {
          warmed.delete(rel) // transient failure — allow a retry on the next tab change
        }
      }
    }
  }

  // ---- Explorer pips -------------------------------------------------------

  // Whole-repo file → facet mix, refetched in one request rather than per file: the Explorer
  // asks us to decorate every visible row, and a fetch per row would be thousands of calls.
  // Each entry is `{t, w}` — the file's attributed byte total and its mix as percentages of
  // it. The pips only need `w`; `t` is what lets the tree roll a directory up by bytes
  // rather than by file count, so its folder chips agree with the TUI's treemap.
  let facetMap = new Map<string, FacetFile>()
  // The legend exactly as the server sent it, and the legend everything actually paints
  // from. They differ only by the filter: `facetLegend` is `facetLegendRaw` with every
  // suppressed facet's colour swapped for the muted role (see applyFilter).
  //
  // One derivation, rather than a `suppressed` set threaded through every paint site: a
  // facet becomes a colour in exactly one place, so filtering is a property of the palette
  // and each surface — chips, pips, gutter — greys without knowing the filter exists. Raw is
  // kept because un-filtering has to restore the true hue without a refetch.
  let facetLegendRaw: LegendEntry[] = []
  let facetLegend: LegendEntry[] = []
  let facetIds: string[] = []
  // The active Lens's id. Only the pips consult it (to stand down for git-changed); the
  // tree paints every Lens.
  let lensId: string | undefined
  // Facets the user has toggled off (PLAN O4). One set drives every surface: the tree greys
  // those cells in place, the Explorer pips fall through to each file's largest surviving
  // facet, and the gutter greys their extents.
  //
  // The server owns it — the TUI's legend and the aperture.filterFacets command both POST to
  // it, and it comes back to us over SSE and on the facet map. This is a local mirror of that
  // value, never the authority, so nothing here cares which surface the user clicked.
  const suppressedFacets = new Set<string>()
  // Outstanding filter POSTs of ours. While non-zero the facet map's `suppressed` is ignored
  // (a response requested before our POST would carry the pre-click filter) — see fetchFacetMap.
  let filterPosts = 0
  let fetchingFacetMap = false
  // Guards the file-set enumeration the same way `fetchingFacetMap` guards the map fetch: a
  // watcher burst must not stack whole-workspace searches on top of each other.
  let fetchingFileSet = false
  // The last response body, verbatim. The server emits files in a stable order, so an
  // unchanged repo re-serializes byte-identically and this comparison is exact — which is
  // what lets the self-heal poll run without touching the UI. See the flicker note below.
  let facetMapRaw: string | undefined

  // Firing `undefined` means "every decoration changed": VSCode drops its whole cache and
  // re-queries the provider for every visible row, and the rows paint bare for the round
  // trip — a visible full-tree flicker. So we fire a URI list whenever we can, and reserve
  // `undefined` for the cases where every row really did change meaning (a new Lens, a
  // filter change, pips switched off).
  const decorationsChanged = new vscode.EventEmitter<vscode.Uri[] | undefined>()

  async function fetchFacetMap() {
    const dir = directory()
    if (!dir) return
    fetchingFacetMap = true
    try {
      const res = await fetch(`${baseUrl()}/aperture/facets`, { headers: { "x-opencode-directory": dir } })
      if (!res.ok) return
      const raw = await res.text()
      // The common case by far: the poll ticked and nothing has been repainted since. Bailing
      // here — before parsing, before firing — is what keeps the tree still between real
      // changes instead of strobing on every poll interval.
      if (raw === facetMapRaw) return
      facetMapRaw = raw
      const data = JSON.parse(raw) as {
        lens?: { id: string; legend?: LegendEntry[] }
        facets?: string[]
        files?: Record<string, FacetFile>
        suppressed?: string[]
      }
      const next = new Map(Object.entries(data.files ?? {}))
      // A different Lens (or vocabulary) re-colours every row at once, so a targeted list
      // would be wrong as well as pointless — that is a genuine full invalidation.
      const relit = JSON.stringify(facetIds) !== JSON.stringify(data.facets ?? [])
      const changed = relit ? undefined : changedUris(facetMap, next)
      const previous = facetMap
      facetMap = next
      facetLegendRaw = data.lens?.legend ?? []
      facetIds = data.facets ?? []
      lensId = data.lens?.id
      // Adopt the server's filter. This is the self-heal path: the SSE event is what makes a
      // click feel instant, but a reconnect (or an extension that started after the filter
      // was set) missed it, and this fetch is where that gets put right. The server clears
      // the set on a Lens switch, so a filter never leaks into a vocabulary that lacks it.
      //
      // Skipped while our own POST is in flight: this response may have been requested
      // before it, in which case it carries the pre-click filter and would visibly un-grey
      // what the user just clicked, only for the echo to re-grey it a moment later.
      if (filterPosts === 0) {
        suppressedFacets.clear()
        for (const facet of data.suppressed ?? []) suppressedFacets.add(facet)
        refreshLegend()
      }
      // The tree colours from the same fetch, and unlike the pips it has no reason to skip
      // any Lens — so it is rebuilt before the early-out below.
      rebuildModel()
      if (changed && changed.length === 0) return
      log(`facet map: ${next.size} files (was ${previous.size}), ${changed ? `${changed.length} rows` : "all rows"}`)
      decorationsChanged.fire(changed)
    } catch (e) {
      log(`facet map fetch FAILED: ${String(e)} (baseUrl=${baseUrl()} dir=${dir})`)
    } finally {
      fetchingFacetMap = false
    }
  }

  // The files whose pip actually differs between two maps — added, removed, or re-weighted.
  // Only these rows need re-querying, so a paint sweep touching a handful of files repaints
  // a handful of rows instead of blanking the tree.
  function changedUris(before: Map<string, FacetFile>, after: Map<string, FacetFile>) {
    const folder = workspaceFolder()
    if (!folder) return undefined
    const key = (entry: FacetFile | undefined) => (entry ? JSON.stringify(entry.w) : "")
    const paths = new Set([...before.keys(), ...after.keys()])
    return [...paths]
      .filter((p) => key(before.get(p)) !== key(after.get(p)))
      .map((p) => vscode.Uri.joinPath(folder.uri, p))
  }

  function scheduleFacetMap() {
    if (facetMapTimer) clearTimeout(facetMapTimer)
    facetMapTimer = setTimeout(() => void fetchFacetMap(), FACET_MAP_DEBOUNCE_MS)
  }

  const decorationProvider: vscode.FileDecorationProvider = {
    onDidChangeFileDecorations: decorationsChanged.event,
    provideFileDecoration(uri) {
      if (uri.scheme !== "file") return undefined
      // Off by default. A FileDecoration is not scopable to a view — it applies to every
      // TreeItem carrying this resourceUri, ours included — and it tints the filename as
      // well as adding the badge. Once the tree's chip is showing the whole mix, that is a
      // second, coarser answer to the same question competing with it in the same row.
      if (!config().get<boolean>("explorerPips", false)) return undefined
      // "Changed since last commit" is the one Lens the pips suppress: VSCode already
      // decorates modified files from its own SCM provider, and ours would compete with that
      // badge for the same slot to say the same thing. The other deterministic built-ins
      // (edit recency, bus factor) are file-level by nature and are exactly what a file tree
      // wants to show, so — unlike the gutter — we do NOT skip all deterministic Lenses.
      // Note this is a *pips* rule, not a data rule: the Aperture tree paints git-changed
      // happily, because its rows have their own icon slot and contend with nothing.
      if (lensId === "git-changed") return undefined
      // Files only. A folder decoration would need its own subtree rollup and would contend
      // with git's folder badges; folder aggregation is the Aperture tree's job (and the
      // TUI top bar's), where there is room to show a composition rather than one colour.
      const entry = facetMap.get(vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/"))
      // No entry = unpainted, non-source, or the map hasn't loaded yet. Returning undefined
      // leaves the row plain; the refresh event makes VSCode ask again once it has.
      if (!entry?.w.length) return undefined
      const deco = decorationFrom(entry.w, facetLegend, facetIds, suppressedFacets)
      if (!deco) return undefined
      return new vscode.FileDecoration(deco.badge, deco.tooltip, deco.color)
    },
  }

  // ---- Aperture tree -------------------------------------------------------

  // The visible file set, and the trie + rollup built from it. Two independent inputs — the
  // file set (from VSCode) and the facet map (from the server) — so the model is rebuilt
  // whenever either lands rather than being owned by one of them.
  let filePaths: string[] = []
  let model: TreeModel = buildModel([], {}, 0)
  // Directories the user created through the tree that have no files in them yet. The trie
  // derives directories from file paths, so without this a new empty folder would vanish
  // the moment it was made. Cleared when a re-enumeration finds them populated.
  const newDirs = new Set<string>()

  const icons = new ChipIcons(context.globalStorageUri, config().get<IconDelivery>("tree.iconDelivery", "data"))
  // Everything the two views need to draw a chip. They ask through these functions rather
  // than being handed values, so a Lens switch or a filter change is a refresh, not a
  // re-wiring.
  const chipContext = {
    model: () => model,
    facets: () => facetIds,
    legend: () => facetLegend,
    suppressed: (): ReadonlySet<string> => suppressedFacets,
    layout: () => config().get<ChipLayout>("tree.chipLayout", "mosaic6"),
    icons,
  }

  const fileOps: ops.FileOpsContext = {
    root: () => workspaceFolder()?.uri,
    rememberDir: (rel) => newDirs.add(rel),
    refresh: () => fetchFileSet(),
    // A file operation the user just performed from this view — show them the result even
    // if they somehow triggered it with the view hidden.
    reveal: (rel) => void revealInTree(rel, { show: true }),
  }

  const tree = new ApertureTree({
    ...chipContext,
    root: () => workspaceFolder()?.uri,
    move: (sources, targetDir) => ops.move(fileOps, sources, targetDir),
  })
  const treeView = vscode.window.createTreeView("aperture.fileTree", {
    treeDataProvider: tree,
    dragAndDropController: tree,
    showCollapseAll: true,
    canSelectMany: true,
  })
  // Cleared by the first successful enumeration. Without it the view is silently blank
  // while the search runs, which reads as "broken" rather than "not ready".
  treeView.message = "Enumerating files…"

  const openEditors = new ApertureOpenEditors({
    ...chipContext,
    relative: (uri) => vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/"),
  })
  const openEditorsView = vscode.window.createTreeView("aperture.openEditors", { treeDataProvider: openEditors })

  function rebuildModel() {
    const files: FacetFiles = {}
    for (const [path, entry] of facetMap) files[path] = entry
    model = buildModel(filePaths, files, facetIds.length, [...newDirs])
    tree.refresh()
    openEditors.refresh()
  }

  // Which rows a command should act on. VSCode passes the clicked item first and the full
  // selection second, but only when the click was inside the selection — a right-click on
  // an unselected row must act on that row alone, not on whatever was selected before.
  function targets(node: Node | undefined, selected: Node[] | undefined): Node[] {
    if (!node) return treeView.selection.slice()
    return selected && selected.some((n) => n.rel === node.rel) ? selected : [node]
  }

  // What the tree must NOT enumerate.
  //
  // `findFiles(include, undefined)` applies `files.exclude` but explicitly **not**
  // `search.exclude` (@types/vscode 1.125, index.d.ts:14093) — and the default
  // `files.exclude` covers `.git`/`.DS_Store` and says nothing about `node_modules`. On this
  // repo that is the difference between ~6k files and ~154k, of which ~147k are
  // dependencies. That is not merely slow: every watcher event re-enumerated the lot into a
  // fresh URI array and a fresh trie, and the churn was enough to OOM the remote extension
  // host. So both settings are merged into one explicit exclude.
  function excludePattern(): string | undefined {
    const globs = new Set<string>()
    for (const section of ["files", "search"]) {
      const configured = vscode.workspace.getConfiguration(section).get<Record<string, unknown>>("exclude") ?? {}
      // A value is `true`, `false`, or a `{ when: … }` sibling condition. Only unconditional
      // `true` entries are taken: a conditional exclude is not worth evaluating here, and
      // showing a file the search box would hide is a far smaller problem than the reverse.
      for (const [glob, on] of Object.entries(configured)) if (on === true) globs.add(glob)
    }
    return globs.size === 0 ? undefined : `{${[...globs].join(",")}}`
  }

  // The same exclusions as literal directory names, for the watcher — which fires on paths
  // rather than on a search, so it needs a cheap segment test rather than a glob match.
  // A leading `**/` plus a literal name covers the entries that matter; anything with
  // wildcards left in it is skipped rather than pulling in a glob dependency for what is
  // only a scheduling hint.
  function excludedSegments(): Set<string> {
    const names = new Set<string>()
    for (const glob of (excludePattern() ?? "").replace(/^\{|\}$/g, "").split(",")) {
      const name = glob.replace(/^\*\*\//, "").replace(/\/\*\*$/, "")
      if (name !== "" && !/[*?{}[\]]/.test(name)) names.add(name)
    }
    return names
  }

  // The tree's file set, enumerated in one search rather than by walking readDirectory —
  // which would mean reimplementing `files.exclude` glob matching by hand.
  //
  // Two knock-on differences from the Explorer, both accepted: an empty directory only
  // appears if something names it (directories are derived from file paths — hence
  // `newDirs`, so a folder you just created is not invisible), and `search.exclude` applies
  // on top of `files.exclude`.
  async function fetchFileSet() {
    const folder = workspaceFolder()
    if (!folder) return
    if (fetchingFileSet) return
    fetchingFileSet = true
    try {
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, "**/*"),
        excludePattern(),
        // A hard ceiling as well as the excludes: a misconfigured workspace should degrade
        // to a truncated tree, never to an extension host that runs out of memory.
        MAX_TREE_FILES,
      )
      filePaths = uris.map((uri) => vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/")).sort()
      // A remembered empty directory that now holds a file is derivable again, so forget it
      // rather than carrying a duplicate for the rest of the session.
      for (const rel of [...newDirs]) if (filePaths.some((path) => path.startsWith(`${rel}/`))) newDirs.delete(rel)
      log(`file set: ${filePaths.length} files`)
      treeView.message =
        filePaths.length >= MAX_TREE_FILES
          ? `Showing the first ${MAX_TREE_FILES} files. Narrow files.exclude / search.exclude to see the rest.`
          : undefined
      rebuildModel()
    } catch (e) {
      log(`file set FAILED: ${String(e)}`)
    } finally {
      fetchingFileSet = false
    }
  }

  function scheduleFileSet() {
    if (fileSetTimer) clearTimeout(fileSetTimer)
    fileSetTimer = setTimeout(() => void fetchFileSet(), FILE_SET_DEBOUNCE_MS)
  }

  // Whether a watcher event is worth a re-enumeration. `files.watcherExclude` already keeps
  // most dependency churn out of the watcher, but it is a different setting from the two
  // above and does not have to agree with them — so a create inside an excluded directory
  // can still arrive, and re-enumerating for a file the tree will never show is pure cost.
  function watchedPath(uri: vscode.Uri): boolean {
    const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/")
    const excluded = excludedSegments()
    return !rel.split("/").some((segment) => excluded.has(segment))
  }

  // Reveal a path in the tree.
  //
  // Two callers with different standing, hence `show`. A TUI navigation is an explicit "go
  // look at this", so it opens the view if it is closed; auto-reveal follows the active
  // editor and must never yank the sidebar open behind you, so it stays put unless the view
  // is already on screen.
  //
  // `expand` is the thing the built-in Explorer could not do at all: `TreeView.reveal` takes
  // it directly, whereas ExplorerView.selectResource stops *at* the target and leaves it
  // shut. That whole workaround is now gone (see revealDirectory).
  async function revealInTree(rel: string, opts: { expand?: boolean; show?: boolean } = {}) {
    if (!treeView.visible && !opts.show) return
    const node = tree.find(rel)
    if (!node) {
      log(`tree reveal skipped: ${rel} is not in the tree`)
      return
    }
    try {
      // `focus` is deliberately left off. The Explorer version had no say — revealInExplorer
      // always focuses — and the old comment accepted that it dragged the cursor out of the
      // terminal running the TUI. Selecting without focusing shows you the directory and
      // leaves you typing where you were.
      await treeView.reveal(node, { select: true, expand: opts.expand || undefined })
    } catch (e) {
      log(`tree reveal FAILED for ${rel}: ${String(e)}`)
    }
  }

  function revealActiveFile() {
    if (!config().get<boolean>("tree.autoReveal", true)) return
    const uri = vscode.window.activeTextEditor?.document.uri
    if (!uri || uri.scheme !== "file") return
    void revealInTree(vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/"))
  }

  // ---- facet filter (PLAN O4) ----------------------------------------------

  // Toggle facets off. Checked = shown; unchecking is what greys a facet, and the picker
  // opens with the current filter already applied so it reads as state rather than as a
  // fresh question each time.
  //
  // The picker is the sibling of the TUI's legend click, not a second filter: it posts the
  // set the user chose and lets the server's echo apply it, so both surfaces agree even
  // though only one of them was touched.
  async function pickFacetFilter() {
    if (facetLegendRaw.length === 0) {
      vscode.window.showInformationMessage("Aperture: no active Lens to filter by.")
      return
    }
    const picked = await vscode.window.showQuickPick(
      facetLegendRaw.map((entry) => ({
        label: entry.label,
        facet: entry.facet,
        picked: !suppressedFacets.has(entry.facet),
      })),
      {
        canPickMany: true,
        title: "Aperture: filter facets",
        placeHolder: "Unchecked facets grey out here, in the editor gutter, and in the opencode top bar",
      },
    )
    // Escape leaves the filter alone; deliberately unchecking everything does not.
    if (picked === undefined) return
    const shown = new Set(picked.map((item) => item.facet))
    void setFacetFilter(facetLegendRaw.filter((e) => !shown.has(e.facet)).map((e) => e.facet))
  }

  // Hand a new filter to the server, which holds it for every surface and echoes it back as
  // aperture.facets.filtered. Applied locally first: the round trip is short but not free,
  // and a filter click should land on the next frame.
  async function setFacetFilter(facets: string[]) {
    const dir = directory()
    suppressedFacets.clear()
    for (const facet of facets) suppressedFacets.add(facet)
    applyFilter()
    if (!dir) return
    filterPosts++
    try {
      await fetch(`${baseUrl()}/aperture/facet-filter`, {
        method: "POST",
        headers: { "x-opencode-directory": dir, "Content-Type": "application/json" },
        body: JSON.stringify({ facets }),
      })
    } catch (e) {
      // The local paint stands. The next facet-map fetch reconciles us with whatever the
      // server actually holds, so a dropped POST self-corrects rather than sticking.
      log(`facet filter POST FAILED: ${String(e)}`)
    } finally {
      filterPosts--
    }
  }

  // Re-derive the painted legend from the raw one + the filter. The single place a facet's
  // colour is decided, so every surface below greys by reading its colour as usual.
  function refreshLegend() {
    facetLegend = facetLegendRaw.map((entry) =>
      suppressedFacets.has(entry.facet) ? { ...entry, color: SUPPRESSED_HUE } : entry,
    )
  }

  // One filter, every surface. Nothing is refetched — the server ships each file's whole mix
  // precisely so this stays a client-side re-render.
  function applyFilter() {
    log(`filter: ${suppressedFacets.size} of ${facetLegendRaw.length} facets suppressed`)
    refreshLegend()
    tree.refresh()
    openEditors.refresh()
    // A genuine full invalidation: every row's answer changed at once.
    decorationsChanged.fire(undefined)
    // The gutter reads the legend too, and unlike the tree it isn't driven by an event —
    // repaint the editors the user can actually see. Straight through, not debounced: this
    // is a click, not a paint sweep.
    void repaintVisible()
  }

  // ---- open-in-editor via SSE ----------------------------------------------

  async function revealFile(relPath: string) {
    const folder = workspaceFolder()
    if (!folder) return
    const uri = vscode.Uri.joinPath(folder.uri, relPath)
    try {
      await vscode.window.showTextDocument(uri, { preview: false })
    } catch {
      // file may have moved/been deleted — ignore.
    }
    void revealInTree(relPath, { show: true })
  }

  // Open a directory in the Aperture tree, so it shows what the TUI's top bar has navigated
  // into. This is the bar's link into the editor now that it no longer lists files (PLAN
  // O1): the bar aggregates, the tree enumerates.
  //
  // This used to target the built-in Explorer and was three times this length, because
  // `revealInExplorer` cannot open the folder you give it. ExplorerView.selectResource walks
  // *down* from the root with `while (item.resource !== resource) await tree.expand(item)`,
  // so it expands every ancestor and stops the moment it reaches the target — revealing
  // `src` selected it and left it shut. The workaround was to reveal an arbitrary *child*
  // (so `src` became an ancestor and the same loop opened it), which in turn needed a
  // readDirectory and a hand-rolled `files.exclude` matcher to pick a child the Explorer was
  // not hiding. `TreeView.reveal` takes `expand` as a parameter, so all of that is gone.
  async function revealDirectory(relPath: string) {
    if (!workspaceFolder()) return
    // The TUI's root scope is the empty string. There is no node for the root — it *is* the
    // tree — so the useful response is to bring the view forward and leave it at that.
    if (relPath === "") {
      await vscode.commands.executeCommand("workbench.view.extension.aperture")
      log("reveal <root>")
      return
    }
    await revealInTree(relPath, { expand: true, show: true })
    log(`reveal ${relPath}`)
  }

  function handleEvent(evt: { type?: string; properties?: any }) {
    if (evt.type === "tui.file.open" && typeof evt.properties?.path === "string") {
      void revealFile(evt.properties.path)
    } else if (evt.type === "tui.directory.reveal" && typeof evt.properties?.path === "string") {
      void revealDirectory(evt.properties.path)
    } else if (evt.type === "aperture.invalidated") {
      scheduleRepaint()
      scheduleFacetMap()
    } else if (evt.type === "aperture.facets.filtered" && Array.isArray(evt.properties?.facets)) {
      // Someone filtered the legend — the TUI's top bar, or the server clearing it on a Lens
      // switch. The event carries the whole set, so adopt it wholesale rather than diffing.
      // No refetch: the filter changes how the colours we already hold are painted, nothing
      // about what was painted.
      const next: string[] = evt.properties.facets.filter((f: unknown) => typeof f === "string")
      // Our own filter clicks echo back through here. Bailing on an unchanged set spares the
      // whole-tree invalidation and gutter repaint we already did optimistically.
      if (next.length === suppressedFacets.size && next.every((f) => suppressedFacets.has(f))) return
      suppressedFacets.clear()
      for (const facet of next) suppressedFacets.add(facet)
      applyFilter()
    }
  }

  // Long-lived SSE connection to /event, reconnecting with a fixed backoff. The server
  // scopes events to the directory we pass, so we only see this workspace's events.
  function connectEvents() {
    let disposed = false
    let controller: AbortController | undefined

    async function loop() {
      while (!disposed) {
        const dir = directory()
        if (!dir) {
          await delay(RECONNECT_DELAY_MS)
          continue
        }
        controller = new AbortController()
        try {
          const res = await fetch(`${baseUrl()}/event`, {
            headers: { "x-opencode-directory": dir, accept: "text/event-stream" },
            signal: controller.signal,
          })
          if (!res.ok || !res.body) {
            await delay(RECONNECT_DELAY_MS)
            continue
          }
          // Fresh connection (first connect, or a reconnect after a server restart — which
          // drops the server's in-memory drilled-file set that drives extent attachment).
          // Re-warm every open tab so their function paint is re-established under the active
          // Lens without needing a focus, keeping the "open ⇒ painted-or-in-flight" invariant.
          warmed.clear()
          void warmOpenTabs()
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ""
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            // SSE frames are separated by a blank line.
            let sep: number
            while ((sep = buffer.indexOf("\n\n")) !== -1) {
              const frame = buffer.slice(0, sep)
              buffer = buffer.slice(sep + 2)
              const data = frame
                .split("\n")
                .filter((l) => l.startsWith("data:"))
                .map((l) => l.slice(5).trim())
                .join("\n")
              if (!data) continue
              try {
                handleEvent(JSON.parse(data))
              } catch {
                // ignore malformed frame
              }
            }
          }
        } catch {
          // network error / aborted — fall through to reconnect.
        }
        if (!disposed) await delay(RECONNECT_DELAY_MS)
      }
    }

    void loop()
    return {
      abort: () => {
        disposed = true
        controller?.abort()
      },
    }
  }

  // ---- wiring --------------------------------------------------------------

  sse = connectEvents()

  // Create/delete change the tree's file set; content changes don't, and are already
  // covered by the facet map's own refresh.
  const fileWatcher = vscode.workspace.createFileSystemWatcher("**/*")

  context.subscriptions.push(
    decorationsChanged,
    tree,
    treeView,
    fileWatcher,
    fileWatcher.onDidCreate((uri) => {
      if (watchedPath(uri)) scheduleFileSet()
    }),
    fileWatcher.onDidDelete((uri) => {
      if (watchedPath(uri)) scheduleFileSet()
    }),
    vscode.window.registerFileDecorationProvider(decorationProvider),
    vscode.commands.registerCommand("aperture.repaint", () => scheduleRepaint()),
    vscode.commands.registerCommand("aperture.filterFacets", () => void pickFacetFilter()),
    vscode.commands.registerCommand("aperture.clearFacetFilter", () => {
      if (suppressedFacets.size === 0) return
      void setFacetFilter([])
    }),
    vscode.commands.registerCommand("aperture.refreshTree", () => {
      void fetchFileSet()
      // Drop the response cache so the refetch is a real one rather than a no-op bail.
      facetMapRaw = undefined
      scheduleFacetMap()
    }),
    vscode.commands.registerCommand("aperture.revealActiveFile", () => revealActiveFile()),
    vscode.commands.registerCommand("aperture.openToSide", (node: Node) =>
      vscode.commands.executeCommand("vscode.open", node.uri, { viewColumn: vscode.ViewColumn.Beside }),
    ),
    // The built-in copyFilePath / revealFileInOS / revealInExplorer are wrapped rather than
    // put in the menu directly: a `view/item/context` entry hands the command *our tree
    // node*, not a URI, so a workbench command that expects a resource gets an object it
    // can't read. Going through executeCommand with node.uri is the reliable form.
    vscode.commands.registerCommand("aperture.copyPath", (node: Node) =>
      vscode.env.clipboard.writeText(node.uri.fsPath),
    ),
    vscode.commands.registerCommand("aperture.copyRelativePath", (node: Node) =>
      vscode.env.clipboard.writeText(node.rel),
    ),
    vscode.commands.registerCommand("aperture.revealInOS", (node: Node) =>
      vscode.commands.executeCommand("revealFileInOS", node.uri),
    ),
    vscode.commands.registerCommand("aperture.revealInExplorer", (node: Node) =>
      vscode.commands.executeCommand("revealInExplorer", node.uri),
    ),
    vscode.commands.registerCommand("aperture.findInFolder", (node: Node) =>
      // The Explorer's own `filesExplorer.findInFolder` reads its selection rather than an
      // argument, so this drives the search view directly instead.
      vscode.commands.executeCommand("workbench.action.findInFiles", { filesToInclude: `./${node.rel}` }),
    ),
    vscode.commands.registerCommand("aperture.newFile", (node?: Node) =>
      ops.newFile(fileOps, node ?? treeView.selection[0]),
    ),
    vscode.commands.registerCommand("aperture.newFolder", (node?: Node) =>
      ops.newFolder(fileOps, node ?? treeView.selection[0]),
    ),
    vscode.commands.registerCommand("aperture.rename", (node: Node) => ops.rename(fileOps, node)),
    vscode.commands.registerCommand("aperture.delete", (node: Node | undefined, selected: Node[] | undefined) =>
      ops.remove(fileOps, targets(node, selected)),
    ),
    vscode.commands.registerCommand("aperture.closeTab", (node: { tab?: vscode.Tab }) =>
      node.tab ? vscode.window.tabGroups.close(node.tab) : undefined,
    ),
    openEditors,
    openEditorsView,
    vscode.window.tabGroups.onDidChangeTabGroups(() => openEditors.refresh()),
    // Reveal on visibility too: auto-reveal is skipped while the view is hidden (there is
    // nothing to scroll), so opening the view has to catch up to the active editor.
    treeView.onDidChangeVisibility((e) => {
      if (e.visible) revealActiveFile()
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      scheduleRepaint()
      revealActiveFile()
    }),
    // A newly split/opened editor becomes visible without necessarily becoming active —
    // repaint so it drills + fills without needing a focus.
    vscode.window.onDidChangeVisibleTextEditors(() => scheduleRepaint()),
    // Warm open-but-hidden tabs so their function paint is ready before they're focused.
    // The Open Editors view is a projection of this same state, so it refreshes here too —
    // including on a dirty/clean flip, which is a tab change rather than a group change.
    vscode.window.tabGroups.onDidChangeTabs(() => {
      void warmOpenTabs()
      openEditors.refresh()
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (vscode.window.visibleTextEditors.some((e) => e.document === doc)) scheduleRepaint()
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("aperture")) return
      // The tree's own settings never touch the server; they only change how what we
      // already have is drawn, so they repaint in place.
      if (e.affectsConfiguration("aperture.tree")) {
        icons.setDelivery(config().get<IconDelivery>("tree.iconDelivery", "data"))
        tree.refresh()
        openEditors.refresh()
      }
      // The pips setting is read inside provideFileDecoration, so toggling it changes every
      // row's answer at once — a genuine full invalidation, and the only way the already
      // painted pips get dropped.
      if (e.affectsConfiguration("aperture.explorerPips")) decorationsChanged.fire(undefined)
      if (!e.affectsConfiguration("aperture.host") && !e.affectsConfiguration("aperture.port")) return
      // Reconnect against the new host/port and repaint. The fresh connection re-warms every
      // open tab on connect (see connectEvents), so no explicit re-warm is needed here.
      sse?.abort()
      sse = connectEvents()
      scheduleRepaint()
      facetMapRaw = undefined
      scheduleFacetMap()
    }),
  )

  // Self-heal poll: re-fetch the visible files' tiles on a slow cadence so a dropped
  // invalidation (or a paint that completes outside an editor change) still surfaces.
  // Skipped while a fetch is already outstanding so a slow walk can't stack refetches.
  pollTimer = setInterval(() => {
    if (!repainting) scheduleRepaint()
  }, REFRESH_POLL_MS)
  facetMapPollTimer = setInterval(() => {
    if (!fetchingFacetMap) scheduleFacetMap()
  }, FACET_MAP_POLL_MS)

  // Paint the visible files. Open-but-hidden tabs are warmed on SSE connect (see
  // connectEvents), so switching to one is instant (no click-to-drill).
  scheduleRepaint()
  scheduleFacetMap()
  // The tree needs both inputs; this is the one that doesn't depend on the server, so it
  // renders a plain file tree immediately and gains its chips when the facet map lands.
  void fetchFileSet()
}

export function deactivate() {
  if (repaintTimer) clearTimeout(repaintTimer)
  if (pollTimer) clearInterval(pollTimer)
  if (facetMapTimer) clearTimeout(facetMapTimer)
  if (facetMapPollTimer) clearInterval(facetMapPollTimer)
  if (fileSetTimer) clearTimeout(fileSetTimer)
  sse?.abort()
  sse = undefined
  for (const deco of decorationByColor.values()) deco.dispose()
  decorationByColor.clear()
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---- Explorer pip encoding (pure) ------------------------------------------

export type FacetWeight = { f: number; p: number }
export type LegendEntry = { facet: string; label: string; color: string }

// A facet's colour as a ThemeColor. FileDecoration.color accepts only a colour *id* — there
// is no runtime API to hand VSCode a hex — so the palette hexes are contributed as ids in
// package.json (`#4E79A7` → `aperture.c4E79A7`, see script/gen-colors.ts). That's what keeps
// the Explorer pip the Lens's *actual* legend hue rather than an approximation of it.
// Theme-role tokens have no hex to match and fall through to the editor's own colours.
export function themeColorFor(hue: string): vscode.ThemeColor | undefined {
  if (hue.startsWith("#")) return new vscode.ThemeColor(`aperture.c${hue.slice(1).toUpperCase()}`)
  const role = THEME_ROLE_COLORS[hue]
  return role ? new vscode.ThemeColor(role) : undefined
}

// Reduce a file's facet mix to the one colour + one glyph a FileDecoration can carry.
//
// `suppressed` is a parameter rather than this picking a baked-in "dominant" on purpose:
// legend filtering (PLAN O4/S4) is the same question asked over a smaller vocabulary, so
// that feature changes only what is passed here and never this encoding.
//
// With nothing suppressed we show the file's plurality facet, which matches the server's
// `attributeFileBytes(...).dominant` and therefore the TUI tile and the directory treemap.
// With facets suppressed we show the file's largest *surviving* facet, and a file made
// entirely of suppressed facets gets no decoration at all — so filtering visually subtracts
// the unrelated files from the tree.
//
// Note the divergence from the Aperture tree, which greys a suppressed facet in place
// rather than dropping it. That is not an inconsistency: the tree has a whole chip to spend
// and can afford to preserve area, while a one-colour pip has to choose a facet, so the
// only filtering it can express is subtraction.
export function decorationFrom(
  weights: ReadonlyArray<FacetWeight>,
  legend: ReadonlyArray<LegendEntry>,
  facets: ReadonlyArray<string>,
  suppressed: ReadonlySet<string>,
): { badge: string; color: vscode.ThemeColor | undefined; tooltip: string } | undefined {
  // Weights arrive sorted descending, so the first survivor is the largest one.
  const chosen = suppressed.size === 0 ? weights[0] : weights.find((w) => !suppressed.has(facets[w.f] ?? ""))
  if (!chosen) return undefined
  const labelOf = (index: number) => legend.find((e) => e.facet === facets[index])?.label ?? facets[index] ?? "?"
  const hue = legend.find((e) => e.facet === facets[chosen.f])?.color
  return {
    badge: SHADES.find((s) => chosen.p >= s.min)!.glyph,
    // "Other" (and anything else outside the legend) has no legend colour; fall back to the
    // muted role the TUI greys it with rather than leaving it uncoloured and indistinguishable
    // from an unpainted file.
    color: themeColorFor(hue ?? "textMuted"),
    tooltip: weights.map((w) => `${labelOf(w.f)} ${w.p}%`).join(" · "),
  }
}
