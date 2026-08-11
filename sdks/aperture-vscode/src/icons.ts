import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import * as vscode from "vscode"
import { chipKey, chipSvg, type ChipLayout, type Segment } from "./chip"

// Getting a generated SVG in front of VSCode as a tree icon.
//
// `TreeItem.iconPath` takes a Uri, which the tree renderer turns into a CSS
// `background-image: url(...)`. Two deliveries can satisfy that and they trade off
// differently, so both are here behind one interface and a setting:
//
//  - "data": a `data:image/svg+xml;base64,…` URI. No I/O, no cleanup, no files to go
//    stale. This is the default because it is strictly simpler when it works.
//  - "file": the SVG written under the extension's globalStorage and referenced as a
//    `file:` Uri. Certain to render (it is what long-standing extensions do) and correctly
//    remapped to `vscode-remote-resource:` when the workspace is remote — which matters
//    here, since this repo is normally opened over Remote-WSL.
//
// If chips come up blank, `aperture.tree.iconDelivery: "file"` is the one-setting fix.

export type IconDelivery = "data" | "file"

export class ChipIcons {
  // One cache entry is one {light,dark} pair, which is what a TreeItem consumes. Since C1
  // the two differ only in the outline stroke — facet colour is a fixed hex on both — so
  // one chip identity keys the pair.
  private readonly cache = new Map<string, vscode.IconPath>()
  private directory: string | undefined

  constructor(
    private readonly storage: vscode.Uri,
    private delivery: IconDelivery,
  ) {}

  // Changing delivery invalidates every URI we have handed out, so the cache goes with it.
  setDelivery(delivery: IconDelivery) {
    if (delivery === this.delivery) return
    this.delivery = delivery
    this.cache.clear()
  }

  for(segments: ReadonlyArray<Segment>, layout: ChipLayout): vscode.IconPath | undefined {
    if (segments.length === 0) return undefined
    const key = chipKey(segments, layout)
    let icon = this.cache.get(key)
    if (!icon) {
      // Both themes still get their own SVG: the chip's outline is the one thing that has
      // to follow the editor theme, since it exists to give the chip an edge against the
      // sidebar background.
      icon = {
        light: this.uri(chipSvg(segments, layout, "light"), key, "light"),
        dark: this.uri(chipSvg(segments, layout, "dark"), key, "dark"),
      }
      this.cache.set(key, icon)
    }
    return icon
  }

  private uri(svg: string, key: string, theme: string): vscode.Uri {
    if (this.delivery === "data") {
      return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`)
    }
    const file = path.join(this.dir(), `${hash(key)}-${theme}.svg`)
    // Written synchronously so `getTreeItem` stays synchronous — a tree that has to await
    // an fs round trip per row paints in visible stages. Each file is ~400 bytes and is
    // written once per distinct chip, so the whole cost is a few hundred small writes.
    if (!fs.existsSync(file)) fs.writeFileSync(file, svg, "utf8")
    return vscode.Uri.file(file)
  }

  private dir(): string {
    if (this.directory) return this.directory
    const dir = path.join(this.storage.fsPath, "chips")
    // Cleared on first use each session rather than pruned: the set of live chips is a
    // function of the active Lens, so yesterday's Lens leaves files nothing will ever ask
    // for again. Rebuilding is lazy and costs one write per chip actually shown.
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    this.directory = dir
    return dir
  }
}

function hash(key: string): string {
  return crypto.createHash("sha1").update(key).digest("hex").slice(0, 16)
}
