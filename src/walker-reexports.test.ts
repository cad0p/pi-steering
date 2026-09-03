// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Root-import pin for the curated walker re-export surface (issue
 * #87).
 *
 * `expandTildeIfLeading` lives in `@cad0p/unbash-walker`'s
 * `resolve-word` module; this suite imports it through the core
 * package root so a future refactor that drops the symbol from the
 * curated re-export list in `./index.ts` breaks loudly here
 * instead of silently shipping two sources of walker truth to
 * downstream consumers (e.g. `pi-steering-github#53`, which
 * resolves bare `~/…` vault paths through `ctx.walkerState.env`).
 *
 * Contract pinned (mirrors the walker's tilde semantics):
 *
 *   - `~` → `HOME`, or `undefined` when HOME is absent.
 *   - `~/rest` → `HOME + "/" + rest`, or `undefined` when HOME
 *     is absent.
 *   - `~user` / `~user/rest` → returned unchanged (arbitrary
 *     user HOME directories are not modeled).
 *   - No leading `~` → input unchanged.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { expandTildeIfLeading } from "./index.ts";

describe("walker re-exports: expandTildeIfLeading (issue #87)", () => {
  it("expands a bare `~` to HOME", () => {
    assert.equal(
      expandTildeIfLeading("~", new Map([["HOME", "/home/pier"]])),
      "/home/pier",
    );
  });

  it("expands `~/rest` to HOME + `/rest`", () => {
    assert.equal(
      expandTildeIfLeading(
        "~/notes/body.md",
        new Map([["HOME", "/home/pier"]]),
      ),
      "/home/pier/notes/body.md",
    );
  });

  it("leaves `~user` / `~user/rest` unchanged (unsupported user dirs)", () => {
    const env = new Map([["HOME", "/home/pier"]]);
    assert.equal(expandTildeIfLeading("~other", env), "~other");
    assert.equal(expandTildeIfLeading("~other/x", env), "~other/x");
  });

  it("returns undefined when HOME is absent (`~` and `~/rest`)", () => {
    assert.equal(expandTildeIfLeading("~", new Map()), undefined);
    assert.equal(expandTildeIfLeading("~/x", new Map()), undefined);
  });

  it("returns non-`~` input unchanged", () => {
    assert.equal(expandTildeIfLeading("/abs/path", new Map()), "/abs/path");
    assert.equal(expandTildeIfLeading("", new Map()), "");
    assert.equal(
      expandTildeIfLeading("$HOME/x", new Map([["HOME", "/h"]])),
      "$HOME/x",
    );
  });
});
