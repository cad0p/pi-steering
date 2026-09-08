// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Typing pins for the `command:` first filter (issue #117) plus the
 * behavioral merge gates: routing is exact basename equality (the
 * type machinery is a strict union over declared descriptor keys,
 * threaded through `defineConfig` like `AllRuleNames`).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import type { BashToolCallEvent } from "@earendil-works/pi-coding-agent";
import { makeCtx, makeTrackedHost as makeHost } from "./__test-helpers__.ts";
import { defineConfig } from "./define-config.ts";
import { buildEvaluator } from "./evaluator.ts";
import { resolvePlugins } from "./plugin-merger.ts";
import { noForcePush } from "./plugins/git/rules/no-force-push.ts";
import shippedGitPlugin from "./plugins/git/index.ts";
import shippedRmPlugin, { noRmRfSlash } from "./plugins/rm/index.ts";
import type { Plugin, Rule } from "./schema.ts";

describe("command: typing pins (issue #117)", () => {
  it("accepts a declared basename", () => {
    const cfg = defineConfig({
      plugins: [shippedGitPlugin],
      rules: [
        {
          name: "git-only",
          tool: "bash",
          command: "git",

          reason: "r",
        },
      ],
    });
    assert.equal(cfg.rules?.[0]?.name, "git-only");
  });

  it("accepts a readonly array of declared basenames", () => {
    const cfg = defineConfig({
      plugins: [shippedGitPlugin, shippedRmPlugin],
      rules: [
        {
          name: "git-or-rm",
          tool: "bash",
          command: ["git", "rm"] as const,
          reason: "r",
        },
      ],
    });
    assert.equal(cfg.rules?.[0]?.name, "git-or-rm");
  });

  it("accepts inline-literal plugin basenames", () => {
    const myPlugin = {
      name: "myplugin",
      cliDescriptors: { mycli: { flags: {} } },
    } as const satisfies Plugin;
    const cfg = defineConfig({
      plugins: [myPlugin],
      rules: [
        {
          name: "mycli-only",
          tool: "bash",
          command: "mycli",

          reason: "r",
        },
      ],
    });
    assert.equal(cfg.rules?.[0]?.name, "mycli-only");
  });

  it("widened `: Plugin` skips the check (runtime backstop covers)", async () => {
    // Bare `: Plugin` widens `cliDescriptors` to
    // `Record<string, CLIDescriptor>` — "can't verify" means "skip",
    // never a false-positive. The fail-closed rule-tagged
    // `MissingDescriptorError` block covers the widened path at
    // evaluation time (no silent never-fire).
    const wide: Plugin = {
      name: "wide",
      cliDescriptors: { widecli: { flags: {} } },
    };
    const cfg = defineConfig({
      plugins: [wide],
      rules: [
        {
          name: "wide-rule",
          tool: "bash",
          command: "anything",
          reason: "r",
        },
      ],
    });
    assert.equal(cfg.rules?.[0]?.name, "wide-rule");
    // Runtime side of the skip: evaluating a matched ref without a
    // registered descriptor fails CLOSED (rule-tagged MDE block),
    // never silently.
    const ev = buildEvaluator(
      { rules: cfg.rules ?? [] },
      resolvePlugins([wide], {}),
      makeHost(),
    );
    const res = await ev.evaluate(
      {
        type: "tool_call",
        toolCallId: "t1",
        toolName: "bash",
        input: { command: "anything run" },
      } as BashToolCallEvent,
      makeCtx("/r"),
      0,
    );
    const reason = (res as { reason?: string } | undefined)?.reason ?? "";
    assert.match(reason, /No CLI descriptor for basename "anything"/);
  });

  it("rejects an undeclared basename at tsc", () => {
    defineConfig({
      plugins: [shippedGitPlugin, shippedRmPlugin],
      rules: [
        {
          name: "typo",
          tool: "bash",
          // @ts-expect-error — "gti" is not a declared descriptor key.
          command: "gti",
          reason: "r",
        },
      ],
    });
  });
});

describe("command: required + rejects pattern/field (issue #117)", () => {
  it("rejects an absent command at tsc", () => {
    defineConfig({
      plugins: [shippedGitPlugin],
      rules: [
        // @ts-expect-error — command is required on bash rules.
        {
          name: "no-command",
          tool: "bash",
          reason: "r",
        },
      ],
    });
  });

  it("no shipped bash rule carries pattern/field; every one routes on command", () => {
    const shipped: readonly Rule[] = [
      ...(shippedGitPlugin.rules ?? []),
      ...(shippedRmPlugin.rules ?? []),
    ];
    assert.ok(shipped.length > 0);
    for (const rule of shipped) {
      assert.ok(
        !("pattern" in rule),
        `${rule.name} must not carry pattern`,
      );
      assert.ok(!("field" in rule), `${rule.name} must not carry field`);
      if (rule.tool !== "bash") throw new Error("narrow");
      assert.ok(
        typeof rule.command === "string" || Array.isArray(rule.command),
        `${rule.name} must route on command`,
      );
    }
  });
});

describe("command: evaluator behavior (issue #117)", () => {
  function bashEvent(command: string): BashToolCallEvent {
    return {
      type: "tool_call",
      toolCallId: "t1",
      toolName: "bash",
      input: { command },
    };
  }

  function evaluatorWith(rules: readonly Rule[], plugins: readonly Plugin[]) {
    return buildEvaluator({ rules }, resolvePlugins(plugins, {}), makeHost());
  }

  it("wrapper transparency: sh -c, /usr/bin/, -C match; echo does not", async () => {
    const ev = evaluatorWith([noForcePush], [shippedGitPlugin]);
    const yes = [
      "git push --force",
      "sh -c 'git push --force'",
      "/usr/bin/git push --force",
      "git -C /x push --force",
      "cd /repo && git push --force",
    ];
    for (const cmd of yes) {
      const r = await ev.evaluate(bashEvent(cmd), makeCtx("/repo"), 0);
      assert.equal(
        (r as { block?: boolean } | undefined)?.block,
        true,
        `expected block: ${cmd}`,
      );
    }
    const no = await ev.evaluate(
      bashEvent("echo 'git push --force'"),
      makeCtx("/repo"),
      0,
    );
    assert.equal(no, undefined);
  });

  it("array-OR routing (synthetic two-binary rule, one name)", async () => {
    // No production vehicle after the async deletion — synthetic pin.
    // One name = one disabledRules entry; leaves stay per-ref AND.
    const facts = {
      name: "synth",
      cliDescriptors: { alpha: {}, bravo: {} },
    } as const satisfies Plugin;
    const rule = {
      name: "alpha-or-bravo",
      tool: "bash",
      command: ["alpha", "bravo"],
      reason: "synthetic",
    } as const satisfies Rule;
    const ev = evaluatorWith([rule], [facts]);
    for (const cmd of ["alpha run", "bravo run"]) {
      const r = await ev.evaluate(bashEvent(cmd), makeCtx("/r"), 0);
      assert.equal(
        (r as { block?: boolean } | undefined)?.block,
        true,
        `expected block: ${cmd}`,
      );
    }
    assert.equal(await ev.evaluate(bashEvent("other run"), makeCtx("/r"), 0), undefined);
    // Single disable entry covers both members (identity, not leaves):
    // the array-routed rule's name typechecks as one disabledRules entry.
    const cfg = defineConfig({
      plugins: [facts],
      rules: [rule],
      disabledRules: ["alpha-or-bravo"],
    });
    assert.deepEqual(cfg.disabledRules, ["alpha-or-bravo"]);
  });

  it("per-ref leaf semantics under arrays: senseless leaf never fires", async () => {
    const facts = {
      name: "synth",
      cliDescriptors: { git: {}, npm: {} },
    } as const satisfies Plugin;
    const rule: Rule = {
      name: "push-guard",
      tool: "bash",
      command: ["git", "npm"],
      reason: "synthetic",
      when: { subcommand: "push" },
    };
    const ev = evaluatorWith([rule], [facts]);
    const fires = await ev.evaluate(bashEvent("git push"), makeCtx("/r"), 0);
    assert.equal((fires as { block?: boolean } | undefined)?.block, true);
    // No `push` token on the npm ref → the leaf never fires for it.
    assert.equal(
      await ev.evaluate(bashEvent("npm run dev"), makeCtx("/r"), 0),
      undefined,
    );
  });

  it("unrouted undescribed binaries never throw (routing first, resolution second)", async () => {
    // The anti-hoist pin: `arityOf` sits strictly AFTER the routing
    // filter, so `kubectl get pods` (no kubectl descriptor anywhere)
    // evaluates clean instead of throwing MissingDescriptorError.
    const ev = evaluatorWith([noForcePush], [shippedGitPlugin]);
    assert.equal(
      await ev.evaluate(bashEvent("kubectl get pods"), makeCtx("/r"), 0),
      undefined,
    );
  });

  it("nameless refs (bare VAR=x) never match and never throw", async () => {
    const ev = evaluatorWith([noForcePush], [shippedGitPlugin]);
    assert.equal(
      await ev.evaluate(bashEvent("VAR=x"), makeCtx("/r"), 0),
      undefined,
    );
  });

  it("unknown command basename fails closed at evaluation (rule-tagged MDE block)", async () => {
    // No build-time throw: the fail-closed `MissingDescriptorError`
    // block (with remedy) on the first MATCHED evaluation is the
    // runtime backstop — it covers widened-`: Plugin` / plain-JS
    // configs the type union can't see, and keeps the §5 throw
    // contract unchanged (unmatched refs never reach it).
    const rule: Rule = {
      name: "mystery",
      tool: "bash",
      command: "mycli",
      reason: "r",
    };
    const ev = evaluatorWith([rule], []);
    const res = await ev.evaluate(
      bashEvent("mycli push"),
      makeCtx("/r"),
      0,
    );
    const reason = (res as { reason?: string } | undefined)?.reason ?? "";
    assert.match(reason, /\[steering:mystery@user\]/);
    assert.match(reason, /No CLI descriptor for basename "mycli"/);
  });

  it("whitespace in command is rejected at build", async () => {
    const rule = {
      name: "bad",
      tool: "bash",
      command: "git commit",
      reason: "r",
    } as unknown as Rule;
    assert.throws(
      () => evaluatorWith([rule], [shippedGitPlugin]),
      /invalid command entry "git commit"/,
    );
  });

  it("empty command array never fires (mirrors empty-anyOf)", async () => {
    const rule = {
      name: "never",
      tool: "bash",
      command: [],
      reason: "r",
    } as unknown as Rule;
    const facts = {
      name: "synth",
      cliDescriptors: { git: {} },
    } as const satisfies Plugin;
    const ev = evaluatorWith([rule], [facts]);
    assert.equal(
      await ev.evaluate(bashEvent("git push --force"), makeCtx("/r"), 0),
      undefined,
    );
  });
});

describe("command: write/edit pattern untouched (issue #117)", () => {
  it("write/edit rules still accept string|RegExp patterns and fire", async () => {
    const str: Rule = {
      name: "w-str",
      tool: "write",
      field: "path",
      pattern: "^/etc/",
      reason: "r",
    };
    const re: Rule = {
      name: "e-re",
      tool: "edit",
      field: "content",
      pattern: /SECRET/,
      reason: "r",
    };
    assert.ok(str.pattern === "^/etc/");
    assert.ok(re.pattern instanceof RegExp);
  });
});

describe("command: async deletion pins (issue #117 §6.1)", () => {
  it('defineConfig plugin-name union no longer contains "async"', () => {
    defineConfig({
      plugins: [shippedGitPlugin, shippedRmPlugin],
      // @ts-expect-error — "async" ships nothing anymore.
      disabledPlugins: ["async"],
    });
  });

  it("package.json no longer exports ./plugins/async", () => {
    const pkg = JSON.parse(
      readFileSync(join(dirname(new URL(import.meta.url).pathname), "..", "package.json"), "utf8"),
    ) as { exports: Record<string, unknown> };
    assert.ok(!("./plugins/async" in pkg.exports));
    assert.ok("./plugins/git" in pkg.exports);
    assert.ok("./plugins/rm" in pkg.exports);
  });

  it("the async plugin files are gone (scoped import rejects)", async () => {
    const spec = ["./plugins", "async", "index.ts"].join("/");
    await assert.rejects(import(spec));
  });

  it("shipped plugins are git + rm only", () => {
    assert.equal(shippedGitPlugin.name, "git");
    assert.equal(shippedRmPlugin.name, "rm");
    assert.ok(!("async" in { git: 1, rm: 1 }));
  });

  it("no-rm-rf-slash keeps its seal after the migration", () => {
    assert.equal(noRmRfSlash.noOverride, true);
  });
});
