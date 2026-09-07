// SPDX-License-Identifier: MIT
// Part of the pi-steering work-item-plugin example.

/**
 * Shared harness pieces for the work-item-plugin suites.
 *
 * `featureBranchHost` keeps the git rails HONEST: instead of disabling
 * `no-main-commit*` (fail-closed on an unresolvable branch), harnesses
 * resolve `git branch --show-current` to a feature branch so the rails
 * pass through naturally — these suites pin work-item behavior AND its
 * coexistence with the real git plugin. Everything else execs loud
 * (exit 128): if example code ever shells out unexpectedly, tests scream
 * instead of silently passing on empty stdout.
 */

import type { Plugin } from "@cad0p/pi-steering";
import { createRecordingHost } from "@cad0p/pi-steering/testing";

// Minimal npm facts for harnesses driving `npm test` (issue #107:
// absent descriptors are loud); `{ npm: {} }` is explicit-strict,
// honest for the plain `npm test` invocations used here.
export const exampleNpmFacts = {
  name: "example-npm-facts",
  cliDescriptors: { npm: {} },
} as const satisfies Plugin;

/** Recording host with `git branch --show-current` pinned to a feature branch. */
export function featureBranchHost(branchName = "feat/x") {
  return createRecordingHost({
    exec: async (cmd, args) => {
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
      return {
        stdout: "",
        stderr: `unexpected exec in work-item harness: ${cmd} ${args.join(" ")}`,
        code: 128,
        killed: false,
      };
    },
  });
}
