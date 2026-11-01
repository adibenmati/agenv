// Usage: node ngrok-port.e2e.js <repoDir> — the ngrok panel offers the port of the agenv it was opened from (not a fixed
// number) and starts the tunnel on that port. The start call is intercepted: no real ngrok runs.
const { chromium } = require("playwright-core");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), net = require("net"), http = require("http");
const { repoDir, chromePath } = require("./lib");
const repo = repoDir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenv-ngrok-e2e-"));
  const port = await freePort();
  const srv = spawn(process.execPath, [path.join(repo, "server.js"), "--port", port, "--host", "127.0.0.1", "--token", "T", "--no-qr"],
    { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: "ignore", windowsHide: true });
  const up = () => new Promise((res, rej) => http.get({ host: "127.0.0.1", port, path: "/api/sessions?token=T" }, (r) => { r.resume(); r.on("end", res); }).on("error", rej));
  for (let i = 0; i < 100; i++) { try { await up(); break; } catch { await sleep(200); } }
  const browser = await chromium.launch({ executablePath: chromePath() });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };
  let posted = null;
  await page.route("**/api/ngrok/start*", (route) => { posted = JSON.parse(route.request().postData() || "{}"); route.fulfill({ json: { ok: false, error: "intercepted" } }); });
  try {
    await page.goto(`http://127.0.0.1:${port}/?token=T`);
    await page.click("text=Session 0");
    await page.waitForSelector("#workspace-area .xterm");
    await page.click("#ab-ngrok");
    await page.waitForSelector("#ngrok-port");
    ok((await page.inputValue("#ngrok-port")) === String(port), "the port field shows the port of this agenv, not 7685");
    await page.click("#ngrok-start-btn");
    await page.waitForFunction(() => document.getElementById("ngrok-output") && document.getElementById("ngrok-output").textContent.includes("intercepted"));
    ok(posted && posted.port === port, "the tunnel is started on this agenv's port");
  } catch (e) { console.log("FAIL " + e.message); process.exitCode = 1; }
  finally { await browser.close(); srv.kill(); }
})();
