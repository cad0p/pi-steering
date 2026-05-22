// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Internal module — not part of the package's public API.
 *
 * This module holds the per-session wiring that `register()` uses to
 * spin up an evaluator + observer dispatcher from a walk-up steering
 * config. It is intentionally NOT re-exported from `index.ts` or any
 * other public entry point; consumers building their own extensions
 * should go through `loadHarness` (subpath `pi-steering/testing`)
 * or call `buildEvaluator` / `buildObserverDispatcher` directly.
 *
 * The runtime owns the strict-mode contract: diagnostics produced by
 * the loader (per-layer import failures, dual-form coexistence,
 * stray files, cross-layer + within-layer collisions) and by the
 * plugin merger (predicate / observer / rule / extension-orphan /
 * disabled / reserved-name diagnostics) are aggregated here. Any
 * error-class diagnostic always escalates to a thrown error; warning-
 * class diagnostics escalate when `failOnWarnings !== false` on the
 * merged config (default: true). Otherwise warnings are emitted to
 * `console.warn` for legacy fail-soft semantics.
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
import { dropUnusedObservers } from "./drop-unused-observers.ts";

/**
 * Run `buildConfig` over the raw layer list, validate user-config
 * rule + observer names, then run `resolvePlugins` — short-circuiting
 * before `resolvePlugins` if any merge-side diagnostic is
 * error-class. Both `buildConfig` (`detectTrackerNameCollisions`)
 * and `resolvePlugins` independently flag tracker-name collisions;
 * running the merger after the loader has already flagged one would
 * emit the same diagnostic twice. The short-circuit centralizes that
 * gate so every surface that runs the full merge+resolve pipeline
 * (`buildSessionRuntime`, `loadHarness`, the `pi-steering list` CLI)
 * emits each error-class diagnostic exactly once.
 *
 * User-config rule and observer name validation runs
 * unconditionally between `buildConfig` and the merge short-circuit
 * — so every surface gets the same `invalid-name` diagnostic stream
 * including the case where a merge-side error fires alongside a
 * malformed user-config name. The validation reads
 * `merged.rules[*].name` and `merged.observers[*].name`, both
 * populated by `buildConfig` even on merge error, and does not
 * depend on any `resolvePlugins` state. No surface routes user-
 * config malformed names through the plain-Error throw inside
 * `buildEvaluator` / `buildObserverDispatcher`. Plugin-shipped names
 * are still validated inside `resolvePlugins` (gated behind the
 * short-circuit, since `resolvePlugins` is the surface that consumes
 * them).
 *
 * Returns the merged `SteeringConfig`, the `ResolvedPluginState` (or
 * `null` when the short-circuit fired), and the aggregated
 * diagnostics array (merge-side, then user-config name validation,
 * then resolve-side, in order). On short-circuit `diagnostics`
 * contains the merge-side stream PLUS the user-config name
 * validation stream — resolve-side is skipped together with
 * `resolvePlugins`.
 *
 * Loader-side diagnostics from `loadConfigs` are NOT included here —
 * callers that walked up from a cwd (`buildSessionRuntime`, the CLI)
 * thread those in separately. `loadHarness` operates on a single
 * in-memory layer and has no loader stream to thread.
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
	// User-config name validation runs unconditionally — BEFORE the
	// merge short-circuit — so a config with a merge-side error AND a
	// malformed user-config name surfaces both diagnostics in one
	// run. The pass reads `merged.rules[*].name` and
	// `merged.observers[*].name`, both populated by `buildConfig`
	// even on merge error; the validation does not depend on any
	// `resolvePlugins` state, so there's no risk of cascading false-
	// positives from a partially-merged config. Resolve-side
	// (`resolvePlugins`) IS still gated behind the short-circuit
	// because running it over a config with e.g. a tracker-name
	// collision could surface confusing diagnostics from the
	// inconsistent state.
	const userConfigNameDiagnostics = validateUserConfigNames(merged);
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
 * suitable for use as a thrown Error's `message`. The format:
 *
 *   - Header: `${count} config issue${plural}:` (singular when
 *     `count === 1`).
 *   - One bullet per diagnostic, severity tag in brackets, optional
 *     path prefix when {@link SteeringDiagnostic.path} is set.
 *   - Severity ordering: errors first, then warnings. Within each
 *     severity, declaration order is preserved.
 *
 * No footer.
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
 * Render a single {@link SteeringDiagnostic} as a one-line message
 * suitable for the two single-diagnostic surfaces:
 *
 *   - `console.warn` (legacy fail-soft channel under
 *     `failOnWarnings: false`) — `buildSessionRuntime` only routes
 *     warnings through here; errors always throw via the aggregated
 *     form.
 *   - CLI stderr (`pi-steering list` pre-flight surface) — both
 *     warnings and errors render through this helper inline as the
 *     loader / merger yields them.
 *
 * Errors get an `ERROR: ` severity prefix after the bracket so a
 * user grepping CI logs has a clear handle; warnings have none.
 * Path prefix is conditional on {@link SteeringDiagnostic.path}
 * being set — cross-layer collisions (no source path) render with
 * the message alone.
 *
 * The aggregated multi-line form (for thrown-Error message bodies
 * in strict mode) is produced by {@link formatAggregatedDiagnostics},
 * not this helper.
 */
export function formatSingleLineDiagnostic(d: SteeringDiagnostic): string {
	const severity = d.type === "error" ? "ERROR: " : "";
	const pathPrefix = d.path !== undefined ? `${d.path}: ` : "";
	return `[pi-steering] ${severity}${pathPrefix}${d.message}`;
}

/**
 * Build the per-session evaluator + observer dispatcher from the walk-
 * up config rooted at `cwd`. `disableDefaults: true` in any layer is
 * honored before defaults are injected:
 *
 *   1. `loadConfigs(cwd)` — async IO, read every layer from cwd →
 *      $HOME.
 *   2. `mergeBool(layers, "disableDefaults")` — inner-wins peek
 *      across raw layers without paying for a full merge.
 *   3. `buildConfig(layers, defaults?)` with defaults conditional on
 *      the disableDefaults peek, producing the effective config.
 *   3a. Short-circuit on error-class loader / merge diagnostics
 *      before running plugin merger — avoids double-reporting
 *      tracker-name-collision when both surfaces detect it.
 *   4. Apply `config.disabledRules` to the merged `rules` — the plugin
 *      merger handles this for plugin-shipped rules, but
 *      `buildConfig` leaves user/default rules in `config.rules`
 *      untouched on the assumption that the caller (this function)
 *      filters them before handing off to `buildEvaluator`.
 *   5. Run `resolvePlugins` to get the plugin-merger-side diagnostics.
 *   6. Aggregate every diagnostic produced along the way and apply
 *      the strict-mode contract: throw when any error-class
 *      diagnostic is present, throw when any warning-class diagnostic
 *      is present and `failOnWarnings !== false`, otherwise emit
 *      surviving warnings via `console.warn`.
 *
 * Factored out of `register()` so the wiring is unit-testable without
 * a pi runtime stub. The `config` from earlier versions of this
 * function is absorbed into the runtime: the bridge no longer needs
 * to inspect it, and exposing it tempted callers to bypass the
 * strict-mode contract.
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

	// Peek at `disableDefaults` across raw layers without paying for
	// a full merge. `mergeBool` walks layers inner-first and returns the
	// first explicit value, matching `buildConfig`'s precedence.
	const disableDefaults =
		mergeBool(rawLayers, "disableDefaults") === true;
	const defaults: SteeringConfig | undefined = disableDefaults
		? undefined
		: { rules: DEFAULT_RULES, plugins: DEFAULT_PLUGINS };

	// Run buildConfig + resolvePlugins through the shared helper so the
	// short-circuit between the two passes is uniform across
	// `buildSessionRuntime`, `loadHarness`, and the CLI's `runList`.
	const { merged, resolved, diagnostics: mergeAndResolveDiagnostics } =
		runMergerPipeline(
			rawLayers,
			defaults,
			EVALUATOR_BUILTIN_TRACKERS,
		);
	aggregated.push(...mergeAndResolveDiagnostics);

	const failOnWarnings = merged.failOnWarnings;
	const treatWarningsAsErrors = failOnWarnings !== false;

	// Strict-mode contract: error-class diagnostics ALWAYS throw;
	// warning-class diagnostics throw only when `failOnWarnings !==
	// false` (default true). Otherwise warnings fall through to
	// console.warn for legacy fail-soft semantics.
	const hasError = aggregated.some((d) => d.type === "error");
	const hasWarning = aggregated.some((d) => d.type === "warning");
	if (hasError || (treatWarningsAsErrors && hasWarning)) {
		throw new Error(formatAggregatedDiagnostics(aggregated));
	}
	if (hasWarning) {
		// failOnWarnings === false; emit surviving warnings on the
		// legacy console.warn channel so users running with the opt-out
		// still see the message stream that pre-strict-mode code
		// produced. `formatSingleLineDiagnostic` accepts both severities,
		// but here we deliberately only route warnings — errors above
		// already threw via the aggregated form, so reaching this branch
		// with `d.type === "error"` is unreachable. The filter narrows
		// to the warning subtype as a defensive check.
		const warnings = aggregated.filter(
			(d): d is SteeringDiagnostic & { type: "warning" } =>
				d.type === "warning",
		);
		for (const d of warnings) {
			console.warn(formatSingleLineDiagnostic(d));
		}
	}

	// At this point `resolved` cannot be null: the helper only returns
	// `null` when merge-side diagnostics include an error-class entry,
	// and the strict-mode throw above already fired in that case.
	if (resolved === null) {
		throw new Error(
			"[pi-steering] internal: runMergerPipeline " +
				"returned a null resolve without surfacing an error-class " +
				"diagnostic",
		);
	}

	// Apply `disabledRules` to the merged rule set. Plugin-shipped rules
	// are filtered inside `resolvePlugins`; user / default rules go
	// through `config.rules` on the evaluator side, so we filter them
	// here to keep the semantic consistent across both sources.
	const disabled = new Set(merged.disabledRules ?? []);
	const filteredConfig: SteeringConfig = { ...merged };
	if (merged.rules !== undefined) {
		const kept = merged.rules.filter((r) => !disabled.has(r.name));
		if (kept.length > 0) filteredConfig.rules = kept;
		else delete filteredConfig.rules;
	}

	// Drop observers whose declared writes are unconsumed. Applied
	// across plugin-merged observers AND user-authored observers using
	// the union of all rule `happened` references. Dropped observers
	// stop firing on tool_result AND stop contributing speculative
	// entries to the evaluator (single source of truth via this
	// orchestration-layer filter).
	//
	// `console.info` is the only `console.*` call this function makes
	// in steady state. It survives the strict-mode refactor because
	// dropping unused observers is a by-design behavior, not a
	// configuration issue: no rule references the observer's writes,
	// so silently skipping them is the only sensible outcome. The
	// info-level message exists so a plugin author debugging "why
	// isn't my observer firing?" has a breadcrumb to follow without
	// it bubbling up as a diagnostic the user has to action.
	const userObservers = filteredConfig.observers ?? [];
	const allRules = [...(filteredConfig.rules ?? []), ...resolved.rules];
	const pluginDrop = dropUnusedObservers(resolved.observers, allRules);
	const userDrop = dropUnusedObservers(userObservers, allRules);
	for (const d of [...pluginDrop.dropped, ...userDrop.dropped]) {
		console.info(
			`[pi-steering] observer '${d.name}' dropped; its writes ` +
				`(${d.writes.join(", ")}) are not consumed by any rule`,
		);
	}
	const filteredResolved = { ...resolved, observers: [...pluginDrop.kept] };

	const evaluator = buildEvaluator(filteredConfig, filteredResolved, host);
	const dispatcher = buildObserverDispatcher(
		filteredResolved,
		userDrop.kept,
		host,
	);
	return { evaluator, dispatcher };
}
