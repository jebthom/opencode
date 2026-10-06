// Where Aperture writes its own files inside the project, relative to the project directory.
// The writers build their paths from these, and the TUI's change views drop anything under them:
// Lens definitions, Lens history and session logs change on every turn, and listing them beside
// the user's code as "uncommitted" reads as the agent touching files it never touched. Committed
// or not, they are infrastructure rather than work on the repo.

// lenses.json, active.json and lens-history.jsonl.
export const LENS_DIR = [".opencode", "aperture"]
// The study log's per-session folders (study-log.ts).
export const SESSION_LOG_DIR = ["perf", "logs", "sessions"]
// The auto-session diagnostic log (util/debug-autosession.ts).
export const AUTOSESSION_LOG = ["perf", "autosession.log"]
// The removed painter's timing log. Nothing writes it any more, but repos that ran an older
// build still carry one.
const PAINTER_LOG = ["perf", "painter.log"]

// `relPath` is project-relative with `/` separators, as git and the facet map report it.
export function isPlumbing(relPath: string) {
  return (
    [LENS_DIR, SESSION_LOG_DIR].some((dir) => relPath.startsWith(dir.join("/") + "/")) ||
    [AUTOSESSION_LOG, PAINTER_LOG].some((file) => relPath === file.join("/"))
  )
}
