// SPDX-License-Identifier: MIT
// Part of pi-steering / examples.

/**
 * Example: force-push-strict rule pack.
 *
 * Equivalent to `steering.json` in this directory but expressed in the
 * canonical TypeScript form. Drop this file in at
 * `.pi/steering.ts` (or `.pi/steering/index.ts`) to activate.
 *
 * What it enforces: no force pushes of ANY kind, including
 * `--force-with-lease` (which the shipped `DEFAULT_RULES.no-force-push`
 * deliberately allows). Useful on teams where shared-branch history
 * must stay append-only even for "safe" rewrites.
 *
 * Shape:
 *
 *   - `disabledRules: ["no-force-push"]` drops the default rule so
 *     it doesn't fire alongside our stricter one (otherwise the
 *     default's block message would win on `git push --force`).
 *   - `no-force-push-strict` fires on `--force` (any suffix, any
 *     position) AND on `-f`. Matches the same pre-subcommand flag
 *     patterns as the default (`git -C /path push --force`,
 *     `git -c key=val push --force`, `git --git-dir=/x push -f`).
 *
 * Scope note: the git plugin's `no-main-commit` fires on top of this
 * rule when the plugin is declared (`plugins: [gitPlugin]`, opt-in).
 * If that's not wanted, omit the plugin or add
 * `disabledRules: ["no-force-push", "no-main-commit"]`.
 */

import { defineConfig } from "@cad0p/pi-steering";
import gitPlugin from "@cad0p/pi-steering/plugins/git";

export default defineConfig({
  plugins: [gitPlugin],
  // Disable the shipped default so its less-strict block-reason (
  // "use --force-with-lease if you must") doesn't leak to the LLM
  // alongside our stricter variant.
  disabledRules: ["no-force-push"],
  rules: [
    {
      name: "no-force-push-strict",
      tool: "bash",
      field: "command",
      // Mirrors DEFAULT_RULES.no-force-push's pre-subcommand flag
      // slot but WITHOUT the `--force-with-lease` allowance.
      pattern:
        "^git\\b(?:\\s+-{1,2}[A-Za-z]\\S*(?:\\s+\\S+)?)*\\s+push\\b.*(?:--force\\b|\\s-f(?:\\s|$))",
      reason:
        "No force pushes of any kind, including --force-with-lease. Create a new commit, or reset + re-commit via a non-force path.",
    },
  ],
});
