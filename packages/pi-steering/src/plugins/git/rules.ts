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
import { walkerUnknownCwdReason } from "../../helpers/walker-unknown-cwd-reason.ts";
import { NO_CHECKOUT_IN_CHAIN } from "./branch-tracker.ts";
import { walkerString } from "./predicates.ts";

/**
 * Bash command pattern matching `git commit` (with optional pre-subcommand
 * flag slots like `git -C /path commit ...`). Shared by `no-main-commit`
 * and `no-main-commit-github` so the family stays byte-equal as the
 * regex evolves; reorderings that touch one rule's pattern can't
 * silently drift from the other. See the package README's
 * "Pre-subcommand flag slots" note for the regex's intent.
 */
const GIT_COMMIT_PATTERN =
	"^git\\b(?:\\s+-{1,2}[A-Za-z]\\S*(?:\\s+\\S+)?)*\\s+commit\\b";

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
	when: { branch: /^(main|master|mainline|trunk)$/ },
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
		const onClause =
			branch !== undefined ? ` You are on '${branch}'.` : "";
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
 * Walker-unknown cwd produces the standard
 * {@link walkerUnknownCwdReason} text instead of the github-
 * specific guidance — under walker-unknown we haven't actually
 * verified the user is on a github clone's main branch, and
 * claiming so would be misleading. The `remote:` predicate's
 * `requireKnownCwd` wrap (inherited from `predicates.ts`) handles
 * the `when:` side; this ReasonFn handles the agent-facing message.
 *
 * Pattern is shared with `noMainCommit` via the module-private
 * {@link GIT_COMMIT_PATTERN} constant so the two rules' bash-
 * command applicability stays byte-equal as the family evolves.
 *
 * @see {@link walkerUnknownCwdReason}
 * @see {@link noMainCommit}
 */
export const noMainCommitGithub = {
	name: "no-main-commit-github",
	tool: "bash",
	field: "command",
	pattern: GIT_COMMIT_PATTERN,
	when: {
		branch: /^(main|master|mainline|trunk)$/,
		remote: /github\.com[/:]/,
	},
	reason: (ctx) => {
		// Walker-unknown cwd: don't claim github-specific context when
		// the walker couldn't verify it. Use the standard helper for
		// the consistent "current directory:" message + the wrap's
		// fail-closed framing. Same pattern as the dynamic-reason-
		// runtime-cwd example.
		if (ctx.walkerState?.["cwd"] === "unknown") {
			return walkerUnknownCwdReason(ctx, "github clone status");
		}
		// Reuse the same walkerString-based branch interpolation idiom
		// noMainCommit's reason fn uses (single source of truth for
		// tracker-sentinel semantics).
		const res = walkerString(ctx, "branch", NO_CHECKOUT_IN_CHAIN);
		const branch =
			res.kind === "value" && res.value !== "" ? res.value : undefined;
		const onClause =
			branch !== undefined ? ` You are on '${branch}'.` : "";
		return (
			`You're on a github clone's main branch.${onClause} Open a PR ` +
			`for review; \`gh pr merge\` lands the change after approval. ` +
			`Direct commits to main bypass review and break PR discipline.` +
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
