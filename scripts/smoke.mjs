#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Part of pi-steering.
//
// Isolated smoke test for the pi-steering extension.
//
// Loads the built extension entry via its published shape (dynamic import of
// the dist/index.js default export), mocks the pi ExtensionAPI surface the
// extension calls into, and drives it with synthetic `session_start` +
// `tool_call` events. Asserts block/allow + override-audit behavior for a
// fixed matrix of cases.
//
// Why this harness and not real pi + LLM? The LLM-driven smoke path hits
// provider-side safety refusals on adversarial commands like `rm -rf /` and
// `git push --force`, which makes it unreliable as a regression gate. The
// synthetic harness exercises the exact same extension code path (the
// `register()` entry that pi would call, the same tool_call event shape pi
// emits) without the non-determinism of the LLM layer.
//
// Usage:
//   pnpm -r build                                   # build the extension
//   node scripts/smoke.mjs                          # run against defaults only
//   node scripts/smoke.mjs /path/to/steering-dir    # + user rules from that dir's .pi/steering/
//                                                     (v2 TS config: <dir>/.pi/steering/index.ts)

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const repoRoot = resolve(import.meta.dirname, "..");
const distEntry = join(repoRoot, "dist/index.js");

/* -------------------------------------------------------------------------- */
/* Mock pi ExtensionAPI                                                       */
/* -------------------------------------------------------------------------- */

function makeMockPi() {
  const handlers = {};
  const entries = [];
  const api = {
    on(event, handler) {
      handlers[event] = handler;
    },
    appendEntry(kind, data) {
      entries.push({ kind, data });
    },
  };
  return { api, handlers, entries };
}

function fireSessionStart(mock, cwd) {
  const h = mock.handlers.session_start;
  if (!h) throw new Error("session_start handler not registered");
  h({}, { cwd });
}

async function fireBashToolCall(mock, command, cwd) {
  const h = mock.handlers.tool_call;
  if (!h) throw new Error("tool_call handler not registered");
  const event = {
    type: "tool_call",
    toolName: "bash",
    toolCallId: "call-1",
    input: { command },
  };
  // The handler forwards to evaluator.evaluate, which is async — await
  // its promise so the block verdict is settled before we assert.
  return h(event, { cwd });
}

/* -------------------------------------------------------------------------- */
/* Test matrix                                                                */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {{
 *   label: string,
 *   command: string,
 *   expect: "block" | "allow" | "allow+audit",
 *   expectRule?: string,     // required when expect="block" or "allow+audit"
 * }} SmokeCase
 */

/** @type {SmokeCase[]} */
const CASES = [
  {
    label: "default no-force-push blocks `git push --force origin main`",
    command: "git push --force origin main",
    expect: "block",
    expectRule: "no-force-push",
  },
  {
    label: "plain `git push origin main` is allowed",
    command: "git push origin main",
    expect: "allow",
  },
  {
    label: "`git commit --amend` is allowed (no-amend not in defaults)",
    command: 'git commit --amend -m "x"',
    expect: "allow",
  },
  {
    label: "override comment unblocks no-force-push and audits the override",
    // Both default no-force-push and user test-no-force-push match this
    // command. Overriding just no-force-push would advance to
    // test-no-force-push (which would still block — see the multi-rule
    // firing tests). For an isolated 'override accepted' assertion we
    // override both so the chain passes through cleanly and we can
    // observe the no-force-push audit entry.
    command:
      "git push --force origin main " +
      "# steering-override: no-force-push \u2014 smoke test " +
      "# steering-override: test-no-force-push \u2014 smoke test",
    expect: "allow+audit",
    expectRule: "no-force-push",
  },
  {
    label: "AST backend: `echo 'git push --force'` is NOT a false positive",
    command: "echo 'git push --force'",
    expect: "allow",
  },
  {
    label: "no-rm-rf-slash (noOverride) blocks `rm -rf /`",
    command: "rm -rf /",
    expect: "block",
    expectRule: "no-rm-rf-slash",
  },
  {
    label: "no-rm-rf-slash ignores override comment (noOverride)",
    command: "rm -rf / # steering-override: no-rm-rf-slash \u2014 nope",
    expect: "block",
    expectRule: "no-rm-rf-slash",
  },
  {
    label:
      "user-defined test-no-force-push fires first (v2 merges user rules before defaults)",
    command: "git push --force origin main",
    expect: "block",
    // v2 merges inner-first: defaults are pushed to the END of the
    // effective layer list, so the user rule lands BEFORE the
    // defaults and test-no-force-push wins over no-force-push. Assert
    // the user rule's name so a hypothetical reorder to
    // defaults-first fails loudly instead of passing via the
    // no-force-push substring inside the source tag.
    expectRule: "test-no-force-push",
    requiresUserRule: true,
  },
  {
    label:
      "user rule genuinely loads: overriding no-force-push alone still blocks via test-no-force-push",
    command:
      "git push --force origin main " +
      "# steering-override: no-force-push \u2014 smoke pin",
    expect: "block",
    expectRule: "test-no-force-push",
  },
];

/* -------------------------------------------------------------------------- */
/* Runner                                                                     */
/* -------------------------------------------------------------------------- */

async function main() {
  const userRulesDir = process.argv[2];
  let sessionDir;
  let cleanup = () => {};
  if (userRulesDir) {
    sessionDir = resolve(userRulesDir);
  } else {
    // Create an isolated session dir with a user rule so the requiresUserRule
    // case has something to load. Project-local config lives under `.pi/`,
    // matching pi's extension layout (same place as `.pi/extensions/`).
    // v2 form: a TS config at `.pi/steering/index.ts` (the v1
    // `.pi/steering.json` is CLI import-json migration-only and is NOT
    // loaded by the v2 loader — only `<slot>/index.ts` / `<slot>.ts`).
    sessionDir = mkdtempSync(join(tmpdir(), "pi-poc-smoke-"));
    mkdirSync(join(sessionDir, ".pi", "steering"), { recursive: true });
    // The `satisfies import(...)` is type-only (erased at transform), so
    // jiti never resolves the package at runtime.
    const userRuleConfig = `export default {
  // v2 override policy is fail-closed (defaultNoOverride defaults to
  // true) — the harness exercises the override path, so it opts in
  // explicitly, mirroring a real v2 config that uses overrides.
  defaultNoOverride: false,
  rules: [
    {
      name: "test-no-force-push",
      tool: "bash",
      field: "command",
      pattern: "^git\\\\b.*push\\\\b.*--force",
      reason: "blocked by smoke-test rule",
    },
  ],
} satisfies import("@cad0p/pi-steering").SteeringConfig;
`;
    writeFileSync(
      join(sessionDir, ".pi", "steering", "index.ts"),
      userRuleConfig,
    );
    cleanup = () => rmSync(sessionDir, { recursive: true, force: true });
  }

  // Isolate $HOME so no outer ~/.pi/agent/steering/ (global layer) leaks in.
  const tmpHome = mkdtempSync(join(tmpdir(), "pi-poc-smoke-home-"));
  mkdirSync(join(tmpHome, ".pi", "agent"), { recursive: true });
  const origHome = process.env.HOME;
  process.env.HOME = tmpHome;

  let passed = 0;
  let failed = 0;
  const failures = [];

  try {
    // Load the built extension.
    const mod = await import(distEntry);
    const register = mod.default;
    if (typeof register !== "function") {
      throw new Error(
        `expected default export to be a function, got ${typeof register}`,
      );
    }

    // The factory loads config at factory time from process.cwd() (the
    // eager-load design: buildSessionRuntime runs inside register, before
    // pi.on wiring). Point cwd at the session dir so the project layer
    // resolves to the harness's rules dir, mirroring how pi loads rules
    // from its launch cwd. distEntry is absolute, so the dynamic import
    // above is unaffected by the chdir.
    process.chdir(sessionDir);

    const mock = makeMockPi();
    // register is async (factory awaits buildSessionRuntime before
    // registering handlers) — must settle before firing session_start.
    await register(mock.api);
    fireSessionStart(mock, sessionDir);

    for (const c of CASES) {
      // Track entries added by this case specifically so we can assert
      // audit-log side effects without cross-contamination.
      const entriesBefore = mock.entries.length;
      const result = await fireBashToolCall(mock, c.command, sessionDir);
      const blocked = result && result.block === true;
      const newEntries = mock.entries.slice(entriesBefore);

      let ok = false;
      let detail = "";
      if (c.expect === "block") {
        if (!blocked) {
          detail = `expected block, got ${JSON.stringify(result)}`;
        } else if (
          c.expectRule &&
          !(result.reason ?? "").includes(c.expectRule)
        ) {
          detail = `block reason does not mention "${c.expectRule}": ${result.reason}`;
        } else {
          ok = true;
          detail = result.reason ?? "(no reason)";
        }
      } else if (c.expect === "allow") {
        if (blocked) {
          detail = `expected allow, got block: ${result?.reason}`;
        } else {
          ok = true;
          detail = "allowed";
        }
      } else if (c.expect === "allow+audit") {
        if (blocked) {
          detail = `expected allow+audit, got block: ${result?.reason}`;
        } else {
          const audit = newEntries.find(
            (e) =>
              e.kind === "steering-override" &&
              (!c.expectRule || e.data?.rule === c.expectRule),
          );
          if (!audit) {
            detail = `no steering-override audit entry for rule=${c.expectRule}. entries=${JSON.stringify(newEntries)}`;
          } else {
            ok = true;
            detail = `audited: ${audit.data.reason}`;
          }
        }
      } else {
        detail = `unknown expect: ${c.expect}`;
      }

      const sym = ok ? "\u2713" : "\u2717";
      const line = `${sym} ${c.label}`;
      console.log(`${line}\n    ${detail}`);
      if (ok) passed++;
      else {
        failed++;
        failures.push({ label: c.label, detail });
      }
    }
  } finally {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    // sessionDir is the process cwd at this point; POSIX tolerates
    // removing the cwd, Windows raises EPERM. Nothing after the finally
    // block depends on cwd, so step back first.
    process.chdir(repoRoot);
    cleanup();
    rmSync(tmpHome, { recursive: true, force: true });
  }

  console.log(`\n${passed}/${passed + failed} cases passed`);
  if (failed > 0) {
    console.error(`\nFailures:`);
    for (const f of failures) console.error(`  - ${f.label}\n    ${f.detail}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
