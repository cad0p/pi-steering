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
 * `$HOME` so the loader's global layer reads the per-test config.
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
import {
  makeCtx,
  useScratchHome,
  writeSteeringSingleFileConfig,
} from "./__test-helpers__.ts";
import register from "./index.ts";

/* -------------------------------------------------------------------------- */
/* Mock ExtensionAPI                                                          */
/* -------------------------------------------------------------------------- */

type EventName = "agent_start" | "session_start" | "tool_call" | "tool_result";

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
/* register()-throws assertion helper                                         */
/* -------------------------------------------------------------------------- */

/**
 * Asserts that `register()` rejects with an Error whose `message`
 * matches every regex in `matchers`. Optional `extraChecks` runs
 * additional assertions against the rejected error (e.g. count
 * matches, structured fields).
 *
 * Folds the per-site `const mock = makeMockPi(); await
 * assert.rejects(...)` boilerplate.
 */
async function expectRegisterThrow(
  matchers: RegExp[],
  extraChecks?: (err: Error) => void,
): Promise<void> {
  const mock = makeMockPi();
  await assert.rejects(
    () => register(mock.api as ExtensionAPI),
    (err: Error) => {
      for (const m of matchers) {
        assert.match(err.message, m);
      }
      extraChecks?.(err);
      return true;
    },
  );
}

/* -------------------------------------------------------------------------- */
/* Factory throws on each diagnostic kind                                     */
/* -------------------------------------------------------------------------- */

describe("register(): factory throws on diagnostics", () => {
  useFactoryTimeScratchHome();
  captureWarns();

  it("throws on tracker-name-collision (error-class, failOnWarnings default)", async () => {
    writeSteeringSingleFileConfig(
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
    await expectRegisterThrow(
      [/\[error\]/, /tracker name collision/, /"branch"/],
      (err) => {
        // Integration mirror of O2 single-emission lock; see
        // internal/session-runtime.test.ts.
        const collisionMatches = err.message.match(/tracker name collision/g);
        assert.equal(
          collisionMatches?.length,
          1,
          "tracker-name-collision must appear exactly once",
        );
      },
    );
  });

  it("throws on reserved-tracker-name (error-class)", async () => {
    writeSteeringSingleFileConfig(
      tmpHome,
      `const t = { initial: "?", unknown: "unknown", modifiers: {}, subshellSemantics: "isolated" };
			export default {
				disableDefaults: true,
				plugins: [
					{ name: "pa", trackers: { events: t } },
				],
			};`,
    );
    await expectRegisterThrow([
      /\[error\]/,
      /tracker name "events" is reserved/,
    ]);
  });

  it("throws on reserved-predicate-key (error-class)", async () => {
    writeSteeringSingleFileConfig(
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
    await expectRegisterThrow([
      /\[error\]/,
      /reserved predicate key "onUnknown"/,
    ]);
  });

  it("throws on tracker-name-collision EVEN WITH failOnWarnings: false", async () => {
    // Errors override the opt-out; the engine cannot operate
    // safely with two plugins claiming the same state dimension.
    writeSteeringSingleFileConfig(
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
    await expectRegisterThrow([/\[error\]/, /tracker name collision/]);
  });

  it("throws on plugin-name-collision (warning-class, failOnWarnings default)", async () => {
    // Project and global layers ship the same plugin name. The
    // collision is warning-class but escalates under the default
    // `failOnWarnings: true`.
    const inner = join(tmpHome, "inner");
    mkdirSync(inner, { recursive: true });
    writeSteeringSingleFileConfig(
      inner,
      `export default {
				plugins: [{ name: "shared" }],
			};`,
    );
    mkdirSync(join(tmpHome, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".pi", "agent", "steering.ts"),
      `export default {
				disableDefaults: true,
				plugins: [{ name: "shared" }],
			};`,
      "utf8",
    );
    process.chdir(inner);
    await expectRegisterThrow([/\[warning\]/, /plugin "shared"/]);
  });

  it("throws on per-layer import failure", async () => {
    mkdirSync(join(tmpHome, ".pi"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".pi", "steering.ts"),
      "export default this is not valid typescript;\n",
      "utf8",
    );
    // Narrow on the actual parse-failure detail so a future loader
    // change that swallows the underlying error message (and leaves
    // only "failed to import") trips this assertion. Node's TS
    // stripper emits `Expected '...', got '...'` for syntax errors;
    // older jiti-style strippers emit `SyntaxError` or `Unexpected`.
    await expectRegisterThrow([
      /\[warning\]/,
      /failed to import/i,
      /Expected|SyntaxError|Unexpected/i,
    ]);
  });

  it("throws on predicate-collision (proves resolvePlugins warnings are plumbed)", async () => {
    writeSteeringSingleFileConfig(
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
    await expectRegisterThrow([
      /\[warning\]/,
      /duplicate predicate "when\.sharedKey"/,
    ]);
  });

  it("throws on observer-collision", async () => {
    writeSteeringSingleFileConfig(
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
    await expectRegisterThrow([/\[warning\]/, /duplicate observer "obs-x"/]);
  });

  it("throws on exemption-orphan (warning-class, failOnWarnings default)", async () => {
    // An exemption targeting a rule name absent from the merged
    // universe is warning-class but escalates under the default
    // `failOnWarnings: true` — a typo'd carve-out must not ship
    // silently as a dead exemption.
    writeSteeringSingleFileConfig(
      tmpHome,
      `export default {
				disableDefaults: true,
				exemptions: [
					{ rule: "no-such-rule", when: { cwd: "/vault/" } },
				],
			};`,
    );
    process.chdir(tmpHome);
    await expectRegisterThrow([
      /\[warning\]/,
      /exemption for rule "no-such-rule" \(config\)/,
    ]);
  });

  it("exemption-orphan with failOnWarnings: false falls through to console.warn", async () => {
    writeSteeringSingleFileConfig(
      tmpHome,
      `export default {
				disableDefaults: true,
				failOnWarnings: false,
				exemptions: [
					{ rule: "no-such-rule", when: { cwd: "/vault/" } },
				],
			};`,
    );
    process.chdir(tmpHome);
    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    const warn = capturedWarns.find((m) =>
      /exemption for rule "no-such-rule"/.test(m),
    );
    assert.ok(
      warn !== undefined,
      `expected exemption-orphan on console.warn, got: ${JSON.stringify(capturedWarns)}`,
    );
  });

  it("throws on rule-collision", async () => {
    writeSteeringSingleFileConfig(
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
    await expectRegisterThrow([/\[warning\]/, /duplicate rule "dup"/]);
  });
});

/* -------------------------------------------------------------------------- */
/* Factory does NOT throw                                                     */
/* -------------------------------------------------------------------------- */

describe("register(): factory does NOT throw", () => {
  useFactoryTimeScratchHome();
  captureWarns();

  it("warning-class with failOnWarnings: false falls through to console.warn", async () => {
    writeSteeringSingleFileConfig(
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
    // At least one captured warn matches the unified single-line
    // shape: `[pi-steering] [warning] <message>`. The aggregated-throw
    // format (with `<count> config issue` header) only renders for
    // thrown errors; this opt-out path goes through console.warn.
    const observerWarn = capturedWarns.find((m) =>
      /\[pi-steering\].*observer.*obs-x/i.test(m),
    );
    assert.ok(
      observerWarn !== undefined,
      `expected observer-collision warn on console.warn; got: ${JSON.stringify(capturedWarns)}`,
    );
    assert.match(observerWarn, /\[warning\]/);
    assert.doesNotMatch(observerWarn, /config issue/);
  });

  it("disabledPlugins resolves plugin-name-collision before the check runs", async () => {
    // The global layer's `disabledPlugins: ["shared"]` removes
    // the would-be collision before cross-layer detection,
    // matching the disable-then-detect ordering. No throw, no
    // warn.
    const inner = join(tmpHome, "inner");
    mkdirSync(inner, { recursive: true });
    writeSteeringSingleFileConfig(
      inner,
      `export default {
				plugins: [{ name: "shared" }],
			};`,
    );
    mkdirSync(join(tmpHome, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".pi", "agent", "steering.ts"),
      `export default {
				disableDefaults: true,
				disabledPlugins: ["shared"],
				plugins: [{ name: "shared" }],
			};`,
      "utf8",
    );
    process.chdir(inner);
    const mock = makeMockPi();
    await register(mock.api as ExtensionAPI);
    const collisionWarn = capturedWarns.find((m) => /plugin "shared"/i.test(m));
    assert.equal(
      collisionWarn,
      undefined,
      `expected NO plugin-collision warn; got: ${JSON.stringify(capturedWarns)}`,
    );
  });

  it("failOnWarnings undefined coerces to true (default-on)", async () => {
    // No `failOnWarnings` field at all; the runtime treats the
    // absence as `true` and escalates the warning.
    writeSteeringSingleFileConfig(
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
    await expectRegisterThrow([/\[warning\]/]);
  });
});

/* -------------------------------------------------------------------------- */
/* Cwd-mismatch session_start console.warn                                   */
/* -------------------------------------------------------------------------- */

describe("register(): cwd-mismatch session_start warn", () => {
  useFactoryTimeScratchHome();
  captureWarns();

  it("emits console.warn when ctx.cwd !== launchCwd; engine continues evaluating", async () => {
    // A user-defined rule lives in the launch-cwd config (tmpHome) but
    // not in foreignCwd's project layer; if it still fires after the
    // cwd-mismatch warn, launch-cwd config remained in force.
    writeSteeringSingleFileConfig(
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

    // Handlers must be wired (evaluator + dispatcher non-null).
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
    assert.ok(
      cwdMismatchWarn.includes(foreignCwd),
      `expected warn to contain foreignCwd; got: ${cwdMismatchWarn}`,
    );
    assert.ok(
      cwdMismatchWarn.includes(tmpHome),
      `expected warn to contain tmpHome; got: ${cwdMismatchWarn}`,
    );

    // Engine continues evaluating: the launch-cwd-only rule still
    // fires under the foreign-cwd ctx. Match on the rule name
    // (carried in `reason` as `[steering:<rule-name>@<source>]`) so a
    // future default-rule shadow matching the same pattern wouldn't
    // silently satisfy `block === true`.
    const blockedEvent: ToolCallEvent = {
      type: "tool_call",
      toolName: "bash",
      toolCallId: "call-1",
      input: { command: "echo LAUNCH_CWD_PROBE" },
    };
    const blocked = (await mock.handlers.tool_call(
      blockedEvent,
      makeCtx(foreignCwd),
    )) as ToolCallEventResult | undefined;
    assert.equal(blocked?.block, true);
    assert.match(
      blocked?.reason ?? "",
      /block-launch-cwd-only-rule/,
      "expected the launch-cwd-only rule to fire — not a default-rule shadow",
    );
  });

  it("does NOT emit cwd-mismatch warn when ctx.cwd === launchCwd", async () => {
    writeSteeringSingleFileConfig(tmpHome, "export default {};");
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
    writeSteeringSingleFileConfig(
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
    assert.equal(
      lines.length,
      4,
      `expected header + 3 bullets; got: ${err.message}`,
    );
    // Errors-first ordering: line 1 is the [error] bullet. Tighten
    // to enforce that no path prefix slips between the severity
    // tag and the message text — a future change adding a path
    // prefix to `reserved-tracker-name` would surface here.
    assert.match(
      lines[1]!,
      /^ {2}- \[error\] tracker name "events" is reserved/,
    );
    assert.match(lines[2]!, /^ {2}- \[warning\] /);
    assert.match(lines[3]!, /^ {2}- \[warning\] /);

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
