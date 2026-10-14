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
const TODO = "ticket hnbdeuu8: at 1578026 a diff that merges or splits comment notes is accepted";
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

test("a diff that removes the line between two comment notes is 409 and writes nothing (ticket hnbdeuu8)", { todo: TODO }, async () => {
  await refused("@@ -4,2 +4,1 @@\n This note is the start of the thread.\n-:: 1\n");
});

test("a diff that adds a note line inside a comment thread is 409 and writes nothing (ticket hnbdeuu8)", { todo: TODO }, async () => {
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
