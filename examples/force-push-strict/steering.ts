// SPDX-License-Identifier: MIT
// Part of pi-steering / examples.

/**
 * Example: force-push-strict rule pack.
 *
 * Equivalent to `steering.json` in this directory but expressed in the
 * canonical TypeScript form. Drop this file in at
 * `.pi/steering.ts` (or `.pi/steering/index.ts`) to activate.
 *
 * NOTE (issue #65): the shipped `DEFAULT_RULES.no-force-push` is now
 * SEALED — it blocks every remote-history-rewrite form
 * (`--force`, `--force-with-lease`, `--force-if-includes`, bundled
 * shorts like `-uf`, leading-`+` refspecs like `git push origin
 * +main`, and `--mirror`) with a dedicated reason message. That means
 * this pack is REDUNDANT for its original purpose: the default now
 * covers everything here, and more. The pack is kept as a REFERENCE
 * for the disable-and-replace idiom — dropping a default via
 * `disabledRules` and installing your own rule under a new name —
 * which is the mechanism you'd use to customize (or loosen) any
 * default. Its rule pattern mirrors the sealed default.
 *
 * Shape:
 *
 *   - `disabledRules: ["no-force-push"]` drops the default rule so
 *     ours owns the block message (otherwise the default's message
 *     would win on `git push --force`).
 *   - `no-force-push-strict` fires on `--force` (any suffix, any
 *     position), bundled short flags (`-f`, `-uf`, `-fu`, `-nfv`),
 *     leading-`+` refspecs (`git push origin +main`), and `--mirror`.
 *     Matches the same pre-subcommand flag patterns as the default
 *     (`git -C /path push --force`, `git -c key=val push --force`,
 *     `git --git-dir=/x push -f`).
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
  // Disable-and-replace idiom (kept as a reference): drop the shipped
  // default so our custom rule owns the block-reason message. Since
  // issue #65 the default is already strict — you only need this
  // idiom when you want a DIFFERENT policy or message than the
  // default provides.
  disabledRules: ["no-force-push"],
  rules: [
    {
      name: "no-force-push-strict",
      tool: "bash",
      field: "command",
      // Mirrors the SEALED DEFAULT_RULES.no-force-push pattern
      // (issue #65): --force* via word boundary, bundled shorts,
      // leading-+ refspecs, --mirror.
      pattern:
        "^git\\b(?:\\s+-{1,2}[A-Za-z]\\S*(?:\\s+\\S+)?)*\\s+push\\b.*(?:--force\\b|\\s-[A-Za-z]*f[A-Za-z]*(?:\\s|$)|\\s\\+[^\\s:]+(?::\\S*)?(?:\\s|$)|--mirror\\b)",
      reason:
        "No force pushes of any kind, including --force-with-lease. Create a new commit, or reset + re-commit via a non-force path.",
    },
  ],
});
