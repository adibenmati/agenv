// Usage: node test/e2e/hibernate.e2e.js [repoDir] — a hidden tab frees its terminal after a while and comes back intact
const { chromium } = require("playwright-core");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), net = require("net");
const { repoDir, shot, chromePath } = require("./lib");

const repo = repoDir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenv-e2e-home-"));
  const port = await freePort();
  const srv = spawn(process.execPath, [path.join(repo, "server.js"), "--port", port, "--host", "127.0.0.1", "--token", "T", "--no-qr"],
    { cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let log = ""; srv.stdout.on("data", (d) => (log += d)); srv.stderr.on("data", (d) => (log += d));
  await sleep(1500);

  const browser = await chromium.launch({ executablePath: chromePath() });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });   // a missing favicon is not a page error
  const ok = (cond, msg) => { console.log((cond ? "PASS " : "FAIL ") + msg); if (!cond) process.exitCode = 1; };

  try {
    await page.goto(`http://127.0.0.1:${port}/?token=T`);
    await page.evaluate(() => localStorage.setItem("agenv.hibernateMs", "1500"));
    await page.reload();
    await page.click("text=Session 0");
    await page.waitForSelector("#workspace-area .xterm", { timeout: 15000 });
    const visibleText = () => page.evaluate(() => [...document.querySelectorAll("#workspace-area .xterm-rows")].map((e) => e.innerText).join("\n"));
    const count = (t, s) => t.split(s).length - 1;

    await page.click("#workspace-area .xterm");
    await sleep(1500);
    await page.keyboard.type("echo MARK_ONE\n", { delay: 20 });
    await page.waitForFunction(() => [...document.querySelectorAll("#workspace-area .xterm-rows")].some((e) => (e.innerText.match(/MARK_ONE/g) || []).length >= 2), null, { timeout: 10000 });
    const before = count(await visibleText(), "MARK_ONE");
    ok(before >= 2, `marker echoed in tab 1 (${before} occurrences)`);
    const xtermsBefore = await page.evaluate(() => document.querySelectorAll(".xterm").length);

    await page.click("#add-tab");
    await page.waitForFunction((n) => document.querySelectorAll(".xterm").length > n, xtermsBefore, { timeout: 10000 });
    const xtermsWithTwo = await page.evaluate(() => document.querySelectorAll(".xterm").length);
    await sleep(3000); // longer than the hibernate delay
    const xtermsAfter = await page.evaluate(() => document.querySelectorAll(".xterm").length);
    ok(xtermsAfter === xtermsWithTwo - 1, `hidden tab's xterm disposed (${xtermsWithTwo} -> ${xtermsAfter} .xterm elements)`);
    ok(!/Browser disconnected from session 0/.test(log), "hibernated pane kept its socket open");

    await page.click(".tab >> nth=0");
    await page.waitForFunction(() => /MARK_ONE/.test([...document.querySelectorAll("#workspace-area .xterm-rows")].map((e) => e.innerText).join("")), null, { timeout: 10000 });
    await sleep(500);
    const after = count(await visibleText(), "MARK_ONE");
    ok(after === before, `woken tab shows scrollback exactly once (${before} -> ${after})`);

    await page.click("#workspace-area .xterm");
    await page.keyboard.type("echo AFTER_WAKE\n", { delay: 20 });
    await page.waitForFunction(() => ([...document.querySelectorAll("#workspace-area .xterm-rows")].map((e) => e.innerText).join("").match(/AFTER_WAKE/g) || []).length >= 2, null, { timeout: 10000 });
    ok(true, "input works after wake");

    // Switching back and forth again must not duplicate anything either
    await page.click(".tab >> nth=1"); await sleep(3000);
    await page.click(".tab >> nth=0"); await sleep(1500);
    const again = count(await visibleText(), "MARK_ONE");
    ok(again === before, `second hibernate/wake cycle still exact (${again})`);
    ok(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  } catch (e) {
    console.log("FAIL exception:", e.message.split("\n")[0]);
    await page.screenshot({ path: shot("hibernate-fail.png") });
    console.log("screenshot:", shot("hibernate-fail.png"));
    process.exitCode = 1;
  } finally {
    await browser.close();
    srv.kill();
  }
})();
