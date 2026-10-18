import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../server.js";

// Ticket hnbdeuu8: a diff must not merge or split comment notes. A hunk that removes the `:: N`
// line between two notes, or adds one inside a thread, is 409 and writes nothing. A hunk that
// changes only a note's text is accepted.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "cli.js");
const THREAD = "```comment c1\n:: 0\n@2026-10-05T16:00:00.000Z Ada\nThis note is the start of the thread.\n:: 1\n@2026-10-05T16:05:00.000Z Bea\nA reply keeps its own author line.\n```\n";

function cliEnv() {
  const env = { ...process.env };
  delete env.VIEWMARK_USER;
  delete env.VIEWMARK_PORT;
  return env;
}

function run(port, args, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "--port", String(port), "--user", "qa", ...args], { env: cliEnv() });
    const out = [];
    const err = [];
    child.on("error", reject);
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.stdin.end(input);
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
  });
}

// A hub with one repo, `docs`, holding `t.md` with the thread above. `fn` gets the port.
async function withThread(fn) {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-notes-state-"));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-notes-"));
  const server = await start(0, state);
  const port = server.address().port;
  try {
    const registered = await run(port, ["repo", "register", "--name", "docs", "--description", "docs", "--path", dir]);
    assert.equal(registered.code, 0, registered.stderr);
    const made = await run(port, ["--repo", "docs", "create", "t.md"], THREAD);
    assert.equal(made.code, 0, made.stderr);
    await fn(port);
  } finally {
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    for (const d of [dir, state]) await fs.rm(d, { recursive: true, force: true });
  }
}

async function refused(diff) {
  await withThread(async (port) => {
    const edited = await run(port, ["--repo", "docs", "edit", "t.md"], diff);
    // A 409 exits 409, which the shell sees as 153.
    assert.equal(edited.code, 409 % 256, `edit exited ${edited.code}: ${edited.stderr.trim()}`);
    const shown = await run(port, ["--repo", "docs", "show", "t.md"]);
    assert.equal(shown.stdout, THREAD, "the thread changed");
  });
}

test("a diff that removes the line between two comment notes is 409 and writes nothing (ticket hnbdeuu8)", async () => {
  await refused("@@ -4,2 +4,1 @@\n This note is the start of the thread.\n-:: 1\n");
});

test("a diff that adds a note line inside a comment thread is 409 and writes nothing (ticket hnbdeuu8)", async () => {
  await refused("@@ -4,1 +4,2 @@\n This note is the start of the thread.\n+:: 2\n");
});

test("a diff that changes only a comment note's text is accepted (ticket hnbdeuu8)", async () => {
  await withThread(async (port) => {
    const edited = await run(port, ["--repo", "docs", "edit", "t.md"], "@@ -7,1 +7,1 @@\n-A reply keeps its own author line.\n+A reply keeps its author line.\n");
    assert.equal(edited.code, 0, edited.stderr);
    const shown = await run(port, ["--repo", "docs", "show", "t.md"]);
    assert.equal(shown.stdout, THREAD.replace("its own author", "its author"));
  });
});

test("a diff that adds a bare :: line inside a comment thread is 409 and writes nothing (ticket hnbdeuu8)", async () => {
  await refused("@@ -4,1 +4,2 @@\n This note is the start of the thread.\n+::\n");
});

// Another session watching t.md, as a page does: it opens the file and keeps every message.
async function watcher(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
  const seen = [];
  ws.addEventListener("message", (event) => seen.push(JSON.parse(String(event.data))));
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const send = (msg) => ws.send(JSON.stringify({ username: "Watcher", ...msg }));
  const until = async (pred, what) => {
    const started = Date.now();
    while (!seen.some(pred)) {
      if (Date.now() - started > 3000) throw new Error(`the watcher waited for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  send({ type: "hello" });
  await until((msg) => msg.type === "hello", "hello");
  send({ type: "repo", name: "docs" });
  send({ type: "open", path: "t.md" });
  await until((msg) => msg.type === "file" && msg.path === "t.md", "the file");
  return { seen, until, close: () => ws.close() };
}

// Case 72 of qa/lock-spans-test-plan.md: the refused hunk takes no lock. A session watching the
// file is never told the CLI's user holds any of it, and gets no doc. A hunk that changes only a
// note's text reaches that same watcher, which shows it is listening.
test("a diff that merges or splits comment notes takes no lock (ticket hnbdeuu8, case 72)", async () => {
  await withThread(async (port) => {
    const watch = await watcher(port);
    try {
      for (const diff of ["@@ -4,2 +4,1 @@\n This note is the start of the thread.\n-:: 1\n", "@@ -4,1 +4,2 @@\n This note is the start of the thread.\n+:: 2\n"]) {
        const edited = await run(port, ["--repo", "docs", "edit", "t.md"], diff);
        assert.equal(edited.code, 409 % 256, `edit exited ${edited.code}: ${edited.stderr.trim()}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      const held = watch.seen.filter((msg) => msg.type === "locks" && (msg.lines || []).some((line) => line.username === "qa"));
      assert.deepEqual(held, [], "the watcher was told the CLI's user holds part of the thread");
      assert.equal(watch.seen.some((msg) => msg.type === "doc"), false, "the watcher got a doc for a refused hunk");
      const accepted = await run(port, ["--repo", "docs", "edit", "t.md"], "@@ -7,1 +7,1 @@\n-A reply keeps its own author line.\n+A reply keeps its author line.\n");
      assert.equal(accepted.code, 0, accepted.stderr);
      await watch.until((msg) => msg.type === "doc" && msg.path === "t.md", "the accepted edit");
    } finally {
      watch.close();
    }
  });
});
