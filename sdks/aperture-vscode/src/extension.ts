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

// One decoration type per hex color, created lazily and reused. Cleared (set to an empty
// range list) on every repaint for colors not present this pass, so stale strips vanish.
const decorationByColor = new Map<string, vscode.TextEditorDecorationType>()

let sse: { abort: () => void } | undefined
let repaintTimer: ReturnType<typeof setTimeout> | undefined

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

  function decorationFor(color: string): vscode.TextEditorDecorationType {
    let deco = decorationByColor.get(color)
    if (!deco) {
      deco = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        borderWidth: "0 0 0 2px",
        borderStyle: "solid",
        borderColor: color,
        overviewRulerColor: color,
        overviewRulerLane: vscode.OverviewRulerLane.Left,
      })
      decorationByColor.set(color, deco)
    }
    return deco
  }

  type Extent = { name: string; startLine: number; endLine: number; facet?: string; hue?: string }

  async function fetchExtents(relPath: string): Promise<Extent[] | undefined> {
    const dir = directory()
    if (!dir) return undefined
    // Scope the window at the file's parent dir so the file's node is in-window and the
    // server attaches its extents (a root-scoped window omits deep files).
    const scope = relPath.split("/").slice(0, -1).join("/")
    const url = `${baseUrl()}/aperture?drill=${encodeURIComponent(relPath)}&scope=${encodeURIComponent(scope)}`
    const res = await fetch(url, { headers: { "x-opencode-directory": dir } })
    if (!res.ok) return undefined
    const data = (await res.json()) as { extents?: Record<string, Extent[]> }
    // `extents` is keyed by file node id with at most one key (the drilled file).
    return Object.values(data.extents ?? {})[0]
  }

  async function repaint(editor: vscode.TextEditor | undefined) {
    if (!editor || editor.document.uri.scheme !== "file") {
      log(`skip: no file editor (scheme=${editor?.document.uri.scheme})`)
      return
    }
    const relPath = vscode.workspace.asRelativePath(editor.document.uri, false).replace(/\\/g, "/")

    let extents: Extent[] | undefined
    try {
      extents = await fetchExtents(relPath)
    } catch (e) {
      log(`fetch FAILED for ${relPath}: ${String(e)} (baseUrl=${baseUrl()} dir=${directory()})`)
      return
    }
    const painted = (extents ?? []).filter((e) => e.hue?.startsWith("#")).length
    log(`drill ${relPath}: ${extents?.length ?? 0} extents, ${painted} painted`)

    // Group line ranges by color; only painted functions carry a hex hue.
    const rangesByColor = new Map<string, vscode.Range[]>()
    for (const ex of extents ?? []) {
      const hue = ex.hue
      if (!hue || !hue.startsWith("#")) continue
      const range = new vscode.Range(ex.startLine - 1, 0, ex.endLine - 1, 0)
      const list = rangesByColor.get(hue) ?? []
      list.push(range)
      rangesByColor.set(hue, list)
    }

    // Apply present colors and clear any cached color absent this pass.
    for (const color of new Set([...decorationByColor.keys(), ...rangesByColor.keys()])) {
      editor.setDecorations(decorationFor(color), rangesByColor.get(color) ?? [])
    }
  }

  function scheduleRepaint(editor = vscode.window.activeTextEditor) {
    if (repaintTimer) clearTimeout(repaintTimer)
    repaintTimer = setTimeout(() => void repaint(editor), REPAINT_DEBOUNCE_MS)
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
    vscode.window.onDidChangeActiveTextEditor((editor) => scheduleRepaint(editor)),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const editor = vscode.window.activeTextEditor
      if (editor && editor.document === doc) scheduleRepaint(editor)
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("aperture")) return
      // Reconnect against the new host/port and repaint.
      sse?.abort()
      sse = connectEvents()
      scheduleRepaint()
    }),
  )

  // Paint whatever is already open.
  scheduleRepaint()
}

export function deactivate() {
  if (repaintTimer) clearTimeout(repaintTimer)
  sse?.abort()
  sse = undefined
  for (const deco of decorationByColor.values()) deco.dispose()
  decorationByColor.clear()
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
