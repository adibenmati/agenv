// Usage: node session-activity.e2e.js <repoDir> — each session in the sidebar shows what it is working on: a line that
// scrolls left to right while it works (from the task an agent writes in the terminal title, or what was typed), stands
// still when done, and opens a details panel when clicked.
const { chromium } = require("playwright-core");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), net = require("net"), http = require("http");
const { repoDir, chromePath } = require("./lib");
const repo = repoDir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenv-activity-e2e-"));
  const port = await freePort();
  const srv = spawn(process.execPath, [path.join(repo, "server.js"), "--port", port, "--host", "127.0.0.1", "--token", "T", "--no-qr"],
    { env: { ...process.env, AGENV_HOME: home, HOME: home, USERPROFILE: home }, stdio: "ignore", windowsHide: true });
  const up = () => new Promise((res, rej) => http.get({ host: "127.0.0.1", port, path: "/api/sessions?token=T" }, (r) => { r.resume(); r.on("end", res); }).on("error", rej));
  for (let i = 0; i < 100; i++) { try { await up(); break; } catch { await sleep(200); } }
  const browser = await chromium.launch({ executablePath: chromePath() });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };
  const line = ".sp-session[data-sid] .sp-activity";
  const run = async (cmd) => { await page.click("#workspace-area .xterm"); await page.keyboard.type(cmd); await page.keyboard.press("Enter"); };
  const isWin = process.platform === "win32";
  const setTitle = (t) => run(isWin ? "title " + t : `printf '\\033]0;${t}\\007'`);
  try {
    await page.goto(`http://127.0.0.1:${port}/?token=T`);
    await page.click("text=Session 0");
    await page.waitForSelector("#workspace-area .xterm");
    await sleep(1500);
    await page.click("#activity-bar .ab-btn[data-panel='sessions-panel']");
    await page.waitForSelector("#sessions-panel .sp-session[data-sid]");

    await run("echo activity-ok");
    await page.waitForFunction((sel) => [...document.querySelectorAll(sel)].some((e) => e.textContent.includes("echo activity-ok")), line, { timeout: 10000 });
    ok(true, "a typed command shows as the session's activity");

    await setTitle("◐ Testing the marquee");
    await page.waitForFunction((sel) => [...document.querySelectorAll(sel + ".working")].some((e) => e.textContent.includes("Testing the marquee")), line, { timeout: 10000 });
    ok(true, "a task in the terminal title shows as working");
    ok(await page.evaluate((sel) => getComputedStyle(document.querySelector(sel + ".working .sp-act-text")).animationName === "sp-marquee", line), "it scrolls");
    // Sample the position a few times; the text wraps back to the left once per loop, so most steps (not all) move right.
    const xs = [];
    for (let i = 0; i < 5; i++) {
      xs.push(await page.evaluate((sel) => document.querySelector(sel + ".working .sp-act-text").getBoundingClientRect().left, line));
      await sleep(250);
    }
    const right = xs.slice(1).filter((x, i) => x > xs[i]).length;
    ok(right >= 3, `left to right (${xs.map((x) => x.toFixed(0)).join(" → ")})`);
    await page.screenshot({ path: path.join(os.tmpdir(), "agenv-activity.png") });

    await setTitle("✳ Testing the marquee");
    await page.waitForFunction((sel) => [...document.querySelectorAll(sel)].some((e) => e.textContent.includes("Testing the marquee") && !e.classList.contains("working")), line, { timeout: 10000 });
    ok(true, "when the task is done the line stands still");

    await page.click(line);
    await page.waitForSelector(".si-box", { timeout: 3000 });
    await page.waitForFunction(() => document.querySelector(".si-hist"), null, { timeout: 5000 });
    const panel = await page.textContent(".si-box");
    ok(panel.includes("Testing the marquee"), "clicking the line opens the details panel with the task");
    ok(panel.includes("echo activity-ok"), "and the recent activity");
    ok(/activity-ok/.test(await page.textContent(".si-out")), "and the latest output");
    await page.screenshot({ path: path.join(os.tmpdir(), "agenv-activity-panel.png") });
    await page.keyboard.press("Escape");
    ok(!(await page.$(".si-overlay")), "Esc closes it");
  } catch (e) { console.log("FAIL " + e.message); process.exitCode = 1; }
  finally { ok(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : "")); await browser.close(); srv.kill(); }
})();
