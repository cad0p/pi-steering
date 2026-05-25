# Fixture 04 — cwd-mismatch session_start `console.warn`

> **Manual fixture only — requires interactive `--resume` picker.**
> The bridge-side contract is unit-tested in
> `factory-time-load.test.ts`; this fixture is the cross-process
> sink-side check.

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
# 1. Create a session in a guaranteed-clean tmp dir
#    (no .pi/steering reachable from there):
TMP=$(mktemp -d)
cd "$TMP"
pi -p "echo creating session"
# Note the session ID via `pi --resume` (latest entry).

# 2. cd into the fixture's directory and resume that session:
cd packages/pi-steering/test/fixtures/strict-mode/04-cwd-mismatch-warn/
pi --resume                 # interactive picker; press Tab to switch to
                            # "All" scope, then select the session you
                            # just created
```

## Expected outcome

At session resume, pi's terminal stderr contains a line of the form:

```
[pi-steering] session cwd (/tmp/tmp.XXXXXX) differs from launch cwd (/path/to/fixture). Steering rules loaded from launch cwd; session-cwd rules NOT applied. To use session-cwd rules, exit pi and re-launch from /tmp/tmp.XXXXXX.
```

Concretely:

- After observing the warn, ask the model to run `echo CWD_PROBE`.
  Expected: blocked with `[steering:block-launch-cwd-probe@user]`
  (the rule lives in the fixture dir's `.pi/steering/`, which is now
  the launch cwd; the foreign session cwd has no steering config).

The warn lands on stderr at session resume; on `/reload`, pi's
chatContainer clobbers stderr, so the warn is only visible at the
startup boundary.

## What this fixture pins

Cwd-mismatch behavior: cross-project resume produces a single
console.warn signal; the engine does NOT disable itself, and the
launch-cwd rule set (here, the `block-launch-cwd-probe` user rule)
remains in force. Partial launch-cwd guardrails beat silently
disabling everything for the resumed session.

## Pre-flight

_See [`../RUNNING.md`](../RUNNING.md) § Pre-flight._
