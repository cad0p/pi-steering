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
//   node scripts/smoke.mjs                          # run against declared plugins only
//   node scripts/smoke.mjs /path/to/steering-dir    # + user rules from that dir's .pi/steering/
//                                                     (v2 TS config: <dir>/.pi/steering/index.ts)

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

async function fireSessionStart(mock, cwd) {
  const h = mock.handlers.session_start;
  if (!h) throw new Error("session_start handler not registered");
  // The runtime build now happens inside the session_start handler
  // (lazy design) — must await it before firing tool calls.
  await h({}, { cwd });
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
    label:
      "declared git plugin's no-force-push blocks `git push --force origin main`",
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
    label:
      "`git commit --amend` is allowed (commit-on-main pair disabled in the fixture config)",
    command: 'git commit --amend -m "x"',
    expect: "allow",
  },
  {
    label: "override comment unblocks no-force-push and audits the override",
    // Both the plugin's no-force-push and the user test-no-force-push
    // match this command. Overriding just no-force-push would advance
    // to test-no-force-push (which would still block — see the
    // multi-rule firing tests). For an isolated 'override accepted'
    // assertion we override both so the chain passes through cleanly
    // and we can observe the no-force-push audit entry.
    command:
      "git push --force origin main " +
      "# steering-override: no-force-push — smoke test " +
      "# steering-override: test-no-force-push — smoke test",
    expect: "allow+audit",
    expectRule: "no-force-push",
  },
  {
    label: "AST backend: `echo 'git push --force'` is NOT a false positive",
    command: "echo 'git push --force'",
    expect: "allow",
  },
  {
    label: "declared rm plugin's no-rm-rf-slash (noOverride) blocks `rm -rf /`",
    command: "rm -rf /",
    expect: "block",
    expectRule: "no-rm-rf-slash",
  },
  {
    label: "no-rm-rf-slash ignores override comment (noOverride)",
    command: "rm -rf / # steering-override: no-rm-rf-slash — nope",
    expect: "block",
    expectRule: "no-rm-rf-slash",
  },
  {
    label:
      "user-defined test-no-force-push fires first (user rules evaluate before plugin rules)",
    command: "git push --force origin main",
    expect: "block",
    // The evaluator composes [...userRules, ...pluginRules]: the user
    // rule lands BEFORE the git plugin's no-force-push, so
    // test-no-force-push wins on this command. Assert the user rule's
    // name so a hypothetical reorder fails loudly instead of passing
    // via the no-force-push substring inside the source tag.
    expectRule: "test-no-force-push",
    requiresUserRule: true,
  },
  {
    label:
      "user rule genuinely loads: overriding no-force-push alone still blocks via test-no-force-push",
    command:
      "git push --force origin main " +
      "# steering-override: no-force-push — smoke pin",
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
    // jiti never resolves the package at runtime. The PLUGIN imports are
    // real runtime imports: post-issue-72 there are no engine-injected
    // default rails, so the smoke config declares each shipping plugin
    // explicitly — via absolute dist paths, because a temp dir can't
    // resolve bare package names. The commit-on-main pair is disabled
    // because this harness has no pi.exec stub (the branch predicate
    // would fail-closed on every `git commit`).
    const distPlugin = (name) => {
      const entry = join(repoRoot, "dist", "plugins", name, "index.js");
      if (!existsSync(entry)) {
        throw new Error(
          `smoke harness: built plugin entry not found at ${entry} — run \`pnpm build\` first`,
        );
      }
      return entry;
    };
    const userRuleConfig = `import gitPlugin from ${JSON.stringify(distPlugin("git"))};
import rmPlugin from ${JSON.stringify(distPlugin("rm"))};
import asyncPlugin from ${JSON.stringify(distPlugin("async"))};

export default {
  // v2 override policy is fail-closed (defaultNoOverride defaults to
  // true) — the harness exercises the override path, so it opts in
  // explicitly, mirroring a real v2 config that uses overrides.
  defaultNoOverride: false,
  plugins: [gitPlugin, rmPlugin, asyncPlugin],
  disabledRules: ["no-main-commit", "no-main-commit-github"],
  rules: [
    {
      name: "test-no-force-push",
      tool: "bash",
      field: "command",
      pattern: "^git\\\\b.*push\\\\b.*--force",
      reason: "blocked by smoke-test rule",
    },
  ],
} satisfies import("@cad0p/pi-steering").SteeringConfig;`;

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

    const mock = makeMockPi();
    // register is sync and register-only (the runtime build is deferred
    // to session_start) — awaited for parity with pi's loader, harmless.
    await register(mock.api);
    // cwd flows via the fired ctx: the lazy session_start handler builds
    // the runtime from ctx.cwd (the session dir), so its project layer
    // resolves to the harness's rules dir.
    await fireSessionStart(mock, sessionDir);

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
    // The harness never chdirs anymore (no factory-time cwd capture), so
    // sessionDir can be removed in place.
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
