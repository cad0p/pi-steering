// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Plugin-shipped rules for the git plugin, one file per rule.
 *
 * This bundle assembles the `rules` array the plugin registers under
 * `Plugin.rules` and re-exports each rule + the shared pattern
 * constants. The per-item files live alongside this index:
 *
 *   - `no-main-commit.ts`       — generic commit-on-protected-branch
 *                                  guard.
 *   - `no-main-commit-github.ts`— github.com specialization emitting
 *                                  PR-flow guidance.
 *   - `patterns.ts`             — `GIT_COMMIT_PATTERN` /
 *                                  `PROTECTED_BRANCH_PATTERN` shared
 *                                  by both rules.
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
 * Rules ride on the branch predicate registered in `../predicates/`
 * and the branch tracker in `../trackers/branch-tracker.ts`. The
 * tracker makes the rule bypass-proof against the
 * `git checkout main && git commit` pattern: the walker folds the
 * checkout into the branch seen by the commit, so the rule still
 * fires.
 */

import type { Rule } from "../../../schema.ts";
import { noMainCommit } from "./no-main-commit.ts";
import { noMainCommitGithub } from "./no-main-commit-github.ts";

export { GIT_COMMIT_PATTERN, PROTECTED_BRANCH_PATTERN } from "./patterns.ts";

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
 * breaks this routing; pinned via a unit test in `./index.test.ts`.
 */
export const rules = [
  noMainCommitGithub,
  noMainCommit,
] as const satisfies readonly Rule[];

export { noMainCommit, noMainCommitGithub };
