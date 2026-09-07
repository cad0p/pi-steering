// SPDX-License-Identifier: MIT
// Part of pi-steering.
//
// DRAFT gh descriptor for pi-steering-github#61 (they own gh facts).
// NOT imported by core (core tests keep synthetic gh descriptors;
// never seed gh facts in core — #107 §8 harness rule stands).
// Contributed to pi-steering-github#61; lands BEFORE the #111 CI example
// (it is its first adopter). OUT of this repo's runtime (note only,
// do not implement cross-repo).

// source: @withfig/autocomplete@2.692.3 src/gh.ts, retrieved 2026-09-07,
// reviewed vs `gh --help` (gh version 2.96.0) on 2026-09-07.
// Per-entry takesValue reviewed against --help arity text; Fig `args` presence
// was the draft signal, --help was the verdict.
//
// Review trace:
// - `-R/--repo [HOST/]OWNER/REPO`: Fig args + `gh pr --help` arity agree → takesValue:true.
// - `--help`, `--version`: Fig no-args + `gh --help` FLAGS agree → takesValue:false.
// - Per-command flags (e.g. `-e/--env`, `-o/--org`, `-y/--confirm`) out of scope
//   for the globals draft; owning repo expands per-command tables.

import type { CLIDescriptor } from "./src/schema.ts";

/**
 * DRAFT gh globals descriptor (for pi-steering-github#61, not core).
 */
export const GH_CLI_DESCRIPTOR_DRAFT = {
  positionPolicy: "globals-anywhere",
  flags: {
    repo: { aliases: ["-R", "--repo"], takesValue: true },
    help: { aliases: ["--help"], takesValue: false },
    version: { aliases: ["--version"], takesValue: false },
  },
} as const satisfies CLIDescriptor;
