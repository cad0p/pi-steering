# Fixture 05 — aggregated render: 1 error + 2 warnings, errors-first

Exercises the aggregated multi-line error format: a single thrown
factory error contains all diagnostics with errors first, no
severity-column padding, no footer hint.

## Launch invocation

```bash
cd packages/pi-steering/test/fixtures/strict-mode/05-aggregated-render-mixed/
pi -p "echo test"
```

## Expected outcome

Pi prints an `[Extension issues]` block (yellow) at startup whose body
matches the multi-line shape:

```
Failed to load extension: <bridge path>: 3 config issues:
  - [error] tracker name "events" is reserved: plugin "plugin-a" registers a tracker under that name but the evaluator uses it on `walkerState` for speculative-entry synthesis consumed by the built-in `when.happened` predicate. Rename the tracker.
  - [warning] duplicate observer "obs-x" — plugins "plugin-a" (kept) and "plugin-b" (ignored); first-registered wins
  - [warning] duplicate rule "dup" — plugins "plugin-a" (kept) and "plugin-b" (ignored); first-registered wins
```

Concretely:

- The thrown error's body opens with `3 config issues:` (plural).
- The first non-header line is an `[error]` bullet.
- The remaining lines are `[warning]` bullets — errors come first.
- Each bullet is `  - [<severity>] <message>` (two-space indent, dash,
  space, severity in brackets, no padding for column alignment).
- No path prefix (the diagnostics are cross-plugin collisions; their
  `path` is unset).
- No footer hint after the bullets.

Note: the literal message text is set by `plugin-merger.ts`'s
diagnostic emission. If the wording changes there, update both the
integration tests' regex assertions and this README in lock-step.

## What this fixture pins

Aggregated render shape: `<count> config issue(s):` header,
errors-first ordering, no padding, no footer. Mixed-severity
aggregation in a single thrown factory error proves the runtime
batches every diagnostic into one error rather than throwing on
the first one.

## Pre-flight

See `packages/pi-steering/test/fixtures/strict-mode/README.md` for the pi-pinning steps.
