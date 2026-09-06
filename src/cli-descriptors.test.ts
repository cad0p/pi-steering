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
  GH_CLI_DESCRIPTOR,
  GIT_CLI_DESCRIPTOR,
  resolveDescriptor,
} from "./cli-descriptors.ts";

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

  it("core defaults are pinned (git + gh minimum)", () => {
    assert.deepEqual(GIT_CLI_DESCRIPTOR, {
      positionPolicy: "globals-before-only",
      valueConsumingFlags: ["-C", "-c"],
    });
    assert.deepEqual(GH_CLI_DESCRIPTOR, {
      positionPolicy: "globals-anywhere",
      valueConsumingFlags: ["-R", "--repo", "--hostname"],
    });
  });
});

describe("isValueConsuming: arity-helper contract (issue #106 step-5, #107 implements)", () => {
  it("returns true iff flag is in inline ?? descriptor ?? []", async () => {
    const { isValueConsuming } = await import("./helpers/flags.ts");
    // Inline present → descriptor ignored (REPLACE, no union).
    assert.equal(
      isValueConsuming("--a", { inline: ["--a"], descriptor: ["--b"] }),
      true,
    );
    assert.equal(
      isValueConsuming("--b", { inline: ["--a"], descriptor: ["--b"] }),
      false,
    );
    // Inline absent → descriptor.
    assert.equal(isValueConsuming("--b", { descriptor: ["--b"] }), true);
    assert.equal(isValueConsuming("--x", { descriptor: ["--b"] }), false);
    // Neither → false (strict: nothing consumes).
    assert.equal(isValueConsuming("--x", {}), false);
    // Empty inline REPLACES non-empty descriptor.
    assert.equal(
      isValueConsuming("--b", { inline: [], descriptor: ["--b"] }),
      false,
    );
  });

  it("FlagLookupOptions.valueConsumingFlags seam exists (no behavior change)", async () => {
    const { commandFromInput } = await import("./helpers/command.ts");
    // Per-ref binding is accepted and inert: presence-only agrees,
    // value-level behavior unchanged until #107.
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
    // Per-call opts win over the bound descriptor (contract, inert today).
    assert.equal(
      cmd.hasFlag("--delete", { valueConsumingFlags: ["--other"] }),
      true,
    );
  });
});
