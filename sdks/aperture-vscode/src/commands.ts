import * as vscode from "vscode"
import type { Node } from "./tree"

// The Explorer affordances a custom TreeView does not inherit.
//
// The built-in `explorer.newFile` / `renameFile` / `deleteFile` commands look like the
// obvious implementation and are not usable here: they act on the *Explorer's* own
// selection, not on a URI you pass them, so invoking them from another view either does
// nothing or operates on whatever the Explorer happened to have selected.
//
// Everything below therefore goes through `WorkspaceEdit`, which is the better answer
// anyway: a WorkspaceEdit rename fires the rename participants, so TypeScript offers to
// update imports exactly as it does from the Explorer, and a WorkspaceEdit delete lands on
// the undo stack.
//
// The genuinely URI-taking built-ins (revealFileInOS, revealInExplorer, vscode.open) are
// thin enough to register inline in extension.ts, where the reason they have to be wrapped
// at all — a view menu hands the command our tree node, not a resource — is documented.

export interface FileOpsContext {
  readonly root: () => vscode.Uri | undefined
  // A directory the user created that has no files in it yet. The tree derives directories
  // from file paths, so without this an empty new folder would not appear.
  readonly rememberDir: (rel: string) => void
  // Re-enumerate the file set. Awaited before revealing, because the tree cannot reveal a
  // path its model has not been rebuilt to contain yet.
  readonly refresh: () => Promise<void>
  readonly reveal: (rel: string) => void
}

// Where a "new file/folder" lands: inside the selected folder, or beside the selected file.
function parentOf(node: Node | undefined): string {
  if (!node) return ""
  if (node.dir) return node.rel
  const slash = node.rel.lastIndexOf("/")
  return slash === -1 ? "" : node.rel.slice(0, slash)
}

function join(root: vscode.Uri, rel: string): vscode.Uri {
  return rel === "" ? root : vscode.Uri.joinPath(root, rel)
}

export async function newFile(ctx: FileOpsContext, node: Node | undefined) {
  const root = ctx.root()
  if (!root) return
  const parent = parentOf(node)
  const name = await vscode.window.showInputBox({
    title: "New File",
    prompt: parent === "" ? "Name for the new file" : `Name for the new file in ${parent}`,
    validateInput: validateName,
  })
  if (!name) return
  const rel = parent === "" ? name : `${parent}/${name}`
  const uri = join(root, rel)
  try {
    // Fails rather than truncating if the file already exists — a "new file" that silently
    // emptied an existing one would be the worst possible outcome of a typo.
    await vscode.workspace.fs.stat(uri)
    vscode.window.showErrorMessage(`Aperture: ${rel} already exists.`)
    return
  } catch {
    // Expected: it does not exist yet.
  }
  // fs.writeFile creates missing parent directories, so a nested name like `a/b/c.ts`
  // works the same way it does in the Explorer.
  await vscode.workspace.fs.writeFile(uri, new Uint8Array())
  await ctx.refresh()
  await vscode.window.showTextDocument(uri)
  ctx.reveal(rel)
}

export async function newFolder(ctx: FileOpsContext, node: Node | undefined) {
  const root = ctx.root()
  if (!root) return
  const parent = parentOf(node)
  const name = await vscode.window.showInputBox({
    title: "New Folder",
    prompt: parent === "" ? "Name for the new folder" : `Name for the new folder in ${parent}`,
    validateInput: validateName,
  })
  if (!name) return
  const rel = parent === "" ? name : `${parent}/${name}`
  await vscode.workspace.fs.createDirectory(join(root, rel))
  ctx.rememberDir(rel)
  await ctx.refresh()
  ctx.reveal(rel)
}

export async function rename(ctx: FileOpsContext, node: Node) {
  const root = ctx.root()
  if (!root) return
  const name = await vscode.window.showInputBox({
    title: "Rename",
    value: node.name,
    // Preselect the stem, not the extension — the same convenience the Explorer's inline
    // rename gives, and the thing you almost always want to change.
    valueSelection: stemRange(node.name),
    validateInput: validateName,
  })
  if (!name || name === node.name) return
  const slash = node.rel.lastIndexOf("/")
  const rel = slash === -1 ? name : `${node.rel.slice(0, slash)}/${name}`
  const edit = new vscode.WorkspaceEdit()
  edit.renameFile(node.uri, join(root, rel), { overwrite: false })
  // Through a WorkspaceEdit so rename participants run: this is what makes TypeScript
  // offer to update imports, exactly as an Explorer rename does.
  if (!(await vscode.workspace.applyEdit(edit))) {
    vscode.window.showErrorMessage(`Aperture: could not rename ${node.name}.`)
    return
  }
  await ctx.refresh()
  ctx.reveal(rel)
}

export async function remove(ctx: FileOpsContext, nodes: ReadonlyArray<Node>) {
  if (nodes.length === 0) return
  // Honour the Explorer's own confirmation setting rather than inventing a second one.
  if (vscode.workspace.getConfiguration("explorer").get<boolean>("confirmDelete", true)) {
    const what = nodes.length === 1 ? `'${nodes[0]!.name}'` : `${nodes.length} items`
    const choice = await vscode.window.showWarningMessage(
      `Are you sure you want to delete ${what}?`,
      { modal: true, detail: "This can be undone with Undo (Ctrl+Z)." },
      "Delete",
    )
    if (choice !== "Delete") return
  }
  const edit = new vscode.WorkspaceEdit()
  for (const node of nodes) edit.deleteFile(node.uri, { recursive: true, ignoreIfNotExists: true })
  // WorkspaceEdit rather than fs.delete: it fires the delete participants and lands on the
  // undo stack, which is a better safety net than the OS trash for source files.
  if (!(await vscode.workspace.applyEdit(edit))) {
    vscode.window.showErrorMessage("Aperture: could not delete.")
    return
  }
  await ctx.refresh()
}

// Move `sources` into `targetDir` — the drop handler's other half, shared with nothing else
// but kept here so every path-mutating operation goes through the same WorkspaceEdit route.
export async function move(ctx: FileOpsContext, sources: ReadonlyArray<vscode.Uri>, targetDir: string) {
  const root = ctx.root()
  if (!root) return
  const target = join(root, targetDir)
  const edit = new vscode.WorkspaceEdit()
  let moved = 0
  for (const source of sources) {
    const name = source.path.slice(source.path.lastIndexOf("/") + 1)
    const destination = vscode.Uri.joinPath(target, name)
    if (destination.toString() === source.toString()) continue
    // Dropping a folder into itself or into its own descendant would delete it. The path
    // prefix test is the whole guard, and it has to run before the edit is applied.
    if (target.toString() === source.toString() || target.path.startsWith(`${source.path}/`)) {
      vscode.window.showErrorMessage(`Aperture: cannot move ${name} into itself.`)
      return
    }
    edit.renameFile(source, destination, { overwrite: false })
    moved++
  }
  if (moved === 0) return
  if (!(await vscode.workspace.applyEdit(edit))) {
    vscode.window.showErrorMessage("Aperture: could not move.")
    return
  }
  await ctx.refresh()
}

function validateName(value: string): string | undefined {
  if (value.trim() === "") return "A name is required."
  if (value.startsWith("/") || value.endsWith("/")) return "A name cannot start or end with a slash."
  if (/[\\:*?"<>|]/.test(value)) return 'A name cannot contain \\ : * ? " < > |'
  if (value.split("/").some((part) => part === "." || part === "..")) return "A name cannot contain . or .. segments."
  return undefined
}

function stemRange(name: string): [number, number] {
  const dot = name.lastIndexOf(".")
  // A leading dot is the whole name (.gitignore), not an empty stem with an extension.
  return [0, dot > 0 ? dot : name.length]
}
