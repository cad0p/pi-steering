# Changelog

All notable changes to this project will be documented in this file.

## [calver-released]

<!-- USER-EDITABLE SECTION START -->
<!-- Add your curated release notes here. -->
<!-- USER-EDITABLE SECTION END -->

### 🚀 Features

- Exemption registry — composable carve-outs for guard rules ([#26](https://github.com/cad0p/pi-steering/pull/26)) ([#27](https://github.com/cad0p/pi-steering/pull/27))
- Clean reload via jiti evalModule — transitive config reload, drop Node 22 floor ([#23](https://github.com/cad0p/pi-steering/pull/23)) ([#31](https://github.com/cad0p/pi-steering/pull/31))
- Lazy session_start runtime build — register-only sync factory ([#9](https://github.com/cad0p/pi-steering/pull/9)) ([#30](https://github.com/cad0p/pi-steering/pull/30)) ([#37](https://github.com/cad0p/pi-steering/pull/37))
- Gate project-layer steering configs behind pi's project trust ([#22](https://github.com/cad0p/pi-steering/pull/22)) ([#40](https://github.com/cad0p/pi-steering/pull/40))
- Weekly upstream drift check for the trust gate — mirror-fidelity test + drift workflow ([#42](https://github.com/cad0p/pi-steering/pull/42)) ([#43](https://github.com/cad0p/pi-steering/pull/43))
- Compile-time detection of orphan plugin exemptions ([#29](https://github.com/cad0p/pi-steering/pull/29)) ([#46](https://github.com/cad0p/pi-steering/pull/46))
- Escalate plugin-shipped exemption orphans to error-class at merge (closes #48)
- Resolved-by-default Word.text — predicates validate what executes (closes #51)
- *(defaults)* Seal no-force-push — block --force-with-lease, +refspec force, --mirror (closes #65)
- *(git-plugin)* Make no-main-commit pair non-overridable (closes #79)
- *(defaults)* Distribute DEFAULT_RULES into git/rm/async plugins; remove engine-defaults machinery (closes #72) ([#83](https://github.com/cad0p/pi-steering/pull/83))
- Block reasons always state the tool call was not executed (closes #85)
- Re-export expandTildeIfLeading in the curated walker surface (closes #87)
- *(core)* Built-in ARGV leaves (closes #90)
- *(core)* Promote flag primitives to core root (P3, closes #99)

### 🐛 Bug Fixes

- Await async factory + re-align smoke harness to v2 loader contract ([#34](https://github.com/cad0p/pi-steering/pull/34)) ([#35](https://github.com/cad0p/pi-steering/pull/35))
- Set GH_TOKEN in drift-check Report step (e2e-caught) ([#44](https://github.com/cad0p/pi-steering/pull/44))
- Bash-faithful Word resolution — drop the same-ref prefix overlay (closes #53) ([#56](https://github.com/cad0p/pi-steering/pull/56))
- Rename when.happened to when.missing (closes #55) ([#57](https://github.com/cad0p/pi-steering/pull/57))
- Observer watch matching resolves plugin-composed env trackers (closes #54)
- Work-item-format fixture rawText shape + CI examples typecheck (closes #60)

### 🚜 Refactor

- Git plugin → per-item layout (work-item-plugin structure, zero behavior change) (closes #62)
- Drop per-folder bundles in plugins/git — top-level assembly shape (closes #64)
- *(core)* Walker locateSubcommandRun replaces scanSubcommandWords mirror (closes #91)

### 📚 Documentation

- *(schema)* State all-leaves-AND semantics in when: TSDoc (closes #78) ([#80](https://github.com/cad0p/pi-steering/pull/80))
- Walker-dependency house rule — no direct unbash-walker dep (closes #93)
- Contributor test conventions — no redundant pins (closes #97)

### ⚡ Performance

- Pin jiti fsCache to package-local node_modules/.cache/jiti ([#38](https://github.com/cad0p/pi-steering/pull/38)) ([#39](https://github.com/cad0p/pi-steering/pull/39))

### ⚙️ Miscellaneous Tasks

- Modern-API budget harvest — @types/node ^22 + ES2024 lib, import.meta.main, fs.globSync, strip-types cleanup ([#32](https://github.com/cad0p/pi-steering/pull/32)) ([#33](https://github.com/cad0p/pi-steering/pull/33))


## [0.2.0] - 2026-08-11

<!-- USER-EDITABLE SECTION START -->
### Breaking

- **Two-layer config resolution** (issue [#21](https://github.com/cad0p/pi-steering/issues/21)): the loader now mirrors pi's own settings model instead of walking up `cwd → $HOME`. Exactly two fixed layers — the project layer at `<cwd>/.pi/steering/` and the global layer at `<agentDir>/steering/` (`~/.pi/agent/steering/`, or `$PI_CODING_AGENT_DIR` when set) — merged project-first (project wins on rule-name collision). Intermediate ancestor layers no longer load, and `~/.pi/steering/` is no longer special (no alias, no deprecation diagnostic): it only works when pi is launched from `$HOME` itself, where the project layer IS that path.
- **Migration:** `mv ~/.pi/steering ~/.pi/agent/steering`. No fallback is provided — the old path stops being discovered once this version ships.
<!-- USER-EDITABLE SECTION END -->

### 🚀 Features

- Two-layer config resolution — project `.pi/steering/` + global `agentDir/steering/`, walk-up removed ([#21](https://github.com/cad0p/pi-steering/pull/21)) ([#25](https://github.com/cad0p/pi-steering/pull/25))

### 🐛 Bug Fixes

- Approve peer-graph build scripts (@google/genai, protobufjs) in pnpm-workspace.yaml ([#17](https://github.com/cad0p/pi-steering/pull/17))

### 📚 Documentation

- PUBLISHING.md reflects scoped @cad0p publish + semver-calver-release flow ([#15](https://github.com/cad0p/pi-steering/pull/15))
- Npm install line for published scoped package ([#20](https://github.com/cad0p/pi-steering/pull/20))

### 🎨 Styling

- Biome format + organizeImports after scoped-rename edits ([#18](https://github.com/cad0p/pi-steering/pull/18))


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
