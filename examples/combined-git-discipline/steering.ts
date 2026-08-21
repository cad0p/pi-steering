// SPDX-License-Identifier: MIT
// Part of pi-steering / examples.

/**
 * Example: combined-git-discipline rule pack.
 *
 * Equivalent to `steering.json` in this directory but expressed in the
 * canonical TypeScript form. Drop this file in at
 * `.pi/steering.ts` (or `.pi/steering/index.ts`) to activate.
 *
 * Stacks two guardrails on top of the engine's built-in defaults:
 *
 *   1. `no-amend` - no `git commit --amend` (rewrites history).
 *   2. `pr-create-must-be-draft` - `gh pr create` must include
 *       `--draft`.
 *
 * Force pushes need NO extra rule here: since issue #65 the shipped
 * `DEFAULT_RULES.no-force-push` is sealed — it already blocks every
 * remote-history-rewrite form (`--force`, `--force-with-lease`,
 * bundled shorts like `-uf`, leading-`+` refspecs, `--mirror`). Older
 * copies of this pack disabled the default and re-added a stricter
 * variant; that disable-and-replace step is now redundant (and would
 * actually WEAKEN coverage — see ../force-push-strict for the idiom if
 * you genuinely want to swap the default out).
 *
 * Use this as a starting point for teams that want "disciplined PR
 * flow" out of the box. Tweak individual patterns downstream.
 *
 * Scope note: the other default rules (no-hard-reset, no-rm-rf-slash,
 * no-long-running-commands) stay active, and the git plugin
 * (no-main-commit + branch predicate) is declared explicitly below —
 * the plugin is opt-in.
 */

import { defineConfig } from "@cad0p/pi-steering";
import gitPlugin from "@cad0p/pi-steering/plugins/git";

export default defineConfig({
  plugins: [gitPlugin],
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
