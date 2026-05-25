// Fixture: error-class diagnostic ALWAYS throws, even with
// `failOnWarnings: false` (the opt-out only applies to warnings).
//
// Two plugins both register a `branch` tracker. Two plugins claiming
// the same state dimension is a tracker-name-collision — error-class
// because the engine cannot operate safely (whichever first-wins is
// non-deterministic per layer order). The runtime escalates this to
// a thrown error regardless of `failOnWarnings`.
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
