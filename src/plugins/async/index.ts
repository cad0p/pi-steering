// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * async plugin for `@cad0p/pi-steering`.
 *
 * Subpath import: `pi-steering/plugins/async`.
 *
 * Registers (in the terms of `Plugin`):
 *
 *   - `rules` - `no-long-running-commands`, the dev-server / watcher
 *     availability guard. Qualitatively different from the
 *     destructive-command rails (protects loop availability, not
 *     data), which is why it ships under its own plugin. Override-
 *     comment eligible.
 *
 * Opt-in: registered ONLY when the user declares it:
 *
 * ```ts
 * import asyncPlugin from "@cad0p/pi-steering/plugins/async";
 * export default defineConfig({ plugins: [asyncPlugin] });
 * ```
 *
 * Declaring it explicitly also feeds its rule name into
 * `defineConfig`'s type unions (typo-checking on `disabledRules`);
 * relying on an undeclared plugin would silently widen the union and
 * let typos through.
 *
 * ## Note for plugin authors
 *
 * Layout mirrors the canonical git plugin: one file per concern, a
 * terse default export assembling them. Copy-adapt liberally.
 */

import type { Plugin, Rule } from "../../schema.ts";
import { noLongRunningCommands } from "./rules/no-long-running-commands.ts";

/**
 * Rules shipped by the async plugin.
 */
export const rules = [
  noLongRunningCommands,
] as const satisfies readonly Rule[];

/**
 * The async plugin. Default export so `import asyncPlugin from
 * "pi-steering/plugins/async"` gives you the whole thing.
 *
 * `as const satisfies Plugin` (rather than `: Plugin`) preserves the
 * literal `name: "async"` in the inferred type — the input to
 * `defineConfig`'s rule / plugin name unions, which need the literal
 * (not `name: string`) to offer typo detection on e.g.
 * `disabledRules`.
 */
const asyncPlugin = {
  name: "async",
  rules,
} as const satisfies Plugin;

/**
 * Type-level regression sentinel: if the plugin literal ever loses
 * the `name: "async"` narrowing (for example, someone reintroducing
 * `: Plugin` annotation), the inferred type of `ASYNC_PLUGIN_NAME`
 * widens to `string` and any downstream literal-name inference
 * breaks. Keep this export in place to fail compilation loudly when
 * that happens.
 */
export const ASYNC_PLUGIN_NAME: "async" = asyncPlugin.name;

export default asyncPlugin;

export { noLongRunningCommands };
