// Stand-in for an interactive `claude`: registers itself the way Claude Code does
// (~/.claude/sessions/<pid>.json) and stays alive until interrupted.
const fs = require("fs"), path = require("path");
const [home, sessionId, cwd] = process.argv.slice(2);
const dir = path.join(home, ".claude", "sessions");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, process.pid + ".json");
fs.writeFileSync(file, JSON.stringify({ pid: process.pid, sessionId, cwd, startedAt: Date.now(), kind: "interactive" }));
console.log("FAKE_CLAUDE_READY " + process.pid);
const bye = () => { try { fs.unlinkSync(file); } catch {} process.exit(0); };
process.on("SIGINT", bye); process.on("SIGTERM", bye);
setInterval(() => {}, 1000);
