// SPDX-License-Identifier: MIT
// Part of pi-steering-commit-format.

/**
 * Default plugin: convenience for the common case (no extension, no
 * custom formats). If you want different formats, build your own
 * predicate via {@link commitFormatFactory} and register it in your
 * own plugin.
 *
 * Mirrors the `pi-steering-flags` shape: `as const satisfies Plugin`
 * preserves literal types so `defineConfig({ plugins: [commitFormatPlugin] })`
 * can cross-reference the predicate names at compile time.
 */

import type { Plugin, PredicateShape } from "pi-steering";
import { BUILTIN_FORMATS } from "./builtin-formats.ts";
import { commitFormatFactory } from "./factory.ts";
import type { CommitFormatArgs } from "./factory.ts";

/**
 * Default `commitFormat` predicate, built from {@link commitFormatFactory}
 * over {@link BUILTIN_FORMATS}.
 *
 * Common usage:
 * ```ts
 * when: { commitFormat: { require: ["conventional"] } }
 * when: { commitFormat: { require: ["conventional", "jira"] } }
 * ```
 *
 * For custom format sets (third-party formats, alternate spellings,
 * org-specific patterns), use {@link commitFormatFactory} directly to
 * build a named predicate; register it on
 * {@link PiSteeringPredicates} from your own plugin so authors get
 * the same compile-time autocomplete + JSDoc on hover this default
 * predicate provides. See the README's "Combine with custom formats"
 * section for the canonical pattern, and pi-steering's gitPlugin and
 * pi-steering-flags' registry blocks as additional references.
 */
export const commitFormat = commitFormatFactory(BUILTIN_FORMATS);

declare global {
	/**
	 * pi-steering-commit-format's typed-predicate registry. Registers
	 * the default `commitFormat` predicate so consumers get
	 * compile-time autocomplete + JSDoc on hover for `when.commitFormat`
	 * inside their rule literals.
	 *
	 * The predicate inspects `ctx.input.command` only — no walker
	 * state is consulted, so there's no walker-unknown-cwd guard.
	 *
	 * Custom-format consumers (those who build a predicate via
	 * {@link commitFormatFactory} over a non-builtin format set) MUST
	 * register their predicate's name on this interface from their
	 * own plugin's `declare global` block. The registry is the source
	 * of truth for the `when:` keyset; an unregistered predicate name
	 * is rejected at the type level. See pi-steering's gitPlugin
	 * (`plugins/git/index.ts`) and pi-steering-flags (`src/index.ts`)
	 * for canonical multi-predicate registry blocks.
	 *
	 * @see PredicateShape, DefaultSpreadBase, PredicateModifiers in
	 *      `pi-steering`'s `schema.ts` for the full registry contract.
	 */
	interface PiSteeringPredicates {
		/**
		 * `when.commitFormat` — checks that the commit message in the
		 * evaluated bash command's `-m <msg>` value matches every
		 * format listed in `require:` (AND semantics across the listed
		 * formats). Fires (rule BLOCKS) when any required format check
		 * fails.
		 *
		 * The default predicate is wired against {@link BUILTIN_FORMATS}
		 * — `"conventional"` (Conventional Commits 1.0.0 with the
		 * Angular preset's 11-token type allowlist) and `"jira"`
		 * (bracketed JIRA-style references like `[ABC-123]`). Use
		 * `require: ["conventional"]` to demand a single format,
		 * `require: ["conventional", "jira"]` to demand both.
		 *
		 * Empty `require: []` is a no-op (nothing required → nothing
		 * fires). Bare `git commit` (editor-mode, no `-m`) is NOT
		 * validated — pair with a separate hook if editor commits
		 * need gating.
		 *
		 * For custom format sets, build your own predicate via
		 * {@link commitFormatFactory} and register its name on
		 * {@link PiSteeringPredicates} from your own plugin (see the
		 * README's "Combine with custom formats" section).
		 *
		 * Spread-only predicate (no bare shorthand): `require:` is
		 * required, no single-value shorthand is meaningful. Auto-
		 * detected `SpreadBase` (object form: the `Bare` shape itself)
		 * matches the desired authoring surface.
		 */
		commitFormat: PredicateShape<CommitFormatArgs>;
	}
}

export const commitFormatPlugin = {
	name: "commit-format",
	predicates: { commitFormat },
} as const satisfies Plugin;

export default commitFormatPlugin;
