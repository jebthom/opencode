#!/usr/bin/env bash
# Build the extension and package it into a .vsix using bun.
#
# Why this script exists: `vsce package` runs the `vscode:prepublish` npm script, and
# under Remote-WSL the only `npm` on PATH is the Windows one — it spawns cmd.exe, can't
# use the WSL UNC cwd, and can't find `bun`, so the build step fails. We build here with
# bun instead, then temporarily drop `vscode:prepublish` while vsce packages (restored on
# exit via the backup), so vsce has nothing to run.
set -euo pipefail
cd "$(dirname "$0")"

bun run package

cp package.json .package.json.bak
trap 'mv .package.json.bak package.json' EXIT
bun -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json","utf8"));delete p.scripts["vscode:prepublish"];fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\n")'

bunx @vscode/vsce package --no-dependencies
echo "Packaged: $(ls -t ./*.vsix | head -1)"
