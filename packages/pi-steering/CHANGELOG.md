# Changelog

All notable changes to `pi-steering` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project will adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
once `v0.1.0` publishes to npm.

## [Unreleased] — pre-publish (v0.1.x)

### Breaking

- Factory-time throw on any warning-class loader/merger diagnostic by default. Opt out via `defineConfig({ failOnWarnings: false })`.
- Tracker-name collisions are now detected at config-load time and surfaced as an `error`-class diagnostic that aggregates with other diagnostics (single thrown error per factory invocation, not multiple sequential throws). Errors always throw regardless of `failOnWarnings` (see schema JSDoc).
- `disabledPlugins` / `disabledRules` are now applied BEFORE cross-layer collision detection in `buildConfig`. A user resolving a duplicate-plugin warning by adding the plugin to `disabledPlugins` now sees the warning go away.
- `loadConfigs(cwd)`, `buildConfig(layers, defaults?)`, `loadSteeringConfig(cwd, defaults?)` return shape changed (now include `diagnostics` field). Internal `buildSessionRuntime` return shape changed. Bridge default factory is now async.
- `PluginResolveWarning` interface renamed to `SteeringDiagnostic` with extended `kind` union (covers loader-side categories) and required `type: "warning" | "error"` field.

### Visibility improvement (not a regression)

Some plugin-merger warnings (predicate / observer / rule / extension-orphan collisions) were previously collected into an internal array and never logged. Under `failOnWarnings: false` they are now emitted to `console.warn` for parity with loader-side warnings; under `failOnWarnings: true` (default) they're aggregated into the factory throw.

Note: `plugin-disabled` and `rule-disabled` (the legacy fail-soft warnings `resolvePlugins` previously emitted for `disabledPlugins` / `disabledRules` opt-outs) are NOT in the diagnostic stream — they describe successful by-design behavior (the user explicitly opted out). They surface via `console.info` debugging breadcrumbs, mirroring `dropUnusedObservers`.
