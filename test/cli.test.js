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
import { commentThreads, parseCommentNotes, splitCommentNote } from "../src/doc.js";
import { composeTicket, parseTicket } from "../src/ticket.js";
import { validUsername } from "../cli.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "cli.js");
const HELLO = "hello line\nsecond line\n";
const DRAFT = "a draft\n";

function diffText(hunks) {
  const lines = [];
  for (const hunk of hunks) {
    lines.push("@@");
    for (const row of hunk) lines.push(row);
  }
  return `${lines.join("\n")}\n`;
}

const HELP_NEEDLES = [
  "list",
  "show",
  "create",
  "edit",
  "--rev",
  "--find",
  "--replace",
  "--start",
  "--end",
  "--expect",
  "stdout",
  "stderr",
  "rev N",
  "rev 0",
  "conflict",
  "context",
  "overlap",
  "matches N",
  "error STATUS",
  "held by NAME",
  "Each hunk is its own splice, so unchanged text between hunks stays put. Another socket's span is 409 and names that user, and a comment range that overlaps a fence or a table or splits a comment is 409 and names that.",
  "{files}",
  "{path,rev,text}",
  "{path,rev:0}",
  "A context mismatch exits 409 and does not write.",
  "No hunks leaves the file as it was and does not open a socket.",
  "Later field writes win.",
  "ticket list",
  "ticket show",
  "ticket create",
  "ticket set",
  "ticket purge",
  "delete <path>",
  "comment list <path>",
  "comment show <path> <thread>",
  "comment reply <path> <thread>",
  "comment add <path> --start LINE:OFFSET --end LINE:OFFSET",
  "comment edit <path> <thread> <note> --expect TEXT",
  "An agent leaves a question with `comment add PATH --start LINE:OFFSET --end LINE:OFFSET --expect TEXT` and the question on stdin.",
  "Lines count from 1. Offset counts from 0. The end offset is exclusive.",
  "--repo is required on list, show, create, edit, delete, comment, commit, and ticket.",
  "ticket delete",
  "--title",
  "--state",
  "--type",
  "--priority",
  "--parent",
  "low, medium, or high",
  "An omitted create stores medium",
  "--depends",
  "--closed",
  "reporter",
  "create reads the body from stdin when stdin is not a terminal.",
  "create <path> [--file PATH]",
  "The body is stdin when stdin is not a terminal. A terminal sends an empty body. --file PATH reads that file instead and does not read stdin.",
  "serve",
  "keeps running",
  "beside the program",
  "--user is not required",
  "commit [--message TEXT]",
  "An omitted message lets the hub choose the subject.",
  "1–200",
];

function run(args, extraEnv = {}, input = "") {
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
    child.stdin.write(input);
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

async function registerRepo(port, name, description, repoPath) {
  const client = await hello(port, "fixture", null);
  client.send({ type: "repo.register", username: "fixture", name, description, path: repoPath });
  const msg = await client.next((item) => item.type === "repos" || item.type === "error");
  client.ws.close();
  if (msg.type !== "repos") throw new Error(`register ${name} failed ${msg.status}`);
  return msg;
}

async function withDocs(fn) {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-cli-state-"));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-cli-"));
  await fs.mkdir(path.join(dir, "notes"));
  await fs.writeFile(path.join(dir, "hello.md"), HELLO);
  await fs.writeFile(path.join(dir, "notes", "draft.md"), DRAFT);
  await fs.writeFile(path.join(dir, "skip.txt"), "nope\n");
  const server = await start(0, state);
  try {
    await registerRepo(server.address().port, "docs", "Docs", dir);
    await fn({ dir, port: server.address().port });
  } finally {
    await closeServer(server);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(state, { recursive: true, force: true });
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

async function hello(port, username, repo = "docs") {
  const client = connect(port, username);
  await client.ready;
  client.send({ type: "hello", username });
  if (repo) client.send({ type: "repo", username, name: repo });
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
  const agents = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
  const cause = "Each hunk is its own splice, so unchanged text between hunks stays put. Another socket's span is 409 and names that user, and a comment range that overlaps a fence or a table or splits a comment is 409 and names that.";
  assert.ok(agents.includes(cause));
  assert.equal(agents.includes("crosses one of those boundaries"), false);
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

    const unknown = await run(["nope", "--user", "user", "--repo", "docs", "--port", String(gate.port)]);
    assert.equal(unknown.code, 2);
    assert.equal(gate.hits.length, 0);
    const extra = await run(["list", "extra", "--user", "user", "--repo", "docs", "--port", String(gate.port)]);
    assert.equal(extra.code, 2);
    assert.equal(gate.hits.length, 0);
  } finally {
    await gate.close();
  }
});

async function runArgv(args, extraEnv = {}) {
  const helper = path.join(
    os.tmpdir(),
    `viewmark-argv-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`,
  );
  const source = `import { pathToFileURL } from "node:url";
process.argv = [process.execPath, ${JSON.stringify(cli)}, ...${JSON.stringify(args)}];
await import(pathToFileURL(${JSON.stringify(cli)}).href);
`;
  await fs.writeFile(helper, source);
  try {
    return await new Promise((resolve, reject) => {
      const env = { ...process.env };
      delete env.VIEWMARK_USER;
      delete env.VIEWMARK_PORT;
      for (const [key, value] of Object.entries(extraEnv)) {
        if (value === undefined) delete env[key];
        else env[key] = value;
      }
      const child = spawn(process.execPath, [helper], { env, stdio: ["ignore", "pipe", "pipe"] });
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
  } finally {
    await fs.rm(helper, { force: true });
  }
}

async function captureCli(args) {
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
        const msg = JSON.parse(payload.toString("utf8"));
        messages.push(msg);
        if (msg.type !== "commit") return;
        const commits = Object.hasOwn(msg, "message")
          ? [{ author: msg.username, subject: msg.message, paths: ["hello.md"] }]
          : [];
        socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify({ type: "commit", commits }))));
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
  });
  await listen(server);
  try {
    const res = await run(["--port", String(server.address().port), "--user", "user", "--repo", "docs", ...args]);
    return { res, messages };
  } finally {
    peer?.destroy();
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}

test("T-cli-commit", async () => {
  const gate = await trap();
  try {
    const noRepo = await run(["--port", String(gate.port), "--user", "user", "commit"]);
    assert.equal(noRepo.code, 2);
    assert.equal(noRepo.stdout, "");
    assert.equal(noRepo.stderr, "viewmark: --repo is required\n");

    const positional = await run(["--port", String(gate.port), "--user", "user", "--repo", "docs", "commit", "hello.md"]);
    assert.equal(positional.code, 2);
    assert.equal(positional.stdout, "");
    assert.equal(positional.stderr, "viewmark: unexpected argument\n");
    const positionalMessage = await run([
      "--port", String(gate.port),
      "--user", "user",
      "--repo", "docs",
      "commit",
      "--message", "hi",
      "extra",
    ]);
    assert.equal(positionalMessage.code, 2);
    assert.equal(positionalMessage.stdout, "");

    for (const message of ["", "   ", "\n", "bad\nnote", "\t", "bad\ttab", "bad\rnote", "a".repeat(201), ` ${"a".repeat(201)} `]) {
      const res = await run([
        "--port", String(gate.port),
        "--user", "user",
        "--repo", "docs",
        "commit",
        "--message", message,
      ]);
      assert.equal(res.code, 2, JSON.stringify(message));
      assert.equal(res.stdout, "");
      assert.equal(res.stderr, "viewmark: invalid message\n");
    }
    for (const message of ["\0", "nul\0here"]) {
      const res = await runArgv([
        "--port", String(gate.port),
        "--user", "user",
        "--repo", "docs",
        "commit",
        "--message", message,
      ]);
      assert.equal(res.code, 2, JSON.stringify(message));
      assert.equal(res.stdout, "");
      assert.equal(res.stderr, "viewmark: invalid message\n");
    }

    const onList = await run([
      "--port", String(gate.port),
      "--user", "user",
      "--repo", "docs",
      "list",
      "--message", "hi",
    ]);
    assert.equal(onList.code, 2);
    assert.equal(onList.stdout, "");
    assert.equal(onList.stderr, "viewmark: unexpected flag\n");
    for (const args of [
      ["show", "hello.md", "--message", "hi"],
      ["create", "a.md", "--message", "hi"],
      ["edit", "hello.md", "--message", "hi"],
      ["delete", "hello.md", "--message", "hi"],
      ["ticket", "list", "--message", "hi"],
      ["repo", "list", "--message", "hi"],
    ]) {
      const res = await run(["--port", String(gate.port), "--user", "user", "--repo", "docs", ...args]);
      assert.equal(res.code, 2, args.join(" "));
      assert.equal(res.stdout, "");
      assert.equal(res.stderr, "viewmark: unexpected flag\n");
    }
    const served = await run(["serve", "--message=hi"], { VIEWMARK_PORT: String(gate.port), VIEWMARK_USER: "user" });
    assert.equal(served.code, 2);
    assert.equal(served.stdout, "");
    assert.equal(served.stderr, "viewmark: unexpected flag\n");
    assert.equal(gate.hits.length, 0);
  } finally {
    await gate.close();
  }

  const omitted = await captureCli(["commit"]);
  assert.equal(omitted.res.code, 0);
  assert.equal(omitted.res.stdout, "");
  assert.equal(omitted.res.stderr, "");
  assert.deepEqual(omitted.messages.map((msg) => msg.type), ["hello", "repo", "commit"]);
  assert.deepEqual(omitted.messages[1], { type: "repo", username: "user", name: "docs" });
  assert.deepEqual(omitted.messages[2], { type: "commit", username: "user" });
  assert.equal(Object.hasOwn(omitted.messages[2], "message"), false);

  const trimmed = await captureCli(["commit", "--message", " \thello\n "]);
  assert.equal(trimmed.res.code, 0);
  assert.equal(trimmed.res.stderr, "");
  assert.equal(trimmed.res.stdout, "hello\n");
  assert.deepEqual(trimmed.messages[2], { type: "commit", username: "user", message: "hello" });

  const wide = ` ${"a".repeat(200)} `;
  const sent = await captureCli(["commit", "--message", wide]);
  assert.equal(sent.res.code, 0);
  assert.equal(sent.res.stderr, "");
  assert.equal(sent.res.stdout, `${"a".repeat(200)}\n`);
  assert.equal(sent.messages[2].message, "a".repeat(200));

  await withDocs(async ({ dir, port }) => {
    const args = ["--port", String(port), "--user", "user", "--repo", "docs", "commit"];
    const clean = await run(args);
    assert.equal(clean.code, 0);
    assert.equal(clean.stdout, "");
    assert.equal(clean.stderr, "");
    await assert.rejects(() => git(dir, ["rev-parse", "HEAD"]));

    const cleanJson = await run(["--json", ...args]);
    assert.equal(cleanJson.code, 0);
    assert.equal(cleanJson.stderr, "");
    assert.equal(cleanJson.stdout, `${JSON.stringify({ type: "commit", commits: [] })}\n`);
    await assert.rejects(() => git(dir, ["rev-parse", "HEAD"]));

    const edited = await run([
      "--port", String(port),
      "--user", "user",
      "--repo", "docs",
      "edit",
      "notes/draft.md",
    ], {}, diffText([["-a draft", "+a note"]]));
    assert.equal(edited.code, 0);
    assert.equal(edited.stdout, "a note\n");
    await assert.rejects(() => git(dir, ["rev-parse", "HEAD"]));

    const committed = await run(args);
    assert.equal(committed.code, 0);
    assert.equal(committed.stderr, "");
    assert.equal(committed.stdout, "Edit notes/draft.md\n");
    const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
    assert.match(head, /^[0-9a-f]{40}$/);
    assert.equal((await git(dir, ["rev-parse", "HEAD^{/Edit notes/draft.md}"])).trim(), head);
    assert.equal(await git(dir, ["log", "-1", "--format=%an <%ae>%n%s"]), "user <user@viewmark.local>\nEdit notes/draft.md\n");
    assert.equal(await git(dir, ["show", "HEAD:notes/draft.md"]), "a note\n");

    const again = await run(args);
    assert.equal(again.code, 0);
    assert.equal(again.stdout, "");
    assert.equal(again.stderr, "");
    assert.equal((await git(dir, ["rev-parse", "HEAD"])).trim(), head);

    const hello = await run([
      "--port", String(port),
      "--user", "user",
      "--repo", "docs",
      "edit",
      "hello.md",
    ], {}, diffText([["-hello line", "+hi line"]]));
    assert.equal(hello.code, 0);
    assert.equal(hello.stdout, "hi line\nsecond line\n");
    assert.equal((await git(dir, ["rev-parse", "HEAD"])).trim(), head);

    const json = await run(["--json", ...args]);
    assert.equal(json.code, 0);
    assert.equal(json.stderr, "");
    const ack = {
      type: "commit",
      commits: [{ author: "user", subject: "Edit hello.md", paths: ["hello.md"] }],
    };
    assert.equal(json.stdout, `${JSON.stringify(ack)}\n`);
    const next = (await git(dir, ["rev-parse", "HEAD"])).trim();
    assert.notEqual(next, head);
    assert.equal((await git(dir, ["rev-parse", "HEAD^{/Edit hello.md}"])).trim(), next);
    assert.equal((await git(dir, ["log", "-1", "--format=%s"])).trim(), "Edit hello.md");

    const shipped = await run([
      "--port", String(port),
      "--user", "user",
      "--repo", "docs",
      "edit",
      "hello.md",
    ], {}, diffText([["-hi line", "+yo line"]]));
    assert.equal(shipped.code, 0);
    const noted = await run([...args, "--message", "  Ship it  "]);
    assert.equal(noted.code, 0);
    assert.equal(noted.stderr, "");
    assert.equal(noted.stdout, "Ship it\n");
    assert.equal((await git(dir, ["log", "-1", "--format=%s"])).trim(), "Ship it");
    assert.equal((await git(dir, ["rev-parse", "HEAD^{/Ship it}"])).trim(), (await git(dir, ["rev-parse", "HEAD"])).trim());

    const missing = await run(["--port", String(port), "--user", "user", "--repo", "missing", "commit"]);
    assert.equal(missing.code, shellStatus(404));
    assert.equal(missing.stdout, "");
    assert.equal(missing.stderr, "error 404\n");
    const missingJson = await run(["--json", "--port", String(port), "--user", "user", "--repo", "missing", "commit"]);
    assert.equal(missingJson.code, shellStatus(404));
    assert.equal(missingJson.stdout, "");
    assert.equal(missingJson.stderr, "error 404\n");
  });
});

test("T-cli-list", async () => {
  await withDocs(async ({ port }) => {
    const res = await run(["--port", String(port), "--user", "user", "--repo", "docs", "list"]);
    assert.equal(res.code, 0);
    assert.equal(res.stderr, "");
    assert.equal(res.stdout, "hello.md\nnotes/draft.md\n");

    const json = await run(["--json", "--repo", "docs", "list"], { VIEWMARK_PORT: String(port), VIEWMARK_USER: "user" });
    assert.equal(json.code, 0);
    assert.equal(json.stderr, "");
    assert.equal(json.stdout, `${JSON.stringify({ files: ["hello.md", "notes/draft.md"] })}\n`);

    const flagged = await run(["--port", String(port), "--user", "user", "--repo", "docs", "list"], { VIEWMARK_PORT: "1" });
    assert.equal(flagged.code, 0);
    assert.equal(flagged.stdout, "hello.md\nnotes/draft.md\n");
  });
});

test("T-cli-show", async () => {
  await withDocs(async ({ dir, port }) => {
    const watcher = await hello(port, "watch");
    await openDoc(watcher, "watch", "hello.md");
    const shown = await run(["--port", String(port), "--user", "user", "--repo", "docs", "show", "hello.md"]);
    assert.equal(shown.code, 0);
    assert.equal(shown.stdout, HELLO);
    assert.equal(shown.stderr, "rev 0\n");
    const nested = await run(["--port", String(port), "--user", "user", "--repo", "docs", "show", "notes/draft.md"]);
    assert.equal(nested.code, 0);
    assert.equal(nested.stdout, DRAFT);
    assert.equal(nested.stderr, "rev 0\n");
    await delay(100);
    assert.equal(sawOwnEdit(watcher.queue, "user"), false);

    const json = await run(["show", "hello.md", "--json", "--port", String(port), "--user", "user", "--repo", "docs"]);
    assert.equal(json.code, 0);
    assert.equal(json.stderr, "");
    assert.equal(json.stdout, `${JSON.stringify({ path: "hello.md", rev: 0, text: HELLO })}\n`);

    const slash = await run(["--port", String(port), "--user", "user", "--repo", "docs", "show", "/hello.md"]);
    assert.equal(slash.code, shellStatus(404));
    assert.equal(slash.stdout, "");
    assert.equal(slash.stderr, "error 404\n");
    const missing = await run(["--json", "--port", String(port), "--user", "user", "--repo", "docs", "show", "missing.md"]);
    assert.equal(missing.code, shellStatus(404));
    assert.equal(missing.stdout, "");
    assert.equal(missing.stderr, "error 404\n");
    await assert.rejects(() => git(dir, ["rev-parse", "HEAD"]));
    watcher.ws.close();
  });
});

test("T-cli-delete", async () => {
  const gate = await trap();
  try {
    const noRepo = await run(["--port", String(gate.port), "--user", "user", "delete", "hello.md"]);
    assert.equal(noRepo.code, 2);
    assert.equal(noRepo.stdout, "");
    assert.equal(noRepo.stderr, "viewmark: --repo is required\n");

    const missingPath = await run(["--port", String(gate.port), "--user", "user", "--repo", "docs", "delete"]);
    assert.equal(missingPath.code, 2);
    assert.equal(missingPath.stdout, "");
    assert.equal(missingPath.stderr, "viewmark: path required\n");

    const two = await run([
      "--port", String(gate.port),
      "--user", "user",
      "--repo", "docs",
      "delete",
      "hello.md",
      "notes/draft.md",
    ]);
    assert.equal(two.code, 2);
    assert.equal(two.stdout, "");
    assert.equal(two.stderr, "viewmark: unexpected argument\n");
    assert.equal(gate.hits.length, 0);
  } finally {
    await gate.close();
  }

  await withDocs(async ({ dir, port }) => {
    const holder = await hello(port, "Ada");
    await openDoc(holder, "Ada", "hello.md");
    const held = await run(["--port", String(port), "--user", "user", "--repo", "docs", "delete", "hello.md"]);
    assert.equal(held.code, shellStatus(409));
    assert.equal(held.stdout, "");
    assert.equal(held.stderr, "error 409\nheld by Ada\n");
    assert.equal(await fs.readFile(path.join(dir, "hello.md"), "utf8"), HELLO);
    const witness = await hello(port, "Bea");
    await openDoc(witness, "Bea", "hello.md");
    const released = witness.next((msg) => msg.type === "locks" && msg.path === "hello.md");
    holder.ws.close();
    await released;
    await openDoc(witness, "Bea", "notes/draft.md");

    const bare = await run(["--port", String(port), "--user", "user", "--repo", "docs", "delete", "hello"]);
    assert.equal(bare.code, shellStatus(404));
    assert.equal(bare.stdout, "");
    assert.equal(bare.stderr, "error 404\n");
    assert.equal(await fs.readFile(path.join(dir, "hello.md"), "utf8"), HELLO);

    const rooted = await run(["--port", String(port), "--user", "user", "--repo", "docs", "delete", "/hello.md"]);
    assert.equal(rooted.code, shellStatus(404));
    assert.equal(rooted.stdout, "");
    assert.equal(rooted.stderr, "error 404\n");
    assert.equal(await fs.readFile(path.join(dir, "hello.md"), "utf8"), HELLO);

    const padded = await run(["--port", String(port), "--user", "user", "--repo", "docs", "delete", " notes/draft.md"]);
    assert.equal(padded.code, shellStatus(404));
    assert.equal(padded.stdout, "");
    assert.equal(padded.stderr, "error 404\n");
    assert.equal(await fs.readFile(path.join(dir, "notes", "draft.md"), "utf8"), DRAFT);

    const removed = await run(["--port", String(port), "--user", "user", "--repo", "docs", "delete", "hello.md"]);
    assert.equal(removed.code, 0);
    assert.equal(removed.stdout, "hello.md\n");
    assert.equal(removed.stderr, "");
    await assert.rejects(() => fs.lstat(path.join(dir, "hello.md")));

    const missing = await run(["--port", String(port), "--user", "user", "--repo", "docs", "delete", "missing.md"]);
    assert.equal(missing.code, shellStatus(404));
    assert.equal(missing.stdout, "");
    assert.equal(missing.stderr, "error 404\n");

    const ticketPath = await run([
      "--port", String(port),
      "--user", "user",
      "--repo", "docs",
      "delete",
      "tickets/aaaaaaaa.md",
    ]);
    assert.equal(ticketPath.code, shellStatus(400));
    assert.equal(ticketPath.stdout, "");
    assert.equal(ticketPath.stderr, "error 400\n");

    await fs.writeFile(path.join(dir, "other.md"), "other\n");
    await openDoc(witness, "Bea", "other.md");
    const json = await run([
      "--json",
      "--port", String(port),
      "--user", "user",
      "--repo", "docs",
      "delete",
      "notes/draft.md",
    ]);
    assert.equal(json.code, 0);
    assert.equal(json.stderr, "");
    assert.equal(json.stdout, `${JSON.stringify({ path: "notes/draft.md" })}\n`);
    await assert.rejects(() => fs.lstat(path.join(dir, "notes", "draft.md")));
    witness.ws.close();
  });
});

test("T-cli-create", async () => {
  const gate = await trap();
  try {
    for (const pathArg of ["", "   ", "/", "///"]) {
      const empty = await run(["--port", String(gate.port), "--user", "user", "--repo", "docs", "create", pathArg]);
      assert.equal(empty.code, 2, JSON.stringify(pathArg));
    }
    for (const args of [
      ["list", "--file", "x"],
      ["show", "hello.md", "--file", "x"],
      ["edit", "hello.md", "--file", "x"],
      ["delete", "hello.md", "--file", "x"],
      ["commit", "--file", "x"],
      ["ticket", "list", "--file", "x"],
      ["repo", "list", "--file", "x"],
    ]) {
      const flagged = await run(["--port", String(gate.port), "--user", "user", "--repo", "docs", ...args]);
      assert.equal(flagged.code, 2, args.join(" "));
      assert.equal(flagged.stdout, "");
      assert.equal(flagged.stderr, "viewmark: unexpected flag\n");
    }
    const served = await run(["serve", "--file", "x"], { VIEWMARK_PORT: String(gate.port) });
    assert.equal(served.code, 2);
    assert.equal(served.stdout, "");
    assert.equal(served.stderr, "viewmark: unexpected flag\n");
    assert.equal(gate.hits.length, 0);
  } finally {
    await gate.close();
  }

  await withDocs(async ({ dir, port }) => {
    const created = await run(["--port", String(port), "--user", "user", "--repo", "docs", "create", "notes/idea"]);
    assert.equal(created.code, 0);
    assert.equal(created.stdout, "notes/idea.md\n");
    assert.equal(created.stderr, "rev 0\n");
    assert.equal(await fs.readFile(path.join(dir, "notes", "idea.md"), "utf8"), "");

    const again = await run(["--port", String(port), "--user", "user", "--repo", "docs", "create", "notes/idea"]);
    assert.equal(again.code, shellStatus(409));
    assert.equal(again.stdout, "");
    assert.equal(again.stderr, "error 409\n");
    assert.equal(await fs.readFile(path.join(dir, "notes", "idea.md"), "utf8"), "");

    const nope = await run(["--port", String(port), "--user", "user", "--repo", "docs", "create", "../nope"]);
    assert.equal(nope.code, shellStatus(404));
    assert.equal(nope.stdout, "");
    assert.equal(nope.stderr, "error 404\n");
    await assert.rejects(() => fs.lstat(path.join(dir, "nope.md")));
    await assert.rejects(() => git(dir, ["rev-parse", "HEAD"]));

    const trimmed = await run(["--port", String(port), "--user", "user", "--repo", "docs", "create", "  /notes/next  "]);
    assert.equal(trimmed.code, 0);
    assert.equal(trimmed.stdout, "notes/next.md\n");
    assert.equal(trimmed.stderr, "rev 0\n");
    assert.equal(await fs.readFile(path.join(dir, "notes", "next.md"), "utf8"), "");

    const markdown = await run(["--json", "--port", String(port), "--user", "user", "--repo", "docs", "create", "notes/keep.markdown"]);
    assert.equal(markdown.code, 0);
    assert.equal(markdown.stderr, "");
    assert.equal(markdown.stdout, `${JSON.stringify({ path: "notes/keep.markdown", rev: 0 })}\n`);
    assert.equal(await fs.readFile(path.join(dir, "notes", "keep.markdown"), "utf8"), "");
    await assert.rejects(() => git(dir, ["rev-parse", "HEAD"]));

    const piped = await run(
      ["--port", String(port), "--user", "user", "--repo", "docs", "create", "notes/piped"],
      {},
      "Piped.\n",
    );
    assert.equal(piped.code, 0);
    assert.equal(piped.stdout, "notes/piped.md\n");
    assert.equal(piped.stderr, "rev 0\n");
    assert.equal(await fs.readFile(path.join(dir, "notes", "piped.md"), "utf8"), "Piped.\n");

    const jsonBody = await run(
      ["--json", "--port", String(port), "--user", "user", "--repo", "docs", "create", "notes/json-body"],
      {},
      "Json.\n",
    );
    assert.equal(jsonBody.code, 0);
    assert.equal(jsonBody.stderr, "");
    assert.equal(jsonBody.stdout, `${JSON.stringify({ path: "notes/json-body.md", rev: 0 })}\n`);
    assert.equal(Object.hasOwn(JSON.parse(jsonBody.stdout), "text"), false);
    assert.equal(await fs.readFile(path.join(dir, "notes", "json-body.md"), "utf8"), "Json.\n");

    const disk = path.join(dir, "from-disk.txt");
    await fs.writeFile(disk, "From disk.\n");
    const fromFile = await run(
      ["--port", String(port), "--user", "user", "--repo", "docs", "create", "notes/from-disk", "--file", disk],
      {},
      "Ignored.\n",
    );
    assert.equal(fromFile.code, 0);
    assert.equal(fromFile.stdout, "notes/from-disk.md\n");
    assert.equal(fromFile.stderr, "rev 0\n");
    assert.equal(fromFile.stdout.includes("From disk."), false);
    assert.equal(await fs.readFile(path.join(dir, "notes", "from-disk.md"), "utf8"), "From disk.\n");

    const blank = path.join(dir, "blank-body.txt");
    await fs.writeFile(blank, "");
    const blankDoc = await run(
      ["--port", String(port), "--user", "user", "--repo", "docs", "create", "notes/blank-body", "--file", blank],
      {},
      "Ignored.\n",
    );
    assert.equal(blankDoc.code, 0);
    assert.equal(await fs.readFile(path.join(dir, "notes", "blank-body.md"), "utf8"), "");

    const gate = await trap();
    try {
      const missingFile = path.join(dir, "no-such-body.txt");
      const missing = await run([
        "--port", String(gate.port),
        "--user", "user",
        "--repo", "docs",
        "create",
        "notes/missing-body",
        "--file",
        missingFile,
      ]);
      assert.equal(missing.code, 2);
      assert.equal(missing.stdout, "");
      assert.equal(missing.stderr, `viewmark: cannot read ${missingFile}\n`);
      await assert.rejects(() => fs.lstat(path.join(dir, "notes", "missing-body.md")));

      const asDir = await run([
        "--port", String(gate.port),
        "--user", "user",
        "--repo", "docs",
        "create",
        "notes/dir-body",
        "--file",
        dir,
      ]);
      assert.equal(asDir.code, 2);
      assert.equal(asDir.stdout, "");
      assert.equal(asDir.stderr, `viewmark: cannot read ${dir}\n`);
      await assert.rejects(() => fs.lstat(path.join(dir, "notes", "dir-body.md")));

      const secret = path.join(dir, "secret-body.txt");
      await fs.writeFile(secret, "nope\n");
      await fs.chmod(secret, 0);
      try {
        const denied = await run([
          "--port", String(gate.port),
          "--user", "user",
          "--repo", "docs",
          "create",
          "notes/secret-body",
          "--file",
          secret,
        ]);
        assert.equal(denied.code, 2);
        assert.equal(denied.stdout, "");
        assert.equal(denied.stderr, `viewmark: cannot read ${secret}\n`);
      } finally {
        await fs.chmod(secret, 0o644);
      }
      await assert.rejects(() => fs.lstat(path.join(dir, "notes", "secret-body.md")));

      for (const fileArg of ["", "--file="]) {
        const args = ["--port", String(gate.port), "--user", "user", "--repo", "docs", "create", "notes/empty-flag"];
        if (fileArg === "") args.push("--file", "");
        else args.push(fileArg);
        const emptyFile = await run(args);
        assert.equal(emptyFile.code, 2, JSON.stringify(fileArg));
        assert.equal(emptyFile.stdout, "");
        assert.equal(emptyFile.stderr, "viewmark: empty file\n");
      }
      await assert.rejects(() => fs.lstat(path.join(dir, "notes", "empty-flag.md")));
      assert.equal(gate.hits.length, 0);
    } finally {
      await gate.close();
    }
  });
});

function editArgs(port, path, extra = []) {
  return ["--port", String(port), "--user", "user", "--repo", "docs", "edit", path, ...extra];
}

test("T-cli-edit", async () => {
  const gate = await trap();
  try {
    const rejected = [
      ["--rev", "0"],
      ["--find", "hello", "--replace", "hi"],
      ["--replace", "hi"],
      ["--start", "1:0"],
      ["--start", "nope", "--end", "1:1"],
    ];
    for (const flags of rejected) {
      const res = await run(
        ["--port", String(gate.port), "--user", "user", "--repo", "docs", "edit", "hello.md", ...flags],
        {},
        diffText([["-hello line", "+hi line"]]),
      );
      assert.equal(res.code, 2, flags.join(" "));
      assert.equal(res.stdout, "", flags.join(" "));
    }
    const invalid = await run(
      ["--port", String(gate.port), "--user", "user", "--repo", "docs", "edit", "hello.md"],
      {},
      "not a diff\n",
    );
    assert.equal(invalid.code, 2);
    assert.equal(invalid.stdout, "");
    assert.equal(invalid.stderr, "viewmark: invalid diff\n");
    const bare = await run(
      ["--port", String(gate.port), "--user", "user", "--repo", "docs", "edit", "hello.md"],
      {},
      "@@\n+only\n",
    );
    assert.equal(bare.code, 2);
    assert.equal(bare.stderr, "viewmark: hunk has no context\n");
    const empty = await run(
      ["--port", String(gate.port), "--user", "user", "--repo", "docs", "edit", "hello.md"],
      {},
      "diff --git a b\n--- a\n+++ b\n",
    );
    assert.equal(empty.code, 0);
    assert.equal(empty.stdout, "");
    assert.equal(empty.stderr, "");
    assert.equal(gate.hits.length, 0);
  } finally {
    await gate.close();
  }

  await withDocs(async ({ dir, port }) => {
    const body = "Alpha\nBeta\nGamma\n";
    await fs.writeFile(path.join(dir, "greek.md"), body);
    const edited = await run(
      editArgs(port, "greek.md"),
      {},
      diffText([["-Beta", "-Gamma", "+Beta", "+Delta"]]),
    );
    assert.equal(edited.code, 0);
    assert.equal(edited.stdout, "Alpha\nBeta\nDelta\n");
    assert.equal(edited.stderr, "rev 1\n");
    assert.equal(await fs.readFile(path.join(dir, "greek.md"), "utf8"), "Alpha\nBeta\nDelta\n");
    await delay(400);
    await assert.rejects(() => git(dir, ["rev-parse", "HEAD"]));

    const cleared = await run(
      editArgs(port, "hello.md"),
      {},
      diffText([["-second line", "+line"]]),
    );
    assert.equal(cleared.code, 0);
    assert.equal(cleared.stdout, "hello line\nline\n");
    assert.equal(cleared.stderr, "rev 1\n");
    assert.equal(await fs.readFile(path.join(dir, "hello.md"), "utf8"), "hello line\nline\n");

    await fs.writeFile(path.join(dir, "overlap.md"), "aaa\n");
    const once = await run(
      ["--json", ...editArgs(port, "overlap.md")],
      {},
      diffText([["-aaa", "+ba"]]),
    );
    assert.equal(once.code, 0);
    assert.equal(once.stderr, "");
    assert.equal(once.stdout, `${JSON.stringify({ path: "overlap.md", rev: 1, text: "ba\n" })}\n`);
    assert.equal(await fs.readFile(path.join(dir, "overlap.md"), "utf8"), "ba\n");

    const absent = await run(editArgs(port, "missing.md"), {}, diffText([["-a", "+b"]]));
    assert.equal(absent.code, shellStatus(404));
    assert.equal(absent.stdout, "");
    assert.equal(absent.stderr, "error 404\n");

    const ranged = "one\ntwo\none\n";
    await fs.writeFile(path.join(dir, "repeat.md"), ranged);
    const many = await run(editArgs(port, "repeat.md"), {}, diffText([["-one", "+ONE"]]));
    assert.equal(many.code, 2);
    assert.equal(many.stdout, "");
    assert.equal(many.stderr, "matches 2\n");
    assert.equal(await fs.readFile(path.join(dir, "repeat.md"), "utf8"), ranged);
    const third = await run(
      editArgs(port, "repeat.md", ["--start", "3:0", "--end", "3:3"]),
      {},
      diffText([["-one", "+ONE"]]),
    );
    assert.equal(third.code, 0);
    assert.equal(third.stdout, "one\ntwo\nONE\n");
    assert.equal(third.stderr, "rev 1\n");
    const flipped = await run(
      editArgs(port, "repeat.md", ["--start", "3:3", "--end", "3:0"]),
      {},
      diffText([["-ONE", "+one"]]),
    );
    assert.equal(flipped.code, 0);
    assert.equal(flipped.stdout, ranged);
    assert.equal(await fs.readFile(path.join(dir, "repeat.md"), "utf8"), ranged);
  });
});

test("a diff publishes one splice per hunk and skips text between them", async () => {
  await withDocs(async ({ dir, port }) => {
    const body = "Alpha\n\nBeta\n\nGamma\n";
    const next = "A\n\nBeta\n\nG\n";
    await fs.writeFile(path.join(dir, "gap.md"), body);
    await fs.writeFile(path.join(dir, "gap-json.md"), body);
    const watcher = await hello(port, "watch");
    try {
      await openDoc(watcher, "watch", "gap.md");
      const edited = await run(
        editArgs(port, "gap.md"),
        {},
        diffText([["-Alpha", "+A"], ["-Gamma", "+G"]]),
      );
      assert.equal(edited.code, 0);
      assert.equal(edited.stdout, next);
      assert.equal(edited.stderr, "rev 2\n");
      assert.equal(await fs.readFile(path.join(dir, "gap.md"), "utf8"), next);
      const first = await watcher.next((msg) => msg.type === "doc" && msg.path === "gap.md");
      const second = await watcher.next((msg) => msg.type === "doc" && msg.path === "gap.md");
      assert.equal(first.actor, "user");
      assert.equal(second.actor, "user");
      assert.equal(first.text.includes("Gamma"), false);
      assert.equal(first.text.includes("Beta"), true);
      assert.ok(first.from > body.indexOf("Beta"));
      assert.equal(second.text, next);
      assert.ok(second.to <= body.indexOf("Beta"));

      const json = await run(
        ["--json", ...editArgs(port, "gap-json.md")],
        {},
        diffText([["-Alpha", "+A"], ["-Gamma", "+G"]]),
      );
      assert.equal(json.code, 0);
      assert.equal(json.stderr, "");
      assert.equal(json.stdout, `${JSON.stringify({ path: "gap-json.md", rev: 2, text: next })}\n`);
    } finally {
      watcher.ws.close();
    }
  });
});

test("a Gamma change leaves a Beta hunk applicable, and a held Beta span names that user", async () => {
  await withDocs(async ({ dir, port }) => {
    const body = "Alpha\nBeta\nGamma\n";
    await fs.writeFile(path.join(dir, "greek.md"), body);
    await fs.writeFile(path.join(dir, "held.md"), body);
    const gamma = await run(editArgs(port, "greek.md"), {}, diffText([["-Gamma", "+Gone"]]));
    assert.equal(gamma.code, 0);
    assert.equal(gamma.stdout, "Alpha\nBeta\nGone\n");
    const beta = await run(
      editArgs(port, "greek.md", ["--start", "2:0", "--end", "2:4"]),
      {},
      diffText([["-Beta", "+Bee"]]),
    );
    assert.equal(beta.code, 0);
    assert.equal(beta.stdout, "Alpha\nBee\nGone\n");
    assert.equal(beta.stderr, "rev 2\n");
    assert.equal(await fs.readFile(path.join(dir, "greek.md"), "utf8"), "Alpha\nBee\nGone\n");

    const holder = await hello(port, "holder");
    try {
      const opened = await openDoc(holder, "holder", "held.md");
      const at = opened.text.indexOf("Beta");
      holder.send({
        type: "lock",
        username: "holder",
        path: "held.md",
        anchor: at,
        cursor: at + 4,
        rev: opened.rev,
      });
      await holder.next((msg) => msg.type === "locks" && msg.path === "held.md");
      const blocked = await run(editArgs(port, "held.md"), {}, diffText([["-Beta", "+Bee"]]));
      assert.equal(blocked.code, shellStatus(409));
      assert.equal(blocked.stdout, body);
      assert.equal(blocked.stderr, "rev 0\nconflict\nheld by holder\n");
      assert.equal(await fs.readFile(path.join(dir, "held.md"), "utf8"), body);
      const json = await run(
        ["--json", ...editArgs(port, "held.md")],
        {},
        diffText([["-Beta", "+Bee"]]),
      );
      assert.equal(json.code, shellStatus(409));
      assert.equal(json.stderr, "");
      assert.equal(
        json.stdout,
        `${JSON.stringify({ path: "held.md", rev: 0, text: body, error: "conflict", heldBy: "holder" })}\n`,
      );
    } finally {
      holder.ws.close();
    }
  });
});

test("T-cli-stale", async () => {
  await withDocs(async ({ dir, port }) => {
    const missing = await run(editArgs(port, "hello.md"), {}, diffText([["-missing", "+x"]]));
    assert.equal(missing.code, shellStatus(409));
    assert.equal(missing.stdout, HELLO);
    assert.equal(missing.stderr, "rev 0\ncontext\n");
    assert.equal(await fs.readFile(path.join(dir, "hello.md"), "utf8"), HELLO);

    const json = await run(
      ["--json", ...editArgs(port, "hello.md")],
      {},
      diffText([["-missing", "+x"]]),
    );
    assert.equal(json.code, shellStatus(409));
    assert.equal(json.stderr, "");
    assert.equal(
      json.stdout,
      `${JSON.stringify({ path: "hello.md", rev: 0, text: HELLO, error: "context" })}\n`,
    );

    const past = await run(
      editArgs(port, "hello.md", ["--start", "9:0", "--end", "9:1"]),
      {},
      diffText([["-hello line", "+x"]]),
    );
    assert.equal(past.code, shellStatus(400));
    assert.equal(past.stdout, "");
    assert.equal(past.stderr, "error 400\n");
    assert.equal(await fs.readFile(path.join(dir, "hello.md"), "utf8"), HELLO);

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
    const later = await run(
      ["--port", String(port), "--user", "other", "--repo", "docs", "edit", "notes/draft.md"],
      {},
      diffText([["-a draft", "+nope"]]),
    );
    assert.equal(later.code, shellStatus(409));
    assert.equal(later.stdout, DRAFT);
    assert.equal(later.stderr, "rev 0\nconflict\nheld by holder\n");
    assert.equal(await fs.readFile(path.join(dir, "notes", "draft.md"), "utf8"), DRAFT);
    await assert.rejects(() => git(dir, ["rev-parse", "HEAD"]));
    holder.ws.close();
  });
});

test("T-cli-matches", async () => {
  await withDocs(async ({ dir, port }) => {
    const watcher = await hello(port, "watch");
    await openDoc(watcher, "watch", "hello.md");
    await fs.writeFile(path.join(dir, "lines.md"), "line\nline\n");
    const many = await run(editArgs(port, "lines.md"), {}, diffText([["-line", "+row"]]));
    assert.equal(many.code, 2);
    assert.equal(many.stdout, "");
    assert.equal(many.stderr, "matches 2\n");
    await delay(100);
    assert.equal(sawOwnEdit(watcher.queue, "user"), false);
    assert.equal(await fs.readFile(path.join(dir, "hello.md"), "utf8"), HELLO);
    assert.equal(await fs.readFile(path.join(dir, "lines.md"), "utf8"), "line\nline\n");

    await fs.writeFile(path.join(dir, "triple.md"), "a\na\na\n");
    const overlap = await run(editArgs(port, "triple.md"), {}, diffText([["-a", "-a", "+b"]]));
    assert.equal(overlap.code, 2);
    assert.equal(overlap.stdout, "");
    assert.equal(overlap.stderr, "overlap\n");
    assert.equal(await fs.readFile(path.join(dir, "triple.md"), "utf8"), "a\na\na\n");
    await assert.rejects(() => git(dir, ["rev-parse", "HEAD"]));
    watcher.ws.close();
  });
});

test("T-cli-noop", async () => {
  await withDocs(async ({ dir, port }) => {
    const watcher = await hello(port, "watch");
    await openDoc(watcher, "watch", "hello.md");
    const same = await run(editArgs(port, "hello.md"), {}, diffText([[" hello line"]]));
    assert.equal(same.code, 0);
    assert.equal(same.stdout, HELLO);
    assert.equal(same.stderr, "rev 0\n");
    const json = await run(
      ["--json", ...editArgs(port, "hello.md")],
      {},
      diffText([["-hello line", "+hello line"]]),
    );
    assert.equal(json.code, 0);
    assert.equal(json.stderr, "");
    assert.equal(json.stdout, `${JSON.stringify({ path: "hello.md", rev: 0, text: HELLO })}\n`);
    await delay(100);
    assert.equal(sawOwnEdit(watcher.queue, "user"), false);
    assert.equal(await fs.readFile(path.join(dir, "hello.md"), "utf8"), HELLO);
    await assert.rejects(() => git(dir, ["rev-parse", "HEAD"]));
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
    const dead = await run(["--port", String(closed), "--user", "user", "--repo", "docs", "list"]);
    assert.equal(dead.code, 1);
    assert.equal(dead.stderr, "");
    assert.ok(Date.now() - deadStarted < 4000);
  } catch (err) {
    gate.close();
    throw err;
  }

  await withDocs(async ({ dir, port }) => {
    const fromEnv = await run(
      ["--port", String(port), "--repo", "docs", "edit", "hello.md"],
      { VIEWMARK_USER: "envuser" },
      diffText([["-hello line", "+howdy line"]]),
    );
    assert.equal(fromEnv.code, 0);
    assert.equal(fromEnv.stdout, "howdy line\nsecond line\n");
    await delay(400);
    await assert.rejects(() => git(dir, ["rev-parse", "HEAD"]));

    const flagged = await run(
      [
        "--user", "flaguser",
        "--port", String(port),
        "--repo", "docs",
        "edit", "notes/draft.md",
      ],
      { VIEWMARK_USER: "envuser" },
      diffText([["-a draft", "+flagged"]]),
    );
    assert.equal(flagged.code, 0);
    assert.equal(flagged.stdout, "flagged\n");
    await delay(400);
    await assert.rejects(() => git(dir, ["rev-parse", "HEAD"]));

    const shown = await run(["--port", String(port), "show", "notes/draft.md"], { VIEWMARK_USER: "a<b" });
    assert.equal(shown.code, 2);
    const override = await run(["--user", "user", "--repo", "docs", "--port", String(port), "show", "notes/draft.md"], {
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
    const res = await run(["--port", String(server.address().port), "--user", "user", "--repo", "docs", "list"]);
    const elapsed = Date.now() - started;
    assert.equal(res.code, 1);
    assert.equal(res.stdout, "");
    assert.ok(elapsed >= 4500 && elapsed < 9000, String(elapsed));
    assert.deepEqual(messages.map((msg) => msg.type), ["hello", "repo", "list", "pong"]);
    assert.equal(messages[1].name, "docs");
    assert.equal(messages[3].username, "user");
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
const SEED_ID = "seedmark";
const SEED_CREATED = "2026-10-05T00:00:00.000Z";
const SEED_TICKET = {
  id: SEED_ID,
  title: "Markdown in a ticket",
  state: "new",
  type: "task",
  priority: "medium",
  parent: "",
  depends: [],
  reporter: "Viewmark",
  created: SEED_CREATED,
};
const SEED_LINE = `${SEED_ID}\t${SEED_CREATED}\tnew\ttask\tmedium\tMarkdown in a ticket\n`;
const BODY = "Keep me\n\ntitle: not a header\n";

function ticketErr(fields, conflict = false) {
  const parent = fields.parent === "" ? "parent" : `parent ${fields.parent}`;
  const depends = fields.depends.length === 0 ? "depends" : `depends ${fields.depends.join(",")}`;
  const type = fields.type ?? "task";
  const priority = fields.priority ?? "medium";
  const lines = [
    `rev ${fields.rev}`,
    `title ${fields.title}`,
    `state ${fields.state}`,
    `type ${type}`,
    `priority ${priority}`,
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
    type: fields.type ?? "task",
    priority: fields.priority ?? "medium",
    parent: fields.parent,
    depends: fields.depends,
    reporter: fields.reporter,
    created: fields.created,
    text: fields.text,
  };
}

async function runFast(args, extraEnv, input) {
  const started = Date.now();
  const res = await run(args, extraEnv, input);
  assert.ok(Date.now() - started < 4000, `${args.join(" ")} took ${Date.now() - started}ms`);
  return res;
}

async function withHub(fn) {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-cli-state-"));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-cli-docs-"));
  const server = await start(0, state);
  try {
    await registerRepo(server.address().port, "docs", "Docs", dir);
    await fn({ dir, port: server.address().port });
  } finally {
    await closeServer(server);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(state, { recursive: true, force: true });
  }
}

async function writeTicket(dir, fields) {
  const text = composeTicket({
    parent: "",
    depends: [],
    body: "",
    reporter: "indexer",
    state: "new",
    type: "task",
    priority: "medium",
    ...fields,
  });
  assert.ok(text);
  await fs.mkdir(path.join(dir, "tickets"), { recursive: true });
  await fs.writeFile(path.join(dir, "tickets", `${fields.id}.md`), text);
  return text;
}

function ticketArgs(port, args, user = "user") {
  return ["--port", String(port), "--user", user, "--repo", "docs", ...args];
}

async function captureCreates(args) {
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
        const msg = JSON.parse(payload.toString("utf8"));
        messages.push(msg);
        if (msg.type !== "ticket.create") return;
        socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify({
          type: "file",
          path: "tickets/aaaaaaaa.md",
          rev: 0,
          text: "",
          ticket: {
            id: "aaaaaaaa",
            title: msg.title,
            state: msg.state || "new",
            type: msg.ticketType || "task",
            priority: msg.priority || "medium",
            parent: "",
            depends: [],
            reporter: "user",
            created: "2026-10-04T00:00:00.000Z",
          },
        }))));
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
  });
  await listen(server);
  try {
    const res = await runFast(["--port", String(server.address().port), "--user", "user", "--repo", "docs", ...args]);
    return { res, messages };
  } finally {
    peer?.destroy();
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
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
      ["--port", String(gate.port), "--user", "user", "--repo", "docs", "ticket"],
      ["--port", String(gate.port), "--user", "user", "--repo", "docs", "ticket", "nope"],
      ["--port", String(gate.port), "--user", "user", "--repo", "docs", "ticket", "list", "extra"],
      ["--port", String(gate.port), "--user", "user", "--repo", "docs", "ticket", "list", "--closed=yes"],
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
    assert.equal(empty.stdout, SEED_LINE);
    assert.equal(empty.stderr, "");
    const emptyJson = await runFast(["--json", ...ticketArgs(port, ["ticket", "list", "--closed"])]);
    assert.equal(emptyJson.code, 0);
    assert.equal(emptyJson.stderr, "");
    assert.equal(emptyJson.stdout, `${JSON.stringify({ tickets: [SEED_TICKET] })}\n`);

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
    assert.equal(docs.stdout, "welcome.md\n");
    assert.equal(docs.stderr, "");

    const listed = await runFast(ticketArgs(port, ["ticket", "list"]));
    assert.equal(listed.code, 0);
    assert.equal(listed.stderr, "");
    assert.equal(listed.stdout, [
      `${B}\t${T0}\tnew\ttask\tmedium\tBeta\n`,
      `${C}\t${T1}\ttriaged\ttask\tmedium\tSee\n`,
      `${Z}\t${T3}\tin progress\ttask\tmedium\tHas spaces\n`,
      SEED_LINE,
    ].join(""));

    const closed = await runFast(ticketArgs(port, ["--closed", "ticket", "list"]));
    assert.equal(closed.code, 0);
    assert.equal(closed.stderr, "");
    assert.equal(closed.stdout, [
      `${A}\t${T0}\tclosed\ttask\tmedium\tAlpha\n`,
      `${B}\t${T0}\tnew\ttask\tmedium\tBeta\n`,
      `${C}\t${T1}\ttriaged\ttask\tmedium\tSee\n`,
      `${Z}\t${T3}\tin progress\ttask\tmedium\tHas spaces\n`,
      SEED_LINE,
    ].join(""));

    const json = await runFast(["--json", ...ticketArgs(port, ["ticket", "list"])]);
    assert.equal(json.code, 0);
    assert.equal(json.stderr, "");
    const open = JSON.parse(json.stdout);
    assert.deepEqual(open, {
      tickets: [
        { id: B, title: "Beta", state: "new", type: "task", priority: "medium", parent: "", depends: [], reporter: "indexer", created: T0 },
        {
          id: C,
          title: "See",
          state: "triaged",
          type: "task",
          priority: "medium",
          parent: B,
          depends: [A, Z],
          reporter: "indexer",
          created: T1,
        },
        {
          id: Z,
          title: "Has spaces",
          state: "in progress",
          type: "task",
          priority: "medium",
          parent: "",
          depends: [],
          reporter: "indexer",
          created: T3,
        },
        SEED_TICKET,
      ],
    });
    for (const ticket of open.tickets) {
      assert.deepEqual(Object.keys(ticket), ["id", "title", "state", "type", "priority", "parent", "depends", "reporter", "created"]);
    }

    const all = await runFast(ticketArgs(port, ["ticket", "--json", "list", "--closed"]));
    assert.equal(all.stderr, "");
    const parsed = JSON.parse(all.stdout);
    assert.deepEqual(parsed.tickets.map((ticket) => ticket.id), [A, B, C, Z, SEED_ID]);
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
      const res = await runFast(["--port", String(gate.port), "--user", "user", "--repo", "docs", ...args]);
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
      "id", "path", "rev", "title", "state", "type", "priority", "parent", "depends", "reporter", "created", "text",
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
      ["ticket", "create", "--title", "Hello", "--type", "nope"],
      ["ticket", "create", "--title", "Hello", "--type", ""],
      ["ticket", "create", "--title", "Hello", "--type", "Bug"],
      ["ticket", "create", "--title", "Hello", "--priority", "urgent"],
      ["ticket", "create", "--title", "Hello", "--priority", ""],
      ["ticket", "create", "--title", "Hello", "--priority", "Medium"],
      ["ticket", "create", "--title", "Hello", "extra"],
      ["ticket", "create", "--state", "new"],
    ];
    for (const args of cases) {
      const res = await runFast(["--port", String(gate.port), "--user", "user", "--repo", "docs", ...args]);
      assert.equal(res.code, 2, args.join(" "));
      assert.equal(res.stdout, "");
    }
    assert.equal(gate.hits.length, 0);
  } finally {
    await gate.close();
  }

  const omitted = await captureCreates(["ticket", "create", "--title", "Hello"]);
  assert.equal(omitted.res.code, 0);
  const omittedCreate = omitted.messages.find((msg) => msg.type === "ticket.create");
  assert.equal(omittedCreate.title, "Hello");
  assert.equal(Object.hasOwn(omittedCreate, "priority"), false);
  const sentHigh = await captureCreates(["ticket", "create", "--title", "Hot", "--priority", "high"]);
  assert.equal(sentHigh.res.code, 0);
  const highCreate = sentHigh.messages.find((msg) => msg.type === "ticket.create");
  assert.equal(highCreate.priority, "high");
  assert.equal(Object.hasOwn(highCreate, "ticketType"), false);

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
    assert.equal(disk.type, "task");
    assert.equal(disk.parent, "");
    assert.deepEqual(disk.depends, []);
    assert.equal(disk.reporter, "user");
    assert.equal(disk.created, stamp);
    assert.equal(disk.body, "");
    assert.equal(disk.priority, "medium");
    const shown = await runFast(ticketArgs(port, ["ticket", "show", id]));
    assert.equal(shown.stdout, "");
    assert.equal(shown.stderr, ticketErr({
      rev: 0,
      title: "Hello",
      state: "new",
      type: "task",
      parent: "",
      depends: [],
      reporter: "user",
      created: stamp,
    }));
    assert.match(shown.stderr, /state new\ntype task\npriority medium\n/);

    const hot = await runFast(ticketArgs(port, ["ticket", "create", "--title", "Hot", "--priority=high"]));
    assert.equal(hot.code, 0);
    const hotId = hot.stdout.trim();
    const hotDisk = parseTicket(hotId, await fs.readFile(path.join(dir, "tickets", `${hotId}.md`), "utf8"));
    assert.equal(hotDisk.priority, "high");
    assert.equal(hotDisk.type, "task");
    assert.equal(hotDisk.state, "new");
    const hotShown = await runFast(ticketArgs(port, ["ticket", "show", hotId]));
    assert.match(hotShown.stderr, /type task\npriority high\n/);

    const bug = await runFast(ticketArgs(port, ["ticket", "create", "--title", "Bug", "--type", "bug"]));
    assert.equal(bug.code, 0);
    const bugId = bug.stdout.trim();
    const bugDisk = parseTicket(bugId, await fs.readFile(path.join(dir, "tickets", `${bugId}.md`), "utf8"));
    assert.equal(bugDisk.type, "bug");
    assert.equal(bugDisk.state, "new");
    assert.equal(bugDisk.title, "Bug");
    assert.equal(bugDisk.body, "");
    const bugShown = await runFast(ticketArgs(port, ["ticket", "show", bugId]));
    assert.match(bugShown.stderr, /type bug\n/);

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
      ["--user", "flaguser", "--port", String(port), "--repo", "docs", "ticket", "create", "--title", "Flagged"],
      { VIEWMARK_USER: "envuser" },
    );
    assert.equal(flagged.code, 0);
    assert.match(flagged.stderr, /^rev 0\nreporter flaguser\ncreated /);

    const fromEnv = await runFast(
      ["--port", String(port), "--repo", "docs", "ticket", "create", "--title", "From env"],
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

test("T-cli-ticket-body", async () => {
  const body = "See the log.\n\nNext.\n";
  await withHub(async ({ dir, port }) => {
    const created = await runFast(ticketArgs(port, ["ticket", "create", "--title", "Logged"]), {}, body);
    assert.equal(created.code, 0);
    assert.match(created.stdout, /^[23456789abcdefghjkmnpqrstuvwxyz]{8}\n$/);
    const id = created.stdout.trim();
    const shown = await runFast(ticketArgs(port, ["ticket", "show", id]));
    assert.equal(shown.code, 0);
    assert.equal(shown.stdout, body);
    const raw = await fs.readFile(path.join(dir, "tickets", `${id}.md`), "utf8");
    const splitAt = raw.indexOf("\n\n");
    assert.ok(splitAt >= 0);
    assert.equal(raw.slice(splitAt + 2), body);
    assert.equal(parseTicket(id, raw).body, body);

    const empty = await runFast(ticketArgs(port, ["ticket", "create", "--title", "Empty"]));
    assert.equal(empty.code, 0);
    const emptyId = empty.stdout.trim();
    const emptyRaw = await fs.readFile(path.join(dir, "tickets", `${emptyId}.md`), "utf8");
    const emptySplit = emptyRaw.indexOf("\n\n");
    assert.ok(emptySplit >= 0);
    assert.equal(emptyRaw.slice(emptySplit + 2), "");
    assert.equal(parseTicket(emptyId, emptyRaw).body, "");
    const emptyShown = await runFast(ticketArgs(port, ["ticket", "show", emptyId]));
    assert.equal(emptyShown.code, 0);
    assert.equal(emptyShown.stdout, "");

    const namesBefore = (await fs.readdir(path.join(dir, "tickets"))).sort();
    const kept = await fs.readFile(path.join(dir, "tickets", `${id}.md`), "utf8");
    const keptEmpty = await fs.readFile(path.join(dir, "tickets", `${emptyId}.md`), "utf8");
    const client = await hello(port, "user");
    for (const bad of [1, null, false, {}, []]) {
      client.send({ type: "ticket.create", username: "user", title: "Bad", body: bad });
      assert.deepEqual(
        await client.next((msg) => msg.type === "error" || msg.type === "file" || msg.type === "tickets"),
        { type: "error", status: 400 },
      );
    }
    client.ws.close();
    assert.deepEqual((await fs.readdir(path.join(dir, "tickets"))).sort(), namesBefore);
    assert.equal(await fs.readFile(path.join(dir, "tickets", `${id}.md`), "utf8"), kept);
    assert.equal(await fs.readFile(path.join(dir, "tickets", `${emptyId}.md`), "utf8"), keptEmpty);
  });
});

test("T-cli-ticket-set", async () => {
  const gate = await trap();
  try {
    const cases = [
      ["ticket", "set", "short", "--rev", "0", "--title", "Hello"],
      ["ticket", "set", "iiiiiiii", "--rev", "0", "--title", "Hello"],
      ["ticket", "set", A, "--rev", "1.5", "--title", "Hello"],
      ["ticket", "set", A, "--rev", "0"],
      ["ticket", "set", A, "--rev", "0", "--title", ""],
      ["ticket", "set", A, "--rev", "0", "--title", "   "],
      ["ticket", "set", A, "--rev", "0", "--state", "done"],
      ["ticket", "set", A, "--rev", "0", "--state", "closed "],
      ["ticket", "set", A, "--rev", "0", "--type", "nope"],
      ["ticket", "set", A, "--rev", "0", "--type", ""],
      ["ticket", "set", A, "--rev", "0", "--type", "Bug"],
      ["ticket", "set", A, "--rev", "0", "--priority", "nope"],
      ["ticket", "set", A, "--rev", "0", "--priority", ""],
      ["ticket", "set", A, "--rev", "0", "--priority", "HIGH"],
      ["ticket", "set", A, "--rev", "0", "--parent", "123"],
      ["ticket", "set", A, "--rev", "0", "--parent", "nonee"],
      ["ticket", "set", A, "--rev", "0", "--depends", ""],
      ["ticket", "set", A, "--rev", "0", "--depends", `${A},`],
      ["ticket", "set", A, "--rev", "0", "--depends", `${A},iiiiiiii`],
      ["ticket", "set", A, "extra", "--rev", "0", "--title", "Hello"],
    ];
    for (const args of cases) {
      const res = await runFast(["--port", String(gate.port), "--user", "user", "--repo", "docs", ...args]);
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
      const missing = await runFast(ticketArgs(port, ["ticket", "set", D, "--title", "Nope"]));
      assert.equal(missing.code, shellStatus(404));
      assert.equal(missing.stdout, "");
      assert.equal(missing.stderr, "error 404\n");

      const sameTitle = await runFast(ticketArgs(port, ["ticket", "set", B, "--title", "  Beta  "]));
      assert.equal(sameTitle.code, 0);
      assert.equal(sameTitle.stdout, BODY);
      assert.equal(sameTitle.stderr, ticketErr(view));
      await assertNoTicketBroadcast(watcher);

      const sameDepends = await runFast(ticketArgs(port, ["ticket", "set", B, "--depends", `${C}, ${A}`]));
      assert.equal(sameDepends.code, 0);
      assert.equal(sameDepends.stdout, BODY);
      assert.equal(sameDepends.stderr, ticketErr(view));
      await assertNoTicketBroadcast(watcher);

      const sameParent = await runFast(ticketArgs(port, ["ticket", "set", B, "--parent=none"]));
      assert.equal(sameParent.code, 0);
      assert.equal(sameParent.stderr, ticketErr(view));
      await assertNoTicketBroadcast(watcher);
      assert.equal(await fs.readFile(bPath, "utf8"), original);

      const long = await runFast(ticketArgs(port, ["ticket", "set", B, "--title", "x".repeat(201)]));
      assert.equal(long.code, shellStatus(400));
      assert.equal(long.stdout, "");
      assert.equal(long.stderr, "error 400\n");
      const tabbed = await runFast(["--json", ...ticketArgs(port, ["ticket", "set", B, "--title", "bad\ttitle"])]);
      assert.equal(tabbed.code, shellStatus(400));
      assert.equal(tabbed.stdout, "");
      assert.equal(tabbed.stderr, "error 400\n");
      assert.equal(await fs.readFile(bPath, "utf8"), original);

      const renamed = await runFast(ticketArgs(port, ["ticket", "set", B, "--title=Renamed"]));
      assert.equal(renamed.code, 0);
      view.rev = 1;
      view.title = "Renamed";
      assert.equal(renamed.stdout, BODY);
      assert.equal(renamed.stderr, ticketErr(view));
      assert.equal(parseTicket(B, await fs.readFile(bPath, "utf8")).body, BODY);

      const progressed = await runFast(["--json", ...ticketArgs(port, ["ticket", "set", B, "--state", "in progress"])]);
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
        "ticket", "set", B, "--parent", A, "--depends", `${C}, ${A}`,
      ]));
      assert.equal(linked.code, 0);
      view.rev = 3;
      view.parent = A;
      assert.equal(linked.stdout, BODY);
      assert.equal(linked.stderr, ticketErr(view));

      const replaced = await runFast(ticketArgs(port, ["ticket", "set", B, "--depends", ` ${C} `]));
      assert.equal(replaced.code, 0);
      view.rev = 4;
      view.depends = [C];
      assert.equal(replaced.stderr, ticketErr(view));
      assert.deepEqual(parseTicket(B, await fs.readFile(bPath, "utf8")).depends, [C]);

      const cleared = await runFast(ticketArgs(port, [
        "ticket", "set", B, "--parent", "none", "--depends", "none",
      ]));
      assert.equal(cleared.code, 0);
      view.rev = 5;
      view.parent = "";
      view.depends = [];
      assert.equal(cleared.stdout, BODY);
      assert.equal(cleared.stderr, ticketErr(view));

      const beforeMiss = await fs.readFile(bPath, "utf8");
      const miss = await runFast(ticketArgs(port, ["ticket", "set", B, "--parent", D]));
      assert.equal(miss.code, shellStatus(409));
      assert.equal(miss.stdout, BODY);
      assert.equal(miss.stderr, ticketErr(view, true));
      assert.equal(await fs.readFile(bPath, "utf8"), beforeMiss);

      const self = await runFast(["--json", ...ticketArgs(port, ["ticket", "set", B, "--parent", B])]);
      assert.equal(self.code, shellStatus(409));
      assert.equal(self.stderr, "");
      assert.deepEqual(JSON.parse(self.stdout), {
        ...ticketJson({ id: B, path: `tickets/${B}.md`, text: BODY, ...view }),
        error: "conflict",
      });
      assert.equal(await fs.readFile(bPath, "utf8"), beforeMiss);

      const parented = await runFast(ticketArgs(port, ["ticket", "set", B, "--parent", A]));
      assert.equal(parented.code, 0);
      view.rev = 6;
      view.parent = A;
      assert.equal(parented.stderr, ticketErr(view));

      const typed = await runFast(ticketArgs(port, ["ticket", "set", B, "--type", "bug"]));
      assert.equal(typed.code, 0);
      view.rev = 7;
      view.type = "bug";
      assert.equal(typed.stdout, BODY);
      assert.equal(typed.stderr, ticketErr(view));
      const typedDisk = parseTicket(B, await fs.readFile(bPath, "utf8"));
      assert.equal(typedDisk.type, "bug");
      assert.equal(typedDisk.body, BODY);
      assert.equal(typedDisk.state, "in progress");
      assert.equal(typedDisk.title, "Renamed");

      const beforeSame = await fs.readFile(bPath, "utf8");
      const sameType = await runFast(ticketArgs(port, ["ticket", "set", B, "--type", "bug"]));
      assert.equal(sameType.code, 0);
      assert.equal(sameType.stdout, BODY);
      assert.equal(sameType.stderr, ticketErr(view));
      assert.equal(await fs.readFile(bPath, "utf8"), beforeSame);

      const lowered = await runFast(ticketArgs(port, ["ticket", "set", B, "--priority", "low"]));
      assert.equal(lowered.code, 0);
      view.rev = 8;
      view.priority = "low";
      assert.equal(lowered.stdout, BODY);
      assert.equal(lowered.stderr, ticketErr(view));
      assert.equal(parseTicket(B, await fs.readFile(bPath, "utf8")).priority, "low");
      const beforeSamePriority = await fs.readFile(bPath, "utf8");
      const samePriority = await runFast(ticketArgs(port, ["ticket", "set", B, "--priority", "low"]));
      assert.equal(samePriority.code, 0);
      assert.equal(samePriority.stdout, BODY);
      assert.equal(samePriority.stderr, ticketErr(view));
      assert.equal(await fs.readFile(bPath, "utf8"), beforeSamePriority);

      const cycle = await runFast(ticketArgs(port, ["ticket", "set", A, "--parent", B]));
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

      const later = await runFast(ticketArgs(port, ["ticket", "set", B, "--title", "Later"]));
      assert.equal(later.code, 0);
      assert.equal(later.stdout, BODY);
      view.rev = 9;
      view.title = "Later";
      assert.equal(later.stderr, ticketErr(view));
      const laterDisk = parseTicket(B, await fs.readFile(bPath, "utf8"));
      assert.equal(laterDisk.title, "Later");
      assert.equal(laterDisk.body, BODY);
      assert.equal(laterDisk.parent, A);
      await assert.rejects(() => git(dir, ["rev-parse", "HEAD"]));
    } finally {
      watcher.ws.close();
    }
  });
});

test("T-cli-ticket-purge", async () => {
  const gate = await trap();
  try {
    const extra = await runFast(["--port", String(gate.port), "--user", "user", "--repo", "docs", "ticket", "purge", "extra"]);
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
    assert.equal(remain.stdout, `${B}\t${T0}\tnew\ttask\tmedium\tBeta\n${E}\t${T2}\tnew\ttask\tmedium\tEe\n${SEED_LINE}`);

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
    assert.equal(left.stdout, `${B}\t${T0}\tnew\ttask\tmedium\tBeta\n${E}\t${T2}\tnew\ttask\tmedium\tEe\n${SEED_LINE}`);
    await assert.rejects(() => git(dir, ["rev-parse", "HEAD"]));
  });
});

test("T-cli-ticket-delete", async () => {
  const gate = await trap();
  try {
    const bad = await run(["--port", String(gate.port), "--user", "user", "--repo", "docs", "ticket", "delete", "nope"]);
    assert.equal(bad.code, 2);
    assert.equal(bad.stdout, "");
    assert.equal(bad.stderr, "viewmark: invalid id\n");
    const missingId = await run(["--port", String(gate.port), "--user", "user", "--repo", "docs", "ticket", "delete"]);
    assert.equal(missingId.code, 2);
    assert.equal(missingId.stdout, "");
    assert.equal(missingId.stderr, "viewmark: id required\n");
    const extra = await run([
      "--port", String(gate.port),
      "--user", "user",
      "--repo", "docs",
      "ticket",
      "delete",
      A,
      "extra",
    ]);
    assert.equal(extra.code, 2);
    assert.equal(extra.stdout, "");
    assert.equal(extra.stderr, "viewmark: unexpected argument\n");
    assert.equal(gate.hits.length, 0);
  } finally {
    await gate.close();
  }

  await withHub(async ({ dir, port }) => {
    const parentText = await writeTicket(dir, { id: B, title: "Beta", created: T0, body: "beta\n" });
    await writeTicket(dir, { id: C, title: "See", created: T1, body: "see\n" });
    await writeTicket(dir, { id: E, title: "Ee", created: T2, body: "ee\n" });
    const linked = await runFast(ticketArgs(port, [
      "ticket", "set", C, "--parent", B, "--depends", B,
    ]));
    assert.equal(linked.code, 0);
    assert.equal(parseTicket(C, await fs.readFile(path.join(dir, "tickets", `${C}.md`), "utf8")).parent, B);

    const absent = await runFast(ticketArgs(port, ["ticket", "delete", A]));
    assert.equal(absent.code, shellStatus(404));
    assert.equal(absent.stdout, "");
    assert.equal(absent.stderr, "error 404\n");

    const holder = await hello(port, "Ada");
    await openDoc(holder, "Ada", `tickets/${B}.md`);
    const held = await runFast(ticketArgs(port, ["ticket", "delete", B]));
    assert.equal(held.code, shellStatus(409));
    assert.equal(held.stdout, "");
    assert.equal(held.stderr, "error 409\nheld by Ada\n");
    assert.equal(await fs.readFile(path.join(dir, "tickets", `${B}.md`), "utf8"), parentText);
    const witness = await hello(port, "Bea");
    await openDoc(witness, "Bea", `tickets/${B}.md`);
    const released = witness.next((msg) => msg.type === "locks" && msg.path === `tickets/${B}.md`);
    holder.ws.close();
    await released;
    await openDoc(witness, "Bea", `tickets/${C}.md`);

    const removed = await runFast(ticketArgs(port, ["ticket", "delete", B]));
    assert.equal(removed.code, 0);
    assert.equal(removed.stdout, `tickets/${B}.md\n`);
    assert.equal(removed.stderr, "");
    await assert.rejects(() => fs.lstat(path.join(dir, "tickets", `${B}.md`)));
    const child = parseTicket(C, await fs.readFile(path.join(dir, "tickets", `${C}.md`), "utf8"));
    assert.equal(child.parent, "");
    assert.deepEqual(child.depends, []);
    assert.equal(child.body, "see\n");

    await openDoc(witness, "Bea", `tickets/${E}.md`);
    const json = await runFast(["--json", ...ticketArgs(port, ["ticket", "delete", C])]);
    assert.equal(json.code, 0);
    assert.equal(json.stderr, "");
    assert.equal(json.stdout, `${JSON.stringify({ path: `tickets/${C}.md` })}\n`);
    await assert.rejects(() => fs.lstat(path.join(dir, "tickets", `${C}.md`)));
    witness.ws.close();
  });
});

test("T-cli-repo", async () => {
  const gate = await trap();
  try {
    const noDesc = await run([
      "--port", String(gate.port),
      "--user", "user",
      "repo", "register",
      "--name", "one",
      "--path", os.tmpdir(),
    ]);
    assert.equal(noDesc.code, 2);
    assert.equal(noDesc.stdout, "");
    const noRepo = await run(["--port", String(gate.port), "--user", "user", "list"]);
    assert.equal(noRepo.code, 2);
    const flagged = await run(["--port", String(gate.port), "--user", "user", "--repo", "one", "repo", "list"]);
    assert.equal(flagged.code, 2);
    assert.equal(gate.hits.length, 0);
    const closed = gate.port;
    await gate.close();
    const dead = await run(["--port", String(closed), "--user", "user", "list"]);
    assert.equal(dead.code, 2);
  } catch (err) {
    await gate.close().catch(() => {});
    throw err;
  }

  const state = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-cli-repo-state-"));
  const docs = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-cli-repo-"));
  await fs.writeFile(path.join(docs, "a.md"), "file\n");
  const server = await start(0, state);
  try {
    const port = server.address().port;
    const registered = await run([
      "--port", String(port),
      "--user", "user",
      "repo", "register",
      "--name", "one",
      "--description", "One",
      "--path", docs,
    ]);
    assert.equal(registered.code, 0);
    assert.equal(registered.stderr, "");
    assert.equal(registered.stdout, "one\n");

    const real = await fs.realpath(docs);
    const listed = await run(["--port", String(port), "--user", "user", "repo", "list"]);
    assert.equal(listed.code, 0);
    assert.equal(listed.stderr, "");
    assert.equal(listed.stdout, `one\tOne\t${real}\n`);

    const json = await run(["--json", "--port", String(port), "--user", "user", "repo", "list"]);
    assert.equal(json.code, 0);
    assert.equal(json.stderr, "");
    assert.equal(json.stdout, `${JSON.stringify({ repos: [{ name: "one", description: "One", path: real }] })}\n`);

    const files = await run(["--port", String(port), "--user", "user", "--repo", "one", "list"]);
    assert.equal(files.code, 0);
    assert.equal(files.stderr, "");
    assert.equal(files.stdout, "a.md\n");

    const nope = await run(["--port", String(port), "--user", "user", "--repo", "nope", "list"]);
    assert.equal(nope.code, shellStatus(404));
    assert.equal(nope.stdout, "");
    assert.equal(nope.stderr, "error 404\n");

    const removed = await run(["--port", String(port), "--user", "user", "repo", "deregister", "one"]);
    assert.equal(removed.code, 0);
    assert.equal(removed.stdout, "");
    assert.equal(removed.stderr, "");
    assert.equal(await fs.readFile(path.join(docs, "a.md"), "utf8"), "file\n");

    const again = await run([
      "--json",
      "--port", String(port),
      "--user", "user",
      "repo", "register",
      "--name", "one",
      "--description", "One",
      "--path", docs,
    ]);
    assert.equal(again.code, 0);
    assert.equal(again.stderr, "");
    assert.equal(again.stdout, `${JSON.stringify({ name: "one", description: "One", path: real })}\n`);

    const gone = await run(["--json", "--port", String(port), "--user", "user", "repo", "deregister", "one"]);
    assert.equal(gone.code, 0);
    assert.equal(gone.stderr, "");
    assert.equal(gone.stdout, `${JSON.stringify({ name: "one" })}\n`);
    assert.equal(await fs.readFile(path.join(docs, "a.md"), "utf8"), "file\n");
  } finally {
    await closeServer(server);
    await fs.rm(docs, { recursive: true, force: true });
    await fs.rm(state, { recursive: true, force: true });
  }
});

function getPage(port, requestPath) {
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
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function openCli(args, extraEnv = {}, cwd) {
  const env = { ...process.env };
  delete env.VIEWMARK_USER;
  delete env.VIEWMARK_PORT;
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const child = spawn(process.execPath, [cli, ...args], { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
  const out = [];
  const err = [];
  child.stdout.on("data", (chunk) => out.push(chunk));
  child.stderr.on("data", (chunk) => err.push(chunk));
  const closed = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    closed,
    stdout: () => Buffer.concat(out).toString("utf8"),
    stderr: () => Buffer.concat(err).toString("utf8"),
  };
}

async function readServeLine(proc, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const text = proc.stdout();
    const nl = text.indexOf("\n");
    if (nl >= 0) return text.slice(0, nl + 1);
    if (proc.child.exitCode !== null || proc.child.signalCode !== null) {
      throw new Error(`serve exited code=${proc.child.exitCode} stdout=${JSON.stringify(text)} stderr=${JSON.stringify(proc.stderr())}`);
    }
    await delay(10);
  }
  throw new Error(`timeout stdout=${JSON.stringify(proc.stdout())} stderr=${JSON.stringify(proc.stderr())}`);
}

async function stopCli(proc) {
  if (proc.child.exitCode === null && proc.child.signalCode === null) {
    proc.child.kill("SIGTERM");
    const finished = await Promise.race([proc.closed, delay(1000).then(() => null)]);
    if (!finished && proc.child.exitCode === null && proc.child.signalCode === null) {
      proc.child.kill("SIGKILL");
      await proc.closed;
    }
  }
  return proc.closed;
}

test("T-cli-serve", async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts.start, "node cli.js serve");

  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-cli-serve-"));
  const proc = openCli(["serve", temp, "--port", "0"]);
  try {
    const line = await readServeLine(proc);
    const match = /^127\.0\.0\.1:(\d+)\t(.+)\n$/.exec(line);
    assert.ok(match, JSON.stringify(line));
    const bound = Number(match[1]);
    assert.equal(match[2], await fs.realpath(temp));
    const page = await getPage(bound, "/");
    assert.equal(page.status, 200);
    assert.ok(page.body.includes('id="editor"'));
    assert.equal(proc.child.exitCode, null);
    assert.equal(proc.stderr(), "");
    await stopCli(proc);
    assert.equal(proc.stdout(), line);
  } finally {
    await stopCli(proc);
    await fs.rm(temp, { recursive: true, force: true });
  }

  const ignored = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-cli-serve-user-"));
  const ignoreProc = openCli(
    ["--user", "a<b", "serve", ignored, "--port", "0"],
    { VIEWMARK_USER: "x<y", VIEWMARK_PORT: "1" },
  );
  try {
    const line = await readServeLine(ignoreProc);
    const match = /^127\.0\.0\.1:(\d+)\t(.+)\n$/.exec(line);
    assert.ok(match, JSON.stringify(line));
    assert.notEqual(Number(match[1]), 1);
    assert.equal(match[2], await fs.realpath(ignored));
    const page = await getPage(Number(match[1]), "/");
    assert.equal(page.status, 200);
    assert.ok(page.body.includes('id="editor"'));
    assert.equal(ignoreProc.stderr(), "");
  } finally {
    await stopCli(ignoreProc);
    await fs.rm(ignored, { recursive: true, force: true });
  }

  const fromEnv = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-cli-serve-env-"));
  const envProc = openCli(["serve", fromEnv], { VIEWMARK_PORT: "0" });
  try {
    const line = await readServeLine(envProc);
    assert.match(line, /^127\.0\.0\.1:\d+\t.+\n$/);
    assert.equal(line.slice(line.indexOf("\t") + 1, -1), await fs.realpath(fromEnv));
  } finally {
    await stopCli(envProc);
    await fs.rm(fromEnv, { recursive: true, force: true });
  }

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-cli-serve-cwd-"));
  const relative = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-cli-serve-rel-"));
  const relName = path.basename(relative);
  const relParent = path.dirname(relative);
  const relProc = openCli(["serve", relName, "--port", "0"], {}, relParent);
  const defaultState = path.join(root, "state");
  let defaultExisted = true;
  try {
    await fs.lstat(defaultState);
  } catch {
    defaultExisted = false;
  }
  const defaultProc = openCli(["serve", "--port", "0"], {}, scratch);
  try {
    const relLine = await readServeLine(relProc);
    const relDir = relLine.slice(relLine.indexOf("\t") + 1, -1);
    assert.equal(relDir, await fs.realpath(relative));

    const line = await readServeLine(defaultProc);
    const match = /^127\.0\.0\.1:(\d+)\t(.+)\n$/.exec(line);
    assert.ok(match, JSON.stringify(line));
    assert.equal(match[2], await fs.realpath(defaultState));
    assert.notEqual(match[2], await fs.realpath(scratch));
    const page = await getPage(Number(match[1]), "/");
    assert.equal(page.status, 200);
    assert.ok(page.body.includes('id="editor"'));
  } finally {
    await stopCli(relProc);
    await stopCli(defaultProc);
    await fs.rm(scratch, { recursive: true, force: true });
    await fs.rm(relative, { recursive: true, force: true });
    if (!defaultExisted) await fs.rm(defaultState, { recursive: true, force: true });
  }

  const gate = await trap();
  try {
    for (const args of [
      ["serve", "--repo", "x"],
      ["serve", "--json"],
      ["serve", "--closed"],
      ["serve", "--rev", "1"],
      ["serve", "--find", "a"],
      ["serve", "--replace", "b"],
      ["serve", "--title", "t"],
      ["serve", "--state", "new"],
      ["serve", "--type", "bug"],
      ["serve", "--priority", "high"],
      ["serve", "--parent", "none"],
      ["serve", "--depends", "none"],
      ["serve", "--name", "n"],
      ["serve", "--description", "d"],
      ["serve", "--path", "p"],
      ["serve", "--message", "hi"],
      ["serve", "--start", "1:0"],
      ["serve", "--end", "1:1"],
      ["serve", "one", "two"],
      ["serve", "--port", "nope"],
      ["serve", "--port", "65536"],
    ]) {
      const res = await run(args, { VIEWMARK_PORT: String(gate.port), VIEWMARK_USER: "alice" });
      assert.equal(res.code, 2, args.join(" "));
      assert.equal(res.stdout, "", args.join(" "));
    }
    assert.equal(gate.hits.length, 0);
    const plainRepo = await run(["serve", "--repo", "x"]);
    assert.equal(plainRepo.code, 2);
    assert.equal(plainRepo.stdout, "");
    const plainJson = await run(["serve", "--json"]);
    assert.equal(plainJson.code, 2);
    assert.equal(plainJson.stdout, "");
    assert.equal(gate.hits.length, 0);

    const blocked = path.join(os.tmpdir(), `viewmark-cli-serve-file-${gate.port}`);
    await fs.writeFile(blocked, "x");
    try {
      const failed = await run(["serve", blocked, "--port", "0"]);
      assert.equal(failed.code, 1);
      assert.equal(failed.stdout, "");
      assert.notEqual(failed.stderr, "");
    } finally {
      await fs.rm(blocked, { force: true });
    }

    const busyDir = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-cli-serve-busy-"));
    try {
      const busy = await run(["serve", busyDir, "--port", String(gate.port)]);
      assert.equal(busy.code, 1);
      assert.equal(busy.stdout, "");
      assert.match(busy.stderr, /EADDRINUSE/);
      assert.equal(gate.hits.length, 0);
    } finally {
      await fs.rm(busyDir, { recursive: true, force: true });
    }
  } finally {
    await gate.close();
  }
});

const GROK_LINE = "@2026-10-05T04:14:24.392Z Grok";
const THREAD_BODY = ["How?", "::", GROK_LINE, "Because."].join("\n");
const THREAD_DOC = `See {c1}this{/c1}.\n\n\`\`\`comment c1\n${THREAD_BODY}\n\`\`\`\n`;
const THREAD_REL = "notes/thread.md";
const ORIGINAL_NOTE = `${GROK_LINE}\nBecause.`;

function commentArgs(port, user, args) {
  return ["--port", String(port), "--user", user, "--repo", "docs", "comment", ...args];
}

async function writeThread(dir) {
  const full = path.join(dir, "notes", "thread.md");
  await fs.writeFile(full, THREAD_DOC);
  return full;
}

function notesOf(doc) {
  const thread = commentThreads(doc).find((item) => item.id === "c1");
  if (!thread) return null;
  return parseCommentNotes(thread.body);
}

test("T-comment-reply", async () => {
  await withDocs(async ({ dir, port }) => {
    const full = await writeThread(dir);
    await fs.writeFile(
      path.join(dir, "notes", "done.md"),
      "See {c2}that{/c2}.\n\n```comment c2 resolved\ndone\n```\n",
    );

    const plain = await run(commentArgs(port, "Grok", ["list", THREAD_REL]));
    assert.equal(plain.code, 0);
    assert.equal(plain.stdout, "c1\n");
    assert.equal(plain.stderr, "");
    assert.equal(await fs.readFile(full, "utf8"), THREAD_DOC);

    const json = await run(["--json", ...commentArgs(port, "Grok", ["list", THREAD_REL])]);
    assert.equal(json.code, 0);
    assert.equal(json.stderr, "");
    const listed = JSON.parse(json.stdout);
    assert.deepEqual(Object.keys(listed), ["path", "rev", "threads"]);
    assert.equal(listed.path, THREAD_REL);
    assert.equal(listed.rev, 0);
    assert.deepEqual(listed.threads, [{
      id: "c1",
      resolved: false,
      notes: [
        { id: 0, author: "", time: "", text: "How?" },
        { id: 1, author: "Grok", time: "2026-10-05T04:14:24.392Z", text: "Because." },
      ],
    }]);
    assert.deepEqual(listed.threads[0].notes.map((note) => note.id), [0, 1]);
    assert.deepEqual(Object.keys(listed.threads[0]), ["id", "resolved", "notes"]);
    assert.deepEqual(Object.keys(listed.threads[0].notes[0]), ["id", "author", "time", "text"]);

    const resolved = await run(commentArgs(port, "Grok", ["list", "notes/done.md"]));
    assert.equal(resolved.code, 0);
    assert.equal(resolved.stdout, "c2 resolved\n");
    assert.equal(resolved.stderr, "");

    const shown = await run(commentArgs(port, "Grok", ["show", THREAD_REL, "c1"]));
    assert.equal(shown.code, 0);
    assert.equal(shown.stdout, `${THREAD_BODY}\n`);
    assert.equal(shown.stderr, "rev 0\n");
    const shownJson = await run(["--json", ...commentArgs(port, "Grok", ["show", THREAD_REL, "c1"])]);
    assert.equal(shownJson.code, 0);
    assert.equal(shownJson.stderr, "");
    const one = JSON.parse(shownJson.stdout);
    assert.deepEqual(one, {
      path: THREAD_REL,
      rev: 0,
      id: "c1",
      resolved: false,
      notes: listed.threads[0].notes,
    });

    const empty = await run(commentArgs(port, "Grok", ["list", "hello.md"]));
    assert.equal(empty.code, 0);
    assert.equal(empty.stdout, "");
    assert.equal(empty.stderr, "");

    const separator = await run(commentArgs(port, "Grok", ["reply", THREAD_REL, "c1"]), {}, "Yes.\n::\nno");
    assert.equal(separator.code, shellStatus(400));
    assert.equal(separator.stdout, "");
    assert.equal(separator.stderr, "error 400\n");
    assert.equal(await fs.readFile(full, "utf8"), THREAD_DOC);

    const watcher = await hello(port, "watcher");
    try {
      await openDoc(watcher, "watcher", THREAD_REL);
      const replied = await run(commentArgs(port, "Grok", ["reply", THREAD_REL, "c1"]), {}, "Yes.\n");
      assert.equal(replied.code, 0);
      assert.equal(replied.stdout, "note 2\n");
      assert.equal(replied.stderr, "rev 1\n");
      const docMsg = await watcher.next((msg) => msg.type === "doc" && msg.path === THREAD_REL);
      assert.equal(docMsg.type, "doc");
      const live = notesOf(docMsg.text);
      assert.equal(live[0].raw, "How?");
      assert.equal(live[1].raw, ORIGINAL_NOTE);
      assert.equal(live[2].id, 2);
      assert.match(live[2].raw, /^@\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z Grok\nYes\.\n$/);
      const stored = notesOf(await fs.readFile(full, "utf8"));
      assert.equal(stored[0].raw, "How?");
      assert.equal(stored[1].raw, ORIGINAL_NOTE);
      assert.equal(stored[2].raw, live[2].raw);

      const replyJson = await run(
        ["--json", ...commentArgs(port, "Grok", ["reply", THREAD_REL, "c1"])],
        {},
        "And.\n",
      );
      assert.equal(replyJson.code, 0);
      assert.equal(replyJson.stderr, "");
      assert.deepEqual(JSON.parse(replyJson.stdout), {
        path: THREAD_REL,
        id: "c1",
        note: 3,
        rev: 2,
      });

      const stale = await hello(port, "Grok");
      try {
        stale.send({
          type: "comment.reply",
          username: "Grok",
          path: THREAD_REL,
          id: "c1",
          rev: 0,
          text: "Later.\n",
        });
        const again = await stale.next((msg) => msg.type === "comment" || msg.type === "error");
        assert.equal(again.type, "comment");
        assert.equal(again.note, 4);
        assert.equal(again.rev, 3);
        const notes = notesOf(await fs.readFile(full, "utf8"));
        assert.equal(notes[0].raw, "How?");
        assert.equal(notes[1].raw, ORIGINAL_NOTE);
      } finally {
        stale.ws.close();
      }
    } finally {
      watcher.ws.close();
    }
  });
});

test("T-comment-edit", async () => {
  await withDocs(async ({ dir, port }) => {
    const full = await writeThread(dir);
    const grok = await hello(port, "Grok");
    try {
      grok.send({
        type: "comment.edit",
        username: "Grok",
        path: THREAD_REL,
        id: "c1",
        note: "1",
        rev: 99,
        text: "Updated.",
      });
      const badNote = await grok.next((msg) => msg.type === "error" || msg.type === "comment");
      assert.equal(badNote.status, 400);
      grok.send({
        type: "comment.edit",
        username: "Grok",
        path: THREAD_REL,
        id: "c1",
        note: -1,
        rev: 0,
        text: "Updated.",
      });
      const negative = await grok.next((msg) => msg.type === "error" || msg.type === "comment");
      assert.equal(negative.status, 400);
      assert.equal(await fs.readFile(full, "utf8"), THREAD_DOC);
    } finally {
      grok.ws.close();
    }

    const same = await run(
      commentArgs(port, "Grok", ["edit", THREAD_REL, "c1", "1", "--expect", "Because."]),
      {},
      "Because.",
    );
    assert.equal(same.code, 0);
    assert.equal(same.stdout, "note 1\n");
    assert.equal(same.stderr, "rev 0\n");
    assert.equal(await fs.readFile(full, "utf8"), THREAD_DOC);

    const edited = await run(
      commentArgs(port, "Grok", ["edit", THREAD_REL, "c1", "1", "--expect", "Because."]),
      {},
      "Updated.",
    );
    assert.equal(edited.code, 0);
    assert.equal(edited.stdout, "note 1\n");
    assert.equal(edited.stderr, "rev 1\n");
    const notes = notesOf(await fs.readFile(full, "utf8"));
    assert.equal(notes[0].raw, "How?");
    assert.equal(notes[1].raw, `${GROK_LINE}\nUpdated.`);
    assert.equal(notes[1].id, 1);
    const changed = await fs.readFile(full, "utf8");

    const again = await run(
      commentArgs(port, "Grok", ["edit", THREAD_REL, "c1", "1", "--expect", "Updated."]),
      {},
      "Updated.",
    );
    assert.equal(again.code, 0);
    assert.equal(again.stdout, "note 1\n");
    assert.equal(again.stderr, "rev 1\n");
    assert.equal(await fs.readFile(full, "utf8"), changed);

    const json = await run(
      ["--json", ...commentArgs(port, "Grok", ["edit", THREAD_REL, "c1", "1", "--expect", "Updated."])],
      {},
      "Updated. again",
    );
    assert.equal(json.code, 0);
    assert.equal(json.stderr, "");
    assert.deepEqual(JSON.parse(json.stdout), { path: THREAD_REL, id: "c1", note: 1, rev: 2 });
    assert.equal(notesOf(await fs.readFile(full, "utf8"))[1].raw, `${GROK_LINE}\nUpdated. again`);

    const separator = await run(
      commentArgs(port, "Grok", ["edit", THREAD_REL, "c1", "1", "--expect", "Updated. again"]),
      {},
      "no\n::\n",
    );
    assert.equal(separator.code, shellStatus(400));
    assert.equal(separator.stdout, "");
    assert.equal(separator.stderr, "error 400\n");
    assert.equal(notesOf(await fs.readFile(full, "utf8"))[1].raw, `${GROK_LINE}\nUpdated. again`);
  });
});

test("T-comment-auth", async () => {
  await withDocs(async ({ dir, port }) => {
    const full = await writeThread(dir);
    const watcher = await hello(port, "watcher");
    try {
      await openDoc(watcher, "watcher", THREAD_REL);
      const ada = await run(
        commentArgs(port, "Ada", ["edit", THREAD_REL, "c1", "1", "--expect", "Because."]),
        {},
        "Updated.",
      );
      assert.equal(ada.code, shellStatus(403));
      assert.equal(ada.stdout, "");
      assert.equal(ada.stderr, "error 403\n");
      const note0 = await run(
        commentArgs(port, "Grok", ["edit", THREAD_REL, "c1", "0", "--expect", "How?"]),
        {},
        "Updated.",
      );
      assert.equal(note0.code, shellStatus(403));
      assert.equal(note0.stdout, "");
      assert.equal(note0.stderr, "error 403\n");
      assert.equal(await fs.readFile(full, "utf8"), THREAD_DOC);
      await delay(50);
      assert.equal(watcher.queue.some((msg) => msg.type === "doc"), false);
    } finally {
      watcher.ws.close();
    }
  });
});

test("T-comment-conflict", async () => {
  await withDocs(async ({ dir, port }) => {
    const full = await writeThread(dir);
    const holder = await hello(port, "Ada");
    const witness = await hello(port, "witness");
    try {
      await openDoc(witness, "witness", THREAD_REL);
      const opened = await openDoc(holder, "Ada", THREAD_REL);
      holder.send({
        type: "lock",
        username: "Ada",
        path: THREAD_REL,
        rev: opened.rev,
        anchor: 0,
        cursor: opened.text.length,
      });
      const locks = await holder.next((msg) => msg.type === "locks" && msg.path === THREAD_REL);
      assert.ok(locks.lines.some((line) => line && line.username === "Ada" && line.index === 0));
      const blocked = await run(commentArgs(port, "Grok", ["reply", THREAD_REL, "c1"]), {}, "Yes.\n");
      assert.equal(blocked.code, shellStatus(409));
      assert.equal(blocked.stdout, "");
      assert.equal(blocked.stderr, "error 409\nheld by Ada\n");
      assert.equal(await fs.readFile(full, "utf8"), THREAD_DOC);
      await delay(50);
      assert.equal(witness.queue.some((msg) => msg.type === "doc"), false);

      const released = witness.next((msg) => (
        msg.type === "locks" && msg.path === THREAD_REL && !msg.lines.some((line) => line && line.username === "Ada")
      ));
      holder.ws.close();
      await released;
    } finally {
      holder.ws.close();
      witness.ws.close();
    }

    const edited = await run(
      commentArgs(port, "Grok", ["edit", THREAD_REL, "c1", "1", "--expect", "Because."]),
      {},
      "Updated.",
    );
    assert.equal(edited.code, 0);
    assert.equal(edited.stderr, "rev 1\n");
    const changed = await fs.readFile(full, "utf8");
    assert.notEqual(changed, THREAD_DOC);
    const stale = await run(
      commentArgs(port, "Grok", ["edit", THREAD_REL, "c1", "1", "--expect", "Because."]),
      {},
      "Nope.",
    );
    assert.equal(stale.code, shellStatus(409));
    assert.equal(stale.stdout, "");
    assert.equal(stale.stderr, "error 409\ncontext\n");
    assert.equal(await fs.readFile(full, "utf8"), changed);
    const moved = await run(
      commentArgs(port, "Grok", ["edit", THREAD_REL, "c1", "1", "--expect", "Updated."]),
      {},
      "Nope.",
    );
    assert.equal(moved.code, 0);
    assert.equal(moved.stderr, "rev 2\n");
    assert.equal(notesOf(await fs.readFile(full, "utf8"))[1].raw, `${GROK_LINE}\nNope.`);
  });
});

test("T-comment-usage", async () => {
  const help = await run(["help"]);
  assert.equal(help.code, 0);
  assert.ok(help.stdout.includes("comment:"));
  assert.ok(help.stdout.includes("comment list"));
  assert.ok(help.stdout.includes("comment reply"));
  for (const line of [
    "comment list <path>",
    "comment show <path> <thread>",
    "comment reply <path> <thread>",
    "comment add <path> --start LINE:OFFSET --end LINE:OFFSET",
    "comment edit <path> <thread> <note> --expect TEXT",
    "An agent leaves a question with `comment add PATH --start LINE:OFFSET --end LINE:OFFSET --expect TEXT` and the question on stdin.",
  ]) {
    assert.ok(help.stdout.includes(line), line);
  }
  assert.match(help.stdout, /--repo is required on list, show, create, edit, delete, comment, commit, and ticket\./);

  const gate = await trap();
  try {
    const noRepo = await run(["--port", String(gate.port), "--user", "Grok", "comment", "list", THREAD_REL]);
    assert.equal(noRepo.code, 2);
    assert.equal(noRepo.stdout, "");
    assert.equal(noRepo.stderr, "viewmark: --repo is required\n");

    const cases = [
      [["comment", "list"], "path required"],
      [["comment", "show"], "path required"],
      [["comment", "reply"], "path required"],
      [["comment", "edit"], "path required"],
      [["comment", "list", "a.md", "b.md"], "unexpected argument"],
      [["comment", "show", "a.md"], "unexpected argument"],
      [["comment", "reply", "a.md", "c1", "extra"], "unexpected argument"],
      [["comment", "edit", "a.md", "c1", "1", "extra", "--expect", "x"], "unexpected argument"],
      [["comment", "nope", "a.md"], "unexpected argument"],
      [["comment", "edit", "a.md", "c1"], "invalid note"],
      [["comment", "edit", "a.md", "c1", "abc", "--expect", "x"], "invalid note"],
      [["comment", "edit", "a.md", "c1", "1.5", "--expect", "x"], "invalid note"],
      [["comment", "edit", "a.md", "c1", "1"], "edit requires --expect"],
      [["comment", "edit", "a.md", "c1", "1", "--rev", "nope"], "unexpected flag"],
      [["comment", "edit", "a.md", "c1", "1", "--rev", "1.5", "--expect", "x"], "unexpected flag"],
      [["comment", "reply", "a.md", "c1", "--rev", "1"], "unexpected flag"],
      [["comment", "add"], "path required"],
      [["comment", "add", "a.md"], "add requires --start and --end"],
      [["comment", "add", "a.md", "--start", "1:0"], "add requires --start and --end"],
      [["comment", "add", "a.md", "--end", "1:1"], "add requires --start and --end"],
      [["comment", "add", "a.md", "--start", "foo", "--end", "1:1"], "invalid position"],
      [["comment", "add", "a.md", "--start", "1:0", "--end", "1:1", "extra"], "unexpected argument"],
      [["comment", "add", "a.md", "--start", "1:0", "--end", "1:1"], "add requires --expect"],
      [["comment", "add", "a.md", "--start", "1:0", "--end", "1:1", "--find", "x"], "unexpected flag"],
      [["comment", "add", "a.md", "--start", "1:0", "--end", "1:1", "--rev", "0"], "unexpected flag"],
      [["comment", "list", "a.md", "--start", "1:0", "--end", "1:1"], "unexpected flag"],
      [["comment", "show", "a.md", "c1", "--start", "1:0"], "unexpected flag"],
      [["comment", "reply", "a.md", "c1", "--end", "1:1"], "unexpected flag"],
      [["comment", "edit", "a.md", "c1", "0", "--expect", "x", "--start", "1:0"], "unexpected flag"],
      [["list", "--start", "1:0"], "unexpected flag"],
      [["show", "hello.md", "--end", "1:0"], "unexpected flag"],
    ];
    for (const [args, message] of cases) {
      const res = await run(["--port", String(gate.port), "--user", "Grok", "--repo", "docs", ...args]);
      assert.equal(res.code, 2, args.join(" "));
      assert.equal(res.stdout, "", args.join(" "));
      assert.equal(res.stderr, `viewmark: ${message}\n`, args.join(" "));
    }

    const negative = await run([
      "--port", String(gate.port),
      "--user", "Grok",
      "--repo", "docs",
      "comment", "edit",
      THREAD_REL,
      "c1",
      "-1",
    ]);
    assert.equal(negative.code, shellStatus(400));
    assert.equal(negative.stdout, "");
    assert.equal(negative.stderr, "error 400\n");
    assert.equal(gate.hits.length, 0);
  } finally {
    await gate.close();
  }

  await withDocs(async ({ dir, port }) => {
    const full = await writeThread(dir);
    await fs.writeFile(path.join(dir, "notes", "keep.markdown"), "See {k}k{/k}.\n\n```comment k\nhi\n```\n");
    const markdown = await run(commentArgs(port, "Grok", ["list", "notes/keep.markdown"]));
    assert.equal(markdown.code, 0);
    assert.equal(markdown.stdout, "k\n");

    const missingThread = await run(commentArgs(port, "Grok", ["show", THREAD_REL, "missing"]));
    assert.equal(missingThread.code, shellStatus(404));
    assert.equal(missingThread.stdout, "");
    assert.equal(missingThread.stderr, "error 404\n");
    const missingReply = await run(commentArgs(port, "Grok", ["reply", THREAD_REL, "missing"]), {}, "Yes.\n");
    assert.equal(missingReply.code, shellStatus(404));
    assert.equal(missingReply.stderr, "error 404\n");
    assert.equal(await fs.readFile(full, "utf8"), THREAD_DOC);

    const badId = await run(commentArgs(port, "Grok", ["reply", THREAD_REL, "1c"]), {}, "Yes.\n");
    assert.equal(badId.code, shellStatus(400));
    assert.equal(badId.stderr, "error 400\n");

    const ticket = await run(commentArgs(port, "Grok", ["list", "tickets/x.md"]));
    assert.equal(ticket.code, shellStatus(400));
    assert.equal(ticket.stdout, "");
    assert.equal(ticket.stderr, "error 400\n");
    const text = await run(commentArgs(port, "Grok", ["list", "skip.txt"]));
    assert.equal(text.code, shellStatus(400));
    assert.equal(text.stderr, "error 400\n");
    const bare = await run(commentArgs(port, "Grok", ["reply", "hello", "c1"]), {}, "Yes.\n");
    assert.equal(bare.code, shellStatus(400));
    assert.equal(bare.stderr, "error 400\n");
    const missing = await run(commentArgs(port, "Grok", ["list", "missing.md"]));
    assert.equal(missing.code, shellStatus(404));
    assert.equal(missing.stderr, "error 404\n");
    const parent = await run(commentArgs(port, "Grok", ["list", "../hello.md"]));
    assert.equal(parent.code, shellStatus(404));
    assert.equal(parent.stderr, "error 404\n");
    const rooted = await run(commentArgs(port, "Grok", ["show", "/hello.md", "c1"]));
    assert.equal(rooted.code, shellStatus(404));
    assert.equal(await fs.readFile(full, "utf8"), THREAD_DOC);

    const alone = await hello(port, "Grok", null);
    try {
      alone.send({ type: "comment.threads", username: "Grok", path: "hello.md" });
      const msg = await alone.next((item) => item.type === "error" || item.type === "comments");
      assert.equal(msg.type, "error");
      assert.equal(msg.status, 400);
    } finally {
      alone.ws.close();
    }
  });
});

async function captureComment(args, input, text, rev = 4) {
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
        const msg = JSON.parse(payload.toString("utf8"));
        messages.push(msg);
        let reply = null;
        if (msg.type === "open") reply = { type: "file", path: msg.path, rev, text, locks: [] };
        else if (msg.type === "comment.add") {
          reply = { type: "comment", path: msg.path, id: "c1", note: 0, rev: rev + 1 };
        }
        if (reply) socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify(reply))));
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
  });
  await listen(server);
  try {
    const res = await run(
      ["--port", String(server.address().port), "--user", "Ada", "--repo", "docs", ...args],
      {},
      input,
    );
    return { res, messages };
  } finally {
    peer?.destroy();
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}

function addedMessage(messages) {
  return messages.find((msg) => msg.type === "comment.add");
}

test("T-comment-add", async () => {
  const agents = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
  const replyAt = agents.indexOf("A reply goes through `comment reply`, not through `edit`.");
  const leaveAt = agents.indexOf(
    "An agent leaves a question with `comment add PATH --start LINE:OFFSET --end LINE:OFFSET --expect TEXT` and the question on stdin. `--expect` is the bytes at that range. Lines count from 1. Offset counts from 0. The end offset is exclusive.",
  );
  assert.ok(replyAt !== -1);
  assert.ok(leaveAt > replyAt);

  const fox = "See the fox.\n";
  const question = "Is this the right animal?\n";
  const gate = await trap();
  try {
    const silent = [
      [["comment", "add", "notes/fox.md", "--start", "1:8", "--end", "1:11", "--expect", "fox"], ""],
      [["comment", "add", "notes/fox.md", "--start", "1:8", "--end", "1:11", "--expect", "fox"], "Yes.\n::\nno\n"],
      [["comment", "add", "notes/fox.md", "--start", "1:8", "--end", "1:11", "--expect", "fox"], ":: 3\n"],
      [["comment", "add", "notes/fox.md", "--start", "1:8", "--end", "1:8", "--expect", "fox"], question],
      [["comment", "add", "notes/fox.md", "--start", "0:0", "--end", "1:1", "--expect", "x"], question],
      [["comment", "add", "notes/fox.md", "--start", "1:-1", "--end", "1:2", "--expect", "x"], question],
      [["comment", "add", "notes/fox.md", "--start", "-3:0", "--end", "1:1", "--expect", "x"], question],
    ];
    for (const [args, input] of silent) {
      const res = await run(
        ["--port", String(gate.port), "--user", "Ada", "--repo", "docs", ...args],
        {},
        input,
      );
      assert.equal(res.code, shellStatus(400), `${args.join(" ")} ${JSON.stringify(input)}`);
      assert.equal(res.stdout, "", args.join(" "));
      assert.equal(res.stderr, "error 400\n", args.join(" "));
    }
    assert.equal(gate.hits.length, 0);
  } finally {
    await gate.close();
  }

  const sent = await captureComment(
    ["comment", "add", "notes/fox.md", "--start", "1:8", "--end", "1:11", "--expect", "fox"],
    question,
    fox,
  );
  assert.equal(sent.res.code, 0);
  assert.equal(sent.res.stdout, "c1\n");
  assert.equal(sent.res.stderr, "rev 5\n");
  assert.deepEqual(sent.messages.map((msg) => msg.type), ["hello", "repo", "comment.add"]);
  assert.deepEqual(addedMessage(sent.messages), {
    type: "comment.add",
    username: "Ada",
    path: "notes/fox.md",
    start: { line: 1, offset: 8 },
    end: { line: 1, offset: 11 },
    expect: "fox",
    text: question,
  });

  const jsonWire = await captureComment(
    ["--json", "comment", "add", "notes/fox.md", "--start", "1:8", "--end", "1:11", "--expect", "fox"],
    question,
    fox,
  );
  assert.equal(jsonWire.res.code, 0);
  assert.equal(jsonWire.res.stderr, "");
  assert.deepEqual(JSON.parse(jsonWire.res.stdout), {
    path: "notes/fox.md",
    id: "c1",
    note: 0,
    rev: 5,
  });

  const wrapped = await captureComment(
    ["comment", "add", "notes/pair.md", "--start", "1:0", "--end", "2:0", "--expect", "one\n"],
    question,
    "one\ntwo\n",
  );
  assert.equal(wrapped.res.code, 0);
  assert.deepEqual(addedMessage(wrapped.messages).start, { line: 1, offset: 0 });
  assert.deepEqual(addedMessage(wrapped.messages).end, { line: 2, offset: 0 });
  assert.equal(addedMessage(wrapped.messages).expect, "one\n");

  const throughPeriod = await captureComment(
    ["comment", "add", "notes/fox.md", "--start", "1:8", "--end", "1:12", "--expect", "fox."],
    question,
    fox,
  );
  assert.equal(throughPeriod.res.code, 0);
  assert.deepEqual(addedMessage(throughPeriod.messages).end, { line: 1, offset: 12 });
  assert.equal(addedMessage(throughPeriod.messages).expect, "fox.");

  const reversed = await captureComment(
    ["comment", "add", "notes/fox.md", "--start", "1:11", "--end", "1:8", "--expect", "fox"],
    question,
    fox,
  );
  assert.equal(reversed.res.code, 0);
  assert.deepEqual(addedMessage(reversed.messages).start, { line: 1, offset: 11 });
  assert.deepEqual(addedMessage(reversed.messages).end, { line: 1, offset: 8 });
  assert.equal(addedMessage(reversed.messages).expect, "fox");

  await withDocs(async ({ dir, port }) => {
    const rel = "notes/fox.md";
    const full = path.join(dir, rel);
    await fs.writeFile(full, fox);
    const wrong = await run(
      commentArgs(port, "Ada", ["add", rel, "--start", "1:8", "--end", "1:11", "--expect", "cat"]),
      {},
      question,
    );
    assert.equal(wrong.code, shellStatus(409));
    assert.equal(wrong.stdout, "");
    assert.equal(wrong.stderr, "error 409\ncontext\n");
    assert.equal(await fs.readFile(full, "utf8"), fox);
    const witness = await hello(port, "witness");
    try {
      await openDoc(witness, "witness", rel);
      const added = await run(
        commentArgs(port, "Ada", ["add", rel, "--start", "1:8", "--end", "1:11", "--expect", "fox"]),
        {},
        question,
      );
      assert.equal(added.code, 0);
      assert.equal(added.stdout, "c1\n");
      assert.equal(added.stderr, "rev 1\n");
      const stored = await fs.readFile(full, "utf8");
      assert.equal(stored.startsWith("See the {c1}fox{/c1}.\n"), true);
      const thread = commentThreads(stored).find((item) => item.id === "c1");
      const notes = parseCommentNotes(thread.body);
      assert.equal(notes.length, 1);
      assert.equal(notes[0].id, 0);
      const parts = splitCommentNote(notes[0].raw);
      assert.equal(parts.author, "Ada");
      assert.equal(parts.text, question);
      assert.match(parts.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      const doc = await witness.next((msg) => msg.type === "doc" && msg.path === rel);
      assert.equal(doc.rev, 1);
      assert.equal(doc.actor, "Ada");
      assert.equal(doc.text, stored);
      await delay(50);
      assert.equal(witness.queue.filter((msg) => msg.type === "doc").length, 0);
    } finally {
      witness.ws.close();
    }

    const revFull = path.join(dir, "notes/rev.md");
    await fs.writeFile(revFull, fox);
    const backward = await run(
      commentArgs(port, "Ada", ["add", "notes/rev.md", "--start", "1:11", "--end", "1:8", "--expect", "fox"]),
      {},
      question,
    );
    assert.equal(backward.code, 0);
    assert.equal(backward.stdout, "c1\n");
    assert.equal((await fs.readFile(revFull, "utf8")).startsWith("See the {c1}fox{/c1}.\n"), true);

    const dotFull = path.join(dir, "notes/dot.md");
    await fs.writeFile(dotFull, fox);
    const dotted = await run(
      commentArgs(port, "Ada", ["add", "notes/dot.md", "--start", "1:8", "--end", "1:12", "--expect", "fox."]),
      {},
      question,
    );
    assert.equal(dotted.code, 0);
    assert.equal((await fs.readFile(dotFull, "utf8")).startsWith("See the {c1}fox.{/c1}\n"), true);

    const pairFull = path.join(dir, "notes/pair.md");
    await fs.writeFile(pairFull, "one\ntwo\n");
    const pair = await run(
      commentArgs(port, "Ada", ["add", "notes/pair.md", "--start", "1:0", "--end", "2:0", "--expect", "one\n"]),
      {},
      question,
    );
    assert.equal(pair.code, 0);
    assert.equal(pair.stdout, "c1\n");
    assert.equal((await fs.readFile(pairFull, "utf8")).startsWith("{c1}one\n{/c1}two\n"), true);

    const shortFull = path.join(dir, "notes/short.md");
    await fs.writeFile(shortFull, fox);
    const watcher = await hello(port, "witness");
    try {
      await openDoc(watcher, "witness", "notes/short.md");
      const missing = await run(
        commentArgs(port, "Ada", ["add", "notes/short.md", "--start", "9:0", "--end", "9:1", "--expect", "x"]),
        {},
        question,
      );
      assert.equal(missing.code, shellStatus(400));
      assert.equal(missing.stdout, "");
      assert.equal(missing.stderr, "error 400\n");
      assert.equal(await fs.readFile(shortFull, "utf8"), fox);
      await delay(50);
      assert.equal(watcher.queue.some((msg) => msg.type === "doc"), false);
    } finally {
      watcher.ws.close();
    }

    const over = await run(
      commentArgs(port, "Ada", ["add", "notes/short.md", "--start", "1:0", "--end", "1:13", "--expect", "x"]),
      {},
      question,
    );
    assert.equal(over.code, shellStatus(400));
    assert.equal(over.stderr, "error 400\n");
    assert.equal(await fs.readFile(shortFull, "utf8"), fox);

    const jsonFull = path.join(dir, "notes/json.md");
    await fs.writeFile(jsonFull, fox);
    const json = await run(
      ["--json", ...commentArgs(port, "Ada", ["add", "notes/json.md", "--start", "1:8", "--end", "1:11", "--expect", "fox"])],
      {},
      question,
    );
    assert.equal(json.code, 0);
    assert.equal(json.stderr, "");
    assert.deepEqual(JSON.parse(json.stdout), { path: "notes/json.md", id: "c1", note: 0, rev: 1 });
    const jsonDoc = await fs.readFile(jsonFull, "utf8");
    assert.equal(jsonDoc.startsWith("See the {c1}fox{/c1}.\n"), true);
    const jsonNote = splitCommentNote(parseCommentNotes(commentThreads(jsonDoc)[0].body)[0].raw);
    assert.equal(jsonNote.author, "Ada");
    assert.equal(jsonNote.text, question);

    const fence = "```\ncode\n```\n";
    const fenceFull = path.join(dir, "notes/fence.md");
    await fs.writeFile(fenceFull, fence);
    const fenced = await run(
      commentArgs(port, "Ada", ["add", "notes/fence.md", "--start", "1:0", "--end", "1:3", "--expect", "```"]),
      {},
      question,
    );
    assert.equal(fenced.code, shellStatus(409));
    assert.equal(fenced.stdout, "");
    assert.equal(fenced.stderr, "error 409\noverlaps a fence\n");
    assert.equal(await fs.readFile(fenceFull, "utf8"), fence);

    const table = "| Login stalls | Ends the character |\n| --- | --- |\n| yes | no |\n";
    const tableFull = path.join(dir, "notes/table.md");
    await fs.writeFile(tableFull, table);
    const row = await run(
      commentArgs(port, "Ada", ["add", "notes/table.md", "--start", "3:2", "--end", "3:5", "--expect", "yes"]),
      {},
      question,
    );
    assert.equal(row.code, shellStatus(409));
    assert.equal(row.stdout, "");
    assert.equal(row.stderr, "error 409\noverlaps a table\n");
    assert.equal(await fs.readFile(tableFull, "utf8"), table);

    const marked = "See {c1}fox{/c1}.\n";
    const splitFull = path.join(dir, "notes/split.md");
    await fs.writeFile(splitFull, marked);
    const split = await run(
      commentArgs(port, "Ada", ["add", "notes/split.md", "--start", "1:9", "--end", "1:16", "--expect", "ox{/c1}"]),
      {},
      question,
    );
    assert.equal(split.code, shellStatus(409));
    assert.equal(split.stdout, "");
    assert.equal(split.stderr, "error 409\nsplits a comment\n");
    assert.equal(await fs.readFile(splitFull, "utf8"), marked);

    const holdFull = path.join(dir, "notes/hold.md");
    await fs.writeFile(holdFull, fox);
    const holder = await hello(port, "Ada");
    const seeing = await hello(port, "witness");
    try {
      await openDoc(seeing, "witness", "notes/hold.md");
      const opened = await openDoc(holder, "Ada", "notes/hold.md");
      holder.send({
        type: "lock",
        username: "Ada",
        path: "notes/hold.md",
        rev: opened.rev,
        anchor: 0,
        cursor: opened.text.length,
      });
      await holder.next((msg) => msg.type === "locks" && msg.path === "notes/hold.md");
      await seeing.next((msg) => msg.type === "locks" && msg.path === "notes/hold.md");
      const blocked = await run(
        commentArgs(port, "Bea", ["add", "notes/hold.md", "--start", "1:8", "--end", "1:11", "--expect", "fox"]),
        {},
        question,
      );
      assert.equal(blocked.code, shellStatus(409));
      assert.equal(blocked.stdout, "");
      assert.equal(blocked.stderr, "error 409\nheld by Ada\n");
      assert.equal(await fs.readFile(holdFull, "utf8"), fox);
      await delay(50);
      assert.equal(seeing.queue.some((msg) => msg.type === "doc"), false);
    } finally {
      holder.ws.close();
      seeing.ws.close();
    }

    const gone = await run(
      commentArgs(port, "Ada", ["add", "notes/missing.md", "--start", "1:0", "--end", "1:1", "--expect", "x"]),
      {},
      question,
    );
    assert.equal(gone.code, shellStatus(404));
    assert.equal(gone.stdout, "");
    assert.equal(gone.stderr, "error 404\n");
  });
});
