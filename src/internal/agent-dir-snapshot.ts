// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Internal module — not part of the package's public API (the read-only
 * accessor {@link agentDirSnapshot} is re-exported from the package root).
 *
 * PROCESS-scoped snapshot of where the GLOBAL layer lives and of the home
 * directory. This is the ONLY module in pi-steering that reads `HOME`,
 * `USERPROFILE`, `PI_CODING_AGENT_DIR`, `homedir()` or `os.userInfo()`;
 * every other reader (the loader, the CLI, the walker's `HOME` seed) takes
 * the snapshot. A source scan pins that (`agent-dir-snapshot-scan.test.ts`).
 *
 * Lens round 3 (red-team F1): the round-2 fix resolved the agent dir once
 * per `register()`; a project layer's TIMER wrote the variable after the
 * restore and the next `/reload` loaded a rogue global layer. So the agent
 * dir is resolved ONCE per process and reused; the snapshot lives on
 * `globalThis` under a registry symbol because `/reload` re-evaluates this
 * module.
 *
 * Lens round 5 (mechanism change): rounds 3 and 4 kept the live environment
 * as an input and tried to detect every way it could drift (per key, then
 * normalised). Each round found a respelling the normalisation let through
 * (a `..` behind a symlink, an empty `HOME`, a relative `HOME`). So decisions
 * no longer read the live environment at all after the first read: the
 * agent dir and the home directory come from this snapshot only. The drift
 * check below is ADVISORY: it restores what it can and warns, so that child
 * processes and lazy readers outside steering see the first-load values
 * again, but no steering decision depends on it catching every respelling.
 *
 * The first read, stated (the rule for the home directory):
 *   - `HOME` (`USERPROFILE` on Windows) is used when it is a NON-EMPTY,
 *     ABSOLUTE path.
 *   - Unset, empty and relative are all "no usable home": the snapshot takes
 *     the account's home from the password database (`os.userInfo()`), not
 *     the cwd and not `""`. (Node's `homedir()` falls back to the password
 *     database only when `HOME` is UNSET; for an empty `HOME` it returns
 *     `""`, which pi would turn into a cwd-relative `.pi/agent`.) The raw
 *     values are kept as they were — for the advisory drift check, unset
 *     and empty are different values for `HOME` / `USERPROFILE`; only
 *     `PI_CODING_AGENT_DIR` treats empty as unset, as pi does.
 *   - The agent dir: a non-empty `PI_CODING_AGENT_DIR` (`~` expanded with
 *     the home above, a relative value resolved against the cwd of the
 *     first read), else `<home>/.pi/agent`.
 *
 * Limits, stated: config code runs in this process and can still replace
 * the snapshot object itself (in-process code can patch anything; the
 * boundary for that class is pi's project-trust gate). The snapshot is
 * only as good as the FIRST read: code that runs before it (an extension
 * pi loads before this one, or anything that calls {@link agentDirSnapshot}
 * first) can set the variables, and the first read then takes them. pi
 * itself (1.5.0) resolves its own agent dir once at startup; what it still
 * reads live on `/reload` is outside steering (see the README).
 */

import { homedir, userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { SteeringDiagnostic } from "../schema.ts";

const KEY = Symbol.for("@cad0p/pi-steering/agent-dir-snapshot");

/**
 * Env keys that locate the global layer, or that a home-directory lookup
 * reads: `PI_CODING_AGENT_DIR`, `HOME` (POSIX) and `USERPROFILE`
 * (Windows). No XDG variable locates the agent dir (pi's `getAgentDir()`
 * reads the same keys). Watched by the import-time check in the loader
 * and by the advisory drift check here.
 */
export const AGENT_DIR_ENV_KEYS = [
  "PI_CODING_AGENT_DIR",
  "HOME",
  "USERPROFILE",
] as const;

export type AgentDirEnvKey = (typeof AGENT_DIR_ENV_KEYS)[number];
export type AgentDirEnv = Readonly<Record<AgentDirEnvKey, string | undefined>>;

interface Snapshot {
  readonly agentDir: string;
  readonly homeDir: string;
  readonly env: AgentDirEnv;
}

function store(): Record<symbol, Snapshot | undefined> {
  return globalThis as unknown as Record<symbol, Snapshot | undefined>;
}

/** The raw values of every watched key, now. */
export function currentAgentDirEnv(): AgentDirEnv {
  const env = {} as Record<AgentDirEnvKey, string | undefined>;
  for (const key of AGENT_DIR_ENV_KEYS) env[key] = process.env[key];
  return Object.freeze(env);
}

/** The account's home from the password database; Node's lookup as a last resort. */
function accountHome(): string {
  try {
    const fromDb = userInfo().homedir;
    if (typeof fromDb === "string" && isAbsolute(fromDb)) return fromDb;
  } catch {
    // no password-database entry (some containers): fall through
  }
  const fallback = homedir();
  return isAbsolute(fallback) ? fallback : "/";
}

/** The home directory by the first-read rule in the module header. */
function resolveHome(env: AgentDirEnv): string {
  const raw = process.platform === "win32" ? env.USERPROFILE : env.HOME;
  if (raw !== undefined && raw !== "" && isAbsolute(raw)) return resolve(raw);
  return accountHome();
}

/**
 * Resolve the agent dir and the home directory from the CURRENT
 * environment by the first-read rule. Used for the first read and, in the
 * drift message only, to say where the drifted environment would have
 * pointed. Never a decision input after the first read.
 */
export function resolveAgentDirFrom(env: AgentDirEnv = currentAgentDirEnv()): {
  agentDir: string;
  homeDir: string;
} {
  const homeDir = resolveHome(env);
  const envDir = env.PI_CODING_AGENT_DIR;
  if (envDir === undefined || envDir === "")
    return { agentDir: join(homeDir, ".pi", "agent"), homeDir };
  if (envDir === "~") return { agentDir: homeDir, homeDir };
  if (envDir.startsWith("~/"))
    return { agentDir: join(homeDir, envDir.slice(2)), homeDir };
  return { agentDir: resolve(envDir), homeDir };
}

/** The process snapshot, taken now if nothing took it yet. */
function snapshot(): { snap: Snapshot; created: boolean } {
  const existing = store()[KEY];
  if (existing !== undefined) return { snap: existing, created: false };
  const env = currentAgentDirEnv();
  const snap: Snapshot = Object.freeze({ ...resolveAgentDirFrom(env), env });
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
 * Simple, lexical-only comparison form for the ADVISORY drift check:
 * doubled slashes, `/./` segments and a trailing slash are ignored;
 * nothing else is (no `..` collapsing, no absolutising — either can hide a
 * real change behind a symlink or a later chdir). Unset and empty differ,
 * except for `PI_CODING_AGENT_DIR`, which pi and the loader ignore when
 * empty. A respelling this treats as a change is restored and reported;
 * one it treats as equal is left alone, which moves nothing steering
 * decides (decisions read the snapshot). Exported for tests.
 */
export function comparableEnvValue(
  key: AgentDirEnvKey,
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  if (value === "") return key === "PI_CODING_AGENT_DIR" ? undefined : "";
  let v = value.replace(/\/{2,}/g, "/");
  while (v.includes("/./")) v = v.replace("/./", "/");
  v = v.replace(/\/\.$/, "/");
  if (v.length > 1) v = v.replace(/\/+$/, "");
  return v;
}

/**
 * Keys whose value now differs from `before` (by
 * {@link comparableEnvValue}); each one is set back to its `before` value.
 * Used by the loader's import-time check and by {@link processAgentDir}.
 */
export function restoreAgentDirEnv(before: AgentDirEnv): AgentDirEnvKey[] {
  const changed = AGENT_DIR_ENV_KEYS.filter(
    (key) =>
      comparableEnvValue(key, process.env[key]) !==
      comparableEnvValue(key, before[key]),
  );
  for (const key of changed) {
    const value = before[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return changed;
}

/**
 * The agent dir for this process: resolved on the first call, reused by
 * every later call. On a later call the advisory drift check runs: every
 * watched variable that differs from its first-read value is restored, and
 * `drift` is an `agent-dir-env-drift` warning naming the keys.
 */
export function processAgentDir(): {
  agentDir: string;
  drift: SteeringDiagnostic | null;
} {
  const { snap, created } = snapshot();
  if (created) return { agentDir: snap.agentDir, drift: null };
  const now = resolveAgentDirFrom();
  const changed = restoreAgentDirEnv(snap.env);
  if (changed.length === 0) return { agentDir: snap.agentDir, drift: null };
  const keys = changed.map((k) => `process.env.${k}`).join(" and ");
  const where =
    now.agentDir === snap.agentDir
      ? `it still resolved to the same agent dir, ${snap.agentDir}`
      : `it resolved to ${now.agentDir}`;
  return {
    agentDir: snap.agentDir,
    drift: {
      type: "warning",
      kind: "agent-dir-env-drift",
      message:
        `${keys} changed after the first steering load in this process (${where}); ` +
        `steering does not follow it — the global layer, the home directory and the walker's HOME ` +
        `all come from the first-load snapshot (${snap.agentDir}, home ${snap.homeDir}) — and ` +
        `${changed.length === 1 ? "the variable was" : "the variables were"} restored for everything else. ` +
        "Earlier config code (a project layer's timer or async work) is the usual cause.",
    },
  };
}

/**
 * The process snapshot as every steering reader takes it: the agent dir
 * and the home directory as they were at the first read in this process
 * (taken now if nothing took it yet). Read-only: it never restores or
 * reports; {@link processAgentDir} does that at each load.
 *
 * A config that derives a path from the home directory should use
 * `homeDir` from here instead of `homedir()` / `process.env.HOME`: the
 * layer module is re-evaluated on every load, and a live read follows
 * whatever `HOME` earlier config code left behind.
 */
export function agentDirSnapshot(): { agentDir: string; homeDir: string } {
  const { snap } = snapshot();
  return { agentDir: snap.agentDir, homeDir: snap.homeDir };
}

/** TEST-ONLY: forget the process snapshot (tests switch HOME per case). */
export function resetProcessAgentDirForTests(): void {
  delete store()[KEY];
}
