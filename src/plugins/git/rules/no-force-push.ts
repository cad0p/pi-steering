// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * `no-force-push` rule for the git plugin — the remote-history-rewrite
 * guard.
 *
 * Moved out of the engine's former default-rule bundle (issue #72): every
 * destructive-command rail now lives in the domain plugin that owns
 * its surface. The reason text is byte-identical to the 0.2.0 default,
 * including the issue #65 sealing (every remote-history-rewrite form
 * blocked). Override-comment eligible.
 */

import type { CLIFlag, PredicateContext, Rule } from "../../../schema.ts";

/**
 * Push force entries matched through the bound facade (issue #117).
 *
 * `--help`-pinned (`git push -h`): `--force`, `-f`, `--force-with-lease`,
 * `--force-if-includes`, `--mirror` are all real push flags. The
 * `--force` spelling does NOT cover `--force-with-lease` at the token
 * level (exact token / attached-`=` matching), so each rides its own
 * entry; the old regex's `\b` trick (matching every `--force-*`
 * suffix, including hypothetical `--force-bar`) is deliberately NOT
 * reproduced — unknown future spellings fail closed elsewhere, not
 * here. Bundled shorts (`-f`, `-uf`, `-fu`, `-nfv`) match through
 * `hasFlagOrBundle` (table-glue truncation included). Safe for push:
 * no other git-push short flag contains `f`.
 */
export const FORCE_PUSH_FLAG_ENTRIES = [
  { aliases: ["--force"], takesValue: false },
  { aliases: ["-f"], takesValue: false },
  { aliases: ["--force-with-lease"], takesValue: false },
  { aliases: ["--force-if-includes"], takesValue: false },
  { aliases: ["--mirror"], takesValue: false },
] as const satisfies readonly CLIFlag[];

/**
 * Leading-`+` refspec scan (`git push origin +main`, `+src:dst`).
 *
 * `+main` is not flag-shaped — it's a positional — so no `flag:`
 * entry can express it. Only LEADING-`+` forms are force markers: a
 * `+` mid-token (branch names like `c++-port`) has no leading `+`
 * and is not matched. A bare `"+"` alone is not a refspec either.
 */
function hasLeadingPlusRefspec(ctx: PredicateContext): boolean {
  const args = ctx.input.args;
  if (!Array.isArray(args)) return false;
  return args.some((w) => {
    const v = w?.value ?? "";
    return v.length > 1 && v[0] === "+" && v[1] !== ":";
  });
}

/**
 * `no-force-push` - block every remote-history-rewrite push form.
 */
export const noForcePush = {
  name: "no-force-push",
  tool: "bash",
  command: "git",
  // Routing is `command: "git"` (exact basename — `echo 'git push
  // --force'` has basename `echo` and never matches) + `subcommand:
  // "push"` (the descriptor's consuming-flag arity keeps `git -C
  // /path push`, `git -c key=val push`, `git --git-dir=/x push`
  // routed — the old pre-subcommand flag slot). The force signal is
  // flag-forms OR refspec-forms (leaves are AND-only, so the OR
  // lives in one inline `condition:` over the bound facade +
  // positional scan — the rule's single-binary one-off composition,
  // proven by the merge-gate pins in `./no-force-push.test.ts`).
  when: {
    subcommand: "push",
    condition: (ctx) =>
      ctx.command.hasFlagOrBundle(FORCE_PUSH_FLAG_ENTRIES) ||
      hasLeadingPlusRefspec(ctx),
  },
  reason:
    "Force pushes rewrite remote history and can destroy teammates' work. Create a new commit instead, or ask the user to run one manually.",
} as const satisfies Rule;
