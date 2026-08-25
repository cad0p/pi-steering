// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Pattern spot-checks + end-to-end coverage for the async plugin's
 * `no-long-running-commands` rule
 * (`./rules/no-long-running-commands.ts`).
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
import { noLongRunningCommands } from "../index.ts";

describe("rules/no-long-running-commands: pattern spot-checks", () => {
  function pattern(): RegExp {
    if (typeof noLongRunningCommands.pattern !== "string") {
      throw new Error("no-long-running-commands must use a string pattern");
    }
    return new RegExp(noLongRunningCommands.pattern);
  }

  it("matches `npm run dev`", () => {
    assert.equal(pattern().test("npm run dev"), true);
  });

  it("matches `tsc --watch`", () => {
    assert.equal(pattern().test("tsc --watch"), true);
  });

  it("does NOT match `npm run build`", () => {
    assert.equal(pattern().test("npm run build"), false);
  });

  it("matches `pnpm dev`", () => {
    assert.equal(pattern().test("pnpm dev"), true);
  });

  it("matches `pnpm run dev`", () => {
    assert.equal(pattern().test("pnpm run dev"), true);
  });

  it("does NOT match `pnpm build`", () => {
    assert.equal(pattern().test("pnpm build"), false);
  });

  it("matches `vite` (bare = dev server)", () => {
    assert.equal(pattern().test("vite"), true);
  });

  it("matches `vite dev`", () => {
    assert.equal(pattern().test("vite dev"), true);
  });

  it("does NOT match `vite build`", () => {
    assert.equal(pattern().test("vite build"), false);
  });

  it("matches `astro dev`", () => {
    assert.equal(pattern().test("astro dev"), true);
  });

  it("does NOT match `astro build`", () => {
    assert.equal(pattern().test("astro build"), false);
  });

  it("matches `next dev`", () => {
    assert.equal(pattern().test("next dev"), true);
  });

  it("does NOT match `next build`", () => {
    assert.equal(pattern().test("next build"), false);
  });

  it("matches `deno task dev`", () => {
    assert.equal(pattern().test("deno task dev"), true);
  });

  it("does NOT match `deno task build`", () => {
    assert.equal(pattern().test("deno task build"), false);
  });

  it("matches `bun dev`", () => {
    assert.equal(pattern().test("bun dev"), true);
  });

  it("matches `bun run dev`", () => {
    assert.equal(pattern().test("bun run dev"), true);
  });

  it("does NOT match `bun install`", () => {
    assert.equal(pattern().test("bun install"), false);
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

describe("rules/no-long-running-commands: end-to-end via buildEvaluator", () => {
  function ruleEvaluator() {
    const resolved = resolvePlugins([], {});
    const rules: readonly Rule[] = [noLongRunningCommands];
    return buildEvaluator({ rules }, resolved, makeHost());
  }

  it("blocks `npm run dev`", async () => {
    const ev = ruleEvaluator();
    const r = await ev.evaluate(bashEvent("npm run dev"), makeCtx("/r"), 0);
    assert.equal((r as { block?: boolean } | undefined)?.block, true);
    assert.match(
      (r as { reason?: string } | undefined)?.reason ?? "",
      /no-long-running-commands/,
    );
  });

  it("allows `npm run build`", async () => {
    const ev = ruleEvaluator();
    const r = await ev.evaluate(bashEvent("npm run build"), makeCtx("/r"), 0);
    assert.equal(r, undefined);
  });
});
