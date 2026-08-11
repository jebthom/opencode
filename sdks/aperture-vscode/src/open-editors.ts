import * as vscode from "vscode"
import { chipSegments, chipTooltip, type ChipLayout, type LegendEntry } from "./chip"
import type { ChipIcons } from "./icons"
import type { TreeModel } from "./model"

// The Aperture container's Open Editors section.
//
// Cheaper than the file tree: `vscode.window.tabGroups` already *is* the model, so there is
// no enumeration, no watcher and no trie — just a projection of the tab state, with the
// same facet chip the file tree uses so the two read as one view.
//
// Groups only appear as rows when there is more than one, matching the built-in Open
// Editors: a single-group workspace should not pay an indent level for a header that says
// nothing.

export type EditorNode =
  | { readonly kind: "group"; readonly group: vscode.TabGroup }
  | { readonly kind: "tab"; readonly tab: vscode.Tab; readonly uri: vscode.Uri | undefined }

export interface OpenEditorsContext {
  readonly model: () => TreeModel
  readonly facets: () => ReadonlyArray<string>
  readonly legend: () => ReadonlyArray<LegendEntry>
  readonly suppressed: () => ReadonlySet<string>
  readonly layout: () => ChipLayout
  readonly icons: ChipIcons
  readonly relative: (uri: vscode.Uri) => string
}

export class ApertureOpenEditors implements vscode.TreeDataProvider<EditorNode> {
  private readonly changed = new vscode.EventEmitter<EditorNode | undefined>()
  readonly onDidChangeTreeData = this.changed.event

  constructor(private readonly ctx: OpenEditorsContext) {}

  dispose() {
    this.changed.dispose()
  }

  refresh() {
    this.changed.fire(undefined)
  }

  getChildren(node?: EditorNode): EditorNode[] {
    const groups = vscode.window.tabGroups.all
    if (node === undefined) {
      if (groups.length > 1) return groups.map((group) => ({ kind: "group", group }))
      return tabsOf(groups[0])
    }
    return node.kind === "group" ? tabsOf(node.group) : []
  }

  getTreeItem(node: EditorNode): vscode.TreeItem {
    if (node.kind === "group") {
      const index = vscode.window.tabGroups.all.indexOf(node.group) + 1
      const item = new vscode.TreeItem(`Group ${index}`, vscode.TreeItemCollapsibleState.Expanded)
      item.id = `group:${index}`
      item.contextValue = "apertureTabGroup"
      return item
    }

    const { tab, uri } = node
    const item = new vscode.TreeItem(tab.label)
    // Unique per tab, and stable while the tab is where it is — without an id the rows
    // renumber on every refresh and selection jumps.
    item.id = `tab:${vscode.window.tabGroups.all.indexOf(tab.group)}:${uri?.toString() ?? tab.label}`
    item.contextValue = "apertureTab"
    if (!uri) return item

    // resourceUri rather than the label alone, so git's decorations and the file icon
    // theme apply here exactly as they do in the file tree.
    item.resourceUri = uri
    item.command = { command: "vscode.open", title: "Open", arguments: [uri] }
    const rel = this.ctx.relative(uri)
    const slash = rel.lastIndexOf("/")
    // The built-in Open Editors shows the containing directory as dim trailing text; the
    // dot is how a dirty tab reads when we cannot replace the close button with one.
    item.description = `${tab.isDirty ? "● " : ""}${slash === -1 ? "" : rel.slice(0, slash)}`

    const weights = this.ctx.model().weights(rel, false)
    if (weights?.length) {
      const facets = this.ctx.facets()
      const legend = this.ctx.legend()
      const layout = this.ctx.layout()
      const suppressed = this.ctx.suppressed()
      item.iconPath = this.ctx.icons.for(chipSegments(weights, facets, legend, { layout, suppressed }), layout)
      item.tooltip = new vscode.MarkdownString(`**${rel}**\n\n${chipTooltip(weights, facets, legend)}`)
    }
    return item
  }
}

function tabsOf(group: vscode.TabGroup | undefined): EditorNode[] {
  if (!group) return []
  // Only text/diff/notebook/custom inputs carry a URI; a webview or terminal tab is still a
  // row, it just has no file behind it to paint or open.
  return group.tabs.map((tab) => ({ kind: "tab" as const, tab, uri: uriOf(tab.input) }))
}

function uriOf(input: unknown): vscode.Uri | undefined {
  if (input instanceof vscode.TabInputText) return input.uri
  if (input instanceof vscode.TabInputNotebook) return input.uri
  if (input instanceof vscode.TabInputCustom) return input.uri
  // A diff shows two files; the modified side is the one being edited, which is what the
  // chip and the open command should refer to.
  if (input instanceof vscode.TabInputTextDiff) return input.modified
  return undefined
}
