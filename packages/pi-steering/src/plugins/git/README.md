# pi-steering/plugins/git

Git plugin for [pi-steering](../../../README.md) — branch
awareness, upstream checks, and git-specific cwd tracking on top of
the core steering engine.

> **Default-on.** As of v0.1.0 this plugin is registered
> automatically via [`DEFAULT_PLUGINS`](../../defaults.ts). New
> consumers get the predicates, rules, tracker, and cwd extensions
> without an explicit `import`. Opt out via
> `defineConfig({ disabledPlugins: ["git"] })` or drop all defaults
> with `disableDefaults: true`. See [Disabling](#disabling) below.

## What it ships

| Surface | Names | Purpose |
|---|---|---|
| Predicates | `branch`, `upstream`, `commitsAhead`, `hasStagedChanges`, `isClean`, `remote` | New `when.<key>` slots for rules |
| Rules | `no-main-commit`, `no-main-commit-github` | Block direct commits to protected branches; the `-github` variant emits PR-flow guidance on github.com clones |
| Trackers | `branch` | Walker-threaded branch state (`git checkout X` advances) |
| Tracker extensions | `cwd.git` | `--git-dir=` / `--work-tree=` flag parsing on top of the built-in cwd tracker |

## Usage

```ts
// .pi/steering.ts
import { defineConfig } from "pi-steering";

export default defineConfig({
  // No explicit `plugins: [gitPlugin]` needed — it's in DEFAULT_PLUGINS.
  rules: [
    // Custom rule layered on top of the plugin's predicates:
    {
      name: "no-push-when-dirty",
      tool: "bash",
      field: "command",
      pattern: "^git\\s+push\\b",
      when: { isClean: false },
      reason: "Stash or commit your working changes before pushing.",
    },
  ],
});
```

Explicit import still works (e.g. in tests driving `loadHarness`
with `includeDefaults: false`):

```ts
import { defineConfig } from "pi-steering";
import gitPlugin from "pi-steering/plugins/git";

export default defineConfig({
  plugins: [gitPlugin],
  rules: [...],
});
```

### Disabling

Keep the predicates + tracker, drop the shipped rule:

```ts
import { defineConfig } from "pi-steering";

export default defineConfig({
  disabledRules: ["no-main-commit"],
});
```

Drop the whole git plugin (no `branch` / `upstream` / ... predicates,
no tracker, no cwd extensions, no rule):

```ts
import { defineConfig } from "pi-steering";

export default defineConfig({
  disabledPlugins: ["git"],
});
```

Drop EVERYTHING shipped — both `DEFAULT_RULES` and
`DEFAULT_PLUGINS`:

```ts
import { defineConfig } from "pi-steering";

export default defineConfig({
  disableDefaults: true,
});
```

## Predicate reference

### `branch`

Match the current git branch.

```ts
when: { branch: /^main$/ }
when: { branch: "^feat-" }                             // string = regex source
when: { branch: { pattern: /^main$/, onUnknown: "allow" } }
```

Resolution is a three-way discrimination on what the branch tracker
knows about the current `tool_call` chain:

1. **value** — the tracker observed an in-chain `git checkout <X>` /
   `git switch <X>` with a statically-resolvable target. Match the
   pattern against `X`. This is what makes
   `git checkout main && git commit` evaluate against `main`, not
   the pre-chain branch.
2. **unknown** — the tracker observed a checkout but couldn't
   resolve the target (e.g. `git checkout $VAR`). Apply `onUnknown`
   policy WITHOUT shelling out: `git branch --show-current` here
   would return the PRE-checkout branch and silently defeat the
   walker — exactly the case the tracker exists to catch.
3. **missing** — no branch-changing command fired in the current
   chain. Shell out via `git branch --show-current` in `ctx.cwd`;
   the shell's current state is the answer the predicate wants.

`onUnknown` defaults to `"block"` (fail-closed) — if the branch
can't be determined (dynamic checkout, exec failure, detached HEAD
in the missing case), the predicate reports "match" so the rule
still fires.

### `upstream`

Match the current branch's configured upstream (`git rev-parse
--abbrev-ref @{upstream}`). Same shape as `branch`, no tracker today.

```ts
when: { upstream: /^origin\/main$/ }
when: { upstream: { pattern: "^origin/", onUnknown: "allow" } }
```

### `commitsAhead`

Match the count of commits ahead of a revision (default
`@{upstream}`).

```ts
when: { commitsAhead: { eq: 1 } }                       // exactly one
when: { commitsAhead: { gt: 0 } }                       // at least one
when: { commitsAhead: { gt: 0, lt: 5 } }                // 1..4
when: { commitsAhead: { wrt: "origin/main", eq: 1 } }
```

At least one of `eq` / `gt` / `lt` must be specified. Returns
`false` (rule skips) on exec failure or non-numeric output — pair
with `upstream` for fail-closed behavior.

### `hasStagedChanges` / `isClean`

Boolean predicates.

```ts
when: { hasStagedChanges: true }   // staged changes exist
when: { hasStagedChanges: false }  // no staged changes
when: { isClean: true }            // working tree clean
when: { isClean: false }           // working tree dirty
```

Returns `false` on exec failure. Layer with `upstream` if you need
fail-closed behavior.

### `remote`

Match the `origin` remote URL. Same shape as `branch`.

```ts
when: { remote: /github\.com:org\// }
when: { remote: { pattern: /production/, onUnknown: "block" } }
```

## Shipped rules

### `no-main-commit`

Blocks direct commits to protected branches (`main`, `master`,
`mainline`, `trunk`).

```ts
{
  name: "no-main-commit",
  tool: "bash",
  field: "command",
  pattern: "^git\\b(?:\\s+-{1,2}[A-Za-z]\\S*(?:\\s+\\S+)?)*\\s+commit\\b",
  when: { branch: /^(main|master|mainline|trunk)$/ },
  reason: "Don't commit directly to a protected branch...",
  noOverride: false,
}
```

Overridable via `# steering-override: no-main-commit — <reason>` on
the bash command. Catches `git -C /path commit`, `sh -c 'git
commit'`, and — thanks to the branch tracker — `git checkout main
&& git commit`.

The pattern is shared with `no-main-commit-github` via the
exported `GIT_COMMIT_PATTERN` constant in `rules.ts` (re-exported
from `pi-steering/plugins/git`), so a regex change to one rule is
physically forced onto the other (a unit test pins each rule's
`pattern` field against the constant by value).

### `no-main-commit-github`

Specialization of `no-main-commit` for github.com clones. Same
pattern + protected-branch list, plus a `remote: /github\.com[/:]/`
clause; the reason text emits PR-flow guidance (`gh pr merge`)
instead of the generic feature-branch reminder, plus a safety
reminder against unsolicited PR merges or ready-for-review flips.

```ts
{
  name: "no-main-commit-github",
  tool: "bash",
  field: "command",
  pattern: GIT_COMMIT_PATTERN, // shared with no-main-commit
  when: {
    branch: /^(main|master|mainline|trunk)$/,
    remote: /github\.com[/:]/,
  },
  reason: (ctx) => /* multi-paragraph PR-flow + safety guidance */,
  noOverride: false,
}
```

**First-match-wins ordering is load-bearing.**
`no-main-commit-github` is registered BEFORE `no-main-commit` in
the plugin's rule array. On a github clone + on main, both rules'
`when:` clauses match — first-match-wins routes the
github-flavored guidance to github users. On non-github contexts
(Brazil packages, vault paths, /tmp scratch repos with non-github
remotes) the github rule's `remote:` predicate doesn't match → the
engine falls through to the generic `no-main-commit`. A unit test
pins this position so reordering for stylistic reasons trips the
suite.

Under walker-unknown cwd (`cd "$VAR" && git commit`), the rule
still fires fail-closed — but the reason text switches to the
standard `walkerUnknownCwdReason` message instead of claiming
github-specific context the engine couldn't verify.

## Customization

Three escape valves of increasing scope, ordered most → least
common. None of these are exemption-by-cwd patterns — see the
[Cwd-based exemption](#cwd-based-exemption-advanced) advanced
section below for that case (it has subtle
walker-unknown-cwd interactions you need to handle explicitly).

```ts
// 1. Swap the github rule's PR-flow guidance for the generic
//    feature-branch reminder (keep blocking direct commits to
//    main, just drop the github-specific message). The generic
//    `no-main-commit` is still active and fires on a github clone
//    + main; disabling the github specialization makes the engine
//    emit the generic message instead.
import { defineConfig } from "pi-steering";

export default defineConfig({
  disabledRules: ["no-main-commit-github"],
});
```

```ts
// 2. Disable + replace with a freshly-named user rule whose
//    `reason` text points your agents at an internal skill /
//    runbook. Spread the original to inherit `pattern`, `when:`,
//    `tool`, `field`, and `noOverride` — only override the field
//    you actually want to change. No `when:` changes → no
//    walker-unknown-cwd interactions to reason about.
import { defineConfig } from "pi-steering";
import { noMainCommitGithub } from "pi-steering/plugins/git";
import type { Rule } from "pi-steering";

const myNoMainCommitGithub = {
  ...noMainCommitGithub,
  // FRESH name — see warning below; reusing the original name has
  // two failure modes, both bad.
  name: "myorg-no-main-commit-github",
  reason:
    "You're on a github clone's protected branch. " +
    "Open a PR for review (`gh pr create`); land via `gh pr merge` " +
    "after approval. See skill `git-discipline@myorg` for our team's " +
    "PR conventions.\n\n" +
    "Safety: NEVER merge a PR or mark it ready-for-review unless " +
    "the user explicitly asks. Wait for explicit user instruction.",
} as const satisfies Rule;

export default defineConfig({
  disabledRules: ["no-main-commit-github"], // drop the default
  rules: [myNoMainCommitGithub],            // replacement on
});
```

```ts
// 3. Disable the entire git plugin (drops all gitPlugin
//    predicates / rules / trackers / extensions):
import { defineConfig } from "pi-steering";

export default defineConfig({
  disabledPlugins: ["git"],
});
```

### ⚠️ Always use a fresh name when extending or replacing a plugin rule

pi-steering composes user rules and plugin rules as
`[...userRules, ...pluginRules]` with **no name dedup at the
user/plugin layer.** Reusing the plugin rule's name in your config
has two failure modes, **both bad**, depending on whether you also
use `disabledRules`:

1. **Same name + NO `disabledRules`** → BOTH rules are kept. The
   plugin rule fires alongside your customized version, so paths
   you intended to exempt still get the original message. The
   customization silently fails to apply.

2. **Same name + `disabledRules: ["original-name"]`** → the
   `disabledRules` filter applies to ALL rules with that name
   across both the user-config and plugin-rule sources. NEITHER
   rule fires. Silent fail-OPEN — the worst outcome for a safety
   rule, since the agent now has no guardrail at all.

Use a fresh name (e.g., `myorg-no-main-commit-github`). Pair it
with `disabledRules: ["no-main-commit-github"]` so the original is
dropped and your fresh-named replacement survives the disable
filter.

### Cwd-based exemption (advanced)

A common request: "don't block commits to main inside my vault
directory" (vault flows like napkin-distill commit to a `main`
branch by design). Cwd-based exemptions need care because:

1. **The generic `no-main-commit` still fires on vault paths.**
   Disabling only the github specialization isn't enough — the
   generic rule's `when:` is just `{ branch: ... }` (no `remote:`
   gate), so it fires on any github clone or any other repo whose
   branch is one of the protected names. To actually exempt a path
   you need to disable BOTH shipped rules and register a
   user-authored rule.

2. **`not: { cwd: ... }` flips fail-closed to fail-OPEN under
   walker-unknown cwd.** When the walker can't statically resolve
   cwd (`cd "$VAR" && git commit`), the inner predicate's
   fail-closed-on-unknown default fires `cwd: ...` → the `not:`
   wrapper inverts → the carve-out predicate FAILS → the rule
   skips. A user committing inside `cd "$VAULT_PATH" && git
   commit` slips past the rule even when not in a vault path. The
   fix is to use the predicate's object form with explicit
   `onUnknown: "allow"` so the inner predicate allows on unknown,
   the `not:` inverts to fire, and the outer rule fires fail-closed
   under walker-unknown cwd.

Worked example:

```ts
import { defineConfig } from "pi-steering";
import { noMainCommit } from "pi-steering/plugins/git";
import type { Pattern, Rule } from "pi-steering";

const VAULT_DIRS: Pattern[] = [
  /\/Goldmine\//,
  /\/\.cache\/napkin-distill\//,
];

const noMainCommitExceptVault = {
  ...noMainCommit,
  name: "myorg-no-main-commit-except-vault",
  when: {
    ...noMainCommit.when,
    // Object form with `onUnknown: "allow"` is LOAD-BEARING here.
    // Bare `not: { cwd: VAULT_DIRS }` would be fail-OPEN under
    // walker-unknown cwd — the inner cwd: predicate fires fail-
    // closed on unknown, the `not:` inverts, the outer rule
    // skips, and a `cd "$VAR" && git commit` slips past. Setting
    // `onUnknown: "allow"` on the inner predicate makes it
    // ALLOW under unknown — the `not:` then inverts to FIRE —
    // and the outer rule stays fail-closed.
    not: { cwd: { pattern: VAULT_DIRS, onUnknown: "allow" } },
  },
} as const satisfies Rule;

export default defineConfig({
  // BOTH shipped rules disabled; otherwise the generic
  // `no-main-commit` fires on vault paths and the carve-out
  // doesn't deliver on its name.
  disabledRules: ["no-main-commit-github", "no-main-commit"],
  rules: [noMainCommitExceptVault],
});
```

The `Pattern[]` annotation on `VAULT_DIRS` lets you mix string
patterns and RegExp without TS narrowing the array's element type
to `RegExp[]`. Annotation is optional for all-RegExp arrays (TS
infers `RegExp[]`, a subtype of `Pattern[]`); explicit `Pattern[]`
becomes load-bearing only when mixing strings and RegExp.

## Authoring new plugins

This directory is the canonical reference for plugin authors. The
file layout separates concerns:

- `branch-tracker.ts` — walker state modifier (one file per tracker).
- `cwd-extensions.ts` — modifiers layering onto existing trackers.
- `predicates.ts` — one handler per `when.<key>` slot.
- `rules.ts` — rule definitions consuming the above.
- `index.ts` — default export assembling the plugin.

Each file has its own test suite; `integration.test.ts` pins end-to-
end wiring through `resolvePlugins` and `buildEvaluator`. Copy-adapt
this layout for your own plugin.

### Composable building blocks

Several pieces are re-exported from `pi-steering/plugins/git` so
downstream plugins can reuse the engine's walker conventions
without reimplementing them:

- `walkerString(ctx, key, initialSentinel)` / `WalkerStringResult` —
  narrows the walker-tracker value read off `ctx.walkerState[key]`
  into one of `{ kind: "value"; value }` | `{ kind: "unknown" }` |
  `{ kind: "missing" }`. The three-way discrimination is what the
  `branch` predicate uses to dispatch on tracker state without
  string-comparison sentinel checks.
- `NO_CHECKOUT_IN_CHAIN` — the branch tracker's fall-through
  sentinel for chains where no in-chain `git checkout` /
  `git switch` fired. Plugin authors who consume tracker state
  directly can match this sentinel to know they need to fall back
  to a shell-out (vs. `"unknown"`, where the tracker observed an
  unresolvable checkout).
- `GIT_COMMIT_PATTERN` — the bash-command regex source matching
  `git commit` (with optional pre-subcommand flag slots). Reuse
  in plugin rules that want to share applicability with the
  shipped commit-on-main rules.

Example import:

```ts
import {
  walkerString,
  NO_CHECKOUT_IN_CHAIN,
  GIT_COMMIT_PATTERN,
} from "pi-steering/plugins/git";
```
