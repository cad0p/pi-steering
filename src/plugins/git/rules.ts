// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Plugin-shipped rules for the git plugin.
 *
 * Rules here ship as SUGGESTED defaults - the plugin is opt-in (users
 * must explicitly import and list it under `plugins: [...]`), so
 * shipping a curated starter set matches the ADR's "distribution unit
 * for rule packs" framing.
 *
 * Users who want the branch predicate but NOT `no-main-commit` can
 * keep it by disabling the rule selectively:
 *
 *   ```ts
 *   defineConfig({
 *     plugins: [gitPlugin],
 *     disabledRules: ["no-main-commit"],
 *   });
 *   ```
 *
 * Rules ride on the branch predicate registered in `./predicates.ts`
 * and the branch tracker in `./branch-tracker.ts`. The tracker makes
 * the rule bypass-proof against the `git checkout main && git commit`
 * pattern: the walker folds the checkout into the branch seen by the
 * commit, so the rule still fires.
 */

import type { Rule } from "../../schema.ts";
import { walkerString } from "./predicates/index.ts";
import { NO_CHECKOUT_IN_CHAIN } from "./trackers/branch-tracker.ts";

/**
 * Bash command pattern matching `git commit` (with optional pre-subcommand
 * flag slots like `git -C /path commit ...`). Shared by `no-main-commit`
 * and `no-main-commit-github` so the family stays byte-equal as the
 * regex evolves; reorderings that touch one rule's pattern can't
 * silently drift from the other.
 *
 * Exported so tests can pin each rule's `pattern` field against this
 * constant by value (`noMainCommit.pattern === GIT_COMMIT_PATTERN`).
 * That catches accidental divergence between the two rules' patterns
 * (e.g. one drops a `\b`, the other doesn't) and removal/rename of
 * the constant itself. It does NOT catch a future inlining of the
 * literal at a rule's definition site with the SAME bytes — string
 * primitives compare by value, so byte-equal copy-pasted literals
 * pass `===`. Plugin authors who need true shared-reference pinning
 * should use a `RegExp` (object) constant instead of a string source.
 */
export const GIT_COMMIT_PATTERN =
  "^git\\b(?:\\s+-{1,2}[A-Za-z]\\S*(?:\\s+\\S+)?)*\\s+commit\\b";

/**
 * Protected branch names that the gitPlugin's commit-on-main rules
 * block by default (`main`, `master`, `mainline`, `trunk`). Shared by
 * `no-main-commit` and `no-main-commit-github` so the protected-
 * branch list stays uniform across the rule family — adding an alias
 * here (e.g. a vendor-specific default-branch name) automatically
 * propagates to both rules.
 *
 * `RegExp` (object) constant rather than a string source: that gives
 * true shared-reference pinning at the test layer
 * (`noMainCommit.when.branch === PROTECTED_BRANCH_PATTERN`), which
 * also catches a future inline of the SAME bytes at a rule's
 * definition site — something the string-source `GIT_COMMIT_PATTERN`
 * pin can't do (see its JSDoc for the value-vs-reference tradeoff).
 */
export const PROTECTED_BRANCH_PATTERN = /^(main|master|mainline|trunk)$/;

/**
 * `no-main-commit` - block direct commits to a protected branch
 * (main / master / mainline / trunk).
 *
 * Fires on:
 *   - `git commit -m "..."` when the current branch is one of the
 *     protected names,
 *   - `git checkout main && git commit ...` (the branch tracker folds
 *     the checkout into the branch state for the commit),
 *   - `sh -c 'git commit ...'` (wrapper expansion),
 *   - `git -C /other commit ...` where the repo at `/other` is on
 *     main (the `branch` predicate queries git at the effective cwd).
 *
 * Does NOT fire on:
 *   - `git commit` while on a feature branch,
 *   - `git log --grep="commit"` (anchored to `git commit`, not
 *     arbitrary git subcommands),
 *   - `echo 'git commit -m "x"'` (extraction anchors to the
 *     basename).
 *
 * Fail-closed on unresolvable branch: if the branch predicate can't
 * determine the current branch (detached HEAD, not a repo, or the
 * tracker collapsed to `unknown` via `git checkout $VAR`), the rule
 * fires by default. Authors who want the allow-through behavior
 * supply the object form explicitly:
 *
 *   `when: { branch: { pattern: /.../, onUnknown: "allow" } }`
 *
 * Reason text is dynamic via {@link ReasonFn}: when the branch
 * tracker has resolved a concrete branch name for the guarded
 * command (statically from a `git checkout <name>` earlier in the
 * chain), the name is injected into the block message so the agent
 * sees "You are on 'main'" instead of a generic reminder. The
 * ReasonFn filters out the tracker's internal sentinels
 * (`NO_CHECKOUT_IN_CHAIN` — no in-chain checkout, exec-fallback
 * path; `"unknown"` — dynamic checkout the walker couldn't
 * resolve) so those strings never leak into the agent-facing
 * message; the static actionable tail still guides the agent to a
 * feature branch in those cases.
 *
 * Pairs with {@link noMainCommitGithub} (specialization for
 * github.com clones, placed BEFORE this rule in the rule array so
 * first-match-wins routes the github-flavored guidance to github
 * users; non-github contexts fall through to this generic rule).
 *
 * Override: allowed (the rule is overridable via a
 * `# steering-override: no-main-commit` comment). This is a workflow
 * rule, not an inherent-destructiveness rule - authors override when
 * the commit is intentional (e.g. release process on `main`).
 */
export const noMainCommit = {
  name: "no-main-commit",
  tool: "bash",
  field: "command",
  pattern: GIT_COMMIT_PATTERN,
  when: { branch: PROTECTED_BRANCH_PATTERN },
  reason: (ctx) => {
    // Delegate the sentinel classification to `walkerString` — the
    // same three-way discrimination (value / unknown / missing)
    // every other branch-consumer in this plugin uses. Single source
    // of truth for tracker-sentinel semantics; future sentinel
    // additions update one site (the classifier in predicates.ts),
    // not this filter too. Empty-string remains filtered inline as
    // a defensive check against future tracker contracts (detached
    // HEAD or similar); the branch tracker doesn't emit it today.
    const res = walkerString(ctx, "branch", NO_CHECKOUT_IN_CHAIN);
    const branch =
      res.kind === "value" && res.value !== "" ? res.value : undefined;
    const onClause = branch !== undefined ? ` You are on '${branch}'.` : "";
    return (
      `Don't commit directly to a protected branch ` +
      `(main / master / mainline / trunk).${onClause} ` +
      `Create a feature branch first: \`git checkout -b feat/...\`.`
    );
  },
  // Explicit override-OK: workflow rules are intentionally
  // overridable.
  noOverride: false,
} as const satisfies Rule;

/**
 * `no-main-commit-github` — block direct commits to a protected
 * branch (main / master / mainline / trunk) on github.com clones.
 * Specialization of {@link noMainCommit} that emits PR-flow guidance
 * instead of the generic feature-branch reminder.
 *
 * Pairs with {@link noMainCommit}: this rule is more specific (adds
 * `remote:` check), placed BEFORE `noMainCommit` in the plugin's
 * rule array so first-match-wins routing surfaces the github-
 * flavored reason on github clones. Non-github contexts (Brazil
 * packages, vault paths, /tmp scratch repos with non-github remotes)
 * fall through to the generic `noMainCommit`.
 *
 * Override: allowed (intentionally overridable for legitimate cases
 * like release-process commits to main). User can:
 *   - Disable: `disabledRules: ["no-main-commit-github"]`
 *   - Per-invocation: `# steering-override: no-main-commit-github` comment
 *   - Customize: see gitPlugin's README "Customization" section
 *
 * @remarks Both `https://github.com/...` and `git@github.com:...`
 *          clone URLs are matched (the `remote:` regex's `[/:]`
 *          character class accepts both the HTTPS path separator
 *          and the SSH user-host separator).
 *
 * @remarks `remote:` is configured as `{ pattern, onUnknown: "allow" }`.
 *          The `onUnknown: "allow"` argument governs the case where
 *          the walker resolved cwd but the inner exec couldn't
 *          determine the remote URL — i.e. a known-cwd repo with no
 *          `origin` remote configured (fresh-init, repo with
 *          `upstream` but no `origin`, or other exec failure). In that
 *          case the predicate skips and the engine falls through to
 *          the generic `noMainCommit` (correct generic message).
 *          The branch predicate stays at default `onUnknown: "block"`
 *          (fail-closed) so protected-branch detection isn't weakened.
 *
 * Walker-unknown cwd: the `remote:` leaf surfaces trinary
 * `"unknown"` (via the inline walker-unknown-cwd guard at the top of
 * the handler) before the inner exec runs whenever
 * `walkerState.cwd === "unknown"`. The engine's leaf-level
 * `onUnknown:` policy reads the `"allow"` set on the leaf, projects
 * `"unknown" → false`, and the github rule SKIPS. The engine then
 * falls through to the generic {@link noMainCommit} (only `branch:`
 * leaf), which fires fail-CLOSED and emits the generic
 * protected-branch reason. The github-specific rule deliberately
 * does NOT fire under walker-unknown cwd — a github-flavored reason
 * would overstate what the engine has confirmed.
 *
 * Walker-unknown branch state: when `walkerState.cwd` is known but
 * the branch tracker collapses to its `"unknown"` sentinel (dynamic
 * checkout the walker couldn't resolve), the reason fn routes to a
 * "could not verify the current branch" message rather than
 * asserting a specific protected branch the engine hasn't
 * confirmed.
 *
 * Pattern is shared with `noMainCommit` via the exported
 * {@link GIT_COMMIT_PATTERN} constant so the two rules' bash-
 * command applicability stays byte-equal as the family evolves.
 *
 * @see {@link noMainCommit}
 */
export const noMainCommitGithub = {
  name: "no-main-commit-github",
  tool: "bash",
  field: "command",
  pattern: GIT_COMMIT_PATTERN,
  when: {
    branch: PROTECTED_BRANCH_PATTERN,
    // Intentional fail-OPEN — falls through to the generic
    // `noMainCommit` rule when origin can't be resolved.
    //
    // `onUnknown: "allow"` posture: a github-specialized rule
    // should only fire when github context is confirmed. The
    // `"allow"` covers two opt-out paths:
    //   1. Known-cwd no-`origin` case (fresh-init repo, repo with
    //      `upstream` but no `origin`, or other exec failure):
    //      handler returns `false`, leaf projects to false, github
    //      rule skips. Generic `noMainCommit` fires next — user
    //      gets the correct generic message rather than PR-flow
    //      guidance for a repo where there's no PR to open.
    //   2. Walker-unknown cwd (`cd "$VAR" && git commit`): the
    //      handler's inline guard surfaces trinary `"unknown"`,
    //      the leaf-level `"allow"` projects to false, github rule
    //      skips. Generic `noMainCommit` fires fail-CLOSED via the
    //      branch predicate's default `onUnknown: "block"`.
    // Both paths land on the same generic protected-branch reason,
    // avoiding overstated github-specific claims when context is
    // unverified.
    remote: { pattern: /github\.com[/:]/, onUnknown: "allow" },
  },
  reason: (ctx) => {
    // Walker-unknown branch: protected-branch unverified. Don't
    // make a positive claim about which protected branch is
    // involved.
    //
    // (CWD is always known in this rule's reason fn — `remote:`'s
    //  `onUnknown: "allow"` projects walker-unknown CWD to false at
    //  the leaf level, so the rule skips to the generic
    //  `noMainCommit` before this reason fn runs.)
    const branchRes = walkerString(ctx, "branch", NO_CHECKOUT_IN_CHAIN);
    if (branchRes.kind === "unknown") {
      return (
        `Could not verify the current branch — your command used a ` +
        `dynamic checkout target (\`git checkout $VAR\`) that ` +
        `couldn't be statically resolved. If you're on a protected ` +
        `branch (main / master / mainline / trunk) on a github ` +
        `clone, open a PR for review instead of committing directly.` +
        `\n\n` +
        `Safety: NEVER merge a PR or mark it ready-for-review unless ` +
        `the user explicitly asks. Wait for explicit user instruction.`
      );
    }
    // Reuse the same walkerString-based branch interpolation idiom
    // noMainCommit's reason fn uses (single source of truth for
    // tracker-sentinel semantics).
    const branch =
      branchRes.kind === "value" && branchRes.value !== ""
        ? branchRes.value
        : undefined;
    const onClause = branch !== undefined ? ` You are on '${branch}'.` : "";
    // Prose says "protected branch" rather than "main branch":
    // the `when:` clause matches all four protected branch names
    // (main / master / mainline / trunk). Mirrors
    // `noMainCommit`'s wording, which lists them.
    return (
      `You're on a github clone's protected branch.${onClause} Open ` +
      `a PR for review; \`gh pr merge\` lands the change after ` +
      `approval. Direct commits to a protected branch bypass review ` +
      `and break PR discipline.` +
      `\n\n` +
      `Safety: NEVER merge a PR or mark it ready-for-review unless ` +
      `the user explicitly asks. Wait for explicit user instruction.`
    );
  },
  // Explicit override-OK: workflow rules are intentionally
  // overridable. Mirrors `noMainCommit`'s posture. Without this
  // field the schema defaults to `defaultNoOverride: true`
  // (fail-closed), making the rule non-overridable and contradicting
  // the JSDoc above.
  noOverride: false,
} as const satisfies Rule;

/**
 * Suggested rules for the git plugin.
 *
 * **Order matters — first-match-wins.** The github-specific rule
 * (`no-main-commit-github`) is placed BEFORE the generic
 * (`no-main-commit`) so on github clones + on main, the github
 * rule's `remote:` predicate matches → fires first → user gets
 * PR-flow guidance. On non-github contexts (Brazil packages, vault
 * paths, scratch repos with non-github remotes) the github rule's
 * `remote:` predicate doesn't match → the engine falls through to
 * the generic `no-main-commit`. Reordering for stylistic reasons
 * breaks this routing; pinned via a unit test in `./rules.test.ts`.
 */
export const rules = [
  noMainCommitGithub,
  noMainCommit,
] as const satisfies readonly Rule[];
