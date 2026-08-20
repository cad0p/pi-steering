// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Shared pattern constants for the git plugin's commit-on-main rules.
 *
 * Extracted from the rules bulk file during the per-item layout
 * refactor: `GIT_COMMIT_PATTERN` and `PROTECTED_BRANCH_PATTERN` are
 * shared by `no-main-commit` and `no-main-commit-github` so the
 * family stays byte-equal as the regexes evolve.
 */

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
