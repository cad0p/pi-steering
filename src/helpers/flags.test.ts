// SPDX-License-Identifier: MIT
// Part of pi-steering.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Word } from "@cad0p/unbash-walker";
import type { SteeringCommand as RootSteeringCommand } from "../index.ts";
import type { FlagLookupOptions as RootFlagLookupOptions } from "../index.ts";
import type { PredicateWord } from "../schema.ts";
import type { FlagLookupOptions } from "./flags.ts";
import {
  getFlagValue,
  hasEnvAssignment,
  hasFlag,
  INFO_FLAGS,
  isInfoOnly,
} from "./flags.ts";

/** Minimal Word for tests — tests don't exercise the walker, just the helpers. */
function W(value: string): Word {
  return { value, text: value, pos: 0, end: value.length } as Word;
}

/** PredicateWord for facade inputs — the minimal word plus its raw source token. */
function PW(value: string): PredicateWord {
  return { ...W(value), rawText: value };
}

describe("hasFlag", () => {
  it("finds bare flag", () => {
    assert.equal(hasFlag([W("--profile"), W("dev")], "--profile"), true);
  });

  it("finds attached-value flag", () => {
    assert.equal(hasFlag([W("--profile=dev")], "--profile"), true);
  });

  it("does not confuse prefix collisions (--profile-foo vs --profile)", () => {
    assert.equal(hasFlag([W("--profile-foo")], "--profile"), false);
  });

  it("handles empty args", () => {
    assert.equal(hasFlag([], "--profile"), false);
  });

  it("handles undefined args", () => {
    assert.equal(hasFlag(undefined, "--profile"), false);
  });

  it("finds short flag", () => {
    assert.equal(hasFlag([W("-p"), W("dev")], "-p"), true);
  });

  it("does not match flag appearing as a positional value", () => {
    // `cmd --profile-unrelated --profile dev` — the first token
    // is a different flag, the second is ours.
    assert.equal(
      hasFlag(
        [W("--profile-unrelated"), W("--profile"), W("dev")],
        "--profile",
      ),
      true,
    );
  });
});

describe("getFlagValue", () => {
  it("returns value for separated form", () => {
    assert.equal(getFlagValue([W("--profile"), W("dev")], "--profile"), "dev");
  });

  it("returns value for attached form", () => {
    assert.equal(getFlagValue([W("--profile=dev")], "--profile"), "dev");
  });

  it("returns empty-string attached form as ''", () => {
    // A lone attached-empty token (`--flag=`) is a flag with an empty
    // value; callers can check against `""` if they need to
    // differentiate. Both spellings behave identically.
    assert.equal(getFlagValue([W("--profile=")], "--profile"), "");
    assert.equal(getFlagValue([W("--subject=")], "--subject"), "");
  });

  it("returns null when flag is trailing (no value)", () => {
    assert.equal(getFlagValue([W("--profile")], "--profile"), null);
  });

  it("issue #12 repro: last alias occurrence wins (--subject after -t)", () => {
    // `gh pr merge -t "see #13" --subject "closes #12"` — gh keeps
    // only the --subject value; -t and --subject are one logical flag.
    assert.equal(
      getFlagValue(
        [W("-t"), W("see #13"), W("--subject"), W("closes #12")],
        ["-t", "--subject"],
      ),
      "closes #12",
    );
  });

  it("issue #12 repro reversed: -t after --subject wins", () => {
    assert.equal(
      getFlagValue(
        [W("--subject"), W("closes #12"), W("-t"), W("see #13")],
        ["-t", "--subject"],
      ),
      "see #13",
    );
  });

  it("repeated same flag: last occurrence wins", () => {
    // LAST-flag-wins matches how gh / cobra / pflag parse repeated
    // flags — the earlier occurrence is overridden.
    assert.equal(
      getFlagValue(
        [W("--profile"), W("a"), W("--profile"), W("b")],
        "--profile",
      ),
      "b",
    );
  });

  it("finds an attached form during the reverse scan", () => {
    assert.equal(
      getFlagValue(
        [W("--subject=closes #12"), W("-t"), W("x")],
        ["-t", "--subject"],
      ),
      "x",
    );
  });

  it("mixed attached/separated across occurrences: separated-last wins", () => {
    assert.equal(
      getFlagValue([W("--subject=a"), W("--subject"), W("b")], "--subject"),
      "b",
    );
  });

  it("mixed attached/separated across occurrences: attached-last wins", () => {
    assert.equal(
      getFlagValue([W("--subject"), W("a"), W("--subject=b")], "--subject"),
      "b",
    );
  });

  it("attached-empty value wins regardless of neighbors", () => {
    assert.equal(
      getFlagValue([W("a"), W("--subject="), W("b")], "--subject"),
      "",
    );
    assert.equal(
      getFlagValue([W("a"), W("b"), W("--subject=")], "--subject"),
      "",
    );
  });

  it("single-string flags arg is equivalent to the array form", () => {
    const args = [W("--profile"), W("dev")];
    assert.equal(getFlagValue(args, "--profile"), "dev");
    assert.equal(getFlagValue(args, ["--profile"]), "dev");
  });

  it("trailing flag is fail-closed: null, no fallback", () => {
    assert.equal(getFlagValue([W("--subject")], "--subject"), null);
    // The winning occurrence is the trailing valueless --subject;
    // NO fallback to the earlier overridden --profile dev.
    assert.equal(
      getFlagValue([W("--profile"), W("dev"), W("--subject")], "--subject"),
      null,
    );
    // Repeated flag with a trailing valueless last: NO fallback either.
    assert.equal(
      getFlagValue([W("--subject"), W("dev"), W("--subject")], "--subject"),
      null,
    );
  });

  it("returns null when flag is absent", () => {
    assert.equal(getFlagValue([W("other")], "--profile"), null);
  });

  it("returns null when args is undefined", () => {
    assert.equal(getFlagValue(undefined, "--profile"), null);
  });

  it("returns null when args is empty", () => {
    assert.equal(getFlagValue([], "--profile"), null);
  });

  it("returns the next token even if it looks like a flag", () => {
    // Documented behavior: callers who want strict validation
    // should post-check the return.
    assert.equal(
      getFlagValue([W("--profile"), W("--other-flag")], "--profile"),
      "--other-flag",
    );
  });

  it("next-token blind consumption holds for array-form flags too", () => {
    assert.equal(
      getFlagValue([W("--profile"), W("--other")], ["--profile"]),
      "--other",
    );
  });

  it("separated form with empty next value returns null", () => {
    assert.equal(getFlagValue([W("--subject"), W("")], "--subject"), null);
  });

  it("does not confuse prefix collisions (--profile-unrelated vs --profile)", () => {
    assert.equal(
      getFlagValue(
        [W("--profile-unrelated"), W("--profile"), W("dev")],
        "--profile",
      ),
      "dev",
    );
    assert.equal(getFlagValue([W("--subject-extra=x")], "--subject"), null);
  });

  it("quote-awareness: reads .value, never unquotes .text", () => {
    // Migration shape: adopters of hand-rolled `.text` + unquote
    // scans get upgraded quote handling for free.
    const quoted = {
      text: '"closes #12"',
      value: "closes #12",
      pos: 0,
      end: 13,
    } as Word;
    assert.equal(
      getFlagValue([W("--subject"), quoted], "--subject"),
      "closes #12",
    );
  });

  it("falls back to .text when .value is undefined", () => {
    const rawOnly = {
      text: "--subject=x",
      value: undefined,
      pos: 0,
      end: 11,
    } as unknown as Word;
    assert.equal(getFlagValue([rawOnly], "--subject"), "x");
  });

  it("returns null on an empty alias array", () => {
    assert.equal(getFlagValue([W("--subject"), W("x")], []), null);
  });

  it("adjacent duplicate bare flags: next token resolves the winner", () => {
    assert.equal(
      getFlagValue([W("--subject"), W("--subject"), W("x")], "--subject"),
      "x",
    );
  });

  it("adjacent duplicates with a trailing valueless winner fail closed", () => {
    // `[--subject, --subject]`: the LAST occurrence is trailing-
    // valueless, so last-wins returns null — no fallback to the first
    // occurrence's next token.
    const args = [W("--subject"), W("--subject")];
    assert.equal(getFlagValue(args, "--subject"), null);
  });
});

describe("hasEnvAssignment", () => {
  it("finds AWS_PROFILE= prefix in envAssignments", () => {
    assert.equal(hasEnvAssignment([W("AWS_PROFILE=dev")], "AWS_PROFILE"), true);
  });

  it("does not match partial variable names (AWS vs AWS_PROFILE)", () => {
    assert.equal(hasEnvAssignment([W("AWS_PROFILE=dev")], "AWS"), false);
  });

  it("finds one of several assignments", () => {
    assert.equal(
      hasEnvAssignment(
        [W("PATH=/usr/bin"), W("AWS_PROFILE=dev"), W("DEBUG=1")],
        "AWS_PROFILE",
      ),
      true,
    );
  });

  it("returns false on empty envAssignments", () => {
    assert.equal(hasEnvAssignment([], "AWS_PROFILE"), false);
  });

  it("returns false on undefined envAssignments", () => {
    assert.equal(hasEnvAssignment(undefined, "AWS_PROFILE"), false);
  });
});

describe("INFO_FLAGS", () => {
  it("is exactly the minimal safe default set (--help / --version only)", () => {
    assert.deepEqual([...INFO_FLAGS], ["--help", "--version"]);
  });

  it("does NOT include the -h / -v short forms (adversarial ops)", () => {
    const flags = INFO_FLAGS as readonly string[];
    assert.ok(!flags.includes("-h"));
    assert.ok(!flags.includes("-v"));
  });
});

describe("isInfoOnly", () => {
  it("returns true for bare --help", () => {
    assert.equal(isInfoOnly([W("--help")]), true);
  });

  it("returns true for bare --version", () => {
    assert.equal(isInfoOnly([W("--version")]), true);
  });

  it("returns false for -h (not in the default set)", () => {
    assert.equal(isInfoOnly([W("-h")]), false);
  });

  it("returns false for -v (not in the default set)", () => {
    assert.equal(isInfoOnly([W("-v")]), false);
  });

  it("does NOT match --help inside a quoted VALUE (issue #13 repro)", () => {
    // `gh pr merge --squash --subject "see --help"` — the `--help`
    // token here is a VALUE (resolved by the quote-aware walker to a
    // single `see --help` word), not a flag token. Token-level
    // detection must NOT carve it out.
    assert.equal(
      isInfoOnly([W("--squash"), W("--subject"), W("see --help")]),
      false,
    );
  });

  it("does NOT match --helpful (token equality, not substring)", () => {
    assert.equal(isInfoOnly([W("--helpful")]), false);
  });

  it("does NOT match glued short forms like -hx", () => {
    assert.equal(isInfoOnly([W("-hx")]), false);
  });

  it("matches attached-value forms --help=x AND --version=1", () => {
    // `hasFlag`'s prefix semantics treat `--help=...` / `--version=...`
    // as the same flag with an attached value.
    assert.equal(isInfoOnly([W("--help=x")]), true);
    assert.equal(isInfoOnly([W("--version=1")]), true);
  });

  it("extraFlags: ['-h'] makes -h count but -v still does NOT", () => {
    const extra = ["-h"];
    assert.equal(isInfoOnly([W("-h")], extra), true);
    assert.equal(isInfoOnly([W("-v")], extra), false);
  });

  it("returns false on undefined args", () => {
    assert.equal(isInfoOnly(undefined), false);
  });

  it("returns false on empty args", () => {
    assert.equal(isInfoOnly([]), false);
  });
});

describe("glued short flags (issue #11)", () => {
  // `gh -Rc/d` — the walker keeps `-Rc/d` as ONE argv word.

  describe("default blindness (ShellCheck-norm fail-closed)", () => {
    it("getFlagValue does NOT decompose -Rcad0p/x without opt-in", () => {
      assert.equal(getFlagValue([W("-Rcad0p/x")], "-R"), null);
      assert.equal(getFlagValue([W("-Rcad0p/x")], ["-R", "--repo"]), null);
    });

    it("hasFlag does NOT match -Rcad0p/x without opt-in", () => {
      assert.equal(hasFlag([W("-Rcad0p/x")], "-R"), false);
      assert.equal(hasFlag([W("-Rcad0p/x")], ["-R", "--repo"]), false);
    });
  });

  describe("glue-enabled resolution", () => {
    const glue = { gluedShorts: ["R"] };

    it("resolves the glued form -Rx/y", () => {
      assert.equal(
        getFlagValue(
          [W("gh"), W("-Rcad0p/x"), W("pr"), W("create")],
          ["-R", "--repo"],
          glue,
        ),
        "cad0p/x",
      );
    });

    it("attached-empty -R= still resolves to the empty string", () => {
      assert.equal(getFlagValue([W("-R=")], ["-R"], glue), "");
    });

    it("exact -R + next token unchanged under glue opt-in", () => {
      assert.equal(getFlagValue([W("-R"), W("c/d")], ["-R"], glue), "c/d");
    });

    it("trailing valueless -R stays fail-closed null", () => {
      assert.equal(
        getFlagValue([W("pr"), W("merge"), W("-R")], ["-R"], glue),
        null,
      );
    });

    it("single-string flags arg accepts the options bag too", () => {
      assert.equal(getFlagValue([W("-Rc/d")], "-R", glue), "c/d");
    });
  });

  describe("per-position precedence: exact > attached > glued", () => {
    const glue = { gluedShorts: ["R"] };

    it("attached-empty beats glued rest (-R= is '', not '=')", () => {
      // Glued on `-R` would read the rest '=' as the value; the attached
      // form must win with the documented empty-string contract.
      assert.equal(getFlagValue([W("-R=")], ["-R"], glue), "");
    });

    it("pathological aliases: attached on -Rx wins over glued on -R", () => {
      // Exact can never match a token containing '='. Attached runs
      // before glued: alias '-Rx' (declared first) yields 'y'. If
      // precedence ever flipped to glued-first, '-R' + rest would
      // yield 'x=y' instead — this pin makes that regression loud.
      assert.equal(getFlagValue([W("-Rx=y")], ["-Rx", "-R"], glue), "y");
    });
  });

  describe("last-wins across mixed forms", () => {
    const glue = { gluedShorts: ["R"] };
    const flags = ["-R", "--repo"];

    it("separated then glued: last occurrence wins", () => {
      assert.equal(
        getFlagValue(
          [W("gh"), W("-R"), W("a/b"), W("pr"), W("merge"), W("-Rc/d")],
          flags,
          glue,
        ),
        "c/d",
      );
    });

    it("long separated then glued short: glued wins", () => {
      assert.equal(
        getFlagValue(
          [W("gh"), W("--repo"), W("a/b"), W("pr"), W("merge"), W("-Rc/d")],
          flags,
          glue,
        ),
        "c/d",
      );
    });

    it("ambiguity ruling: trailing bare -R over earlier --repo a/b -> null", () => {
      // The issue matrix's `gh --repo a/b pr merge -Rc/d` line compresses
      // THIS case: the trailing VALUELESS occurrence wins, fail-closed,
      // with NO fallback to the overridden --repo a/b.
      assert.equal(
        getFlagValue(
          [W("gh"), W("--repo"), W("a/b"), W("pr"), W("merge"), W("-R")],
          flags,
          glue,
        ),
        null,
      );
    });
  });

  describe("bundling safety", () => {
    it("undeclared lead letter never decomposes (docker -vf alpine, f declared)", () => {
      const args = [W("run"), W("-vf"), W("alpine")];
      const glue = { gluedShorts: ["f"] };
      assert.equal(getFlagValue(args, ["-v", "-f"], glue), null);
      assert.equal(hasFlag(args, ["-v", "-f"], glue), false);
      assert.equal(hasFlag(args, "-f", glue), false);
    });

    it("irrelevant declared letter leaves -vf untouched", () => {
      const args = [W("-vf"), W("alpine")];
      assert.equal(getFlagValue(args, ["-R"], { gluedShorts: ["R"] }), null);
      assert.equal(hasFlag(args, ["-v", "-f"], { gluedShorts: ["R"] }), false);
    });

    it("declared lead letter consumes its remainder (-fv, f declared)", () => {
      assert.equal(
        getFlagValue([W("-fv")], ["-f"], { gluedShorts: ["f"] }),
        "v",
      );
    });

    it("two declared letters: FIRST letter owns the rest (-vf, v+f)", () => {
      assert.equal(
        getFlagValue([W("-vf")], ["-v", "-f"], { gluedShorts: ["v", "f"] }),
        "f",
      );
    });
  });

  describe("eligibility guards", () => {
    const glue = { gluedShorts: ["R"] };
    const flags = ["-R", "--repo"];

    it("--repo=cad0p/x still attached-resolves", () => {
      assert.equal(getFlagValue([W("--repo=cad0p/x")], flags, glue), "cad0p/x");
    });

    it("--repo cad0p/x separated unchanged", () => {
      assert.equal(
        getFlagValue([W("--repo"), W("cad0p/x")], flags, glue),
        "cad0p/x",
      );
    });

    it("double-dash tokens are never glued (--Rx/y)", () => {
      assert.equal(getFlagValue([W("--Rx/y")], flags, glue), null);
      assert.equal(hasFlag([W("--Rx/y")], flags, glue), false);
    });

    it("glue letter without its own -X alias in the query set: no glue", () => {
      // gluedShorts ['R'] but only --repo queried: the intersection is
      // empty, so -Ra/b stays opaque and the separated long form wins.
      assert.equal(
        getFlagValue([W("--repo"), W("a/b")], ["--repo"], glue),
        "a/b",
      );
      assert.equal(getFlagValue([W("-Ra/b")], ["--repo"], glue), null);
    });

    it("multi-char shorts never become glue-eligible", () => {
      // '-xy' is not a single-letter alias, so declaring 'z' grants nothing.
      assert.equal(
        getFlagValue([W("-xyz")], ["-xy"], { gluedShorts: ["z"] }),
        null,
      );
    });
  });

  describe("quote-awareness", () => {
    const glue = { gluedShorts: ["R"] };

    it("glued token resolves via .value when .value differs from .text", () => {
      // `gh -R"c/x"` — raw source keeps the quotes; the walker's resolved
      // value strips them, and THAT is what gets decomposed.
      const quoted = {
        text: '-R"c/x"',
        value: "-Rc/x",
        pos: 0,
        end: 8,
      } as Word;
      assert.equal(getFlagValue([quoted], ["-R"], glue), "c/x");
      assert.equal(hasFlag([quoted], ["-R"], glue), true);
    });

    it("falls back to .text when .value is undefined (glued too)", () => {
      const rawOnly = {
        text: "-Rc/d",
        value: undefined,
        pos: 0,
        end: 5,
      } as unknown as Word;
      assert.equal(getFlagValue([rawOnly], ["-R"], glue), "c/d");
    });
  });

  describe("malformed options fail open (identical to omitted)", () => {
    const args = [W("-Rc/d")];
    const flags = ["-R", "--repo"];

    it("empty options object behaves like omitted", () => {
      assert.equal(getFlagValue(args, flags, {}), null);
      assert.equal(hasFlag(args, flags, {}), false);
    });

    it("empty gluedShorts behaves like omitted", () => {
      assert.equal(getFlagValue(args, flags, { gluedShorts: [] }), null);
      assert.equal(hasFlag(args, flags, { gluedShorts: [] }), false);
    });

    it("non-single-char letters are ignored", () => {
      const bad = { gluedShorts: ["RR"] };
      assert.equal(getFlagValue(args, flags, bad), null);
      assert.equal(hasFlag(args, flags, bad), false);
    });

    it("runtime garbage entries are ignored (house fail-open precedent)", () => {
      const bad = { gluedShorts: [123] } as unknown as FlagLookupOptions;
      assert.equal(getFlagValue(args, flags, bad), null);
      assert.equal(hasFlag(args, flags, bad), false);
    });

    it("option-level garbage: string gluedShorts is ignored like omitted", () => {
      // `{ gluedShorts: "RR" }` must NOT enable glue via char iteration.
      const bad = { gluedShorts: "RR" } as unknown as FlagLookupOptions;
      assert.equal(getFlagValue(args, flags, bad), null);
      assert.equal(hasFlag(args, flags, bad), false);
    });

    it("option-level garbage: numeric gluedShorts is ignored like omitted", () => {
      const bad = { gluedShorts: 123 } as unknown as FlagLookupOptions;
      assert.equal(getFlagValue(args, flags, bad), null);
      assert.equal(hasFlag(args, flags, bad), false);
    });
  });

  describe("hasFlag mirrors", () => {
    it("true for the glued form when opted in (scalar and alias set)", () => {
      assert.equal(hasFlag([W("-Rc/d")], "-R", { gluedShorts: ["R"] }), true);
      assert.equal(
        hasFlag([W("-Rc/d")], ["-R", "--repo"], { gluedShorts: ["R"] }),
        true,
      );
    });

    it("false for undeclared-letter bundles even when another letter is declared", () => {
      assert.equal(
        hasFlag([W("-vf")], ["-v", "-f"], { gluedShorts: ["f"] }),
        false,
      );
    });

    it("false without opt-in (default blindness mirror)", () => {
      assert.equal(hasFlag([W("gh"), W("-Rc/d")], ["-R", "--repo"]), false);
    });

    it("attached-empty -R= still counts as flag presence", () => {
      // Documented contract: the attached-empty spelling is a flag with
      // an empty value — presence, not absence.
      assert.equal(hasFlag([W("-R=")], ["-R"], { gluedShorts: ["R"] }), true);
    });
  });
});

describe("command facade: package-root surface pin (#101)", () => {
  it("commandFromInput is on the root; the 4 bare helpers are not", async () => {
    const root = await import("../index.ts");
    assert.equal(typeof root.commandFromInput, "function");
    assert.ok(Array.isArray(root.INFO_FLAGS));
    for (const name of [
      "hasFlag",
      "getFlagValue",
      "hasEnvAssignment",
      "isInfoOnly",
    ] as const) {
      assert.equal(name in root, false, `${name} must not be on the root`);
    }
  });

  it("root type surface still carries SteeringCommand + FlagLookupOptions", () => {
    // Compile-time pin: both types stay importable from the root for
    // `ctx.command` call sites and out-of-handler factory use.
    const opts: RootFlagLookupOptions = { gluedShorts: ["R"] };
    const cmd: RootSteeringCommand | null = null;
    assert.deepEqual(opts, { gluedShorts: ["R"] });
    assert.equal(cmd, null);
  });

  it("root commandFromInput binds hasFlag (attached form)", async () => {
    const root = await import("../index.ts");
    const cmd = root.commandFromInput({
      tool: "bash",
      args: [PW("--profile=dev")],
    });
    assert.equal(cmd.hasFlag("--profile"), true);
  });

  it("root commandFromInput getFlagValue is last-wins", async () => {
    const root = await import("../index.ts");
    const cmd = root.commandFromInput({
      tool: "bash",
      args: [PW("--profile"), PW("a"), PW("--profile"), PW("b")],
    });
    assert.equal(cmd.getFlagValue("--profile"), "b");
  });

  it("root commandFromInput getAllFlagValues keeps argv order", async () => {
    const root = await import("../index.ts");
    const cmd = root.commandFromInput({
      tool: "bash",
      args: [PW("-m"), PW("a"), PW("--message"), PW("b")],
    });
    assert.deepEqual(cmd.getAllFlagValues(["-m", "--message"]), ["a", "b"]);
  });

  it("root commandFromInput hasEnvAssignment matches on the literal name", async () => {
    const root = await import("../index.ts");
    const cmd = root.commandFromInput({
      tool: "bash",
      envAssignments: [W("AWS_PROFILE=dev")],
    });
    assert.equal(cmd.hasEnvAssignment("AWS_PROFILE"), true);
    assert.equal(cmd.hasEnvAssignment("AWS"), false);
  });

  it("root commandFromInput isInfoOnly honors the default set", async () => {
    const root = await import("../index.ts");
    assert.equal(
      root.commandFromInput({ tool: "bash", args: [PW("--help")] }).isInfoOnly(),
      true,
    );
    assert.equal(
      root.commandFromInput({ tool: "bash", args: [PW("-h")] }).isInfoOnly(),
      false,
    );
  });

  it("root INFO_FLAGS is the minimal safe default set", async () => {
    const root = await import("../index.ts");
    assert.deepEqual([...root.INFO_FLAGS], ["--help", "--version"]);
  });
});
