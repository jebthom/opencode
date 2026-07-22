#!/usr/bin/env bash
# Start Aperture against a target repo.
#
#   aperture                 # paint the current directory
#   aperture /path/to/repo   # paint an explicit target
#
# Exists because `bun run dev` resolves its script from the Aperture repo root and then moves
# the process into packages/opencode (--cwd), so it cannot simply be run from the participant's
# workspace. Any extra args are forwarded to the CLI.
set -euo pipefail

target="${1:-$PWD}"
if [ "$#" -gt 0 ]; then shift; fi

# Resolve before cd'ing away: a relative positional would otherwise be resolved against the
# Aperture repo, not the participant's workspace.
target="$(realpath "$target")"

cd /opt/aperture
exec bun run dev "$target" --port 4096 "$@"
