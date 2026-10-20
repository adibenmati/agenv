// Usage: node messages.e2e.js <repoDir> — the Messages panel shows the log, the send form and "Run a command in many sessions"
const { chromium } = require("playwright-core");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), net = require("net"), http = require("http");

const { repoDir, shot, chromePath } = require("./lib");
const repo = repoDir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenv-messages-e2e-"));
  const port = await freePort();
  const srv = spawn(process.execPath, [path.join(repo, "server.js"), "--port", port, "--host", "127.0.0.1", "--token", "T", "--no-qr"],
    { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: "ignore", windowsHide: true });
  const apiGet = (p) => new Promise((res) => http.get(`http://127.0.0.1:${port}${p}?token=T`, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => res(JSON.parse(b))); }));
  await sleep(1500);

  const browser = await chromium.launch({ executablePath: chromePath() });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const ok = (cond, msg) => { console.log((cond ? "PASS " : "FAIL ") + msg); if (!cond) process.exitCode = 1; };

  try {
    await page.goto(`http://127.0.0.1:${port}/?token=T`);
    await page.click("text=Session 0");
    await page.waitForSelector("#workspace-area .xterm");
    await page.click("#ab-messages");
    await page.waitForSelector("#messages-panel .ms-run");
    const text = await page.$eval("#messages-panel", (e) => e.innerText);
    ok(/Run a command in many sessions/i.test(text), "the panel offers 'Run a command in many sessions'");
    ok(await page.$eval("#messages-panel .ms-target", (e) => e.options[0].text === "All sessions"), "the target list starts with All sessions");
    ok(await page.$eval("#messages-panel .ms-agents-only", (e) => e.checked), "only-agent-sessions is on by default");

    await page.selectOption("#messages-panel .ms-target", { index: 0 });
    await page.fill("#messages-panel .ms-cmd", "echo agenv-broadcast-ok");
    await page.uncheck("#messages-panel .ms-agents-only");
    await page.click("#messages-panel .ms-run");
    await page.waitForFunction(() => document.querySelector(".xterm-rows") && document.querySelector(".xterm-rows").innerText.includes("agenv-broadcast-ok"), null, { timeout: 15000 });
    ok(true, "the command was typed into the open terminal and ran");
    ok((await apiGet("/api/sessions")).length >= 1, "session still alive");
  } catch (e) {
    console.log("FAIL " + e.message); process.exitCode = 1;
  } finally {
    ok(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await browser.close();
    srv.kill();
  }
})();
