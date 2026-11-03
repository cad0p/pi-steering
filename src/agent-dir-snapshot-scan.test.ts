// SPDX-License-Identifier: MIT
// Part of pi-steering.
//
// Lens round 5 (mechanism change): after the first read, nothing in
// pi-steering reads the live home directory or agent-dir variables for a
// decision; every reader takes the process snapshot
// (src/internal/agent-dir-snapshot.ts). This scan pins it: any of the
// patterns below in shipped source outside the snapshot module fails.
// Comments are stripped first (they may name the forbidden calls).

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = dirname(fileURLToPath(import.meta.url));
const ALLOWED = new Set(["internal/agent-dir-snapshot.ts"]);

/** Live reads of the home directory / agent dir. */
const FORBIDDEN: readonly RegExp[] = [
  /\bhomedir\s*\(/,
  /process\.env\.(?:HOME|USERPROFILE|PI_CODING_AGENT_DIR)\b/,
  /process\.env\[\s*["'`](?:HOME|USERPROFILE|PI_CODING_AGENT_DIR)["'`]\s*\]/,
  /\bos\.userInfo\b/,
  /\buserInfo\s*\(/,
];

/** Strip block comments, whole-line comments and trailing ` // …` comments. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) =>
      /^\s*\/\//.test(line) ? "" : line.replace(/\s\/\/\s.*$/, ""),
    )
    .join("\n");
}

function shippedSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...shippedSources(path));
    else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts") &&
      entry.name !== "__test-helpers__.ts"
    )
      out.push(path);
  }
  return out;
}

describe("round 5: no live HOME / agent-dir read outside the snapshot module", () => {
  it("the shipped sources contain none of the forbidden reads", () => {
    const hits: string[] = [];
    const files = shippedSources(SRC);
    assert.ok(files.length > 20, `scan found only ${files.length} files`);
    for (const file of files) {
      const rel = relative(SRC, file).split("\\").join("/");
      if (ALLOWED.has(rel)) continue;
      const code = stripComments(readFileSync(file, "utf8"));
      for (const [i, line] of code.split("\n").entries()) {
        for (const re of FORBIDDEN)
          if (re.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    }
    assert.deepEqual(hits, []);
  });

  it("the scan catches each pattern and ignores comments (not vacuous)", () => {
    for (const sample of [
      "const h = homedir();",
      "const h = process.env.HOME;",
      "const h = process.env.USERPROFILE;",
      "const d = process.env.PI_CODING_AGENT_DIR;",
      'const d = process.env["HOME"];',
      "const u = os.userInfo().homedir;",
    ]) {
      assert.ok(
        FORBIDDEN.some((re) => re.test(stripComments(sample))),
        sample,
      );
    }
    assert.ok(
      !FORBIDDEN.some((re) =>
        re.test(stripComments("// homedir() in a comment")),
      ),
    );
  });

  it("the snapshot module is the one place that reads them", () => {
    const code = stripComments(
      readFileSync(join(SRC, "internal", "agent-dir-snapshot.ts"), "utf8"),
    );
    assert.ok(/\bhomedir\s*\(/.test(code));
    assert.ok(/\buserInfo\s*\(/.test(code));
  });
});
