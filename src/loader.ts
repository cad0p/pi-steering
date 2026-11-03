// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * TS config loader. Two fixed layers: the project layer at
 * `<cwd>/.pi/steering/` (or `.pi/steering.ts`) and the global layer
 * at `<agentDir>/steering/`, dynamic-import each, merge inner-first
 * (project layer wins on name-keyed collisions). Per-symbol JSDoc
 * carries the contract; see also the {@link SteeringDiagnostic} /
 * {@link SteeringDiagnosticKind} JSDoc for the diagnostic stream.
 *
 * Trust gate: the project layer loads only when the project is
 * trusted — `loadConfigs` accepts pi's RESOLVED project-trust
 * decision via {@link LoadConfigsOptions} (see {@link loadConfigs}).
 */

import {
  accessSync,
  constants,
  existsSync,
  globSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { EVALUATOR_BUILTIN_TRACKERS } from "./evaluator.ts";
import {
  agentDirSnapshot,
  currentAgentDirEnv,
  restoreAgentDirEnv,
} from "./internal/agent-dir-snapshot.ts";
import { runMergerPipeline } from "./internal/session-runtime.ts";
import { verifyLayerPin } from "./layer-pin.ts";
import { formatTrackerNameCollisionMessage } from "./plugin-merger.ts";
import type {
  AnyPredicateHandler,
  CLIDescriptor,
  Exemption,
  Observer,
  Plugin,
  Rule,
  SteeringConfig,
  SteeringDiagnostic,
} from "./schema.ts";

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Candidate file paths for a given directory's `slot` (default
 * `.pi/steering`), in priority order. First existing file wins.
 *
 * Exported for tests — not part of the library's public API.
 */
export function configCandidates(dir: string, slot = ".pi/steering"): string[] {
  return [join(dir, slot, "index.ts"), join(dir, `${slot}.ts`)];
}

/**
 * Return the non-`.ts` files that exist under `<dir>/<slot>` so
 * callers can warn about them. Uses a best-effort fs read: a missing
 * directory returns an empty list.
 */
function unexpectedFilesUnderSteering(
  dir: string,
  slot = ".pi/steering",
): string[] {
  const steeringDir = join(dir, slot);
  if (!existsSync(steeringDir)) return [];
  try {
    // globSync with withFileTypes: true (Node >=22.2, inside the
    // floor) deliberately narrows the stray scan to non-dotfile
    // regular files: dotfiles (.gitignore, .DS_Store, editor junk)
    // are never config-candidate files, so warning about them is
    // noise; symlinked entries are excluded (glob reports them as
    // non-file dirents, and a symlinked helper is a deliberate
    // redirect, not a stray); directories stay filtered by
    // isFile(). Ordering is sorted (glob) — previously unspecified
    // and unpinned.
    const entries = globSync("*", {
      cwd: steeringDir,
      withFileTypes: true,
    });
    const out: string[] = [];
    for (const entry of entries) {
      const name = entry.name;
      if (name === "index.ts") continue;
      if (name.endsWith(".ts")) continue; // allow helpers like `rules.ts`
      if (!entry.isFile()) continue;
      out.push(join(steeringDir, name));
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Find the config file (if any) for a single layer. Returns the
 * resolved file path and a `layer-form-coexistence` diagnostic when
 * both `<slot>/index.ts` and `<slot>.ts` coexist in the same
 * directory (the directory form wins).
 *
 * Exported for tests.
 */
export function findConfigFile(
  dir: string,
  slot = ".pi/steering",
): {
  file: string | null;
  diagnostic: SteeringDiagnostic | null;
} {
  const [indexForm, flatForm] = configCandidates(dir, slot);
  const indexExists = indexForm !== undefined && existsSync(indexForm);
  const flatExists = flatForm !== undefined && existsSync(flatForm);
  let diagnostic: SteeringDiagnostic | null = null;
  if (indexExists && flatExists && indexForm !== undefined) {
    // `path` points at the directory holding the conflict so the
    // renderer's `${path}: ${message}` prefix surfaces the parent
    // once and the message names which two forms coexist. The winning
    // file path is implicit (the directory form always wins).
    diagnostic = {
      type: "warning",
      kind: "layer-form-coexistence",
      path: dir,
      message:
        `both ${slot}.ts and ${slot}/index.ts exist; using ` +
        `directory form. Delete ${slot}.ts to remove this warning.`,
    };
  }
  if (indexExists) return { file: indexForm ?? null, diagnostic };
  if (flatExists) return { file: flatForm ?? null, diagnostic };
  return { file: null, diagnostic };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Options for {@link loadConfigs} / {@link loadSteeringConfig}.
 *
 * `projectLayerTrusted` carries pi's RESOLVED project-trust decision
 * for the load root: when `false`, the project layer at
 * `<cwd>/.pi/steering/` is skipped and an `info`-class
 * `layer-project-untrusted` diagnostic is emitted (only when a
 * project-layer config candidate exists); the global layer ALWAYS
 * loads. When `undefined` or `true` the gate is inert and today's
 * exact behavior applies. The loader never resolves trust itself —
 * it adopts the caller's decision (bridge captures `ctx.isProjectTrusted()`
 * pre-await; the CLI mirrors pi's non-UI formula).
 */
export interface LoadConfigsOptions {
  projectLayerTrusted?: boolean;
  /**
   * The agent directory the GLOBAL layer is loaded from, resolved by the
   * caller BEFORE any config code ran (the bridge snapshots it at
   * extension-factory time). When absent, {@link loadConfigs} takes it
   * from the process snapshot (`agentDirSnapshot()`), never from a live
   * read of the environment, still before importing the project layer. Either way the
   * project layer can no longer move the global layer by assigning
   * `process.env.PI_CODING_AGENT_DIR` or `HOME` at import time (lens
   * round 2: functional F1 / trust F1).
   */
  agentDir?: string;
  /**
   * PROTOTYPE, off unless set: path to an integrity pin manifest for the
   * global layer (see {@link verifyLayerPin}). When set, the loader
   * verifies the pinned files BEFORE importing the global layer and
   * reports a warning-class `global-layer-pin-mismatch` on any
   * difference. It is a boundary only when the manifest AND this code
   * live where the agent's uid cannot write; otherwise it is a
   * writer-independent tripwire.
   */
  globalLayerPin?: string;
}

/**
 * jiti's id-relative default cache resolution (prepareCacheDir) treats
 * the instance id as a directory: for a file id like `<pkg>/src/loader.ts`
 * it probes `<pkg>/src/node_modules` (never exists) and silently falls
 * back to `${tmpdir}/jiti` — volatile (wiped on reboot → every pi
 * process re-pays the ~1.2s cold transpile once), machine-wide shared
 * and unbounded. Pin to the package's own `node_modules/.cache/jiti`
 * when the package has a node_modules dir; fall back to jiti's default
 * otherwise (status quo).
 *
 * Exported for tests — not part of the library's public API.
 */
export function resolveJitiCacheDir(moduleUrl: string): string | true {
  if (!moduleUrl.startsWith("file://")) return true;
  const pkgRoot = dirname(dirname(fileURLToPath(moduleUrl)));
  const nm = join(pkgRoot, "node_modules");
  try {
    if (!existsSync(nm)) return true; // never create a stray node_modules
    const dir = join(nm, ".cache", "jiti");
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return dir;
  } catch {
    return true; // read-only pnpm store etc. → jiti default (tmpdir), same as today
  }
}
const JITI_CACHE_DIR = resolveJitiCacheDir(import.meta.url);

/**
 * Load a single config file (via jiti `evalModule`) and return its
 * default export. The module MUST `export default` a
 * {@link SteeringConfig} object — the loader does not accept
 * module-namespace imports as a fallback, to keep the authoring
 * contract unambiguous.
 *
 * Throws a scoped error when the import fails, when the module has no
 * default export, or when the default export isn't a plain object —
 * the caller surfaces these per-layer without bringing the whole
 * session down (a single bad layer shouldn't nuke the engine).
 *
 * Reload contract: a FRESH jiti instance is created per call (the
 * per-instance parent cache starts empty, so nothing leaks between
 * loads), and `moduleCache: false` keeps jiti from registering
 * anything in `require.cache` — every load re-reads and re-evaluates
 * the file from disk, INCLUDING everything the config transitively
 * imports (sibling `.ts` / `.js` files, `node_modules` plugins).
 * `fsCache` is a source-level cache only (transformed output, keyed
 * by content hash) — it never affects reload semantics. The source
 * string is evaluated fresh each call, so a failed load never
 * poisons subsequent loads. Cache location contract: the directory
 * is pinned to `<pkgRoot>/node_modules/.cache/jiti` when the package
 * has a writable `node_modules` dir (see
 * {@link resolveJitiCacheDir}), else jiti's default `${tmpdir}/jiti`
 * fallback. The option is passed explicitly, so `JITI_FS_CACHE` env
 * defaults are overridden either way — unchanged from before (the
 * loader already passed `fsCache: true` explicitly; jiti's option
 * merge gives userOptions precedence over env defaults).
 *
 * `async: true` is passed explicitly to `evalModule`: it wraps the
 * module in an async function, so top-level `await` and dynamic
 * `import()` inside configs work, and `evalModule` returns a Promise
 * (hence the `await` below).
 *
 * jiti's default `interopDefault: true` wraps the module namespace in
 * an interop Proxy, so NEITHER `"default" in mod` NOR `mod.default`
 * reliably detects a real default export. The proxy's `get` trap
 * falls back to the namespace (or a `{ default: … }` wrapper)
 * whenever the real default is nullish, so `mod.default` is never
 * `undefined`; and `in` falls through to the raw exports object,
 * which OWNS a `default` key even for `export default undefined`.
 * The only reliable signal is the own-property descriptor probe
 * below (`Object.getOwnPropertyDescriptor`): it bypasses the proxy's
 * traps, sees the raw exports object, and yields `value: undefined`
 * exactly when the source default is `undefined` (`export default
 * null` throws inside evalModule before this guard runs).
 */
async function importConfigFile(path: string): Promise<SteeringConfig> {
  // Fresh instance per load: per-instance parentCache is empty, and
  // moduleCache: false keeps jiti from registering anything in
  // require.cache — every load re-reads + re-evaluates from disk,
  // including everything the config transitively imports.
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    fsCache: JITI_CACHE_DIR,
  });
  const source = readFileSync(path, "utf8");
  // async: true → async wrapper: top-level await + dynamic import()
  // inside configs work; evalModule returns a Promise<module namespace>.
  const mod = (await jiti.evalModule(source, {
    filename: path,
    async: true,
  })) as {
    default?: unknown;
  } & Record<string, unknown>;

  // Probe the own property descriptor instead of `"default" in mod`
  // or `mod.default`: jiti's interop wrapper (interopDefault: true)
  // is a Proxy whose `get` trap fabricates a non-`undefined` value
  // for nullish real defaults — `export default undefined` yields an
  // object and a named-exports-only module yields the namespace, so
  // the bare checks would never fire and the module would silently
  // load as a config. `in` is no better: it falls through to the raw
  // exports object, which DOES own a `default` key for `export
  // default undefined`. The descriptor (which bypasses the proxy's
  // traps) is the only signal that sees the raw exports object AND
  // the true value of its `default` key.
  const defaultDesc = Object.getOwnPropertyDescriptor(mod, "default");
  if (defaultDesc === undefined || defaultDesc.value === undefined) {
    // Path is intentionally omitted from the message; the caller wraps
    // this throw in a `layer-import-failed` diagnostic whose own `path`
    // field is the single source of truth for the file location.
    throw new Error(
      "config file must have a default export. Use " +
        "`export default { ... } satisfies SteeringConfig` or " +
        "`export default defineConfig({ ... })`.",
    );
  }
  const candidate = defaultDesc.value;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  ) {
    throw new Error(
      `config file default export must be a SteeringConfig object, ` +
        `got ${Array.isArray(candidate) ? "array" : typeof candidate}.`,
    );
  }
  return candidate as SteeringConfig;
}

/**
 * Load the two fixed config layers for `cwd`: the project layer at
 * `<cwd>/.pi/steering/` (or `.pi/steering.ts`) and the global layer
 * at `<agentDir>/steering/` (see {@link agentDirSnapshot}). Returns
 * the layers INNER-FIRST (project first, then global; caller passes
 * to {@link buildConfig}, which expects inner-first so early entries
 * take precedence on collisions).
 *
 * Trust gate: when `opts.projectLayerTrusted === false`, the project
 * layer is SKIPPED entirely — no candidate scan beyond the
 * `existsSync` probe, no stray-file scan, no coexistence diagnostic,
 * no import (the gate precedes jiti eval, the loader's only
 * code-execution surface). An `info`-class `layer-project-untrusted`
 * diagnostic is emitted only when a project-layer config candidate
 * exists (`findConfigFile(cwd, ".pi/steering").file !== null`), so
 * an untrusted project without one produces no noise. The global
 * layer loads unconditionally in every case. `projectLayerTrusted`
 * undefined or `true` → exact pre-gate behavior.
 *
 * Issues encountered along the way (per-layer import failure, dual
 * form coexistence, stray non-`.ts` file under the layer directory)
 * surface as structured {@link SteeringDiagnostic} entries on the
 * returned object. The loader does not log to `console.warn` directly
 * — the bridge runtime owns the policy decision (throw vs. log) once
 * it has collected diagnostics from every source.
 */
export async function loadConfigs(
  cwd: string,
  opts?: LoadConfigsOptions,
): Promise<{
  layers: SteeringConfig[];
  diagnostics: SteeringDiagnostic[];
}> {
  // Resolve the global layer's location ONCE, before any config code
  // runs, and import the global layer FIRST. The project layer is
  // arbitrary TypeScript: before this ordering it could assign
  // process.env.PI_CODING_AGENT_DIR (or HOME) at import time and the
  // loader, resolving the agent dir afterwards, loaded an
  // attacker-chosen "global" layer with every lock gone and zero
  // diagnostics (lens round 2: functional F1, trust F1). The location is
  // the PROCESS snapshot (lens round 5): never a live read of the env.
  const agentDir = opts?.agentDir ?? agentDirSnapshot().agentDir;
  const globalLayers: SteeringConfig[] = [];
  const globalDiagnostics: SteeringDiagnostic[] = [];
  if (opts?.globalLayerPin !== undefined) {
    globalDiagnostics.push(
      ...verifyLayerPin(
        opts.globalLayerPin,
        findConfigFile(agentDir, "steering").file,
      ),
    );
  }
  await loadLayer(agentDir, "steering", globalLayers, globalDiagnostics);
  // Snapshot AFTER the global layer ran: only the project layer's
  // changes are attributed to it below.
  const envBefore = currentAgentDirEnv();

  const layers: SteeringConfig[] = [];
  const diagnostics: SteeringDiagnostic[] = [];
  if (opts?.projectLayerTrusted === false) {
    // Gate: nothing of the project layer is inspected beyond the
    // candidate probe — no stray scan, no coexistence diagnostic,
    // no import. The coexistence diagnostic is intentionally NOT
    // produced when untrusted (accepted, documented).
    if (findConfigFile(cwd, ".pi/steering").file !== null) {
      diagnostics.push({
        type: "info",
        kind: "layer-project-untrusted",
        path: join(cwd, ".pi", "steering"),
        message:
          "project layer skipped (project untrusted); global layer still applies",
      });
    }
  } else {
    await loadLayer(cwd, ".pi/steering", layers, diagnostics);
  }
  // A project layer that changed a variable that locates the global layer
  // is told so loudly, and the change is undone for everything outside
  // steering (child processes, lazy readers). Advisory: no steering
  // decision reads these variables after the first read (lens round 5).
  for (const key of restoreAgentDirEnv(envBefore)) {
    diagnostics.push({
      type: "warning",
      kind: "agent-dir-env-mutated",
      path: join(cwd, ".pi", "steering"),
      message:
        `the project layer changed process.env.${key} while it loaded; ` +
        `the global layer was loaded from ${agentDir} (resolved before any ` +
        "config code ran) and the variable was restored.",
    });
  }
  layers.push(...globalLayers);
  // Diagnostics keep their historical order: project first, then global.
  diagnostics.push(...globalDiagnostics);
  return { layers, diagnostics };
}

/**
 * Load a single layer: `slot` under `dir` (candidate file discovery,
 * coexistence diagnostic, stray-file scan, dynamic import). Shared by
 * the project layer (`cwd` + `.pi/steering`) and the global layer
 * (`agentDir` + `steering`).
 */
async function loadLayer(
  dir: string,
  slot: string,
  layers: SteeringConfig[],
  diagnostics: SteeringDiagnostic[],
): Promise<void> {
  const { file, diagnostic } = findConfigFile(dir, slot);
  if (diagnostic !== null) diagnostics.push(diagnostic);
  if (file === null) {
    // Surface stray files under `<slot>/` that the loader won't pick
    // up. Only check when the directory exists but has no `index.ts`
    // — otherwise a project without any steering directory would
    // emit noise.
    const slotDir = join(dir, slot);
    if (existsSync(slotDir)) {
      for (const stray of unexpectedFilesUnderSteering(dir, slot)) {
        diagnostics.push({
          type: "warning",
          kind: "layer-stray-file",
          path: stray,
          message: `ignoring non-.ts file under ${slot}/`,
        });
      }
    }
    return;
  }
  try {
    layers.push(await importConfigFile(file));
  } catch (err) {
    // Use err.message to drop the `Error: ` class prefix; native
    // runtime errors (jiti syntax errors) may embed their path inside
    // the message and we accept that duplication.
    const body = err instanceof Error ? err.message : String(err);
    diagnostics.push({
      type: "warning",
      kind: "layer-import-failed",
      path: file,
      message: `failed to import: ${body}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/**
 * Collect plugins across layers, recording a diagnostic for each
 * cross-layer duplicate plugin name. First-registered wins (inner
 * layer is first — matches pi's project-local → global convention).
 *
 * The caller is responsible for unioning `config.disabledPlugins`
 * across layers and passing the result as `disabledPlugins` (see
 * `buildConfig`). Plugins whose name appears in the supplied set are
 * still merged into the output (so downstream surfaces like
 * `pi-steering list` can render them tagged as disabled), but they're
 * EXEMPT from collision detection. A user resolving a duplicate-plugin
 * warning by adding the plugin to `disabledPlugins` should see the
 * warning go away in the same config edit; detect-then-disable would
 * still surface the warning even though the disable already settled
 * the conflict.
 */
function mergePlugins(
  layers: readonly SteeringConfig[],
  disabledPlugins: ReadonlySet<string>,
  locks: LockState,
  deps: LockDependencies,
  diagnostics: SteeringDiagnostic[],
): Plugin[] {
  const seen = new Set<string>();
  const out: Plugin[] = [];
  for (const [layerIndex, layer] of layers.entries()) {
    if (!layer.plugins) continue;
    for (const raw of layer.plugins) {
      if (seen.has(raw.name)) {
        if (!disabledPlugins.has(raw.name)) {
          diagnostics.push({
            type: "warning",
            kind: "plugin-name-collision",
            message: `duplicate plugin "${raw.name}"; keeping first-registered entry.`,
          });
        }
        continue;
      }
      // An inner layer must not shadow, by plugin NAME, a plugin that
      // provides a locked rule's dependencies or ships a locked rule:
      // first-registered wins today, so the shadow would replace the
      // provider and the locked rule would name an unregistered
      // predicate (red-team R-F2b, probe5).
      if (
        layerIndex < locks.outer &&
        (deps.outerProviders.has(raw.name) || deps.outerShips.has(raw.name))
      ) {
        diagnostics.push({
          type: "warning",
          kind: "locked-rule-violation",
          message:
            `refusing plugin "${raw.name}" from ${describeLayers([layerIndex])}: ` +
            `it shadows the ${describeLayers([locks.outer])} plugin that ` +
            `${describeProvider(deps, raw.name)} (locked by ` +
            `${describeLayers([locks.outer])}); the outer plugin keeps the name.`,
        });
        continue;
      }
      const plugin =
        layerIndex < locks.outer
          ? stripProtectedFromPlugin(raw, layerIndex, locks, deps, diagnostics)
          : raw;
      seen.add(plugin.name);
      out.push(plugin);
    }
  }
  return out;
}

/**
 * Remove from an INNER plugin the pieces a locked rule depends on: the
 * predicate handlers it calls, its named observers, the CLI descriptors
 * that decide how its commands parse, its exemptions, and any rule or
 * observer that would shadow a locked name. Returns the plugin
 * unchanged when there is nothing to strip; every strip is a
 * warning-class `locked-rule-violation` naming both sides — never an
 * engine error, because an inner layer must not be able to disarm the
 * session by provoking a throw (red-team R-F2a, R-F2b).
 */
function stripProtectedFromPlugin(
  plugin: Plugin,
  layerIndex: number,
  locks: LockState,
  deps: LockDependencies,
  diagnostics: SteeringDiagnostic[],
): Plugin {
  const removed: string[] = [];
  const predicates: Record<string, AnyPredicateHandler> = {};
  for (const [key, handler] of Object.entries(plugin.predicates ?? {})) {
    if (deps.predicates.has(key)) removed.push(`predicate "${key}"`);
    else predicates[key] = handler;
  }
  const observers = (plugin.observers ?? []).filter((observer) => {
    if (!deps.observers.has(observer.name)) return true;
    removed.push(`observer "${observer.name}"`);
    return false;
  });
  const cliDescriptors: Record<string, CLIDescriptor> = {};
  for (const [key, descriptor] of Object.entries(plugin.cliDescriptors ?? {})) {
    if (deps.descriptors.has(key)) removed.push(`descriptor "${key}"`);
    else cliDescriptors[key] = descriptor;
  }
  const exemptions = (plugin.exemptions ?? []).filter((exemption) => {
    if (!isProtectedFrom(locks, exemption.rule, layerIndex)) return true;
    removed.push(`exemption for "${exemption.rule}"`);
    return false;
  });
  const rules = (plugin.rules ?? []).filter((rule) => {
    if (!isProtectedFrom(locks, rule.name, layerIndex)) return true;
    removed.push(`rule "${rule.name}"`);
    return false;
  });
  if (removed.length === 0) return plugin;
  diagnostics.push({
    type: "warning",
    kind: "locked-rule-violation",
    message:
      `refusing ${removed.join(", ")} from plugin "${plugin.name}" ` +
      `(${describeLayers([layerIndex])}): a locked rule depends on it, and the ` +
      `inner declaration would replace the one the lock trusts ` +
      `(locked by ${describeLayers([locks.outer])}); the outer declaration stays in force.`,
  });
  const out: Plugin = { ...plugin };
  if (plugin.predicates !== undefined) out.predicates = predicates;
  if (plugin.observers !== undefined) out.observers = observers;
  if (plugin.cliDescriptors !== undefined) out.cliDescriptors = cliDescriptors;
  if (plugin.exemptions !== undefined) out.exemptions = exemptions;
  if (plugin.rules !== undefined) out.rules = rules;
  return out;
}

/**
 * Merge rules across layers — inner layer's rule name overrides outer.
 * Declaration order within a layer is preserved; cross-layer order is
 * "first layer that mentions a given rule name wins for its slot".
 *
 * Records a diagnostic on duplicate names WITHIN a single layer
 * (authoring mistake) — mirrors {@link mergeObservers}. Cross-layer
 * collisions stay silent: overriding a rule by name is the documented
 * customization path.
 *
 * LOCKED NAMES are the exception: a rule locked by one layer
 * ({@link SteeringConfig.lockedRules}) cannot be redefined by another
 * layer. The lock-declaring layer's definition wins in either layer
 * order, and the refused override is a warning-class
 * `locked-rule-violation` diagnostic instead of a silent shadow.
 *
 * Disabled rules are merged but exempt from collision detection (see
 * {@link mergePlugins} for rationale).
 */
function mergeRules(
  layers: readonly SteeringConfig[],
  disabledRules: ReadonlySet<string>,
  locks: LockState,
  diagnostics: SteeringDiagnostic[],
): Rule[] {
  // Declarations in first-seen order, so the output order stays stable
  // (inner-first, then outer; within a layer, source order).
  const declared = new Map<string, Array<{ rule: Rule; layer: number }>>();
  const order: string[] = [];
  for (const [layerIndex, layer] of layers.entries()) {
    if (!layer.rules) continue;
    const seenInLayer = new Set<string>();
    for (const rule of layer.rules) {
      if (seenInLayer.has(rule.name)) {
        if (!disabledRules.has(rule.name)) {
          diagnostics.push({
            type: "warning",
            kind: "rule-name-collision",
            message:
              `duplicate rule "${rule.name}" within single config layer; ` +
              "keeping first, dropping subsequent",
          });
        }
        continue;
      }
      seenInLayer.add(rule.name);
      const list = declared.get(rule.name);
      if (list === undefined) {
        declared.set(rule.name, [{ rule, layer: layerIndex }]);
        order.push(rule.name);
      } else {
        list.push({ rule, layer: layerIndex });
      }
    }
  }

  const out: Rule[] = [];
  for (const name of order) {
    const entries = declared.get(name) ?? [];
    // The OUTERMOST lock owner is the authority for this name. A
    // definition from a layer inner to it is a shadow: the documented
    // inner-wins path would otherwise replace the locked rail with a
    // do-nothing body while leaving its name in place (R-F1). Layers
    // outer to the owner may still override it (they are closer to the
    // owner than any shadow is).
    const owners = locks.owners.get(name);
    const authority = owners === undefined ? undefined : Math.max(...owners);
    const authoritative = entries.filter(
      (entry) => authority !== undefined && entry.layer >= authority,
    );
    if (authoritative.length > 0) {
      out.push(authoritative[authoritative.length - 1]?.rule as Rule);
      for (const shadow of entries) {
        if (shadow.layer >= authority!) continue;
        diagnostics.push({
          type: "warning",
          kind: "locked-rule-violation",
          message:
            `refusing a definition of locked rule "${name}" from ` +
            `${describeLayers([shadow.layer])} (locked by ` +
            `${describeLayers([authority as number])}); the locked definition wins.`,
        });
      }
      continue;
    }
    // No declaration from the owner or outer: the rule lives only in
    // inner layers. Keep the ordinary inner-wins winner — the lock
    // still refuses a LATER disable/override by an inner layer.
    out.push(entries[0]?.rule as Rule);
  }
  return out;
}

/**
 * Merge observers across layers — inner layer's observer name
 * overrides outer. Records a diagnostic on duplicate names WITHIN a
 * single layer (authoring mistake); cross-layer overrides are silent
 * (intentional customization).
 */
function mergeObservers(
  layers: readonly SteeringConfig[],
  diagnostics: SteeringDiagnostic[],
): Observer[] {
  const byName = new Map<string, Observer>();
  for (const layer of layers) {
    if (!layer.observers) continue;
    const seenInLayer = new Set<string>();
    for (const obs of layer.observers) {
      if (seenInLayer.has(obs.name)) {
        diagnostics.push({
          type: "warning",
          kind: "observer-name-collision",
          message: `duplicate observer "${obs.name}"; keeping first-registered entry.`,
        });
        continue;
      }
      seenInLayer.add(obs.name);
      if (!byName.has(obs.name)) {
        byName.set(obs.name, obs);
      }
    }
  }
  return [...byName.values()];
}

/**
 * Merge simple string-list fields (`disabledRules`, `disabledPlugins`)
 * as a union across layers. Preserves first-seen order for deterministic
 * output in tests.
 */
function mergeStringUnion(
  layers: readonly SteeringConfig[],
  key: "disabledRules" | "disabledPlugins" | "lockedRules",
): string[] | undefined {
  const seen = new Set<string>();
  let any = false;
  for (const layer of layers) {
    const list = layer[key];
    if (list === undefined) continue;
    any = true;
    for (const item of list) seen.add(item);
  }
  return any ? [...seen] : undefined;
}

/**
 * Merge config-layer exemptions as a UNION across layers — no
 * inner-wins (unlike rules / plugins / observers, which override by
 * name). Every layer's carve-outs apply; per-rule OR-ing happens at
 * evaluation time.
 *
 * Declaration order is preserved (inner-first, then outer) for
 * deterministic output in tests. Duplicates are intentionally NOT
 * deduped: the registry has no collision concept, and evaluation is
 * idempotent under duplicates.
 *
 * LOCKED NAMES are the exception: an exemption targeting a rule locked
 * by ANOTHER layer is dropped with a warning-class
 * `locked-rule-violation` diagnostic. Otherwise a project layer could
 * neutralise a global rail without touching `disabledRules` at all —
 * the exemption registry accumulates across layers by design.
 */
function mergeExemptions(
  layers: readonly SteeringConfig[],
  locks: LockState,
  diagnostics: SteeringDiagnostic[],
): Exemption[] | undefined {
  const out: Exemption[] = [];
  for (const [layerIndex, layer] of layers.entries()) {
    if (!layer.exemptions) continue;
    for (const exemption of layer.exemptions) {
      if (isProtectedFrom(locks, exemption.rule, layerIndex)) {
        diagnostics.push({
          type: "warning",
          kind: "locked-rule-violation",
          message:
            `refusing an exemption of locked rule "${exemption.rule}" from ` +
            `${describeLayers([layerIndex])} (locked by ` +
            `${describeLayers(ownersOuterThan(locks, exemption.rule, layerIndex))}); ` +
            "the exemption is dropped.",
        });
        continue;
      }
      out.push(exemption);
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Lock bookkeeping for {@link buildConfig}.
 *
 * A lock binds only OUTWARD: the layer that declares it protects the
 * rule from every layer INNER to that declarer, and never from the
 * declarer itself. With pi-steering's two layers (project = #0 inner,
 * global = #1 outer) that means only the outermost layer's locks bind.
 *
 * The first cut treated every `lockedRules` declaration as ownership,
 * so a project layer that listed the merge guard became an "owner" and
 * its own disable / exemption / boolean flip was honoured with zero
 * diagnostics — a one-line kill switch that all three lenses found
 * (functional F1, red-team R-F1, trust F1). Declarations are now
 * per-declarer claims with an outward-only effect, and there is NO
 * self-exemption: the outermost layer cannot be protected from itself
 * (nothing is outer to it), so an owner is never locked out of their own
 * config, while an inner layer's own lock grants it nothing at all.
 */
interface LockState {
  /** Rule name → layer indices that lock it (every declarer). */
  owners: ReadonlyMap<string, ReadonlySet<number>>;
  /** Indices of layers that declare at least one lock. */
  declarers: readonly number[];
  /** The outermost layer index — the authority end of the chain. */
  outer: number;
  /** Rule names locked by the outermost layer (the binding set). */
  outerLocked: ReadonlySet<string>;
}

/**
 * Collect every layer's `lockedRules` claim. Names are NOT validated
 * here (see `validateUserConfigNames`); a lock that names no rule is
 * reported by {@link buildConfig} instead, so the diagnostic has the
 * full rule universe to compare against.
 */
function collectLocks(layers: readonly SteeringConfig[]): LockState {
  const owners = new Map<string, Set<number>>();
  const declarers: number[] = [];
  const outer = layers.length === 0 ? -1 : layers.length - 1;
  for (const [layerIndex, layer] of layers.entries()) {
    const names = layer.lockedRules ?? [];
    if (names.length > 0) declarers.push(layerIndex);
    for (const name of names) {
      const set = owners.get(name);
      if (set === undefined) owners.set(name, new Set([layerIndex]));
      else set.add(layerIndex);
    }
  }
  const outerLocked = new Set(layers[outer]?.lockedRules ?? []);
  return { owners, declarers, outer, outerLocked };
}

/**
 * True when `name` is locked by a layer OUTER to `layerIndex` — the
 * only relationship in which a lock binds. A layer's own lock never
 * protects it, and an inner layer's lock never protects against an
 * outer one.
 */
function isProtectedFrom(
  locks: LockState,
  name: string,
  layerIndex: number,
): boolean {
  return ownersOuterThan(locks, name, layerIndex).length > 0;
}

/** Owners of `name` that are outer to `layerIndex` (for messages). */
function ownersOuterThan(
  locks: LockState,
  name: string,
  layerIndex: number,
): number[] {
  const owners = locks.owners.get(name);
  if (owners === undefined) return [];
  return [...owners]
    .filter((owner) => owner > layerIndex)
    .sort((a, b) => a - b);
}

/**
 * Registry dependencies of the outermost layer's locked rules.
 *
 * A locked rule is a BODY, not a runtime: its predicates come from
 * plugins, its observers are referenced by name, and its CLI
 * descriptors decide how the command is parsed. A project plugin that
 * supplies any of those wins the first-registered race and neuters the
 * rule while leaving its text intact — the rule "stays ACTIVE" and
 * blocks nothing (red-team R-F2). The lock therefore extends to the
 * dependency closure, and to the plugins that provide it.
 */
interface LockDependencies {
  /** Predicate keys referenced by a locked rule. */
  predicates: ReadonlySet<string>;
  /** Observer names a locked rule references by name. */
  observers: ReadonlySet<string>;
  /** CLI basenames a locked bash rule routes on. */
  descriptors: ReadonlySet<string>;
  /** Plugin names providing at least one protected dependency. */
  providers: ReadonlySet<string>;
  /** Provider names declared by the OUTERMOST layer (the trusted ones). */
  outerProviders: ReadonlySet<string>;
  /** Plugin names shipping a locked rule, declared by the outermost layer. */
  outerShips: ReadonlySet<string>;
  /** Provider name → what it provides (for messages). */
  provides: ReadonlyMap<string, readonly string[]>;
  /** Provider name → locked rules that lose a dependency with it. */
  providerRules: ReadonlyMap<string, readonly string[]>;
  /** Plugin name → locked rules it ships as plugin rules. */
  ships: ReadonlyMap<string, readonly string[]>;
}

/**
 * Compute the dependency closure of the outermost layer's locked rules.
 *
 * Scans EVERY declaration (layer rules and plugin rules) of a locked
 * name: an inner duplicate is stripped before it can affect evaluation,
 * but its references still count, so the closure errs on the side of
 * protecting more.
 */
function collectLockDependencies(
  layers: readonly SteeringConfig[],
  locks: LockState,
): LockDependencies {
  const declarations: Rule[] = [];
  for (const layer of layers) {
    for (const rule of layer.rules ?? []) {
      if (locks.outerLocked.has(rule.name)) declarations.push(rule);
    }
    for (const plugin of layer.plugins ?? []) {
      for (const rule of plugin.rules ?? []) {
        if (locks.outerLocked.has(rule.name)) declarations.push(rule);
      }
    }
  }

  const predicates = new Set<string>();
  const observers = new Set<string>();
  const descriptors = new Set<string>();
  for (const rule of declarations) {
    for (const key of Object.keys(rule.when ?? {})) predicates.add(key);
    const not = rule.when?.not;
    if (not !== undefined && typeof not === "object") {
      for (const key of Object.keys(not)) predicates.add(key);
    }
    if (typeof rule.observer === "string") observers.add(rule.observer);
    if (rule.tool === "bash") {
      const commands = Array.isArray(rule.command)
        ? rule.command
        : [rule.command];
      for (const command of commands) descriptors.add(command);
    }
  }

  const provides = new Map<string, string[]>();
  const providerRules = new Map<string, string[]>();
  const ships = new Map<string, string[]>();
  for (const layer of layers) {
    for (const plugin of layer.plugins ?? []) {
      const provided: string[] = [];
      for (const key of Object.keys(plugin.predicates ?? {})) {
        if (predicates.has(key)) provided.push(`predicate "${key}"`);
      }
      for (const observer of plugin.observers ?? []) {
        if (observers.has(observer.name)) {
          provided.push(`observer "${observer.name}"`);
        }
      }
      for (const key of Object.keys(plugin.cliDescriptors ?? {})) {
        if (descriptors.has(key)) provided.push(`descriptor "${key}"`);
      }
      if (provided.length > 0) {
        provides.set(plugin.name, [
          ...new Set([...(provides.get(plugin.name) ?? []), ...provided]),
        ]);
      }
      for (const rule of plugin.rules ?? []) {
        if (!locks.outerLocked.has(rule.name)) continue;
        ships.set(plugin.name, [
          ...new Set([...(ships.get(plugin.name) ?? []), rule.name]),
        ]);
      }
      for (const rule of declarations) {
        if (!provided.some((item) => ruleNeeds(rule, item))) continue;
        providerRules.set(plugin.name, [
          ...new Set([...(providerRules.get(plugin.name) ?? []), rule.name]),
        ]);
      }
    }
  }
  const outerPlugins = layers[locks.outer]?.plugins ?? [];
  const outerProviders = new Set<string>();
  const outerShips = new Set<string>();
  for (const plugin of outerPlugins) {
    if (provides.has(plugin.name)) outerProviders.add(plugin.name);
    if (ships.has(plugin.name)) outerShips.add(plugin.name);
  }
  return {
    predicates,
    observers,
    descriptors,
    providers: new Set(provides.keys()),
    outerProviders,
    outerShips,
    provides,
    providerRules,
    ships,
  };
}

/** Does `rule` reference the dependency described by `item`? */
function ruleNeeds(rule: Rule, item: string): boolean {
  const quoted = /"(.*)"/.exec(item);
  const name = quoted?.[1];
  if (name === undefined) return false;
  if (item.startsWith("predicate ")) {
    if (name in (rule.when ?? {})) return true;
    const not = rule.when?.not;
    return not !== undefined && typeof not === "object" && name in not;
  }
  if (item.startsWith("observer ")) return rule.observer === name;
  if (item.startsWith("descriptor ")) {
    if (rule.tool !== "bash") return false;
    const commands = Array.isArray(rule.command)
      ? rule.command
      : [rule.command];
    return commands.includes(name);
  }
  return false;
}

/** Render a provider plugin's contribution for a diagnostic. */
function describeProvider(deps: LockDependencies, pluginName: string): string {
  const provides = deps.provides.get(pluginName) ?? [];
  const ships = deps.ships.get(pluginName) ?? [];
  const parts: string[] = [];
  if (ships.length > 0) parts.push(`ships locked ${pluralRules(ships)}`);
  if (provides.length > 0) parts.push(`provides ${provides.join(", ")}`);
  return parts.length === 0 ? "serves locked rules" : parts.join(" and ");
}

function pluralRules(names: readonly string[]): string {
  const list = names.map((name) => `"${name}"`).join(", ");
  return names.length === 1 ? `rule ${list}` : `rules ${list}`;
}

/** Render layer indices for a diagnostic message. */
function describeLayers(indices: readonly number[]): string {
  const sorted = [...indices].sort((a, b) => a - b);
  return sorted.length === 1
    ? `layer #${sorted[0]}`
    : `layers #${sorted.join(", #")}`;
}

/**
 * Merge `disabledRules` across layers, minus disables a lock refuses.
 *
 * A disable from layer i is honored only when no layer OUTER to i locks
 * the rule. Otherwise the disable is dropped and a warning-class
 * `locked-rule-violation` diagnostic names the rule, the refusing
 * layer and the lock owner. The rule therefore stays ACTIVE, which is
 * the only fail-safe outcome: a refused disable can never be mistaken
 * for a working one. A lock a layer declared itself grants it nothing
 * (self-exemption is gone), and the outermost layer is never protected
 * from itself, so no owner is locked out of their own config.
 */
function mergeDisabledRules(
  layers: readonly SteeringConfig[],
  locks: LockState,
  diagnostics: SteeringDiagnostic[],
): string[] | undefined {
  const disablers = new Map<string, number[]>();
  for (const [layerIndex, layer] of layers.entries()) {
    for (const name of layer.disabledRules ?? []) {
      const list = disablers.get(name);
      if (list === undefined) disablers.set(name, [layerIndex]);
      else list.push(layerIndex);
    }
  }
  if (disablers.size === 0) return undefined;
  const kept: string[] = [];
  for (const [name, indices] of disablers) {
    const refused = indices.filter((index) =>
      isProtectedFrom(locks, name, index),
    );
    if (refused.length < indices.length) {
      // At least one disabling layer is not protected (the outermost
      // layer disabling its own rule) — the disable is authoritative.
      kept.push(name);
      continue;
    }
    diagnostics.push({
      type: "warning",
      kind: "locked-rule-violation",
      message:
        `refusing to disable locked rule "${name}" from ` +
        `${describeLayers(refused)} (locked by ` +
        `${describeLayers(ownersOuterThan(locks, name, Math.min(...refused)))}); ` +
        "the rule stays active.",
    });
  }
  return kept.length > 0 ? kept : undefined;
}

/**
 * Merge `disabledPlugins` across layers, minus disables a lock refuses.
 *
 * Disabling a plugin removes every rule it ships AND every predicate,
 * observer and descriptor it provides, so a locked rule can be disarmed
 * through a plugin name instead of a rule name. The earlier cut only
 * looked at plugin-shipped rules, so `disabledPlugins: ["merge-guard"]`
 * was accepted silently: merge-guard ships predicates and no rules, the
 * locked rule then named an unregistered predicate, the engine threw,
 * and the whole session ran unsteered (functional F2, trust F2). The
 * refusal now covers the dependency closure and names the rule and the
 * lock owner in the message.
 */
function mergeDisabledPlugins(
  layers: readonly SteeringConfig[],
  locks: LockState,
  deps: LockDependencies,
  diagnostics: SteeringDiagnostic[],
): string[] | undefined {
  const disablers = new Map<string, number[]>();
  for (const [layerIndex, layer] of layers.entries()) {
    for (const name of layer.disabledPlugins ?? []) {
      const list = disablers.get(name);
      if (list === undefined) disablers.set(name, [layerIndex]);
      else list.push(layerIndex);
    }
  }
  if (disablers.size === 0) return undefined;
  // Locked rules a plugin serves: the ones it ships plus the ones that
  // lose a dependency without it.
  const served = (pluginName: string): string[] => [
    ...new Set([
      ...(deps.ships.get(pluginName) ?? []),
      ...(deps.providerRules.get(pluginName) ?? []),
    ]),
  ];
  const kept: string[] = [];
  for (const [name, indices] of disablers) {
    const rules = served(name);
    const refused = indices.filter((index) =>
      rules.some((rule) => isProtectedFrom(locks, rule, index)),
    );
    if (refused.length < indices.length) {
      kept.push(name); // at least one disabling layer is not protected
      continue;
    }
    const lockedRules = [
      ...new Set(
        rules.filter((rule) =>
          refused.some((index) => isProtectedFrom(locks, rule, index)),
        ),
      ),
    ];
    diagnostics.push({
      type: "warning",
      kind: "locked-rule-violation",
      message:
        `refusing to disable plugin "${name}" from ${describeLayers(refused)}: ` +
        `it ${describeProvider(deps, name)} for locked ${pluralRules(lockedRules)} ` +
        `(locked by ${describeLayers([locks.outer])}); the plugin stays active.`,
    });
  }
  return kept.length > 0 ? kept : undefined;
}

/**
 * Resolve an inner-wins boolean that can itself disarm the rails:
 *
 *   - `failOnWarnings: true` turns ANY warning — including the very
 *     diagnostic that reports a refused disable — into a thrown error
 *     that builds no steering runtime at all;
 *   - `defaultNoOverride: false` makes every rule overridable by a
 *     `# steering-override: <rule>` comment, so an agent could walk
 *     straight through a locked rule.
 *
 * When a layer declares locks, both values come from a lock-declaring
 * layer, and a non-owning layer that asks for a different value is
 * ignored with a warning-class `locked-rule-violation` diagnostic.
 *
 * When no lock-declaring layer sets the field, the ordinary inner-wins
 * merge still applies (there is no owner value to protect).
 */
function resolveLockOwnedBool(
  layers: readonly SteeringConfig[],
  locks: LockState,
  diagnostics: SteeringDiagnostic[],
  key: "failOnWarnings" | "defaultNoOverride",
): boolean | undefined {
  // No binding lock (the outermost layer locks nothing): the ordinary
  // inner-wins merge applies.
  if (locks.outer < 0 || locks.outerLocked.size === 0) {
    return mergeBool(layers, key);
  }
  // The outermost layer decides, and only the outermost layer. An inner
  // layer's value can never reach this point — the first cut took the
  // FIRST declarer's value, so a project layer that named any rule
  // became the policy owner (red-team R-F1 probe3).
  const outerValue = layers[locks.outer]?.[key];
  // Fail-safe default when the outer layer is silent: warnings stay
  // non-fatal (a strict default would let any warning abort the runtime
  // and disarm every rail) and rules stay non-overridable.
  const effective =
    typeof outerValue === "boolean"
      ? outerValue
      : key === "failOnWarnings"
        ? false
        : true;
  for (const [layerIndex, layer] of layers.entries()) {
    if (layerIndex === locks.outer) continue;
    const value = layer[key];
    if (typeof value !== "boolean" || value === effective) continue;
    diagnostics.push({
      type: "warning",
      kind: "locked-rule-violation",
      message:
        `ignoring ${key}=${value} from ${describeLayers([layerIndex])}: ` +
        `${describeLayers([locks.outer])} locks rules and ` +
        (typeof outerValue === "boolean"
          ? `sets ${key}=${effective}`
          : `leaves ${key} to the fail-safe default (${effective})`) +
        (key === "failOnWarnings"
          ? "; warning escalation cannot be used to disarm locked rules."
          : "; making every rule overridable by comment cannot be used to disarm locked rules."),
    });
  }
  return effective;
}

/**
 * Inner-wins boolean merge over the inner-first layers. Walks
 * left-to-right (inner-first); returns the first explicit boolean or
 * `undefined`. Used by `buildConfig` and the session runtime for the
 * inner-wins boolean fields. Internal — not in the package's
 * `exports` surface.
 */
export function mergeBool(
  layers: readonly SteeringConfig[],
  key: "defaultNoOverride" | "failOnWarnings",
): boolean | undefined {
  for (const layer of layers) {
    const v = layer[key];
    if (typeof v === "boolean") return v;
  }
  return undefined;
}

/**
 * Detect plugins registering a tracker under the same name and push
 * an error-class diagnostic for each collision. Two plugins claiming
 * the same state dimension is always a bug; the runtime escalates
 * these to a thrown error regardless of the user's strict-mode
 * preference.
 *
 * Plugins whose name appears in `disabledPlugins` are skipped before
 * collision detection (mirrors {@link mergePlugins}).
 */
function detectTrackerNameCollisions(
  plugins: readonly Plugin[],
  disabledPlugins: ReadonlySet<string>,
  diagnostics: SteeringDiagnostic[],
): void {
  const seen = new Map<string, string>(); // trackerName -> pluginName
  for (const plugin of plugins) {
    if (disabledPlugins.has(plugin.name)) continue;
    if (!plugin.trackers) continue;
    for (const trackerName of Object.keys(plugin.trackers)) {
      const prior = seen.get(trackerName);
      if (prior !== undefined) {
        diagnostics.push({
          type: "error",
          kind: "tracker-name-collision",
          message: formatTrackerNameCollisionMessage(
            prior,
            plugin.name,
            trackerName,
          ),
        });
        continue;
      }
      seen.set(trackerName, plugin.name);
    }
  }
}

/**
 * Merge `layers` (inner-first) into a single effective
 * {@link SteeringConfig}. There are no engine-injected defaults
 * (issue #72): the merged config contains exactly what the layers
 * declare.
 *
 * Cross-layer plugin name collisions, within-layer rule + observer
 * name collisions, and cross-layer tracker name collisions surface
 * as structured {@link SteeringDiagnostic} entries on the returned
 * object. Predicate-key + tracker-extension collisions are detected
 * in `resolvePlugins`, not here — buildConfig handles cross-layer and
 * within-layer name-collision shapes only.
 */
export function buildConfig(layers: readonly SteeringConfig[]): {
  config: SteeringConfig;
  diagnostics: SteeringDiagnostic[];
} {
  const effective: SteeringConfig[] = [...layers];

  const diagnostics: SteeringDiagnostic[] = [];

  // Locks first: every merge below is lock-aware (disabledRules,
  // disabledPlugins, rule overrides, exemptions, plugin registry,
  // failOnWarnings, defaultNoOverride).
  const locks = collectLocks(effective);
  const deps = collectLockDependencies(effective, locks);
  // Only the outermost layer's declarations bind, so only those are
  // echoed: a project layer's lockedRules must not read as protection.
  const lockedRulesList =
    locks.outerLocked.size > 0 ? [...locks.outerLocked] : undefined;

  const disabledPluginsList = mergeDisabledPlugins(
    effective,
    locks,
    deps,
    diagnostics,
  );
  const disabledRulesList = mergeDisabledRules(effective, locks, diagnostics);
  const disabledPluginsSet = new Set(disabledPluginsList ?? []);
  const disabledRulesSet = new Set(disabledRulesList ?? []);

  // Predicate + tracker-extension collisions are detected in
  // resolvePlugins, not here. buildConfig handles cross-layer and
  // within-layer name-collision shapes only.
  const plugins = mergePlugins(
    effective,
    disabledPluginsSet,
    locks,
    deps,
    diagnostics,
  );
  detectTrackerNameCollisions(plugins, disabledPluginsSet, diagnostics);

  const rules = mergeRules(effective, disabledRulesSet, locks, diagnostics);
  const observers = mergeObservers(effective, diagnostics);
  const exemptions = mergeExemptions(effective, locks, diagnostics);

  // A lock that names no rule protects nothing — a typo, or a stale lock
  // after a rename. Compile-time typo checking (defineConfig) covers the
  // config author; this covers JSON / satisfies configs and renames.
  const ruleUniverse = new Set<string>();
  for (const rule of rules) ruleUniverse.add(rule.name);
  for (const plugin of plugins) {
    for (const rule of plugin.rules ?? []) ruleUniverse.add(rule.name);
  }
  for (const name of locks.outerLocked) {
    if (ruleUniverse.has(name)) continue;
    diagnostics.push({
      type: "warning",
      kind: "locked-rule-violation",
      message:
        `lockedRules names "${name}", but no layer or plugin declares that ` +
        "rule; the lock protects nothing (a typo, or a stale lock after a rename).",
    });
  }
  // A lock binds outward only, so an INNER layer's lockedRules is inert.
  // Say so once per inner declarer instead of letting a repo believe it
  // locked something (lens round 2: red-team F6).
  for (const layerIndex of locks.declarers) {
    if (layerIndex === locks.outer) continue;
    const names = effective[layerIndex]?.lockedRules ?? [];
    diagnostics.push({
      type: "warning",
      kind: "lock-inert",
      message:
        `lockedRules from config layer #${layerIndex} (${names.join(", ")}) has ` +
        "no effect: a lock binds outward only, so only the outermost (global) " +
        "layer can lock a rule.",
    });
  }

  const out: SteeringConfig = {};
  if (plugins.length > 0) out.plugins = plugins;
  if (rules.length > 0) out.rules = rules;
  if (observers.length > 0) out.observers = observers;
  if (exemptions !== undefined) out.exemptions = exemptions;

  if (disabledRulesList !== undefined) out.disabledRules = disabledRulesList;
  if (disabledPluginsList !== undefined) {
    out.disabledPlugins = disabledPluginsList;
  }
  if (lockedRulesList !== undefined) out.lockedRules = lockedRulesList;

  const defaultNoOverride = resolveLockOwnedBool(
    effective,
    locks,
    diagnostics,
    "defaultNoOverride",
  );
  if (defaultNoOverride !== undefined) {
    out.defaultNoOverride = defaultNoOverride;
  }
  const failOnWarnings = resolveLockOwnedBool(
    effective,
    locks,
    diagnostics,
    "failOnWarnings",
  );
  if (failOnWarnings !== undefined) out.failOnWarnings = failOnWarnings;

  return { config: out, diagnostics };
}

/**
 * Convenience: load all layers for `cwd`, run the loader-side merge
 * (`buildConfig`), then the plugin merger (`resolvePlugins`) with
 * user-config rule + observer name validation between the two passes.
 * `opts` is forwarded to {@link loadConfigs} unchanged (trust-gate
 * parity for embedders — see {@link LoadConfigsOptions}).
 * Diagnostics from every surface flow into a single returned array,
 * so an external embedder writing their own bridge or pre-flight
 * check sees the SAME diagnostic stream the production runtime sees
 * — no surface is silently skipped.
 *
 * Diagnostics return in declaration order; merge-side errors
 * short-circuit `resolvePlugins` before its diagnostics are added.
 *
 * Production-strictness divergence: `loadSteeringConfig` does NOT
 * apply the strict-mode `failOnWarnings` throw policy that
 * `buildSessionRuntime` does. The function never throws on
 * diagnostics; embedders apply their own throw + warning policy.
 * See `failOnWarnings` on {@link SteeringConfig} for production-
 * faithful pre-flight semantics.
 */
export async function loadSteeringConfig(
  cwd: string,
  opts?: LoadConfigsOptions,
): Promise<{ config: SteeringConfig; diagnostics: SteeringDiagnostic[] }> {
  const { layers, diagnostics: loaderDiagnostics } = await loadConfigs(
    cwd,
    opts,
  );
  const { merged, diagnostics: mergeAndResolveDiagnostics } = runMergerPipeline(
    layers,
    EVALUATOR_BUILTIN_TRACKERS,
  );
  return {
    config: merged,
    diagnostics: [...loaderDiagnostics, ...mergeAndResolveDiagnostics],
  };
}
