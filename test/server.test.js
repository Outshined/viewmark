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
import { TICKET_ALPHABET, composeTicket, parseTicket } from "../src/ticket.js";
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

test("T-create", async () => {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-out-"));
  try {
    await withDocs(async ({ port, dir }) => {
      await fs.writeFile(path.join(dir, "exists.md"), "keep");
      await fs.symlink(outside, path.join(dir, "out"));
      const b = await hello(port, "B");
      const a = await hello(port, "A");
      a.send({ type: "create", username: "A", path: "notes/idea.md" });
      const docsA = await a.next((msg) => msg.type === "docs");
      const docsB = await b.next((msg) => msg.type === "docs");
      assert.ok(docsA.files.includes("notes/idea.md"));
      assert.ok(docsB.files.includes("notes/idea.md"));
      const opened = await a.next((msg) => msg.type === "file" && msg.path === "notes/idea.md");
      assert.equal(opened.text, "");
      assert.equal(opened.rev, 0);
      assert.equal(await readDoc(dir, "notes/idea.md"), "");
      await assert.rejects(() => git(dir, ["rev-parse", "HEAD"]));
      a.send({ type: "create", username: "A", path: "notes/idea.md" });
      assert.deepEqual(await a.next((msg) => msg.type === "error"), { type: "error", status: 409 });
      assert.equal(await readDoc(dir, "notes/idea.md"), "");
      a.send({ type: "create", username: "A", path: "a.txt" });
      assert.deepEqual(await a.next((msg) => msg.type === "error"), { type: "error", status: 400 });
      await assert.rejects(() => fs.lstat(path.join(dir, "a.txt")));
      a.send({ type: "create", username: "A", path: "../x.md" });
      assert.deepEqual(await a.next((msg) => msg.type === "error"), { type: "error", status: 404 });
      a.send({ type: "create", username: "A", path: "exists.md" });
      assert.deepEqual(await a.next((msg) => msg.type === "error"), { type: "error", status: 409 });
      assert.equal(await readDoc(dir, "exists.md"), "keep");
      a.send({ type: "create", username: "A", path: "out/x.md" });
      assert.deepEqual(await a.next((msg) => msg.type === "error"), { type: "error", status: 404 });
      await assert.rejects(() => fs.lstat(path.join(outside, "x.md")));
      await syncLock(a, [], "A", "notes/idea.md", 0, 0);
      a.send({ type: "edit", username: "A", path: "notes/idea.md", rev: 0, op: "insert", text: "Hi" });
      const doc = await takeDoc(a);
      assert.equal(doc.text, "Hi");
      const untilClosed = closed(a.ws);
      a.ws.close();
      await untilClosed;
      const deadline = Date.now() + 5000;
      let log = "";
      while (Date.now() < deadline) {
        try {
          log = await git(dir, ["log", "-1", "--format=%an%n%ae%n%s"]);
          break;
        } catch {
          await delay(50);
        }
      }
      assert.equal(log, "A\nA@viewmark.local\nEdit notes/idea.md\n");
      assert.equal(await readDoc(dir, "notes/idea.md"), "Hi");
      assert.equal(await readDoc(dir, "exists.md"), "keep");
      b.ws.close();
    });
  } finally {
    await fs.rm(outside, { recursive: true, force: true });
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }), head);
  }
});

const TICKET_KEYS = ["created", "depends", "id", "parent", "reporter", "state", "title", "type"];

function assertTicketEntry(ticket) {
  assert.deepEqual(Object.keys(ticket).sort(), TICKET_KEYS);
}

function sortedTickets(tickets) {
  return [...tickets].sort((a, b) => {
    if (a.created < b.created) return -1;
    if (a.created > b.created) return 1;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
}

function ticketText(fields) {
  const text = composeTicket({
    parent: "",
    depends: [],
    body: "",
    reporter: "indexer",
    type: "task",
    ...fields,
  });
  assert.ok(text);
  return text;
}

async function writeTicket(dir, fields) {
  const text = ticketText({ type: "task", ...fields });
  await fs.mkdir(path.join(dir, "tickets"), { recursive: true });
  await fs.writeFile(path.join(dir, "tickets", `${fields.id}.md`), text);
  return text;
}

async function snapshotTree(dir) {
  async function walk(rel) {
    const full = path.join(dir, rel);
    const info = await fs.lstat(full);
    if (info.isSymbolicLink()) return { [rel]: "link" };
    if (info.isDirectory()) {
      const names = await fs.readdir(full);
      const out = {};
      for (const name of names.sort()) Object.assign(out, await walk(rel ? `${rel}/${name}` : name));
      return out;
    }
    if (!info.isFile()) return {};
    return { [rel]: await fs.readFile(full, "utf8") };
  }
  const names = await fs.readdir(dir);
  const out = {};
  for (const name of names.sort()) {
    if (name === ".git") continue;
    Object.assign(out, await walk(name));
  }
  return out;
}

async function assertNoHead(server, dir) {
  await close(server);
  await assert.rejects(() => git(dir, ["rev-parse", "HEAD"]));
}

async function createTicket(client, username, title, state, type) {
  const payload = { type: "ticket.create", username, title };
  if (state !== undefined) payload.state = state;
  if (type !== undefined) payload.ticketType = type;
  const before = Date.now();
  client.send(payload);
  const listed = await client.next((msg) => msg.type === "tickets");
  const file = await client.next((msg) => msg.type === "file");
  return { listed, file, before, after: Date.now() };
}

test("T-ticket-hide", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "a.md"), "a\n");
    await fs.mkdir(path.join(dir, "sub"), { recursive: true });
    await fs.writeFile(path.join(dir, "sub", "b.markdown"), "b\n");
    await fs.writeFile(path.join(dir, "tickets.md"), "root\n");
    await fs.mkdir(path.join(dir, "notes", "tickets"), { recursive: true });
    await fs.writeFile(path.join(dir, "notes", "tickets", "c.md"), "nested name\n");
    const older = await writeTicket(dir, {
      id: "bbbbbbbb",
      title: "Older",
      state: "new",
      created: "2020-01-01T00:00:00.000Z",
      body: "Keep me\n",
    });
    const closed = await writeTicket(dir, {
      id: "aaaaaaaa",
      title: "Closed one",
      state: "closed",
      created: "2020-01-01T00:00:01.000Z",
      body: "done\n",
    });
    await writeTicket(dir, {
      id: "dddddddd",
      title: "Dee",
      state: "new",
      created: "2020-01-01T00:00:02.000Z",
      body: "from disk\n",
    });
    await writeTicket(dir, {
      id: "eeeeeeee",
      title: "Ee",
      state: "new",
      created: "2020-01-01T00:00:02.000Z",
      body: "also disk\n",
    });
    await fs.writeFile(path.join(dir, "tickets", "cccccccc.md"), "nope\n");
    await fs.writeFile(path.join(dir, "tickets", "readme.md"), "hello\n");
    await fs.writeFile(path.join(dir, "tickets", "aaaaaaaa.markdown"), "not a ticket path\n");
    await fs.mkdir(path.join(dir, "tickets", "nested"), { recursive: true });
    await fs.writeFile(path.join(dir, "tickets", "nested", "d.md"), "x\n");

    const client = await hello(port, "A");
    client.send({ type: "list", username: "A" });
    assert.deepEqual(await client.next((msg) => msg.type === "docs"), {
      type: "docs",
      files: ["a.md", "notes/tickets/c.md", "sub/b.markdown", "tickets.md"],
    });

    for (const rel of [
      "tickets/readme.md",
      "tickets/nested/d.md",
      "tickets/cccccccc.md",
      "tickets/aaaaaaaa.markdown",
      "tickets",
    ]) {
      client.send({ type: "open", username: "A", path: rel });
      assert.deepEqual(await client.next((msg) => msg.type === "error"), { type: "error", status: 404 });
    }
    client.send({ type: "open", username: "A", path: "tickets/cccccccc.md" });
    assert.deepEqual(await client.next((msg) => msg.type === "error"), { type: "error", status: 404 });

    const root = await openDoc(client, "A", "tickets.md");
    assert.equal(root.text, "root\n");
    assert.equal(Object.hasOwn(root, "ticket"), false);

    const opened = await openDoc(client, "A", "tickets/bbbbbbbb.md");
    assert.equal(opened.text, "Keep me\n");
    assert.equal(opened.rev, 0);
    assert.deepEqual(opened.locks, []);
    assert.equal(Object.hasOwn(opened.ticket, "body"), false);
    assert.deepEqual(opened.ticket, {
      id: "bbbbbbbb",
      title: "Older",
      state: "new",
      type: "task",
      parent: "",
      depends: [],
      reporter: "indexer",
      created: "2020-01-01T00:00:00.000Z",
    });
    assert.equal(await readDoc(dir, "tickets/bbbbbbbb.md"), older);

    const closedOpen = await openDoc(client, "A", "tickets/aaaaaaaa.md");
    assert.equal(closedOpen.text, "done\n");
    assert.equal(closedOpen.ticket.state, "closed");
    assert.equal(await readDoc(dir, "tickets/aaaaaaaa.md"), closed);

    client.send({ type: "tickets", username: "A" });
    const listed = await client.next((msg) => msg.type === "tickets");
    assert.deepEqual(listed.tickets.map((ticket) => ticket.id), ["bbbbbbbb", "aaaaaaaa", "dddddddd", "eeeeeeee"]);
    assert.deepEqual(listed.tickets, sortedTickets(listed.tickets));
    for (const ticket of listed.tickets) assertTicketEntry(ticket);
    assert.equal(listed.tickets.some((ticket) => ticket.state === "closed"), true);

    await fs.writeFile(path.join(dir, "tickets", "bbbbbbbb.md"), "garbage\n");
    await fs.writeFile(path.join(dir, "tickets", "eeeeeeee.md"), "garbage\n");
    client.send({ type: "tickets", username: "A" });
    const cached = await client.next((msg) => msg.type === "tickets");
    assert.deepEqual(cached.tickets.map((ticket) => ticket.id), ["bbbbbbbb", "aaaaaaaa", "dddddddd"]);
    assert.equal(cached.tickets[0].title, "Older");
    assert.equal(cached.tickets.find((ticket) => ticket.id === "dddddddd").title, "Dee");
    const still = await openDoc(client, "A", "tickets/bbbbbbbb.md");
    assert.equal(still.text, "Keep me\n");
    assert.equal(still.ticket.title, "Older");

    client.send({ type: "create", username: "A", path: "tickets" });
    assert.deepEqual(await client.next((msg) => msg.type === "error"), { type: "error", status: 400 });
    client.send({ type: "create", username: "A", path: "tickets/ffffffff.md" });
    assert.deepEqual(await client.next((msg) => msg.type === "error"), { type: "error", status: 400 });
    client.send({ type: "create", username: "A", path: "tickets/foo.txt" });
    assert.deepEqual(await client.next((msg) => msg.type === "error"), { type: "error", status: 400 });
    await assert.rejects(() => fs.lstat(path.join(dir, "tickets", "ffffffff.md")));
    await assert.rejects(() => fs.lstat(path.join(dir, "tickets", "foo.txt")));
    client.send({ type: "create", username: "A", path: "notes/idea.md" });
    const docs = await client.next((msg) => msg.type === "docs");
    assert.deepEqual(docs.files, ["a.md", "notes/idea.md", "notes/tickets/c.md", "sub/b.markdown", "tickets.md"]);
    assert.equal(docs.files.some((rel) => rel.startsWith("tickets/")), false);
    client.ws.close();
  });
});

test("T-ticket-create", async () => {
  await withDocs(async ({ server, port, dir }) => {
    await writeTicket(dir, {
      id: "bbbbbbbb",
      title: "Older",
      state: "new",
      created: "2020-01-01T00:00:00.000Z",
      body: "",
    });
    const olderDisk = await readDoc(dir, "tickets/bbbbbbbb.md");
    const a = await hello(port, "A");
    const b = await hello(port, "B");
    const beforeBad = await snapshotTree(dir);

    for (const payload of [
      { type: "ticket.create", username: "A" },
      { type: "ticket.create", username: "A", title: "" },
      { type: "ticket.create", username: "A", title: "   " },
      { type: "ticket.create", username: "A", title: "x".repeat(201) },
      { type: "ticket.create", username: "A", title: "bad\ttitle" },
      { type: "ticket.create", username: "A", title: "bad\ntitle" },
      { type: "ticket.create", username: "A", title: "Ok", state: "done" },
      { type: "ticket.create", username: "A", title: "Ok", state: "" },
      { type: "ticket.create", username: "A", title: "Ok", state: " new" },
      { type: "ticket.create", username: "A", title: "Ok", ticketType: "nope" },
      { type: "ticket.create", username: "A", title: "Ok", ticketType: "" },
      { type: "ticket.create", username: "A", title: "Ok", ticketType: "Bug" },
    ]) {
      a.send(payload);
      assert.deepEqual(await a.next((msg) => msg.type === "error"), { type: "error", status: 400 });
    }
    b.send({ type: "list", username: "B" });
    assert.equal((await b.next((msg) => msg.type === "docs" || msg.type === "tickets")).type, "docs");
    assert.deepEqual(await snapshotTree(dir), beforeBad);
    assert.equal(await readDoc(dir, "tickets/bbbbbbbb.md"), olderDisk);

    const first = await createTicket(a, "A", "  Hello  ");
    const seen = await b.next((msg) => msg.type === "tickets");
    const created = first.file.ticket;
    assert.equal(first.file.text, "");
    assert.equal(first.file.rev, 0);
    assert.deepEqual(first.file.locks, []);
    assert.equal(first.file.path, `tickets/${created.id}.md`);
    assert.equal(created.title, "Hello");
    assert.equal(created.state, "new");
    assert.equal(created.type, "task");
    assert.equal(created.parent, "");
    assert.deepEqual(created.depends, []);
    assert.equal(created.reporter, "A");
    assert.match(created.created, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const createdMs = Date.parse(created.created);
    assert.ok(createdMs >= first.before && createdMs <= first.after);
    assert.equal(created.id.length, 8);
    for (const ch of created.id) assert.equal(TICKET_ALPHABET.includes(ch), true);
    assertTicketEntry(created);
    assert.deepEqual(first.listed, seen);
    assert.deepEqual(first.listed.tickets, sortedTickets(first.listed.tickets));
    assert.deepEqual(first.listed.tickets.map((ticket) => ticket.id), ["bbbbbbbb", created.id]);
    assert.deepEqual(first.listed.tickets[1], created);
    assert.equal(await readDoc(dir, first.file.path), ticketText({ ...created, body: "" }));
    assert.equal(await readDoc(dir, "tickets/bbbbbbbb.md"), olderDisk);
    assert.equal(a.all.some((msg) => msg.type === "docs"), false);
    a.send({ type: "list", username: "A" });
    const docs = await a.next((msg) => msg.type === "docs");
    assert.deepEqual(docs.files, []);
    assert.equal(a.all.some((msg) => msg.type === "docs" || msg.type === "tickets"), false);

    const second = await createTicket(a, "A", "Next", "triaged");
    await b.next((msg) => msg.type === "tickets");
    assert.equal(second.file.ticket.state, "triaged");
    assert.equal(second.file.ticket.reporter, "A");
    assert.notEqual(second.file.ticket.id, created.id);
    assert.equal(second.file.text, "");
    assert.equal(second.listed.tickets.find((ticket) => ticket.id === created.id).state, "new");
    assert.equal(second.listed.tickets.find((ticket) => ticket.id === second.file.ticket.id).state, "triaged");
    assert.deepEqual(second.listed.tickets, sortedTickets(second.listed.tickets));
    assert.equal(a.all.some((msg) => msg.type === "docs"), false);

    const bug = await createTicket(a, "A", "Bug", undefined, "bug");
    await b.next((msg) => msg.type === "tickets");
    assert.equal(bug.file.ticket.type, "bug");
    assert.equal(bug.file.ticket.state, "new");
    assert.equal(bug.file.text, "");
    const bugDisk = parseTicket(bug.file.ticket.id, await readDoc(dir, bug.file.path));
    assert.equal(bugDisk.type, "bug");
    assert.equal(bugDisk.title, "Bug");
    assert.equal(bugDisk.body, "");
    assert.match(await readDoc(dir, bug.file.path), /^type: bug$/m);

    await assertNoHead(server, dir);
  });
});

test("T-ticket-set", async () => {
  await withDocs(async ({ server, port, dir }) => {
    const a = await hello(port, "A");
    const b = await hello(port, "B");
    const first = await createTicket(a, "A", "Alpha");
    await b.next((msg) => msg.type === "tickets");
    const second = await createTicket(b, "B", "Beta");
    await a.next((msg) => msg.type === "tickets");
    const pathA = first.file.path;
    const pathB = second.file.path;
    const idA = first.file.ticket.id;
    const idB = second.file.ticket.id;
    let revA = 0;

    async function setOk(sender, username, watcher, payload, notice) {
      sender.send({ type: "ticket.set", username, ...payload });
      const listed = await sender.next((msg) => msg.type === "tickets");
      let meta = null;
      if (notice === "sender") meta = await sender.next((msg) => msg.type === "ticket");
      const watched = await watcher.next((msg) => msg.type === "tickets");
      if (notice === "watcher") meta = await watcher.next((msg) => msg.type === "ticket");
      assert.equal(sender.all.some((msg) => msg.type === "doc"), false);
      assert.equal(watcher.all.some((msg) => msg.type === "doc" || msg.type === "ticket"), false);
      assert.deepEqual(listed.tickets, sortedTickets(listed.tickets));
      assert.deepEqual(watched.tickets, listed.tickets);
      for (const ticket of listed.tickets) assertTicketEntry(ticket);
      return { listed, meta };
    }

    async function setBad(sender, username, watcher, payload, status) {
      const before = await snapshotTree(dir);
      sender.send({ type: "ticket.set", username, ...payload });
      const err = await sender.next((msg) => msg.type === "error" || msg.type === "tickets" || msg.type === "ticket");
      assert.deepEqual(err, { type: "error", status });
      watcher.send({ type: "list", username: watcher === a ? "A" : "B" });
      const next = await watcher.next((msg) => msg.type === "docs" || msg.type === "tickets" || msg.type === "ticket");
      assert.equal(next.type, "docs");
      assert.deepEqual(await snapshotTree(dir), before);
    }

    let result = await setOk(a, "A", b, { path: pathA, rev: revA, title: "Renamed" }, "sender");
    revA = result.meta.rev;
    assert.equal(revA, 1);
    assert.deepEqual(result.meta, {
      type: "ticket",
      path: pathA,
      rev: 1,
      title: "Renamed",
      state: "new",
      ticketType: "task",
      parent: "",
      depends: [],
      reporter: "A",
      created: first.file.ticket.created,
    });
    assert.equal(result.listed.tickets.find((ticket) => ticket.id === idA).title, "Renamed");
    assert.equal(parseTicket(idA, await readDoc(dir, pathA)).body, "");

    result = await setOk(a, "A", b, { path: pathA, rev: revA, state: "triaged" }, "sender");
    revA = result.meta.rev;
    assert.equal(result.meta.title, "Renamed");
    assert.equal(result.meta.state, "triaged");
    assert.equal(result.meta.rev, 2);

    result = await setOk(a, "A", b, { path: pathA, rev: revA, parent: idB }, "sender");
    revA = result.meta.rev;
    assert.equal(result.meta.parent, idB);
    assert.equal(result.meta.state, "triaged");
    assert.deepEqual(result.meta.depends, []);

    result = await setOk(a, "A", b, { path: pathA, rev: revA, depends: [idB, idB] }, "sender");
    revA = result.meta.rev;
    assert.deepEqual(result.meta.depends, [idB]);
    assert.equal(result.meta.parent, idB);
    const dupDisk = await readDoc(dir, pathA);

    a.send({ type: "ticket.set", username: "A", path: pathA, rev: revA, depends: [idB] });
    a.send({ type: "list", username: "A" });
    assert.equal((await a.next((msg) => msg.type === "docs" || msg.type === "tickets" || msg.type === "ticket")).type, "docs");
    b.send({ type: "list", username: "B" });
    assert.equal((await b.next((msg) => msg.type === "docs" || msg.type === "tickets" || msg.type === "ticket")).type, "docs");
    assert.equal(await readDoc(dir, pathA), dupDisk);

    result = await setOk(a, "A", b, { path: pathA, rev: revA, state: "in progress" }, "sender");
    revA = result.meta.rev;
    assert.equal(result.meta.state, "in progress");
    assert.equal(result.listed.tickets.find((ticket) => ticket.id === idB).state, "new");
    assert.deepEqual(result.meta.depends, [idB]);

    a.send({ type: "ticket.set", username: "A", path: pathA, rev: revA, title: "Renamed" });
    a.send({ type: "list", username: "A" });
    assert.equal((await a.next((msg) => msg.type === "docs" || msg.type === "tickets" || msg.type === "ticket")).type, "docs");
    assert.equal(result.meta.rev, revA);

    result = await setOk(
      a,
      "A",
      b,
      { path: pathA, rev: revA, parent: "", depends: [] },
      "sender",
    );
    revA = result.meta.rev;
    assert.equal(result.meta.parent, "");
    assert.deepEqual(result.meta.depends, []);
    assert.equal(result.meta.state, "in progress");
    assert.equal(result.meta.title, "Renamed");

    await setBad(a, "A", b, { path: pathA, rev: revA, reporter: "A" }, 400);
    await setBad(a, "A", b, { path: pathA, rev: revA, created: first.file.ticket.created }, 400);
    await setBad(a, "A", b, { path: pathA, rev: revA, title: "   " }, 400);
    await setBad(a, "A", b, { path: pathA, rev: revA, title: "x".repeat(201) }, 400);
    await setBad(a, "A", b, { path: pathA, rev: revA, state: "Done" }, 400);
    await setBad(a, "A", b, { path: pathA, rev: revA, ticketType: "nope" }, 400);
    await setBad(a, "A", b, { path: pathA, rev: revA, ticketType: "" }, 400);
    await setBad(a, "A", b, { path: pathA, rev: revA, ticketType: "Bug" }, 400);
    await setBad(a, "A", b, { path: pathA, rev: revA, depends: idB }, 400);
    await setBad(a, "A", b, { path: pathA, rev: revA, parent: "aaaaaaai" }, 400);
    await setBad(a, "A", b, { path: "a.md", rev: 0, title: "Nope" }, 404);
    await setBad(a, "A", b, { path: "tickets/readme.md", rev: 0, title: "Nope" }, 404);

    result = await setOk(b, "B", a, { path: pathB, rev: 0, title: "Beta 2" }, "sender");
    assert.equal(result.meta.rev, 1);
    assert.equal(result.meta.reporter, "B");
    assert.equal(result.listed.tickets.find((ticket) => ticket.id === idA).title, "Renamed");

    result = await setOk(a, "A", b, { path: pathA, rev: revA, state: "closed" }, "sender");
    assert.equal(result.meta.state, "closed");
    assert.equal(result.listed.tickets.find((ticket) => ticket.id === idA).state, "closed");
    assert.equal(parseTicket(idA, await readDoc(dir, pathA)).title, "Renamed");

    await assertNoHead(server, dir);
  });
});

test("T-ticket-stale", async () => {
  await withDocs(async ({ server, port, dir }) => {
    const a = await hello(port, "A");
    const created = await createTicket(a, "A", "Alpha");
    const path = created.file.path;
    const id = created.file.ticket.id;
    const original = await readDoc(dir, path);

    a.send({ type: "ticket.set", username: "A", path, rev: 4, title: "Nope" });
    assert.deepEqual(await a.next((msg) => msg.type === "error"), { type: "error", status: 409 });
    assert.equal(await readDoc(dir, path), original);
    assert.equal(a.all.some((msg) => msg.type === "tickets" || msg.type === "ticket"), false);

    a.send({ type: "ticket.set", username: "A", path, rev: 0, title: "Kept" });
    const listed = await a.next((msg) => msg.type === "tickets");
    const meta = await a.next((msg) => msg.type === "ticket");
    assert.equal(meta.rev, 1);
    assert.equal(meta.title, "Kept");
    assert.equal(listed.tickets[0].title, "Kept");
    const written = await readDoc(dir, path);
    assert.equal(parseTicket(id, written).title, "Kept");
    assert.notEqual(written, original);

    a.send({ type: "ticket.set", username: "A", path, rev: 0, title: "Other" });
    assert.deepEqual(await a.next((msg) => msg.type === "error"), { type: "error", status: 409 });
    assert.equal(await readDoc(dir, path), written);
    a.send({ type: "ticket.set", username: "A", path, rev: "1", title: "Other" });
    assert.deepEqual(await a.next((msg) => msg.type === "error"), { type: "error", status: 409 });
    assert.equal(await readDoc(dir, path), written);

    a.send({ type: "ticket.set", username: "A", path, rev: 1, title: "Final" });
    const again = await a.next((msg) => msg.type === "ticket");
    await a.next((msg) => msg.type === "tickets");
    assert.equal(again.title, "Final");
    assert.equal(again.rev, 2);
    assert.equal(parseTicket(id, await readDoc(dir, path)).title, "Final");

    await assertNoHead(server, dir);
  });
});

test("T-ticket-cycle", async () => {
  await withDocs(async ({ server, port, dir }) => {
    const a = await hello(port, "A");
    const first = await createTicket(a, "A", "Alpha");
    const second = await createTicket(a, "A", "Beta");
    const third = await createTicket(a, "A", "Gamma");
    const idA = first.file.ticket.id;
    const idB = second.file.ticket.id;
    const idC = third.file.ticket.id;
    const pathA = first.file.path;
    const pathB = second.file.path;
    const pathC = third.file.path;
    const openPath = pathC;
    const rev = new Map([
      [pathA, 0],
      [pathB, 0],
      [pathC, 0],
    ]);

    async function setOk(payload) {
      a.send({ type: "ticket.set", username: "A", ...payload });
      const listed = await a.next((msg) => msg.type === "tickets");
      if (payload.path === openPath) {
        const meta = await a.next((msg) => msg.type === "ticket");
        assert.equal(meta.path, payload.path);
        assert.equal(meta.rev, rev.get(payload.path) + 1);
        assert.equal(a.all.some((msg) => msg.type === "doc"), false);
      }
      a.send({ type: "list", username: "A" });
      const next = await a.next((msg) => msg.type === "docs" || msg.type === "ticket" || msg.type === "doc");
      assert.equal(next.type, "docs");
      rev.set(payload.path, rev.get(payload.path) + 1);
      return listed;
    }

    async function setFail(payload, status) {
      const before = await snapshotTree(dir);
      a.send({ type: "ticket.set", username: "A", ...payload });
      a.send({ type: "list", username: "A" });
      const firstMsg = await a.next((msg) => msg.type === "error" || msg.type === "tickets" || msg.type === "ticket" || msg.type === "docs");
      assert.deepEqual(firstMsg, { type: "error", status });
      const next = await a.next((msg) => msg.type === "docs" || msg.type === "tickets" || msg.type === "ticket");
      assert.equal(next.type, "docs");
      assert.deepEqual(await snapshotTree(dir), before);
    }

    await setFail({ path: pathA, rev: 0, parent: idA }, 409);
    await setFail({ path: pathA, rev: 0, depends: [idA] }, 409);
    await setFail({ path: pathA, rev: 0, parent: "zzzzzzzz" }, 409);
    await setFail({ path: pathA, rev: 0, depends: ["zzzzzzzz"] }, 409);

    let listed = await setOk({ path: pathA, rev: 0, parent: idB });
    assert.equal(listed.tickets.find((ticket) => ticket.id === idA).parent, idB);
    await setFail({ path: pathB, rev: 0, parent: idA }, 409);

    listed = await setOk({ path: pathB, rev: 0, parent: idC });
    assert.equal(listed.tickets.find((ticket) => ticket.id === idB).parent, idC);
    await setFail({ path: pathC, rev: 0, parent: idA }, 409);
    assert.equal(rev.get(pathC), 0);

    listed = await setOk({ path: pathA, rev: rev.get(pathA), depends: [idB] });
    const alpha = listed.tickets.find((ticket) => ticket.id === idA);
    assert.equal(alpha.parent, idB);
    assert.deepEqual(alpha.depends, [idB]);
    listed = await setOk({ path: pathB, rev: rev.get(pathB), depends: [idC] });
    assert.deepEqual(listed.tickets.find((ticket) => ticket.id === idB).depends, [idC]);
    await setFail({ path: pathC, rev: 0, depends: [idA] }, 409);

    listed = await setOk({ path: pathA, rev: rev.get(pathA), state: "in progress" });
    assert.equal(listed.tickets.find((ticket) => ticket.id === idA).state, "in progress");
    assert.equal(listed.tickets.find((ticket) => ticket.id === idB).state, "new");
    assert.equal(parseTicket(idC, await readDoc(dir, pathC)).parent, "");
    assert.deepEqual(parseTicket(idC, await readDoc(dir, pathC)).depends, []);

    await assertNoHead(server, dir);
  });
});

test("T-ticket-body", async () => {
  await withDocs(async ({ server, port, dir }) => {
    const a = await hello(port, "Ada");
    const b = await hello(port, "Bea");
    const created = await createTicket(a, "Ada", "Body", "triaged");
    await b.next((msg) => msg.type === "tickets");
    const rel = created.file.path;
    const id = created.file.ticket.id;
    const opened = await openDoc(b, "Bea", rel);
    assert.equal(opened.text, "");
    assert.deepEqual(opened.ticket, created.file.ticket);

    await syncLock(a, [b], "Ada", rel, 0, 0);
    const inserted = "Hello\n\ntitle: not a header\n";
    a.send({ type: "edit", username: "Ada", path: rel, rev: 0, op: "insert", text: inserted });
    const docA = await takeDoc(a);
    const docB = await takeDoc(b);
    assert.deepEqual(docA, docB);
    assert.equal(docA.text, inserted);
    assert.equal(docA.path, rel);
    assert.equal(docA.rev, 1);
    assert.equal(docA.text.includes("reporter:"), false);
    const disk = await readDoc(dir, rel);
    const parsed = parseTicket(id, disk);
    assert.equal(parsed.body, inserted);
    assert.equal(parsed.title, "Body");
    assert.equal(parsed.state, "triaged");
    assert.equal(parsed.reporter, "Ada");
    await assert.rejects(() => git(dir, ["rev-parse", "HEAD"]));

    a.send({ type: "undo", username: "Ada", path: rel, rev: docA.rev });
    const undone = await takeDoc(a);
    await takeDoc(b);
    assert.equal(undone.text, "");
    assert.equal(parseTicket(id, await readDoc(dir, rel)).body, "");
    a.send({ type: "redo", username: "Ada", path: rel, rev: undone.rev });
    const redone = await takeDoc(a);
    await takeDoc(b);
    assert.equal(redone.text, inserted);

    a.send({ type: "ticket.set", username: "Ada", path: rel, rev: redone.rev, title: "Body 2" });
    const listed = await a.next((msg) => msg.type === "tickets");
    const meta = await a.next((msg) => msg.type === "ticket");
    await b.next((msg) => msg.type === "tickets");
    const metaB = await b.next((msg) => msg.type === "ticket");
    assert.deepEqual(meta, metaB);
    assert.equal(meta.title, "Body 2");
    assert.equal(meta.rev, redone.rev + 1);
    assert.equal(meta.state, "triaged");
    assert.equal(a.all.some((msg) => msg.type === "doc"), false);
    assert.equal(listed.tickets[0].title, "Body 2");
    const after = parseTicket(id, await readDoc(dir, rel));
    assert.equal(after.title, "Body 2");
    assert.equal(after.body, inserted);
    assert.equal(after.type, "task");

    a.send({ type: "ticket.set", username: "Ada", path: rel, rev: meta.rev, ticketType: "enhancement" });
    const typeMeta = await a.next((msg) => msg.type === "ticket");
    await a.next((msg) => msg.type === "tickets");
    await b.next((msg) => msg.type === "tickets");
    const typeMetaB = await b.next((msg) => msg.type === "ticket");
    assert.deepEqual(typeMeta, typeMetaB);
    assert.equal(typeMeta.ticketType, "enhancement");
    assert.equal(typeMeta.rev, meta.rev + 1);
    assert.equal(typeMeta.state, "triaged");
    assert.equal(typeMeta.title, "Body 2");
    const typed = parseTicket(id, await readDoc(dir, rel));
    assert.equal(typed.type, "enhancement");
    assert.equal(typed.body, inserted);
    assert.equal(typed.state, "triaged");
    assert.equal(a.all.some((msg) => msg.type === "doc"), false);

    const beforeBadType = await readDoc(dir, rel);
    a.send({ type: "ticket.set", username: "Ada", path: rel, rev: typeMeta.rev, ticketType: "nope" });
    assert.deepEqual(
      await a.next((msg) => msg.type === "error" || msg.type === "ticket" || msg.type === "tickets"),
      { type: "error", status: 400 },
    );
    assert.equal(await readDoc(dir, rel), beforeBadType);

    const again = await openDoc(a, "Ada", rel);
    assert.equal(again.text, inserted);
    assert.equal(again.rev, typeMeta.rev);
    assert.equal(again.ticket.title, "Body 2");
    assert.equal(again.ticket.type, "enhancement");
    assert.equal(again.ticket.state, "triaged");

    await assertNoHead(server, dir);
  });
});

test("T-ticket-purge", async () => {
  await withDocs(async ({ server, port, dir }) => {
    const idle = await hello(port, "Idle");
    idle.send({ type: "ticket.purge", username: "Idle" });
    assert.deepEqual(await idle.next((msg) => msg.type === "tickets"), { type: "tickets", tickets: [] });
    await assert.rejects(() => fs.lstat(path.join(dir, "tickets")));

    const T0 = "2020-01-01T00:00:00.000Z";
    const T1 = "2020-01-01T00:00:01.000Z";
    const T2 = "2020-01-01T00:00:02.000Z";
    const T3 = "2020-01-01T00:00:03.000Z";
    const T4 = "2020-01-01T00:00:04.000Z";
    await writeTicket(dir, {
      id: "bbbbbbbb",
      title: "Beta",
      state: "new",
      created: T0,
      body: "beta\n",
    });
    await writeTicket(dir, {
      id: "aaaaaaaa",
      title: "Alpha",
      state: "new",
      parent: "cccccccc",
      depends: ["bbbbbbbb", "cccccccc"],
      created: T1,
      body: "alpha\n",
    });
    await writeTicket(dir, {
      id: "eeeeeeee",
      title: "Ee",
      state: "new",
      depends: ["cccccccc"],
      created: T2,
      body: "ee\n",
    });
    await writeTicket(dir, {
      id: "dddddddd",
      title: "Dee",
      state: "new",
      parent: "cccccccc",
      created: T3,
      body: "dee\n",
    });
    await writeTicket(dir, {
      id: "cccccccc",
      title: "Closed",
      state: "closed",
      created: T4,
      body: "gone\n",
    });
    await fs.writeFile(path.join(dir, "tickets", "readme.md"), "keep\n");
    await fs.writeFile(path.join(dir, "tickets", "zzzzzzzz.md"), "nope\n");
    await fs.mkdir(path.join(dir, "tickets", "nested"), { recursive: true });
    await fs.writeFile(path.join(dir, "tickets", "nested", "d.md"), "x\n");
    await fs.writeFile(path.join(dir, "doc.md"), "doc\n");

    const sub = await hello(port, "Sub");
    const keep = await hello(port, "Keep");
    const bye = await hello(port, "Bye");
    const alpha = await openDoc(sub, "Sub", "tickets/aaaaaaaa.md");
    assert.equal(alpha.text, "alpha\n");
    assert.equal(alpha.rev, 0);
    const beta = await openDoc(keep, "Keep", "tickets/bbbbbbbb.md");
    assert.equal(beta.rev, 0);
    await openDoc(bye, "Bye", "tickets/cccccccc.md");

    idle.send({ type: "ticket.purge", username: "Idle" });
    const notice = await sub.next((msg) => msg.type === "ticket" || msg.type === "tickets");
    assert.deepEqual(notice, {
      type: "ticket",
      path: "tickets/aaaaaaaa.md",
      rev: 1,
      title: "Alpha",
      state: "new",
      ticketType: "task",
      parent: "",
      depends: ["bbbbbbbb"],
      reporter: "indexer",
      created: T1,
    });
    const survivors = await sub.next((msg) => msg.type === "tickets");
    const keepList = await keep.next((msg) => msg.type === "tickets" || msg.type === "ticket");
    const byeList = await bye.next((msg) => msg.type === "tickets" || msg.type === "ticket");
    const idleList = await idle.next((msg) => msg.type === "tickets" || msg.type === "ticket");
    assert.equal(keepList.type, "tickets");
    assert.equal(byeList.type, "tickets");
    assert.equal(idleList.type, "tickets");
    assert.deepEqual(keepList, survivors);
    assert.deepEqual(byeList, survivors);
    assert.deepEqual(idleList, survivors);
    assert.deepEqual(survivors.tickets.map((ticket) => ticket.id), ["bbbbbbbb", "aaaaaaaa", "eeeeeeee", "dddddddd"]);
    assert.equal(survivors.tickets.find((ticket) => ticket.id === "aaaaaaaa").parent, "");
    assert.deepEqual(survivors.tickets.find((ticket) => ticket.id === "aaaaaaaa").depends, ["bbbbbbbb"]);
    assert.deepEqual(survivors.tickets.find((ticket) => ticket.id === "eeeeeeee").depends, []);
    assert.equal(survivors.tickets.find((ticket) => ticket.id === "dddddddd").parent, "");
    assert.equal(survivors.tickets.some((ticket) => ticket.state === "closed"), false);
    for (const ticket of survivors.tickets) assertTicketEntry(ticket);
    assert.equal(sub.all.some((msg) => msg.type === "doc"), false);

    const alphaDisk = parseTicket("aaaaaaaa", await readDoc(dir, "tickets/aaaaaaaa.md"));
    assert.equal(alphaDisk.body, "alpha\n");
    assert.equal(alphaDisk.parent, "");
    assert.deepEqual(alphaDisk.depends, ["bbbbbbbb"]);
    const eeDisk = parseTicket("eeeeeeee", await readDoc(dir, "tickets/eeeeeeee.md"));
    assert.equal(eeDisk.body, "ee\n");
    assert.deepEqual(eeDisk.depends, []);
    const deeDisk = parseTicket("dddddddd", await readDoc(dir, "tickets/dddddddd.md"));
    assert.equal(deeDisk.parent, "");
    assert.equal(deeDisk.body, "dee\n");
    assert.equal(await readDoc(dir, "tickets/bbbbbbbb.md"), ticketText({
      id: "bbbbbbbb",
      title: "Beta",
      state: "new",
      created: T0,
      body: "beta\n",
    }));
    await assert.rejects(() => fs.lstat(path.join(dir, "tickets", "cccccccc.md")));
    assert.equal(await readDoc(dir, "tickets/readme.md"), "keep\n");
    assert.equal(await readDoc(dir, "tickets/zzzzzzzz.md"), "nope\n");
    assert.equal(await readDoc(dir, "tickets/nested/d.md"), "x\n");
    assert.equal(await readDoc(dir, "doc.md"), "doc\n");
    bye.send({ type: "open", username: "Bye", path: "tickets/cccccccc.md" });
    assert.deepEqual(await bye.next((msg) => msg.type === "error"), { type: "error", status: 404 });
    bye.send({ type: "list", username: "Bye" });
    assert.deepEqual(await bye.next((msg) => msg.type === "docs"), { type: "docs", files: ["doc.md"] });

    idle.send({ type: "ticket.purge", username: "Idle" });
    const second = await sub.next((msg) => msg.type === "tickets" || msg.type === "ticket");
    assert.equal(second.type, "tickets");
    assert.deepEqual(second.tickets.map((ticket) => ticket.id), survivors.tickets.map((ticket) => ticket.id));
    await keep.next((msg) => msg.type === "tickets");
    await bye.next((msg) => msg.type === "tickets");
    await idle.next((msg) => msg.type === "tickets");
    sub.send({ type: "list", username: "Sub" });
    assert.equal((await sub.next((msg) => msg.type === "docs" || msg.type === "ticket")).type, "docs");

    sub.send({ type: "ticket.set", username: "Sub", path: "tickets/aaaaaaaa.md", rev: 0, title: "Stale" });
    assert.deepEqual(await sub.next((msg) => msg.type === "error"), { type: "error", status: 409 });
    assert.equal(parseTicket("aaaaaaaa", await readDoc(dir, "tickets/aaaaaaaa.md")).title, "Alpha");
    sub.send({ type: "ticket.set", username: "Sub", path: "tickets/aaaaaaaa.md", rev: 1, title: "After" });
    const bumped = await sub.next((msg) => msg.type === "ticket");
    await sub.next((msg) => msg.type === "tickets");
    assert.equal(bumped.rev, 2);
    assert.equal(bumped.parent, "");
    assert.equal(bumped.title, "After");
    await keep.next((msg) => msg.type === "tickets");
    await idle.next((msg) => msg.type === "tickets");
    keep.send({ type: "ticket.set", username: "Keep", path: "tickets/bbbbbbbb.md", rev: 0, title: "Beta 2" });
    const kept = await keep.next((msg) => msg.type === "ticket");
    await keep.next((msg) => msg.type === "tickets");
    assert.equal(kept.rev, 1);
    assert.equal(kept.title, "Beta 2");
    assert.equal(parseTicket("bbbbbbbb", await readDoc(dir, "tickets/bbbbbbbb.md")).body, "beta\n");

    await assertNoHead(server, dir);
  });
});
