// SPDX-License-Identifier: MIT
// Part of pi-steering / examples.

/**
 * Example: no-amend rule pack.
 *
 * Equivalent to `steering.json` in this directory but expressed in the
 * v0.1.0 canonical TypeScript form. Drop this file in at
 * `.pi/steering.ts` (or `.pi/steering/index.ts`) to activate.
 *
 * What it enforces: blocks `git commit --amend` in any form. Useful
 * on review-driven workflows where commit-SHA stability matters (an
 * amend rewrites the SHA, which breaks reviewers' cross-push diff
 * tracking).
 *
 * Scope note: the rule is additive and independent of the git plugin
 * (plain pattern, no predicates). The rm / async declarations below
 * restore the classic filesystem + loop rails post-#72; drop them if
 * you want THIS RULE ONLY.
 */

import { defineConfig } from "@cad0p/pi-steering";
import asyncPlugin from "@cad0p/pi-steering/plugins/async";
import rmPlugin from "@cad0p/pi-steering/plugins/rm";

export default defineConfig({
  plugins: [rmPlugin, asyncPlugin],
  rules: [
    {
      name: "no-amend",
      tool: "bash",
      field: "command",
      // Mirrors the pre-subcommand flag slot used by the git
      // plugin's no-force-push so `git -C /path commit --amend`,
      // `git -c key=val commit --amend`, and
      // `git --git-dir=/x commit --amend` are all caught.
      pattern:
        "^git\\b(?:\\s+-{1,2}[A-Za-z]\\S*(?:\\s+\\S+)?)*\\s+commit\\b.*--amend\\b",
      reason:
        "Don't rewrite history with --amend. Create a new commit instead. If you need to fix the last commit's message, do it in a follow-up commit \u2014 PR reviewers track diffs across pushes and amend confuses that.",
    },
  ],
});
