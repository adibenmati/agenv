// Usage: node messages.e2e.js <repoDir> — the Messages panel: pick several sessions to message, run a command in many
// sessions, and ask an agent (right-click) to message several others. Agent CLIs are a fake `codex` on PATH.
const { chromium } = require("playwright-core");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), net = require("net"), http = require("http");

const { repoDir, chromePath } = require("./lib");
const repo = repoDir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenv-messages-e2e-"));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "agenv-messages-bin-"));
  const out = path.join(home, "codex-input.txt");
  fs.writeFileSync(path.join(bin, "codex.js"),
    `const fs = require("fs");\nconsole.log(">_ OpenAI Codex (v0.0.0)");\nprocess.stdin.setEncoding("utf8");\nlet buf = "";\n` +
    `process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.search(/[\\r\\n]/)) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l) fs.appendFileSync(${JSON.stringify(out)}, l + "\\n"); } });\nsetInterval(() => {}, 1000);\n`);
  fs.writeFileSync(path.join(bin, "codex.cmd"), `@echo off\r\nnode "%~dp0codex.js"\r\n`);
  fs.writeFileSync(path.join(bin, "codex"), `#!/bin/sh\nexec node "$(dirname "$0")/codex.js"\n`, { mode: 0o755 });

  const port = await freePort();
  const srv = spawn(process.execPath, [path.join(repo, "server.js"), "--port", port, "--host", "127.0.0.1", "--token", "T", "--no-qr"],
    { env: { ...process.env, HOME: home, USERPROFILE: home, PATH: bin + path.delimiter + process.env.PATH }, stdio: "ignore", windowsHide: true });
  const call = (method, p, body) => new Promise((res, rej) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, method, path: p + "?token=T", headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} },
      (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => { try { res(JSON.parse(b)); } catch { res(b); } }); });
    req.on("error", rej); req.end(data);
  });
  const lines = () => (fs.existsSync(out) ? fs.readFileSync(out, "utf8").trim().split("\n").filter(Boolean) : []);
  for (let i = 0; i < 100; i++) { try { await call("GET", "/api/sessions"); break; } catch { await sleep(200); } }

  const browser = await chromium.launch({ executablePath: chromePath() });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", async (d) => { await d.accept(); });
  const ok = (cond, msg) => { console.log((cond ? "PASS " : "FAIL ") + msg); if (!cond) process.exitCode = 1; };

  try {
    await call("POST", "/api/sessions", { name: "cx1", command: "codex" });
    await call("POST", "/api/sessions", { name: "cx2", command: "codex" });
    await sleep(4000);   // both fake codex processes are up and quiet

    await page.goto(`http://127.0.0.1:${port}/?token=T`);
    await page.click("text=Session 0");
    await page.waitForSelector("#workspace-area .xterm");
    await page.click("#ab-messages");
    await page.waitForSelector("#messages-panel .ms-run");

    const text = await page.$eval("#messages-panel", (e) => e.innerText);
    ok(/Run a command in many sessions/i.test(text), "the panel offers 'Run a command in many sessions'");
    ok(await page.$eval("#messages-panel .ms-target", (e) => e.options[0].text === "All sessions"), "the target list starts with All sessions");
    ok((await page.$$("#messages-panel .ms-pick")).length >= 3, "recipients are a list of the current sessions to tick");

    // 1. tick both agents (not Session 0) and message them together
    for (const name of ["cx1", "cx2"]) await page.locator("#messages-panel .ms-peer", { hasText: name }).locator("input").check();
    await page.fill("#messages-panel .ms-text", "hello both");
    await page.click("#messages-panel .ms-send");
    const t0 = Date.now();
    while (lines().filter((l) => l.includes("hello both")).length < 2 && Date.now() - t0 < 20000) await sleep(300);
    const got = lines().filter((l) => l.includes("[agenv message from you] hello both"));
    ok(got.length === 2, "one send reached both ticked sessions (" + got.length + " lines)");

    // 2. ask cx1 (right-click) to message cx2 through agenv
    await page.click("#ab-sessions");
    await page.waitForSelector("#sessions-panel .sp-session");
    await page.locator("#sessions-panel .sp-session", { hasText: "cx1" }).click({ button: "right" });
    await page.locator(".ctx-menu .ctx-item", { hasText: "Ask this agent to message another session" }).click();
    await page.waitForSelector(".ask-picks");
    const choices = await page.$$eval(".ask-picks label", (ls) => ls.map((l) => l.innerText.trim()));
    ok(!choices.some((c) => c.startsWith("cx1")) && choices.some((c) => c.startsWith("cx2")), "the dialog lists the other open sessions to tick: " + choices.join(" | "));
    await page.locator(".ask-picks label", { hasText: "cx2" }).locator("input").check();
    await page.fill(".ask-msg", "status please");
    await page.click(".ask-btn.primary");
    const t1 = Date.now();
    while (!lines().some((l) => l.includes('agenv send "cx2" "status please"')) && Date.now() - t1 < 20000) await sleep(300);
    ok(lines().some((l) => l.includes('agenv send "cx2" "status please"')), "cx1 was told to run: agenv send \"cx2\" \"status please\"");

    // 3. run a command in many sessions
    await page.click("#ab-messages");
    await page.waitForSelector("#messages-panel .ms-run");
    await page.fill("#messages-panel .ms-cmd", "echo agenv-broadcast-ok");
    await page.uncheck("#messages-panel .ms-agents-only");
    await page.click("#messages-panel .ms-run");
    await page.click("#ab-explorer").catch(() => {});
    await page.waitForFunction(() => [...document.querySelectorAll(".xterm-rows")].some((e) => e.innerText.includes("agenv-broadcast-ok")), null, { timeout: 15000 });
    ok(true, "the command was typed into an open terminal and ran");
  } catch (e) {
    console.log("FAIL " + e.message); process.exitCode = 1;
  } finally {
    ok(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await browser.close();
    srv.kill();
  }
})();
