// Usage: node rtl.e2e.js <repoDir> — Hebrew typed into a terminal reads right to left (xterm draws it mirrored on its own).
const { chromium } = require("playwright-core");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), net = require("net"), http = require("http");
const { repoDir, chromePath } = require("./lib");
const repo = repoDir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenv-rtl-e2e-"));
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
  const rows = () => page.evaluate(() => [...document.querySelectorAll("#workspace-area .xterm-rows > div")].map((r) => r.textContent.replace(/\u00a0/g, " ")));
  try {
    await page.goto(`http://127.0.0.1:${port}/?token=T`);
    await page.click("text=Session 0");
    await page.waitForSelector("#workspace-area .xterm");
    await sleep(1500);
    await page.keyboard.type("echo שלום עולם hello 123");
    await sleep(500);
    ok((await rows()).some((r) => r.includes("echo םלוע םולש hello 123")), "Hebrew being typed reads right to left");
    await page.keyboard.press("Enter");
    await sleep(1200);
    ok((await rows()).some((r) => r.startsWith("םלוע םולש hello 123")), "and so does Hebrew the terminal prints");
    await page.keyboard.type("echo שלום");
    await sleep(600);
    const around = await page.evaluate(() => {
      const c = document.querySelector("#workspace-area .xterm-rows .xterm-cursor");
      if (!c) return null;
      const cells = [...c.parentElement.children];
      const i = cells.indexOf(c);
      return { before: cells.slice(0, i).map((e) => e.textContent).join("").replace(/ /g, " "), after: cells.slice(i + 1).map((e) => e.textContent).join("") };
    });
    ok(around && around.before.endsWith("echo ") && around.after.startsWith("םולש"), "while typing Hebrew the cursor sits at its left edge, where the next letter goes" + (around ? " (" + JSON.stringify(around.before.slice(-8)) + " | " + JSON.stringify(around.after.slice(0, 6)) + ")" : ""));
    const cursorRows = await page.evaluate(() => document.querySelectorAll("#workspace-area .xterm-rows .xterm-cursor").length);
    ok(cursorRows === 1, "the cursor is still drawn");
    const dir = await page.evaluate(() => { const t = document.createElement("textarea"); document.body.appendChild(t); const v = getComputedStyle(t).unicodeBidi; t.remove(); return v; });
    ok(dir === "plaintext", "text boxes take their direction from what is typed");
  } catch (e) { console.log("FAIL " + e.message); process.exitCode = 1; }
  finally { ok(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : "")); await browser.close(); srv.kill(); }
})();
