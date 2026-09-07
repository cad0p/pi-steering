// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * rm plugin-owned CLI descriptor (issue #110 explicit-strict verdict).
 *
 * Verdict (2026-09-07, reviewed vs `rm --help` (GNU coreutils)): rm ships
 * NO value-taking surface — every flag is boolean (`-f/--force`, `-i`,
 * `-I`, `-r/-R/--recursive`, `-d/--dir`, `-v/--verbose`, `--one-file-system`,
 * `--no-preserve-root`, `--help`, `--version`) or optional-attached
 * (`--interactive[=WHEN]`, `--preserve-root[=all]` — attached-only, separate
 * never consumes, so takesValue:false by the --exec-path precedent).
 *
 * Explicit-strict `{ rm: { flags: {} } }` is warranted (not absent-throw):
 * the rm rule is pattern-only but the engine binds `ctx.command` per ref
 * for EVERY bash ref — without a descriptor, `rm -rf /` would block with a
 * missing-descriptor reason instead of the rule's catastrophic-delete reason.
 * Empty table = nothing consumes (bool flags stay present-but-valueless,
 * attached `--flag=x` still applies per-token).
 */

import type { CLIDescriptor } from "../../schema.ts";

/**
 * rm descriptor: explicit strict (no value-taking surface).
 *
 * Referenced by name (never inlined) in the plugin literal so hover
 * rides on this const.
 */
export const RM_CLI_DESCRIPTOR = {
  flags: {},
} as const satisfies CLIDescriptor;
