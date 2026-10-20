import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { start } from "../server.js";
import { allocateImageId, assetDirOf, imageFileName, imageKind, imageLineFor, imagePlacement, imageRangePlacement, normalizeDocRel, readBuild, rewriteImageDirs } from "../src/hub.js";
import { commentThreads, lockIndexAt, lockSpans, parseCommentNotes, plan, splitCommentNote } from "../src/doc.js";
import { TICKET_ALPHABET, composeTicket, parseTicket } from "../src/ticket.js";
import { MAX_PAYLOAD, createParser, encodeFrame } from "../src/ws.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALPHA = "alpha\nbeta\ngamma\n";

function getRaw(port, requestPath) {
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
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

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

async function hello(port, username, repo = "docs", session) {
  const client = connect(port);
  await client.ready;
  const greeting = { type: "hello", username };
  if (typeof session === "string") greeting.session = session;
  client.send(greeting);
  const greeted = await client.next((msg) => msg.type === "hello" || msg.type === "error");
  if (greeted.type !== "hello") throw new Error(`hello failed ${JSON.stringify(greeted)}`);
  if (Object.prototype.hasOwnProperty.call(greeted, "session")) {
    throw new Error(`hello reply includes session ${JSON.stringify(greeted)}`);
  }
  if (repo) client.send({ type: "repo", username, name: repo });
  return client;
}

async function waitClosed(socket) {
  socket.close();
  await closed(socket);
  await delay(30);
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

test("viewmark-favicon.svg is the page icon", async () => {
  const disk = await fs.readFile(path.join(repoRoot, "index.html"), "utf8");
  assert.match(disk, /<link rel="icon" href="viewmark-favicon.svg" type="image\/svg\+xml">/);
  await withServer(async (port) => {
    const res = await get(port, "/viewmark-favicon.svg");
    assert.equal(res.status, 200);
    assert.equal(res.type, "image/svg+xml");
    assert.ok(res.body.startsWith("<svg"));
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

test("T-seed-missing", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-seed-"));
  const state = path.join(parent, "state");
  const docs = path.join(parent, "missing");
  const server = await start(0, state);
  try {
    await registerRepo(server.address().port, "docs", "Docs", docs);
    const welcome = await fs.readFile(path.join(docs, "welcome.md"));
    const ticket = await fs.readFile(path.join(docs, "tickets", "seedmark.md"));
    assert.deepEqual(welcome, await fs.readFile(path.join(repoRoot, "samples", "welcome.md")));
    assert.deepEqual(ticket, await fs.readFile(path.join(repoRoot, "samples", "tickets", "seedmark.md")));
    assert.ok(parseTicket("seedmark", ticket.toString("utf8")));
  } finally {
    await close(server);
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("T-seed-occupied", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-seed-"));
  const state = path.join(parent, "state");
  const docs = path.join(parent, "kept");
  await fs.mkdir(docs);
  await fs.writeFile(path.join(docs, "keep.md"), "keep\n");
  const server = await start(0, state);
  try {
    await registerRepo(server.address().port, "docs", "Docs", docs);
    assert.equal(await fs.readFile(path.join(docs, "keep.md"), "utf8"), "keep\n");
    await assert.rejects(() => fs.lstat(path.join(docs, "welcome.md")));
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
    const client = await hello(port, "A");
    client.send({ type: "list", username: "A" });
    assert.deepEqual(await client.next((msg) => msg.type === "docs"), {
      type: "docs",
      files: ["a.md", "sub/b.markdown", "welcome.md"],
      titles: { "welcome.md": "Welcome" },
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
    const split = "alpha\n\nbeta\n";
    await fs.writeFile(path.join(dir, "a.md"), split);
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
    assert.deepEqual(await a.next((msg) => msg.type === "docs"), {
      type: "docs",
      files: ["a.md", "welcome.md"],
      titles: { "welcome.md": "Welcome" },
    });

    const a2 = await hello(port, "A");
    const rev = (await openDoc(a, "A", "a.md")).rev;
    await openDoc(a2, "A", "a.md");
    await syncLock(a, [a2], "A", "a.md", 0, rev);
    a2.send({ type: "lock", username: "A", path: "a.md", anchor: 0, cursor: 0, rev });
    assert.deepEqual(await a2.next((msg) => msg.type === "error"), { type: "error", status: 409, heldBy: "A" });
    const other = await syncLock(a2, [a], "A", "a.md", split.indexOf("beta"), rev);
    assert.deepEqual(other.lines, [
      { index: 0, username: "A" },
      { index: 2, username: "A" },
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
    assert.deepEqual(await b.next((msg) => msg.type === "error"), { type: "error", status: 409, heldBy: "A" });
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
      changes: [{ from: 0, to: 0, inserted: "X" }],
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

test("backspace in a blank run deletes that newline and leaves a later blank", async () => {
  await withDocs(async ({ port, dir }) => {
    const text = "a\n\n\n\nb\n";
    await fs.writeFile(path.join(dir, "a.md"), text);
    const a = await hello(port, "A");
    const b = await hello(port, "B");
    const opened = await openDoc(a, "A", "a.md");
    await openDoc(b, "B", "a.md");
    assert.equal(lockIndexAt(text, 2), 1);
    assert.equal(lockIndexAt(text, 4), 3);
    await syncLock(a, [b], "A", "a.md", 2, opened.rev);
    await syncLock(b, [a], "B", "a.md", 4, opened.rev);
    a.send({
      type: "edit",
      username: "A",
      path: "a.md",
      rev: opened.rev,
      anchor: 2,
      cursor: 2,
      op: "backspace",
    });
    const doc = await takeDoc(a);
    assert.deepEqual(await takeDoc(b), doc);
    assert.equal(doc.rev, opened.rev + 1);
    assert.equal(doc.text, "a\n\n\nb\n");
    assert.deepEqual(doc.changes, [{ from: 1, to: 2, inserted: "" }]);
    assert.equal(doc.from, 1);
    assert.equal(doc.to, 2);
    assert.equal(doc.inserted, "");
    assert.equal(await readDoc(dir, "a.md"), doc.text);
    b.send({ type: "open", username: "B", path: "a.md" });
    const again = await b.next((msg) => msg.type === "file" && msg.path === "a.md");
    assert.equal(again.cursor, 3);
    assert.equal(again.anchor, 3);
    assert.equal(lockIndexAt(doc.text, again.cursor), 2);
    assert.deepEqual(again.locks.find((line) => line.username === "B"), { index: 2, username: "B" });
    a.ws.close();
    b.ws.close();
  });
});

test("append after a held paragraph applies", async () => {
  await withDocs(async ({ port, dir }) => {
    const text = "alpha\n";
    await fs.writeFile(path.join(dir, "a.md"), text);
    const a = await hello(port, "A");
    const b = await hello(port, "B");
    const opened = await openDoc(a, "A", "a.md");
    await openDoc(b, "B", "a.md");
    assert.equal(lockIndexAt(text, 0), 0);
    assert.ok(text.length > lockSpans(text)[0].end);
    await syncLock(b, [a], "B", "a.md", 0, opened.rev);
    a.send({
      type: "edit",
      username: "A",
      path: "a.md",
      rev: opened.rev,
      anchor: text.length,
      cursor: text.length,
      op: "insert",
      text: "\nlast\n",
    });
    const doc = await takeDoc(a);
    assert.deepEqual(await takeDoc(b), doc);
    assert.equal(doc.rev, opened.rev + 1);
    assert.equal(doc.text, "alpha\n\nlast\n");
    assert.deepEqual(doc.changes, [{ from: text.length, to: text.length, inserted: "\nlast\n" }]);
    b.send({ type: "open", username: "B", path: "a.md" });
    const again = await b.next((msg) => msg.type === "file" && msg.path === "a.md");
    assert.equal(again.cursor, 0);
    assert.deepEqual(again.locks.find((line) => line.username === "B"), { index: 0, username: "B" });
    assert.equal(await readDoc(dir, "a.md"), doc.text);
    a.ws.close();
    b.ws.close();
  });
});

test("zero newline at a held paragraph is refused and a blank line before it is not", async () => {
  await withDocs(async ({ port, dir }) => {
    const text = "hello\n";
    await fs.writeFile(path.join(dir, "a.md"), text);
    const a = await hello(port, "A");
    const b = await hello(port, "B");
    const opened = await openDoc(a, "A", "a.md");
    await openDoc(b, "B", "a.md");
    await syncLock(b, [a], "B", "a.md", 1, opened.rev);
    a.send({
      type: "edit",
      username: "A",
      path: "a.md",
      rev: opened.rev,
      anchor: 0,
      cursor: 0,
      op: "insert",
      text: "zero\n",
    });
    assert.deepEqual(await a.next((msg) => msg.type === "error" || msg.type === "doc"), {
      type: "error",
      status: 409,
      heldBy: "B",
    });
    assert.equal(b.all.some((msg) => msg.type === "doc"), false);
    assert.equal(await readDoc(dir, "a.md"), text);
    a.send({
      type: "edit",
      username: "A",
      path: "a.md",
      rev: opened.rev,
      anchor: 0,
      cursor: 0,
      op: "insert",
      text: "zero\n\n",
    });
    const doc = await takeDoc(a);
    assert.deepEqual(await takeDoc(b), doc);
    assert.equal(doc.text, "zero\n\nhello\n");
    assert.equal(doc.rev, opened.rev + 1);
    b.send({ type: "open", username: "B", path: "a.md" });
    const again = await b.next((msg) => msg.type === "file" && msg.path === "a.md");
    assert.equal(again.cursor, 7);
    assert.equal(again.anchor, 7);
    assert.equal(lockIndexAt(doc.text, again.cursor), 2);
    assert.deepEqual(again.locks.find((line) => line.username === "B"), { index: 2, username: "B" });
    assert.equal(again.locks.some((line) => line.username === "A" && line.index === 2), false);
    assert.equal(await readDoc(dir, "a.md"), doc.text);
    a.ws.close();
    b.ws.close();
  });
});

test("undo and redo of comment.add restore the bytes in one rev each", async () => {
  await withDocs(async ({ port, dir }) => {
    const text = "hello fox\n";
    await fs.writeFile(path.join(dir, "a.md"), text);
    const a = await hello(port, "A");
    let rev = (await openDoc(a, "A", "a.md")).rev;
    await syncLock(a, [], "A", "a.md", 0, rev);
    a.send({
      type: "edit",
      username: "A",
      path: "a.md",
      rev,
      anchor: 6,
      cursor: 9,
      op: "comment.add",
    });
    let doc = await takeDoc(a);
    assert.equal(doc.rev, rev + 1);
    assert.equal(doc.changes.length, 2);
    assert.equal(applyListed(text, doc.changes), doc.text);
    assert.equal(doc.changes.some((change) => change.from <= 6 && change.to >= doc.text.indexOf("```comment")), false);
    assert.equal(await readDoc(dir, "a.md"), doc.text);
    const commented = doc.text;
    rev = doc.rev;
    a.send({ type: "undo", username: "A", path: "a.md", rev });
    doc = await takeDoc(a);
    assert.equal(doc.rev, rev + 1);
    assert.equal(doc.text, text);
    assert.equal(await readDoc(dir, "a.md"), text);
    rev = doc.rev;
    a.send({ type: "redo", username: "A", path: "a.md", rev });
    doc = await takeDoc(a);
    assert.equal(doc.rev, rev + 1);
    assert.equal(doc.text, commented);
    assert.equal(await readDoc(dir, "a.md"), commented);
    a.ws.close();
  });
});

function applyListed(text, changes) {
  let doc = text;
  for (const change of changes) doc = doc.slice(0, change.from) + change.inserted + doc.slice(change.to);
  return doc;
}

test("backspace at cursor 0 answers noop and the next insert applies", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "a.md"), ALPHA);
    const a = await hello(port, "A");
    const b = await hello(port, "B");
    const opened = await openDoc(a, "A", "a.md");
    assert.equal(Object.hasOwn(opened, "cursor"), false);
    await openDoc(b, "B", "a.md");
    a.send({ type: "edit", username: "A", path: "a.md", rev: opened.rev, op: "nope" });
    assert.deepEqual(await a.next((msg) => msg.type === "error" || msg.type === "noop" || msg.type === "doc"), {
      type: "error",
      status: 400,
    });
    a.send({
      type: "edit",
      username: "A",
      path: "a.md",
      rev: opened.rev,
      op: "comment.add",
      anchor: 0,
      cursor: 0,
    });
    assert.deepEqual(await a.next((msg) => msg.type === "error" || msg.type === "noop" || msg.type === "doc"), {
      type: "error",
      status: 409,
    });
    a.send({
      type: "edit",
      username: "A",
      path: "a.md",
      rev: opened.rev,
      cursor: 0,
      anchor: 0,
      op: "backspace",
    });
    assert.deepEqual(await a.next((msg) => msg.type === "noop" || msg.type === "doc" || msg.type === "error"), {
      type: "noop",
      path: "a.md",
      rev: opened.rev,
    });
    assert.equal(b.all.some((msg) => msg.type === "doc"), false);
    assert.equal(await readDoc(dir, "a.md"), ALPHA);
    await syncLock(a, [b], "A", "a.md", 0, opened.rev);
    a.send({ type: "edit", username: "A", path: "a.md", rev: opened.rev, op: "insert", text: "Q" });
    const doc = await takeDoc(a);
    const other = await takeDoc(b);
    assert.equal(doc.rev, opened.rev + 1);
    assert.equal(doc.text, `Q${ALPHA}`);
    assert.deepEqual(other, doc);
    assert.equal(await readDoc(dir, "a.md"), doc.text);
    a.send({ type: "open", username: "A", path: "a.md" });
    const again = await a.next((msg) => msg.type === "file" && msg.path === "a.md");
    assert.equal(again.rev, doc.rev);
    assert.equal(again.text, doc.text);
    assert.equal(again.cursor, doc.cursor);
    assert.equal(again.anchor, doc.anchor);
    a.ws.close();
    b.ws.close();
  });
});

test("delete at the end of the text answers noop", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "a.md"), ALPHA);
    const a = await hello(port, "A");
    const b = await hello(port, "B");
    const opened = await openDoc(a, "A", "a.md");
    await openDoc(b, "B", "a.md");
    const end = ALPHA.length;
    a.send({
      type: "edit",
      username: "A",
      path: "a.md",
      rev: opened.rev,
      cursor: end,
      anchor: end,
      op: "delete",
    });
    assert.deepEqual(await a.next((msg) => msg.type === "noop" || msg.type === "doc" || msg.type === "error"), {
      type: "noop",
      path: "a.md",
      rev: opened.rev,
    });
    assert.equal(b.all.some((msg) => msg.type === "doc"), false);
    assert.equal(await readDoc(dir, "a.md"), ALPHA);
    a.send({ type: "open", username: "A", path: "a.md" });
    const again = await a.next((msg) => msg.type === "file" && msg.path === "a.md");
    assert.equal(again.rev, opened.rev);
    assert.equal(again.text, ALPHA);
    assert.equal(again.cursor, 0);
    assert.equal(again.anchor, 0);
    a.ws.close();
    b.ws.close();
  });
});

test("empty undo and empty redo answer noop", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "a.md"), ALPHA);
    const a = await hello(port, "A");
    const b = await hello(port, "B");
    let rev = (await openDoc(a, "A", "a.md")).rev;
    await openDoc(b, "B", "a.md");
    const noop = async () => a.next((msg) => msg.type === "noop" || msg.type === "error" || msg.type === "doc");
    a.send({ type: "undo", username: "A", path: "a.md", rev });
    assert.deepEqual(await noop(), { type: "noop", path: "a.md", rev });
    a.send({ type: "redo", username: "A", path: "a.md", rev });
    assert.deepEqual(await noop(), { type: "noop", path: "a.md", rev });
    assert.equal(b.all.some((msg) => msg.type === "doc"), false);
    assert.equal(await readDoc(dir, "a.md"), ALPHA);

    await syncLock(a, [b], "A", "a.md", 0, rev);
    a.send({ type: "edit", username: "A", path: "a.md", rev, op: "insert", text: "Q" });
    let doc = await takeDoc(a);
    assert.deepEqual(await takeDoc(b), doc);
    assert.equal(doc.text, `Q${ALPHA}`);
    rev = doc.rev;
    a.send({ type: "undo", username: "A", path: "a.md", rev });
    doc = await takeDoc(a);
    assert.deepEqual(await takeDoc(b), doc);
    assert.equal(doc.text, ALPHA);
    assert.equal(await readDoc(dir, "a.md"), ALPHA);
    rev = doc.rev;
    a.send({ type: "undo", username: "A", path: "a.md", rev });
    assert.deepEqual(await noop(), { type: "noop", path: "a.md", rev });
    a.send({ type: "redo", username: "A", path: "a.md", rev });
    doc = await takeDoc(a);
    assert.deepEqual(await takeDoc(b), doc);
    assert.equal(doc.text, `Q${ALPHA}`);
    rev = doc.rev;
    a.send({ type: "redo", username: "A", path: "a.md", rev });
    assert.deepEqual(await noop(), { type: "noop", path: "a.md", rev });
    assert.equal(await readDoc(dir, "a.md"), `Q${ALPHA}`);
    a.ws.close();
    b.ws.close();
  });
});

test("T-undo", async () => {
  await withDocs(async ({ port, dir }) => {
    const lines = "alpha\n\nbeta\n\ngamma\n";
    await fs.writeFile(path.join(dir, "a.md"), lines);
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
    assert.equal(doc.text, "Xalpha\n\nYbeta\n\ngamma\n");
    b.send({ type: "undo", username: "B", path: "a.md", rev });
    doc = await takeDoc(b);
    await takeDoc(a);
    rev = doc.rev;
    assert.equal(doc.text, "Xalpha\n\nbeta\n\ngamma\n");
    assert.equal(await readDoc(dir, "a.md"), doc.text);

    a.send({ type: "undo", username: "A", path: "a.md", rev });
    doc = await takeDoc(a);
    await takeDoc(b);
    rev = doc.rev;
    assert.equal(doc.text, lines);
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
    assert.equal(doc.text, "alpha\n\nYbeta\n\ngamma\n");
    assert.equal(await readDoc(dir, "a.md"), doc.text);
    a.ws.close();
    b.ws.close();
  });
});

test("two forward deletes undo and redo each character", async () => {
  await withDocs(async ({ port, dir }) => {
    const text = "alpha beta\n";
    await fs.writeFile(path.join(dir, "a.md"), text);
    const a = await hello(port, "A");
    let rev = (await openDoc(a, "A", "a.md")).rev;
    await syncLock(a, [], "A", "a.md", 0, rev);
    a.send({ type: "edit", username: "A", path: "a.md", rev, op: "delete", cursor: 0, anchor: 0 });
    let doc = await takeDoc(a);
    rev = doc.rev;
    assert.equal(doc.text, "lpha beta\n");
    a.send({ type: "edit", username: "A", path: "a.md", rev, op: "delete", cursor: 0, anchor: 0 });
    doc = await takeDoc(a);
    rev = doc.rev;
    assert.equal(doc.text, "pha beta\n");
    a.send({ type: "undo", username: "A", path: "a.md", rev });
    doc = await takeDoc(a);
    rev = doc.rev;
    assert.equal(doc.text, "lpha beta\n");
    a.send({ type: "undo", username: "A", path: "a.md", rev });
    doc = await takeDoc(a);
    rev = doc.rev;
    assert.equal(doc.text, text);
    assert.equal(await readDoc(dir, "a.md"), text);
    a.send({ type: "redo", username: "A", path: "a.md", rev });
    doc = await takeDoc(a);
    rev = doc.rev;
    assert.equal(doc.text, "lpha beta\n");
    a.send({ type: "redo", username: "A", path: "a.md", rev });
    doc = await takeDoc(a);
    rev = doc.rev;
    assert.equal(doc.text, "pha beta\n");
    assert.equal(await readDoc(dir, "a.md"), doc.text);
    a.send({ type: "undo", username: "A", path: "a.md", rev });
    doc = await takeDoc(a);
    rev = doc.rev;
    assert.equal(doc.text, "lpha beta\n");
    a.send({ type: "undo", username: "A", path: "a.md", rev });
    doc = await takeDoc(a);
    assert.equal(doc.text, text);
    assert.equal(await readDoc(dir, "a.md"), text);
    a.ws.close();
  });
});

test("a foreign insert at a deleted offset shifts the earlier undo", async () => {
  await withDocs(async ({ port, dir }) => {
    const text = "alpha\n\nbeta\n";
    await fs.writeFile(path.join(dir, "a.md"), text);
    const a = await hello(port, "A");
    const b = await hello(port, "B");
    let rev = (await openDoc(a, "A", "a.md")).rev;
    await openDoc(b, "B", "a.md");
    await syncLock(a, [b], "A", "a.md", 0, rev);
    a.send({ type: "edit", username: "A", path: "a.md", rev, op: "delete", cursor: 0, anchor: 0 });
    let doc = await takeDoc(a);
    await takeDoc(b);
    rev = doc.rev;
    assert.equal(doc.text, "lpha\n\nbeta\n");
    await syncLock(a, [b], "A", "a.md", doc.text.indexOf("beta"), rev);
    await syncLock(b, [a], "B", "a.md", 0, rev);
    b.send({ type: "edit", username: "B", path: "a.md", rev, op: "insert", text: "Q", cursor: 0, anchor: 0 });
    doc = await takeDoc(b);
    await takeDoc(a);
    rev = doc.rev;
    assert.equal(doc.text, "Qlpha\n\nbeta\n");
    const gap = doc.text.indexOf("\n\n") + 1;
    await syncLock(b, [a], "B", "a.md", gap, rev);
    a.send({ type: "undo", username: "A", path: "a.md", rev });
    doc = await takeDoc(a);
    await takeDoc(b);
    assert.equal(doc.text, "Qalpha\n\nbeta\n");
    assert.equal(await readDoc(dir, "a.md"), doc.text);
    a.ws.close();
    b.ws.close();
  });
});

test("two backspaces undo each character", async () => {
  await withDocs(async ({ port, dir }) => {
    const text = "alpha beta\n";
    await fs.writeFile(path.join(dir, "a.md"), text);
    const a = await hello(port, "A");
    let rev = (await openDoc(a, "A", "a.md")).rev;
    await syncLock(a, [], "A", "a.md", 5, rev);
    a.send({ type: "edit", username: "A", path: "a.md", rev, op: "backspace", cursor: 5, anchor: 5 });
    let doc = await takeDoc(a);
    rev = doc.rev;
    assert.equal(doc.text, "alph beta\n");
    a.send({ type: "edit", username: "A", path: "a.md", rev, op: "backspace", cursor: 4, anchor: 4 });
    doc = await takeDoc(a);
    rev = doc.rev;
    assert.equal(doc.text, "alp beta\n");
    a.send({ type: "undo", username: "A", path: "a.md", rev });
    doc = await takeDoc(a);
    rev = doc.rev;
    assert.equal(doc.text, "alph beta\n");
    a.send({ type: "undo", username: "A", path: "a.md", rev });
    doc = await takeDoc(a);
    rev = doc.rev;
    assert.equal(doc.text, text);
    a.send({ type: "redo", username: "A", path: "a.md", rev });
    doc = await takeDoc(a);
    rev = doc.rev;
    assert.equal(doc.text, "alph beta\n");
    a.send({ type: "redo", username: "A", path: "a.md", rev });
    doc = await takeDoc(a);
    assert.equal(doc.text, "alp beta\n");
    assert.equal(await readDoc(dir, "a.md"), doc.text);
    a.ws.close();
  });
});

test("a deleted foreign insert stays in front of an earlier forward delete", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "a.md"), "alpha\n\nbeta\n");
    const a = await hello(port, "A");
    const b = await hello(port, "B");
    let rev = (await openDoc(a, "A", "a.md")).rev;
    await openDoc(b, "B", "a.md");
    await syncLock(a, [b], "A", "a.md", 0, rev);
    a.send({ type: "edit", username: "A", path: "a.md", rev, op: "delete", cursor: 0, anchor: 0 });
    let doc = await takeDoc(a);
    await takeDoc(b);
    rev = doc.rev;
    await syncLock(a, [b], "A", "a.md", doc.text.indexOf("beta"), rev);
    await syncLock(b, [a], "B", "a.md", 0, rev);
    b.send({ type: "edit", username: "B", path: "a.md", rev, op: "insert", text: "Q", cursor: 0, anchor: 0 });
    doc = await takeDoc(b);
    await takeDoc(a);
    rev = doc.rev;
    assert.equal(doc.text, "Qlpha\n\nbeta\n");
    const gap = doc.text.indexOf("\n\n") + 1;
    await syncLock(b, [a], "B", "a.md", gap, rev);
    await syncLock(a, [b], "A", "a.md", 0, rev);
    a.send({ type: "edit", username: "A", path: "a.md", rev, op: "delete", cursor: 0, anchor: 0 });
    doc = await takeDoc(a);
    await takeDoc(b);
    rev = doc.rev;
    assert.equal(doc.text, "lpha\n\nbeta\n");
    a.send({ type: "undo", username: "A", path: "a.md", rev });
    doc = await takeDoc(a);
    await takeDoc(b);
    rev = doc.rev;
    assert.equal(doc.text, "Qlpha\n\nbeta\n");
    a.send({ type: "undo", username: "A", path: "a.md", rev });
    doc = await takeDoc(a);
    await takeDoc(b);
    assert.equal(doc.text, "Qalpha\n\nbeta\n");
    assert.equal(await readDoc(dir, "a.md"), doc.text);
    a.ws.close();
    b.ws.close();
  });
});

test("T-undo-lock", async () => {
  await withDocs(async ({ port, dir }) => {
    const lines = "alpha\n\nbeta\n\ngamma\n";
    await fs.writeFile(path.join(dir, "a.md"), lines);
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
    assert.deepEqual(await a.next((msg) => msg.type === "error"), { type: "error", status: 409, heldBy: "B" });
    assert.ok((await readDoc(dir, "a.md")).startsWith("Z"));
    await syncLock(b, [a], "B", "a.md", doc.text.indexOf("beta"), rev);
    a.send({ type: "undo", username: "A", path: "a.md", rev });
    doc = await takeDoc(a);
    await takeDoc(b);
    assert.equal(doc.text, "Zalpha\n\nbeta\n\ngamma\n");
    assert.equal(await readDoc(dir, "a.md"), doc.text);
    a.ws.close();
    b.ws.close();
  });
});

test("T-overlap", async () => {
  await withDocs(async ({ port, dir }) => {
    const lines = "alpha\n\nbeta\n\ngamma\n";
    await fs.writeFile(path.join(dir, "a.md"), lines);
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
    assert.equal(doc.text, lines);
    await syncLock(b, [a], "B", "a.md", doc.text.indexOf("beta"), rev);
    a.send({ type: "undo", username: "A", path: "a.md", rev });
    assert.deepEqual(await a.next((msg) => msg.type === "error"), { type: "error", status: 409 });
    assert.equal(await readDoc(dir, "a.md"), lines);
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
    assert.deepEqual(await a.next((msg) => msg.type === "noop" || msg.type === "error" || msg.type === "doc"), {
      type: "noop",
      path: "a.md",
      rev,
    });
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
    assert.deepEqual(await a.next((msg) => msg.type === "noop" || msg.type === "error" || msg.type === "doc"), {
      type: "noop",
      path: "a.md",
      rev,
    });
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

test("moving an image pin stores the fractions and keeps the notes", async () => {
  await withDocs(async ({ port, dir }) => {
    const text = "![box](box.svg)\n```comment c1 0.25,0.5\n:: 0\n@2026-10-16T15:00:00.000Z qa\nA pin.\n:: 1\n@2026-10-16T15:01:00.000Z qa\nStill here.\n```\nEnd.\n";
    await fs.writeFile(path.join(dir, "a.md"), text);
    const a = await hello(port, "A");
    let rev = (await openDoc(a, "A", "a.md")).rev;
    const end = text.indexOf("End");
    await syncLock(a, [], "A", "a.md", end, rev, end);
    a.send({
      type: "edit",
      username: "A",
      path: "a.md",
      rev,
      op: "comment.pin.move",
      id: "c1",
      x: 0.62,
      y: 0.18,
      anchor: end,
      cursor: end,
    });
    let doc = await takeDoc(a);
    rev = doc.rev;
    assert.match(doc.text, /```comment c1 0\.62,0\.18\n/);
    assert.match(doc.text, /A pin\.\n/);
    assert.match(doc.text, /Still here\.\n/);
    assert.equal(doc.text[doc.cursor], "E");
    assert.equal(await readDoc(dir, "a.md"), doc.text);
    a.send({
      type: "edit",
      username: "A",
      path: "a.md",
      rev,
      op: "comment.pin.move",
      id: "c1",
      x: 1.2,
      y: 0.2,
      anchor: doc.cursor,
      cursor: doc.cursor,
    });
    const err = await a.next((msg) => msg.type === "error" || msg.type === "doc" || msg.type === "noop");
    assert.equal(err.status, 400);
    assert.equal(err.reason, "pin is out of range");
    assert.equal(await readDoc(dir, "a.md"), doc.text);
    a.send({ type: "undo", username: "A", path: "a.md", rev });
    const back = await takeDoc(a);
    assert.match(back.text, /```comment c1 0\.25,0\.5\n/);
    assert.match(back.text, /Still here\.\n/);
    a.ws.close();
  });
});

test("comment.reply and comment.edit keep a caret that is not at the top", async () => {
  await withDocs(async ({ port, dir }) => {
    const rel = "long.md";
    const lines = `top\n${"x".repeat(400)}\ntail word here\n`;
    const at = lines.indexOf("tail");
    await fs.writeFile(path.join(dir, rel), lines);
    const a = await hello(port, "A");
    try {
      let rev = (await openDoc(a, "A", rel)).rev;
      await syncLock(a, [], "A", rel, at, rev, at + 4);
      a.send({
        type: "edit",
        username: "A",
        path: rel,
        rev,
        op: "comment.add",
        anchor: at,
        cursor: at + 4,
      });
      let doc = await takeDoc(a);
      rev = doc.rev;
      assert.ok(doc.cursor > at, `comment.add parked the caret at ${doc.cursor}`);
      const parked = doc.cursor;
      const parkedAnchor = doc.anchor;
      a.send({ type: "comment.reply", username: "A", path: rel, id: "c1", text: "a note" });
      doc = await takeDoc(a);
      assert.match(doc.text, /a note/);
      assert.equal(doc.cursor, parked);
      assert.equal(doc.anchor, parkedAnchor);
      assert.equal(await readDoc(dir, rel), doc.text);
      const thread = commentThreads(doc.text).find((item) => item.id === "c1");
      const written = parseCommentNotes(thread.body).find((note) => splitCommentNote(note.raw).text === "a note");
      assert.ok(written, "the reply has no note");
      a.send({
        type: "comment.edit",
        username: "A",
        path: rel,
        id: "c1",
        note: written.id,
        rev: doc.rev,
        text: "a longer note",
      });
      doc = await takeDoc(a);
      assert.match(doc.text, /a longer note/);
      assert.equal(doc.cursor, parked);
      assert.equal(doc.anchor, parkedAnchor);
    } finally {
      a.ws.close();
    }
  });
});

test("a page edit that changes a comment fence or the blank between fences answers 409 and writes nothing", async () => {
  await withDocs(async ({ port, dir }) => {
    const fence = (id) => `\`\`\`comment ${id} resolved\n:: 0\n@2026-10-05T16:00:00.000Z qa\nNote.\n\`\`\`\n`;
    const text = `See {c7}this{/c7} and {c8}that{/c8}.\n\n${fence("c7")}\n${fence("c8")}`;
    await fs.writeFile(path.join(dir, "a.md"), text);
    const a = await hello(port, "A");
    const opened = await openDoc(a, "A", "a.md");
    const rev = opened.rev;
    const opener = text.indexOf("```comment c8");
    const blank = opener - 1;
    a.send({
      type: "edit",
      username: "A",
      path: "a.md",
      rev,
      op: "insert",
      text: "x",
      anchor: opener,
      cursor: opener,
      exact: true,
    });
    assert.deepEqual(await a.next((msg) => msg.type === "error" || msg.type === "doc" || msg.type === "noop"), {
      type: "error",
      status: 409,
      reason: "changes a comment fence",
    });
    assert.equal(await readDoc(dir, "a.md"), text);
    a.send({
      type: "edit",
      username: "A",
      path: "a.md",
      rev,
      op: "insert",
      text: "",
      anchor: blank,
      cursor: blank + 1,
      exact: true,
    });
    assert.deepEqual(await a.next((msg) => msg.type === "error" || msg.type === "doc" || msg.type === "noop"), {
      type: "error",
      status: 409,
      reason: "changes a comment fence",
    });
    assert.equal(await readDoc(dir, "a.md"), text);
    a.send({
      type: "edit",
      username: "A",
      path: "a.md",
      rev,
      op: "backspace",
      anchor: text.length,
      cursor: text.length,
    });
    assert.deepEqual(await a.next((msg) => msg.type === "error" || msg.type === "doc" || msg.type === "noop"), {
      type: "error",
      status: 409,
      reason: "changes a comment fence",
    });
    assert.equal(await readDoc(dir, "a.md"), text);
    a.send({
      type: "edit",
      username: "A",
      path: "a.md",
      rev,
      op: "insert",
      text: "Hello",
      anchor: text.length,
      cursor: text.length,
    });
    const typed = await takeDoc(a);
    assert.equal(typed.text.startsWith(text), true);
    assert.equal(typed.text.endsWith("Hello"), true);
    assert.equal(typed.text.includes("```comment c7 resolved"), true);
    assert.equal(typed.text.includes("```comment c8 resolved"), true);
    assert.equal(await readDoc(dir, "a.md"), typed.text);
    a.send({
      type: "edit",
      username: "A",
      path: "a.md",
      rev: typed.rev,
      op: "comment.save",
      id: "c8",
      body: ":: 0\n@2026-10-05T16:00:00.000Z qa\nSaved.\n",
    });
    const saved = await takeDoc(a);
    // replaceCommentBody appends a newline after the body the card sent.
    assert.match(saved.text, /```comment c8 resolved\n:: 0\n@2026-10-05T16:00:00.000Z qa\nSaved.\n\n```\nHello$/);
    assert.match(saved.text, /```comment c7 resolved\n:: 0\n@2026-10-05T16:00:00.000Z qa\nNote.\n```/);
    assert.equal(await readDoc(dir, "a.md"), saved.text);
    a.ws.close();
  });
});

test("an insert that cuts a comment marker answers 409 and the file stays", async () => {
  await withDocs(async ({ port, dir }) => {
    const text = "See {c1}this{/c1} now.\n\n```comment c1\n:: 0\nnote\n```\n";
    await fs.writeFile(path.join(dir, "a.md"), text);
    const a = await hello(port, "A");
    const opened = await openDoc(a, "A", "a.md");
    a.send({
      type: "edit",
      username: "A",
      path: "a.md",
      rev: opened.rev,
      cursor: 6,
      anchor: 5,
      op: "insert",
      text: "X",
    });
    assert.deepEqual(await a.next((msg) => msg.type === "error" || msg.type === "doc" || msg.type === "noop"), {
      type: "error",
      status: 409,
    });
    assert.equal(await readDoc(dir, "a.md"), text);
    a.ws.close();
  });
});

test("T-shrink", async () => {
  await withDocs(async ({ port, dir }) => {
    const text = `${ALPHA}\n# H\n`;
    await fs.writeFile(path.join(dir, "a.md"), text);
    const a = await hello(port, "A");
    const b = await hello(port, "B");
    const opened = await openDoc(a, "A", "a.md");
    await openDoc(b, "B", "a.md");
    const locked = await syncLock(a, [b], "A", "a.md", 0, opened.rev, text.length);
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

test("a second socket editing a held paragraph gets 409", async () => {
  await withDocs(async ({ port, dir }) => {
    const para = "Alpha\nBeta\n";
    await fs.writeFile(path.join(dir, "a.md"), para);
    const a = await hello(port, "A");
    const b = await hello(port, "B");
    const opened = await openDoc(a, "A", "a.md");
    await openDoc(b, "B", "a.md");
    await syncLock(a, [b], "A", "a.md", 0, opened.rev);
    const beta = para.indexOf("Beta");
    b.send({
      type: "edit",
      username: "B",
      path: "a.md",
      rev: opened.rev,
      op: "insert",
      text: "Q",
      anchor: beta,
      cursor: beta,
    });
    assert.deepEqual(await b.next((msg) => msg.type === "error" || msg.type === "doc"), { type: "error", status: 409, heldBy: "A" });
    assert.equal(await readDoc(dir, "a.md"), para);
    a.ws.close();
    b.ws.close();

    const table = "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n";
    await fs.writeFile(path.join(dir, "t.md"), table);
    const owner = await hello(port, "A");
    const other = await hello(port, "B");
    const file = await openDoc(owner, "A", "t.md");
    await openDoc(other, "B", "t.md");
    const held = await syncLock(owner, [other], "A", "t.md", 0, file.rev, table.length);
    assert.ok(held.lines.some((line) => line.index === 1 && line.username === "A"));
    assert.ok(held.lines.some((line) => line.index === 2 && line.username === "A"));
    const from = table.indexOf("1");
    const to = table.indexOf("4") + 1;
    owner.send({
      type: "edit",
      username: "A",
      path: "t.md",
      rev: file.rev,
      op: "insert",
      text: "Z",
      anchor: from,
      cursor: to,
    });
    const doc = await takeDoc(owner);
    await other.next((msg) => msg.type === "doc" && msg.rev === doc.rev);
    assert.equal(doc.text.includes("Z"), true);
    assert.notEqual(doc.text, table);
    assert.equal(await readDoc(dir, "t.md"), doc.text);
    owner.ws.close();
    other.ws.close();
  });
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
    header.writeBigUInt64BE(BigInt(2 * 1024 * 1024 + 1), 2);
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
    assert.deepEqual(messages.find((msg) => msg.type === "docs"), {
      type: "docs",
      files: ["welcome.md"],
      titles: { "welcome.md": "Welcome" },
    });
    parts.end();
  });
});

test("T-create", async () => {
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
      a.send({ type: "create", username: "A", path: "notes/idea.md" });
      const ideaDocs = await a.next((msg) => msg.type === "docs" || msg.type === "error");
      assert.equal(ideaDocs.type, "docs");
      assert.equal(ideaDocs.files.includes("notes/idea-2.md"), true);
      const ideaFile = await a.next((msg) => msg.type === "file" || msg.type === "error");
      assert.equal(ideaFile.type, "file");
      assert.equal(ideaFile.path, "notes/idea-2.md");
      assert.equal(ideaFile.rev, 0);
      assert.equal(ideaFile.text, "");
      assert.equal(await readDoc(dir, "notes/idea.md"), "");
      assert.equal(await readDoc(dir, "notes/idea-2.md"), "");
      a.send({ type: "create", username: "A", path: "a.txt" });
      assert.deepEqual(await a.next((msg) => msg.type === "error"), { type: "error", status: 400 });
      await assert.rejects(() => fs.lstat(path.join(dir, "a.txt")));
      a.send({ type: "create", username: "A", path: "../x.md" });
      assert.deepEqual(await a.next((msg) => msg.type === "error"), { type: "error", status: 404 });
      a.send({ type: "create", username: "A", path: "exists.md" });
      const existsDocs = await a.next((msg) => msg.type === "docs" || msg.type === "error");
      assert.equal(existsDocs.type, "docs");
      const existsFile = await a.next((msg) => msg.type === "file" || msg.type === "error");
      assert.equal(existsFile.type, "file");
      assert.equal(existsFile.path, "exists-2.md");
      assert.equal(existsFile.rev, 0);
      assert.equal(existsFile.text, "");
      assert.equal(await readDoc(dir, "exists.md"), "keep");
      assert.equal(await readDoc(dir, "exists-2.md"), "");
      a.send({ type: "create", username: "A", path: "out/x.md" });
      const outsideFile = await a.next((msg) => (msg.type === "file" && msg.path === "out/x.md") || msg.type === "error");
      assert.equal(outsideFile.type, "file");
      assert.equal(outsideFile.text, "");
      assert.equal(await fs.readFile(path.join(outside, "x.md"), "utf8"), "");
      a.send({ type: "create", username: "A", path: "notes/body.md", text: "Body\n" });
      const bodyFile = await a.next((msg) => msg.type === "file" && msg.path === "notes/body.md");
      assert.equal(bodyFile.text, "Body\n");
      assert.equal(bodyFile.rev, 0);
      assert.equal(await readDoc(dir, "notes/body.md"), "Body\n");
      a.send({ type: "create", username: "A", path: "notes/empty-text.md", text: "" });
      const emptyText = await a.next((msg) => msg.type === "file" && msg.path === "notes/empty-text.md");
      assert.equal(emptyText.text, "");
      assert.equal(emptyText.rev, 0);
      assert.equal(await readDoc(dir, "notes/empty-text.md"), "");
      a.send({ type: "create", username: "A", path: "notes/plain.md" });
      const plain = await a.next((msg) => msg.type === "file" && msg.path === "notes/plain.md");
      assert.equal(plain.text, "");
      assert.equal(plain.rev, 0);
      assert.equal(await readDoc(dir, "notes/plain.md"), "");
      const badTexts = [1, null, false, {}, []];
      for (let i = 0; i < badTexts.length; i += 1) {
        const rel = `fresh/bad-${i}.md`;
        a.send({ type: "create", username: "A", path: rel, text: badTexts[i] });
        assert.deepEqual(await a.next((msg) => msg.type === "error"), { type: "error", status: 400 });
        await assert.rejects(() => fs.lstat(path.join(dir, rel)));
      }
      await assert.rejects(() => fs.lstat(path.join(dir, "fresh")));
      await openDoc(a, "A", "notes/idea.md");
      await syncLock(a, [], "A", "notes/idea.md", 0, 0);
      a.send({ type: "edit", username: "A", path: "notes/idea.md", rev: 0, op: "insert", text: "Hi" });
      const doc = await takeDoc(a);
      assert.equal(doc.text, "Hi");
      const untilClosed = closed(a.ws);
      a.ws.close();
      await untilClosed;
      assert.equal(await readDoc(dir, "notes/idea.md"), "Hi");
      assert.equal(await readDoc(dir, "exists.md"), "keep");
      b.ws.close();
    });
  } finally {
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("a directory symlink outside the root is part of the document tree", { timeout: 20000 }, async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-link-"));
  try {
    await withDocs(async ({ port, dir }) => {
      await fs.writeFile(path.join(outside, "note.md"), "# Note\noutside\n");
      await fs.writeFile(path.join(outside, "stay.md"), "stay\n");
      await fs.writeFile(path.join(outside, "note.txt"), "nope\n");
      await fs.writeFile(path.join(outside, "plain.md"), "plain\n");
      await fs.mkdir(path.join(outside, ".git"));
      await fs.writeFile(path.join(outside, ".git", "secret.md"), "secret\n");
      await fs.symlink(".", path.join(outside, "spin"));
      await fs.symlink(outside, path.join(dir, "out"));
      await fs.symlink(path.join(outside, "plain.md"), path.join(dir, "linked.md"));
      await fs.mkdir(path.join(dir, "inner"));
      await fs.writeFile(path.join(dir, "inner", "page.md"), "# Page\ninner\n");
      await fs.symlink("inner", path.join(dir, "alias"));
      await fs.mkdir(path.join(dir, "box"));
      await fs.writeFile(path.join(dir, "box", "note.md"), "boxed\n");
      await fs.symlink(".", path.join(dir, "box", "again"));
      await fs.symlink(".", path.join(dir, "loop"));
      await fs.mkdir(path.join(dir, "archive"));
      await fs.writeFile(path.join(dir, "archive", "keep.md"), "keep\n");

      const a = await hello(port, "A");
      a.send({ type: "list", username: "A" });
      const listed = await a.next((msg) => msg.type === "docs");
      for (const rel of ["out/note.md", "out/stay.md", "out/plain.md", "alias/page.md", "inner/page.md", "box/note.md", "archive/keep.md", "welcome.md"]) {
        assert.equal(listed.files.includes(rel), true, rel);
      }
      for (const rel of ["linked.md", "out/.git/secret.md", "out/spin/note.md", "out/spin/stay.md", "box/again/note.md", "loop/welcome.md", "out/note.txt"]) {
        assert.equal(listed.files.includes(rel), false, rel);
      }
      assert.equal(listed.files.filter((file) => file === "out/note.md").length, 1);
      assert.equal(listed.titles["out/note.md"], "Note");
      assert.equal(listed.titles["alias/page.md"], "Page");

      const shown = await openDoc(a, "A", "out/note.md");
      assert.equal(shown.text, "# Note\noutside\n");
      assert.equal(shown.text, await fs.readFile(path.join(outside, "note.md"), "utf8"));
      const aliasShown = await openDoc(a, "A", "alias/page.md");
      assert.equal(aliasShown.text, "# Page\ninner\n");
      a.send({ type: "open", username: "A", path: "linked.md" });
      assert.deepEqual(await a.next((msg) => msg.type === "error"), { type: "error", status: 404 });
      assert.equal((await fs.lstat(path.join(dir, "linked.md"))).isSymbolicLink(), true);
      assert.equal(await fs.readFile(path.join(outside, "plain.md"), "utf8"), "plain\n");

      a.send({ type: "open", username: "A", path: "out/note.md" });
      const editing = await a.next((msg) => msg.type === "file" && msg.path === "out/note.md");
      const end = editing.text.length;
      a.send({ type: "edit", username: "A", path: "out/note.md", rev: editing.rev, anchor: end, cursor: end, op: "insert", text: "Z" });
      const edited = await takeDoc(a);
      assert.notEqual(edited.text, "# Note\noutside\n");
      assert.ok(edited.text.startsWith("# Note\n"));
      assert.ok(edited.text.includes("Z"));
      assert.equal(await fs.readFile(path.join(outside, "note.md"), "utf8"), edited.text);

      a.send({ type: "create", username: "A", path: "out/made.md", text: "made\n" });
      const made = await a.next((msg) => (msg.type === "file" && msg.path === "out/made.md") || msg.type === "error");
      assert.equal(made.type, "file");
      assert.equal(made.text, "made\n");
      assert.equal(await fs.readFile(path.join(outside, "made.md"), "utf8"), "made\n");
      assert.equal((await fs.lstat(path.join(dir, "out"))).isSymbolicLink(), true);
      const madeDocs = await a.next((msg) => msg.type === "docs");
      assert.equal(madeDocs.files.includes("out/made.md"), true);

      a.send({ type: "delete", username: "A", path: "out/made.md" });
      assert.deepEqual(await a.next((msg) => msg.type === "deleted" || msg.type === "error"), { type: "deleted", path: "out/made.md" });
      await assert.rejects(() => fs.lstat(path.join(outside, "made.md")));
      assert.equal((await fs.lstat(path.join(dir, "out"))).isSymbolicLink(), true);
      const deletedDocs = await a.next((msg) => msg.type === "docs");
      assert.equal(deletedDocs.files.includes("out/made.md"), false);
      assert.equal(deletedDocs.files.includes("out/note.md"), true);

      a.send({ type: "move", username: "A", path: "out/note.md", dir: "archive" });
      const movedDocs = await a.next((msg) => msg.type === "docs" || msg.type === "error");
      assert.equal(movedDocs.type, "docs");
      assert.equal(movedDocs.files.includes("archive/note.md"), true);
      assert.equal(movedDocs.files.includes("out/note.md"), false);
      const moved = await a.next((msg) => msg.type === "moved" || msg.type === "error");
      assert.equal(moved.type, "moved");
      assert.equal(await fs.readFile(path.join(dir, "archive", "note.md"), "utf8"), edited.text);
      await assert.rejects(() => fs.lstat(path.join(outside, "note.md")));

      a.send({ type: "move", username: "A", path: "archive/note.md", dir: "out" });
      const backDocs = await a.next((msg) => msg.type === "docs" || msg.type === "error");
      assert.equal(backDocs.type, "docs");
      assert.equal(backDocs.files.includes("out/note.md"), true);
      assert.equal(backDocs.files.includes("archive/note.md"), false);
      const back = await a.next((msg) => msg.type === "moved" || msg.type === "error");
      assert.equal(back.type, "moved");
      assert.equal(await fs.readFile(path.join(outside, "note.md"), "utf8"), edited.text);
      await assert.rejects(() => fs.lstat(path.join(dir, "archive", "note.md")));

      a.send({ type: "delete", username: "A", path: "out/stay.md" });
      assert.deepEqual(await a.next((msg) => msg.type === "deleted" || msg.type === "error"), { type: "deleted", path: "out/stay.md" });
      await assert.rejects(() => fs.lstat(path.join(outside, "stay.md")));

      a.ws.close();
    });
  } finally {
    await fs.rm(outside, { recursive: true, force: true });
  }
});

const TICKET_KEYS = ["assignee", "created", "depends", "id", "parent", "priority", "reporter", "rev", "state", "title", "type"];

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
      files: ["a.md", "notes/tickets/c.md", "sub/b.markdown", "tickets.md", "welcome.md"],
      titles: { "welcome.md": "Welcome" },
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
      assignee: "",
      parent: "",
      depends: [],
      reporter: "indexer",
      created: "2020-01-01T00:00:00.000Z",
      rev: 0,
    });
    assert.equal(await readDoc(dir, "tickets/bbbbbbbb.md"), older);

    const closedOpen = await openDoc(client, "A", "tickets/aaaaaaaa.md");
    assert.equal(closedOpen.text, "done\n");
    assert.equal(closedOpen.ticket.state, "closed");
    assert.equal(await readDoc(dir, "tickets/aaaaaaaa.md"), closed);

    client.send({ type: "tickets", username: "A" });
    const listed = await client.next((msg) => msg.type === "tickets");
    assert.deepEqual(listed.tickets.map((ticket) => ticket.id), ["bbbbbbbb", "aaaaaaaa", "dddddddd", "eeeeeeee", "seedmark"]);
    assert.deepEqual(listed.tickets, sortedTickets(listed.tickets));
    for (const ticket of listed.tickets) assertTicketEntry(ticket);
    assert.equal(listed.tickets.some((ticket) => ticket.state === "closed"), true);

    await fs.writeFile(path.join(dir, "tickets", "bbbbbbbb.md"), "garbage\n");
    await fs.writeFile(path.join(dir, "tickets", "eeeeeeee.md"), "garbage\n");
    client.send({ type: "tickets", username: "A" });
    const cached = await client.next((msg) => msg.type === "tickets");
    assert.deepEqual(cached.tickets.map((ticket) => ticket.id), ["bbbbbbbb", "aaaaaaaa", "dddddddd", "seedmark"]);
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
    assert.deepEqual(docs.files, ["a.md", "notes/idea.md", "notes/tickets/c.md", "sub/b.markdown", "tickets.md", "welcome.md"]);
    assert.equal(docs.titles["welcome.md"], "Welcome");
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
    assert.deepEqual(first.listed.tickets.map((ticket) => ticket.id), ["bbbbbbbb", "seedmark", created.id]);
    assert.deepEqual(first.listed.tickets[2], created);
    assert.equal(await readDoc(dir, first.file.path), ticketText({ ...created, body: "" }));
    assert.equal(await readDoc(dir, "tickets/bbbbbbbb.md"), olderDisk);
    assert.equal(a.all.some((msg) => msg.type === "docs"), false);
    a.send({ type: "list", username: "A" });
    const docs = await a.next((msg) => msg.type === "docs");
    assert.deepEqual(docs.files, ["welcome.md"]);
    assert.deepEqual(docs.titles, { "welcome.md": "Welcome" });
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
      "id", "title", "state", "type", "priority", "assignee", "parent", "depends", "reporter", "created", "rev",
    ]);
    assert.equal(plain.file.ticket.rev, 0);
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
      "type", "path", "rev", "title", "state", "ticketType", "priority", "assignee", "parent", "depends", "reporter", "created",
    ]);
    assert.equal(meta.priority, "low");
    assert.equal(meta.rev, 1);
    assert.equal(parseTicket(high.file.ticket.id, await readDoc(dir, highPath)).priority, "low");
    assert.equal(listed.tickets.find((ticket) => ticket.id === high.file.ticket.id).priority, "low");
    assert.equal(listed.tickets.find((ticket) => ticket.id === high.file.ticket.id).rev, 1);
    assert.equal(listed.tickets.find((ticket) => ticket.id === plain.file.ticket.id).rev, 0);
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
      assignee: "",
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

  });
});

test("T-ticket-stale", async () => {
  await withDocs(async ({ server, port, dir }) => {
    const a = await hello(port, "A");
    const created = await createTicket(a, "A", "Alpha", undefined, undefined, "Keep the body.\n");
    const path = created.file.path;
    const id = created.file.ticket.id;
    const body = "Keep the body.\n";

    async function setTitle(rev, title) {
      const payload = { type: "ticket.set", username: "A", path, title };
      if (rev !== undefined) payload.rev = rev;
      a.send(payload);
      const listed = await a.next((msg) => msg.type === "tickets");
      const meta = await a.next((msg) => msg.type === "ticket");
      return { listed, meta };
    }

    let step = await setTitle(4, "Nope");
    assert.equal(step.meta.rev, 1);
    assert.equal(step.meta.title, "Nope");
    assert.equal(step.listed.tickets.find((ticket) => ticket.id === id).title, "Nope");
    assert.equal(parseTicket(id, await readDoc(dir, path)).body, body);

    step = await setTitle(0, "Kept");
    assert.equal(step.meta.rev, 2);
    assert.equal(step.meta.title, "Kept");
    assert.equal(parseTicket(id, await readDoc(dir, path)).body, body);

    step = await setTitle(0, "Other");
    assert.equal(step.meta.rev, 3);
    assert.equal(step.meta.title, "Other");

    step = await setTitle("1", "String");
    assert.equal(step.meta.rev, 4);
    assert.equal(step.meta.title, "String");
    assert.equal(parseTicket(id, await readDoc(dir, path)).body, body);

    step = await setTitle(undefined, "Final");
    assert.equal(step.meta.rev, 5);
    assert.equal(step.meta.title, "Final");
    const disk = parseTicket(id, await readDoc(dir, path));
    assert.equal(disk.title, "Final");
    assert.equal(disk.body, body);

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
    assert.equal(listed.tickets.find((ticket) => ticket.id === id).title, "Body 2");
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

  });
});

test("T-ticket-purge", async () => {
  await withDocs(async ({ server, port, dir }) => {
    const idle = await hello(port, "Idle");
    idle.send({ type: "ticket.purge", username: "Idle" });
    const seeded = await idle.next((msg) => msg.type === "tickets");
    assert.deepEqual(seeded.tickets.map((ticket) => ticket.id), ["seedmark"]);
    assert.equal(seeded.tickets[0].state, "new");
    assert.equal((await fs.lstat(path.join(dir, "tickets"))).isDirectory(), true);

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
      assignee: "",
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
    assert.deepEqual(survivors.tickets.map((ticket) => ticket.id), ["bbbbbbbb", "aaaaaaaa", "eeeeeeee", "dddddddd", "seedmark"]);
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
    assert.deepEqual(await bye.next((msg) => msg.type === "docs"), {
      type: "docs",
      files: ["doc.md", "welcome.md"],
      titles: { "welcome.md": "Welcome" },
    });

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
    const stale = await sub.next((msg) => msg.type === "ticket");
    await sub.next((msg) => msg.type === "tickets");
    assert.equal(stale.rev, 2);
    assert.equal(stale.title, "Stale");
    assert.equal(parseTicket("aaaaaaaa", await readDoc(dir, "tickets/aaaaaaaa.md")).body, "alpha\n");
    sub.send({ type: "ticket.set", username: "Sub", path: "tickets/aaaaaaaa.md", rev: 1, title: "After" });
    const bumped = await sub.next((msg) => msg.type === "ticket");
    await sub.next((msg) => msg.type === "tickets");
    assert.equal(bumped.rev, 3);
    assert.equal(bumped.parent, "");
    assert.equal(bumped.title, "After");
    assert.equal(parseTicket("aaaaaaaa", await readDoc(dir, "tickets/aaaaaaaa.md")).body, "alpha\n");
    await keep.next((msg) => msg.type === "tickets");
    await idle.next((msg) => msg.type === "tickets");
    keep.send({ type: "ticket.set", username: "Keep", path: "tickets/bbbbbbbb.md", rev: 0, title: "Beta 2" });
    const kept = await keep.next((msg) => msg.type === "ticket");
    await keep.next((msg) => msg.type === "tickets");
    assert.equal(kept.rev, 1);
    assert.equal(kept.title, "Beta 2");
    assert.equal(parseTicket("bbbbbbbb", await readDoc(dir, "tickets/bbbbbbbb.md")).body, "beta\n");

  });
});

test("T-hub-delete", async () => {
  await withDocs(async ({ server, port, dir }) => {
    await fs.writeFile(path.join(dir, "b.md"), "bee\n");
    await fs.mkdir(path.join(dir, "sub"), { recursive: true });
    await fs.writeFile(path.join(dir, "sub", "a.md"), "ay\n");
    const ada = await hello(port, "Ada");
    const bea = await hello(port, "Bea");
    ada.send({ type: "delete", username: "Ada", path: "tickets/aaaaaaaa.md" });
    assert.deepEqual(await ada.next((msg) => msg.type === "error"), { type: "error", status: 400 });
    ada.send({ type: "delete", username: "Ada", path: ".." });
    assert.deepEqual(await ada.next((msg) => msg.type === "error"), { type: "error", status: 404 });
    ada.send({ type: "delete", username: "Ada", path: "sub" });
    assert.deepEqual(await ada.next((msg) => msg.type === "error"), { type: "error", status: 404 });
    ada.send({ type: "delete", username: "Ada", path: "missing.md" });
    assert.deepEqual(await ada.next((msg) => msg.type === "error"), { type: "error", status: 404 });
    assert.equal(await readDoc(dir, "b.md"), "bee\n");
    assert.equal(await readDoc(dir, "sub/a.md"), "ay\n");

    await openDoc(bea, "Bea", "b.md");
    await syncLock(bea, [], "Bea", "b.md", 0, 0);
    ada.send({ type: "delete", username: "Ada", path: "b.md" });
    assert.deepEqual(await ada.next((msg) => msg.type === "error" || msg.type === "deleted"), { type: "error", status: 409, heldBy: "Bea" });
    assert.equal(await readDoc(dir, "b.md"), "bee\n");

    bea.send({ type: "edit", username: "Bea", path: "b.md", rev: 0, anchor: 0, cursor: 0, op: "insert", text: "Z" });
    const edited = await takeDoc(bea);
    assert.equal(edited.text, "Zbee\n");
    bea.send({ type: "delete", username: "Bea", path: "b.md" });
    assert.deepEqual(await bea.next((msg) => msg.type === "deleted" || msg.type === "error"), { type: "deleted", path: "b.md" });
    const docs = await bea.next((msg) => msg.type === "docs");
    assert.equal(docs.files.includes("b.md"), false);
    assert.equal(docs.files.includes("sub/a.md"), true);
    const adaDocs = await ada.next((msg) => msg.type === "docs" || msg.type === "deleted");
    assert.equal(adaDocs.type, "docs");
    assert.equal(adaDocs.files.includes("b.md"), false);
    assert.equal(ada.all.some((msg) => msg.type === "deleted"), false);
    await assert.rejects(() => fs.lstat(path.join(dir, "b.md")));
    assert.equal(await readDoc(dir, "sub/a.md"), "ay\n");
    const subInfo = await fs.lstat(path.join(dir, "sub"));
    assert.equal(subInfo.isDirectory(), true);

    bea.send({ type: "undo", username: "Bea", path: "b.md", rev: edited.rev });
    assert.deepEqual(await bea.next((msg) => msg.type === "error" || msg.type === "doc"), { type: "error", status: 409 });
    await assert.rejects(() => fs.lstat(path.join(dir, "b.md")));

    await fs.writeFile(path.join(dir, "b.md"), "back\n");
    ada.send({ type: "delete", username: "Ada", path: "b.md" });
    assert.deepEqual(await ada.next((msg) => msg.type === "deleted" || msg.type === "error"), { type: "deleted", path: "b.md" });
    await assert.rejects(() => fs.lstat(path.join(dir, "b.md")));
  });
});

test("T-hub-ticket-delete", async () => {
  await withDocs(async ({ server, port, dir }) => {
    const T0 = "2020-01-01T00:00:00.000Z";
    const T1 = "2020-01-01T00:00:01.000Z";
    const beta = await writeTicket(dir, {
      id: "bbbbbbbb",
      title: "Beta",
      state: "new",
      parent: "aaaaaaaa",
      depends: ["cccccccc", "aaaaaaaa"],
      created: T0,
      body: "beta\n",
    });
    const alpha = await writeTicket(dir, {
      id: "aaaaaaaa",
      title: "Alpha",
      state: "new",
      created: T1,
      body: "alpha\n",
    });
    const ada = await hello(port, "Ada");
    const bea = await hello(port, "Bea");
    ada.send({ type: "delete", username: "Ada", path: "tickets/aaaaaaaa.md" });
    assert.deepEqual(await ada.next((msg) => msg.type === "error"), { type: "error", status: 400 });
    assert.equal(await readDoc(dir, "tickets/aaaaaaaa.md"), alpha);

    await openDoc(bea, "Bea", "tickets/aaaaaaaa.md");
    ada.send({ type: "ticket.delete", username: "Ada", id: "aaaaaaaa" });
    assert.deepEqual(await ada.next((msg) => msg.type === "error" || msg.type === "deleted"), { type: "error", status: 409, heldBy: "Bea" });
    assert.equal(await readDoc(dir, "tickets/aaaaaaaa.md"), alpha);
    assert.equal(await readDoc(dir, "tickets/bbbbbbbb.md"), beta);

    bea.send({ type: "ticket.delete", username: "Bea", id: "aaaaaaaa" });
    assert.deepEqual(await bea.next((msg) => msg.type === "deleted" || msg.type === "error"), {
      type: "deleted",
      path: "tickets/aaaaaaaa.md",
    });
    const listed = await bea.next((msg) => msg.type === "tickets");
    assert.equal(listed.tickets.some((ticket) => ticket.id === "aaaaaaaa"), false);
    const survivor = listed.tickets.find((ticket) => ticket.id === "bbbbbbbb");
    assert.ok(survivor);
    assert.equal(survivor.parent, "");
    assert.deepEqual(survivor.depends, ["cccccccc"]);
    const disk = parseTicket("bbbbbbbb", await readDoc(dir, "tickets/bbbbbbbb.md"));
    assert.equal(disk.body, "beta\n");
    assert.equal(disk.parent, "");
    assert.deepEqual(disk.depends, ["cccccccc"]);
    await assert.rejects(() => fs.lstat(path.join(dir, "tickets", "aaaaaaaa.md")));

    bea.send({ type: "ticket.delete", username: "Bea", id: "cccccccc" });
    assert.deepEqual(await bea.next((msg) => msg.type === "error"), { type: "error", status: 404 });
    bea.send({ type: "ticket.delete", username: "Bea", id: "nope" });
    assert.deepEqual(await bea.next((msg) => msg.type === "error"), { type: "error", status: 404 });

    await writeTicket(dir, {
      id: "aaaaaaaa",
      title: "Alpha",
      state: "new",
      created: T1,
      body: "alpha\n",
    });
    ada.send({ type: "ticket.delete", username: "Ada", id: "aaaaaaaa" });
    assert.deepEqual(await ada.next((msg) => msg.type === "deleted" || msg.type === "error"), {
      type: "deleted",
      path: "tickets/aaaaaaaa.md",
    });
    await assert.rejects(() => fs.lstat(path.join(dir, "tickets", "aaaaaaaa.md")));
    const again = parseTicket("bbbbbbbb", await readDoc(dir, "tickets/bbbbbbbb.md"));
    assert.equal(again.parent, "");
    assert.deepEqual(again.depends, ["cccccccc"]);
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
      { type: "delete", username: "A", path: "a.md" },
      { type: "ticket.delete", username: "A", id: "aaaaaaaa" },
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
    assert.equal(created.tickets.length, 2);
    const made = created.tickets.find((ticket) => ticket.id !== "seedmark");
    assert.equal(made.title, "Only one");
    await client.next((msg) => msg.type === "file");

    client.send({ type: "repo", username: "A", name: "two" });
    client.send({ type: "open", username: "A", path: "a.md" });
    const other = await client.next((msg) => msg.type === "file" || msg.type === "docs" || msg.type === "error");
    assert.equal(other.type, "file");
    assert.equal(other.text, "beta\n");
    client.send({ type: "tickets", username: "A" });
    const listed = await client.next((msg) => msg.type === "tickets");
    assert.deepEqual(listed.tickets.map((ticket) => ticket.id), ["seedmark"]);
    assert.equal(listed.tickets.some((ticket) => ticket.id === made.id), false);
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
    client.send({ type: "repo.register", username: "A", name: "bad:name", description: "Nope", path: other });
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

    client.send({ type: "repo.register", username: "A", name: "inner", description: "Inner", path: inner });
    const innerMsg = await client.next((msg) => msg.type === "repos" || msg.type === "error");
    assert.equal(innerMsg.type, "repos");
    client.send({ type: "repo.register", username: "A", name: "outer", description: "Outer", path: outer });
    assert.deepEqual(await client.next((msg) => msg.type === "error"), { type: "error", status: 400 });

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

    client.send({ type: "repo", username: "B", name: "docs" });
    assert.deepEqual(await client.next((msg) => msg.type === "error"), { type: "error", status: 404 });
    client.send({ type: "list", username: "B" });
    assert.deepEqual(await client.next((msg) => msg.type === "error"), { type: "error", status: 400 });
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
    client.send({ type: "repo", username: "A", name: "one" });
    client.send({ type: "list", username: "A" });
    const same = await client.next((msg) => msg.type === "docs" || msg.type === "error");
    assert.equal(same.type, "docs");

    client.send({ type: "repo", username: "A", name: "two" });
    client.send({ type: "open", username: "A", path: "a.md" });
    const next = await client.next((msg) => msg.type === "file" || msg.type === "docs" || msg.type === "error");
    assert.equal(next.type, "file");
    assert.equal(next.text, "alpha\n");
    assert.equal(await fs.readFile(path.join(one, "a.md"), "utf8"), "Xalpha\n");
    client.send({ type: "undo", username: "A", path: "a.md", rev: next.rev });
    assert.deepEqual(await client.next((msg) => msg.type === "noop" || msg.type === "error" || msg.type === "doc"), {
      type: "noop",
      path: "a.md",
      rev: next.rev,
    });
    assert.equal(await fs.readFile(path.join(two, "a.md"), "utf8"), "alpha\n");
    client.ws.close();
  } finally {
    await close(server);
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
      "welcome.md",
    ]);
    assert.equal(listed.files.every((file) => typeof file === "string"), true);
    assert.deepEqual(listed.titles, {
      "archive/keep.md": "Keep",
      "archive/plain.md": "Taken",
      "cached.md": "Disk",
      "elsewhere/plain.md": "Elsewhere",
      "notes/sub/deep.md": "Deep",
      "welcome.md": "Welcome",
    });
    assert.equal(listed.titles["notes/idea.md"], undefined);
    assert.equal(listed.titles["second.md"], undefined);

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
    assert.equal(docsA.titles["archive/idea.md"], undefined);
    assert.equal(docsA.titles["notes/idea.md"], undefined);
    assert.deepEqual(a.all, [{
      type: "moved",
      path: "notes/idea.md",
      moves: [{ path: "notes/idea.md", dest: "archive/idea.md" }],
    }]);
    a.all.length = 0;
    assert.equal(b.all.length, 0);
    assert.equal(await readDoc(dir, "archive/idea.md"), "Qintro\n# Idea Title\n");
    await assert.rejects(() => fs.lstat(path.join(dir, "notes", "idea.md")));

    await fs.writeFile(path.join(dir, "archive", "idea.md"), "# Sneaky\n");
    a.send({ type: "list", username: "A" });
    const cachedTitle = await a.next((msg) => msg.type === "docs");
    assert.equal(cachedTitle.titles["archive/idea.md"], undefined);
    await fs.writeFile(path.join(dir, "archive", "idea.md"), "Qintro\n# Idea Title\n");

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
    assert.equal(topDocsB.titles["idea.md"], undefined);
    assert.equal(await readDoc(dir, "idea.md"), "QZintro\n# Idea Title\n");
    await assert.rejects(() => fs.lstat(path.join(dir, "archive", "idea.md")));
    assert.deepEqual(a.all, [{
      type: "moved",
      path: "archive/idea.md",
      moves: [{ path: "archive/idea.md", dest: "idea.md" }],
    }]);
    a.all.length = 0;
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
    assert.deepEqual(a.all, [{
      type: "moved",
      path: "notes",
      moves: [{ path: "notes/sub/deep.md", dest: "archive/notes/sub/deep.md" }],
    }]);
    a.all.length = 0;
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
    assert.deepEqual(a.all, [{
      type: "moved",
      path: "archive/notes",
      moves: [{ path: "archive/notes/sub/deep.md", dest: "notes/sub/deep.md" }],
    }]);
    a.all.length = 0;
    assert.equal(b.all.length, 0);

    a.send({ type: "move", username: "A", path: "archive/keep.md", dir: "archive" });
    assert.deepEqual(await a.next((msg) => msg.type === "moved" || msg.type === "error"), {
      type: "moved",
      path: "archive/keep.md",
      moves: [{ path: "archive/keep.md", dest: "archive/keep.md" }],
    });
    assert.equal(a.all.length, 0);
    assert.equal(b.all.length, 0);
    assert.equal(b.all.some((msg) => msg.type === "moved"), false);
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

test("the served build is the hash of the page sources", async () => {
  const head = await readBuild(repoRoot);
  assert.match(head, /^[0-9a-f]{64}$/);
  const disk = await fs.readFile(path.join(repoRoot, "index.html"), "utf8");
  assert.equal(disk.includes("viewmark-build"), false);
  await withDocs(async ({ port, dir }) => {
    const page = await get(port, "/");
    assert.equal(page.status, 200);
    const match = page.body.match(/<meta name="viewmark-build" content="([^"]*)">/);
    assert.ok(match);
    assert.equal(match[1], head);
    const charset = page.body.indexOf('<meta charset="utf-8">');
    const stamped = page.body.indexOf('<meta name="viewmark-build"');
    const viewport = page.body.indexOf('<meta name="viewport"');
    assert.ok(charset !== -1 && charset < stamped && stamped < viewport);
    const direct = await get(port, "/index.html");
    assert.equal(direct.body.includes(`content="${head}"`), true);
    await fs.writeFile(path.join(dir, "index.html"), "<meta charset=\"utf-8\">\n<p>raw</p>\n");
    const raw = await get(port, "/raw/docs/index.html");
    assert.equal(raw.status, 200);
    assert.equal(raw.body.includes("viewmark-build"), false);
    const client = connect(port);
    await client.ready;
    client.send({ type: "hello", username: "Ada" });
    const greeted = await client.next((msg) => msg.type === "hello" || msg.type === "error");
    assert.deepEqual(greeted, { type: "hello", build: head });
    client.ws.close();
  });
});

test("readBuild hashes the page sources and ignores other files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-build-"));
  try {
    await fs.writeFile(path.join(dir, "index.html"), "<meta charset=\"utf-8\">\n");
    await fs.writeFile(path.join(dir, "editor.css"), "body{}\n");
    await fs.mkdir(path.join(dir, "src"));
    await fs.mkdir(path.join(dir, "vendor"));
    await fs.writeFile(path.join(dir, "src", "a.js"), "a\n");
    await fs.writeFile(path.join(dir, "vendor", "v.js"), "v\n");
    await fs.writeFile(path.join(dir, "README.md"), "nope\n");
    const first = await readBuild(dir);
    const second = await readBuild(dir);
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(second, first);
    await fs.writeFile(path.join(dir, "README.md"), "still nope\n");
    assert.equal(await readBuild(dir), first);
    await fs.writeFile(path.join(dir, "src", "a.js"), "b\n");
    const third = await readBuild(dir);
    assert.match(third, /^[0-9a-f]{64}$/);
    assert.notEqual(third, first);
    assert.equal(await readBuild(path.join(dir, "src", "a.js")), "");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("T-comment-add", async () => {
  await withDocs(async ({ port, dir }) => {
    const fox = "See the fox.\n";
    const question = "Is this the right animal?\n";
    const rel = "fox.md";
    await fs.writeFile(path.join(dir, rel), fox);
    const witness = await hello(port, "witness");
    const ada = await hello(port, "Ada");
    try {
      await openDoc(witness, "witness", rel);
      ada.send({
        type: "comment.add",
        username: "Ada",
        path: rel,
        rev: 0,
        anchor: 8,
        cursor: 11,
        text: question,
      });
      const msg = await ada.next((item) => item.type === "comment" || item.type === "error");
      assert.equal(msg.type, "comment");
      assert.equal(msg.path, rel);
      assert.equal(msg.id, "c1");
      assert.equal(msg.note, 0);
      assert.equal(msg.rev, 1);
      const stored = await readDoc(dir, rel);
      assert.equal(stored.startsWith("See the {c1}fox{/c1}.\n"), true);
      const thread = commentThreads(stored).find((item) => item.id === "c1");
      const notes = parseCommentNotes(thread.body);
      assert.equal(notes.length, 1);
      assert.equal(notes[0].id, 0);
      const parts = splitCommentNote(notes[0].raw);
      assert.equal(parts.author, "Ada");
      assert.equal(parts.text, question);
      assert.match(parts.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      const doc = await witness.next((item) => item.type === "doc" && item.path === rel);
      assert.equal(doc.rev, 1);
      assert.equal(doc.text, stored);
      assert.equal(doc.actor, "Ada");
      await delay(50);
      assert.equal(witness.all.filter((item) => item.type === "doc").length, 0);

      ada.send({
        type: "comment.add",
        username: "Ada",
        path: rel,
        rev: 0,
        anchor: 0,
        cursor: 3,
        text: "Later.\n",
      });
      const stale = await ada.next((item) => item.type === "comment" || item.type === "error");
      assert.deepEqual(stale, { type: "error", status: 409 });
      assert.equal(await readDoc(dir, rel), stored);
      await delay(50);
      assert.equal(witness.all.filter((item) => item.type === "doc").length, 0);
    } finally {
      ada.ws.close();
      witness.ws.close();
    }

    const plain = "plain.md";
    await fs.writeFile(path.join(dir, plain), fox);
    const quiet = await hello(port, "Ada");
    const seeing = await hello(port, "witness");
    try {
      await openDoc(seeing, "witness", plain);
      for (const text of ["", "no\n::\n", ":: 0\n"]) {
        quiet.send({
          type: "comment.add",
          username: "Ada",
          path: plain,
          rev: 0,
          anchor: 8,
          cursor: 11,
          text,
        });
        const refused = await quiet.next((item) => item.type === "comment" || item.type === "error");
        assert.deepEqual(refused, { type: "error", status: 400 });
        assert.equal(await readDoc(dir, plain), fox);
      }
      quiet.send({
        type: "comment.add",
        username: "Ada",
        path: plain,
        rev: 0,
        anchor: 8,
        cursor: 8,
        text: question,
      });
      assert.deepEqual(
        await quiet.next((item) => item.type === "comment" || item.type === "error"),
        { type: "error", status: 409 },
      );
      quiet.send({
        type: "comment.add",
        username: "Ada",
        path: plain,
        rev: 0,
        anchor: "8",
        cursor: 11,
        text: question,
      });
      assert.deepEqual(
        await quiet.next((item) => item.type === "comment" || item.type === "error"),
        { type: "error", status: 400 },
      );
      quiet.send({
        type: "comment.add",
        username: "Ada",
        path: plain,
        anchor: 8,
        cursor: 11,
        text: question,
      });
      assert.deepEqual(
        await quiet.next((item) => item.type === "comment" || item.type === "error"),
        { type: "error", status: 409 },
      );
      assert.equal(await readDoc(dir, plain), fox);
      await delay(50);
      assert.equal(seeing.all.some((item) => item.type === "doc"), false);
    } finally {
      quiet.ws.close();
      seeing.ws.close();
    }

    const fence = "```\ncode\n```\n";
    await fs.writeFile(path.join(dir, "fence.md"), fence);
    const coder = await hello(port, "Ada");
    try {
      coder.send({
        type: "comment.add",
        username: "Ada",
        path: "fence.md",
        rev: 0,
        anchor: 0,
        cursor: 0,
        text: question,
      });
      assert.deepEqual(
        await coder.next((item) => item.type === "comment" || item.type === "error"),
        { type: "error", status: 409 },
      );
      coder.send({
        type: "comment.add",
        username: "Ada",
        path: "fence.md",
        rev: 0,
        anchor: 0,
        cursor: 3,
        text: question,
      });
      assert.deepEqual(
        await coder.next((item) => item.type === "comment" || item.type === "error"),
        { type: "error", status: 409, reason: "overlaps a fence" },
      );
      assert.equal(await readDoc(dir, "fence.md"), fence);
    } finally {
      coder.ws.close();
    }

    const table = "| Login stalls | Ends the character |\n| --- | --- |\n| yes | no |\n";
    await fs.writeFile(path.join(dir, "table.md"), table);
    const tabler = await hello(port, "Ada");
    try {
      const yes = table.indexOf("yes");
      const no = table.indexOf("no");
      tabler.send({
        type: "comment.add",
        username: "Ada",
        path: "table.md",
        rev: 0,
        anchor: yes,
        cursor: no + 2,
        text: question,
      });
      assert.deepEqual(
        await tabler.next((item) => item.type === "comment" || item.type === "error"),
        { type: "error", status: 409, reason: "overlaps a table" },
      );
      assert.equal(await readDoc(dir, "table.md"), table);
      tabler.send({
        type: "comment.add",
        username: "Ada",
        path: "table.md",
        rev: 0,
        anchor: yes,
        cursor: yes + 3,
        text: question,
      });
      const msg = await tabler.next((item) => item.type === "comment" || item.type === "error");
      assert.equal(msg.type, "comment");
      assert.equal(msg.path, "table.md");
      assert.equal(msg.id, "c1");
      assert.equal(msg.note, 0);
      assert.equal(msg.rev, 1);
      assert.equal((await readDoc(dir, "table.md")).includes("{c1}yes{/c1}"), true);
    } finally {
      tabler.ws.close();
    }

    const marked = "See {c1}fox{/c1}.\n";
    await fs.writeFile(path.join(dir, "split.md"), marked);
    const splitter = await hello(port, "Ada");
    try {
      splitter.send({
        type: "comment.add",
        username: "Ada",
        path: "split.md",
        rev: 0,
        anchor: marked.indexOf("ox"),
        cursor: marked.indexOf("."),
        text: question,
      });
      assert.deepEqual(
        await splitter.next((item) => item.type === "comment" || item.type === "error"),
        { type: "error", status: 409, reason: "splits a comment" },
      );
      assert.equal(await readDoc(dir, "split.md"), marked);
    } finally {
      splitter.ws.close();
    }

    const back = "back.md";
    await fs.writeFile(path.join(dir, back), fox);
    const reverser = await hello(port, "Ada");
    try {
      reverser.send({
        type: "comment.add",
        username: "Ada",
        path: back,
        rev: 0,
        anchor: 11,
        cursor: 8,
        text: question,
      });
      const msg = await reverser.next((item) => item.type === "comment" || item.type === "error");
      assert.equal(msg.type, "comment");
      assert.equal(msg.note, 0);
      assert.equal((await readDoc(dir, back)).startsWith("See the {c1}fox{/c1}.\n"), true);
    } finally {
      reverser.ws.close();
    }

    const pair = "pair.md";
    await fs.writeFile(path.join(dir, pair), "one\ntwo\n");
    const liner = await hello(port, "Ada");
    try {
      liner.send({
        type: "comment.add",
        username: "Ada",
        path: pair,
        rev: 0,
        anchor: 0,
        cursor: 4,
        text: question,
      });
      const msg = await liner.next((item) => item.type === "comment" || item.type === "error");
      assert.equal(msg.type, "comment");
      assert.equal((await readDoc(dir, pair)).startsWith("{c1}one\n{/c1}two\n"), true);
    } finally {
      liner.ws.close();
    }

    const para = "aaa\n\nbbb\n";
    await fs.writeFile(path.join(dir, "para.md"), para);
    const holder = await hello(port, "Hold");
    const other = await hello(port, "Ada");
    try {
      const opened = await openDoc(holder, "Hold", "para.md");
      await syncLock(holder, [], "Hold", "para.md", 0, opened.rev, 3);
      other.send({
        type: "comment.add",
        username: "Ada",
        path: "para.md",
        rev: opened.rev,
        anchor: 5,
        cursor: 8,
        text: question,
      });
      const msg = await other.next((item) => item.type === "comment" || item.type === "error");
      assert.equal(msg.type, "comment");
      assert.equal(msg.note, 0);
      assert.equal(msg.rev, 1);
      assert.equal((await readDoc(dir, "para.md")).startsWith("aaa\n\n{c1}bbb{/c1}\n"), true);
    } finally {
      holder.ws.close();
      other.ws.close();
    }

    const held = "held.md";
    await fs.writeFile(path.join(dir, held), fox);
    const owner = await hello(port, "Hold");
    const blocked = await hello(port, "Ada");
    const watcher = await hello(port, "witness");
    try {
      await openDoc(watcher, "witness", held);
      const opened = await openDoc(owner, "Hold", held);
      await syncLock(owner, [watcher], "Hold", held, 0, opened.rev, opened.text.length);
      blocked.send({
        type: "comment.add",
        username: "Ada",
        path: held,
        rev: opened.rev,
        anchor: 8,
        cursor: 11,
        text: question,
      });
      assert.deepEqual(
        await blocked.next((item) => item.type === "comment" || item.type === "error"),
        { type: "error", status: 409, heldBy: "Hold" },
      );
      assert.equal(await readDoc(dir, held), fox);
      await delay(50);
      assert.equal(watcher.all.some((item) => item.type === "doc"), false);
    } finally {
      owner.ws.close();
      blocked.ws.close();
      watcher.ws.close();
    }
  });
});

test("T-heading-title", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "page.md"), "# Old\n\nbody\n");
    await fs.writeFile(path.join(dir, "plain.md"), "plain\n");
    const a = await hello(port, "A");
    const b = await hello(port, "B");
    const opened = await openDoc(a, "A", "page.md");
    await openDoc(b, "B", "page.md");
    let rev = opened.rev;
    await syncLock(a, [b], "A", "page.md", 0, rev);
    a.send({
      type: "edit",
      username: "A",
      path: "page.md",
      rev,
      anchor: 2,
      cursor: 5,
      op: "insert",
      text: "New",
    });
    const renamedA = await takeDoc(a);
    const renamedB = await takeDoc(b);
    assert.equal(renamedA.text, "# New\n\nbody\n");
    assert.deepEqual(renamedB, renamedA);
    const docsA = await a.next((msg) => msg.type === "docs");
    const docsB = await b.next((msg) => msg.type === "docs");
    assert.deepEqual(docsB, docsA);
    assert.equal(docsA.titles["page.md"], "New");
    assert.equal(await readDoc(dir, "page.md"), "# New\n\nbody\n");
    assert.equal(a.all.length, 0);
    assert.equal(b.all.length, 0);

    rev = renamedA.rev;
    const bodyAt = renamedA.text.indexOf("body");
    await syncLock(a, [b], "A", "page.md", bodyAt, rev);
    a.send({
      type: "edit",
      username: "A",
      path: "page.md",
      rev,
      anchor: bodyAt,
      cursor: bodyAt,
      op: "insert",
      text: "X",
    });
    const bodyA = await takeDoc(a);
    const bodyB = await takeDoc(b);
    assert.equal(bodyA.text, "# New\n\nXbody\n");
    assert.deepEqual(bodyB, bodyA);
    await delay(200);
    assert.equal(a.all.some((msg) => msg.type === "docs"), false);
    assert.equal(b.all.some((msg) => msg.type === "docs"), false);
    assert.equal(await readDoc(dir, "page.md"), "# New\n\nXbody\n");

    const plain = await openDoc(a, "A", "plain.md");
    await b.next((msg) => msg.type === "locks" && msg.path === "page.md");
    rev = plain.rev;
    await syncLock(a, [], "A", "plain.md", 0, rev, "plain".length);
    a.send({
      type: "edit",
      username: "A",
      path: "plain.md",
      rev,
      anchor: 0,
      cursor: "plain".length,
      op: "insert",
      text: "# Title",
    });
    const titled = await takeDoc(a);
    assert.equal(titled.text, "# Title\n");
    const titleDocsA = await a.next((msg) => msg.type === "docs");
    const titleDocsB = await b.next((msg) => msg.type === "docs");
    assert.equal(titleDocsA.titles["plain.md"], "Title");
    assert.equal(titleDocsB.titles["plain.md"], "Title");
    assert.equal(await readDoc(dir, "plain.md"), "# Title\n");
    assert.equal(a.all.length, 0);
    assert.equal(b.all.length, 0);

    rev = titled.rev;
    a.send({
      type: "edit",
      username: "A",
      path: "plain.md",
      rev,
      anchor: 0,
      cursor: "# Title".length,
      op: "insert",
      text: "plain",
    });
    const cleared = await takeDoc(a);
    assert.equal(cleared.text, "plain\n");
    const clearDocsA = await a.next((msg) => msg.type === "docs");
    const clearDocsB = await b.next((msg) => msg.type === "docs");
    assert.equal(clearDocsA.titles["plain.md"], undefined);
    assert.equal(clearDocsB.titles["plain.md"], undefined);
    assert.equal(Object.hasOwn(clearDocsA.titles, "plain.md"), false);
    assert.equal(await readDoc(dir, "plain.md"), "plain\n");
    assert.equal(a.all.length, 0);
    assert.equal(b.all.length, 0);

    rev = cleared.rev;
    a.send({ type: "edit", username: "A", path: "plain.md", rev, op: "insert", text: "X" });
    const plainBody = await takeDoc(a);
    assert.equal(plainBody.text, "plainX\n");
    await delay(200);
    assert.equal(a.all.some((msg) => msg.type === "docs"), false);
    assert.equal(b.all.some((msg) => msg.type === "docs"), false);
    assert.equal(await readDoc(dir, "plain.md"), "plainX\n");

    const ticketRel = "tickets/bbbbbbbb.md";
    await writeTicket(dir, {
      id: "bbbbbbbb",
      title: "Ticket",
      state: "new",
      created: "2020-01-01T00:00:00.000Z",
      body: "# Old\n",
    });
    const ticket = await openDoc(a, "A", ticketRel);
    assert.equal(ticket.text, "# Old\n");
    await syncLock(a, [], "A", ticketRel, 0, ticket.rev);
    a.send({
      type: "edit",
      username: "A",
      path: ticketRel,
      rev: ticket.rev,
      anchor: 2,
      cursor: 5,
      op: "insert",
      text: "New",
    });
    const ticketDoc = await takeDoc(a);
    assert.equal(ticketDoc.text, "# New\n");
    assert.equal(parseTicket("bbbbbbbb", await readDoc(dir, ticketRel)).body, "# New\n");
    await delay(200);
    assert.equal(a.all.some((msg) => msg.type === "docs"), false);
    assert.equal(b.all.some((msg) => msg.type === "docs"), false);
    a.ws.close();
    b.ws.close();
  });
});

test("a heading title omits comment markers", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "marked.md"), "# {c1}Welcome{/c1}\n\nbody\n\n```comment c1\nnote\n```\n");
    await fs.writeFile(path.join(dir, "part.md"), "# Hello {c1}world{/c1}\n");
    await fs.writeFile(path.join(dir, "two.md"), "# {c1}A{/c1} and {note_2}B{/note_2}\n");
    await fs.writeFile(path.join(dir, "nested.md"), "# {c1}A {c2}B{/c2} C{/c1}\n");
    await fs.writeFile(path.join(dir, "split.md"), "# {c2}Hello\n\nthere{/c2}\n");
    await fs.writeFile(path.join(dir, "bare.md"), "# Use {c9} raw\n");
    await fs.writeFile(path.join(dir, "closer.md"), "# Hello {/c1}\n");
    await fs.writeFile(path.join(dir, "empty.md"), "# {c1}{/c1}\n");
    await fs.writeFile(path.join(dir, "crlf.md"), "# {c1}Welcome{/c1}\r\nbody\n");
    await fs.writeFile(path.join(dir, "page.md"), "# Page\n");
    const a = await hello(port, "A");
    const b = await hello(port, "B");
    a.send({ type: "list", username: "A" });
    const listed = await a.next((msg) => msg.type === "docs");
    assert.equal(listed.titles["marked.md"], "Welcome");
    assert.equal(listed.titles["part.md"], "Hello world");
    assert.equal(listed.titles["two.md"], "A and B");
    assert.equal(listed.titles["nested.md"], "A B C");
    assert.equal(listed.titles["split.md"], "Hello");
    assert.equal(listed.titles["bare.md"], "Use {c9} raw");
    assert.equal(listed.titles["closer.md"], "Hello {/c1}");
    assert.equal(Object.hasOwn(listed.titles, "empty.md"), false);
    assert.equal(listed.titles["crlf.md"], "Welcome");
    assert.equal(listed.titles["page.md"], "Page");
    assert.equal(listed.titles["welcome.md"], "Welcome");

    const opened = await openDoc(a, "A", "page.md");
    await openDoc(b, "B", "page.md");
    let rev = opened.rev;
    await syncLock(a, [b], "A", "page.md", 2, rev, 6);
    a.send({
      type: "edit",
      username: "A",
      path: "page.md",
      rev,
      anchor: 2,
      cursor: 6,
      op: "comment.add",
    });
    const wrapped = await takeDoc(a);
    await takeDoc(b);
    assert.equal(wrapped.text.startsWith("# {c1}Page{/c1}\n"), true);
    await delay(200);
    assert.equal(a.all.some((msg) => msg.type === "docs"), false);
    assert.equal(b.all.some((msg) => msg.type === "docs"), false);
    a.send({ type: "list", username: "A" });
    const same = await a.next((msg) => msg.type === "docs");
    assert.equal(same.titles["page.md"], "Page");
    assert.equal(same.titles["page.md"].includes("{"), false);

    rev = wrapped.rev;
    const openAt = wrapped.text.indexOf("{c1}");
    const closeAt = wrapped.text.indexOf("{/c1}");
    const word = openAt + "{c1}".length;
    assert.equal(wrapped.text.slice(word, closeAt), "Page");
    await syncLock(a, [b], "A", "page.md", word, rev, closeAt);
    a.send({
      type: "edit",
      username: "A",
      path: "page.md",
      rev,
      anchor: word,
      cursor: closeAt,
      op: "insert",
      text: "Title",
    });
    const renamed = await takeDoc(a);
    await takeDoc(b);
    assert.equal(renamed.text.startsWith("# {c1}Title{/c1}\n"), true);
    const docsA = await a.next((msg) => msg.type === "docs");
    const docsB = await b.next((msg) => msg.type === "docs");
    assert.equal(docsA.titles["page.md"], "Title");
    assert.equal(docsB.titles["page.md"], "Title");
    assert.equal(await readDoc(dir, "page.md"), renamed.text);
    a.ws.close();
    b.ws.close();
  });
});

test("a closed holder reconnects with its token and the file message carries its caret and the lock succeeds", async () => {
  await withDocs(async ({ port, dir }) => {
    const text = "alpha\nbeta\n";
    await fs.writeFile(path.join(dir, "a.md"), text);
    const token = "sess_A-1";
    const a = await hello(port, "A", "docs", token);
    let rev = (await openDoc(a, "A", "a.md")).rev;
    await syncLock(a, [], "A", "a.md", 1, rev, 4);
    a.send({
      type: "edit",
      username: "A",
      path: "a.md",
      rev,
      anchor: 2,
      cursor: 2,
      op: "insert",
      text: "Q",
    });
    const edited = await takeDoc(a);
    assert.equal(edited.text, "alQpha\nbeta\n");
    a.send({ type: "undo", username: "A", path: "a.md", rev: edited.rev });
    const undone = await takeDoc(a);
    assert.equal(undone.text, text);
    await syncLock(a, [], "A", "a.md", 1, undone.rev, 4);
    await waitClosed(a.ws);

    const again = await hello(port, "A", "docs", token);
    again.send({ type: "open", username: "A", path: "a.md" });
    const file = await again.next((msg) => msg.type === "file" && msg.path === "a.md");
    assert.equal(file.text, text);
    assert.equal(file.anchor, 1);
    assert.equal(file.cursor, 4);
    const index = lockIndexAt(file.text, file.cursor);
    assert.deepEqual(
      file.locks.find((line) => line.username === "A" && line.index === index),
      { index, username: "A", token },
    );
    again.send({ type: "lock", username: "A", path: "a.md", anchor: 1, cursor: 4, rev: file.rev });
    const locks = await again.next((msg) => msg.type === "locks" || msg.type === "error");
    assert.equal(locks.type, "locks");
    again.send({ type: "redo", username: "A", path: "a.md", rev: file.rev });
    const redone = await takeDoc(again);
    assert.equal(redone.text, "alQpha\nbeta\n");
    assert.equal(redone.cursor, 3);
    assert.equal(redone.anchor, 3);
    again.ws.close();
  });
});

test("a second live socket with that token takes the held line and a later hello adopts the caret", async () => {
  await withDocs(async ({ port, dir }) => {
    const text = "alpha\n\nbeta\n";
    await fs.writeFile(path.join(dir, "a.md"), text);
    const token = "same-token";
    const caret = text.indexOf("beta");
    const a = await hello(port, "A", "docs", token);
    const rev = (await openDoc(a, "A", "a.md")).rev;
    await syncLock(a, [], "A", "a.md", caret, rev);
    const b = await hello(port, "B", "docs", token);
    const opened = await openDoc(b, "B", "a.md");
    assert.equal(Object.hasOwn(opened, "cursor"), false);
    assert.equal(Object.hasOwn(opened, "anchor"), false);
    b.send({ type: "lock", username: "B", path: "a.md", anchor: caret, cursor: caret, rev });
    const took = await b.next((msg) => msg.type === "locks" || msg.type === "error");
    assert.equal(took.type, "locks");
    assert.equal(took.lines.some((line) => line.username === "A"), false);
    await a.next((msg) => msg.type === "locks" && msg.path === "a.md");
    const other = await syncLock(b, [a], "B", "a.md", 0, rev);
    assert.deepEqual(
      other.lines.find((line) => line.username === "B"),
      { index: 0, username: "B", token },
    );

    await waitClosed(a.ws);
    const again = await hello(port, "A", "docs", token);
    again.send({ type: "open", username: "A", path: "a.md" });
    const file = await again.next((msg) => msg.type === "file" && msg.path === "a.md");
    assert.equal(file.anchor, caret);
    assert.equal(file.cursor, caret);
    again.send({ type: "lock", username: "A", path: "a.md", anchor: caret, cursor: caret, rev: file.rev });
    const locks = await again.next((msg) => msg.type === "locks" || msg.type === "error");
    assert.equal(locks.type, "locks");
    assert.deepEqual(
      locks.lines.find((line) => line.index === lockIndexAt(file.text, caret)),
      { index: lockIndexAt(file.text, caret), username: "A", token },
    );
    b.ws.close();
    again.ws.close();
  });
});

test("a reload hello keeps the newest socket for that token", async () => {
  await withDocs(async ({ port, dir }) => {
    const text = "alpha\nbeta\n";
    await fs.writeFile(path.join(dir, "a.md"), text);
    const token = "reload-token";
    const caret = 7;
    const inserted = "zero\n\n";
    const first = await hello(port, "A", "docs", token);
    const second = await hello(port, "A", "docs", token);
    await waitClosed(first.ws);
    const rev = (await openDoc(second, "A", "a.md")).rev;
    await syncLock(second, [], "A", "a.md", caret, rev);
    await waitClosed(second.ws);
    const agent = await hello(port, "B", "docs");
    const opened = await openDoc(agent, "B", "a.md");
    agent.send({
      type: "edit",
      username: "B",
      path: "a.md",
      rev: opened.rev,
      anchor: 0,
      cursor: 0,
      op: "insert",
      text: inserted,
    });
    const doc = await takeDoc(agent);
    assert.equal(doc.text, inserted + text);
    const third = await hello(port, "A", "docs", token);
    third.send({ type: "open", username: "A", path: "a.md" });
    const file = await third.next((msg) => msg.type === "file" && msg.path === "a.md");
    assert.equal(file.cursor, caret + inserted.length);
    assert.equal(file.anchor, caret + inserted.length);
    const index = lockIndexAt(file.text, file.cursor);
    assert.equal(file.locks.some((line) => line.index === index && line.username === "A"), false);
    assert.equal(file.locks.find((line) => line.index === index).username, "B");
    third.send({
      type: "lock",
      username: "A",
      path: "a.md",
      anchor: file.anchor,
      cursor: file.cursor,
      rev: file.rev,
    });
    assert.deepEqual(await third.next((msg) => msg.type === "locks" || msg.type === "error"), {
      type: "error",
      status: 409,
      heldBy: "B",
    });
    agent.ws.close();
    third.ws.close();
  });
});

test("an insert by someone else while the socket is down shifts the caret the file message returns", async () => {
  await withDocs(async ({ port, dir }) => {
    const text = "one\n\nalpha\n";
    await fs.writeFile(path.join(dir, "a.md"), text);
    const token = "down-caret";
    const caret = text.indexOf("alpha") + 2;
    const inserted = "zero\n\n";
    const a = await hello(port, "A", "docs", token);
    const b = await hello(port, "B");
    const rev = (await openDoc(a, "A", "a.md")).rev;
    await openDoc(b, "B", "a.md");
    await syncLock(a, [b], "A", "a.md", caret, rev);
    await waitClosed(a.ws);
    b.send({
      type: "edit",
      username: "B",
      path: "a.md",
      rev,
      anchor: 0,
      cursor: 0,
      op: "insert",
      text: inserted,
    });
    const doc = await takeDoc(b);
    assert.equal(doc.text, inserted + text);
    const again = await hello(port, "A", "docs", token);
    again.send({ type: "open", username: "A", path: "a.md" });
    const file = await again.next((msg) => msg.type === "file" && msg.path === "a.md");
    assert.equal(file.text, doc.text);
    assert.equal(file.cursor, caret + inserted.length);
    assert.equal(file.anchor, caret + inserted.length);
    const index = lockIndexAt(file.text, file.cursor);
    assert.deepEqual(
      file.locks.find((line) => line.username === "A" && line.index === index),
      { index, username: "A", token },
    );
    again.send({
      type: "lock",
      username: "A",
      path: "a.md",
      anchor: file.anchor,
      cursor: file.cursor,
      rev: file.rev,
    });
    const locks = await again.next((msg) => msg.type === "locks" || msg.type === "error");
    assert.equal(locks.type, "locks");
    b.ws.close();
    again.ws.close();
  });
});

test("kmc2taym: a reconnect does not take a line another session holds", async () => {
  await withDocs(async ({ port, dir }) => {
    const text = "one\n\nab\n\ntwo\n";
    await fs.writeFile(path.join(dir, "a.md"), text);
    const token = "page-token";
    const caret = text.indexOf("ab") + 2;
    const line = lockIndexAt(text, caret);
    const page = await hello(port, "Ada", "docs", token);
    const bea = await hello(port, "Bea", "docs", "bea-token");
    const rev = (await openDoc(page, "Ada", "a.md")).rev;
    await openDoc(bea, "Bea", "a.md");
    await syncLock(page, [bea], "Ada", "a.md", caret, rev);
    await waitClosed(page.ws);
    const freed = await bea.next((msg) => msg.type === "locks" && msg.path === "a.md");
    assert.equal(freed.lines.some((item) => item.username === "Ada"), false);
    await syncLock(bea, [], "Bea", "a.md", caret, rev);
    const again = await hello(port, "Ada", "docs", token);
    again.send({ type: "open", username: "Ada", path: "a.md" });
    const file = await again.next((msg) => msg.type === "file" && msg.path === "a.md");
    assert.equal(file.cursor, caret);
    assert.equal(file.anchor, caret);
    assert.equal(file.locks.some((item) => item.index === line && item.username === "Ada"), false);
    assert.deepEqual(
      file.locks.find((item) => item.index === line),
      { index: line, username: "Bea", token: "bea-token" },
    );
    again.send({ type: "lock", username: "Ada", path: "a.md", anchor: caret, cursor: caret, rev: file.rev });
    assert.deepEqual(await again.next((msg) => msg.type === "locks" || msg.type === "error"), {
      type: "error",
      status: 409,
      heldBy: "Bea",
    });
    again.send({
      type: "edit",
      username: "Ada",
      path: "a.md",
      rev: file.rev,
      anchor: caret,
      cursor: caret,
      op: "insert",
      text: "c",
    });
    assert.deepEqual(await again.next((msg) => msg.type === "doc" || msg.type === "error"), {
      type: "error",
      status: 409,
      heldBy: "Bea",
    });
    assert.equal(await readDoc(dir, "a.md"), text);
    bea.send({ type: "lock", username: "Bea", path: "a.md", anchor: caret, cursor: caret, rev: file.rev });
    const still = await bea.next((msg) => msg.type === "locks" || msg.type === "error");
    assert.equal(still.type, "locks");
    assert.deepEqual(
      still.lines.find((item) => item.index === line),
      { index: line, username: "Bea", token: "bea-token" },
    );
    bea.ws.close();
    again.ws.close();
  });
});

test("the hub ignores a session token outside the accepted pattern", async () => {
  await withDocs(async ({ port, dir }) => {
    const text = "alpha\nbeta\n";
    await fs.writeFile(path.join(dir, "a.md"), text);
    for (const session of ["has space", "a".repeat(81), ""]) {
      const a = await hello(port, "A", "docs", session);
      const rev = (await openDoc(a, "A", "a.md")).rev;
      await syncLock(a, [], "A", "a.md", 4, rev);
      await waitClosed(a.ws);
      const again = await hello(port, "A", "docs", session);
      again.send({ type: "open", username: "A", path: "a.md" });
      const file = await again.next((msg) => msg.type === "file" && msg.path === "a.md");
      assert.equal(Object.hasOwn(file, "cursor"), false);
      assert.equal(Object.hasOwn(file, "anchor"), false);
      again.ws.close();
    }
    const token = "a".repeat(80);
    const a = await hello(port, "A", "docs", token);
    const rev = (await openDoc(a, "A", "a.md")).rev;
    await syncLock(a, [], "A", "a.md", 4, rev);
    await waitClosed(a.ws);
    const again = await hello(port, "A", "docs", token);
    again.send({ type: "open", username: "A", path: "a.md" });
    const file = await again.next((msg) => msg.type === "file" && msg.path === "a.md");
    assert.equal(file.cursor, 4);
    assert.equal(file.anchor, 4);
    again.ws.close();
  });
});

test("a gone token leaves the lock and the last close deletes an unreferenced picture", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "pic.md"), "alpha beta\n");
    const ada = await hello(port, "Ada", "docs", "ada-tab");
    const attached = await attachBytes(ada, "Ada", "pic.md", PNG, { cursor: 8 });
    const name = imageFile(attached.file.text, "pic", "png");
    const full = path.join(dir, "pic", name);
    const extra = await attachBytes(ada, "Ada", "pic.md", PNG, { cursor: 8 });
    const kept = imageFiles(extra.file.text, "pic", "png").find((file) => file !== name);
    const keptFull = path.join(dir, "pic", kept);
    const start = extra.file.text.indexOf(`![${name}]`);
    const end = extra.file.text.indexOf("\n", start) + 1;
    ada.send({
      type: "edit",
      username: "Ada",
      path: "pic.md",
      rev: extra.file.rev,
      anchor: start,
      cursor: end,
      op: "delete",
    });
    const removed = await takeDoc(ada);
    assert.equal(removed.text.includes(`![${name}]`), false);
    assert.equal(removed.text.includes(`![${kept}]`), true);
    assert.ok((await fs.readFile(full)).equals(PNG));
    const caret = removed.cursor;
    await waitClosed(ada.ws);
    await waitAbsent(full);
    assert.ok((await fs.readFile(keptFull)).equals(PNG));

    const bea = await hello(port, "Bea", "docs", "bea-tab");
    const opened = await openDoc(bea, "Bea", "pic.md");
    bea.send({ type: "lock", username: "Bea", path: "pic.md", anchor: caret, cursor: caret, rev: opened.rev });
    const locks = await bea.next((msg) => msg.type === "locks" || msg.type === "error");
    assert.equal(locks.type, "locks");
    assert.equal(locks.lines.some((line) => line.username === "Ada"), false);
    bea.ws.close();
  });
});

test("a different token is another session, and its document keeps the picture until that tab leaves", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "pic.md"), "alpha beta\n\ngamma\n");
    const ada = await hello(port, "Ada", "docs", "ada-tab");
    const attached = await attachBytes(ada, "Ada", "pic.md", PNG, { cursor: 8 });
    const name = imageFile(attached.file.text, "pic", "png");
    const full = path.join(dir, "pic", name);
    const start = attached.file.text.indexOf(`![${name}]`);
    const end = attached.file.text.indexOf("\n", start) + 1;
    ada.send({
      type: "edit",
      username: "Ada",
      path: "pic.md",
      rev: attached.file.rev,
      anchor: start,
      cursor: end,
      op: "delete",
    });
    const removed = await takeDoc(ada);
    assert.equal(removed.text.includes(`![${name}]`), false);
    assert.ok((await fs.readFile(full)).equals(PNG));
    const bea = await hello(port, "Ada", "docs", "bea-tab");
    const opened = await openDoc(bea, "Ada", "pic.md");
    const caret = opened.text.indexOf("gamma");
    await syncLock(ada, [bea], "Ada", "pic.md", caret, opened.rev);
    bea.send({ type: "lock", username: "Ada", path: "pic.md", anchor: caret, cursor: caret, rev: opened.rev });
    assert.deepEqual(await bea.next((msg) => msg.type === "error" || msg.type === "locks"), {
      type: "error",
      status: 409,
      heldBy: "Ada",
    });
    await waitClosed(ada.ws);
    await stays(full);
    const freed = await bea.next((msg) => msg.type === "locks" && msg.path === "pic.md");
    assert.equal(freed.lines.some((line) => line.token === "ada-tab"), false);
    bea.send({ type: "lock", username: "Ada", path: "pic.md", anchor: caret, cursor: caret, rev: freed.rev });
    const took = await bea.next((msg) => msg.type === "locks" || msg.type === "error");
    assert.equal(took.type, "locks");
    assert.equal(
      took.lines.some((line) => line.token === "bea-tab" && line.index === lockIndexAt(opened.text, caret)),
      true,
    );
    await waitClosed(bea.ws);
    await waitAbsent(full);
  });
});

test("a second open with the same token is not held by that user", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "again.md"), "alpha beta\n\ngamma delta\n");
    const token = "same-tab";
    const ada = await hello(port, "Ada", "docs", token);
    const opened = await openDoc(ada, "Ada", "again.md");
    await syncLock(ada, [], "Ada", "again.md", 3, opened.rev);
    await waitClosed(ada.ws);
    const again = await hello(port, "Ada", "docs", token);
    const file = await openDoc(again, "Ada", "again.md");
    assert.equal(file.cursor, 3);
    const attached = await attachBytes(again, "Ada", "again.md", PNG, { cursor: 3 });
    assert.notEqual(attached.status, 409, attached.heldBy || JSON.stringify(attached));
    assert.equal(attached.file.text.includes("!["), true);
    assert.notEqual(attached.file.text, file.text);
    again.ws.close();
  });
});

test("a live socket with the same token does not hold a paste, and opening another document drops it", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "again.md"), "alpha beta\n\ngamma delta\n");
    await fs.writeFile(path.join(dir, "away.md"), "Away.\n");
    await fs.writeFile(path.join(dir, "pic.md"), "alpha beta\n");
    const token = "same-tab";
    const first = await hello(port, "Ada", "docs", token);
    const opened = await openDoc(first, "Ada", "again.md");
    await syncLock(first, [], "Ada", "again.md", 3, opened.rev);
    const second = await hello(port, "Ada", "docs", token);
    await openDoc(second, "Ada", "again.md");
    const attached = await attachBytes(second, "Ada", "again.md", PNG, { cursor: 3 });
    assert.notEqual(attached.status, 409, attached.heldBy || JSON.stringify(attached));
    assert.equal(attached.file.text.includes("!["), true);
    first.ws.close();
    second.ws.close();

    const holder = await hello(port, "Ada", "docs", token);
    const shot = await attachBytes(holder, "Ada", "pic.md", PNG, { cursor: 8 });
    const name = imageFile(shot.file.text, "pic", "png");
    const full = path.join(dir, "pic", name);
    const extra = await attachBytes(holder, "Ada", "pic.md", PNG, { cursor: 8 });
    const kept = imageFiles(extra.file.text, "pic", "png").find((file) => file !== name);
    const start = extra.file.text.indexOf(`![${name}]`);
    const end = extra.file.text.indexOf("\n", start) + 1;
    holder.send({
      type: "edit",
      username: "Ada",
      path: "pic.md",
      rev: extra.file.rev,
      anchor: start,
      cursor: end,
      op: "delete",
    });
    const removed = await takeDoc(holder);
    assert.equal(removed.text.includes(`![${name}]`), false);
    assert.ok((await fs.readFile(full)).equals(PNG));
    const later = await hello(port, "Ada", "docs", token);
    later.send({ type: "open", username: "Ada", path: "away.md" });
    const away = await later.next((msg) => msg.type === "file" && msg.path === "away.md");
    assert.equal(away.text, "Away.\n");
    await waitAbsent(full);
    assert.ok((await fs.readFile(path.join(dir, "pic", kept))).equals(PNG));
    assert.equal(holder.ws.readyState, WebSocket.OPEN);
    holder.ws.close();
    later.ws.close();
  });
});

test("a live socket with the same token takes the line the previous socket holds", async () => {
  await withDocs(async ({ port, dir }) => {
    const text = "one\n\ntwo\n\nthree\n";
    await fs.writeFile(path.join(dir, "a.md"), text);
    const token = "same-token";
    const caret = text.indexOf("three");
    const index = lockIndexAt(text, caret);
    const first = await hello(port, "Ada", "docs", token);
    const second = await hello(port, "Ada", "docs", token);
    const rev = (await openDoc(first, "Ada", "a.md")).rev;
    await openDoc(second, "Ada", "a.md");
    await syncLock(first, [second], "Ada", "a.md", caret, rev);
    second.send({ type: "lock", username: "Ada", path: "a.md", anchor: caret, cursor: caret, rev });
    const took = await second.next((msg) => msg.type === "locks" || msg.type === "error");
    assert.equal(took.type, "locks");
    assert.deepEqual(took.lines.filter((line) => line.index === index), [{ index, username: "Ada", token }]);
    await first.next((msg) => msg.type === "locks" && msg.path === "a.md");
    const other = await hello(port, "Bea", "docs", "other-token");
    await openDoc(other, "Bea", "a.md");
    other.send({ type: "lock", username: "Bea", path: "a.md", anchor: caret, cursor: caret, rev });
    assert.deepEqual(await other.next((msg) => msg.type === "error" || msg.type === "locks"), {
      type: "error",
      status: 409,
      heldBy: "Ada",
    });
    // The second socket left the line. It stays unlisted only if the first socket dropped it.
    const moved = await syncLock(second, [first], "Ada", "a.md", 0, rev);
    assert.equal(moved.lines.some((line) => line.index === index), false);
    first.ws.close();
    second.ws.close();
    other.ws.close();
  });
});

test("opening another document is the last close for a token socket", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "pic.md"), "alpha beta\n");
    await fs.writeFile(path.join(dir, "away.md"), "Away.\n");
    const ada = await hello(port, "Ada", "docs", "ada-tab");
    const attached = await attachBytes(ada, "Ada", "pic.md", PNG, { cursor: 8 });
    const name = imageFile(attached.file.text, "pic", "png");
    const full = path.join(dir, "pic", name);
    const extra = await attachBytes(ada, "Ada", "pic.md", PNG, { cursor: 8 });
    const kept = imageFiles(extra.file.text, "pic", "png").find((file) => file !== name);
    const start = extra.file.text.indexOf(`![${name}]`);
    const end = extra.file.text.indexOf("\n", start) + 1;
    ada.send({
      type: "edit",
      username: "Ada",
      path: "pic.md",
      rev: extra.file.rev,
      anchor: start,
      cursor: end,
      op: "delete",
    });
    const removed = await takeDoc(ada);
    assert.equal(removed.text.includes(`![${name}]`), false);
    assert.ok((await fs.readFile(full)).equals(PNG));
    ada.send({ type: "open", username: "Ada", path: "away.md" });
    const away = await ada.next((msg) => msg.type === "file" && msg.path === "away.md");
    assert.equal(away.text, "Away.\n");
    await waitAbsent(full);
    assert.ok((await fs.readFile(path.join(dir, "pic", kept))).equals(PNG));
    ada.ws.close();
  });
});

test("picture: a space in the document path keeps the file when another document opens", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "Test Page.md"), "alpha beta\n");
    await fs.writeFile(path.join(dir, "away.md"), "Away.\n");
    const ada = await hello(port, "Ada", "docs", "ada-tab");
    try {
      const attached = await attachBytes(ada, "Ada", "Test Page.md", PNG, { cursor: 8 });
      const name = imageFile(attached.file.text, "Test Page", "png");
      assert.notEqual(name, "");
      const full = path.join(dir, "Test Page", name);
      assert.equal(attached.file.text.includes(`![${name}](<Test Page/${name}>)`), true);
      assert.ok((await fs.readFile(full)).equals(PNG));
      const raw = await getRaw(port, `/raw/docs/${encodeURIComponent("Test Page")}/${name}`);
      assert.equal(raw.status, 200);
      assert.ok(raw.body.equals(PNG));

      ada.send({ type: "open", username: "Ada", path: "away.md" });
      const away = await ada.next((msg) => msg.type === "file" && msg.path === "away.md");
      assert.equal(away.text, "Away.\n");
      assert.ok((await fs.readFile(full)).equals(PNG));
      const still = await getRaw(port, `/raw/docs/${encodeURIComponent("Test Page")}/${name}`);
      assert.equal(still.status, 200);
      assert.ok(still.body.equals(PNG));

      ada.send({ type: "open", username: "Ada", path: "Test Page.md" });
      const back = await ada.next((msg) => msg.type === "file" && msg.path === "Test Page.md");
      const start = back.text.indexOf(`![${name}]`);
      const end = back.text.indexOf("\n", start) + 1;
      ada.send({
        type: "edit",
        username: "Ada",
        path: "Test Page.md",
        rev: back.rev,
        anchor: start,
        cursor: end,
        op: "delete",
      });
      const removed = await takeDoc(ada);
      assert.equal(removed.text.includes(`![${name}]`), false);
      assert.ok((await fs.readFile(full)).equals(PNG));
      ada.send({ type: "open", username: "Ada", path: "away.md" });
      await ada.next((msg) => msg.type === "file" && msg.path === "away.md");
      await waitAbsent(full);
      assert.equal((await getRaw(port, `/raw/docs/${encodeURIComponent("Test Page")}/${name}`)).status, 404);
    } finally {
      ada.ws.close();
    }
  });
});

test("picture: a parenthesis in the document path keeps the file when another document opens", async () => {
  await withDocs(async ({ port, dir }) => {
    const rel = "Plan (draft).md";
    await fs.writeFile(path.join(dir, rel), "alpha beta\n");
    await fs.writeFile(path.join(dir, "away.md"), "Away.\n");
    const ada = await hello(port, "Ada", "docs", "ada-tab");
    try {
      const attached = await attachBytes(ada, "Ada", rel, PNG, { cursor: 8 });
      const name = imageFile(attached.file.text, "Plan (draft)", "png");
      assert.notEqual(name, "");
      assert.equal(attached.file.text.includes(`![${name}](<Plan (draft)/${name}>)`), true);
      const full = path.join(dir, "Plan (draft)", name);
      assert.ok((await fs.readFile(full)).equals(PNG));
      const rawPath = `/raw/docs/${encodeURIComponent("Plan (draft)")}/${name}`;
      const raw = await getRaw(port, rawPath);
      assert.equal(raw.status, 200);
      assert.ok(raw.body.equals(PNG));

      ada.send({ type: "open", username: "Ada", path: "away.md" });
      const away = await ada.next((msg) => msg.type === "file" && msg.path === "away.md");
      assert.equal(away.text, "Away.\n");
      assert.ok((await fs.readFile(full)).equals(PNG));
      const still = await getRaw(port, rawPath);
      assert.equal(still.status, 200);
      assert.ok(still.body.equals(PNG));
    } finally {
      ada.ws.close();
    }
  });
});

test("T-rev", async () => {
  await withDocs(async ({ port, dir }) => {
    const helloText = "hello line\nsecond line\n";
    await fs.writeFile(path.join(dir, "hello.md"), helloText);
    const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
    const opener = await hello(port, "A");
    const other = await hello(port, "B");
    const asker = await hello(port, "C");
    const opened = await openDoc(opener, "A", "hello.md");
    const noted = opened.rev;
    asker.send({ type: "rev", username: "C", path: "hello.md" });
    const reply = await asker.next((msg) => msg.type === "rev" || msg.type === "error");
    assert.deepEqual(reply, { type: "rev", path: "hello.md", sha256: sha(helloText) });
    await delay(100);
    assert.equal(opener.all.some((msg) => msg.type === "rev"), false);
    assert.equal(other.all.some((msg) => msg.type === "rev"), false);
    const again = await openDoc(opener, "A", "hello.md");
    assert.equal(again.rev, noted);
    assert.equal(again.text, helloText);

    await syncLock(opener, [], "A", "hello.md", 0, noted);
    opener.send({ type: "edit", username: "A", path: "hello.md", rev: noted, op: "insert", text: "Z" });
    const doc = await takeDoc(opener);
    assert.equal(doc.rev, noted + 1);
    assert.equal(doc.text, `Z${helloText}`);
    const disk = "disk only\n";
    await fs.writeFile(path.join(dir, "hello.md"), disk);
    asker.send({ type: "rev", username: "C", path: "hello.md" });
    const cached = await asker.next((msg) => msg.type === "rev" || msg.type === "error");
    assert.deepEqual(cached, { type: "rev", path: "hello.md", sha256: sha(doc.text) });
    assert.notEqual(cached.sha256, sha(disk));
    const still = await openDoc(opener, "A", "hello.md");
    assert.equal(still.rev, doc.rev);
    assert.equal(still.text, doc.text);

    const sealed = Buffer.from("never opened\n", "utf8");
    await fs.writeFile(path.join(dir, "sealed.md"), sealed);
    const raw = Buffer.from([0xff, 0x00, 0xfe]);
    await fs.writeFile(path.join(dir, "raw.bin"), raw);
    asker.send({ type: "rev", username: "C", path: "sealed.md" });
    const fresh = await asker.next((msg) => msg.type === "rev" && msg.path === "sealed.md");
    assert.equal(fresh.sha256, sha(await fs.readFile(path.join(dir, "sealed.md"))));
    asker.send({ type: "rev", username: "C", path: "raw.bin" });
    const bytes = await asker.next((msg) => msg.type === "rev" && msg.path === "raw.bin");
    assert.equal(bytes.sha256, sha(raw));
    await delay(100);
    assert.equal(opener.all.some((msg) => msg.type === "rev"), false);
    assert.equal(other.all.some((msg) => msg.type === "rev"), false);
    assert.equal(asker.all.some((msg) => msg.type === "doc"), false);
    opener.ws.close();
    other.ws.close();
    asker.ws.close();
  });
});

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const IMAGE_ID = "[23456789abcdefghjkmnpqrstuvwxyz]{8}";

function rollsFor(id) {
  const size = TICKET_ALPHABET.length;
  const rolls = [];
  for (const ch of id) rolls.push((TICKET_ALPHABET.indexOf(ch) + 0.5) / size);
  return rolls;
}

function sendBytes(client, bytes) {
  client.ws.send(Buffer.from(bytes));
}

async function attachBytes(client, username, rel, bytes, extra = {}, timeout = 3000) {
  client.send({ type: "attach", username, path: rel, ...extra });
  sendBytes(client, bytes);
  const first = await client.next((msg) => msg.type === "doc" || msg.type === "error", timeout);
  if (first.type === "error") return first;
  await client.next((msg) => msg.type === "locks" && msg.path === rel && msg.rev === first.rev, timeout);
  const file = await client.next((msg) => (msg.type === "file" && msg.path === rel) || msg.type === "error", timeout);
  if (file.type === "error") return file;
  return { doc: first, file };
}

function imageFiles(text, dir, ext) {
  const found = [];
  const escaped = dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`!\\[(${IMAGE_ID}\\.${ext})\\]\\(<?${escaped}/\\1>?\\)`, "g");
  for (const match of text.matchAll(re)) found.push(match[1]);
  return found;
}

function imageFile(text, dir, ext) {
  return imageFiles(text, dir, ext)[0] || "";
}

test("create stores a normalized document path", async () => {
  assert.equal(normalizeDocRel("Test Page.md"), "test-page.md");
  assert.equal(normalizeDocRel("Plan (draft).md"), "plan-draft.md");
  assert.equal(normalizeDocRel("notes/My Notes.md"), "notes/my-notes.md");
  assert.equal(normalizeDocRel("my_notes.v2.md"), "my-notes-v2.md");
  assert.equal(normalizeDocRel("Äpfel.md"), "äpfel.md");
  assert.equal(normalizeDocRel("My Notes.markdown"), "my-notes.markdown");
  assert.equal(normalizeDocRel("a---b.md"), "a-b.md");
  assert.equal(normalizeDocRel("-Page-.md"), "page.md");
  assert.equal(normalizeDocRel("!!!.md"), null);
  assert.equal(normalizeDocRel("notes/!!!.md"), null);
  assert.equal(normalizeDocRel(".md"), null);
  assert.equal(normalizeDocRel("a.txt"), null);
  assert.equal(assetDirOf("test-page.md"), "test-page");

  await withDocs(async ({ port, dir }) => {
    const a = await hello(port, "A");
    try {
      const made = async (sent, text) => {
        const payload = { type: "create", username: "A", path: sent };
        if (text !== undefined) payload.text = text;
        a.send(payload);
        const docs = await a.next((msg) => msg.type === "docs" || msg.type === "error");
        if (docs.type === "error") return docs;
        const file = await a.next((msg) => msg.type === "file" || msg.type === "error");
        return { docs, file };
      };
      const absent = (rel) => assert.rejects(() => fs.lstat(path.join(dir, rel)));

      const page = await made("Test Page.md", "alpha beta\n");
      assert.equal(page.file.type, "file");
      assert.equal(page.file.path, "test-page.md");
      assert.equal(page.file.rev, 0);
      assert.equal(page.file.text, "alpha beta\n");
      assert.equal(page.docs.files.includes("test-page.md"), true);
      assert.equal(page.docs.files.includes("Test Page.md"), false);
      assert.equal(page.docs.titles["test-page.md"], undefined);
      assert.equal(await readDoc(dir, "test-page.md"), "alpha beta\n");
      await absent("Test Page.md");

      const attached = await attachBytes(a, "A", "test-page.md", PNG, { cursor: 8 });
      const shot = imageFile(attached.file.text, "test-page", "png");
      assert.notEqual(shot, "");
      assert.equal(attached.file.text.includes(`(test-page/${shot})`), true);
      assert.ok((await fs.readFile(path.join(dir, "test-page", shot))).equals(PNG));
      await absent(path.join("Test Page", shot));
      const raw = await getRaw(port, `/raw/docs/test-page/${shot}`);
      assert.equal(raw.status, 200);
      assert.ok(raw.body.equals(PNG));

      const draft = await made("Plan (draft).md");
      assert.equal(draft.file.path, "plan-draft.md");
      assert.equal(await readDoc(dir, "plan-draft.md"), "");
      await absent("Plan (draft).md");

      const nested = await made("notes/My Notes.md", "# My Notes\n");
      assert.equal(nested.file.path, "notes/my-notes.md");
      assert.equal(nested.docs.titles["notes/my-notes.md"], "My Notes");
      assert.equal(await readDoc(dir, "notes/my-notes.md"), "# My Notes\n");
      await absent("notes/My Notes.md");

      const dotted = await made("my_notes.v2.md");
      assert.equal(dotted.file.path, "my-notes-v2.md");
      assert.equal(await readDoc(dir, "my-notes-v2.md"), "");

      const apple = await made("Äpfel.md", "fruit\n");
      assert.equal(apple.file.path, "äpfel.md");
      assert.equal(await readDoc(dir, "äpfel.md"), "fruit\n");
      await absent("Äpfel.md");

      const markdown = await made("Keep Me.markdown");
      assert.equal(markdown.file.path, "keep-me.markdown");
      assert.equal(await readDoc(dir, "keep-me.markdown"), "");

      const folder = await made("My Folder/Page.md", "no heading\n");
      assert.equal(folder.file.path, "my-folder/page.md");
      assert.equal(folder.docs.titles["my-folder/page.md"], undefined);
      assert.equal(await readDoc(dir, "my-folder/page.md"), "no heading\n");
      await absent("My Folder/Page.md");
      const stat = await fs.lstat(path.join(dir, "my-folder"));
      assert.equal(stat.isDirectory(), true);

      const second = await made("test-page.md");
      assert.equal(second.file.path, "test-page-2.md");
      assert.equal(second.file.rev, 0);
      assert.equal(second.file.text, "");
      assert.equal(await readDoc(dir, "test-page-2.md"), "");
      const third = await made("TEST PAGE.md");
      assert.equal(third.file.path, "test-page-3.md");
      assert.equal(third.file.rev, 0);
      assert.equal(third.file.text, "");
      assert.equal(await readDoc(dir, "test-page-3.md"), "");
      const stored = await readDoc(dir, "test-page.md");
      assert.ok(stored.startsWith("alpha beta\n"));
      assert.ok(stored.includes(`(test-page/${shot})`));
      await absent("test-page-4.md");

      a.send({ type: "create", username: "A", path: "!!!.md" });
      assert.deepEqual(await a.next((msg) => msg.type === "error"), { type: "error", status: 400 });
      await absent("!!!.md");
      a.send({ type: "create", username: "A", path: "newdir/!!!.md" });
      assert.deepEqual(await a.next((msg) => msg.type === "error"), { type: "error", status: 400 });
      await absent("newdir");
      a.send({ type: "create", username: "A", path: "!!!/page.md" });
      assert.deepEqual(await a.next((msg) => msg.type === "error"), { type: "error", status: 400 });
      await absent("page.md");

      a.send({ type: "create", username: "A", path: "tickets/Hello.md" });
      assert.deepEqual(await a.next((msg) => msg.type === "error"), { type: "error", status: 400 });
      await absent("tickets/Hello.md");
      await absent("tickets/hello.md");
      a.send({ type: "create", username: "A", path: "Tickets/Hello.md" });
      assert.deepEqual(await a.next((msg) => msg.type === "error"), { type: "error", status: 400 });
      await absent("Tickets/Hello.md");
      await absent("tickets/hello.md");

      a.send({ type: "create", username: "A", path: "../nope.md" });
      assert.deepEqual(await a.next((msg) => msg.type === "error"), { type: "error", status: 404 });
      a.send({ type: "create", username: "A", path: ".git/x.md" });
      assert.deepEqual(await a.next((msg) => msg.type === "error"), { type: "error", status: 404 });
      a.send({ type: "create", username: "A", path: `${"n".repeat(1022)}.md` });
      assert.deepEqual(await a.next((msg) => msg.type === "error"), { type: "error", status: 404 });

      await fs.writeFile(path.join(dir, "Kept Name.md"), "kept\n");
      const opened = await openDoc(a, "A", "Kept Name.md");
      assert.equal(opened.path, "Kept Name.md");
      assert.equal(opened.text, "kept\n");
      assert.equal(await readDoc(dir, "Kept Name.md"), "kept\n");
      const kept = await made("kept-name.md");
      assert.equal(kept.file.path, "kept-name-2.md");
      assert.equal(kept.file.rev, 0);
      assert.equal(kept.file.text, "");
      assert.equal(await readDoc(dir, "Kept Name.md"), "kept\n");
      assert.equal(await readDoc(dir, "kept-name-2.md"), "");
      await absent("kept-name.md");
      assert.equal((await fs.readdir(dir)).includes("Kept Name.md"), true);

      await fs.mkdir(path.join(dir, "archive"), { recursive: true });
      await fs.writeFile(path.join(dir, "archive", "keep.md"), "k\n");
      await fs.mkdir(path.join(dir, "Old Notes"), { recursive: true });
      await fs.writeFile(path.join(dir, "Old Notes", "space.md"), "space\n");
      a.send({ type: "move", username: "A", path: "Old Notes", dir: "archive" });
      const moved = await a.next((msg) => msg.type === "moved" || msg.type === "error");
      assert.deepEqual(moved, {
        type: "moved",
        path: "Old Notes",
        moves: [{ path: "Old Notes/space.md", dest: "archive/Old Notes/space.md" }],
      });
      assert.equal(await readDoc(dir, "archive/Old Notes/space.md"), "space\n");
      await absent("archive/old-notes/space.md");
      await absent("Old Notes/space.md");
    } finally {
      a.ws.close();
    }
  });
});

test("create places a file in the directory that already normalizes to that segment", async () => {
  await withDocs(async ({ port, dir }) => {
    const a = await hello(port, "A");
    try {
      const made = async (sent, text) => {
        a.send({ type: "create", username: "A", path: sent, text });
        const docs = await a.next((msg) => msg.type === "docs" || msg.type === "error");
        if (docs.type === "error") return docs;
        const file = await a.next((msg) => msg.type === "file" || msg.type === "error");
        return { docs, file };
      };
      const absent = (rel) => assert.rejects(() => fs.lstat(path.join(dir, rel)));

      await fs.mkdir(path.join(dir, "My Notes"));
      await fs.writeFile(path.join(dir, "My Notes", "keep.md"), "keep\n");
      const reused = await made("MY NOTES/Page.md", "inside\n");
      assert.equal(reused.file.path, "My Notes/page.md");
      assert.equal(reused.file.text, "inside\n");
      assert.equal(await readDoc(dir, "My Notes/page.md"), "inside\n");
      await absent("my-notes");
      await absent("MY NOTES");

      const nested = await made("my-notes/Sub/Leaf.md", "leaf\n");
      assert.equal(nested.file.path, "My Notes/sub/leaf.md");
      assert.equal(await readDoc(dir, "My Notes/sub/leaf.md"), "leaf\n");
      await absent("my-notes");

      const attached = await attachBytes(a, "A", "My Notes/page.md", PNG, { cursor: 3 });
      const shot = imageFile(attached.file.text, "My Notes/page", "png");
      assert.notEqual(shot, "");
      assert.ok((await fs.readFile(path.join(dir, "My Notes", "page", shot))).equals(PNG));
      await absent(path.join("my-notes", "page"));

      await fs.mkdir(path.join(dir, "notes"));
      await fs.mkdir(path.join(dir, "Notes"));
      const exact = await made("NOTES/Zed.md", "z\n");
      assert.equal(exact.file.path, "notes/zed.md");
      assert.equal(await readDoc(dir, "notes/zed.md"), "z\n");
      await absent("Notes/zed.md");

      await fs.mkdir(path.join(dir, "My_Notes"));
      const clash = await made("my-notes/other.md", "no\n");
      assert.equal(clash.type, "error");
      assert.equal(clash.status, 409);
      await absent("my-notes");
      await absent("My Notes/other.md");
      await absent("My_Notes/other.md");

      await fs.mkdir(path.join(dir, ".git"));
      const git = await made("git/page.md", "g\n");
      assert.equal(git.file.path, "git/page.md");
      assert.equal(await readDoc(dir, "git/page.md"), "g\n");
      await absent(".git/page.md");
    } finally {
      a.ws.close();
    }
  });
});

test("create stores the first free file name when that name is taken", async () => {
  await withDocs(async ({ port, dir }) => {
    const a = await hello(port, "A");
    try {
      const made = async (sent, text) => {
        const payload = { type: "create", username: "A", path: sent };
        if (text !== undefined) payload.text = text;
        a.send(payload);
        const docs = await a.next((msg) => msg.type === "docs" || msg.type === "error");
        if (docs.type === "error") return docs;
        const file = await a.next((msg) => msg.type === "file" || msg.type === "error");
        return { docs, file };
      };
      const absent = (rel) => assert.rejects(() => fs.lstat(path.join(dir, rel)));

      const fresh = await made("Fresh Page.md", "fresh\n");
      assert.equal(fresh.file.path, "fresh-page.md");
      assert.equal(await readDoc(dir, "fresh-page.md"), "fresh\n");

      const notes = await made("notes.markdown", "one\n");
      assert.equal(notes.file.path, "notes.markdown");
      const notesAgain = await made("Notes.markdown", "two\n");
      assert.equal(notesAgain.file.path, "notes-2.markdown");
      assert.equal(notesAgain.file.text, "two\n");
      assert.equal(await readDoc(dir, "notes.markdown"), "one\n");
      assert.equal(await readDoc(dir, "notes-2.markdown"), "two\n");
      await absent("notes.md");
      await absent("notes-2.md");

      await fs.writeFile(path.join(dir, "test-page-2.md"), "two\n");
      const numbered = await made("test-page-2.md", "next\n");
      assert.equal(numbered.file.path, "test-page-2-2.md");
      assert.equal(numbered.file.text, "next\n");
      assert.equal(await readDoc(dir, "test-page-2.md"), "two\n");
      assert.equal(await readDoc(dir, "test-page-2-2.md"), "next\n");
      await absent("test-page.md");
      await absent("test-page-3.md");

      await fs.writeFile(path.join(dir, "gap.md"), "g\n");
      await fs.writeFile(path.join(dir, "gap-3.md"), "3\n");
      const gap = await made("gap.md", "mid\n");
      assert.equal(gap.file.path, "gap-2.md");
      assert.equal(await readDoc(dir, "gap.md"), "g\n");
      assert.equal(await readDoc(dir, "gap-3.md"), "3\n");
      assert.equal(await readDoc(dir, "gap-2.md"), "mid\n");

      await fs.mkdir(path.join(dir, "dirfile.md"));
      const dirfile = await made("dirfile.md", "file\n");
      assert.equal(dirfile.file.path, "dirfile-2.md");
      assert.equal(await readDoc(dir, "dirfile-2.md"), "file\n");
      assert.equal((await fs.lstat(path.join(dir, "dirfile.md"))).isDirectory(), true);

      await fs.mkdir(path.join(dir, "Old Pages"));
      await fs.writeFile(path.join(dir, "Old Pages", "Page.md"), "old\n");
      await fs.writeFile(path.join(dir, "Old Pages", "Page-2.md"), "spelling\n");
      const nested = await made("old-pages/Page.md", "new\n");
      assert.equal(nested.file.path, "Old Pages/page-3.md");
      assert.equal(nested.file.text, "new\n");
      assert.equal(await readDoc(dir, "Old Pages/Page.md"), "old\n");
      assert.equal(await readDoc(dir, "Old Pages/Page-2.md"), "spelling\n");
      assert.equal(await readDoc(dir, "Old Pages/page-3.md"), "new\n");
      await absent("old-pages");
      await absent("Old Pages/page.md");
      await absent("Old Pages/page-2.md");

      const attached = await attachBytes(a, "A", "Old Pages/page-3.md", PNG, { cursor: 0 });
      assert.equal(attached.file.type, "file");
      const shot = imageFile(attached.file.text, "Old Pages/page-3", "png");
      assert.notEqual(shot, "");
      assert.ok((await fs.readFile(path.join(dir, "Old Pages", "page-3", shot))).equals(PNG));
      await absent(path.join("old-pages", "page-3"));
      assert.equal(await readDoc(dir, "Old Pages/Page.md"), "old\n");
      assert.equal(await readDoc(dir, "Old Pages/Page-2.md"), "spelling\n");

      await fs.writeFile(path.join(dir, "edge.md"), "edge\n");
      for (let n = 2; n <= 98; n += 1) await fs.writeFile(path.join(dir, `edge-${n}.md`), `${n}\n`);
      const last = await made("edge.md", "last\n");
      assert.equal(last.file.path, "edge-99.md");
      assert.equal(await readDoc(dir, "edge.md"), "edge\n");
      assert.equal(await readDoc(dir, "edge-98.md"), "98\n");
      assert.equal(await readDoc(dir, "edge-99.md"), "last\n");
      await absent("edge-100.md");

      await fs.writeFile(path.join(dir, "full.md"), "full\n");
      for (let n = 2; n <= 99; n += 1) await fs.writeFile(path.join(dir, `full-${n}.md`), `${n}\n`);
      const blocked = await made("Full.md", "no\n");
      assert.equal(blocked.type, "error");
      assert.equal(blocked.status, 409);
      assert.equal(await readDoc(dir, "full.md"), "full\n");
      assert.equal(await readDoc(dir, "full-2.md"), "2\n");
      assert.equal(await readDoc(dir, "full-99.md"), "99\n");
      await absent("full-100.md");
    } finally {
      a.ws.close();
    }
  });
});

async function waitAbsent(full) {
  for (let i = 0; i < 40; i += 1) {
    try {
      await fs.lstat(full);
    } catch (err) {
      if (err && err.code === "ENOENT") return;
      throw err;
    }
    await delay(25);
  }
  throw new Error(`still present ${full}`);
}

async function stays(full) {
  const start = Date.now();
  while (Date.now() - start < 200) {
    await fs.lstat(full);
    await delay(20);
  }
}

test("picture: names, kinds, and placement", () => {
  const line = "![abcdefgh.png](pic/abcdefgh.png)";
  const para = imagePlacement("alpha beta\n", 8, line);
  assert.equal(para.doc, `alpha beta\n\n${line}\n`);
  assert.equal(para.caret, para.doc.length);
  assert.ok(plan(para.doc, para.caret).atoms.some((atom) => atom.type === "image" && atom.alt === "abcdefgh.png" && atom.url === "pic/abcdefgh.png"));

  const both = imagePlacement("alpha beta\n\ngamma\n", 8, line);
  assert.equal(both.doc, `alpha beta\n\n${line}\n\ngamma\n`);
  const inside = imageRangePlacement("alpha beta\n", 6, 8, line);
  assert.equal(inside.doc, `alpha beta\n\n${line}\n`);
  assert.equal(inside.doc.startsWith("alpha beta\n"), true);
  const gap = "alpha\n\nbeta\n";
  const onBlank = imageRangePlacement(gap, 6, 6, line);
  assert.equal(onBlank.doc, `alpha\n${line}\nbeta\n`);
  assert.equal(onBlank.caret, onBlank.doc.indexOf("beta"));
  const across = imageRangePlacement(gap, 0, 8, line);
  assert.equal(across.error, 400);
  assert.equal(Object.hasOwn(across, "doc"), false);
  assert.equal(both.caret, both.doc.indexOf(line) + line.length + 1);
  assert.ok(plan(both.doc, both.caret).atoms.some((atom) => atom.type === "image"));

  const empty = imagePlacement("", null, line);
  assert.equal(empty.doc, `${line}\n`);
  assert.equal(empty.caret, empty.doc.length);

  const note = "Hello\n\n```comment c1\n:: 0\n@2026-10-05T16:00:00.000Z Ada\nA note.\n```\n";
  const placed = imagePlacement(note, note.indexOf("A note.") + 2, line);
  assert.equal(placed.doc, `${note}\n${line}\n`);
  assert.equal(placed.doc.slice(0, placed.doc.lastIndexOf("```")).includes("!["), false);

  const seq = rollsFor("abcdefgh").concat(rollsFor("23456789"));
  let at = 0;
  const named = imageFileName("pic", "png", "![abcdefgh.png](pic/abcdefgh.png)\n", new Set(), () => seq[at++]);
  assert.equal(named.file, "23456789.png");
  assert.equal(named.rel, "pic/23456789.png");
  assert.ok(at > 8);

  const letter = (TICKET_ALPHABET.indexOf("a") + 0.5) / TICKET_ALPHABET.length;
  const same = () => letter;
  assert.equal(allocateImageId(() => true, same), null);
  assert.equal(allocateImageId(() => false, same), "aaaaaaaa");

  assert.equal(imageKind(PNG), "png");
  assert.equal(imageKind(Buffer.from([0xff, 0xd8, 0xff, 0])), "jpg");
  assert.equal(imageKind(Buffer.from("GIF89a")), "gif");
  assert.equal(imageKind(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")])), "webp");
  assert.equal(imageKind(Buffer.from("hello")), null);
  assert.equal(imageKind(Buffer.alloc(0)), null);
  assert.equal(imageKind(Buffer.alloc(MAX_PAYLOAD + 1)), null);
  assert.equal(imageKind(Buffer.alloc(MAX_PAYLOAD)), null);

  assert.equal(assetDirOf("tickets/abcdefgh.md"), "tickets/abcdefgh");
  assert.equal(assetDirOf("notes/welcome.md"), "notes/welcome");
  assert.equal(assetDirOf("notes/welcome.markdown"), "notes/welcome");
  assert.equal(assetDirOf("tickets.md"), null);
  assert.equal(assetDirOf("tickets.markdown"), null);
  assert.equal(assetDirOf("pic"), null);

  const remote = "![remote](https://example.com/a.png)\n\n![local](notes/welcome/abcdefgh.png)\n\n![blob](data:image/png;base64,aaaa)\n\n![web](http://example.com/b.png)\n";
  assert.equal(
    rewriteImageDirs(remote, "notes/welcome", "archive/welcome"),
    "![remote](https://example.com/a.png)\n\n![local](archive/welcome/abcdefgh.png)\n\n![blob](data:image/png;base64,aaaa)\n\n![web](http://example.com/b.png)\n",
  );
  assert.equal(
    rewriteImageDirs("![local](Test Page/abcdefgh.png)\n", "Test Page", "archive/Test Page"),
    "![local](<archive/Test Page/abcdefgh.png>)\n",
  );
  assert.equal(
    rewriteImageDirs("![local](<Test Page/abcdefgh.png>)\n", "Test Page", "archive/Test Page"),
    "![local](<archive/Test Page/abcdefgh.png>)\n",
  );
  assert.equal(
    rewriteImageDirs("![local](plain/abcdefgh.png)\n", "plain", "Old Notes/plain"),
    "![local](<Old Notes/plain/abcdefgh.png>)\n",
  );
  assert.equal(
    rewriteImageDirs("![web](https://example.com/a(b).png)\n![local](Plan (draft)/abcdefgh.png) )\n", "Plan (draft)", "archive/Plan (draft)"),
    "![web](https://example.com/a(b).png)\n![local](<archive/Plan (draft)/abcdefgh.png>) )\n",
  );
  assert.equal(
    rewriteImageDirs("![local](Plan\t(draft)/abcdefgh.png)\n", "Plan\t(draft)", "box"),
    "![local](box/abcdefgh.png)\n",
  );
  assert.equal(
    rewriteImageDirs("Type `![alt](` and then the address.\n\n![abcdefgh.png](span/abcdefgh.png)\n", "span", "archive/span"),
    "Type `![alt](` and then the address.\n\n![abcdefgh.png](archive/span/abcdefgh.png)\n",
  );
  assert.equal(
    rewriteImageDirs("```\n![alt](\n```\n\n![abcdefgh.png](<My Notes/abcdefgh.png>)\n", "My Notes", "archive/My Notes"),
    "```\n![alt](\n```\n\n![abcdefgh.png](<archive/My Notes/abcdefgh.png>)\n",
  );
  assert.equal(imageLineFor("My Notes", "abcdefgh.png"), "![abcdefgh.png](<My Notes/abcdefgh.png>)");
  assert.equal(imageLineFor("Tab\there", "abcdefgh.png"), "![abcdefgh.png](<Tab\there/abcdefgh.png>)");
  assert.equal(imageLineFor("Plan (draft)", "abcdefgh.png"), "![abcdefgh.png](<Plan (draft)/abcdefgh.png>)");
  assert.equal(imageLineFor("Plan)", "abcdefgh.png"), "![abcdefgh.png](<Plan)/abcdefgh.png>)");
  assert.equal(imageLineFor("a\\b", "abcdefgh.png"), "![abcdefgh.png](<a\\\\b/abcdefgh.png>)");
  assert.equal(imageLineFor("plain", "abcdefgh.png"), "![abcdefgh.png](plain/abcdefgh.png)");
  assert.equal(imageLineFor("sub/deep", "abcdefgh.png"), "![abcdefgh.png](sub/deep/abcdefgh.png)");
  assert.equal(imageLineFor("a%20b", "abcdefgh.png"), "![abcdefgh.png](a%20b/abcdefgh.png)");
  assert.equal(imageLineFor("a#b", "abcdefgh.png"), "![abcdefgh.png](a#b/abcdefgh.png)");
  let bracketAt = 0;
  const bracketSeq = rollsFor("abcdefgh").concat(rollsFor("23456789"));
  const bracketed = imageFileName("My Notes", "png", "![abcdefgh.png](<My Notes/abcdefgh.png>)\n", new Set(), () => bracketSeq[bracketAt++]);
  assert.equal(bracketed.file, "23456789.png");
  assert.equal(bracketed.rel, "My Notes/23456789.png");
});

test("picture: a PNG attach is its own paragraph and GET /raw returns the bytes", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "pic.md"), "alpha beta\n");
    const ada = await hello(port, "Ada");
    const wit = await hello(port, "Wit");
    try {
      await openDoc(wit, "Wit", "pic.md");
      const attached = await attachBytes(ada, "Ada", "pic.md", PNG, { cursor: 8 });
      const name = imageFile(attached.file.text, "pic", "png");
      const line = `![${name}](pic/${name})`;
      assert.equal(attached.file.text, `alpha beta\n\n${line}\n`);
      assert.equal(attached.doc.text, attached.file.text);
      assert.equal(attached.doc.inserted.includes(line), true);
      assert.equal(JSON.stringify(attached.doc).includes(PNG.toString("base64")), false);
      assert.equal(attached.file.cursor, attached.file.text.length);
      assert.equal(attached.file.anchor, attached.file.text.length);
      assert.ok(plan(attached.file.text, attached.file.cursor).atoms.some((atom) => atom.type === "image" && atom.alt === name));
      assert.equal(await readDoc(dir, "pic.md"), attached.file.text);
      assert.ok((await fs.readFile(path.join(dir, "pic", name))).equals(PNG));

      const seen = await wit.next((msg) => msg.type === "doc" && msg.path === "pic.md");
      assert.equal(seen.text, attached.file.text);
      assert.equal(seen.inserted.includes(line), true);
      assert.equal(JSON.stringify(seen).includes(PNG.toString("base64")), false);

      const raw = await getRaw(port, `/raw/docs/pic/${name}`);
      assert.equal(raw.status, 200);
      assert.equal(raw.type, "image/png");
      assert.ok(raw.body.equals(PNG));

      ada.send({ type: "list", username: "Ada" });
      const docs = await ada.next((msg) => msg.type === "docs");
      assert.ok(docs.files.includes("pic.md"));
      assert.equal(docs.files.some((file) => file === "pic" || file.startsWith("pic/")), false);
      ada.send({ type: "open", username: "Ada", path: "pic" });
      const missing = await ada.next((msg) => (msg.type === "error" && msg.status === 404) || (msg.type === "file" && msg.path === "pic"));
      assert.equal(missing.type, "error");

      const again = await attachBytes(ada, "Ada", "pic.md", PNG, { cursor: 8 });
      const names = imageFiles(again.file.text, "pic", "png");
      assert.equal(names.length, 2);
      assert.ok(names.includes(name));
      const second = names.find((file) => file !== name);
      assert.ok(second);
      assert.equal(again.file.text.startsWith("alpha beta\n"), true);
      assert.ok((await fs.readFile(path.join(dir, "pic", second))).equals(PNG));

      const samples = [
        { ext: "jpg", type: "image/jpeg", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]) },
        { ext: "gif", type: "image/gif", bytes: Buffer.concat([Buffer.from("GIF89a"), Buffer.from([0, 0])]) },
        { ext: "webp", type: "image/webp", bytes: Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]) },
      ];
      for (const sample of samples) {
        const rel = `${sample.ext}.md`;
        await fs.writeFile(path.join(dir, rel), "alpha beta\n");
        const done = await attachBytes(ada, "Ada", rel, sample.bytes, { cursor: 8 });
        const file = imageFile(done.file.text, sample.ext, sample.ext);
        assert.equal(done.file.text, `alpha beta\n\n![${file}](${sample.ext}/${file})\n`);
        const body = await getRaw(port, `/raw/docs/${sample.ext}/${file}`);
        assert.equal(body.status, 200);
        assert.equal(body.type, sample.type);
        assert.ok(body.body.equals(sample.bytes));
      }
    } finally {
      ada.ws.close();
      wit.ws.close();
    }
  });
});

test("picture: a non-image and one byte over 2 MiB write nothing", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "pic.md"), "alpha beta\n");
    const ada = await hello(port, "Ada");
    try {
      ada.send({ type: "attach", username: "Ada", path: "missing.md" });
      sendBytes(ada, PNG);
      const missing = await ada.next((msg) => msg.type === "error" || msg.type === "doc");
      assert.equal(missing.type, "error");
      assert.equal(missing.status, 404);
      assert.equal(await readDoc(dir, "pic.md"), "alpha beta\n");

      const empty = await attachBytes(ada, "Ada", "pic.md", Buffer.alloc(0), { cursor: 8 });
      assert.equal(empty.status, 400);
      assert.equal(empty.reason, "empty image");
      const text = await attachBytes(ada, "Ada", "pic.md", Buffer.from("not an image"), { cursor: 8 });
      assert.equal(text.status, 400);
      assert.equal(text.reason, "not an image");
      const nowhere = await attachBytes(ada, "Ada", "pic.md", PNG);
      assert.equal(nowhere.status, 400);
      assert.equal(await readDoc(dir, "pic.md"), "alpha beta\n");
      await assert.rejects(fs.lstat(path.join(dir, "pic")), (err) => err.code === "ENOENT");
    } finally {
      ada.ws.close();
    }

    const huge = await hello(port, "Ada");
    const until = closed(huge.ws);
    huge.ws.addEventListener("error", () => {});
    const over = Buffer.alloc(MAX_PAYLOAD + 1);
    PNG.copy(over, 0);
    huge.send({ type: "attach", username: "Ada", path: "pic.md", cursor: 8 });
    sendBytes(huge, over);
    await Promise.race([
      until,
      delay(5000).then(() => {
        throw new Error("oversized frame left the socket open");
      }),
    ]);
    assert.equal(await readDoc(dir, "pic.md"), "alpha beta\n");
    await assert.rejects(fs.lstat(path.join(dir, "pic")), (err) => err.code === "ENOENT");
  });
});

test("picture: exactly 2 MiB is kept", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "pic.md"), "alpha beta\n");
    const bytes = Buffer.alloc(MAX_PAYLOAD);
    PNG.copy(bytes, 0);
    const ada = await hello(port, "Ada");
    try {
      const attached = await attachBytes(ada, "Ada", "pic.md", bytes, { cursor: 8 }, 20000);
      const name = imageFile(attached.file.text, "pic", "png");
      assert.notEqual(name, "");
      assert.equal(attached.file.text, `alpha beta\n\n![${name}](pic/${name})\n`);
      const raw = await getRaw(port, `/raw/docs/pic/${name}`);
      assert.equal(raw.status, 200);
      assert.equal(raw.type, "image/png");
      assert.equal(raw.body.length, MAX_PAYLOAD);
      assert.ok(raw.body.equals(bytes));
    } finally {
      ada.ws.close();
    }
  });
});

test("picture: a held span names that user and writes nothing", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "pic.md"), "alpha beta\n");
    const bea = await hello(port, "Bea");
    const ada = await hello(port, "Ada");
    try {
      const opened = await openDoc(bea, "Bea", "pic.md");
      await syncLock(bea, [], "Bea", "pic.md", 0, opened.rev);
      const refused = await attachBytes(ada, "Ada", "pic.md", PNG, { cursor: 0 });
      assert.equal(refused.status, 409);
      assert.equal(refused.heldBy, "Bea");
      assert.equal(await readDoc(dir, "pic.md"), "alpha beta\n");
      await assert.rejects(fs.lstat(path.join(dir, "pic")), (err) => err.code === "ENOENT");
    } finally {
      ada.ws.close();
      bea.ws.close();
    }
  });
});

test("picture: undo restores the line and the last close drops an unreferenced file", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "pic.md"), "alpha beta\n");
    const ada = await hello(port, "Ada");
    try {
      const attached = await attachBytes(ada, "Ada", "pic.md", PNG, { cursor: 8 });
      const name = imageFile(attached.file.text, "pic", "png");
      const full = path.join(dir, "pic", name);
      ada.send({ type: "undo", username: "Ada", path: "pic.md", rev: attached.file.rev });
      const undone = await takeDoc(ada);
      assert.equal(undone.text, "alpha beta\n");
      assert.ok((await fs.readFile(full)).equals(PNG));
      ada.send({ type: "redo", username: "Ada", path: "pic.md", rev: undone.rev });
      const redone = await takeDoc(ada);
      assert.equal(redone.text, attached.file.text);
      assert.ok((await fs.readFile(full)).equals(PNG));

      const extra = await attachBytes(ada, "Ada", "pic.md", PNG, { cursor: 8 });
      const kept = imageFiles(extra.file.text, "pic", "png").find((file) => file !== name);
      assert.ok(kept);
      const keptFull = path.join(dir, "pic", kept);
      const start = extra.file.text.indexOf(`![${name}]`);
      const end = extra.file.text.indexOf("\n", start) + 1;
      ada.send({
        type: "edit",
        username: "Ada",
        path: "pic.md",
        rev: extra.file.rev,
        anchor: start,
        cursor: end,
        op: "delete",
      });
      const removed = await takeDoc(ada);
      assert.equal(removed.text.includes(`![${name}]`), false);
      assert.equal(removed.text.includes(`![${kept}]`), true);
      assert.ok((await fs.readFile(full)).equals(PNG));
      ada.send({ type: "undo", username: "Ada", path: "pic.md", rev: removed.rev });
      const back = await takeDoc(ada);
      assert.equal(back.text.includes(`![${name}]`), true);
      assert.ok((await fs.readFile(full)).equals(PNG));
      const again = back.text.indexOf(`![${name}]`);
      ada.send({
        type: "edit",
        username: "Ada",
        path: "pic.md",
        rev: back.rev,
        anchor: again,
        cursor: back.text.indexOf("\n", again) + 1,
        op: "delete",
      });
      const gone = await takeDoc(ada);
      assert.equal(gone.text.includes(`![${name}]`), false);

      const bea = await hello(port, "Bea");
      try {
        await openDoc(bea, "Bea", "pic.md");
        await waitClosed(ada.ws);
        await stays(full);
        await stays(keptFull);
      } finally {
        await waitClosed(bea.ws);
      }
      await waitAbsent(full);
      assert.ok((await fs.readFile(keptFull)).equals(PNG));
    } finally {
      ada.ws.close();
    }
  });
});

test("picture: a title change does not move the file, and a move rewrites that document", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.mkdir(path.join(dir, "notes"), { recursive: true });
    await fs.mkdir(path.join(dir, "archive"), { recursive: true });
    await fs.writeFile(path.join(dir, "archive", "keep.md"), "keep\n");
    await fs.writeFile(path.join(dir, "titled.md"), "# Old title\n\nbody\n");
    await fs.writeFile(
      path.join(dir, "notes", "welcome.md"),
      "alpha beta\n\n![remote](https://example.com/a.png)\n\n![blob](data:image/png;base64,aaaa)\n",
    );
    await fs.writeFile(path.join(dir, "notes", "plain.md"), "plain\n");
    await fs.mkdir(path.join(dir, "archive", "plain"));
    await fs.mkdir(path.join(dir, "archive", "welcome"));
    const ada = await hello(port, "Ada");
    try {
      const titled = await attachBytes(ada, "Ada", "titled.md", PNG, { cursor: 2 });
      const titledName = imageFile(titled.file.text, "titled", "png");
      const titledFull = path.join(dir, "titled", titledName);
      ada.send({
        type: "edit",
        username: "Ada",
        path: "titled.md",
        rev: titled.file.rev,
        anchor: 2,
        cursor: 5,
        op: "insert",
        text: "New",
      });
      const renamed = await takeDoc(ada);
      assert.match(renamed.text, /^# New title\n/);
      assert.equal(renamed.text.includes(`titled/${titledName}`), true);
      assert.ok((await fs.readFile(titledFull)).equals(PNG));

      ada.send({ type: "move", username: "Ada", path: "notes/plain.md", dir: "archive" });
      const plain = await ada.next((msg) => msg.type === "moved" || msg.type === "error");
      assert.equal(plain.type, "error");
      assert.equal(plain.status, 409);
      assert.equal(await readDoc(dir, "notes/plain.md"), "plain\n");
      assert.equal((await fs.lstat(path.join(dir, "archive", "plain"))).isDirectory(), true);

      const welcome = await attachBytes(ada, "Ada", "notes/welcome.md", PNG, { cursor: 8 });
      const name = imageFile(welcome.file.text, "notes/welcome", "png");
      assert.equal(welcome.file.text.includes("https://example.com/a.png"), true);
      assert.equal(welcome.file.text.includes("data:image/png;base64,aaaa"), true);
      assert.equal(welcome.file.text.startsWith(`alpha beta\n\n![${name}](notes/welcome/${name})\n`), true);
      const from = path.join(dir, "notes", "welcome", name);
      ada.send({ type: "move", username: "Ada", path: "notes/welcome.md", dir: "archive" });
      const blocked = await ada.next((msg) => msg.type === "moved" || msg.type === "error");
      assert.equal(blocked.status, 409);
      assert.equal(await readDoc(dir, "notes/welcome.md"), welcome.file.text);
      assert.ok((await fs.readFile(from)).equals(PNG));
      assert.equal((await fs.lstat(path.join(dir, "archive", "welcome"))).isDirectory(), true);

      await fs.rm(path.join(dir, "archive", "welcome"), { recursive: true });
      ada.send({ type: "move", username: "Ada", path: "notes/welcome.md", dir: "archive" });
      const moved = await ada.next((msg) => msg.type === "moved" || msg.type === "error");
      assert.equal(moved.type, "moved");
      const next = await readDoc(dir, "archive/welcome.md");
      assert.equal(next.includes(`archive/welcome/${name}`), true);
      assert.equal(next.includes("notes/welcome/"), false);
      assert.equal(next.includes("https://example.com/a.png"), true);
      assert.equal(next.includes("data:image/png;base64,aaaa"), true);
      assert.ok((await fs.readFile(path.join(dir, "archive", "welcome", name))).equals(PNG));
      await assert.rejects(fs.lstat(path.join(dir, "notes", "welcome.md")), (err) => err.code === "ENOENT");
      await assert.rejects(fs.lstat(path.join(dir, "notes", "welcome")), (err) => err.code === "ENOENT");

      await fs.mkdir(path.join(dir, "notes", "nested"), { recursive: true });
      await fs.writeFile(path.join(dir, "notes", "nested", "leaf.md"), "leaf\n");
      const leaf = await attachBytes(ada, "Ada", "notes/nested/leaf.md", PNG, { cursor: 0 });
      const leafName = imageFile(leaf.file.text, "notes/nested/leaf", "png");
      ada.send({ type: "move", username: "Ada", path: "notes/nested", dir: "archive" });
      const tree = await ada.next((msg) => msg.type === "moved" || msg.type === "error");
      assert.equal(tree.type, "moved");
      const leafText = await readDoc(dir, "archive/nested/leaf.md");
      assert.equal(leafText.includes(`archive/nested/leaf/${leafName}`), true);
      assert.ok((await fs.readFile(path.join(dir, "archive", "nested", "leaf", leafName))).equals(PNG));
    } finally {
      ada.ws.close();
    }
  });
});

test("picture: deleting the document or the ticket removes the directory", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "pic.md"), "alpha beta\n");
    const ada = await hello(port, "Ada");
    const bea = await hello(port, "Bea");
    try {
      const attached = await attachBytes(ada, "Ada", "pic.md", PNG, { cursor: 8 });
      const name = imageFile(attached.file.text, "pic", "png");
      const full = path.join(dir, "pic", name);
      await openDoc(bea, "Bea", "pic.md");
      ada.send({ type: "delete", username: "Ada", path: "pic.md" });
      const held = await ada.next((msg) => msg.type === "deleted" || msg.type === "error");
      assert.equal(held.status, 409);
      assert.equal(held.heldBy, "Bea");
      assert.equal(await readDoc(dir, "pic.md"), attached.file.text);
      assert.ok((await fs.readFile(full)).equals(PNG));
      await waitClosed(bea.ws);
      let deleted;
      for (let i = 0; i < 20; i += 1) {
        ada.send({ type: "delete", username: "Ada", path: "pic.md" });
        deleted = await ada.next((msg) => msg.type === "deleted" || msg.type === "error");
        if (deleted.type === "deleted") break;
        await delay(25);
      }
      assert.equal(deleted.type, "deleted");
      assert.equal(deleted.path, "pic.md");
      await assert.rejects(fs.lstat(path.join(dir, "pic.md")), (err) => err.code === "ENOENT");
      await assert.rejects(fs.lstat(full), (err) => err.code === "ENOENT");

      const made = await createTicket(ada, "Ada", "Picture", undefined, undefined, "alpha beta\n");
      const rel = made.file.path;
      const id = made.file.ticket.id;
      const shot = await attachBytes(ada, "Ada", rel, PNG, { cursor: 8 });
      const shotName = imageFile(shot.file.text, `tickets/${id}`, "png");
      const shotFull = path.join(dir, "tickets", id, shotName);
      ada.send({ type: "ticket.set", username: "Ada", path: rel, title: "Renamed" });
      await ada.next((msg) => msg.type === "tickets");
      const titled = await ada.next((msg) => msg.type === "ticket" && msg.path === rel);
      assert.equal(titled.title, "Renamed");
      assert.ok((await fs.readFile(shotFull)).equals(PNG));
      const stored = parseTicket(id, await fs.readFile(path.join(dir, rel), "utf8"));
      assert.equal(stored.title, "Renamed");
      assert.equal(stored.body.includes(`tickets/${id}/${shotName}`), true);
      ada.send({ type: "ticket.set", username: "Ada", path: rel, state: "closed" });
      await ada.next((msg) => msg.type === "tickets");
      await ada.next((msg) => msg.type === "ticket" && msg.path === rel && msg.state === "closed");
      ada.send({ type: "ticket.purge", username: "Ada" });
      const left = await ada.next((msg) => msg.type === "tickets");
      assert.equal(left.tickets.some((ticket) => ticket.id === id), false);
      await assert.rejects(fs.lstat(path.join(dir, rel)), (err) => err.code === "ENOENT");
      await assert.rejects(fs.lstat(shotFull), (err) => err.code === "ENOENT");

      const other = await createTicket(ada, "Ada", "Gone", undefined, undefined, "alpha beta\n");
      const otherRel = other.file.path;
      const otherId = other.file.ticket.id;
      const otherShot = await attachBytes(ada, "Ada", otherRel, PNG, { cursor: 8 });
      const otherName = imageFile(otherShot.file.text, `tickets/${otherId}`, "png");
      ada.send({ type: "ticket.delete", username: "Ada", id: otherId });
      const removed = await ada.next((msg) => msg.type === "deleted" || msg.type === "error");
      assert.equal(removed.type, "deleted");
      assert.equal(removed.path, otherRel);
      await assert.rejects(fs.lstat(path.join(dir, otherRel)), (err) => err.code === "ENOENT");
      await assert.rejects(fs.lstat(path.join(dir, "tickets", otherId, otherName)), (err) => err.code === "ENOENT");
    } finally {
      ada.ws.close();
      bea.ws.close();
    }
  });
});

test("UR.1", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "a.md"), "alpha\n");
    const a = await hello(port, "A");
    const b = await hello(port, "B");
    try {
      let rev = (await openDoc(a, "A", "a.md")).rev;
      await openDoc(b, "B", "a.md");
      await syncLock(a, [b], "A", "a.md", 5, rev);
      a.send({ type: "edit", username: "A", path: "a.md", rev, op: "insert", text: "x", anchor: 5, cursor: 5 });
      let doc = await takeDoc(a);
      let seen = await takeDoc(b);
      rev = doc.rev;
      assert.equal(doc.text, "alphax\n");
      assert.equal(seen.text, "alphax\n");
      a.send({ type: "edit", username: "A", path: "a.md", rev, op: "insert", text: "y", anchor: 6, cursor: 6, group: true });
      doc = await takeDoc(a);
      seen = await takeDoc(b);
      rev = doc.rev;
      assert.equal(doc.text, "alphaxy\n");
      assert.equal(seen.text, "alphaxy\n");
      assert.equal(doc.cursor, 7);
      a.send({ type: "undo", username: "A", path: "a.md", rev });
      doc = await takeDoc(a);
      seen = await takeDoc(b);
      rev = doc.rev;
      assert.equal(doc.text, "alpha\n");
      assert.equal(doc.cursor, 5);
      assert.equal(doc.anchor, 5);
      assert.equal(seen.text, "alpha\n");
      a.send({ type: "undo", username: "A", path: "a.md", rev });
      assert.equal((await a.next((msg) => msg.type === "noop" || msg.type === "error" || msg.type === "doc")).type, "noop");
      assert.equal(await readDoc(dir, "a.md"), "alpha\n");
    } finally {
      a.ws.close();
      b.ws.close();
    }
  });
});

test("UR.g.1", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "a.md"), "alpha\n");
    const a = await hello(port, "A");
    try {
      let rev = (await openDoc(a, "A", "a.md")).rev;
      await syncLock(a, [], "A", "a.md", 5, rev);
      for (const text of ["x", "y", "z"]) {
        const cursor = "alpha".length + (text === "x" ? 0 : text === "y" ? 1 : 2);
        a.send({
          type: "edit",
          username: "A",
          path: "a.md",
          rev,
          op: "insert",
          text,
          anchor: cursor,
          cursor,
          ...(text === "x" ? {} : { group: true }),
        });
        const doc = await takeDoc(a);
        rev = doc.rev;
      }
      a.send({ type: "undo", username: "A", path: "a.md", rev });
      const doc = await takeDoc(a);
      assert.equal(doc.text, "alpha\n");
      assert.equal(doc.cursor, 5);
      assert.equal(doc.anchor, 5);
      assert.equal(await readDoc(dir, "a.md"), "alpha\n");
    } finally {
      a.ws.close();
    }
  });
});

test("UR.g.4", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "a.md"), "alpha\n");
    const a = await hello(port, "A");
    try {
      let rev = (await openDoc(a, "A", "a.md")).rev;
      await syncLock(a, [], "A", "a.md", 5, rev);
      for (const text of ["x", "y", "z"]) {
        const cursor = 5 + (text === "x" ? 0 : text === "y" ? 1 : 2);
        a.send({
          type: "edit",
          username: "A",
          path: "a.md",
          rev,
          op: "insert",
          text,
          anchor: cursor,
          cursor,
          ...(text === "x" ? {} : { group: true }),
        });
        rev = (await takeDoc(a)).rev;
      }
      a.send({ type: "undo", username: "A", path: "a.md", rev });
      let doc = await takeDoc(a);
      rev = doc.rev;
      assert.equal(doc.text, "alpha\n");
      a.send({ type: "redo", username: "A", path: "a.md", rev });
      doc = await takeDoc(a);
      assert.equal(doc.text, "alphaxyz\n");
      assert.equal(doc.cursor, 8);
      assert.equal(doc.anchor, 8);
      assert.equal(await readDoc(dir, "a.md"), "alphaxyz\n");
    } finally {
      a.ws.close();
    }
  });
});

test("UR.g.5", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "a.md"), "alpha\n");
    const a = await hello(port, "A");
    try {
      let rev = (await openDoc(a, "A", "a.md")).rev;
      await syncLock(a, [], "A", "a.md", 2, rev, 4);
      a.send({ type: "edit", username: "A", path: "a.md", rev, op: "insert", text: "x", anchor: 2, cursor: 4 });
      let doc = await takeDoc(a);
      rev = doc.rev;
      assert.equal(doc.text, "alxa\n");
      a.send({ type: "edit", username: "A", path: "a.md", rev, op: "insert", text: "y", anchor: 3, cursor: 3, group: true });
      doc = await takeDoc(a);
      rev = doc.rev;
      assert.equal(doc.text, "alxya\n");
      assert.equal(doc.cursor, 4);
      a.send({ type: "undo", username: "A", path: "a.md", rev });
      doc = await takeDoc(a);
      rev = doc.rev;
      assert.equal(doc.text, "alpha\n");
      assert.equal(doc.anchor, 2);
      assert.equal(doc.cursor, 4);
      a.send({ type: "redo", username: "A", path: "a.md", rev });
      doc = await takeDoc(a);
      assert.equal(doc.text, "alxya\n");
      assert.equal(doc.cursor, 4);
      assert.equal(doc.anchor, 4);
      assert.equal(await readDoc(dir, "a.md"), "alxya\n");
    } finally {
      a.ws.close();
    }
  });
});

test("UR.g a grouped insert that is not an append folds into the open entry", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "a.md"), "alpha\n");
    const a = await hello(port, "A");
    try {
      let rev = (await openDoc(a, "A", "a.md")).rev;
      await syncLock(a, [], "A", "a.md", 5, rev);
      a.send({ type: "edit", username: "A", path: "a.md", rev, op: "insert", text: "x", anchor: 5, cursor: 5 });
      let doc = await takeDoc(a);
      rev = doc.rev;
      a.send({ type: "edit", username: "A", path: "a.md", rev, op: "insert", text: "y", anchor: 6, cursor: 6, group: true });
      doc = await takeDoc(a);
      rev = doc.rev;
      a.send({ type: "edit", username: "A", path: "a.md", rev, op: "insert", text: "z", anchor: 6, cursor: 6, group: true });
      doc = await takeDoc(a);
      rev = doc.rev;
      assert.equal(doc.text, "alphaxzy\n");
      a.send({ type: "undo", username: "A", path: "a.md", rev });
      doc = await takeDoc(a);
      rev = doc.rev;
      assert.equal(doc.text, "alpha\n");
      assert.equal(doc.cursor, 5);
      assert.equal(doc.anchor, 5);
      a.send({ type: "undo", username: "A", path: "a.md", rev });
      assert.equal((await a.next((msg) => msg.type === "noop" || msg.type === "error" || msg.type === "doc")).type, "noop");
      a.send({ type: "redo", username: "A", path: "a.md", rev });
      doc = await takeDoc(a);
      assert.equal(doc.text, "alphaxzy\n");
      assert.equal(await readDoc(dir, "a.md"), "alphaxzy\n");
    } finally {
      a.ws.close();
    }
  });
});

test("a grouped backspace, break, and delete fold into the open entry", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "a.md"), "alpha\n");
    const a = await hello(port, "A");
    try {
      let rev = (await openDoc(a, "A", "a.md")).rev;
      await syncLock(a, [], "A", "a.md", 5, rev);
      a.send({ type: "edit", username: "A", path: "a.md", rev, op: "insert", text: "x", anchor: 5, cursor: 5 });
      let doc = await takeDoc(a);
      rev = doc.rev;
      a.send({ type: "edit", username: "A", path: "a.md", rev, op: "insert", text: "y", anchor: 6, cursor: 6, group: true });
      doc = await takeDoc(a);
      rev = doc.rev;
      a.send({ type: "edit", username: "A", path: "a.md", rev, op: "backspace", anchor: 7, cursor: 7, group: true });
      doc = await takeDoc(a);
      rev = doc.rev;
      assert.equal(doc.text, "alphax\n");
      a.send({ type: "undo", username: "A", path: "a.md", rev });
      doc = await takeDoc(a);
      rev = doc.rev;
      assert.equal(doc.text, "alpha\n");
      assert.equal(doc.cursor, 5);
      a.send({ type: "redo", username: "A", path: "a.md", rev });
      doc = await takeDoc(a);
      rev = doc.rev;
      assert.equal(doc.text, "alphax\n");

      a.send({ type: "edit", username: "A", path: "a.md", rev, op: "insert", text: "\n\n", anchor: doc.cursor, cursor: doc.cursor, group: true });
      doc = await takeDoc(a);
      rev = doc.rev;
      assert.notEqual(doc.text, "alphax\n");
      a.send({ type: "edit", username: "A", path: "a.md", rev, op: "insert", text: "y", anchor: doc.cursor, cursor: doc.cursor, group: true });
      doc = await takeDoc(a);
      rev = doc.rev;
      assert.equal(doc.text.includes("y"), true);
      a.send({ type: "undo", username: "A", path: "a.md", rev });
      doc = await takeDoc(a);
      rev = doc.rev;
      assert.equal(doc.text, "alpha\n");

      await syncLock(a, [], "A", "a.md", 0, rev, 5);
      a.send({ type: "edit", username: "A", path: "a.md", rev, op: "insert", text: "", anchor: 0, cursor: 5 });
      doc = await takeDoc(a);
      rev = doc.rev;
      assert.equal(doc.text, "\n");
      a.send({ type: "edit", username: "A", path: "a.md", rev, op: "insert", text: "z", anchor: 0, cursor: 0, group: true });
      doc = await takeDoc(a);
      rev = doc.rev;
      assert.equal(doc.text, "z\n");
      a.send({ type: "undo", username: "A", path: "a.md", rev });
      doc = await takeDoc(a);
      assert.equal(doc.text, "alpha\n");
      assert.equal(doc.cursor, 5);
      assert.equal(doc.anchor, 0);
      assert.equal(await readDoc(dir, "a.md"), "alpha\n");
    } finally {
      a.ws.close();
    }
  });
});

test("UR.g text another session wrote inside the run stays", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "a.md"), "alpha\n\nbeta\n");
    const a = await hello(port, "A");
    const b = await hello(port, "B");
    try {
      let rev = (await openDoc(a, "A", "a.md")).rev;
      await openDoc(b, "B", "a.md");
      await syncLock(a, [b], "A", "a.md", 5, rev);
      a.send({ type: "edit", username: "A", path: "a.md", rev, op: "insert", text: "x", anchor: 5, cursor: 5 });
      let doc = await takeDoc(a);
      await takeDoc(b);
      rev = doc.rev;
      a.send({ type: "edit", username: "A", path: "a.md", rev, op: "insert", text: "y", anchor: 6, cursor: 6, group: true });
      doc = await takeDoc(a);
      await takeDoc(b);
      rev = doc.rev;
      assert.equal(doc.text, "alphaxy\n\nbeta\n");
      const gap = doc.text.indexOf("\n\n") + 1;
      await syncLock(a, [b], "A", "a.md", gap, rev);
      await syncLock(b, [a], "B", "a.md", 0, rev);
      b.send({ type: "edit", username: "B", path: "a.md", rev, op: "insert", text: "Z", anchor: 0, cursor: 0 });
      doc = await takeDoc(b);
      await takeDoc(a);
      rev = doc.rev;
      assert.equal(doc.text, "Zalphaxy\n\nbeta\n");
      await syncLock(b, [a], "B", "a.md", doc.text.indexOf("beta"), rev);
      a.send({ type: "undo", username: "A", path: "a.md", rev });
      doc = await takeDoc(a);
      await takeDoc(b);
      assert.equal(doc.text, "Zalpha\n\nbeta\n");
      assert.equal(doc.cursor, 6);
      assert.equal(doc.anchor, 6);
      assert.equal(await readDoc(dir, "a.md"), doc.text);
    } finally {
      a.ws.close();
      b.ws.close();
    }
  });
});

test("UR.g text another session inserted between typed characters stays", async () => {
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "a.md"), "alpha\n\nbeta\n");
    const a = await hello(port, "A");
    const b = await hello(port, "B");
    try {
      let rev = (await openDoc(a, "A", "a.md")).rev;
      await openDoc(b, "B", "a.md");
      await syncLock(a, [b], "A", "a.md", 5, rev);
      a.send({ type: "edit", username: "A", path: "a.md", rev, op: "insert", text: "x", anchor: 5, cursor: 5 });
      let doc = await takeDoc(a);
      await takeDoc(b);
      rev = doc.rev;
      a.send({ type: "edit", username: "A", path: "a.md", rev, op: "insert", text: "y", anchor: 6, cursor: 6, group: true });
      doc = await takeDoc(a);
      await takeDoc(b);
      rev = doc.rev;
      const gap = doc.text.indexOf("\n\n") + 1;
      await syncLock(a, [b], "A", "a.md", gap, rev);
      await syncLock(b, [a], "B", "a.md", 6, rev);
      b.send({ type: "edit", username: "B", path: "a.md", rev, op: "insert", text: "Z", anchor: 6, cursor: 6 });
      doc = await takeDoc(b);
      await takeDoc(a);
      rev = doc.rev;
      assert.equal(doc.text, "alphaxZy\n\nbeta\n");
      await syncLock(b, [a], "B", "a.md", doc.text.indexOf("beta"), rev);
      a.send({ type: "undo", username: "A", path: "a.md", rev });
      doc = await takeDoc(a);
      await takeDoc(b);
      rev = doc.rev;
      assert.equal(doc.text, "alphaZ\n\nbeta\n");
      assert.equal(doc.cursor, 5);
      assert.equal(doc.anchor, 5);
      a.send({ type: "redo", username: "A", path: "a.md", rev });
      doc = await takeDoc(a);
      await takeDoc(b);
      assert.equal(doc.text, "alphaxZy\n\nbeta\n");
      assert.equal(doc.cursor, 8);
      assert.equal(doc.anchor, 8);
      assert.equal(await readDoc(dir, "a.md"), doc.text);
    } finally {
      a.ws.close();
      b.ws.close();
    }
  });
});

test("picture: a comment note stays text", async () => {
  await withDocs(async ({ port, dir }) => {
    const note = "Hello\n\n```comment c1\n:: 0\n@2026-10-05T16:00:00.000Z Ada\nA note.\n```\n";
    await fs.writeFile(path.join(dir, "noted.md"), note);
    const ada = await hello(port, "Ada");
    try {
      const attached = await attachBytes(ada, "Ada", "noted.md", PNG, { cursor: note.indexOf("A note.") + 2 });
      const name = imageFile(attached.file.text, "noted", "png");
      assert.equal(attached.file.text, `${note}\n![${name}](noted/${name})\n`);
      assert.equal(attached.file.text.slice(0, attached.file.text.lastIndexOf("```")).includes("!["), false);
      assert.equal(attached.file.text.includes("A note."), true);
      assert.ok((await fs.readFile(path.join(dir, "noted", name))).equals(PNG));
    } finally {
      ada.ws.close();
    }
  });
});

test("T-ticket-cross-repo", async () => {
  const A = "aaaaaaaa";
  const B = "bbbbbbbb";
  const C = "cccccccc";
  const D = "dddddddd";
  const F = "ffffffff";
  const G = "gggggggg";
  const H = "hhhhhhhh";
  const K = "k2n4p7qa";
  const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-other-"));
  const mineDir = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-mine-"));
  const ghostDir = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-ghost-"));
  try {
    await withDocs(async ({ port, dir }) => {
      await registerRepo(port, "other", "Other", otherDir);
      await registerRepo(port, "my_repo-2", "Mine", mineDir);
      const stamp = (n) => `2026-03-01T00:00:0${n}.000Z`;
      await writeTicket(dir, { id: A, title: "Alpha", state: "new", created: stamp(1), body: "alpha\n" });
      await writeTicket(dir, { id: B, title: "Bravo", state: "new", created: stamp(2), body: "bravo\n" });
      await writeTicket(dir, {
        id: C,
        title: "Cee",
        state: "new",
        parent: A,
        depends: [`docs:${A}`, `other:${A}`],
        created: stamp(3),
        body: "cee\n",
      });
      await writeTicket(dir, { id: F, title: "Eff", state: "closed", created: stamp(4), body: "eff\n" });
      await writeTicket(dir, {
        id: G,
        title: "Gee",
        state: "new",
        parent: F,
        depends: [`docs:${F}`, `other:${B}`],
        created: stamp(5),
        body: "gee\n",
      });
      await writeTicket(otherDir, { id: B, title: "Other Bravo", state: "new", created: stamp(2), body: "ob\n" });
      await writeTicket(otherDir, {
        id: D,
        title: "Dee",
        state: "new",
        parent: `docs:${A}`,
        depends: [`docs:${A}`],
        created: stamp(3),
        body: "dee\n",
      });
      await writeTicket(otherDir, {
        id: H,
        title: "Aitch",
        state: "new",
        parent: `docs:${F}`,
        created: stamp(4),
        body: "aitch\n",
      });

      const ada = await hello(port, "A");
      const ada2 = await hello(port, "A2");
      const bo = await hello(port, "B", "other");
      const pathOf = (id) => `tickets/${id}.md`;
      const readId = async (root, id) => readDoc(root, pathOf(id));

      function assertInbound(records, expected) {
        for (const row of records) {
          assert.deepEqual(Object.keys(row).sort(), ["depends", "id", "parent", "repo", "title"]);
        }
        assert.deepEqual(records, expected);
      }

      async function expectNoTicketBroadcast(client, username) {
        assert.equal(client.all.some((msg) => msg.type === "tickets" || msg.type === "docs"), false);
        client.send({ type: "list", username });
        const msg = await client.next((item) => item.type === "docs" || item.type === "tickets");
        assert.equal(msg.type, "docs");
        assert.equal(client.all.some((item) => item.type === "tickets"), false);
      }

      async function setResult(client, username, payload) {
        client.send({ type: "ticket.set", username, ...payload });
        return client.next((msg) => msg.type === "tickets" || msg.type === "error" || msg.type === "ticket");
      }

      async function setOk(client, username, payload, peers) {
        const msg = await setResult(client, username, payload);
        assert.equal(msg.type, "tickets");
        assert.ok(Array.isArray(msg.inbound));
        assert.ok(Array.isArray(msg.present));
        assert.ok(Array.isArray(msg.foreign));
        const home = msg.tickets.some((ticket) => ticket.id === C) ? "docs"
          : msg.tickets.some((ticket) => ticket.id === D) ? "other" : "";
        assert.notEqual(home, "");
        for (const row of msg.foreign) {
          assert.deepEqual(Object.keys(row).sort(), ["depends", "id", "parent", "repo", "rev", "title"]);
          assert.equal(typeof row.rev, "number");
          assert.notEqual(row.repo, home);
        }
        for (const ticket of msg.tickets) assertTicketEntry(ticket);
        for (const peer of peers) {
          const copy = await peer.next((item) => item.type === "tickets" || item.type === "error");
          assert.deepEqual(copy, msg);
        }
        return msg;
      }

      async function expectOwnTickets(client, home, ownId, otherRepo, otherId) {
        const msg = await client.next((item) => item.type === "tickets" || item.type === "error");
        assert.equal(msg.type, "tickets");
        assert.equal(msg.tickets.some((ticket) => ticket.id === ownId), true);
        assert.ok(Array.isArray(msg.foreign));
        assert.equal(msg.foreign.some((row) => row.repo === home), false);
        const row = msg.foreign.find((item) => item.repo === otherRepo && item.id === otherId);
        assert.ok(row, `${otherRepo}:${otherId}`);
        assert.deepEqual(Object.keys(row).sort(), ["depends", "id", "parent", "repo", "rev", "title"]);
        assert.equal(typeof row.rev, "number");
        assert.ok(Array.isArray(msg.present));
        return msg;
      }

      // The writer's frame is already taken by setOk. These take the other repo's frame.
      async function docsSaw(otherId) {
        const msg = await expectOwnTickets(ada, "docs", C, "other", otherId);
        assert.deepEqual(await ada2.next((item) => item.type === "tickets" || item.type === "error"), msg);
        return msg;
      }

      async function otherSaw(docsId) {
        return expectOwnTickets(bo, "other", D, "docs", docsId);
      }

      async function setBad(client, username, payload, status, fileRoot, id, peers) {
        const before = await readId(fileRoot, id);
        const msg = await setResult(client, username, payload);
        assert.deepEqual(msg, { type: "error", status });
        assert.equal(await readId(fileRoot, id), before);
        for (const peer of peers) await expectNoTicketBroadcast(peer.client, peer.username);
        return before;
      }

      try {
        const listedMine = await setOk(ada, "A", { path: pathOf(A), parent: `ghost:${K}` }, [ada2]);
        assert.equal(listedMine.tickets.find((ticket) => ticket.id === A).parent, `ghost:${K}`);
        assert.equal(listedMine.tickets.some((ticket) => ticket.id === D), false);
        const ghostParent = await readId(dir, A);
        assert.match(ghostParent, /^parent: ghost:k2n4p7qa$/m);
        assert.equal(ghostParent.includes(`docs:${K}`), false);
        const ghostFrame = await otherSaw(A);
        assert.notDeepEqual(ghostFrame, listedMine);
        assert.equal(ghostFrame.foreign.find((row) => row.repo === "docs" && row.id === A).parent, `ghost:${K}`);

        await setBad(ada, "A", { path: pathOf(A), depends: [`my_repo-2:${K}`] }, 409, dir, A, [
          { client: ada2, username: "A2" },
          { client: bo, username: "B" },
        ]);
        await setBad(ada, "A", { path: pathOf(A), parent: `other:${K}` }, 409, dir, A, [
          { client: ada2, username: "A2" },
          { client: bo, username: "B" },
        ]);
        assert.equal(await readId(dir, A), ghostParent);

        await registerRepo(port, "ghost", "Ghost", ghostDir);
        for (const client of [ada, ada2, bo]) {
          const repos = await client.next((msg) => msg.type === "repos");
          const names = repos.repos.map((repo) => repo.name);
          assert.equal(names.includes("my_repo-2"), true);
          assert.equal(names.includes("ghost"), true);
          assert.equal(names.includes("bad:name"), false);
        }

        const renamed = await setOk(ada, "A", { path: pathOf(A), title: "Renamed" }, [ada2]);
        assert.equal(renamed.tickets.find((ticket) => ticket.id === A).title, "Renamed");
        assert.equal(renamed.tickets.find((ticket) => ticket.id === A).parent, "");
        assert.equal(renamed.present.includes(`docs:${A}`), true);
        assert.equal(renamed.present.includes(`other:${B}`), true);
        assert.equal(renamed.present.includes(`ghost:${K}`), false);
        const renamedDisk = parseTicket(A, await readId(dir, A));
        assert.equal(renamedDisk.title, "Renamed");
        assert.equal(renamedDisk.parent, "");
        const renamedOther = await otherSaw(A);
        assert.notDeepEqual(renamedOther, renamed);
        assert.equal(renamedOther.foreign.find((row) => row.repo === "docs" && row.id === A).title, "Renamed");
        assert.equal(renamedOther.foreign.find((row) => row.repo === "docs" && row.id === A).parent, "");

        await setBad(ada, "A", { path: pathOf(A), parent: `other:${K}` }, 409, dir, A, [
          { client: ada2, username: "A2" },
          { client: bo, username: "B" },
        ]);
        assert.equal(parseTicket(A, await readId(dir, A)).parent, "");

        for (const parent of ["other:", `:${K}`, `other:${K}:x`, `other :${K}`, "other:k2n4p7q", "other:iiiiiiii", `_repo:${A}`, `${"n".repeat(65)}:${A}`]) {
          await setBad(ada, "A", { path: pathOf(A), parent }, 400, dir, A, [
            { client: ada2, username: "A2" },
            { client: bo, username: "B" },
          ]);
        }
        await setBad(ada, "A", { path: pathOf(A), depends: [B, "other:"] }, 400, dir, A, [
          { client: ada2, username: "A2" },
          { client: bo, username: "B" },
        ]);

        for (const parent of [A, `docs:${A}`]) {
          await setBad(ada, "A", { path: pathOf(A), parent }, 409, dir, A, [
            { client: ada2, username: "A2" },
            { client: bo, username: "B" },
          ]);
        }
        for (const depends of [[A], [`docs:${A}`]]) {
          await setBad(ada, "A", { path: pathOf(A), depends }, 409, dir, A, [
            { client: ada2, username: "A2" },
            { client: bo, username: "B" },
          ]);
        }

        const bare = await setOk(ada, "A", { path: pathOf(A), parent: B }, [ada2]);
        assert.equal(bare.tickets.find((ticket) => ticket.id === A).parent, B);
        const bareDisk = await readId(dir, A);
        assert.match(bareDisk, /^parent: bbbbbbbb$/m);
        assert.equal(bareDisk.includes("docs:bbbbbbbb"), false);
        const bareOther = await otherSaw(A);
        assert.equal(bareOther.foreign.find((row) => row.repo === "docs" && row.id === A).parent, B);

        const qualified = await setOk(ada, "A", { path: pathOf(A), parent: `docs:${B}` }, [ada2]);
        assert.equal(qualified.tickets.find((ticket) => ticket.id === A).parent, `docs:${B}`);
        assert.match(await readId(dir, A), /^parent: docs:bbbbbbbb$/m);
        const qualifiedOther = await otherSaw(A);
        assert.equal(qualifiedOther.foreign.find((row) => row.repo === "docs" && row.id === A).parent, `docs:${B}`);

        const linked = await setOk(ada, "A", { path: pathOf(A), parent: `other:${B}` }, [ada2]);
        assert.equal(linked.tickets.find((ticket) => ticket.id === A).parent, `other:${B}`);
        assert.equal(linked.tickets.some((ticket) => ticket.id === D), false);
        assertInbound(linked.inbound, [
          { repo: "other", id: D, title: "Dee", parent: `docs:${A}`, depends: [`docs:${A}`] },
          { repo: "other", id: H, title: "Aitch", parent: `docs:${F}`, depends: [] },
        ]);
        assert.match(await readId(dir, A), /^parent: other:bbbbbbbb$/m);
        const linkedOther = await otherSaw(A);
        assert.notDeepEqual(linkedOther, linked);
        assert.equal(linkedOther.foreign.find((row) => row.repo === "docs" && row.id === A).parent, `other:${B}`);
        assertInbound(linkedOther.inbound, [
          { repo: "docs", id: A, title: "Renamed", parent: `other:${B}`, depends: [] },
          {
            repo: "docs",
            id: G,
            title: "Gee",
            parent: F,
            depends: [`docs:${F}`, `other:${B}`],
          },
        ]);

        bo.send({ type: "tickets", username: "B" });
        const otherList = await bo.next((msg) => msg.type === "tickets");
        assert.equal(otherList.tickets.some((ticket) => ticket.id === A), false);
        assert.equal(otherList.tickets.some((ticket) => ticket.id === B), true);
        assert.equal(otherList.foreign.some((row) => row.repo === "other"), false);
        assert.equal(otherList.foreign.find((row) => row.repo === "docs" && row.id === A).parent, `other:${B}`);
        assertInbound(otherList.inbound, [
          { repo: "docs", id: A, title: "Renamed", parent: `other:${B}`, depends: [] },
          {
            repo: "docs",
            id: G,
            title: "Gee",
            parent: F,
            depends: [`docs:${F}`, `other:${B}`],
          },
        ]);
        ada.send({ type: "tickets", username: "A" });
        const docsList = await ada.next((msg) => msg.type === "tickets");
        assert.equal(docsList.tickets.some((ticket) => ticket.id === D), false);
        assert.equal(docsList.foreign.some((row) => row.repo === "docs"), false);
        assert.equal(docsList.foreign.find((row) => row.repo === "other" && row.id === D).parent, `docs:${A}`);
        assertInbound(docsList.inbound, linked.inbound);
        await expectNoTicketBroadcast(ada2, "A2");
        await expectNoTicketBroadcast(bo, "B");

        await setBad(bo, "B", { path: pathOf(B), parent: `docs:${A}` }, 409, otherDir, B, [
          { client: ada, username: "A" },
          { client: ada2, username: "A2" },
        ]);
        assert.equal(parseTicket(B, await readId(otherDir, B)).parent, "");

        const dependBack = await setOk(bo, "B", { path: pathOf(B), depends: [`docs:${A}`] }, []);
        assert.deepEqual(dependBack.tickets.find((ticket) => ticket.id === B).depends, [`docs:${A}`]);
        const dependDocs = await docsSaw(B);
        assert.deepEqual(dependDocs.foreign.find((row) => row.repo === "other" && row.id === B).depends, [`docs:${A}`]);
        await setBad(ada, "A", { path: pathOf(A), depends: [`other:${B}`] }, 409, dir, A, [
          { client: ada2, username: "A2" },
          { client: bo, username: "B" },
        ]);
        assert.deepEqual(parseTicket(A, await readId(dir, A)).depends, []);

        await setOk(bo, "B", { path: pathOf(B), depends: [] }, []);
        const clearedDocs = await docsSaw(B);
        assert.deepEqual(clearedDocs.foreign.find((row) => row.repo === "other" && row.id === B).depends, []);
        const ownParent = await setOk(ada, "A", { path: pathOf(A), depends: [`other:${B}`] }, [ada2]);
        assert.equal(ownParent.tickets.find((ticket) => ticket.id === A).parent, `other:${B}`);
        assert.deepEqual(ownParent.tickets.find((ticket) => ticket.id === A).depends, [`other:${B}`]);
        const ownDisk = await readId(dir, A);
        assert.match(ownDisk, /^parent: other:bbbbbbbb$/m);
        assert.match(ownDisk, /^depends: other:bbbbbbbb$/m);
        const ownOther = await otherSaw(A);
        assert.equal(ownOther.foreign.find((row) => row.repo === "docs" && row.id === A).parent, `other:${B}`);
        assert.deepEqual(ownOther.foreign.find((row) => row.repo === "docs" && row.id === A).depends, [`other:${B}`]);

        const foreign = await setOk(bo, "B", { path: pathOf(B), parent: `nope:${A}` }, []);
        assert.equal(foreign.tickets.find((ticket) => ticket.id === B).parent, `nope:${A}`);
        const nopeDocs = await docsSaw(B);
        assert.equal(nopeDocs.foreign.find((row) => row.repo === "other" && row.id === B).parent, `nope:${A}`);
        const still = await setOk(bo, "B", { path: pathOf(B), title: "Still Bravo" }, []);
        assert.equal(still.tickets.find((ticket) => ticket.id === B).title, "Still Bravo");
        assert.equal(still.tickets.find((ticket) => ticket.id === B).parent, `nope:${A}`);
        const stillDocs = await docsSaw(B);
        assert.equal(stillDocs.foreign.find((row) => row.repo === "other" && row.id === B).title, "Still Bravo");
        assert.equal(stillDocs.foreign.find((row) => row.repo === "other" && row.id === B).parent, `nope:${A}`);
        assert.equal(parseTicket(B, await readId(otherDir, B)).title, "Still Bravo");
        assert.equal(parseTicket(B, await readId(otherDir, B)).parent, `nope:${A}`);

        const deeBefore = await readId(otherDir, D);
        const aitchBefore = await readId(otherDir, H);
        ada.send({ type: "ticket.delete", username: "A", id: A });
        assert.equal((await ada.next((msg) => msg.type === "deleted" || msg.type === "error")).type, "deleted");
        assert.equal((await ada.next((msg) => msg.type === "docs" || msg.type === "tickets")).type, "docs");
        const afterDelete = await ada.next((msg) => msg.type === "tickets");
        assert.equal((await ada2.next((msg) => msg.type === "docs" || msg.type === "tickets")).type, "docs");
        assert.deepEqual(await ada2.next((msg) => msg.type === "tickets"), afterDelete);
        assert.equal(afterDelete.tickets.some((ticket) => ticket.id === A), false);
        const deletedOther = await otherSaw(C);
        assert.notDeepEqual(deletedOther, afterDelete);
        assert.equal(deletedOther.foreign.some((row) => row.repo === "docs" && row.id === A), false);
        assert.equal(deletedOther.tickets.find((ticket) => ticket.id === D).parent, `docs:${A}`);
        const cee = parseTicket(C, await readId(dir, C));
        assert.equal(cee.parent, "");
        assert.deepEqual(cee.depends, [`other:${A}`]);
        assert.equal(await readId(otherDir, D), deeBefore);
        assert.equal(parseTicket(D, deeBefore).parent, `docs:${A}`);
        const ceeSet = await setOk(ada, "A", { path: pathOf(C), title: "Cee 2" }, [ada2]);
        assert.equal(ceeSet.tickets.find((ticket) => ticket.id === C).title, "Cee 2");
        assert.deepEqual(ceeSet.tickets.find((ticket) => ticket.id === C).depends, []);
        const ceeDisk = parseTicket(C, await readId(dir, C));
        assert.equal(ceeDisk.title, "Cee 2");
        assert.deepEqual(ceeDisk.depends, []);
        const ceeOther = await otherSaw(C);
        assert.equal(ceeOther.foreign.find((row) => row.repo === "docs" && row.id === C).title, "Cee 2");
        assert.deepEqual(ceeOther.foreign.find((row) => row.repo === "docs" && row.id === C).depends, []);

        ada.send({ type: "ticket.purge", username: "A" });
        const purged = await ada.next((msg) => msg.type === "tickets" || msg.type === "error");
        assert.equal(purged.type, "tickets");
        assert.deepEqual(await ada2.next((msg) => msg.type === "tickets"), purged);
        assert.equal(purged.tickets.some((ticket) => ticket.id === F), false);
        const purgedOther = await otherSaw(G);
        assert.notDeepEqual(purgedOther, purged);
        assert.equal(purgedOther.foreign.some((row) => row.repo === "docs" && row.id === F), false);
        assert.equal(purgedOther.foreign.find((row) => row.repo === "docs" && row.id === G).parent, "");
        await assert.rejects(() => fs.lstat(path.join(dir, pathOf(F))));
        const gee = parseTicket(G, await readId(dir, G));
        assert.equal(gee.parent, "");
        assert.deepEqual(gee.depends, [`other:${B}`]);
        assert.equal(await readId(otherDir, H), aitchBefore);
        assert.equal(await readId(otherDir, D), deeBefore);
        const aitchSet = await setOk(bo, "B", { path: pathOf(H), title: "Aitch 2" }, []);
        assert.equal(aitchSet.tickets.find((ticket) => ticket.id === H).title, "Aitch 2");
        assert.equal(aitchSet.tickets.find((ticket) => ticket.id === H).parent, "");
        const aitchDocs = await docsSaw(H);
        assert.equal(aitchDocs.foreign.find((row) => row.repo === "other" && row.id === H).title, "Aitch 2");
        assert.equal(aitchDocs.foreign.find((row) => row.repo === "other" && row.id === H).parent, "");
        assert.equal(parseTicket(H, await readId(otherDir, H)).title, "Aitch 2");
        assert.equal(parseTicket(H, await readId(otherDir, H)).parent, "");
        assert.equal(await readId(otherDir, D), deeBefore);

        await setBad(ada, "A", { path: pathOf(D), repo: "other", parent: "other:" }, 400, otherDir, D, [
          { client: ada2, username: "A2" },
          { client: bo, username: "B" },
        ]);
        await setBad(ada, "A", { path: pathOf(D), repo: "other", parent: `other:${K}` }, 409, otherDir, D, [
          { client: ada2, username: "A2" },
          { client: bo, username: "B" },
        ]);
        await setBad(ada, "A", { path: pathOf(D), repo: "other", parent: D }, 409, otherDir, D, [
          { client: ada2, username: "A2" },
          { client: bo, username: "B" },
        ]);
        await setBad(ada, "A", { path: pathOf(D), repo: "nope", parent: "" }, 404, otherDir, D, [
          { client: ada2, username: "A2" },
          { client: bo, username: "B" },
        ]);

        const cleared = await setOk(ada, "A", { path: pathOf(D), repo: "other", parent: "" }, [ada2]);
        assert.equal(cleared.tickets.some((ticket) => ticket.id === D), false);
        assert.equal(cleared.foreign.find((row) => row.repo === "other" && row.id === D).parent, "");
        assert.deepEqual(cleared.foreign.find((row) => row.repo === "other" && row.id === D).depends, []);
        const clearedOther = await otherSaw(C);
        assert.notDeepEqual(clearedOther, cleared);
        assert.equal(clearedOther.tickets.find((ticket) => ticket.id === D).parent, "");
        assert.deepEqual(clearedOther.tickets.find((ticket) => ticket.id === D).depends, []);
        const clearedDisk = parseTicket(D, await readId(otherDir, D));
        assert.equal(clearedDisk.parent, "");
        assert.deepEqual(clearedDisk.depends, []);

        ada.send({ type: "ticket.create", username: "A", title: "Made" });
        const made = await ada.next((msg) => msg.type === "tickets" || msg.type === "error");
        assert.equal(made.type, "tickets");
        const madeTicket = made.tickets.find((ticket) => ticket.title === "Made");
        assert.ok(madeTicket);
        assert.deepEqual(await ada2.next((msg) => msg.type === "tickets" || msg.type === "error"), made);
        const madeFile = await ada.next((msg) => msg.type === "file");
        assert.equal(madeFile.path, pathOf(madeTicket.id));
        const madeOther = await otherSaw(madeTicket.id);
        assert.equal(madeOther.foreign.find((row) => row.repo === "docs" && row.id === madeTicket.id).title, "Made");
        assert.notDeepEqual(madeOther, made);

        const heldBefore = await readId(otherDir, H);
        await openDoc(bo, "B", pathOf(H));
        ada.send({ type: "ticket.set", username: "A", path: pathOf(H), repo: "other", title: "Held" });
        assert.deepEqual(await ada.next((msg) => msg.type === "error" || msg.type === "tickets"), {
          type: "error",
          status: 409,
          heldBy: "B",
        });
        assert.equal(await readId(otherDir, H), heldBefore);
        await expectNoTicketBroadcast(ada2, "A2");
        await expectNoTicketBroadcast(bo, "B");
      } finally {
        ada.ws.close();
        ada2.ws.close();
        bo.ws.close();
      }
    });
  } finally {
    await fs.rm(otherDir, { recursive: true, force: true });
    await fs.rm(mineDir, { recursive: true, force: true });
    await fs.rm(ghostDir, { recursive: true, force: true });
  }
});

test("a released ticket caret no longer blocks another socket", async () => {
  await withDocs(async ({ port, dir }) => {
    const body = "one\n\ntwo\n";
    const id = "aaaaaaaa";
    const rel = `tickets/${id}.md`;
    await writeTicket(dir, {
      id,
      title: "Alpha",
      state: "new",
      created: "2026-10-01T00:00:00.000Z",
      body,
    });
    const a = await hello(port, "A");
    const b = await hello(port, "B");
    try {
      const opened = await openDoc(a, "A", rel);
      assert.equal(opened.text, body);
      await openDoc(b, "B", rel);
      const from = lockIndexAt(body, 0);
      const to = lockIndexAt(body, body.length);
      assert.ok(to > from);
      const locked = await syncLock(a, [b], "A", rel, 0, opened.rev, body.length);
      const indexes = [];
      for (let index = from; index <= to; index += 1) indexes.push(index);
      assert.deepEqual(locked.lines.map((line) => line.index), indexes);
      assert.equal(locked.lines.every((line) => line.username === "A"), true);
      const refuse = async (cursor) => {
        b.send({
          type: "edit",
          username: "B",
          path: rel,
          rev: opened.rev,
          op: "insert",
          text: "Q",
          anchor: cursor,
          cursor,
        });
        const error = await b.next((msg) => msg.type === "error" || msg.type === "doc");
        assert.equal(error.type, "error");
        assert.equal(error.status, 409);
        assert.equal(error.heldBy, "A");
      };
      await refuse(0);
      await refuse(body.indexOf("two"));
      a.send({ type: "lock", username: "A", path: rel, rev: opened.rev + 1, release: true });
      assert.deepEqual(await a.next((msg) => msg.type === "error"), { type: "error", status: 409 });
      await refuse(body.indexOf("two"));
      a.send({ type: "lock", username: "A", path: rel, rev: opened.rev, release: true });
      const freedA = await a.next((msg) => msg.type === "locks" && msg.path === rel);
      const freedB = await b.next((msg) => msg.type === "locks" && msg.path === rel);
      assert.deepEqual(freedA.lines, []);
      assert.deepEqual(freedB.lines, []);
      b.send({
        type: "edit",
        username: "B",
        path: rel,
        rev: opened.rev,
        op: "insert",
        text: "Q",
        anchor: 0,
        cursor: 0,
      });
      const doc = await takeDoc(b);
      await takeDoc(a);
      assert.equal(doc.text, "Qone\n\ntwo\n");
      const twoAt = doc.text.indexOf("two");
      b.send({
        type: "edit",
        username: "B",
        path: rel,
        rev: doc.rev,
        op: "insert",
        text: "Z",
        anchor: twoAt,
        cursor: twoAt,
      });
      const second = await takeDoc(b);
      await takeDoc(a);
      assert.equal(second.text, "Qone\n\nZtwo\n");
      const disk = await readDoc(dir, rel);
      assert.equal(disk.includes("Qone"), true);
      assert.equal(disk.includes("Ztwo"), true);
    } finally {
      a.ws.close();
      b.ws.close();
    }
  });
});

test("a line inserted above a range shifts the stored numbers and undo restores them", async () => {
  const source = "```js\none\ntwo\nthree\nfour\n```\n";
  const original = `${source}\`\`\`comment c1 2-3\n\n\`\`\`\n`;
  await withDocs(async ({ port, dir }) => {
    await fs.writeFile(path.join(dir, "a.md"), original);
    const a = await hello(port, "A");
    let rev = (await openDoc(a, "A", "a.md")).rev;
    const at = original.indexOf("two");
    await syncLock(a, [], "A", "a.md", at, rev);
    a.send({
      type: "edit",
      username: "A",
      path: "a.md",
      rev,
      op: "insert",
      text: "X\n",
      exact: true,
      anchor: at,
      cursor: at,
    });
    const doc = await takeDoc(a);
    rev = doc.rev;
    assert.equal(doc.text.includes("```comment c1 3-4\n"), true);
    assert.equal(doc.text.includes("X\ntwo\n"), true);
    assert.equal(await readDoc(dir, "a.md"), doc.text);
    a.send({ type: "undo", username: "A", path: "a.md", rev });
    const restored = await takeDoc(a);
    assert.equal(restored.text, original);
    assert.equal(await readDoc(dir, "a.md"), original);

    const gap = restored.text.indexOf("```comment");
    a.send({
      type: "edit",
      username: "A",
      path: "a.md",
      rev: restored.rev,
      op: "insert",
      text: "\n",
      exact: true,
      anchor: gap,
      cursor: gap,
    });
    assert.deepEqual(await a.next((msg) => msg.type === "error"), {
      type: "error",
      status: 400,
      reason: "not in the run",
    });
    assert.equal(await readDoc(dir, "a.md"), original);
    a.ws.close();
  });
});

test("a directory can be created before it holds a document", async () => {
  assert.equal(assetDirOf("tickets.md"), null);
  assert.equal(assetDirOf("welcome.md"), "welcome");
  await withDocs(async ({ port, dir }) => {
    const a = await hello(port, "A");
    const b = await hello(port, "Bea");
    const marker = (rel) => path.join(dir, ...rel.split("/"), ".viewmark-dir");
    const absent = (rel) => assert.rejects(() => fs.lstat(path.join(dir, rel)), (err) => err.code === "ENOENT");
    const take = async (pred) => a.next((msg) => pred(msg));

    a.send({ type: "list", username: "A" });
    const initial = await take((msg) => msg.type === "docs");
    assert.equal(initial.dirs, undefined);
    assert.equal(initial.files.includes("welcome.md"), true);

    await fs.writeFile(path.join(dir, "plain.md"), "plain\n");
    await fs.mkdir(path.join(dir, "welcome"));
    await fs.writeFile(path.join(dir, "welcome", "shot.png"), "png");
    a.send({ type: "list", username: "A" });
    const quiet = await take((msg) => msg.type === "docs");
    assert.equal(quiet.dirs, undefined);
    assert.equal(quiet.files.includes("welcome.md"), true);
    assert.equal(quiet.files.some((file) => file.startsWith("welcome/")), false);

    a.send({ type: "move", username: "A", path: "plain.md", dir: "nope" });
    assert.deepEqual(await take((msg) => msg.type === "error"), { type: "error", status: 404 });
    a.send({ type: "move", username: "A", path: "plain.md", dir: "welcome" });
    assert.deepEqual(await take((msg) => msg.type === "error"), { type: "error", status: 404 });
    assert.equal(await fs.readFile(path.join(dir, "plain.md"), "utf8"), "plain\n");
    assert.equal(await fs.readFile(path.join(dir, "welcome", "shot.png"), "utf8"), "png");

    const refused = [
      "",
      "   ",
      ".",
      "..",
      ".git",
      "foo/.git",
      "a//b",
      "---",
      "tickets",
      "tickets/pages",
      "../out",
      "x".repeat(1025),
    ];
    for (const rel of refused) {
      a.send({ type: "directory.create", username: "A", path: rel });
      assert.deepEqual(await take((msg) => msg.type === "error"), { type: "error", status: 400, reason: "name" });
    }
    await absent(".git");
    await absent("a");
    assert.equal((await fs.readdir(dir)).includes("x".repeat(1025)), false);
    await assert.rejects(() => fs.lstat(marker("tickets")));
    assert.equal((await fs.lstat(path.join(dir, "tickets", "seedmark.md"))).isFile(), true);

    a.send({ type: "directory.create", username: "A", path: "welcome" });
    assert.deepEqual(await take((msg) => msg.type === "error"), {
      type: "error",
      status: 409,
      reason: "That directory holds pictures for welcome.md.",
      path: "welcome.md",
    });
    a.send({ type: "directory.create", username: "A", path: "welcome/extra" });
    assert.deepEqual(await take((msg) => msg.type === "error"), {
      type: "error",
      status: 409,
      reason: "That directory holds pictures for welcome.md.",
      path: "welcome.md",
    });
    await absent("welcome/.viewmark-dir");
    await absent("welcome/extra");
    assert.equal(await fs.readFile(path.join(dir, "welcome", "shot.png"), "utf8"), "png");

    await fs.writeFile(path.join(dir, "tickets.md"), "# Tickets\n");
    a.send({ type: "list", username: "A" });
    const tickets = await take((msg) => msg.type === "docs");
    assert.equal(tickets.files.includes("tickets.md"), true);
    assert.equal(tickets.dirs, undefined);
    a.send({ type: "directory.create", username: "A", path: "tickets" });
    assert.deepEqual(await take((msg) => msg.type === "error"), { type: "error", status: 400, reason: "name" });

    a.send({ type: "directory.create", username: "A", path: "Notes/Drafts" });
    const drafted = await take((msg) => msg.type === "docs");
    assert.equal(drafted.files.includes("welcome.md"), true);
    assert.deepEqual(drafted.dirs, ["notes/drafts"]);
    assert.equal(drafted.files.some((file) => file.startsWith("notes/drafts/")), false);
    assert.deepEqual(await take((msg) => msg.type === "directory"), { type: "directory", path: "notes/drafts" });
    assert.equal(await fs.readFile(marker("notes/drafts"), "utf8"), "");
    const seen = await b.next((msg) => msg.type === "docs" && Array.isArray(msg.dirs) && msg.dirs.includes("notes/drafts"));
    assert.deepEqual(seen.dirs, ["notes/drafts"]);

    await fs.writeFile(marker("notes/drafts"), "keep");
    a.send({ type: "directory.create", username: "A", path: "notes/drafts" });
    assert.deepEqual(await take((msg) => msg.type === "directory" || msg.type === "docs" || msg.type === "error"), {
      type: "directory",
      path: "notes/drafts",
    });
    assert.equal(await fs.readFile(marker("notes/drafts"), "utf8"), "keep");

    a.send({ type: "directory.create", username: "A", path: "notes" });
    assert.deepEqual(await take((msg) => msg.type === "directory" || msg.type === "docs" || msg.type === "error"), {
      type: "directory",
      path: "notes",
    });
    await absent("notes/.viewmark-dir");

    a.send({ type: "directory.create", username: "A", path: "Area 51" });
    assert.equal((await take((msg) => msg.type === "docs")).dirs.includes("area-51"), true);
    assert.deepEqual(await take((msg) => msg.type === "directory"), { type: "directory", path: "area-51" });
    assert.equal((await fs.lstat(path.join(dir, "area-51"))).isDirectory(), true);

    await fs.mkdir(path.join(dir, "Kept Name"));
    a.send({ type: "directory.create", username: "A", path: "kept-name" });
    assert.equal((await take((msg) => msg.type === "docs")).dirs.includes("Kept Name"), true);
    assert.deepEqual(await take((msg) => msg.type === "directory"), { type: "directory", path: "Kept Name" });
    assert.equal(await fs.readFile(marker("Kept Name"), "utf8"), "");
    await absent("kept-name");

    await fs.mkdir(path.join(dir, "My Notes"));
    a.send({ type: "directory.create", username: "A", path: "My Notes/Drafts" });
    assert.equal((await take((msg) => msg.type === "docs")).dirs.includes("My Notes/drafts"), true);
    const nested = await take((msg) => msg.type === "directory");
    assert.equal(nested.path, "My Notes/drafts");
    assert.equal(await fs.readFile(marker("My Notes/drafts"), "utf8"), "");
    await fs.writeFile(marker("My Notes/drafts"), "keep");
    a.send({ type: "directory.create", username: "A", path: "my-notes" });
    assert.deepEqual(await take((msg) => msg.type === "directory" || msg.type === "docs" || msg.type === "error"), {
      type: "directory",
      path: "My Notes",
    });
    await absent("My Notes/.viewmark-dir");
    assert.equal(await fs.readFile(marker("My Notes/drafts"), "utf8"), "keep");

    await fs.mkdir(path.join(dir, "Draft Box"));
    await fs.mkdir(path.join(dir, "draft_box"));
    a.send({ type: "directory.create", username: "A", path: "draft-box" });
    assert.deepEqual(await take((msg) => msg.type === "error"), { type: "error", status: 409 });
    a.send({ type: "directory.create", username: "A", path: "draft-box/child" });
    assert.deepEqual(await take((msg) => msg.type === "error"), { type: "error", status: 409 });
    await absent("Draft Box/.viewmark-dir");
    await absent("draft_box/.viewmark-dir");
    await absent("draft-box");

    a.send({ type: "create", username: "A", path: "pages/note.md", text: "Note\n" });
    const createdDocs = await take((msg) => msg.type === "docs");
    assert.equal(createdDocs.files.includes("pages/note.md"), true);
    assert.equal((createdDocs.dirs || []).includes("pages"), false);
    const created = await take((msg) => msg.type === "file" && msg.path === "pages/note.md");
    assert.equal(created.text, "Note\n");
    a.send({ type: "directory.create", username: "A", path: "pages" });
    assert.deepEqual(await take((msg) => msg.type === "directory" || msg.type === "error"), { type: "directory", path: "pages" });
    await absent("pages/.viewmark-dir");
    a.send({ type: "delete", username: "A", path: "pages/note.md" });
    assert.deepEqual(await take((msg) => msg.type === "deleted"), { type: "deleted", path: "pages/note.md" });
    const afterNote = await take((msg) => msg.type === "docs");
    assert.equal(afterNote.files.includes("pages/note.md"), false);
    assert.equal((afterNote.dirs || []).includes("pages"), false);
    a.send({ type: "move", username: "A", path: "plain.md", dir: "pages" });
    assert.deepEqual(await take((msg) => msg.type === "error"), { type: "error", status: 404 });
    assert.equal(await fs.readFile(path.join(dir, "plain.md"), "utf8"), "plain\n");
    a.send({ type: "directory.create", username: "A", path: "pages" });
    assert.equal((await take((msg) => msg.type === "docs")).dirs.includes("pages"), true);
    assert.deepEqual(await take((msg) => msg.type === "directory"), { type: "directory", path: "pages" });
    a.send({ type: "move", username: "A", path: "plain.md", dir: "pages" });
    const movedDocs = await take((msg) => msg.type === "docs");
    assert.equal(movedDocs.files.includes("pages/plain.md"), true);
    assert.equal(movedDocs.files.includes("plain.md"), false);
    assert.deepEqual(await take((msg) => msg.type === "moved"), {
      type: "moved",
      path: "plain.md",
      moves: [{ path: "plain.md", dest: "pages/plain.md" }],
    });
    assert.equal(await fs.readFile(path.join(dir, "pages", "plain.md"), "utf8"), "plain\n");
    a.send({ type: "delete", username: "A", path: "pages/plain.md" });
    assert.deepEqual(await take((msg) => msg.type === "deleted"), { type: "deleted", path: "pages/plain.md" });
    const restored = await take((msg) => msg.type === "docs");
    assert.equal(restored.dirs.includes("pages"), true);
    assert.equal(await fs.readFile(marker("pages"), "utf8"), "");

    await fs.writeFile(path.join(dir, "notes", "stay.md"), "stay\n");
    a.send({ type: "directory.delete", username: "A", path: "notes" });
    assert.deepEqual(await take((msg) => msg.type === "error"), {
      type: "error",
      status: 409,
      reason: "directory is not empty",
    });
    assert.equal(await fs.readFile(path.join(dir, "notes", "stay.md"), "utf8"), "stay\n");
    assert.equal(await fs.readFile(marker("notes/drafts"), "utf8"), "keep");
    a.send({ type: "directory.delete", username: "A", path: "notes/drafts" });
    const removedDocs = await take((msg) => msg.type === "docs");
    assert.equal((removedDocs.dirs || []).includes("notes/drafts"), false);
    assert.deepEqual(await take((msg) => msg.type === "directory.deleted"), { type: "directory.deleted", path: "notes/drafts" });
    await absent("notes/drafts");

    await fs.mkdir(path.join(dir, "lone"));
    a.send({ type: "directory.delete", username: "A", path: "lone" });
    assert.deepEqual(await take((msg) => msg.type === "error"), { type: "error", status: 404 });
    assert.equal((await fs.lstat(path.join(dir, "lone"))).isDirectory(), true);

    await fs.mkdir(path.join(dir, "archive"));
    await fs.writeFile(path.join(dir, "archive", "keep.md"), "keep\n");
    a.send({ type: "directory.create", username: "A", path: "box" });
    assert.equal((await take((msg) => msg.type === "docs")).dirs.includes("box"), true);
    assert.deepEqual(await take((msg) => msg.type === "directory"), { type: "directory", path: "box" });
    a.send({ type: "move", username: "A", path: "box", dir: "archive" });
    const boxed = await take((msg) => msg.type === "docs");
    assert.equal(boxed.dirs.includes("archive/box"), true);
    assert.equal(boxed.dirs.includes("box"), false);
    assert.deepEqual(await take((msg) => msg.type === "moved"), {
      type: "moved",
      path: "box",
      moves: [{ path: "box", dest: "archive/box" }],
    });
    assert.equal(await fs.readFile(marker("archive/box"), "utf8"), "");
    a.send({ type: "move", username: "A", path: "archive/box", dir: "archive" });
    assert.deepEqual(await take((msg) => msg.type === "moved" || msg.type === "docs" || msg.type === "error"), {
      type: "moved",
      path: "archive/box",
      moves: [{ path: "archive/box", dest: "archive/box" }],
    });

    a.send({ type: "directory.create", username: "A", path: "hold/welcome" });
    assert.equal((await take((msg) => msg.type === "docs")).dirs.includes("hold/welcome"), true);
    assert.deepEqual(await take((msg) => msg.type === "directory"), { type: "directory", path: "hold/welcome" });
    a.send({ type: "move", username: "A", path: "hold/welcome", dir: "" });
    assert.deepEqual(await take((msg) => msg.type === "error"), { type: "error", status: 409 });
    assert.equal(await fs.readFile(marker("hold/welcome"), "utf8"), "");
    await absent("welcome/.viewmark-dir");
    assert.equal(await fs.readFile(path.join(dir, "welcome", "shot.png"), "utf8"), "png");

    await fs.mkdir(path.join(dir, "keep", "a"), { recursive: true });
    await fs.writeFile(path.join(dir, "keep", "a.md"), "A\n");
    await fs.writeFile(path.join(dir, "keep", "b.md"), "B\n");
    await fs.writeFile(path.join(dir, "keep", "a", "pic.png"), "pic");
    await fs.mkdir(path.join(dir, "pile", "a"), { recursive: true });
    await fs.writeFile(path.join(dir, "pile", "a.md"), "P\n");
    await fs.writeFile(path.join(dir, "pile", "a", "pic.png"), "pic");
    a.send({ type: "directory.delete", username: "A", path: "keep" });
    assert.deepEqual(await take((msg) => msg.type === "error"), {
      type: "error",
      status: 409,
      reason: "directory is not empty",
    });
    assert.equal(await fs.readFile(path.join(dir, "keep", "a.md"), "utf8"), "A\n");
    await openDoc(b, "Bea", "keep/b.md");
    a.send({ type: "directory.delete", username: "A", path: "keep", documents: true });
    assert.deepEqual(await take((msg) => msg.type === "error"), { type: "error", status: 409, heldBy: "Bea" });
    assert.equal(await fs.readFile(path.join(dir, "keep", "a.md"), "utf8"), "A\n");
    assert.equal(await fs.readFile(path.join(dir, "keep", "b.md"), "utf8"), "B\n");
    assert.equal(await fs.readFile(path.join(dir, "keep", "a", "pic.png"), "utf8"), "pic");

    await openDoc(a, "A", "pile/a.md");
    a.send({ type: "directory.delete", username: "A", path: "pile", documents: true });
    assert.deepEqual(await take((msg) => msg.type === "directory.deleted"), { type: "directory.deleted", path: "pile" });
    await absent("pile");
    assert.equal(await fs.readFile(path.join(dir, "keep", "b.md"), "utf8"), "B\n");

    a.ws.close();
    b.ws.close();
  });
});

test("eftpk82u: rename a document or a directory", async () => {
  await withDocs(async ({ port, dir }) => {
    const kept = "# Kept heading\n\nprose stays\n";
    const draft = "# Draft\n\nstays\n";
    const pictured = "# Pictured\n\n![shot](notes/pictured/shot.png)\n\n![web](https://example.com/a.png)\n\n![blob](data:image/png;base64,aaaa)\n";
    const notAllowed = "That name is not allowed.";
    const used = "That name is already used.";
    const picture = "A picture directory is in the way.";
    await fs.writeFile(path.join(dir, "welcome.md"), kept);
    await fs.mkdir(path.join(dir, "notes"), { recursive: true });
    await fs.writeFile(path.join(dir, "notes", "draft.md"), draft);
    await fs.writeFile(path.join(dir, "notes", "Hello.md"), "spelling\n");
    await fs.mkdir(path.join(dir, "archive"), { recursive: true });
    await fs.writeFile(path.join(dir, "archive", "keep.md"), "# Keep\n");
    await fs.writeFile(path.join(dir, "page.markdown"), "# Page\n");
    const a = await hello(port, "A");
    const b = await hello(port, "B");
    const marker = (rel) => path.join(dir, ...rel.split("/"), ".viewmark-dir");
    const refuse = async (extra, status, reason) => {
      a.send({ type: "rename", username: "A", ...extra });
      const msg = await a.next((item) => item.type === "error" || item.type === "docs" || item.type === "renamed");
      const expect = { type: "error", status };
      if (reason !== undefined) expect.reason = reason;
      assert.deepEqual(msg, expect, JSON.stringify(extra));
      assert.equal(a.all.some((item) => item.type === "docs" || item.type === "renamed"), false);
      assert.equal(b.all.length, 0);
    };
    const renameIdle = async (path, name) => {
      a.send({ type: "rename", username: "A", path, name });
      const docs = await a.next((msg) => msg.type === "docs" || msg.type === "renamed" || msg.type === "error");
      assert.equal(docs.type, "docs", JSON.stringify(docs));
      const renamed = await a.next((msg) => msg.type === "renamed" || msg.type === "error");
      assert.equal(renamed.type, "renamed", JSON.stringify(renamed));
      const docsB = await b.next((msg) => msg.type === "docs" || msg.type === "file" || msg.type === "renamed" || msg.type === "error");
      assert.equal(docsB.type, "docs");
      assert.equal(b.all.some((msg) => msg.type === "renamed"), false);
      return renamed;
    };
    const createDir = async (path) => {
      a.send({ type: "directory.create", username: "A", path });
      const docs = await a.next((msg) => msg.type === "docs" || msg.type === "error");
      assert.equal(docs.type, "docs", JSON.stringify(docs));
      const made = await a.next((msg) => msg.type === "directory" || msg.type === "error");
      assert.equal(made.type, "directory", JSON.stringify(made));
      assert.equal((await b.next((msg) => msg.type === "docs" || msg.type === "error")).type, "docs");
      return made.path;
    };
    try {
      const before = await snapshotTree(dir);
      for (const name of ["a/b.md", "", "   ", ".", "..", ".git", "---", "tickets", "tickets.md", "Tickets", "a\\b.md", "a\0b", "a".repeat(1024)]) {
        await refuse({ path: "welcome.md", name }, 400, notAllowed);
      }
      await refuse({ path: "welcome.md" }, 400, notAllowed);
      await refuse({ path: "welcome.md", name: 4 }, 400, notAllowed);
      await refuse({ path: "tickets", name: "box" }, 400, notAllowed);
      await refuse({ path: "tickets/seedmark.md", name: "other.md" }, 400, notAllowed);
      await refuse({ path: "missing.md", name: "other.md" }, 404);
      await refuse({ path: "../out.md", name: "other.md" }, 404);
      await refuse({ path: "welcome", name: "other" }, 404);
      await refuse({ path: "notes/draft.md", name: "a".repeat(1016) }, 400, notAllowed);
      assert.deepEqual(await snapshotTree(dir), before);

      a.send({ type: "rename", username: "A", path: "welcome.md", name: "Welcome.md" });
      assert.deepEqual(await a.next((msg) => msg.type === "renamed" || msg.type === "docs" || msg.type === "error"), {
        type: "renamed",
        path: "welcome.md",
        moves: [{ path: "welcome.md", dest: "welcome.md" }],
      });
      assert.equal(a.all.length, 0);
      assert.equal(b.all.length, 0);
      assert.equal(await readDoc(dir, "welcome.md"), kept);

      await refuse({ path: "notes/draft.md", name: "hello.md" }, 409, used);
      await refuse({ path: "notes/draft.md", name: "Hello.md" }, 409, used);
      assert.equal(await readDoc(dir, "notes/draft.md"), draft);
      assert.equal(await readDoc(dir, "notes/Hello.md"), "spelling\n");
      await assert.rejects(() => fs.lstat(path.join(dir, "notes", "hello.md")), (err) => err.code === "ENOENT");
      await assert.rejects(() => fs.lstat(path.join(dir, "notes", "hello-2.md")), (err) => err.code === "ENOENT");
      await assert.rejects(() => fs.lstat(path.join(dir, "notes", "draft-2.md")), (err) => err.code === "ENOENT");
      await refuse({ path: "notes", name: "archive" }, 409, used);
      await refuse({ path: "notes", name: "Archive" }, 409, used);
      assert.equal(await readDoc(dir, "notes/draft.md"), draft);
      assert.equal(await readDoc(dir, "archive/keep.md"), "# Keep\n");

      await fs.mkdir(path.join(dir, "notes", "parked"));
      await fs.writeFile(path.join(dir, "notes", "parked", "other.png"), "other");
      await fs.mkdir(path.join(dir, "notes", "pictured"));
      await fs.writeFile(path.join(dir, "notes", "pictured", "shot.png"), "png-bytes");
      await fs.writeFile(path.join(dir, "notes", "pictured.md"), pictured);
      await fs.mkdir(path.join(dir, "notes", "Hello"));
      await fs.writeFile(path.join(dir, "notes", "Hello", "keep.txt"), "keep");
      await refuse({ path: "notes/pictured.md", name: "Hello.md" }, 409, used);
      assert.equal(await readDoc(dir, "notes/pictured.md"), pictured);
      assert.equal(await fs.readFile(path.join(dir, "notes", "pictured", "shot.png"), "utf8"), "png-bytes");
      await refuse({ path: "notes/pictured.md", name: "parked.md" }, 409, picture);
      assert.equal(await readDoc(dir, "notes/pictured.md"), pictured);
      assert.equal(await fs.readFile(path.join(dir, "notes", "parked", "other.png"), "utf8"), "other");
      await fs.writeFile(path.join(dir, "notes", "bare.md"), "bare\n");
      await refuse({ path: "notes/bare.md", name: "parked.md" }, 409, picture);
      assert.equal(await readDoc(dir, "notes/bare.md"), "bare\n");
      assert.equal(await fs.readFile(path.join(dir, "notes", "parked", "other.png"), "utf8"), "other");

      await fs.mkdir(path.join(dir, "welcome"));
      await fs.writeFile(path.join(dir, "welcome", "shot.png"), "png");
      await refuse({ path: "notes", name: "welcome" }, 409, picture);
      assert.equal(await readDoc(dir, "notes/draft.md"), draft);
      assert.equal(await fs.readFile(path.join(dir, "welcome", "shot.png"), "utf8"), "png");
      await fs.writeFile(path.join(dir, "welcome", "inside.md"), "inside\n");
      await refuse({ path: "notes", name: "welcome" }, 409, used);
      await fs.rm(path.join(dir, "welcome", "inside.md"));
      assert.equal(await fs.readFile(path.join(dir, "welcome", "shot.png"), "utf8"), "png");
      assert.equal(await readDoc(dir, "notes/draft.md"), draft);

      const opened = await openDoc(b, "B", "notes/draft.md");
      assert.equal(opened.text, draft);
      assert.equal(opened.rev, 0);
      await syncLock(b, [], "B", "notes/draft.md", 0, opened.rev);
      a.send({ type: "rename", username: "A", path: "notes/draft.md", name: "Side Note" });
      const followed = await b.next((msg) => msg.type === "file" || msg.type === "error");
      assert.equal(followed.type, "file");
      assert.equal(followed.path, "notes/side-note.md");
      assert.equal(followed.rev, 0);
      assert.equal(followed.text, draft);
      assert.deepEqual(followed.locks, [{ index: 0, username: "B" }]);
      const docsB = await b.next((msg) => msg.type === "docs");
      const docsA = await a.next((msg) => msg.type === "docs" || msg.type === "file" || msg.type === "error");
      assert.equal(docsA.type, "docs");
      assert.equal(docsA.files.includes("notes/side-note.md"), true);
      assert.equal(docsA.files.includes("notes/draft.md"), false);
      assert.equal(docsB.files.includes("notes/side-note.md"), true);
      assert.deepEqual(await a.next((msg) => msg.type === "renamed" || msg.type === "error"), {
        type: "renamed",
        path: "notes/draft.md",
        moves: [{ path: "notes/draft.md", dest: "notes/side-note.md" }],
      });
      assert.equal(b.all.some((msg) => msg.type === "renamed"), false);
      assert.equal(await readDoc(dir, "notes/side-note.md"), draft);
      await assert.rejects(() => fs.lstat(path.join(dir, "notes", "draft.md")), (err) => err.code === "ENOENT");
      b.send({ type: "edit", username: "B", path: "notes/draft.md", rev: 0, op: "insert", text: "NO" });
      assert.deepEqual(await b.next((msg) => msg.type === "error" || msg.type === "doc"), { type: "error", status: 409 });
      assert.equal(await readDoc(dir, "notes/side-note.md"), draft);
      const at = draft.indexOf("stays");
      b.send({ type: "edit", username: "B", path: "notes/side-note.md", rev: 0, op: "insert", text: "Z", anchor: at, cursor: at });
      const edited = await takeDoc(b);
      assert.equal(edited.text.startsWith("# Draft\n"), true);
      assert.equal(edited.text.includes("Zstays"), true);

      const shot = await renameIdle("notes/pictured.md", "Shot Book.md");
      assert.deepEqual(shot.moves, [{ path: "notes/pictured.md", dest: "notes/shot-book.md" }]);
      const shotText = await readDoc(dir, "notes/shot-book.md");
      assert.equal(shotText.startsWith("# Pictured\n"), true);
      assert.equal(shotText.includes("notes/shot-book/shot.png"), true);
      assert.equal(shotText.includes("notes/pictured/"), false);
      assert.equal(shotText.includes("https://example.com/a.png"), true);
      assert.equal(shotText.includes("data:image/png;base64,aaaa"), true);
      assert.equal(await fs.readFile(path.join(dir, "notes", "shot-book", "shot.png"), "utf8"), "png-bytes");
      await assert.rejects(() => fs.lstat(path.join(dir, "notes", "pictured.md")), (err) => err.code === "ENOENT");
      await assert.rejects(() => fs.lstat(path.join(dir, "notes", "pictured")), (err) => err.code === "ENOENT");

      const cased = await renameIdle("notes/Hello.md", "hello.md");
      assert.deepEqual(cased.moves, [{ path: "notes/Hello.md", dest: "notes/hello.md" }]);
      assert.equal(await readDoc(dir, "notes/hello.md"), "spelling\n");
      assert.equal(await fs.readFile(path.join(dir, "notes", "hello", "keep.txt"), "utf8"), "keep");
      await assert.rejects(() => fs.lstat(path.join(dir, "notes", "Hello.md")), (err) => err.code === "ENOENT");

      const keptSuffix = await renameIdle("page.markdown", "Hello.markdown");
      assert.deepEqual(keptSuffix.moves, [{ path: "page.markdown", dest: "hello.markdown" }]);
      assert.equal(await readDoc(dir, "hello.markdown"), "# Page\n");
      const gained = await renameIdle("hello.markdown", "Other");
      assert.deepEqual(gained.moves, [{ path: "hello.markdown", dest: "other.md" }]);
      assert.equal(await readDoc(dir, "other.md"), "# Page\n");
      await assert.rejects(() => fs.lstat(path.join(dir, "hello.markdown")), (err) => err.code === "ENOENT");

      const leaf = "leaf\n\n![shot](pack/sub/deep/shot.png)\n\n![web](https://example.com/a.png)\n\n![blob](data:image/png;base64,aaaa)\n";
      const packDraft = "# Pack\n\nstays\n";
      await fs.mkdir(path.join(dir, "pack", "sub", "deep"), { recursive: true });
      await fs.writeFile(path.join(dir, "pack", "draft.md"), packDraft);
      await fs.writeFile(path.join(dir, "pack", "sub", "deep.md"), leaf);
      await fs.writeFile(path.join(dir, "pack", "sub", "deep", "shot.png"), "png");
      await fs.writeFile(path.join(dir, "pack", "extra.txt"), "extra\n");
      const openedLeaf = await openDoc(b, "B", "pack/sub/deep.md");
      assert.equal(openedLeaf.rev, 0);
      assert.equal(openedLeaf.text, leaf);
      a.send({ type: "rename", username: "A", path: "pack", name: "My Notes" });
      const nested = await b.next((msg) => msg.type === "file" || msg.type === "error");
      assert.equal(nested.type, "file");
      assert.equal(nested.path, "my-notes/sub/deep.md");
      assert.equal(nested.rev, 1);
      assert.equal(nested.text.includes("my-notes/sub/deep/shot.png"), true);
      assert.equal(nested.text.includes("https://example.com/a.png"), true);
      assert.equal(nested.text.includes("data:image/png;base64,aaaa"), true);
      assert.equal(nested.text.includes("pack/sub/deep/"), false);
      const nestDocsB = await b.next((msg) => msg.type === "docs");
      const nestDocsA = await a.next((msg) => msg.type === "docs" || msg.type === "file" || msg.type === "error");
      assert.equal(nestDocsA.type, "docs");
      assert.equal(nestDocsA.files.includes("my-notes/draft.md"), true);
      assert.equal(nestDocsA.files.includes("my-notes/sub/deep.md"), true);
      assert.equal(nestDocsA.files.includes("pack/draft.md"), false);
      assert.equal(nestDocsA.titles["my-notes/draft.md"], "Pack");
      assert.deepEqual(nestDocsB.files, nestDocsA.files);
      assert.deepEqual(await a.next((msg) => msg.type === "renamed" || msg.type === "error"), {
        type: "renamed",
        path: "pack",
        moves: [
          { path: "pack/draft.md", dest: "my-notes/draft.md" },
          { path: "pack/sub/deep.md", dest: "my-notes/sub/deep.md" },
        ],
      });
      assert.equal(b.all.some((msg) => msg.type === "renamed"), false);
      assert.equal(await readDoc(dir, "my-notes/draft.md"), packDraft);
      assert.equal(await fs.readFile(path.join(dir, "my-notes", "extra.txt"), "utf8"), "extra\n");
      assert.equal(await fs.readFile(path.join(dir, "my-notes", "sub", "deep", "shot.png"), "utf8"), "png");
      await assert.rejects(() => fs.lstat(path.join(dir, "pack")), (err) => err.code === "ENOENT");
      b.send({ type: "edit", username: "B", path: "pack/sub/deep.md", rev: 1, op: "insert", text: "NO" });
      assert.deepEqual(await b.next((msg) => msg.type === "error" || msg.type === "doc"), { type: "error", status: 409 });
      b.send({ type: "edit", username: "B", path: "my-notes/sub/deep.md", rev: 1, op: "insert", text: "Q", anchor: 0, cursor: 0 });
      const leafEdited = await takeDoc(b);
      assert.equal(leafEdited.text.startsWith("Qleaf\n"), true);

      assert.equal(await createDir("Empty Box"), "empty-box");
      const emptied = await renameIdle("empty-box", "My Box");
      assert.deepEqual(emptied, {
        type: "renamed",
        path: "empty-box",
        moves: [{ path: "empty-box", dest: "my-box" }],
      });
      assert.equal(await fs.readFile(marker("my-box"), "utf8"), "");
      await assert.rejects(() => fs.lstat(marker("empty-box")), (err) => err.code === "ENOENT");
      a.send({ type: "rename", username: "A", path: "my-box", name: "My Box" });
      assert.deepEqual(await a.next((msg) => msg.type === "renamed" || msg.type === "docs" || msg.type === "error"), {
        type: "renamed",
        path: "my-box",
        moves: [{ path: "my-box", dest: "my-box" }],
      });
      assert.equal(a.all.length, 0);
      assert.equal(b.all.length, 0);
      assert.equal(await fs.readFile(marker("my-box"), "utf8"), "");
      const dashed = await renameIdle("my-box", "drafts.md");
      assert.deepEqual(dashed.moves, [{ path: "my-box", dest: "drafts-md" }]);
      assert.equal(await fs.readFile(marker("drafts-md"), "utf8"), "");

      assert.equal(await createDir("hold/pages"), "hold/pages");
      const nestedTickets = await renameIdle("hold/pages", "tickets");
      assert.deepEqual(nestedTickets.moves, [{ path: "hold/pages", dest: "hold/tickets" }]);
      assert.equal(await fs.readFile(marker("hold/tickets"), "utf8"), "");
      assert.equal(await createDir("box"), "box");
      await refuse({ path: "box", name: "tickets" }, 400, notAllowed);
      assert.equal(await fs.readFile(marker("box"), "utf8"), "");

      await fs.writeFile(path.join(dir, "notes", "label.md"), "label\n");
      const under = await renameIdle("notes/label.md", "tickets.md");
      assert.deepEqual(under.moves, [{ path: "notes/label.md", dest: "notes/tickets.md" }]);
      assert.equal(await readDoc(dir, "notes/tickets.md"), "label\n");
      await fs.writeFile(path.join(dir, "tickets.md"), "# T\n");
      const away = await renameIdle("tickets.md", "not-tickets.md");
      assert.deepEqual(away.moves, [{ path: "tickets.md", dest: "not-tickets.md" }]);
      assert.equal(await readDoc(dir, "not-tickets.md"), "# T\n");
      await assert.rejects(() => fs.lstat(path.join(dir, "tickets.md")), (err) => err.code === "ENOENT");
      assert.equal((await fs.lstat(path.join(dir, "tickets", "seedmark.md"))).isFile(), true);
    } finally {
      a.ws.close();
      b.ws.close();
    }
  });
});
