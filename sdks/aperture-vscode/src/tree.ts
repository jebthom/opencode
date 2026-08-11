import * as vscode from "vscode"
import { chipSegments, chipTooltip, type ChipLayout, type LegendEntry } from "./chip"
import type { ChipIcons } from "./icons"
import type { Entry, TreeModel } from "./model"

// The Aperture file tree.
//
// This exists because a FileDecoration cannot show a composition — one ThemeColor and a
// two-character badge is the entire budget, so O2's Explorer pips have to reduce a file's
// facet mix to its plurality winner. A TreeItem's icon is a URI, so here each row carries
// a generated SVG of the whole mix, and folders carry their subtree's rollup — which the
// Explorer decoration deliberately declined to attempt.
//
// The trade is that we own the tree: none of the Explorer's own affordances come for free.
// What we do inherit by setting `resourceUri` is the label, the file icon theme's icon for
// rows we don't paint, and every FileDecorationProvider's output — including git's badges
// and our own. Decorations colour the label and badge, not the icon slot, so they compose
// with the chip rather than competing with it for it.

export type Node = {
  // Workspace-relative, forward-slashed. The tree's identity for a row.
  readonly rel: string
  readonly name: string
  readonly dir: boolean
  readonly uri: vscode.Uri
}

export interface TreeContext {
  readonly model: () => TreeModel
  readonly facets: () => ReadonlyArray<string>
  readonly legend: () => ReadonlyArray<LegendEntry>
  readonly suppressed: () => ReadonlySet<string>
  readonly layout: () => ChipLayout
  readonly icons: ChipIcons
  readonly root: () => vscode.Uri | undefined
  // Move dropped resources into a workspace-relative directory. Lives in commands.ts with
  // the rest of the WorkspaceEdit-based file operations.
  readonly move: (sources: ReadonlyArray<vscode.Uri>, targetDir: string) => Promise<void>
}

// Dragging in and out of the tree speaks `text/uri-list`, the same mime the Explorer and
// the editor use — so a row can be dragged onto the editor area to open it, and files can
// be dragged in from the Explorer or the OS.
const URI_LIST = "text/uri-list"

export class ApertureTree implements vscode.TreeDataProvider<Node>, vscode.TreeDragAndDropController<Node> {
  readonly dragMimeTypes = [URI_LIST]
  readonly dropMimeTypes = [URI_LIST]

  private readonly changed = new vscode.EventEmitter<Node | undefined>()
  readonly onDidChangeTreeData = this.changed.event
  // Nodes are interned by path so a row keeps its identity across refreshes. Without this
  // every refresh hands VSCode fresh objects, `reveal` can never match a node it was given
  // earlier, and expansion state resets.
  private readonly nodes = new Map<string, Node>()

  constructor(private readonly ctx: TreeContext) {}

  dispose() {
    this.changed.dispose()
  }

  // Firing `undefined` here is not the full-invalidation trap it is for
  // FileDecorationProvider (which drops its whole cache and repaints the tree bare for a
  // round trip). VSCode re-queries only the nodes that are actually expanded, keeps
  // expansion state, and `getChildren` is a trie lookup with no I/O — so a repaint is
  // cheap and does not flicker.
  refresh(node?: Node) {
    this.changed.fire(node)
  }

  getChildren(node?: Node): Node[] {
    return this.ctx
      .model()
      .children(node?.rel ?? "")
      .map((entry) => this.intern(entry))
  }

  getParent(node: Node): Node | undefined {
    const parent = parentPath(node.rel)
    return parent === "" ? undefined : this.nodes.get(parent)
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.uri,
      node.dir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    )
    item.id = node.rel
    item.contextValue = node.dir ? "apertureFolder" : "apertureFile"
    if (!node.dir) item.command = { command: "vscode.open", title: "Open", arguments: [node.uri] }

    const weights = this.ctx.model().weights(node.rel, node.dir)
    if (!weights?.length) {
      // Unpainted — a non-source file, or a folder with nothing painted below it. Leaving
      // `iconPath` unset is deliberate: with `resourceUri` set, VSCode falls back to the
      // user's file icon theme, so these rows look exactly like the Explorer's and the
      // chip stays a positive signal rather than every row carrying one.
      return item
    }

    const facets = this.ctx.facets()
    const legend = this.ctx.legend()
    const layout = this.ctx.layout()
    const suppressed = this.ctx.suppressed()
    // One set of segments for both themes: every facet colour is a fixed hex (PLAN C1), so
    // there is nothing left to re-resolve when the editor theme changes.
    item.iconPath = this.ctx.icons.for(chipSegments(weights, facets, legend, { layout, suppressed }), layout)

    const breakdown = chipTooltip(weights, facets, legend)
    const tooltip = new vscode.MarkdownString()
    tooltip.appendMarkdown(`**${node.name}**\n\n${breakdown}`)
    item.tooltip = tooltip
    return item
  }

  handleDrag(source: readonly Node[], data: vscode.DataTransfer) {
    data.set(URI_LIST, new vscode.DataTransferItem(source.map((node) => node.uri.toString()).join("\r\n")))
  }

  async handleDrop(target: Node | undefined, data: vscode.DataTransfer) {
    const item = data.get(URI_LIST)
    if (!item) return
    // The mime is a CRLF-separated list by spec, but a single-item drag from some sources
    // arrives bare and comment lines are legal — hence the filter rather than a plain split.
    const uris = (await item.asString())
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) => vscode.Uri.parse(line))
    if (uris.length === 0) return
    // Dropping onto a file means "into the folder it is in" — the Explorer's behaviour, and
    // the only reading that makes sense for a move.
    const directory = target === undefined ? "" : target.dir ? target.rel : parentPath(target.rel)
    await this.ctx.move(uris, directory)
  }

  // Look a node up by path, materialising it if the tree knows about it. This is how the
  // TUI's reveal events and auto-reveal find something to hand to `TreeView.reveal`.
  find(rel: string): Node | undefined {
    const existing = this.nodes.get(rel)
    if (existing) return existing
    const model = this.ctx.model()
    if (!model.has(rel) || rel === "") return undefined
    // Materialise the whole ancestor chain: `reveal` walks up via getParent, which reads
    // from `nodes`, so an un-materialised ancestor would break the walk.
    const parts = rel.split("/")
    let parent = ""
    for (const part of parts) {
      const path = parent === "" ? part : `${parent}/${part}`
      this.intern({ rel: path, name: part, dir: model.isDir(path) })
      parent = path
    }
    return this.nodes.get(rel)
  }

  private intern(entry: Entry): Node {
    const existing = this.nodes.get(entry.rel)
    if (existing && existing.dir === entry.dir) return existing
    const root = this.ctx.root()
    const node: Node = {
      rel: entry.rel,
      name: entry.name,
      dir: entry.dir,
      uri: root ? vscode.Uri.joinPath(root, entry.rel) : vscode.Uri.file(entry.rel),
    }
    this.nodes.set(entry.rel, node)
    return node
  }
}

// "" for a top-level path — the root, which is not itself a node.
function parentPath(rel: string): string {
  const slash = rel.lastIndexOf("/")
  return slash === -1 ? "" : rel.slice(0, slash)
}
