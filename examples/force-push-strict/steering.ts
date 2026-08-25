// SPDX-License-Identifier: MIT
// Part of pi-steering / examples.

/**
 * Example: force-push-strict rule pack.
 *
 * Equivalent to `steering.json` in this directory but expressed in the
 * canonical TypeScript form. Drop this file in at
 * `.pi/steering.ts` (or `.pi/steering/index.ts`) to activate.
 *
 * NOTE (issue #65): the git plugin's `no-force-push` rule is SEALED —
 * it blocks every remote-history-rewrite form (`--force`,
 * `--force-with-lease`, `--force-if-includes`, bundled shorts like
 * `-uf`, leading-`+` refspecs like `git push origin +main`, and
 * `--mirror`) with a dedicated reason message. That makes this pack
 * REDUNDANT for its original purpose: the plugin's rule covers
 * everything here, and more. The pack is kept as a REFERENCE for the
 * disable-and-replace idiom — dropping a shipped rule via
 * `disabledRules` and installing your own rule under a new name —
 * which is the mechanism you'd use to customize (or loosen) any
 * shipped rule. Its rule pattern mirrors the sealed one.
 *
 * Shape:
 *
 *   - `plugins: [gitPlugin]` declares the shipping plugin — since
 *     issue #72 nothing is engine-injected, so the rules only exist
 *     if the plugin is declared (and its names only typo-check if it
 *     is).
 *   - `disabledRules: ["no-force-push"]` drops the plugin's rule so
 *     ours owns the block message (otherwise its message would win
 *     on `git push --force`).
 *   - `no-force-push-strict` fires on `--force` (any suffix, any
 *     position), bundled short flags (`-f`, `-uf`, `-fu`, `-nfv`),
 *     leading-`+` refspecs (`git push origin +main`), and `--mirror`.
 *     Matches the same pre-subcommand flag patterns as the sealed
 *     rule (`git -C /path push --force`,
 *     `git -c key=val push --force`, `git --git-dir=/x push -f`).
 *
 * Scope note: the git plugin's `no-main-commit` also fires once the
 * plugin is declared. If that's not wanted, add
 * `disabledRules: ["no-force-push", "no-main-commit"]`.
 */

import { defineConfig } from "@cad0p/pi-steering";
import gitPlugin from "@cad0p/pi-steering/plugins/git";

export default defineConfig({
  plugins: [gitPlugin],
  // Disable-and-replace idiom (kept as a reference): drop the plugin's
  // shipped rule so our custom rule owns the block-reason message.
  // Since issue #65 that rule is already strict — you only need this
  // idiom when you want a DIFFERENT policy or message than the
  // shipped one provides.
  disabledRules: ["no-force-push"],
  rules: [
    {
      name: "no-force-push-strict",
      tool: "bash",
      field: "command",
      // Mirrors the SEALED plugins/git no-force-push pattern
      // (issue #65): --force* via word boundary, bundled shorts,
      // leading-+ refspecs, --mirror.
      pattern:
        "^git\\b(?:\\s+-{1,2}[A-Za-z]\\S*(?:\\s+\\S+)?)*\\s+push\\b.*(?:--force\\b|\\s-[A-Za-z]*f[A-Za-z]*(?:\\s|$)|\\s\\+[^\\s:]+(?::\\S*)?(?:\\s|$)|--mirror\\b)",
      reason:
        "No force pushes of any kind, including --force-with-lease. Create a new commit, or reset + re-commit via a non-force path.",
    },
  ],
});
