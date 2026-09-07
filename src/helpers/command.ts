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
 * Each flag method delegates to the mechanism in `./flags.ts` with identical
 * precedence/edge semantics (`matchFlagAt` exact → attached → glued;
 * quote-aware `.value`-first reads). `positionals()` adds the bound
 * positional view over the same snapshot with the same bound consuming
 * list — consumption and skipping cannot diverge.
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
import {
  getAllFlagValues,
  getFlagValue,
  hasEnvAssignment,
  hasFlag,
  isInfoOnly,
  isValueConsuming,
} from "./flags.ts";

/**
 * Bound view over one parsed tool input's argv + env-prefix words.
 *
 * Built once per command ref by the engine (`ctx.command`) or on
 * demand via {@link commandFromInput} for out-of-handler / test use.
 *
 * Registry-only arity (issue #107): the bound methods take NO opts —
 * the `commandFromInput(input, resolvedFlags)` binding carries the
 * descriptor-resolved consuming-flag list, so consumption and
 * skipping cannot diverge. Absent binding → strict empty set
 * (undeclared flags never consume).
 */
export interface SteeringCommand {
  /**
   * `true` if the command carries any listed flag (bare token,
   * attached `flag=value` token). Delegates to `hasFlag` with the
   * bound argv words (presence-only: no arity input, no opts).
   */
  hasFlag(flag: string | readonly string[]): boolean;

  /**
   * Value of the LAST occurrence of any listed flag alias, or `null`
   * if absent or present-but-valueless. Delegates to `getFlagValue`
   * (last-wins) with the bound argv words + bound consuming list.
   */
  getFlagValue(flags: string | readonly string[]): string | null;

  /**
   * Values of EVERY occurrence of any listed flag alias, in argv
   * order, or `[]` if absent or present-but-valueless. Delegates to
   * `getAllFlagValues` with the bound argv words + bound consuming
   * list. Consumers apply their own join policy (e.g. git's `"\n\n"`
   * for repeated `-m`).
   */
  getAllFlagValues(flags: string | readonly string[]): string[];

  /**
   * Resolved positional operands left→right, INCLUDING the subcommand
   * run (`git push origin :branch` → `["push","origin",":branch"]`).
   * Skips: the `--` token itself (everything after it surfaces
   * verbatim), attached `--flag=value` tokens, declared consuming
   * flags + their values (BY POSITION), and opaque single-dash
   * multi-char units (bundles like `-fdx`, glued `-X<rest>` — never
   * decomposed without per-call glue knowledge). Clean `--long` /
   * `-x` flag-words that are not declared-consuming surface as
   * themselves (registry-only arity pin: `push --delete origin` keeps
   * both `--delete` and `origin`). Total: never throws.
   */
  positionals(): string[];

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
 * env-prefix words, with the descriptor-resolved consuming-flag list
 * (issue #107 registry-only binding).
 *
 * The engine binds per ref (`resolveDescriptor(basename).valueConsumingFlags`
 * → here); the facade stays a pure view. Total: never throws on weird
 * input — `input?.args ?? []` / `input?.envAssignments ?? []` normalize
 * missing keys (and a missing input itself) to the empty behavior. The
 * constructor snapshots (COPYs) both arrays, so post-construction
 * mutation of the caller's arrays cannot leak into the facade.
 */
export function commandFromInput(
  input: PredicateToolInput,
  resolvedFlags?: readonly string[],
): SteeringCommand {
  const args: readonly Word[] = [...(input?.args ?? [])];
  const envAssignments: readonly Word[] = [...(input?.envAssignments ?? [])];
  // Registry-only arity: absent binding → strict empty set (nothing
  // consumes). One list backs getFlagValue / getAllFlagValues /
  // positionals() — consumption and skipping cannot diverge.
  const consuming: readonly string[] =
    resolvedFlags !== undefined ? [...resolvedFlags] : [];
  const opts = { valueConsumingFlags: consuming };
  return {
    hasFlag: (flag) => hasFlag(args, flag),
    getFlagValue: (flags) => getFlagValue(args, flags, opts),
    getAllFlagValues: (flags) => getAllFlagValues(args, flags, opts),
    positionals: () => positionalsOf(args, consuming),
    hasEnvAssignment: (name) => hasEnvAssignment(envAssignments, name),
    isInfoOnly: (extraFlags) => isInfoOnly(args, extraFlags),
  };
}

/**
 * Read a word's resolved value with a fallback to its text form —
 * same `.value`-first contract as the flag helpers, so quote-awareness
 * falls out (a quoted `"see --help"` value token is one non-flag
 * word → positional; a quoted flag spelling is still exact-matched).
 */
function wordValue(w: Word | undefined): string {
  if (w === undefined) return "";
  return w.value ?? w.text ?? "";
}

/**
 * Pure positional view over bound argv words (issue #107 §6).
 *
 * Single left→right scan over resolved strings:
 *   1. Bare `--`: everything after it is positional (verbatim). The
 *      `--` token itself never surfaces.
 *   2. Attached `--flag=value` tokens (any dash-led token containing
 *      `=`) never surface — single tokens, always apply.
 *   3. Exact token equal to a DECLARED consuming flag → skip token +
 *      next token (trailing with no next → skip token only).
 *   4. Opaque single-dash multi-char units (bundles like `-fdx`, glued
 *      `-X<rest>` — indistinguishable with no per-call glue knowledge)
 *      → skipped as ONE unit, never decomposed into letters.
 *   5. Everything else surfaces IN ORDER — INCLUDING the subcommand
 *      run and clean `--long` / `-x` / `-` flag-words that are not
 *      declared-consuming (registry-only pin: `push --delete origin`
 *      → `["push","--delete","origin"]`).
 *   6. No descriptor for the basename → strict default (empty consuming
 *      set): rule 3 never fires, all separated next-tokens surface.
 *
 * Total: never throws on weird input (missing/odd shapes degrade to
 * empty behavior, never escape).
 */
function positionalsOf(
  args: readonly Word[],
  consuming: readonly string[],
): string[] {
  const out: string[] = [];
  let afterDashDash = false;
  for (let i = 0; i < args.length; i++) {
    const token = wordValue(args[i]);
    if (!afterDashDash && token === "--") {
      afterDashDash = true;
      continue;
    }
    if (afterDashDash) {
      out.push(token);
      continue;
    }
    // Attached forms carry their value on the token: skip one word.
    if (token.startsWith("-") && token.includes("=")) continue;
    // Declared consuming flags skip their value BY POSITION.
    if (isValueConsuming(token, consuming)) {
      i += 1;
      continue;
    }
    // Opaque bundles/glued: skip whole, never decompose.
    if (token.startsWith("-") && !token.startsWith("--") && token.length > 2) {
      continue;
    }
    out.push(token);
  }
  return out;
}
