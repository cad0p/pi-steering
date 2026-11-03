// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Internal module — not part of the package's public API (the read-only
 * accessor {@link agentDirSnapshot} is re-exported from the package root).
 *
 * PROCESS-scoped snapshot of where the GLOBAL layer lives, and of every
 * environment variable that locates it or that the global layer reads
 * through `homedir()` (see `AGENT_DIR_ENV_KEYS` in loader.ts).
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
 * re-evaluates this module.
 *
 * Lens round 4 (red-team F1 = functional F2): the drift check compares
 * every snapshotted KEY, not the resolved agent dir. A timer that pins
 * `PI_CODING_AGENT_DIR` to the real dir and moves `HOME` leaves the
 * resolution unchanged, yet the global layer is re-evaluated per load and
 * reads `homedir()`; so each key that differs from its first-load value
 * (after path normalisation: a trailing slash is not a change) is
 * restored and reported as `agent-dir-env-drift`, raised in-chat. The
 * global layer reads the home directory through {@link agentDirSnapshot}
 * rather than a fresh `homedir()`, so a change between loads cannot move
 * what it derives from it either.
 *
 * Limits, stated: config code runs in this process and can still replace
 * the snapshot object itself (in-process code can patch anything; the
 * boundary for that class is pi's project-trust gate). The snapshot is
 * only as good as the FIRST load: an extension pi runs before this one's
 * factory can set the variables before the snapshot exists, and the first
 * load then looks normal. pi itself (1.5.0) resolves its own agent dir
 * once at startup and reuses it on `/reload`, so a drifted variable does
 * not move the extension set or the settings file; until the next
 * steering load restores it, a drifted value is visible to anything that
 * reads the environment lazily (a child process the bash tool spawns,
 * pi's `getAgentDir()` default arguments).
 */

import { homedir } from "node:os";
import {
  AGENT_DIR_ENV_KEYS,
  normalizeEnvPath,
  resolveAgentDir,
} from "../loader.ts";
import type { SteeringDiagnostic } from "../schema.ts";

const KEY = Symbol.for("@cad0p/pi-steering/agent-dir-snapshot");

type EnvKey = (typeof AGENT_DIR_ENV_KEYS)[number];

interface Snapshot {
  readonly agentDir: string;
  /** `homedir()` at the first load. */
  readonly homeDir: string;
  readonly env: Readonly<Record<EnvKey, string | undefined>>;
}

function store(): Record<symbol, Snapshot | undefined> {
  return globalThis as unknown as Record<symbol, Snapshot | undefined>;
}

/** The process snapshot, taken now if no load took it yet. */
function snapshot(): { snap: Snapshot; created: boolean } {
  const existing = store()[KEY];
  if (existing !== undefined) return { snap: existing, created: false };
  const env = {} as Record<EnvKey, string | undefined>;
  for (const key of AGENT_DIR_ENV_KEYS) env[key] = process.env[key];
  const snap: Snapshot = Object.freeze({
    agentDir: resolveAgentDir(),
    homeDir: homedir(),
    env: Object.freeze(env),
  });
  Object.defineProperty(globalThis, KEY, {
    value: snap,
    enumerable: false,
    writable: false,
    // configurable so the test seam below can reset it; in-process
    // code could replace it either way (see the module header).
    configurable: true,
  });
  return { snap, created: true };
}

/**
 * The agent dir for this process: resolved on the first call, reused by
 * every later call. On a later call every snapshotted variable that
 * differs from its first-load value (compared after path normalisation)
 * is restored, and `drift` is an `agent-dir-env-drift` warning naming the
 * keys and where the environment resolved before the restore.
 */
export function processAgentDir(): {
  agentDir: string;
  drift: SteeringDiagnostic | null;
} {
  const { snap, created } = snapshot();
  if (created) return { agentDir: snap.agentDir, drift: null };
  const changed = AGENT_DIR_ENV_KEYS.filter(
    (key) =>
      normalizeEnvPath(process.env[key]) !== normalizeEnvPath(snap.env[key]),
  );
  if (changed.length === 0) return { agentDir: snap.agentDir, drift: null };
  const now = resolveAgentDir();
  for (const key of changed) {
    const first = snap.env[key];
    if (first === undefined) delete process.env[key];
    else process.env[key] = first;
  }
  const keys = changed.map((k) => `process.env.${k}`).join(" and ");
  const where =
    normalizeEnvPath(now) === normalizeEnvPath(snap.agentDir)
      ? `it still resolved to the same agent dir, ${snap.agentDir}`
      : `it resolved to ${now}`;
  return {
    agentDir: snap.agentDir,
    drift: {
      type: "warning",
      kind: "agent-dir-env-drift",
      message:
        `${keys} changed after the first steering load in this process (${where}); ` +
        `the global layer still loads from ${snap.agentDir} with the first-load home directory, ` +
        `and ${changed.length === 1 ? "the variable was" : "the variables were"} restored. ` +
        "Earlier config code (a project layer's timer or async work) is the usual cause.",
    },
  };
}

/**
 * The process snapshot as the GLOBAL layer should read it: the agent dir
 * and the home directory as they were at the first steering load in this
 * process (taken now if no load took it yet). Read-only: it never
 * restores or reports; {@link processAgentDir} does that at each load.
 *
 * A config that derives a path from the home directory (an exemption for
 * `~/.pi`, say) should use `homeDir` from here instead of a fresh
 * `homedir()`: the layer module is re-evaluated on every load, and a
 * fresh read follows whatever `HOME` a project layer's timer left behind.
 */
export function agentDirSnapshot(): { agentDir: string; homeDir: string } {
  const { snap } = snapshot();
  return { agentDir: snap.agentDir, homeDir: snap.homeDir };
}

/** TEST-ONLY: forget the process snapshot (tests switch HOME per case). */
export function resetProcessAgentDirForTests(): void {
  delete store()[KEY];
}
