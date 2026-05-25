// Fixture: clean config that loads successfully so the bridge can
// register handlers; the cwd-mismatch warn fires only on
// `session_start` when the resumed session's `ctx.cwd` differs from
// the launch cwd captured at factory time.
//
// Authors a launch-cwd-only USER rule so the manual verification
// can confirm launch-cwd config remains in force after the warn —
// the rule is only present here and not in any plausible foreign
// resume cwd.
import { defineConfig } from "pi-steering";

export default defineConfig({
	rules: [
		{
			name: "block-launch-cwd-probe",
			tool: "bash",
			field: "command",
			pattern: /^echo CWD_PROBE$/,
			reason: "launch-cwd-only rule used by the cwd-mismatch fixture",
		},
	],
});
