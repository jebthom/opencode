import { createSignal } from "solid-js"

// Cross-plugin navigation bus for the Aperture top bar (A4). The chat renderer and
// the Aperture slot are separate feature-plugins with no shared component tree, and
// the TUI plugin API exposes only `event.on` (server events), no client-side emit —
// but both are bundled in the same process, so a module-level signal is a safe
// singleton channel between them. Clicking a file/dir reference in the chat publishes
// a request here; the Aperture View subscribes and re-roots its scope.
//
// The payload carries a monotonic `seq` so clicking the *same* path twice still
// re-fires the subscriber (a bare string wouldn't change).

export interface ApertureNavRequest {
  // The directory scope to root the View at (repo-relative, no leading/trailing slash).
  readonly scope: string
  readonly seq: number
}

const [request, setRequest] = createSignal<ApertureNavRequest | undefined>(undefined)
let seq = 0

// Immediate parent directory of a repo-relative POSIX path; "" for a root-level path.
function posixDir(p: string): string {
  const trimmed = p.replace(/^\/+|\/+$/g, "")
  const i = trimmed.lastIndexOf("/")
  return i === -1 ? "" : trimmed.slice(0, i)
}

// Re-root the Aperture View so `path` is visible. A file roots the View at its parent
// directory (so the file shows in the 2-level window); a directory roots at itself.
export function navigateAperture(path: string, kind: "file" | "directory" = "file") {
  const scope = kind === "directory" ? path.replace(/^\/+|\/+$/g, "") : posixDir(path)
  setRequest({ scope, seq: ++seq })
}

// Subscribed by the Aperture View (createEffect/on).
export const apertureNavRequest = request
