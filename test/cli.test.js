import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { start } from "../server.js";
import { acceptKey, createParser, encodeFrame } from "../src/ws.js";
import { composeTicket, parseTicket } from "../src/ticket.js";
import { validUsername } from "../cli.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "cli.js");
const HELLO = "hello line\nsecond line\n";
const DRAFT = "a draft\n";

const HELP_NEEDLES = [
  "list",
  "show",
  "create",
  "edit",
  "--rev",
  "--find",
  "--replace",
  "one copy-paste edit",
  "stdout",
  "stderr",
  "rev N",
  "rev 0",
  "conflict",
  "matches N",
  "error STATUS",
  "{files}",
  "{path,rev,text}",
  "{path,rev:0}",
  "A stale rev exits 409 and does not write.",
  "ticket list",
  "ticket show",
  "ticket create",
  "ticket set",
  "ticket purge",
  "--title",
  "--state",
  "--parent",
  "--depends",
  "--closed",
  "reporter",
];

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

async function withDocs(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-cli-"));
  await fs.mkdir(path.join(dir, "notes"));
  await fs.writeFile(path.join(dir, "hello.md"), HELLO);
  await fs.writeFile(path.join(dir, "notes", "draft.md"), DRAFT);
  await fs.writeFile(path.join(dir, "skip.txt"), "nope\n");
  const server = await start(0, dir);
  try {
    await fn({ dir, port: server.address().port });
  } finally {
    await closeServer(server);
    await fs.rm(dir, { recursive: true, force: true });
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

async function commitWithin(dir, ms = 3000) {
  const deadline = Date.now() + ms;
  let last = new Error("no commit");
  while (Date.now() < deadline) {
    try {
      return await git(dir, ["log", "-1", "--format=%an%n%ae%n%s"]);
    } catch (err) {
      last = err;
      await delay(20);
    }
  }
  throw last;
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
    queue,
    ready,
    next,
    send(obj) {
      ws.send(JSON.stringify(obj));
    },
  };
}

async function hello(port, username) {
  const client = connect(port, username);
  await client.ready;
  client.send({ type: "hello", username });
  return client;
}

async function openDoc(client, username, rel) {
  client.send({ type: "open", username, path: rel });
  return client.next((msg) => msg.type === "file" && msg.path === rel);
}

// POSIX keeps the low 8 bits of process.exit.
function shellStatus(status) {
  return status & 0xff;
}

function sawOwnEdit(queue, username) {
  return queue.some((msg) => {
    if (msg.type === "doc") return true;
    if (msg.type !== "locks" || !Array.isArray(msg.lines)) return false;
    return msg.lines.some((line) => line && line.username === username);
  });
}

function assertHelp(text) {
  for (const needle of HELP_NEEDLES) assert.ok(text.includes(needle), needle);
  for (const code of ["0", "1", "2", "144", "148", "153", "400", "404", "409"]) {
    assert.match(text, new RegExp(`(^|[\\s:,])${code}(?![0-9])`, "m"));
  }
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

test("T-cli-help", async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.bin.viewmark, "./cli.js");
  assert.equal(pkg.dependencies, undefined);
  const source = await fs.readFile(cli, "utf8");
  assert.ok(source.startsWith("#!/usr/bin/env node\n"));

  const gate = await trap();
  try {
    const invocations = [
      [],
      ["--help"],
      ["help"],
      ["help", "edit"],
      ["edit", "--help"],
      ["--help", "edit"],
      ["show", "--help"],
    ];
    for (const args of invocations) {
      const res = await run(args, { VIEWMARK_PORT: String(gate.port), VIEWMARK_USER: "user" });
      assert.equal(res.code, 0, args.join(" "));
      assert.equal(res.stderr, "");
      assertHelp(res.stdout);
    }
    assert.equal(gate.hits.length, 0);

    const unknown = await run(["nope", "--user", "user", "--port", String(gate.port)]);
    assert.equal(unknown.code, 2);
    assert.equal(gate.hits.length, 0);
    const extra = await run(["list", "extra", "--user", "user", "--port", String(gate.port)]);
    assert.equal(extra.code, 2);
    assert.equal(gate.hits.length, 0);
  } finally {
    await gate.close();
  }
});

test("T-cli-list", async () => {
  await withDocs(async ({ port }) => {
    const res = await run(["--port", String(port), "--user", "user", "list"]);
    assert.equal(res.code, 0);
    assert.equal(res.stderr, "");
    assert.equal(res.stdout, "hello.md\nnotes/draft.md\n");

    const json = await run(["--json", "list"], { VIEWMARK_PORT: String(port), VIEWMARK_USER: "user" });
    assert.equal(json.code, 0);
    assert.equal(json.stderr, "");
    assert.equal(json.stdout, `${JSON.stringify({ files: ["hello.md", "notes/draft.md"] })}\n`);

    const flagged = await run(["--port", String(port), "--user", "user", "list"], { VIEWMARK_PORT: "1" });
    assert.equal(flagged.code, 0);
    assert.equal(flagged.stdout, "hello.md\nnotes/draft.md\n");
  });
});

test("T-cli-show", async () => {
  await withDocs(async ({ dir, port }) => {
    const watcher = await hello(port, "watch");
    await openDoc(watcher, "watch", "hello.md");
    const shown = await run(["--port", String(port), "--user", "user", "show", "hello.md"]);
    assert.equal(shown.code, 0);
    assert.equal(shown.stdout, HELLO);
    assert.equal(shown.stderr, "rev 0\n");
    const nested = await run(["--port", String(port), "--user", "user", "show", "notes/draft.md"]);
    assert.equal(nested.code, 0);
    assert.equal(nested.stdout, DRAFT);
    assert.equal(nested.stderr, "rev 0\n");
    await delay(100);
    assert.equal(sawOwnEdit(watcher.queue, "user"), false);

    const json = await run(["show", "hello.md", "--json", "--port", String(port), "--user", "user"]);
    assert.equal(json.code, 0);
    assert.equal(json.stderr, "");
    assert.equal(json.stdout, `${JSON.stringify({ path: "hello.md", rev: 0, text: HELLO })}\n`);

    const slash = await run(["--port", String(port), "--user", "user", "show", "/hello.md"]);
    assert.equal(slash.code, shellStatus(404));
    assert.equal(slash.stdout, "");
    assert.equal(slash.stderr, "error 404\n");
    const missing = await run(["--json", "--port", String(port), "--user", "user", "show", "missing.md"]);
    assert.equal(missing.code, shellStatus(404));
    assert.equal(missing.stdout, "");
    assert.equal(missing.stderr, "error 404\n");
    await assert.rejects(() => git(dir, ["rev-parse", "HEAD"]));
    watcher.ws.close();
  });
});

test("T-cli-create", async () => {
  const gate = await trap();
  try {
    for (const pathArg of ["", "   ", "/", "///"]) {
      const empty = await run(["--port", String(gate.port), "--user", "user", "create", pathArg]);
      assert.equal(empty.code, 2, JSON.stringify(pathArg));
    }
    assert.equal(gate.hits.length, 0);
  } finally {
    await gate.close();
  }

  await withDocs(async ({ dir, port }) => {
    const created = await run(["--port", String(port), "--user", "user", "create", "notes/idea"]);
    assert.equal(created.code, 0);
    assert.equal(created.stdout, "notes/idea.md\n");
    assert.equal(created.stderr, "rev 0\n");
    assert.equal(await fs.readFile(path.join(dir, "notes", "idea.md"), "utf8"), "");

    const again = await run(["--port", String(port), "--user", "user", "create", "notes/idea"]);
    assert.equal(again.code, shellStatus(409));
    assert.equal(again.stdout, "");
    assert.equal(again.stderr, "error 409\n");
    assert.equal(await fs.readFile(path.join(dir, "notes", "idea.md"), "utf8"), "");

    const nope = await run(["--port", String(port), "--user", "user", "create", "../nope"]);
    assert.equal(nope.code, shellStatus(404));
    assert.equal(nope.stdout, "");
    assert.equal(nope.stderr, "error 404\n");
    await assert.rejects(() => fs.lstat(path.join(dir, "nope.md")));
    await assert.rejects(() => git(dir, ["rev-parse", "HEAD"]));

    const trimmed = await run(["--port", String(port), "--user", "user", "create", "  /notes/next  "]);
    assert.equal(trimmed.code, 0);
    assert.equal(trimmed.stdout, "notes/next.md\n");
    assert.equal(trimmed.stderr, "rev 0\n");
    assert.equal(await fs.readFile(path.join(dir, "notes", "next.md"), "utf8"), "");

    const markdown = await run(["--json", "--port", String(port), "--user", "user", "create", "notes/keep.markdown"]);
    assert.equal(markdown.code, 0);
    assert.equal(markdown.stderr, "");
    assert.equal(markdown.stdout, `${JSON.stringify({ path: "notes/keep.markdown", rev: 0 })}\n`);
    assert.equal(await fs.readFile(path.join(dir, "notes", "keep.markdown"), "utf8"), "");
    await assert.rejects(() => git(dir, ["rev-parse", "HEAD"]));
  });
});

test("T-cli-edit", async () => {
  const gate = await trap();
  try {
    const missing = await run([
      "--port", String(gate.port),
      "--user", "user",
      "edit",
      "hello.md",
      "--find", "hello",
      "--replace", "hi",
    ]);
    assert.equal(missing.code, 2);
    const emptyFind = await run([
      "--port", String(gate.port),
      "--user", "user",
      "edit",
      "hello.md",
      "--rev", "0",
      "--find", "",
      "--replace", "hi",
    ]);
    assert.equal(emptyFind.code, 2);
    const badRev = await run([
      "--port", String(gate.port),
      "--user", "user",
      "edit",
      "hello.md",
      "--rev", "1.5",
      "--find", "hello",
      "--replace", "hi",
    ]);
    assert.equal(badRev.code, 2);
    assert.equal(gate.hits.length, 0);
  } finally {
    await gate.close();
  }

  await withDocs(async ({ dir, port }) => {
    const edited = await run([
      "--port", String(port),
      "--user", "user",
      "edit",
      "notes/draft.md",
      "--rev", "0",
      "--find", "a draft",
      "--replace", "a note",
    ]);
    assert.equal(edited.code, 0);
    assert.equal(edited.stdout, "a note\n");
    assert.equal(edited.stderr, "rev 1\n");
    assert.equal(await fs.readFile(path.join(dir, "notes", "draft.md"), "utf8"), "a note\n");
    const started = Date.now();
    const log = await commitWithin(dir, 3000);
    assert.ok(Date.now() - started <= 3000);
    assert.equal(log, "user\nuser@viewmark.local\nEdit notes/draft.md\n");
    assert.equal(await git(dir, ["show", "HEAD:notes/draft.md"]), "a note\n");

    const cleared = await run([
      "--port", String(port),
      "--user", "user",
      "edit",
      "hello.md",
      "--rev", "0",
      "--find", "second ",
      "--replace=",
    ]);
    assert.equal(cleared.code, 0);
    assert.equal(cleared.stdout, "hello line\nline\n");
    assert.equal(cleared.stderr, "rev 1\n");
    assert.equal(await fs.readFile(path.join(dir, "hello.md"), "utf8"), "hello line\nline\n");

    await fs.writeFile(path.join(dir, "overlap.md"), "aaa\n");
    const once = await run([
      "--json",
      "--port", String(port),
      "--user", "user",
      "edit",
      "overlap.md",
      "--rev", "0",
      "--find", "aa",
      "--replace", "b",
    ]);
    assert.equal(once.code, 0);
    assert.equal(once.stderr, "");
    assert.equal(once.stdout, `${JSON.stringify({ path: "overlap.md", rev: 1, text: "ba\n" })}\n`);
    assert.equal(await fs.readFile(path.join(dir, "overlap.md"), "utf8"), "ba\n");

    const absent = await run([
      "--port", String(port),
      "--user", "user",
      "edit",
      "missing.md",
      "--rev", "0",
      "--find", "a",
      "--replace", "b",
    ]);
    assert.equal(absent.code, shellStatus(404));
    assert.equal(absent.stdout, "");
    assert.equal(absent.stderr, "error 404\n");
  });
});

test("T-cli-stale", async () => {
  await withDocs(async ({ dir, port }) => {
    const stale = await run([
      "--port", String(port),
      "--user", "user",
      "edit",
      "hello.md",
      "--rev", "4",
      "--find", "line",
      "--replace", "row",
    ]);
    assert.equal(stale.code, shellStatus(409));
    assert.equal(stale.stdout, HELLO);
    assert.equal(stale.stderr, "rev 0\nconflict\n");
    assert.equal(await fs.readFile(path.join(dir, "hello.md"), "utf8"), HELLO);

    const json = await run([
      "--json",
      "--port", String(port),
      "--user", "user",
      "edit",
      "hello.md",
      "--rev", "4",
      "--find", "line",
      "--replace", "row",
    ]);
    assert.equal(json.code, shellStatus(409));
    assert.equal(json.stderr, "");
    assert.equal(
      json.stdout,
      `${JSON.stringify({ path: "hello.md", rev: 0, text: HELLO, error: "conflict" })}\n`,
    );

    const holder = await hello(port, "holder");
    const opened = await openDoc(holder, "holder", "notes/draft.md");
    holder.send({
      type: "lock",
      username: "holder",
      path: "notes/draft.md",
      anchor: 0,
      cursor: opened.text.length,
      rev: opened.rev,
    });
    await holder.next((msg) => msg.type === "locks" && msg.path === "notes/draft.md");
    const later = await run([
      "--port", String(port),
      "--user", "other",
      "edit",
      "notes/draft.md",
      "--rev", "0",
      "--find", "draft",
      "--replace", "nope",
    ]);
    assert.equal(later.code, shellStatus(409));
    assert.equal(later.stdout, DRAFT);
    assert.equal(later.stderr, "rev 0\nconflict\n");
    assert.equal(await fs.readFile(path.join(dir, "notes", "draft.md"), "utf8"), DRAFT);

    const laterJson = await run([
      "--json",
      "--port", String(port),
      "--user", "other",
      "edit",
      "notes/draft.md",
      "--rev", "0",
      "--find", "draft",
      "--replace", "nope",
    ]);
    assert.equal(laterJson.code, shellStatus(409));
    assert.equal(laterJson.stderr, "");
    assert.equal(
      laterJson.stdout,
      `${JSON.stringify({ path: "notes/draft.md", rev: 0, text: DRAFT, error: "conflict" })}\n`,
    );
    assert.equal(await fs.readFile(path.join(dir, "notes", "draft.md"), "utf8"), DRAFT);
    await assert.rejects(() => git(dir, ["rev-parse", "HEAD"]));
    holder.ws.close();
  });
});

test("T-cli-matches", async () => {
  await withDocs(async ({ dir, port }) => {
    const watcher = await hello(port, "watch");
    await openDoc(watcher, "watch", "hello.md");
    const none = await run([
      "--port", String(port),
      "--user", "user",
      "edit",
      "hello.md",
      "--rev", "0",
      "--find", "missing",
      "--replace", "x",
    ]);
    assert.equal(none.code, 2);
    assert.equal(none.stdout, "");
    assert.equal(none.stderr, "matches 0\n");
    const many = await run([
      "--port", String(port),
      "--user", "user",
      "edit",
      "hello.md",
      "--rev", "0",
      "--find", "line",
      "--replace", "row",
    ]);
    assert.equal(many.code, 2);
    assert.equal(many.stdout, "");
    assert.equal(many.stderr, "matches 2\n");
    await delay(100);
    assert.equal(sawOwnEdit(watcher.queue, "user"), false);
    assert.equal(await fs.readFile(path.join(dir, "hello.md"), "utf8"), HELLO);

    await fs.writeFile(path.join(dir, "quad.md"), "aaaa\n");
    const overlap = await run([
      "--port", String(port),
      "--user", "user",
      "edit",
      "quad.md",
      "--rev", "0",
      "--find", "aa",
      "--replace", "b",
    ]);
    assert.equal(overlap.code, 2);
    assert.equal(overlap.stderr, "matches 2\n");
    assert.equal(await fs.readFile(path.join(dir, "quad.md"), "utf8"), "aaaa\n");
    await assert.rejects(() => git(dir, ["rev-parse", "HEAD"]));
    watcher.ws.close();
  });
});

test("T-cli-noop", async () => {
  await withDocs(async ({ dir, port }) => {
    const watcher = await hello(port, "watch");
    await openDoc(watcher, "watch", "hello.md");
    const same = await run([
      "--port", String(port),
      "--user", "user",
      "edit",
      "hello.md",
      "--rev", "0",
      "--find", "hello",
      "--replace", "hello",
    ]);
    assert.equal(same.code, 0);
    assert.equal(same.stdout, HELLO);
    assert.equal(same.stderr, "rev 0\n");
    const json = await run([
      "--json",
      "--port", String(port),
      "--user", "user",
      "edit",
      "hello.md",
      "--rev", "0",
      "--find", "hello",
      "--replace", "hello",
    ]);
    assert.equal(json.code, 0);
    assert.equal(json.stderr, "");
    assert.equal(json.stdout, `${JSON.stringify({ path: "hello.md", rev: 0, text: HELLO })}\n`);
    await delay(100);
    assert.equal(sawOwnEdit(watcher.queue, "user"), false);
    assert.equal(await fs.readFile(path.join(dir, "hello.md"), "utf8"), HELLO);
    await assert.rejects(() => git(dir, ["rev-parse", "HEAD"]));

    const many = await run([
      "--port", String(port),
      "--user", "user",
      "edit",
      "hello.md",
      "--rev", "0",
      "--find", "line",
      "--replace", "line",
    ]);
    assert.equal(many.code, 2);
    assert.equal(many.stderr, "matches 2\n");
    const absent = await run([
      "--port", String(port),
      "--user", "user",
      "edit",
      "hello.md",
      "--rev", "0",
      "--find", "zzz",
      "--replace", "zzz",
    ]);
    assert.equal(absent.code, 2);
    assert.equal(absent.stderr, "matches 0\n");
    assert.equal(await fs.readFile(path.join(dir, "hello.md"), "utf8"), HELLO);
    watcher.ws.close();
  });
});

test("T-cli-user", async () => {
  assert.equal(validUsername("a\0b"), false);
  assert.equal(validUsername(""), false);
  assert.equal(validUsername("ada"), true);

  const gate = await trap();
  try {
    const cases = [
      ["list", "--port", String(gate.port)],
      ["list", "--port", String(gate.port), "--user", ""],
      ["list", "--port", String(gate.port), "--user", "a<b"],
      ["list", "--port", String(gate.port), "--user", "a>b"],
      ["list", "--port", String(gate.port), "--user", "a\nb"],
      ["list", "--port", String(gate.port), "--user", "a\rb"],
    ];
    for (const args of cases) {
      const started = Date.now();
      const res = await run(args);
      assert.equal(res.code, 2, args.join(" "));
      assert.ok(Date.now() - started < 1000);
    }
    const fromEnv = await run(["list", "--port", String(gate.port)], { VIEWMARK_USER: "a<b" });
    assert.equal(fromEnv.code, 2);
    const emptyEnv = await run(["list", "--port", String(gate.port)], { VIEWMARK_USER: "" });
    assert.equal(emptyEnv.code, 2);
    const flagWinsInvalid = await run(["list", "--port", String(gate.port), "--user", ""], {
      VIEWMARK_USER: "user",
    });
    assert.equal(flagWinsInvalid.code, 2);
    assert.equal(gate.hits.length, 0);

    const closed = gate.port;
    await gate.close();
    const deadStarted = Date.now();
    const dead = await run(["--port", String(closed), "--user", "user", "list"]);
    assert.equal(dead.code, 1);
    assert.equal(dead.stderr, "");
    assert.ok(Date.now() - deadStarted < 4000);
  } catch (err) {
    gate.close();
    throw err;
  }

  await withDocs(async ({ dir, port }) => {
    const fromEnv = await run(
      ["--port", String(port), "edit", "hello.md", "--rev", "0", "--find", "hello", "--replace", "howdy"],
      { VIEWMARK_USER: "envuser" },
    );
    assert.equal(fromEnv.code, 0);
    assert.equal(fromEnv.stdout, "howdy line\nsecond line\n");
    assert.equal(await commitWithin(dir, 3000), "envuser\nenvuser@viewmark.local\nEdit hello.md\n");

    const flagged = await run(
      [
        "--user", "flaguser",
        "--port", String(port),
        "edit", "notes/draft.md",
        "--rev", "0",
        "--find", "a draft",
        "--replace", "flagged",
      ],
      { VIEWMARK_USER: "envuser" },
    );
    assert.equal(flagged.code, 0);
    assert.equal(flagged.stdout, "flagged\n");
    const deadline = Date.now() + 3000;
    let log = "";
    while (Date.now() < deadline) {
      log = await git(dir, ["log", "-1", "--format=%an%n%ae%n%s"]);
      if (log.startsWith("flaguser\n")) break;
      await delay(20);
    }
    assert.equal(log, "flaguser\nflaguser@viewmark.local\nEdit notes/draft.md\n");

    const shown = await run(["--port", String(port), "show", "notes/draft.md"], { VIEWMARK_USER: "a<b" });
    assert.equal(shown.code, 2);
    const override = await run(["--user", "user", "--port", String(port), "show", "notes/draft.md"], {
      VIEWMARK_USER: "a<b",
    });
    assert.equal(override.code, 0);
    assert.equal(override.stdout, "flagged\n");
  });
});

test("T-cli-user silence", { timeout: 20000 }, async () => {
  const messages = [];
  let peer = null;
  const server = http.createServer();
  server.on("upgrade", (req, socket) => {
    peer = socket;
    const key = req.headers["sec-websocket-key"];
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n` +
        "\r\n",
    );
    const parser = createParser({
      requireMask: true,
      onText(payload) {
        messages.push(JSON.parse(payload.toString("utf8")));
      },
      onPing(payload) {
        socket.write(encodeFrame(0xa, payload));
      },
      onClose() {
        socket.end();
      },
      onError() {
        socket.destroy();
      },
    });
    socket.on("data", (chunk) => parser.push(chunk));
    socket.on("error", () => {});
    socket.on("close", () => {
      if (peer === socket) peer = null;
    });
    setTimeout(() => {
      if (socket.destroyed) return;
      socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify({ type: "ping" }))));
    }, 50);
  });
  await listen(server);
  try {
    const started = Date.now();
    const res = await run(["--port", String(server.address().port), "--user", "user", "list"]);
    const elapsed = Date.now() - started;
    assert.equal(res.code, 1);
    assert.equal(res.stdout, "");
    assert.ok(elapsed >= 4500 && elapsed < 9000, String(elapsed));
    assert.deepEqual(messages.map((msg) => msg.type), ["hello", "list", "pong"]);
    assert.equal(messages[2].username, "user");
  } finally {
    peer?.destroy();
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});

const A = "aaaaaaaa";
const B = "bbbbbbbb";
const C = "cccccccc";
const D = "dddddddd";
const E = "eeeeeeee";
const Z = "zzzzzzzz";
const T0 = "2020-01-01T00:00:00.000Z";
const T1 = "2020-01-01T00:00:01.000Z";
const T2 = "2020-01-01T00:00:02.000Z";
const T3 = "2020-01-01T00:00:03.000Z";
const BODY = "Keep me\n\ntitle: not a header\n";

function ticketErr(fields, conflict = false) {
  const parent = fields.parent === "" ? "parent" : `parent ${fields.parent}`;
  const depends = fields.depends.length === 0 ? "depends" : `depends ${fields.depends.join(",")}`;
  const lines = [
    `rev ${fields.rev}`,
    `title ${fields.title}`,
    `state ${fields.state}`,
    parent,
    depends,
    `reporter ${fields.reporter}`,
    `created ${fields.created}`,
  ];
  if (conflict) lines.push("conflict");
  return `${lines.join("\n")}\n`;
}

function ticketJson(fields) {
  return {
    id: fields.id,
    path: fields.path,
    rev: fields.rev,
    title: fields.title,
    state: fields.state,
    parent: fields.parent,
    depends: fields.depends,
    reporter: fields.reporter,
    created: fields.created,
    text: fields.text,
  };
}

async function runFast(args, extraEnv) {
  const started = Date.now();
  const res = await run(args, extraEnv);
  assert.ok(Date.now() - started < 4000, `${args.join(" ")} took ${Date.now() - started}ms`);
  return res;
}

async function withHub(fn) {
  const server = await start(0);
  try {
    await fn({ dir: server.docsDir, port: server.address().port });
  } finally {
    await closeServer(server);
  }
}

async function writeTicket(dir, fields) {
  const text = composeTicket({
    parent: "",
    depends: [],
    body: "",
    reporter: "indexer",
    state: "new",
    ...fields,
  });
  assert.ok(text);
  await fs.mkdir(path.join(dir, "tickets"), { recursive: true });
  await fs.writeFile(path.join(dir, "tickets", `${fields.id}.md`), text);
  return text;
}

function ticketArgs(port, args, user = "user") {
  return ["--port", String(port), "--user", user, ...args];
}

async function assertNoTicketBroadcast(watcher) {
  watcher.send({ type: "list", username: "watch" });
  const next = await watcher.next((msg) => msg.type === "docs" || msg.type === "tickets" || msg.type === "ticket");
  assert.equal(next.type, "docs");
}

test("T-cli-ticket-list", async () => {
  const gate = await trap();
  try {
    const cases = [
      ["--port", String(gate.port), "ticket", "list"],
      ["--port", String(gate.port), "--user", "user", "ticket"],
      ["--port", String(gate.port), "--user", "user", "ticket", "nope"],
      ["--port", String(gate.port), "--user", "user", "ticket", "list", "extra"],
      ["--port", String(gate.port), "--user", "user", "ticket", "list", "--closed=yes"],
    ];
    for (const args of cases) {
      const res = await runFast(args);
      assert.equal(res.code, 2, args.join(" "));
      assert.equal(res.stdout, "");
    }
    assert.equal(gate.hits.length, 0);
  } finally {
    await gate.close();
  }

  await withHub(async ({ dir, port }) => {
    const empty = await runFast(ticketArgs(port, ["ticket", "list"]));
    assert.equal(empty.code, 0);
    assert.equal(empty.stdout, "");
    assert.equal(empty.stderr, "");
    const emptyJson = await runFast(["--json", ...ticketArgs(port, ["ticket", "list", "--closed"])]);
    assert.equal(emptyJson.code, 0);
    assert.equal(emptyJson.stderr, "");
    assert.equal(emptyJson.stdout, `${JSON.stringify({ tickets: [] })}\n`);

    await writeTicket(dir, { id: Z, title: "Has spaces", state: "in progress", created: T3 });
    await writeTicket(dir, { id: A, title: "Alpha", state: "closed", created: T0 });
    await writeTicket(dir, { id: B, title: "Beta", created: T0 });
    await writeTicket(dir, {
      id: C,
      title: "See",
      state: "triaged",
      parent: B,
      depends: [Z, A],
      created: T1,
      body: BODY,
    });

    const docs = await runFast(ticketArgs(port, ["list"]));
    assert.equal(docs.code, 0);
    assert.equal(docs.stdout, "");
    assert.equal(docs.stderr, "");

    const listed = await runFast(ticketArgs(port, ["ticket", "list"]));
    assert.equal(listed.code, 0);
    assert.equal(listed.stderr, "");
    assert.equal(listed.stdout, [
      `${B}\t${T0}\tnew\tBeta\n`,
      `${C}\t${T1}\ttriaged\tSee\n`,
      `${Z}\t${T3}\tin progress\tHas spaces\n`,
    ].join(""));

    const closed = await runFast(ticketArgs(port, ["--closed", "ticket", "list"]));
    assert.equal(closed.code, 0);
    assert.equal(closed.stderr, "");
    assert.equal(closed.stdout, [
      `${A}\t${T0}\tclosed\tAlpha\n`,
      `${B}\t${T0}\tnew\tBeta\n`,
      `${C}\t${T1}\ttriaged\tSee\n`,
      `${Z}\t${T3}\tin progress\tHas spaces\n`,
    ].join(""));

    const json = await runFast(["--json", ...ticketArgs(port, ["ticket", "list"])]);
    assert.equal(json.code, 0);
    assert.equal(json.stderr, "");
    const open = JSON.parse(json.stdout);
    assert.deepEqual(open, {
      tickets: [
        { id: B, title: "Beta", state: "new", parent: "", depends: [], reporter: "indexer", created: T0 },
        {
          id: C,
          title: "See",
          state: "triaged",
          parent: B,
          depends: [A, Z],
          reporter: "indexer",
          created: T1,
        },
        {
          id: Z,
          title: "Has spaces",
          state: "in progress",
          parent: "",
          depends: [],
          reporter: "indexer",
          created: T3,
        },
      ],
    });
    for (const ticket of open.tickets) {
      assert.deepEqual(Object.keys(ticket), ["id", "title", "state", "parent", "depends", "reporter", "created"]);
    }

    const all = await runFast(ticketArgs(port, ["ticket", "--json", "list", "--closed"]));
    assert.equal(all.stderr, "");
    const parsed = JSON.parse(all.stdout);
    assert.deepEqual(parsed.tickets.map((ticket) => ticket.id), [A, B, C, Z]);
    assert.equal(parsed.tickets[0].state, "closed");
    assert.deepEqual(parsed.tickets[1].depends, []);
    assert.deepEqual(parsed.tickets[2].depends, [A, Z]);
  });
});

test("T-cli-ticket-show", async () => {
  const gate = await trap();
  try {
    const cases = [
      ["ticket", "show"],
      ["ticket", "show", "ab"],
      ["ticket", "show", "iiiiiiii"],
      ["ticket", "show", "aaaaaaaaa"],
      ["ticket", "show", "AAAAAAAA"],
      ["ticket", "show", "tickets/aaaaaaaa.md"],
      ["ticket", "show", A, "extra"],
    ];
    for (const args of cases) {
      const res = await runFast(["--port", String(gate.port), "--user", "user", ...args]);
      assert.equal(res.code, 2, args.join(" "));
      assert.equal(res.stdout, "");
    }
    assert.equal(gate.hits.length, 0);
  } finally {
    await gate.close();
  }

  await withHub(async ({ dir, port }) => {
    const full = await writeTicket(dir, {
      id: C,
      title: "See",
      state: "triaged",
      parent: B,
      depends: [Z, A],
      created: T1,
      body: BODY,
    });
    await writeTicket(dir, { id: A, title: "Alpha", state: "closed", created: T0, body: "" });
    await fs.writeFile(path.join(dir, "tickets", "ffffffff.md"), "nope\n");

    const shown = await runFast(ticketArgs(port, ["ticket", "show", C]));
    assert.equal(shown.code, 0);
    assert.equal(shown.stdout, BODY);
    assert.notEqual(shown.stdout, full);
    assert.equal(shown.stderr, ticketErr({
      rev: 0,
      title: "See",
      state: "triaged",
      parent: B,
      depends: [A, Z],
      reporter: "indexer",
      created: T1,
    }));

    const empty = await runFast(ticketArgs(port, ["ticket", "show", A]));
    assert.equal(empty.code, 0);
    assert.equal(empty.stdout, "");
    assert.equal(empty.stderr, ticketErr({
      rev: 0,
      title: "Alpha",
      state: "closed",
      parent: "",
      depends: [],
      reporter: "indexer",
      created: T0,
    }));

    const json = await runFast(["--json", ...ticketArgs(port, ["ticket", "show", C])]);
    assert.equal(json.code, 0);
    assert.equal(json.stderr, "");
    const parsed = JSON.parse(json.stdout);
    assert.deepEqual(Object.keys(parsed), [
      "id", "path", "rev", "title", "state", "parent", "depends", "reporter", "created", "text",
    ]);
    assert.deepEqual(parsed, ticketJson({
      id: C,
      path: `tickets/${C}.md`,
      rev: 0,
      title: "See",
      state: "triaged",
      parent: B,
      depends: [A, Z],
      reporter: "indexer",
      created: T1,
      text: BODY,
    }));

    const missing = await runFast(ticketArgs(port, ["ticket", "show", D]));
    assert.equal(missing.code, shellStatus(404));
    assert.equal(missing.stdout, "");
    assert.equal(missing.stderr, "error 404\n");
    const missingJson = await runFast(["--json", ...ticketArgs(port, ["ticket", "show", D])]);
    assert.equal(missingJson.code, shellStatus(404));
    assert.equal(missingJson.stdout, "");
    assert.equal(missingJson.stderr, "error 404\n");
    const garbage = await runFast(ticketArgs(port, ["ticket", "show", "ffffffff"]));
    assert.equal(garbage.code, shellStatus(404));
    assert.equal(garbage.stdout, "");
    assert.equal(garbage.stderr, "error 404\n");
  });
});

test("T-cli-ticket-create", async () => {
  const gate = await trap();
  try {
    const cases = [
      ["ticket", "create"],
      ["ticket", "create", "--title", ""],
      ["ticket", "create", "--title", "   "],
      ["ticket", "create", "--title", "Hello", "--state", "done"],
      ["ticket", "create", "--title", "Hello", "--state", ""],
      ["ticket", "create", "--title", "Hello", "--state", " new"],
      ["ticket", "create", "--title", "Hello", "extra"],
      ["ticket", "create", "--state", "new"],
    ];
    for (const args of cases) {
      const res = await runFast(["--port", String(gate.port), "--user", "user", ...args]);
      assert.equal(res.code, 2, args.join(" "));
      assert.equal(res.stdout, "");
    }
    assert.equal(gate.hits.length, 0);
  } finally {
    await gate.close();
  }

  await withHub(async ({ dir, port }) => {
    const before = Date.now();
    const created = await runFast(ticketArgs(port, ["ticket", "create", "--title", "  Hello  "]));
    const after = Date.now();
    assert.equal(created.code, 0);
    assert.match(created.stdout, /^[23456789abcdefghjkmnpqrstuvwxyz]{8}\n$/);
    const id = created.stdout.trim();
    const lines = created.stderr.split("\n");
    assert.equal(lines[0], "rev 0");
    assert.equal(lines[1], "reporter user");
    assert.match(lines[2], /^created \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(lines[3], "");
    const stamp = lines[2].slice("created ".length);
    const stamped = Date.parse(stamp);
    assert.ok(stamped >= before && stamped <= after);
    const disk = parseTicket(id, await fs.readFile(path.join(dir, "tickets", `${id}.md`), "utf8"));
    assert.equal(disk.title, "Hello");
    assert.equal(disk.state, "new");
    assert.equal(disk.parent, "");
    assert.deepEqual(disk.depends, []);
    assert.equal(disk.reporter, "user");
    assert.equal(disk.created, stamp);
    assert.equal(disk.body, "");
    const shown = await runFast(ticketArgs(port, ["ticket", "show", id]));
    assert.equal(shown.stdout, "");
    assert.equal(shown.stderr, ticketErr({
      rev: 0,
      title: "Hello",
      state: "new",
      parent: "",
      depends: [],
      reporter: "user",
      created: stamp,
    }));

    const triaged = await runFast(ticketArgs(port, ["ticket", "create", "--title=Next", "--state=triaged"]));
    assert.equal(triaged.code, 0);
    assert.notEqual(triaged.stdout.trim(), id);
    const triagedId = triaged.stdout.trim();
    const triagedDisk = parseTicket(triagedId, await fs.readFile(path.join(dir, "tickets", `${triagedId}.md`), "utf8"));
    assert.equal(triagedDisk.title, "Next");
    assert.equal(triagedDisk.state, "triaged");
    assert.equal(triagedDisk.reporter, "user");

    const progress = await runFast(ticketArgs(port, ["ticket", "create", "--title", "Fix  the  login", "--state", "in progress"]));
    assert.equal(progress.code, 0);
    const progressId = progress.stdout.trim();
    const progressDisk = parseTicket(progressId, await fs.readFile(path.join(dir, "tickets", `${progressId}.md`), "utf8"));
    assert.equal(progressDisk.title, "Fix  the  login");
    assert.equal(progressDisk.state, "in progress");

    const closed = await runFast(ticketArgs(port, ["ticket", "create", "--title", "Done", "--state", "closed"]));
    assert.equal(closed.code, 0);
    const closedId = closed.stdout.trim();

    const listed = await runFast(ticketArgs(port, ["ticket", "list"]));
    assert.equal(listed.stderr, "");
    assert.equal(listed.stdout.includes(closedId), false);
    assert.equal(listed.stdout.includes(id), true);
    assert.equal(listed.stdout.includes(triagedId), true);
    assert.equal(listed.stdout.includes(progressId), true);
    const withClosed = await runFast(["--json", ...ticketArgs(port, ["ticket", "list", "--closed"])]);
    const all = JSON.parse(withClosed.stdout).tickets;
    assert.deepEqual(all.map((ticket) => ticket.id), [...all].sort((left, right) => {
      if (left.created < right.created) return -1;
      if (left.created > right.created) return 1;
      if (left.id < right.id) return -1;
      if (left.id > right.id) return 1;
      return 0;
    }).map((ticket) => ticket.id));
    assert.equal(all.find((ticket) => ticket.id === closedId).state, "closed");
    assert.equal(all.find((ticket) => ticket.id === id).title, "Hello");

    const jsonBefore = Date.now();
    const json = await runFast(["--json", ...ticketArgs(port, ["ticket", "create", "--title", "Json"])]);
    const jsonAfter = Date.now();
    assert.equal(json.code, 0);
    assert.equal(json.stderr, "");
    const parsed = JSON.parse(json.stdout);
    assert.deepEqual(Object.keys(parsed), ["id", "path", "rev", "reporter", "created"]);
    assert.equal(parsed.rev, 0);
    assert.equal(parsed.reporter, "user");
    assert.equal(parsed.path, `tickets/${parsed.id}.md`);
    assert.match(parsed.id, /^[23456789abcdefghjkmnpqrstuvwxyz]{8}$/);
    assert.ok(Date.parse(parsed.created) >= jsonBefore && Date.parse(parsed.created) <= jsonAfter);
    assert.equal(json.stdout, `${JSON.stringify(parsed)}\n`);

    const flagged = await runFast(
      ["--user", "flaguser", "--port", String(port), "ticket", "create", "--title", "Flagged"],
      { VIEWMARK_USER: "envuser" },
    );
    assert.equal(flagged.code, 0);
    assert.match(flagged.stderr, /^rev 0\nreporter flaguser\ncreated /);

    const fromEnv = await runFast(
      ["--port", String(port), "ticket", "create", "--title", "From env"],
      { VIEWMARK_USER: "envuser" },
    );
    assert.equal(fromEnv.code, 0);
    assert.match(fromEnv.stderr, /^rev 0\nreporter envuser\ncreated /);

    const count = async () => (await fs.readdir(path.join(dir, "tickets"))).length;
    const beforeCount = await count();
    const long = await runFast(["--json", ...ticketArgs(port, ["ticket", "create", "--title", "x".repeat(201)])]);
    assert.equal(long.code, shellStatus(400));
    assert.equal(long.stdout, "");
    assert.equal(long.stderr, "error 400\n");
    const tabbed = await runFast(ticketArgs(port, ["ticket", "create", "--title", "bad\ttitle"]));
    assert.equal(tabbed.code, shellStatus(400));
    assert.equal(tabbed.stdout, "");
    assert.equal(tabbed.stderr, "error 400\n");
    assert.equal(await count(), beforeCount);
    await assert.rejects(() => git(dir, ["rev-parse", "HEAD"]));
  });
});

test("T-cli-ticket-set", async () => {
  const gate = await trap();
  try {
    const cases = [
      ["ticket", "set", "short", "--rev", "0", "--title", "Hello"],
      ["ticket", "set", "iiiiiiii", "--rev", "0", "--title", "Hello"],
      ["ticket", "set", A, "--title", "Hello"],
      ["ticket", "set", A, "--rev", "1.5", "--title", "Hello"],
      ["ticket", "set", A, "--rev", "0"],
      ["ticket", "set", A, "--rev", "0", "--title", ""],
      ["ticket", "set", A, "--rev", "0", "--title", "   "],
      ["ticket", "set", A, "--rev", "0", "--state", "done"],
      ["ticket", "set", A, "--rev", "0", "--state", "closed "],
      ["ticket", "set", A, "--rev", "0", "--parent", "123"],
      ["ticket", "set", A, "--rev", "0", "--parent", "nonee"],
      ["ticket", "set", A, "--rev", "0", "--depends", ""],
      ["ticket", "set", A, "--rev", "0", "--depends", `${A},`],
      ["ticket", "set", A, "--rev", "0", "--depends", `${A},iiiiiiii`],
      ["ticket", "set", A, "extra", "--rev", "0", "--title", "Hello"],
    ];
    for (const args of cases) {
      const res = await runFast(["--port", String(gate.port), "--user", "user", ...args]);
      assert.equal(res.code, 2, args.join(" "));
      assert.equal(res.stdout, "");
    }
    assert.equal(gate.hits.length, 0);
  } finally {
    await gate.close();
  }

  await withHub(async ({ dir, port }) => {
    const original = await writeTicket(dir, {
      id: B,
      title: "Beta",
      created: T0,
      depends: [C, A],
      body: BODY,
    });
    await writeTicket(dir, { id: A, title: "Alpha", created: T1, body: "alpha\n" });
    await writeTicket(dir, { id: C, title: "See", created: T2, body: "" });
    const bPath = path.join(dir, "tickets", `${B}.md`);
    const view = {
      rev: 0,
      title: "Beta",
      state: "new",
      parent: "",
      depends: [A, C],
      reporter: "indexer",
      created: T0,
    };
    const watcher = await hello(port, "watch");
    try {
      const missing = await runFast(ticketArgs(port, ["ticket", "set", D, "--rev", "0", "--title", "Nope"]));
      assert.equal(missing.code, shellStatus(404));
      assert.equal(missing.stdout, "");
      assert.equal(missing.stderr, "error 404\n");

      const sameTitle = await runFast(ticketArgs(port, ["ticket", "set", B, "--rev", "0", "--title", "  Beta  "]));
      assert.equal(sameTitle.code, 0);
      assert.equal(sameTitle.stdout, BODY);
      assert.equal(sameTitle.stderr, ticketErr(view));
      await assertNoTicketBroadcast(watcher);

      const sameDepends = await runFast(ticketArgs(port, ["ticket", "set", B, "--rev", "0", "--depends", `${C}, ${A}`]));
      assert.equal(sameDepends.code, 0);
      assert.equal(sameDepends.stdout, BODY);
      assert.equal(sameDepends.stderr, ticketErr(view));
      await assertNoTicketBroadcast(watcher);

      const sameParent = await runFast(ticketArgs(port, ["ticket", "set", B, "--rev=0", "--parent=none"]));
      assert.equal(sameParent.code, 0);
      assert.equal(sameParent.stderr, ticketErr(view));
      await assertNoTicketBroadcast(watcher);
      assert.equal(await fs.readFile(bPath, "utf8"), original);

      const stale = await runFast(ticketArgs(port, ["ticket", "set", B, "--rev", "4", "--title", "Renamed"]));
      assert.equal(stale.code, shellStatus(409));
      assert.equal(stale.stdout, BODY);
      assert.equal(stale.stderr, ticketErr(view, true));
      assert.equal(stale.stderr.includes("error "), false);
      await assertNoTicketBroadcast(watcher);

      const staleBad = await runFast(ticketArgs(port, ["ticket", "set", B, "--rev", "4", "--title", "x".repeat(201)]));
      assert.equal(staleBad.code, shellStatus(409));
      assert.equal(staleBad.stdout, BODY);
      assert.equal(staleBad.stderr, ticketErr(view, true));
      assert.equal(await fs.readFile(bPath, "utf8"), original);

      const staleJson = await runFast(["--json", ...ticketArgs(port, ["ticket", "set", B, "--rev", "4", "--title", "Renamed"])]);
      assert.equal(staleJson.code, shellStatus(409));
      assert.equal(staleJson.stderr, "");
      const conflict = JSON.parse(staleJson.stdout);
      assert.deepEqual(Object.keys(conflict), [
        "id", "path", "rev", "title", "state", "parent", "depends", "reporter", "created", "text", "error",
      ]);
      assert.deepEqual(conflict, {
        ...ticketJson({
          id: B,
          path: `tickets/${B}.md`,
          text: BODY,
          ...view,
        }),
        error: "conflict",
      });

      const long = await runFast(ticketArgs(port, ["ticket", "set", B, "--rev", "0", "--title", "x".repeat(201)]));
      assert.equal(long.code, shellStatus(400));
      assert.equal(long.stdout, "");
      assert.equal(long.stderr, "error 400\n");
      const tabbed = await runFast(["--json", ...ticketArgs(port, ["ticket", "set", B, "--rev", "0", "--title", "bad\ttitle"])]);
      assert.equal(tabbed.code, shellStatus(400));
      assert.equal(tabbed.stdout, "");
      assert.equal(tabbed.stderr, "error 400\n");
      assert.equal(await fs.readFile(bPath, "utf8"), original);

      const renamed = await runFast(ticketArgs(port, ["ticket", "set", B, "--rev=0", "--title=Renamed"]));
      assert.equal(renamed.code, 0);
      view.rev = 1;
      view.title = "Renamed";
      assert.equal(renamed.stdout, BODY);
      assert.equal(renamed.stderr, ticketErr(view));
      assert.equal(parseTicket(B, await fs.readFile(bPath, "utf8")).body, BODY);

      const progressed = await runFast(["--json", ...ticketArgs(port, ["ticket", "set", B, "--rev", "1", "--state", "in progress"])]);
      assert.equal(progressed.code, 0);
      assert.equal(progressed.stderr, "");
      view.rev = 2;
      view.state = "in progress";
      const progressedJson = JSON.parse(progressed.stdout);
      assert.deepEqual(progressedJson, ticketJson({
        id: B,
        path: `tickets/${B}.md`,
        text: BODY,
        ...view,
      }));
      assert.equal(Object.hasOwn(progressedJson, "error"), false);

      const linked = await runFast(ticketArgs(port, [
        "ticket", "set", B, "--rev", "2", "--parent", A, "--depends", `${C}, ${A}`,
      ]));
      assert.equal(linked.code, 0);
      view.rev = 3;
      view.parent = A;
      assert.equal(linked.stdout, BODY);
      assert.equal(linked.stderr, ticketErr(view));

      const replaced = await runFast(ticketArgs(port, ["ticket", "set", B, "--rev", "3", "--depends", ` ${C} `]));
      assert.equal(replaced.code, 0);
      view.rev = 4;
      view.depends = [C];
      assert.equal(replaced.stderr, ticketErr(view));
      assert.deepEqual(parseTicket(B, await fs.readFile(bPath, "utf8")).depends, [C]);

      const cleared = await runFast(ticketArgs(port, [
        "ticket", "set", B, "--rev", "4", "--parent", "none", "--depends", "none",
      ]));
      assert.equal(cleared.code, 0);
      view.rev = 5;
      view.parent = "";
      view.depends = [];
      assert.equal(cleared.stdout, BODY);
      assert.equal(cleared.stderr, ticketErr(view));

      const beforeMiss = await fs.readFile(bPath, "utf8");
      const miss = await runFast(ticketArgs(port, ["ticket", "set", B, "--rev", "5", "--parent", D]));
      assert.equal(miss.code, shellStatus(409));
      assert.equal(miss.stdout, BODY);
      assert.equal(miss.stderr, ticketErr(view, true));
      assert.equal(await fs.readFile(bPath, "utf8"), beforeMiss);

      const self = await runFast(["--json", ...ticketArgs(port, ["ticket", "set", B, "--rev", "5", "--parent", B])]);
      assert.equal(self.code, shellStatus(409));
      assert.equal(self.stderr, "");
      assert.deepEqual(JSON.parse(self.stdout), {
        ...ticketJson({ id: B, path: `tickets/${B}.md`, text: BODY, ...view }),
        error: "conflict",
      });
      assert.equal(await fs.readFile(bPath, "utf8"), beforeMiss);

      const parented = await runFast(ticketArgs(port, ["ticket", "set", B, "--rev", "5", "--parent", A]));
      assert.equal(parented.code, 0);
      view.rev = 6;
      view.parent = A;
      assert.equal(parented.stderr, ticketErr(view));

      const cycle = await runFast(ticketArgs(port, ["ticket", "set", A, "--rev", "0", "--parent", B]));
      assert.equal(cycle.code, shellStatus(409));
      assert.equal(cycle.stdout, "alpha\n");
      assert.equal(cycle.stderr, ticketErr({
        rev: 0,
        title: "Alpha",
        state: "new",
        parent: "",
        depends: [],
        reporter: "indexer",
        created: T1,
      }, true));
      assert.equal(parseTicket(A, await fs.readFile(path.join(dir, "tickets", `${A}.md`), "utf8")).parent, "");
      assert.equal(parseTicket(B, await fs.readFile(bPath, "utf8")).parent, A);
      assert.equal(parseTicket(B, await fs.readFile(bPath, "utf8")).body, BODY);
      await assert.rejects(() => git(dir, ["rev-parse", "HEAD"]));
    } finally {
      watcher.ws.close();
    }
  });
});

test("T-cli-ticket-purge", async () => {
  const gate = await trap();
  try {
    const extra = await runFast(["--port", String(gate.port), "--user", "user", "ticket", "purge", "extra"]);
    assert.equal(extra.code, 2);
    assert.equal(extra.stdout, "");
    const missingUser = await runFast(["--port", String(gate.port), "ticket", "purge"]);
    assert.equal(missingUser.code, 2);
    assert.equal(gate.hits.length, 0);
  } finally {
    await gate.close();
  }

  await withHub(async ({ dir, port }) => {
    const none = await runFast(ticketArgs(port, ["ticket", "purge"]));
    assert.equal(none.code, 0);
    assert.equal(none.stdout, "");
    assert.equal(none.stderr, "");
    const noneJson = await runFast(["--json", ...ticketArgs(port, ["ticket", "purge"])]);
    assert.equal(noneJson.code, 0);
    assert.equal(noneJson.stderr, "");
    assert.equal(noneJson.stdout, `${JSON.stringify({ purged: [] })}\n`);

    await writeTicket(dir, {
      id: B,
      title: "Beta",
      created: T0,
      parent: A,
      depends: [Z, E],
      body: "beta\n",
    });
    await writeTicket(dir, { id: A, title: "Alpha", state: "closed", created: T1, body: "gone-a\n" });
    await writeTicket(dir, { id: D, title: "Dee", state: "closed", created: T1, body: "gone-d\n" });
    await writeTicket(dir, { id: E, title: "Ee", created: T2, body: "ee\n" });
    await writeTicket(dir, { id: Z, title: "Zee", state: "closed", created: T3, body: "gone-z\n" });
    await fs.writeFile(path.join(dir, "tickets", "readme.md"), "keep\n");
    await fs.mkdir(path.join(dir, "tickets", "nested"), { recursive: true });
    await fs.writeFile(path.join(dir, "tickets", "nested", "d.md"), "x\n");

    const purged = await runFast(ticketArgs(port, ["ticket", "purge"]));
    assert.equal(purged.code, 0);
    assert.equal(purged.stderr, "");
    assert.equal(purged.stdout, `${A}\n${D}\n${Z}\n`);
    await assert.rejects(() => fs.lstat(path.join(dir, "tickets", `${A}.md`)));
    await assert.rejects(() => fs.lstat(path.join(dir, "tickets", `${D}.md`)));
    await assert.rejects(() => fs.lstat(path.join(dir, "tickets", `${Z}.md`)));
    assert.equal(await fs.readFile(path.join(dir, "tickets", "readme.md"), "utf8"), "keep\n");
    assert.equal(await fs.readFile(path.join(dir, "tickets", "nested", "d.md"), "utf8"), "x\n");

    const shown = await runFast(ticketArgs(port, ["ticket", "show", B]));
    assert.equal(shown.code, 0);
    assert.equal(shown.stdout, "beta\n");
    assert.equal(shown.stderr, ticketErr({
      rev: 0,
      title: "Beta",
      state: "new",
      parent: "",
      depends: [E],
      reporter: "indexer",
      created: T0,
    }));
    const ee = await runFast(ticketArgs(port, ["ticket", "show", E]));
    assert.equal(ee.stdout, "ee\n");
    assert.equal(ee.stderr, ticketErr({
      rev: 0,
      title: "Ee",
      state: "new",
      parent: "",
      depends: [],
      reporter: "indexer",
      created: T2,
    }));
    const remain = await runFast(ticketArgs(port, ["ticket", "list", "--closed"]));
    assert.equal(remain.stdout, `${B}\t${T0}\tnew\tBeta\n${E}\t${T2}\tnew\tEe\n`);

    const betaBefore = await fs.readFile(path.join(dir, "tickets", `${B}.md`), "utf8");
    const again = await runFast(ticketArgs(port, ["ticket", "purge"]));
    assert.equal(again.code, 0);
    assert.equal(again.stdout, "");
    assert.equal(again.stderr, "");
    assert.equal(await fs.readFile(path.join(dir, "tickets", `${B}.md`), "utf8"), betaBefore);

    await writeTicket(dir, { id: C, title: "Later", state: "closed", created: T0, body: "later\n" });
    await writeTicket(dir, { id: "ffffffff", title: "After", state: "closed", created: T3, body: "" });
    const json = await runFast(["--json", ...ticketArgs(port, ["ticket", "purge"])]);
    assert.equal(json.code, 0);
    assert.equal(json.stderr, "");
    assert.equal(json.stdout, `${JSON.stringify({ purged: [C, "ffffffff"] })}\n`);
    const left = await runFast(ticketArgs(port, ["ticket", "list", "--closed"]));
    assert.equal(left.stdout, `${B}\t${T0}\tnew\tBeta\n${E}\t${T2}\tnew\tEe\n`);
    await assert.rejects(() => git(dir, ["rev-parse", "HEAD"]));
  });
});
