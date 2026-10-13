import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../server.js";

// Ticket xwcxqsrk: show and ticket show, plain and --json, write the whole document to a pipe
// whose reader starts late, or exit non-zero when they cannot.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "cli.js");
const LINE = "The quick brown fox jumps over the lazy dog, again and again.\n";
const BODY = LINE.repeat(Math.ceil(300000 / LINE.length));

function cliEnv() {
  const env = { ...process.env };
  delete env.VIEWMARK_USER;
  delete env.VIEWMARK_PORT;
  return env;
}

// The CLI writes into a shell pipe, as `viewmark show … | tool` does. The reader takes nothing
// for `wait` ms, then reads to the end. With `closeAfter`, the reader is `head -c 100`, which
// closes the pipe early. `code` is the CLI's own exit status, from PIPESTATUS, and is null when
// the pipeline was still running after 10 s. (A child_process pipe left paused will not do here:
// when the child exits, Node resumes it and drops what it holds.)
function runSlow(port, args, { wait = 300, closeAfter = false, input = "" } = {}) {
  const reader = closeAfter ? "head -c 100" : wait > 0 ? `(sleep ${wait / 1000}; cat)` : "cat";
  const script = `"$0" "$@" | ${reader}; echo "\${PIPESTATUS[0]}" >&3`;
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", script, process.execPath, cli, "--port", String(port), "--user", "qa", ...args], {
      env: cliEnv(),
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    const out = [];
    const status = [];
    child.on("error", reject);
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.resume();
    child.stdio[3].on("data", (chunk) => status.push(chunk));
    const killer = setTimeout(() => child.kill("SIGKILL"), 10000);
    child.on("close", () => {
      clearTimeout(killer);
      const text = Buffer.concat(status).toString("utf8").trim();
      resolve({ code: text === "" ? null : Number(text), stdout: Buffer.concat(out).toString("utf8") });
    });
  });
}

async function withHub(fn) {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-pipe-state-"));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-pipe-"));
  const server = await start(0, state);
  const port = server.address().port;
  try {
    const registered = await runSlow(port, ["repo", "register", "--name", "docs", "--description", "Docs", "--path", dir], { wait: 0 });
    assert.equal(registered.code, 0);
    const made = await runSlow(port, ["--repo", "docs", "create", "big.md"], { wait: 0, input: BODY });
    assert.equal(made.code, 0);
    const ticket = await runSlow(port, ["--repo", "docs", "ticket", "create", "--title", "Big"], { wait: 0, input: BODY });
    assert.equal(ticket.code, 0);
    await fn({ port, id: ticket.stdout.trim().split("\n")[0] });
  } finally {
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(state, { recursive: true, force: true });
  }
}

test("show and ticket show write the whole document to a pipe whose reader starts late (ticket xwcxqsrk)", async () => {
  await withHub(async ({ port, id }) => {
    const shown = await runSlow(port, ["--repo", "docs", "show", "big.md"]);
    assert.equal(shown.code, 0);
    assert.equal(shown.stdout.length, BODY.length, `show wrote ${shown.stdout.length} of ${BODY.length} bytes`);
    const json = await runSlow(port, ["--json", "--repo", "docs", "show", "big.md"]);
    assert.equal(json.code, 0);
    assert.doesNotThrow(() => JSON.parse(json.stdout), `show --json wrote ${json.stdout.length} bytes that do not parse`);
    const ticket = await runSlow(port, ["--repo", "docs", "ticket", "show", id]);
    assert.equal(ticket.code, 0);
    assert.equal(ticket.stdout.length, BODY.length, `ticket show wrote ${ticket.stdout.length} of ${BODY.length} bytes`);
    const ticketJson = await runSlow(port, ["--json", "--repo", "docs", "ticket", "show", id]);
    assert.equal(ticketJson.code, 0);
    assert.doesNotThrow(() => JSON.parse(ticketJson.stdout), `ticket show --json wrote ${ticketJson.stdout.length} bytes that do not parse`);
  });
});

test("show exits non-zero when its reader closes the pipe before the document is written (ticket xwcxqsrk)", async () => {
  await withHub(async ({ port }) => {
    const shown = await runSlow(port, ["--repo", "docs", "show", "big.md"], { closeAfter: true });
    assert.notEqual(shown.code, null, "show was still running 10 s after its reader closed the pipe");
    assert.notEqual(shown.code, 0, `show exited 0 after its reader closed the pipe at ${shown.stdout.length} of ${BODY.length} bytes`);
  });
});
