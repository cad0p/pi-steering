// Fixture: clean config that loads successfully so the bridge can
// register handlers; the cwd-mismatch warn fires only on
// `session_start` when the resumed session's `ctx.cwd` differs from
// the launch cwd captured at factory time.
import { defineConfig } from "pi-steering";

export default defineConfig({});
