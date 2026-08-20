// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Git plugin for `@cad0p/pi-steering`.
 *
 * Subpath import: `pi-steering/plugins/git`.
 *
 * Registers (in the terms of `Plugin`):
 *
 *   - `predicates`         - `branch`, `upstream`, `commitsAhead`,
 *                             `hasStagedChanges`, `isClean`, `remote`.
 *                             See the per-item files under
 *                             `./predicates/` for the arg shapes each
 *                             handler accepts.
 *   - `rules`              - `no-main-commit-github` (github-flavored,
 *                             first-match-wins) + `no-main-commit`
 *                             (generic fallback). Both overridable.
 *                             Users disable via
 *                             `disabledRules: ["no-main-commit"]` /
 *                             `["no-main-commit-github"]` or opt out
 *                             of the whole plugin with
 *                             `disabledPlugins: ["git"]`.
 *   - `trackers.branch`    - sequential `git checkout` / `git switch`
 *                             branch tracker. See `./trackers/branch-tracker.ts`.
 *   - `trackerExtensions.cwd.git`
 *                            - per-command `--git-dir=` / `--work-tree=`
 *                              parser layered on the core cwd tracker.
 *                              See `./trackers/cwd-extensions.ts`.
 *
 * Also re-exported as composable building blocks for downstream
 * plugins (e.g. RDS-style multi-package `cr --all` scans that need
 * to query git state per subpackage directory):
 *
 *   - `getBranch(ctx, cwd?)`            — current branch or `null`
 *   - `getUpstream(ctx, cwd?)`          — upstream name or `null`
 *   - `getCommitsAhead(ctx, wrt?, cwd?)` — commit count or `null`
 *   - `getStagedChanges(ctx, cwd?)`     — boolean or `null`
 *   - `getWorkingTreeClean(ctx, cwd?)`  — boolean or `null`
 *   - `getRemoteUrl(ctx, cwd?)`         — origin URL or `null`
 *   - `walkerString(value)`             — walker-sentinel narrowing
 *                                          helper for plugin-author
 *                                          predicates
 *   - `NO_CHECKOUT_IN_CHAIN`            — branch-tracker fall-through
 *                                          sentinel
 *   - `GIT_COMMIT_PATTERN`              — shared `git commit` regex
 *                                          source used by both
 *                                          commit-on-main rules
 *   - `PROTECTED_BRANCH_PATTERN`         — shared protected-branch
 *                                          regex (main / master /
 *                                          mainline / trunk) used by
 *                                          both commit-on-main rules
 *
 * See `./helpers/git-ops.ts` for the helper contract (all collapse
 * failure modes to `null`; caller decides what to do with it).
 *
 * Opt-in since the v0.1.x monorepo split: `DEFAULT_PLUGINS` is empty,
 * so this plugin is registered ONLY when the user declares it:
 *
 * ```ts
 * import gitPlugin from "@cad0p/pi-steering/plugins/git";
 * export default defineConfig({ plugins: [gitPlugin] });
 * ```
 *
 * Declaring it explicitly also feeds its rule / predicate names into
 * `defineConfig`'s type unions (typo-checking on `disabledRules` /
 * `disabledPlugins`); relying on a default would silently widen the
 * union and let typos through.
 *
 * Tests build configs via `loadHarness({ includeDefaults: false })`
 * and pass the plugin explicitly.
 *
 * ## Note for plugin authors
 *
 * This is the canonical reference plugin. Third-party plugins are
 * expected to mirror this layout - one file per concern (tracker /
 * extension / predicates / rules), a terse default export assembling
 * them. Copy-adapt liberally.
 */

import type { Tracker } from "@cad0p/unbash-walker";
import type { DEFAULT_PLUGINS } from "../../defaults.ts";
import type {
  AnyPredicateHandler,
  BuiltInWhenLeaves,
  Patterns,
  Plugin,
  PredicateShape,
  Rule,
} from "../../schema.ts";
import { branch } from "./predicates/branch.ts";
import { commitsAhead } from "./predicates/commits-ahead.ts";
import { hasStagedChanges } from "./predicates/has-staged-changes.ts";
import { isClean } from "./predicates/is-clean.ts";
import { remote } from "./predicates/remote.ts";
import { upstream } from "./predicates/upstream.ts";
import { noMainCommit } from "./rules/no-main-commit.ts";
import { noMainCommitGithub } from "./rules/no-main-commit-github.ts";
import { branchTracker } from "./trackers/branch-tracker.ts";
import { gitCwdExtensions } from "./trackers/cwd-extensions.ts";

declare global {
  /**
   * gitPlugin's typed-predicate registry. Each entry declares the
   * predicate's `bare` value type and (optionally) an explicit
   * `spreadBase` (the spread's object form WITHOUT modifiers).
   * Modifiers (currently `onUnknown:`) are added at use site via
   * `& PredicateModifiers` (outer leaf) or at the not-block top
   * level (inside `not:`).
   *
   * Note: `cwd` is intentionally NOT in this block. It's a built-in
   * non-registry leaf on {@link BuiltInWhenLeaves} (see schema.ts) so
   * authors can write `when: { cwd: /work/ }` against pi-steering core
   * without needing gitPlugin's module augmentation in scope. The
   * runtime handler that wires `when.cwd` to the walker still lives
   * in pi-steering core; gitPlugin layers `git --git-dir=` /
   * `--work-tree=` cwd extensions via {@link gitCwdExtensions} but
   * does not own the predicate's registry shape.
   *
   * @see PredicateShape, DefaultSpreadBase, PredicateModifiers in
   *      `schema.ts` for the full registry contract.
   */
  interface PiSteeringPredicates {
    /**
     * `when.branch` — match the current git branch. Pattern leaf,
     * tracker-aware (in-chain `git checkout X` resolves statically;
     * dynamic `git checkout $VAR` surfaces the walker's
     * `"unknown"` sentinel — the engine's `onUnknown:` policy
     * then projects to a definite verdict).
     */
    branch: PredicateShape<Patterns>;

    /**
     * `when.upstream` — match the current branch's configured
     * upstream (`git rev-parse --abbrev-ref @{upstream}`). Pattern
     * leaf. Inlines a walker-unknown-cwd guard at the handler
     * top — surfaces trinary `"unknown"` instead of querying the
     * wrong repo when the walker can't statically resolve cwd.
     */
    upstream: PredicateShape<Patterns>;

    /**
     * `when.remote` — match the repo's `origin` remote URL
     * (`git config --get remote.origin.url`). Pattern leaf. Same
     * walker-unknown-cwd guard as `upstream:`.
     */
    remote: PredicateShape<Patterns>;

    /**
     * `when.isClean` — `true` when the working tree has no
     * unstaged / untracked / staged changes (`git status
     * --porcelain` is empty); `false` otherwise. Boolean leaf;
     * spreadBase auto-detects to `{ value: boolean }`. Inlines
     * the walker-unknown-cwd guard.
     */
    isClean: PredicateShape<boolean>;

    /**
     * `when.hasStagedChanges` — `true` when there are staged
     * changes (`git diff --cached --quiet` exits non-zero);
     * `false` otherwise. Boolean leaf. Inlines the walker-
     * unknown-cwd guard.
     */
    hasStagedChanges: PredicateShape<boolean>;

    /**
     * `when.commitsAhead` — match when the count of commits ahead
     * of `wrt:` (default `@{upstream}`) satisfies every supplied
     * comparator. Bare shorthand `commitsAhead: N` is equivalent
     * to `{ eq: N }`. Spread form supports:
     *   - `eq?: number` — exact equality (`count === eq`).
     *   - `gt?: number` — strict greater-than (`count > gt`).
     *   - `lt?: number` — strict less-than (`count < lt`).
     *   - `wrt?: string` — git revision to count against (default
     *     `"@{upstream}"`).
     * At least one of `eq` / `gt` / `lt` MUST be specified;
     * combined with AND.
     *
     * Mixed-bare predicate: explicit `SpreadBase` since auto-
     * detection from `number` would give `{ value: number }`,
     * which doesn't match the desired comparator-bag shape.
     * Inlines the walker-unknown-cwd guard.
     */
    commitsAhead: PredicateShape<
      number,
      { eq?: number; gt?: number; lt?: number; wrt?: string }
    >;
  }
}

/**
 * Predicate handlers the git plugin registers under
 * `Plugin.predicates`. Keys become the `when.<key>` slots rule authors
 * see.
 *
 * Typed as `Record<string, AnyPredicateHandler>` to match
 * {@link Plugin.predicates} at the registry boundary — each handler's
 * concrete argument shape is preserved in its own module, and
 * consumers can import `commitsAhead`, `isClean`, etc. directly when
 * they want the narrow type.
 */
export const predicates: Record<string, AnyPredicateHandler> = {
  branch,
  upstream,
  commitsAhead,
  hasStagedChanges,
  isClean,
  remote,
};

/**
 * Suggested rules for the git plugin.
 *
 * **Order matters — first-match-wins.** The github-specific rule
 * (`no-main-commit-github`) is placed BEFORE the generic
 * (`no-main-commit`) so on github clones + on main, the github
 * rule's `remote:` predicate matches → fires first → user gets
 * PR-flow guidance. On non-github contexts (Brazil packages, vault
 * paths, scratch repos with non-github remotes) the github rule's
 * `remote:` predicate doesn't match → the engine falls through to
 * the generic `no-main-commit`. Reordering for stylistic reasons
 * breaks this routing; pinned via a unit test in `./index.test.ts`.
 */
export const rules = [
  noMainCommitGithub,
  noMainCommit,
] as const satisfies readonly Rule[];

/**
 * The git plugin. Default export so `import gitPlugin from
 * "pi-steering/plugins/git"` gives you the whole thing.
 *
 * `as const satisfies Plugin` (rather than `: Plugin`) preserves the
 * literal `name: "git"` in the inferred type. That literal is the
 * input to any future `AllPluginNames<P>`-style inference in
 * `defineConfig`, which needs `name: "git"`, not `name: string`, to
 * offer string-literal completion for e.g. `disabledPlugins`.
 */
const gitPlugin = {
  name: "git",
  predicates,
  rules,
  trackers: {
    // `Plugin.trackers` is typed `Record<string, Tracker<unknown>>`
    // because the schema can't commit to a specific T per tracker.
    // Cast is safe - the walker dispatches on `modifiers[basename]`
    // and never narrows T at the tracker-registry layer.
    branch: branchTracker as unknown as Tracker<unknown>,
  },
  trackerExtensions: {
    cwd: {
      git: gitCwdExtensions,
    },
  },
} as const satisfies Plugin;

/**
 * Type-level regression sentinel: if the plugin literal ever loses
 * the `name: "git"` narrowing (for example, someone reintroducing
 * `: Plugin` annotation), the inferred type of `GIT_PLUGIN_NAME`
 * widens to `string` and any downstream literal-name inference
 * breaks. Keep this export in place to fail compilation loudly when
 * that happens.
 */
export const GIT_PLUGIN_NAME: "git" = gitPlugin.name;

export default gitPlugin;

export {
  getBranch,
  getCommitsAhead,
  getRemoteUrl,
  getStagedChanges,
  getUpstream,
  getWorkingTreeClean,
} from "./helpers/git-ops.ts";
export {
  branch,
  type WalkerStringResult,
  walkerString,
} from "./predicates/branch.ts";
export {
  type CommitsAheadArgs,
  commitsAhead,
} from "./predicates/commits-ahead.ts";
export { hasStagedChanges } from "./predicates/has-staged-changes.ts";
export { isClean } from "./predicates/is-clean.ts";
export { remote } from "./predicates/remote.ts";
export { upstream } from "./predicates/upstream.ts";
export {
  GIT_COMMIT_PATTERN,
  PROTECTED_BRANCH_PATTERN,
} from "./helpers/patterns.ts";
export { noMainCommit, noMainCommitGithub };
// Named re-exports for consumers that want to pick pieces (e.g. a
// test harness constructing a minimal config that uses only the
// `branch` predicate without the shipped rule).
export {
  branchTracker,
  NO_CHECKOUT_IN_CHAIN,
} from "./trackers/branch-tracker.ts";
export { gitCwdExtensions } from "./trackers/cwd-extensions.ts";
