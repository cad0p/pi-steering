// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Tests for the git plugin's `rules` array (`./index.ts`).
 *
 * The one load-bearing array-level pin: first-match-wins ordering.
 * The github-specific rule (`no-main-commit-github`) must appear
 * BEFORE the generic (`no-main-commit`) in the plugin's rule array —
 * on a github clone + on main, BOTH rules' `when:` clauses match and
 * first-match-wins routes the github-flavored guidance to github
 * users. Reordering for stylistic reasons silently regresses the
 * user-facing message; this test makes that regression visible.
 *
 * (Per-rule shape / behavior pins live in `./rules/no-main-commit.test.ts`
 * and `./rules/no-main-commit-github.test.ts`.)
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import gitPlugin from "./index.ts";

describe("rules: array order (first-match-wins)", () => {
  it("first-match-wins ordering: github rule appears BEFORE no-main-commit in the plugin's rule array", () => {
    // Load-bearing ordering. On a github clone + on main, BOTH rules'
    // `when:` clauses match — first-match-wins routes the github-
    // flavored guidance to github users. Reordering for stylistic
    // reasons (alphabetical, etc.) silently regresses user-facing
    // behavior; this assertion makes that regression visible.
    const rules = gitPlugin.rules ?? [];
    const githubIdx = rules.findIndex(
      (r) => r.name === "no-main-commit-github",
    );
    const genericIdx = rules.findIndex((r) => r.name === "no-main-commit");
    assert.notEqual(githubIdx, -1, "no-main-commit-github must be registered");
    assert.notEqual(genericIdx, -1, "no-main-commit must be registered");
    assert.ok(
      githubIdx < genericIdx,
      `expected no-main-commit-github (idx ${githubIdx}) BEFORE no-main-commit (idx ${genericIdx})`,
    );
  });
});
