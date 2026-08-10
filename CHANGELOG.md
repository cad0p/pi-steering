# Changelog

All notable changes to this project will be documented in this file.

## [calver-released]

<!-- USER-EDITABLE SECTION START -->
<!-- Add your curated release notes here. -->
<!-- USER-EDITABLE SECTION END -->

### 📚 Documentation

- PUBLISHING.md reflects scoped @cad0p publish + semver-calver-release flow ([#15](https://github.com/cad0p/pi-steering/pull/15))


## [0.1.0] — 2026-08-10

### Added

- First public npm release as `@cad0p/pi-steering` (scoped — reverses the ADR's unscoped-name decision per maintainer request).
- `publishConfig.access: public` for OIDC/CLI publishing.

### Changed

- `unbash-walker` dependency: `github:cad0p/unbash-walker` → `@cad0p/unbash-walker ^0.1.0`.

## [Unreleased] — pre-publish (v0.1.x)

### Changed

- Monorepo split (2026-08-10): this repo is now `cad0p/pi-steering` (renamed from `pi-steering-hooks`); `unbash-walker`, `pi-steering-commit-format`, and `pi-steering-flags` moved to their own repos. The git plugin is now **opt-in** — `DEFAULT_PLUGINS` is empty; declare `plugins: [gitPlugin]` (import from `pi-steering/plugins/git`) to register it. This restores compile-time typo-checking on `disabledRules` / `disabledPlugins` for configs that declare their plugins (runtime defaults and type-level visibility can no longer diverge).

### Breaking

- Factory-time throw on any warning-class loader/merger diagnostic by default. Opt out via `defineConfig({ failOnWarnings: false })`.
- Tracker-name collisions are now detected at config-load time and surfaced as an `error`-class diagnostic that aggregates with other diagnostics (single thrown error per factory invocation, not multiple sequential throws). Errors always throw regardless of `failOnWarnings` (see schema JSDoc).
- `disabledPlugins` / `disabledRules` are now applied BEFORE cross-layer collision detection in `buildConfig`. A user resolving a duplicate-plugin warning by adding the plugin to `disabledPlugins` now sees the warning go away.
- `loadConfigs(cwd)`, `buildConfig(layers, defaults?)`, `loadSteeringConfig(cwd, defaults?)` return shape changed (now include `diagnostics` field). Internal `buildSessionRuntime` return shape changed. Bridge default factory is now async.
- `PluginResolveWarning` interface renamed to `SteeringDiagnostic` with extended `kind` union (covers loader-side categories) and required `type: "warning" | "error"` field.

### Changed

Visibility improvement: some plugin-merger warnings (predicate / observer / rule / extension-orphan collisions) were previously collected internally and never logged. They now flow through the same `failOnWarnings` policy as loader-side warnings: aggregated into the factory throw under the default, or emitted to `console.warn` with the opt-out.
