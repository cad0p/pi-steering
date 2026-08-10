// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Tests for the `@cad0p/pi-steering` CLI (`./pi-steering.ts`).
 *
 * Runs the CLI as a subprocess via `node --experimental-strip-types
 * src/bin/pi-steering.ts …`. This mirrors real invocation (the built
 * shebang script runs under a fresh node) and sidesteps the
 * `node:test` worker's stdout sharing — patching
 * `process.stdout.write` in-process swallows the worker's TAP frames.
 *
 * File IO fixtures live under `mkdtempSync`; each test cleans up its
 * directory in `afterEach`.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { writeSteeringDirConfig } from "../__test-helpers__.ts";

// ---------------------------------------------------------------------------
// subprocess runner
// ---------------------------------------------------------------------------

const CLI_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "pi-steering.ts",
);

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the CLI as a child process under `node --experimental-strip-types`.
 * Returns the exit code and captured stdout/stderr. Never throws for
 * non-zero exit codes — the caller asserts on `code`.
 *
 * Accepts an optional `cwd` so tests for the `list` subcommand can
 * point the walk-up loader at a scratch directory without polluting
 * the project.
 */
function runCli(...args: string[]): Promise<RunResult>;
function runCli(opts: { cwd?: string }, ...args: string[]): Promise<RunResult>;
function runCli(
  first?: string | { cwd?: string },
  ...rest: string[]
): Promise<RunResult> {
  let cwd: string | undefined;
  let args: string[];
  if (typeof first === "object" && first !== null) {
    cwd = first.cwd;
    args = rest;
  } else {
    args = first === undefined ? [...rest] : [first, ...rest];
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", CLI_PATH, ...args],
      {
        stdio: ["ignore", "pipe", "pipe"],
        ...(cwd !== undefined ? { cwd } : {}),
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      // Filter the Node experimental-strip-types warning so tests
      // assert against clean stderr. The warning is
      // version-dependent; drop any line mentioning it.
      const cleanedStderr = stderr
        .split("\n")
        .filter((line) => !/ExperimentalWarning/.test(line))
        .filter((line) => !/Use `node --trace-warnings/.test(line))
        .join("\n");
      resolvePromise({
        code: code ?? -1,
        stdout,
        stderr: cleanedStderr,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// tmpdir fixture
// ---------------------------------------------------------------------------

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pi-steering-cli-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// top-level
// ---------------------------------------------------------------------------

describe("pi-steering CLI: help + dispatch", () => {
  it("--help prints usage and exits 0", async () => {
    const r = await runCli("--help");
    assert.equal(r.code, 0);
    assert.match(r.stdout, /pi-steering — tools for/);
    assert.match(r.stdout, /import-json/);
    assert.match(r.stdout, /list \[--format=/);
    assert.equal(r.stderr.trim(), "");
  });

  it("-h prints usage and exits 0", async () => {
    const r = await runCli("-h");
    assert.equal(r.code, 0);
    assert.match(r.stdout, /USAGE/);
  });

  it("no args prints usage and exits 0", async () => {
    const r = await runCli();
    assert.equal(r.code, 0);
    assert.match(r.stdout, /USAGE/);
  });

  it("unknown subcommand writes to stderr and exits 1", async () => {
    const r = await runCli("bogus-sub");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown subcommand "bogus-sub"/);
    // Help still gets written to stdout for context.
    assert.match(r.stdout, /USAGE/);
  });
});

// ---------------------------------------------------------------------------
// import-json: argument parsing
// ---------------------------------------------------------------------------

describe("pi-steering import-json: argument parsing", () => {
  it("requires an input file", async () => {
    const r = await runCli("import-json");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /requires an input file/);
  });

  it("rejects unknown flags", async () => {
    const r = await runCli("import-json", "--nope");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown flag "--nope"/);
  });

  it("rejects -o without an argument", async () => {
    const r = await runCli("import-json", "input.json", "-o");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /-o requires an argument/);
  });

  it("rejects more than one positional argument", async () => {
    const r = await runCli("import-json", "a.json", "b.json");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /too many positional arguments/);
  });
});

// ---------------------------------------------------------------------------
// import-json: IO error paths
// ---------------------------------------------------------------------------

describe("pi-steering import-json: IO errors", () => {
  it("missing file -> stderr + exit 1", async () => {
    const r = await runCli("import-json", join(scratch, "nope.json"));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /cannot read /);
  });

  it("invalid JSON -> stderr + exit 1", async () => {
    const path = join(scratch, "bad.json");
    writeFileSync(path, "{ not json", "utf8");
    const r = await runCli("import-json", path);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not valid JSON/);
  });
});

// ---------------------------------------------------------------------------
// import-json: happy path
// ---------------------------------------------------------------------------

const VALID_V1 = {
  disable: ["no-force-push"],
  rules: [
    {
      name: "no-amend",
      tool: "bash",
      field: "command",
      pattern: "^git\\s+commit\\b.*--amend",
      reason: "Don't rewrite history.",
    },
  ],
};

describe("pi-steering import-json: conversion", () => {
  it("stdout mode: writes defineConfig output and exits 0", async () => {
    const path = join(scratch, "steering.json");
    writeFileSync(path, JSON.stringify(VALID_V1), "utf8");

    const r = await runCli("import-json", path);
    assert.equal(r.code, 0);
    assert.equal(r.stderr.trim(), "");
    assert.match(r.stdout, /import \{ defineConfig \} from "@cad0p\/pi-steering"/);
    assert.match(r.stdout, /export default defineConfig\(/);
    assert.match(r.stdout, /"no-amend"/);
    assert.match(r.stdout, /"Don't rewrite history\."/);
    // Preserve the disabled-rules list. Note the rename: v1 JSON's
    // `disable` key becomes v2 TS `disabledRules` on output.
    assert.match(r.stdout, /"disabledRules":\s*\[\s*"no-force-push"\s*\]/);
  });

  it("-o mode: writes file + reports path, exits 0", async () => {
    const inputPath = join(scratch, "steering.json");
    const outputPath = join(scratch, "steering.ts");
    writeFileSync(inputPath, JSON.stringify(VALID_V1), "utf8");

    const r = await runCli("import-json", inputPath, "-o", outputPath);
    assert.equal(r.code, 0);
    assert.match(r.stdout, new RegExp(`Wrote ${outputPath}`));
    assert.equal(r.stderr.trim(), "");

    const written = readFileSync(outputPath, "utf8");
    assert.match(written, /import \{ defineConfig \}/);
    assert.match(written, /"no-amend"/);
    // The generated file should be valid enough that a user can
    // drop it in and `tsc --noEmit` it. Sanity check: trailing
    // newline, no BOM.
    assert.ok(written.endsWith("\n"));
    assert.ok(!written.startsWith("\uFEFF"));
  });

  it("--output long form works the same as -o", async () => {
    const inputPath = join(scratch, "steering.json");
    const outputPath = join(scratch, "out.ts");
    writeFileSync(inputPath, JSON.stringify(VALID_V1), "utf8");

    const r = await runCli("import-json", inputPath, "--output", outputPath);
    assert.equal(r.code, 0);
    const written = readFileSync(outputPath, "utf8");
    assert.match(written, /defineConfig/);
  });

  it("FromJSONError propagates as exit 2 with path info", async () => {
    // `plugins` is a v2-only construct; `fromJSON` rejects it.
    const inputPath = join(scratch, "steering.json");
    writeFileSync(
      inputPath,
      JSON.stringify({ plugins: [{ name: "git" }] }),
      "utf8",
    );

    const r = await runCli("import-json", inputPath);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /conversion failed at <root>\.plugins/);
    assert.equal(r.stdout, "");
  });
});

// ---------------------------------------------------------------------------
// `list` subcommand
// ---------------------------------------------------------------------------

describe("pi-steering list", () => {
  it("prints 'no config' when no .pi/steering exists", async () => {
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(r.code, 0);
    assert.match(r.stdout, /No steering config found\./);
  });

  it("--format=json with no config returns empty structure", async () => {
    const r = await runCli({ cwd: scratch }, "list", "--format=json");
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout) as {
      plugins: unknown[];
      userRules: unknown[];
      disabled: { rules: unknown[] };
    };
    assert.deepEqual(parsed.plugins, []);
    assert.deepEqual(parsed.userRules, []);
    assert.deepEqual(parsed.disabled.rules, []);
  });

  it("text format groups plugin + user rules and lists disables", async () => {
    writeSteeringDirConfig(
      scratch,
      `export default {
				plugins: [
					{
						name: "git",
						rules: [
							{
								name: "no-main-commit",
								tool: "bash",
								field: "command",
								pattern: /^git\\s+commit/,
								when: { branch: /^main$/ },
								reason: "no",
							},
						],
					},
				],
				rules: [
					{
						name: "my-rule",
						tool: "bash",
						field: "command",
						pattern: /^echo/,
						reason: "no",
					},
				],
				disabledRules: ["some-disabled-rule"],
			};`,
    );
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Resolved config: 1 plugin, 2 rules, 0 observers\./);
    assert.match(r.stdout, /git\s+\[pi-steering\/plugins\/git\]/);
    assert.match(r.stdout, /no-main-commit\s+bash\s+when: branch/);
    assert.match(r.stdout, /User \(\.pi\/steering\/index\.ts\):/);
    assert.match(r.stdout, /my-rule\s+bash/);
    assert.match(r.stdout, /Disabled rules: some-disabled-rule/);
  });

  it("--format=json emits a parseable structure with all sections", async () => {
    writeSteeringDirConfig(
      scratch,
      `export default {
				plugins: [{ name: "git", rules: [] }],
				rules: [
					{
						name: "u1",
						tool: "bash",
						field: "command",
						pattern: /^ls/,
						reason: "no",
					},
				],
				observers: [
					{
						name: "obs1",
						writes: ["thing-happened"],
						onResult: () => {},
					},
				],
			};`,
    );
    const r = await runCli({ cwd: scratch }, "list", "--format=json");
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout) as {
      plugins: Array<{ name: string; source?: string; rules: unknown[] }>;
      userRules: Array<{ name: string; tool: string }>;
      userObservers: Array<{ name: string; writes: string[] }>;
      disabled: { rules: unknown[]; plugins: unknown[] };
    };
    assert.equal(parsed.plugins[0]?.name, "git");
    assert.equal(parsed.plugins[0]?.source, "pi-steering/plugins/git");
    assert.equal(parsed.userRules[0]?.name, "u1");
    assert.equal(parsed.userObservers[0]?.name, "obs1");
    assert.deepEqual(parsed.userObservers[0]?.writes, ["thing-happened"]);
  });

  it("rejects an unknown --format value", async () => {
    const r = await runCli({ cwd: scratch }, "list", "--format=yaml");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown --format value "yaml"/);
  });

  it("rejects unknown flags", async () => {
    const r = await runCli({ cwd: scratch }, "list", "--nope");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown flag "--nope"/);
  });

  it("list --help prints per-subcommand help", async () => {
    const r = await runCli({ cwd: scratch }, "list", "--help");
    assert.equal(r.code, 0);
    assert.match(r.stdout, /pi-steering list — show the resolved config/);
    assert.match(r.stdout, /--format=text\|json/);
  });

  it("summarizes happened: predicate with its event", async () => {
    writeSteeringDirConfig(
      scratch,
      `export default {
				rules: [
					{
						name: "rq",
						tool: "bash",
						field: "command",
						pattern: /^git push/,
						when: { happened: { event: "tests-passed", in: "agent_loop" } },
						reason: "no",
					},
				],
			};`,
    );
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(r.code, 0);
    assert.match(r.stdout, /when: happened:tests-passed/);
  });

  it("marks disabled rules with '(disabled)' suffix in text output (F4)", async () => {
    writeSteeringDirConfig(
      scratch,
      `export default {
				plugins: [
					{
						name: "git",
						rules: [
							{ name: "active-rule", tool: "bash", field: "command", pattern: /./, reason: "r" },
							{ name: "disabled-rule", tool: "bash", field: "command", pattern: /./, reason: "r" },
						],
					},
				],
				disabledRules: ["disabled-rule"],
			};`,
    );
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(r.code, 0);
    // Active rule: no suffix.
    assert.match(r.stdout, /active-rule\s+bash\s*$/m);
    // Disabled rule: (disabled) suffix.
    assert.match(r.stdout, /disabled-rule\s+bash\s+\(disabled\)/);
    // Footer unchanged.
    assert.match(r.stdout, /Disabled rules: disabled-rule/);
  });

  it("marks disabled plugins with '(disabled)' suffix on the header (F4)", async () => {
    writeSteeringDirConfig(
      scratch,
      `export default {
				plugins: [
					{
						name: "git",
						rules: [
							{ name: "some-rule", tool: "bash", field: "command", pattern: /./, reason: "r" },
						],
					},
				],
				disabledPlugins: ["git"],
			};`,
    );
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(r.code, 0);
    // Plugin header carries the (disabled) suffix.
    assert.match(
      r.stdout,
      /git\s+\[pi-steering\/plugins\/git\]\s+\(disabled\)/,
    );
    assert.match(r.stdout, /Disabled plugins: git/);
  });

  it("JSON output tags disabled rules and plugins with 'disabled: true' (F4)", async () => {
    writeSteeringDirConfig(
      scratch,
      `export default {
				plugins: [
					{
						name: "git",
						rules: [
							{ name: "active-rule", tool: "bash", field: "command", pattern: /./, reason: "r" },
							{ name: "disabled-rule", tool: "bash", field: "command", pattern: /./, reason: "r" },
						],
					},
					{ name: "also-disabled" },
				],
				disabledRules: ["disabled-rule"],
				disabledPlugins: ["also-disabled"],
			};`,
    );
    const r = await runCli({ cwd: scratch }, "list", "--format=json");
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout) as {
      plugins: Array<{
        name: string;
        disabled?: boolean;
        rules: Array<{ name: string; disabled?: boolean }>;
      }>;
    };
    const git = parsed.plugins.find((p) => p.name === "git");
    const also = parsed.plugins.find((p) => p.name === "also-disabled");
    assert.ok(git);
    assert.ok(also);
    assert.equal(
      git.disabled,
      undefined,
      "git plugin is active; no disabled flag",
    );
    assert.equal(
      also.disabled,
      true,
      "also-disabled plugin carries disabled: true",
    );
    const active = git.rules.find((r) => r.name === "active-rule");
    const disabled = git.rules.find((r) => r.name === "disabled-rule");
    assert.ok(active);
    assert.ok(disabled);
    assert.equal(active.disabled, undefined);
    assert.equal(disabled.disabled, true);
  });
});

// ---------------------------------------------------------------------------
// list: diagnostic surfacing on stderr
// ---------------------------------------------------------------------------

describe("pi-steering list: diagnostics on stderr", () => {
  it("writes a layer-stray-file diagnostic to stderr in the legacy single-line shape", async () => {
    const pi = join(scratch, ".pi", "steering");
    mkdirSync(pi, { recursive: true });
    writeFileSync(join(pi, "rules.json"), "{}", "utf8");
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(r.code, 0);
    // Diagnostic on stderr; stdout shows the empty-config render.
    assert.match(
      r.stderr,
      /\[pi-steering\] .*rules\.json: ignoring non-\.ts file under \.pi\/steering\//,
      `expected stray-file diagnostic on stderr; got: ${r.stderr}`,
    );
  });

  it("writes a layer-import-failed diagnostic to stderr when a layer fails to import", async () => {
    const pi = join(scratch, ".pi");
    mkdirSync(pi, { recursive: true });
    writeFileSync(
      join(pi, "steering.ts"),
      "export default { rules: {{ not valid ts }} };",
      "utf8",
    );
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(r.code, 0);
    assert.match(
      r.stderr,
      /\[pi-steering\] .*\.pi\/steering\.ts: failed to import:/,
      `expected layer-import-failed diagnostic on stderr; got: ${r.stderr}`,
    );
  });

  it("writes an error-class merge diagnostic to stderr with the [error] tag exactly once", async () => {
    writeSteeringDirConfig(
      scratch,
      `const t = { initial: "?", unknown: "unknown", modifiers: {}, subshellSemantics: "isolated" };
			export default {
				plugins: [
					{ name: "pa", trackers: { branch: t } },
					{ name: "pb", trackers: { branch: t } },
				],
			};`,
    );
    const r = await runCli({ cwd: scratch }, "list");
    // Error-class diagnostic → exit 1 so CI pipelines using
    // `pi-steering list` as a config-lint pre-flight gate the run
    // without parsing stderr.
    assert.equal(r.code, 1);
    assert.match(
      r.stderr,
      /\[pi-steering\] \[error\] tracker name collision/,
      `expected [error]-tagged tracker collision on stderr; got: ${r.stderr}`,
    );
    // The shared merge-pipeline helper short-circuits between
    // buildConfig and resolvePlugins on error-class merge
    // diagnostics, so the same collision should appear exactly once
    // even though both buildConfig and resolvePlugins independently
    // detect tracker-name collisions.
    const occurrences = r.stderr.match(/tracker name collision/g) ?? [];
    assert.equal(
      occurrences.length,
      1,
      `expected exactly one tracker-name-collision line on stderr; got ${occurrences.length}: ${r.stderr}`,
    );
  });

  it("surfaces BOTH a tracker-name-collision AND a malformed user-config rule name on stderr in one run", async () => {
    // Combined-error case: a config with both a merge-side error
    // (tracker-name-collision) AND a user-config-side error
    // (malformed rule name) should produce both diagnostics on
    // stderr in a single `pi-steering list` invocation. Before this change,
    // `runMergerPipeline`'s short-circuit gated
    // `validateUserConfigNames` behind the merge-error branch — the
    // CLI user fixed the tracker, re-ran, and only THEN saw the
    // malformed name. After this change, user-config name validation runs
    // unconditionally so both classes of error surface together,
    // matching the production runtime's aggregated throw.
    writeSteeringDirConfig(
      scratch,
      `const t = { initial: "?", unknown: "unknown", modifiers: {}, subshellSemantics: "isolated" };
			export default {
				plugins: [
					{ name: "pa", trackers: { branch: t } },
					{ name: "pb", trackers: { branch: t } },
				],
				rules: [
					{
						name: "phony] BAD",
						tool: "bash",
						field: "command",
						pattern: /^never$/,
						reason: "r",
					},
				],
			};`,
    );
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(
      r.code,
      1,
      `expected exit 1 on combined error stream; got: code=${r.code}, stderr=${r.stderr}`,
    );
    assert.match(
      r.stderr,
      /\[pi-steering\] \[error\] tracker name collision/,
      `expected [error]-tagged tracker-name-collision on stderr; got: ${r.stderr}`,
    );
    assert.match(
      r.stderr,
      /\[pi-steering\] \[error\] rule name "phony\] BAD" \(user config\).*disallowed/,
      `expected [error]-tagged invalid-name on stderr; got: ${r.stderr}`,
    );
  });

  it("writes an [error]-tagged reserved-tracker-name diagnostic from the plugin merger to stderr", async () => {
    // Reserved-name violations fire only at the plugin-merger surface;
    // without the merger pass in `runList`, a user running
    // `pi-steering list` on a config with a reserved tracker name
    // would see no error, then hit the same violation at extension factory time.
    writeSteeringDirConfig(
      scratch,
      `const t = { initial: "?", unknown: "unknown", modifiers: {}, subshellSemantics: "isolated" };
			export default {
				plugins: [
					{ name: "reserved-plugin", trackers: { events: t } },
				],
			};`,
    );
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(r.code, 1);
    assert.match(
      r.stderr,
      /\[pi-steering\] \[error\] tracker name "events" is reserved/,
      `expected reserved-tracker-name diagnostic on stderr; got: ${r.stderr}`,
    );
  });

  it("writes an [error]-tagged invalid-name diagnostic from the plugin merger to stderr", async () => {
    // Malformed plugin / rule / observer names flow through the
    // merger's diagnostic stream after the validateName refactor.
    writeSteeringDirConfig(
      scratch,
      `export default {
				plugins: [
					{
						name: "forge-plugin",
						rules: [
							{
								name: "bad name",
								tool: "bash",
								field: "command",
								pattern: /^never$/,
								reason: "r",
							},
						],
					},
				],
			};`,
    );
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(r.code, 1);
    assert.match(
      r.stderr,
      /\[pi-steering\] \[error\] rule name "bad name" \(plugin "forge-plugin"\).*disallowed/,
      `expected invalid-name diagnostic on stderr; got: ${r.stderr}`,
    );
  });

  it("a clean config produces no diagnostic lines on stderr and exits 0", async () => {
    writeSteeringDirConfig(
      scratch,
      `export default {
				rules: [
					{
						name: "clean-rule",
						tool: "bash",
						field: "command",
						pattern: /^never$/,
						reason: "r",
					},
				],
			};`,
    );
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(r.code, 0);
    const diagnosticLines = r.stderr
      .split("\n")
      .filter((line) => line.startsWith("[pi-steering]"));
    assert.equal(
      diagnosticLines.length,
      0,
      `expected zero diagnostic lines; got: ${JSON.stringify(diagnosticLines)}`,
    );
  });

  it("a warning-only diagnostic stream still exits 0 (warnings are fail-soft on the CLI)", async () => {
    // Warning-class diagnostics like `layer-stray-file` are advisory
    // — they don't prevent production from starting on this config.
    // CI pipelines treating exit 1 as "config rejected" should not
    // trip on warnings; the CLI only escalates exit code on error-
    // class diagnostics.
    const pi = join(scratch, ".pi", "steering");
    mkdirSync(pi, { recursive: true });
    writeFileSync(join(pi, "rules.json"), "{}", "utf8");
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(r.code, 0);
    assert.match(
      r.stderr,
      /ignoring non-\.ts file/,
      `expected stray-file diagnostic on stderr; got: ${r.stderr}`,
    );
  });

  it("flags a malformed user-config rule name with an invalid-name diagnostic and exits 1", async () => {
    // User-config rule names are validated only at extension factory time
    // (via the evaluator's build-time throw). Without this CLI pass,
    // `pi-steering list` would render the malformed rule as a valid
    // listing on stdout, then production would refuse to start —
    // authors using the CLI as pre-flight would get a false-green.
    writeSteeringDirConfig(
      scratch,
      `export default {
				rules: [
					{
						name: "phony] ALL CLEAR [real",
						tool: "bash",
						field: "command",
						pattern: /^never$/,
						reason: "r",
					},
				],
			};`,
    );
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(r.code, 1);
    assert.match(
      r.stderr,
      /\[pi-steering\] \[error\] rule name "phony\] ALL CLEAR \[real" \(user config\).*disallowed/,
      `expected user-config rule invalid-name diagnostic on stderr; got: ${r.stderr}`,
    );
  });

  it("flags a malformed user-config observer name with an invalid-name diagnostic and exits 1", async () => {
    // Same shape as the rule-name case but for observers — ensures
    // the CLI's pre-flight surface covers both halves of the
    // `validateUserConfigNames` helper.
    writeSteeringDirConfig(
      scratch,
      `export default {
				observers: [
					{ name: "evil] obs", onResult: () => {} },
				],
			};`,
    );
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(r.code, 1);
    assert.match(
      r.stderr,
      /\[pi-steering\] \[error\] observer name "evil\] obs" \(user config\).*disallowed/,
      `expected user-config observer invalid-name diagnostic on stderr; got: ${r.stderr}`,
    );
  });

  it("surfaces an `observer dropped` info-level breadcrumb on stderr when an observer's writes are unconsumed", async () => {
    // CLI mirrors `buildSessionRuntime`'s `dropUnusedObservers` pass
    // so `pi-steering list` surfaces the same breadcrumb a session
    // would, via the `console.info` interception in
    // `runCliMergeWithInfoCapture` (lands on stderr; stdout stays
    // clean for the structured listing).
    writeSteeringDirConfig(
      scratch,
      `export default {
				observers: [
					{
						name: "unread",
						writes: ["never_consumed"],
						onResult: () => {},
					},
				],
				rules: [
					{
						name: "r",
						tool: "bash",
						field: "command",
						pattern: /^never$/,
						reason: "r",
					},
				],
			};`,
    );
    const r = await runCli({ cwd: scratch }, "list");
    // Drop pass is informational, not error-class — exit 0.
    assert.equal(
      r.code,
      0,
      `expected exit 0 (info-level breadcrumb only); got code=${r.code}, stderr=${r.stderr}`,
    );
    assert.match(
      r.stderr,
      /\[pi-steering\] observer 'unread' dropped; its writes \(never_consumed\) are not consumed by any rule/,
      `expected observer-drop breadcrumb on stderr; got: ${r.stderr}`,
    );
  });

  it("surfaces an `observer dropped` breadcrumb when the consumer rule is disabled via `disabledRules` (parity with runtime)", async () => {
    // CLI must filter `merged.rules` against `disabledRules` before
    // `dropUnusedObservers` so the observer set the runtime would
    // drop at extension factory time matches what `pi-steering list`
    // reports.
    writeSteeringDirConfig(
      scratch,
      `export default {
				disabledRules: ["consumer"],
				observers: [
					{
						name: "obs-x",
						writes: ["X"],
						onResult: () => {},
					},
				],
				rules: [
					{
						name: "consumer",
						tool: "bash",
						field: "command",
						pattern: /^never$/,
						reason: "r",
						when: { happened: { event: "X" } },
					},
				],
			};`,
    );
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(
      r.code,
      0,
      `expected exit 0 (info-level breadcrumb only); got code=${r.code}, stderr=${r.stderr}`,
    );
    assert.match(
      r.stderr,
      /\[pi-steering\] observer 'obs-x' dropped; its writes \(X\) are not consumed by any rule/,
      `expected observer-drop breadcrumb on stderr (consumer rule was disabled, observer should be reported as dropped to match runtime); got: ${r.stderr}`,
    );
  });

  it("does NOT drop the observer when the consumer rule is enabled (inverse parity)", async () => {
    // Pins the inverse direction so a refactor that flips the
    // filter (`disabledRules.has(r.name)` ↔ `!disabledRules.has`)
    // surfaces here — the disabled-true case alone would not catch
    // it.
    writeSteeringDirConfig(
      scratch,
      `export default {
				observers: [
					{
						name: "obs-x",
						writes: ["X"],
						onResult: () => {},
					},
				],
				rules: [
					{
						name: "consumer",
						tool: "bash",
						field: "command",
						pattern: /^never$/,
						reason: "r",
						when: { happened: { event: "X" } },
					},
				],
			};`,
    );
    const r = await runCli({ cwd: scratch }, "list");
    assert.equal(
      r.code,
      0,
      `expected exit 0 (clean run); got code=${r.code}, stderr=${r.stderr}`,
    );
    assert.doesNotMatch(
      r.stderr,
      /\[pi-steering\] observer 'obs-x' dropped/,
      `expected NO observer-drop breadcrumb on stderr (consumer rule is enabled, observer is consumed); got: ${r.stderr}`,
    );
  });
});
