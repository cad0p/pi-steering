# Internal invariants — `S`, `E`, and `O` tags

Short reference for the load-bearing invariants flagged across the
engine source. These are NOT a public API contract — they are
maintainer shorthand to keep related call sites traceable across
files. Source comments cite the tag and rely on this file for the
definition.

This file ships with the package as a maintainer-facing glossary;
it is not part of the public API surface (no exports), but is
included in the npm tarball for source-readers consulting tagged
call sites on disk.

## Safety invariants (`S`)

The engine evaluates user-authored steering rules against
LLM-proposed tool calls. The `S` invariants are the layered defenses
that keep a buggy or malformed plugin / rule from silently
fail-OPENING the gate.

### `S1` — fail-closed isolation

**Where:** `evaluator.ts` (`evaluateEvent` top-level wrap; per-rule
try/catch), `evaluator-internals/predicates.ts` (per-predicate
try/catch in `runPredicateChain`).

A predicate that throws — built-in or plugin-supplied, sync or async
— is treated as "rule does not fire", logged via `console.warn` with
the rule name + `@<source>` tag + key, and evaluation continues with
the next rule. The top-level wrap in `evaluator.ts` is the outermost
catch: if the engine's own scaffolding throws (parse errors, walker
bugs, corrupted session JSONL), the tool is BLOCKED with an
engine-tagged reason so the agent sees the throw came from the
engine, not from a rule.

The same pattern applies to observers in `observer-dispatcher.ts` —
a throwing observer is isolated to its own dispatch and never
escalates.

### `S2` — write-through-read consistency

**Where:** `evaluator-internals/context.ts` (`createAppendEntry` /
`createFindEntries` paired-cache invariant).

When `createAppendEntry` and `createFindEntries` share the same
cache map (the evaluator wires them this way per tool_call; the
observer-dispatcher wires them per tool_result), an `appendEntry`
write during rule A's `onFire` invalidates the cached read for that
`customType`, so rule B's `when.happened` predicate within the same
phase sees the fresh entry. Callers that omit the shared cache get
per-closure snapshot behavior (pre-`S2`), which is sound only when
the closure never interleaves reads with writes.

### `S3` — name validation

**Where:** `plugin-merger.ts` (`validateName`; production pipeline
via `validateUserConfigNames` + `resolvePlugins`), `evaluator.ts`
(defensive throw in `buildEvaluator`), `observer-dispatcher.ts`
(defensive throw in `buildObserverDispatcher`).

Rule / plugin / observer names flow into user-visible strings — the
`[steering:<name>@<source>]` block-reason tag shown to the LLM, the
`@<source>` tag in warning logs, override-comment target matching,
`disabledRules` / `disabledPlugins` config references. Names
containing whitespace, control characters, `]`, or newlines let a
malicious or careless config author forge block reasons that
deceive the agent.

The standard pipeline routes user names through
`validateUserConfigNames` and plugin-shipped names through
`resolvePlugins`, both of which produce an `invalid-name`
diagnostic that aggregates into the strict-mode throw. The
defensive throws inside `buildEvaluator` and
`buildObserverDispatcher` cover direct callers (unit tests, future
SDK embedders) that build a runtime without going through
`buildSessionRuntime` / `loadHarness` / `loadSteeringConfig`.

## Evaluation invariants (`E`)

### `E1` — cross-rule write visibility within a phase

**Where:** paired-cache wiring in `evaluator.ts` and
`observer-dispatcher.ts`; cache mechanism in
`evaluator-internals/context.ts`.

Within a single tool_call (or tool_result) phase, every rule reads
the same world. If rule A's `onFire` writes a session entry via
`appendEntry`, rule B's `when.happened` predicate later in the same
phase MUST see that entry; otherwise rules that coordinate via
session state become order-dependent and surprising. `E1` is
implemented by the shared cache invalidation described in `S2` —
the two tags travel together because the implementation is one
mechanism, but the concerns are distinct: `S2` is about cache
freshness; `E1` is about evaluation semantics.

## Orchestration invariants (`O`)

### `O1` — observer-drop parity between runtime and CLI

**Where:** `internal/session-runtime.ts` (`buildSessionRuntime` →
`finalizePluginState`); `bin/pi-steering.ts`
(`runCliMergeWithInfoCapture`).

**What:** Both surfaces apply `disabledRules` filtering BEFORE
running `dropUnusedObservers`, so an observer whose only consumers
are disabled rules surfaces the same `console.info` breadcrumb in
both paths. A future surface that bypasses this ordering would see
different observer-drop behavior than the runtime.

**Pinned by:** `internal/session-runtime.test.ts` (runtime branch);
`bin/pi-steering.test.ts` (CLI branch).
