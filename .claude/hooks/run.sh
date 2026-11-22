#!/bin/sh
# Runs a TypeScript hook from this directory with Bun.
#
# Usage: sh run.sh <hook-name>   (runs <hook-name>.ts, passing stdin through)
#
# Exits 0 without doing anything when Bun is not installed, so the hooks never
# get in the way on a machine that has not been set up yet.

project_dir=${CLAUDE_PROJECT_DIR:-$(pwd)}

bun_bin=$(command -v bun 2>/dev/null || true)
if [ -z "$bun_bin" ] && [ -x "$HOME/.bun/bin/bun" ]; then
  bun_bin="$HOME/.bun/bin/bun"
fi
[ -n "$bun_bin" ] || exit 0

exec "$bun_bin" "$project_dir/.claude/hooks/$1.ts"
