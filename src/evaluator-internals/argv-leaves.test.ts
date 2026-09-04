// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Tests for the built-in ARGV leaves `when.subcommand` / `when.flag`
 * (issue #90, P2 of #76).
 *
 * Two layers:
 *
 *   1. Unit (`evaluateWhen` + `mockContext` with hand-built
 *      `PredicateWord[]` args): pattern semantics, malformed-input
 *      fail-skip, unknown projection, `not:` Kleene composition,
 *      exemption strictness.
 *   2. End-to-end (`loadHarness` + `expectBlocks` / `expectAllows`
 *      over real command strings): the acceptance matrix from #90 —
 *      the walker parses, the engine extracts, the rule fires.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  Exemption,
  FlagLeaf,
  PredicateWord,
  Rule,
  SubcommandLeaf,
  TopLevelWhenClause,
} from "../schema.ts";
import {
  expectAllows,
  expectBlocks,
  loadHarness,
  mockContext,
} from "../testing/index.ts";
import {
  evaluateWhen,
  validateExemptionWhenClauseShape,
} from "./predicates.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Static word: resolved forms === source. */
function w(
  text: string,
  overrides?: { value?: string; rawText?: string },
): PredicateWord {
  return {
    text,
    value: overrides?.value ?? text,
    rawText: overrides?.rawText ?? text,
  } as PredicateWord;
}

/** Intractable word: both resolved forms `undefined`, only source left. */
function rawOnly(rawText: string): PredicateWord {
  return { rawText } as unknown as PredicateWord;
}

/** Drive `evaluateWhen` with an argv-shaped bash context. */
async function fires(
  when: TopLevelWhenClause,
  args: PredicateWord[],
  opts?: {
    basename?: string;
    onUnknownDefault?: "allow" | "block";
    ignoreExplicitModifiers?: boolean;
  },
): Promise<boolean> {
  const ctx = mockContext({
    input: {
      tool: "bash",
      command: "git …",
      basename: opts?.basename ?? "git",
      args,
    },
  });
  return evaluateWhen(
    when,
    { cwd: "/tmp/test" },
    ctx,
    {},
    "test-rule",
    "test",
    opts?.onUnknownDefault,
    opts?.ignoreExplicitModifiers,
  );
}

/** Drive `evaluateWhen` with a non-bash (write) context: no `args`. */
async function firesOnWrite(when: TopLevelWhenClause): Promise<boolean> {
  const ctx = mockContext({
    tool: "write",
    input: { tool: "write", path: "/tmp/x", content: "x" },
  });
  return evaluateWhen(when, { cwd: "/tmp/test" }, ctx, {}, "t", "t");
}

function gitRule(when: TopLevelWhenClause): Rule {
  return {
    name: "no-push",
    tool: "bash",
    field: "command",
    pattern: "^git\\b",
    reason: "no push",
    when,
  };
}

// ---------------------------------------------------------------------------
// subcommand: walker-parity extraction (unit)
// ---------------------------------------------------------------------------

describe("argv leaves: subcommand extraction parity", () => {
  it("git -C /path push extracts push (declared consuming -C)", async () => {
    assert.equal(
      await fires(
        {
          subcommand: {
            pattern: "push",
            valueConsumingFlags: ["-C", "-c"],
          },
        },
        [w("-C"), w("/path"), w("push")],
      ),
      true,
    );
  });

  it("git -c KEY=VAL push extracts push (declared consuming -c)", async () => {
    assert.equal(
      await fires(
        {
          subcommand: {
            pattern: "push",
            valueConsumingFlags: ["-C", "-c"],
          },
        },
        [w("-c"), w("KEY=VAL"), w("push")],
      ),
      true,
    );
  });

  it("WITHOUT the declaration, -c KEY=VAL reads KEY=VAL (fail-open skip, documented)", async () => {
    // The bare form cannot know `-c` consumes: `KEY=VAL` is the first
    // positional → mismatch → rule SKIPS. This is why the spread form
    // exists for consuming-flag shapes.
    assert.equal(
      await fires({ subcommand: "push" }, [w("-c"), w("KEY=VAL"), w("push")]),
      false,
    );
  });

  it("gh -R x/y pr merge extracts pr (declared consuming -R)", async () => {
    assert.equal(
      await fires(
        { subcommand: { pattern: "pr", valueConsumingFlags: ["-R"] } },
        [w("-R"), w("x/y"), w("pr"), w("merge")],
        { basename: "gh" },
      ),
      true,
    );
  });

  it("gh --repo=x/y pr extracts pr with NO declaration (attached form)", async () => {
    assert.equal(
      await fires({ subcommand: "pr" }, [w("--repo=x/y"), w("pr")], {
        basename: "gh",
      }),
      true,
    );
  });

  it("gh --hostname h pr extracts pr (declared consuming --hostname)", async () => {
    assert.equal(
      await fires(
        { subcommand: { pattern: "pr", valueConsumingFlags: ["--hostname"] } },
        [w("--hostname"), w("h"), w("pr")],
        { basename: "gh" },
      ),
      true,
    );
  });

  it("go -v build → unknown → fires fail-closed (after-only invalid)", async () => {
    assert.equal(
      await fires({ subcommand: "build" }, [w("-v"), w("build")], {
        basename: "go",
      }),
      true,
    );
  });

  it("aws s3 --profile x ls at depth 2 extracts the [s3, ls] sequence", async () => {
    assert.equal(
      await fires(
        {
          subcommand: {
            pattern: ["s3", "ls"],
            depth: 2,
            valueConsumingFlags: ["--profile"],
          },
        },
        [w("s3"), w("--profile"), w("x"), w("ls")],
        { basename: "aws" },
      ),
      true,
    );
  });

  it("slice-trap regression: [s3, --profile] must NOT match the aws run", async () => {
    // A contiguous `slice(0, 2)` rebuild would admit the consumed
    // `--profile` gap token; indices.map() never does.
    assert.equal(
      await fires(
        {
          subcommand: {
            pattern: ["s3", "--profile"],
            depth: 2,
            valueConsumingFlags: ["--profile"],
          },
        },
        [w("s3"), w("--profile"), w("x"), w("ls")],
        { basename: "aws" },
      ),
      false,
    );
  });

  it("git push -C x extracts push (before-only: post-subcommand flags are subcommand args)", async () => {
    assert.equal(
      await fires(
        { subcommand: { pattern: "push", valueConsumingFlags: ["-C"] } },
        [w("push"), w("-C"), w("x")],
      ),
      true,
    );
  });

  it("all-flags invocation (git --version) → unknown → fires", async () => {
    assert.equal(await fires({ subcommand: "push" }, [w("--version")]), true);
  });

  it("trailing consuming flag (git -C) → unknown → fires", async () => {
    assert.equal(
      await fires(
        { subcommand: { pattern: "push", valueConsumingFlags: ["-C"] } },
        [w("-C")],
      ),
      true,
    );
  });

  it("unknown binary falls back to globals-anywhere", async () => {
    assert.equal(
      await fires({ subcommand: "frobnicate" }, [w("frobnicate")], {
        basename: "mytool",
      }),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// subcommand: pattern semantics (unit)
// ---------------------------------------------------------------------------

describe("argv leaves: subcommand pattern semantics", () => {
  it("bare string is EXACT equality (push ≠ pushback)", async () => {
    assert.equal(await fires({ subcommand: "push" }, [w("push")]), true);
    assert.equal(await fires({ subcommand: "push" }, [w("pushback")]), false);
  });

  it("RegExp tests (pushback matches /^push/)", async () => {
    assert.equal(await fires({ subcommand: /^push/ }, [w("pushback")]), true);
  });

  it("bare array is OR-of-matches at depth 1", async () => {
    assert.equal(
      await fires({ subcommand: ["push", "pull"] }, [w("pull")]),
      true,
    );
    assert.equal(
      await fires({ subcommand: ["push", "pull"] }, [w("fetch")]),
      false,
    );
  });

  it("sequence: full run required (aws s3 alone ≠ [s3, ls] depth 2)", async () => {
    const leaf: TopLevelWhenClause = {
      subcommand: { pattern: ["s3", "ls"], depth: 2 },
    };
    assert.equal(
      await fires(leaf, [w("s3"), w("ls")], { basename: "aws" }),
      true,
    );
    assert.equal(await fires(leaf, [w("s3")], { basename: "aws" }), false);
    assert.equal(
      await fires(leaf, [w("s3"), w("cp")], { basename: "aws" }),
      false,
    );
  });

  it("sequence members mix string-exact + RegExp", async () => {
    assert.equal(
      await fires(
        { subcommand: { pattern: ["get", /^pod/], depth: 2 } },
        [w("get"), w("pods")],
        { basename: "kubectl" },
      ),
      true,
    );
    assert.equal(
      await fires(
        { subcommand: { pattern: ["get", /^svc/], depth: 2 } },
        [w("get"), w("pods")],
        { basename: "kubectl" },
      ),
      false,
    );
  });

  it("malformed leaves fail-SKIP (false, never unknown): matrix", async () => {
    const args = [w("push")];
    const bad: TopLevelWhenClause[] = [
      // empty / non-Pattern arrays
      { subcommand: [] },
      { subcommand: ["push", 123] as unknown as SubcommandLeaf },
      { subcommand: { pattern: [] } },
      { subcommand: { pattern: ["push", 123] as unknown as string[] } },
      // non-Pattern scalar / missing pattern
      { subcommand: 123 as unknown as SubcommandLeaf },
      { subcommand: {} as unknown as SubcommandLeaf },
      { subcommand: { pattern: 123 } as unknown as SubcommandLeaf },
      // single pattern with depth > 1
      { subcommand: { pattern: "push", depth: 2 } },
      { subcommand: { pattern: /push/, depth: 3 } },
      // spread array length ≠ depth (bare arrays cover OR)
      { subcommand: { pattern: ["a", "b"] } },
      { subcommand: { pattern: ["a", "b", "c"], depth: 2 } },
      // bad depth / bad valueConsumingFlags
      { subcommand: { pattern: "push", depth: -1 } },
      { subcommand: { pattern: "push", depth: 1.5 } },
      {
        subcommand: {
          pattern: "push",
          depth: "2",
        } as unknown as SubcommandLeaf,
      },
      {
        subcommand: {
          pattern: "push",
          valueConsumingFlags: "-C",
        } as unknown as SubcommandLeaf,
      },
      {
        subcommand: {
          pattern: "push",
          valueConsumingFlags: ["-C", 1],
        } as unknown as SubcommandLeaf,
      },
    ];
    for (const when of bad) {
      assert.equal(await fires(when, args), false, JSON.stringify(when));
    }
  });

  it("depth 0 → unknown → fires by default, skips with onUnknown allow", async () => {
    assert.equal(
      await fires({ subcommand: { pattern: "push", depth: 0 } }, [w("push")]),
      true,
    );
    assert.equal(
      await fires(
        { subcommand: { pattern: "push", depth: 0, onUnknown: "allow" } },
        [w("push")],
      ),
      false,
    );
  });

  it("resolved-first: $X with X=--force classifies flag-shaped (never raw $X)", async () => {
    // `"$X"` IS `--force` at execution: skipped as a flag, so `push`
    // still extracts. The walker-raw scan would see positional `$X`.
    assert.equal(
      await fires({ subcommand: "push" }, [
        w('"$X"', { value: "--force", rawText: '"$X"' }),
        w("push"),
      ]),
      true,
    );
  });

  it("rawText fallback when text + value are both undefined", async () => {
    assert.equal(await fires({ subcommand: "push" }, [rawOnly("push")]), true);
    assert.equal(
      await fires({ subcommand: "push" }, [
        rawOnly("--force"),
        rawOnly("push"),
      ]),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// flag: presence semantics (unit)
// ---------------------------------------------------------------------------

describe("argv leaves: flag presence semantics", () => {
  it("long exact token matches; absent flag is definite false", async () => {
    assert.equal(
      await fires({ flag: { anyOf: ["--force"] } }, [w("push"), w("--force")]),
      true,
    );
    assert.equal(
      await fires({ flag: { anyOf: ["--force"] } }, [w("push")]),
      false,
    );
  });

  it("attached --flag=value matches without declaration", async () => {
    assert.equal(
      await fires({ flag: { anyOf: ["--repo"] } }, [w("--repo=x/y")], {
        basename: "gh",
      }),
      true,
    );
    assert.equal(
      await fires({ flag: { anyOf: ["--repo"] } }, [w("--repo=x/y")], {
        basename: "gh",
      }),
      true,
    );
  });

  it("short exact token matches without bundleAware", async () => {
    assert.equal(
      await fires({ flag: { anyOf: ["-f"] } }, [w("push"), w("-f")]),
      true,
    );
  });

  it("bundleAware routes -uf through bundleContains (-u and -f)", async () => {
    const args = [w("push"), w("-uf")];
    assert.equal(await fires({ flag: { anyOf: ["-f"] } }, args), false);
    assert.equal(
      await fires({ flag: { anyOf: ["-f"], bundleAware: true } }, args),
      true,
    );
    assert.equal(
      await fires({ flag: { anyOf: ["-u"], bundleAware: true } }, args),
      true,
    );
    assert.equal(
      await fires({ flag: { anyOf: ["-x"], bundleAware: true } }, args),
      false,
    );
  });

  it("longs NEVER bundle-match", async () => {
    assert.equal(
      await fires({ flag: { anyOf: ["--force"], bundleAware: true } }, [
        w("--forceful"),
      ]),
      false,
    );
  });

  it("consuming values skipped BY POSITION, never by content", async () => {
    // `gh -R --force pr` with -R declared: `--force` is -R's VALUE.
    const args = [w("-R"), w("--force"), w("pr")];
    assert.equal(
      await fires(
        { flag: { anyOf: ["--force"], valueConsumingFlags: ["-R"] } },
        args,
        { basename: "gh" },
      ),
      false,
    );
    // Undeclared: `--force` scans present.
    assert.equal(
      await fires({ flag: { anyOf: ["--force"] } }, args, { basename: "gh" }),
      true,
    );
  });

  it("the consuming flag itself IS present (only its value is skipped)", async () => {
    assert.equal(
      await fires(
        { flag: { anyOf: ["-R"], valueConsumingFlags: ["-R"] } },
        [w("-R"), w("x/y"), w("pr")],
        { basename: "gh" },
      ),
      true,
    );
  });

  it("malformed flag leaves fail-SKIP (false, never unknown): matrix", async () => {
    const args = [w("push"), w("--force")];
    const bad: TopLevelWhenClause[] = [
      { flag: { anyOf: [] } },
      { flag: { anyOf: ["--force", 1] } as unknown as FlagLeaf },
      // multi-char short spellings are invalid members
      { flag: { anyOf: ["-ff"], bundleAware: true } },
      // bare `-` / `--` / non-dash spellings invalid
      { flag: { anyOf: ["-"] } },
      { flag: { anyOf: ["--"] } },
      { flag: { anyOf: ["force"] } },
      // no bare form: non-object leaves invalid
      { flag: "--force" as unknown as FlagLeaf },
      { flag: ["--force"] as unknown as FlagLeaf },
      { flag: 123 as unknown as FlagLeaf },
      // bad valueConsumingFlags
      {
        flag: { anyOf: ["--force"], valueConsumingFlags: "--repo" },
      } as unknown as TopLevelWhenClause,
      {
        flag: { anyOf: ["--force"], valueConsumingFlags: [1] },
      } as unknown as TopLevelWhenClause,
    ];
    for (const when of bad) {
      assert.equal(await fires(when, args), false, JSON.stringify(when));
    }
  });

  it("bundleAware typo-defense: only === true enables bundles", async () => {
    const args = [w("push"), w("-uf")];
    assert.equal(
      await fires(
        {
          flag: { anyOf: ["-f"], bundleAware: "yes" },
        } as unknown as TopLevelWhenClause,
        args,
      ),
      false,
    );
  });

  it("-- is flag-shaped; post--- positionals scan as ordinary tokens (documented limit)", async () => {
    assert.equal(
      await fires({ flag: { anyOf: ["--force"] } }, [w("--"), w("--force")]),
      true,
    );
  });

  it("non-bash (no args) → unknown → fires; onUnknown allow skips", async () => {
    assert.equal(await firesOnWrite({ flag: { anyOf: ["--force"] } }), true);
    assert.equal(
      await firesOnWrite({ flag: { anyOf: ["--force"], onUnknown: "allow" } }),
      false,
    );
  });

  it("non-bash subcommand → unknown → fires; onUnknown allow skips", async () => {
    assert.equal(await firesOnWrite({ subcommand: "push" }), true);
    assert.equal(
      await firesOnWrite({
        subcommand: { pattern: "push", onUnknown: "allow" },
      }),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// not: blocks (Kleene, positive cases)
// ---------------------------------------------------------------------------

describe("argv leaves: not-block Kleene semantics", () => {
  it("not: { subcommand } — mismatch fires, match skips", async () => {
    assert.equal(
      await fires({ not: { subcommand: "push" } }, [w("pull")]),
      true,
    );
    assert.equal(
      await fires({ not: { subcommand: "push" } }, [w("push")]),
      false,
    );
  });

  it("not: { flag } — absent fires, present skips", async () => {
    assert.equal(
      await fires({ not: { flag: { anyOf: ["--force"] } } }, [w("push")]),
      true,
    );
    assert.equal(
      await fires({ not: { flag: { anyOf: ["--force"] } } }, [
        w("push"),
        w("--force"),
      ]),
      false,
    );
  });

  it("not: { subcommand } on unknown extraction fires by default (block-level block)", async () => {
    assert.equal(
      await fires({ not: { subcommand: "build" } }, [w("-v"), w("build")], {
        basename: "go",
      }),
      true,
    );
  });

  it("not: { subcommand } on unknown + block onUnknown allow skips", async () => {
    assert.equal(
      await fires(
        { not: { subcommand: "build", onUnknown: "allow" } },
        [w("-v"), w("build")],
        { basename: "go" },
      ),
      false,
    );
  });

  it("not: { flag } on non-bash fires by default (unknown → block-level block)", async () => {
    const ctx = mockContext({
      tool: "write",
      input: { tool: "write", path: "/x", content: "x" },
    });
    assert.equal(
      await evaluateWhen(
        { not: { flag: { anyOf: ["--force"] } } },
        { cwd: "/tmp/test" },
        ctx,
        {},
        "t",
        "t",
      ),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Exemptions: S1 strict (type + load-time + evaluation)
// ---------------------------------------------------------------------------

describe("argv leaves: exemption strictness (S1)", () => {
  it("type-level: onUnknown forbidden in exemption subcommand/flag spreads", () => {
    const _banSub: Exemption = {
      rule: "x",
      when: {
        subcommand: {
          pattern: "push",
          // @ts-expect-error: leaf-level onUnknown forbidden in exemptions
          onUnknown: "allow",
        },
      },
    };
    const _banFlag: Exemption = {
      rule: "x",
      when: {
        flag: {
          anyOf: ["--force"],
          // @ts-expect-error: leaf-level onUnknown forbidden in exemptions
          onUnknown: "allow",
        },
      },
    };
    const _banNotSub: Exemption = {
      rule: "x",
      when: {
        not: {
          subcommand: {
            pattern: "push",
            // @ts-expect-error: leaf-level onUnknown forbidden inside not:
            onUnknown: "allow",
          },
        },
      },
    };
    const _banNotFlag: Exemption = {
      rule: "x",
      when: {
        not: {
          flag: {
            anyOf: ["--force"],
            // @ts-expect-error: leaf-level onUnknown forbidden inside not:
            onUnknown: "allow",
          },
        },
      },
    };
    void _banSub;
    void _banFlag;
    void _banNotSub;
    void _banNotFlag;
    assert.ok(true);
  });

  it("load-time: smuggled onUnknown in ARGV spreads throws (incl. bare-keyed)", () => {
    const cases: Array<[string, TopLevelWhenClause]> = [
      [
        "anyOf",
        {
          flag: { anyOf: ["--force"], onUnknown: "allow" },
        } as unknown as TopLevelWhenClause,
      ],
      [
        "bundleAware-only",
        {
          flag: { anyOf: ["--force"], bundleAware: true, onUnknown: "allow" },
        } as unknown as TopLevelWhenClause,
      ],
      [
        "bare bundleAware",
        {
          flag: { bundleAware: true, onUnknown: "allow" },
        } as unknown as TopLevelWhenClause,
      ],
      [
        "bare valueConsumingFlags",
        {
          flag: { valueConsumingFlags: ["-R"], onUnknown: "allow" },
        } as unknown as TopLevelWhenClause,
      ],
      [
        "depth-only",
        {
          subcommand: { depth: 1, onUnknown: "allow" },
        } as unknown as TopLevelWhenClause,
      ],
      [
        "bare valueConsumingFlags (subcommand)",
        {
          subcommand: { valueConsumingFlags: ["-C"], onUnknown: "allow" },
        } as unknown as TopLevelWhenClause,
      ],
      [
        "pattern+onUnknown",
        {
          subcommand: { pattern: "push", onUnknown: "allow" },
        } as unknown as TopLevelWhenClause,
      ],
    ];
    for (const [label, when] of cases) {
      assert.throws(
        () => validateExemptionWhenClauseShape(when, `exemption ${label}`),
        /forbidden 'onUnknown/,
        label,
      );
    }
  });

  it("load-time: not-block smuggled onUnknown throws", () => {
    assert.throws(
      () =>
        validateExemptionWhenClauseShape(
          {
            not: { flag: { anyOf: ["--force"] }, onUnknown: "allow" },
          } as unknown as TopLevelWhenClause,
          "exemption x",
        ),
      /forbidden 'onUnknown/,
    );
  });

  it("evaluation: smuggled onUnknown block never exempts on unknown (hard allow)", async () => {
    // `go -v build` extraction is null → unknown; even an as-any
    // `onUnknown: "block"` must NOT exempt.
    const smuggled = {
      subcommand: { pattern: "build", onUnknown: "block" },
    } as unknown as TopLevelWhenClause;
    const ctx = mockContext({
      input: {
        tool: "bash",
        command: "go -v build",
        basename: "go",
        args: [w("-v"), w("build")],
      },
    });
    assert.equal(
      await evaluateWhen(
        smuggled,
        { cwd: "/tmp/test" },
        ctx,
        {},
        "t",
        "t",
        "allow",
        true,
      ),
      false,
    );
  });

  it("evaluation: unknown extraction never exempts (default strict path)", async () => {
    const ctx = mockContext({
      input: {
        tool: "bash",
        command: "go -v build",
        basename: "go",
        args: [w("-v"), w("build")],
      },
    });
    assert.equal(
      await evaluateWhen(
        { subcommand: "build" },
        { cwd: "/tmp/test" },
        ctx,
        {},
        "t",
        "t",
        "allow",
        true,
      ),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Plugin-key collision parity with cwd
// ---------------------------------------------------------------------------

describe("argv leaves: plugin collision parity (explicit branch wins)", () => {
  it("a plugin registering `subcommand` does not shadow the built-in", async () => {
    const h = loadHarness({
      config: {
        plugins: [
          {
            name: "evil",
            predicates: {
              subcommand: () => false,
              flag: () => {
                throw new Error("must never run");
              },
            },
            rules: [],
          },
        ],
        rules: [gitRule({ subcommand: "push" })],
      },
    });
    await expectBlocks(
      h,
      { command: "git push origin main" },
      { rule: "no-push" },
    );
    await expectAllows(h, { command: "git pull" });
  });

  it("control: a plugin registering `cwd` behaves the same (explicit wins)", async () => {
    const h = loadHarness({
      config: {
        plugins: [
          {
            name: "evil",
            predicates: { cwd: () => false },
            rules: [],
          },
        ],
        rules: [
          {
            name: "no-push",
            tool: "bash",
            field: "command",
            pattern: "^git\\b",
            reason: "no push",
            when: { cwd: /./ },
          },
        ],
      },
    });
    await expectBlocks(
      h,
      { command: "git push origin main" },
      { rule: "no-push" },
    );
  });
});

// ---------------------------------------------------------------------------
// End-to-end acceptance matrix (#90 checkboxes)
// ---------------------------------------------------------------------------

describe("argv leaves: end-to-end acceptance (#90)", () => {
  it("git -C /path push + git -c KEY=VAL push match subcommand push", async () => {
    const h = loadHarness({
      config: {
        rules: [
          gitRule({
            subcommand: { pattern: "push", valueConsumingFlags: ["-C", "-c"] },
          }),
        ],
      },
    });
    await expectBlocks(
      h,
      { command: "git -C /path push origin main" },
      { rule: "no-push" },
    );
    await expectBlocks(
      h,
      { command: "git -c KEY=VAL push origin main" },
      { rule: "no-push" },
    );
    await expectAllows(h, { command: "git pull" });
  });

  it("flag bundleAware matches git push -uf for -u/-f", async () => {
    const h = loadHarness({
      config: {
        rules: [
          gitRule({ flag: { anyOf: ["-f", "--force"], bundleAware: true } }),
        ],
      },
    });
    await expectBlocks(
      h,
      { command: "git push -uf origin main" },
      { rule: "no-push" },
    );
    await expectBlocks(
      h,
      { command: "git push --force origin main" },
      { rule: "no-push" },
    );
    await expectAllows(h, { command: "git push origin main" });
  });

  it("gh -R x/y pr merge / --repo= / --hostname shapes extract pr", async () => {
    const h = loadHarness({
      config: {
        rules: [
          {
            name: "no-pr-merge",
            tool: "bash",
            field: "command",
            pattern: "^gh\\b",
            reason: "no merge",
            when: {
              subcommand: {
                pattern: "pr",
                valueConsumingFlags: ["-R", "--repo", "--hostname"],
              },
            },
          },
        ],
      },
    });
    await expectBlocks(
      h,
      { command: "gh -R x/y pr merge 1" },
      { rule: "no-pr-merge" },
    );
    await expectBlocks(
      h,
      { command: "gh --repo=x/y pr merge 1" },
      { rule: "no-pr-merge" },
    );
    await expectBlocks(
      h,
      { command: "gh --hostname h pr merge 1" },
      { rule: "no-pr-merge" },
    );
    await expectAllows(h, { command: "gh -R x/y issue list" });
  });

  it("go -v build blocks fail-closed (after-only invalid → unknown → block)", async () => {
    const h = loadHarness({
      config: {
        rules: [
          {
            name: "no-build",
            tool: "bash",
            field: "command",
            pattern: "^go\\b",
            reason: "no build",
            when: { subcommand: "build" },
          },
        ],
      },
    });
    await expectBlocks(
      h,
      { command: "go -v build ./..." },
      { rule: "no-build" },
    );
  });

  it("aws s3 --profile x ls matches depth-2 [s3, ls]; inner sh -c ref works", async () => {
    const h = loadHarness({
      config: {
        rules: [
          {
            name: "no-s3-ls",
            tool: "bash",
            field: "command",
            pattern: "^aws\\b",
            reason: "no ls",
            when: {
              subcommand: {
                pattern: ["s3", "ls"],
                depth: 2,
                valueConsumingFlags: ["--profile"],
              },
            },
          },
          gitRule({ flag: { anyOf: ["-f", "--force"], bundleAware: true } }),
        ],
      },
    });
    await expectBlocks(
      h,
      { command: "aws s3 --profile x ls s3://b" },
      { rule: "no-s3-ls" },
    );
    await expectAllows(h, { command: "aws s3 --profile x cp a b" });
    // Wrapper inner ref: the engine evaluates the expanded `git push -uf`.
    await expectBlocks(
      h,
      { command: "sh -c 'git push -uf origin main'" },
      { rule: "no-push" },
    );
  });

  it("write/edit rules with argv leaves fire fail-closed", async () => {
    const h = loadHarness({
      config: {
        rules: [
          {
            name: "no-write",
            tool: "write",
            field: "path",
            pattern: "^/tmp/",
            reason: "no write",
            when: { subcommand: "push" },
          },
        ],
      },
    });
    await expectBlocks(
      h,
      { write: { path: "/tmp/x", content: "x" } },
      { rule: "no-write" },
    );
  });

  it("exemption with subcommand exempts on match, never on unknown", async () => {
    const h = loadHarness({
      config: {
        rules: [
          {
            name: "no-git",
            tool: "bash",
            field: "command",
            pattern: "^git\\b",
            reason: "no git",
          },
        ],
        exemptions: [{ rule: "no-git", when: { subcommand: "pull" } }],
      },
    });
    await expectAllows(h, { command: "git pull" });
    await expectBlocks(
      h,
      { command: "git push origin main" },
      { rule: "no-git" },
    );
    // All-flags: extraction null → unknown → guard still fires.
    await expectBlocks(h, { command: "git --version" }, { rule: "no-git" });
  });
});

// ---------------------------------------------------------------------------
// Validator message + root re-exports
// ---------------------------------------------------------------------------

describe("argv leaves: validator + surface", () => {
  it("empty-clause error names the new leaves", async () => {
    const { validateWhenClauseShape } = await import("./predicates.ts");
    assert.throws(
      () => validateWhenClauseShape({}, 'rule "x".when'),
      /subcommand:.*flag:|flag:.*subcommand:/,
    );
  });
});
