// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * S1 regression pins for the `when.subcommand` walker migration
 * (issue #91; PR-B of the export/mirror-removal stack).
 *
 * The 55 `argv-leaves.test.ts` parity tests are FROZEN
 * characterization tests — this file pins ONLY the migration's own
 * S1 surface, i.e. the `projectSubcommandWords` adapter + the guard
 * rails around the real `locateSubcommandRun` call:
 *
 *   1. `.value` projection: words carrying ONLY `rawText` (both
 *      resolved forms `undefined`) classify exactly as before —
 *      the walker reads `.value` ONLY, so the adapter must
 *      pre-resolve the full `value ?? text ?? rawText` chain.
 *   2. Non-string guard: a defined non-string resolved form is
 *      stringified, never passed raw (the walker's `startsWith`
 *      would throw `TypeError`).
 *   3. Invalid resolved policy: skip + warn (return `false`), never
 *      a walker `TypeError` escape.
 *
 * All pins drive the public internal entry points (`evaluateWhen` +
 * `mockContext`), never the adapter directly.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { DEFAULT_POSITION_POLICIES } from "@cad0p/unbash-walker";
import type { PredicateWord, TopLevelWhenClause } from "../schema.ts";
import { mockContext } from "../testing/index.ts";
import { evaluateWhen } from "./predicates.ts";

/** Drive `evaluateWhen` with an argv-shaped bash context. */
async function fires(
  when: TopLevelWhenClause,
  args: PredicateWord[],
  basename = "git",
): Promise<boolean> {
  const ctx = mockContext({
    input: {
      tool: "bash",
      command: "git …",
      basename,
      args,
    },
  });
  return evaluateWhen(when, { cwd: "/tmp/test" }, ctx, {}, "test-rule", "test");
}

/** Intractable word: both resolved forms `undefined`, only source left. */
function rawOnly(rawText: string): PredicateWord {
  return { rawText } as unknown as PredicateWord;
}

describe("subcommand walker adapter S1 pins (issue #91)", () => {
  it("classifies rawText-only positionals via the projected `.value`", async () => {
    assert.equal(await fires({ subcommand: "push" }, [rawOnly("push")]), true);
  });

  it("skips rawText-only flags via the projected `.value`", async () => {
    assert.equal(
      await fires({ subcommand: "push" }, [
        rawOnly("--force"),
        rawOnly("push"),
      ]),
      true,
    );
  });

  it("stringifies non-string resolved forms instead of throwing", async () => {
    const numeric = {
      text: "42",
      value: 42,
      rawText: "42",
    } as unknown as PredicateWord;
    // Guard pins the MATCH (not just no-throw): raw `42` would make
    // the walker throw `TypeError` → skip+warn → `false`.
    assert.equal(await fires({ subcommand: "42" }, [numeric]), true);
  });

  describe("invalid resolved position policy", () => {
    const TABLE = DEFAULT_POSITION_POLICIES as Record<string, unknown>;
    const KEY = "__pi_steering_test_evilbin__";
    const prior = TABLE[KEY];
    const warnings: unknown[][] = [];
    const origWarn = console.warn;

    afterEach(() => {
      if (prior === undefined) delete TABLE[KEY];
      else TABLE[KEY] = prior;
      warnings.length = 0;
      console.warn = origWarn;
    });

    it("skips + warns instead of letting the walker TypeError escape", async () => {
      TABLE[KEY] = "bogus-policy";
      console.warn = (...args: unknown[]) => {
        warnings.push(args);
      };
      const word = {
        text: "push",
        value: "push",
        rawText: "push",
      } as PredicateWord;
      assert.equal(await fires({ subcommand: "push" }, [word], KEY), false);
      assert.equal(warnings.length, 1);
      assert.match(String(warnings[0]?.[0]), /invalid position policy/);
    });
  });
});
