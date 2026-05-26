// Fixture: 1 error + 2 warnings aggregate into a single thrown
// factory error; the rendered shape pins the multi-line format
// (errors-first ordering, no padding, no footer).
//
// Layout:
//   - plugin-a registers tracker "events" (reserved name, error-class)
//     plus an observer "obs-x" and a rule "dup".
//   - plugin-b ships observer "obs-x" (collision, warning-class) and
//     rule "dup" (collision, warning-class).
//
// All three diagnostics surface from `resolvePlugins`; the runtime
// aggregates them with errors first.
import { defineConfig } from "pi-steering";

const tracker = {
	initial: "?",
	unknown: "unknown" as const,
	modifiers: {},
	subshellSemantics: "isolated" as const,
};

export default defineConfig({
	disableDefaults: true,
	plugins: [
		{
			name: "plugin-a",
			trackers: { events: tracker },
			observers: [
				{
					name: "obs-x",
					onResult: () => {},
				},
			],
			rules: [
				{
					name: "dup",
					tool: "bash",
					field: "command",
					pattern: /^never-a$/,
					reason: "from plugin-a",
				},
			],
		},
		{
			name: "plugin-b",
			observers: [
				{
					name: "obs-x",
					onResult: () => {},
				},
			],
			rules: [
				{
					name: "dup",
					tool: "bash",
					field: "command",
					pattern: /^never-b$/,
					reason: "from plugin-b",
				},
			],
		},
	],
});
