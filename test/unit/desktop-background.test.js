const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const zlib = require("zlib");
const { tunnelActive, solidPng } = require("../../dist/desktop/background");

function serve(handler) {
  return new Promise((res) => { const s = http.createServer(handler).listen(0, "127.0.0.1", () => res(s)); });
}

describe("desktop background (window closed while the tunnel is up)", () => {
  it("tunnelActive is true only when the server reports a running tunnel, and sends the token", async () => {
    let seen = "";
    const s = await serve((req, res) => { seen = req.url; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ running: true, url: "https://x" })); });
    assert.equal(await tunnelActive(s.address().port, "a b"), true);
    assert.equal(seen, "/api/ngrok/status?token=a%20b");
    s.close();
  });

  it("tunnelActive is false when no tunnel runs, the token is refused, the answer is junk or nothing listens", async () => {
    const off = await serve((_q, res) => res.end(JSON.stringify({ running: false })));
    assert.equal(await tunnelActive(off.address().port, "t"), false);
    off.close();
    const denied = await serve((_q, res) => { res.statusCode = 401; res.end(JSON.stringify({ running: true })); });
    assert.equal(await tunnelActive(denied.address().port, "t"), false);
    denied.close();
    const junk = await serve((_q, res) => res.end("<html>"));
    assert.equal(await tunnelActive(junk.address().port, "t"), false);
    junk.close();
    const gone = await serve((_q, res) => res.end());
    const port = gone.address().port; gone.close();
    assert.equal(await tunnelActive(port, "t"), false);
  });

  it("tunnelActive gives up on a server that never answers", async () => {
    const hang = await serve(() => {});
    assert.equal(await tunnelActive(hang.address().port, "t", 150), false);
    hang.closeAllConnections(); hang.close();
  });

  it("solidPng is a valid PNG of the asked size and colour", () => {
    const png = solidPng(8, 1, 2, 3);
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(png.readUInt32BE(16), 8);   // IHDR width
    assert.equal(png.readUInt32BE(20), 8);   // IHDR height
    const idatLen = png.readUInt32BE(33);
    const raw = zlib.inflateSync(png.subarray(41, 41 + idatLen));
    assert.equal(raw.length, 8 * (1 + 8 * 3));
    assert.deepEqual([...raw.subarray(1, 4)], [1, 2, 3]);
  });
});
