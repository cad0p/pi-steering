// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Tests for the git plugin's `no-main-commit-github` rule
 * (`./no-main-commit-github.ts`).
 *
 * These verify the rule definition itself - pattern shape, `when`
 * wiring, `noOverride` semantics, dynamic reason text - against the
 * evaluator pipeline. Each test constructs a minimal config with the
 * plugin loaded and runs a bash tool_call through `buildEvaluator`.
 *
 * End-to-end wiring (walker branch state driving predicate behavior,
 * plugin registration) is in `../integration.test.ts`; the generic
 * rule lives in `./no-main-commit.test.ts`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  BashToolCallEvent,
  ExecResult as PiExecResult,
} from "@earendil-works/pi-coding-agent";
import { makeCtx, makeTrackedHost } from "../../../__test-helpers__.ts";
import { buildEvaluator } from "../../../evaluator.ts";
import { resolvePlugins } from "../../../plugin-merger.ts";
import gitPlugin from "../index.ts";
import { noMainCommit } from "./no-main-commit.ts";
import { noMainCommitGithub } from "./no-main-commit-github.ts";
import { GIT_COMMIT_PATTERN, PROTECTED_BRANCH_PATTERN } from "./patterns.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function bashEvent(command: string): BashToolCallEvent {
  return {
    type: "tool_call",
    toolCallId: "t1",
    toolName: "bash",
    input: { command },
  };
}

/**
 * Build an evaluator that includes the git plugin with a stub `exec`
 * returning the given fake branch on `git branch --show-current` AND
 * the given fake origin URL on `git config --get remote.origin.url`
 * (when {@link remoteUrl} is non-null). Every other `git` call returns
 * exit 1 so predicates fall back to their `onUnknown` policy.
 *
 * Pass `remoteUrl: null` to simulate a repo with no `origin` remote
 * (the `git config --get remote.origin.url` call returns non-zero).
 */
function buildWithBranchAndRemote(
  branchName: string,
  remoteUrl: string | null,
) {
  const host = makeTrackedHost({
    exec: async (cmd, args): Promise<PiExecResult> => {
      if (
        cmd === "git" &&
        args[0] === "branch" &&
        args[1] === "--show-current"
      ) {
        return {
          stdout: `${branchName}\n`,
          stderr: "",
          code: 0,
          killed: false,
        };
      }
      if (
        cmd === "git" &&
        args[0] === "config" &&
        args[1] === "--get" &&
        args[2] === "remote.origin.url" &&
        remoteUrl !== null
      ) {
        return {
          stdout: `${remoteUrl}\n`,
          stderr: "",
          code: 0,
          killed: false,
        };
      }
      return { stdout: "", stderr: "", code: 1, killed: false };
    },
  });
  const resolved = resolvePlugins([gitPlugin], {});
  const evaluator = buildEvaluator({}, resolved, host);
  return { evaluator, host };
}

// ---------------------------------------------------------------------------
// no-main-commit-github
//
// Specialization of `no-main-commit` that emits PR-flow guidance on
// github.com clones. The shared `GIT_COMMIT_PATTERN` constant +
// first-match-wins ordering in the rule array are LOAD-BEARING — these
// tests pin the routing so a future maintainer reordering for stylistic
// reasons trips the suite rather than silently regressing the user-
// facing message. (The array-order pin itself lives in
// `./index.test.ts`.)
// ---------------------------------------------------------------------------

describe("rules: no-main-commit-github", () => {
  it("github clone + on main → fires github rule with PR-flow guidance + safety reminder", async () => {
    const { evaluator } = buildWithBranchAndRemote(
      "main",
      "https://github.com/cad0p/repo.git",
    );
    const res = await evaluator.evaluate(
      bashEvent("git commit -m 'x'"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(res && res.block === true);
    assert.match(
      res.reason!,
      /\[steering:no-main-commit-github@[^\]]+\]/,
      "github-flavored rule must fire (with the steering tag)",
    );
    assert.match(
      res.reason!,
      /github clone's protected branch/,
      "reason must include the github-specific anchor (protected-branch wording mirrors the four-name when: clause)",
    );
    assert.match(
      res.reason!,
      /Open a PR for review/,
      "reason must include the PR-flow guidance",
    );
    assert.match(
      res.reason!,
      /NEVER merge a PR or mark it ready-for-review/,
      "reason must include the safety reminder",
    );
    // Multi-paragraph render-shape pin: the steering tag renders
    // on its own line followed by a paragraph break, and the
    // safety reminder stays a separate paragraph from the PR-flow
    // body. Pins both the engine's paragraph-aware tag separator
    // (in formatReason) AND this rule's `\n\n` body separator at
    // one site. Counterfactual: a regression in either (e.g.,
    // engine refactor that strips trailing/leading whitespace, or
    // a future cleanup that changes `\n\n` → `\n` in the rule's
    // reason text) would silently degrade rendering — the .match
    // checks above don't catch newline drift.
    assert.match(
      res.reason!,
      /^\[steering:no-main-commit-github@[^\]]+\]\n\nYou're on a github clone's protected branch/,
      "tag must render on its own line followed by paragraph break",
    );
    assert.match(
      res.reason!,
      /\n\nSafety: NEVER merge a PR/,
      "safety reminder must remain a separate paragraph from the PR-flow body",
    );
  });

  it("non-github remote + on main → falls through to generic no-main-commit", async () => {
    const { evaluator } = buildWithBranchAndRemote(
      "main",
      "git@self-hosted.example.com:Foo/Bar.git",
    );
    const res = await evaluator.evaluate(
      bashEvent("git commit -m 'x'"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(res && res.block === true);
    assert.match(
      res.reason!,
      /\[steering:no-main-commit@[^\]]+\]/,
      "generic no-main-commit must fire on non-github remotes",
    );
    assert.doesNotMatch(
      res.reason!,
      /no-main-commit-github@/,
      "github-flavored rule must NOT fire on non-github remotes",
    );
    assert.doesNotMatch(
      res.reason!,
      /github clone's protected branch/,
      "reason must not claim github-specific context on non-github remotes",
    );
  });

  it("no origin configured + on main → falls through to generic no-main-commit", async () => {
    // Pins the `onUnknown: "allow"` posture on the github rule's
    // `remote:` predicate. With the default `onUnknown: "block"`, the
    // github rule would fire fail-closed on a repo with no origin
    // configured — emitting github-flavored PR-flow guidance and
    // claiming a github clone the engine couldn't actually verify.
    // `onUnknown: "allow"` makes the github rule cleanly skip on
    // no-origin so the generic `noMainCommit` (which has no
    // `remote:` clause) fires instead, with branch-only context the
    // engine can confirm.
    const { evaluator } = buildWithBranchAndRemote("main", null);
    const res = await evaluator.evaluate(
      bashEvent("git commit -m 'x'"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(res && res.block === true);
    assert.match(
      res.reason!,
      /\[steering:no-main-commit@[^\]]+\]/,
      "generic no-main-commit must fire on no-origin repos",
    );
    assert.doesNotMatch(
      res.reason!,
      /no-main-commit-github@/,
      "github-flavored rule must NOT fire on no-origin repos",
    );
    assert.doesNotMatch(
      res.reason!,
      /github clone's protected branch/,
      "reason must not claim github-specific context on no-origin repos",
    );
  });

  it("github clone + on feature branch → does not fire", async () => {
    const { evaluator } = buildWithBranchAndRemote(
      "feat-x",
      "https://github.com/cad0p/repo.git",
    );
    const res = await evaluator.evaluate(
      bashEvent("git commit -m 'x'"),
      makeCtx("/repo"),
      0,
    );
    assert.equal(res, undefined);
  });

  it("non-commit verb (`git push`) on main → does not fire (pattern doesn't match)", async () => {
    const { evaluator } = buildWithBranchAndRemote(
      "main",
      "https://github.com/cad0p/repo.git",
    );
    const res = await evaluator.evaluate(
      bashEvent("git push origin main"),
      makeCtx("/repo"),
      0,
    );
    assert.equal(
      res,
      undefined,
      "shared GIT_COMMIT_PATTERN constant must only match `git commit` (not `git push`)",
    );
  });

  it("vault path + on main + github remote → fires github rule (gitPlugin has no built-in vault knowledge)", async () => {
    // Counterfactual rationale: a future refactor that adds a
    // cwd-based vault exemption to the rule (e.g.,
    // `not: { cwd: VAULT_DIRS }` baked into the default `when:`)
    // would silently change this behavior — vault paths would skip
    // the rule. The README's Customization section is built on
    // the contract that vault exemption is downstream-consumer
    // responsibility, NOT a built-in default; this test pins that
    // contract.
    const { evaluator } = buildWithBranchAndRemote(
      "main",
      "https://github.com/user/Goldmine.git",
    );
    const res = await evaluator.evaluate(
      bashEvent("git commit -m 'note'"),
      makeCtx("/home/user/Goldmine/notes"),
      0,
    );
    assert.ok(
      res && res.block === true,
      "vault path must NOT bypass the rule — gitPlugin doesn't ship vault awareness",
    );
    assert.match(
      res.reason!,
      /\[steering:no-main-commit-github@[^\]]+\]/,
      "vault paths still get the github-flavored message; vault exemption is a downstream-consumer override",
    );
  });

  it("SSH-form github URL (`git@github.com:...`) → fires github rule", async () => {
    // The `remote:` regex `/github\.com[/:]/` accepts both the
    // HTTPS path separator (`github.com/`) and the SSH user-host
    // separator (`github.com:`). Pins the broader character class
    // against an accidental narrowing back to `/github\.com\//`.
    const { evaluator } = buildWithBranchAndRemote(
      "main",
      "git@github.com:cad0p/repo.git",
    );
    const res = await evaluator.evaluate(
      bashEvent("git commit -m 'x'"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(res && res.block === true);
    assert.match(
      res.reason!,
      /\[steering:no-main-commit-github@[^\]]+\]/,
      "SSH-form github URL must route to the github-flavored message",
    );
  });

  it("overridable via `# steering-override: no-main-commit-github` comment", async () => {
    // Mirrors the override-comment test on the generic rule. The
    // rule's `noOverride: false` field is set explicitly with a
    // JSDoc rationale ("workflow rules are intentionally
    // overridable") — this test exercises the engine's actual
    // override-comment path on the github specialization, rather
    // than relying on the rule-shape `assert.equal(noOverride,
    // false)` pin alone. A future refactor that drops the field
    // or flips the schema default would surface here as a failed
    // override + a missing audit entry.
    //
    // Both `no-main-commit-github` and the generic
    // `no-main-commit` fire on a github clone + main. Stacked
    // override comments suppress both — the engine accepts
    // multiple override markers on a single command (see
    // `extractOverride`'s JSDoc on stacked overrides). The audit
    // entry assertion specifically targets the github rule to pin
    // the github-side override path was exercised.
    const { evaluator, host } = buildWithBranchAndRemote(
      "main",
      "https://github.com/cad0p/repo.git",
    );
    const res = await evaluator.evaluate(
      bashEvent(
        "git commit -m 'release' " +
          "# steering-override: no-main-commit-github - release process " +
          "# steering-override: no-main-commit - release process",
      ),
      makeCtx("/repo"),
      0,
    );
    assert.equal(res, undefined);
    assert.ok(
      host.appended.some(
        (e) =>
          e.type === "steering-override" &&
          (e.data as { rule?: string } | undefined)?.rule ===
            "no-main-commit-github",
      ),
      "expected a steering-override audit entry for no-main-commit-github (proves the github rule's override path was exercised)",
    );
  });

  it("`git checkout $VAR && git commit` on github clone → walker-unknown branch routes to the bespoke 'could not verify' message", async () => {
    // Pins the walker-unknown-branch early-return in the reason fn.
    // Walker-unknown CWD takes a different path: `remote:` opts into
    // `onUnknown: "allow"` and projects unknown→false BEFORE this
    // reason fn runs (the rule skips, deferring to the generic
    // noMainCommit). This test scopes to walker-unknown BRANCH (not
    // cwd): github remote stubbed + dynamic checkout target in the
    // chain so the branch tracker collapses to its `"unknown"`
    // sentinel under known cwd. The branch predicate's default
    // `onUnknown: "block"` fires fail-closed; the reason fn detects
    // `branchRes.kind === "unknown"` and emits the bespoke "could not
    // verify the current branch" message rather than falling through
    // to a positive claim about the protected branch.
    //
    // Counterfactual rationale: without the walker-unknown-branch
    // sibling early-return, the reason fn falls through to the
    // known-branch body ("You're on a github clone's protected
    // branch"). The walkerString-driven dynamic clause
    // ` You are on '${branch}'.` correctly omits itself when
    // `branchRes.kind === "unknown"` (the ternary at
    // `no-main-commit-github.ts` returns undefined → `onClause = ""`),
    // so the `"unknown"` sentinel cannot leak — but the static body
    // still claims github-flavored protected-branch context the
    // engine hasn't verified. The agent then sees github-specific
    // PR-flow guidance for a context the rule didn't actually verify.
    const { evaluator } = buildWithBranchAndRemote(
      "feature",
      "https://github.com/cad0p/repo.git",
    );
    const res = await evaluator.evaluate(
      bashEvent("git checkout $VAR && git commit -m 'x'"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(res && res.block === true);
    assert.match(
      res.reason!,
      /\[steering:no-main-commit-github@[^\]]+\]/,
      "github-flavored rule must fire on dynamic-checkout chain",
    );
    assert.match(
      res.reason!,
      /Could not verify the current branch/,
      "reason must use the bespoke walker-unknown-branch message",
    );
    assert.doesNotMatch(
      res.reason!,
      /You're on a github clone's protected branch/,
      "reason must NOT make an unverified positive claim about the protected branch",
    );
    assert.doesNotMatch(
      res.reason!,
      /You are on '/,
      "reason must not include the dynamic branch-name clause when walker state is 'unknown'",
    );
    assert.doesNotMatch(
      res.reason!,
      /'unknown'/,
      "reason must not leak the walker `unknown` sentinel into the agent-facing message",
    );
    // Cross-phase: paragraph-aware separator preserves the safety
    // reminder as its own paragraph on the walker-unknown-branch
    // body too.
    assert.match(
      res.reason!,
      /\n\nSafety: NEVER merge a PR/,
      "safety reminder must remain a separate paragraph on the walker-unknown-branch body",
    );
  });

  it("`git checkout main && git commit` on github clone → reason injects 'You are on main'", async () => {
    // Mirror of `noMainCommit`'s dynamic-clause pin for the github
    // specialization: when the branch tracker has resolved a
    // concrete protected-branch name from an in-chain checkout, the
    // reason fn injects the name into the body. Pins the
    // `walkerString`-driven interpolation against a regression that
    // hardcodes "main".
    const { evaluator } = buildWithBranchAndRemote(
      "feature",
      "https://github.com/cad0p/repo.git",
    );
    const res = await evaluator.evaluate(
      bashEvent("git checkout main && git commit -m 'x'"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(res && res.block === true);
    assert.match(res.reason!, /\[steering:no-main-commit-github@[^\]]+\]/);
    assert.match(
      res.reason!,
      /You are on 'main'/,
      "reason must include the walker-resolved branch name",
    );
  });

  it("`git checkout master && git commit` on github clone → injects the concrete protected branch name", async () => {
    // Sibling pin to the `main` test: master / mainline / trunk all
    // flow through the same tracker-driven interpolation. Catches a
    // regression that hardcodes a single protected-branch literal
    // instead of reading from `walkerString`.
    const { evaluator } = buildWithBranchAndRemote(
      "feature",
      "https://github.com/cad0p/repo.git",
    );
    const res = await evaluator.evaluate(
      bashEvent("git checkout master && git commit -m 'x'"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(res && res.block === true);
    assert.match(res.reason!, /You are on 'master'/);
  });

  it("`git checkout trunk && git commit` on github clone → injects 'trunk' (interpolation is tracker-driven)", async () => {
    // Pin the third protected-branch alias to seal the
    // tracker-driven contract: the injected name comes from
    // `walkerString`, not a hardcoded set of `main` / `master`.
    const { evaluator } = buildWithBranchAndRemote(
      "feature",
      "https://github.com/cad0p/repo.git",
    );
    const res = await evaluator.evaluate(
      bashEvent("git checkout trunk && git commit -m 'x'"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(res && res.block === true);
    assert.match(res.reason!, /You are on 'trunk'/);
  });

  it("no in-chain checkout on github clone → reason omits the dynamic branch clause", async () => {
    // Exec reports `main` via `git branch --show-current`, so the
    // rule fires — but the BRANCH TRACKER didn't see an in-chain
    // checkout, so `walkerString` returns the
    // `NO_CHECKOUT_IN_CHAIN` sentinel (not a real branch name).
    // The reason fn must NOT leak the sentinel into the body and
    // must omit the dynamic clause; the static github-flavored
    // guidance still fires.
    const { evaluator } = buildWithBranchAndRemote(
      "main",
      "https://github.com/cad0p/repo.git",
    );
    const res = await evaluator.evaluate(
      bashEvent("git commit -m 'x'"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(res && res.block === true);
    assert.match(res.reason!, /\[steering:no-main-commit-github@[^\]]+\]/);
    assert.match(res.reason!, /You're on a github clone's protected branch/);
    assert.doesNotMatch(
      res.reason!,
      /You are on '/,
      "reason must not include the dynamic clause when no in-chain checkout was tracked",
    );
  });

  it("rule-shape pin: `noOverride: false` + `when:` includes both branch + remote", () => {
    const rule = gitPlugin.rules?.find(
      (r) => r.name === "no-main-commit-github",
    );
    assert.ok(rule);
    assert.equal(rule.tool, "bash");
    assert.equal(rule.field, "command");
    assert.equal(
      rule.noOverride,
      false,
      "workflow rule must stay overridable via `# steering-override:` comment",
    );
    assert.ok(
      rule.when !== undefined &&
        "branch" in (rule.when as Record<string, unknown>) &&
        "remote" in (rule.when as Record<string, unknown>),
      "when: must include both branch + remote (specialization shape)",
    );
  });

  it("`disabledRules: ['no-main-commit-github']` only + github clone → generic fires (clean fall-through)", async () => {
    // Pins the canonical "swap to generic message" customization:
    // disable just the github specialization, generic stays
    // active, user gets the generic feature-branch reminder
    // instead of PR-flow guidance. This is the user-facing
    // behavior README's Customization section advertises for the
    // disable-only path — pinned so a regression in the
    // disabledRules filter (e.g., name-prefix-matching that
    // accidentally disables both rules) surfaces here as a
    // missing block.
    const host = makeTrackedHost({
      exec: async (cmd, args): Promise<PiExecResult> => {
        if (
          cmd === "git" &&
          args[0] === "branch" &&
          args[1] === "--show-current"
        ) {
          return {
            stdout: "main\n",
            stderr: "",
            code: 0,
            killed: false,
          };
        }
        if (
          cmd === "git" &&
          args[0] === "config" &&
          args[1] === "--get" &&
          args[2] === "remote.origin.url"
        ) {
          return {
            stdout: "https://github.com/cad0p/repo.git\n",
            stderr: "",
            code: 0,
            killed: false,
          };
        }
        return { stdout: "", stderr: "", code: 1, killed: false };
      },
    });
    const resolved = resolvePlugins([gitPlugin], {
      disabledRules: ["no-main-commit-github"],
    });
    const evaluator = buildEvaluator({}, resolved, host);
    const res = await evaluator.evaluate(
      bashEvent("git commit -m 'x'"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(
      res && res.block === true,
      "generic rule must still fire on protected branch when only the github rule is disabled",
    );
    assert.match(
      res.reason!,
      /\[steering:no-main-commit@[^\]]+\]/,
      "generic no-main-commit fires on github clones too (its when: is just branch-based)",
    );
    assert.doesNotMatch(
      res.reason!,
      /no-main-commit-github@/,
      "github-flavored rule must NOT fire when listed in disabledRules",
    );
  });

  it("`disabledRules: ['no-main-commit-github']` only + non-github → generic fires (disable doesn't affect generic routing)", async () => {
    // Sibling pin to the above: disabling the github rule must
    // not affect the generic rule's routing on non-github
    // remotes. A regression where `disabledRules` accidentally
    // name-prefix-matched (`startsWith` instead of equality)
    // would disable both rules here and surface as `res ===
    // undefined`.
    const host = makeTrackedHost({
      exec: async (cmd, args): Promise<PiExecResult> => {
        if (
          cmd === "git" &&
          args[0] === "branch" &&
          args[1] === "--show-current"
        ) {
          return {
            stdout: "main\n",
            stderr: "",
            code: 0,
            killed: false,
          };
        }
        return { stdout: "", stderr: "", code: 1, killed: false };
      },
    });
    const resolved = resolvePlugins([gitPlugin], {
      disabledRules: ["no-main-commit-github"],
    });
    const evaluator = buildEvaluator({}, resolved, host);
    const res = await evaluator.evaluate(
      bashEvent("git commit -m 'x'"),
      makeCtx("/repo"),
      0,
    );
    assert.ok(
      res && res.block === true,
      "generic rule fires on non-github too — disable name-equality must scope cleanly",
    );
    assert.match(res.reason!, /\[steering:no-main-commit@[^\]]+\]/);
  });

  it("`disabledRules: ['no-main-commit-github', 'no-main-commit']` → no commit-on-main rule fires", async () => {
    // Sanity-check pin for the both-disabled case. With both
    // rules disabled, the engine has no commit-on-main guard at
    // all → block does not surface. Useful as a regression seal
    // against an accidental third commit-on-main rule being
    // added without being listed here.
    const host = makeTrackedHost({
      exec: async (cmd, args): Promise<PiExecResult> => {
        if (
          cmd === "git" &&
          args[0] === "branch" &&
          args[1] === "--show-current"
        ) {
          return {
            stdout: "main\n",
            stderr: "",
            code: 0,
            killed: false,
          };
        }
        if (
          cmd === "git" &&
          args[0] === "config" &&
          args[1] === "--get" &&
          args[2] === "remote.origin.url"
        ) {
          return {
            stdout: "https://github.com/cad0p/repo.git\n",
            stderr: "",
            code: 0,
            killed: false,
          };
        }
        return { stdout: "", stderr: "", code: 1, killed: false };
      },
    });
    const resolved = resolvePlugins([gitPlugin], {
      disabledRules: ["no-main-commit-github", "no-main-commit"],
    });
    const evaluator = buildEvaluator({}, resolved, host);
    const res = await evaluator.evaluate(
      bashEvent("git commit -m 'x'"),
      makeCtx("/repo"),
      0,
    );
    assert.equal(
      res,
      undefined,
      "both rules disabled: no commit-on-main rule should fire",
    );
  });

  it("both rules' pattern fields equal the exported GIT_COMMIT_PATTERN constant", () => {
    // Value-equality pin against the exported constant. The pattern
    // is a string primitive, so this is byte-equality, NOT shared-
    // reference identity — a future maintainer who inlines the
    // literal at one rule's definition site with the SAME bytes
    // would not trip this assertion. What it DOES catch:
    //   - Either rule's pattern accidentally diverging from the
    //     exported constant (e.g. one drops `\b`, one anchors
    //     differently).
    //   - The constant itself getting renamed away or removed.
    // True shared-reference factoring would need a `RegExp` (object)
    // constant; today's design uses a string source so the regex-
    // compile cache in the engine can dedupe across both rules
    // without per-rule allocation.
    assert.equal(
      noMainCommit.pattern,
      GIT_COMMIT_PATTERN,
      "noMainCommit.pattern must equal the exported GIT_COMMIT_PATTERN constant",
    );
    assert.equal(
      noMainCommitGithub.pattern,
      GIT_COMMIT_PATTERN,
      "noMainCommitGithub.pattern must equal the exported GIT_COMMIT_PATTERN constant",
    );
  });

  it("both rules' branch fields share-reference the exported PROTECTED_BRANCH_PATTERN constant", () => {
    // Shared-reference pin (`===` on the RegExp object), STRICTLY
    // stronger than the byte-equality pin above for `pattern`. The
    // protected-branch list is a `RegExp` (object) constant rather
    // than a string source, so identity comparison is meaningful:
    // any future maintainer who inlines `/^(main|master|mainline|trunk)$/`
    // at a rule's definition site — even with byte-identical contents
    // — trips this assertion because the inlined literal compiles to
    // a fresh `RegExp` instance. That catches the failure mode the
    // `GIT_COMMIT_PATTERN` value-equality pin cannot: silent
    // re-inlining that re-introduces the duplication this constant
    // was extracted to eliminate.
    //
    // Without the shared constant, the protected-branch list could
    // drift between the two rules (one rule adds a vendor-specific
    // default-branch alias, the other doesn't); pinning shared-
    // reference forces both rules to pick up the alias from a single
    // edit site.
    assert.strictEqual(
      noMainCommit.when.branch,
      PROTECTED_BRANCH_PATTERN,
      "noMainCommit.when.branch must reference the exported PROTECTED_BRANCH_PATTERN constant",
    );
    // `noMainCommitGithub.when` is the object form (with `remote:`);
    // the `branch:` field still points directly at the regex.
    assert.strictEqual(
      noMainCommitGithub.when.branch,
      PROTECTED_BRANCH_PATTERN,
      "noMainCommitGithub.when.branch must reference the exported PROTECTED_BRANCH_PATTERN constant",
    );
  });
});

// The first-match-wins array-order pin (formerly the last it in this
// describe) lives in `./index.test.ts` — it pins the plugin's `rules`
// array, not the github rule itself.
