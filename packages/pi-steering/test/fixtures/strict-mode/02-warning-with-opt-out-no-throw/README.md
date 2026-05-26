# Fixture 02 — warning-class with `failOnWarnings: false` opt-out

Exercises the legacy fail-soft escape hatch: with
`defineConfig({ failOnWarnings: false })`, warning-class diagnostics
fall through to `console.warn` instead of throwing. The bridge keeps
running with the merged config.

## Launch invocation

```bash
cd packages/pi-steering/test/fixtures/strict-mode/02-warning-with-opt-out-no-throw/
pi -p "echo test" 2>stderr.log
cat stderr.log
```

## Expected outcome

- Pi does NOT print an `[Extension issues]` block at startup.
- Pi runs to completion (`echo test` executes; the agent answers).
- `stderr.log` (or the terminal's stderr if not redirected) contains
  at least one line of the form:
  ```
  [pi-steering] [warning] duplicate rule "dup" — plugins "plugin-a" (kept) and "plugin-b" (ignored); first-registered wins
  ```
  (single-line console.warn shape; bracketed `[warning]` severity tag
  matches the multi-line aggregate's per-bullet convention, no
  `<count> config issue` header — that's the aggregated-throw format
  only.)

See conventions in `../README.md`.

## What this fixture pins

`failOnWarnings: false` opt-out: warnings fall through to
`console.warn` instead of escalating to a thrown factory error,
rendered in the unified single-line shape. This is the only path
back to legacy fail-soft semantics; it should work end-to-end
without a thrown factory.

## Pre-flight

_See [`../RUNNING.md`](../RUNNING.md) § Pre-flight._
