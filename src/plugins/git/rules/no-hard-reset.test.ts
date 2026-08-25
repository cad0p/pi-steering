// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Pattern spot-checks + end-to-end coverage for the git plugin's
 * `no-hard-reset` rule (`./no-hard-reset.ts`).
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
import { noHardReset } from "./no-hard-reset.ts";

describe("rules/no-hard-reset: pattern spot-checks", () => {
  function pattern(): RegExp {
    if (typeof noHardReset.pattern !== "string") {
      throw new Error("no-hard-reset must use a string pattern");
    }
    return new RegExp(noHardReset.pattern);
  }

  it("matches `git reset --hard`", () => {
    assert.equal(pattern().test("git reset --hard"), true);
  });

  it("matches `git reset --hard HEAD`", () => {
    assert.equal(pattern().test("git reset --hard HEAD"), true);
  });

  it("does NOT match `git reset --soft`", () => {
    assert.equal(pattern().test("git reset --soft HEAD~1"), false);
  });

  it("matches `git -C /other reset --hard` (pre-subcommand flag)", () => {
    assert.equal(pattern().test("git -C /other reset --hard"), true);
  });

  it("matches `git -c rerere.enabled=false reset --hard` (key=val config)", () => {
    assert.equal(
      pattern().test("git -c rerere.enabled=false reset --hard"),
      true,
    );
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

describe("rules/no-hard-reset: end-to-end via buildEvaluator", () => {
  function ruleEvaluator() {
    const resolved = resolvePlugins([], {});
    const rules: readonly Rule[] = [noHardReset];
    return buildEvaluator({ rules }, resolved, makeHost());
  }

  it("blocks `git reset --hard HEAD`", async () => {
    const ev = ruleEvaluator();
    const r = await ev.evaluate(
      bashEvent("git reset --hard HEAD"),
      makeCtx("/r"),
      0,
    );
    assert.equal((r as { block?: boolean } | undefined)?.block, true);
    assert.match(
      (r as { reason?: string } | undefined)?.reason ?? "",
      /no-hard-reset/,
    );
  });

  it("allows `git reset --soft HEAD~1`", async () => {
    const ev = ruleEvaluator();
    const r = await ev.evaluate(
      bashEvent("git reset --soft HEAD~1"),
      makeCtx("/r"),
      0,
    );
    assert.equal(r, undefined);
  });
});
