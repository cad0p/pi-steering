# Publishing plan (deferred)

All four packages (`@cad0p/pi-steering`, `unbash-walker`, `pi-steering-commit-format`, `pi-steering-flags`) are currently `private: true` with version `0.0.0-poc.0`. Publishing is deferred and gated; this document is the runbook for when it happens.

## Post-split state (2026-08-10)

The monorepo was split into four standalone repos, each with its own CI (`ci.yml`, pnpm + node 24 + biome + tsc + node --test):

- `@cad0p/pi-steering` — this repo (renamed from `pi-steering-hooks`; keeps the full git history, issues, and PRs).
- `cad0p/unbash-walker` — the AST/tracker utility. Consumed here via `"unbash-walker": "github:cad0p/unbash-walker"` (resolvable pre-publish; `prepare` builds `dist` on install).
- `cad0p/pi-steering-commit-format`, `cad0p/pi-steering-flags` — the two official plugins, peer-depending on `@cad0p/pi-steering` via `github:cad0p/pi-steering`.

## Gate criteria

Before the first npm publish, both of these must be true:

1. The `unbash-walker` extraction proposal has been filed on [`jdiamond/pi-guard`](https://github.com/jdiamond/pi-guard) and jdiamond has responded (accept/decline/defer), OR two weeks have elapsed since the proposal was filed. The two-week timeout exists to keep the publishing decision unblocked when upstream maintainers are busy; it isn't a deadline for jdiamond.
2. The release gate ADR (2026-05-08) v0.1.0 must-items are complete (this repo's CHANGELOG tracks the v0.1.x pre-publish status).

## What changes at publish time

1. **npm OIDC trusted publishing** (per repo, on npmjs.com): add the GitHub repository as an OIDC publisher for each unscoped package name — `unbash-walker`, `@cad0p/pi-steering`, `pi-steering-commit-format`, `pi-steering-flags`. This is a manual npmjs.com step; the release workflow below assumes it.
2. **Version/manifest bumps per repo**, in dependency order:
   - `cad0p/unbash-walker`: drop `"private": true`, bump to `0.1.0`. Publish FIRST.
   - `cad0p/pi-steering`: drop `"private": true`, bump to `0.1.0`, swap `"unbash-walker": "github:cad0p/unbash-walker"` → `"unbash-walker": "^0.1.0"`. Publish SECOND.
   - `cad0p/pi-steering-commit-format` + `cad0p/pi-steering-flags`: drop `"private": true`, bump to `0.1.0`, swap the `@cad0p/pi-steering` peer/dev github: specs → `^0.1.0`. Publish LAST (either order).
3. **Add the release workflows** to each repo from [`cad0p/semver-calver-release/examples/basic-npm-package`](https://github.com/cad0p/semver-calver-release/tree/main/examples/basic-npm-package): `release.yml` (push to `main` + `release/*`; OIDC `id-token: write`), `validate-package-version.yml`, `validate-release-pr.yml`. Branch triggers use `main` as-is.
4. **README install instructions** flip from `pi install git:github.com/cad0p/pi-steering` to `pi install npm:pi-steering`.

## Remaining pre-publish cleanups

- The fork relationship to `samfoy/pi-steering-hooks` is gone with the rename — no detach needed.
- The `github:` dependency specs are the only pre-publish wart; they are swapped for npm ranges in step 2 above.

## v1 API stability considerations

These are API-surface decisions to revisit before cutting v1.0 (after shipping as 0.x to gather real usage).

### `BashContext` couples consumers to `unbash-walker`'s `CommandRef`

The `prepareBashContext(command, sessionCwd): BashContext` helper exposes `refs: readonly CommandRef[]` and `cwdMap: ReadonlyMap<CommandRef, string>` in its return type. `CommandRef` is defined in `unbash-walker` and carries unbash's AST node shape. Downstream consumers who keep a `BashContext` across evaluations are transitively coupled to:

- `unbash-walker`'s exported `CommandRef` type (now its own package/repo).
- `unbash`'s `Command` node type inside `CommandRef.node`.

**Why it's in the public API today.** `prepareBashContext` + `evaluateBashRuleWithContext` is the hot-path alternative to `evaluateBashRule` for callers evaluating many rules against one command — the split avoids re-parsing per rule. Exposing the context lets those callers reuse work across rules.

**Options to revisit at v1.0.**

1. **Keep as-is.** `unbash-walker` ownership transition happens first (via the extraction proposal to jdiamond); `CommandRef` stabilizes there. v1.0 re-exports it from this package as a stable type.
2. **Opaque handle.** Make `BashContext` a nominal type with no enumerable fields. Consumers pass it through but can't introspect. Requires a second helper for any consumer that needs to look at individual refs.
3. **Flatten the context into plain data.** Pre-stringify everything into `{ commands: readonly { text: string; cwd: string }[] }` with no AST references. Simplest, loses downstream utility (consumers who want wrapper-expansion metadata have to re-parse).

For 0.x: keep as-is; mark the type `@experimental` in JSDoc. For v1.0: decide based on how consumers end up using it.

### `Rule.when` is open for future predicates

`Rule.when` is typed as `{ cwd?: string }` today. Additional predicates (`branch`, `env`, `time-of-day`) were flagged as future work by samfoy (and we agree). At v1.0, consider either:

- Adding known predicates as optional peers (`branch?: string`, etc.). Schema grows but stays flat.
- Keeping `cwd` as the only built-in and documenting `when.<key>` as an extension point for custom evaluators.

Only affects v1.0 if predicates beyond `cwd` land before it.
