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
} from "./evaluator-internals/predicates.ts";
import { resolvePlugins } from "./plugin-merger.ts";
import type { Plugin, ReservedPredicateKey } from "./schema.ts";

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
