// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Shared boolean-leaf argument unwrapping for the git plugin's
 * boolean predicates (`isClean`, `hasStagedChanges`).
 *
 * Extracted verbatim from the predicates bulk file during the per-item
 * layout refactor — both boolean handlers accept the same bare / spread
 * shapes and share this single unwrap implementation.
 */

/**
 * Unwrap the boolean payload from a {@link PredicateShape}<boolean>
 * argument. Accepts the bare form (`true` / `false`) and the
 * spread form (`{ value: true, onUnknown? }` /
 * `{ value: false, onUnknown? }`); the engine's `readLeafOnUnknown`
 * reads any `onUnknown:` sibling and `projectVerdict` applies the
 * policy to the handler's `"unknown"` returns. The handler itself
 * treats `onUnknown:` as an opaque sibling field and only consumes
 * `value:`.
 *
 * Returns `undefined` on malformed input — the caller decides what
 * to do with that (typically `return false`, mirroring the existing
 * pattern-unwrap fail-closed contract).
 *
 * Used by {@link isClean} and {@link hasStagedChanges}; both ship
 * with `PredicateShape<boolean>` in the registry so the bare/spread
 * shape is identical at the type level too.
 *
 * @internal
 */
export function unwrapBooleanLeafArg(args: unknown): boolean | undefined {
  if (typeof args === "boolean") return args;
  if (
    args !== null &&
    typeof args === "object" &&
    typeof (args as { value?: unknown }).value === "boolean"
  ) {
    return (args as { value: boolean }).value;
  }
  return undefined;
}

/**
 * Test-internal export of {@link unwrapBooleanLeafArg}. Module-private
 * by intent; the `@internal` JSDoc tag (TypeScript ecosystem-standard)
 * flags "not part of the public surface" and the underscore prefix
 * mirrors the convention so external consumers can grep-discover it
 * too. Direct unit tests pin malformed-input branches that are hard
 * to drive via the engine end-to-end.
 *
 * @internal
 */
export const _unwrapBooleanLeafArg = unwrapBooleanLeafArg;
