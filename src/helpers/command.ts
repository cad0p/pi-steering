// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Context-provided command facade (issue #101).
 *
 * A `SteeringCommand` is a bound view over one already-parsed
 * {@link PredicateToolInput}: the engine builds it per command ref from
 * `input.args` + `input.envAssignments` (see `commandFromInput`), so
 * rule code never threads bare `Word[]` arrays by hand. `mockContext`
 * builds the same view, so unit-tested predicates see it too.
 *
 * Each method delegates to the mechanism in `./flags.ts` with identical
 * precedence/edge semantics (`matchFlagAt` exact → attached → glued;
 * quote-aware `.value`-first reads). The facade adds no parsing of its
 * own.
 *
 * Deliberate non-goals:
 *
 *   - No exported string→words lexer. The walker already parsed the
 *     command into `ctx.input.args` (quote-aware); a second lexing
 *     implementation would be drift by construction. String holders
 *     migrate at the rule level by reading `ctx.command`.
 *   - No `resolve: "first"` option. First-wins models no real parser
 *     (ADR 2026-08-21); only last-wins (`getFlagValue`) + all-values
 *     (`getAllFlagValues`) exist.
 *   - Join policy lives in consumers, never core — e.g. git
 *     concatenates repeated `-m` with `"\n\n"` at the rule level.
 */

import type { Word } from "@cad0p/unbash-walker";
import type { PredicateToolInput } from "../schema.ts";
import type { FlagLookupOptions } from "./flags.ts";
import {
  getAllFlagValues,
  getFlagValue,
  hasEnvAssignment,
  hasFlag,
  isInfoOnly,
} from "./flags.ts";

/**
 * Bound view over one parsed tool input's argv + env-prefix words.
 *
 * Built once per command ref by the engine (`ctx.command`) or on
 * demand via {@link commandFromInput} for out-of-handler / test use.
 */
export interface SteeringCommand {
  /**
   * `true` if the command carries any listed flag (bare token,
   * attached `flag=value` token, or opt-in glued `-X<value>` form).
   * Delegates to `hasFlag` with the bound argv words.
   */
  hasFlag(
    flag: string | readonly string[],
    opts?: FlagLookupOptions,
  ): boolean;

  /**
   * Value of the LAST occurrence of any listed flag alias, or `null`
   * if absent or present-but-valueless. Delegates to `getFlagValue`
   * (last-wins) with the bound argv words.
   */
  getFlagValue(
    flags: string | readonly string[],
    opts?: FlagLookupOptions,
  ): string | null;

  /**
   * Values of EVERY occurrence of any listed flag alias, in argv
   * order, or `[]` if absent or present-but-valueless. Delegates to
   * `getAllFlagValues` with the bound argv words. Consumers apply
   * their own join policy (e.g. git's `"\n\n"` for repeated `-m`).
   */
  getAllFlagValues(
    flags: string | readonly string[],
    opts?: FlagLookupOptions,
  ): string[];

  /**
   * `true` if the command's shell env-prefix carries an assignment
   * for `name` (literal `name=` prefix match). Delegates to
   * `hasEnvAssignment` with the bound env-assignment words.
   */
  hasEnvAssignment(name: string): boolean;

  /**
   * `true` if the command carries any info-only flag (token-level,
   * quote-aware; default `--help` / `--version` plus additive
   * `extraFlags`). Delegates to `isInfoOnly` with the bound argv
   * words.
   */
  isInfoOnly(extraFlags?: readonly string[]): boolean;
}

/**
 * Build a {@link SteeringCommand} bound to one tool input's argv +
 * env-prefix words.
 *
 * Total: never throws on weird input — `input?.args ?? []` /
 * `input?.envAssignments ?? []` normalize missing keys (and a missing
 * input itself) to the empty behavior (`hasFlag false`,
 * `getFlagValue null`, `getAllFlagValues []`, `hasEnvAssignment
 * false`, `isInfoOnly false`). The constructor snapshots (COPYs) both
 * arrays, so post-construction mutation of the caller's arrays cannot
 * leak into the facade.
 */
export function commandFromInput(
  input: PredicateToolInput,
): SteeringCommand {
  const args: readonly Word[] = [...(input?.args ?? [])];
  const envAssignments: readonly Word[] = [...(input?.envAssignments ?? [])];
  return {
    hasFlag: (flag, opts) => hasFlag(args, flag, opts),
    getFlagValue: (flags, opts) => getFlagValue(args, flags, opts),
    getAllFlagValues: (flags, opts) => getAllFlagValues(args, flags, opts),
    hasEnvAssignment: (name) => hasEnvAssignment(envAssignments, name),
    isInfoOnly: (extraFlags) => isInfoOnly(args, extraFlags),
  };
}
