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

import type { PositionPolicy } from "@cad0p/unbash-walker";
import { DEFAULT_POSITION_POLICIES } from "@cad0p/unbash-walker";
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

/**
 * Valid `positionPolicy` values. Mirrors the leaf-side
 * `VALID_POSITION_POLICIES` in `evaluator-internals/predicates.ts` —
 * kept local so this module stays dependency-free (no core→leaf
 * edge).
 */
const VALID_DESCRIPTOR_POLICIES: ReadonlySet<string> = new Set([
  "globals-anywhere",
  "globals-before-only",
  "globals-after-only",
]);

/**
 * Basenames already warned for post-merge descriptor malformation.
 * Module-level one-shot set: the merged `cliDescriptors` map is
 * mutable post-merge by plain-JS callers, so resolution-time
 * re-validation warns once per basename (tagged
 * `[invalid-descriptor]`, NOT the diagnostic pipeline — never
 * escalates via `failOnWarnings`, never fires per-tool_call
 * per-ref).
 */
const warnedBasenames = new Set<string>();

function warnInvalidDescriptorOnce(basename: string, detail: string): void {
  if (warnedBasenames.has(basename)) return;
  warnedBasenames.add(basename);
  console.warn(
    `[pi-steering] [invalid-descriptor] CLI descriptor for basename ` +
      `${JSON.stringify(basename)} ${detail}; falling back to strict default`,
  );
}

/**
 * Test-only reset for the one-shot WARN set. Lets
 * `invalid-policy/flags one-shot` pins assert re-WARN behavior
 * without cross-test pollution.
 */
export function __resetDescriptorWarningsForTests(): void {
  warnedBasenames.clear();
}

/**
 * Resolve per-binary argv knowledge for one ref basename (issue
 * #106).
 *
 * Per-field composition (firm):
 *   - `valueConsumingFlags`: inline (when present) REPLACES the
 *     registry list (no union); else registry; else empty strict
 *     default (nothing consumes).
 *   - `positionPolicy`: inline (when valid) > registry (when valid)
 *     > `DEFAULT_POSITION_POLICIES` table > strict
 *     `"globals-anywhere"` (table stays the fallback when registry
 *     absent).
 *
 * Re-validates at resolution time (not just merge time):
 * `ResolvedPluginState.cliDescriptors` is mutable post-merge by
 * plain-JS callers. Invalid registry flags/policy → treat as absent
 * + one-shot WARN (module-level set, tagged `[invalid-descriptor]`).
 */
export function resolveDescriptor(
  basename: string,
  inline?: Pick<CLIDescriptor, "positionPolicy" | "valueConsumingFlags">,
  descriptors?: Record<string, CLIDescriptor>,
): { positionPolicy: PositionPolicy; valueConsumingFlags: readonly string[] } {
  const registryEntry =
    descriptors?.[basename] ?? CORE_CLI_DESCRIPTORS[basename];

  // Flags: inline REPLACES registry; registry invalid → absent + WARN.
  let valueConsumingFlags: readonly string[];
  if (inline?.valueConsumingFlags !== undefined) {
    const v = inline.valueConsumingFlags;
    valueConsumingFlags =
      Array.isArray(v) && v.every((f) => typeof f === "string") ? v : [];
  } else if (registryEntry?.valueConsumingFlags !== undefined) {
    const v = registryEntry.valueConsumingFlags;
    if (Array.isArray(v) && v.every((f) => typeof f === "string")) {
      valueConsumingFlags = v;
    } else {
      warnInvalidDescriptorOnce(
        basename,
        "has malformed valueConsumingFlags (expected string array)",
      );
      valueConsumingFlags = [];
    }
  } else {
    valueConsumingFlags = [];
  }

  // Policy: inline (valid) > registry (valid) > table > strict default.
  const inlinePolicy = inline?.positionPolicy;
  if (
    typeof inlinePolicy === "string" &&
    VALID_DESCRIPTOR_POLICIES.has(inlinePolicy)
  ) {
    return {
      positionPolicy: inlinePolicy as PositionPolicy,
      valueConsumingFlags,
    };
  }
  const rawRegistryPolicy = registryEntry?.positionPolicy;
  if (typeof rawRegistryPolicy === "string") {
    if (VALID_DESCRIPTOR_POLICIES.has(rawRegistryPolicy)) {
      return {
        positionPolicy: rawRegistryPolicy as PositionPolicy,
        valueConsumingFlags,
      };
    }
    warnInvalidDescriptorOnce(
      basename,
      `has invalid positionPolicy ${JSON.stringify(rawRegistryPolicy)}`,
    );
  } else if (rawRegistryPolicy !== undefined) {
    warnInvalidDescriptorOnce(
      basename,
      `has invalid positionPolicy ${JSON.stringify(rawRegistryPolicy)}`,
    );
  }
  const tablePolicy: unknown =
    basename !== undefined
      ? (DEFAULT_POSITION_POLICIES as Record<string, unknown>)[basename]
      : undefined;
  if (
    typeof tablePolicy === "string" &&
    VALID_DESCRIPTOR_POLICIES.has(tablePolicy)
  ) {
    return {
      positionPolicy: tablePolicy as PositionPolicy,
      valueConsumingFlags,
    };
  }
  return { positionPolicy: "globals-anywhere", valueConsumingFlags };
}
