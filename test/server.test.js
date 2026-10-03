import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { start } from "../server.js";

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: { Connection: "close" },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            type: res.headers["content-type"] ?? "",
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
    server.closeAllConnections();
  });
}

async function withServer(fn) {
  const server = await start(0);
  try {
    await fn(server.address().port);
  } finally {
    await close(server);
  }
}

test("T-index", async () => {
  await withServer(async (port) => {
    const res = await get(port, "/");
    assert.equal(res.status, 200);
    assert.equal(res.type, "text/html");
    assert.ok(res.body.includes('id="editor"'));
  });
});

test("T-module", async () => {
  await withServer(async (port) => {
    const res = await get(port, "/src/editor.js");
    assert.equal(res.status, 200);
    assert.equal(res.type, "text/javascript");
    assert.ok(res.body.includes("export function plan"));
  });
});

test("T-missing", async () => {
  await withServer(async (port) => {
    const res = await get(port, "/no-such");
    assert.equal(res.status, 404);
  });
});

test("T-traversal", async () => {
  await withServer(async (port) => {
    const res = await get(port, "/..%2F..%2Fetc/passwd");
    assert.equal(res.status, 404);
  });
});
