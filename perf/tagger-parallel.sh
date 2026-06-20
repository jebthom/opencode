#!/usr/bin/env bash
#
# tagger-parallel.sh — measure the wall-clock win from running tag calls
# concurrently. Sweeps --concurrency over the `balanced` partitioner (N equal-load
# bins run N-wide), so for each level wall ≈ a single bin's latency. Reports wall
# time and any throttling (retries / backoff) so you can see where rate limits
# start to bite — on a tier with headroom, they shouldn't.
#
# Usage:
#   ANTHROPIC_API_KEY=... perf/tagger-parallel.sh [slice-dir] [mode-flag]
#     slice-dir   subtree to tag (default packages/opencode/src/server)
#     mode-flag   --minimal (default) | --medium | --full
#
# Env overrides:
#   LEVELS="1 2 4 8 16"   concurrency levels to sweep (also the partition count).
#   REPEAT=3              runs per level, averaged (default 3).
#
# Reading it: C=1 is the single-call baseline (whole slice in one request). As C
# rises wall time should fall toward the latency of one ~(files/C)-file call, then
# flatten once per-call overhead dominates. 'retries'>0 means throttling appeared
# — back the concurrency off below that level for production.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

SLICE="${1:-packages/opencode/src/server}"
MODE="${2:---minimal}"
LEVELS="${LEVELS:-1 2 4 8 16}"
REPEAT="${REPEAT:-3}"

if [[ ! -d "$SLICE" ]]; then
  echo "slice dir not found: $SLICE" >&2
  exit 1
fi
if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "ANTHROPIC_API_KEY not set — the parallel test makes live calls." >&2
  exit 1
fi

echo "==> tagger parallelization sweep"
echo "    slice    : $SLICE"
echo "    mode     : $MODE"
echo "    levels   : $LEVELS"
echo "    repeat   : $REPEAT (averaged)"
echo

printf "  %-6s %-6s %-12s %-9s %s\n" "conc" "bins" "wall_avg(s)" "retries" "note"
base=""
for C in $LEVELS; do
  out="$(bun perf/tagger-eval.ts "$SLICE" "$MODE" --batch balanced --concurrency "$C" --partitions "$C" --repeat "$REPEAT" 2>/dev/null)"
  bins="$(echo "$out" | awk '/^  bins/ {print $3; exit}')"
  wall="$(echo "$out" | awk -F'[:s]' '/wallclock/ {v=$2; gsub(/ /,"",v); sum+=v; n++} END{if(n) printf "%.1f", sum/n}')"
  retr="$(echo "$out" | awk '/throttle/ {sum+=$3} END{print sum+0}')"
  bins="${bins:-?}"
  wall="${wall:-?}"
  # speedup vs the C=1 baseline
  note=""
  if [[ -z "$base" ]]; then
    base="$wall"
  elif [[ "$wall" != "?" && "$base" != "?" && "$base" != "0" ]]; then
    note="$(awk -v b="$base" -v w="$wall" 'BEGIN{ if(w>0) printf "%.1fx vs C=1", b/w }')"
  fi
  [[ "$retr" != "0" ]] && note="${note:+$note, }THROTTLED"
  printf "  %-6s %-6s %-12s %-9s %s\n" "$C" "$bins" "$wall" "$retr" "$note"
done

echo
echo "Floor = latency of one (files/C)-file call; past that, more workers won't help."
echo "Compare C=1 here (one big call) against production fixed-30 (~sequential) to see"
echo "the full win. Any 'THROTTLED' row is where rate limits start — stay under it."
