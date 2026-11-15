// Usage: node compose.e2e.js <repoDir> — the writing box: Ctrl+Shift+K or the pane's pencil opens it, text written there
// (Hebrew, English, both) goes to the session with Enter, Esc closes it and keeps the draft.
const { chromium } = require("playwright-core");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), net = require("net"), http = require("http");
const { repoDir, chromePath } = require("./lib");
const repo = repoDir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenv-compose-e2e-"));
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
  const termText = () => page.evaluate(() => [...document.querySelectorAll("#workspace-area .xterm-rows > div")].map((r) => r.textContent).join("\n"));
  try {
    await page.goto(`http://127.0.0.1:${port}/?token=T`);
    await page.click("text=Session 0");
    await page.waitForSelector("#workspace-area .xterm");
    await sleep(1500);

    await page.keyboard.press("Control+Shift+K");
    await page.waitForSelector(".compose-box textarea", { timeout: 3000 });
    ok(await page.evaluate(() => document.activeElement && document.activeElement.classList.contains("compose-input")), "Ctrl+Shift+K opens the writing box with the keyboard in it");
    await page.keyboard.type("echo compose-ok SEO שלום");
    ok(await page.evaluate(() => getComputedStyle(document.querySelector(".compose-input")).direction !== "" && document.querySelector(".compose-input").getAttribute("dir") === "auto"), "the box takes its direction from the text");
    await page.screenshot({ path: path.join(os.tmpdir(), "agenv-compose.png") });
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => [...document.querySelectorAll(".xterm-rows > div")].filter((r) => r.textContent.includes("compose-ok")).length >= 2, null, { timeout: 8000 });
    ok(true, "Enter sends it to the session, which runs it");
    ok(!(await page.$(".compose-box")), "and the box closes");
    ok(await page.evaluate(() => document.activeElement && document.activeElement.classList.contains("xterm-helper-textarea")), "the keyboard is back in the terminal");
    ok(!(await termText()).includes("\u0000"), "nothing odd was typed");

    await page.click(".ph-compose");
    await page.waitForSelector(".compose-box textarea");
    await page.keyboard.type("טיוטה draft");
    await page.keyboard.press("Escape");
    ok(!(await page.$(".compose-box")), "Esc closes the box");
    ok(!(await termText()).includes("draft"), "without sending anything");
    await page.click(".ph-compose");
    await page.waitForSelector(".compose-box textarea");
    ok((await page.inputValue(".compose-box textarea")) === "טיוטה draft", "the pencil reopens it with the draft kept");
    await page.keyboard.down("Shift"); await page.keyboard.press("Enter"); await page.keyboard.up("Shift");
    ok((await page.inputValue(".compose-box textarea")).includes("\n"), "Shift+Enter is a new line");
  } catch (e) { console.log("FAIL " + e.message); process.exitCode = 1; }
  finally { ok(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : "")); await browser.close(); srv.kill(); }
})();
