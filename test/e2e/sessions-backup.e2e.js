// Usage: node sessions-backup.e2e.js <repoDir> — the Sessions panel's backup buttons: export downloads a JSON file,
// import adds sessions from one.
const { chromium } = require("playwright-core");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), net = require("net"), http = require("http");

const { repoDir, chromePath } = require("./lib");
const repo = repoDir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenv-backup-e2e-"));
  const port = await freePort();
  const srv = spawn(process.execPath, [path.join(repo, "server.js"), "--port", port, "--host", "127.0.0.1", "--token", "T", "--no-qr"],
    { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: "ignore", windowsHide: true });
  const call = (method, p) => new Promise((res, rej) => {
    http.request({ host: "127.0.0.1", port, method, path: p + "?token=T" }, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => { try { res(JSON.parse(b)); } catch { res(b); } }); }).on("error", rej).end();
  });
  for (let i = 0; i < 100; i++) { try { await call("GET", "/api/sessions"); break; } catch { await sleep(200); } }

  const browser = await chromium.launch({ executablePath: chromePath() });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const ok = (cond, msg) => { console.log((cond ? "PASS " : "FAIL ") + msg); if (!cond) process.exitCode = 1; };

  try {
    await page.goto(`http://127.0.0.1:${port}/?token=T`);
    await page.click("text=Session 0");
    await page.waitForSelector("#workspace-area .xterm");
    await page.click("#ab-sessions");
    await page.waitForSelector("#sessions-panel [data-act='export-sessions']");
    ok(await page.$("#sessions-panel [data-act='import-sessions']") !== null, "the Sessions panel has Export and Import buttons");

    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#sessions-panel [data-act='export-sessions']")]);
    const file = path.join(home, "backup.json");
    await download.saveAs(file);
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    ok(/^agenv-sessions-\d{4}-\d{2}-\d{2}\.json$/.test(download.suggestedFilename()) && data.format === "agenv-sessions", "Export downloads agenv-sessions-<date>.json");

    data.sessions.push({ name: "from-the-file", cwd: home, tool: "terminal", lastCommand: "", launchCommand: "", userNamed: true, group: "Backup/Test", note: "", claudeSessionId: null, created: 1, lastActivity: 1 });
    fs.writeFileSync(file, JSON.stringify(data));
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("#sessions-panel [data-act='import-sessions']")]);
    await chooser.setFiles(file);
    await page.waitForFunction(() => document.querySelector("#sessions-panel")?.innerText.includes("from-the-file"), null, { timeout: 10000 });
    ok(true, "Import adds the session from the file to the tree, in its folder");
    ok((await page.$eval("#sessions-panel", (e) => e.innerText)).includes("BACKUP"), "and creates its folder");
  } catch (e) {
    console.log("FAIL " + e.message); process.exitCode = 1;
  } finally {
    ok(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await browser.close();
    srv.kill();
  }
})();
