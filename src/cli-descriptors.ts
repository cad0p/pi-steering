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
 * Named error thrown when the merged registry has NO entry for a ref's
 * basename (issue #107, absent-descriptor goes loud).
 *
 * Carries the `basename` (set at the throw site in
 * {@link resolveDescriptor}); the evaluator's `runPredicateChain`
 * attaches `ruleName`/`source` on the rule path before rethrowing to
 * the top-level fail-closed catch (explicit passthrough — deliberately
 * STRONGER than the `UnknownPredicateError` precedent, which S1
 * isolates to warn+skip: a missing descriptor is a fail-CLOSED config
 * hole, not a buggy predicate, so swallowing it would fail OPEN).
 *
 * Present-but-empty descriptors (`{ npm: {} }`) are EXPLICIT strict
 * and never throw — only a wholly absent entry does.
 */
export class MissingDescriptorError extends Error {
  /** Ref basename with no registry entry. */
  readonly basename: string;
  /** Attaching rule (set by the evaluator on the rule path). */
  ruleName?: string;
  /** Attaching rule source (set alongside {@link ruleName}). */
  source?: string;

  constructor(basename: string) {
    super(`[pi-steering] ${missingDescriptorRemedy(basename)}`);
    this.name = "MissingDescriptorError";
    this.basename = basename;
  }
}

/**
 * Actionable remedy for a missing descriptor, shared by the throw-site
 * error message and the agent-facing block reason. Names the basename
 * plus both fixes: declare per-binary argv knowledge via the owning
 * plugin's `Plugin.cliDescriptors` slot, or an explicit-strict empty
 * entry (`{ "<basename>": {} }`, nothing consumes).
 */
export function missingDescriptorRemedy(basename: string): string {
  const slot = /^[A-Za-z_$][\w$]*$/.test(basename)
    ? `Plugin.cliDescriptors.${basename}`
    : `Plugin.cliDescriptors[${JSON.stringify(basename)}]`;
  return (
    `No CLI descriptor for basename ${JSON.stringify(basename)}. ` +
    `Declare per-binary argv knowledge via ${slot}, ` +
    `or { ${JSON.stringify(basename)}: {} } for explicit strict ` +
    `(nothing consumes).`
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
 * Resolve per-binary argv knowledge for one ref basename (issues
 * #106/#107, registry-only).
 *
 * Absent entry → throws {@link MissingDescriptorError} (loud:
 * basename + remedy). Present-but-empty (`{ npm: {} }`) is EXPLICIT
 * strict → silent verdicts (flags `[]`, policy table fallback).
 *
 *   - `valueConsumingFlags`: registry list (validated) else empty
 *     strict default (nothing consumes).
 *   - `positionPolicy`: registry (when valid) >
 *     `DEFAULT_POSITION_POLICIES` table > strict `"globals-anywhere"`
 *     (table stays the fallback when registry absent).
 *
 * Re-validates at resolution time (not just merge time):
 * `ResolvedPluginState.cliDescriptors` is mutable post-merge by
 * plain-JS callers. Invalid registry flags/policy → treat as absent
 * + one-shot WARN (module-level set, tagged `[invalid-descriptor]`).
 */
export function resolveDescriptor(
  basename: string,
  descriptors?: Record<string, CLIDescriptor>,
): { positionPolicy: PositionPolicy; valueConsumingFlags: readonly string[] } {
  const registryEntry =
    descriptors?.[basename] ?? CORE_CLI_DESCRIPTORS[basename];

  // Absent entry → LOUD (fail-closed config hole, never silent
  // strict). Present-but-empty (`{ npm: {} }`) is explicit strict →
  // silent verdicts below.
  if (registryEntry === undefined) {
    throw new MissingDescriptorError(basename);
  }

  // Flags: registry (validated) else strict empty set.
  let valueConsumingFlags: readonly string[];
  if (registryEntry?.valueConsumingFlags !== undefined) {
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

  // Policy: registry (valid) > table > strict default.
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
