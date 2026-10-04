import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { start } from "../server.js";
import { createParser, encodeFrame } from "../src/ws.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALPHA = "alpha\nbeta\ngamma\n";

function get(port, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: requestPath,
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

function git(dir, args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: dir }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve(stdout.toString());
    });
  });
}

function messageText(data) {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return null;
}

function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
  const queue = [];
  const pings = [];
  let pingWaiter = null;
  let opened = false;
  ws.addEventListener("message", (ev) => {
    const text = messageText(ev.data);
    const msg = JSON.parse(text);
    if (msg.type === "ping") {
      pings.push(msg);
      if (pingWaiter) {
        const resolve = pingWaiter;
        pingWaiter = null;
        resolve(pings.shift());
      }
      return;
    }
    queue.push(msg);
    drain();
  });
  const waiters = [];
  function drain() {
    while (waiters.length > 0 && queue.length > 0) {
      const waiter = waiters[0];
      const index = queue.findIndex(waiter.pred);
      if (index < 0) return;
      const msg = queue.splice(index, 1)[0];
      waiters.shift();
      clearTimeout(waiter.timer);
      waiter.resolve(msg);
    }
  }
  function next(pred, timeout = 3000) {
    return new Promise((resolve, reject) => {
      const waiter = {
        pred,
        resolve,
        timer: setTimeout(() => {
          const at = waiters.indexOf(waiter);
          if (at >= 0) waiters.splice(at, 1);
          reject(new Error(`timeout waiting; queued ${JSON.stringify(queue)}`));
        }, timeout),
      };
      waiters.push(waiter);
      drain();
    });
  }
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", () => {
      opened = true;
      resolve();
    });
    ws.addEventListener("error", () => {
      if (!opened) reject(new Error("websocket failed"));
    });
  });
  return {
    ws,
    all: queue,
    ready,
    next,
    send(obj) {
      ws.send(JSON.stringify(obj));
    },
    waitPing(timeout = 20000) {
      if (pings.length > 0) return Promise.resolve(pings.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no ping")), timeout);
        pingWaiter = (msg) => {
          clearTimeout(timer);
          resolve(msg);
        };
      });
    },
  };
}

async function hello(port, username) {
  const client = connect(port);
  await client.ready;
  client.send({ type: "hello", username });
  return client;
}

async function openDoc(client, username, rel) {
  client.send({ type: "open", username, path: rel });
  return client.next((msg) => msg.type === "file" && msg.path === rel);
}

async function syncLock(actor, others, username, rel, anchor, rev, cursor = anchor) {
  actor.send({ type: "lock", username, path: rel, anchor, cursor, rev });
  const mine = await actor.next((msg) => msg.type === "locks" && msg.path === rel);
  for (const other of others) await other.next((msg) => msg.type === "locks" && msg.path === rel);
  return mine;
}

async function takeDoc(client) {
  const doc = await client.next((msg) => msg.type === "doc");
  await client.next((msg) => msg.type === "locks" && msg.rev === doc.rev && msg.path === doc.path);
  return doc;
}

async function withDocs(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-hub-"));
  const server = await start(0, dir);
  try {
    await fn({ server, dir, port: server.address().port });
  } finally {
    await close(server);
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function readDoc(dir, rel) {
  return fs.readFile(path.join(dir, rel), "utf8");
}

function closed(target) {
  return new Promise((resolve) => {
    target.addEventListener("close", () => resolve(), { once: true });
  });
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

test("T-init", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-parent-"));
  const dir = path.join(parent, "nested", "docs");
  const server = await start(0, dir);
  try {
    const info = await fs.stat(path.join(dir, ".git"));
    assert.equal(info.isDirectory(), true);
    const top = (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
    assert.equal(await fs.realpath(top), await fs.realpath(dir));
  } finally {
    await close(server);
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("T-list", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "a.md"), "a\n");
    await fs.mkdir(path.join(dir, "sub"));
    await fs.writeFile(path.join(dir, "sub", "b.markdown"), "b\n");
    await fs.writeFile(path.join(dir, "c.txt"), "c\n");
    await fs.writeFile(path.join(dir, ".git", "secret.md"), "nope\n");
    const client = await hello(port, "A");
    client.send({ type: "list", username: "A" });
    assert.deepEqual(await client.next((msg) => msg.type === "docs"), {
      type: "docs",
      files: ["a.md", "sub/b.markdown"],
    });
    const raw = await get(port, "/raw/a.md");
    assert.equal(raw.status, 200);
    assert.equal(raw.body, "a\n");
    const nested = await get(port, "/raw/sub/b.markdown");
    assert.equal(nested.status, 200);
    assert.equal(nested.body, "b\n");
    const escaped = await get(port, "/raw/..%2F..%2Fetc/passwd");
    assert.equal(escaped.status, 404);
    client.ws.close();
  });
});

test("T-auth", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "a.md"), ALPHA);
    const empty = connect(port);
    await empty.ready;
    const untilClosed = closed(empty.ws);
    empty.send({ type: "hello", username: "" });
    await untilClosed;

    const a = await hello(port, "A");
    a.send({ type: "pong", username: "B" });
    assert.deepEqual(await a.next((msg) => msg.type === "error"), { type: "error", status: 403 });
    a.send({ type: "list", username: "B" });
    assert.deepEqual(await a.next((msg) => msg.type === "error"), { type: "error", status: 403 });
    a.send({ type: "list", username: "A" });
    assert.deepEqual(await a.next((msg) => msg.type === "docs"), { type: "docs", files: ["a.md"] });

    const a2 = await hello(port, "A");
    const rev = (await openDoc(a, "A", "a.md")).rev;
    await openDoc(a2, "A", "a.md");
    await syncLock(a, [a2], "A", "a.md", 0, rev);
    a2.send({ type: "lock", username: "A", path: "a.md", anchor: 0, cursor: 0, rev });
    assert.deepEqual(await a2.next((msg) => msg.type === "error"), { type: "error", status: 409 });
    const other = await syncLock(a2, [a], "A", "a.md", ALPHA.indexOf("beta"), rev);
    assert.deepEqual(other.lines, [
      { index: 0, username: "A" },
      { index: 1, username: "A" },
    ]);
    a.ws.close();
    a2.ws.close();
  });
});

test("T-edit", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "a.md"), ALPHA);
    const a = await hello(port, "A");
    const b = await hello(port, "B");
    const opened = await openDoc(a, "A", "a.md");
    assert.equal(opened.text, ALPHA);
    assert.equal(opened.rev, 0);
    assert.deepEqual(opened.locks, []);
    await openDoc(b, "B", "a.md");
    const locked = await syncLock(a, [b], "A", "a.md", 0, opened.rev);
    assert.deepEqual(locked.lines, [{ index: 0, username: "A" }]);
    b.send({ type: "lock", username: "B", path: "a.md", anchor: 0, cursor: 0, rev: opened.rev });
    assert.deepEqual(await b.next((msg) => msg.type === "error"), { type: "error", status: 409 });
    assert.equal(await readDoc(dir, "a.md"), ALPHA);
    a.send({ type: "edit", username: "A", path: "a.md", rev: opened.rev, op: "insert", text: "X" });
    const docA = await a.next((msg) => msg.type === "doc");
    const docB = await b.next((msg) => msg.type === "doc");
    const expected = {
      type: "doc",
      path: "a.md",
      rev: 1,
      text: "Xalpha\nbeta\ngamma\n",
      from: 0,
      to: 0,
      inserted: "X",
      actor: "A",
      cursor: 1,
      anchor: 1,
    };
    assert.deepEqual(docA, expected);
    assert.deepEqual(docB, expected);
    assert.equal(await readDoc(dir, "a.md"), expected.text);
    await a.next((msg) => msg.type === "locks" && msg.rev === 1);
    await b.next((msg) => msg.type === "locks" && msg.rev === 1);
    b.send({ type: "edit", username: "B", path: "a.md", rev: opened.rev, op: "insert", text: "Q" });
    assert.deepEqual(await b.next((msg) => msg.type === "error"), { type: "error", status: 409 });
    assert.equal(await readDoc(dir, "a.md"), expected.text);
    a.ws.close();
    b.ws.close();
  });
});

test("T-undo", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "a.md"), ALPHA);
    const a = await hello(port, "A");
    const b = await hello(port, "B");
    let rev = (await openDoc(a, "A", "a.md")).rev;
    await openDoc(b, "B", "a.md");
    await syncLock(a, [b], "A", "a.md", 0, rev);
    a.send({ type: "edit", username: "A", path: "a.md", rev, op: "insert", text: "X" });
    let doc = await takeDoc(a);
    await takeDoc(b);
    rev = doc.rev;
    await syncLock(b, [a], "B", "a.md", doc.text.indexOf("beta"), rev);
    b.send({ type: "edit", username: "B", path: "a.md", rev, op: "insert", text: "Y" });
    doc = await takeDoc(b);
    await takeDoc(a);
    rev = doc.rev;
    assert.equal(doc.text, "Xalpha\nYbeta\ngamma\n");
    b.send({ type: "undo", username: "B", path: "a.md", rev });
    doc = await takeDoc(b);
    await takeDoc(a);
    rev = doc.rev;
    assert.equal(doc.text, "Xalpha\nbeta\ngamma\n");
    assert.equal(await readDoc(dir, "a.md"), doc.text);

    a.send({ type: "undo", username: "A", path: "a.md", rev });
    doc = await takeDoc(a);
    await takeDoc(b);
    rev = doc.rev;
    assert.equal(doc.text, ALPHA);
    a.send({ type: "edit", username: "A", path: "a.md", rev, op: "insert", text: "X" });
    doc = await takeDoc(a);
    await takeDoc(b);
    rev = doc.rev;
    await syncLock(b, [a], "B", "a.md", doc.text.indexOf("beta"), rev);
    b.send({ type: "edit", username: "B", path: "a.md", rev, op: "insert", text: "Y" });
    doc = await takeDoc(b);
    await takeDoc(a);
    rev = doc.rev;
    a.send({ type: "undo", username: "A", path: "a.md", rev });
    doc = await takeDoc(a);
    await takeDoc(b);
    assert.equal(doc.text, "alpha\nYbeta\ngamma\n");
    assert.equal(await readDoc(dir, "a.md"), doc.text);
    a.ws.close();
    b.ws.close();
  });
});

test("T-undo-lock", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "a.md"), ALPHA);
    const a = await hello(port, "A");
    const b = await hello(port, "B");
    let rev = (await openDoc(a, "A", "a.md")).rev;
    await openDoc(b, "B", "a.md");
    await syncLock(a, [b], "A", "a.md", 0, rev);
    a.send({ type: "edit", username: "A", path: "a.md", rev, op: "insert", text: "X" });
    let doc = await takeDoc(a);
    await takeDoc(b);
    rev = doc.rev;
    await syncLock(a, [b], "A", "a.md", doc.text.indexOf("gamma"), rev);
    await syncLock(b, [a], "B", "a.md", 0, rev);
    b.send({ type: "edit", username: "B", path: "a.md", rev, op: "insert", text: "Z" });
    doc = await takeDoc(b);
    await takeDoc(a);
    rev = doc.rev;
    assert.equal(doc.text.startsWith("Z"), true);
    a.send({ type: "undo", username: "A", path: "a.md", rev });
    assert.deepEqual(await a.next((msg) => msg.type === "error"), { type: "error", status: 409 });
    assert.ok((await readDoc(dir, "a.md")).startsWith("Z"));
    await syncLock(b, [a], "B", "a.md", doc.text.indexOf("beta"), rev);
    a.send({ type: "undo", username: "A", path: "a.md", rev });
    doc = await takeDoc(a);
    await takeDoc(b);
    assert.equal(doc.text, "Zalpha\nbeta\ngamma\n");
    assert.equal(await readDoc(dir, "a.md"), doc.text);
    a.ws.close();
    b.ws.close();
  });
});

test("T-overlap", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "a.md"), ALPHA);
    const a = await hello(port, "A");
    const b = await hello(port, "B");
    let rev = (await openDoc(a, "A", "a.md")).rev;
    await openDoc(b, "B", "a.md");
    await syncLock(a, [b], "A", "a.md", 0, rev);
    a.send({ type: "edit", username: "A", path: "a.md", rev, op: "insert", text: "XX" });
    let doc = await takeDoc(a);
    await takeDoc(b);
    rev = doc.rev;
    await syncLock(a, [b], "A", "a.md", doc.text.indexOf("gamma"), rev);
    await syncLock(b, [a], "B", "a.md", 0, rev, 2);
    b.send({ type: "edit", username: "B", path: "a.md", rev, op: "backspace" });
    doc = await takeDoc(b);
    await takeDoc(a);
    rev = doc.rev;
    assert.equal(doc.text, ALPHA);
    await syncLock(b, [a], "B", "a.md", doc.text.indexOf("beta"), rev);
    a.send({ type: "undo", username: "A", path: "a.md", rev });
    assert.deepEqual(await a.next((msg) => msg.type === "error"), { type: "error", status: 409 });
    assert.equal(await readDoc(dir, "a.md"), ALPHA);
    a.ws.close();
    b.ws.close();
  });
});

test("T-redo", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "a.md"), ALPHA);
    const a = await hello(port, "A");
    let rev = (await openDoc(a, "A", "a.md")).rev;
    await syncLock(a, [], "A", "a.md", 0, rev);
    a.send({ type: "edit", username: "A", path: "a.md", rev, op: "insert", text: "X" });
    let doc = await takeDoc(a);
    rev = doc.rev;
    a.send({ type: "undo", username: "A", path: "a.md", rev });
    doc = await takeDoc(a);
    rev = doc.rev;
    assert.equal(doc.text, ALPHA);
    a.send({ type: "redo", username: "A", path: "a.md", rev });
    doc = await takeDoc(a);
    rev = doc.rev;
    assert.equal(doc.text, "Xalpha\nbeta\ngamma\n");
    a.send({ type: "undo", username: "A", path: "a.md", rev });
    doc = await takeDoc(a);
    rev = doc.rev;
    a.send({ type: "edit", username: "A", path: "a.md", rev, op: "insert", text: "Y" });
    doc = await takeDoc(a);
    rev = doc.rev;
    assert.equal(doc.text, "Yalpha\nbeta\ngamma\n");
    a.send({ type: "redo", username: "A", path: "a.md", rev });
    assert.deepEqual(await a.next((msg) => msg.type === "error"), { type: "error", status: 409 });
    assert.equal(await readDoc(dir, "a.md"), "Yalpha\nbeta\ngamma\n");
    a.ws.close();
  });
});

test("T-cap", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "a.md"), "z\n");
    const a = await hello(port, "A");
    let rev = (await openDoc(a, "A", "a.md")).rev;
    await syncLock(a, [], "A", "a.md", 0, rev);
    for (let i = 0; i < 205; i += 1) {
      a.send({ type: "edit", username: "A", path: "a.md", rev, op: "insert", text: "q" });
      const doc = await takeDoc(a);
      rev = doc.rev;
    }
    for (let i = 0; i < 200; i += 1) {
      a.send({ type: "undo", username: "A", path: "a.md", rev });
      const doc = await takeDoc(a);
      rev = doc.rev;
    }
    assert.equal(await readDoc(dir, "a.md"), "qqqqqz\n");
    a.send({ type: "undo", username: "A", path: "a.md", rev });
    assert.deepEqual(await a.next((msg) => msg.type === "error"), { type: "error", status: 409 });
    assert.equal(await readDoc(dir, "a.md"), "qqqqqz\n");
    a.ws.close();
  });
});

test("T-comment", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "a.md"), ALPHA);
    const a = await hello(port, "A");
    let rev = (await openDoc(a, "A", "a.md")).rev;
    await syncLock(a, [], "A", "a.md", 0, rev, ALPHA.length - 1);
    a.send({
      type: "edit",
      username: "A",
      path: "a.md",
      rev,
      op: "comment.add",
      anchor: 0,
      cursor: 5,
    });
    let doc = await takeDoc(a);
    rev = doc.rev;
    assert.match(doc.text, /\{c1\}alpha\{\/c1\}/);
    assert.match(doc.text, /```comment c1/);
    assert.equal(await readDoc(dir, "a.md"), doc.text);
    a.send({
      type: "edit",
      username: "A",
      path: "a.md",
      rev,
      op: "comment.save",
      id: "c1",
      body: "note",
    });
    doc = await takeDoc(a);
    rev = doc.rev;
    assert.match(doc.text, /```comment c1\nnote\n```/);
    a.send({
      type: "edit",
      username: "A",
      path: "a.md",
      rev,
      op: "comment.resolve",
      id: "c1",
      resolved: true,
    });
    doc = await takeDoc(a);
    rev = doc.rev;
    assert.match(doc.text, /```comment c1 resolved/);
    a.send({ type: "edit", username: "A", path: "a.md", rev, op: "comment.delete", id: "c1" });
    doc = await takeDoc(a);
    rev = doc.rev;
    assert.equal(doc.text.includes("c1"), false);
    assert.equal(await readDoc(dir, "a.md"), doc.text);
    a.send({ type: "undo", username: "A", path: "a.md", rev });
    doc = await takeDoc(a);
    assert.match(doc.text, /```comment c1 resolved/);
    a.ws.close();
  });
});

test("T-shrink", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "a.md"), ALPHA);
    const a = await hello(port, "A");
    const b = await hello(port, "B");
    const opened = await openDoc(a, "A", "a.md");
    await openDoc(b, "B", "a.md");
    const locked = await syncLock(a, [b], "A", "a.md", 0, opened.rev, ALPHA.length);
    assert.ok(locked.lines.some((line) => line.index === 1 && line.username === "A"));
    assert.ok(locked.lines.some((line) => line.index === 2 && line.username === "A"));
    a.send({
      type: "edit",
      username: "A",
      path: "a.md",
      rev: opened.rev,
      op: "comment.add",
      anchor: 0,
      cursor: 5,
    });
    const doc = await a.next((msg) => msg.type === "doc");
    const locks = await a.next((msg) => msg.type === "locks" && msg.rev === doc.rev && msg.path === doc.path);
    await b.next((msg) => msg.type === "doc" && msg.rev === doc.rev);
    const seen = await b.next((msg) => msg.type === "locks" && msg.rev === doc.rev && msg.path === doc.path);
    assert.match(doc.text, /^\{c1\}alpha\{\/c1\}\nbeta\ngamma\n/);
    assert.equal(doc.actor, "A");
    assert.deepEqual(locks.lines, [{ index: 0, username: "A" }]);
    assert.deepEqual(seen.lines, [{ index: 0, username: "A" }]);
    assert.equal(locks.lines.some((line) => line.index === 1 || line.index === 2), false);
    a.ws.close();
    b.ws.close();
  });
});

test("T-commit", async () => {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "a.md"), ALPHA);
    const a = await hello(port, "A");
    let rev = (await openDoc(a, "A", "a.md")).rev;
    await syncLock(a, [], "A", "a.md", 0, rev);
    await syncLock(a, [], "A", "a.md", ALPHA.indexOf("gamma"), rev);
    await assert.rejects(() => git(dir, ["rev-parse", "HEAD"]));
    await syncLock(a, [], "A", "a.md", 0, rev);
    a.send({ type: "edit", username: "A", path: "a.md", rev, op: "insert", text: "X" });
    const doc = await takeDoc(a);
    rev = doc.rev;
    await syncLock(a, [], "A", "a.md", doc.text.indexOf("gamma"), rev);
    assert.equal(await git(dir, ["log", "-1", "--format=%an%n%ae%n%s"]), "A\nA@viewmark.local\nEdit a.md\n");
    const count = (await git(dir, ["rev-list", "--count", "HEAD"])).trim();
    assert.equal(count, "1");
    await syncLock(a, [], "A", "a.md", doc.text.indexOf("beta"), rev);
    assert.equal((await git(dir, ["rev-list", "--count", "HEAD"])).trim(), "1");
    a.ws.close();
  });
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }), head);
});

test("T-frame", async () => {
  await withDocs(async ({ port }) => {
    const binary = connect(port);
    await binary.ready;
    const binaryClosed = closed(binary.ws);
    binary.ws.send(Buffer.from([1, 2, 3]));
    await binaryClosed;

    const unmasked = await new Promise((resolve, reject) => {
      const key = randomBytes(16).toString("base64");
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/ws",
          headers: {
            Connection: "Upgrade",
            Upgrade: "websocket",
            "Sec-WebSocket-Key": key,
            "Sec-WebSocket-Version": "13",
          },
        },
        () => reject(new Error("expected upgrade")),
      );
      req.on("upgrade", (_res, socket) => resolve(socket));
      req.on("error", reject);
      req.end();
    });
    // A paused upgrade socket does not emit close until the close frame is read.
    unmasked.on("data", () => {});
    unmasked.on("error", () => {});
    unmasked.write(Buffer.from([0x81, 0x02, 0x68, 0x69]));
    await once(unmasked, "close");

    const huge = await new Promise((resolve, reject) => {
      const key = randomBytes(16).toString("base64");
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/ws",
          headers: {
            Connection: "Upgrade",
            Upgrade: "websocket",
            "Sec-WebSocket-Key": key,
            "Sec-WebSocket-Version": "13",
          },
        },
        () => reject(new Error("expected upgrade")),
      );
      req.on("upgrade", (_res, socket) => resolve(socket));
      req.on("error", reject);
      req.end();
    });
    const header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0xff;
    header.writeBigUInt64BE(BigInt(1024 * 1024 + 1), 2);
    huge.on("data", () => {});
    huge.on("error", () => {});
    huge.write(header);
    await once(huge, "close");

    const parts = await new Promise((resolve, reject) => {
      const key = randomBytes(16).toString("base64");
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/ws",
          headers: {
            Connection: "Upgrade",
            Upgrade: "websocket",
            "Sec-WebSocket-Key": key,
            "Sec-WebSocket-Version": "13",
          },
        },
        () => reject(new Error("expected upgrade")),
      );
      req.on("upgrade", (_res, socket) => resolve(socket));
      req.on("error", reject);
      req.end();
    });
    const messages = [];
    const parser = createParser({
      requireMask: false,
      onText(payload) {
        messages.push(JSON.parse(payload.toString("utf8")));
      },
      onPing() {},
      onClose() {},
      onError(reason) {
        messages.push({ error: reason });
      },
    });
    parts.on("data", (chunk) => parser.push(chunk));
    const helloBody = Buffer.from('{"type":"hello","username":"A"}');
    parts.write(encodeFrame(0x1, helloBody.subarray(0, 12), { mask: true, fin: false }));
    parts.write(encodeFrame(0x0, helloBody.subarray(12), { mask: true, fin: true }));
    parts.write(encodeFrame(0x1, Buffer.from('{"type":"list","username":"A"}'), { mask: true }));
    const deadline = Date.now() + 2000;
    while (!messages.some((msg) => msg.type === "docs") && Date.now() < deadline) await delay(20);
    assert.deepEqual(messages.find((msg) => msg.type === "docs"), { type: "docs", files: [] });
    parts.end();
  });
});

test("T-idle", { timeout: 60000 }, async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "a.md"), ALPHA);
    const a = await hello(port, "Ada");
    const rev = (await openDoc(a, "Ada", "a.md")).rev;
    await syncLock(a, [], "Ada", "a.md", 0, rev);
    a.send({ type: "edit", username: "Ada", path: "a.md", rev, op: "insert", text: "X" });
    await takeDoc(a);
    await delay(2000);
    await assert.rejects(() => git(dir, ["rev-parse", "HEAD"]));
    assert.deepEqual(await a.waitPing(), { type: "ping" });
    const deadline = Date.now() + 40000;
    let log = "";
    while (Date.now() < deadline) {
      try {
        log = await git(dir, ["log", "-1", "--format=%an%n%ae%n%s"]);
        break;
      } catch {
        await delay(200);
      }
    }
    assert.equal(log, "Ada\nAda@viewmark.local\nEdit a.md\n");
    assert.equal((await git(dir, ["rev-list", "--count", "HEAD"])).trim(), "1");
    a.ws.close();
  });
});
