// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Internal module — not part of the package's public API.
 *
 * PROCESS-scoped snapshot of where the GLOBAL layer lives.
 *
 * Lens round 3 (red-team F1): the round-2 fix resolved the agent dir once
 * per `register()` and restored `PI_CODING_AGENT_DIR` / `HOME` after the
 * project import. A project layer that wrote the variable LATER (a timer,
 * any async work) survived that restore, and the next `register()` — every
 * `/reload` re-imports the extension and calls the factory again — read
 * the rogue value and loaded an attacker-chosen global layer with no
 * notice.
 *
 * So the agent dir is resolved ONCE per process, at the first steering
 * load, and every later load in the process reuses it; the environment is
 * never re-read for that purpose. The snapshot lives on `globalThis` under
 * a registry symbol, not in a module-level constant, because `/reload`
 * re-evaluates this module. A later resolution that differs (drift) is
 * reported (`agent-dir-env-drift`, raised in-chat) and the variables are
 * restored to their first-load values.
 *
 * Limits, stated: config code runs in this process and can still replace
 * the snapshot object itself (in-process code can patch anything; the
 * boundary for that class is pi's project-trust gate). And pi resolves its
 * OWN agent dir from the environment on `/reload` before any extension
 * runs, so a drifted variable can change which extensions pi loads at all;
 * the restore here keeps the drift from outliving the reload that
 * reports it, but cannot undo that reload.
 */

import { resolveAgentDir } from "../loader.ts";

const KEY = Symbol.for("@cad0p/pi-steering/agent-dir-snapshot");
const ENV_KEYS = ["PI_CODING_AGENT_DIR", "HOME"] as const;

interface Snapshot {
  readonly agentDir: string;
  readonly env: Readonly<Record<(typeof ENV_KEYS)[number], string | undefined>>;
}

function store(): Record<symbol, Snapshot | undefined> {
  return globalThis as unknown as Record<symbol, Snapshot | undefined>;
}

/**
 * The agent dir for this process: resolved on the first call, reused by
 * every later call. `drift` is a one-line message when the environment
 * now resolves elsewhere (the variables are restored before returning).
 */
export function processAgentDir(): { agentDir: string; drift: string | null } {
  const existing = store()[KEY];
  if (existing === undefined) {
    const snapshot: Snapshot = Object.freeze({
      agentDir: resolveAgentDir(),
      env: Object.freeze({
        PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
        HOME: process.env.HOME,
      }),
    });
    Object.defineProperty(globalThis, KEY, {
      value: snapshot,
      enumerable: false,
      writable: false,
      // configurable so the test seam below can reset it; in-process
      // code could replace it either way (see the module header).
      configurable: true,
    });
    return { agentDir: snapshot.agentDir, drift: null };
  }
  const now = resolveAgentDir();
  if (now === existing.agentDir)
    return { agentDir: existing.agentDir, drift: null };
  const changed: string[] = [];
  for (const key of ENV_KEYS) {
    const first = existing.env[key];
    if (process.env[key] === first) continue;
    changed.push(`process.env.${key}`);
    if (first === undefined) delete process.env[key];
    else process.env[key] = first;
  }
  return {
    agentDir: existing.agentDir,
    drift:
      `${changed.join(" and ") || "the agent dir environment"} changed after the first steering load in this process ` +
      `(it resolved to ${now}); the global layer still loads from ${existing.agentDir}, and the variable was restored. ` +
      "Earlier config code (a project layer's timer or async work) is the usual cause; pi itself may already have " +
      "resolved its own agent dir from the changed value for this reload.",
  };
}

/** TEST-ONLY: forget the process snapshot (tests switch HOME per case). */
export function resetProcessAgentDirForTests(): void {
  delete store()[KEY];
}
