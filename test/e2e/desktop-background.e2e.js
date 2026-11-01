// Usage: node desktop-background.e2e.js <repoDir> — in the desktop app, closing the window quits agenv, except while the
// ngrok tunnel is up: then the server stays alive in the tray. A fake `ngrok` on PATH stands in for the real one.
const { chromium } = require("playwright-core");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const { repoDir } = require("./lib");
const repo = repoDir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

// Electron is driven over the DevTools port; closing the page closes the window.
async function launch(home, bin) {
  const cdp = 21000 + Math.floor(Math.random() * 20000);
  const proc = spawn(require("electron"), [path.join(repo, "electron.js"), "--remote-debugging-port=" + cdp], {
    env: { ...process.env, AGENV_HOME: home, PORT: String(42000 + Math.floor(Math.random() * 20000)), PATH: bin + path.delimiter + process.env.PATH },
    cwd: repo, stdio: "ignore", windowsHide: true });
  let browser = null;
  for (let i = 0; i < 60 && !browser; i++) { await sleep(500); try { browser = await chromium.connectOverCDP("http://127.0.0.1:" + cdp); } catch {} }
  if (!browser) throw new Error("could not reach the desktop app");
  let page = null;
  for (let i = 0; i < 40 && !page; i++) { page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("token=")); if (!page) await sleep(500); }
  if (!page) throw new Error("no agenv window");
  return { proc, browser, win: page, exited: new Promise((r) => proc.on("exit", r)) };
}
const alive = (port) => new Promise((res) => http.get({ host: "127.0.0.1", port, path: "/" }, (r) => { r.resume(); res(true); }).on("error", () => res(false)));

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenv-desk-e2e-"));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "agenv-fake-ngrok-"));
  fs.writeFileSync(path.join(bin, "fake-ngrok.js"), "setInterval(()=>{},1000)");
  fs.writeFileSync(path.join(bin, "ngrok.cmd"), `@echo off\r\n"${process.execPath}" "${path.join(bin, "fake-ngrok.js")}"\r\n`);
  fs.writeFileSync(path.join(bin, "ngrok"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, "fake-ngrok.js")}"\n`, { mode: 0o755 });

  // 1. no tunnel: closing the window quits
  let app = await launch(home, bin);
  const port1 = new URL(app.win.url()).port;
  await app.win.close();
  await Promise.race([app.exited, sleep(8000)]);
  await sleep(500);
  ok(!(await alive(port1)), "without a tunnel, closing the window quits agenv");
  try { app.proc.kill(); } catch {}

  // 2. tunnel up: closing the window keeps the server
  app = await launch(home, bin);
  const win = app.win;
  const u = new URL(win.url()); const port = u.port, token = u.searchParams.get("token");
  const start = win.evaluate(({ token }) => fetch("/api/ngrok/start?token=" + token, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then((r) => r.json()), { token });
  await Promise.race([start, sleep(6000)]);
  const st = await fetch(`http://127.0.0.1:${port}/api/ngrok/status?token=${token}`).then((r) => r.json());
  ok(st.running === true, "the fake tunnel is running");
  await win.close();
  await sleep(2500);
  ok(await alive(port), "with a tunnel up, closing the window leaves the server running");
  const stillTunnel = await fetch(`http://127.0.0.1:${port}/api/ngrok/status?token=${token}`).then((r) => r.json());
  ok(stillTunnel.running === true, "and the tunnel with it");
  const tunnelStop = await fetch(`http://127.0.0.1:${port}/api/ngrok/stop?token=${token}`, { method: "POST" });
  ok(tunnelStop.ok, "the tunnel is stopped from the web");
  await sleep(33000);
  ok(!(await alive(port)), "once the tunnel is stopped, the background app quits by itself");
  try { app.proc.kill(); } catch {}
})().catch((e) => { console.log("FAIL " + e.message); process.exitCode = 1; });
