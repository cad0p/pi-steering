// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Factory-time load + cwd-mismatch integration tests.
 *
 * Direct unit-level tests for `buildSessionRuntime` live in
 * `internal/session-runtime.test.ts`; the bridge-glue tests
 * (lifecycle wiring, default-rules, agent_loop threading) live in
 * `index.test.ts`. This file covers the integration scenarios
 * where the bridge factory's eager-load path through
 * `buildSessionRuntime` exercises the strict-mode throw rule
 * end-to-end:
 *
 *   - tracker-name-collision error throws even with
 *     `failOnWarnings: false`,
 *   - per-layer import failure escalates,
 *   - predicate / observer / rule plugin-merger collisions
 *     escalate (proves merger warnings are now plumbed),
 *   - `failOnWarnings: false` falls through to `console.warn` for
 *     warning-class only,
 *   - `disabledPlugins` resolves a would-be plugin-name-collision
 *     before the collision check runs,
 *   - `failOnWarnings` undefined coerces to true (default),
 *   - cwd-mismatch fires the `session_start` console.warn while
 *     leaving the evaluator + dispatcher non-null,
 *   - aggregated render snapshot pins the multi-line format.
 *
 * The bridge factory is async; tests `chdir` into a fresh scratch
 * `$HOME` so the loader walk-up reads the per-test config.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type {
	ExtensionAPI,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import register from "./index.ts";
import { makeCtx, useIsolatedHome } from "./__test-helpers__.ts";

/* -------------------------------------------------------------------------- */
/* Mock ExtensionAPI                                                          */
/* -------------------------------------------------------------------------- */

type EventName =
	| "agent_start"
	| "session_start"
	| "tool_call"
	| "tool_result";

interface MockPi {
	api: unknown;
	handlers: Partial<
		Record<EventName, (event: unknown, ctx: unknown) => unknown>
	>;
}

function makeMockPi(): MockPi {
	const handlers: MockPi["handlers"] = {};
	const api = {
		on(event: EventName, handler: (e: unknown, ctx: unknown) => unknown) {
			handlers[event] = handler;
		},
		appendEntry() {},
		async exec() {
			return { stdout: "", stderr: "", code: 0, killed: false };
		},
	};
	return { api, handlers };
}

function writeConfig(dir: string, body: string): void {
	mkdirSync(join(dir, ".pi"), { recursive: true });
	writeFileSync(join(dir, ".pi", "steering.ts"), body, "utf8");
}

/* -------------------------------------------------------------------------- */
/* Scratch home + chdir fixture                                               */
/* -------------------------------------------------------------------------- */

let tmpHome: string;
let priorCwd: string;
function useScratchHome(): void {
	useIsolatedHome("pi-steering-factory-time-", (t) => {
		tmpHome = t;
	});
	beforeEach(() => {
		priorCwd = process.cwd();
		process.chdir(tmpHome);
	});
	afterEach(() => {
		process.chdir(priorCwd);
	});
}

/* -------------------------------------------------------------------------- */
/* console.warn capture                                                       */
/* -------------------------------------------------------------------------- */

let capturedWarns: string[];
let priorWarn: typeof console.warn;
function captureWarns(): void {
	beforeEach(() => {
		capturedWarns = [];
		priorWarn = console.warn;
		console.warn = (msg: unknown) => {
			capturedWarns.push(String(msg));
		};
	});
	afterEach(() => {
		console.warn = priorWarn;
	});
}

/* -------------------------------------------------------------------------- */
/* Cases 1-9: factory throws on each diagnostic kind                          */
/* -------------------------------------------------------------------------- */

describe("register(): factory throws on diagnostics", () => {
	useScratchHome();
	captureWarns();

	it("throws on tracker-name-collision (error-class, failOnWarnings default)", async () => {
		writeConfig(
			tmpHome,
			`const t = { initial: "?", unknown: "unknown", modifiers: {}, subshellSemantics: "isolated" };
			export default {
				disableDefaults: true,
				plugins: [
					{ name: "pa", trackers: { branch: t } },
					{ name: "pb", trackers: { branch: t } },
				],
			};`,
		);
		const mock = makeMockPi();
		await assert.rejects(
			() => register(mock.api as ExtensionAPI),
			(err: Error) => {
				assert.match(err.message, /\[error\]/);
				assert.match(err.message, /tracker name collision/);
				assert.match(err.message, /"branch"/);
				return true;
			},
		);
	});

	it("throws on reserved-tracker-name (error-class)", async () => {
		writeConfig(
			tmpHome,
			`const t = { initial: "?", unknown: "unknown", modifiers: {}, subshellSemantics: "isolated" };
			export default {
				disableDefaults: true,
				plugins: [
					{ name: "pa", trackers: { events: t } },
				],
			};`,
		);
		const mock = makeMockPi();
		await assert.rejects(
			() => register(mock.api as ExtensionAPI),
			(err: Error) => {
				assert.match(err.message, /\[error\]/);
				assert.match(err.message, /tracker name "events" is reserved/);
				return true;
			},
		);
	});

	it("throws on reserved-predicate-key (error-class)", async () => {
		writeConfig(
			tmpHome,
			`export default {
				disableDefaults: true,
				plugins: [
					{
						name: "pa",
						predicates: {
							onUnknown: () => () => true,
						},
					},
				],
			};`,
		);
		const mock = makeMockPi();
		await assert.rejects(
			() => register(mock.api as ExtensionAPI),
			(err: Error) => {
				assert.match(err.message, /\[error\]/);
				assert.match(
					err.message,
					/reserved predicate key "onUnknown"/,
				);
				return true;
			},
		);
	});

	it("throws on tracker-name-collision EVEN WITH failOnWarnings: false", async () => {
		// Errors override the opt-out; the engine cannot operate
		// safely with two plugins claiming the same state dimension.
		writeConfig(
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
		const mock = makeMockPi();
		await assert.rejects(
			() => register(mock.api as ExtensionAPI),
			(err: Error) => {
				assert.match(err.message, /\[error\]/);
				assert.match(err.message, /tracker name collision/);
				return true;
			},
		);
	});

	it("throws on plugin-name-collision (warning-class, failOnWarnings default)", async () => {
		// Two layers ship the same plugin name. The collision is
		// warning-class but escalates under the default
		// `failOnWarnings: true`.
		mkdirSync(join(tmpHome, "inner"), { recursive: true });
		writeConfig(
			tmpHome,
			`export default {
				disableDefaults: true,
				plugins: [{ name: "shared" }],
			};`,
		);
		writeConfig(
			join(tmpHome, "inner"),
			`export default {
				plugins: [{ name: "shared" }],
			};`,
		);
		process.chdir(join(tmpHome, "inner"));
		const mock = makeMockPi();
		await assert.rejects(
			() => register(mock.api as ExtensionAPI),
			(err: Error) => {
				assert.match(err.message, /\[warning\]/);
				assert.match(err.message, /plugin "shared"/);
				return true;
			},
		);
	});

	it("throws on per-layer import failure", async () => {
		mkdirSync(join(tmpHome, ".pi"), { recursive: true });
		writeFileSync(
			join(tmpHome, ".pi", "steering.ts"),
			"export default this is not valid typescript;\n",
			"utf8",
		);
		const mock = makeMockPi();
		await assert.rejects(
			() => register(mock.api as ExtensionAPI),
			(err: Error) => {
				assert.match(err.message, /\[warning\]/);
				assert.match(err.message, /failed to (import|load)/i);
				return true;
			},
		);
	});

	it("throws on predicate-collision (proves resolvePlugins warnings are plumbed)", async () => {
		writeConfig(
			tmpHome,
			`export default {
				disableDefaults: true,
				plugins: [
					{
						name: "pa",
						predicates: { sharedKey: () => () => true },
					},
					{
						name: "pb",
						predicates: { sharedKey: () => () => true },
					},
				],
			};`,
		);
		const mock = makeMockPi();
		await assert.rejects(
			() => register(mock.api as ExtensionAPI),
			(err: Error) => {
				assert.match(err.message, /\[warning\]/);
				assert.match(err.message, /predicate.*sharedKey/i);
				return true;
			},
		);
	});

	it("throws on observer-collision", async () => {
		writeConfig(
			tmpHome,
			`export default {
				disableDefaults: true,
				plugins: [
					{
						name: "pa",
						observers: [{ name: "obs-x", onResult: () => {} }],
					},
					{
						name: "pb",
						observers: [{ name: "obs-x", onResult: () => {} }],
					},
				],
			};`,
		);
		const mock = makeMockPi();
		await assert.rejects(
			() => register(mock.api as ExtensionAPI),
			(err: Error) => {
				assert.match(err.message, /\[warning\]/);
				assert.match(err.message, /observer.*obs-x/i);
				return true;
			},
		);
	});

	it("throws on rule-collision", async () => {
		writeConfig(
			tmpHome,
			`export default {
				disableDefaults: true,
				plugins: [
					{
						name: "pa",
						rules: [{
							name: "dup",
							tool: "bash",
							field: "command",
							pattern: /^never-a$/,
							reason: "from pa",
						}],
					},
					{
						name: "pb",
						rules: [{
							name: "dup",
							tool: "bash",
							field: "command",
							pattern: /^never-b$/,
							reason: "from pb",
						}],
					},
				],
			};`,
		);
		const mock = makeMockPi();
		await assert.rejects(
			() => register(mock.api as ExtensionAPI),
			(err: Error) => {
				assert.match(err.message, /\[warning\]/);
				assert.match(err.message, /rule.*dup/i);
				return true;
			},
		);
	});
});

/* -------------------------------------------------------------------------- */
/* Cases 10-12: factory does NOT throw                                        */
/* -------------------------------------------------------------------------- */

describe("register(): factory does NOT throw", () => {
	useScratchHome();
	captureWarns();

	it("warning-class with failOnWarnings: false falls through to console.warn", async () => {
		writeConfig(
			tmpHome,
			`export default {
				disableDefaults: true,
				failOnWarnings: false,
				plugins: [
					{
						name: "pa",
						observers: [{ name: "obs-x", onResult: () => {} }],
					},
					{
						name: "pb",
						observers: [{ name: "obs-x", onResult: () => {} }],
					},
				],
			};`,
		);
		const mock = makeMockPi();
		// Should resolve without throwing.
		await register(mock.api as ExtensionAPI);
		// At least one captured warn matches the legacy single-line
		// shape (no `[warning]` severity tag, no `<count> config
		// issue` header — that's the aggregated-throw format only).
		const observerWarn = capturedWarns.find((m) =>
			/\[pi-steering\].*observer.*obs-x/i.test(m),
		);
		assert.ok(
			observerWarn !== undefined,
			`expected observer-collision warn on console.warn; got: ${JSON.stringify(capturedWarns)}`,
		);
		assert.doesNotMatch(observerWarn, /\[warning\]/);
		assert.doesNotMatch(observerWarn, /config issue/);
	});

	it("disabledPlugins resolves plugin-name-collision before the check runs", async () => {
		// The outer layer's `disabledPlugins: ["shared"]` removes
		// the would-be collision before cross-layer detection,
		// matching the disable-then-detect ordering. No throw, no
		// warn.
		mkdirSync(join(tmpHome, "inner"), { recursive: true });
		writeConfig(
			tmpHome,
			`export default {
				disableDefaults: true,
				disabledPlugins: ["shared"],
				plugins: [{ name: "shared" }],
			};`,
		);
		writeConfig(
			join(tmpHome, "inner"),
			`export default {
				plugins: [{ name: "shared" }],
			};`,
		);
		process.chdir(join(tmpHome, "inner"));
		const mock = makeMockPi();
		await register(mock.api as ExtensionAPI);
		const collisionWarn = capturedWarns.find((m) =>
			/plugin "shared"/i.test(m),
		);
		assert.equal(
			collisionWarn,
			undefined,
			`expected NO plugin-collision warn; got: ${JSON.stringify(capturedWarns)}`,
		);
	});

	it("failOnWarnings undefined coerces to true (default-on)", async () => {
		// No `failOnWarnings` field at all; the runtime treats the
		// absence as `true` and escalates the warning.
		writeConfig(
			tmpHome,
			`export default {
				disableDefaults: true,
				plugins: [
					{
						name: "pa",
						observers: [{ name: "obs-x", onResult: () => {} }],
					},
					{
						name: "pb",
						observers: [{ name: "obs-x", onResult: () => {} }],
					},
				],
			};`,
		);
		const mock = makeMockPi();
		await assert.rejects(
			() => register(mock.api as ExtensionAPI),
			(err: Error) => {
				assert.match(err.message, /\[warning\]/);
				return true;
			},
		);
	});
});

/* -------------------------------------------------------------------------- */
/* Case 13: cwd-mismatch session_start console.warn                           */
/* -------------------------------------------------------------------------- */

describe("register(): cwd-mismatch session_start warn", () => {
	useScratchHome();
	captureWarns();

	it("emits console.warn when ctx.cwd !== launchCwd; engine continues evaluating", async () => {
		// Clean config so register resolves; then fire session_start
		// with a cwd different from the captured launchCwd.
		writeConfig(tmpHome, "export default {};");
		const mock = makeMockPi();
		await register(mock.api as ExtensionAPI);

		// Confirm handlers are registered (evaluator + dispatcher
		// non-null in the closure means the tool_call handler can
		// invoke them).
		assert.ok(mock.handlers.session_start);
		assert.ok(mock.handlers.tool_call);
		assert.ok(mock.handlers.tool_result);

		// Fire session_start with a foreign cwd.
		const foreignCwd = "/tmp/some/other/project";
		await mock.handlers.session_start(
			{ type: "session_start", reason: "startup" },
			makeCtx(foreignCwd),
		);

		const cwdMismatchWarn = capturedWarns.find((m) =>
			/\[pi-steering\] session cwd \(/.test(m),
		);
		assert.ok(
			cwdMismatchWarn !== undefined,
			`expected cwd-mismatch warn; got: ${JSON.stringify(capturedWarns)}`,
		);
		assert.match(cwdMismatchWarn, /differs from launch cwd/);
		assert.match(cwdMismatchWarn, new RegExp(foreignCwd));
		assert.match(cwdMismatchWarn, new RegExp(tmpHome));

		// Engine continues evaluating: a tool_call handler returns
		// without throwing — the evaluator was NOT reset by the
		// cwd-mismatch warn.
		const toolCallEvent: ToolCallEvent = {
			type: "tool_call",
			toolName: "bash",
			toolCallId: "call-1",
			input: { command: "echo hi" },
		};
		const result = await mock.handlers.tool_call(
			toolCallEvent,
			makeCtx(foreignCwd),
		);
		// No rule fires for `echo hi`; result is undefined. The
		// crucial assertion is that the call did not throw and the
		// evaluator was reachable.
		assert.equal(result, undefined);
	});

	it("does NOT emit cwd-mismatch warn when ctx.cwd === launchCwd", async () => {
		writeConfig(tmpHome, "export default {};");
		const mock = makeMockPi();
		await register(mock.api as ExtensionAPI);

		await mock.handlers.session_start!(
			{ type: "session_start", reason: "startup" },
			makeCtx(tmpHome),
		);

		const cwdMismatchWarn = capturedWarns.find((m) =>
			/\[pi-steering\] session cwd \(/.test(m),
		);
		assert.equal(
			cwdMismatchWarn,
			undefined,
			`expected NO cwd-mismatch warn for matching cwds; got: ${JSON.stringify(capturedWarns)}`,
		);
	});
});

/* -------------------------------------------------------------------------- */
/* Case 14: aggregated render snapshot — 1 error + 2 warnings                 */
/* -------------------------------------------------------------------------- */

describe("register(): aggregated render snapshot", () => {
	useScratchHome();
	captureWarns();

	it("renders 1 error + 2 warnings with errors-first ordering and the multi-line shape", async () => {
		// Layout matches the 05-aggregated-render-mixed e2e
		// fixture: plugin-a registers reserved tracker `events`
		// (error), and both plugins ship `obs-x` (warning) + `dup`
		// (warning).
		writeConfig(
			tmpHome,
			`const t = { initial: "?", unknown: "unknown", modifiers: {}, subshellSemantics: "isolated" };
			export default {
				disableDefaults: true,
				plugins: [
					{
						name: "plugin-a",
						trackers: { events: t },
						observers: [{ name: "obs-x", onResult: () => {} }],
						rules: [{
							name: "dup",
							tool: "bash",
							field: "command",
							pattern: /^never-a$/,
							reason: "from plugin-a",
						}],
					},
					{
						name: "plugin-b",
						observers: [{ name: "obs-x", onResult: () => {} }],
						rules: [{
							name: "dup",
							tool: "bash",
							field: "command",
							pattern: /^never-b$/,
							reason: "from plugin-b",
						}],
					},
				],
			};`,
		);
		const mock = makeMockPi();
		const err = await register(mock.api as ExtensionAPI).then(
			() => null,
			(e: Error) => e,
		);
		assert.ok(err, "expected register to throw");

		// Header: plural form ("issues"), no leading prefix (pi adds
		// "Failed to load extension: " automatically downstream).
		assert.match(err.message, /^3 config issues:\n/);

		// Bullet shape: two-space indent, dash, space, severity in
		// brackets, no padding for column alignment.
		const lines = err.message.split("\n");
		assert.equal(lines.length, 4, `expected header + 3 bullets; got: ${err.message}`);
		assert.match(lines[1]!, /^  - \[error\] /);
		assert.match(lines[2]!, /^  - \[warning\] /);
		assert.match(lines[3]!, /^  - \[warning\] /);

		// Errors-first ordering: the [error] bullet is line 1.
		assert.match(lines[1]!, /tracker name "events" is reserved/);

		// Warnings preserve declaration order from `resolvePlugins`
		// (observer pass before rule pass).
		assert.match(lines[2]!, /observer.*obs-x/i);
		assert.match(lines[3]!, /rule.*dup/i);

		// No padding (severity tag flush against the next token).
		assert.doesNotMatch(err.message, /\[error\] {2,}/);
		assert.doesNotMatch(err.message, /\[warning\] {2,}/);

		// No footer (the message ends at the last bullet).
		assert.equal(lines[lines.length - 1]!.startsWith("  - "), true);
	});
});
