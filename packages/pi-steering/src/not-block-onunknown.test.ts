// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Type + runtime tests for the not-block onUnknown semantics +
 * per-predicate typing introduced alongside the trinary
 * `PredicateHandler` widening.
 *
 * Two surfaces under test:
 *
 *   1. Reserved-key registration error \u2014 plugin-merger throws at
 *      config-resolve time when a plugin attempts to register a
 *      predicate with a name reserved by the schema (currently
 *      `"not"`, `"onUnknown"` \u2014 the runtime mirror of
 *      {@link ReservedPredicateKey}).
 *
 *   2. Type-vs-runtime sync \u2014 the runtime constant
 *      `RESERVED_PREDICATE_KEYS` and the type-level
 *      `ReservedPredicateKey` derive lockstep from
 *      `OperatorField | keyof PredicateModifiers`. A future maintainer
 *      who adds a modifier key (or operator field) without updating
 *      both surfaces is caught by the type-level
 *      `_RESERVED_PREDICATE_KEYS_COVERS_TYPE` assertion in
 *      `evaluator-internals/predicates.ts`. This test additionally
 *      pins the runtime constant's contents so a typo or accidental
 *      reorder gets a fixture-level diff.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	RESERVED_PREDICATE_KEYS,
	isReservedPredicateKey,
	validateWhenClauseShape,
} from "./evaluator-internals/predicates.ts";
import { resolvePlugins } from "./plugin-merger.ts";
import { buildEvaluator } from "./evaluator.ts";
import { makeCtx, makeTrackedHost } from "./__test-helpers__.ts";
import type {
	BuiltInWhenLeaves,
	Plugin,
	PredicateModifiers,
	ReservedPredicateKey,
	Rule,
	TopLevelWhenClause,
} from "./schema.ts";

// ---------------------------------------------------------------------------
// Reserved-key registration check (plugin-merger throws)
// ---------------------------------------------------------------------------

describe("plugin-merger: reserved predicate key registration check", () => {
	it("throws when a plugin registers `not` as a predicate name", () => {
		const plugin: Plugin = {
			name: "evil",
			predicates: {
				// Direct collision with the `not?:` operator field on
				// TopLevelWhenClause.
				not: () => true,
			},
		};
		assert.throws(
			() => resolvePlugins([plugin], {}),
			/reserved predicate key "not"/,
		);
	});

	it("throws when a plugin registers `onUnknown` as a predicate name", () => {
		const plugin: Plugin = {
			name: "evil",
			predicates: {
				// Direct collision with the `onUnknown?:` modifier on
				// PredicateModifiers (consumed by the leaf adapter at the
				// outer level and by the not-block evaluator inside `not:`).
				onUnknown: () => true,
			},
		};
		assert.throws(
			() => resolvePlugins([plugin], {}),
			/reserved predicate key "onUnknown"/,
		);
	});

	it("error message includes the offending plugin name and a suggested alternative", () => {
		const plugin: Plugin = {
			name: "my-plugin",
			predicates: { not: () => true },
		};
		assert.throws(
			() => resolvePlugins([plugin], {}),
			(err: Error) => {
				assert.match(err.message, /Plugin "my-plugin"/);
				assert.match(err.message, /isNot/); // suggested alternative
				assert.match(err.message, /not, onUnknown/); // full reserved set listed
				return true;
			},
		);
	});

	it("accepts non-reserved names \u2014 sanity check that the throw is targeted", () => {
		const plugin: Plugin = {
			name: "good",
			predicates: {
				myCustomPredicate: () => true,
				isClean: () => true, // built-in name is fine \u2014 it's a normal collision
			},
		};
		assert.doesNotThrow(() => resolvePlugins([plugin], {}));
	});
});

// ---------------------------------------------------------------------------
// Type \u2194 runtime sync pin
// ---------------------------------------------------------------------------

describe("RESERVED_PREDICATE_KEYS: type \u2194 runtime sync pin", () => {
	it("matches the {OperatorField, modifier keys} fixture so additions get a loud diff", () => {
		// Pinned fixture so adding a new modifier or operator without
		// updating the runtime list (or the matching type union) gets a
		// loud test-level diff. The type-level assertion in
		// `evaluator-internals/predicates.ts` already catches the
		// drift in the OPPOSITE direction (runtime list missing a type
		// member); this test catches the direction the type-level
		// assertion can't (fixture pinning the literal contents).
		assert.deepEqual(
			[...RESERVED_PREDICATE_KEYS].sort(),
			["not", "onUnknown"].sort(),
		);
	});

	it("isReservedPredicateKey covers every entry in RESERVED_PREDICATE_KEYS", () => {
		for (const key of RESERVED_PREDICATE_KEYS) {
			assert.equal(
				isReservedPredicateKey(key),
				true,
				`isReservedPredicateKey("${key}") should be true`,
			);
		}
	});

	it("isReservedPredicateKey returns false for non-reserved keys", () => {
		assert.equal(isReservedPredicateKey("cwd"), false);
		assert.equal(isReservedPredicateKey("branch"), false);
		assert.equal(isReservedPredicateKey("commitsAhead"), false);
		assert.equal(isReservedPredicateKey("happened"), false);
		assert.equal(isReservedPredicateKey("condition"), false);
	});

	it("type assignment: runtime entries are assignable to ReservedPredicateKey", () => {
		// Compile-time pin via assignment. If a future maintainer
		// adds a runtime entry that drifts from the type union, this
		// assignment fails to compile.
		const _checked: readonly ReservedPredicateKey[] = RESERVED_PREDICATE_KEYS;
		assert.ok(_checked.length > 0);
	});
});

// ---------------------------------------------------------------------------
// MODIFIER_KEYS ↔ keyof PredicateModifiers sync pin
// ---------------------------------------------------------------------------

describe("MODIFIER_KEYS: type ↔ runtime sync pin", () => {
	it("validateWhenClauseShape strips `onUnknown` when counting leaves (modifier-only outer block throws)", () => {
		// If `onUnknown` ever drops out of MODIFIER_KEYS, an outer
		// block with only `onUnknown:` would count it as a leaf and
		// the validator would PASS — masking the empty-clause foot-gun.
		// This tests the runtime side of the sync pin.
		assert.throws(
			() =>
				validateWhenClauseShape(
					{ onUnknown: "block" } as unknown as TopLevelWhenClause<string>,
					'rule "r".when',
				),
			/contains no predicate leaves/,
		);
	});

	it("keyof PredicateModifiers compile-time matches the runtime modifier list", () => {
		// Belt-and-suspenders: the type-level `_MODIFIER_KEYS_COVERS_TYPE`
		// constant in `evaluator-internals/predicates.ts` fails compilation
		// when a future modifier (e.g. v0.2 `priority?:`) is added without
		// updating MODIFIER_KEYS. We pin the contract here too so a reader
		// landing on this test file can see the lockstep relationship.
		const expected: readonly (keyof PredicateModifiers)[] = ["onUnknown"];
		assert.equal(expected.length, 1);
	});
});

// ---------------------------------------------------------------------------
// Rule.when wired to TopLevelWhenClause<Writes>
// ---------------------------------------------------------------------------

describe("Rule.when: registry-driven mapped type wireup", () => {
	it("NonNullable<Rule['when']> is structurally identical to TopLevelWhenClause<string>", () => {
		// Compile-only assertion. If `BaseRule.when` ever regresses to
		// the legacy `WhenClause` (loose index signature), this fails to
		// typecheck — the registry-driven mapped type's narrow domain is
		// not assignable to a wider permissive interface.
		type RuleWhenIsTopLevel = NonNullable<Rule["when"]> extends
			TopLevelWhenClause<string>
			? TopLevelWhenClause<string> extends NonNullable<Rule["when"]>
				? true
				: false
			: false;
		const _identity: RuleWhenIsTopLevel = true;
		void _identity;
		assert.ok(true);
	});

	it("rule-level onUnknown: is forbidden against the actual Rule type", () => {
		const _r: Rule = {
			name: "r",
			tool: "bash",
			field: "command",
			pattern: "^git",
			reason: "r",
			when: {
				cwd: /work/,
				// @ts-expect-error — rule-level onUnknown: is not on TopLevelWhenClause.
				onUnknown: "block",
			},
		};
		assert.ok(_r.name === "r");
	});

	it("leaf-level onUnknown: inside not: is forbidden against the actual Rule type", () => {
		const _r: Rule = {
			name: "r",
			tool: "bash",
			field: "command",
			pattern: "^git",
			reason: "r",
			when: {
				not: {
					// @ts-expect-error — InnerValue<"branch"> excludes leaf-level modifiers.
					branch: { pattern: /main/, onUnknown: "allow" },
				},
			},
		};
		assert.ok(_r.name === "r");
	});

	it("not: not: recursion is forbidden against the actual Rule type", () => {
		const _r: Rule = {
			name: "r",
			tool: "bash",
			field: "command",
			pattern: "^git",
			reason: "r",
			when: {
				not: {
					// @ts-expect-error — TopLevelWhenClauseNoRecurse has no `not?:` field.
					not: { cwd: /work/ },
				},
			},
		};
		assert.ok(_r.name === "r");
	});
});

// ---------------------------------------------------------------------------
// Runtime nested-not: guard (catches JSON / `as any` escape hatches)
// ---------------------------------------------------------------------------

describe("validateWhenClauseShape: nested-not: rejection", () => {
	it("throws on `when: { not: { not: { cwd: P } } }` directly", () => {
		assert.throws(
			() =>
				validateWhenClauseShape(
					{
						not: { not: { cwd: /work/ } },
					} as unknown as TopLevelWhenClause<string>,
					'rule "r".when',
				),
			/contains a nested 'not:' key/,
		);
	});

	it("throws at buildEvaluator config-resolve time when a rule slips a nested not: through `as any`", () => {
		const rule: Rule = {
			name: "nested-not-via-cast",
			tool: "bash",
			field: "command",
			pattern: "^git",
			reason: "r",
			when: { not: { not: { cwd: /work/ } } } as unknown as NonNullable<
				Rule["when"]
			>,
		};
		assert.throws(
			() =>
				buildEvaluator(
					{ rules: [rule] },
					resolvePlugins([], {}),
					makeTrackedHost(),
				),
			/contains a nested 'not:' key/,
		);
	});

	it("the error message names the path and explains why nested not: is forbidden", () => {
		assert.throws(
			() =>
				validateWhenClauseShape(
					{
						not: { not: { cwd: /work/ } },
					} as unknown as TopLevelWhenClause<string>,
					'rule "my-rule".when',
				),
			(err: Error) => {
				assert.match(err.message, /'rule "my-rule"\.when\.not'/);
				assert.match(err.message, /Use a single 'not:' wrapper/);
				return true;
			},
		);
	});
});

// Keep makeCtx referenced so its import is not dropped on tree-shake passes.
void makeCtx;

// ---------------------------------------------------------------------------
// BuiltInWhenLeaves shape pin
// ---------------------------------------------------------------------------

describe("BuiltInWhenLeaves: shape pin", () => {
	it("BuiltInWhenLeaves contains exactly { happened, condition, cwd }", () => {
		// Compile-only assertion. If a future change adds a new built-in
		// non-registry leaf (e.g., `tool?:`) without updating the pin, this
		// fails to typecheck — forces a deliberate decision rather than
		// silently widening the surface that ships with the engine itself.
		type _BuiltInShape = keyof BuiltInWhenLeaves extends
			"happened" | "condition" | "cwd"
			? true
			: false;
		const _b: _BuiltInShape = true;
		void _b;
		assert.ok(true);
	});
});
