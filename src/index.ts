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
import type { EvaluatorHost } from "./evaluator.ts";
import { buildSessionRuntime } from "./internal/session-runtime.ts";

/**
 * Pi extension factory. Wires the steering engine onto pi's
 * lifecycle events.
 *
 * Strict-mode contract: see {@link SteeringConfig.failOnWarnings}.
 *
 * Lifecycle wiring:
 *
 *   - factory time      — eager load via {@link buildSessionRuntime};
 *                         throws on diagnostic per the strict-mode
 *                         contract.
 *   - `agent_start`     — bump the internal `agentLoopIndex` counter
 *                         so tool_call / tool_result handlers can
 *                         forward it into the evaluator + dispatcher.
 *                         One agent loop = one user prompt + all the
 *                         tool calls it spawns.
 *   - `session_start`   — emit a `console.warn` if the resumed
 *                         session's `ctx.cwd` differs from the launch
 *                         cwd captured at factory time (cross-project
 *                         resume). The engine continues evaluating
 *                         with launch-cwd rules.
 *   - `tool_call` / `tool_result` route through the evaluator and
 *     dispatcher (see {@link buildSessionRuntime}).
 *
 * Exported as the default export per pi's extension convention.
 */
export default async function register(pi: ExtensionAPI): Promise<void> {
  let agentLoopIndex = 0;

  const host: EvaluatorHost = {
    exec: pi.exec,
    appendEntry: pi.appendEntry,
  };

  const launchCwd = process.cwd();

  const { evaluator, dispatcher } = await buildSessionRuntime(launchCwd, host);

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

// Walker types re-exported for plugin authors. Forward-compatible with
// future unbash-walker extraction — imports from this package won't
// break.
export type {
  Command,
  CommandRef,
  EnvState,
  Modifier,
  Node,
  Script,
  SubshellSemantics,
  Tracker,
  WalkResult,
  Word,
  WordPart,
} from "@cad0p/unbash-walker";
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
} from "@cad0p/unbash-walker";
// JSON compat — convert v1 JSON configs to v2 TS configs.
export { FromJSONError, fromJSON } from "./compat.ts";
// Defaults — bundled rule and plugin starter set.
export { DEFAULT_PLUGINS, DEFAULT_RULES } from "./defaults.ts";
export type { DefineConfigInput } from "./define-config.ts";
// Config helper (preferred entry point).
export { defineConfig } from "./define-config.ts";
// Predicate helper.
export { definePredicate } from "./define-predicate.ts";
// Auto-tag key for session-entry writes. Exposed so plugin authors
// inspecting raw session entries via `findEntries` can reference the
// constant instead of hardcoding the string.
export { AGENT_LOOP_INDEX_KEY } from "./evaluator-internals/context.ts";
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
// Loader — two-layer config discovery + merge.
export { buildConfig, loadConfigs, loadSteeringConfig } from "./loader.ts";
// Schema types — the public authoring surface.
export type {
  AnyPredicateHandler,
  BaseRule,
  BashRule,
  BuiltInWhenLeaves,
  BuiltInWhenLeavesInner,
  BuiltInWhenLeavesOuter,
  DefaultSpreadBase,
  EditRule,
  ExecOpts,
  ExecResult,
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
  WhenClause,
  WhenWalkerState,
  WriteRule,
} from "./schema.ts";
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
  MockEntry,
  MockObserverContextOptions,
  PriorEntryOptions,
  RecordedExecCall,
  RecordedSessionEntry,
  RecordingHost,
  ToolCallShorthand,
  ToolResultShorthand,
  WriteShorthand,
} from "./testing/index.ts";
// Testing primitives — re-exported at the root for discoverability.
// The canonical import path is `@cad0p/pi-steering/testing`;
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
