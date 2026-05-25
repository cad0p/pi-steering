// SPDX-License-Identifier: MIT
// Part of pi-steering.
//
// pi-steering — deterministic steering hooks for pi agents.
// Inspired by @samfp/pi-steering-hooks (schema, override-comment,
// defaults). AST backend + command-level effective-cwd via
// unbash-walker. This file is the thin wiring layer between pi's
// extension API and the engine (loader + plugin-merger + evaluator
// + observer-dispatcher).

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { buildSessionRuntime } from "./internal/session-runtime.ts";
import type { EvaluatorHost } from "./evaluator.ts";

/**
 * Pi extension factory. Wires the steering engine onto pi's
 * lifecycle events.
 *
 * Strict-mode contract: the factory eagerly walks up from
 * `process.cwd()` and builds the per-session evaluator + dispatcher
 * via {@link buildSessionRuntime} — loading every
 * `.pi/steering/index.ts` (or `.pi/steering.ts`) from the launch cwd
 * up to and including `$HOME`, merging with `DEFAULT_RULES` +
 * `DEFAULT_PLUGINS` (unless `disableDefaults: true` is set anywhere
 * in the walk-up chain), and aggregating every
 * {@link SteeringDiagnostic} from the loader and plugin merger. The
 * runtime owns the throw: any error-class diagnostic always
 * escalates, and any warning-class diagnostic escalates when
 * `failOnWarnings !== false`. With `failOnWarnings: false`,
 * surviving warnings are emitted to `console.warn` instead of
 * throwing; the bridge continues with the merged config. The bridge
 * does not catch a thrown factory — the throw propagates through
 * pi's extension loader into pi's `[Extension issues]` block (pi's
 * startup yellow-highlighted diagnostic banner), which is the only
 * diagnostic surface that survives `/reload`.
 *
 * Lifecycle wiring:
 *
 *   - factory time      — eager load via {@link buildSessionRuntime};
 *                         throws on diagnostic per the strict-mode
 *                         contract described above.
 *   - `agent_start`     — bump the internal `agentLoopIndex` counter
 *                         so tool_call / tool_result handlers can
 *                         forward it into the evaluator + dispatcher.
 *                         One agent loop = one user prompt + all the
 *                         tool calls it spawns.
 *   - `session_start`   — emit a `console.warn` if the resumed
 *                         session's `ctx.cwd` differs from the launch
 *                         cwd captured at factory time (cross-project
 *                         resume). The engine continues evaluating
 *                         with launch-cwd rules — partial guardrails
 *                         beat silently disabling everything for the
 *                         resumed session.
 *   - `tool_call`       — gate via the evaluator. Returns a
 *                         ToolCallEventResult to block or `undefined`
 *                         to allow.
 *   - `tool_result`     — dispatch to all matching observers.
 *
 * Exported as the default export per pi's extension convention.
 */
export default async function register(pi: ExtensionAPI): Promise<void> {
	let agentLoopIndex = 0;

	// Narrow host surface the evaluator + dispatcher need.
	const host: EvaluatorHost = {
		exec: pi.exec,
		appendEntry: pi.appendEntry,
	};

	// Captured once for the cross-project-resume detection in session_start.
	const launchCwd = process.cwd();

	const { evaluator, dispatcher } = await buildSessionRuntime(
		launchCwd,
		host,
	);

	pi.on("agent_start", () => {
		agentLoopIndex += 1;
	});

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		if (ctx.cwd !== launchCwd) {
			console.warn(
				`[pi-steering] session cwd (${ctx.cwd}) differs from launch cwd ` +
					`(${launchCwd}). Steering rules loaded from launch cwd; ` +
					`session-cwd rules NOT applied. To use session-cwd rules, ` +
					`exit pi and re-launch from ${ctx.cwd}.`,
			);
		}
	});

	pi.on("tool_call", (event, ctx) =>
		evaluator.evaluate(event, ctx, agentLoopIndex),
	);

	pi.on("tool_result", (event, ctx) =>
		dispatcher.dispatch(event, ctx, agentLoopIndex),
	);
}

// ---------------------------------------------------------------------------
// Public surface — the engine.
//
// Consumers embedding the engine (building their own extensions, a CLI
// that lints commands, a test harness, …) import these from the
// package root.
// ---------------------------------------------------------------------------

// Defaults — bundled rule and plugin starter set.
export { DEFAULT_PLUGINS, DEFAULT_RULES } from "./defaults.ts";

// Config helper (preferred entry point).
export { defineConfig } from "./define-config.ts";
export type { DefineConfigInput } from "./define-config.ts";

// Predicate helper.
export { definePredicate } from "./define-predicate.ts";

// Reason-text helper for custom predicates that read runtime
// `ctx.cwd` (shell-exec or filesystem queries) rather than
// walker-tracked state.
//
// `walkerUnknownCwdReason`: composable agent-facing reason text
// for ReasonFns to call on the walker-unknown branch of those
// runtime-cwd predicates (typical handler shape:
// `if (ctx.walkerState?.cwd === "unknown") return "unknown";`,
// then the engine projects via `onUnknown:` policy).
export { walkerUnknownCwdReason } from "./helpers/walker-unknown-cwd-reason.ts";

// Loader — walk-up config discovery + merge.
export { buildConfig, loadConfigs, loadSteeringConfig } from "./loader.ts";

// JSON compat — convert v1 JSON configs to v2 TS configs.
export { FromJSONError, fromJSON } from "./compat.ts";

// Auto-tag key for session-entry writes. Exposed so plugin authors
// inspecting raw session entries via `findEntries` can reference the
// constant instead of hardcoding the string.
export { AGENT_LOOP_INDEX_KEY } from "./evaluator-internals/context.ts";

// Schema types — the public authoring surface.
export type {
	AnyPredicateHandler,
	DefaultSpreadBase,
	ExecOpts,
	ExecResult,
	BaseRule,
	BashRule,
	EditRule,
	InnerValue,
	Observer,
	ObserverContext,
	ObserverWatch,
	OperatorField,
	OuterValue,
	Pattern,
	Patterns,
	Plugin,
	PluginPredicateKey,
	PredicateContext,
	PredicateFn,
	PredicateHandler,
	PredicateModifiers,
	PredicateShape,
	PredicateToolInput,
	PredicateVerdict,
	ReasonFn,
	ReservedPredicateKey,
	Rule,
	SteeringConfig,
	SteeringDiagnostic,
	SteeringDiagnosticKind,
	ToolResultEvent,
	TopLevelWhenClause,
	TopLevelWhenClauseNoRecurse,
	BuiltInWhenLeaves,
	BuiltInWhenLeavesInner,
	BuiltInWhenLeavesOuter,
	WhenClause,
	WhenWalkerState,
	WriteRule,
} from "./schema.ts";

// Walker types re-exported for plugin authors. Forward-compatible with
// future unbash-walker extraction — imports from this package won't
// break.
export type {
	CommandRef,
	Command,
	Modifier,
	Node,
	Script,
	SubshellSemantics,
	Tracker,
	WalkResult,
	Word,
	WordPart,
} from "unbash-walker";

// Walker functions re-exported for plugin authors writing custom
// predicates and trackers. Forward-compatible with future
// unbash-walker extraction.
export {
	cwdTracker,
	envTracker,
	expandWrapperCommands,
	extractAllCommandsFromAST,
	formatCommand,
	getBasename,
	getCommandArgs,
	getCommandName,
	isStaticallyResolvable,
	parse,
	resolveWord,
	walk,
} from "unbash-walker";

export type { EnvState } from "unbash-walker";

// Testing primitives — re-exported at the root for discoverability.
// The canonical import path is `pi-steering/testing`;
// this root re-export means a test file that already imports
// `defineConfig` from the root doesn't need a second import line for
// `loadHarness`. See `./testing/index.ts` for the API docs.
export {
	createRecordingHost,
	expectAllows,
	expectBlocks,
	expectRuleFires,
	formatMatrix,
	getAppendedEntries,
	loadHarness,
	mockContext,
	mockExtensionContext,
	mockObserverContext,
	priorEntry,
	runMatrix,
	testObserver,
	testPredicate,
} from "./testing/index.ts";

export type {
	BashShorthand,
	CreateRecordingHostOptions,
	EditShorthand,
	ExpectBlocksOptions,
	Harness,
	LoadHarnessOptions,
	MatrixCase,
	MatrixCaseResult,
	MatrixResult,
	MockContextOptions,
	MockObserverContextOptions,
	MockEntry,
	PriorEntryOptions,
	RecordedExecCall,
	RecordedSessionEntry,
	RecordingHost,
	ToolCallShorthand,
	ToolResultShorthand,
	WriteShorthand,
} from "./testing/index.ts";
