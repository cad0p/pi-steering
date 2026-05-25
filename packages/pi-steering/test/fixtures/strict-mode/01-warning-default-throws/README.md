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

Pi renders the factory throw in its `[Extension issues]` startup
block (yellow). The body of the error — what the bridge controls
and what the integration tests pin — is:

```
1 config issue:
  - [warning] duplicate rule "dup" — plugins "plugin-a" (kept) and "plugin-b" (ignored); first-registered wins
```

Concretely:

- The thrown error message starts with `1 config issue:` (the
  singular form; aggregated factories with N>1 issues use the
  `N config issues:` plural).
- At least one bullet line begins with `  - [warning]`.
- The bullet text references the colliding rule name `dup`.

The session continues running but the steering engine is NOT loaded
for this session (the throw aborted bridge setup). Tool calls pass
through unsteered.

See conventions in `../README.md` (pi-wrapping out of scope; message
text owned by `plugin-merger.ts`; cross-plugin collisions carry no
`path`).

## Pre-flight

See `packages/pi-steering/test/fixtures/strict-mode/README.md` for
the steps to point pi at this branch's bridge before running the
fixture.

## What this fixture pins

Default-on behavior: a non-fatal collision becomes fatal at factory
time, surfacing in the only diagnostic channel that survives
`/reload` (`[Extension issues]`).
