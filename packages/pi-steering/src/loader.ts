// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * TS-only config loader — walk-up discovery + merge.
 *
 * Per the accepted ADR ("Design → File layout and loader behavior"):
 *
 *   - Walk up from the session cwd to `$HOME` (inclusive), checking each
 *     layer for `.pi/steering/index.ts` FIRST, then `.pi/steering.ts`.
 *     First hit wins per layer. A bare `<ancestor>/steering.ts` is
 *     intentionally NOT discovered.
 *   - Inner (closer to session cwd) layers take precedence on name
 *     collisions — matches pi's project-local → global convention and
 *     the v1 JSON loader's inner-over-outer semantics.
 *   - Node ≥ 22 required (native type-stripping via `await import()`).
 *     Loader throws a clear "upgrade Node" error on older runtimes.
 *   - File extensions: `.ts` only. Other files under `.pi/steering/` are
 *     warned about and skipped — a user might keep helpers there.
 *
 * Merge semantics ({@link buildConfig}):
 *
 *   - `rules`:            concat; inner layer's rule name overrides outer's.
 *   - `plugins`:          concat in declaration order; inner layers first.
 *   - `observers`:        concat; inner name overrides outer.
 *   - `disabledRules`,
 *     `disabledPlugins`:  union across layers.
 *   - `defaultNoOverride`,
 *     `disableDefaults`:  inner wins if set.
 *
 * Engine hard-errors on tracker NAME collisions (two plugins both
 * registering a tracker called `branch`); soft-warns on all other
 * collisions (rule name, observer name, predicate key, tracker-extension
 * `(tracker, basename)` pair).
 *
 * NOTE: this module loads + merges CONFIG SHAPES. It does NOT execute
 * predicates, observers, or resolve plugin wiring. Those are Phase 3's
 * evaluator concerns.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
 * Runtime check: throws with an actionable message when Node is older
 * than the minimum supported version.
 *
 * Note: native TS type-stripping shipped stable in Node 22.6+. On Node
 * 22.0–22.5, dynamic import of `.ts` files requires the
 * `--experimental-strip-types` runtime flag; without it, imports fail
 * with `ERR_UNKNOWN_FILE_EXTENSION`. The error is caught at the per-layer
 * boundary and logged, but users seeing repeated import failures on Node
 * 22.0–22.5 should either upgrade Node or add the flag to their pi
 * invocation.
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
 * resolved file path plus an optional diagnostic when both candidate
 * forms coexist at the same directory.
 *
 * When BOTH `.pi/steering/index.ts` AND `.pi/steering.ts` exist in
 * the same directory the directory form wins, but ambiguous
 * coexistence is almost always an authoring mistake (forgotten
 * cleanup, stale file). The returned diagnostic gives callers a
 * structured handle on that case so they can plumb it into the
 * aggregate diagnostics array instead of reporting via
 * `console.warn`.
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
		throw new Error(
			`Config file ${path} must have a default export. Use ` +
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
			`Config file ${path} default export must be a SteeringConfig object, ` +
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
 * Errors within a single layer (bad default export, import failure)
 * are recorded as `kind: "layer-import-failed"` diagnostics and the
 * layer is skipped — a broken ancestor config shouldn't prevent the
 * session from starting with a sensible subset.
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
			// won't pick up (e.g. `.js`, `.mjs`, `.mts`). Only check when
			// the directory exists but has no `index.ts` — otherwise a
			// project without any steering directory would emit noise.
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
			diagnostics.push({
				type: "warning",
				kind: "layer-import-failed",
				path: file,
				message: `failed to import: ${String(err)}`,
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
 * Plugins whose name appears in the union of every layer's
 * `disabledPlugins` are still merged into the output (so downstream
 * surfaces like `pi-steering list` can render them tagged as
 * disabled), but they're EXEMPT from collision detection. A user
 * resolving a duplicate-plugin warning by adding the plugin to
 * `disabledPlugins` should see the warning go away in the same
 * config edit; detect-then-disable would still surface the warning
 * even though the disable already settled the conflict.
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
 * Rules whose name appears in the union of every layer's
 * `disabledRules` are still merged into the output (so downstream
 * surfaces like `pi-steering list` can render them tagged as
 * disabled), but they're EXEMPT from collision detection. Mirrors
 * the disabledPlugins handling in {@link mergePlugins}.
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
			// Else: an inner layer already placed this rule. We intentionally
			// do NOT record a diagnostic here — overriding a rule by name is
			// the documented way to customize behavior from an outer layer.
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
 * Merge a boolean field across layers using inner-wins precedence.
 * Inner wins. If no layer specifies the field AND the caller
 * supplied a `defaults` config, that layer's value is used (since
 * `defaults` is appended at the END of the inner-first layer list).
 * Otherwise returns `undefined` — buildConfig callers typically
 * coerce the final undefined according to field-specific semantics
 * (e.g. evaluator-side `defaultNoOverride ?? true` fail-closed,
 * runtime-side `failOnWarnings !== false` strict-default).
 *
 * NOTE we intentionally do NOT bake field-specific defaults into the
 * merged config here. The merged config reflects what the user
 * declared; consumers apply the appropriate fallback at use time.
 * Keeping the two concerns separate lets tests assert "layers were
 * merged correctly" without also asserting "the field-specific
 * default was applied".
 *
 * Exported for the bridge runtime, which needs to peek at
 * `disableDefaults` before deciding whether to layer in
 * DEFAULT_RULES / DEFAULT_PLUGINS, and at `failOnWarnings` before
 * deciding the strict-mode throw policy.
 */
export function mergeBool(
	layers: readonly SteeringConfig[],
	key: "defaultNoOverride" | "disableDefaults" | "failOnWarnings",
): boolean | undefined {
	// Layers are passed inner-first. Walk left-to-right and keep the
	// FIRST layer that sets the field — that's the innermost explicit
	// value.
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
 * collision detection so a user resolving the error by following the
 * diagnostic's own remedy ("disable one plugin") sees the diagnostic
 * go away in the same edit. Mirrors the disable-then-detect ordering
 * in {@link mergePlugins} and {@link mergeRules}.
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
					message:
						`tracker name collision: both plugins "${prior}" and ` +
						`"${plugin.name}" register a tracker called "${trackerName}". ` +
						"Two plugins claiming the same state dimension is always a " +
						"bug — rename one tracker or disable one plugin.",
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

	// Compute the disable-sets up-front so the merge passes can drop
	// disabled entities BEFORE running collision detection. A user
	// resolving a duplicate-plugin warning by adding the plugin to
	// `disabledPlugins` should see the warning go away in the same
	// config edit — detect-then-disable would still surface the
	// warning even though the disable already settled the conflict.
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
 * Convenience: load all layers for `cwd`, then merge with optional
 * `defaults`. Equivalent to running {@link loadConfigs} then
 * {@link buildConfig} and concatenating their diagnostics arrays
 * — returns the same `{ config, diagnostics }` shape "the loader saw
 * EVERYTHING up to the runtime hand-off" so callers don't have to
 * stitch the two diagnostic streams together themselves.
 *
 * The runtime (`buildSessionRuntime`) does NOT use this wrapper
 * directly because it needs the raw layer list for the two-pass
 * disable-defaults probe. External callers building their own
 * extensions or CLIs that want the full merged config + diagnostics
 * in one call should reach for this.
 */
export async function loadSteeringConfig(
	cwd: string,
	defaults?: SteeringConfig,
): Promise<{ config: SteeringConfig; diagnostics: SteeringDiagnostic[] }> {
	const { layers, diagnostics: loaderDiagnostics } = await loadConfigs(cwd);
	const { config, diagnostics: mergeDiagnostics } = buildConfig(
		layers,
		defaults,
	);
	return {
		config,
		diagnostics: [...loaderDiagnostics, ...mergeDiagnostics],
	};
}
