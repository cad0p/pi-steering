// SPDX-License-Identifier: MIT
// Part of pi-steering / examples.

/**
 * Example: draft-prs-only rule pack.
 *
 * Equivalent to `steering.json` in this directory but expressed in the
 * v0.1.0 canonical TypeScript form. Drop this file in at
 * `.pi/steering.ts` (or `.pi/steering/index.ts`) to activate.
 *
 * What it enforces: `gh pr create` must include `--draft`. Useful on
 * teams that require a human review step before flipping a PR from
 * draft to ready.
 *
 * Scope note: the rule is additive. Since issue #72 nothing is
 * engine-injected — the rm / async declarations below restore the
 * classic filesystem + loop rails; drop them if you want THIS PACK
 * ONLY. The git plugin isn't declared here, so its rules stay inert.
 */

import { defineConfig } from "@cad0p/pi-steering";
import asyncPlugin from "@cad0p/pi-steering/plugins/async";
import rmPlugin from "@cad0p/pi-steering/plugins/rm";

export default defineConfig({
  plugins: [rmPlugin, asyncPlugin],
  rules: [
    {
      name: "pr-create-must-be-draft",
      tool: "bash",
      field: "command",
      pattern: "^gh\\s+pr\\s+create\\b",
      // `unless` short-circuits the rule: if the command ALSO
      // matches the unless pattern, the rule does NOT fire. Here it
      // means "block gh pr create UNLESS --draft is also present".
      unless: "--draft\\b",
      reason:
        "PRs must be created as drafts. Mark the PR ready for review only after a human has reviewed the diff. Use `gh pr ready <number>` to flip from draft to ready.",
    },
  ],
});
