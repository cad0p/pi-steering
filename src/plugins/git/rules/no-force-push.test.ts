// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Pattern spot-checks + end-to-end coverage for the git plugin's
 * `no-force-push` rule (`./no-force-push.ts`).
 *
 * The fixtures are ported verbatim from the former `defaults.test.ts`
 * (issue #72 moved the rule here): if a case flips vs. its old
 * expectation, the pattern drifted during the migration. The one
 * historical exception predates the move — issue #65 sealed the
 * pattern so lease-related cases MATCH / BLOCK.
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
import { noForcePush } from "./no-force-push.ts";

describe("rules/no-force-push: pattern spot-checks", () => {
  function pattern(): RegExp {
    if (typeof noForcePush.pattern !== "string") {
      throw new Error("no-force-push must use a string pattern");
    }
    return new RegExp(noForcePush.pattern);
  }

  it("matches `git push --force`", () => {
    assert.equal(pattern().test("git push --force"), true);
  });

  it("matches `git push -f`", () => {
    assert.equal(pattern().test("git push -f"), true);
  });

  it("matches `git push --force-with-lease` (sealed, #65)", () => {
    assert.equal(pattern().test("git push --force-with-lease"), true);
  });

  it("matches `git push --force-if-includes` (sealed, #65)", () => {
    assert.equal(pattern().test("git push --force-if-includes"), true);
  });

  it("matches bundled short flags (`-uf`, `-fu`, `-nfv`) (#65)", () => {
    assert.equal(pattern().test("git push -uf origin main"), true);
    assert.equal(pattern().test("git push -fu origin main"), true);
    assert.equal(pattern().test("git push -nfv origin main"), true);
  });

  it("matches leading-`+` refspecs (#65)", () => {
    assert.equal(pattern().test("git push origin +main"), true);
    assert.equal(pattern().test("git push origin +src:dst"), true);
  });

  it("matches `git push --mirror` (#65)", () => {
    assert.equal(pattern().test("git push --mirror"), true);
  });

  it("does NOT match plain `git push origin main`", () => {
    assert.equal(pattern().test("git push origin main"), false);
  });

  it("does NOT match non-force short flags alone (-u/-n/-q/-v)", () => {
    assert.equal(pattern().test("git push -u origin main"), false);
    assert.equal(pattern().test("git push -n origin main"), false);
    assert.equal(pattern().test("git push -q origin main"), false);
    assert.equal(pattern().test("git push -v origin main"), false);
  });

  it("does NOT match branch names with mid-token `+` (c++-port)", () => {
    // Only LEADING-`+` refspec forms are force markers: no whitespace
    // before the `+` in `c++-port`, so no refspec-force match.
    assert.equal(pattern().test("git push origin c++-port"), false);
  });

  it("matches `git push origin main --force`", () => {
    assert.equal(pattern().test("git push origin main --force"), true);
  });

  it("matches `git -C /other push --force` (pre-subcommand flag)", () => {
    assert.equal(pattern().test("git -C /other push --force"), true);
  });

  it("matches `git -c rerere.enabled=false push --force` (key=val config)", () => {
    assert.equal(
      pattern().test("git -c rerere.enabled=false push --force"),
      true,
    );
  });

  it("matches `git --git-dir=/path push --force` (long-form pre-subcommand)", () => {
    assert.equal(pattern().test("git --git-dir=/path push --force"), true);
  });

  it("matches `git push --force-bar` (other --force-* suffix, accepted over-match)", () => {
    assert.equal(pattern().test("git push --force-bar"), true);
  });
});

// ---------------------------------------------------------------------------
// End-to-end through buildEvaluator
// ---------------------------------------------------------------------------

/**
 * Build an evaluator driven ONLY by {@link noForcePush} so the rule's
 * effective behavior (including the walker + wrapper expansion) gets
 * end-to-end coverage.
 */
function ruleEvaluator() {
  const resolved = resolvePlugins([], {});
  const rules: readonly Rule[] = [noForcePush];
  return buildEvaluator({ rules }, resolved, makeHost());
}

function bashEvent(command: string): BashToolCallEvent {
  return {
    type: "tool_call",
    toolCallId: "t1",
    toolName: "bash",
    input: { command },
  };
}

describe("rules/no-force-push: end-to-end via buildEvaluator", () => {
  it("blocks `git push --force`", async () => {
    const ev = ruleEvaluator();
    const r = await ev.evaluate(
      bashEvent("git push --force"),
      makeCtx("/r"),
      0,
    );
    assert.equal((r as { block?: boolean } | undefined)?.block, true);
    assert.match(
      (r as { reason?: string } | undefined)?.reason ?? "",
      /no-force-push/,
    );
  });

  it("blocks `git push --force-with-lease` (sealed, #65)", async () => {
    const ev = ruleEvaluator();
    const r = await ev.evaluate(
      bashEvent("git push --force-with-lease"),
      makeCtx("/r"),
      0,
    );
    assert.equal((r as { block?: boolean } | undefined)?.block, true);
  });

  it("catches `git push --force` behind `sh -c` wrapper", async () => {
    // The AST backend's wrapper-expansion sees the inner command even
    // behind sh/bash -c. Regex-on-raw would miss this — the whole
    // reason the walker exists.
    const ev = ruleEvaluator();
    const r = await ev.evaluate(
      bashEvent("sh -c 'git push --force'"),
      makeCtx("/r"),
      0,
    );
    assert.equal((r as { block?: boolean } | undefined)?.block, true);
  });

  it("does NOT block `echo 'git push --force'` (basename is echo)", async () => {
    const ev = ruleEvaluator();
    const r = await ev.evaluate(
      bashEvent("echo 'git push --force'"),
      makeCtx("/r"),
      0,
    );
    assert.equal(r, undefined);
  });
});
