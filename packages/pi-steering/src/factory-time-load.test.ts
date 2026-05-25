// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Factory-time load + cwd-mismatch integration tests.
 *
 * Direct unit-level tests for `buildSessionRuntime` live in
 * `internal/session-runtime.test.ts`; the bridge-glue tests
 * (lifecycle wiring, default-rules, agent_loop threading) live in
 * `index.test.ts`. This file covers 15 integration scenarios where
 * the bridge factory's eager-load path through `buildSessionRuntime`
 * exercises the strict-mode throw rule end-to-end:
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
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import register from "./index.ts";
import { makeCtx, useScratchHome } from "./__test-helpers__.ts";

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
function useFactoryTimeScratchHome(): void {
	useScratchHome("pi-steering-factory-time-", (t) => {
		tmpHome = t;
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
/* Factory throws on each diagnostic kind                                     */
/* -------------------------------------------------------------------------- */

describe("register(): factory throws on diagnostics", () => {
	useFactoryTimeScratchHome();
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
				// Single-emission lock: integration mirror of the runtime-level
				// short-circuit between `buildConfig` and `resolvePlugins` (see
				// `internal/session-runtime.test.ts`). A regression that
				// reintroduced double-emission would surface here as well.
				const collisionMatches = err.message.match(
					/tracker name collision/g,
				);
				assert.equal(
					collisionMatches?.length,
					1,
					"tracker-name-collision must appear exactly once",
				);
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
				assert.match(err.message, /failed to import/i);
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
				assert.match(err.message, /duplicate predicate "when\.sharedKey"/);
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
				assert.match(err.message, /duplicate observer "obs-x"/);
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
				assert.match(err.message, /duplicate rule "dup"/);
				return true;
			},
		);
	});
});

/* -------------------------------------------------------------------------- */
/* Factory does NOT throw                                                     */
/* -------------------------------------------------------------------------- */

describe("register(): factory does NOT throw", () => {
	useFactoryTimeScratchHome();
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
/* Cwd-mismatch session_start console.warn                                   */
/* -------------------------------------------------------------------------- */

describe("register(): cwd-mismatch session_start warn", () => {
	useFactoryTimeScratchHome();
	captureWarns();

	it("emits console.warn when ctx.cwd !== launchCwd; engine continues evaluating", async () => {
		// Author a USER-DEFINED rule into the launch-cwd config that
		// the foreign cwd could not possibly load: foreignCwd has no
		// `.pi/steering` and the walk-up from `/tmp/some/other/project`
		// terminates at root without reaching tmpHome's HOME. If a
		// future regression transparently re-loaded config from
		// ctx.cwd on session_start, this rule would silently disappear
		// (and DEFAULT_RULES alone could not distinguish the two
		// rule-sets — the foreign cwd would also inject defaults).
		writeConfig(
			tmpHome,
			`export default {
				rules: [
					{
						name: "block-launch-cwd-only-rule",
						tool: "bash",
						field: "command",
						pattern: /^echo LAUNCH_CWD_PROBE$/,
						reason: "launch-cwd-only rule used by the cwd-mismatch test",
					},
				],
			};`,
		);
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

		// Pin the cross-project-resume contract beyond "engine merely
		// continues": the LAUNCH-CWD rule set must still be in force.
		// The user-defined rule above is authored ONLY in tmpHome's
		// `.pi/steering.ts` and could not have been loaded from
		// foreignCwd (no `.pi/steering` at /tmp/some/other, and the
		// walk-up from foreignCwd terminates at root without reaching
		// tmpHome's HOME). If a future regression swapped to
		// ctx.cwd-config on cwd-mismatch, this user rule would silently
		// disappear — DEFAULT_RULES alone cannot distinguish that case
		// because the foreign cwd would also inject defaults.
		const blockedEvent: ToolCallEvent = {
			type: "tool_call",
			toolName: "bash",
			toolCallId: "call-2",
			input: { command: "echo LAUNCH_CWD_PROBE" },
		};
		const blocked = (await mock.handlers.tool_call(
			blockedEvent,
			makeCtx(foreignCwd),
		)) as ToolCallEventResult | undefined;
		assert.equal(
			blocked?.block,
			true,
			"user-defined launch-cwd rule must still fire after the cwd-mismatch warn (proves launch-cwd config — not a re-loaded ctx.cwd config — is in force)",
		);
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
/* Aggregated render snapshot — 1 error + 2 warnings                          */
/* -------------------------------------------------------------------------- */

describe("register(): aggregated render snapshot", () => {
	useFactoryTimeScratchHome();
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
		// Errors-first ordering: line 1 is the [error] bullet. Tighten
		// to enforce that no path prefix slips between the severity
		// tag and the message text — a future change adding a path
		// prefix to `reserved-tracker-name` would surface here.
		assert.match(
			lines[1]!,
			/^  - \[error\] tracker name "events" is reserved/,
		);
		assert.match(lines[2]!, /^  - \[warning\] /);
		assert.match(lines[3]!, /^  - \[warning\] /);

		// Warnings preserve declaration order from `resolvePlugins`
		// (observer pass before rule pass).
		assert.match(lines[2]!, /duplicate observer "obs-x"/);
		assert.match(lines[3]!, /duplicate rule "dup"/);

		// No padding (severity tag flush against the next token).
		assert.doesNotMatch(err.message, /\[error\] {2,}/);
		assert.doesNotMatch(err.message, /\[warning\] {2,}/);

		// No footer (the message ends at the last bullet).
		assert.equal(lines[lines.length - 1]!.startsWith("  - "), true);
	});
});
