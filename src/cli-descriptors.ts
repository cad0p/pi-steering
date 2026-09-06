// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Core-owned CLI descriptors (issue #106).
 *
 * Per-binary argv knowledge lives here as the lowest-priority
 * fallback: the merger fills absent basenames AFTER the plugin
 * first-wins loop, so any plugin entry shadows core (with a WARN)
 * but still wins.
 *
 * Imports ONLY the `CLIDescriptor` type from schema — no edge to any
 * plugin barrel, so the merger can import this module without a
 * cycle. `src/plugins/git/index.ts` re-exports the git const for
 * discoverability.
 */

import type { CLIDescriptor } from "./schema.ts";

/**
 * Git descriptor: policy mirrors the walker's
 * `DEFAULT_POSITION_POLICIES["git"]`; flags match the currently
 * inlined `["-C", "-c"]` at every `when.subcommand` git use + the
 * `-C`/`-c` handling in
 * `src/plugins/git/trackers/branch-tracker.ts`.
 */
export const GIT_CLI_DESCRIPTOR: CLIDescriptor = {
  positionPolicy: "globals-before-only",
  valueConsumingFlags: ["-C", "-c"],
};

// PARTIAL (v1): tail-TBD — gather remaining gh consuming
// flags from pi-steering-github usage before finalizing.
export const GH_CLI_DESCRIPTOR: CLIDescriptor = {
  positionPolicy: "globals-anywhere",
  valueConsumingFlags: ["-R", "--repo", "--hostname"],
};

/**
 * Core fallback map: basename → descriptor. The merger fills absent
 * basenames from this map AFTER the plugin loop (pure fallback, no
 * WARN).
 */
export const CORE_CLI_DESCRIPTORS: Record<string, CLIDescriptor> = {
  git: GIT_CLI_DESCRIPTOR,
  gh: GH_CLI_DESCRIPTOR,
};
