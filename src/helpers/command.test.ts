// SPDX-License-Identifier: MIT
// Part of pi-steering.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Word } from "@cad0p/unbash-walker";
import type { PredicateToolInput } from "../schema.ts";
import { commandFromInput, type SteeringCommand } from "./command.ts";
import {
  getFlagValue,
  hasEnvAssignment,
  hasFlag,
  isInfoOnly,
} from "./flags.ts";

/** Minimal Word for tests — tests don't exercise the walker, just the facade. */
function W(value: string, text?: string): Word {
  const t = text ?? value;
  return { value, text: t, pos: 0, end: t.length } as Word;
}

/** PredicateWord for facade inputs — the minimal word plus its raw source token. */
function PW(value: string, text?: string) {
  const w = W(value, text);
  return { ...w, rawText: text ?? value };
}

/** Build a bash-input facade over shorthand string args. */
function bashCmd(
  args: ReturnType<typeof PW>[],
  envAssignments?: Word[],
): SteeringCommand {
  return commandFromInput(
    envAssignments === undefined
      ? { tool: "bash", args }
      : { tool: "bash", args, envAssignments },
  );
}

function S(...values: string[]): ReturnType<typeof PW>[] {
  return values.map((v) => PW(v));
}

describe("SteeringCommand.getAllFlagValues", () => {
  it("collects repeated flags in argv order across mixed aliases", () => {
    const cmd = bashCmd(S("-m", "a", "--message", "b"));
    assert.deepEqual(cmd.getAllFlagValues(["-m", "--message"]), ["a", "b"]);
  });

  it("reads the attached form, including attached-empty as explicit \"\"", () => {
    const cmd = bashCmd(S("--subject=docs", "--subject="));
    assert.deepEqual(cmd.getAllFlagValues("--subject"), ["docs", ""]);
  });

  it("skips separated-empty (no push), unlike attached-empty", () => {
    // Scalar returns null on `--flag ""`; the array twin SKIPS.
    const cmd = bashCmd([PW("--subject"), PW("", '""'), PW("--subject"), PW("x")]);
    assert.deepEqual(cmd.getAllFlagValues("--subject"), ["x"]);
  });

  it("resolves glued shorts only when opted in", () => {
    const glued = bashCmd(S("-Rc/d"));
    assert.deepEqual(glued.getAllFlagValues("-R", { gluedShorts: ["R"] }), ["c/d"]);
    const blind = bashCmd(S("-Rc/d"));
    assert.deepEqual(blind.getAllFlagValues("-R"), []);
  });

  it("does not decompose an undeclared bundle lead", () => {
    const cmd = bashCmd(S("-vf", "alpine"));
    assert.deepEqual(cmd.getAllFlagValues("-f", { gluedShorts: ["f"] }), []);
  });

  it("trailing valueless occurrence contributes nothing (scalar poisoned to null)", () => {
    const cmd = bashCmd(S("-m", "a", "-m"));
    assert.deepEqual(cmd.getAllFlagValues("-m"), ["a"]);
    assert.equal(cmd.getFlagValue("-m"), null);
  });

  it("trailing empty-next-token contributes nothing (scalar poisoned to null)", () => {
    const cmd = bashCmd([PW("-m"), PW("a"), PW("-m"), PW("", '""')]);
    assert.deepEqual(cmd.getAllFlagValues("-m"), ["a"]);
    assert.equal(cmd.getFlagValue("-m"), null);
  });

  it("trailing valueless after attached-empty preserves the explicit empty", () => {
    const cmd = bashCmd(S("--m=", "--m"));
    assert.deepEqual(cmd.getAllFlagValues("--m"), [""]);
    assert.equal(cmd.getFlagValue("--m"), null);
  });

  it("is quote-aware via .value-first reads", () => {
    const cmd = bashCmd([PW("-m"), PW("conventional: subject", "'conventional: subject'")]);
    assert.deepEqual(cmd.getAllFlagValues("-m"), ["conventional: subject"]);
  });

  it("returns [] on no match and on undefined args", () => {
    assert.deepEqual(bashCmd(S("status")).getAllFlagValues("-m"), []);
    assert.deepEqual(
      commandFromInput({ tool: "bash" }).getAllFlagValues("-m"),
      [],
    );
  });

  it("last-element invariant holds for well-formed non-trailing-broken inputs", () => {
    const cases: { args: ReturnType<typeof PW>[]; flags: string[] }[] = [
      { args: S("-m", "a", "-m", "b"), flags: ["-m"] },
      { args: S("-m", "a", "--message", "b"), flags: ["-m", "--message"] },
      { args: S("--subject=x"), flags: ["--subject"] },
      { args: S("--subject=", "--subject=y"), flags: ["--subject"] },
      { args: S("status"), flags: ["-m"] },
    ];
    for (const { args, flags } of cases) {
      const cmd = bashCmd(args);
      const all = cmd.getAllFlagValues(flags);
      assert.equal(cmd.getFlagValue(flags), all.length > 0 ? all[all.length - 1] : null);
    }
    // Glued form under matching opt-in options.
    const glued = bashCmd(S("-Rc/d", "-Re/f"));
    const opts = { gluedShorts: ["R"] };
    const allGlued = glued.getAllFlagValues("-R", opts);
    assert.deepEqual(allGlued, ["c/d", "e/f"]);
    assert.equal(glued.getFlagValue("-R", opts), allGlued[allGlued.length - 1]);
  });
});

describe("SteeringCommand delegation", () => {
  it("hasFlag / getFlagValue / hasEnvAssignment / isInfoOnly match the bare mechanism", () => {
    const args = [PW("--profile"), PW("dev"), PW("--profile=prod")];
    const env = [W("AWS_PROFILE=dev")];
    const cmd = bashCmd(args, env);
    assert.equal(cmd.hasFlag("--profile"), hasFlag(args, "--profile"));
    assert.equal(
      cmd.getFlagValue("--profile"),
      getFlagValue(args, "--profile"),
    );
    assert.equal(
      cmd.hasEnvAssignment("AWS_PROFILE"),
      hasEnvAssignment(env, "AWS_PROFILE"),
    );
    assert.equal(cmd.isInfoOnly(), isInfoOnly(args));
  });

  it("hasEnvAssignment is literal-name only", () => {
    const cmd = bashCmd([], [W("AWS_PROFILE=dev")]);
    assert.equal(cmd.hasEnvAssignment("AWS_PROFILE"), true);
    assert.equal(cmd.hasEnvAssignment("AWS"), false);
  });

  it("isInfoOnly honors the default set plus additive extras", () => {
    assert.equal(bashCmd(S("--help")).isInfoOnly(), true);
    assert.equal(bashCmd(S("see --help")).isInfoOnly(), false);
    assert.equal(bashCmd(S("-v")).isInfoOnly(), false);
    assert.equal(bashCmd(S("-v")).isInfoOnly(["-v"]), true);
  });

  it("write-tool input normalizes to the empty facade", () => {
    const cmd = commandFromInput({ tool: "write", path: "x", content: "y" });
    assert.equal(cmd.hasFlag("--help"), false);
    assert.equal(cmd.getFlagValue("--help"), null);
    assert.deepEqual(cmd.getAllFlagValues("--help"), []);
    assert.equal(cmd.hasEnvAssignment("A"), false);
    assert.equal(cmd.isInfoOnly(), false);
  });
});

describe("commandFromInput totality + COPY", () => {
  it("is total over undefined / null input (no throw, empty facade)", () => {
    for (const bad of [undefined, null] as unknown as PredicateToolInput[]) {
      const cmd = commandFromInput(bad);
      assert.equal(cmd.hasFlag("-m"), false);
      assert.equal(cmd.getFlagValue("-m"), null);
      assert.deepEqual(cmd.getAllFlagValues("-m"), []);
      assert.equal(cmd.hasEnvAssignment("A"), false);
      assert.equal(cmd.isInfoOnly(), false);
    }
  });

  it("snapshots (COPYs) the caller's arrays — later mutation cannot leak", () => {
    const args = [PW("-m"), PW("a")];
    const env = [W("A=1")];
    const cmd = commandFromInput({ tool: "bash", args, envAssignments: env });
    args.push(PW("-m"), PW("b"));
    env.push(W("B=2"));
    assert.deepEqual(cmd.getAllFlagValues("-m"), ["a"]);
    assert.equal(cmd.getFlagValue("-m"), "a");
    assert.equal(cmd.hasEnvAssignment("B"), false);
    assert.equal(cmd.hasEnvAssignment("A"), true);
  });
});
