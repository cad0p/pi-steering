// SPDX-License-Identifier: MIT
// Part of pi-steering-flags.

/**
 * Regression fence: verifies that the `declare global { interface
 * PiSteeringPredicates }` block in `./index.ts` is wired up correctly
 * \u2014 the `requiresFlag` and `allowlistedFlagsOnly` keys typecheck
 * inside a `Rule`'s `when:` slot with their bare and spread forms.
 *
 * Mirrors the spirit of pi-steering's `jsdoc-propagation.test.ts`
 * (TypeScript Compiler API driving a synthetic source file) but
 * lighter-weight: only verifies that the registry block makes the
 * predicates accessible at the type level. JSDoc-propagation behavior
 * is exercised on the canonical gitPlugin registry block; we don't
 * duplicate that fence here.
 *
 * If this fence fails, either the registry block was removed /
 * regressed, the predicate names drifted from the registry's keys,
 * or the bare / spread shapes no longer match what a rule author
 * would write.
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as ts from "typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FLAGS_INDEX_PATH = path.resolve(HERE, "index.ts");
// Resolve pi-steering's source-file index via this package's
// node_modules symlink \u2014 the registry block in index.ts uses
// `import "pi-steering"` which resolves through the workspace alias.
const PI_STEERING_INDEX_PATH = path.resolve(
	HERE,
	"../../pi-steering/src/index.ts",
);

const COMPILER_OPTIONS: ts.CompilerOptions = {
	target: ts.ScriptTarget.ES2022,
	module: ts.ModuleKind.ES2022,
	moduleResolution: ts.ModuleResolutionKind.Bundler,
	allowImportingTsExtensions: true,
	skipLibCheck: true,
	strict: true,
	exactOptionalPropertyTypes: true,
	noEmit: true,
	types: [],
};

function withScratch(suffix: string, fn: (scratchDir: string) => void): void {
	const scratchDir = path.join(
		os.tmpdir(),
		`pi-steering-flags-registry-${suffix}-${process.pid}-${Date.now()}`,
	);
	try {
		fn(scratchDir);
	} finally {
		rmSync(scratchDir, { recursive: true, force: true });
	}
}

function compile(scratchDir: string, source: string): readonly ts.Diagnostic[] {
	mkdirSync(scratchDir, { recursive: true });
	const scratchFile = path.join(scratchDir, "probe.ts");
	writeFileSync(scratchFile, source);
	const program = ts.createProgram([scratchFile], COMPILER_OPTIONS);
	return [
		...program.getSemanticDiagnostics(),
		...program.getSyntacticDiagnostics(),
	];
}

const IMPORT_HEADER = [
	`import "${FLAGS_INDEX_PATH.replace(/\\/g, "\\\\")}";`,
	`import { defineConfig, type Rule } from "${PI_STEERING_INDEX_PATH.replace(/\\/g, "\\\\")}";`,
	"",
].join("\n");

const RULE_PROLOGUE = [
	'\tname: "x",',
	'\ttool: "bash",',
	'\tfield: "command",',
	'\tpattern: "^x",',
	'\treason: "x",',
].join("\n");

describe("pi-steering-flags PiSteeringPredicates registry", () => {
	it("requiresFlag accepts the bare-string shorthand inside `when:`", () => {
		withScratch("bare-string", (scratchDir) => {
			const source =
				IMPORT_HEADER
				+ "const r = {\n"
				+ RULE_PROLOGUE
				+ '\n\twhen: { requiresFlag: "--profile" },\n'
				+ "} as const satisfies Rule;\n"
				+ "export default defineConfig({ rules: [r] });\n";
			const diagnostics = compile(scratchDir, source);
			assert.deepEqual(
				diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
				[],
				"requiresFlag bare-string shorthand should typecheck",
			);
		});
	});

	it("requiresFlag accepts the spread form (flag + env) inside `when:`", () => {
		withScratch("spread", (scratchDir) => {
			const source =
				IMPORT_HEADER
				+ "const r = {\n"
				+ RULE_PROLOGUE
				+ '\n\twhen: { requiresFlag: { flag: "--profile", env: "AWS_PROFILE" } },\n'
				+ "} as const satisfies Rule;\n"
				+ "export default defineConfig({ rules: [r] });\n";
			const diagnostics = compile(scratchDir, source);
			assert.deepEqual(
				diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
				[],
				"requiresFlag spread form should typecheck",
			);
		});
	});

	it("allowlistedFlagsOnly accepts the spread form inside `when:`", () => {
		withScratch("allow-spread", (scratchDir) => {
			const source =
				IMPORT_HEADER
				+ "const r = {\n"
				+ RULE_PROLOGUE
				+ '\n\twhen: { allowlistedFlagsOnly: { allow: ["--all", "--description"] } },\n'
				+ "} as const satisfies Rule;\n"
				+ "export default defineConfig({ rules: [r] });\n";
			const diagnostics = compile(scratchDir, source);
			assert.deepEqual(
				diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
				[],
				"allowlistedFlagsOnly spread form should typecheck",
			);
		});
	});

	it("rejects unknown predicate names \u2014 registry is the source of truth", () => {
		withScratch("unknown-key", (scratchDir) => {
			const source =
				IMPORT_HEADER
				+ "const r = {\n"
				+ RULE_PROLOGUE
				+ '\n\twhen: { thisIsNotARegisteredPredicate: "x" },\n'
				+ "} as const satisfies Rule;\n"
				+ "export default defineConfig({ rules: [r] });\n";
			const diagnostics = compile(scratchDir, source);
			// Pin to TS2353 ("Object literal may only specify known
			// properties") rather than `length !== 0` so probe-source
			// drift can't silently mask the rejection \u2014 a different
			// error code would mean the fence is firing for the wrong
			// reason and needs investigation.
			const tsErrors = diagnostics.filter((d) => d.code === 2353);
			assert.notEqual(
				tsErrors.length,
				0,
				"unknown predicate key should fail to typecheck with TS2353",
			);
		});
	});
});
