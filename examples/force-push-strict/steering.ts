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
 * shipped rule. Its routing + leaves mirror the sealed rule.
 *
 * Shape:
 *
 *   - `plugins: [gitPlugin]` declares the shipping plugin — since
 *     issue #72 nothing is engine-injected, so the rules only exist
 *     if the plugin is declared (and its names only typo-check if it
 *     is). The declaration also supplies the git CLI facts the
 *     replacement rule's `subcommand:` / `flag:` leaves resolve
 *     against.
 *   - `disabledRules: ["no-force-push"]` drops the plugin's rule so
 *     ours owns the block message (otherwise its message would win
 *     on `git push --force`).
 *   - `no-force-push-strict` fires on `--force` (any position),
 *     `--force-with-lease`, `--force-if-includes`, bundled short
 *     flags (`-f`, `-uf`, `-fu`, `-nfv`), leading-`+` refspecs
 *     (`git push origin +main`), and `--mirror`. The `subcommand:
 *     "push"` leaf keeps the pre-subcommand flag coverage of the
 *     sealed rule (`git -C /path push --force`,
 *     `git -c key=val push --force`, `git --git-dir=/x push -f`).
 *
 * Scope note: the git plugin's `no-main-commit` also fires once the
 * plugin is declared. If that's not wanted, add
 * `disabledRules: ["no-force-push", "no-main-commit"]`.
 */

import { defineConfig, type PredicateContext } from "@cad0p/pi-steering";
import gitPlugin from "@cad0p/pi-steering/plugins/git";

/**
 * Mirrors the sealed `no-force-push` entries (`git push -h`): one
 * entry per spelling — token matching is exact, so `--force` does
 * not cover `--force-with-lease`. Keep in sync with the plugin rule
 * when the push force surface grows.
 */
const FORCE_FLAG_ENTRIES = [
  { aliases: ["--force"], takesValue: false },
  { aliases: ["-f"], takesValue: false },
  { aliases: ["--force-with-lease"], takesValue: false },
  { aliases: ["--force-if-includes"], takesValue: false },
  { aliases: ["--mirror"], takesValue: false },
] as const;

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
      command: "git",
      // Mirrors the SEALED plugins/git no-force-push routing (issue
      // #65): `subcommand: "push"` plus the force-signal OR (flag
      // forms via the facade, leading-`+` refspecs via positional
      // scan — `+main` is a positional, not flag-shaped).
      when: {
        subcommand: "push",
        condition: (ctx: PredicateContext) =>
          ctx.command.hasFlagOrBundle(FORCE_FLAG_ENTRIES) ||
          (Array.isArray(ctx.input.args) &&
            ctx.input.args.some((w) => {
              const v = w?.value ?? "";
              return v.length > 1 && v[0] === "+" && v[1] !== ":";
            })),
      },
      reason:
        "No force pushes of any kind, including --force-with-lease. Create a new commit, or reset + re-commit via a non-force path.",
    },
  ],
});
