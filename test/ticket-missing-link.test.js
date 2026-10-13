import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../server.js";

// Ticket dfpje5ux: a link to a ticket that has gone missing is removed or ignored. A ticket in
// `other` that holds `docs:A` still takes a field write after A is deleted or purged from `docs`.
// A write that adds a link to a missing ticket in a registered repo is still 409.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "cli.js");
const TODO = "ticket dfpje5ux: at f0cc055 a write to a ticket that holds a missing link is 409";

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

// `ticket show` writes the fields to stderr, one `name value` per line.
async function fields(port, repo, id) {
  const shown = await run(port, ["--repo", repo, "ticket", "show", id]);
  assert.equal(shown.code, 0, shown.stderr);
  const out = {};
  for (const line of shown.stderr.split("\n")) {
    const at = line.indexOf(" ");
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1);
    else if (line) out[line] = "";
  }
  return out;
}

async function withHub(fn) {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-missing-state-"));
  const docs = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-missing-docs-"));
  const other = await fs.mkdtemp(path.join(os.tmpdir(), "viewmark-missing-other-"));
  const server = await start(0, state);
  const port = server.address().port;
  try {
    for (const [name, dir] of [["docs", docs], ["other", other]]) {
      const registered = await run(port, ["repo", "register", "--name", name, "--description", name, "--path", dir]);
      assert.equal(registered.code, 0, registered.stderr);
    }
    const create = async (repo, title) => {
      const made = await run(port, ["--repo", repo, "ticket", "create", "--title", title], `${title}\n`);
      assert.equal(made.code, 0, made.stderr);
      return made.stdout.trim().split("\n")[0];
    };
    await fn({ port, create });
  } finally {
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    for (const dir of [docs, other, state]) await fs.rm(dir, { recursive: true, force: true });
  }
}

// B in `other` depends on A in `docs`. `gone` removes A, then B takes a field write.
async function writeAfterGone(gone) {
  await withHub(async ({ port, create }) => {
    const a = await create("docs", "Alpha");
    const b = await create("other", "Bravo");
    const linked = await run(port, ["--repo", "other", "ticket", "set", b, "--depends", `docs:${a}`]);
    assert.equal(linked.code, 0, linked.stderr);
    await gone(port, a);
    const shown = await run(port, ["--repo", "docs", "ticket", "show", a]);
    assert.notEqual(shown.code, 0, `A is still in docs after it was removed`);
    const closed = await run(port, ["--repo", "other", "ticket", "set", b, "--state", "closed"]);
    assert.equal(closed.code, 0, `ticket set B --state closed exited ${closed.code}: ${closed.stderr.trim()}`);
    const after = await fields(port, "other", b);
    assert.equal(after.state, "closed");
    assert.ok(after.depends === `docs:${a}` || after.depends === "", `B's depends is ${JSON.stringify(after.depends)}, neither kept as docs:${a} nor removed`);
  });
}

test("a ticket whose link went missing when that ticket was deleted still takes a field write (ticket dfpje5ux)", { todo: TODO }, async () => {
  await writeAfterGone(async (port, a) => {
    const deleted = await run(port, ["--repo", "docs", "ticket", "delete", a]);
    assert.equal(deleted.code, 0, deleted.stderr);
  });
});

test("a ticket whose link went missing when that ticket was purged still takes a field write (ticket dfpje5ux)", { todo: TODO }, async () => {
  await writeAfterGone(async (port, a) => {
    const closed = await run(port, ["--repo", "docs", "ticket", "set", a, "--state", "closed"]);
    assert.equal(closed.code, 0, closed.stderr);
    const purged = await run(port, ["--repo", "docs", "ticket", "purge"]);
    assert.equal(purged.code, 0, purged.stderr);
  });
});

test("a write that adds a link to a missing ticket in a registered repo is still 409 and writes nothing (ticket dfpje5ux)", async () => {
  await withHub(async ({ port, create }) => {
    const b = await create("other", "Bravo");
    const before = await fields(port, "other", b);
    const linked = await run(port, ["--repo", "other", "ticket", "set", b, "--depends", "docs:k2n4p7qa"]);
    // A 409 exits 409, which the shell sees as 153.
    assert.equal(linked.code, 409 % 256, `ticket set exited ${linked.code}: ${linked.stderr.trim()}`);
    assert.match(linked.stderr, /^conflict$/m);
    const after = await fields(port, "other", b);
    assert.equal(after.rev, before.rev);
    assert.equal(after.depends, before.depends);
  });
});
