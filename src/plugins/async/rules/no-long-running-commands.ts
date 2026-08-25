// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * `no-long-running-commands` rule for the async plugin — the
 * dev-server / watcher availability guard.
 *
 * Moved out of the engine's former `DEFAULT_RULES` (issue #72): every
 * rail now lives in the domain plugin that owns its surface. This one
 * is qualitatively different from the destructive-command rails (it
 * protects loop AVAILABILITY, not data), which is why it ships under
 * its own plugin rather than alongside git/filesystem guards. The
 * pattern and reason text are byte-identical to the 0.2.0 default.
 * Override-comment eligible.
 */

import type { Rule } from "../../../schema.ts";

/**
 * `no-long-running-commands` - block commands that park the agent
 * loop in a foreground server / watcher.
 */
export const noLongRunningCommands = {
  name: "no-long-running-commands",
  tool: "bash",
  field: "command",
  // Covers npm / yarn / pnpm dev + start, npx --watch, webpack dev
  // modes, jest / tsc --watch, nodemon, and the modern
  // bundler/runtime ecosystem (vite, astro, next dev, deno task
  // dev/start/serve, bun dev). Representative, not exhaustive —
  // consumers with other watchers should add them via their own
  // `.pi/steering.ts`.
  pattern:
    "^(?:npm\\s+(?:run\\s+dev|start)|yarn\\s+(?:dev|start)|pnpm\\s+(?:run\\s+)?(?:dev|start)|npx\\s+.*--watch|webpack\\s+(?:--watch|serve)|jest\\s+--watch|nodemon\\b|tsc\\s+--watch|vite(?:\\s+(?:dev|serve|preview))?(?!\\s+[A-Za-z])|astro\\s+(?:dev|preview)|next\\s+dev|deno\\s+task\\s+(?:dev|start|serve)|bun\\s+(?:dev|run\\s+dev))\\b",
  reason:
    "Long-running dev servers and watchers block the agent loop. Ask the user to run it manually in another terminal, or use a background-process tool.",
} as const satisfies Rule;
