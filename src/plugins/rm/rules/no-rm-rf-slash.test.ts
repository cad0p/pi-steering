// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Pattern spot-checks + end-to-end coverage for the rm plugin's
 * `no-rm-rf-slash` rule (`./rules/no-rm-rf-slash.ts`).
 *
 * The fixtures are ported verbatim from the former `defaults.test.ts`
 * (issue #72 moved the rule here): if a case flips vs. its old
 * expectation, the pattern drifted during the migration.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BashToolCallEvent } from "@earendil-works/pi-coding-agent";
import {
  makeCtx,
  makeTrackedHost as makeHost,
} from "../../../__test-helpers__.ts";
import { buildEvaluator } from "../../../evaluator.ts";
import { resolvePlugins } from "../../../plugin-merger.ts";
import type { Rule } from "../../../schema.ts";
import rmPlugin, { noRmRfSlash } from "../index.ts";

describe("rules/no-rm-rf-slash: pattern spot-checks", () => {
  function pattern(): RegExp {
    if (typeof noRmRfSlash.pattern !== "string") {
      throw new Error("no-rm-rf-slash must use a string pattern");
    }
    return new RegExp(noRmRfSlash.pattern);
  }

  it("matches `rm -rf /`", () => {
    assert.equal(pattern().test("rm -rf /"), true);
  });

  it("matches `rm -fr /` (flag order agnostic)", () => {
    assert.equal(pattern().test("rm -fr /"), true);
  });

  it("matches `rm -r -f /` (separated flags)", () => {
    assert.equal(pattern().test("rm -r -f /"), true);
  });

  it("matches `rm --recursive --force /` (long-form flags)", () => {
    assert.equal(pattern().test("rm --recursive --force /"), true);
  });

  it("matches `rm -Rf /` (uppercase R)", () => {
    assert.equal(pattern().test("rm -Rf /"), true);
  });

  it("does NOT match `rm -rf /tmp`", () => {
    assert.equal(pattern().test("rm -rf /tmp"), false);
  });

  it("does NOT match `rm /tmp` (no flags)", () => {
    assert.equal(pattern().test("rm /tmp"), false);
  });

  it("does NOT match `rm -r /tmp` (missing force flag)", () => {
    assert.equal(pattern().test("rm -r /tmp"), false);
  });

  it("does NOT match `rm -f /` (missing recursive flag)", () => {
    assert.equal(pattern().test("rm -f /"), false);
  });

  it("does NOT match `rm -rf .`", () => {
    assert.equal(pattern().test("rm -rf ."), false);
  });
});

// ---------------------------------------------------------------------------
// End-to-end through buildEvaluator
// ---------------------------------------------------------------------------

function bashEvent(command: string): BashToolCallEvent {
  return {
    type: "tool_call",
    toolCallId: "t1",
    toolName: "bash",
    input: { command },
  };
}

describe("rules/no-rm-rf-slash: end-to-end via buildEvaluator", () => {
  function ruleEvaluator() {
    const resolved = resolvePlugins([], {});
    const rules: readonly Rule[] = [noRmRfSlash];
    return buildEvaluator({ rules }, resolved, makeHost());
  }

  it("blocks `rm -rf /` and ignores override (noOverride: true)", async () => {
    const ev = ruleEvaluator();
    const r = await ev.evaluate(
      bashEvent("rm -rf / # steering-override: no-rm-rf-slash — nope"),
      makeCtx("/r"),
      0,
    );
    assert.equal((r as { block?: boolean } | undefined)?.block, true);
    assert.match(
      (r as { reason?: string } | undefined)?.reason ?? "",
      /no-rm-rf-slash/,
    );
    // noOverride rules should NOT advertise the "To override" hint,
    // because the rule has no override path.
    assert.doesNotMatch(
      (r as { reason?: string } | undefined)?.reason ?? "",
      /To override/,
    );
  });

  it("allows `rm -rf /tmp/foo` (safe path)", async () => {
    const ev = ruleEvaluator();
    const r = await ev.evaluate(bashEvent("rm -rf /tmp/foo"), makeCtx("/r"), 0);
    assert.equal(r, undefined);
  });

  it("plugin literal keeps the noOverride: true seal", () => {
    // The seal survived the move out of defaults (#72): the shipped
    // plugin's copy must stay hard-block even against
    // config defaultNoOverride: false.
    const shipped = rmPlugin.rules?.find((r) => r.name === "no-rm-rf-slash");
    assert.ok(shipped, "rule must ship with the plugin");
    assert.equal(shipped.noOverride, true);
  });
});
