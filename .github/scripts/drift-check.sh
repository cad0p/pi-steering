#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Part of pi-steering.
#
# Weekly upstream drift check (driven by .github/workflows/drift-check.yml):
# runs the 4-stage verification (typecheck, test, build, smoke) against the
# CURRENTLY INSTALLED pi (the workflow bumps it first via `pnpm up`), records
# old -> new pi versions, and writes .drift-summary.md. Exits 0 when every
# stage passed, 1 otherwise (the workflow files a [drift] issue on failure).
#
# Locally testable: `bash .github/scripts/drift-check.sh` from the repo root.

set -u

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

tmp_dir="${TMPDIR:-/tmp}"
summary_file="$repo_root/.drift-summary.md"

# Old pi version — ANCHORED on the importer key line `'@earendil-works/
# pi-coding-agent':` in pnpm-lock.yaml. A bare "first version:" would
# hit @cad0p/unbash-walker (0.1.0, sorts alphabetically earlier). The
# `(ws@…)` suffix (peer-version decorations) is stripped via gsub.
old_pi="$(
  git show HEAD:pnpm-lock.yaml |
    awk '/'"'"'@earendil-works\/pi-coding-agent'"'"':/{f=1} f && /version:/{gsub(/\(.*/,""); print $2; exit}'
)"
old_pi="${old_pi:-unknown}"

# New pi version — RELATIVE path: pi's exports map blocks the bare
# `@earendil-works/pi-coding-agent/package.json` specifier.
new_pi="$(node -p "require('./node_modules/@earendil-works/pi-coding-agent/package.json').version")"

if git diff --quiet -- pnpm-lock.yaml; then
  lockfile_moved=0
else
  lockfile_moved=1
fi

# All four stages ALWAYS run (more signal), each in a subshell
# capturing output + exit code to $tmp_dir/drift-<stage>.{log,exit}.
stages=("typecheck" "test" "build" "smoke")

run_stage() {
  local name="$1"
  shift
  (
    "$@" >"$tmp_dir/drift-$name.log" 2>&1
    echo $? >"$tmp_dir/drift-$name.exit"
  )
}

run_stage typecheck pnpm typecheck
run_stage test pnpm test
run_stage build pnpm build
run_stage smoke node scripts/smoke.mjs

# Collect results into the summary file.
failed=0
: >"$summary_file"
{
  echo "# Weekly drift check — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
  echo "- pi: ${old_pi} -> ${new_pi}"
  if [ "$lockfile_moved" -eq 1 ]; then
    echo "- pnpm-lock.yaml: MOVED"
    git diff --stat -- pnpm-lock.yaml | sed 's/^/  /'
  else
    echo "- pnpm-lock.yaml: unchanged"
  fi
  echo
  echo "## Stages"
  echo
} >>"$summary_file"

stage_summary=""
for name in "${stages[@]}"; do
  code="$(cat "$tmp_dir/drift-$name.exit")"
  if [ "$code" -eq 0 ]; then
    status="PASS"
  else
    status="FAIL"
    failed=1
  fi
  printf -- "- %s: %s (exit %s)\n" "$name" "$status" "$code" >>"$summary_file"
  stage_summary="${stage_summary} ${name}=${status}"
done

for name in "${stages[@]}"; do
  code="$(cat "$tmp_dir/drift-$name.exit")"
  if [ "$code" -ne 0 ]; then
    {
      echo
      echo "### ${name} — log tail (last 40 lines)"
      echo '```'
      tail -40 "$tmp_dir/drift-$name.log"
      echo '```'
    } >>"$summary_file"
  fi
done

if [ "$failed" -eq 0 ]; then
  overall="PASS"
else
  overall="FAIL"
fi
echo "drift-check: pi ${old_pi} -> ${new_pi}; lockfile_moved=${lockfile_moved}; stages:${stage_summary}; overall=${overall}"

exit "$failed"
