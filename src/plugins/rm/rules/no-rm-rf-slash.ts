// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * `no-rm-rf-slash` rule for the rm plugin — the recursive-force-delete-
 * from-root guard.
 *
 * Moved out of the engine's former default-rule bundle (issue #72): every
 * destructive-command rail now lives in the domain plugin that owns
 * its surface. The pattern and reason text are byte-identical to the
 * 0.2.0 default, including the `noOverride: true` seal.
 */

import type { Rule } from "../../../schema.ts";

/**
 * `no-rm-rf-slash` - block recursive force-deletes rooted at `/`.
 */
export const noRmRfSlash = {
  name: "no-rm-rf-slash",
  tool: "bash",
  field: "command",
  // rm with recursive AND force flags in any form, operating on `/`.
  // Uses two independent lookaheads so separated flags (`-r -f`),
  // long-form flags (`--recursive --force`), mixed case (`-Rf`),
  // and reversed order (`-fr`) are all caught. Anchored to the
  // basename so `echo 'rm -rf /'` (basename=echo) is NOT flagged.
  pattern:
    "^rm\\b(?=.*(?:-[A-Za-z]*[rR][A-Za-z]*|--recursive))(?=.*(?:-[A-Za-z]*f[A-Za-z]*|--force)).*\\s/(?:\\s|$)",
  reason:
    "Recursive force-delete from root is catastrophic and irreversible. Specify a safe path (e.g. a subdirectory of the project or a temp dir).",
  // HARD block — inherent destructiveness, no override possible.
  // Explicit `noOverride: true` guarantees this even when a layer
  // sets `defaultNoOverride: false`.
  noOverride: true,
} as const satisfies Rule;
