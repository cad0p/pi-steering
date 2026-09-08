// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Typing pins for the `command:` first filter (issue #117).
 *
 * Commit 1 (additive foundation): `command` is optional and the engine
 * still routes on `pattern:` — these pins cover the TYPE machinery
 * only (strict union over declared descriptor keys, threaded through
 * `defineConfig` like `AllRuleNames`). The commit-2 deletion flips
 * enforcement to exact equality, and appends the behavior pins
 * (wrapper transparency, array-OR, per-ref leaves, absent-descriptor
 * throw) to this file.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defineConfig } from "./define-config.ts";
import shippedGitPlugin from "./plugins/git/index.ts";
import shippedRmPlugin from "./plugins/rm/index.ts";
import type { Plugin } from "./schema.ts";

describe("command: typing pins (issue #117)", () => {
  it("accepts a declared basename", () => {
    const cfg = defineConfig({
      plugins: [shippedGitPlugin],
      rules: [
        {
          name: "git-only",
          tool: "bash",
          field: "command",
          pattern: "^git\\b",
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
          field: "command",
          pattern: "^(git|rm)\\b",
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
          field: "command",
          pattern: "^mycli\\b",
          command: "mycli",
          reason: "r",
        },
      ],
    });
    assert.equal(cfg.rules?.[0]?.name, "mycli-only");
  });

  it("widened `: Plugin` skips the check (runtime backstop covers)", () => {
    // Bare `: Plugin` widens `cliDescriptors` to
    // `Record<string, CLIDescriptor>` — "can't verify" means "skip",
    // never a false-positive. The evaluator-build backstop throws
    // loud on unknown basenames at runtime (pinned in commit 2).
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
          field: "command",
          pattern: "^anything\\b",
          command: "anything",
          reason: "r",
        },
      ],
    });
    assert.equal(cfg.rules?.[0]?.name, "wide-rule");
  });

  it("rejects an undeclared basename at tsc", () => {
    defineConfig({
      plugins: [shippedGitPlugin, shippedRmPlugin],
      rules: [
        {
          name: "typo",
          tool: "bash",
          field: "command",
          pattern: "^gti\\b",
          // @ts-expect-error — "gti" is not a declared descriptor key.
          command: "gti",
          reason: "r",
        },
      ],
    });
  });
});
