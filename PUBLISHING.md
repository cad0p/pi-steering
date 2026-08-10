# Publishing

**Status: PUBLISHED.** All four packages ship on npm under the `@cad0p` scope (2026-08-10), version `0.1.0`:

- [`@cad0p/unbash-walker`](https://www.npmjs.com/package/@cad0p/unbash-walker)
- [`@cad0p/pi-steering`](https://www.npmjs.com/package/@cad0p/pi-steering)
- [`@cad0p/pi-steering-flags`](https://www.npmjs.com/package/@cad0p/pi-steering-flags)
- [`@cad0p/pi-steering-commit-format`](https://www.npmjs.com/package/@cad0p/pi-steering-commit-format)

## How releases work now

Every repo carries the `cad0p/semver-calver-release` workflows (`release.yml`, `validate-package-version.yml`, `validate-release-pr.yml` — copied from `examples/basic-npm-package`):

- **Push to `main` with code changes** → hybrid SemVer+CalVer prerelease (`0.1.0-YYYYMMDD.N`), tagged + GitHub prerelease, published to npm with the `next` dist-tag, and the draft changelog PR on `release/from-v0.1.0` is updated.
- **Curated base release** (e.g. `0.1.1`): edit CHANGELOG on `release/from-v0.1.0`, bump `package.json`, merge the draft PR. Floating tags (`v0`, `v0.1`) move on base releases only.
- **Validation**: `validate-package-version` (version must not change on normal PRs; CHANGELOG edits belong on release branches) and `validate-release-pr` are required status checks on the `main` ruleset.

## npm publishing mechanics

- **OIDC trusted publishing** (npmjs.com → Access Tokens → GitHub Actions) is configured per package: owner `cad0p`, repository `<repo>`, workflow `release.yml`. No npm tokens/secrets needed.
- The `npm-publish` action fetches the OIDC token (`audience=npm`) itself, sets the version from the release tag, runs `npm install` (pnpm is installed on the runner for `prepare: pnpm build` — fixed upstream in semver-calver-release v1.2.3), and publishes `--access public` (`--tag next` for prereleases).
- `publishConfig.access: public` is set in every manifest.

## History

- 2026-05-08 ADR planned **unscoped** names (`pi-steering`, `unbash-walker`) with a jdiamond/pi-guard extraction gate. Both reversed on 2026-08-10 at the maintainer's request: published **scoped** under `@cad0p` (consistent with `@cad0p/pi-napkin`, `@cad0p/pi-tree-navigator`), no upstream gate — the packages are published as-is; a future pi-guard adoption can fork the code rather than the names.
- The unscoped names remain free on npm.

## Pre-publish trivia (kept for context)

- 0.1.0 was published from the CLI with 2FA web-auth per publish; the release workflows have taken over since.
- `blockExoticSubdeps` / `github:` dependency specs were the pre-publish wiring; all deps are registry ranges now.
