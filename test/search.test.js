import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../server.js";
import { searchMatches, searchTicketBody, ticketBodyOffset } from "../src/doc.js";
import { composeTicket } from "../src/ticket.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "cli.js");

function ticketText(id, fields) {
  return composeTicket({
    id,
    title: fields.title,
    state: fields.state || "new",
    type: "task",
    priority: "medium",
    assignee: fields.assignee || "",
    parent: "",
    depends: [],
    reporter: "qa",
    created: fields.created,
    body: fields.body,
  });
}

test("search matches two hits, a longer alternative, aa in aaa, a plus, and a ticket body offset", () => {
  assert.deepEqual(searchMatches("cat and cat", "cat"), [
    { start: 0, end: 3 },
    { start: 8, end: 11 },
  ]);
  assert.deepEqual(searchMatches("catalog", "cat"), [{ start: 0, end: 3 }]);
  assert.deepEqual(searchMatches("aaa", "aa|a"), [
    { start: 0, end: 2 },
    { start: 2, end: 3 },
  ]);
  assert.deepEqual(searchMatches("aaa", "aa"), [{ start: 0, end: 2 }]);
  assert.deepEqual(searchMatches("xxaaaayy", "a+"), [{ start: 2, end: 6 }]);
  assert.deepEqual(searchMatches("alpha", "Alpha"), []);
  assert.deepEqual(searchMatches("a\nb", "^b"), []);
  assert.deepEqual(searchMatches("", ""), []);
  assert.deepEqual(searchMatches("abc", ""), []);
  assert.equal(searchMatches("abc", "["), null);
  assert.equal(searchMatches("abc", 1), null);
  assert.deepEqual(searchMatches("ab", "(?=a)"), []);

  const body = "before Needle after Needle";
  const file = ticketText("abcd2345", {
    title: "Quiet",
    created: "2026-01-01T00:00:00.000Z",
    body,
  });
  const base = ticketBodyOffset(file);
  assert.ok(base > 0);
  assert.equal(file.slice(base), body);
  assert.equal(file.slice(0, base).includes("Needle"), false);
  const first = body.indexOf("Needle");
  const second = body.lastIndexOf("Needle");
  assert.deepEqual(searchTicketBody(file, "Needle"), [
    { start: base + first, end: base + first + "Needle".length },
    { start: base + second, end: base + second + "Needle".length },
  ]);
});

function run(args, extraEnv = {}) {
  const env = { ...process.env };
  delete env.VIEWMARK_USER;
  delete env.VIEWMARK_PORT;
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.stdin.on("error", () => {});
    child.stdin.end();
    child.on("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
    server.closeAllConnections();
  });
}

function messageText(data) {
  if (typeof data === "string") return Promise.resolve(data);
  if (Buffer.isBuffer(data)) return Promise.resolve(data.toString("utf8"));
  if (data instanceof ArrayBuffer) return Promise.resolve(Buffer.from(data).toString("utf8"));
  if (ArrayBuffer.isView(data)) {
    return Promise.resolve(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8"));
  }
  if (data && typeof data.text === "function") return data.text();
  return Promise.resolve(null);
}

function connect(port, username) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
  const queue = [];
  const waiters = [];
  let chain = Promise.resolve();
  ws.addEventListener("message", (ev) => {
    chain = chain.then(async () => {
      const text = await messageText(ev.data);
      const msg = JSON.parse(text);
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", username }));
        return;
      }
      queue.push(msg);
      drain();
    });
  });
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
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("websocket failed")));
  });
  return {
    ws,
    ready,
    next,
    send(obj) {
      ws.send(JSON.stringify(obj));
    },
  };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function trap() {
  const hits = [];
  const server = net.createServer((sock) => {
    hits.push(1);
    sock.destroy();
  });
  return listen(server).then(() => ({
    port: server.address().port,
    hits,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  }));
}

test("search rejects a bad pattern and a bad invocation without a socket", async () => {
  const gate = await trap();
  try {
    const bad = await run(["--port", String(gate.port), "--user", "user", "--repo", "docs", "search", "--docs", "["]);
    assert.equal(bad.code, 400 & 0xff);
    assert.equal(bad.stdout, "");
    assert.equal(bad.stderr, "error 400\ninvalid pattern\n");
    const cases = [
      [["--user", "user", "search", "--docs", "a"], "--repo is required"],
      [["--port", String(gate.port), "--user", "user", "--repo", "docs", "search"], "search takes one of --docs or --tickets"],
      [["--port", String(gate.port), "--user", "user", "--repo", "docs", "search", "--docs", "--tickets", "a"], "search takes one of --docs or --tickets"],
      [["--port", String(gate.port), "--user", "user", "--repo", "docs", "search", "--docs"], "query required"],
      [["--port", String(gate.port), "--user", "user", "--repo", "docs", "search", "--docs", "a", "b"], "unexpected argument"],
      [["--port", String(gate.port), "--user", "user", "--repo", "docs", "search", "--docs=foo"], "unknown argument"],
      [["--port", String(gate.port), "--user", "user", "--repo", "docs", "list", "--docs"], "unexpected flag"],
      [["--port", String(gate.port), "--user", "user", "--repo", "docs", "search", "--closed", "--docs", "a"], "unexpected flag"],
      [["--port", String(gate.port), "serve", "--docs"], "unexpected flag"],
    ];
    for (const [args, message] of cases) {
      const res = await run(args, { VIEWMARK_PORT: String(gate.port) });
      assert.equal(res.code, 2, args.join(" "));
      assert.equal(res.stdout, "", args.join(" "));
      assert.equal(res.stderr, `viewmark: ${message}\n`, args.join(" "));
    }
    assert.equal(gate.hits.length, 0);
  } finally {
    await gate.close();
  }
});

test("search lists docs and tickets from the open repo", async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-search-state-"));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-search-"));
  const server = await start(0, state);
  const port = server.address().port;
  let held = null;
  try {
    await fs.mkdir(path.join(dir, "notes"));
    await fs.mkdir(path.join(dir, "catalog"));
    await fs.mkdir(path.join(dir, "tickets"));
    await fs.writeFile(path.join(dir, "a.md"), "cat one\ncat two\n");
    await fs.writeFile(path.join(dir, "b.md"), "other\n");
    await fs.writeFile(path.join(dir, "case.md"), "alpha\n");
    await fs.writeFile(path.join(dir, "fenced.md"), "note {c7} here\n");
    await fs.writeFile(path.join(dir, "gap.md"), "a   b\n");
    await fs.writeFile(path.join(dir, "shot.md"), "![alt](cat-picture.png)\n\n```mermaid\ncat diagram\n```\n");
    await fs.writeFile(path.join(dir, "plain.md"), "# catalog page\n\nnope\n");
    await fs.writeFile(path.join(dir, "notes", "catalog.md"), "nope\n");
    await fs.writeFile(path.join(dir, "notes", "welcome.md"), "# Welcome\n\nnope\n");
    await fs.writeFile(path.join(dir, "notes", "other.md"), "nope\n");
    await fs.writeFile(path.join(dir, "catalog", "notes.md"), "nope\n");
    await fs.writeFile(path.join(dir, "secret.md"), "hidden phrase\n");
    await fs.writeFile(path.join(dir, "skip.txt"), "cat\n");
    const tickets = [
      ["wxyz2345", { title: "needle title", created: "2026-01-01T00:00:00.000Z", body: "plain\n" }],
      ["abcd2345", { title: "Quiet", created: "2026-02-02T00:00:00.000Z", body: "body needle\n" }],
      ["efgh6789", { title: "closed needle", created: "2026-03-03T00:00:00.000Z", body: "nope\n", state: "closed" }],
      ["mnprstuv", {
        title: "Miss",
        created: "2099-01-02T03:04:05.006Z",
        body: "nope\n",
        state: "blocked",
        assignee: "zzuniqueassignee",
      }],
      ["cache234", {
        title: "Cached title",
        created: "2026-05-05T00:00:00.000Z",
        body: "cached-needle\n",
        assignee: "onlyheader",
      }],
    ];
    for (const [id, fields] of tickets) {
      await fs.writeFile(path.join(dir, "tickets", `${id}.md`), ticketText(id, fields));
    }
    await fs.symlink("abcd2345.md", path.join(dir, "tickets", "sym2345k.md"));

    const registrar = connect(port, "fixture");
    await registrar.ready;
    registrar.send({ type: "hello", username: "fixture" });
    registrar.send({ type: "repo.register", username: "fixture", name: "docs", description: "Docs", path: dir });
    const registered = await registrar.next((item) => item.type === "repos" || item.type === "error");
    assert.equal(registered.type, "repos");
    registrar.ws.close();

    const args = ["--port", String(port), "--user", "user", "--repo", "docs", "search"];
    const cat = await run([...args, "--docs", "cat"]);
    assert.equal(cat.code, 0, cat.stderr);
    assert.equal(cat.stderr, "");
    assert.equal(cat.stdout, "a.md\ncatalog/notes.md\nnotes/catalog.md\nplain.md\nshot.md\n");

    const anchored = await run([...args, "--docs", "^catalog"]);
    assert.equal(anchored.code, 0, anchored.stderr);
    assert.equal(anchored.stdout, "catalog/notes.md\nnotes/catalog.md\nplain.md\n");

    const fence = await run([...args, "--docs", "c7"]);
    assert.equal(fence.stdout, "fenced.md\n");
    const picture = await run([...args, "--docs", "cat-picture"]);
    assert.equal(picture.stdout, "shot.md\n");
    const lower = await run([...args, "--docs", "alpha"]);
    assert.equal(lower.stdout, "case.md\n");
    const upper = await run([...args, "--docs", "Alpha"]);
    assert.equal(upper.code, 0, upper.stderr);
    assert.equal(upper.stdout, "");
    const spaces = await run([...args, "--docs", "   "]);
    assert.equal(spaces.stdout, "gap.md\n");
    const empty = await run([...args, "--docs", ""]);
    assert.equal(empty.code, 0, empty.stderr);
    assert.equal(empty.stdout, "");
    const json = await run(["--port", String(port), "--user", "user", "--json", "--repo", "docs", "search", "--docs", "cat"]);
    assert.equal(json.code, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), {
      paths: ["a.md", "catalog/notes.md", "notes/catalog.md", "plain.md", "shot.md"],
    });

    const needle = await run([...args, "--tickets", "needle"]);
    assert.equal(needle.code, 0, needle.stderr);
    assert.equal(needle.stdout, "tickets/wxyz2345.md\ntickets/abcd2345.md\ntickets/efgh6789.md\ntickets/cache234.md\n");
    const title = await run([...args, "--tickets", "needle title"]);
    assert.equal(title.stdout, "tickets/wxyz2345.md\n");
    const body = await run([...args, "--tickets", "body needle"]);
    assert.equal(body.stdout, "tickets/abcd2345.md\n");
    assert.equal((await run([...args, "--tickets", "zzuniqueassignee"])).stdout, "");
    assert.equal((await run([...args, "--tickets", "2099-01-02T03:04:05.006Z"])).stdout, "");
    assert.equal((await run([...args, "--tickets", "blocked"])).stdout, "");
    assert.equal((await run([...args, "--tickets", "medium"])).stdout, "");
    assert.equal((await run([...args, "--docs", "needle"])).stdout, "");
    assert.equal((await run([...args, "--tickets", "cat"])).stdout, "");
    assert.equal((await run([...args, "--tickets", "sym2345k"])).stdout, "");

    const bare = connect(port, "user");
    await bare.ready;
    bare.send({ type: "hello", username: "user" });
    await bare.next((item) => item.type === "hello");
    bare.send({ type: "search", username: "user", kind: "docs", query: "cat" });
    const noRepo = await bare.next((item) => item.type === "error" || item.type === "search");
    assert.equal(noRepo.type, "error");
    assert.equal(noRepo.status, 400);
    bare.send({ type: "repo", username: "user", name: "docs" });
    bare.send({ type: "search", username: "user", kind: "nope", query: "cat" });
    const badKind = await bare.next((item) => item.type === "error");
    assert.equal(badKind.status, 400);
    bare.send({ type: "search", username: "user", kind: "docs", query: "[" });
    const invalid = await bare.next((item) => item.type === "error" && item.reason === "invalid pattern");
    assert.equal(invalid.status, 400);
    assert.equal(invalid.paths, undefined);
    bare.send({ type: "search", username: "user", kind: "docs", query: "" });
    const none = await bare.next((item) => item.type === "search" && item.query === "");
    assert.deepEqual(none.paths, []);
    assert.equal(none.kind, "docs");
    bare.ws.close();

    held = connect(port, "user");
    await held.ready;
    held.send({ type: "hello", username: "user" });
    await held.next((item) => item.type === "hello");
    held.send({ type: "repo", username: "user", name: "docs" });
    held.send({ type: "open", username: "user", path: "tickets/cache234.md" });
    const opened = await held.next((item) => item.type === "file" && item.path === "tickets/cache234.md");
    assert.equal(opened.text, "cached-needle\n");
    assert.equal(opened.ticket.title, "Cached title");
    await fs.writeFile(path.join(dir, "tickets", "cache234.md"), ticketText("cache234", {
      title: "Disk only title",
      created: "2026-05-05T00:00:00.000Z",
      body: "diskonlyphrase\n",
      assignee: "onlyheader",
    }));
    assert.equal((await run([...args, "--tickets", "Cached title"])).stdout, "tickets/cache234.md\n");
    assert.equal((await run([...args, "--tickets", "cached-needle"])).stdout, "tickets/cache234.md\n");
    assert.equal((await run([...args, "--tickets", "onlyheader"])).stdout, "");
    assert.equal((await run([...args, "--tickets", "diskonlyphrase"])).stdout, "");
    assert.equal((await run([...args, "--tickets", "Disk only title"])).stdout, "");

    if (typeof process.getuid === "function" && process.getuid() !== 0) {
      await fs.chmod(path.join(dir, "secret.md"), 0);
      assert.equal((await run([...args, "--docs", "hidden phrase"])).stdout, "");
      assert.equal((await run([...args, "--docs", "secret"])).stdout, "secret.md\n");
      await fs.chmod(path.join(dir, "secret.md"), 0o644);
    }
  } finally {
    if (held) held.ws.close();
    await closeServer(server);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(state, { recursive: true, force: true });
  }
});
