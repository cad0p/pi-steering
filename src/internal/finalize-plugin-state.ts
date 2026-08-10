// SPDX-License-Identifier: MIT
// Part of pi-steering.

/**
 * Late-stage plugin-state finalization shared by `buildSessionRuntime`,
 * `loadHarness`, and the CLI `list` path. Centralizes the
 * `dropUnusedObservers` + breadcrumb pass so all three stay byte-equal
 * in their breadcrumb output and observer-drop semantics.
 *
 * Drops observers whose declared `writes` are unconsumed across both
 * plugin-merged and user-authored streams, using the union of all
 * rule `happened` references. Emits an `info`-level breadcrumb per
 * dropped observer so plugin authors debugging "why isn't my
 * observer firing?" have a trail to follow without it bubbling up as
 * a diagnostic the user has to action.
 *
 * Callers must pre-filter `config.disabledRules` out of `userRules`
 * — see {@link dropUnusedObservers}'s contract.
 */

import type { Observer, Rule } from "../schema.ts";
import { dropUnusedObservers } from "./drop-unused-observers.ts";

export function finalizePluginState(
  userRules: readonly Rule[],
  pluginRules: readonly Rule[],
  userObservers: readonly Observer[],
  pluginObservers: readonly Observer[],
): {
  pluginKept: readonly Observer[];
  userKept: readonly Observer[];
} {
  const allRules = [...userRules, ...pluginRules];
  const pluginDrop = dropUnusedObservers(pluginObservers, allRules);
  const userDrop = dropUnusedObservers(userObservers, allRules);
  for (const d of [...pluginDrop.dropped, ...userDrop.dropped]) {
    console.info(
      `[pi-steering] observer '${d.name}' dropped; its writes ` +
        `(${d.writes.join(", ")}) are not consumed by any rule`,
    );
  }
  return { pluginKept: pluginDrop.kept, userKept: userDrop.kept };
}
