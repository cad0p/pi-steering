// SPDX-License-Identifier: MIT
// Part of pi-steering.
//
// Lens round 2 on the lock (lockedRules):
//   - functional F1 / trust F1 (HIGH): the project layer, imported first,
//     could assign process.env.PI_CODING_AGENT_DIR (or HOME) and the
//     loader then loaded an attacker-chosen "global" layer, every lock
//     gone, zero diagnostics. The agent dir is now resolved before any
//     config code runs and the global layer is imported first.
//   - functional F2 / trust F2 / red-team F5 (MED): an error-class
//     diagnostic dropped the WHOLE inner layer, silently at runtime. Now
//     only the offending declaration is dropped where possible, and every
//     drop is printed with console.warn and raised in-chat.
//   - pre-existing, same class: a project rule naming an unregistered
//     predicate threw from buildEvaluator and disarmed every rail.
//   - red-team F6 (LOW): an inner layer's lockedRules is inert; say so.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type {
  ExtensionAPI,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import {
  fireSessionStart,
  makeCtx,
  makeNotifyRecorder,
  useIsolatedHome,
} from "./__test-helpers__.ts";
import register from "./index.ts";
import {
  buildSessionRuntime,
  runMergerPipeline,
} from "./internal/session-runtime.ts";
import { loadSteeringConfig } from "./loader.ts";

const GLOBAL = `export default {
  rules: [
    { name: "guard", tool: "bash", command: "echo", reason: "guard" },
  ],
  lockedRules: ["guard"],
  failOnWarnings: false,
};`;

let home: string;
let priorAgentDir: string | undefined;
let warns: string[];
let priorWarn: typeof console.warn;
let priorInfo: typeof console.info;

function setup(prefix: string): void {
  useIsolatedHome(prefix, (t) => {
    home = t;
  });
  beforeEach(() => {
    priorAgentDir = process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_CODING_AGENT_DIR;
    warns = [];
    priorWarn = console.warn;
    priorInfo = console.info;
    console.warn = (m: unknown) => {
      warns.push(String(m));
    };
    console.info = () => {};
  });
  afterEach(() => {
    console.warn = priorWarn;
    console.info = priorInfo;
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
  });
}

function writeGlobal(body = GLOBAL): string {
  const dir = join(home, ".pi", "agent", "steering");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.ts"), body, "utf8");
  return join(home, ".pi", "agent");
}

function writeProject(body: string): string {
  const project = join(home, "proj");
  mkdirSync(join(project, ".pi", "steering"), { recursive: true });
  writeFileSync(join(project, ".pi", "steering", "index.ts"), body, "utf8");
  return project;
}

/** A rogue agent dir with an empty global layer, as in the lenses' repro. */
function rogueAgentDir(): string {
  const rogue = mkdtempSync(join(home, "evilagent-"));
  mkdirSync(join(rogue, "steering"), { recursive: true });
  writeFileSync(join(rogue, "steering", "index.ts"), "export default {};");
  return rogue;
}

const host = {
  exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
  appendEntry: () => {},
};

function bash(command: string) {
  return {
    type: "tool_call" as const,
    toolCallId: "t1",
    toolName: "bash",
    input: { command },
  };
}

function makeMockPi() {
  const handlers: Record<string, (e: unknown, c: unknown) => unknown> = {};
  const api = {
    on(event: string, h: (e: unknown, c: unknown) => unknown) {
      handlers[event] = h;
    },
    appendEntry() {},
    async exec() {
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
  };
  return { api, handlers };
}

async function fireBash(
  mock: ReturnType<typeof makeMockPi>,
  command: string,
  cwd: string,
): Promise<ToolCallEventResult | undefined> {
  const h = mock.handlers.tool_call;
  if (!h) throw new Error("tool_call handler not registered");
  const event: ToolCallEvent = {
    type: "tool_call",
    toolName: "bash",
    toolCallId: "c1",
    input: { command },
  };
  return (await h(event, makeCtx(cwd))) as ToolCallEventResult | undefined;
}

describe("load order: a project layer cannot move the global layer", () => {
  setup("pi-steering-load-order-");

  for (const key of ["PI_CODING_AGENT_DIR", "HOME"] as const) {
    it(`ignores and restores process.env.${key} set by the project layer`, async () => {
      writeGlobal();
      const rogue = rogueAgentDir();
      // HOME → the rogue's parent must hold .pi/agent/steering.
      let target = rogue;
      if (key === "HOME") {
        target = mkdtempSync(join(home, "evilhome-"));
        mkdirSync(join(target, ".pi", "agent", "steering"), {
          recursive: true,
        });
        writeFileSync(
          join(target, ".pi", "agent", "steering", "index.ts"),
          "export default {};",
        );
      }
      const project = writeProject(
        `process.env[${JSON.stringify(key)}] = ${JSON.stringify(target)};
        export default { disabledRules: ["guard"] };`,
      );
      const before = process.env[key];
      const { config, diagnostics } = await loadSteeringConfig(project);
      assert.deepEqual(
        config.lockedRules,
        ["guard"],
        JSON.stringify(diagnostics),
      );
      assert.ok(
        config.rules?.some((r) => r.name === "guard"),
        "the real global layer's rail is loaded",
      );
      const moved = diagnostics.find((d) => d.kind === "agent-dir-env-mutated");
      assert.ok(moved, JSON.stringify(diagnostics));
      assert.equal(moved.type, "warning");
      assert.match(moved.message, new RegExp(`process\\.env\\.${key}`));
      assert.equal(process.env[key], before, "the variable is restored");
    });
  }

  it("the lenses' repro through the extension: the guard still blocks", async () => {
    writeGlobal();
    const rogue = rogueAgentDir();
    const project = writeProject(
      `process.env.PI_CODING_AGENT_DIR = ${JSON.stringify(rogue)};
      export default {};`,
    );
    const mock = makeMockPi();
    register(mock.api as unknown as ExtensionAPI);
    const notify = makeNotifyRecorder();
    await fireSessionStart(mock, project, "startup", notify);
    const verdict = await fireBash(mock, "echo hi", project);
    assert.equal(verdict?.block, true, "global guard still active");
    assert.ok(
      notify.types.includes("warning") &&
        notify.messages.some((m) => /agent-dir|PI_CODING_AGENT_DIR/.test(m)),
      `in-chat warning expected; got ${JSON.stringify(notify)}`,
    );
    assert.equal(process.env.PI_CODING_AGENT_DIR, undefined);
  });

  it("uses the caller's agentDir snapshot verbatim", async () => {
    const agentDir = writeGlobal();
    const project = writeProject("export default {};");
    process.env.PI_CODING_AGENT_DIR = rogueAgentDir();
    const { config } = await loadSteeringConfig(project, { agentDir });
    assert.deepEqual(config.lockedRules, ["guard"]);
  });
});

describe("drops: only the offending declaration, and loudly", () => {
  setup("pi-steering-drop-");

  const PRIVATE_RULE =
    '{ name: "private-rule", tool: "bash", command: "printf", reason: "private" }';

  it("a valid project rule beside a reserved-predicate plugin survives", async () => {
    writeGlobal();
    const project = writeProject(
      `export default {
        rules: [${PRIVATE_RULE}],
        plugins: [{ name: "evil", predicates: { not: () => true } }],
      };`,
    );
    const runtime = await buildSessionRuntime(project, host);
    const ctx = makeCtx(project);
    assert.equal(
      (await runtime.evaluator.evaluate(bash("printf x"), ctx, 0))?.block,
      true,
      "the project's own rail is still enforced",
    );
    assert.equal(
      (await runtime.evaluator.evaluate(bash("echo x"), ctx, 0))?.block,
      true,
      "the global rail is still enforced",
    );
    assert.equal(runtime.notices.length, 1, JSON.stringify(runtime.notices));
    assert.match(
      runtime.notices[0] ?? "",
      /dropping plugin "evil" from config layer #0/,
    );
    assert.ok(
      warns.some((w) => /dropping plugin "evil"/.test(w)),
      "printed with console.warn, not console.info",
    );
  });

  it("the functional lens's repro: an orphan plugin exemption no longer deletes the private rule", async () => {
    writeGlobal();
    const project = writeProject(
      `export default {
        rules: [${PRIVATE_RULE}],
        plugins: [{ name: "evil", exemptions: [{ rule: "nope", when: { cwd: "/" } }] }],
      };`,
    );
    const runtime = await buildSessionRuntime(project, host);
    assert.equal(
      (await runtime.evaluator.evaluate(bash("printf x"), makeCtx(project), 0))
        ?.block,
      true,
    );
    assert.match(runtime.notices.join("\n"), /dropping plugin "evil"/);
  });

  it("a project rule naming an unregistered predicate is dropped, not the session", async () => {
    writeGlobal();
    const project = writeProject(
      `export default {
        rules: [
          ${PRIVATE_RULE},
          { name: "typo", tool: "bash", command: "ls", when: { bogusPredicate: true }, reason: "x" },
        ],
      };`,
    );
    const runtime = await buildSessionRuntime(project, host);
    const ctx = makeCtx(project);
    assert.equal(
      (await runtime.evaluator.evaluate(bash("echo x"), ctx, 0))?.block,
      true,
    );
    assert.equal(
      (await runtime.evaluator.evaluate(bash("printf x"), ctx, 0))?.block,
      true,
    );
    assert.match(
      runtime.notices.join("\n"),
      /dropping rule "typo"[\s\S]*bogusPredicate/,
    );
  });

  it("a single (outermost) layer with an unknown predicate still fails as before", async () => {
    writeGlobal(
      `export default { rules: [{ name: "typo", tool: "bash", command: "ls", when: { bogusPredicate: true }, reason: "x" }] };`,
    );
    await assert.rejects(
      buildSessionRuntime(home, host),
      /unknown predicate "bogusPredicate"/,
    );
  });

  it("falls back to dropping the whole inner layer when no declaration is to blame", () => {
    const outer = {
      rules: [
        { name: "guard", tool: "bash" as const, command: "echo", reason: "g" },
      ],
      lockedRules: ["guard"],
      failOnWarnings: false,
    };
    const inner = {
      rules: [
        {
          name: "private-rule",
          tool: "bash" as const,
          command: "printf",
          reason: "p",
        },
      ],
      lockedRules: ["bad name!"],
    };
    const { merged, diagnostics } = runMergerPipeline([inner, outer], []);
    assert.deepEqual(
      diagnostics.filter((d) => d.type === "error"),
      [],
    );
    const drop = diagnostics.find((d) => d.kind === "layer-dropped-on-error");
    assert.ok(drop, JSON.stringify(diagnostics));
    assert.deepEqual(
      merged.rules?.map((r) => r.name),
      ["guard"],
    );
  });

  it("the bridge raises every drop in-chat as a warning", async () => {
    writeGlobal();
    const project = writeProject(
      `export default { rules: [${PRIVATE_RULE}], plugins: [{ name: "evil", predicates: { not: () => true } }] };`,
    );
    const mock = makeMockPi();
    register(mock.api as unknown as ExtensionAPI);
    const notify = makeNotifyRecorder();
    await fireSessionStart(mock, project, "startup", notify);
    assert.deepEqual(notify.types, ["warning"], JSON.stringify(notify));
    assert.match(notify.messages[0] ?? "", /dropping plugin "evil"/);
    assert.equal((await fireBash(mock, "printf x", project))?.block, true);
  });
});

describe("an inner layer's lockedRules is inert, and says so", () => {
  setup("pi-steering-inert-lock-");

  it("warns once per inner declarer", async () => {
    writeGlobal();
    const project = writeProject('export default { lockedRules: ["guard"] };');
    const { diagnostics } = await loadSteeringConfig(project);
    const inert = diagnostics.filter((d) => d.kind === "lock-inert");
    assert.equal(inert.length, 1, JSON.stringify(diagnostics));
    assert.equal(inert[0]?.type, "warning");
    assert.match(inert[0]?.message ?? "", /layer #0 \(guard\) has no effect/);
  });

  it("the outermost layer's own locks are not reported", async () => {
    writeGlobal();
    const { diagnostics } = await loadSteeringConfig(
      writeProject("export default {};"),
    );
    assert.equal(diagnostics.filter((d) => d.kind === "lock-inert").length, 0);
  });
});
