import * as vscode from "vscode"

// Aperture — a slim client for the opencode server. It renders function-level Facet
// painting in the editor gutter and reveals files the TUI drills into.
//
//  - Gutter (extension → server): GET /aperture?drill=<relPath> returns the focused
//    file's `extents` ({name,startLine,endLine,facet?,hue?}); we paint each as a colored
//    left-border strip + overview-ruler mark.
//  - Explorer pips (extension → server): GET /aperture/facets returns every painted file's
//    facet mix in one shot; we decorate each file row with a coloured shade glyph.
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
    const painted = (extents ?? []).filter((e) => e.hue && resolveHue(e.hue) !== undefined).length
    log(`drill ${relPath}: ${extents?.length ?? 0} extents, ${painted} painted`)

    // Group line ranges by hue; a painted function carries a hue we can resolve (hex or
    // a known theme-role token). Functions with no/unresolvable hue stay unpainted. One
    // range per line: the `before` strip only renders at a range's start, so a multi-line
    // range would leave every line but the first un-striped.
    const rangesByColor = new Map<string, vscode.Range[]>()
    for (const ex of extents ?? []) {
      const hue = ex.hue
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
  let facetMap = new Map<string, FacetWeight[]>()
  let facetLegend: LegendEntry[] = []
  let facetIds: string[] = []
  // Which facet the pips report. Undefined = each file's own dominant facet. Set via the
  // aperture.focusFacet command; PLAN O4/S4 will drive it from the TUI's legend filter
  // instead, which is why nothing below assumes where the value came from.
  let focusFacet: string | undefined
  let fetchingFacetMap = false
  // The last response body, verbatim. The server emits files in a stable order, so an
  // unchanged repo re-serializes byte-identically and this comparison is exact — which is
  // what lets the self-heal poll run without touching the UI. See the flicker note below.
  let facetMapRaw: string | undefined

  // Firing `undefined` means "every decoration changed": VSCode drops its whole cache and
  // re-queries the provider for every visible row, and the rows paint bare for the round
  // trip — a visible full-tree flicker. So we fire a URI list whenever we can, and reserve
  // `undefined` for the cases where every row really did change meaning (a new Lens, a new
  // focus facet, pips switched off).
  const decorationsChanged = new vscode.EventEmitter<vscode.Uri[] | undefined>()

  async function fetchFacetMap() {
    const dir = directory()
    // Turning the setting off has to actively clear what's already painted — returning early
    // would leave the last fetch's pips on screen forever, since nothing else drops them.
    if (!config().get<boolean>("explorerPips", true)) {
      if (facetMap.size === 0) return
      facetMap = new Map()
      facetMapRaw = undefined
      decorationsChanged.fire(undefined)
      return
    }
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
        files?: Record<string, FacetWeight[]>
      }
      // "Changed since last commit" is the one Lens we suppress here: VSCode already
      // decorates modified files from its own SCM provider, and ours would compete with that
      // badge for the same slot to say the same thing. The other deterministic built-ins
      // (edit recency, bus factor) are file-level by nature and are exactly what a file tree
      // wants to show, so — unlike the gutter — we do NOT skip all deterministic Lenses.
      const suppressed = data.lens?.id === "git-changed"
      const next = suppressed ? new Map<string, FacetWeight[]>() : new Map(Object.entries(data.files ?? {}))
      // A different Lens (or vocabulary) re-colours every row at once, so a targeted list
      // would be wrong as well as pointless — that is a genuine full invalidation.
      const relit = JSON.stringify(facetIds) !== JSON.stringify(data.facets ?? [])
      const changed = relit ? undefined : changedUris(facetMap, next)
      const previous = facetMap
      facetMap = next
      facetLegend = data.lens?.legend ?? []
      facetIds = data.facets ?? []
      // A focus facet from a previous Lens means nothing under this one; dropping it avoids
      // an Explorer that has silently blanked itself.
      if (focusFacet !== undefined && !facetIds.includes(focusFacet)) focusFacet = undefined
      if (changed && changed.length === 0) return
      log(
        `facet map: ${next.size} files (was ${previous.size}), ` +
          `${changed ? `${changed.length} rows` : "all rows"} repainted${suppressed ? " (suppressed)" : ""}`,
      )
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
  function changedUris(before: Map<string, FacetWeight[]>, after: Map<string, FacetWeight[]>) {
    const folder = workspaceFolder()
    if (!folder) return undefined
    const key = (w: FacetWeight[] | undefined) => (w ? JSON.stringify(w) : "")
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
      // Files only. A folder decoration would need its own subtree rollup and would contend
      // with git's folder badges; directory aggregation stays the top bar's job.
      const weights = facetMap.get(vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/"))
      // No entry = unpainted, non-source, or the map hasn't loaded yet. Returning undefined
      // leaves the row plain; the refresh event makes VSCode ask again once it has.
      if (!weights?.length) return undefined
      const deco = decorationFrom(weights, facetLegend, facetIds, focusFacet)
      if (!deco) return undefined
      return new vscode.FileDecoration(deco.badge, deco.tooltip, deco.color)
    },
  }

  // Pick which facet the pips report, or reset to each file's dominant one.
  async function pickFocusFacet() {
    if (facetLegend.length === 0) {
      vscode.window.showInformationMessage("Aperture: no active Lens to filter by.")
      return
    }
    const reset = "Show each file's dominant facet"
    const picked = await vscode.window.showQuickPick([reset, ...facetLegend.map((e) => e.label)], {
      title: "Aperture: focus a facet in the Explorer",
    })
    if (picked === undefined) return
    focusFacet = picked === reset ? undefined : facetLegend.find((e) => e.label === picked)?.facet
    decorationsChanged.fire(undefined)
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
  }

  // Pick any entry inside `uri` that the Explorer is actually showing. Revealing a child is
  // how we force a folder open (see revealDirectory), so the one thing that matters is that
  // the entry exists in the tree's model — revealing something the tree filters out finds no
  // item and silently does nothing. `files.exclude` is where the usual offenders live
  // (`**/.git`, `**/node_modules`, `**/.DS_Store`), so we honour it; its values are globs,
  // but the ones that matter here are a leading `**/` plus a literal name, and anything
  // fancier is left unmatched rather than pulling in a glob dependency for a heuristic.
  // Which entry we get is irrelevant — it exists only to be something whose *parent* is the
  // folder we want expanded.
  //
  // Not covered: `explorer.excludeGitIgnore`, and glob patterns we decline to match. If we
  // pick something the tree is hiding, the reveal no-ops and the folder is left collapsed —
  // i.e. it degrades to the old behaviour rather than misbehaving.
  async function firstVisibleChild(uri: vscode.Uri): Promise<vscode.Uri | undefined> {
    let entries: [string, vscode.FileType][]
    try {
      entries = await vscode.workspace.fs.readDirectory(uri)
    } catch {
      return undefined // unreadable / vanished — caller falls back to a plain reveal
    }
    const exclude = vscode.workspace.getConfiguration("files", uri).get<Record<string, boolean>>("exclude") ?? {}
    const hidden = new Set(
      Object.entries(exclude)
        .filter(([, on]) => on)
        .map(([glob]) => glob.replace(/^\*\*\//, ""))
        .filter((name) => !/[*?{}[\]]/.test(name)),
    )
    const pick = entries.find(([name]) => !hidden.has(name))
    return pick ? vscode.Uri.joinPath(uri, pick[0]) : undefined
  }

  // Open a directory in the Explorer, so the file tree shows what the TUI's top bar has
  // navigated into. This is the bar's link into the editor now that it no longer lists
  // files (PLAN O1): the bar aggregates, the file tree enumerates.
  //
  // `revealInExplorer` alone is not enough, and the reason is in ExplorerView.selectResource:
  // it walks *down* from the root with `while (item.resource !== resource) await
  // tree.expand(item)`, so it expands every ancestor and stops the moment it reaches the
  // target — the target itself is never expanded. Revealing `src` therefore selects it and
  // leaves it shut, which is why the TUI could be rooted inside a folder the Explorer still
  // showed collapsed. Revealing something *inside* `src` makes `src` an ancestor, so the
  // same loop opens it. That is the mechanism, not a trick.
  //
  // (`list.expand` looks like the obvious fix and is not: it acts on the list service's
  // last-focused list, and on an already-open folder it walks focus to the first child
  // instead of doing nothing. It was tried and did not work.)
  //
  // Reveal also *focuses* the Explorer, which is deliberate: the user clicked a directory
  // asking to go look at it, so handing them the tree is the useful outcome even though it
  // moves the cursor out of the terminal running the TUI.
  async function revealDirectory(relPath: string) {
    const folder = workspaceFolder()
    if (!folder) return
    // The TUI's root scope is the empty string, which joinPath would turn into a trailing
    // slash the Explorer can't match — use the folder URI itself.
    const uri = relPath === "" ? folder.uri : vscode.Uri.joinPath(folder.uri, relPath)
    try {
      // The workspace root is the tree's root and is always open, so it needs no child.
      const child = relPath === "" ? undefined : await firstVisibleChild(uri)
      if (child) await vscode.commands.executeCommand("revealInExplorer", child)
      // Put the selection back on the folder that was actually clicked, so the Explorer
      // highlight matches where the TUI is rooted. Revealing a folder never collapses it,
      // so the expansion from the step above survives — and on an already-open folder the
      // whole sequence is idempotent.
      await vscode.commands.executeCommand("revealInExplorer", uri)
      log(`reveal ${relPath === "" ? "<root>" : relPath}${child ? "" : " (no visible child — not expanded)"}`)
    } catch (e) {
      // directory may have moved/been deleted — ignore, as revealFile does.
      log(`reveal FAILED for ${relPath}: ${String(e)}`)
    }
  }

  function handleEvent(evt: { type?: string; properties?: any }) {
    if (evt.type === "tui.file.open" && typeof evt.properties?.path === "string") {
      void revealFile(evt.properties.path)
    } else if (evt.type === "tui.directory.reveal" && typeof evt.properties?.path === "string") {
      void revealDirectory(evt.properties.path)
    } else if (evt.type === "aperture.invalidated") {
      scheduleRepaint()
      scheduleFacetMap()
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

  context.subscriptions.push(
    decorationsChanged,
    vscode.window.registerFileDecorationProvider(decorationProvider),
    vscode.commands.registerCommand("aperture.repaint", () => scheduleRepaint()),
    vscode.commands.registerCommand("aperture.focusFacet", () => void pickFocusFacet()),
    vscode.window.onDidChangeActiveTextEditor(() => scheduleRepaint()),
    // A newly split/opened editor becomes visible without necessarily becoming active —
    // repaint so it drills + fills without needing a focus.
    vscode.window.onDidChangeVisibleTextEditors(() => scheduleRepaint()),
    // Warm open-but-hidden tabs so their function paint is ready before they're focused.
    vscode.window.tabGroups.onDidChangeTabs(() => void warmOpenTabs()),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (vscode.window.visibleTextEditors.some((e) => e.document === doc)) scheduleRepaint()
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("aperture")) return
      // Reconnect against the new host/port and repaint. The fresh connection re-warms every
      // open tab on connect (see connectEvents), so no explicit re-warm is needed here.
      sse?.abort()
      sse = connectEvents()
      scheduleRepaint()
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
}

export function deactivate() {
  if (repaintTimer) clearTimeout(repaintTimer)
  if (pollTimer) clearInterval(pollTimer)
  if (facetMapTimer) clearTimeout(facetMapTimer)
  if (facetMapPollTimer) clearInterval(facetMapPollTimer)
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
// `focus` is a parameter rather than a baked-in "dominant" on purpose: filtering the view to
// a single facet (PLAN O4/S4) is the same question asked with a different focus, so that
// feature changes only what is passed here and never this encoding. With no focus we show
// the file's plurality facet, which matches the server's `attributeFileBytes(...).dominant`
// and therefore the TUI tile and the directory treemap. With a focus we show *that* facet's
// share, and a file that doesn't carry it gets no decoration at all — so setting a focus
// visually subtracts every unrelated file from the tree.
export function decorationFrom(
  weights: ReadonlyArray<FacetWeight>,
  legend: ReadonlyArray<LegendEntry>,
  facets: ReadonlyArray<string>,
  focus: string | undefined,
): { badge: string; color: vscode.ThemeColor | undefined; tooltip: string } | undefined {
  // Weights arrive sorted descending, so the head is the plurality facet.
  const chosen = focus === undefined ? weights[0] : weights.find((w) => facets[w.f] === focus)
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
