// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Tests for `resolveDescriptor` precedence (issue #106 step-4).
 *
 * Pins the firm per-field composition:
 *   - inline `valueConsumingFlags`, when present, REPLACES the
 *     registry list (no union).
 *   - registry `positionPolicy` always overrides the
 *     `DEFAULT_POSITION_POLICIES` table fallback.
 *   - registry-absent + table-miss → strict `globals-anywhere` /
 *     empty set (table stays the fallback when registry absent).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  __resetDescriptorWarningsForTests,
  CORE_CLI_DESCRIPTORS,
  resolveDescriptor,
} from "./cli-descriptors.ts";
import { GIT_CLI_DESCRIPTOR } from "./plugins/git/descriptors.ts";
import type { CLIDescriptor } from "./schema.ts";

describe("resolveDescriptor: precedence inline > registry > strict-default", () => {
  it("inline flags REPLACE the registry list (no union)", () => {
    __resetDescriptorWarningsForTests();
    const registry = {
      git: { valueConsumingFlags: ["-C", "-c", "--extra"] },
    };
    const resolved = resolveDescriptor(
      "git",
      { valueConsumingFlags: ["--only"] },
      registry,
    );
    assert.deepEqual(resolved.valueConsumingFlags, ["--only"]);
  });

  it("registry flags win when inline absent", () => {
    __resetDescriptorWarningsForTests();
    const registry = {
      mycli: { valueConsumingFlags: ["--take"] },
    };
    const resolved = resolveDescriptor("mycli", undefined, registry);
    assert.deepEqual(resolved.valueConsumingFlags, ["--take"]);
  });

  it("registry policy overrides the table fallback", () => {
    __resetDescriptorWarningsForTests();
    // git table is globals-before-only; registry overrides to anywhere.
    const registry = {
      git: { positionPolicy: "globals-anywhere" as const },
    };
    const resolved = resolveDescriptor("git", undefined, registry);
    assert.equal(resolved.positionPolicy, "globals-anywhere");
  });

  it("registry-absent + table-miss → strict globals-anywhere / empty set", () => {
    __resetDescriptorWarningsForTests();
    const resolved = resolveDescriptor("unknown-basileus-xyz", undefined, {});
    assert.equal(resolved.positionPolicy, "globals-anywhere");
    assert.deepEqual(resolved.valueConsumingFlags, []);
  });

  it("per-field composition is UNCONDITIONAL (flags replace, policy overrides)", () => {
    __resetDescriptorWarningsForTests();
    const registry = {
      git: {
        positionPolicy: "globals-anywhere" as const,
        valueConsumingFlags: ["--reg"],
      },
    };
    const resolved = resolveDescriptor(
      "git",
      { valueConsumingFlags: ["--inline"] },
      registry,
    );
    // Inline flags replace; registry policy still overrides table.
    assert.deepEqual(resolved.valueConsumingFlags, ["--inline"]);
    assert.equal(resolved.positionPolicy, "globals-anywhere");
  });

  it("git plugin descriptor is pinned (plugin-owned, core seeds nothing)", () => {
    // Value pin against the plugin-owned const (imported from its
    // plugin home, not core).
    assert.deepEqual(GIT_CLI_DESCRIPTOR, {
      positionPolicy: "globals-before-only",
      valueConsumingFlags: ["-C", "-c"],
    });
    // Assignability pin (§9): the const satisfies CLIDescriptor
    // (JSDoc presence itself is not tsc-pinnable — hover rides on
    // the named-const reference pattern).
    const _assignable: CLIDescriptor = GIT_CLI_DESCRIPTOR;
    void _assignable;
    // Core seeds nothing.
    assert.deepEqual(CORE_CLI_DESCRIPTORS, {});
  });
});

describe("commandFromInput binding: FlagLookupOptions.valueConsumingFlags seam (issue #106 step-4)", () => {
  it("per-ref binding threads the descriptor list; per-call opts win (step-1: gating live)", async () => {
    const { commandFromInput } = await import("./helpers/command.ts");
    // Per-ref binding is accepted: presence agrees, and the strict-
    // always gate now applies (undeclared `--delete` is valueless).
    const cmd = commandFromInput(
      {
        tool: "bash",
        command: "git push --delete origin",
        basename: "git",
        args: [
          { text: "push", value: "push", rawText: "push" },
          { text: "--delete", value: "--delete", rawText: "--delete" },
          { text: "origin", value: "origin", rawText: "origin" },
        ],
      } as never,
      ["-C", "-c"],
    );
    assert.equal(cmd.hasFlag("--delete"), true);
    // Per-call opts still win over the bound descriptor on the
    // standalone-opts path (presence agrees either way).
    assert.equal(
      cmd.hasFlag("--delete", { valueConsumingFlags: ["--other"] }),
      true,
    );
    // Gating is live: `--delete` is undeclared in the bound list.
    assert.equal(cmd.getFlagValue("--delete"), null);
    assert.deepEqual(cmd.getAllFlagValues("--delete"), []);
  });
});
