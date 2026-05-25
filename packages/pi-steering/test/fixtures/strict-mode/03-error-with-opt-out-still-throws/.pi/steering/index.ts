// Fixture: error-class diagnostic ALWAYS throws, even with
// `failOnWarnings: false` (the opt-out only applies to warnings).
//
// Two plugins both register a `branch` tracker. Two plugins claiming
// the same state dimension is always a bug — the loser's tracker is
// silently unreachable, the rules that consult it become predicate-key
// references to a now-shadowed tracker, and config-merge order is the
// only thing that decides which side wins. The runtime escalates this
// to a thrown error regardless of `failOnWarnings`.
import { defineConfig } from "pi-steering";

const tracker = {
	initial: "?",
	unknown: "unknown" as const,
	modifiers: {},
	subshellSemantics: "isolated" as const,
};

export default defineConfig({
	disableDefaults: true,
	failOnWarnings: false,
	plugins: [
		{ name: "plugin-a", trackers: { branch: tracker } },
		{ name: "plugin-b", trackers: { branch: tracker } },
	],
});
