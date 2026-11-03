// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Internal module — not part of the package's public API.
 *
 * This module holds the wiring that the bridge factory in `index.ts`
 * uses to spin up an evaluator + observer dispatcher from the
 * two-layer config (project layer at `cwd`, global layer at the
 * agent dir). It is intentionally NOT re-exported from
 * `index.ts` or any other public entry point; consumers building
 * their own extensions should go through `loadHarness` (subpath
 * `@cad0p/pi-steering/testing`) or call `buildEvaluator` /
 * `buildObserverDispatcher` directly.
 *
 * The runtime owns the strict-mode contract: diagnostics produced
 * by the loader (per-layer import failures, dual-form coexistence,
 * stray files, cross-layer + within-layer collisions) and by the
 * plugin merger (predicate / observer / rule / extension-orphan /
 * reserved-name / invalid-name diagnostics) are aggregated here.
 * Any error-class diagnostic always escalates to a thrown error;
 * warning-class diagnostics escalate when `failOnWarnings !== false`
 * on the merged config (default: true). Otherwise warnings are
 * emitted to `console.warn` for legacy fail-soft semantics.
 *
 * The bridge defers the build to the first `session_start` on each
 * extension instance, anchored on the session's `ctx.cwd`. A
 * strict-mode aggregate throw (the "<n> config issue(s):" header) is
 * caught by the bridge and surfaced as a `console.error` line plus an
 * in-chat `ui.notify` carrying the FULL aggregated body; the session
 * runs unsteered (fail-closed). Any other error is rethrown and stays
 * loud via pi's `Extension "..." error:` rendering.
 */

import {
  buildEvaluator,
  EVALUATOR_BUILTIN_TRACKERS,
  type EvaluatorHost,
  type EvaluatorRuntime,
} from "../evaluator.ts";
import {
  buildConfig,
  type LoadConfigsOptions,
  loadConfigs,
} from "../loader.ts";
import {
  buildObserverDispatcher,
  type ObserverDispatcher,
} from "../observer-dispatcher.ts";
import {
  type ResolvedPluginState,
  resolvePlugins,
  validateUserConfigNames,
} from "../plugin-merger.ts";
import type {
  Exemption,
  SteeringConfig,
  SteeringDiagnostic,
} from "../schema.ts";
import { finalizePluginState } from "./finalize-plugin-state.ts";

/**
 * Detect exemptions whose target rule name doesn't exist in the final
 * merged rule universe and emit an `exemption-orphan` diagnostic for
 * each — the carve-out can never match anything.
 *
 * Two-tier severity contract (the ONLY severity split in orphan
 * detection):
 *
 *   - Plugin-shipped exemptions (`merged.plugins[].exemptions`, source
 *     `plugin "Y"`) are ERROR-class. A plugin explicitly shipping a
 *     carve-out that targets a rule missing from the merged universe
 *     is a broken plugin/config contract (e.g. the napkin plugin
 *     documents "gitPlugin MUST be listed alongside") — it must fail
 *     every surface: the runtime always throws (regardless of
 *     `failOnWarnings`), the CLI exits 1, `loadHarness` short-circuits
 *     to a no-op harness.
 *   - Config-written exemptions (`merged.exemptions`, source
 *     `config`) stay WARNING-class. User typos are already caught at
 *     compile time by `AllRuleNames` inside `defineConfig`; `satisfies`
 *     / JSON / JS authors keep the documented fail-soft path (strict
 *     mode throws, else `console.warn`).
 *
 * Universe formula (single source of truth for runtime, CLI, and
 * `loadHarness` — all three funnel through `runMergerPipeline`):
 *
 *   `merged.rules` ∪ rule names across `merged.plugins`
 *
 * `merged.plugins` intentionally includes DISABLED plugins (loader's
 * `mergePlugins` keeps them; `resolvePlugins` filters them from
 * `resolved.rules`) — a rule shipped only by a disabled plugin exists
 * in the universe, so an exemption targeting it is inert, silent, and
 * NOT orphaned (by-design disable, consistent with the disabled-rule
 * `console.info` breadcrumb). `resolved.rules` is redundant under
 * this formula. There are no engine-injected default rules (issue
 * #72): the universe is exactly what the config declares.
 */
function detectExemptionOrphans(merged: SteeringConfig): SteeringDiagnostic[] {
  const universe = new Set<string>();
  for (const rule of merged.rules ?? []) universe.add(rule.name);
  for (const plugin of merged.plugins ?? []) {
    for (const rule of plugin.rules ?? []) universe.add(rule.name);
  }

  const diagnostics: SteeringDiagnostic[] = [];
  const check = (
    exemption: Exemption,
    source: string,
    type: "error" | "warning",
  ): void => {
    if (universe.has(exemption.rule)) return;
    diagnostics.push({
      type,
      kind: "exemption-orphan",
      message:
        `exemption for rule "${exemption.rule}" (${source}) targets a rule ` +
        "that doesn't exist in the merged config; exemption ignored. " +
        "Check the rule name for typos, or install the plugin that ships it.",
    });
  };
  // Plugin bucket → error-class (broken plugin/config contract);
  // config bucket → warning-class (fail-soft, see JSDoc above).
  for (const plugin of merged.plugins ?? []) {
    for (const exemption of plugin.exemptions ?? []) {
      check(exemption, `plugin "${plugin.name}"`, "error");
    }
  }
  for (const exemption of merged.exemptions ?? []) {
    check(exemption, "config", "warning");
  }
  return diagnostics;
}

/**
 * Run `buildConfig` then `resolvePlugins` over the raw layer list,
 * short-circuiting before `resolvePlugins` if any merge-side
 * diagnostic is error-class. Avoids double-emitting
 * `tracker-name-collision` (O2 in INVARIANTS.md).
 * `validateUserConfigNames` runs unconditionally so user-config name
 * issues surface alongside merge errors; `detectExemptionOrphans`
 * runs on the merged config so runtime / CLI / loadHarness see the
 * same rule universe (defaults divergence handled explicitly). Its
 * severity split — plugin-shipped orphans error-class, config-written
 * orphans warning-class — applies identically on every surface.
 */
export function runMergerPipeline(
  layers: readonly SteeringConfig[],
  builtinTrackers: readonly string[],
): {
  merged: SteeringConfig;
  resolved: ResolvedPluginState | null;
  diagnostics: SteeringDiagnostic[];
} {
  // Fail-safe drop: an error-class diagnostic from an INNER layer must
  // not leave the session unsteered. First the offending DECLARATIONS
  // of the innermost layer are dropped (a plugin, a rule, an observer,
  // an exemption or a disabledPlugins entry — one at a time, each kept
  // out only when that strictly reduces the error count) so the rest of
  // that layer still loads; only when no such pruning makes the merge
  // clean is the whole layer dropped (innermost first). Each drop is a
  // `layer-part-dropped-on-error` / `layer-dropped-on-error` breadcrumb
  // that the session runtime prints with console.warn and the bridge
  // raises in-chat (info-class in the stream so strict mode never turns
  // the drop itself into a full disarm). If the outermost layer itself
  // is broken nothing is dropped and the error surfaces as before (the
  // owner's own content is not something to paper over).
  //
  // Why this exists: a project layer could otherwise disarm every rail
  // for the whole session with one line, either by provoking an engine
  // throw (disabledPlugins on a predicate-only plugin → unknown
  // predicate; a reserved tracker name; an orphan exemption; a rule
  // naming an unknown predicate, which threw from buildEvaluator) or by
  // flipping failOnWarnings so that a WARNING aborts the build. The
  // lock closes the named paths; this closes the class. Dropping only
  // the offending declaration keeps a legitimate per-repo rail alive
  // beside a broken plugin (lens round 2: functional F2, trust F2,
  // red-team F5).
  let attemptLayers = [...layers];
  const dropped: SteeringDiagnostic[] = [];
  for (;;) {
    const result = mergeWithTrialBuild(attemptLayers, builtinTrackers);
    const hasError = result.diagnostics.some((d) => d.type === "error");
    if (!hasError || attemptLayers.length <= 1) {
      return { ...result, diagnostics: [...dropped, ...result.diagnostics] };
    }
    // Attribution guard (lens round 3, functional F1 NIT / F3): if the
    // OUTER layers fail on their own, the error is theirs, not the inner
    // layer's. Nothing is dropped and the error surfaces exactly as a
    // broken outermost layer does — no misattributed "dropping config
    // layer #0" notice for a fault the project layer did not cause.
    const outerAlone = mergeWithTrialBuild(
      attemptLayers.slice(1),
      builtinTrackers,
      { forceTrial: true },
    );
    if (outerAlone.diagnostics.some((d) => d.type === "error")) {
      return { ...result, diagnostics: [...dropped, ...result.diagnostics] };
    }
    const droppedIndex = layers.length - attemptLayers.length;
    const pruned = pruneInnermostLayer(
      attemptLayers,
      result,
      builtinTrackers,
      droppedIndex,
    );
    if (pruned !== null) {
      return {
        ...pruned.result,
        diagnostics: [
          ...dropped,
          ...pruned.notices,
          ...pruned.result.diagnostics,
        ],
      };
    }
    const firstError = result.diagnostics.find((d) => d.type === "error");
    dropped.push({
      type: "info",
      kind: "layer-dropped-on-error",
      message:
        `dropping config layer #${droppedIndex} after an error-class diagnostic; ` +
        `${attemptLayers.length - 1} outer ` +
        `${attemptLayers.length - 1 === 1 ? "layer still loads" : "layers still load"} ` +
        "(an inner layer must not be able to leave the session unsteered). " +
        `Dropped error: ${firstError?.message ?? "unknown"}`,
    });
    attemptLayers = attemptLayers.slice(1);
  }
}

/**
 * Diagnostic kinds the bridge raises in-chat as well as on the console:
 * each one means the session runs with LESS than its config declares,
 * or under a layer other than the one it was pointed at.
 */
export const IN_CHAT_KINDS: ReadonlySet<SteeringDiagnostic["kind"]> = new Set([
  "layer-dropped-on-error",
  "layer-part-dropped-on-error",
  // A layer that failed to import loads nothing it declares (lens
  // round 3, functional F2): as loud as a drop.
  "layer-import-failed",
  "agent-dir-env-mutated",
  "agent-dir-env-drift",
  "global-layer-pin-mismatch",
] as const);

type MergeResult = {
  merged: SteeringConfig;
  resolved: ResolvedPluginState | null;
  diagnostics: SteeringDiagnostic[];
};

function errorCount(result: MergeResult): number {
  return result.diagnostics.filter((d) => d.type === "error").length;
}

/** One droppable declaration of a layer, with a label for the notice. */
interface LayerUnit {
  label: string;
  /** The declaration's own name, used to attribute an error message. */
  name: string;
  without: (layer: SteeringConfig) => SteeringConfig;
}

function withoutIndex<T>(list: readonly T[], index: number): T[] {
  return list.filter((_, i) => i !== index);
}

/** Every declaration of `layer` that the pruning may drop on its own. */
function layerUnits(layer: SteeringConfig): LayerUnit[] {
  const units: LayerUnit[] = [];
  for (const [i, plugin] of (layer.plugins ?? []).entries()) {
    units.push({
      label: `plugin "${String(plugin?.name)}"`,
      name: String(plugin?.name),
      without: (l) => ({ ...l, plugins: withoutIndex(l.plugins ?? [], i) }),
    });
  }
  for (const [i, rule] of (layer.rules ?? []).entries()) {
    units.push({
      label: `rule "${String(rule?.name)}"`,
      name: String(rule?.name),
      without: (l) => ({ ...l, rules: withoutIndex(l.rules ?? [], i) }),
    });
  }
  for (const [i, observer] of (layer.observers ?? []).entries()) {
    const name =
      typeof observer === "string" ? observer : String(observer?.name);
    units.push({
      label: `observer "${name}"`,
      name,
      without: (l) => ({
        ...l,
        observers: withoutIndex(l.observers ?? [], i),
      }),
    });
  }
  for (const [i, exemption] of (layer.exemptions ?? []).entries()) {
    units.push({
      label: `exemption for rule "${String(exemption?.rule)}"`,
      name: String(exemption?.rule),
      without: (l) => ({
        ...l,
        exemptions: withoutIndex(l.exemptions ?? [], i),
      }),
    });
  }
  for (const [i, name] of (layer.disabledPlugins ?? []).entries()) {
    units.push({
      label: `disabledPlugins entry "${String(name)}"`,
      name: String(name),
      without: (l) => ({
        ...l,
        disabledPlugins: withoutIndex(l.disabledPlugins ?? [], i),
      }),
    });
  }
  return units;
}

/**
 * Drop the offending declarations of the INNERMOST layer instead of the
 * whole layer. Greedy and bounded by the layer's declaration count: each
 * pass tries every remaining declaration on its own and keeps, in order
 * of preference,
 *   1. the first removal that strictly lowers the error count;
 *   2. else the first removal that makes a current error disappear and
 *      whose own name appears in that error's message (an
 *      `evaluator-build-failed` reports ONE fault per build, so two
 *      typo'd rules trade one error for the other and the count never
 *      falls — lens round 3, functional F1);
 *   3. else the first removal that makes a current error disappear
 *      without raising the count.
 * Every accepted removal takes one declaration out, so the loop ends
 * after at most as many passes as the layer has declarations. It stops
 * when the merge is clean (success) or when no removal helps (null → the
 * caller drops the layer). Removing an inner declaration only ever moves
 * the merge toward the outer layers alone, so it cannot weaken an outer
 * rail.
 */
function pruneInnermostLayer(
  attemptLayers: readonly SteeringConfig[],
  initial: MergeResult,
  builtinTrackers: readonly string[],
  layerIndex: number,
): { result: MergeResult; notices: SteeringDiagnostic[] } | null {
  const [inner, ...outer] = attemptLayers;
  if (inner === undefined) return null;
  let current = inner;
  let result = initial;
  let errors = errorCount(result);
  const notices: SteeringDiagnostic[] = [];
  let budget: number;
  try {
    budget = layerUnits(current).length;
  } catch {
    return null; // a layer whose declarations cannot even be listed
  }
  while (errors > 0 && budget > 0) {
    let units: LayerUnit[];
    try {
      units = layerUnits(current);
    } catch {
      return null;
    }
    const errorMessages = result.diagnostics
      .filter((d) => d.type === "error")
      .map((d) => d.message);
    let best: {
      rank: number;
      unit: LayerUnit;
      candidate: SteeringConfig;
      trial: MergeResult;
      gone: string[];
    } | null = null;
    for (const unit of units) {
      let candidate: SteeringConfig;
      try {
        candidate = unit.without(current);
      } catch {
        continue;
      }
      const trial = mergeWithTrialBuild([candidate, ...outer], builtinTrackers);
      const trialErrors = errorCount(trial);
      const gone = errorMessages.filter(
        (m) =>
          !trial.diagnostics.some((t) => t.type === "error" && t.message === m),
      );
      let rank = 0;
      if (trialErrors < errors) rank = 3;
      else if (
        trialErrors <= errors &&
        gone.some((m) => m.includes(`"${unit.name}"`))
      )
        rank = 2;
      else if (trialErrors <= errors && gone.length > 0) rank = 1;
      if (rank > (best?.rank ?? 0)) {
        best = { rank, unit, candidate, trial, gone };
        if (rank === 3) break;
      }
    }
    if (best === null) return null;
    notices.push({
      type: "info",
      kind: "layer-part-dropped-on-error",
      message:
        `dropping ${best.unit.label} from config layer #${layerIndex} after an ` +
        "error-class diagnostic; the rest of that layer and every outer " +
        "layer still load (an inner layer must not be able to leave the " +
        `session unsteered). Dropped error: ${best.gone[0] ?? "unknown"}`,
    });
    current = best.candidate;
    result = best.trial;
    errors = errorCount(result);
    budget -= 1;
  }
  if (errors > 0) return null;
  return { result, notices };
}

/**
 * Prepare the evaluator inputs exactly as the session runtime does:
 * disabled rules filtered out, plugin observers / exemptions finalised.
 * Shared by {@link buildSessionRuntime} and the trial build below so the
 * two can never disagree.
 */
function prepareEvaluatorInputs(
  merged: SteeringConfig,
  resolved: ResolvedPluginState,
): {
  filteredConfig: SteeringConfig;
  filteredResolved: ResolvedPluginState;
  userKept: ReturnType<typeof finalizePluginState>["userKept"];
} {
  const disabled = new Set(merged.disabledRules ?? []);
  const filteredConfig: SteeringConfig = { ...merged };
  if (merged.rules !== undefined) {
    const kept = merged.rules.filter((r) => !disabled.has(r.name));
    if (kept.length > 0) filteredConfig.rules = kept;
    else delete filteredConfig.rules;
  }

  const { pluginKept, userKept } = finalizePluginState(
    filteredConfig.rules ?? [],
    resolved.rules,
    filteredConfig.observers ?? [],
    resolved.observers,
    filteredConfig.exemptions ?? [],
    resolved.exemptions ?? [],
  );
  const filteredResolved = {
    ...resolved,
    observers: [...pluginKept],
  };
  return { filteredConfig, filteredResolved, userKept };
}

/** Host for a trial build: construction never execs or appends. */
const TRIAL_HOST: EvaluatorHost = {
  exec: () => Promise.reject(new Error("trial build host: no exec")),
  appendEntry: () => {},
};

/**
 * {@link mergeLayersOnce}, plus — when an inner layer is present and the
 * merge is otherwise clean — a trial evaluator / dispatcher build. The
 * evaluator validates `when:` clauses (unknown predicate keys, empty
 * clauses, `onUnknown` in an exemption) by THROWING, which the bridge
 * cannot tell from an engine crash, so a project rule naming a predicate
 * nobody registers used to disarm every rail. Here the throw becomes an
 * error-class `evaluator-build-failed` diagnostic that the drop logic
 * can attribute. A single (outermost) layer is not trial-built: its
 * failure surfaces exactly as before.
 */
function mergeWithTrialBuild(
  layers: readonly SteeringConfig[],
  builtinTrackers: readonly string[],
  opts: { forceTrial?: boolean } = {},
): MergeResult {
  let result: MergeResult;
  try {
    result = mergeLayersOnce(layers, builtinTrackers);
  } catch (err) {
    // A config OBJECT that throws while it is read (a throwing getter on
    // a plugin's `predicates`, a `rules` accessor) used to escape the
    // diagnostic path and leave the session unsteered (lens round 3,
    // functional F3). Here it becomes an error-class diagnostic that the
    // drop logic can attribute like any other.
    const body = err instanceof Error ? err.message : String(err);
    return {
      merged: {},
      resolved: null,
      diagnostics: [
        {
          type: "error",
          kind: "layer-merge-failed",
          message: `reading the config threw: ${body}`,
        },
      ],
    };
  }
  if (!opts.forceTrial && layers.length <= 1) return result;
  if (result.resolved === null) return result;
  if (result.diagnostics.some((d) => d.type === "error")) return result;
  try {
    const { filteredConfig, filteredResolved, userKept } =
      prepareEvaluatorInputs(result.merged, result.resolved);
    buildEvaluator(filteredConfig, filteredResolved, TRIAL_HOST);
    buildObserverDispatcher(filteredResolved, userKept, TRIAL_HOST);
    return result;
  } catch (err) {
    const body = err instanceof Error ? err.message : String(err);
    return {
      ...result,
      diagnostics: [
        ...result.diagnostics,
        { type: "error", kind: "evaluator-build-failed", message: body },
      ],
    };
  }
}

/** One merge attempt over a fixed layer list (see {@link runMergerPipeline}). */
function mergeLayersOnce(
  layers: readonly SteeringConfig[],
  builtinTrackers: readonly string[],
): {
  merged: SteeringConfig;
  resolved: ResolvedPluginState | null;
  diagnostics: SteeringDiagnostic[];
} {
  const { config: merged, diagnostics: mergeDiagnostics } = buildConfig(layers);
  const userConfigNameDiagnostics = validateUserConfigNames(layers);
  const exemptionOrphanDiagnostics = detectExemptionOrphans(merged);
  if (mergeDiagnostics.some((d) => d.type === "error")) {
    return {
      merged,
      resolved: null,
      diagnostics: [
        ...mergeDiagnostics,
        ...userConfigNameDiagnostics,
        ...exemptionOrphanDiagnostics,
      ],
    };
  }
  const resolved = resolvePlugins(
    merged.plugins ?? [],
    merged,
    builtinTrackers,
  );
  return {
    merged,
    resolved,
    diagnostics: [
      ...mergeDiagnostics,
      ...userConfigNameDiagnostics,
      ...exemptionOrphanDiagnostics,
      ...resolved.diagnostics,
    ],
  };
}

/**
 * Render a diagnostics array into a single multi-line message
 * suitable for use as a thrown Error's `message`. See {@link
 * SteeringDiagnostic} render-format matrix for the canonical shape;
 * the `formatAggregatedDiagnostics: rule-based spec` describe block in
 * `internal/session-runtime.test.ts` pins the rules.
 */
export function formatAggregatedDiagnostics(
  diagnostics: readonly SteeringDiagnostic[],
): string {
  const errors = diagnostics.filter((d) => d.type === "error");
  const warnings = diagnostics.filter((d) => d.type === "warning");
  const ordered = [...errors, ...warnings];
  const count = ordered.length;
  const noun = count === 1 ? "issue" : "issues";
  const lines = ordered.map((d) => {
    const pathPrefix = d.path !== undefined ? `${d.path}: ` : "";
    return `  - [${d.type}] ${pathPrefix}${d.message}`;
  });
  return `${count} config ${noun}:\n${lines.join("\n")}`;
}

/**
 * Single-line render of one diagnostic; see {@link SteeringDiagnostic}
 * render-format matrix for the canonical contract.
 */
export function formatSingleLineDiagnostic(d: SteeringDiagnostic): string {
  const pathPrefix = d.path !== undefined ? `${d.path}: ` : "";
  return `[pi-steering] [${d.type}] ${pathPrefix}${d.message}`;
}

/**
 * Build the per-session evaluator + observer dispatcher from the walk-
 * up config rooted at `cwd`. Throws on any error-class diagnostic and
 * on warning-class diagnostics when `failOnWarnings !== false`;
 * otherwise emits surviving warnings via `console.warn`. See {@link
 * runMergerPipeline} for the merge contract and `finalizePluginState`
 * for observer-drop.
 *
 * `opts` is forwarded to {@link loadConfigs} — `projectLayerTrusted:
 * false` gates the project layer behind pi's resolved project-trust
 * decision (see {@link LoadConfigsOptions}). Info-class diagnostics
 * (e.g. the `layer-project-untrusted` skip breadcrumb) are emitted
 * via `console.info` BEFORE the throw/warn policy runs and are
 * excluded from the aggregate throw body by construction
 * (`formatAggregatedDiagnostics` filters error/warning only) — an
 * untrusted project keeps global-layer steering in every strict-mode
 * setting.
 */
export async function buildSessionRuntime(
  cwd: string,
  host: EvaluatorHost,
  opts?: LoadConfigsOptions,
): Promise<{
  evaluator: EvaluatorRuntime;
  dispatcher: ObserverDispatcher;
  /**
   * Single-line renders of the diagnostics the bridge must also raise
   * IN-CHAT (see {@link IN_CHAT_KINDS}): a dropped layer or declaration,
   * a project layer that moved the agent dir, a pin mismatch. Already
   * printed with `console.warn`.
   */
  notices: string[];
}> {
  const aggregated: SteeringDiagnostic[] = [];

  const { layers: rawLayers, diagnostics: loaderDiagnostics } =
    await loadConfigs(cwd, opts);
  aggregated.push(...loaderDiagnostics);

  // Info-class breadcrumbs (e.g. `layer-project-untrusted` under the
  // trust gate) surface on `console.info` here, BEFORE the throw/warn
  // policy below — they describe normal behavior, never escalate, and
  // must be visible even when the session build later throws on
  // warning/error diagnostics. Mirrors the disabled-rules / dropped-
  // observer `console.info` breadcrumb pattern.
  for (const d of aggregated) {
    if (d.type === "info") console.info(formatSingleLineDiagnostic(d));
  }

  const {
    merged,
    resolved,
    diagnostics: mergeAndResolveDiagnostics,
  } = runMergerPipeline(rawLayers, EVALUATOR_BUILTIN_TRACKERS);
  aggregated.push(...mergeAndResolveDiagnostics);

  // Loud drops: the drop breadcrumbs are info-class in the stream (so
  // strict mode cannot turn a drop into a full disarm), but losing a
  // repo's rails must never be silent — console.warn here, in-chat via
  // the bridge (lens round 2: functional F2, trust F2, red-team F5).
  const notices: string[] = [];
  for (const d of aggregated) {
    if (!IN_CHAT_KINDS.has(d.kind)) continue;
    const line = formatSingleLineDiagnostic(d);
    notices.push(line);
    if (d.type === "info") console.warn(line);
  }

  const failOnWarnings = merged.failOnWarnings;
  const treatWarningsAsErrors = failOnWarnings !== false;

  const hasError = aggregated.some((d) => d.type === "error");
  const hasWarning = aggregated.some((d) => d.type === "warning");
  if (hasError || (treatWarningsAsErrors && hasWarning)) {
    throw new Error(formatAggregatedDiagnostics(aggregated));
  }
  if (hasWarning) {
    // Fail-soft single-line route — filtered to warning-class only
    // (F1): info-class diagnostics were already breadcrumbed via
    // `console.info` above and must never re-emit through the
    // `console.warn` loop. Behavior-preserving today (no info
    // producers existed before the trust gate); pins the single-route
    // contract.
    for (const d of aggregated) {
      if (d.type === "warning") console.warn(formatSingleLineDiagnostic(d));
    }
  }

  if (resolved === null) {
    throw new Error("internal: resolved null without error diagnostic");
  }

  const { filteredConfig, filteredResolved, userKept } = prepareEvaluatorInputs(
    merged,
    resolved,
  );

  const evaluator = buildEvaluator(filteredConfig, filteredResolved, host);
  const dispatcher = buildObserverDispatcher(filteredResolved, userKept, host);
  return { evaluator, dispatcher, notices };
}
