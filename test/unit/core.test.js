// test/unit/core.test.js — Crypto (compatible with files the old server wrote), Config, CLI commands, TypedEmitter
"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { Crypto } = require("../../dist/core/Crypto");
const { Config } = require("../../dist/core/Config");
const { TypedEmitter } = require("../../dist/core/TypedEmitter");
const { HttpError } = require("../../dist/core/HttpError");
const { hashPassword, verifyPassword } = require("../../dist/core/password");
const { runCommand } = require("../../dist/cli/commands");
const fx = path.join(__dirname, "..", "fixtures", "crypto");
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "agenv-c-"));

describe("Crypto", () => {
  it("decrypts what the old server wrote", () => {
    const c = new Crypto(path.join(fx, "key"));
    assert.deepEqual(c.decryptJSON(fs.readFileSync(path.join(fx, "cipher.json"), "utf8")), JSON.parse(fs.readFileSync(path.join(fx, "plain.json"), "utf8")));
  });
  it("reads a legacy plain-JSON file (no version field) as-is, like the old server", () => {
    const c = new Crypto(path.join(fx, "key"));
    assert.deepEqual(c.decryptJSON(fs.readFileSync(path.join(fx, "legacy-plain.json"), "utf8")), { legacy: true, items: [1] });
  });
  it("round-trips and creates a missing key file", () => {
    const keyPath = path.join(tmpHome(), "k");
    const c = new Crypto(keyPath);
    assert.deepEqual(c.decryptJSON(c.encryptJSON({ a: 1 })), { a: 1 });
    assert.ok(fs.existsSync(keyPath));
    assert.equal(fs.readFileSync(keyPath, "utf8").trim().length, 64);
  });
  it("throws on garbage and on a tampered ciphertext", () => {
    const c = new Crypto(path.join(fx, "key"));
    assert.throws(() => c.decryptJSON("not-encrypted"));
    const t = JSON.parse(fs.readFileSync(path.join(fx, "cipher.json"), "utf8")); t.data = Buffer.from("tampered").toString("base64");
    assert.throws(() => c.decryptJSON(JSON.stringify(t)));
  });
});

describe("password", () => {
  it("verifies the right password and rejects a wrong or malformed one", () => {
    const h = hashPassword("s3cret");
    assert.equal(verifyPassword("s3cret", h), true);
    assert.equal(verifyPassword("nope", h), false);
    assert.equal(verifyPassword("s3cret", "garbage"), false);
  });
});

describe("Config", () => {
  it("applies flags and defaults", () => {
    const c = Config.fromArgv(["--port", "9000", "--max-sessions", "3", "--no-qr", "--token", "T"], {}, tmpHome());
    assert.equal(c.port, 9000); assert.equal(c.maxSessions, 3); assert.equal(c.showQr, false); assert.equal(c.token, "T");
    assert.equal(c.host, "127.0.0.1"); assert.equal(c.initialSessions, 1); assert.equal(c.mirror, false); assert.equal(c.autoOpen, false);
  });
  it("defaults the port from PORT and the host from HOST", () => {
    const c = Config.fromArgv([], { PORT: "8123", HOST: "0.0.0.0" }, tmpHome());
    assert.equal(c.port, 8123); assert.equal(c.host, "0.0.0.0");
  });
  it("forces localhost under Electron", () => {
    assert.equal(Config.fromArgv(["--host", "0.0.0.0"], { ELECTRON: "1" }, tmpHome()).host, "127.0.0.1");
  });
  it("collects the run command and skips flags + their values", () => {
    const c = Config.fromArgv(["run", "claude", "--port", "1", "--model", "opus", "--name", "x"], {}, tmpHome());
    assert.equal(c.command, "run"); assert.equal(c.runCommand, "claude --model opus"); assert.equal(c.runName, "x");
  });
  it("persists dotted keys to ~/.agenvrc.json and reuses a saved token", () => {
    const h = tmpHome(); const c = Config.fromArgv([], {}, h);
    c.set("auth.username", "bob"); c.set("token", "saved-token");
    const again = Config.fromArgv([], {}, h);
    assert.equal(again.get("auth.username"), "bob"); assert.equal(again.token, "saved-token");
    assert.equal(again.get("auth.missing"), undefined);
  });
  it("a corrupt config file reads as empty instead of throwing", () => {
    const h = tmpHome(); fs.writeFileSync(path.join(h, ".agenvrc.json"), "{not json");
    assert.equal(Config.fromArgv([], {}, h).get("anything"), undefined);
  });
});

describe("runCommand", () => {
  const capture = (fn) => { const out = [], err = []; const l = console.log, e = console.error; console.log = (...a) => out.push(a.join(" ")); console.error = (...a) => err.push(a.join(" ")); try { return { code: fn(), out, err }; } finally { console.log = l; console.error = e; } };
  it("returns null for anything that is not a CLI command", () => {
    assert.equal(runCommand(Config.fromArgv(["--port", "1"], {}, tmpHome())), null);
  });
  it("prints the version and help with exit code 0", () => {
    const v = capture(() => runCommand(Config.fromArgv(["version"], {}, tmpHome())));
    assert.equal(v.code, 0); assert.match(v.out.join("\n"), /^agenv v\d+\.\d+\.\d+/);
    const h = capture(() => runCommand(Config.fromArgv(["help"], {}, tmpHome())));
    assert.equal(h.code, 0); assert.match(h.out.join("\n"), /Usage:/);
  });
  it("set stores a value (hashing the password) and get reads it back", () => {
    const home = tmpHome();
    assert.equal(capture(() => runCommand(Config.fromArgv(["set", "auth.username", "bob"], {}, home))).code, 0);
    assert.equal(capture(() => runCommand(Config.fromArgv(["set", "auth.password", "pw"], {}, home))).code, 0);
    const u = capture(() => runCommand(Config.fromArgv(["get", "auth.username"], {}, home)));
    assert.equal(u.code, 0); assert.deepEqual(u.out, ["bob"]);
    const p = capture(() => runCommand(Config.fromArgv(["get", "auth.password"], {}, home)));
    assert.deepEqual(p.out, ["(hashed)"]);
    assert.equal(verifyPassword("pw", Config.fromArgv([], {}, home).get("auth.password")), true);
  });
  it("run with a command lets the server start; run without one prints usage and exits 1", () => {
    assert.equal(runCommand(Config.fromArgv(["run", "echo", "hi"], {}, tmpHome())), null);
    const r = capture(() => runCommand(Config.fromArgv(["run", "--port", "5"], {}, tmpHome())));
    assert.equal(r.code, 1); assert.match(r.err.join("\n"), /Usage: agenv run <command/);
  });
  it("set without a value and get of an unset key exit 1", () => {
    const home = tmpHome();
    assert.equal(capture(() => runCommand(Config.fromArgv(["set", "k"], {}, home))).code, 1);
    assert.equal(capture(() => runCommand(Config.fromArgv(["get", "nope"], {}, home))).code, 1);
  });
});

describe("HttpError", () => {
  it("carries a status and message", () => {
    const e = new HttpError(404, "Session not found");
    assert.equal(e.status, 404); assert.equal(e.message, "Session not found"); assert.ok(e instanceof Error);
  });
});

describe("TypedEmitter", () => {
  it("delivers arguments to every listener in order and supports off()", () => {
    const e = new TypedEmitter(); const seen = [];
    const a = (v) => seen.push("a" + v); const b = (v) => seen.push("b" + v);
    e.on("x", a); e.on("x", b); e.emit("x", 1); e.off("x", a); e.emit("x", 2);
    assert.deepEqual(seen, ["a1", "b1", "b2"]);
  });
  it("a throwing listener does not stop the others or the emitter", () => {
    const e = new TypedEmitter(); const seen = [];
    const origErr = console.error; console.error = () => {};
    try { e.on("x", () => { throw new Error("boom"); }); e.on("x", (v) => seen.push(v)); e.emit("x", 1); }
    finally { console.error = origErr; }
    assert.deepEqual(seen, [1]);
  });
});
