// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Tests for `resolveDescriptor` (issues #106/#107, registry-only).
 *
 * Pins the firm resolution:
 *   - registry `valueConsumingFlags` (validated) else strict empty set.
 *   - registry `positionPolicy` always overrides the
 *     `DEFAULT_POSITION_POLICIES` table fallback.
 *   - registry-absent → throws `MissingDescriptorError` (no silent
 *     fallback; present-empty `{<bin>: {}}` is explicit strict).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  __resetDescriptorWarningsForTests,
  CORE_CLI_DESCRIPTORS,
  MissingDescriptorError,
  resolveDescriptor,
} from "./arity.ts";
import { GIT_CLI_DESCRIPTOR } from "./plugins/git/descriptors.ts";
import type { CLIDescriptor } from "./schema.ts";

describe("resolveDescriptor: registry > table > strict-default", () => {
  it("registry flags resolve (no inline channel)", () => {
    __resetDescriptorWarningsForTests();
    const registry = {
      mycli: { valueConsumingFlags: ["--take"] },
    };
    const resolved = resolveDescriptor("mycli", registry);
    assert.deepEqual(resolved.valueConsumingFlags, ["--take"]);
  });

  it("registry policy overrides the table fallback", () => {
    __resetDescriptorWarningsForTests();
    // git table is globals-before-only; registry overrides to anywhere.
    const registry = {
      git: { positionPolicy: "globals-anywhere" as const },
    };
    const resolved = resolveDescriptor("git", registry);
    assert.equal(resolved.positionPolicy, "globals-anywhere");
  });

  it("absent basename → throws MissingDescriptorError (loud, never silent strict)", () => {
    __resetDescriptorWarningsForTests();
    assert.throws(
      () => resolveDescriptor("unknown-basileus-xyz", {}),
      (err: unknown) => {
        assert.ok(err instanceof MissingDescriptorError);
        assert.equal(err.basename, "unknown-basileus-xyz");
        assert.match(err.message, /unknown-basileus-xyz/);
        assert.match(err.message, /cliDescriptors/);
        assert.match(err.message, /\{ "unknown-basileus-xyz": \{\} \}/);
        return true;
      },
    );
    // Missing map entirely throws too.
    assert.throws(
      () => resolveDescriptor("npm", undefined),
      MissingDescriptorError,
    );
  });

  it("present-but-empty descriptor ({ npm: {} }) = explicit strict (silent)", () => {
    __resetDescriptorWarningsForTests();
    const resolved = resolveDescriptor("npm", { npm: {} });
    assert.deepEqual(resolved.valueConsumingFlags, []);
    // Policy still falls back to the walker table, then strict.
    assert.equal(resolved.positionPolicy, "globals-anywhere");
    const gitStrict = resolveDescriptor("git", { git: {} });
    assert.deepEqual(gitStrict.valueConsumingFlags, []);
    assert.equal(gitStrict.positionPolicy, "globals-before-only");
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
