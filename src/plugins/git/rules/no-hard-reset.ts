// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * `no-hard-reset` rule for the git plugin — the working-tree-destroying
 * reset guard.
 *
 * Moved out of the engine's former `DEFAULT_RULES` (issue #72): every
 * destructive-command rail now lives in the domain plugin that owns
 * its surface. The pattern and reason text are byte-identical to the
 * 0.2.0 default. Override-comment eligible.
 */

import type { Rule } from "../../../schema.ts";

/**
 * `no-hard-reset` - block `git reset --hard` in any form.
 */
export const noHardReset = {
  name: "no-hard-reset",
  tool: "bash",
  field: "command",
  // Same pre-subcommand flag broadening as `no-force-push` so
  // `git -C /other reset --hard` and `git -c key=val reset --hard`
  // are also caught.
  pattern:
    "^git\\b(?:\\s+-{1,2}[A-Za-z]\\S*(?:\\s+\\S+)?)*\\s+reset\\s+--hard\\b",
  reason:
    "Hard reset discards uncommitted changes permanently. Use `git stash` to save work first, or `git reset --soft` to keep changes staged.",
} as const satisfies Rule;
