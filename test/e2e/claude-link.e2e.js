// Usage: node claude-link-e2e.js <repoDir>
// Rename → Claude title, Continue Agent → --resume <id>, closed session → resume.
const { chromium } = require("playwright-core");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), net = require("net"), http = require("http");

const { repoDir, shot, chromePath } = require("./lib");
const repo = repoDir();
const exe = chromePath();
const fake = path.join(__dirname, "fakeclaude.js");
const UUID = "0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenv-link-e2e-"));
  const projCwd = fs.mkdtempSync(path.join(os.tmpdir(), "agenv-link-proj-"));
  const transcript = path.join(home, ".claude", "projects", "C--proj", UUID + ".jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", cwd: projCwd, sessionId: UUID, message: { role: "user", content: "hi" } }) + "\n");

  const port = await freePort();
  const srv = spawn(process.execPath, [path.join(repo, "server.js"), "--port", port, "--host", "127.0.0.1", "--token", "T", "--no-qr"],
    { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: "ignore", windowsHide: true });
  const apiGet = (p) => new Promise((res) => http.get(`http://127.0.0.1:${port}${p}?token=T`, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => res(JSON.parse(b))); }));
  await sleep(1500);

  const browser = await chromium.launch({ executablePath: exe });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  const posted = [];
  await page.route("**/api/sessions?*", (route) => { if (route.request().method() === "POST") posted.push(JSON.parse(route.request().postData() || "{}")); route.continue(); });
  const ok = (cond, msg) => { console.log((cond ? "PASS " : "FAIL ") + msg); if (!cond) process.exitCode = 1; };
  const ask = async (text) => { await page.waitForSelector(".ask-input"); await page.fill(".ask-input", text); await page.keyboard.press("Enter"); };
  const ctxClick = async (label) => { await page.locator(".ctx-menu .ctx-item:not(.has-sub)", { hasText: label }).first().click(); };
  const rows = () => page.evaluate(() => [...document.querySelectorAll("#workspace-area .xterm-rows")].map((e) => e.innerText).join("\n"));
  const waitFor = async (fn, ms, what) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error("timeout: " + what); await sleep(300); } };

  try {
    await page.goto(`http://127.0.0.1:${port}/?token=T`);
    await page.click("text=Session 0");
    await page.waitForSelector("#workspace-area .xterm");
    await page.click("#workspace-area .xterm");
    await sleep(1500);

    // 1. A claude process started by hand inside the terminal gets linked via the process tree
    await page.keyboard.type(`node "${fake}" "${home}" ${UUID} "${projCwd}"\n`, { delay: 5 });
    await waitFor(async () => /FAKE_CLAUDE_READY/.test(await rows()), 15000, "fake claude start");
    const t0 = Date.now();
    await waitFor(async () => (await apiGet("/api/sessions")).find((s) => s.id === 0).claudeSessionId === UUID, 40000, "link");
    ok(true, `running conversation linked to session 0 via process tree (${Date.now() - t0}ms)`);

    // 2. Renaming the session renames the Claude conversation
    await page.click("#ab-sessions");
    await page.waitForSelector('#sessions-panel .sp-session[data-sid="0"]');
    await page.click('#sessions-panel .sp-session[data-sid="0"]', { button: "right" });
    await ctxClick("Rename");
    await ask("seo audit");
    await waitFor(() => fs.readFileSync(transcript, "utf8").includes('"customTitle":"seo audit"'), 5000, "custom-title");
    ok(true, "rename wrote a custom-title record to the Claude transcript");

    // 3a. The tree's ▶ while claude is still running only opens the tab — nothing typed into claude
    ok((await apiGet("/api/sessions")).find((s) => s.id === 0).claudeRunning === true, "server reports claude running in the session");
    await page.hover('#sessions-panel .sp-session[data-sid="0"]');
    await page.click('#sessions-panel .sp-session[data-sid="0"] [data-act="continue-agent"]');
    await sleep(2000);
    ok(!(await rows()).replace(/\n/g, "").includes("--resume " + UUID), "tree ▶ does not type into a running claude");

    // 3b. After claude exits, the tree's ▶ types `claude --resume <id>`
    await page.click("#workspace-area .xterm");
    await page.keyboard.press("Control+C");
    await waitFor(async () => (await apiGet("/api/sessions")).find((s) => s.id === 0).claudeRunning === false, 25000, "claudeRunning cleared");
    await page.hover('#sessions-panel .sp-session[data-sid="0"]');
    await page.click('#sessions-panel .sp-session[data-sid="0"] [data-act="continue-agent"]');
    await waitFor(async () => (await rows()).replace(/\n/g, "").includes("--resume " + UUID), 8000, "resume command in terminal");
    ok(true, "tree ▶ resumes the linked conversation (--resume <id>)");
    await sleep(1500);
    await page.keyboard.press("Control+C"); await page.keyboard.press("Control+C");

    // 4. Delete → Recently Closed → Resume brings back name, group and conversation
    await page.click('#sessions-panel .sp-session[data-sid="0"]', { button: "right" });
    await page.locator(".ctx-menu .ctx-item.has-sub", { hasText: "Move to Group" }).first().hover();
    await ctxClick("New Group");
    await ask("proj/dev");
    await sleep(800);
    await page.click('#sessions-panel .sp-session[data-sid="0"]', { button: "right" });
    await ctxClick("Delete");
    await waitFor(async () => (await apiGet("/api/archive")).some((a) => a.claudeSessionId === UUID), 5000, "archived");
    await page.click("#sessions-panel [data-act='toggle-closed']");
    await page.waitForSelector("#sessions-panel .sp-session.closed");
    const closedText = await page.textContent("#sessions-panel .sp-session.closed");
    ok(closedText.includes("seo audit") && closedText.includes(UUID.slice(0, 8)), "closed session listed with its name and conversation: " + closedText.replace(/\s+/g, " ").trim());

    await page.click("#sessions-panel .sp-session.closed [data-act='resume-closed']");
    await waitFor(() => posted.length > 0, 5000, "resume POST");
    const body = posted[posted.length - 1];
    ok(body.command && body.command.includes("--resume " + UUID), "resume launches claude --resume <id>: " + body.command);
    ok(path.resolve(body.cwd) === path.resolve(projCwd), "resume starts in the conversation's folder: " + body.cwd);
    ok(body.name === "seo audit" && body.group === "proj/dev", "resume keeps name and group");
    await sleep(1500);
    const list = await apiGet("/api/sessions");
    const reborn = list.find((s) => s.name === "seo audit");
    ok(reborn && reborn.claudeSessionId === UUID, "reopened session is linked to the same conversation");
    ok(!(await apiGet("/api/archive")).some((a) => a.claudeSessionId === UUID), "resumed entry removed from Recently Closed");

    await page.screenshot({ path: shot("claude-link.png") });
    ok(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  } catch (e) {
    console.log("FAIL exception:", e.message.split("\n")[0]);
    await page.screenshot({ path: shot("claude-link-fail.png") });
    process.exitCode = 1;
  } finally {
    await browser.close();
    srv.kill();
  }
})();
