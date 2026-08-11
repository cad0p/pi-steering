// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Tests for `resolvePlugins` — the plugin merger.
 *
 * Covers the collision semantics the ADR pins down: first-wins on soft
 * collisions (predicate / observer / rule), hard error on tracker name
 * collision, proper layering of trackerExtensions on top of registered
 * trackers, and the config-level `disabledRules` / `disabledPlugins` filters.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Modifier, Tracker } from "@cad0p/unbash-walker";
import {
  resolvePlugins,
  validateName,
  validateUserConfigNames,
} from "./plugin-merger.ts";
import type { Observer, Plugin, Rule } from "./schema.ts";

/** Build a minimal observer with a recognizable onResult. */
function mkObserver(name: string): Observer {
  return { name, onResult: () => {} };
}

/** Build a minimal bash rule. */
function mkRule(name: string): Rule {
  return {
    name,
    tool: "bash",
    field: "command",
    pattern: "^never$",
    reason: `rule ${name}`,
  };
}

/** Build a minimal tracker with deterministic initial / unknown. */
function mkTracker(label: string): Tracker<string> {
  return {
    initial: `${label}:init`,
    unknown: `${label}:unknown`,
    modifiers: {},
    subshellSemantics: "isolated",
  };
}

/** A sentinel per-command modifier we can identify by identity. */
function mkModifier(tag: string): Modifier<string> {
  return {
    scope: "per-command",
    apply: (_args, current) => `${current}+${tag}`,
  };
}

describe("resolvePlugins: empty input", () => {
  it("returns an empty ResolvedPluginState for no plugins", () => {
    const state = resolvePlugins([], {});
    assert.deepEqual(state.predicates, {});
    assert.deepEqual(state.observers, []);
    assert.deepEqual(state.trackers, {});
    assert.deepEqual(state.trackerModifiers, {});
    assert.deepEqual(state.composedTrackers, {});
    assert.deepEqual(state.rules, []);
    // Optional field: absent (undefined) when no plugin ships
    // exemptions — the evaluator treats it as an empty bucket.
    assert.equal(state.exemptions, undefined);
    assert.deepEqual(state.diagnostics, []);
  });
});

describe("resolvePlugins: single plugin surface", () => {
  it("propagates predicates / observers / trackers / rules unchanged", () => {
    const tracker = mkTracker("t");
    const obs = mkObserver("obs");
    const rule = mkRule("r");
    const predicate = () => true;

    const plugin: Plugin = {
      name: "p",
      predicates: { foo: predicate },
      observers: [obs],
      trackers: { t: tracker as Tracker<unknown> },
      rules: [rule],
    };

    const state = resolvePlugins([plugin], {});
    assert.equal(state.predicates["foo"], predicate);
    assert.deepEqual(state.observers, [obs]);
    assert.equal(state.trackers["t"], tracker);
    // No extensions → composed tracker is identity-equal when no extras
    // were layered on.
    assert.equal(state.composedTrackers["t"], tracker);
    assert.deepEqual(state.rules, [rule]);
    assert.deepEqual(state.rulePluginOwners, { r: "p" });
    assert.deepEqual(state.diagnostics, []);
  });
});

describe("resolvePlugins: rulePluginOwners", () => {
  it("maps each plugin rule name to its originating plugin", () => {
    const p1: Plugin = { name: "plugin-a", rules: [mkRule("rule-a")] };
    const p2: Plugin = { name: "plugin-b", rules: [mkRule("rule-b")] };
    const state = resolvePlugins([p1, p2], {});
    assert.deepEqual(state.rulePluginOwners, {
      "rule-a": "plugin-a",
      "rule-b": "plugin-b",
    });
  });

  it("first-wins collision keeps the first owner", () => {
    const p1: Plugin = { name: "first", rules: [mkRule("dup")] };
    const p2: Plugin = { name: "second", rules: [mkRule("dup")] };
    const state = resolvePlugins([p1, p2], {});
    assert.deepEqual(state.rulePluginOwners, { dup: "first" });
  });
});

describe("resolvePlugins: predicate collision (soft)", () => {
  it("keeps first-registered predicate, emits warning", () => {
    const keptHandler = () => true;
    const droppedHandler = () => false;
    const p1: Plugin = { name: "first", predicates: { branch: keptHandler } };
    const p2: Plugin = {
      name: "second",
      predicates: { branch: droppedHandler },
    };

    const state = resolvePlugins([p1, p2], {});
    assert.equal(state.predicates["branch"], keptHandler);
    assert.equal(state.diagnostics.length, 1);
    assert.equal(state.diagnostics[0]?.kind, "predicate-collision");
    assert.match(state.diagnostics[0]?.message ?? "", /when\.branch/);
    assert.match(state.diagnostics[0]?.message ?? "", /first/);
    assert.match(state.diagnostics[0]?.message ?? "", /second/);
  });
});

describe("resolvePlugins: observer collision (soft)", () => {
  it("keeps first-registered observer, emits warning", () => {
    const kept = mkObserver("sync-done");
    const dropped = mkObserver("sync-done");
    const p1: Plugin = { name: "first", observers: [kept] };
    const p2: Plugin = { name: "second", observers: [dropped] };

    const state = resolvePlugins([p1, p2], {});
    assert.deepEqual(state.observers, [kept]);
    assert.equal(state.observers[0], kept, "first-registered instance kept");
    assert.equal(state.diagnostics.length, 1);
    assert.equal(state.diagnostics[0]?.kind, "observer-collision");
  });
});

describe("resolvePlugins: rule collision (soft)", () => {
  it("keeps first-registered rule, emits warning", () => {
    const kept = mkRule("shared-name");
    const dropped = mkRule("shared-name");
    const p1: Plugin = { name: "first", rules: [kept] };
    const p2: Plugin = { name: "second", rules: [dropped] };

    const state = resolvePlugins([p1, p2], {});
    assert.equal(state.rules.length, 1);
    assert.equal(state.rules[0], kept);
    assert.equal(state.diagnostics.length, 1);
    assert.equal(state.diagnostics[0]?.kind, "rule-collision");
  });
});

describe("resolvePlugins: tracker collision (error-class diagnostic)", () => {
  it("records an error-class tracker-name-collision diagnostic when two plugins register the same tracker name", () => {
    const p1: Plugin = {
      name: "first",
      trackers: { branch: mkTracker("one") as Tracker<unknown> },
    };
    const p2: Plugin = {
      name: "second",
      trackers: { branch: mkTracker("two") as Tracker<unknown> },
    };

    const state = resolvePlugins([p1, p2], {});
    const hit = state.diagnostics.find(
      (d) => d.kind === "tracker-name-collision",
    );
    assert.ok(
      hit,
      `expected a tracker-name-collision diagnostic; got: ${JSON.stringify(state.diagnostics)}`,
    );
    assert.equal(hit.type, "error");
    assert.match(hit.message, /tracker name collision/);
    assert.match(hit.message, /"first".*"second"/);
    // Direct callers (those that bypass `buildConfig`) check
    // `result.diagnostics.some(d => d.type === "error")` before using
    // the resolved state — same contract as `loadHarness`.
    assert.ok(
      state.diagnostics.some((d) => d.type === "error"),
      "expected at least one error-class diagnostic",
    );
    // The colliding tracker is dropped from the second plugin; the first
    // plugin's registration wins (matches the loader's first-wins ordering).
    assert.equal(
      (state.trackers.branch as Tracker<string>).initial,
      "one:init",
    );
  });

  it("preserves warning-class diagnostics from earlier plugins alongside the tracker-name-collision error", () => {
    // Convert-to-diagnostic guarantees: a tracker-name collision no
    // longer aborts the merger. Earlier plugins' warning-class
    // diagnostics (e.g. duplicate predicate names) survive on the
    // returned `diagnostics` array, so direct callers of
    // `resolvePlugins` see the full picture in one read instead of
    // catching a throw and losing visibility into prior issues.
    const p1: Plugin = {
      name: "first",
      predicates: { dup: () => true },
      trackers: { branch: mkTracker("one") as Tracker<unknown> },
    };
    const p2: Plugin = {
      name: "second",
      predicates: { dup: () => false },
      trackers: { branch: mkTracker("two") as Tracker<unknown> },
    };
    const state = resolvePlugins([p1, p2], {});
    assert.ok(
      state.diagnostics.some((d) => d.kind === "predicate-collision"),
      "expected the predicate-collision warning to survive alongside the tracker error",
    );
    assert.ok(
      state.diagnostics.some((d) => d.kind === "tracker-name-collision"),
      "expected the tracker-name-collision error",
    );
  });

  it('records an error-class diagnostic when a plugin registers the reserved tracker name "events"', () => {
    // `walkerState.events` is written by the evaluator's speculative-
    // entry synthesis pass (see evaluator.ts `prepareBashState`). A
    // plugin-registered `events` tracker would be silently clobbered
    // when the evaluator merges synthesized entries in, breaking
    // `when.happened` with `in: "tool_call"`. Schema JSDoc promises
    // rejection; this test holds the promise honest.
    const p: Plugin = {
      name: "broken",
      trackers: { events: mkTracker("x") as Tracker<unknown> },
    };
    const state = resolvePlugins([p], {});
    const hit = state.diagnostics.find(
      (d) => d.kind === "reserved-tracker-name",
    );
    assert.ok(
      hit,
      `expected a reserved-tracker-name diagnostic; got: ${JSON.stringify(state.diagnostics)}`,
    );
    assert.equal(hit.type, "error");
    assert.match(hit.message, /tracker name "events" is reserved/);
    // The reserved tracker is dropped, not added to the trackers map.
    assert.ok(!("events" in state.trackers));
  });
});

describe("resolvePlugins: tracker extensions", () => {
  it("layers extension modifiers on top of the declaring tracker", () => {
    const origMod = mkModifier("orig");
    const extraMod = mkModifier("extra");
    const tracker: Tracker<unknown> = {
      initial: "init",
      unknown: "unknown",
      modifiers: { git: origMod as Modifier<unknown> },
      subshellSemantics: "isolated",
    };
    const owner: Plugin = { name: "owner", trackers: { cwd: tracker } };
    const extender: Plugin = {
      name: "extender",
      trackerExtensions: {
        cwd: { git: extraMod as Modifier<unknown> },
      },
    };

    const state = resolvePlugins([owner, extender], {});
    assert.deepEqual(state.diagnostics, []);
    assert.equal(state.trackers["cwd"], tracker, "raw tracker preserved");
    const composed = state.composedTrackers["cwd"]!;
    assert.notEqual(
      composed,
      tracker,
      "composed tracker is a new object (non-mutating)",
    );
    const composedMods = composed.modifiers["git"];
    assert.ok(Array.isArray(composedMods), "composed git entry is array");
    const list = composedMods as Modifier<unknown>[];
    assert.equal(list.length, 2);
    assert.equal(list[0], origMod, "original modifier retained first");
    assert.equal(list[1], extraMod, "extension modifier appended");
  });

  it("warns and drops extensions targeting an unregistered tracker", () => {
    const extender: Plugin = {
      name: "extender",
      trackerExtensions: {
        nosuch: { git: mkModifier("x") as Modifier<unknown> },
      },
    };
    const state = resolvePlugins([extender], {});
    assert.equal(state.diagnostics.length, 1);
    assert.equal(state.diagnostics[0]?.kind, "extension-orphan");
    assert.match(state.diagnostics[0]?.message ?? "", /"nosuch"/);
    assert.deepEqual(state.trackerModifiers, {});
    assert.deepEqual(state.composedTrackers, {});
  });

  it("keeps extensions targeting knownBuiltinTrackers (no warning, modifiers preserved)", () => {
    // The caller declares `"cwd"` as a built-in tracker name. The
    // merger still doesn't OWN the tracker (cwd isn't in any
    // plugin's `trackers` map, so `composedTrackers.cwd` stays
    // undefined), but the extension modifiers are preserved in
    // `trackerModifiers.cwd` for the caller to layer onto its own
    // built-in tracker. The evaluator uses this path for the
    // walker's built-in `cwdTracker`.
    const extender: Plugin = {
      name: "extender",
      trackerExtensions: {
        cwd: { git: mkModifier("x") as Modifier<unknown> },
      },
    };
    const state = resolvePlugins([extender], {}, ["cwd"]);
    assert.equal(
      state.diagnostics.filter((w) => w.kind === "extension-orphan").length,
      0,
      "no orphan warning when the tracker name is declared built-in",
    );
    assert.ok("cwd" in state.trackerModifiers);
    assert.ok(state.trackerModifiers["cwd"]?.["git"] !== undefined);
    // Still NOT composed - the caller is responsible for composing
    // these modifiers onto its own built-in tracker.
    assert.ok(!("cwd" in state.composedTrackers));
  });

  it("accepts the array form on trackerExtensions values", () => {
    const tracker: Tracker<unknown> = {
      initial: "x",
      unknown: "?",
      modifiers: {},
      subshellSemantics: "isolated",
    };
    const m1 = mkModifier("a");
    const m2 = mkModifier("b");
    const owner: Plugin = { name: "owner", trackers: { cwd: tracker } };
    const extender: Plugin = {
      name: "extender",
      trackerExtensions: {
        cwd: {
          git: [m1, m2] as readonly Modifier<unknown>[],
        },
      },
    };

    const state = resolvePlugins([owner, extender], {});
    const composed = state.composedTrackers["cwd"]!;
    const list = composed.modifiers["git"] as Modifier<unknown>[];
    assert.ok(Array.isArray(list));
    assert.deepEqual(list, [m1, m2]);
  });

  it("appends modifiers from multiple plugins in registration order", () => {
    const tracker: Tracker<unknown> = {
      initial: "x",
      unknown: "?",
      modifiers: {},
      subshellSemantics: "isolated",
    };
    const m1 = mkModifier("one");
    const m2 = mkModifier("two");
    const owner: Plugin = { name: "owner", trackers: { cwd: tracker } };
    const ext1: Plugin = {
      name: "ext1",
      trackerExtensions: { cwd: { git: m1 as Modifier<unknown> } },
    };
    const ext2: Plugin = {
      name: "ext2",
      trackerExtensions: { cwd: { git: m2 as Modifier<unknown> } },
    };

    const state = resolvePlugins([owner, ext1, ext2], {});
    const list = state.composedTrackers["cwd"]!.modifiers[
      "git"
    ] as Modifier<unknown>[];
    assert.deepEqual(list, [m1, m2]);
  });

  it("leaves trackers unchanged when no extensions are registered", () => {
    const tracker = mkTracker("cwd");
    const plugin: Plugin = {
      name: "only",
      trackers: { cwd: tracker as Tracker<unknown> },
    };
    const state = resolvePlugins([plugin], {});
    assert.equal(state.composedTrackers["cwd"], tracker);
  });
});

describe("resolvePlugins: config filters", () => {
  let origInfo: typeof console.info;
  let infos: string[];

  function captureInfos(): void {
    origInfo = console.info;
    infos = [];
    console.info = (msg: unknown) => {
      infos.push(String(msg));
    };
  }

  function restoreInfos(): void {
    console.info = origInfo;
  }

  it("applies config.disabledRules to plugin-shipped rules", () => {
    const kept = mkRule("keep-me");
    const dropped = mkRule("drop-me");
    const plugin: Plugin = {
      name: "p",
      rules: [kept, dropped],
    };
    captureInfos();
    try {
      const state = resolvePlugins([plugin], { disabledRules: ["drop-me"] });
      assert.equal(state.rules.length, 1);
      assert.equal(state.rules[0]?.name, "keep-me");
      // Disabling a plugin-shipped rule is by-design behavior, not a
      // diagnostic-stream entry. Surfaced via console.info so authors
      // debugging "why isn't my rule firing?" still get a breadcrumb.
      assert.deepEqual(
        state.diagnostics.filter((d) => d.message.includes("disabled")),
        [],
      );
      assert.ok(
        infos.some(
          (m) =>
            m.includes("[pi-steering]") &&
            m.includes('rule "drop-me"') &&
            m.includes("disabled via config.disabledRules"),
        ),
        `expected a console.info breadcrumb for the disabled rule; got: ${JSON.stringify(infos)}`,
      );
    } finally {
      restoreInfos();
    }
  });

  it("applies config.disabledPlugins to skip an entire plugin", () => {
    const p1: Plugin = {
      name: "git",
      predicates: { branch: () => true },
      rules: [mkRule("no-main-commit")],
      observers: [mkObserver("sync-done")],
    };
    const p2: Plugin = {
      name: "kept",
      predicates: { other: () => true },
    };
    captureInfos();
    try {
      const state = resolvePlugins([p1, p2], { disabledPlugins: ["git"] });

      assert.deepEqual(state.observers, []);
      assert.deepEqual(state.rules, []);
      assert.ok(!("branch" in state.predicates));
      assert.ok("other" in state.predicates);
      // No diagnostic for the disabled plugin — by-design behavior.
      assert.deepEqual(
        state.diagnostics.filter((d) => d.message.includes("disabled")),
        [],
      );
      assert.ok(
        infos.some(
          (m) =>
            m.includes("[pi-steering]") &&
            m.includes('plugin "git"') &&
            m.includes("disabled via config.disabledPlugins"),
        ),
        `expected a console.info breadcrumb for the disabled plugin; got: ${JSON.stringify(infos)}`,
      );
    } finally {
      restoreInfos();
    }
  });

  it("disabledPlugins covering a default plugin does NOT throw under strict default", () => {
    // Regression for the case where `disabledPlugins: ["git"]`
    // previously emitted a `plugin-disabled` warning that strict
    // mode (the new default) escalated to a thrown error, breaking
    // the most common opt-out path on first activation.
    captureInfos();
    try {
      const state = resolvePlugins(
        [{ name: "git", predicates: { branch: () => true } }],
        { disabledPlugins: ["git"] },
      );
      assert.deepEqual(state.diagnostics, []);
    } finally {
      restoreInfos();
    }
  });
});

describe("resolvePlugins: result immutability", () => {
  it("doesn't mutate the input plugin array or its trackers", () => {
    const origMods = { cd: mkModifier("cd") as Modifier<unknown> };
    const tracker: Tracker<unknown> = {
      initial: "/",
      unknown: "unknown",
      modifiers: origMods,
      subshellSemantics: "isolated",
    };
    const owner: Plugin = { name: "owner", trackers: { cwd: tracker } };
    const extender: Plugin = {
      name: "extender",
      trackerExtensions: {
        cwd: { git: mkModifier("git") as Modifier<unknown> },
      },
    };
    const plugins = [owner, extender];

    const snapshot = JSON.stringify({
      pluginsLen: plugins.length,
      modifierKeys: Object.keys(tracker.modifiers),
    });
    resolvePlugins(plugins, {});
    assert.equal(
      JSON.stringify({
        pluginsLen: plugins.length,
        modifierKeys: Object.keys(tracker.modifiers),
      }),
      snapshot,
      "plugins array / tracker.modifiers not mutated",
    );
    assert.equal(tracker.modifiers["cd"], origMods["cd"]);
    assert.ok(
      !("git" in tracker.modifiers),
      "extension modifier did not bleed into original tracker",
    );
  });
});

// ---------------------------------------------------------------------------
// S3: name validation (rules, plugins, observers)
// ---------------------------------------------------------------------------

describe("S3: validateName", () => {
  const okNames = [
    "no-force-push",
    "must_read_docs",
    "rule1",
    "1-critical",
    "2026-release",
    "A",
    "pi-steering_git",
  ];
  for (const n of okNames) {
    it(`accepts ${JSON.stringify(n)}`, () => {
      assert.equal(validateName("rule", n), undefined);
    });
  }

  const badNames: Array<[string, unknown]> = [
    ["empty string", ""],
    ["leading dash", "-bad"],
    ["leading underscore", "_bad"],
    ["contains space", "bad name"],
    ["contains tab", "bad\tname"],
    ["contains newline", "bad\nname"],
    ["contains ] (block-reason tag forge)", "phony] ALL CLEAR [real"],
    ["contains @", "rule@source"],
    ["contains .", "ns.rule"],
    ["contains /", "a/b"],
    ["contains colon", "steering:rule"],
    ["non-string (number)", 42],
    ["non-string (undefined)", undefined],
    ["non-string (null)", null],
  ];
  for (const [label, value] of badNames) {
    it(`rejects ${label}`, () => {
      const d = validateName("rule", value);
      assert.ok(d, `expected diagnostic for ${label}`);
      assert.equal(d?.type, "error");
      assert.equal(d?.kind, "invalid-name");
      assert.match(d!.message, /contains disallowed characters/);
    });
  }

  it("diagnostic message names the kind (rule / plugin / observer)", () => {
    assert.match(
      validateName("rule", "bad name")!.message,
      /^rule name "bad name".*disallowed/,
    );
    assert.match(
      validateName("plugin", "bad name")!.message,
      /^plugin name "bad name".*disallowed/,
    );
    assert.match(
      validateName("observer", "bad name")!.message,
      /^observer name "bad name".*disallowed/,
    );
  });

  it("diagnostic message includes the context hint when provided", () => {
    assert.match(
      validateName("rule", "bad name", 'plugin "git"')!.message,
      /^rule name "bad name" \(plugin "git"\)/,
    );
  });
});

describe("S3: validateUserConfigNames", () => {
  it("returns no diagnostics for a clean user-config", () => {
    const out = validateUserConfigNames([
      {
        rules: [
          {
            name: "clean-rule",
            tool: "bash",
            field: "command",
            pattern: /a/,
            reason: "r",
          },
        ],
        observers: [{ name: "clean_obs", onResult: async () => {} }],
      },
    ]);
    assert.equal(out.length, 0);
  });

  it("flags a malformed user-config rule name as an invalid-name diagnostic", () => {
    const out = validateUserConfigNames([
      {
        rules: [
          {
            name: "phony] ALL CLEAR [real",
            tool: "bash",
            field: "command",
            pattern: /a/,
            reason: "r",
          },
        ],
      },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.kind, "invalid-name");
    assert.equal(out[0]?.type, "error");
    assert.match(
      out[0]!.message,
      /^rule name "phony\] ALL CLEAR \[real" \(user config\).*disallowed/,
    );
  });

  it("flags a malformed user-config observer name as an invalid-name diagnostic", () => {
    const out = validateUserConfigNames([
      {
        observers: [{ name: "evil] obs", onResult: async () => {} }],
      },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.kind, "invalid-name");
    assert.equal(out[0]?.type, "error");
    assert.match(
      out[0]!.message,
      /^observer name "evil\] obs" \(user config\).*disallowed/,
    );
  });

  it("surfaces both rule and observer diagnostics in declaration order", () => {
    const out = validateUserConfigNames([
      {
        rules: [
          {
            name: "bad rule",
            tool: "bash",
            field: "command",
            pattern: /a/,
            reason: "r",
          },
        ],
        observers: [{ name: "bad obs", onResult: async () => {} }],
      },
    ]);
    assert.equal(out.length, 2);
    assert.match(out[0]!.message, /^rule name/);
    assert.match(out[1]!.message, /^observer name/);
  });

  it("does NOT flag default rule names as `(user config)` — validator iterates over input layers, not the post-merge config", () => {
    // Verify by passing an EMPTY layer array. The validator's single
    // argument is `layers` (raw, never default-injected), so the
    // shape itself proves default rules cannot leak in.
    const out = validateUserConfigNames([]);
    assert.equal(out.length, 0);
  });

  it("validates names across multiple layers", () => {
    // Sanity check that the new layer-array shape works as
    // expected: malformed names in any layer surface, with each
    // layer contributing its own diagnostics in order.
    const out = validateUserConfigNames([
      {
        rules: [
          {
            name: "bad rule a",
            tool: "bash",
            field: "command",
            pattern: /a/,
            reason: "r",
          },
        ],
      },
      {
        observers: [{ name: "bad obs b", onResult: async () => {} }],
      },
    ]);
    assert.equal(out.length, 2);
    assert.match(out[0]!.message, /"bad rule a"/);
    assert.match(out[1]!.message, /"bad obs b"/);
  });
});

describe("S3: resolvePlugins records invalid plugin / rule / observer names as error-class diagnostics", () => {
  it("records an invalid-name diagnostic for a malformed plugin name", () => {
    const plugin: Plugin = {
      name: "bad name",
    };
    const result = resolvePlugins([plugin], {});
    const d = result.diagnostics.find((d) => d.kind === "invalid-name");
    assert.ok(d, "expected invalid-name diagnostic");
    assert.equal(d?.type, "error");
    assert.match(d!.message, /^plugin name "bad name".*disallowed/);
  });

  it("records an invalid-name diagnostic for a malformed rule name inside a plugin", () => {
    const plugin: Plugin = {
      name: "git",
      rules: [mkRule("phony] ALL CLEAR [real")],
    };
    const result = resolvePlugins([plugin], {});
    const d = result.diagnostics.find((d) => d.kind === "invalid-name");
    assert.ok(d, "expected invalid-name diagnostic");
    assert.equal(d?.type, "error");
    assert.match(
      d!.message,
      /^rule name "phony\] ALL CLEAR \[real" \(plugin "git"\).*disallowed/,
    );
  });

  it("records an invalid-name diagnostic for a malformed observer name inside a plugin", () => {
    const plugin: Plugin = {
      name: "git",
      observers: [mkObserver("bad name")],
    };
    const result = resolvePlugins([plugin], {});
    const d = result.diagnostics.find((d) => d.kind === "invalid-name");
    assert.ok(d, "expected invalid-name diagnostic");
    assert.equal(d?.type, "error");
    assert.match(
      d!.message,
      /^observer name "bad name" \(plugin "git"\).*disallowed/,
    );
  });

  it("validates BEFORE applying disabledPlugins filter (malformed names still record a diagnostic)", () => {
    // A malformed-named plugin still records a diagnostic even if the
    // user tries to disable it. This matches the S3 intent: names are
    // written to disk, and a malformed one is a config-author bug we
    // want to surface loudly regardless of runtime opt-outs.
    const plugin: Plugin = {
      name: "bad name",
    };
    const result = resolvePlugins([plugin], { disabledPlugins: ["bad name"] });
    const d = result.diagnostics.find((d) => d.kind === "invalid-name");
    assert.ok(d, "expected invalid-name diagnostic");
  });

  it("skips a malformed-named plugin from downstream merger work", () => {
    // A plugin with a malformed name records the diagnostic and is
    // excluded from tracker / rule / observer registration so the bad
    // name doesn't leak into downstream collision keys.
    const plugin: Plugin = {
      name: "bad name",
      trackers: { branch: mkTracker("branch") },
      rules: [mkRule("valid-rule")],
    };
    const result = resolvePlugins([plugin], {});
    assert.equal(result.rules.length, 0);
    assert.deepEqual(result.trackers, {});
  });
});
