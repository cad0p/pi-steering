// Fixture: warning-class diagnostic throws on default `failOnWarnings`.
//
// Two plugins both register a rule called `dup`. The cross-layer
// rule-name collision is a `warning`-class diagnostic. With
// `failOnWarnings` left at its default (true), the runtime
// aggregates and throws at factory time.
import { defineConfig } from "pi-steering";

export default defineConfig({
	disableDefaults: true,
	plugins: [
		{
			name: "plugin-a",
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
