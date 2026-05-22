// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Direct coverage for the strict-mode contract owned by
 * `buildSessionRuntime`. Tests:
 *
 *   - error-class diagnostics always escalate to a thrown error;
 *   - warning-class diagnostics escalate when `failOnWarnings !==
 *     false`;
 *   - with `failOnWarnings: false`, warnings fall back to
 *     `console.warn` and the runtime returns normally;
 *   - the aggregated error message follows the rule-based spec
 *     (header + bullets, errors first, optional path prefix).
 *
 * Uses a tmp `$HOME` so the walk-up loader's `$HOME` ceiling is
 * scoped to the test directory.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	buildSessionRuntime,
	formatAggregatedDiagnostics,
	formatSingleLineDiagnostic,
} from "./session-runtime.ts";
import type { SteeringDiagnostic } from "../schema.ts";

/** Minimal evaluator host; the strict-mode tests don't drive evaluation. */
const noopHost = {
	exec: async () => ({
		stdout: "",
		stderr: "",
		code: 0,
		killed: false,
	}),
	appendEntry: () => {},
};

function writeSteeringConfig(dir: string, body: string): void {
	mkdirSync(join(dir, ".pi"), { recursive: true });
	writeFileSync(join(dir, ".pi", "steering.ts"), body, "utf8");
}

describe("buildSessionRuntime: strict-mode contract", () => {
	let tmpHome: string;
	let priorHome: string | undefined;
	let warnings: string[];
	let origWarn: typeof console.warn;
	let origInfo: typeof console.info;

	beforeEach(() => {
		tmpHome = mkdtempSync(join(tmpdir(), "pi-steering-runtime-"));
		priorHome = process.env["HOME"];
		process.env["HOME"] = tmpHome;
		warnings = [];
		origWarn = console.warn;
		origInfo = console.info;
		console.warn = (msg: unknown) => {
			warnings.push(String(msg));
		};
		// Silence the "observer dropped" info-level chatter; only the
		// strict-mode warn channel is under assertion here.
		console.info = () => {};
	});

	afterEach(() => {
		console.warn = origWarn;
		console.info = origInfo;
		if (priorHome === undefined) delete process.env["HOME"];
		else process.env["HOME"] = priorHome;
		rmSync(tmpHome, { recursive: true, force: true });
	});

	it("returns evaluator + dispatcher when there are no diagnostics", async () => {
		// No config layers, no plugins, no diagnostics. Defaults inject
		// rules + plugins; both are clean.
		const result = await buildSessionRuntime(tmpHome, noopHost);
		assert.ok(result.evaluator);
		assert.ok(result.dispatcher);
		assert.deepEqual(warnings, []);
	});

	it("throws on a warning-class diagnostic by default (failOnWarnings undefined)", async () => {
		// A plugin-shipped predicate collision via direct buildConfig
		// would be hard to stage from a written config; instead, write
		// a config layer that declares two within-layer duplicate rules
		// (rule-name-collision, type:'warning').
		writeSteeringConfig(
			tmpHome,
			`export default {
				disableDefaults: true,
				rules: [
					{ name: "dup", tool: "bash", field: "command", pattern: /^A/, reason: "first" },
					{ name: "dup", tool: "bash", field: "command", pattern: /^B/, reason: "second" },
				],
			};`,
		);
		await assert.rejects(
			() => buildSessionRuntime(tmpHome, noopHost),
			(err: Error) => {
				assert.match(err.message, /^1 config issue:/);
				assert.match(err.message, /\[warning\]/);
				assert.match(err.message, /duplicate rule "dup"/);
				return true;
			},
		);
	});

	it("does NOT throw on a warning-class diagnostic when failOnWarnings: false; emits to console.warn", async () => {
		writeSteeringConfig(
			tmpHome,
			`export default {
				disableDefaults: true,
				failOnWarnings: false,
				rules: [
					{ name: "dup", tool: "bash", field: "command", pattern: /^A/, reason: "first" },
					{ name: "dup", tool: "bash", field: "command", pattern: /^B/, reason: "second" },
				],
			};`,
		);
		const result = await buildSessionRuntime(tmpHome, noopHost);
		assert.ok(result.evaluator);
		assert.ok(result.dispatcher);
		assert.ok(
			warnings.some(
				(w) =>
					w.startsWith("[pi-steering] ") &&
					w.includes('duplicate rule "dup"'),
			),
			`expected a legacy console.warn for the rule collision; got: ${JSON.stringify(warnings)}`,
		);
	});

	it("throws on an error-class diagnostic regardless of failOnWarnings", async () => {
		// Two plugins claim the tracker `branch`. The loader's
		// buildConfig pushes an error-class tracker-name-collision
		// diagnostic; the strict-mode opt-out applies only to warnings,
		// not errors. Setting `failOnWarnings: false` does NOT change
		// the throw — errors always escalate.
		writeSteeringConfig(
			tmpHome,
			`const t = { initial: "?", unknown: "unknown", modifiers: {}, subshellSemantics: "isolated" };
			export default {
				disableDefaults: true,
				failOnWarnings: false,
				plugins: [
					{ name: "pa", trackers: { branch: t } },
					{ name: "pb", trackers: { branch: t } },
				],
			};`,
		);
		await assert.rejects(
			() => buildSessionRuntime(tmpHome, noopHost),
			(err: Error) => {
				assert.match(err.message, /\[error\]/);
				assert.match(err.message, /tracker name collision/);
				return true;
			},
		);
	});

	it("throws on an invalid-name diagnostic for a malformed plugin name", async () => {
		// `validateName` flows through the diagnostic stream rather than
		// throwing a plain Error, so the strict-mode aggregation surfaces
		// the malformed name in the same `N config issue:` shape as other
		// error-class diagnostics. The malformed plugin must use a name
		// shape the loader's plugin-name validation accepts — here we
		// trigger the merger via a malformed RULE name shipped by an
		// otherwise-valid plugin.
		writeSteeringConfig(
			tmpHome,
			`export default {
				disableDefaults: true,
				plugins: [
					{
						name: "forge-plugin",
						rules: [
							{
								name: "bad name",
								tool: "bash",
								field: "command",
								pattern: /^never$/,
								reason: "r",
							},
						],
					},
				],
			};`,
		);
		await assert.rejects(
			() => buildSessionRuntime(tmpHome, noopHost),
			(err: Error) => {
				assert.match(err.message, /^1 config issue:/);
				assert.match(err.message, /\[error\]/);
				assert.match(err.message, /^.*rule name "bad name".*disallowed/m);
				return true;
			},
		);
	});

	it("aggregates multiple diagnostics with errors first", async () => {
		// One error (tracker collision) + one warning (rule
		// collision). Aggregated message lists the error before the
		// warning.
		writeSteeringConfig(
			tmpHome,
			`const t = { initial: "?", unknown: "unknown", modifiers: {}, subshellSemantics: "isolated" };
			export default {
				disableDefaults: true,
				plugins: [
					{ name: "pa", trackers: { branch: t } },
					{ name: "pb", trackers: { branch: t } },
				],
				rules: [
					{ name: "dup", tool: "bash", field: "command", pattern: /^A/, reason: "first" },
					{ name: "dup", tool: "bash", field: "command", pattern: /^B/, reason: "second" },
				],
			};`,
		);
		await assert.rejects(
			() => buildSessionRuntime(tmpHome, noopHost),
			(err: Error) => {
				const message = err.message;
				assert.match(message, /^2 config issues:/);
				const errorIdx = message.indexOf("[error]");
				const warningIdx = message.indexOf("[warning]");
				assert.ok(errorIdx > -1, "expected an [error] line");
				assert.ok(warningIdx > -1, "expected a [warning] line");
				assert.ok(
					errorIdx < warningIdx,
					"errors should be ordered before warnings",
				);
				return true;
			},
		);
	});
});

describe("formatAggregatedDiagnostics: rule-based spec", () => {
	it("renders a single warning with no path prefix", () => {
		const diagnostics: SteeringDiagnostic[] = [
			{
				type: "warning",
				kind: "plugin-name-collision",
				message: 'duplicate plugin "git"; keeping first-registered entry.',
			},
		];
		const out = formatAggregatedDiagnostics(diagnostics);
		assert.equal(
			out,
			"1 config issue:\n" +
				'  - [warning] duplicate plugin "git"; keeping first-registered entry.',
		);
	});

	it("renders a single error with the singular header noun", () => {
		const diagnostics: SteeringDiagnostic[] = [
			{
				type: "error",
				kind: "tracker-name-collision",
				message: 'tracker name collision: plugins "a" and "b"',
			},
		];
		const out = formatAggregatedDiagnostics(diagnostics);
		assert.match(out, /^1 config issue:/);
		assert.match(out, /\[error\] tracker name collision/);
	});

	it("renders multiple diagnostics with errors-first ordering and the plural header noun", () => {
		const diagnostics: SteeringDiagnostic[] = [
			{
				type: "warning",
				kind: "layer-import-failed",
				path: "/u/.pi/steering.ts",
				message: "failed to import: SyntaxError",
			},
			{
				type: "error",
				kind: "tracker-name-collision",
				message: 'tracker name collision: plugins "a" and "b"',
			},
			{
				type: "warning",
				kind: "plugin-name-collision",
				message: 'duplicate plugin "git"',
			},
		];
		const out = formatAggregatedDiagnostics(diagnostics);
		const lines = out.split("\n");
		assert.equal(lines[0], "3 config issues:");
		// Error-class lines appear before warning-class.
		assert.match(lines[1] ?? "", /\[error\] tracker name collision/);
		assert.match(lines[2] ?? "", /\[warning\] /);
		assert.match(lines[3] ?? "", /\[warning\] /);
	});

	it("includes a path prefix when SteeringDiagnostic.path is set", () => {
		const diagnostics: SteeringDiagnostic[] = [
			{
				type: "warning",
				kind: "layer-stray-file",
				path: "/u/.pi/steering/rules.json",
				message: "ignoring non-.ts file under .pi/steering/",
			},
		];
		const out = formatAggregatedDiagnostics(diagnostics);
		assert.match(out, /\[warning\] \/u\/\.pi\/steering\/rules\.json:/);
	});
});

describe("formatSingleLineDiagnostic: rule-based spec", () => {
	it("renders a warning with a path prefix and no severity tag", () => {
		const d: SteeringDiagnostic = {
			type: "warning",
			kind: "layer-import-failed",
			path: "/u/.pi/steering.ts",
			message: "failed to import: SyntaxError",
		};
		assert.equal(
			formatSingleLineDiagnostic(d),
			"[pi-steering] /u/.pi/steering.ts: failed to import: SyntaxError",
		);
	});

	it("renders a warning without a path prefix when path is unset", () => {
		const d: SteeringDiagnostic = {
			type: "warning",
			kind: "plugin-name-collision",
			message: 'duplicate plugin "git"; keeping first-registered entry.',
		};
		assert.equal(
			formatSingleLineDiagnostic(d),
			'[pi-steering] duplicate plugin "git"; keeping first-registered entry.',
		);
	});

	it("renders an error with an ERROR: severity prefix and a path prefix", () => {
		const d: SteeringDiagnostic = {
			type: "error",
			kind: "layer-import-failed",
			path: "/u/.pi/steering.ts",
			message: "failed to import: SyntaxError",
		};
		assert.equal(
			formatSingleLineDiagnostic(d),
			"[pi-steering] ERROR: /u/.pi/steering.ts: failed to import: SyntaxError",
		);
	});

	it("renders an error with an ERROR: severity prefix and no path prefix", () => {
		const d: SteeringDiagnostic = {
			type: "error",
			kind: "tracker-name-collision",
			message: 'tracker name collision: plugins "a" and "b"',
		};
		assert.equal(
			formatSingleLineDiagnostic(d),
			'[pi-steering] ERROR: tracker name collision: plugins "a" and "b"',
		);
	});
});
