// Fixture: warning-class diagnostic does NOT throw with the
// `failOnWarnings: false` opt-out; the diagnostic is emitted to
// console.warn instead.
//
// Same warning-class collision as fixture 01 (two plugins both ship
// a rule called `dup`), but with `failOnWarnings: false` set
// explicitly. The bridge keeps running with the merged config; the
// warning lands on stderr via `console.warn`.
import { defineConfig } from "pi-steering";

export default defineConfig({
	disableDefaults: true,
	failOnWarnings: false,
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
