// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Guard: this package's RUNTIME surface must never import pi by value.
 *
 * pi is a peer, and the loader (loader.ts) evaluates a user's
 * <agentDir>/steering/index.ts through jiti with resolution anchored
 * on the CONFIG's directory. A config tree pins its own
 * @earendil-works/pi-coding-agent devDependency to typecheck against
 * pi, so every VALUE import of pi from this package — reached from the
 * config's own copy of dist/ — resolves to that second pi and loads it
 * inside the running one. Measured on a real global config: +100 MB RSS
 * and +0.6 s per cold load, because a whole pi (agent, pi-ai,
 * providers) initializes a second time.
 *
 * "import type" is safe: verbatimModuleSyntax guarantees tsc drops it.
 * Inline "type" specifiers (import { type X } from ...) are safe too —
 * they are erased the same way. What this suite rejects is a binding
 * that survives into dist/.
 *
 * Scanned surface: src/**&#47;*.ts minus *.test.ts. Source — not dist/ —
 * because CI runs the suite BEFORE the build (ci.yml order: lint,
 * typecheck, tests, then build); source is the honest input under
 * verbatimModuleSyntax, which forbids anything but a 1:1 emit of the
 * value/type import split.
 *
 * Current state: evaluator.ts carried the only such import
 * (isToolCallEventType, whose pi implementation is the single
 * comparison event.toolName === toolName in every published pi since
 * 0.74.0). It is a local function now; this suite keeps it that way.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const PI_PREFIX = "@earendil-works/";
const SRC_DIR = fileURLToPath(new URL("./", import.meta.url));

/** Every non-test .ts file under src/, recursive. */
function runtimeSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...runtimeSources(path));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Value imports / re-exports of pi in one file, rendered as
 * "<line>:<specifier>". A declaration counts as a VALUE import when at
 * least one surviving binding is not type-only.
 */
function runtimePiImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const at = (node: ts.Node): string =>
    String(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
  const hits: string[] = [];
  const isPi = (spec: string): boolean => spec.startsWith(PI_PREFIX);

  for (const stmt of sf.statements) {
    // import ... from "@earendil-works/..."
    if (
      ts.isImportDeclaration(stmt) &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      isPi(stmt.moduleSpecifier.text)
    ) {
      const spec = stmt.moduleSpecifier.text;
      const clause = stmt.importClause;
      // A side-effect import ("import '@earendil-works/...'") always runs.
      if (clause === undefined) {
        hits.push(at(stmt) + ":" + spec);
        continue;
      }
      if (clause.isTypeOnly) continue;
      // A default or namespace binding is always a runtime binding.
      if (clause.name !== undefined) {
        hits.push(at(stmt) + ":" + spec);
        continue;
      }
      const bindings = clause.namedBindings;
      if (bindings === undefined) continue;
      if (ts.isNamespaceImport(bindings)) {
        hits.push(at(stmt) + ":" + spec);
        continue;
      }
      if (bindings.elements.some((el) => !el.isTypeOnly)) {
        hits.push(at(stmt) + ":" + spec);
      }
      continue;
    }

    // export ... from "@earendil-works/..." / export * from ...
    if (
      ts.isExportDeclaration(stmt) &&
      stmt.moduleSpecifier !== undefined &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      isPi(stmt.moduleSpecifier.text)
    ) {
      if (stmt.isTypeOnly) continue;
      const spec = stmt.moduleSpecifier.text;
      const clause = stmt.exportClause;
      // export * from is a runtime re-export surface.
      if (clause === undefined) {
        hits.push(at(stmt) + ":" + spec);
        continue;
      }
      if (
        ts.isNamedExports(clause) &&
        clause.elements.some((el) => !el.isTypeOnly)
      ) {
        hits.push(at(stmt) + ":" + spec);
      }
    }
  }
  return hits;
}

describe("runtime surface has no value import of pi", () => {
  it("scans a non-empty source set (guards against a vacuous pass)", () => {
    // A broken SRC_DIR would make the suite below iterate nothing and
    // pass silently; pin the shape of the input instead.
    assert.ok(runtimeSources(SRC_DIR).length > 20);
  });

  it("imports @earendil-works/* with import type only", () => {
    const offenders = runtimeSources(SRC_DIR).flatMap((file) =>
      runtimePiImports(file).map((hit) => file.slice(SRC_DIR.length) + hit),
    );
    assert.deepEqual(
      offenders,
      [],
      "runtime value import of pi found - it loads a SECOND pi inside any " +
        "user-config tree:\n" +
        offenders.join("\n"),
    );
  });
});
