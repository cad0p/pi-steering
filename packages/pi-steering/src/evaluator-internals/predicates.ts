// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Predicate evaluators for the v2 engine.
 *
 * Three public entry points:
 *
 *   - {@link matchesPatternOrFn}  — resolves `pattern` / `requires` /
 *                                    `unless` values against a target
 *                                    string.
 *   - {@link evaluateWhen}        — walks a {@link WhenClause} tree,
 *                                    dispatching built-in (`cwd`, `not`,
 *                                    `condition`) + plugin-registered
 *                                    predicates.
 *   - {@link UnknownPredicateError} — thrown when a WhenClause names a
 *                                    predicate nobody registered. Kept as
 *                                    a named error so callers can catch
 *                                    it by type; the message includes the
 *                                    offending key.
 *
 * The walker's `cwdTracker.unknown` sentinel is `"unknown"`. That's the
 * string we compare against for `onUnknown` policy application on the
 * built-in `cwd` predicate. Plugin-registered trackers emit their own
 * unknown sentinels; handling those is the plugin handler's job.
 */

import type {
	Pattern,
	PredicateContext,
	PredicateFn,
	PredicateHandler,
	PredicateModifiers,
	PredicateVerdict,
	ReservedPredicateKey,
	TopLevelWhenClause,
	TopLevelWhenClauseNoRecurse,
	WhenClause,
} from "../schema.ts";
import { isPattern } from "../internal/pattern-utils.ts";
import { AGENT_LOOP_INDEX_KEY } from "./context.ts";
import type { SyntheticEntry } from "./speculative-synthesis.ts";

// ---------------------------------------------------------------------------
// Reserved predicate keys (runtime mirror of `ReservedPredicateKey`)
// ---------------------------------------------------------------------------

/**
 * Runtime list of predicate keys that plugins are NOT allowed to
 * register. Mirrors the type-level {@link ReservedPredicateKey} from
 * `schema.ts`. Adding a new modifier to {@link PredicateModifiers} OR a
 * new operator field requires updating both this list and the matching
 * type union; the {@link reservedPredicateKeysCoverReservedTypes}
 * sync-pinning test in `evaluator.test.ts` fails when the two drift.
 *
 * The engine (in the plugin merger) throws at plugin-registration time
 * if a plugin attempts a reserved key, with a concrete error message
 * pointing the plugin author at the collision and suggesting an
 * alternative name.
 */
export const RESERVED_PREDICATE_KEYS = [
	// Operator fields (must mirror schema.ts's `OperatorField` union).
	"not",
	// Modifier keys (must mirror `keyof PredicateModifiers`).
	"onUnknown",
] as const satisfies readonly ReservedPredicateKey[];

/**
 * Type-level assertion that {@link RESERVED_PREDICATE_KEYS} covers
 * every member of {@link ReservedPredicateKey}. If a future modifier or
 * operator is added without updating the runtime list, the
 * `_RESERVED_PREDICATE_KEYS_COVERS_TYPE` constant fails to typecheck
 * (assignability is in the wrong direction). The constant is
 * `_`-prefixed and never read at runtime; its sole job is to fail
 * compilation when the two surfaces drift.
 */
type _ReservedKeyCoverage =
	ReservedPredicateKey extends (typeof RESERVED_PREDICATE_KEYS)[number]
		? true
		: false;
const _RESERVED_PREDICATE_KEYS_COVERS_TYPE: _ReservedKeyCoverage = true;
void _RESERVED_PREDICATE_KEYS_COVERS_TYPE;

/**
 * Whether a string key is reserved (cannot be used as a plugin
 * predicate name). Used by the plugin merger and by
 * {@link validateWhenClauseShape} when computing the leaf-key set of
 * a `not:` block.
 */
export function isReservedPredicateKey(
	key: string,
): key is ReservedPredicateKey {
	return (RESERVED_PREDICATE_KEYS as readonly string[]).includes(key);
}

// ---------------------------------------------------------------------------
// When-clause shape validation (config-resolve time)
// ---------------------------------------------------------------------------

/**
 * Throws if a `when:` or `not:` block contains no predicate-leaf keys
 * after stripping modifier keys.
 *
 * Catches three foot-guns at config-resolve time so the engine never
 * has to silently skip a malformed clause:
 *   - `when: {}` — zero keys.
 *   - `not: { onUnknown: "block" }` — one key, but it's a modifier; no
 *     leaves means the block has nothing to evaluate.
 *   - `when: { not: { not: ... } }` — nested `not:` inside a not-block,
 *     authored via JSON load or `as any` escape hatch (the type-level
 *     ban via {@link TopLevelWhenClauseNoRecurse} catches authoring-
 *     time mistakes; the same recursion catches the JSON / `as any`
 *     escape hatch).
 *
 * The `not:` operator field itself counts as a leaf at the outer
 * `when:` level (it produces a verdict via Kleene composition of the
 * inner not-block); only modifier keys are stripped. Built-in
 * non-registry keys (`condition`, `happened`, `cwd`) count as leaves;
 * plugin-registered predicates count as leaves regardless of whether
 * the plugin is currently loaded — the unknown-predicate check fires
 * later via {@link UnknownPredicateError}.
 *
 * Recurses into the `not:` block to enforce the same shape there.
 *
 * `path` describes the call site for error messages, e.g.
 * `'rule "no-main-commit".when'` or `'rule "no-git-worktree".when.not'`.
 */
export function validateWhenClauseShape(
	block: TopLevelWhenClause<string> | undefined,
	path: string,
): void {
	if (block === undefined) return;
	let leafKeys = 0;
	for (const key of Object.keys(block)) {
		const v = (block as Record<string, unknown>)[key];
		if (v === undefined) continue;
		// Strip modifier keys only — the operator field `not:` produces a
		// verdict via Kleene composition of the inner not-block, so it
		// counts as a leaf for the outer level's leaf-count.
		if (isModifierKey(key)) continue;
		leafKeys += 1;
	}
	if (leafKeys === 0) {
		throw new Error(
			`[pi-steering] ${path} contains no predicate leaves; ` +
				`a clause must contain at least one predicate (cwd:, branch:, ` +
				`commitsAhead:, condition:, happened:, not:, etc.). Modifier keys ` +
				`(${MODIFIER_KEYS.join(", ")}) alone are not enough — add a leaf ` +
				`or remove the empty clause.`,
		);
	}
	// Recurse into the `not:` block. `condition:` is a function leaf,
	// no recursion. Other plugin keys can carry nested objects (e.g.
	// the built-in `happened` shape) but those aren't when-clauses, so
	// recursion is scoped to the `not:` operator only.
	const notBlock = (block as { not?: unknown }).not;
	if (notBlock !== undefined && typeof notBlock === "object" && notBlock !== null) {
		// Reject nested `not:` at runtime. The type-level ban
		// ({@link TopLevelWhenClauseNoRecurse} omits the `not?:` field)
		// catches authoring-time mistakes, but JSON-loaded configs and
		// `as any` escape hatches can author the shape; without this
		// guard the engine's reserved-key skip would silently drop the
		// inner `not:` (zero verdicts → vacuous true → outer not-flip =
		// false → rule never fires).
		if ("not" in notBlock && (notBlock as { not?: unknown }).not !== undefined) {
			throw new Error(
				`[pi-steering] '${path}.not' contains a nested 'not:' key. ` +
					`Use a single 'not:' wrapper; nested 'not: { not: ... }' is ` +
					`semantically equivalent to the unwrapped form and is forbidden ` +
					`by the schema.`,
			);
		}
		validateWhenClauseShape(
			notBlock as TopLevelWhenClause<string>,
			`${path}.not`,
		);
	}
}

/**
 * Modifier-only subset of {@link RESERVED_PREDICATE_KEYS} — used by
 * {@link validateWhenClauseShape} to strip modifiers when counting
 * leaves. Operator fields (currently `"not"`) are NOT modifiers; they
 * produce verdicts and count as leaves.
 *
 * Type-level coverage assertion (mirrors the
 * {@link _RESERVED_PREDICATE_KEYS_COVERS_TYPE} pattern): the
 * `satisfies readonly (keyof PredicateModifiers)[]` clause pins each
 * entry to a real modifier key, AND the
 * {@link _MODIFIER_KEYS_COVERS_TYPE} constant fails compilation if a
 * future modifier (e.g. a hypothetical v0.2 `priority?: number`) is
 * added to {@link PredicateModifiers} without updating this list.
 * Without the lockstep check, the new modifier would be counted as a
 * leaf by {@link validateWhenClauseShape}, masking empty-clause
 * configs that are now "only modifiers, no real leaves."
 */
const MODIFIER_KEYS = ["onUnknown"] as const satisfies readonly (keyof PredicateModifiers)[];

/**
 * Type-level assertion that {@link MODIFIER_KEYS} covers every
 * member of `keyof PredicateModifiers`. Mirrors the
 * {@link _RESERVED_PREDICATE_KEYS_COVERS_TYPE} pattern — the constant
 * is `_`-prefixed and never read at runtime; its sole job is to fail
 * compilation when a new modifier is added without updating the
 * runtime list.
 */
type _ModifierKeyCoverage =
	keyof PredicateModifiers extends (typeof MODIFIER_KEYS)[number] ? true : false;
const _MODIFIER_KEYS_COVERS_TYPE: _ModifierKeyCoverage = true;
void _MODIFIER_KEYS_COVERS_TYPE;

function isModifierKey(key: string): boolean {
	return (MODIFIER_KEYS as readonly string[]).includes(key);
}

// ---------------------------------------------------------------------------
// Pattern / PredicateFn resolution
// ---------------------------------------------------------------------------

/**
 * Regex-compile cache: reuses the same RegExp object for the same string
 * source. Rule patterns are typically long-lived; caching avoids
 * recompilation on every tool_call while still being safe for ad-hoc
 * patterns (weak in the worst case, Map in practice).
 *
 * Module-scoped so it lives across evaluator instances — same rule
 * definition in two configs produces the same RegExp. Cheap enough
 * we don't bother with eviction.
 */
const REGEX_CACHE = new Map<string, RegExp>();

function compileRegex(source: string): RegExp {
	const hit = REGEX_CACHE.get(source);
	if (hit !== undefined) return hit;
	const re = new RegExp(source);
	REGEX_CACHE.set(source, re);
	return re;
}

/**
 * Match a string against a {@link Pattern} (string source or RegExp).
 * Patterns are compiled once and cached; RegExps pass through.
 */
export function matchesPattern(pattern: Pattern, target: string): boolean {
	if (pattern instanceof RegExp) return pattern.test(target);
	return compileRegex(pattern).test(target);
}

/**
 * Evaluate a rule-level predicate (`pattern`, `requires`, `unless`).
 *
 * Accepts the same union v1's `Rule` supported plus {@link PredicateFn}:
 *   - `string` / `RegExp` → pattern match against `target`.
 *   - `function`          → call with `ctx`, coerce result to boolean.
 */
export async function matchesPatternOrFn(
	value: Pattern | PredicateFn,
	target: string,
	ctx: PredicateContext,
): Promise<boolean> {
	if (typeof value === "function") {
		const r = await value(ctx);
		return Boolean(r);
	}
	return matchesPattern(value, target);
}

// ---------------------------------------------------------------------------
// WhenClause dispatch
// ---------------------------------------------------------------------------

/**
 * Thrown when a {@link WhenClause} references a predicate name that no
 * plugin has registered. The error message includes the offending key
 * so the source of the typo / missing plugin is clear at the site of
 * the rule.
 *
 * Schema-level typo detection doesn't cover this because the
 * `WhenClause` index signature is deliberately loose (`unknown`) — per
 * the ADR, plugin predicates can accept arbitrary arg shapes. The
 * trade-off is that we surface the error at evaluation time instead of
 * load time; the key-scoped message keeps that tolerable.
 */
export class UnknownPredicateError extends Error {
	readonly key: string;
	constructor(key: string) {
		super(
			`[pi-steering] unknown when.${key} predicate — ` +
				`no plugin registered a handler for this key. ` +
				`Check for typos, or add a plugin that provides "${key}".`,
		);
		this.name = "UnknownPredicateError";
		this.key = key;
	}
}

/**
 * Built-in `when.cwd` predicate. Accepts shorthand `Pattern`,
 * shorthand `Pattern[]` (OR-of-matches), or the object form
 * `{ pattern: Pattern | Pattern[]; onUnknown? }`. Returns a trinary
 * {@link PredicateVerdict}: `true` / `false` for definite matches
 * against the walker-resolved cwd, or `"unknown"` when the walker's
 * `cwdTracker` couldn't resolve the effective cwd statically (the
 * cwd-tracker `"unknown"` sentinel).
 *
 * The `onUnknown:` modifier on the object form is NOT consumed here.
 * Trinary unknown is surfaced to the caller; the leaf-trinary adapter
 * (outer level) or the not-block evaluator (inner level) applies the
 * `onUnknown:` policy uniformly across leaves.
 *
 * Array semantics: OR-of-matches (predicate matches when the resolved
 * cwd matches ANY of the listed patterns). Empty arrays are invalid
 * (returns `false`); arrays containing non-Pattern values are invalid
 * (returns `false`). Asymmetry: a malformed non-array scalar (e.g.
 * `cwd: 123`) keeps the pre-extension fail-CLOSED behavior — under
 * unknown cwd the predicate surfaces `"unknown"`; under known cwd the
 * trailing `matchesPattern` regex-coercion almost always falls through
 * to `false`. See inline comments for the empirical regex-character-
 * class rationale.
 *
 * Fast path: the common shorthand form `when.cwd: /regex/` (or a
 * string pattern) is read directly — no normalization object
 * allocated. Only the object form `{ pattern, onUnknown }` takes the
 * slightly-slower path of reading the pattern field.
 */
function evaluateCwd(
	value: unknown,
	walkerCwd: string,
): PredicateVerdict {
	// Shorthand Pattern form (string or RegExp).
	if (typeof value === "string" || value instanceof RegExp) {
		if (walkerCwd === "unknown") return "unknown";
		return matchesPattern(value, walkerCwd);
	}
	// Shorthand Pattern[] form (non-empty, all-Pattern).
	if (Array.isArray(value) && value.every(isPattern)) {
		if (value.length === 0) return false; // empty array invalid → rule skips
		if (walkerCwd === "unknown") return "unknown";
		return value.some((p) => matchesPattern(p, walkerCwd));
	}
	// Object form: { pattern: Pattern | Pattern[]; onUnknown? } — the
	// `onUnknown:` modifier is consumed by the caller-side leaf adapter,
	// not here. We surface trinary unknown uniformly.
	if (
		value !== null &&
		typeof value === "object" &&
		"pattern" in (value as Record<string, unknown>)
	) {
		const obj = value as { pattern: unknown };
		if (isPattern(obj.pattern)) {
			if (walkerCwd === "unknown") return "unknown";
			return matchesPattern(obj.pattern, walkerCwd);
		}
		if (Array.isArray(obj.pattern) && obj.pattern.every(isPattern)) {
			if (obj.pattern.length === 0) return false;
			if (walkerCwd === "unknown") return "unknown";
			return obj.pattern.some((p) => matchesPattern(p, walkerCwd));
		}
	}
	// Explicit fail-skip for array-shaped input that isn't all-Pattern.
	// Without this, `cwd: [/foo/, 123]` falls through to the malformed
	// shorthand path below — `new RegExp(String([/foo/, 123]))` compiles
	// to `/\/foo\/,123/`, which only matches paths containing the
	// literal substring `/foo/,123` (effectively skip under known cwd),
	// but the unknown-cwd branch still surfaces unknown. Asymmetric with
	// the gitPlugin sites' clean null-→-skip path; pin uniformly.
	if (Array.isArray(value)) return false;
	// Object that fell out of the object-form branch (e.g.
	// `{ pattern: [/foo/, 123] }` or `{ pattern: 123 }`) — fail-skip
	// uniformly with the array-shorthand and the gitPlugin sites'
	// null-→-skip path. Without this guard, the trailing
	// `matchesPattern(value as Pattern, walkerCwd)` would silently
	// regex-coerce the malformed object via `String(obj)` →
	// `"[object Object]"`, which JS parses as a single character class
	// `/[object Object]/` matching any of {b, c, e, j, o, t, space, O}.
	// Under known cwd that regex matches almost every real path — silent
	// fail-OPEN-fire, masking the config error. The unknown-cwd branch
	// surfacing unknown is also asymmetric with the shorthand-array
	// malformed path that fail-skips uniformly. This guard makes
	// object-form malformed input skip uniformly.
	if (value !== null && typeof value === "object") return false;
	// Malformed non-array input — treat as fail-closed shorthand attempt
	// (preserves existing pre-extension behavior for non-array malformed
	// values: under unknown cwd, surface unknown; under known cwd,
	// attempt a regex coercion which almost certainly produces `false`).
	if (walkerCwd === "unknown") return "unknown";
	return matchesPattern(value as Pattern, walkerCwd);
}

/**
 * Built-in `when.happened` predicate. Merges real session entries
 * (from `ctx.findEntries`, scope-filtered) with speculative entries
 * (from `ctx.walkerState.events[event]`, produced by the walker-level
 * synthesis pass — see {@link synthesizeSpeculativeEntries}) and
 * returns **true when the unified timeline says the event has NOT
 * happened** — i.e. the rule should fire.
 *
 * Single pipeline: the merge via timestamp ordering collapses the
 * prior two-path structure (specialized tool_call-scope speculative-
 * allow running only on stale/absent real entries) into one uniform
 * sort-and-compare. Synthetic entries carry reserved timestamps above
 * all real entries in the same type (see
 * {@link synthesizeSpeculativeEntries}'s timestamp convention); so on
 * an `&&` chain where the prior ref would produce `event`, the
 * merged timeline correctly treats the event as fresher than any
 * stale real entry of the same type.
 *
 * ADR §5 scope semantics are applied to real entries only —
 * speculative entries are always considered in-scope. Synthetic
 * entries represent "about to happen in the current tool_call", and
 * the current tool_call is always part of the current agent_loop and
 * session, so a scope subset check adds no signal. This also means a
 * rule using `in: "agent_loop"` and a rule using `in: "session"` see
 * the same speculative view (correct — "about to happen" is scope-
 * independent; a speculative entry newer than ALL real entries for
 * the type is newer than any scope subset too).
 *
 * Inversion is handled by the caller via `when.not`. Authors wanting
 * "fires when the event HAS happened" wrap this clause in `not:`.
 */
function evaluateHappened(
	value: unknown,
	ctx: PredicateContext,
	ruleName: string,
): boolean {
	if (
		value === null ||
		typeof value !== "object" ||
		!("event" in value) ||
		!("in" in value)
	) {
		throw new Error(
			`[pi-steering] Rule "${ruleName}": when.happened ` +
				`expected { event: string; in: "agent_loop" | "session" | "tool_call"; since?: string; notIn?: "agent_loop" | "session" | "tool_call" }; ` +
				`got ${JSON.stringify(value)}`,
		);
	}
	const {
		event,
		in: scope,
		since,
		notIn,
	} = value as {
		event: string;
		in: unknown;
		since?: unknown;
		notIn?: unknown;
	};
	// Validate the scope string. The type system says
	// `"agent_loop" | "session" | "tool_call"`, but a typo like
	// `"agentLoop"` slips through TypeScript when the value arrives
	// from a JSON source (import-json CLI, hand-written config, etc.).
	// Surface those as loud runtime errors rather than silent
	// fallthrough.
	if (scope !== "agent_loop" && scope !== "session" && scope !== "tool_call") {
		throw new Error(
			`[pi-steering] Rule "${ruleName}": ` +
				`when.happened.in must be "agent_loop", "session", or "tool_call"; ` +
				`got ${JSON.stringify(scope)}`,
		);
	}
	if (since !== undefined && typeof since !== "string") {
		throw new Error(
			`[pi-steering] Rule "${ruleName}": ` +
				`when.happened.since must be a string if present; ` +
				`got ${JSON.stringify(since)}`,
		);
	}

	// Optional `notIn`: scope-subtraction modifier. Flat string — no
	// nested object shape. Validated here rather than at load time to
	// match the existing unknown-scope validation pattern (engine has no
	// schema-level validation pass).
	let innerScope: "agent_loop" | "session" | "tool_call" | null = null;
	if (notIn !== undefined) {
		if (
			notIn !== "agent_loop" &&
			notIn !== "session" &&
			notIn !== "tool_call"
		) {
			throw new Error(
				`[pi-steering] Rule "${ruleName}": ` +
					`when.happened.notIn must be "agent_loop", "session", or "tool_call"; ` +
					`got ${JSON.stringify(notIn)}`,
			);
		}
		if (notIn === scope) {
			throw new Error(
				`[pi-steering] Rule "${ruleName}": ` +
					`when.happened.in and when.happened.notIn are identical (${JSON.stringify(scope)}); subtraction is empty. Remove the "notIn" modifier.`,
			);
		}
		if (SCOPE_ORDER[notIn] > SCOPE_ORDER[scope]) {
			throw new Error(
				`[pi-steering] Rule "${ruleName}": ` +
					`when.happened.notIn (${JSON.stringify(notIn)}) is a superset of when.happened.in (${JSON.stringify(scope)}); subtraction is empty. Adjust the scopes.`,
			);
		}
		innerScope = notIn;
	}

	const sinceValue = typeof since === "string" ? since : undefined;

	const eventLatest = latestTimestampSubtracted(
		event,
		scope,
		innerScope,
		ctx,
	);
	if (eventLatest === null) {
		// Event absent in the (subtracted) timeline → rule fires.
		return true;
	}
	if (sinceValue === undefined) {
		// Simple presence check: event happened → rule does NOT fire.
		return false;
	}
	const sinceLatest = latestTimestampSubtracted(
		sinceValue,
		scope,
		innerScope,
		ctx,
	);
	if (sinceLatest === null) {
		// Invalidator never written in the (subtracted) timeline →
		// degrade to simple-happened semantics (event wins).
		return false;
	}
	// Both present. Event counts as happened iff its latest entry
	// is strictly newer than the invalidator's.
	return eventLatest <= sinceLatest;
}

/**
 * Latest timestamp across the unified real + speculative timeline
 * for the given customType, with optional set-subtraction against an
 * inner scope. `null` when no entries remain after subtraction.
 *
 * Semantics:
 *   - Outer scope `"tool_call"`: real entries are skipped entirely
 *     (real entries are never "within this one bash invocation");
 *     only speculative entries count. Exactly the existing "about to
 *     happen in THIS command" semantic.
 *   - Outer `"agent_loop"`: real entries scope-filtered by
 *     `_agentLoopIndex`; speculative always included.
 *   - Outer `"session"`: all real entries; speculative always included.
 *
 * When `innerScope` is non-null, the subtraction removes entries that
 * are in `innerScope` from the entry stream BEFORE the timestamp max.
 * Since speculative entries are `tool_call`-scope by construction and
 * `tool_call ⊂ agent_loop ⊂ session`, ANY non-null `innerScope`
 * subtracts all speculative entries. For real entries, the inner
 * scope's membership predicate gates which are excluded.
 *
 * Invariant (enforced by {@link evaluateHappened}'s validation):
 * `innerScope === null` OR `SCOPE_ORDER[innerScope] <= SCOPE_ORDER[outer]`
 * AND `innerScope !== outer`. Callers passing anything else get a
 * configuration error before arriving here.
 */
function latestTimestampSubtracted(
	customType: string,
	outer: "agent_loop" | "session" | "tool_call",
	innerScope: "agent_loop" | "session" | "tool_call" | null,
	ctx: PredicateContext,
): number | null {
	let latest = -Infinity;

	// Real entries: in outer scope AND NOT in inner scope.
	// Outer = "tool_call" excludes all real entries outright.
	if (outer !== "tool_call") {
		const inOuter = realEntryInScope(outer, ctx);
		const inInner =
			innerScope !== null && innerScope !== "tool_call"
				? realEntryInScope(innerScope, ctx)
				: null;
		for (const entry of ctx.findEntries<Record<string, unknown>>(customType)) {
			if (!inOuter(entry)) continue;
			if (inInner !== null && inInner(entry)) continue;
			if (entry.timestamp > latest) latest = entry.timestamp;
		}
	}

	// Speculative entries are always `tool_call` scope. Any non-null
	// inner scope subtracts them (tool_call itself, or a superset that
	// includes tool_call). When inner is null, keep them.
	if (innerScope === null) {
		const speculative = speculativeEntriesFor(ctx, customType);
		for (const entry of speculative) {
			if (entry.timestamp > latest) latest = entry.timestamp;
		}
	}

	return latest === -Infinity ? null : latest;
}

/**
 * Read the speculative-entry slice for `customType` off
 * `ctx.walkerState.events`. Returns an empty array when walkerState
 * is undefined (non-bash candidates) or carries no `events` field
 * (configs with no observers producing synthesis entries for this
 * event → the synthesis pass returned empty views per ref).
 */
function speculativeEntriesFor(
	ctx: PredicateContext,
	customType: string,
): readonly SyntheticEntry[] {
	const events = ctx.walkerState?.["events"] as
		| Readonly<Record<string, readonly SyntheticEntry[]>>
		| undefined;
	return events?.[customType] ?? [];
}

/**
 * Scope nesting order used for superset detection in happened.notIn
 * validation. `tool_call ⊂ agent_loop ⊂ session`; a higher number
 * means a broader scope.
 */
const SCOPE_ORDER = {
	tool_call: 0,
	agent_loop: 1,
	session: 2,
} as const;

/**
 * Build a per-entry filter for a scope as it applies to REAL entries
 * (session JSONL). Speculative entries are filtered elsewhere since
 * they have their own scope semantics.
 *
 * For a scope `tool_call`, real entries never match (no real entry
 * originates from the current tool_call's speculative view).
 */
function realEntryInScope(
	scope: "agent_loop" | "session" | "tool_call",
	ctx: PredicateContext,
): (entry: { data: Record<string, unknown> }) => boolean {
	if (scope === "session") {
		return () => true;
	}
	if (scope === "tool_call") {
		return () => false;
	}
	const target = ctx.agentLoopIndex;
	return (entry) => {
		const tag = entry.data?.[AGENT_LOOP_INDEX_KEY];
		return tag === target;
	};
}

/**
 * Walker state consumed by `when` evaluation. Today just the per-ref
 * cwd; the shape is open for future built-ins (e.g. branch) to pull
 * their own fields from the same snapshot.
 *
 * @internal — not a plugin-author surface. Plugin predicates consume
 * `ctx.walkerState` (the public `Readonly<Record<string, unknown>>`
 * on {@link PredicateContext}) instead.
 */
interface WhenWalkerState {
	readonly cwd: string;
}

// ---------------------------------------------------------------------------
// Trinary leaf adapter + Kleene composition
// ---------------------------------------------------------------------------

/**
 * Read the leaf-level `onUnknown:` modifier from a leaf value. Bare
 * forms (string, RegExp, array, boolean, number, etc.) carry no
 * modifiers; only the spread object form's `onUnknown:` field is
 * consulted. Falls back to `"block"` (fail-CLOSED) when absent.
 *
 * Strict equality on `"allow"` mirrors the engine's typo-defense: any
 * other value (`"Allow"` capitalization typo, `"BLOCK"`, `undefined`,
 * numeric, etc.) collapses to `"block"`.
 */
function readLeafOnUnknown(value: unknown): "allow" | "block" {
	if (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		!(value instanceof RegExp) &&
		"onUnknown" in (value as Record<string, unknown>)
	) {
		const v = (value as { onUnknown?: unknown }).onUnknown;
		return v === "allow" ? "allow" : "block";
	}
	return "block";
}

/**
 * Project a {@link PredicateVerdict} to a definite boolean using the
 * supplied `onUnknown:` policy:
 *   - `"block"` (default, fail-CLOSED): `"unknown"` → `true` (the
 *     leaf reports "match" so the rule fires).
 *   - `"allow"` (fail-OPEN): `"unknown"` → `false` (the leaf reports
 *     "no match" so the rule skips).
 *
 * `true` / `false` pass through unchanged.
 */
function projectVerdict(
	verdict: PredicateVerdict,
	onUnknown: "allow" | "block",
): boolean {
	if (verdict === "unknown") return onUnknown === "block";
	return verdict;
}

/**
 * Invoke a plugin-registered handler against the leaf value, awaiting
 * any returned promise and narrowing the result to a trinary
 * {@link PredicateVerdict}. A handler that throws synchronously OR
 * returns a rejected promise is caught and treated as `"unknown"`,
 * matching the spec's contract: "Throwing is equivalent to returning
 * `"unknown"`; prefer explicit returns."
 *
 * The throw-as-unknown semantics preserve fail-CLOSED-by-default — a
 * buggy plugin handler whose `"unknown"` then routes through the
 * default `onUnknown: "block"` policy keeps the rule firing instead
 * of silently fail-OPEN-skipping. Handler errors are logged via
 * `console.warn` so plugin authors can debug; the rule + key are
 * included so the source of the throw is unambiguous.
 */
async function evaluateLeafTrinary(
	handler: PredicateHandler,
	value: unknown,
	ctx: PredicateContext,
	ruleName: string,
	key: string,
): Promise<PredicateVerdict> {
	try {
		const result = await handler(value, ctx);
		if (result === true) return true;
		if (result === false) return false;
		if (result === "unknown") return "unknown";
		// Defensive: a handler returning anything else is buggy. Treat as
		// unknown for fail-CLOSED-by-default; log so the plugin author can
		// trace it.
		console.warn(
			`[pi-steering] Rule "${ruleName}": when.${key} handler returned ` +
				`${JSON.stringify(result)}; expected boolean | "unknown". ` +
				`Treating as "unknown"; the configured onUnknown policy will ` +
				`project this to a definite verdict.`,
		);
		return "unknown";
	} catch (err) {
		const msg =
			err instanceof Error
				? `${err.message}\n${err.stack ?? ""}`
				: String(err);
		console.warn(
			`[pi-steering] Rule "${ruleName}": when.${key} handler threw: ${msg}`,
		);
		return "unknown";
	}
}

/**
 * Kleene 3-valued AND across an array of trinary verdicts. Used to
 * compose multi-leaf `not:` blocks before the not-flip applies.
 *
 * Truth table (`x AND y`):
 *   true & true       = true
 *   false & anything  = false   (false absorbs)
 *   anything & false  = false
 *   true & unknown    = unknown
 *   unknown & true    = unknown
 *   unknown & unknown = unknown
 *
 * Empty input is `true` (vacuous truth) — but not-block evaluation
 * rejects the empty case at config-resolve time via
 * {@link validateWhenClauseShape}, so this code path only runs on
 * non-empty leaf sets.
 */
function kleeneAnd(verdicts: readonly PredicateVerdict[]): PredicateVerdict {
	let anyUnknown = false;
	for (const v of verdicts) {
		if (v === false) return false; // false absorbs
		if (v === "unknown") anyUnknown = true;
	}
	return anyUnknown ? "unknown" : true;
}

/**
 * Evaluate a `not:` block per the corrected pseudocode.
 *
 * Inside `not:`, leaves are composed with Kleene 3-valued AND; the
 * block-level `onUnknown:` modifier (default `"block"`) projects the
 * unknown-leaf case to a definite verdict BEFORE the not-flip applies.
 * This is a deliberate deviation from pure Kleene: the flip is skipped
 * when leaves resolve via `onUnknown:` policy so that
 * `not: { cwd: P, onUnknown: "block" }` directly means "rule fires"
 * without requiring the user to invert.
 *
 * Returns a definite boolean (the not-clause's contribution to the
 * outer when-clause's AND): `true` means the not-clause matched (rule
 * fires); `false` means it didn't.
 *
 * Truth-table coverage:
 *   - all-true leaves   → not(true) = false (rule skips on this
 *     not-clause).
 *   - any-false leaf    → false absorbs in Kleene AND → not(false) =
 *     true (rule fires).
 *   - some-unknown, no-false → Kleene AND = "unknown" → block-level
 *     `onUnknown:` policy projects directly without the flip:
 *       "block" → not-clause = true  (fail-CLOSED — rule fires)
 *       "allow" → not-clause = false (fail-OPEN — rule skips)
 */
async function evaluateNotBlock(
	block: TopLevelWhenClauseNoRecurse<string>,
	state: WhenWalkerState,
	ctx: PredicateContext,
	predicates: Record<string, PredicateHandler>,
	ruleName: string,
): Promise<boolean> {
	// Read block-level `onUnknown:` modifier. Default fail-CLOSED.
	const blockOnUnknown =
		(block as { onUnknown?: unknown }).onUnknown === "allow"
			? "allow"
			: "block";

	// Evaluate each leaf to a trinary verdict. Reserved keys (modifiers
	// + the operator field) are skipped; nested `not:` recursion is
	// rejected at runtime in {@link validateWhenClauseShape} — the
	// type-level ban via {@link TopLevelWhenClauseNoRecurse} catches
	// authoring-time mistakes, the validator catches JSON / `as any`
	// escape hatches before the engine ever runs. The unknown-predicate
	// check still fires for unregistered keys.
	const verdicts: PredicateVerdict[] = [];
	for (const [key, value] of Object.entries(block)) {
		if (value === undefined) continue;
		if (isReservedPredicateKey(key)) continue;

		// Built-in: cwd — trinary on walker-unknown sentinel.
		if (key === "cwd") {
			verdicts.push(evaluateCwd(value, state.cwd));
			continue;
		}

		// Built-in: happened — boolean leaf, no walker-unknown semantics
		// (it consults session entries / speculative entries).
		if (key === "happened") {
			verdicts.push(evaluateHappened(value, ctx, ruleName));
			continue;
		}

		// Built-in: condition — escape-hatch boolean callback. Treat
		// throws as `"unknown"` for parity with plugin handlers.
		if (key === "condition") {
			const fn = value as PredicateFn;
			try {
				const result = await fn(ctx);
				verdicts.push(Boolean(result));
			} catch (err) {
				const msg =
					err instanceof Error
						? `${err.message}\n${err.stack ?? ""}`
						: String(err);
				console.warn(
					`[pi-steering] Rule "${ruleName}": when.condition (inside not:) ` +
						`threw: ${msg}`,
				);
				verdicts.push("unknown");
			}
			continue;
		}

		// Plugin-registered predicate. Unknown predicate → named error.
		const handler = predicates[key];
		if (handler === undefined) throw new UnknownPredicateError(key);
		verdicts.push(
			await evaluateLeafTrinary(handler, value, ctx, ruleName, key),
		);
	}

	const combined = kleeneAnd(verdicts);

	if (combined === false) {
		// false absorbs → not(false) = true (rule fires on this not-clause).
		return true;
	}
	if (combined === "unknown") {
		// Skip the not-flip: the block-level `onUnknown:` policy directly
		// produces the rule-level outcome. "block" → fire; "allow" → skip.
		return blockOnUnknown === "block";
	}
	// All-true → not(true) = false (rule skips on this not-clause).
	return false;
}

/**
 * Evaluate a {@link WhenClause}: returns true if every predicate in the
 * clause "matches" for the given context. An empty / undefined clause
 * trivially matches (rule fires regardless of `when`).
 *
 * Dispatch table:
 *   - `cwd`        — built-in (walker-tied), consumes `state.cwd`. Returns
 *                    trinary; outer leaf-level `onUnknown:` modifier on
 *                    the spread form projects to a definite boolean via
 *                    {@link projectVerdict} (default `"block"` =
 *                    fail-CLOSED).
 *   - `happened`   — built-in (session-entry-scoped), consumes
 *                    `ctx.findEntries` + `ctx.agentLoopIndex`. Boolean.
 *   - `not`        — nested `not:` block; dispatched to
 *                    {@link evaluateNotBlock} which composes leaves with
 *                    Kleene 3-valued AND and applies the block-level
 *                    `onUnknown:` policy without the not-flip on unknown
 *                    leaves.
 *   - `condition`  — {@link PredicateFn}; call with ctx. Throws caught
 *                    and treated as fail-skip (boolean false).
 *   - anything else — `predicates[key]`; trinary handler with
 *                    leaf-level `onUnknown:` modifier projection. Throws
 *                    treated as `"unknown"` per spec.
 *
 * Reserved keys (`onUnknown`, future modifiers) are skipped here too —
 * they're meaningful as siblings to leaves at the outer level (per
 * spread form `{ pattern, onUnknown }` placement) but the engine
 * doesn't iterate them as standalone keys; the leaf adapter consumes
 * them inline. A bare `onUnknown:` at the outer level (without a
 * containing leaf) is type-banned but skipped here defensively.
 */
export async function evaluateWhen(
	when: TopLevelWhenClause<string> | undefined,
	state: WhenWalkerState,
	ctx: PredicateContext,
	predicates: Record<string, PredicateHandler>,
	ruleName: string,
): Promise<boolean> {
	if (!when) return true;

	for (const [key, value] of Object.entries(when)) {
		if (value === undefined) continue;

		// Skip modifier-key siblings at the outer level (defensive — the
		// type system bans rule-level `onUnknown:`, but a JSON config
		// could slip one through). The `not:` operator field is NOT
		// skipped here — it's a leaf that produces a verdict via Kleene
		// composition of the inner not-block, dispatched below.
		if (isModifierKey(key)) continue;

		// Built-in: cwd. Trinary leaf with leaf-level `onUnknown:` policy.
		if (key === "cwd") {
			const verdict = evaluateCwd(value, state.cwd);
			const onUnknown = readLeafOnUnknown(value);
			if (!projectVerdict(verdict, onUnknown)) return false;
			continue;
		}

		// Built-in: happened (session-entry presence check). Boolean.
		if (key === "happened") {
			if (!evaluateHappened(value, ctx, ruleName)) return false;
			continue;
		}

		// Built-in: not (recursive inversion via the corrected
		// not-block evaluator).
		if (key === "not") {
			const nested = value as TopLevelWhenClauseNoRecurse<string>;
			const notFires = await evaluateNotBlock(
				nested,
				state,
				ctx,
				predicates,
				ruleName,
			);
			if (!notFires) return false;
			continue;
		}

		// Built-in: condition (escape-hatch function). Boolean-only per
		// spec — the callback owns its own walker-unknown handling.
		if (key === "condition") {
			const fn = value as PredicateFn;
			const result = await fn(ctx);
			if (!result) return false;
			continue;
		}

		// Plugin-registered predicate. Trinary leaf adapter awaits, narrows,
		// catches throws, then leaf-level `onUnknown:` projects to boolean.
		const handler = predicates[key];
		if (handler === undefined) throw new UnknownPredicateError(key);
		const verdict = await evaluateLeafTrinary(
			handler,
			value,
			ctx,
			ruleName,
			key,
		);
		const onUnknown = readLeafOnUnknown(value);
		if (!projectVerdict(verdict, onUnknown)) return false;
	}
	return true;
}
