// Usage: node sessions-batch.e2e.js <repoDir> — folder colours reach sessions and tabs, Resume all / Message all / relay menu items, font sizes
const { chromium } = require("playwright-core");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), net = require("net"), http = require("http");

const { repoDir, chromePath } = require("./lib");
const repo = repoDir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenv-sbatch-e2e-"));
  const port = await freePort();
  const srv = spawn(process.execPath, [path.join(repo, "server.js"), "--port", port, "--host", "127.0.0.1", "--token", "T", "--no-qr"],
    { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: "ignore", windowsHide: true });
  const call = (method, p, body) => new Promise((res, rej) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, method, path: p + "?token=T", headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} },
      (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => { try { res(JSON.parse(b)); } catch { res(b); } }); });
    req.on("error", rej); req.end(data);
  });
  await sleep(1500);

  const browser = await chromium.launch({ executablePath: chromePath() });
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const ok = (cond, msg) => { console.log((cond ? "PASS " : "FAIL ") + msg); if (!cond) process.exitCode = 1; };

  try {
    await call("PUT", "/api/session-groups", { groups: [{ path: "ops", color: "#f85149" }, { path: "ops/db", color: "" }] });
    const second = await call("POST", "/api/sessions", { name: "dbsession" });
    await call("PUT", "/api/sessions/0", { group: "ops" });
    await call("PUT", "/api/sessions/" + second.id, { group: "ops/db" });

    await page.goto(`http://127.0.0.1:${port}/?token=T`);
    await page.click("text=Session 0");
    await page.waitForSelector("#workspace-area .xterm");
    await page.click("#ab-sessions");
    await page.waitForSelector("#sessions-panel .sp-session");

    const colors = await page.$$eval("#sessions-panel .sp-session", (els) => els.map((e) => e.style.getPropertyValue("--gc")));
    ok(colors.length === 2 && colors.every((c) => c.trim() === "#f85149"), "sessions in a coloured folder and in its uncoloured subfolder both get the folder colour: " + colors.join(","));
    ok(await page.$eval("#sessions-panel [data-act='resume-all']", (e) => !!e), "header has Resume all");
    ok(await page.$eval("#sessions-panel [data-act='message-all']", (e) => !!e), "header has Message all");

    const badge = await page.$eval("#tab-bar .tab-num", (e) => getComputedStyle(e).backgroundColor);
    ok(badge === "rgb(248, 81, 73)", "the tab badge takes the folder colour: " + badge);

    // group menu
    await page.click("#sessions-panel .sp-group-header >> nth=0", { button: "right" });
    const menu = await page.$$eval(".ctx-menu .ctx-item", (els) => els.map((e) => e.textContent.trim()));
    ok(menu.some((t) => /^Resume All/.test(t)) && menu.some((t) => /^Message All/.test(t)), "group menu offers Resume All and Message All: " + menu.join(" | "));
    await page.keyboard.press("Escape");
    await page.mouse.click(700, 500);

    // session menu
    await page.click("#sessions-panel .sp-session >> nth=0", { button: "right" });
    const smenu = await page.$$eval(".ctx-menu .ctx-item", (els) => els.map((e) => e.textContent.trim()));
    ok(smenu.some((t) => /Ask this agent to message another session/.test(t)), "session menu offers 'Ask this agent to message another session'");
    await page.keyboard.press("Escape");
    await page.mouse.click(700, 500);

    // Resume all (nothing asleep, nothing to resume: it must answer, not fail)
    await page.click("#sessions-panel [data-act='resume-all']");
    await page.waitForSelector(".toast, .notif-toast, [class*='toast']", { timeout: 5000 }).catch(() => {});
    ok(errors.length === 0, "no page errors after Resume all");

    // fonts: terminal text and the left pane
    await page.evaluate(() => { document.getElementById("ab-settings").click(); });
    const fontOpts = await page.$$eval("#fontsize-select option", (os) => os.map((o) => o.value));
    ok(fontOpts.includes("24") && fontOpts.includes("32"), "terminal font size goes above 16px: " + fontOpts.join(","));
    await page.selectOption("#fontsize-select", "24");
    await sleep(500);
    const termSize = await page.evaluate(() => getComputedStyle(document.querySelector(".xterm-rows")).fontSize);
    ok(termSize === "24px", "terminals follow the font size setting live: " + termSize);

    const sbBefore = await page.$eval("#sessions-panel", (e) => e.getBoundingClientRect().width);
    const textBefore = await page.$eval("#sessions-panel .sp-title", (e) => e.getBoundingClientRect().height);
    await page.selectOption("#uiscale-select", "150");
    await sleep(300);
    const sbAfter = await page.$eval("#sessions-panel", (e) => e.getBoundingClientRect().width);
    const textAfter = await page.$eval("#sessions-panel .sp-title", (e) => e.getBoundingClientRect().height);
    const sidebarW = await page.$eval("#sidebar", (e) => e.getBoundingClientRect().width);
    ok(textAfter > textBefore * 1.3, `left pane text grows with the setting (${textBefore.toFixed(1)} -> ${textAfter.toFixed(1)})`);
    ok(sbAfter <= sidebarW + 1, `the zoomed panel still fits its sidebar (${sbAfter.toFixed(0)} <= ${sidebarW.toFixed(0)}; before ${sbBefore.toFixed(0)})`);
  } catch (e) {
    console.log("FAIL " + e.message); process.exitCode = 1;
  } finally {
    ok(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await browser.close();
    srv.kill();
  }
})();
