// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Predicate handlers for the git plugin, one file per handler.
 *
 * This bundle assembles the `predicates` record the plugin registers
 * under `Plugin.predicates` and re-exports each handler + its types
 * for plugin authors who want to pick pieces. The per-item files live
 * alongside this index:
 *
 *   - `branch.ts`            — `when.branch` handler + the shared
 *                              `WalkerStringResult` / `walkerString`
 *                              branch-tracker-consumption helpers.
 *   - `upstream.ts`          — `when.upstream` handler.
 *   - `commits-ahead.ts`     — `when.commitsAhead` handler +
 *                              `CommitsAheadArgs`.
 *   - `has-staged-changes.ts`— `when.hasStagedChanges` handler.
 *   - `is-clean.ts`          — `when.isClean` handler.
 *   - `remote.ts`            — `when.remote` handler.
 *
 * Shared predicate-argument helpers (pattern unwrap / boolean leaf
 * unwrap / the walker-unknown-cwd guard) live in `../helpers/`.
 */

import type { AnyPredicateHandler } from "../../../schema.ts";
import { branch, type WalkerStringResult, walkerString } from "./branch.ts";
import { upstream } from "./upstream.ts";
import { commitsAhead, type CommitsAheadArgs } from "./commits-ahead.ts";
import { hasStagedChanges } from "./has-staged-changes.ts";
import { isClean } from "./is-clean.ts";
import { remote } from "./remote.ts";

/**
 * Bundle of predicate handlers the git plugin registers under
 * `Plugin.predicates`. Keys become the `when.<key>` slots rule authors
 * see.
 *
 * Typed as `Record<string, AnyPredicateHandler>` to match
 * {@link Plugin.predicates} at the registry boundary — each handler's
 * concrete argument shape is preserved in its individual declaration
 * above, and consumers can import `commitsAhead`, `isClean`, etc.
 * directly when they want the narrow type.
 */
export const predicates: Record<string, AnyPredicateHandler> = {
  branch,
  upstream,
  commitsAhead,
  hasStagedChanges,
  isClean,
  remote,
};

export { branch, walkerString };
export type { WalkerStringResult };
export { upstream };
export { commitsAhead };
export type { CommitsAheadArgs };
export { hasStagedChanges };
export { isClean };
export { remote };
