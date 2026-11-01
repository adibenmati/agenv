// Usage: node terminal-refit.e2e.js <repoDir> — a terminal follows its container when only the container changes size
// (no window resize), and a window that comes back from minimised gets redrawn and the keyboard back in the terminal.
const { chromium } = require("playwright-core");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), net = require("net"), http = require("http");

const { repoDir, chromePath } = require("./lib");
const repo = repoDir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenv-refit-e2e-"));
  const port = await freePort();
  const srv = spawn(process.execPath, [path.join(repo, "server.js"), "--port", port, "--host", "127.0.0.1", "--token", "T", "--no-qr"],
    { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: "ignore", windowsHide: true });
  const call = (method, p) => new Promise((res, rej) => {
    http.request({ host: "127.0.0.1", port, method, path: p + "?token=T" }, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => { try { res(JSON.parse(b)); } catch { res(b); } }); }).on("error", rej).end();
  });
  for (let i = 0; i < 100; i++) { try { await call("GET", "/api/sessions"); break; } catch { await sleep(200); } }

  const browser = await chromium.launch({ executablePath: chromePath() });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const ok = (cond, msg) => { console.log((cond ? "PASS " : "FAIL ") + msg); if (!cond) process.exitCode = 1; };
  const size = () => page.evaluate(() => { const r = document.querySelector("#workspace-area .xterm-rows"); return { rows: r ? r.children.length : 0, h: document.querySelector("#workspace-area .xterm-screen").clientHeight, w: document.querySelector("#workspace-area .xterm-screen").clientWidth }; });
  const serverSize = async () => { const s = (await call("GET", "/api/sessions"))[0]; return s; };

  try {
    await page.goto(`http://127.0.0.1:${port}/?token=T`);
    await page.click("text=Session 0");
    await page.waitForSelector("#workspace-area .xterm");
    await sleep(1500);
    const before = await size();

    // the container shrinks without the window changing: the work area loses 300px of height and 400px of width
    await page.evaluate(() => { const w = document.querySelector("#workspace-area"); w.style.height = (w.clientHeight - 300) + "px"; w.style.width = (w.clientWidth - 400) + "px"; w.style.flex = "none"; });
    await sleep(800);
    const after = await size();
    ok(after.h < before.h - 200 && after.w < before.w - 300, `the terminal follows its container (${before.w}x${before.h} -> ${after.w}x${after.h})`);

    // coming back from minimised: visibilitychange + focus; the keyboard returns to the terminal
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.evaluate(() => { document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus")); });
    await sleep(500);
    ok(await page.evaluate(() => document.activeElement && document.activeElement.classList.contains("xterm-helper-textarea")), "after the window comes back the terminal has the keyboard");
    await page.keyboard.type("echo refit-ok");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => [...document.querySelectorAll(".xterm-rows")].some((e) => e.innerText.includes("refit-ok")), null, { timeout: 8000 });
    ok(true, "and typing works");
  } catch (e) {
    console.log("FAIL " + e.message); process.exitCode = 1;
  } finally {
    ok(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await browser.close();
    srv.kill();
  }
})();
