# force-push-strict

A rule pack that blocks **every** form of `git push --force`, including `--force-with-lease`.

## What it enforces

- `git push --force` → blocked
- `git push -f` → blocked
- `git push --force-with-lease` → **blocked** (this is the difference from the default)
- `git push origin main` → allowed

The pattern also handles git pre-subcommand flags (`git -C /other push --force`, `git -c key=val push -f`) and wrapper bypasses (`sh -c 'git push --force'`, `sudo xargs git push --force`, …) — all transparently, via the AST backend.

## How it differs from the default

The built-in `no-force-push` rule permits `--force-with-lease` because the lease flag is the documented "safe" way to update a branch after a rebase. That's fine for most teams, but in environments where:

- the branch is shared broadly (`main`, `develop`, long-lived release branches),
- history integrity is a compliance requirement, or
- you want the agent to never reach for any `--force` variant as a first-line fix,

the lease-variant carve-out is an attack surface. This rule pack closes it.

## When to use

- Strict-history environments (shared release branches, regulated contexts)
- Teams that want a single "never force push" discipline without agent-side judgement calls
- As a starting point for more restrictive house rules

## Install

Two equivalent forms. Pick whichever matches your setup.

### TypeScript form (canonical)

Copy [`steering.ts`](./steering.ts) to `~/.pi/agent/steering.ts` (or
`<project-root>/.pi/steering.ts`) for a repo-scoped policy. The
TypeScript form participates in compile-time checking via
`defineConfig`. The loader accepts TypeScript only.

### JSON form (for migration)

The loader does **not** load `.pi/steering.json` files directly. The
[`steering.json`](./steering.json) below is provided as a reference
shape for `pi-steering import-json` migration — convert it with
`pi-steering import-json steering.json -o .pi/steering/index.ts` (or
programmatically via `fromJSON` from `compat.ts`).

JSON is a deliberate subset of the TypeScript shape: pattern-string
rules, `requires` / `unless`, `when.cwd` (string pattern only), and
override flags. Plugins, observers, function-valued rule fields,
plugin-registered predicate keys (`when.<customKey>`), `when.not`,
and `when.condition` are TypeScript-only — equivalently, any `when`
clause member other than `when.cwd` is rejected.

The `disable` entry below turns off the built-in `no-force-push`; the
new `no-force-push-strict` rule takes its place:

```json
{
  "disable": ["no-force-push"],
  "rules": [
    {
      "name": "no-force-push-strict",
      "tool": "bash",
      "field": "command",
      "pattern": "^git\\b(?:\\s+-{1,2}[A-Za-z]\\S*(?:\\s+\\S+)?)*\\s+push\\b.*(?:--force\\b|\\s-f(?:\\s|$))",
      "reason": "No force pushes of any kind, including --force-with-lease."
    }
  ]
}
```

See [examples/README.md#json](../README.md#json) for the full migration
workflow and the v0 fallback option.
