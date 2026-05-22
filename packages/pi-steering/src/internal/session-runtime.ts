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
	type EvaluatorRuntime,
	type EvaluatorHost,
} from "../evaluator.ts";
import { buildConfig, loadConfigs } from "../loader.ts";
import {
	buildObserverDispatcher,
	type ObserverDispatcher,
} from "../observer-dispatcher.ts";
import { resolvePlugins } from "../plugin-merger.ts";
import type { SteeringConfig, SteeringDiagnostic } from "../schema.ts";
import { dropUnusedObservers } from "./drop-unused-observers.ts";

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
 * Render a single warning-class diagnostic in the legacy single-line
 * shape used when the user opts out of strict mode via
 * `failOnWarnings: false`. Mirrors the previous `console.warn` shape
 * the loader emitted directly.
 */
function formatLegacyConsoleWarn(d: SteeringDiagnostic): string {
	const pathPrefix = d.path !== undefined ? `${d.path}: ` : "";
	return `[pi-steering] ${pathPrefix}${d.message}`;
}

/**
 * Build the per-session evaluator + observer dispatcher from the walk-
 * up config rooted at `cwd`. Two-pass merge so `disableDefaults: true`
 * in any layer is honored before defaults are injected:
 *
 *   1. `loadConfigs(cwd)` — async IO, read every layer from cwd →
 *      $HOME.
 *   2. `buildConfig(layers)` with NO defaults — lets us peek at the
 *      merged `disableDefaults` flag without DEFAULT_RULES /
 *      DEFAULT_PLUGINS polluting the result. Diagnostics from this
 *      probe are discarded; the second buildConfig pass produces the
 *      authoritative diagnostic stream.
 *   3. Re-run `buildConfig(layers, defaults?)` with defaults
 *      conditional on `disableDefaults`, producing the effective
 *      config.
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

	// First merge without defaults: we only need `disableDefaults` at
	// this point, and layering defaults in would make the check
	// meaningless (defaults shouldn't themselves opt into
	// `disableDefaults`). Probe diagnostics are discarded; the second
	// pass below produces the authoritative diagnostic stream so we
	// don't double-report.
	const { config: probe } = buildConfig(rawLayers);
	const defaults: SteeringConfig | undefined = probe.disableDefaults
		? undefined
		: { rules: DEFAULT_RULES, plugins: DEFAULT_PLUGINS };
	const { config: merged, diagnostics: mergeDiagnostics } = buildConfig(
		rawLayers,
		defaults,
	);
	aggregated.push(...mergeDiagnostics);

	const failOnWarnings = merged.failOnWarnings;
	const treatWarningsAsErrors = failOnWarnings !== false;

	// Short-circuit on error-class diagnostics produced by the loader
	// or buildConfig BEFORE running resolvePlugins. The loader and the
	// merger both detect tracker-name collisions; running the merger
	// after the loader has already flagged one would emit a duplicate
	// diagnostic. Bail out here with the aggregated render so users see
	// every diagnostic at once without double-reporting.
	if (aggregated.some((d) => d.type === "error")) {
		throw new Error(formatAggregatedDiagnostics(aggregated));
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

	const resolved = resolvePlugins(
		filteredConfig.plugins ?? [],
		filteredConfig,
		// `cwd` and `env` are injected by the evaluator (built-in
		// cwdTracker + envTracker); extensions targeting them are valid
		// and must not be treated as orphans. Any other built-in tracker
		// the evaluator introduces later should be added here.
		["cwd", "env"],
	);
	aggregated.push(...resolved.diagnostics);

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
		// produced.
		for (const d of aggregated) {
			if (d.type === "warning") {
				console.warn(formatLegacyConsoleWarn(d));
			}
		}
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
