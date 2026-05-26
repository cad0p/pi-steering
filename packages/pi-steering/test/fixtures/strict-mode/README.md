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

## Conventions (apply to every fixture)

- **Pi's wrapping is out of scope.** Pi-coding-agent's `[Extension
  issues]` rendering — the path line, the `Failed to load extension:`
  prefix, and the surrounding yellow block — is pi's contract and may
  evolve across pi versions. What these fixtures pin is the body
  shape and bullet text the bridge produces; the integration tests
  assert against that body, not pi's wrapping.
- **Diagnostic message text mirrors production wording.** If a
  fixture README's expected outcome diverges from what the
  integration tests assert, treat it as drift and update both.
- **Cross-plugin collisions carry no `path`.** No path prefix appears
  between the `[<severity>]` tag and the message text for
  plugin-merger collision diagnostics; their `path` is unset.

## Running these fixtures

Manual fixtures: pin pi at this branch's bridge, then launch from
each fixture dir in a fresh tmux session. See [RUNNING.md](./RUNNING.md)
for the full procedure (pre-flight `settings.json` edit, per-fixture
tmux pattern, post-flight cleanup).

