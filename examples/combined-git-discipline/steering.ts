// SPDX-License-Identifier: MIT
// Part of pi-steering / examples.

/**
 * Example: combined-git-discipline rule pack.
 *
 * Equivalent to `steering.json` in this directory but expressed in the
 * canonical TypeScript form. Drop this file in at
 * `.pi/steering.ts` (or `.pi/steering/index.ts`) to activate.
 *
 * Stacks two guardrails on top of the declared domain plugins:
 *
 *   1. `no-amend` - no `git commit --amend` (rewrites history).
 *   2. `pr-create-must-be-draft` - `gh pr create` must include
 *       `--draft`.
 *
 * Since issue #72 nothing is engine-injected: this config DECLARES
 * git + rm + async to get the full classic rail set. Force pushes
 * need NO extra rule here: since issue #65 the git plugin's
 * `no-force-push` rule is sealed — it already blocks every
 * remote-history-rewrite form (`--force`, `--force-with-lease`,
 * bundled shorts like `-uf`, leading-`+` refspecs, `--mirror`). Older
 * copies of this pack disabled that rule and re-added a stricter
 * variant; that disable-and-replace step is redundant (and would
 * actually WEAKEN coverage — see ../force-push-strict for the idiom if
 * you genuinely want to swap the shipped rule out).
 *
 * Use this as a starting point for teams that want "disciplined PR
 * flow" out of the box. Tweak individual patterns downstream.
 *
 * Scope note: the other shipped rails (no-hard-reset via git,
 * no-rm-rf-slash via rm, no-long-running-commands via async) are
 * active because their plugins are declared explicitly below.
 */

import { defineConfig } from "@cad0p/pi-steering";
import asyncPlugin from "@cad0p/pi-steering/plugins/async";
import gitPlugin from "@cad0p/pi-steering/plugins/git";
import rmPlugin from "@cad0p/pi-steering/plugins/rm";

export default defineConfig({
  // Post-#72 there are no implicit rails: declare every domain plugin
  // whose rules you want active.
  plugins: [gitPlugin, rmPlugin, asyncPlugin],
  rules: [
    {
      name: "no-amend",
      tool: "bash",
      field: "command",
      pattern:
        "^git\\b(?:\\s+-{1,2}[A-Za-z]\\S*(?:\\s+\\S+)?)*\\s+commit\\b.*--amend\\b",
      reason:
        "Don't rewrite history with --amend. Create a new commit instead.",
    },
    {
      name: "pr-create-must-be-draft",
      tool: "bash",
      field: "command",
      pattern: "^gh\\s+pr\\s+create\\b",
      unless: "--draft\\b",
      reason:
        "PRs must be created as drafts. Mark ready for review only after human approval.",
    },
  ],
});
