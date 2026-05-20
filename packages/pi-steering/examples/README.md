# Rule-pack examples

Curated rule-pack examples for common workflows. Each subdirectory
ships both a TypeScript config (`steering.ts`) and a JSON config
(`steering.json`). Each has its own README with rationale.

| Example | What it enforces | Best for |
|---------|------------------|----------|
| [force-push-strict](./force-push-strict) | No force pushes of any kind (not even `--force-with-lease`) | Shared branches, strict-history teams |
| [no-amend](./no-amend) | No `git commit --amend`. Includes a cwd-scoped variant | Review-driven workflows where commit-SHA stability matters |
| [draft-prs-only](./draft-prs-only) | `gh pr create` requires `--draft` | Teams that require human review before marking ready |
| [combined-git-discipline](./combined-git-discipline) | All three above | Starting point for disciplined PR teams |
| [dynamic-reason-runtime-cwd](./dynamic-reason-runtime-cwd) | Composes a runtime-cwd predicate (`isClean`) with a two-branch `ReasonFn` using `walkerUnknownCwdReason` | Plugin authors writing rules over runtime-cwd predicates that need useful agent reasons on the walker-unknown branch |
| [work-item-plugin](./work-item-plugin) | Canonical example PLUGIN (not a rule-pack). See the plugin's own README. | Authors writing a new plugin |

Each rule-pack directory has smoke tests (`steering.test.ts`) that
verify the config compiles under the current `defineConfig` API and
exposes the expected shape. Behavioural coverage (every pattern,
every wrapper form) lives in the engine's own test suite.

## How to use

### TypeScript (canonical)

1. **Copy** `steering.ts` from an example directory into one of:
   - `~/.pi/steering.ts` (or `~/.pi/steering/index.ts`) — applies globally.
   - `<your-project>/.pi/steering.ts` — applies to this project tree (walk-up loader).
2. **Tweak** as needed — the exported default is a plain
   [`SteeringConfig`](../src/schema.ts), so you can add rules,
   merge with other packs by spreading, or import a plugin.
3. **Verify** the rule is active by running `pi` in the target
   directory; the rules load on `session_start`.

### JSON

The loader does **not** load `.pi/steering.json` files directly — only
`.pi/steering.ts` / `.pi/steering/index.ts`. To migrate an existing
JSON config:

1. Convert with the CLI: `pi-steering import-json .pi/steering.json -o .pi/steering/index.ts`
2. Or programmatically: `fromJSON(JSON.parse(text))` from
   [`compat.ts`](../src/compat.ts), if you're wrapping the conversion
   in your own tooling.

Each example ships a `steering.json` for reference / migration
testing — they're authored against the v0 PoC shape so
`pi-steering import-json` round-trips them cleanly. They do **not**
participate in the loader's `.pi/` walk-up; only the `.ts` form does.

JSON is a deliberate **subset** of the TypeScript schema: pattern-string
rules, `requires` / `unless`, `when.cwd` (string pattern only), and
override flags. Plugins, observers, function-valued rule fields,
plugin-registered predicate keys (`when.<customKey>`), `when.not`,
and `when.condition` are TypeScript-only — `pi-steering import-json`
rejects them with `FromJSONError`. Equivalently: any `when` clause
member other than `when.cwd` is rejected.

If you're not ready to migrate, the v0 runtime had its own loader that
did load JSON; staying on v0 is an option until you convert.

## Verifying a rule works

The quickest smoke-check: run the example's blocked command inside a
pi session and confirm the agent surfaces the `[steering:<rule-name>@<source>] …` block message. Each example directory's
`steering.test.ts` pins the config's structural contract; the engine's
own test suite exercises the rules against realistic inputs.

See the [package README](../README.md) for the schema details
(`pattern`, `requires`, `unless`, `when.cwd`, `reason`,
`noOverride`) and the [repo README](../../../README.md) for the
overall architecture.
