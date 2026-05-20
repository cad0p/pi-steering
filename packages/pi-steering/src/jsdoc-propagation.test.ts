// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Regression fence: verifies that JSDoc declared on
 * `PiSteeringPredicates.<key>` (in a plugin's `declare global { ... }`
 * block) propagates onto the synthesized fields of
 * {@link TopLevelWhenClause} and {@link TopLevelWhenClauseNoRecurse},
 * surfacing on hover for plugin-predicate authors.
 *
 * Background: TypeScript's checker
 * (`resolveMappedTypeMembers` in `src/compiler/checker.ts`) only
 * links property declarations through a mapped type when the
 * constraint AST is literally `keyof T` and the optional `as` clause
 * is a Filter (returns `K | never`, assignable to `K`). The
 * pre-computed alias `[K in PluginPredicateKey]` produces the same
 * keyset but uses a `TypeReference` AST in place of `KeyOfKeyword` —
 * `isMappedTypeWithKeyofConstraintDeclaration` returns false, the
 * `modifiersProp.declarations` link is dropped, and JSDoc on the
 * underlying interface member is no longer reachable from the
 * synthesized symbol.
 *
 * This test resolves the contextual property symbol the same way
 * TypeScript's quick-info codepath does for an object-literal
 * property assignment: it asks the checker for the contextual type
 * of the enclosing object literal and looks up the property by name.
 * The returned symbol's `getDocumentationComment` is the same data
 * tsserver surfaces in `quickInfo` tooltips. If a future refactor
 * reintroduces the alias-key mapping shape, the property symbol's
 * declarations link is dropped, the documentation comment becomes
 * empty, and this test fails immediately.
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as ts from "typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_GIT_PATH = path.resolve(HERE, "plugins/git/index.ts");
const SCHEMA_PATH = path.resolve(HERE, "schema.ts");

interface ScratchProgram {
	program: ts.Program;
	checker: ts.TypeChecker;
	sourceFile: ts.SourceFile;
}

function buildScratchProgram(scratchDir: string, source: string): ScratchProgram {
	mkdirSync(scratchDir, { recursive: true });
	const scratchFile = path.join(scratchDir, "probe.ts");
	writeFileSync(scratchFile, source);

	const program = ts.createProgram([scratchFile], {
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ES2022,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		allowImportingTsExtensions: true,
		skipLibCheck: true,
		strict: true,
		exactOptionalPropertyTypes: true,
		noEmit: true,
		types: [],
	});

	const sourceFile = program.getSourceFile(scratchFile);
	assert(sourceFile, "expected scratch source file to load");
	return { program, checker: program.getTypeChecker(), sourceFile };
}

/**
 * Resolve the `PropertyAssignment` for a key inside the closest
 * enclosing object literal that satisfies `isOuterObject`. Useful
 * for distinguishing `when.isClean` (outer object literal is `when:
 * { ... }`) from `when.not.isClean` (outer is `not: { ... }`).
 */
function findPropertyAssignment(
	sourceFile: ts.SourceFile,
	name: string,
	predicate: (obj: ts.ObjectLiteralExpression) => boolean,
): ts.PropertyAssignment | undefined {
	let found: ts.PropertyAssignment | undefined;
	function visit(node: ts.Node) {
		if (
			!found
			&& ts.isPropertyAssignment(node)
			&& ts.isIdentifier(node.name)
			&& node.name.text === name
			&& ts.isObjectLiteralExpression(node.parent)
			&& predicate(node.parent)
		) {
			found = node;
		}
		node.forEachChild(visit);
	}
	visit(sourceFile);
	return found;
}

function isWhenObjectLiteral(obj: ts.ObjectLiteralExpression): boolean {
	const p = obj.parent;
	return (
		ts.isPropertyAssignment(p)
		&& ts.isIdentifier(p.name)
		&& p.name.text === "when"
	);
}

function isNotObjectLiteral(obj: ts.ObjectLiteralExpression): boolean {
	const p = obj.parent;
	return (
		ts.isPropertyAssignment(p)
		&& ts.isIdentifier(p.name)
		&& p.name.text === "not"
	);
}

/**
 * Resolve hover-time JSDoc for a property assignment by walking the
 * checker's contextual-type lookup — the same path tsserver uses for
 * `quickInfo` tooltips on object-literal keys. Returns the
 * documentation text and the file path of the underlying property
 * declaration, so the test can assert both that JSDoc surfaces and
 * that it traces back to the augmenting plugin's interface
 * declaration.
 */
function resolveContextualJsDoc(
	checker: ts.TypeChecker,
	prop: ts.PropertyAssignment,
): { jsdoc: string; declarationFiles: string[] } {
	const obj = prop.parent;
	assert(
		ts.isObjectLiteralExpression(obj),
		"expected enclosing object literal",
	);
	const contextual = checker.getContextualType(obj);
	assert(
		contextual,
		"expected contextual type on the enclosing object literal",
	);
	const propName = (prop.name as ts.Identifier).text;
	const propSymbol = contextual.getProperty(propName);
	assert(
		propSymbol,
		`expected contextual property symbol for '${propName}' on type ${checker.typeToString(contextual)}`,
	);
	const jsdoc = ts.displayPartsToString(
		propSymbol.getDocumentationComment(checker),
	);
	const declarationFiles = (propSymbol.declarations ?? []).map((d) =>
		d.getSourceFile().fileName,
	);
	return { jsdoc, declarationFiles };
}

describe("JSDoc propagation through TopLevelWhenClause mapped type", () => {
	it("surfaces JSDoc from PiSteeringPredicates.isClean on hover at when.isClean", () => {
		const scratchDir = path.join(
			os.tmpdir(),
			`jsdoc-propagation-outer-${process.pid}`,
		);
		const source = [
			`import "${PLUGIN_GIT_PATH.replace(/\\/g, "\\\\")}";`,
			`import type { Rule } from "${SCHEMA_PATH.replace(/\\/g, "\\\\")}";`,
			"const r: Rule = {",
			'\tname: "x",',
			'\ttool: "bash",',
			'\tfield: "command",',
			'\tpattern: "^x",',
			'\treason: "x",',
			"\twhen: { isClean: false },",
			"};",
			"void r;",
			"",
		].join("\n");

		try {
			const { checker, sourceFile } = buildScratchProgram(
				scratchDir,
				source,
			);

			const prop = findPropertyAssignment(
				sourceFile,
				"isClean",
				isWhenObjectLiteral,
			);
			assert(prop, "expected to find when.isClean property in scratch file");

			const { jsdoc, declarationFiles } = resolveContextualJsDoc(
				checker,
				prop,
			);

			// Pin: source-declared JSDoc text from
			// plugins/git/index.ts's `declare global { interface
			// PiSteeringPredicates { /** ... */ isClean: ... } }`.
			assert(
				jsdoc.includes("when.isClean"),
				`expected JSDoc to include 'when.isClean'; got: ${JSON.stringify(jsdoc)}`,
			);
			assert(
				jsdoc.includes("git status"),
				`expected JSDoc to include 'git status'; got: ${JSON.stringify(jsdoc)}`,
			);

			// Pin: the declaration link traces back to the augmenting
			// plugin module, not the scratch file. If the mapped type
			// loses homomorphism, declarations would be dropped and
			// this assertion would fail (declarationFiles becomes []
			// and the prior JSDoc-text asserts already failed).
			assert(
				declarationFiles.some((f) => f.endsWith("plugins/git/index.ts")),
				`expected declaration to trace to plugins/git/index.ts; got: ${JSON.stringify(declarationFiles)}`,
			);
		} finally {
			rmSync(scratchDir, { recursive: true, force: true });
		}
	});

	it("surfaces the same JSDoc on hover at not.isClean (TopLevelWhenClauseNoRecurse path)", () => {
		const scratchDir = path.join(
			os.tmpdir(),
			`jsdoc-propagation-inner-${process.pid}`,
		);
		const source = [
			`import "${PLUGIN_GIT_PATH.replace(/\\/g, "\\\\")}";`,
			`import type { Rule } from "${SCHEMA_PATH.replace(/\\/g, "\\\\")}";`,
			"const r: Rule = {",
			'\tname: "x",',
			'\ttool: "bash",',
			'\tfield: "command",',
			'\tpattern: "^x",',
			'\treason: "x",',
			"\twhen: { not: { isClean: false } },",
			"};",
			"void r;",
			"",
		].join("\n");

		try {
			const { checker, sourceFile } = buildScratchProgram(
				scratchDir,
				source,
			);

			const prop = findPropertyAssignment(
				sourceFile,
				"isClean",
				isNotObjectLiteral,
			);
			assert(prop, "expected to find not.isClean property in scratch file");

			const { jsdoc, declarationFiles } = resolveContextualJsDoc(
				checker,
				prop,
			);

			assert(
				jsdoc.includes("when.isClean"),
				`expected nested JSDoc to include 'when.isClean'; got: ${JSON.stringify(jsdoc)}`,
			);
			assert(
				jsdoc.includes("git status"),
				`expected nested JSDoc to include 'git status'; got: ${JSON.stringify(jsdoc)}`,
			);
			assert(
				declarationFiles.some((f) => f.endsWith("plugins/git/index.ts")),
				`expected nested declaration to trace to plugins/git/index.ts; got: ${JSON.stringify(declarationFiles)}`,
			);
		} finally {
			rmSync(scratchDir, { recursive: true, force: true });
		}
	});
});
