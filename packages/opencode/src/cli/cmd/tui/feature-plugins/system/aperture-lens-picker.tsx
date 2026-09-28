import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createMemo, createResource } from "solid-js"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useTheme } from "@tui/context/theme"

// Searchable Lens picker: a fuzzy-filterable dialog listing every Lens, grouped by owner (the
// user's own, and the ones an agent curates), with the active one marked. Activation rides the
// aperture.invalidated event the switch publishes, so the top bar repaints without a refresh here.

export type LensSummary = {
  id: string
  name: string
  description: string
  owner: "user" | "agent"
  active: boolean
  facets: number
  rules: number
}

export async function fetchLenses(api: { client: TuiPluginApi["client"] }): Promise<LensSummary[]> {
  const result = await api.client.aperture.listLenses({}, { throwOnError: true })
  return result.data as LensSummary[]
}

export function LensPicker(props: { api: TuiPluginApi; sessionID?: string }) {
  const { theme } = useTheme()
  const [lenses] = createResource(() => fetchLenses(props.api))
  const current = createMemo(() => (lenses() ?? []).find((l) => l.active)?.id)
  const options = createMemo(() =>
    (lenses() ?? []).map((l) => ({
      title: l.name,
      value: l.id,
      description: `${l.facets} concern${l.facets === 1 ? "" : "s"} · ${l.description}`,
      category: l.owner === "agent" ? "Curated by the agent" : "Yours",
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
        // Study logging, only when the session is known (the palette path may lack one) — it
        // must never block the switch.
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

export function openLensPicker(api: TuiPluginApi, sessionID?: string) {
  api.ui.dialog.replace(() => <LensPicker api={api} sessionID={sessionID} />)
  api.ui.dialog.setSize("medium")
}
