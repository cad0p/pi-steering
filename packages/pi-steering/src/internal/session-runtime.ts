// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Internal module — not part of the package's public API.
 *
 * This module holds the wiring that the bridge factory in `index.ts`
 * uses to spin up an evaluator + observer dispatcher from a walk-up
 * steering config. It is intentionally NOT re-exported from
 * `index.ts` or any other public entry point; consumers building
 * their own extensions should go through `loadHarness` (subpath
 * `pi-steering/testing`) or call `buildEvaluator` /
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
 * The bridge calls `buildSessionRuntime` once at extension factory
 * time. A thrown factory propagates through pi's extension loader
 * into pi's `[Extension issues]` diagnostic block (which survives
 * `/reload`); the bridge does not catch.
 */

import { DEFAULT_PLUGINS, DEFAULT_RULES } from "../defaults.ts";
import {
	buildEvaluator,
	EVALUATOR_BUILTIN_TRACKERS,
	type EvaluatorRuntime,
	type EvaluatorHost,
} from "../evaluator.ts";
import { buildConfig, loadConfigs, mergeBool } from "../loader.ts";
import {
	buildObserverDispatcher,
	type ObserverDispatcher,
} from "../observer-dispatcher.ts";
import {
	resolvePlugins,
	validateUserConfigNames,
	type ResolvedPluginState,
} from "../plugin-merger.ts";
import type { SteeringConfig, SteeringDiagnostic } from "../schema.ts";
import { finalizePluginState } from "./finalize-plugin-state.ts";

/**
 * Run `buildConfig` then `resolvePlugins` over the raw layer list,
 * short-circuiting before `resolvePlugins` if any merge-side
 * diagnostic is error-class. Avoids double-emitting
 * `tracker-name-collision` (O2 in INVARIANTS.md).
 * `validateUserConfigNames` runs unconditionally so user-config name
 * issues surface alongside merge errors.
 */
export function runMergerPipeline(
	layers: readonly SteeringConfig[],
	defaults: SteeringConfig | undefined,
	builtinTrackers: readonly string[],
): {
	merged: SteeringConfig;
	resolved: ResolvedPluginState | null;
	diagnostics: SteeringDiagnostic[];
} {
	const { config: merged, diagnostics: mergeDiagnostics } = buildConfig(
		layers,
		defaults,
	);
	const userConfigNameDiagnostics = validateUserConfigNames(layers);
	if (mergeDiagnostics.some((d) => d.type === "error")) {
		return {
			merged,
			resolved: null,
			diagnostics: [...mergeDiagnostics, ...userConfigNameDiagnostics],
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
 * up config rooted at `cwd`. Honors `disableDefaults` via inner-wins
 * peek before injecting `DEFAULT_*`. Throws on any error-class
 * diagnostic and on warning-class diagnostics when
 * `failOnWarnings !== false`; otherwise emits surviving warnings via
 * `console.warn`. See {@link runMergerPipeline} for the merge contract
 * and `finalizePluginState` for observer-drop.
 */
export async function buildSessionRuntime(
	cwd: string,
	host: EvaluatorHost,
): Promise<{
	evaluator: EvaluatorRuntime;
	dispatcher: ObserverDispatcher;
}> {
	const aggregated: SteeringDiagnostic[] = [];

	const { layers: rawLayers, diagnostics: loaderDiagnostics } =
		await loadConfigs(cwd);
	aggregated.push(...loaderDiagnostics);

	const disableDefaults =
		mergeBool(rawLayers, "disableDefaults") === true;
	const defaults: SteeringConfig | undefined = disableDefaults
		? undefined
		: { rules: DEFAULT_RULES, plugins: DEFAULT_PLUGINS };

	const { merged, resolved, diagnostics: mergeAndResolveDiagnostics } =
		runMergerPipeline(
			rawLayers,
			defaults,
			EVALUATOR_BUILTIN_TRACKERS,
		);
	aggregated.push(...mergeAndResolveDiagnostics);

	const failOnWarnings = merged.failOnWarnings;
	const treatWarningsAsErrors = failOnWarnings !== false;

	const hasError = aggregated.some((d) => d.type === "error");
	const hasWarning = aggregated.some((d) => d.type === "warning");
	if (hasError || (treatWarningsAsErrors && hasWarning)) {
		throw new Error(formatAggregatedDiagnostics(aggregated));
	}
	if (hasWarning) {
		for (const d of aggregated) {
			console.warn(formatSingleLineDiagnostic(d));
		}
	}

	if (resolved === null) {
		throw new Error("internal: resolved null without error diagnostic");
	}

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
	);
	const filteredResolved = {
		...resolved,
		observers: [...pluginKept],
	};

	const evaluator = buildEvaluator(filteredConfig, filteredResolved, host);
	const dispatcher = buildObserverDispatcher(
		filteredResolved,
		userKept,
		host,
	);
	return { evaluator, dispatcher };
}
