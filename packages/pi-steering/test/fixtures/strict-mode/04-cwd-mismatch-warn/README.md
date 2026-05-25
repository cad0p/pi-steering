# Fixture 04 — cwd-mismatch session_start `console.warn`

Exercises the cross-project-resume detection: when pi resumes a
session whose stored cwd differs from where pi was launched, the
bridge emits a `console.warn` from `session_start` and continues
evaluating with launch-cwd rules (the engine is NOT reset).

## Launch invocation

This fixture requires a two-step launch — first create a session in
this fixture's directory, then resume it from a different directory:

```bash
# 1. Create a session in the fixture's directory:
cd packages/pi-steering/test/fixtures/strict-mode/04-cwd-mismatch-warn/
pi -p "echo creating session"
# Note the session ID printed at the end (e.g. `session-id: abc123`)
# or check the latest session in `pi --resume`.

# 2. cd to a different directory and resume that session:
cd /tmp
pi --resume                 # interactive picker; press Tab to switch to
                            # "All" scope, then select the session you
                            # just created
# OR (non-interactive):
pi --session <session-id-from-step-1> -p "echo resuming" 2>stderr.log
cat stderr.log
```

## Expected outcome

`stderr.log` (or terminal stderr if not redirected) contains a line of
the form:

```
[pi-steering] session cwd (/path/to/fixture) differs from launch cwd (/tmp). Steering rules loaded from launch cwd; session-cwd rules NOT applied. To use session-cwd rules, exit pi and re-launch from /path/to/fixture.
```

Concretely:

- The line starts with `[pi-steering] session cwd (`.
- It references both the session's cwd (the fixture dir, where the
  session was created) and the launch cwd (where pi was launched
  from in step 2).
- Pi continues running normally; the session's chat resumes; tool
  calls are evaluated with the launch-cwd rules.

The warn lands on stderr only (chatContainer-clobbered on
`/reload`); for non-interactive `pi -p` invocations, redirect stderr
to capture it.

## What this fixture pins

Cwd-mismatch behavior: cross-project resume produces a single
console.warn signal; the engine does NOT disable itself. Partial
launch-cwd guardrails beat silently disabling everything for the
resumed session.

## Pre-flight

See `packages/pi-steering/test/fixtures/strict-mode/README.md` for the pi-pinning steps.
