// Usage: node groups-e2e.js <repoDir>  — drives the session group tree UI in Chromium
const { chromium } = require("playwright-core");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), net = require("net"), http = require("http");

const { repoDir, shot, chromePath } = require("./lib");
const repo = repoDir();
const exe = chromePath();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenv-groups-e2e-"));
  const port = await freePort();
  const srv = spawn(process.execPath, [path.join(repo, "server.js"), "--port", port, "--host", "127.0.0.1", "--token", "T", "--no-qr"],
    { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: "ignore", windowsHide: true });
  const apiGet = (p) => new Promise((res) => http.get(`http://127.0.0.1:${port}${p}?token=T`, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => res(JSON.parse(b))); }));
  await sleep(1500);

  const browser = await chromium.launch({ executablePath: exe });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // Fail loudly if anything still calls window.prompt
  page.on("dialog", async (d) => { if (d.type() === "prompt") errors.push("window.prompt used: " + d.message()); await d.accept(); });
  const ok = (cond, msg) => { console.log((cond ? "PASS " : "FAIL ") + msg); if (!cond) process.exitCode = 1; };
  const ask = async (text) => { await page.waitForSelector(".ask-input"); await page.fill(".ask-input", text); await page.keyboard.press("Enter"); };
  const ctxClick = async (label) => { await page.locator(".ctx-menu .ctx-item:not(.has-sub)", { hasText: label }).first().click(); };
  const hoverSub = async (label) => { await page.locator(".ctx-menu .ctx-item.has-sub", { hasText: label }).first().hover(); };
  const sessionGroup = async (id) => (await apiGet("/api/sessions")).find((s) => s.id === id).group;

  try {
    await page.goto(`http://127.0.0.1:${port}/?token=T`);
    await page.click("text=Session 0");
    await page.waitForSelector("#workspace-area .xterm");
    await page.click("#ab-sessions");
    await page.waitForSelector("#sessions-panel .sp-new-group");

    // 1. "+ New Group" with a nested path
    await page.click("#sessions-panel .sp-new-group");
    await ask("project1/marketing/seo");
    await page.waitForFunction(() => document.querySelectorAll("#sessions-panel .sp-group-name").length >= 3);
    const names = await page.$$eval("#sessions-panel .sp-group-name", (els) => els.map((e) => e.textContent));
    ok(["project1", "marketing", "seo"].every((n) => names.includes(n)), "New Group creates nested folders: " + names.join(","));
    const nested = await page.evaluate(() => !!document.querySelector('.sp-group[data-group="project1"] .sp-group[data-group="project1/marketing"] .sp-group[data-group="project1/marketing/seo"]'));
    ok(nested, "folders render as a tree");

    // 2. Right-click the terminal → Move to Group → seo
    await page.click("#workspace-area .xterm", { button: "right" });
    await hoverSub("Move to Group");
    await ctxClick("seo");
    await sleep(500);
    ok((await sessionGroup(0)) === "project1/marketing/seo", "pane right-click moves session to nested folder");
    const inSeo = await page.evaluate(() => !!document.querySelector('.sp-group[data-group="project1/marketing/seo"] .sp-session[data-sid="0"]'));
    ok(inSeo, "session card shows inside seo folder");

    // 3. New tab → right-click tab → Move to Group → New Group…
    await page.click("#add-tab");
    await page.waitForFunction(() => document.querySelectorAll(".tab").length >= 2);
    await sleep(800);
    const sessionsNow = await apiGet("/api/sessions");
    const newId = Math.max(...sessionsNow.map((s) => s.id));
    await page.click(".tab >> nth=1", { button: "right" });
    await hoverSub("Move to Group");
    await ctxClick("New Group");
    await ask("project2/backend");
    await sleep(800);
    ok((await sessionGroup(newId)) === "project2/backend", `tab right-click moves session ${newId} to a new nested group`);

    // 4. Subgroup via header "+" button
    await page.hover('.sp-group-header[data-group-toggle="project2"]');
    await page.click('.sp-group-header[data-group-toggle="project2"] [data-act="new-subgroup"]');
    await ask("api");
    await page.waitForSelector('.sp-group[data-group="project2/api"]');
    ok(true, "header + creates a subgroup");

    // 5. Rename a middle folder: sessions below follow
    await page.click('.sp-group-header[data-group-toggle="project1/marketing"]', { button: "right" });
    await ctxClick("Rename");
    await ask("growth");
    await sleep(800);
    ok((await sessionGroup(0)) === "project1/growth/seo", "renaming a folder moves its subtree");

    // 6. Delete folder: sessions move up to parent
    await page.hover('.sp-group-header[data-group-toggle="project1/growth"]');
    await page.click('.sp-group-header[data-group-toggle="project1/growth"] [data-act="delete-group"]');
    await sleep(800);
    ok((await sessionGroup(0)) === "project1", "deleting a folder moves its sessions to the parent");

    // 7. Folders survive a reload (server-side, not localStorage)
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.click("#ab-sessions").catch(() => {});
    await page.waitForSelector('#sessions-panel .sp-group[data-group="project2/api"]', { timeout: 8000 });
    ok(true, "empty folder survives reload with localStorage cleared");

    // 8. Group names are escaped in menus
    await page.click("#sessions-panel .sp-new-group");
    await ask("<img src=x onerror=window.__xss=1>");
    await sleep(500);
    await page.click(".tab >> nth=0", { button: "right" });
    await hoverSub("Move to Group");
    await sleep(300);
    ok(!(await page.evaluate(() => window.__xss)), "group names are escaped in the context menu");
    await page.keyboard.press("Escape");

    await page.screenshot({ path: shot("groups.png") });
    ok(errors.length === 0, "no page errors / prompts" + (errors.length ? ": " + errors.join(" | ") : ""));
  } catch (e) {
    console.log("FAIL exception:", e.message.split("\n")[0]);
    await page.screenshot({ path: shot("groups-fail.png") });
    process.exitCode = 1;
  } finally {
    await browser.close();
    srv.kill();
  }
})();
