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

async function hello(port, username, repo = "docs") {
  const client = connect(port);
  await client.ready;
  client.send({ type: "hello", username });
  if (repo) client.send({ type: "repo", username, name: repo });
  return client;
}

async function registerRepo(port, name, description, repoPath) {
  const client = await hello(port, "fixture", null);
  client.send({ type: "repo.register", username: "fixture", name, description, path: repoPath });
  const msg = await client.next((item) => item.type === "repos" || item.type === "error");
  client.ws.close();
  if (msg.type !== "repos") throw new Error(`register ${name} failed ${msg.status}`);
  return msg;
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
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-state-"));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-hub-"));
  const server = await start(0, state);
  try {
    await registerRepo(server.address().port, "docs", "Docs", dir);
    await fn({ server, dir, state, port: server.address().port });
  } finally {
    await close(server);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(state, { recursive: true, force: true });
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
  const state = path.join(parent, "nested", "state");
  const docs = path.join(parent, "repo");
  const server = await start(0, state);
  try {
    await assert.rejects(() => fs.stat(path.join(state, ".git")));
    await registerRepo(server.address().port, "docs", "Docs", docs);
    const info = await fs.stat(path.join(docs, ".git"));
    assert.equal(info.isDirectory(), true);
    const top = (await git(docs, ["rev-parse", "--show-toplevel"])).trim();
    assert.equal(await fs.realpath(top), await fs.realpath(docs));
    await assert.rejects(() => fs.stat(path.join(state, ".git")));
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
      titles: {},
    });
    const raw = await get(port, "/raw/docs/a.md");
    assert.equal(raw.status, 200);
    assert.equal(raw.body, "a\n");
    const nested = await get(port, "/raw/docs/sub/b.markdown");
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
    assert.deepEqual(await a.next((msg) => msg.type === "docs"), { type: "docs", files: ["a.md"], titles: {} });

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
    await fs.writeFile(path.join(dir, "b.md"), "b\n");
    const a = await hello(port, "A");
    const b = await hello(port, "B");
    const bare = await hello(port, "C", null);
    bare.send({ type: "commit", username: "C" });
    assert.deepEqual(await bare.next((msg) => msg.type === "error" || msg.type === "commit"), {
      type: "error",
      status: 400,
    });
    for (const message of ["", "   ", "bad\nline", "bad\ttab", "x".repeat(201), "nul\0here", "\0"]) {
      a.send({ type: "commit", username: "A", message });
      assert.deepEqual(await a.next((msg) => msg.type === "error" || msg.type === "commit"), {
        type: "error",
        status: 400,
      });
    }
    await assert.rejects(() => git(dir, ["rev-parse", "HEAD"]));
    a.send({ type: "commit", username: "A" });
    assert.deepEqual(await a.next((msg) => msg.type === "commit"), { type: "commit", commits: [] });
    assert.equal(b.all.some((msg) => msg.type === "commit"), false);

    let rev = (await openDoc(a, "A", "a.md")).rev;
    await syncLock(a, [], "A", "a.md", 0, rev);
    a.send({ type: "edit", username: "A", path: "a.md", rev, op: "insert", text: "X" });
    const doc = await takeDoc(a);
    rev = doc.rev;
    await syncLock(a, [], "A", "a.md", doc.text.indexOf("gamma"), rev);
    await assert.rejects(() => git(dir, ["rev-parse", "HEAD"]));

    a.send({ type: "create", username: "A", path: "extra.md" });
    const docsA = await a.next((msg) => msg.type === "docs");
    assert.ok(docsA.files.includes("extra.md"));
    assert.equal((await a.next((msg) => msg.type === "file" && msg.path === "extra.md")).text, "");
    await b.next((msg) => msg.type === "docs");
    const revB = (await openDoc(b, "B", "b.md")).rev;
    await syncLock(b, [], "B", "b.md", 0, revB);
    b.send({ type: "edit", username: "B", path: "b.md", rev: revB, op: "insert", text: "Y" });
    await takeDoc(b);

    a.send({ type: "commit", username: "A", message: "  Save notes  " });
    assert.deepEqual(await a.next((msg) => msg.type === "commit" || msg.type === "error"), {
      type: "commit",
      commits: [{ author: "A", subject: "Save notes", paths: ["a.md", "extra.md"] }],
    });
    assert.equal(b.all.some((msg) => msg.type === "commit"), false);
    assert.equal(await git(dir, ["log", "-1", "--format=%an <%ae>%n%s"]), "A <A@viewmark.local>\nSave notes\n");
    assert.equal((await git(dir, ["log", "-1", "--format=%b"])).trim(), "a.md\nextra.md");
    assert.equal((await git(dir, ["log", "-1", "--format=%G?"])).trim(), "N");
    assert.equal(await git(dir, ["show", "HEAD:a.md"]), `X${ALPHA}`);
    assert.equal(await git(dir, ["show", "HEAD:extra.md"]), "");
    assert.equal((await git(dir, ["ls-tree", "-r", "--name-only", "HEAD"])).includes("b.md"), false);

    const hook = path.join(dir, ".git", "hooks", "pre-commit");
    await fs.mkdir(path.dirname(hook), { recursive: true });
    await fs.writeFile(hook, "#!/bin/sh\necho checkpoint-hook >&2\nexit 1\n");
    await fs.chmod(hook, 0o755);
    try {
      a.send({ type: "open", username: "A", path: "a.md" });
      const reopened = await a.next((msg) => msg.type === "file" && msg.path === "a.md");
      rev = reopened.rev;
      await syncLock(a, [], "A", "a.md", 0, rev);
      a.send({ type: "edit", username: "A", path: "a.md", rev, op: "insert", text: "Z" });
      rev = (await takeDoc(a)).rev;
      a.send({ type: "commit", username: "A", message: "Nope" });
      assert.deepEqual(await a.next((msg) => msg.type === "error" || msg.type === "commit"), {
        type: "error",
        status: 500,
      });
      assert.equal((await git(dir, ["rev-list", "--count", "HEAD"])).trim(), "1");
      assert.equal(await git(dir, ["show", "HEAD:a.md"]), `X${ALPHA}`);
    } finally {
      await fs.rm(hook, { force: true });
    }
    a.send({ type: "commit", username: "A" });
    assert.deepEqual(await a.next((msg) => msg.type === "commit" || msg.type === "error"), {
      type: "commit",
      commits: [{ author: "A", subject: "Edit a.md", paths: ["a.md"] }],
    });
    assert.equal(await git(dir, ["show", "HEAD:a.md"]), `ZX${ALPHA}`);
    assert.equal((await git(dir, ["rev-list", "--count", "HEAD"])).trim(), "2");
    const untilClosed = closed(a.ws);
    a.ws.close();
    await untilClosed;
    await delay(400);
    assert.equal((await git(dir, ["rev-list", "--count", "HEAD"])).trim(), "2");
    assert.equal((await git(dir, ["ls-tree", "-r", "--name-only", "HEAD"])).includes("b.md"), false);
    b.ws.close();
    bare.ws.close();
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
    parts.write(encodeFrame(0x1, Buffer.from('{"type":"repo","username":"A","name":"docs"}'), { mask: true }));
    parts.write(encodeFrame(0x1, Buffer.from('{"type":"list","username":"A"}'), { mask: true }));
    const deadline = Date.now() + 2000;
    while (!messages.some((msg) => msg.type === "docs") && Date.now() < deadline) await delay(20);
    assert.deepEqual(messages.find((msg) => msg.type === "docs"), { type: "docs", files: [], titles: {} });
    parts.end();
  });
});

test("T-idle", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "a.md"), ALPHA);
    const a = await hello(port, "Ada");
    const rev = (await openDoc(a, "Ada", "a.md")).rev;
    await syncLock(a, [], "Ada", "a.md", 0, rev);
    a.send({ type: "edit", username: "Ada", path: "a.md", rev, op: "insert", text: "X" });
    const doc = await takeDoc(a);
    await syncLock(a, [], "Ada", "a.md", doc.text.indexOf("gamma"), doc.rev);
    await assert.rejects(() => git(dir, ["rev-parse", "HEAD"]));
    const untilClosed = closed(a.ws);
    a.ws.close();
    await untilClosed;
    await delay(400);
    await assert.rejects(() => git(dir, ["rev-parse", "HEAD"]));
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
      await delay(400);
      await assert.rejects(() => git(dir, ["rev-parse", "HEAD"]));
      assert.equal(await readDoc(dir, "notes/idea.md"), "Hi");
      assert.equal(await readDoc(dir, "exists.md"), "keep");
      b.ws.close();
    });
  } finally {
    await fs.rm(outside, { recursive: true, force: true });
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }), head);
  }
});

const TICKET_KEYS = ["created", "depends", "id", "parent", "priority", "reporter", "state", "title", "type"];

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
    priority: "medium",
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
  await assert.rejects(() => git(dir, ["rev-parse", "HEAD"]));
  await close(server);
}

async function createTicket(client, username, title, state, type, body, priority) {
  const payload = { type: "ticket.create", username, title };
  if (state !== undefined) payload.state = state;
  if (type !== undefined) payload.ticketType = type;
  if (body !== undefined) payload.body = body;
  if (priority !== undefined) payload.priority = priority;
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
      titles: {},
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
      priority: "medium",
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
      { type: "ticket.create", username: "A", title: "Ok", body: 1 },
      { type: "ticket.create", username: "A", title: "Ok", body: null },
      { type: "ticket.create", username: "A", title: "Ok", body: false },
      { type: "ticket.create", username: "A", title: "Ok", body: {} },
      { type: "ticket.create", username: "A", title: "Ok", body: [] },
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

    const noted = "See the log.\n\nNext.\n";
    const withBody = await createTicket(a, "A", "Noted", undefined, undefined, noted);
    await b.next((msg) => msg.type === "tickets");
    assert.equal(withBody.file.text, noted);
    assert.equal(withBody.file.text.includes("title:"), false);
    assert.equal(withBody.file.rev, 0);
    const notedRaw = await readDoc(dir, withBody.file.path);
    const notedSplit = notedRaw.indexOf("\n\n");
    assert.ok(notedSplit >= 0);
    assert.equal(notedRaw.slice(notedSplit + 2), noted);
    assert.equal(parseTicket(withBody.file.ticket.id, notedRaw).body, noted);
    assert.equal(parseTicket(withBody.file.ticket.id, notedRaw).title, "Noted");

    const explicitEmpty = await createTicket(a, "A", "Blank", undefined, undefined, "");
    await b.next((msg) => msg.type === "tickets");
    assert.equal(explicitEmpty.file.text, "");
    assert.equal(parseTicket(explicitEmpty.file.ticket.id, await readDoc(dir, explicitEmpty.file.path)).body, "");

    await assertNoHead(server, dir);
  });
});

test("T-priority", async () => {
  await withDocs(async ({ port, dir }) => {
    const a = await hello(port, "A");
    const before = await snapshotTree(dir);
    a.send({ type: "ticket.create", username: "A", title: "Bad", priority: "nope" });
    assert.deepEqual(await a.next((msg) => msg.type === "error"), { type: "error", status: 400 });
    assert.deepEqual(await snapshotTree(dir), before);

    const plain = await createTicket(a, "A", "Plain");
    assert.equal(plain.file.ticket.priority, "medium");
    assert.deepEqual(Object.keys(plain.file.ticket), [
      "id", "title", "state", "type", "priority", "parent", "depends", "reporter", "created",
    ]);
    const plainPath = plain.file.path;
    const plainDisk = await readDoc(dir, plainPath);
    assert.equal(parseTicket(plain.file.ticket.id, plainDisk).priority, "medium");
    const plainHeader = plainDisk.split("\n");
    assert.equal(plainHeader[2], "type: task");
    assert.equal(plainHeader[3], "priority: medium");
    assert.equal(plain.listed.tickets.find((ticket) => ticket.id === plain.file.ticket.id).priority, "medium");
    assertTicketEntry(plain.file.ticket);

    const high = await createTicket(a, "A", "High", undefined, undefined, undefined, "high");
    assert.equal(high.file.ticket.priority, "high");
    assert.equal(high.file.ticket.state, "new");
    assert.equal(high.file.ticket.type, "task");
    const highPath = high.file.path;
    const highDisk = await readDoc(dir, highPath);
    assert.equal(parseTicket(high.file.ticket.id, highDisk).priority, "high");
    assert.equal(highDisk.split("\n")[3], "priority: high");
    assert.equal(high.listed.tickets.find((ticket) => ticket.id === high.file.ticket.id).priority, "high");
    assert.equal(high.listed.tickets.find((ticket) => ticket.id === plain.file.ticket.id).priority, "medium");

    a.send({ type: "ticket.set", username: "A", path: highPath, rev: 0, priority: "low" });
    const listed = await a.next((msg) => msg.type === "tickets");
    const meta = await a.next((msg) => msg.type === "ticket");
    assert.deepEqual(Object.keys(meta), [
      "type", "path", "rev", "title", "state", "ticketType", "priority", "parent", "depends", "reporter", "created",
    ]);
    assert.equal(meta.priority, "low");
    assert.equal(meta.rev, 1);
    assert.equal(parseTicket(high.file.ticket.id, await readDoc(dir, highPath)).priority, "low");
    assert.equal(listed.tickets.find((ticket) => ticket.id === high.file.ticket.id).priority, "low");
    for (const ticket of listed.tickets) assertTicketEntry(ticket);

    a.send({ type: "ticket.set", username: "A", path: plainPath, rev: 0, priority: "nope" });
    assert.deepEqual(
      await a.next((msg) => msg.type === "error" || msg.type === "ticket" || msg.type === "tickets"),
      { type: "error", status: 400 },
    );
    assert.equal(await readDoc(dir, plainPath), plainDisk);
    assert.equal(parseTicket(plain.file.ticket.id, await readDoc(dir, plainPath)).priority, "medium");
    a.ws.close();
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
      priority: "medium",
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
      priority: "medium",
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
    assert.deepEqual(await bye.next((msg) => msg.type === "docs"), { type: "docs", files: ["doc.md"], titles: {} });

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

test("T-repo-isolate", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-iso-"));
  const state = path.join(parent, "state");
  const one = path.join(parent, "one");
  const two = path.join(parent, "two");
  const server = await start(0, state);
  try {
    const port = server.address().port;
    const bare = await hello(port, "A", null);
    for (const payload of [
      { type: "list", username: "A" },
      { type: "open", username: "A", path: "a.md" },
      { type: "create", username: "A", path: "n.md" },
      { type: "edit", username: "A", path: "a.md", rev: 0, op: "insert", text: "Z" },
      { type: "lock", username: "A", path: "a.md", anchor: 0, cursor: 0, rev: 0 },
      { type: "undo", username: "A", path: "a.md", rev: 0 },
      { type: "redo", username: "A", path: "a.md", rev: 0 },
      { type: "tickets", username: "A" },
      { type: "ticket.create", username: "A", title: "X" },
      { type: "ticket.set", username: "A", path: "tickets/aaaaaaaa.md", rev: 0, title: "N" },
      { type: "ticket.purge", username: "A" },
    ]) {
      bare.send(payload);
      assert.deepEqual(await bare.next((msg) => msg.type === "error"), { type: "error", status: 400 });
    }
    bare.ws.close();

    await registerRepo(port, "one", "One", one);
    await registerRepo(port, "two", "Two", two);
    await fs.writeFile(path.join(one, "a.md"), "alpha\n");
    await fs.writeFile(path.join(two, "a.md"), "beta\n");

    const client = await hello(port, "A", null);
    client.send({ type: "repo", username: "A", name: "one" });
    client.send({ type: "open", username: "A", path: "a.md" });
    const opened = await client.next((msg) => msg.type === "file" || msg.type === "docs" || msg.type === "error");
    assert.equal(opened.type, "file");
    assert.equal(opened.text, "alpha\n");
    client.send({ type: "ticket.create", username: "A", title: "Only one" });
    const created = await client.next((msg) => msg.type === "tickets");
    assert.equal(created.tickets.length, 1);
    await client.next((msg) => msg.type === "file");

    client.send({ type: "repo", username: "A", name: "two" });
    client.send({ type: "open", username: "A", path: "a.md" });
    const other = await client.next((msg) => msg.type === "file" || msg.type === "docs" || msg.type === "error");
    assert.equal(other.type, "file");
    assert.equal(other.text, "beta\n");
    client.send({ type: "tickets", username: "A" });
    const listed = await client.next((msg) => msg.type === "tickets");
    assert.deepEqual(listed.tickets, []);
    client.ws.close();
  } finally {
    await close(server);
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("T-repo-registry", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-reg-"));
  const state = path.join(parent, "state");
  const docs = path.join(parent, "docs");
  const nested = path.join(docs, "child");
  const other = path.join(parent, "other");
  const outer = path.join(parent, "outer");
  const inner = path.join(outer, "inner");
  const ghost = path.join(parent, "ghost");
  const server = await start(0, state);
  try {
    const port = server.address().port;
    await assert.rejects(() => fs.stat(path.join(state, ".git")));
    const client = await hello(port, "A", null);
    client.send({ type: "repos", username: "A" });
    assert.deepEqual(await client.next((msg) => msg.type === "repos"), { type: "repos", repos: [] });

    client.send({ type: "repo.register", username: "A", name: "docs", description: "  Docs  ", path: docs });
    const registered = await client.next((msg) => msg.type === "repos" || msg.type === "error");
    assert.equal(registered.type, "repos");
    const docsReal = await fs.realpath(docs);
    assert.deepEqual(registered.repos, [{ name: "docs", description: "Docs", path: docsReal }]);
    await fs.writeFile(path.join(docs, "keep.md"), "keep\n");
    const saved = await fs.readFile(path.join(state, "repos.json"), "utf8");

    client.send({ type: "repo.register", username: "A", name: "docs", description: "Again", path: other });
    assert.deepEqual(await client.next((msg) => msg.type === "error"), { type: "error", status: 409 });
    client.send({ type: "repo.register", username: "A", name: "alias", description: "Alias", path: `${docs}${path.sep}.` });
    assert.deepEqual(await client.next((msg) => msg.type === "error"), { type: "error", status: 409 });
    client.send({ type: "repo.register", username: "A", name: "Bad Name", description: "Nope", path: other });
    assert.deepEqual(await client.next((msg) => msg.type === "error"), { type: "error", status: 400 });
    client.send({ type: "repo.register", username: "A", name: "child", description: "Child", path: nested });
    assert.deepEqual(await client.next((msg) => msg.type === "error"), { type: "error", status: 400 });
    client.send({ type: "repo.register", username: "A", name: "src", description: "Package", path: repoRoot });
    assert.deepEqual(await client.next((msg) => msg.type === "error"), { type: "error", status: 400 });
    client.send({ type: "repo.register", username: "A", name: "broken", description: "has\nline", path: other });
    assert.deepEqual(await client.next((msg) => msg.type === "error"), { type: "error", status: 400 });
    client.send({ type: "repo.register", username: "A", name: "tabbed", description: "has\ttab", path: other });
    assert.deepEqual(await client.next((msg) => msg.type === "error"), { type: "error", status: 400 });
    client.send({ type: "repo.register", username: "A", name: "blank", description: "   ", path: other });
    assert.deepEqual(await client.next((msg) => msg.type === "error"), { type: "error", status: 400 });
    assert.equal(await fs.readFile(path.join(state, "repos.json"), "utf8"), saved);
    await assert.rejects(() => fs.lstat(other));
    await assert.rejects(() => fs.lstat(nested));
    await assert.rejects(() => fs.stat(path.join(state, ".git")));

    client.send({ type: "repo.register", username: "A", name: "inner", description: "Inner", path: inner });
    const innerMsg = await client.next((msg) => msg.type === "repos" || msg.type === "error");
    assert.equal(innerMsg.type, "repos");
    client.send({ type: "repo.register", username: "A", name: "outer", description: "Outer", path: outer });
    assert.deepEqual(await client.next((msg) => msg.type === "error"), { type: "error", status: 400 });
    await assert.rejects(() => fs.stat(path.join(outer, ".git")));
    assert.equal((await fs.stat(path.join(inner, ".git"))).isDirectory(), true);

    client.send({ type: "repo.register", username: "A", name: "ghost", description: "Ghost", path: ghost });
    assert.equal((await client.next((msg) => msg.type === "repos" || msg.type === "error")).type, "repos");
    client.send({ type: "repo.deregister", username: "A", name: "missing" });
    assert.deepEqual(await client.next((msg) => msg.type === "error"), { type: "error", status: 404 });
    client.ws.close();
  } finally {
    await close(server);
  }

  await fs.rm(ghost, { recursive: true, force: true });
  const again = await start(0, state);
  try {
    const port = again.address().port;
    await assert.rejects(() => fs.lstat(ghost));
    const client = await hello(port, "B", null);
    client.send({ type: "repos", username: "B" });
    const listed = await client.next((msg) => msg.type === "repos");
    const names = listed.repos.map((repo) => repo.name);
    assert.deepEqual(names, ["docs", "ghost", "inner"]);
    assert.equal(listed.repos.find((repo) => repo.name === "docs").path, await fs.realpath(docs));
    assert.equal(await fs.readFile(path.join(docs, "keep.md"), "utf8"), "keep\n");

    client.send({ type: "repo.deregister", username: "B", name: "docs" });
    const after = await client.next((msg) => msg.type === "repos" || msg.type === "error");
    assert.equal(after.type, "repos");
    assert.equal(after.repos.some((repo) => repo.name === "docs"), false);
    assert.equal(await fs.readFile(path.join(docs, "keep.md"), "utf8"), "keep\n");
    assert.equal((await fs.stat(path.join(docs, ".git"))).isDirectory(), true);

    client.send({ type: "repo", username: "B", name: "docs" });
    assert.deepEqual(await client.next((msg) => msg.type === "error"), { type: "error", status: 404 });
    client.send({ type: "list", username: "B" });
    assert.deepEqual(await client.next((msg) => msg.type === "error"), { type: "error", status: 400 });
    await assert.rejects(() => fs.stat(path.join(state, ".git")));
    client.ws.close();
  } finally {
    await close(again);
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("T-repo-raw", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "a.md"), "a\n");
    const ok = await get(port, "/raw/docs/a.md");
    assert.equal(ok.status, 200);
    assert.equal(ok.body, "a\n");
    const bare = await get(port, "/raw/a.md");
    assert.equal(bare.status, 404);
    const rootOnly = await get(port, "/raw/");
    assert.equal(rootOnly.status, 404);
    const named = await get(port, "/raw/docs");
    assert.equal(named.status, 404);
    const trav = await get(port, "/raw/docs/..%2F..%2Fetc/passwd");
    assert.equal(trav.status, 404);
  });
});

test("T-repo-switch", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-switch-"));
  const state = path.join(parent, "state");
  const one = path.join(parent, "one");
  const two = path.join(parent, "two");
  const server = await start(0, state);
  try {
    const port = server.address().port;
    await registerRepo(port, "one", "One", one);
    await registerRepo(port, "two", "Two", two);
    await fs.writeFile(path.join(one, "a.md"), "alpha\n");
    await fs.writeFile(path.join(two, "a.md"), "alpha\n");
    const client = await hello(port, "A", null);
    client.send({ type: "repo", username: "A", name: "one" });
    client.send({ type: "open", username: "A", path: "a.md" });
    const opened = await client.next((msg) => msg.type === "file" && msg.path === "a.md");
    client.send({ type: "lock", username: "A", path: "a.md", anchor: 0, cursor: 0, rev: opened.rev });
    await client.next((msg) => msg.type === "locks" && msg.path === "a.md");
    client.send({ type: "edit", username: "A", path: "a.md", rev: opened.rev, op: "insert", text: "X" });
    const doc = await client.next((msg) => msg.type === "doc");
    assert.equal(doc.text, "Xalpha\n");
    await client.next((msg) => msg.type === "locks");
    await assert.rejects(() => git(one, ["rev-parse", "HEAD"]));
    client.send({ type: "repo", username: "A", name: "one" });
    client.send({ type: "list", username: "A" });
    const same = await client.next((msg) => msg.type === "docs" || msg.type === "error");
    assert.equal(same.type, "docs");
    await assert.rejects(() => git(one, ["rev-parse", "HEAD"]));

    client.send({ type: "repo", username: "A", name: "two" });
    client.send({ type: "open", username: "A", path: "a.md" });
    const next = await client.next((msg) => msg.type === "file" || msg.type === "docs" || msg.type === "error");
    assert.equal(next.type, "file");
    assert.equal(next.text, "alpha\n");
    assert.equal(await git(one, ["log", "-1", "--format=%an <%ae>%n%s"]), "A <A@viewmark.local>\nEdit a.md\n");
    assert.equal((await git(one, ["log", "-1", "--format=%b"])).trim(), "");
    assert.equal(await fs.readFile(path.join(one, "a.md"), "utf8"), "Xalpha\n");
    await assert.rejects(() => git(two, ["rev-parse", "HEAD"]));
    client.send({ type: "undo", username: "A", path: "a.md", rev: next.rev });
    assert.deepEqual(await client.next((msg) => msg.type === "error"), { type: "error", status: 409 });
    assert.equal(await fs.readFile(path.join(two, "a.md"), "utf8"), "alpha\n");
    client.ws.close();
  } finally {
    await close(server);
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("T-checkpoint", async (t) => {
  const realSetTimeout = setTimeout;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const wait = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));
  async function untilGit(dir, args) {
    let last;
    for (let i = 0; i < 100; i += 1) {
      try {
        return await git(dir, args);
      } catch (err) {
        last = err;
        await wait(20);
      }
    }
    throw last;
  }
  async function untilCount(dir, count) {
    let last = "";
    for (let i = 0; i < 100; i += 1) {
      try {
        last = (await git(dir, ["rev-list", "--count", "HEAD"])).trim();
        if (last === String(count)) return;
      } catch (err) {
        last = String(err && err.message ? err.message : err);
      }
      await wait(20);
    }
    throw new Error(`expected ${count} commits, saw ${last}`);
  }

  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "a.md"), ALPHA);
    await fs.writeFile(path.join(dir, "b.md"), "b\n");
    const ada = await hello(port, "Ada");
    let revA = (await openDoc(ada, "Ada", "a.md")).rev;
    await syncLock(ada, [], "Ada", "a.md", 0, revA);
    ada.send({ type: "edit", username: "Ada", path: "a.md", rev: revA, op: "insert", text: "X" });
    await takeDoc(ada);
    t.mock.timers.tick(3599999);
    await wait(400);
    await assert.rejects(() => git(dir, ["rev-parse", "HEAD"]));

    let revB = (await openDoc(ada, "Ada", "b.md")).rev;
    await syncLock(ada, [], "Ada", "b.md", 0, revB);
    ada.send({ type: "edit", username: "Ada", path: "b.md", rev: revB, op: "insert", text: "Y" });
    revB = (await takeDoc(ada)).rev;
    t.mock.timers.tick(1);
    await wait(400);
    await assert.rejects(() => git(dir, ["rev-parse", "HEAD"]));

    t.mock.timers.tick(3600000);
    assert.equal(await untilGit(dir, ["log", "-1", "--format=%an <%ae>"]), "Ada <Ada@viewmark.local>\n");
    assert.equal(await git(dir, ["log", "-1", "--format=%s"]), "Update docs\n");
    assert.equal((await git(dir, ["log", "-1", "--format=%b"])).trim(), "a.md\nb.md");
    assert.equal((await git(dir, ["log", "-1", "--format=%G?"])).trim(), "N");
    assert.equal(await git(dir, ["show", "HEAD:a.md"]), `X${ALPHA}`);
    assert.equal(await git(dir, ["show", "HEAD:b.md"]), "Yb\n");
    assert.equal((await git(dir, ["rev-list", "--count", "HEAD"])).trim(), "1");

    await syncLock(ada, [], "Ada", "b.md", 0, revB);
    ada.send({ type: "edit", username: "Ada", path: "b.md", rev: revB, op: "insert", text: "Z" });
    revB = (await takeDoc(ada)).rev;
    t.mock.timers.tick(3600000);
    await untilCount(dir, 2);
    assert.equal(await git(dir, ["log", "-1", "--format=%s"]), "Edit b.md\n");
    assert.equal(await git(dir, ["show", "HEAD:b.md"]), "ZYb\n");

    ada.send({ type: "undo", username: "Ada", path: "b.md", rev: revB });
    revB = (await takeDoc(ada)).rev;
    assert.equal(await readDoc(dir, "b.md"), "Yb\n");
    t.mock.timers.tick(3600000);
    await untilCount(dir, 3);
    assert.equal(await git(dir, ["show", "HEAD:b.md"]), "Yb\n");
    assert.equal((await git(dir, ["log", "-1", "--format=%s"])).trim(), "Edit b.md");

    ada.send({ type: "redo", username: "Ada", path: "b.md", rev: revB });
    revB = (await takeDoc(ada)).rev;
    assert.equal(await readDoc(dir, "b.md"), "ZYb\n");
    t.mock.timers.tick(3600000);
    await untilCount(dir, 4);
    assert.equal(await git(dir, ["show", "HEAD:b.md"]), "ZYb\n");

    const hook = path.join(dir, ".git", "hooks", "pre-commit");
    await fs.mkdir(path.dirname(hook), { recursive: true });
    await fs.writeFile(hook, "#!/bin/sh\necho checkpoint-hook >&2\nexit 1\n");
    await fs.chmod(hook, 0o755);
    const logged = [];
    const orig = console.error;
    console.error = (...args) => logged.push(args);
    try {
      await syncLock(ada, [], "Ada", "b.md", 0, revB);
      ada.send({ type: "edit", username: "Ada", path: "b.md", rev: revB, op: "insert", text: "Q" });
      revB = (await takeDoc(ada)).rev;
      assert.equal(await readDoc(dir, "b.md"), "QZYb\n");
      t.mock.timers.tick(3600000);
      const hasHook = (args) => args.some((arg) => {
        const stderr = arg && arg.stderr != null ? String(arg.stderr) : "";
        const message = arg && arg.message != null ? String(arg.message) : "";
        return `${stderr}\n${message}`.includes("checkpoint-hook");
      });
      for (let i = 0; i < 100 && !logged.some(hasHook); i += 1) await wait(20);
      assert.equal(logged.some(hasHook), true);
      assert.equal((await git(dir, ["rev-list", "--count", "HEAD"])).trim(), "4");
      assert.equal(await git(dir, ["show", "HEAD:b.md"]), "ZYb\n");
    } finally {
      console.error = orig;
      await fs.rm(hook, { force: true });
    }
    ada.send({ type: "commit", username: "Ada" });
    assert.deepEqual(await ada.next((msg) => msg.type === "commit" || msg.type === "error"), {
      type: "commit",
      commits: [{ author: "Ada", subject: "Edit b.md", paths: ["b.md"] }],
    });
    assert.equal(await git(dir, ["show", "HEAD:b.md"]), "QZYb\n");
    assert.equal(await git(dir, ["show", "HEAD:a.md"]), `X${ALPHA}`);
    ada.ws.close();
  });
});

test("T-checkpoint-split", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-split-"));
  const state = path.join(parent, "state");
  const docs = path.join(parent, "docs");
  const other = path.join(parent, "other");
  const tix = path.join(parent, "tix");
  const server = await start(0, state);
  try {
    const port = server.address().port;
    await registerRepo(port, "docs", "Docs", docs);
    await registerRepo(port, "other", "Other", other);
    await registerRepo(port, "tix", "Tix", tix);
    await fs.writeFile(path.join(docs, "a.md"), "a\n");
    await fs.writeFile(path.join(docs, "b.md"), "b\n");
    await fs.writeFile(path.join(other, "c.md"), "c\n");
    await fs.writeFile(path.join(other, "d.md"), "d\n");
    const ada = await hello(port, "Ada");
    const bo = await hello(port, "Bo");

    let revA = (await openDoc(ada, "Ada", "a.md")).rev;
    await syncLock(ada, [], "Ada", "a.md", 0, revA);
    ada.send({ type: "edit", username: "Ada", path: "a.md", rev: revA, op: "insert", text: "X" });
    await takeDoc(ada);
    let revB = (await openDoc(bo, "Bo", "b.md")).rev;
    await syncLock(bo, [], "Bo", "b.md", 0, revB);
    bo.send({ type: "edit", username: "Bo", path: "b.md", rev: revB, op: "insert", text: "Y" });
    await takeDoc(bo);

    ada.send({ type: "commit", username: "Ada" });
    assert.deepEqual(await ada.next((msg) => msg.type === "commit" || msg.type === "error"), {
      type: "commit",
      commits: [{ author: "Ada", subject: "Edit a.md", paths: ["a.md"] }],
    });
    assert.equal(bo.all.some((msg) => msg.type === "commit"), false);
    assert.equal(await git(docs, ["log", "-1", "--format=%an <%ae>%n%s"]), "Ada <Ada@viewmark.local>\nEdit a.md\n");
    assert.equal((await git(docs, ["ls-tree", "-r", "--name-only", "HEAD"])).trim(), "a.md");
    assert.equal(await git(docs, ["show", "HEAD:a.md"]), "Xa\n");

    ada.send({ type: "repo.deregister", username: "Ada", name: "docs" });
    const listed = await ada.next((msg) => msg.type === "repos");
    assert.equal(listed.repos.some((repo) => repo.name === "docs"), false);
    assert.equal((await fs.stat(docs)).isDirectory(), true);
    assert.equal(await fs.readFile(path.join(docs, "a.md"), "utf8"), "Xa\n");
    assert.equal(await fs.readFile(path.join(docs, "b.md"), "utf8"), "Yb\n");
    assert.equal(await git(docs, ["log", "-1", "--format=%an <%ae>%n%s"]), "Bo <Bo@viewmark.local>\nEdit b.md\n");
    assert.equal(await git(docs, ["show", "HEAD:b.md"]), "Yb\n");
    assert.equal((await git(docs, ["rev-list", "--count", "HEAD"])).trim(), "2");

    ada.send({ type: "repo", username: "Ada", name: "tix" });
    const keep = await createTicket(ada, "Ada", "Keep");
    const relK = keep.file.path;
    const idK = keep.file.ticket.id;
    ada.send({ type: "commit", username: "Ada" });
    assert.deepEqual(await ada.next((msg) => msg.type === "commit"), {
      type: "commit",
      commits: [{ author: "Ada", subject: `Edit ${relK}`, paths: [relK] }],
    });
    assert.equal(parseTicket(idK, await git(tix, ["show", `HEAD:${relK}`])).title, "Keep");

    ada.send({ type: "ticket.set", username: "Ada", path: relK, rev: 0, title: "Kept" });
    const kept = await ada.next((msg) => msg.type === "ticket");
    await ada.next((msg) => msg.type === "tickets");
    assert.equal(kept.rev, 1);
    ada.send({ type: "commit", username: "Ada" });
    await ada.next((msg) => msg.type === "commit");
    assert.equal(parseTicket(idK, await git(tix, ["show", `HEAD:${relK}`])).title, "Kept");

    await syncLock(ada, [], "Ada", relK, 0, kept.rev);
    ada.send({ type: "edit", username: "Ada", path: relK, rev: kept.rev, op: "insert", text: "Hello\n" });
    const body = await takeDoc(ada);
    assert.equal(body.text, "Hello\n");
    ada.send({ type: "commit", username: "Ada" });
    await ada.next((msg) => msg.type === "commit");
    assert.equal(parseTicket(idK, await git(tix, ["show", `HEAD:${relK}`])).body, "Hello\n");

    const child = await createTicket(ada, "Ada", "Child");
    const relC = child.file.path;
    const idC = child.file.ticket.id;
    ada.send({ type: "commit", username: "Ada" });
    assert.deepEqual((await ada.next((msg) => msg.type === "commit")).commits[0].paths, [relC]);

    ada.send({ type: "ticket.set", username: "Ada", path: relK, rev: body.rev, depends: [idC] });
    const linked = await ada.next((msg) => msg.type === "tickets");
    assert.deepEqual(linked.tickets.find((ticket) => ticket.id === idK).depends, [idC]);
    ada.send({ type: "commit", username: "Ada" });
    await ada.next((msg) => msg.type === "commit");
    assert.deepEqual(parseTicket(idK, await git(tix, ["show", `HEAD:${relK}`])).depends, [idC]);

    ada.send({ type: "ticket.set", username: "Ada", path: relC, rev: 0, state: "closed" });
    await ada.next((msg) => msg.type === "ticket");
    await ada.next((msg) => msg.type === "tickets");
    ada.send({ type: "ticket.purge", username: "Ada" });
    await ada.next((msg) => msg.type === "tickets");
    await assert.rejects(() => fs.lstat(path.join(tix, relC)));
    ada.send({ type: "commit", username: "Ada" });
    const purged = await ada.next((msg) => msg.type === "commit");
    const purgedPaths = [relK, relC].sort();
    assert.deepEqual(purged.commits, [{ author: "Ada", subject: "Update tix", paths: purgedPaths }]);
    assert.equal((await git(tix, ["log", "-1", "--format=%b"])).trim(), purgedPaths.join("\n"));
    assert.equal((await git(tix, ["ls-tree", "-r", "--name-only", "HEAD"])).includes(relC), false);
    assert.deepEqual(parseTicket(idK, await git(tix, ["show", `HEAD:${relK}`])).depends, []);
    const count = (await git(tix, ["rev-list", "--count", "HEAD"])).trim();

    const temp = await createTicket(ada, "Ada", "Temp");
    ada.send({ type: "ticket.set", username: "Ada", path: temp.file.path, rev: 0, state: "closed" });
    await ada.next((msg) => msg.type === "ticket");
    await ada.next((msg) => msg.type === "tickets");
    ada.send({ type: "ticket.purge", username: "Ada" });
    await ada.next((msg) => msg.type === "tickets");
    ada.send({ type: "commit", username: "Ada" });
    assert.deepEqual(await ada.next((msg) => msg.type === "commit"), { type: "commit", commits: [] });
    assert.equal((await git(tix, ["rev-list", "--count", "HEAD"])).trim(), count);
    assert.equal((await git(tix, ["ls-tree", "-r", "--name-only", "HEAD"])).includes(temp.file.path), false);

    ada.send({ type: "repo", username: "Ada", name: "other" });
    bo.send({ type: "repo", username: "Bo", name: "other" });
    const openedC = await openDoc(ada, "Ada", "c.md");
    await syncLock(ada, [], "Ada", "c.md", 0, openedC.rev);
    ada.send({ type: "edit", username: "Ada", path: "c.md", rev: openedC.rev, op: "insert", text: "C" });
    await takeDoc(ada);
    const openedD = await openDoc(bo, "Bo", "d.md");
    await syncLock(bo, [], "Bo", "d.md", 0, openedD.rev);
    bo.send({ type: "edit", username: "Bo", path: "d.md", rev: openedD.rev, op: "insert", text: "D" });
    await takeDoc(bo);
    const adaClosed = closed(ada.ws);
    const boClosed = closed(bo.ws);
    ada.ws.close();
    bo.ws.close();
    await adaClosed;
    await boClosed;
    await delay(400);
    await assert.rejects(() => git(other, ["rev-parse", "HEAD"]));
    await close(server);
    assert.equal(
      await git(other, ["log", "--reverse", "--format=%an <%ae>%n%s"]),
      "Ada <Ada@viewmark.local>\nEdit c.md\nBo <Bo@viewmark.local>\nEdit d.md\n",
    );
    assert.equal(await git(other, ["show", "HEAD:c.md"]), "Cc\n");
    assert.equal(await git(other, ["show", "HEAD:d.md"]), "Dd\n");
    assert.equal((await fs.stat(other)).isDirectory(), true);
  } finally {
    await close(server).catch(() => {});
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("T-move", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.mkdir(path.join(dir, "archive"), { recursive: true });
    await fs.mkdir(path.join(dir, "notes", "sub"), { recursive: true });
    await fs.mkdir(path.join(dir, "elsewhere"), { recursive: true });
    await fs.writeFile(path.join(dir, "archive", "keep.md"), "# Keep  \n");
    await fs.writeFile(path.join(dir, "archive", "plain.md"), "# Taken\n");
    await fs.writeFile(path.join(dir, "elsewhere", "plain.md"), "# Elsewhere\n");
    await fs.writeFile(path.join(dir, "notes", "idea.md"), "intro\n# Idea Title\n");
    await fs.writeFile(path.join(dir, "notes", "sub", "deep.md"), "# Deep\n");
    await fs.writeFile(path.join(dir, "notes", "extra.txt"), "pic\n");
    await fs.writeFile(path.join(dir, "plain.md"), "no heading\n");
    await fs.writeFile(path.join(dir, "hash.md"), "#Title\n");
    await fs.writeFile(path.join(dir, "bare.md"), "#\n");
    await fs.writeFile(path.join(dir, "blankhash.md"), "# \n");
    await fs.writeFile(path.join(dir, "second.md"), "## Second\n# Later\n");
    await fs.writeFile(path.join(dir, "cached.md"), "# Disk\n");
    await writeTicket(dir, {
      id: "aaaaaaaa",
      title: "Hidden",
      state: "new",
      created: "2020-01-01T00:00:00.000Z",
      body: "secret\n",
    });

    const bare = await hello(port, "Bare", null);
    bare.send({ type: "move", username: "Bare", path: "plain.md", dir: "" });
    assert.deepEqual(await bare.next((msg) => msg.type === "error"), { type: "error", status: 400 });
    bare.ws.close();

    const a = await hello(port, "A");
    const b = await hello(port, "B");
    const openedCache = await openDoc(a, "A", "cached.md");
    assert.equal(openedCache.text, "# Disk\n");
    await fs.writeFile(path.join(dir, "cached.md"), "# Other\n");
    a.send({ type: "list", username: "A" });
    const listed = await a.next((msg) => msg.type === "docs");
    assert.deepEqual(listed.files, [
      "archive/keep.md",
      "archive/plain.md",
      "bare.md",
      "blankhash.md",
      "cached.md",
      "elsewhere/plain.md",
      "hash.md",
      "notes/idea.md",
      "notes/sub/deep.md",
      "plain.md",
      "second.md",
    ]);
    assert.equal(listed.files.every((file) => typeof file === "string"), true);
    assert.deepEqual(listed.titles, {
      "archive/keep.md": "Keep",
      "archive/plain.md": "Taken",
      "cached.md": "Disk",
      "elsewhere/plain.md": "Elsewhere",
      "notes/idea.md": "Idea Title",
      "notes/sub/deep.md": "Deep",
      "second.md": "Later",
    });

    const beforeRejects = await snapshotTree(dir);
    for (const payload of [
      { type: "move", username: "A", path: "tickets", dir: "" },
      { type: "move", username: "A", path: "tickets/aaaaaaaa.md", dir: "archive" },
      { type: "move", username: "A", path: "tickets/missing.md", dir: "" },
      { type: "move", username: "A", path: "plain.md", dir: "tickets" },
      { type: "move", username: "A", path: "notes", dir: "notes" },
      { type: "move", username: "A", path: "notes", dir: "notes/sub" },
    ]) {
      a.send(payload);
      assert.deepEqual(await a.next((msg) => msg.type === "error" || msg.type === "docs"), { type: "error", status: 400 });
    }
    a.send({ type: "move", username: "A", path: "elsewhere/plain.md", dir: "archive" });
    assert.deepEqual(await a.next((msg) => msg.type === "error" || msg.type === "docs"), { type: "error", status: 409 });
    a.send({ type: "move", username: "A", path: "missing.md", dir: "archive" });
    assert.deepEqual(await a.next((msg) => msg.type === "error" || msg.type === "docs"), { type: "error", status: 404 });
    a.send({ type: "move", username: "A", path: "../x.md", dir: "" });
    assert.deepEqual(await a.next((msg) => msg.type === "error" || msg.type === "docs"), { type: "error", status: 404 });
    a.send({ type: "move", username: "A", path: "plain.md", dir: "nope" });
    assert.deepEqual(await a.next((msg) => msg.type === "error" || msg.type === "docs"), { type: "error", status: 404 });
    assert.equal(a.all.some((msg) => msg.type === "docs"), false);
    assert.deepEqual(await snapshotTree(dir), beforeRejects);

    const opened = await openDoc(b, "B", "notes/idea.md");
    assert.equal(opened.rev, 0);
    assert.equal(opened.text, "intro\n# Idea Title\n");
    await syncLock(b, [], "B", "notes/idea.md", 0, opened.rev);
    b.send({ type: "edit", username: "B", path: "notes/idea.md", rev: opened.rev, op: "insert", text: "Q" });
    const doc = await takeDoc(b);
    assert.equal(doc.text, "Qintro\n# Idea Title\n");
    assert.equal(doc.rev, 1);
    b.send({ type: "commit", username: "B" });
    assert.deepEqual(await b.next((msg) => msg.type === "commit" || msg.type === "error"), {
      type: "commit",
      commits: [{ author: "B", subject: "Edit notes/idea.md", paths: ["notes/idea.md"] }],
    });

    a.send({ type: "move", username: "A", path: "notes/idea.md", dir: "archive" });
    const moved = await b.next((msg) => msg.type === "file" || msg.type === "docs" || msg.type === "error");
    assert.equal(moved.type, "file");
    assert.equal(moved.path, "archive/idea.md");
    assert.equal(moved.rev, 1);
    assert.equal(moved.text, "Qintro\n# Idea Title\n");
    assert.deepEqual(moved.locks, [{ index: 0, username: "B" }]);
    const docsB = await b.next((msg) => msg.type === "docs");
    const docsA = await a.next((msg) => msg.type === "docs" || msg.type === "file");
    assert.equal(docsA.type, "docs");
    assert.deepEqual(docsA.files, docsB.files);
    assert.equal(docsA.files.includes("archive/idea.md"), true);
    assert.equal(docsA.files.includes("notes/idea.md"), false);
    assert.equal(docsA.titles["archive/idea.md"], "Idea Title");
    assert.equal(docsA.titles["notes/idea.md"], undefined);
    assert.equal(a.all.length, 0);
    assert.equal(b.all.length, 0);
    assert.equal(await readDoc(dir, "archive/idea.md"), "Qintro\n# Idea Title\n");
    await assert.rejects(() => fs.lstat(path.join(dir, "notes", "idea.md")));

    await fs.writeFile(path.join(dir, "archive", "idea.md"), "# Sneaky\n");
    a.send({ type: "list", username: "A" });
    const cachedTitle = await a.next((msg) => msg.type === "docs");
    assert.equal(cachedTitle.titles["archive/idea.md"], "Idea Title");
    await fs.writeFile(path.join(dir, "archive", "idea.md"), "Qintro\n# Idea Title\n");

    a.send({ type: "commit", username: "A" });
    assert.deepEqual(await a.next((msg) => msg.type === "commit" || msg.type === "error"), {
      type: "commit",
      commits: [{ author: "A", subject: "Update docs", paths: ["archive/idea.md", "notes/idea.md"] }],
    });
    assert.equal(await git(dir, ["show", "HEAD:archive/idea.md"]), "Qintro\n# Idea Title\n");
    assert.equal((await git(dir, ["ls-tree", "-r", "--name-only", "HEAD"])).includes("notes/idea.md"), false);

    b.send({ type: "edit", username: "B", path: "notes/idea.md", rev: 1, op: "insert", text: "NO" });
    assert.deepEqual(await b.next((msg) => msg.type === "error" || msg.type === "doc"), { type: "error", status: 409 });
    assert.equal(await readDoc(dir, "archive/idea.md"), "Qintro\n# Idea Title\n");
    b.send({ type: "edit", username: "B", path: "archive/idea.md", rev: 1, op: "insert", text: "Z" });
    const edited = await takeDoc(b);
    assert.equal(edited.rev, 2);
    assert.equal(edited.text, "QZintro\n# Idea Title\n");
    assert.equal(await readDoc(dir, "archive/idea.md"), "QZintro\n# Idea Title\n");

    a.send({ type: "move", username: "A", path: "archive/idea.md", dir: "" });
    const topped = await b.next((msg) => msg.type === "file" || msg.type === "error");
    assert.equal(topped.type, "file");
    assert.equal(topped.path, "idea.md");
    assert.equal(topped.rev, 2);
    assert.equal(topped.text, "QZintro\n# Idea Title\n");
    const topDocsB = await b.next((msg) => msg.type === "docs");
    const topDocsA = await a.next((msg) => msg.type === "docs" || msg.type === "file");
    assert.equal(topDocsA.type, "docs");
    assert.equal(topDocsA.files.includes("idea.md"), true);
    assert.equal(topDocsA.files.includes("archive/idea.md"), false);
    assert.equal(topDocsB.titles["idea.md"], "Idea Title");
    assert.equal(await readDoc(dir, "idea.md"), "QZintro\n# Idea Title\n");
    await assert.rejects(() => fs.lstat(path.join(dir, "archive", "idea.md")));
    assert.equal(a.all.length, 0);
    assert.equal(b.all.length, 0);

    await openDoc(b, "B", "notes/sub/deep.md");
    a.send({ type: "move", username: "A", path: "notes", dir: "archive" });
    const nested = await b.next((msg) => msg.type === "file" || msg.type === "error");
    assert.equal(nested.type, "file");
    assert.equal(nested.path, "archive/notes/sub/deep.md");
    assert.equal(nested.rev, 0);
    assert.equal(nested.text, "# Deep\n");
    const nestDocsB = await b.next((msg) => msg.type === "docs");
    const nestDocsA = await a.next((msg) => msg.type === "docs" || msg.type === "file");
    assert.equal(nestDocsA.type, "docs");
    assert.equal(nestDocsA.files.includes("archive/notes/sub/deep.md"), true);
    assert.equal(nestDocsA.files.includes("notes/sub/deep.md"), false);
    assert.equal(nestDocsB.titles["archive/notes/sub/deep.md"], "Deep");
    assert.equal(await readDoc(dir, "archive/notes/sub/deep.md"), "# Deep\n");
    assert.equal(await readDoc(dir, "archive/notes/extra.txt"), "pic\n");
    await assert.rejects(() => fs.lstat(path.join(dir, "notes")));
    assert.equal(a.all.length, 0);
    assert.equal(b.all.length, 0);

    a.send({ type: "move", username: "A", path: "archive/notes", dir: "" });
    const restored = await b.next((msg) => msg.type === "file" || msg.type === "error");
    assert.equal(restored.type, "file");
    assert.equal(restored.path, "notes/sub/deep.md");
    assert.equal(restored.rev, 0);
    assert.equal(restored.text, "# Deep\n");
    await b.next((msg) => msg.type === "docs");
    const backDocs = await a.next((msg) => msg.type === "docs" || msg.type === "file");
    assert.equal(backDocs.type, "docs");
    assert.equal(backDocs.files.includes("notes/sub/deep.md"), true);
    assert.equal(backDocs.files.includes("archive/notes/sub/deep.md"), false);
    assert.equal(await readDoc(dir, "notes/sub/deep.md"), "# Deep\n");
    assert.equal(await readDoc(dir, "notes/extra.txt"), "pic\n");
    await assert.rejects(() => fs.lstat(path.join(dir, "archive", "notes")));
    assert.equal(a.all.length, 0);
    assert.equal(b.all.length, 0);

    a.send({ type: "move", username: "A", path: "archive/keep.md", dir: "archive" });
    // A pending next() would stay first in line and swallow the next frame.
    await delay(200);
    assert.equal(a.all.length, 0);
    assert.equal(b.all.length, 0);
    assert.equal(await readDoc(dir, "archive/keep.md"), "# Keep  \n");

    await openDoc(a, "A", "archive/keep.md");
    await fs.rm(path.join(dir, "archive", "keep.md"));
    await fs.mkdir(path.join(dir, "fresh"));
    await fs.writeFile(path.join(dir, "fresh", "keep.md"), "# Fresh\n");
    const cachedDest = await snapshotTree(dir);
    a.send({ type: "move", username: "A", path: "fresh/keep.md", dir: "archive" });
    assert.deepEqual(await a.next((msg) => msg.type === "error" || msg.type === "docs"), { type: "error", status: 409 });
    assert.equal(a.all.some((msg) => msg.type === "docs"), false);
    assert.deepEqual(await snapshotTree(dir), cachedDest);
    assert.equal(await readDoc(dir, "fresh/keep.md"), "# Fresh\n");
    await assert.rejects(() => fs.lstat(path.join(dir, "archive", "keep.md")));

    a.ws.close();
    b.ws.close();
  });
});
