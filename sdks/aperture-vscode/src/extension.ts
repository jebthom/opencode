import * as vscode from "vscode"

// Aperture — a slim client for the opencode server. It renders function-level Facet
// painting in the editor gutter and reveals files the TUI drills into.
//
//  - Gutter (extension → server): GET /aperture?drill=<relPath> returns the focused
//    file's `extents` ({name,startLine,endLine,facet?,hue?}); we paint each as a colored
//    left-border strip + overview-ruler mark.
//  - Open-in-editor (TUI → server → extension): the TUI publishes `tui.file.open` on
//    drill; we listen on the /event SSE stream and reveal the file.
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

// One decoration type per hex color, created lazily and reused. Cleared (set to an empty
// range list) on every repaint for colors not present this pass, so stale strips vanish.
const decorationByColor = new Map<string, vscode.TextEditorDecorationType>()

let sse: { abort: () => void } | undefined
let repaintTimer: ReturnType<typeof setTimeout> | undefined
let pollTimer: ReturnType<typeof setInterval> | undefined
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

  // A facet's `hue` is either a hex string (`#RRGGBB`, user/deterministic palettes) or
  // an opencode theme-role token (the built-in Architecture Lens and the `none`/grey
  // facets). The TUI resolves tokens against its loaded theme; we can't, so we map each
  // known token to the nearest VSCode ThemeColor so the strip still adapts to the
  // editor's theme. Unknown tokens resolve to undefined and are skipped (not painted).
  const THEME_ROLE_COLORS: Record<string, string> = {
    info: "charts.blue",
    success: "charts.green",
    warning: "charts.yellow",
    accent: "charts.purple",
    error: "charts.red",
    textMuted: "descriptionForeground",
    border: "descriptionForeground",
  }

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

  function handleEvent(evt: { type?: string; properties?: any }) {
    if (evt.type === "tui.file.open" && typeof evt.properties?.path === "string") {
      void revealFile(evt.properties.path)
    } else if (evt.type === "aperture.invalidated") {
      scheduleRepaint()
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
    vscode.commands.registerCommand("aperture.repaint", () => scheduleRepaint()),
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
    }),
  )

  // Self-heal poll: re-fetch the visible files' tiles on a slow cadence so a dropped
  // invalidation (or a paint that completes outside an editor change) still surfaces.
  // Skipped while a fetch is already outstanding so a slow walk can't stack refetches.
  pollTimer = setInterval(() => {
    if (!repainting) scheduleRepaint()
  }, REFRESH_POLL_MS)

  // Paint the visible files. Open-but-hidden tabs are warmed on SSE connect (see
  // connectEvents), so switching to one is instant (no click-to-drill).
  scheduleRepaint()
}

export function deactivate() {
  if (repaintTimer) clearTimeout(repaintTimer)
  if (pollTimer) clearInterval(pollTimer)
  sse?.abort()
  sse = undefined
  for (const deco of decorationByColor.values()) deco.dispose()
  decorationByColor.clear()
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
