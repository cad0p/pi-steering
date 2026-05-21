// SPDX-License-Identifier: MIT
// Part of pi-steering-flags.

/**
 * pi-steering-flags \u2014 declarative flag-presence and flag-allowlist
 * predicates for pi-steering rules.
 *
 * First official external plugin for the pi-steering ecosystem.
 * Establishes the precedent pattern for every community plugin that
 * follows:
 *
 *   - Package name: `pi-steering-<domain>` (unscoped, mirroring
 *     `pi-steering` core).
 *   - Keywords: `["pi-package", "pi-steering-package", ...]` for
 *     ecosystem discoverability via pi.dev and `npm search`.
 *   - PeerDep on `pi-steering` (pinned range once published).
 *   - Two predicates exported as a `Plugin`, three helpers exported
 *     for `when.condition` escape-hatch use.
 *
 * See this package's README for usage examples, and the pi-steering
 * README "Writing plugins" section for the design rationale.
 */

import type { Plugin, PredicateShape } from "pi-steering";
import { allowlistedFlagsOnly } from "./predicates/allowlisted-flags-only.ts";
import { requiresFlag } from "./predicates/requires-flag.ts";
import type {
	AllowlistedFlagsOnlyArgs,
	RequiresFlagArgs,
} from "./types.ts";

declare global {
	/**
	 * pi-steering-flags' typed-predicate registry. Each entry declares
	 * the predicate's `bare` value type and (optionally) an explicit
	 * `spreadBase` (the spread's object form WITHOUT modifiers).
	 * Modifiers (currently `onUnknown:`) are added at use site via
	 * `& PredicateModifiers` (outer leaf) or at the not-block top level
	 * (inside `not:`).
	 *
	 * Both predicates read `ctx.input.args` / `ctx.input.envAssignments`
	 * — they don't depend on the walker's effective cwd, so neither
	 * predicate carries a walker-unknown-cwd guard. The `onUnknown:`
	 * modifier still applies if a handler explicitly returns the
	 * `"unknown"` sentinel; current handlers return only `boolean`.
	 *
	 * @see PredicateShape, DefaultSpreadBase, PredicateModifiers in
	 *      `pi-steering`'s `schema.ts` for the full registry contract.
	 * @see The `gitPlugin` declaration in pi-steering's
	 *      `plugins/git/index.ts` for the canonical multi-predicate
	 *      registry block.
	 */
	interface PiSteeringPredicates {
		/**
		 * `when.requiresFlag` — fires (rule BLOCKS) when none of the
		 * specified flag / env-var equivalents appear in the evaluated
		 * command's `ctx.input.args` / `ctx.input.envAssignments`.
		 *
		 * Bare shorthand `requiresFlag: "--profile"` is equivalent to
		 * `{ flag: "--profile" }`. Spread form supports any combination
		 * of `flag` / `flags` / `env` / `envs` (OR semantics across all
		 * listed equivalents — at least one must be present to satisfy).
		 *
		 * Mixed-bare predicate: explicit `SpreadBase` since auto-detection
		 * from `string` would give `{ pattern: string }` (Pattern wrapper),
		 * which doesn't match the desired flag-bag shape.
		 */
		requiresFlag: PredicateShape<string, RequiresFlagArgs>;

		/**
		 * `when.allowlistedFlagsOnly` — fires (rule BLOCKS) on the first
		 * `-`-prefixed token in `ctx.input.args` that is NOT in the
		 * `allow` set, NOT covered by an auto-derived `--flag=` prefix
		 * of an allowed long flag, and NOT matched by an explicit
		 * `allowPrefixes` entry.
		 *
		 * Spread-only predicate (no bare shorthand): the args object's
		 * `allow:` field is required, so there's no sensible single-value
		 * shorthand. The auto-detected `SpreadBase` (object form: the
		 * `Bare` shape itself) is exactly what we want.
		 */
		allowlistedFlagsOnly: PredicateShape<AllowlistedFlagsOnlyArgs>;
	}
}

/**
 * The plugin. `as const satisfies Plugin` preserves literal types so
 * `defineConfig({ plugins: [flagsPlugin] })` can cross-reference the
 * predicate names at compile time.
 */
const flagsPlugin = {
	name: "flags",
	predicates: {
		requiresFlag,
		allowlistedFlagsOnly,
	},
} as const satisfies Plugin;

export default flagsPlugin;

// Named re-exports \u2014 pick-your-piece imports for authors who want
// just one predicate or a helper.
export { requiresFlag } from "./predicates/requires-flag.ts";
export { allowlistedFlagsOnly } from "./predicates/allowlisted-flags-only.ts";
export { hasFlag, getFlagValue, hasEnvAssignment, INFO_ONLY } from "./helpers.ts";
export type {
	RequiresFlagArgs,
	AllowlistedFlagsOnlyArgs,
} from "./types.ts";
