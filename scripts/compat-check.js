// scripts/compat-check.js — usage: node scripts/compat-check.js <entry>
// Copies ~/.agenv-* (or $AGENV_COMPAT_HOME) into a temp home, starts <entry> on the copy and prints what was
// restored. Never writes to the source home. Output is counts only.
"use strict";
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http"), net = require("net");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const entry = process.argv[2];
if (!entry) { console.error("usage: compat-check.js <entry>"); process.exit(2); }
const src = process.env.AGENV_COMPAT_HOME || os.homedir();
const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenv-compat-"));
for (const f of fs.readdirSync(src)) {
  if (!/^\.agenv(-|\.key|rc\.json)/.test(f) || f === ".agenv.pid") continue;
  fs.cpSync(path.join(src, f), path.join(home, f), { recursive: true });
}
const get = (port, p) => new Promise((res) => http.get(`http://127.0.0.1:${port}${p}${p.includes("?") ? "&" : "?"}token=T`, { agent: false }, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => { try { res(JSON.parse(b)); } catch { res(null); } }); }).on("error", () => res(null)));
(async () => {
  const port = await new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
  const proc = spawn(process.execPath, [path.resolve(entry), "--port", String(port), "--host", "127.0.0.1", "--token", "T", "--no-qr"],
    { cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: "ignore", windowsHide: true });
  let sessions = null;
  for (let i = 0; i < 60 && !sessions; i++) { await sleep(300); sessions = await get(port, "/api/sessions"); }
  const [hist, arch, groups, favs] = await Promise.all([get(port, "/api/history"), get(port, "/api/archive"), get(port, "/api/session-groups"), get(port, "/api/favorites")]);
  proc.kill(); await sleep(300); fs.rmSync(home, { recursive: true, force: true });
  if (!sessions) { console.error("FAIL: server did not start / answer"); process.exit(1); }
  const named = sessions.filter((s) => s.name).map((s) => s.name).sort();
  console.log(JSON.stringify({
    sessions: sessions.length, withGroup: sessions.filter((s) => s.group).length, withNote: sessions.filter((s) => s.note).length,
    history: (hist || []).length, archive: (arch || []).length, groups: (groups || []).length, favorites: (favs || []).length,
    names: named.length, firstNames: named.slice(0, 3),
  }));
})();
