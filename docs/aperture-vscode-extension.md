# A6 — A standalone Aperture VSCode extension (prototype)

## Context

Aperture paints code by *Facet* (a Lens's semantic vocabulary). A5 added
function-level resolution: drilling into a file yields **extents** — line-delimited
top-level declarations, each with an inferred `facet` and a resolved hex `hue`. The TUI
renders these as a colored band. Guardrail #2 in PLAN.md is that the TUI has no code
reader — you see *that* a function is "config" or "IO", but not the code. A6 resolves this
by annotating the real editor instead.

The existing `sdks/vscode/` extension is non-functional on current VSCode and is not worth
reviving. Instead we build a **new, standalone, minimal Aperture extension** focused
purely on two connections, intended as a study prototype:

1. **Paint the gutter** of the focused editor by function-level extents — a colored
   left-border strip per extent plus matching marks on the scrollbar/overview-ruler.
2. **Open-in-editor** — clicking a file in the TUI's top bar (to drill/paint it) reveals
   that file in VSCode.

**Architecture framing (the user's model, refined):** the opencode server is the backend;
the extension is a slim client that renders its data. Crucially, *most of the backend
already exists* — the gutter reads the existing `GET /aperture?drill=<file>` route, and
the push channel is the existing `/event` SSE stream. The CLI/TUI stays independent: the
only CLI change is a generic one-shot "reveal this file" intent published on the existing
host-event bus, which the extension happens to subscribe to. The CLI never references
VSCode.

**Connection model: manual.** The user runs `opencode --port <N>` themselves; the
extension connects to that port via a setting (`aperture.port`). Keeps the extension lean
and the CLI fully independent.

## Data flows

- **Gutter (extension → server):** `GET http://<host>:<port>/aperture?drill=<relPath>`
  with header `x-opencode-directory: <workspaceFolder>`. Response `.extents` is a record
  keyed by file node id with **at most one key** (the drilled file) — take
  `Object.values(extents)[0]`. Each extent: `{name, startLine, endLine, facet?, hue?}`;
  `hue` is a hex color once the drill-in painter colors the function (built-in Lens
  palettes are all `#RRGGBB`, see `aperture/lenses.ts`), absent until then.
- **Open-in-editor (TUI → server → extension):** TUI fires a one-shot route on drill →
  server publishes `tui.file.open` on the bus → extension, subscribed to `/event` (SSE),
  reveals the file.

## Part A — Server/CLI: generic "reveal file" intent (minimal)

Mirror the existing `TuiEvent.PromptAppend` pattern (route → handler → `events.publish` →
bus → `/event`). Nothing here is VSCode-specific.

1. **`packages/opencode/src/cli/cmd/tui/event.ts`** — add to `TuiEvent`:
   ```ts
   FileOpen: EventV2.define({ type: "tui.file.open", schema: { path: Schema.String } }),
   ```
2. **`.../server/routes/instance/httpapi/groups/tui.ts`** — add `POST /tui/open-file`
   with `payload: TuiEvent.FileOpen.data` (mirror `appendPrompt`, lines ~37/56).
3. **`.../server/routes/instance/httpapi/handlers/tui.ts`** — handler does
   `yield* events.publish(TuiEvent.FileOpen, ctx.payload)` (mirror `appendPrompt`, ~line 37).
4. **`.../cli/cmd/tui/feature-plugins/system/aperture.tsx`** — in `toggleDrill` (line 236),
   when drilling **on** (new path set, not cleared), fire-and-forget
   `void props.api.client.tui.openFile({ path })`. Only on enable, so poll/invalidation
   refetches (which re-send `drill`) never re-trigger an open.
5. **Regenerate the JS SDK** so the TUI's `client.tui.openFile` exists:
   `cd packages/sdk/js && bun run build` (runs `bun dev generate` → `openapi.json` →
   `@hey-api/openapi-ts` → `src/v2/gen/*`). This is for the TUI client only; the extension
   uses raw `fetch`.

## Part B — New extension: `sdks/aperture-vscode/`

A fresh package; scaffold mirrors `sdks/vscode/` (esbuild + tsc + bun). Do **not** modify
the old extension.

### B0. Scaffold
- `package.json`: `name: "aperture"`, `engines.vscode` at a current baseline (e.g.
  `^1.96.0`), `main: ./dist/extension.js`, `activationEvents: ["onStartupFinished"]`,
  and a **settings contribution**:
  - `aperture.port` (number, default `4096`)
  - `aperture.host` (string, default `"127.0.0.1"`)
- `esbuild.js`, `tsconfig.json`, `.vscodeignore`: copy from `sdks/vscode/` (CJS bundle,
  `external: ["vscode"]`, `platform: node`).
- `src/extension.ts`: all logic below.

### B1. Connection
- Base URL from settings: `http://${host}:${port}`. `directoryHeader` =
  `vscode.workspace.workspaceFolders?.[0]?.uri.fsPath`, sent as `x-opencode-directory` on
  every request. All features are inert no-ops when there's no workspace folder or the
  server is unreachable (catch + ignore; optional status-bar "Aperture: disconnected").

### B2. Gutter painting (colored left border + overview-ruler marks)
- VSCode can't set a gutter *background*; use per-color `TextEditorDecorationType`s cached
  in a `Map<hexColor, type>`:
  ```ts
  vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderWidth: "0 0 0 2px",
    borderStyle: "solid",
    borderColor: hex,
    overviewRulerColor: hex,
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  })
  ```
- `repaint(editor)`: compute `relPath` via `vscode.workspace.asRelativePath`;
  `GET /aperture?drill=<relPath>`; take the single `extents` entry; for each extent with a
  hex `hue`, build `new vscode.Range(startLine-1, 0, endLine-1, 0)`, group ranges by color,
  `editor.setDecorations(type, ranges)` per color, and clear (empty array) any cached color
  not present this pass. Skip extents whose `hue` is absent or non-`#` (unpainted /
  theme-role keys — rare for facet Lenses).
- Triggers: `onDidChangeActiveTextEditor`, `onDidSaveTextDocument`, and the
  `aperture.invalidated` SSE event (B3). Light debounce; ignore non-file editors.

### B3. Open-in-editor via SSE
- `GET /event` (with the `x-opencode-directory` header); stream the response. The
  extension host runs Node with global `fetch` — read `response.body` as a stream, split
  on `\n\n` SSE frames (no new dependency; alternatively add the small `eventsource` pkg).
- Per frame: `JSON.parse` the `data:` line; when `type === "tui.file.open"`, resolve
  `properties.path` against the workspace folder and
  `vscode.window.showTextDocument(uri)`.
- Reconnect with backoff on stream end/error; the same connection also drives B2 repaints
  on `aperture.invalidated`. Tear down on `deactivate`.

## Critical files

| Purpose | Path |
|---|---|
| New TUI event | `packages/opencode/src/cli/cmd/tui/event.ts` |
| Route + handler | `.../httpapi/groups/tui.ts`, `.../httpapi/handlers/tui.ts` |
| Fire on drill | `.../cli/cmd/tui/feature-plugins/system/aperture.tsx` (`toggleDrill`, ~236) |
| Extent contract (reference) | `packages/opencode/src/aperture/payload.ts` (`Extent`, `Payload.extents`) |
| SDK regen | `packages/sdk/js` → `bun run build` |
| **New extension** | `sdks/aperture-vscode/{package.json,esbuild.js,tsconfig.json,.vscodeignore,src/extension.ts}` |

## Reuse (don't reinvent)
- `Payload.extents` + the drill route already deliver line ranges + hex hue — the
  extension reads them directly; no client-side re-implementation of `extentsOf()`.
- `events.publish(TuiEvent.…)` + `/event` SSE is the established TUI↔host channel
  (`handlers/tui.ts`); the reveal intent rides it.
- `sdks/vscode/` is the scaffold template (build config, manifest shape) — copy, don't edit.

## Verification
1. **Build:** `cd packages/sdk/js && bun run build` (regen ok, `tui.openFile` present);
   `cd sdks/aperture-vscode && bun run compile` passes.
2. **End-to-end:** run `opencode --port 4096` in this repo (TUI + server); set
   `aperture.port = 4096`; launch the extension's Dev Host (F5) with this repo open.
   - Open a TS file with several top-level declarations → after the drill-in painter runs,
     confirm colored left-border strips per function + matching scrollbar marks; switch
     Lens in the TUI and confirm colors update on the next paint/invalidation.
   - Click a file in the TUI top bar → confirm VSCode reveals that file.
3. **API spot-check:** `curl 'http://127.0.0.1:4096/aperture?drill=<relPath>' -H
   'x-opencode-directory: <repo>'` shows `extents` with hex `hue`;
   `curl -N 'http://127.0.0.1:4096/event' -H 'x-opencode-directory: <repo>'` shows a
   `tui.file.open` frame on a top-bar click.
4. **Inert path:** wrong/closed port → extension loads, paints nothing, no errors.

## Out of scope / notes
- Auto-discovery (mDNS/lockfile) and extension-spawned TUI are deferred; connection is
  manual via `aperture.port`.
- On-disk committable `name→facet` snapshot (the A6 alternative) is not built — HTTP-live
  via the drill route only.
- Non-`#` (theme-role) hues are skipped, not resolved; built-in facet Lenses use hex.
- The old `sdks/vscode/` extension is left untouched.
