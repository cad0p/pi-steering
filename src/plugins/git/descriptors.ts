// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Git plugin-owned CLI descriptor (issue #106).
 *
 * Per-binary argv knowledge for the `git` basename. Declared via the
 * git plugin's own `cliDescriptors` slot — the exemplar every
 * external plugin copies. Core seeds nothing; the merger fills absent
 * basenames from its (empty) fallback map, so disabling this plugin
 * drops `git` facts and bare `subcommand: "push"` on
 * `git -C /x …` falls back to the strict default (fail-open skip).
 */

import type { CLIDescriptor } from "../../schema.ts";

/**
 * Git descriptor: policy mirrors the walker's
 * `DEFAULT_POSITION_POLICIES["git"]`; flags match the `-C`/`-c`
 * handling in `./trackers/branch-tracker.ts`.
 *
 * Referenced by name (never inlined) in the plugin literal so hover
 * rides on this const.
 */
export const GIT_CLI_DESCRIPTOR = {
  positionPolicy: "globals-before-only",
  valueConsumingFlags: ["-C", "-c"],
} as const satisfies CLIDescriptor;
