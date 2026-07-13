import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createMemo, createResource } from "solid-js"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useTheme } from "@tui/context/theme"

// A2: searchable Lens picker. Replaces the flat ◀/▶ cycle as the only way to switch
// among many Lenses — a fuzzy-filterable dialog listing every available Lens
// (built-in + user), grouped by kind, with the active one marked. Reuses the shared
// DialogSelect (filter input + grouped list + keyboard nav). Activation rides the
// existing aperture.invalidated event the switch publishes, so the top bar re-paints
// without any extra refresh here.

export type LensSummary = {
  id: string
  name: string
  description: string
  scope: "global" | "project"
  builtin: boolean
  active: boolean
  // A drill-down Lens: scoped to a subset of `parent`'s facets. See Lens.parent.
  parent?: string
  depth: number
  rootScope: "global" | "project"
}

// The drill-down Lenses scoped to `id`, transitively. Deleting a Lens deletes these with it
// (a drill-down's domain is its parent's facets — without the parent it can't paint at all),
// so both delete controls use this to say what's about to go. Cycle-safe: `lenses.json` is
// hand-editable.
export function drillDownsOf(lenses: ReadonlyArray<LensSummary>, id: string): LensSummary[] {
  const out: LensSummary[] = []
  const frontier = [id]
  const seen = new Set([id])
  while (frontier.length) {
    const parent = frontier.shift()!
    for (const lens of lenses) {
      if (lens.parent !== parent || seen.has(lens.id)) continue
      seen.add(lens.id)
      out.push(lens)
      frontier.push(lens.id)
    }
  }
  return out
}

// Fetch the Lens list, typed. The generated SDK type lags the server schema (it has no
// `parent`/`depth`), so the cast is the one place that gap is bridged. Takes anything
// carrying a client (the plugin api or the TUI's SDK context).
export async function fetchLenses(api: { client: TuiPluginApi["client"] }): Promise<LensSummary[]> {
  const result = await api.client.aperture.listLenses({}, { throwOnError: true })
  return result.data as LensSummary[]
}

export function LensPicker(props: { api: TuiPluginApi; sessionID?: string }) {
  const { theme } = useTheme()
  const [lenses] = createResource(() => fetchLenses(props.api))
  const current = createMemo(() => (lenses() ?? []).find((l) => l.active)?.id)
  const options = createMemo(() =>
    // The server hands these back in DFS-forest order — each Lens immediately followed by
    // the drill-downs scoped to it — so rendering the hierarchy is just an indent.
    (lenses() ?? []).map((l) => ({
      title: l.depth > 0 ? `${"  ".repeat(l.depth - 1)}↳ ${l.name}` : l.name,
      value: l.id,
      description: l.description,
      // Groups the list into "Project" / "Built-in" sections. Keyed on the ROOT ancestor's
      // scope, not this Lens's own: DialogSelect groups by category, so a project
      // drill-down of a built-in parent would otherwise be lifted out of the forest order
      // into the "Project" section — indented under nothing.
      category: l.rootScope === "global" ? "Built-in" : "Project",
      // ● marks the active Lens, ○ the rest.
      gutter: () => <text fg={l.active ? theme.accent : theme.textMuted}>{l.active ? "●" : "○"}</text>,
    })),
  )
  return (
    <DialogSelect
      title="Switch Lens"
      placeholder="Filter lenses…"
      options={options()}
      current={current()}
      onSelect={(item) => {
        // Aperture research/study logging: record the lens selection (user-driven).
        // Only when we know the session (top-bar path); the palette/`/lens-switch`
        // path may lack one, and study logging must never block the switch.
        if (props.sessionID)
          void props.api.client.aperture.interaction({
            sessionID: props.sessionID,
            interaction: "lens.select",
            lens: item.value,
          })
        void props.api.client.aperture.selectLens({ lens: item.value })
        props.api.ui.dialog.clear()
      }}
    />
  )
}

// Open the picker as a medium dialog. Wired to a palette command and the legend.
export function openLensPicker(api: TuiPluginApi, sessionID?: string) {
  api.ui.dialog.replace(() => <LensPicker api={api} sessionID={sessionID} />)
  api.ui.dialog.setSize("medium")
}
