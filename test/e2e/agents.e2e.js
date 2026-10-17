// Usage: node agents.e2e.js [repoDir] — drives the Agents sidebar panel in Chromium against a fake claude.
// Nothing here calls the real Claude: AGENV_CLAUDE_BIN points at the fixture CLI and a no-op `claude` is first on PATH.
const { chromium } = require("playwright-core");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), net = require("net"), http = require("http");

const { repoDir, shot, chromePath } = require("./lib");
const repo = repoDir();
const exe = chromePath();
const FAKE = path.join(repo, "test", "fixtures", "fake-claude-cli.js");
const SMALL = "0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e", BIG = "11111111-2222-4333-8444-555555555555";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

function stubClaudeDir() {
  const dir = tmp("agenv-e2e-stub-");
  fs.writeFileSync(path.join(dir, "claude.cmd"), "@echo off\r\n");
  fs.writeFileSync(path.join(dir, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return dir;
}

async function boot(mode, work) {
  const home = tmp("agenv-agents-e2e-"), state = tmp("agenv-agents-state-"), stub = stubClaudeDir();
  const dir = path.join(home, ".claude", "projects", "C--proj");
  fs.mkdirSync(dir, { recursive: true });
  const line = (id, text) => JSON.stringify({ type: "user", cwd: work, sessionId: id, message: { role: "user", content: text } }) + "\n";
  fs.writeFileSync(path.join(dir, SMALL + ".jsonl"), line(SMALL, "refactor the widget parser"));
  fs.writeFileSync(path.join(dir, BIG + ".jsonl"), line(BIG, "x".repeat(500 * 1024)));
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(repo, "server.js"), "--port", port, "--host", "127.0.0.1", "--token", "T", "--no-qr"], {
    env: { ...process.env, HOME: home, USERPROFILE: home, AGENV_CLAUDE_BIN: FAKE, FAKE_CLAUDE_STATE: state, FAKE_CLAUDE_MODE: mode, PATH: stub + path.delimiter + process.env.PATH },
    stdio: "ignore", windowsHide: true,
  });
  const get = (p) => new Promise((res, rej) => http.get(`http://127.0.0.1:${port}${p}?token=T`, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on("error", rej));
  for (let i = 0; ; i++) {
    try { await get("/api/agents"); break; } catch { if (i > 60) throw new Error("server did not start"); await sleep(250); }
  }
  return { port, proc, get, dirs: [home, state, stub] };
}

(async () => {
  const work = tmp("agenv-agents-work-");
  const A = await boot("ok", work);
  const B = await boot("fail", work);
  const browser = await chromium.launch({ executablePath: exe });
  const errors = [];
  const ok = (cond, msg) => { console.log((cond ? "PASS " : "FAIL ") + msg); if (!cond) process.exitCode = 1; };
  const waitFor = async (fn, ms, what) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error("timeout: " + what); await sleep(200); } };
  const newPage = async (srv) => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", async (d) => { errors.push("window." + d.type() + " used: " + d.message()); await d.accept(); });
    await page.goto(`http://127.0.0.1:${srv.port}/?token=T`);
    await page.click("text=Session 0");
    await page.waitForSelector("#workspace-area .xterm");
    await page.waitForSelector("#ab-agents");
    return page;
  };
  const agentsOf = (srv) => srv.get("/api/agents");
  const fillDialog = async (page, f) => {
    if (f.name != null) await page.fill(".ag-dialog .ag-name", f.name);
    if (f.specialty != null) await page.fill(".ag-dialog .ag-specialty", f.specialty);
    if (f.cwd != null) await page.fill(".ag-dialog .ag-cwd", f.cwd);
  };
  const toasts = (page) => page.$$eval(".toast-error .toast-msg", (els) => els.map((e) => e.textContent));
  const rowNames = (page) => page.$$eval("#agents-panel .ag-row .ag-name-text", (els) => els.map((e) => e.textContent));

  try {
    const page = await newPage(A);

    // 1. The panel exists and starts empty
    await page.click("#ab-agents");
    await page.waitForSelector("#agents-panel.active .ag-new");
    await page.waitForFunction(() => /No agents yet/.test(document.querySelector("#agents-panel .ag-empty-text")?.textContent || ""));
    ok((await rowNames(page)).length === 0, "Agents panel opens with an empty list");

    // 2. Blank agent
    await page.click("#agents-panel .ag-new");
    await page.waitForSelector(".ag-dialog");
    await fillDialog(page, { name: "blank-one", specialty: "docs <b>writer</b>", cwd: work });
    await page.click(".ag-dialog .ag-create");
    await page.waitForSelector('#agents-panel .ag-row[data-name="blank-one"]');
    ok(true, "blank agent is listed");
    ok(!(await page.$("#agents-panel .ag-row b")), "specialty is escaped in the list row");
    ok((await agentsOf(A)).length === 1, "blank agent exists on the server");

    // 3. From conversation (fork): the estimate shows before anything runs
    await page.click("#agents-panel .ag-new");
    await page.click('.ag-dialog [data-kind="conversation"]');
    await page.selectOption(".ag-dialog .ag-source", SMALL);
    await page.waitForSelector(".ag-dialog .ag-estimate .ag-est-tokens");
    const est = await page.textContent(".ag-dialog .ag-estimate");
    ok(/tokens/.test(est) && /\$/.test(est) && /upper-bound/.test(est), "fork shows tokens, cost and the estimate basis: " + est.trim().slice(0, 90));
    ok(!(await page.$(".ag-dialog .ag-compact-hint")), "small conversation: no compact recommendation");
    await page.selectOption(".ag-dialog .ag-source", BIG);
    await page.waitForSelector(".ag-dialog .ag-compact-hint");
    ok(/compact/i.test(await page.textContent(".ag-dialog .ag-compact-hint")), "large conversation: compact is recommended");
    await page.selectOption(".ag-dialog .ag-source", SMALL);
    await page.waitForFunction(() => !document.querySelector(".ag-dialog .ag-compact-hint"));
    await fillDialog(page, { name: "forked-one", specialty: "widgets", cwd: work });
    ok((await agentsOf(A)).length === 1, "nothing was created before the click");
    await page.click(".ag-dialog .ag-create");
    await page.waitForSelector('#agents-panel .ag-row[data-name="forked-one"]', { timeout: 20000 });
    const forked = (await agentsOf(A)).find((a) => a.name === "forked-one");
    ok(forked && forked.origin.kind === "fork" && forked.conversationId && forked.conversationId !== SMALL, "forked agent has its own conversation");
    ok(!(await page.$(".ag-dialog")), "dialog closes after creation");

    // 4. Distill to a skill: exact path shown, explicit confirm required
    await page.click("#agents-panel .ag-new");
    await page.click('.ag-dialog [data-kind="conversation"]');
    await page.selectOption(".ag-dialog .ag-source", SMALL);
    await fillDialog(page, { name: "skilled", specialty: "skills", cwd: work });
    await page.selectOption(".ag-dialog .ag-mode", "distill-skill");
    await page.waitForSelector(".ag-dialog .ag-target");
    const target = (await page.textContent(".ag-dialog .ag-target-path")).trim();
    const expected = path.join(work, ".claude", "skills", "skilled", "SKILL.md");
    ok(target.replace(/\\/g, "/") === expected.replace(/\\/g, "/"), "distill-skill shows the exact target path: " + target);
    ok(await page.isDisabled(".ag-dialog .ag-create"), "Create is disabled until the write is confirmed");
    await page.check(".ag-dialog .ag-confirm");
    ok(await page.isEnabled(".ag-dialog .ag-create"), "ticking the confirm enables Create");
    await page.screenshot({ path: shot("agents-dialog.png") });
    await page.click(".ag-dialog .ag-create");
    await page.waitForSelector('#agents-panel .ag-row[data-name="skilled"]', { timeout: 20000 });
    ok(fs.existsSync(expected), "skill file written to the shown path");

    // 5. Open terminal adds a session tab
    const tabsBefore = await page.$$eval(".tab", (e) => e.length);
    await page.click('#agents-panel .ag-row[data-name="blank-one"] [data-act="open"]');
    await waitFor(async () => (await page.$$eval(".tab", (e) => e.length)) > tabsBefore, 10000, "tab");
    ok(true, "Open terminal adds a session tab");
    ok((await A.get("/api/sessions")).some((s) => s.name === "blank-one"), "the session carries the agent name");
    // Opening again (also a double click) reuses the open session and tab: no second session, no second tab
    const openBtn = '#agents-panel .ag-row[data-name="blank-one"] [data-act="open"]';
    const sessCount = (await A.get("/api/sessions")).length;
    await page.click(openBtn);
    await page.click(openBtn, { clickCount: 2 }).catch(() => {});
    await sleep(1500);
    ok((await A.get("/api/sessions")).filter((x) => x.name === "blank-one").length === 1 && (await A.get("/api/sessions")).length === sessCount, "Open terminal again creates no second session");
    ok((await page.$$eval(".tab", (e) => e.length)) === tabsBefore + 1, "Open terminal again creates no second tab");

    // 6. Edit, duplicate, delete with in-app dialogs
    await page.click('#agents-panel .ag-row[data-name="blank-one"] [data-act="edit"]');
    await page.waitForSelector(".ag-dialog .ag-specialty");
    await page.fill(".ag-dialog .ag-specialty", "edited");
    await page.click(".ag-dialog .ag-save");
    await waitFor(async () => (await agentsOf(A)).find((a) => a.name === "blank-one")?.specialty === "edited", 5000, "edit");
    ok(true, "Edit saves the profile");
    await page.click('#agents-panel .ag-row[data-name="forked-one"] [data-act="duplicate"]');
    await page.waitForSelector(".ag-dialog .ag-create");
    await page.click(".ag-dialog .ag-create");
    await page.waitForSelector('#agents-panel .ag-row[data-name="forked-one-copy"]', { timeout: 20000 });
    ok(true, "Duplicate lists the copy");
    await page.click('#agents-panel .ag-row[data-name="forked-one-copy"] [data-act="delete"]');
    await page.waitForSelector(".ag-dialog .ag-confirm-ok");
    await page.click(".ag-dialog .ag-confirm-ok");
    await waitFor(async () => !(await agentsOf(A)).some((a) => a.name === "forked-one-copy"), 5000, "delete");
    ok(true, "Delete asks in-app and removes the agent");

    // 7. Failed creation: bad folder and duplicate name -> toast, no new row
    const before = (await agentsOf(A)).length;
    await waitFor(async () => (await rowNames(page)).length === before, 5000, "list settled");
    await page.click("#agents-panel .ag-new");
    await fillDialog(page, { name: "nowhere", specialty: "x", cwd: path.join(work, "does-not-exist") });
    await page.click(".ag-dialog .ag-create");
    await waitFor(async () => (await toasts(page)).length > 0, 5000, "toast");
    ok((await rowNames(page)).length === before && !(await agentsOf(A)).some((a) => a.name === "nowhere"), "bad folder: toast shown and no row");
    await page.fill(".ag-dialog .ag-cwd", work);
    await page.fill(".ag-dialog .ag-name", "blank-one");
    const t0 = (await toasts(page)).length;
    await page.click(".ag-dialog .ag-create");
    await waitFor(async () => (await toasts(page)).length > t0, 5000, "dup toast");
    ok((await rowNames(page)).filter((n) => n === "blank-one").length === 1, "duplicate name: toast shown and no second row");
    await page.keyboard.press("Escape");

    // 7b. Overwrite: an existing briefing is only replaced after an explicit overwrite confirm
    const brief = path.join(work, ".claude", "agenv-briefings", "brief.md");
    fs.mkdirSync(path.dirname(brief), { recursive: true });
    fs.writeFileSync(brief, "mine");
    await page.click("#agents-panel .ag-new");
    await page.click('.ag-dialog [data-kind="conversation"]');
    await page.selectOption(".ag-dialog .ag-source", SMALL);
    await fillDialog(page, { name: "brief", specialty: "b", cwd: work });
    await page.selectOption(".ag-dialog .ag-mode", "distill-briefing");
    await page.check(".ag-dialog .ag-confirm");
    await page.click(".ag-dialog .ag-create");
    await page.waitForSelector(".ag-dialog .ag-overwrite-row:not([hidden])");
    ok(fs.readFileSync(brief, "utf8") === "mine" && !(await agentsOf(A)).some((a) => a.name === "brief"), "existing file: refused, file untouched, overwrite option shown");
    ok(await page.isDisabled(".ag-dialog .ag-create"), "Create stays disabled until overwrite is ticked");
    await page.selectOption(".ag-dialog .ag-mode", "distill-skill");
    ok(await page.isHidden(".ag-dialog .ag-overwrite-row"), "changing the target resets the overwrite option");
    await page.selectOption(".ag-dialog .ag-mode", "distill-briefing");
    await page.check(".ag-dialog .ag-confirm");
    await page.click(".ag-dialog .ag-create");
    await page.waitForSelector(".ag-dialog .ag-overwrite-row:not([hidden])");
    await page.check(".ag-dialog .ag-overwrite");
    await page.click(".ag-dialog .ag-create");
    await page.waitForSelector('#agents-panel .ag-row[data-name="brief"]', { timeout: 20000 });
    ok(fs.readFileSync(brief, "utf8") !== "mine", "overwrite confirmed: file replaced and agent listed");

    // 8. Claude search: Fork conversation opens a terminal, Make agent prefills the dialog
    await page.click("#ab-claude");
    await page.waitForSelector(`#claude-search-panel .cs-card[data-id="${SMALL}"]`);
    await page.click(`#claude-search-panel .cs-card[data-id="${SMALL}"]`, { button: "right" });
    ok(await page.locator(".ctx-menu .ctx-item", { hasText: "Fork conversation" }).count() > 0
      && await page.locator(".ctx-menu .ctx-item", { hasText: "Make agent from this" }).count() > 0, "search card context menu has both actions");
    await page.keyboard.press("Escape");
    const sess0 = (await A.get("/api/sessions")).length;
    await page.click(`#claude-search-panel .cs-card[data-id="${SMALL}"] [data-act="fork"]`, { clickCount: 2 });
    await waitFor(async () => (await A.get("/api/sessions")).length > sess0, 10000, "fork session");
    await sleep(1500);
    ok((await A.get("/api/sessions")).length === sess0 + 1, "double-clicking Fork creates exactly one session");
    await page.click(`#claude-search-panel .cs-card[data-id="${SMALL}"] [data-act="make-agent"]`);
    await page.waitForSelector(".ag-dialog");
    await page.waitForFunction((id) => document.querySelector(".ag-dialog .ag-source")?.value === id, SMALL).catch(() => {});
    ok((await page.inputValue(".ag-dialog .ag-source")) === SMALL, "Make agent from this prefills the source conversation");
    await page.keyboard.press("Escape");

    // 9. Session context menu entry
    await page.click("#ab-sessions");
    await page.waitForSelector('#sessions-panel .sp-session[data-sid="0"]');
    await page.click('#sessions-panel .sp-session[data-sid="0"]', { button: "right" });
    ok(await page.locator(".ctx-menu .ctx-item", { hasText: "Make agent from this session" }).count() > 0, "session context menu has Make agent from this session");
    await page.keyboard.press("Escape");
    await page.click("#ab-agents");
    await page.waitForSelector("#agents-panel.active");
    await page.screenshot({ path: shot("agents.png") });

    // 10. A claude that fails: toast, no row, nothing left behind
    const pageB = await newPage(B);
    await pageB.click("#ab-agents");
    await pageB.click("#agents-panel .ag-new");
    await pageB.click('.ag-dialog [data-kind="conversation"]');
    await pageB.selectOption(".ag-dialog .ag-source", SMALL);
    await fillDialog(pageB, { name: "doomed", specialty: "x", cwd: work });
    await pageB.click(".ag-dialog .ag-create");
    await waitFor(async () => (await toasts(pageB)).length > 0, 20000, "failure toast");
    ok((await rowNames(pageB)).length === 0 && (await agentsOf(B)).length === 0, "failed fork: toast shown and no agent row");
    await pageB.screenshot({ path: shot("agents-fail.png") });

    ok(errors.length === 0, "no page errors / prompts" + (errors.length ? ": " + errors.join(" | ") : ""));
  } catch (e) {
    console.log("FAIL exception:", e.message.split("\n").slice(0, 3).join(" | "), "@", (e.stack.match(/agents\.e2e\.js:\d+/) || [""])[0]);
    process.exitCode = 1;
    const pg = browser.contexts()[0]?.pages()[0];
    if (pg) await pg.screenshot({ path: shot("agents-fail.png") }).catch(() => {});
    if (errors.length) console.log("page errors: " + errors.join(" | "));
  } finally {
    await browser.close();
    for (const s of [A, B]) { try { s.proc.kill(); } catch {} }
    await sleep(500);
    for (const d of [work, ...A.dirs, ...B.dirs]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  }
})();
