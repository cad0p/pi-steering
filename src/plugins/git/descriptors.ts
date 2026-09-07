// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Git plugin-owned CLI descriptor (issue #106; #110 flag table).
 *
 * Per-binary argv knowledge for the `git` basename. Declared via the
 * git plugin's own `cliDescriptors` slot — the exemplar every
 * external plugin copies. Core seeds nothing; the merger fills absent
 * basenames from its (empty) fallback map, so disabling this plugin
 * drops `git` facts and bare `subcommand: "push"` on
 * `git -C /x …` throws `MissingDescriptorError` (loud block naming
 * the missing facts — declare them or go explicit-strict).
 */

import type { CLIDescriptor } from "../../schema.ts";

/**
 * Git descriptor: policy mirrors the walker's
 * `DEFAULT_POSITION_POLICIES["git"]`; flags match the `-C`/`-c`
 * handling in `./trackers/branch-tracker.ts`.
 *
 * Transition (#110 cutover): minimal entries for the carried `-C`/`-c`
 * value-takers. The seed step expands this table from Fig's `git.ts`
 * human-reviewed vs `git --help` with provenance + oracles-lite pins.
 *
 * Referenced by name (never inlined) in the plugin literal so hover
 * rides on this const.
 */
export const GIT_CLI_DESCRIPTOR = {
  positionPolicy: "globals-before-only",
  flags: {
    C: { aliases: ["-C"], takesValue: true },
    config: { aliases: ["-c"], takesValue: true },
  },
} as const satisfies CLIDescriptor;
