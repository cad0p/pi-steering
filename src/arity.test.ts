// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Tests for `resolveDescriptor` + `deriveFlagSets` + `arityOf`
 * (issues #106/#107 registry-only; #110 flag table, additive foundation).
 *
 * Step 2 (additive): both the legacy `valueConsumingFlags` list and the new
 * `flags` table resolve (unioned). The cutover deletes the legacy channel.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  __resetDescriptorWarningsForTests,
  arityOf,
  CORE_CLI_DESCRIPTORS,
  deriveFlagSets,
  EMPTY_ARITY,
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
    assert.deepEqual([...resolved.valueConsumingFlags], ["--take"]);
    assert.deepEqual([...resolved.gluedShorts], []);
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
    assert.deepEqual([...resolved.valueConsumingFlags], []);
    assert.deepEqual([...resolved.gluedShorts], []);
    // Policy still falls back to the walker table, then strict.
    assert.equal(resolved.positionPolicy, "globals-anywhere");
    const gitStrict = resolveDescriptor("git", { git: {} });
    assert.deepEqual([...gitStrict.valueConsumingFlags], []);
    assert.equal(gitStrict.positionPolicy, "globals-before-only");
  });

  it("missing-key ≡ {} ≡ {flags:{}} empty-arity pin", () => {
    __resetDescriptorWarningsForTests();
    const a = resolveDescriptor("npm", { npm: {} });
    const b = resolveDescriptor("npm", { npm: { flags: {} } });
    assert.deepEqual([...a.valueConsumingFlags], [...b.valueConsumingFlags]);
    assert.deepEqual([...a.gluedShorts], [...b.gluedShorts]);
    assert.equal(a.positionPolicy, b.positionPolicy);
  });

  it("git plugin descriptor is pinned (plugin-owned, core seeds nothing)", () => {
    // Value pin against the plugin-owned const (imported from its
    // plugin home, not core). Transition: legacy list still present;
    // the seed step migrates it to entries.
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

describe("deriveFlagSets: table→sets (sole derivation site)", () => {
  it("single-char-short of takesValue glues; longs contribute only to consuming", () => {
    const { valueConsumingFlags, gluedShorts } = deriveFlagSets({
      repo: { aliases: ["-R", "--repo"], takesValue: true },
    });
    assert.deepEqual([...valueConsumingFlags].sort(), ["--repo", "-R"]);
    assert.deepEqual([...gluedShorts], ["R"]);
  });

  it("longs never glue even takesValue:true", () => {
    const { valueConsumingFlags, gluedShorts } = deriveFlagSets({
      repo: { aliases: ["--repo"], takesValue: true },
    });
    assert.deepEqual([...valueConsumingFlags], ["--repo"]);
    assert.deepEqual([...gluedShorts], []);
  });

  it("bool shorts bundle never glue (takesValue:false ⇒ neither set)", () => {
    const { valueConsumingFlags, gluedShorts } = deriveFlagSets({
      verbose: { aliases: ["-v"], takesValue: false },
    });
    assert.deepEqual([...valueConsumingFlags], []);
    assert.deepEqual([...gluedShorts], []);
  });

  it("tar -fX vs -vf pair: declared {f} glues -fX shape; derivation is lead-agnostic", () => {
    // Derivation emits the glue letter; the lead-letter rule lives in the
    // query layer (matchFlagAt / flagPresent). Pin the set half here.
    const { gluedShorts } = deriveFlagSets({
      file: { aliases: ["-f"], takesValue: true },
    });
    assert.deepEqual([...gluedShorts], ["f"]);
  });

  it("getopt-:: edge pin (documents accepted over-consume)", () => {
    // Optional-arg glue-only-never-separate is NOT modeled: declared
    // takesValue consumes separate too. Pin the derivation half.
    const { valueConsumingFlags } = deriveFlagSets({
      opt: { aliases: ["-o"], takesValue: true },
    });
    assert.ok(valueConsumingFlags.has("-o"));
  });

  it("malformed entries contribute nothing (merger warns; derive skips silently)", () => {
    const { valueConsumingFlags, gluedShorts } = deriveFlagSets({
      bad1: { aliases: [], takesValue: true },
      bad2: { aliases: ["-xy"], takesValue: true },
      bad3: { aliases: ["-R"], takesValue: "yes" as unknown as boolean },
    } as unknown as Record<string, { aliases: string[]; takesValue: boolean }>);
    assert.deepEqual([...valueConsumingFlags], []);
    assert.deepEqual([...gluedShorts], []);
  });

  it("undefined / non-object flags ⇒ empty sets", () => {
    assert.deepEqual([...deriveFlagSets(undefined).valueConsumingFlags], []);
    assert.deepEqual(
      [
        ...deriveFlagSets("nope" as unknown as Record<string, never>)
          .valueConsumingFlags,
      ],
      [],
    );
  });
});

describe("resolveDescriptor: flags table (additive)", () => {
  it("table entries resolve alongside the legacy list (union)", () => {
    __resetDescriptorWarningsForTests();
    const resolved = resolveDescriptor("mycli", {
      mycli: {
        valueConsumingFlags: ["--legacy"],
        flags: {
          repo: { aliases: ["-R", "--repo"], takesValue: true },
          verbose: { aliases: ["-v"], takesValue: false },
        },
      },
    });
    assert.deepEqual([...resolved.valueConsumingFlags].sort(), [
      "--legacy",
      "--repo",
      "-R",
    ]);
    assert.deepEqual([...resolved.gluedShorts], ["R"]);
  });

  it("post-merge flags array/string/null → WARN + strict-empty for that basename", () => {
    __resetDescriptorWarningsForTests();
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (msg?: unknown) => {
      warnings.push(String(msg));
    };
    try {
      const bad = {
        mycli: { flags: ["-R"] },
      } as unknown as Record<string, CLIDescriptor>;
      const resolved = resolveDescriptor("mycli", bad);
      assert.deepEqual([...resolved.valueConsumingFlags], []);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /\[invalid-descriptor\]/);
    } finally {
      console.warn = orig;
      __resetDescriptorWarningsForTests();
    }
  });

  it("per-entry aliases empty / -xy / non-string + takesValue non-boolean → WARN + entry contributes nothing", () => {
    __resetDescriptorWarningsForTests();
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (msg?: unknown) => {
      warnings.push(String(msg));
    };
    try {
      const bad = {
        mycli: {
          flags: {
            good: { aliases: ["-R"], takesValue: true },
            bad: { aliases: [], takesValue: true },
          },
        },
      } as unknown as Record<string, CLIDescriptor>;
      const resolved = resolveDescriptor("mycli", bad);
      assert.ok(resolved.valueConsumingFlags.has("-R"));
      assert.ok(warnings.length >= 1);
      assert.match(warnings[0]!, /\[invalid-descriptor\]/);
      assert.match(warnings[0]!, /"bad"/);
    } finally {
      console.warn = orig;
      __resetDescriptorWarningsForTests();
    }
  });

  it("invalid-present NEVER throws — only absent does", () => {
    __resetDescriptorWarningsForTests();
    const orig = console.warn;
    console.warn = () => {};
    try {
      const bad = {
        mycli: { flags: "nope" },
      } as unknown as Record<string, CLIDescriptor>;
      const resolved = resolveDescriptor("mycli", bad);
      assert.deepEqual([...resolved.valueConsumingFlags], []);
    } finally {
      console.warn = orig;
      __resetDescriptorWarningsForTests();
    }
    assert.throws(
      () => resolveDescriptor("absent-xyz", {}),
      MissingDescriptorError,
    );
  });
});

describe("arityOf: per-tool_call hoisted resolution", () => {
  it("second call for same basename returns SAME object identity", () => {
    __resetDescriptorWarningsForTests();
    const cache = new Map();
    const descriptors = {
      mycli: { flags: { a: { aliases: ["-a"], takesValue: true } } },
    };
    const first = arityOf("mycli", descriptors, cache);
    const second = arityOf("mycli", descriptors, cache);
    assert.equal(first, second);
    assert.equal(cache.size, 1);
  });

  it("nameless returns EMPTY_ARITY without Map write, never throws", () => {
    const cache = new Map();
    const result = arityOf(undefined, undefined, cache);
    assert.equal(result, EMPTY_ARITY);
    assert.equal(cache.size, 0);
  });

  it("per-call Map dies with the call (no cross-call pollution)", () => {
    __resetDescriptorWarningsForTests();
    const descriptors = { mycli: {} };
    const cacheA = new Map();
    const cacheB = new Map();
    const a = arityOf("mycli", descriptors, cacheA);
    const b = arityOf("mycli", descriptors, cacheB);
    assert.notEqual(a, b);
    assert.deepEqual([...a.valueConsumingFlags], [...b.valueConsumingFlags]);
  });
});
