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

type LensSummary = {
  id: string
  name: string
  description: string
  scope: "global" | "project"
  builtin: boolean
  active: boolean
}

export function LensPicker(props: { api: TuiPluginApi; sessionID?: string }) {
  const { theme } = useTheme()
  const [lenses] = createResource(async () => {
    const result = await props.api.client.aperture.listLenses({}, { throwOnError: true })
    return result.data as LensSummary[]
  })
  const current = createMemo(() => (lenses() ?? []).find((l) => l.active)?.id)
  const options = createMemo(() =>
    (lenses() ?? []).map((l) => ({
      title: l.name,
      value: l.id,
      description: l.description,
      // Groups the list into "Project" / "Built-in" sections.
      category: l.builtin ? "Built-in" : "Project",
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
