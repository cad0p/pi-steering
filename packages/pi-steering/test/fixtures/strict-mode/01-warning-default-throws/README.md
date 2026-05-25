# Fixture 01 — warning-class diagnostic throws on default `failOnWarnings`

Exercises the headline strict-mode contract: a `warning`-class
diagnostic (here, two plugins shipping a rule with the same name)
escalates to a thrown factory error when the user has not set
`failOnWarnings: false`.

## Launch invocation

```bash
cd packages/pi-steering/test/fixtures/strict-mode/01-warning-default-throws/
pi -p "echo test"
```

(Or launch interactive `pi` from this directory and observe the
`[Extension issues]` block at startup.)

## Expected outcome

Pi prints an `[Extension issues]` block (yellow) at startup whose body
matches:

```
Failed to load extension: <bridge path>: <count> config issue(s):
  - [warning] duplicate rule "dup" — plugins "plugin-a" (kept) and "plugin-b" (ignored); first-registered wins
```

Concretely:

- The block header is pi's `[Extension issues]`.
- The thrown error message starts with `<count> config issue` (singular
  if there's one, plural otherwise).
- At least one bullet line begins with `  - [warning]`.
- The bullet text references the colliding rule name `dup`.
- The bullet has NO path prefix between `[warning]` and the message —
  cross-plugin collisions are not attributable to a single config file.

The session continues running but the steering engine is NOT loaded
for this session (the throw aborted bridge setup). Tool calls pass
through unsteered.

## Pre-flight

See `packages/pi-steering/test/fixtures/strict-mode/README.md` and the
design's "End-to-end gate strategy" section for the steps to point pi
at this branch's bridge before running the fixture.

## What this fixture pins

Default-on behavior: a non-fatal collision
becomes fatal at factory time, surfacing in the only diagnostic
channel that survives `/reload` (`[Extension issues]`).
