// Usage: node model-effort.e2e.js <repoDir> — set a session's model and effort from the Sessions panel (right-click),
// then for every session at once with the header button; the card shows them.
const { chromium } = require("playwright-core");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), net = require("net"), http = require("http");

const { repoDir, chromePath } = require("./lib");
const repo = repoDir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenv-model-e2e-"));
  const port = await freePort();
  const srv = spawn(process.execPath, [path.join(repo, "server.js"), "--port", port, "--host", "127.0.0.1", "--token", "T", "--no-qr"],
    { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: "ignore", windowsHide: true });
  const call = (method, p, body) => new Promise((res, rej) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, method, path: p + "?token=T", headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} },
      (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => { try { res(JSON.parse(b)); } catch { res(b); } }); });
    req.on("error", rej); req.end(data);
  });
  for (let i = 0; i < 100; i++) { try { await call("GET", "/api/sessions"); break; } catch { await sleep(200); } }

  const browser = await chromium.launch({ executablePath: chromePath() });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const ok = (cond, msg) => { console.log((cond ? "PASS " : "FAIL ") + msg); if (!cond) process.exitCode = 1; };

  try {
    await call("POST", "/api/sessions", { name: "alpha", group: "Team" });
    await call("POST", "/api/sessions", { name: "beta", group: "Team/Sub" });
    await page.goto(`http://127.0.0.1:${port}/?token=T`);
    await page.click("text=Session 0");
    await page.waitForSelector("#workspace-area .xterm");
    await page.click("#ab-sessions");
    await page.waitForSelector("#sessions-panel .sp-session");

    // one session, from its right-click menu
    await page.locator("#sessions-panel .sp-session", { hasText: "alpha" }).click({ button: "right" });
    await page.locator(".ctx-menu .ctx-item", { hasText: "Model & effort" }).click();
    await page.waitForSelector(".ask-model");
    await page.fill(".ask-model", "sonnet");
    await page.selectOption(".ask-effort", "high");
    await page.click(".ask-btn.primary");
    await page.waitForFunction(() => [...document.querySelectorAll("#sessions-panel .sp-session")].some((e) => e.innerText.includes("alpha") && e.innerText.includes("sonnet · high")), null, { timeout: 10000 });
    ok(true, "the card of that session shows 'sonnet · high'");
    const list = await call("GET", "/api/sessions");
    const a = list.find((s) => s.name === "alpha");
    ok(a.model === "sonnet" && a.effort === "high", "the server has it");

    // every session, from the header
    await page.click("#sessions-panel [data-act='model-effort-all']");
    await page.waitForSelector(".ask-model");
    await page.fill(".ask-model", "opus");
    await page.click(".ask-btn.primary");   // effort stays "keep as is"
    await page.waitForFunction(() => [...document.querySelectorAll("#sessions-panel .sp-session")].some((e) => e.innerText.includes("beta") && e.innerText.includes("opus")), null, { timeout: 10000 });
    const after = await call("GET", "/api/sessions");
    ok(after.every((s) => s.model === "opus"), "every session now has model opus");
    ok(after.find((s) => s.name === "alpha").effort === "high", "effort was left as it was");
  } catch (e) {
    console.log("FAIL " + e.message); process.exitCode = 1;
  } finally {
    ok(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await browser.close();
    srv.kill();
  }
})();
