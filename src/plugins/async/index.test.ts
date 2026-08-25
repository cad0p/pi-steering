// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Count lock + shape invariants for the async plugin (`./index.ts`).
 *
 * Replaces the engine-side `defaults.test.ts` count lock (issue #72):
 * the async plugin ships EXACTLY ONE rule. Any addition is a
 * deliberate ship-surface change and must update this assertion
 * explicitly.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Rule } from "../../schema.ts";
import asyncPlugin, { ASYNC_PLUGIN_NAME } from "./index.ts";

// Widen once for shape-invariant iteration (optional fields visible).
const RULES_AS_RULE: readonly Rule[] = asyncPlugin.rules ?? [];

describe("async plugin: ship surface", () => {
  it("ships exactly one rule (count lock)", () => {
    // Locking the count keeps additions/removals a deliberate,
    // reviewed edit.
    assert.equal(asyncPlugin.rules?.length, 1);
  });

  it("the shipped rule is no-long-running-commands", () => {
    assert.deepEqual(
      RULES_AS_RULE.map((r) => r.name),
      ["no-long-running-commands"],
    );
  });

  it('keeps the plugin name literal narrowed to "async"', () => {
    // Type-level sentinel: if the literal ever widens to string, the
    // defineConfig typo-check unions collapse silently.
    const name: "async" = ASYNC_PLUGIN_NAME;
    assert.equal(name, "async");
  });

  it("every rule has non-empty name, pattern, reason and a valid regex", () => {
    for (const r of RULES_AS_RULE) {
      assert.ok(r.name.length > 0);
      const patternLen =
        typeof r.pattern === "string"
          ? r.pattern.length
          : r.pattern.source.length;
      assert.ok(patternLen > 0, `empty pattern in ${r.name}`);
      assert.ok(r.reason.length > 0, `empty reason in ${r.name}`);
      if (typeof r.pattern === "string") {
        assert.doesNotThrow(() => new RegExp(r.pattern as string));
      }
    }
  });
});
