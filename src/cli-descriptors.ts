// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Core CLI-descriptor fallback map (issue #106).
 *
 * Core seeds NOTHING: per-binary argv knowledge lives in the
 * owning plugin via its `Plugin.cliDescriptors` slot (see
 * `src/plugins/git/descriptors.ts` for the exemplar). The map is
 * kept — plus the merger's fallback fill and `resolveDescriptor` —
 * as dormant machinery for any future core-seeded basename.
 *
 * Imports ONLY the `CLIDescriptor` type from schema — no edge to any
 * plugin barrel, so the merger can import this module without a
 * cycle.
 */

import type { PositionPolicy } from "@cad0p/unbash-walker";
import { DEFAULT_POSITION_POLICIES } from "@cad0p/unbash-walker";
import type { CLIDescriptor } from "./schema.ts";

/**
 * Core fallback map: basename → descriptor. Currently EMPTY — core
 * seeds nothing (per-binary facts live in their owning plugins).
 * The merger still fills absent basenames from this map AFTER the
 * plugin loop (pure fallback, no WARN); a no-op in practice while
 * the map is empty.
 */
export const CORE_CLI_DESCRIPTORS: Record<string, CLIDescriptor> = {};

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
