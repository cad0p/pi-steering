// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Low-level flag primitives for inspecting `ctx.input.args` / `ctx.input.envAssignments`.
 *
 * Promoted to core in the P3 promotion (issue #99): these back core's
 * `when.flag` leaves (issue #90) and are exported for rule authors
 * reaching for `when.condition` escape-hatch logic.
 *
 * All helpers are quote-aware: they read `.value` first (the walker's
 * resolved value after quote removal) before falling back to `.text`
 * (the raw source slice).
 */

import type { Word } from "@cad0p/unbash-walker";

/**
 * Read a word's resolved value with a fallback to its text form.
 * Handles both forms consistently so callers can ignore the split.
 */
function wordValue(w: Word | undefined): string {
  if (w === undefined) return "";
  return w.value ?? w.text ?? "";
}

/**
 * Read-only iteration over a Word-array that tolerates either an array
 * of Word or undefined. Hoisted so all helpers share the same empty-
 * input handling.
 */
function* iterWords(
  words: readonly Word[] | undefined,
): IterableIterator<Word> {
  if (words === undefined) return;
  for (const w of words) yield w;
}

/** Options for {@link hasFlag} / {@link getFlagValue} / {@link getAllFlagValues}. */
export interface FlagLookupOptions {
  /**
   * Letters X whose GLUED short form `-X<value>` (one argv word) resolves.
   * Opt-in: absent/empty keeps the ShellCheck-norm blind default.
   * Only letters whose own `-X` alias is in the queried flag set apply.
   */
  gluedShorts?: readonly string[];
}

/** Shared empty set so the no-glue fast path never allocates. */
const EMPTY_GLUE_LETTERS: ReadonlySet<string> = new Set<string>();

/**
 * Letters eligible for glued-short decomposition: the declared
 * `gluedShorts` intersected with the letters of ELIGIBLE aliases
 * (single-dash single-letter shorts) in the queried flag set. Long
 * aliases (`--repo`) and multi-char shorts (`-xy`) are never eligible,
 * and malformed option entries fail open (ignored ⇒ no glue).
 *
 * An empty result makes {@link matchFlagAt} behave exactly like the
 * pre-gluedShorts helpers — byte-for-byte default behavior.
 */
function glueLettersFor(
  flags: string | readonly string[],
  opts?: FlagLookupOptions,
): ReadonlySet<string> {
  const raw = opts?.gluedShorts;
  // Fail-open guard: a non-array gluedShorts ("RR", 123, …) degrades to
  // the blind default instead of iterating chars or throwing.
  const declared: readonly unknown[] = Array.isArray(raw) ? raw : [];
  if (declared.length === 0) return EMPTY_GLUE_LETTERS;
  const flagAliases = typeof flags === "string" ? [flags] : flags;
  const letters = new Set<string>();
  for (const entry of declared) {
    // Fail-open on malformed entries (house precedent): non-array /
    // non-string / non-single-char letters are ignored ⇒ no glue.
    if (typeof entry !== "string" || entry.length !== 1) continue;
    for (const alias of flagAliases) {
      if (alias.length === 2 && alias[0] === "-" && alias[1] === entry) {
        letters.add(entry);
        break;
      }
    }
  }
  return letters;
}

/**
 * How a single argv word matches the queried flag set at one scanned
 * position. Precedence (checked in this order, shared by BOTH helpers):
 *   1. exact token           → separated form, consult next token
 *   2. attached `${alias}=`  → value carried (may be empty string)
 *   3. glued `-X<rest>`      → value `<rest>`, iff X ∈ glueLetters
 */
type FlagMatch =
  | { kind: "exact" }
  | { kind: "attached"; value: string }
  | { kind: "glued"; value: string };

/**
 * Match one argv word against the flag aliases at a single position.
 * Bundling-safe: only declared single letters split off a glued value,
 * and only when the remainder is non-empty (`-vf` never reads as `-v`
 * plus value `f` unless `v` was declared AND owns the lead).
 */
function matchFlagAt(
  wordText: string,
  flagAliases: readonly string[],
  glueLetters: ReadonlySet<string>,
): FlagMatch | undefined {
  // Plan-prescribed precedence: exact-before-attached — observable vs 0.1.x only for degenerate alias sets containing an `=`-bearing alias (e.g. ["--flag", "--flag="]).
  for (const alias of flagAliases) {
    if (wordText === alias) return { kind: "exact" };
  }
  for (const alias of flagAliases) {
    const prefix = `${alias}=`;
    if (wordText.startsWith(prefix)) {
      return { kind: "attached", value: wordText.slice(prefix.length) };
    }
  }
  if (wordText.length > 2 && wordText[0] === "-") {
    const lead = wordText[1];
    if (lead !== undefined && lead !== "-" && glueLetters.has(lead)) {
      return { kind: "glued", value: wordText.slice(2) };
    }
  }
  return undefined;
}

/**
 * `true` if `args` contains any listed flag as a bare token, as the key
 * of an attached-value `flag=value` token, or — when opted in via
 * {@link FlagLookupOptions.gluedShorts} — as a glued short form
 * `-X<value>` carrying its value inline (`gh -Rc/d` keeps `-Rc/d` as
 * ONE argv word).
 *
 * Accepts a single flag or an alias SET (OR'd at every scanned
 * position), mirroring {@link getFlagValue}. Quote-aware (reads
 * `.value` first, falls back to `.text`).
 *
 * @example
 *   hasFlag([W("--profile"), W("dev")], "--profile");    // true  (bare)
 *   hasFlag([W("--profile=dev")], "--profile");          // true  (attached)
 *   hasFlag([W("--profile-foo")], "--profile");          // false (prefix collision avoided)
 *   hasFlag([W("-Rc/d")], "-R", { gluedShorts: ["R"] }); // true  (glued, opt-in)
 */
export function hasFlag(
  args: readonly Word[] | undefined,
  flag: string | readonly string[],
  opts?: FlagLookupOptions,
): boolean {
  const flagSet = typeof flag === "string" ? [flag] : flag;
  const glueLetters = glueLettersFor(flagSet, opts);
  for (const w of iterWords(args)) {
    if (matchFlagAt(wordValue(w), flagSet, glueLetters) !== undefined) {
      return true;
    }
  }
  return false;
}

/**
 * Value associated with the LAST occurrence of any listed flag alias
 * in `args`, or `null` if the flag is absent or present-but-valueless.
 *
 * **LAST-flag-wins**: the scan runs RIGHT→LEFT, so the highest-index
 * occurrence wins — the effective value under every real argv parser.
 * This supersedes this helper's 0.1.0 form, which scanned left-to-
 * right (FIRST occurrence won, single flag only): first-wins models
 * no real parser — argparse / cobra / pflag all default to last-flag-
 * wins, and CLIs like gh collapse repeated spellings of one logical
 * flag to its final value.
 *
 * The second parameter accepts a single flag OR an alias SET
 * (`["-t", "--subject"]` — gh treats those spellings as one logical
 * flag). Aliases are OR'd at every scanned position, so the winner is
 * whichever alias occurrence comes last:
 *
 *   // gh pr merge -t "see #13" --subject "closes #12"
 *   getFlagValue([W("-t"), W("see #13"),
 *                 W("--subject"), W("closes #12")],
 *                ["-t", "--subject"]); // "closes #12"
 *
 * Recognizes three forms (precedence per scanned position):
 *   - exact:     `--flag`       → separated form: NEXT token's value
 *   - attached: `--flag=value`  → returns `"value"` (may be `""`)
 *   - glued:     `-X<rest>`     → returns `<rest>` (opt-in ONLY, via
 *                 {@link FlagLookupOptions.gluedShorts}: the walker keeps
 *                 `gh -Rc/d`'s `-Rc/d` as ONE argv word)
 *
 * Glued decomposition is opt-in per LETTER and bundling-safe: with
 * `gluedShorts: ["f"]`, docker's `-vf alpine` matches NOTHING (the
 * bundle starts with the undeclared `-v`); a declared lead letter
 * consumes its remainder (`-fv` → flag `f`, value `v`). Blanket
 * decomposition is unsound because POSIX CLIs accept glued values AND
 * bundling simultaneously — telling them apart requires per-CLI arity
 * knowledge the caller must assert.
 *
 * The separated form does NOT inspect whether the next token looks
 * like a flag — some CLIs accept `--flag --next-flag` and treat
 * `--next-flag` as the value. Callers who want a strict form should
 * post-check the return value.
 *
 * Fail-closed edge: a TRAILING valueless occurrence wins over an
 * earlier valued one — `cmd -t foo --subject` returns `null`, with NO
 * fallback to the overridden `-t foo`. Real pflag rejects that command
 * line anyway.
 *
 * Matching is exact token equality or the `${flag}=` attached prefix,
 * so prefix collisions are safe (`--profile-foo` ≠ `--profile`).
 * Quote-awareness is inherited (`.value` is read before `.text`) —
 * adopters migrating from hand-rolled `.text` + `unquote` scans get
 * correct handling of quoted values for free.
 */
export function getFlagValue(
  args: readonly Word[] | undefined,
  flags: string | readonly string[],
  opts?: FlagLookupOptions,
): string | null {
  const flagSet = typeof flags === "string" ? [flags] : flags;
  const glueLetters = glueLettersFor(flagSet, opts);
  const argsArr = args ?? [];
  for (let i = argsArr.length - 1; i >= 0; i--) {
    const match = matchFlagAt(wordValue(argsArr[i]), flagSet, glueLetters);
    if (!match) continue;
    if (match.kind === "exact") {
      const next = argsArr[i + 1];
      if (next === undefined) return null;
      const nextVal = wordValue(next);
      return nextVal === "" ? null : nextVal;
    }
    return match.value;
  }
  return null;
}

/**
 * All values associated with any listed flag alias in `args`, in argv
 * order, or `[]` if the flag is absent or present-but-valueless.
 *
 * Forward-scan (LEFT→RIGHT) accumulation twin of {@link getFlagValue}:
 * at each position the same `matchFlagAt` precedence applies
 * (exact → attached → glued with the same `glueLettersFor` gating),
 * and each match resolves its value exactly as `getFlagValue` would at
 * that position — except the scan collects every occurrence instead of
 * keeping only the last:
 *
 *   - exact separated (`--flag value`): the NEXT token's `wordValue`.
 *     A valueless occurrence (no next token) contributes NOTHING, and
 *     an empty-string next token (`--flag ""`) is SKIPPED (does not
 *     push `""`) — mirroring the scalar, which returns `null` on both
 *     shapes. Only the attached-empty spelling carries an explicit
 *     empty value.
 *   - attached (`--flag=value`): pushes `value` verbatim INCLUDING `""`
 *     (`--flag=` is an explicit empty value — the scalar returns `""`).
 *   - glued (`-X<rest>`, opt-in via {@link FlagLookupOptions.gluedShorts}):
 *     pushes `<rest>` (non-empty by construction).
 *
 * Alias sets OR'd per position, same as the scalar; mixed spellings
 * interleave in argv order (`-m a --message b` → `["a", "b"]`).
 * Quote-aware via `.value`-first (`wordValue`), same as scalar.
 * No match → `[]` (never `null`).
 *
 * Trailing-broken asymmetry (deliberate): a trailing broken occurrence
 * contributes nothing to the array but poisons the scalar to `null`.
 * The scalar models "effective value of a broken command line" →
 * `null`; the array models "values a real accumulator collected before
 * the broken tail" (a real CLI would reject the command anyway;
 * consumers joining for display want the collected prefix). Covers BOTH
 * trailing shapes:
 *
 *   - `[-m a, -m]` (trailing valueless) → scalar `null`, array `["a"]`.
 *   - `[-m a, -m ""]` (trailing empty-next-token) → scalar `null`,
 *     array `["a"]`.
 *   - `[--m=, --m]` (trailing valueless after attached-empty) → scalar
 *     `null`, array `[""]`.
 *
 * Invariant (well-formed non-trailing-broken inputs ONLY):
 * `getFlagValue(args, f, o) === (all.length ? all[all.length-1] : null)`.
 * Trailing-broken inputs (no-next-token OR empty-next-token in trailing
 * position) are the documented exception.
 *
 * Join policy lives in consumers, never here — e.g. git concatenates
 * repeated `-m` with `"\n\n"` at the rule level.
 */
export function getAllFlagValues(
  args: readonly Word[] | undefined,
  flags: string | readonly string[],
  opts?: FlagLookupOptions,
): string[] {
  const flagSet = typeof flags === "string" ? [flags] : flags;
  const glueLetters = glueLettersFor(flagSet, opts);
  const argsArr = args ?? [];
  const collected: string[] = [];
  for (let i = 0; i < argsArr.length; i++) {
    const match = matchFlagAt(wordValue(argsArr[i]), flagSet, glueLetters);
    if (!match) continue;
    if (match.kind === "exact") {
      const next = argsArr[i + 1];
      if (next === undefined) continue;
      const nextVal = wordValue(next);
      if (nextVal === "") continue;
      collected.push(nextVal);
    } else {
      collected.push(match.value);
    }
  }
  return collected;
}

/**
 * `true` if `envAssignments` contains a shell env-var assignment
 * matching `name`. Shell env prefixes (`VAR=value cmd ...`) are
 * extracted by the walker into a separate slot on `ctx.input`; this
 * helper reads them directly without scanning the arg list.
 *
 * The comparison is literal on the variable name \u2014 `hasEnvAssignment`
 * does NOT match partial prefixes (e.g. `AWS_PROFILE=x` does not
 * satisfy `AWS`).
 *
 * @example
 *   // ctx.input.envAssignments for `AWS_PROFILE=dev aws s3 ls`
 *   hasEnvAssignment([W("AWS_PROFILE=dev")], "AWS_PROFILE"); // true
 *   hasEnvAssignment([W("AWS_PROFILE=dev")], "AWS");         // false
 */
export function hasEnvAssignment(
  envAssignments: readonly Word[] | undefined,
  name: string,
): boolean {
  const prefix = `${name}=`;
  for (const w of iterWords(envAssignments)) {
    const t = wordValue(w);
    if (t.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Default set of info-only flags, matching only the long forms
 * `--help` and `--version`.
 *
 * `-h` and `-v` are deliberately EXCLUDED: they are real operations
 * in adversarial commands (`docker run -v /data:/data`, `curl -v`,
 * `kubectl -v 8`, `psql -h host`), so a default info-only set must
 * never treat them as carve-outs. Add them per-CLI via
 * {@link isInfoOnly}'s `extraFlags` when a rule author owns that
 * tradeoff for their own tool.
 */
export const INFO_FLAGS = ["--help", "--version"] as const;

/**
 * `true` if `args` contains any info-only flag (token-level, quote-
 * aware). Checks the default {@link INFO_FLAGS} set plus any additive
 * `extraFlags`.
 *
 * Unlike the old `INFO_ONLY` regex, this matches on TOKENS, so a help
 * string inside a quoted VALUE (`gh pr merge --subject "see --help"`)
 * does NOT count — the token there is a value, not a flag. The
 * attached-value form `--help=x` DOES count (via {@link hasFlag}'s
 * prefix semantics), matching how real CLIs parse it.
 *
 * @example
 *   isInfoOnly([W("--help")]);                    // true
 *   isInfoOnly([W("see --help")]);                // false (a value)
 *   isInfoOnly([W("-v")]);                        // false (not in default set)
 *   isInfoOnly([W("-v")], ["-v"]);               // true  (additive extra)
 */
export function isInfoOnly(
  args: readonly Word[] | undefined,
  extraFlags?: readonly string[],
): boolean {
  const flags = [...INFO_FLAGS, ...(extraFlags ?? [])];
  return flags.some((f) => hasFlag(args, f));
}
