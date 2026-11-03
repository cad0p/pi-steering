// SPDX-License-Identifier: MIT
// Part of pi-steering.
//
// PROTOTYPE: the global-layer integrity pin (off unless
// LoadConfigsOptions.globalLayerPin is set; not wired into the
// extension). See layer-pin.ts for what it is and is not.

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { computeLayerPin, verifyLayerPin } from "./layer-pin.ts";
import { loadSteeringConfig } from "./loader.ts";

let root: string;
let agentDir: string;
let layerFile: string;
let pinPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-steering-pin-"));
  agentDir = join(root, "agent");
  mkdirSync(join(agentDir, "steering"), { recursive: true });
  layerFile = join(agentDir, "steering", "index.ts");
  writeFileSync(
    layerFile,
    'import { x } from "./dep.ts"; export default { rules: [] };',
  );
  writeFileSync(join(agentDir, "steering", "dep.ts"), "export const x = 1;");
  // A dependency outside the layer dir, reached through a symlink (pnpm).
  mkdirSync(join(root, "store", "pkg"), { recursive: true });
  writeFileSync(join(root, "store", "pkg", "index.js"), "module.exports = 1;");
  mkdirSync(join(agentDir, "steering", "node_modules"), { recursive: true });
  symlinkSync(
    join(root, "store", "pkg"),
    join(agentDir, "steering", "node_modules", "pkg"),
  );
  pinPath = join(root, "pin.json");
  writeFileSync(
    pinPath,
    JSON.stringify(computeLayerPin([join(agentDir, "steering")])),
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("layer pin (prototype)", () => {
  it("covers the layer, its siblings and symlinked dependencies", () => {
    const pin = computeLayerPin([join(agentDir, "steering")]);
    const files = Object.keys(pin.files).map((p) => p.slice(agentDir.length));
    assert.deepEqual(files.sort(), [
      "/steering/dep.ts",
      "/steering/index.ts",
      "/steering/node_modules/pkg/index.js",
    ]);
  });

  it("an untouched layer verifies clean", () => {
    assert.deepEqual(verifyLayerPin(pinPath, layerFile), []);
  });

  it("reports an edited, an added and a removed file, whatever wrote them", () => {
    writeFileSync(
      join(root, "store", "pkg", "index.js"),
      "module.exports = 2;",
    );
    writeFileSync(join(agentDir, "steering", "extra.ts"), "export default {};");
    rmSync(join(agentDir, "steering", "dep.ts"));
    const [d, ...rest] = verifyLayerPin(pinPath, layerFile);
    assert.equal(rest.length, 0);
    assert.equal(d?.kind, "global-layer-pin-mismatch");
    assert.equal(d?.type, "warning");
    assert.match(d?.message ?? "", /changed 1: .*pkg\/index\.js/);
    assert.match(d?.message ?? "", /missing 1: .*dep\.ts/);
    assert.match(d?.message ?? "", /added 1: .*extra\.ts/);
  });

  it("reports a layer that loads from outside every pinned root (a relocated agent dir)", () => {
    const elsewhere = join(root, "rogue", "steering", "index.ts");
    const diagnostics = verifyLayerPin(pinPath, elsewhere);
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0]?.message ?? "", /outside every pinned root/);
  });

  it("an unreadable or malformed manifest is a mismatch, not a pass", () => {
    assert.match(
      verifyLayerPin(join(root, "nope.json"), layerFile)[0]?.message ?? "",
      /unreadable/,
    );
    writeFileSync(pinPath, JSON.stringify({ version: 2 }));
    assert.match(
      verifyLayerPin(pinPath, layerFile)[0]?.message ?? "",
      /not a version-1/,
    );
  });

  it("the loader checks the pin only when asked, and still loads the layer", async () => {
    const project = join(root, "proj");
    mkdirSync(project);
    writeFileSync(join(agentDir, "steering", "dep.ts"), "export const x = 2;");
    const off = await loadSteeringConfig(project, { agentDir });
    assert.equal(
      off.diagnostics.filter((d) => d.kind === "global-layer-pin-mismatch")
        .length,
      0,
    );
    const on = await loadSteeringConfig(project, {
      agentDir,
      globalLayerPin: pinPath,
    });
    assert.equal(
      on.diagnostics.filter((d) => d.kind === "global-layer-pin-mismatch")
        .length,
      1,
    );
    assert.deepEqual(
      on.config,
      off.config,
      "a mismatch never removes the rails",
    );
  });
});
