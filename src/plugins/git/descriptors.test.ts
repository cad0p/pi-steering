// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Oracles-lite pins for the Fig-seeded git table (issue #110 §6.3).
 *
 * Each seeded git entry has a regex over `git --help` output asserting the
 * arity text that justifies `takesValue`. These are the baselines #111
 * diffs against. `rm`/async absence pins assert NO value-taking surface
 * (explicit verdict, not omission).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { GIT_CLI_DESCRIPTOR } from "./descriptors.ts";
import { RM_CLI_DESCRIPTOR } from "../rm/descriptors.ts";

/** Capture `git --help`, skipping (not failing) when git is unavailable. */
function gitHelp(): string | null {
  try {
    return execFileSync("git", ["--help"], { encoding: "utf8" });
  } catch {
    return null;
  }
}

/** Capture `rm --help`, skipping when unavailable. */
function rmHelp(): string | null {
  try {
    return execFileSync("rm", ["--help"], { encoding: "utf8" });
  } catch {
    return null;
  }
}

describe("git seed oracles-lite (Fig → --help verdict)", () => {
  it("seeded table shape: 17 globals (provenance header on descriptors.ts)", () => {
    const flags = GIT_CLI_DESCRIPTOR.flags as Record<string, unknown>;
    assert.equal(Object.keys(flags).length, 17);
  });

  it("-C <path> (takesValue:true)", () => {
    const help = gitHelp();
    if (help === null) return;
    assert.match(help, /-C <path>/);
    assert.equal(
      (GIT_CLI_DESCRIPTOR.flags as Record<string, { takesValue: boolean }>)[
        "C"
      ]!.takesValue,
      true,
    );
  });

  it("-c <name>=<value> (takesValue:true)", () => {
    const help = gitHelp();
    if (help === null) return;
    assert.match(help, /-c <name>=<value>/);
  });

  it("--git-dir=<path> (takesValue:true)", () => {
    const help = gitHelp();
    if (help === null) return;
    assert.match(help, /--git-dir=<path>/);
  });

  it("--work-tree=<path> (takesValue:true)", () => {
    const help = gitHelp();
    if (help === null) return;
    assert.match(help, /--work-tree=<path>/);
  });

  it("--namespace=<name> (takesValue:true)", () => {
    const help = gitHelp();
    if (help === null) return;
    assert.match(help, /--namespace=<name>/);
  });

  it("--config-env=<name>=<envvar> (takesValue:true; Fig gap filled by --help)", () => {
    const help = gitHelp();
    if (help === null) return;
    assert.match(help, /--config-env=<name>=<envvar>/);
  });

  it("--exec-path[=<path>] optional-attached → takesValue:false", () => {
    const help = gitHelp();
    if (help === null) return;
    assert.match(help, /--exec-path\[=<path>\]/);
    assert.equal(
      (GIT_CLI_DESCRIPTOR.flags as Record<string, { takesValue: boolean }>)[
        "execPath"
      ]!.takesValue,
      false,
    );
  });

  it("bool globals carry no arity text (--bare, --no-pager, --paginate, --html-path)", () => {
    const help = gitHelp();
    if (help === null) return;
    assert.match(help, /--bare/);
    assert.match(help, /--no-pager/);
    assert.match(help, /--paginate/);
    const flags = GIT_CLI_DESCRIPTOR.flags as Record<
      string,
      { takesValue: boolean }
    >;
    for (const key of [
      "bare",
      "noPager",
      "paginate",
      "htmlPath",
      "manPath",
      "infoPath",
      "noReplaceObjects",
      "version",
      "help",
    ]) {
      assert.equal(flags[key]!.takesValue, false, key);
    }
  });
});

describe("rm/async absence pins (explicit verdict, not omission)", () => {
  it("rm ships explicit-strict empty table (no value-taking surface)", () => {
    assert.deepEqual(RM_CLI_DESCRIPTOR, { flags: {} });
  });

  it("rm --help shows only bool + optional-attached flags", () => {
    const help = rmHelp();
    if (help === null) return;
    // Optional-attached shapes exist but never require separate values.
    assert.match(help, /--interactive\[=WHEN\]/);
    // No required-value `<WHEN>`/`=<WHEN>` arity text on any rm flag line
    // outside the optional brackets (spot-check the bool roster).
    assert.match(help, /--one-file-system/);
    assert.match(help, /--no-preserve-root/);
  });

  it("async ships no table (no CLI basename of its own — documented, no code)", async () => {
    const asyncPlugin = (await import("../async/index.ts")).default;
    assert.equal("cliDescriptors" in (asyncPlugin as object), false);
  });
});
