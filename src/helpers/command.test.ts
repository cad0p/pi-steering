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
  resolvedFlags?: readonly string[],
): SteeringCommand {
  return commandFromInput(
    envAssignments === undefined
      ? { tool: "bash", args }
      : { tool: "bash", args, envAssignments },
    resolvedFlags,
  );
}

function S(...values: string[]): ReturnType<typeof PW>[] {
  return values.map((v) => PW(v));
}

describe("SteeringCommand.getAllFlagValues", () => {
  it("collects repeated flags in argv order across mixed aliases", () => {
    const cmd = bashCmd(S("-m", "a", "--message", "b"), undefined, [
      "-m",
      "--message",
    ]);
    assert.deepEqual(cmd.getAllFlagValues(["-m", "--message"]), ["a", "b"]);
  });

  it('reads the attached form, including attached-empty as explicit ""', () => {
    const cmd = bashCmd(S("--subject=docs", "--subject="));
    assert.deepEqual(cmd.getAllFlagValues("--subject"), ["docs", ""]);
  });

  it("skips separated-empty (no push), unlike attached-empty", () => {
    // Scalar returns null on `--flag ""`; the array twin SKIPS.
    const cmd = bashCmd(
      [PW("--subject"), PW("", '""'), PW("--subject"), PW("x")],
      undefined,
      ["--subject"],
    );
    assert.deepEqual(cmd.getAllFlagValues("--subject"), ["x"]);
  });

  it("bound path never decomposes glued shorts (no per-call opts)", () => {
    const cmd = bashCmd(S("-Rc/d"), undefined, ["-R"]);
    // Blind default: the glued word matches nothing, contributes nothing.
    assert.deepEqual(cmd.getAllFlagValues("-R"), []);
    assert.equal(cmd.getFlagValue("-R"), null);
    assert.equal(cmd.hasFlag("-R"), false);
  });

  it("does not decompose an undeclared bundle lead", () => {
    const cmd = bashCmd(S("-vf", "alpine"));
    assert.deepEqual(cmd.getAllFlagValues("-f"), []);
  });

  it("trailing valueless occurrence contributes nothing (scalar poisoned to null)", () => {
    const cmd = bashCmd(S("-m", "a", "-m"), undefined, ["-m"]);
    assert.deepEqual(cmd.getAllFlagValues("-m"), ["a"]);
    assert.equal(cmd.getFlagValue("-m"), null);
  });

  it("trailing empty-next-token contributes nothing (scalar poisoned to null)", () => {
    const cmd = bashCmd(
      [PW("-m"), PW("a"), PW("-m"), PW("", '""')],
      undefined,
      ["-m"],
    );
    assert.deepEqual(cmd.getAllFlagValues("-m"), ["a"]);
    assert.equal(cmd.getFlagValue("-m"), null);
  });

  it("trailing valueless after attached-empty preserves the explicit empty", () => {
    const cmd = bashCmd(S("--m=", "--m"));
    assert.deepEqual(cmd.getAllFlagValues("--m"), [""]);
    assert.equal(cmd.getFlagValue("--m"), null);
  });

  it("is quote-aware via .value-first reads", () => {
    const cmd = bashCmd(
      [PW("-m"), PW("conventional: subject", "'conventional: subject'")],
      undefined,
      ["-m"],
    );
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
    const cases: {
      args: ReturnType<typeof PW>[];
      flags: string[];
    }[] = [
      { args: S("-m", "a", "-m", "b"), flags: ["-m"] },
      {
        args: S("-m", "a", "--message", "b"),
        flags: ["-m", "--message"],
      },
      { args: S("--subject=x"), flags: ["--subject"] },
      { args: S("--subject=", "--subject=y"), flags: ["--subject"] },
      { args: S("status"), flags: ["-m"] },
    ];
    for (const { args, flags } of cases) {
      const cmd = bashCmd(args, undefined, flags);
      const all = cmd.getAllFlagValues(flags);
      assert.equal(
        cmd.getFlagValue(flags),
        all.length > 0 ? all[all.length - 1] : null,
      );
    }
    // Bound path has no glue: glued words stay opaque on both sides.
    const glued = bashCmd(S("-Rc/d", "-Re/f"), undefined, ["-R"]);
    assert.deepEqual(glued.getAllFlagValues("-R"), []);
    assert.equal(glued.getFlagValue("-R"), null);
  });
});

describe("SteeringCommand bound methods take NO opts (issue #107)", () => {
  it("excess-arg calls fail tsc (@ts-expect-error pins)", () => {
    const cmd = bashCmd(S("-R", "c/d"), undefined, ["-R"]);
    // @ts-expect-error — bound facade accepts no options bag (registry-only arity)
    void cmd.hasFlag("-R", { gluedShorts: ["R"] });
    // @ts-expect-error — bound facade accepts no options bag (registry-only arity)
    void cmd.getFlagValue("-R", { valueConsumingFlags: ["-R"] });
    // @ts-expect-error — bound facade accepts no options bag (registry-only arity)
    void cmd.getAllFlagValues("-R", { valueConsumingFlags: ["-R"] });
  });

  it("binds the descriptor-resolved list; undeclared flags are valueless", () => {
    const cmd = commandFromInput(
      {
        tool: "bash",
        command: "git push --delete origin",
        basename: "git",
        args: [PW("push"), PW("--delete"), PW("origin")],
      } as PredicateToolInput,
      ["-C", "-c"],
    );
    assert.equal(cmd.hasFlag("--delete"), true);
    assert.equal(cmd.getFlagValue("--delete"), null);
    assert.deepEqual(cmd.getAllFlagValues("--delete"), []);
    assert.deepEqual(cmd.positionals(), ["push", "--delete", "origin"]);
  });
});

describe("SteeringCommand.positionals (issue #107)", () => {
  it("includes the subcommand run", () => {
    const cmd = bashCmd(S("push", "origin", ":branch"));
    assert.deepEqual(cmd.positionals(), ["push", "origin", ":branch"]);
  });

  it("skips declared-consuming flags + values via the bound descriptor", () => {
    const gh = (args: ReturnType<typeof PW>[]) =>
      commandFromInput({ tool: "bash", args }, ["--body"]);
    assert.deepEqual(gh(S("pr", "merge", "--body", "TEXT")).positionals(), [
      "pr",
      "merge",
    ]);
    // Undeclared `--frobnicate` consumes nothing: TEXT stays positional.
    assert.deepEqual(
      gh(S("pr", "merge", "--frobnicate", "TEXT")).positionals(),
      ["pr", "merge", "--frobnicate", "TEXT"],
    );
  });

  it("push --delete origin keeps both (registry-only pin)", () => {
    // §6 rule 4 vs §7 pin: clean `--long` / `-x` flag-words that are
    // not declared-consuming surface as themselves; only consuming
    // values, attached forms, and opaque bundles skip.
    const cmd = bashCmd(S("push", "--delete", "origin"));
    assert.equal(cmd.getFlagValue("--delete"), null);
    assert.deepEqual(cmd.getAllFlagValues("--delete"), []);
    assert.deepEqual(cmd.positionals(), ["push", "--delete", "origin"]);
  });

  it("-- terminates: everything after is positional verbatim", () => {
    assert.deepEqual(bashCmd(S("checkout", "--", ".")).positionals(), [
      "checkout",
      ".",
    ]);
    assert.deepEqual(bashCmd(S("exec", "<pod>", "--", "<cmd>")).positionals(), [
      "exec",
      "<pod>",
      "<cmd>",
    ]);
    // Post-`--` `--force` surfaces here (documented divergence:
    // `when.flag` still scans it as present).
    assert.deepEqual(bashCmd(S("push", "--", "--force")).positionals(), [
      "push",
      "--force",
    ]);
  });

  it("attached forms never surface", () => {
    assert.deepEqual(bashCmd(S("--subject=x")).positionals(), []);
    assert.deepEqual(
      bashCmd(S("pr", "merge", "--subject=x"), undefined, [
        "--subject",
      ]).positionals(),
      ["pr", "merge"],
    );
  });

  it("bundles surface zero letters (never decomposed)", () => {
    assert.deepEqual(bashCmd(S("-fdx")).positionals(), []);
    assert.deepEqual(bashCmd(S("clean", "-fdx")).positionals(), ["clean"]);
    assert.deepEqual(bashCmd(S("-vf", "alpine")).positionals(), ["alpine"]);
  });

  it("is quote-aware via .value-first reads", () => {
    // A quoted value token classifies by its resolved value.
    assert.deepEqual(
      bashCmd([PW("see --help", '"see --help"')]).positionals(),
      ["see --help"],
    );
    // Quoted flag spelling still exact-matches for consumption.
    const declared = bashCmd(
      [PW("--body", '"--body"'), PW("TEXT")],
      undefined,
      ["--body"],
    );
    assert.deepEqual(declared.positionals(), []);
  });

  it("empty args → []", () => {
    assert.deepEqual(bashCmd([]).positionals(), []);
    assert.deepEqual(commandFromInput({ tool: "bash" }).positionals(), []);
  });

  it("::weird / copy-refspec shapes pass through", () => {
    assert.deepEqual(bashCmd(S("push", "origin", "::weird")).positionals(), [
      "push",
      "origin",
      "::weird",
    ]);
    assert.deepEqual(
      bashCmd(
        S("fetch", "origin", "+refs/heads/*:refs/remotes/origin/*"),
      ).positionals(),
      ["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*"],
    );
  });

  it("trailing declared-consuming is skipped", () => {
    assert.deepEqual(
      bashCmd(S("--body"), undefined, ["--body"]).positionals(),
      [],
    );
  });

  it("bare - surfaces (stdin convention)", () => {
    assert.deepEqual(bashCmd(S("-")).positionals(), ["-"]);
  });

  it("snapshots the input (no post-construction leak)", () => {
    const args = [PW("push"), PW("origin")];
    const cmd = commandFromInput({ tool: "bash", args });
    args.push(PW(":branch"));
    assert.deepEqual(cmd.positionals(), ["push", "origin"]);
  });
});

describe("SteeringCommand delegation", () => {
  it("hasFlag / getFlagValue / hasEnvAssignment / isInfoOnly match the bare mechanism", () => {
    const args = [PW("--profile"), PW("dev"), PW("--profile=prod")];
    const env = [W("AWS_PROFILE=dev")];
    const cmd = bashCmd(args, env, ["--profile"]);
    const opts = { valueConsumingFlags: ["--profile"] };
    assert.equal(cmd.hasFlag("--profile"), hasFlag(args, "--profile"));
    assert.equal(
      cmd.getFlagValue("--profile"),
      getFlagValue(args, "--profile", opts),
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
    assert.deepEqual(cmd.positionals(), []);
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
      assert.deepEqual(cmd.positionals(), []);
      assert.equal(cmd.hasEnvAssignment("A"), false);
      assert.equal(cmd.isInfoOnly(), false);
    }
  });

  it("snapshots (COPYs) the caller's arrays — later mutation cannot leak", () => {
    const args = [PW("-m"), PW("a")];
    const env = [W("A=1")];
    const cmd = commandFromInput({ tool: "bash", args, envAssignments: env }, [
      "-m",
    ]);
    args.push(PW("-m"), PW("b"));
    env.push(W("B=2"));
    assert.deepEqual(cmd.getAllFlagValues("-m"), ["a"]);
    assert.equal(cmd.getFlagValue("-m"), "a");
    assert.equal(cmd.hasEnvAssignment("B"), false);
    assert.equal(cmd.hasEnvAssignment("A"), true);
  });
});
