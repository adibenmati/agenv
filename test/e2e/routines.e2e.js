// Usage: node routines.e2e.js [repoDir] — drives the Routines sidebar panel in Chromium against a fake claude.
// Nothing here calls the real Claude: AGENV_CLAUDE_BIN points at the fixture CLI and a no-op `claude` is first on PATH.
const { chromium } = require("playwright-core");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), net = require("net"), http = require("http");

const { repoDir, shot, chromePath } = require("./lib");
const repo = repoDir();
const exe = chromePath();
const FAKE = path.join(repo, "test", "fixtures", "fake-claude-cli.js");
const HOSTILE = "<img src=x onerror=alert(1)>";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

function stubClaudeDir() {
  const dir = tmp("agenv-e2e-stub-");
  fs.writeFileSync(path.join(dir, "claude.cmd"), "@echo off\r\n");
  fs.writeFileSync(path.join(dir, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return dir;
}

/** Starts a server on a temp HOME with the fake claude; resolves once the API answers. */
async function boot(mode, extraEnv) {
  const home = tmp("agenv-routines-e2e-"), state = tmp("agenv-routines-state-"), stub = stubClaudeDir();
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(repo, "server.js"), "--port", port, "--host", "127.0.0.1", "--token", "T", "--no-qr"], {
    env: { ...process.env, HOME: home, USERPROFILE: home, AGENV_CLAUDE_BIN: FAKE, FAKE_CLAUDE_STATE: state, FAKE_CLAUDE_MODE: mode, PATH: stub + path.delimiter + process.env.PATH, ...(extraEnv || {}) },
    stdio: "ignore", windowsHide: true,
  });
  const call = (method, p, body) => new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(`http://127.0.0.1:${port}${p}?token=T`, { method, headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} }, (r) => {
      let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    });
    req.on("error", rej); if (data) req.write(data); req.end();
  });
  for (let i = 0; ; i++) {
    try { await call("GET", "/api/routines"); break; } catch { if (i > 60) throw new Error("server did not start"); await sleep(250); }
  }
  return { port, proc, get: (p) => call("GET", p), post: (p, b) => call("POST", p, b || {}), dirs: [home, state, stub] };
}

(async () => {
  const work = tmp("agenv-routines-work-");
  const A = await boot("ok");
  const B = await boot("slow", { FAKE_CLAUDE_SLOW_MS: "60000" });
  const browser = await chromium.launch({ executablePath: exe });
  const errors = [];
  const ok = (cond, msg) => { console.log((cond ? "PASS " : "FAIL ") + msg); if (!cond) process.exitCode = 1; };
  const waitFor = async (fn, ms, what) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error("timeout: " + what); await sleep(150); } };
  const requests = [];
  const newPage = async (srv) => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", async (d) => { errors.push("window." + d.type() + " used: " + d.message()); await d.accept(); });
    page.on("request", (r) => requests.push({ t: Date.now(), url: r.url() }));
    await page.goto(`http://127.0.0.1:${srv.port}/?token=T`);
    await page.click("text=Session 0");
    await page.waitForSelector("#workspace-area .xterm");
    await page.waitForSelector("#ab-routines");
    return page;
  };
  const rowNames = (page) => page.$$eval("#routines-panel .rt-row .rt-name-text", (els) => els.map((e) => e.textContent));
  const row = (name) => `#routines-panel .rt-row[data-name="${name}"]`;
  const runsOf = (srv, id) => srv.get(`/api/routines/${id}/runs`);

  try {
    // Make an agent on each server (routines target agents).
    const agentA = await A.post("/api/agents", { name: "helper", cwd: work });
    const agentB = await B.post("/api/agents", { name: "slowpoke", cwd: work });
    ok(agentA.id && agentB.id, "agents exist on both servers");

    const page = await newPage(A);

    // 1. The panel exists and starts empty
    await page.click("#ab-routines");
    await page.waitForSelector("#routines-panel.active .rt-new");
    await page.waitForFunction(() => /No routines yet/.test(document.querySelector("#routines-panel .rt-empty-text")?.textContent || ""));
    ok((await rowNames(page)).length === 0, "Routines panel opens with an empty state");

    // 2. Create an agent routine with the weekdays preset
    await page.click("#routines-panel .rt-new");
    await page.waitForSelector(".rt-dialog .rt-name");
    const machineTz = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    ok((await page.inputValue(".rt-dialog .rt-tz")) === machineTz, "timezone defaults to the machine's: " + machineTz);
    await page.waitForFunction(() => document.querySelectorAll(".rt-dialog .rt-agent option").length > 0 && document.querySelector(".rt-dialog .rt-agent").value);
    await page.fill(".rt-dialog .rt-name", "nightly");
    await page.click('.rt-dialog .rt-preset[data-preset="weekdays"]');
    await page.fill(".rt-dialog .rt-prompt", "say hello");
    await page.screenshot({ path: shot("routines-dialog.png") });
    await page.click(".rt-dialog .rt-save");
    await page.waitForSelector(row("nightly"));
    const sched = (await page.textContent(`${row("nightly")} .rt-schedule`)).trim();
    const next = (await page.textContent(`${row("nightly")} .rt-next`)).trim();
    ok(/Weekdays at 09:00/.test(sched), "row shows the schedule in words: " + sched);
    ok(/^Next/.test(next) && /\d/.test(next) && !/never|not scheduled/i.test(next), "row shows the next run time: " + next);
    const nightly = (await A.get("/api/routines")).find((r) => r.name === "nightly");
    ok(nightly && nightly.cron === "0 9 * * 1-5" && nightly.target.agentId === agentA.id && nightly.permission.mode === "acceptEdits", "routine stored with the resolved cron, the agent and the default permission");
    ok(!(await page.$(".rt-dialog")), "dialog closes after creation");

    // 3. Permission labels in plain words; Skip all permissions needs a checkbox and shows a warning
    await page.click("#routines-panel .rt-new");
    await page.waitForSelector(".rt-dialog .rt-perm");
    const labels = await page.$$eval(".rt-dialog .rt-perm option", (os) => os.map((o) => o.textContent.trim()));
    ok(labels.length === 4 && /^Read-only/.test(labels[0]) && /^Edit files/.test(labels[1]) && /^Allowlist/.test(labels[2]) && /^Skip all permissions/.test(labels[3]), "permission labels are plain words: " + labels.join(" | "));
    ok((await page.inputValue(".rt-dialog .rt-perm")) === "acceptEdits", "Edit files is the default permission");
    ok(await page.isHidden(".rt-dialog .rt-tools"), "allowed tools box is hidden unless Allowlist is chosen");
    await page.selectOption(".rt-dialog .rt-perm", "dontAsk");
    ok(await page.isVisible(".rt-dialog .rt-tools"), "Allowlist shows the allowed tools box");
    await page.fill(".rt-dialog .rt-name", "risky");
    await page.fill(".rt-dialog .rt-prompt", "do things");
    await page.selectOption(".rt-dialog .rt-perm", "bypassPermissions");
    ok(await page.isVisible(".rt-dialog .rt-bypass-warn") && /any command/i.test(await page.textContent(".rt-dialog .rt-bypass-warn")) && /unattended/i.test(await page.textContent(".rt-dialog .rt-bypass-warn")), "Skip all permissions shows a visible warning");
    ok(await page.isDisabled(".rt-dialog .rt-save"), "Save is disabled until the acknowledgement is ticked");
    await page.press(".rt-dialog .rt-name", "Enter");
    await sleep(600);
    ok((await A.get("/api/routines")).length === 1 && !!(await page.$(".rt-dialog")), "submitting without the acknowledgement is blocked");
    await page.screenshot({ path: shot("routines-bypass.png") });
    await page.check(".rt-dialog .rt-bypass");
    ok(await page.isEnabled(".rt-dialog .rt-save"), "ticking the acknowledgement enables Save");
    await page.selectOption(".rt-dialog .rt-perm", "plan");
    ok(await page.isHidden(".rt-dialog .rt-bypass-warn"), "leaving Skip all permissions hides the warning");

    // 4. Invalid cron: inline error in the dialog, no row
    await page.click(".rt-dialog .rt-preset[data-preset=\"custom\"]");
    await page.fill(".rt-dialog .rt-cron", "61 * * * *");
    await page.click(".rt-dialog .rt-save");
    await page.waitForFunction(() => { const e = document.querySelector(".rt-dialog .rt-err"); return e && !e.hidden && e.textContent.trim().length > 0; });
    const errText = await page.textContent(".rt-dialog .rt-err");
    ok(/cron|minute|range|61/i.test(errText) && !!(await page.$(".rt-dialog")), "invalid cron shows an inline error in the dialog: " + errText.trim());
    ok((await rowNames(page)).join() === "nightly" && (await A.get("/api/routines")).length === 1, "invalid cron creates no row");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".rt-dialog"));

    // 5. Run now -> run row appears and turns succeeded with cost
    await page.click(`${row("nightly")} [data-act="run"]`);
    await page.waitForSelector(`${row("nightly")} .rt-run`, { timeout: 15000 });
    ok(true, "Run now: a run row appears");
    await page.waitForFunction((sel) => document.querySelector(sel + " .rt-run .rt-badge.st-succeeded"), row("nightly"), { timeout: 30000 }).catch(() => {});
    const badge = (await page.textContent(`${row("nightly")} .rt-run .rt-badge`)).trim();
    const runText = (await page.textContent(`${row("nightly")} .rt-run`)).replace(/\s+/g, " ");
    ok(badge === "succeeded" && /\$0\.01/.test(runText), "run turned succeeded with its cost: " + runText.trim());
    ok(/succeeded/.test(await page.textContent(`${row("nightly")} .rt-last`)) && /\$0\.01/.test(await page.textContent(`${row("nightly")} .rt-last`)), "row shows the last result and cost");

    // 6. Double-click Run now starts exactly one run
    const before = (await runsOf(A, nightly.id)).length;
    await page.dblclick(`${row("nightly")} [data-act="run"]`);
    await waitFor(async () => (await runsOf(A, nightly.id)).length > before, 10000, "second run");
    await sleep(1500);
    ok((await runsOf(A, nightly.id)).length === before + 1, "double-clicking Run now starts exactly one run");
    await waitFor(async () => (await runsOf(A, nightly.id)).every((r) => r.status !== "queued" && r.status !== "running"), 15000, "runs finished");

    // 7. Open interactively adds exactly one tab
    await page.click(`${row("nightly")} .rt-run`);
    await page.waitForSelector(".rt-runview .rt-rv-open");
    await page.waitForFunction(() => /reply to: say hello|working/.test(document.querySelector(".rt-runview .rt-log")?.textContent || ""), null, { timeout: 10000 }).catch(() => {});
    await page.screenshot({ path: shot("routines-runview.png") });
    const tabsBefore = await page.$$eval(".tab", (e) => e.length);
    await page.dblclick(".rt-runview .rt-rv-open");
    await waitFor(async () => (await page.$$eval(".tab", (e) => e.length)) > tabsBefore, 10000, "tab");
    await sleep(1200);
    ok((await page.$$eval(".tab", (e) => e.length)) === tabsBefore + 1, "Open interactively adds exactly one tab");
    ok((await A.get("/api/sessions")).filter((s) => s.name === "helper").length === 1, "and one session for the agent");
    if (await page.$(".rt-runview")) await page.click(".rt-runview .rt-rv-close");
    await page.waitForFunction(() => !document.querySelector(".rt-runview"));

    // 8. Pause all automation: banner, Run now disabled; unpause restores
    ok(await page.isHidden("#routines-panel .rt-banner"), "no banner while running normally");
    await page.check("#routines-panel .rt-pause");
    await page.waitForSelector("#routines-panel .rt-banner:not([hidden])");
    await waitFor(async () => (await A.get("/api/automation")).paused === true, 5000, "paused");
    ok(await page.isDisabled(`${row("nightly")} [data-act="run"]`), "paused: banner shown and Run now disabled");
    await page.screenshot({ path: shot("routines-paused.png") });
    await page.uncheck("#routines-panel .rt-pause");
    await page.waitForSelector("#routines-panel .rt-banner", { state: "hidden" });
    await waitFor(async () => (await A.get("/api/automation")).paused === false, 5000, "unpaused");
    ok(await page.isEnabled(`${row("nightly")} [data-act="run"]`), "unpaused: banner hidden and Run now enabled again");
    await page.fill("#routines-panel .rt-cap", "5");
    await page.press("#routines-panel .rt-cap", "Enter");
    await waitFor(async () => (await A.get("/api/automation")).maxDailyCostUsd === 5, 5000, "cap");
    ok(true, "daily cost cap field saves");

    // 9. Hostile name renders as text (folder target too), edit and delete use in-app dialogs
    await page.click("#routines-panel .rt-new");
    await page.waitForSelector(".rt-dialog .rt-name");
    await page.fill(".rt-dialog .rt-name", HOSTILE);
    await page.fill(".rt-dialog .rt-prompt", "x");
    await page.selectOption(".rt-dialog .rt-target-kind", "folder");
    await page.fill(".rt-dialog .rt-folder", work);
    await page.click('.rt-dialog .rt-preset[data-preset="hourly"]');
    await page.click(".rt-dialog .rt-save");
    await waitFor(async () => (await rowNames(page)).includes(HOSTILE), 10000, "hostile row");
    ok(!(await page.$("#routines-panel img")) && !(await page.$("#routines-panel .rt-row b")), "hostile name is rendered as text, not markup");
    const host = (await A.get("/api/routines")).find((r) => r.name === HOSTILE);
    ok(host && host.target.kind === "folder" && host.conversation === "fresh", "folder target stored with a fresh conversation");
    await page.click(`#routines-panel .rt-row[data-id="${host.id}"] [data-act="edit"]`);
    await page.waitForSelector(".rt-dialog .rt-save");
    ok((await page.inputValue(".rt-dialog .rt-name")) === HOSTILE && (await page.inputValue(".rt-dialog .rt-folder")) === work, "edit dialog is filled from the routine");
    await page.fill(".rt-dialog .rt-prompt", "edited prompt");
    await page.click(".rt-dialog .rt-save");
    await waitFor(async () => (await A.get("/api/routines")).find((r) => r.id === host.id)?.prompt === "edited prompt", 5000, "edit");
    ok(true, "Edit saves the routine");
    await page.click(`#routines-panel .rt-row[data-id="${host.id}"] .rt-toggle`);
    await waitFor(async () => (await A.get("/api/routines")).find((r) => r.id === host.id)?.enabled === false, 5000, "toggle");
    ok(true, "the enable toggle disables the routine");
    await page.click(`#routines-panel .rt-row[data-id="${host.id}"] [data-act="delete"]`);
    await page.waitForSelector(".rt-dialog .rt-confirm-ok");
    await page.click(".rt-dialog .rt-confirm-ok");
    await waitFor(async () => !(await A.get("/api/routines")).some((r) => r.id === host.id), 8000, "delete");
    await waitFor(async () => !(await rowNames(page)).includes(HOSTILE), 8000, "row gone");
    ok(true, "Delete asks in-app and removes the routine");
    await page.screenshot({ path: shot("routines.png") });
    ok(await page.evaluate(() => { const p = document.getElementById("routines-panel"); return p.scrollWidth <= p.clientWidth; }), "no horizontal overflow in the panel");

    // 10. Slow run: log shows the first line while running; Cancel -> cancelled; polling stops on close and on hide
    const pageB = await newPage(B);
    const slow = await B.post("/api/routines", { name: "slow", cron: "preset:daily", prompt: "go slowly", target: { kind: "agent", agentId: agentB.id } });
    await pageB.click("#ab-routines");
    await pageB.waitForSelector(row("slow"));
    await pageB.click(`${row("slow")} [data-act="run"]`);
    await pageB.waitForSelector(`${row("slow")} .rt-run`, { timeout: 15000 });
    await pageB.click(`${row("slow")} .rt-run`);
    await pageB.waitForSelector(".rt-runview .rt-log");
    await pageB.waitForFunction(() => /SLOW-FIRST-LINE/.test(document.querySelector(".rt-runview .rt-log")?.textContent || ""), null, { timeout: 30000 });
    const statusNow = (await pageB.textContent(".rt-runview .rt-rv-status")).trim();
    ok(/running|queued/.test(statusNow), "the log shows the first line while the run is still " + statusNow);
    await pageB.screenshot({ path: shot("routines-slow.png") });
    const mine = (r) => r.url.startsWith(`http://127.0.0.1:${B.port}/`); // the first page keeps polling its own server
    const logReqs = () => requests.filter((r) => mine(r) && /\/api\/runs\/[^/]+\/log/.test(r.url)).length;
    const l0 = logReqs(); await sleep(4500);
    ok(logReqs() - l0 >= 1 && logReqs() - l0 <= 4, "the log is re-polled about every 2 s while running (" + (logReqs() - l0) + " requests in 4.5 s)");
    await pageB.click(".rt-runview .rt-rv-cancel");
    await pageB.waitForFunction(() => /cancelled/.test(document.querySelector(".rt-runview .rt-rv-status")?.textContent || ""), null, { timeout: 20000 });
    ok((await runsOf(B, slow.id))[0].status === "cancelled", "Cancel ends the slow run as cancelled");
    ok(await pageB.isHidden(".rt-runview .rt-rv-cancel") || await pageB.isDisabled(".rt-runview .rt-rv-cancel"), "Cancel is gone once the run is finished");
    const l1 = logReqs(); await sleep(3500);
    ok(logReqs() === l1, "no more log requests once the run finished");
    await pageB.click(".rt-runview .rt-rv-close");

    // Run again, open its view, close it mid-run: the log polling stops
    await pageB.click(`${row("slow")} [data-act="run"]`);
    await waitFor(async () => (await runsOf(B, slow.id)).some((r) => r.status === "running"), 15000, "second slow run");
    await pageB.waitForFunction((sel) => [...document.querySelectorAll(sel + " .rt-run .rt-badge")].some((b) => /running/.test(b.textContent)), row("slow"), { timeout: 15000 });
    await pageB.click(`${row("slow")} .rt-run .rt-badge.st-running`);
    await pageB.waitForSelector(".rt-runview .rt-log");
    await sleep(1000);
    await pageB.click(".rt-runview .rt-rv-close");
    const l2 = logReqs(); await sleep(4000);
    ok(logReqs() === l2, "closing the run view stops the log polling");
    const listReqs = () => requests.filter((r) => mine(r) && /\/api\/(routines|automation)/.test(r.url)).length;
    await pageB.click("#ab-routines"); // hides the panel
    await pageB.waitForSelector("#routines-panel.active", { state: "hidden" });
    await sleep(500);
    const p0 = listReqs(); await sleep(4500);
    ok(listReqs() === p0, "hiding the panel stops the list polling" + (listReqs() === p0 ? "" : ": " + requests.filter((r) => mine(r) && /\/api\/(routines|automation)/.test(r.url)).slice(p0).map((r) => r.url.replace(/^.*\/api/, "").replace(/\?token=T&?/, "?")).join(" ")));
    // cleanup: cancel the running run via the API so the fake claude does not outlive the test
    for (const r of await runsOf(B, slow.id)) if (r.status === "running" || r.status === "queued") await B.post(`/api/runs/${r.id}/cancel`);

    ok(errors.length === 0, "no page errors / window dialogs" + (errors.length ? ": " + errors.join(" | ") : ""));
  } catch (e) {
    console.log("FAIL exception:", e.message.split("\n").slice(0, 3).join(" | "), "@", (e.stack.match(/routines\.e2e\.js:\d+/) || [""])[0]);
    process.exitCode = 1;
    for (const pg of browser.contexts().flatMap((c) => c.pages()).slice(0, 2)) await pg.screenshot({ path: shot("routines-fail-" + Math.random().toString(36).slice(2, 6) + ".png") }).catch(() => {});
    if (errors.length) console.log("page errors: " + errors.join(" | "));
  } finally {
    await browser.close();
    for (const s of [A, B]) { try { s.proc.kill(); } catch {} }
    await sleep(500);
    for (const d of [work, ...A.dirs, ...B.dirs]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  }
})();
