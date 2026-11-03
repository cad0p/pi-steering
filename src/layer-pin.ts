// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * PROTOTYPE (lens round 2, owner question "where the boundary lives"):
 * an integrity pin for the GLOBAL layer and its import graph.
 *
 * The owner computes a manifest ({@link computeLayerPin}) over the roots
 * that make up the global layer — the steering directory and the
 * packages it imports — and stores it somewhere. The loader, when given
 * the manifest path (`LoadConfigsOptions.globalLayerPin`, off unless
 * set, not wired into the extension), recomputes the digests before it
 * imports the global layer and reports every difference.
 *
 * What it is and is not, stated as part of the claim:
 *   - It is WRITER-INDEPENDENT: a redirect, a cd chain, a glob delete, a
 *     `git checkout`, a dependency edit or a flat `steering.ts` next to
 *     the directory all change a digest or add a file, which the text
 *     guard cannot promise.
 *   - It is a BOUNDARY only when the manifest AND the code that checks it
 *     (this package, pi itself) live where the agent's uid cannot write.
 *     A manifest in an agent-writable place is rewritten together with
 *     the files; a verifier in an agent-writable `node_modules` is
 *     edited out. A signature does not change this while the agent's uid
 *     can read the signing key.
 *   - A mismatch is a WARNING, not a refusal: refusing the global layer
 *     would remove every rail, which is the failure the pin exists to
 *     catch. Whether a mismatch should instead block every tool call is
 *     an owner decision.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { SteeringDiagnostic } from "./schema.ts";

/** Manifest format, version 1. */
export interface LayerPin {
  version: 1;
  /** Absolute roots (files or directories) the digests cover. */
  roots: string[];
  /** Absolute path (as walked from a root) -> sha256 hex of its bytes. */
  files: Record<string, string>;
}

/** Directory names never hashed: caches and VCS metadata. */
const SKIPPED_DIRS = new Set([".cache", ".git"]);

/**
 * Walk `roots` and digest every regular file. Symlinks are followed
 * (pnpm's `node_modules` is symlinks); a directory reached twice by
 * realpath is walked once, so a cycle terminates.
 */
export function computeLayerPin(roots: readonly string[]): LayerPin {
  const files: Record<string, string> = {};
  const seenDirs = new Set<string>();
  const walk = (path: string): void => {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(path);
    } catch {
      return; // dangling symlink or vanished file: absent from the pin
    }
    if (st.isDirectory()) {
      let real: string;
      try {
        real = realpathSync(path);
      } catch {
        return;
      }
      if (seenDirs.has(real)) return;
      seenDirs.add(real);
      for (const name of readdirSync(path).sort()) {
        if (SKIPPED_DIRS.has(name)) continue;
        walk(join(path, name));
      }
      return;
    }
    if (!st.isFile()) return;
    files[path] = createHash("sha256").update(readFileSync(path)).digest("hex");
  };
  const absRoots = roots.map((r) => resolve(r));
  for (const root of absRoots) walk(root);
  return { version: 1, roots: absRoots, files };
}

function isLayerPin(value: unknown): value is LayerPin {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return false;
  if (!Array.isArray(v.roots)) return false;
  if (!v.roots.every((r) => typeof r === "string" && isAbsolute(r))) {
    return false;
  }
  const files = v.files;
  if (files === null || typeof files !== "object" || Array.isArray(files)) {
    return false;
  }
  return Object.values(files).every((d) => typeof d === "string");
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const MAX_LISTED = 5;

/**
 * Verify the files under a pin manifest. Returns warning-class
 * `global-layer-pin-mismatch` diagnostics (empty when everything
 * matches). `layerFile` is the global-layer config file the loader is
 * about to import: it must sit inside a pinned root, which is what binds
 * the pin to the layer actually loaded (a relocated agent dir loads a
 * different file and is reported).
 */
export function verifyLayerPin(
  manifestPath: string,
  layerFile: string | null,
): SteeringDiagnostic[] {
  const mismatch = (message: string): SteeringDiagnostic => ({
    type: "warning",
    kind: "global-layer-pin-mismatch",
    path: manifestPath,
    message,
  });
  let pin: unknown;
  try {
    pin = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    const body = err instanceof Error ? err.message : String(err);
    return [mismatch(`pin manifest unreadable: ${body}`)];
  }
  if (!isLayerPin(pin)) {
    return [mismatch("pin manifest is not a version-1 layer pin")];
  }
  const out: SteeringDiagnostic[] = [];
  if (layerFile === null) {
    out.push(
      mismatch(
        "no global-layer config file exists; the pin covers nothing that loads",
      ),
    );
  } else if (!pin.roots.some((root) => isInside(resolve(layerFile), root))) {
    out.push(
      mismatch(
        `the global layer about to load (${layerFile}) is outside every pinned root`,
      ),
    );
  }
  const now = computeLayerPin(pin.roots).files;
  const changed: string[] = [];
  const missing: string[] = [];
  const added: string[] = [];
  for (const [path, digest] of Object.entries(pin.files)) {
    const current = now[path];
    if (current === undefined) missing.push(path);
    else if (current !== digest) changed.push(path);
  }
  for (const path of Object.keys(now)) {
    if (!(path in pin.files)) added.push(path);
  }
  const list = (label: string, paths: string[]): string =>
    paths.length === 0
      ? ""
      : ` ${label} ${paths.length}: ${paths.slice(0, MAX_LISTED).join(", ")}${paths.length > MAX_LISTED ? ", ..." : ""}.`;
  if (changed.length + missing.length + added.length > 0) {
    out.push(
      mismatch(
        "the global layer differs from its pin." +
          list("changed", changed) +
          list("missing", missing) +
          list("added", added),
      ),
    );
  }
  return out;
}
