# Strict-mode end-to-end fixtures

Manual fixtures verifying the headline factory-time-throw contract
end-to-end through pi's extension loader and `[Extension issues]`
diagnostic block. Each fixture exercises one new decision point
introduced by the strict-mode refactor.

The vitest suite asserts source-side throw shapes and the
single-line / multi-line message format directly. These fixtures
extend that coverage to the cross-package render path: the bridge's
thrown factory must be captured by pi's loader and rendered into the
yellow `[Extension issues]` block (or, for the cwd-mismatch case,
appear on stderr from `console.warn`).

## Fixtures

| Dir | Decision point |
|---|---|
| `01-warning-default-throws/` | Warning-class throws on default `failOnWarnings` |
| `02-warning-with-opt-out-no-throw/` | Warning-class does NOT throw with `failOnWarnings: false`; emits to console.warn |
| `03-error-with-opt-out-still-throws/` | Error-class throws regardless of `failOnWarnings: false` |
| `04-cwd-mismatch-warn/` | `session_start` console.warn fires on foreign-cwd resume |
| `05-aggregated-render-mixed/` | 1 error + 2 warnings render with errors-first ordering and the multi-line aggregated shape |

Each fixture's `README.md` documents the launch invocation and the
expected outcome.

## Pre-flight: pin pi at this branch's bridge

Pi is loaded as a separate package; the orchestrator's running pi
won't pick up this branch's bridge automatically. Before running any
fixture:

```bash
# 1. Push this branch to origin.
cd <repo-root>
git push -u origin <branch-name>

# 2. Edit ~/.pi/agent/settings.json so the pi-steering pin reads:
#      "git:github.com/cad0p/pi-steering-hooks@<branch-name>"
#    (replace whatever ref is currently pinned).

# 3. Refresh the on-disk runtime clone:
pi update --extensions   # or: pi remove && pi install
```

Pi reads `settings.json` on every new launch; the orchestrator's
already-running pi keeps its currently-loaded bridge code. Do NOT
`/reload` the orchestrator's pi until the fixture runs are done — a
`/reload` would re-resolve `settings.json` and pull in this branch's
bridge mid-orchestration.

## Per-fixture run pattern (tmux)

For each fixture, run the verification in a fresh tmux session so
the new pi invocation reads the updated `settings.json`:

```bash
FIXTURE=01-warning-default-throws  # or 02..05
FIXTURE_DIR=<repo-root>/packages/pi-steering/test/fixtures/strict-mode/$FIXTURE

tmux kill-session -t pi-e2e-$FIXTURE 2>/dev/null
tmux new-session -d -s pi-e2e-$FIXTURE -x 220 -y 60 -c "$FIXTURE_DIR"
tmux send-keys -t pi-e2e-$FIXTURE "pi" Enter
sleep 6
tmux capture-pane -t pi-e2e-$FIXTURE -p | head -80
# Confirm the captured pane matches the fixture README's "Expected outcome".
tmux kill-session -t pi-e2e-$FIXTURE
```

Fixture 04 (cwd-mismatch) is the only one that requires a two-step
launch — see its README.

## Post-flight

After all fixtures are confirmed green:

- If the PR is ready: keep `settings.json` pointing at this branch.
- If the PR is still in review: restore `settings.json` to its prior
  pin so the orchestrator's pi keeps running a known-good bridge.
