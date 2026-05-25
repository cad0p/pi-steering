# Fixture 04 — cwd-mismatch session_start `console.warn`

Exercises the cross-project-resume detection: when pi resumes a
session whose stored cwd differs from where pi was launched, the
bridge emits a `console.warn` from `session_start` and continues
evaluating with launch-cwd rules (the engine is NOT reset).

## Launch invocation

This fixture requires a two-step launch — first create a session
from a directory with no steering config, then resume it from the
fixture's directory (which has the rule). The walk-up loader keys
off the launch cwd, so the rule must live where pi is *resumed*,
not where the session was created.

```bash
# 1. Create a session from a directory with no steering config
#    (so the session's stored cwd is foreign to the rule):
cd /tmp
pi -p "echo creating session"
# Note the session ID printed at the end (e.g. `session-id: abc123`)
# or check the latest session in `pi --resume`.

# 2. cd into the fixture's directory and resume that session:
cd packages/pi-steering/test/fixtures/strict-mode/04-cwd-mismatch-warn/
pi --resume                 # interactive picker; press Tab to switch to
                            # "All" scope, then select the session you
                            # just created
```

## Expected outcome

At session resume, pi's terminal stderr contains a line of the form:

```
[pi-steering] session cwd (/tmp) differs from launch cwd (/path/to/fixture). Steering rules loaded from launch cwd; session-cwd rules NOT applied. To use session-cwd rules, exit pi and re-launch from /tmp.
```

Concretely:

- The line starts with `[pi-steering] session cwd (`.
- It references both the session's cwd (`/tmp`, where the session
  was created in step 1) and the launch cwd (the fixture dir, where
  pi was resumed in step 2).
- Pi continues running normally; the session's chat resumes; tool
  calls are evaluated with the launch-cwd rules.
- After observing the cwd-mismatch warn, ask the model to run
  `echo CWD_PROBE` and the bridge intercepts it: the
  `block-launch-cwd-probe` rule is loaded from the fixture dir's
  `.pi/steering/` (now the launch cwd), so `echo CWD_PROBE` is
  blocked with a `[steering:block-launch-cwd-probe@user]` reason —
  proving launch-cwd config is in force, NOT a re-loaded ctx.cwd
  config (there is no `.pi/steering` under `/tmp`).

The warn lands on stderr at session resume; on `/reload`, pi's
chatContainer clobbers stderr, so the warn is only visible at the
startup boundary.

The integration test `factory-time-load.test.ts` case 13 is the
empirical verification of the cwd-mismatch contract end-to-end. This
fixture is for manual sink-side verification that pi's
`[Extension issues]` rendering path stays connected.

## What this fixture pins

Cwd-mismatch behavior: cross-project resume produces a single
console.warn signal; the engine does NOT disable itself, and the
launch-cwd rule set (here, the `block-launch-cwd-probe` user rule)
remains in force. Partial launch-cwd guardrails beat silently
disabling everything for the resumed session.

## Pre-flight

See `packages/pi-steering/test/fixtures/strict-mode/README.md` for the pi-pinning steps.
