// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * TS config loader. Walk up cwd → `$HOME`, find `.pi/steering/index.ts`
 * or `.pi/steering.ts` per layer, dynamic-import each, merge
 * inner-first. Per-symbol JSDoc carries the contract; see also the
 * {@link SteeringDiagnostic} / {@link SteeringDiagnosticKind} JSDoc
 * for the diagnostic stream.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { EVALUATOR_BUILTIN_TRACKERS } from "./evaluator.ts";
import { runMergerPipeline } from "./internal/session-runtime.ts";
import { formatTrackerNameCollisionMessage } from "./plugin-merger.ts";
import type {
	Observer,
	Plugin,
	Rule,
	SteeringConfig,
	SteeringDiagnostic,
} from "./schema.ts";

/**
 * Minimum Node version that supports native `.ts` import via type
 * stripping (without a `--experimental-strip-types` flag). Shipped
 * stable in Node 22.6+. We require 22.x outright to keep the error
 * message simple.
 */
const MIN_NODE_MAJOR = 22;

/**
 * Runtime check: throws when Node is older than the minimum required
 * for native `.ts` import. See README §Install for the supported
 * Node range.
 */
function assertNodeVersion(): void {
	const raw = process.versions.node;
	const major = Number.parseInt(raw.split(".")[0] ?? "0", 10);
	if (Number.isNaN(major) || major < MIN_NODE_MAJOR) {
		throw new Error(
			`pi-steering requires Node >= ${MIN_NODE_MAJOR} ` +
				`for native .ts loading (found ${raw}). ` +
				`Upgrade Node, or stay on v1 JSON configs (\`.pi/steering.json\`).`,
		);
	}
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Candidate file paths for a given directory's `.pi/steering/...` slot,
 * in priority order. First existing file wins.
 *
 * Exported for tests — not part of the library's public API.
 */
export function configCandidates(dir: string): string[] {
	return [
		join(dir, ".pi", "steering", "index.ts"),
		join(dir, ".pi", "steering.ts"),
	];
}

/**
 * Return the non-`.ts` files that exist under `<dir>/.pi/steering/` so
 * callers can warn about them. Uses a best-effort fs read: a missing
 * directory returns an empty list.
 */
function unexpectedFilesUnderSteering(dir: string): string[] {
	const steeringDir = join(dir, ".pi", "steering");
	if (!existsSync(steeringDir)) return [];
	try {
		const entries = readdirSync(steeringDir);
		const out: string[] = [];
		for (const name of entries) {
			const full = join(steeringDir, name);
			try {
				const st = statSync(full);
				if (!st.isFile()) continue;
				if (name === "index.ts") continue;
				if (name.endsWith(".ts")) continue; // allow helpers like `rules.ts`
				out.push(full);
			} catch {
				// skip unreadable entry
			}
		}
		return out;
	} catch {
		return [];
	}
}

/**
 * Walk up from `cwd` to `$HOME` (inclusive, or to the filesystem root
 * if HOME is unset / outside the cwd's ancestry), returning the list
 * of directories INNER-FIRST — so `[cwd, cwd/parent, ..., HOME]`.
 *
 * Exported for tests.
 */
export function ancestorChain(cwd: string): string[] {
	const home = process.env["HOME"] ?? "";
	const out: string[] = [];
	const seen = new Set<string>();
	let current = resolve(cwd);
	while (true) {
		if (seen.has(current)) break; // symlink-loop guard
		seen.add(current);
		out.push(current);
		if (current === home || current === "/") break;
		const parent = dirname(current);
		if (parent === current) break; // filesystem root
		current = parent;
	}
	return out;
}

/**
 * Find the config file (if any) for a single layer. Returns the
 * resolved file path and a `layer-form-coexistence` diagnostic when
 * both `.pi/steering/index.ts` and `.pi/steering.ts` coexist in the
 * same directory (the directory form wins).
 *
 * Exported for tests.
 */
export function findConfigFile(dir: string): {
	file: string | null;
	diagnostic: SteeringDiagnostic | null;
} {
	const [indexForm, flatForm] = configCandidates(dir);
	const indexExists = indexForm !== undefined && existsSync(indexForm);
	const flatExists = flatForm !== undefined && existsSync(flatForm);
	let diagnostic: SteeringDiagnostic | null = null;
	if (indexExists && flatExists && indexForm !== undefined) {
		// `path` points at the directory holding the conflict so the
		// renderer's `${path}: ${message}` prefix surfaces the parent
		// once and the message names which two forms coexist. The winning
		// file path is implicit (the directory form always wins).
		diagnostic = {
			type: "warning",
			kind: "layer-form-coexistence",
			path: dir,
			message:
				"both .pi/steering.ts and .pi/steering/index.ts exist; using " +
				"directory form. Delete .pi/steering.ts to remove this warning.",
		};
	}
	if (indexExists) return { file: indexForm ?? null, diagnostic };
	if (flatExists) return { file: flatForm ?? null, diagnostic };
	return { file: null, diagnostic };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Dynamic-import a single config file and return its default export.
 * The module MUST `export default` a {@link SteeringConfig} object —
 * the loader does not accept module-namespace imports as a fallback,
 * to keep the authoring contract unambiguous.
 *
 * Throws a scoped error when the import fails, when the module has no
 * default export, or when the default export isn't a plain object —
 * the caller surfaces these per-layer without bringing the whole
 * session down (a single bad layer shouldn't nuke the engine).
 */
async function importConfigFile(path: string): Promise<SteeringConfig> {
	const url = pathToFileURL(path).href;
	const mod = (await import(url)) as {
		default?: unknown;
	} & Record<string, unknown>;

	if (mod.default === undefined) {
		// Path is intentionally omitted from the message; the caller wraps
		// this throw in a `layer-import-failed` diagnostic whose own `path`
		// field is the single source of truth for the file location.
		throw new Error(
			"config file must have a default export. Use " +
				"`export default { ... } satisfies SteeringConfig` or " +
				"`export default defineConfig({ ... })`.",
		);
	}
	const candidate = mod.default;
	if (
		candidate === null ||
		typeof candidate !== "object" ||
		Array.isArray(candidate)
	) {
		throw new Error(
			`config file default export must be a SteeringConfig object, ` +
				`got ${Array.isArray(candidate) ? "array" : typeof candidate}.`,
		);
	}
	return candidate as SteeringConfig;
}

/**
 * Walk up from `cwd` collecting config layers. Returns INNER-FIRST
 * (caller passes to {@link buildConfig}, which expects inner-first so
 * early entries take precedence on collisions).
 *
 * Issues encountered along the way (per-layer import failure, dual
 * form coexistence, stray non-`.ts` file under `.pi/steering/`)
 * surface as structured {@link SteeringDiagnostic} entries on the
 * returned object. The loader does not log to `console.warn` directly
 * — the bridge runtime owns the policy decision (throw vs. log) once
 * it has collected diagnostics from every source.
 *
 * @throws when Node is older than {@link MIN_NODE_MAJOR}.
 */
export async function loadConfigs(cwd: string): Promise<{
	layers: SteeringConfig[];
	diagnostics: SteeringDiagnostic[];
}> {
	assertNodeVersion();

	const dirs = ancestorChain(cwd);
	const layers: SteeringConfig[] = [];
	const diagnostics: SteeringDiagnostic[] = [];
	for (const dir of dirs) {
		const { file, diagnostic } = findConfigFile(dir);
		if (diagnostic !== null) diagnostics.push(diagnostic);
		if (file === null) {
			// Surface stray files under `.pi/steering/` that the loader
			// won't pick up. Only check when the directory exists but has
			// no `index.ts` — otherwise a project without any steering
			// directory would emit noise.
			const steeringDir = join(dir, ".pi", "steering");
			if (existsSync(steeringDir)) {
				for (const stray of unexpectedFilesUnderSteering(dir)) {
					diagnostics.push({
						type: "warning",
						kind: "layer-stray-file",
						path: stray,
						message: "ignoring non-.ts file under .pi/steering/",
					});
				}
			}
			continue;
		}
		try {
			layers.push(await importConfigFile(file));
		} catch (err) {
			// Use err.message to drop the `Error: ` class prefix; native
			// runtime errors (jiti syntax errors) may embed their path inside
			// the message and we accept that duplication.
			const body = err instanceof Error ? err.message : String(err);
			diagnostics.push({
				type: "warning",
				kind: "layer-import-failed",
				path: file,
				message: `failed to import: ${body}`,
			});
		}
	}
	return { layers, diagnostics };
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/**
 * Collect plugins across layers, recording a diagnostic for each
 * cross-layer duplicate plugin name. First-registered wins (inner
 * layer is first — matches pi's project-local → global convention).
 *
 * The caller is responsible for unioning `config.disabledPlugins`
 * across layers and passing the result as `disabledPlugins` (see
 * `buildConfig`). Plugins whose name appears in the supplied set are
 * still merged into the output (so downstream surfaces like
 * `pi-steering list` can render them tagged as disabled), but they're
 * EXEMPT from collision detection. A user resolving a duplicate-plugin
 * warning by adding the plugin to `disabledPlugins` should see the
 * warning go away in the same config edit; detect-then-disable would
 * still surface the warning even though the disable already settled
 * the conflict.
 */
function mergePlugins(
	layers: readonly SteeringConfig[],
	disabledPlugins: ReadonlySet<string>,
	diagnostics: SteeringDiagnostic[],
): Plugin[] {
	const seen = new Set<string>();
	const out: Plugin[] = [];
	for (const layer of layers) {
		if (!layer.plugins) continue;
		for (const plugin of layer.plugins) {
			if (seen.has(plugin.name)) {
				if (!disabledPlugins.has(plugin.name)) {
					diagnostics.push({
						type: "warning",
						kind: "plugin-name-collision",
						message: `duplicate plugin "${plugin.name}"; keeping first-registered entry.`,
					});
				}
				continue;
			}
			seen.add(plugin.name);
			out.push(plugin);
		}
	}
	return out;
}

/**
 * Merge rules across layers — inner layer's rule name overrides outer.
 * Declaration order within a layer is preserved; cross-layer order is
 * "first layer that mentions a given rule name wins for its slot".
 *
 * Records a diagnostic on duplicate names WITHIN a single layer
 * (authoring mistake) — mirrors {@link mergeObservers}. Cross-layer
 * collisions stay silent: overriding a rule by name is the documented
 * customization path.
 *
 * Disabled rules are merged but exempt from collision detection (see
 * {@link mergePlugins} for rationale).
 */
function mergeRules(
	layers: readonly SteeringConfig[],
	disabledRules: ReadonlySet<string>,
	diagnostics: SteeringDiagnostic[],
): Rule[] {
	const byName = new Map<string, Rule>();
	for (const layer of layers) {
		if (!layer.rules) continue;
		const seenInLayer = new Set<string>();
		for (const rule of layer.rules) {
			if (seenInLayer.has(rule.name)) {
				if (!disabledRules.has(rule.name)) {
					diagnostics.push({
						type: "warning",
						kind: "rule-name-collision",
						message:
							`duplicate rule "${rule.name}" within single config layer; ` +
							"keeping first, dropping subsequent",
					});
				}
				continue;
			}
			seenInLayer.add(rule.name);
			if (!byName.has(rule.name)) {
				byName.set(rule.name, rule);
			}
		}
	}
	return [...byName.values()];
}

/**
 * Merge observers across layers — inner layer's observer name
 * overrides outer. Records a diagnostic on duplicate names WITHIN a
 * single layer (authoring mistake); cross-layer overrides are silent
 * (intentional customization).
 */
function mergeObservers(
	layers: readonly SteeringConfig[],
	diagnostics: SteeringDiagnostic[],
): Observer[] {
	const byName = new Map<string, Observer>();
	for (const layer of layers) {
		if (!layer.observers) continue;
		const seenInLayer = new Set<string>();
		for (const obs of layer.observers) {
			if (seenInLayer.has(obs.name)) {
				diagnostics.push({
					type: "warning",
					kind: "observer-name-collision",
					message: `duplicate observer "${obs.name}"; keeping first-registered entry.`,
				});
				continue;
			}
			seenInLayer.add(obs.name);
			if (!byName.has(obs.name)) {
				byName.set(obs.name, obs);
			}
		}
	}
	return [...byName.values()];
}

/**
 * Merge simple string-list fields (`disabledRules`, `disabledPlugins`)
 * as a union across layers. Preserves first-seen order for deterministic
 * output in tests.
 */
function mergeStringUnion(
	layers: readonly SteeringConfig[],
	key: "disabledRules" | "disabledPlugins",
): string[] | undefined {
	const seen = new Set<string>();
	let any = false;
	for (const layer of layers) {
		const list = layer[key];
		if (list === undefined) continue;
		any = true;
		for (const item of list) seen.add(item);
	}
	return any ? [...seen] : undefined;
}

/**
 * Inner-wins boolean merge over walked-up layers. Walks left-to-right
 * (inner-first); returns the first explicit boolean or `undefined`.
 * Used by `buildConfig` and the session runtime for the inner-wins
 * boolean fields. Internal — not in the package's `exports` surface.
 */
export function mergeBool(
	layers: readonly SteeringConfig[],
	key: "defaultNoOverride" | "disableDefaults" | "failOnWarnings",
): boolean | undefined {
	for (const layer of layers) {
		const v = layer[key];
		if (typeof v === "boolean") return v;
	}
	return undefined;
}

/**
 * Detect plugins registering a tracker under the same name and push
 * an error-class diagnostic for each collision. Two plugins claiming
 * the same state dimension is always a bug; the runtime escalates
 * these to a thrown error regardless of the user's strict-mode
 * preference.
 *
 * Plugins whose name appears in `disabledPlugins` are skipped before
 * collision detection (mirrors {@link mergePlugins}).
 */
function detectTrackerNameCollisions(
	plugins: readonly Plugin[],
	disabledPlugins: ReadonlySet<string>,
	diagnostics: SteeringDiagnostic[],
): void {
	const seen = new Map<string, string>(); // trackerName -> pluginName
	for (const plugin of plugins) {
		if (disabledPlugins.has(plugin.name)) continue;
		if (!plugin.trackers) continue;
		for (const trackerName of Object.keys(plugin.trackers)) {
			const prior = seen.get(trackerName);
			if (prior !== undefined) {
				diagnostics.push({
					type: "error",
					kind: "tracker-name-collision",
					message: formatTrackerNameCollisionMessage(
						prior,
						plugin.name,
						trackerName,
					),
				});
				continue;
			}
			seen.set(trackerName, plugin.name);
		}
	}
}

/**
 * Merge `layers` (inner-first) into a single effective
 * {@link SteeringConfig}. An optional `defaults` config is treated as
 * the OUTERMOST layer — its fields apply when no real layer specifies
 * them, otherwise real layers override.
 *
 * Cross-layer plugin name collisions, within-layer rule + observer
 * name collisions, and cross-layer tracker name collisions surface
 * as structured {@link SteeringDiagnostic} entries on the returned
 * object. Predicate-key + tracker-extension collisions are detected
 * in `resolvePlugins`, not here — buildConfig handles cross-layer and
 * within-layer name-collision shapes only.
 */
export function buildConfig(
	layers: readonly SteeringConfig[],
	defaults?: SteeringConfig,
): { config: SteeringConfig; diagnostics: SteeringDiagnostic[] } {
	// Build the effective inner-first layer list. `defaults` goes at
	// the END (outermost position) so inner real layers override it.
	const effective: SteeringConfig[] = [...layers];
	if (defaults !== undefined) effective.push(defaults);

	const diagnostics: SteeringDiagnostic[] = [];

	const disabledPluginsList = mergeStringUnion(effective, "disabledPlugins");
	const disabledRulesList = mergeStringUnion(effective, "disabledRules");
	const disabledPluginsSet = new Set(disabledPluginsList ?? []);
	const disabledRulesSet = new Set(disabledRulesList ?? []);

	// Predicate + tracker-extension collisions are detected in
	// resolvePlugins, not here. buildConfig handles cross-layer and
	// within-layer name-collision shapes only.
	const plugins = mergePlugins(effective, disabledPluginsSet, diagnostics);
	detectTrackerNameCollisions(plugins, disabledPluginsSet, diagnostics);

	const rules = mergeRules(effective, disabledRulesSet, diagnostics);
	const observers = mergeObservers(effective, diagnostics);

	const out: SteeringConfig = {};
	if (plugins.length > 0) out.plugins = plugins;
	if (rules.length > 0) out.rules = rules;
	if (observers.length > 0) out.observers = observers;

	if (disabledRulesList !== undefined) out.disabledRules = disabledRulesList;
	if (disabledPluginsList !== undefined) {
		out.disabledPlugins = disabledPluginsList;
	}

	const defaultNoOverride = mergeBool(effective, "defaultNoOverride");
	if (defaultNoOverride !== undefined) {
		out.defaultNoOverride = defaultNoOverride;
	}
	const disableDefaults = mergeBool(effective, "disableDefaults");
	if (disableDefaults !== undefined) out.disableDefaults = disableDefaults;
	const failOnWarnings = mergeBool(effective, "failOnWarnings");
	if (failOnWarnings !== undefined) out.failOnWarnings = failOnWarnings;

	return { config: out, diagnostics };
}

/**
 * Convenience: load all layers for `cwd`, run the loader-side merge
 * (`buildConfig`), then the plugin merger (`resolvePlugins`) with
 * user-config rule + observer name validation between the two passes.
 * Diagnostics from every surface flow into a single returned array,
 * so an external embedder writing their own bridge or pre-flight
 * check sees the SAME diagnostic stream the production runtime sees
 * — no surface is silently skipped.
 *
 * Diagnostics return in declaration order; merge-side errors
 * short-circuit `resolvePlugins` before its diagnostics are added.
 *
 * Production-strictness divergence: `loadSteeringConfig` does NOT
 * apply the strict-mode `failOnWarnings` throw policy that
 * `buildSessionRuntime` does. The function never throws on
 * diagnostics; embedders apply their own throw + warning policy.
 * See `failOnWarnings` on {@link SteeringConfig} for production-
 * faithful pre-flight semantics.
 *
 * @throws when Node < {@link MIN_NODE_MAJOR} (propagated from
 * `loadConfigs`).
 */
export async function loadSteeringConfig(
	cwd: string,
	defaults?: SteeringConfig,
): Promise<{ config: SteeringConfig; diagnostics: SteeringDiagnostic[] }> {
	const { layers, diagnostics: loaderDiagnostics } = await loadConfigs(cwd);
	const { merged, diagnostics: mergeAndResolveDiagnostics } =
		runMergerPipeline(
			layers,
			defaults,
			EVALUATOR_BUILTIN_TRACKERS,
		);
	return {
		config: merged,
		diagnostics: [...loaderDiagnostics, ...mergeAndResolveDiagnostics],
	};
}
