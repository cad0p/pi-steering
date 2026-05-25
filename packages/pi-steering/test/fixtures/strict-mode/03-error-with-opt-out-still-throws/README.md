# Fixture 03 — error-class throws regardless of `failOnWarnings: false`

Exercises the throw-rule asymmetry: `error`-class diagnostics ALWAYS
escalate to a thrown factory error, even when the user has set
`failOnWarnings: false`. The opt-out applies to warnings only.

Specifically: two plugins both register a tracker called `branch`.
That's a tracker-name-collision — error-class because two plugins
claiming the same state dimension is always a bug: the loser's
tracker is silently unreachable, the rules that consult it become
predicate-key references to a now-shadowed tracker, and
config-merge order is the only thing that decides which side wins.
Even with `failOnWarnings: false`, the runtime throws.

## Launch invocation

```bash
cd packages/pi-steering/test/fixtures/strict-mode/03-error-with-opt-out-still-throws/
pi -p "echo test"
```

## Expected outcome

Pi renders the factory throw in its `[Extension issues]` startup
block (yellow). The body of the error — what the bridge controls
and what the integration tests pin — is:

```
1 config issue:
  - [error] tracker name collision: both plugins "plugin-a" and "plugin-b" register a tracker called "branch". ...
```

Concretely:

- The thrown error message starts with `1 config issue:` and the
  bullet carries an `[error]` severity tag.
- The bullet text references the colliding tracker name `branch`.
- The session continues running but the steering engine is NOT loaded.

See conventions in `../README.md` (pi-wrapping out of scope; message
text owned by `plugin-merger.ts`).

## What this fixture pins

Throw-rule semantics: `error`-class diagnostics override the
`failOnWarnings: false` opt-out. A user who has opted out of strict
mode for warnings still gets a thrown factory on tracker-name
collisions.

## Pre-flight

See `packages/pi-steering/test/fixtures/strict-mode/README.md` for the pi-pinning steps.
