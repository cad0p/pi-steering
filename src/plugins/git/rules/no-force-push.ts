// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * `no-force-push` rule for the git plugin — the remote-history-rewrite
 * guard.
 *
 * Moved out of the engine's former `DEFAULT_RULES` (issue #72): every
 * destructive-command rail now lives in the domain plugin that owns
 * its surface. The pattern and reason text are byte-identical to the
 * 0.2.0 default, including the issue #65 sealing (every
 * remote-history-rewrite form blocked). Override-comment eligible.
 */

import type { Rule } from "../../../schema.ts";

/**
 * `no-force-push` - block every remote-history-rewrite push form.
 */
export const noForcePush = {
  name: "no-force-push",
  tool: "bash",
  field: "command",
  // Block EVERY remote-history-rewrite form (issue #65 sealed the
  // old lenient pattern, which deliberately allowed
  // `--force-with-lease`). Anchored so `echo 'git push --force'`
  // (basename=echo) is NOT flagged. The pre-subcommand flag slot
  // `(?:\s+-{1,2}[A-Za-z]\S*(?:\s+\S+)?)*` allows short and long
  // git-flags before the subcommand:
  //   - `git -C /path push --force`
  //   - `git -c key=val push --force`
  //   - `git --git-dir=/x push --force`
  // All three are silent bypasses with a plain `^git\s+push` anchor.
  //
  // The four force alternatives:
  //   - `--force\b`: the word boundary between `e` and `-` catches
  //     BOTH `--force-with-lease` AND `--force-if-includes`. This
  //     INVERTS the old `(?!-with-lease)` carve-out.
  //   - `\s-[A-Za-z]*f[A-Za-z]*(?:\s|$)`: short force INCLUDING
  //     bundled shorts (`-f`, `-uf`, `-fu`, `-nfv`). Same technique
  //     as `no-rm-rf-slash`. Safe for push: no other git-push short
  //     flag contains `f`.
  //   - `\s\+[^\s:]+(?::\S*)?(?:\s|$)`: refspec force prefix
  //     (`git push origin +main`, `+src:dst`). Only LEADING-`+`
  //     forms are force markers — a `+` mid-token (branch names like
  //     `c++-port`) has no whitespace before it and is not matched.
  //   - `--mirror\b`: mirror implies force-update + remote
  //     deletions.
  //
  // Known limit: this pattern over-matches on
  // `git log --grep="push --force"` because `--grep=push` is a
  // single token that still satisfies `\bpush\b`. Real agents don't
  // emit that; if it becomes a problem we'll move to args-array
  // matching.
  pattern:
    "^git\\b(?:\\s+-{1,2}[A-Za-z]\\S*(?:\\s+\\S+)?)*\\s+push\\b.*(?:--force\\b|\\s-[A-Za-z]*f[A-Za-z]*(?:\\s|$)|\\s\\+[^\\s:]+(?::\\S*)?(?:\\s|$)|--mirror\\b)",
  reason:
    "Force pushes rewrite remote history and can destroy teammates' work. Create a new commit instead, or ask the user to run one manually.",
} as const satisfies Rule;
