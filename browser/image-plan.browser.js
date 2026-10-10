import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { AGENT, OTHER, REPO, USER, cli, launchBrowser, Page, startHub } from "./harness.js";

// The test plan in the body of ticket vurzujkx, cases IMG.a1 to IMG.f2, with the owner's
// answers c1 to c4 there. Pictures live beside their document, in a directory named for it, and
// a document holds one image line per picture: ![NAME](DIR/NAME). The bytes are read back only
// through GET /raw and the CLI. browser/images.browser.js is the implementer's own test; this
// file follows the plan.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ID = "[23456789abcdefghjkmnpqrstuvwxyz]{8}";
const MIB2 = 2 * 1024 * 1024;

// ---- fixtures -------------------------------------------------------------------------------

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, "ascii"), data])) >>> 0, 8 + data.length);
  return out;
}

// An RGB PNG with a visible pattern, or with noise, padded to `size` bytes by a private
// ancillary chunk that a decoder skips.
function png(width, height, { noise = false, size = 0 } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    // Random bytes do not compress, so a noise picture stays as large as its pixels.
    if (noise) randomBytes(width * 3).copy(row, 1);
    for (let x = 0; x < width && !noise; x += 1) {
      const stripe = Math.floor(x / 10) % 2 === 0;
      row[1 + x * 3] = stripe ? 200 : 30;
      row[2 + x * 3] = (y * 3) & 255;
      row[3 + x * 3] = stripe ? 40 : 220;
    }
    rows.push(row);
  }
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [head, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.concat(rows)))];
  const end = chunk("IEND", Buffer.alloc(0));
  if (size) {
    const used = parts.reduce((n, b) => n + b.length, 0) + end.length;
    const pad = size - used - 12;
    if (pad < 0) throw new Error(`png already ${used} bytes`);
    parts.push(chunk("paDd", Buffer.alloc(pad, 0x20)));
  }
  parts.push(end);
  const out = Buffer.concat(parts);
  if (size && out.length !== size) throw new Error(`png is ${out.length}, not ${size}`);
  return out;
}

const PNG = png(200, 80);
const PNG_2MIB = png(64, 64, { size: MIB2 });
const PNG_OVER = png(64, 64, { size: MIB2 + 1 });
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");
const GIF = Buffer.from("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");
const WEBP = Buffer.from("UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=", "base64");
const TEXT = Buffer.from("this is a text file, not a picture\n");

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pngSize = (bytes) => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });

// ---- the hub, the CLI, and /raw ---------------------------------------------------------------

function getRaw(port, rel) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: `/raw/${REPO}/${rel}`, method: "GET", headers: { Connection: "close" } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"] ?? "", body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

const run = (hub, args, input = "", user = AGENT) => cli(hub.port, ["--user", user, "--repo", REPO, ...args], input);

async function showDoc(hub, rel) {
  const out = await run(hub, ["show", rel]);
  assert.equal(out.code, 0, `show ${rel}: ${out.stderr}`);
  return { text: out.stdout, rev: Number(/rev (\d+)/.exec(out.stderr)?.[1]) };
}

// Line and offset of a text offset, as the CLI counts them: lines from 1, offsets from 0.
function at(text, offset) {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  return `${line}:${offset - (before.lastIndexOf("\n") + 1)}`;
}

function attach(hub, rel, text, from, to, bytes, user = AGENT) {
  return run(hub, ["attach", rel, "--start", at(text, from), "--end", at(text, to), "--expect", text.slice(from, to)], bytes, user);
}

// Every image line in a text, with its name and address.
function imageLines(text) {
  return [...text.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)].map((m) => ({ line: m[0], alt: m[1], address: m[2], index: m.index }));
}

async function newTicket(hub, body) {
  const made = await run(hub, ["ticket", "create", "--title", "Shot"], body, USER);
  assert.equal(made.code, 0, made.stderr);
  return made.stdout.split("\n")[0].trim();
}

async function setup(t, docs = {}) {
  const hub = await startHub();
  const cleanup = [];
  t.after(async () => {
    for (const fn of cleanup.reverse()) await fn();
    await hub.close();
  });
  for (const [name, text] of Object.entries(docs)) await hub.create(name, text);
  return { hub, cleanup };
}

async function openPage(ctx, file, user = USER) {
  if (!ctx.browser) {
    ctx.browser = await launchBrowser();
    ctx.cleanup.push(() => ctx.browser.close());
  }
  const session = ctx.pages ? (await ctx.browser.newSession()).session : ctx.browser.session;
  ctx.pages = (ctx.pages || 0) + 1;
  const page = new Page(session, ctx.hub.port);
  await page.init();
  await page.login(user);
  if (file) await openFile(page, file);
  return page;
}

async function openFile(page, file) {
  await page.open(file);
  await page.until(() => page.eval(`document.querySelectorAll("#editor .md-line, #editor .md-image").length > 0`), `${file} drawn`);
  await page.quiet();
}

// Raw socket frames, with their opcodes and sizes, in and out.
function recordFrames(page) {
  const frames = [];
  const push = (dir) => (p) => frames.push({ dir, opcode: p.response.opcode, size: p.response.opcode === 2 ? Buffer.from(p.response.payloadData, "base64").length : Buffer.byteLength(p.response.payloadData), text: p.response.opcode === 1 ? p.response.payloadData : "" });
  const offs = [page.session.on("Network.webSocketFrameSent", push("out")), page.session.on("Network.webSocketFrameReceived", push("in"))];
  return { frames, stop: () => offs.forEach((off) => off()) };
}

async function grantClipboard(page) {
  await page.session.send("Browser.grantPermissions", { origin: `http://127.0.0.1:${page.port}`, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
}

async function clipboardImage(page, bytes) {
  const written = await page.eval(`(async () => {
    try {
      const bin = atob(${JSON.stringify(Buffer.from(bytes).toString("base64"))});
      const raw = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) raw[i] = bin.charCodeAt(i);
      await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([raw], { type: "image/png" }) })]);
      return "ok";
    } catch (err) {
      return String(err && err.message || err);
    }
  })()`);
  assert.equal(written, "ok", `the clipboard refused the picture: ${written}`);
}

async function clipboardText(page, text) {
  const written = await page.eval(`navigator.clipboard.writeText(${JSON.stringify(text)}).then(() => "ok", (e) => String(e.message))`);
  assert.equal(written, "ok", `the clipboard refused the text: ${written}`);
}

// Drops files from disk on a text offset, as dragging them from a file manager does.
async function dropFiles(page, offset, files) {
  const pt = await page.eval(`window.__qaClickPoint(${offset})`);
  assert.ok(pt, `no point for offset ${offset}`);
  const data = { items: [], files, dragOperationsMask: 1 };
  for (const type of ["dragEnter", "dragOver", "drop"]) await page.session.send("Input.dispatchDragEvent", { type, x: pt.x, y: pt.y, data });
}

function fixtureDir(ctx) {
  const dir = mkdtempSync(path.join(tmpdir(), "viewmark-qa-images-"));
  ctx.cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function waitFor(check, what, timeout = 3000) {
  const until = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) assert.fail(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

// ---- A. Attach from a script ------------------------------------------------------------------

test("IMG.a1 attach puts one image line after the block, names it like a ticket id, and /raw serves the same PNG", async (t) => {
  const ctx = await setup(t);
  const id = await newTicket(ctx.hub, "First paragraph.\n\nLast paragraph here.\n");
  const before = await showDoc(ctx.hub, `tickets/${id}.md`);
  const out = await attach(ctx.hub, `tickets/${id}.md`, before.text, 0, 5, PNG);
  assert.equal(out.code, 0, out.stderr);
  const after = await showDoc(ctx.hub, `tickets/${id}.md`);
  const found = imageLines(after.text);
  assert.equal(found.length, 1, after.text);
  const [img] = found;
  assert.match(img.address, new RegExp(`^tickets/${id}/${ID}\\.png$`));
  const name = img.address.split("/").pop();
  assert.equal(img.alt, name, "the alt text is the stored file's name (c3)");
  assert.equal(after.text, `First paragraph.\n\n![${name}](tickets/${id}/${name})\n\nLast paragraph here.\n`);
  const raw = await getRaw(ctx.hub.port, img.address);
  assert.equal(raw.status, 200);
  assert.equal(raw.type, "image/png");
  assert.equal(sha(raw.body), sha(PNG));
});

test("IMG.a2 the range names the place as comment add does, and the line goes after the block that holds it", async (t) => {
  const doc = "One para.\n\nTwo para.\n\nThree para.\n";
  const ctx = await setup(t, { "first.md": doc, "last.md": doc, "gap.md": doc });
  const line = (rel, text) => imageLines(text)[0]?.line ?? `(no image line in ${JSON.stringify(text)})`;

  const r1 = await attach(ctx.hub, "first.md", doc, 0, 3, PNG);
  assert.equal(r1.code, 0, r1.stderr);
  const t1 = (await showDoc(ctx.hub, "first.md")).text;
  assert.equal(t1, `One para.\n\n${line("first.md", t1)}\n\nTwo para.\n\nThree para.\n`, "a range in the first paragraph");

  const inLast = doc.indexOf("para.", doc.indexOf("Three"));
  const r2 = await attach(ctx.hub, "last.md", doc, inLast, inLast + 4, PNG);
  assert.equal(r2.code, 0, r2.stderr);
  const t2 = (await showDoc(ctx.hub, "last.md")).text;
  assert.equal(t2, `One para.\n\nTwo para.\n\nThree para.\n\n${line("last.md", t2)}\n`, "a range inside the last paragraph");

  const gap = doc.indexOf("\n\n") + 1;
  const r3 = await attach(ctx.hub, "gap.md", doc, gap, gap, PNG);
  assert.equal(r3.code, 0, r3.stderr);
  const t3 = (await showDoc(ctx.hub, "gap.md")).text;
  assert.equal(t3, `One para.\n${line("gap.md", t3)}\nTwo para.\n\nThree para.\n`, "an empty range on the empty line between two paragraphs");
});

test("IMG.a3 a second attach gets a new name, and both files and lines are there", async (t) => {
  const ctx = await setup(t);
  const id = await newTicket(ctx.hub, "Only paragraph.\n");
  const rel = `tickets/${id}.md`;
  let text = (await showDoc(ctx.hub, rel)).text;
  assert.equal((await attach(ctx.hub, rel, text, 0, 4, PNG)).code, 0);
  text = (await showDoc(ctx.hub, rel)).text;
  assert.equal((await attach(ctx.hub, rel, text, 0, 4, GIF)).code, 0);
  const lines = imageLines((await showDoc(ctx.hub, rel)).text);
  assert.equal(lines.length, 2);
  assert.notEqual(lines[0].address, lines[1].address);
  const bodies = await Promise.all(lines.map((l) => getRaw(ctx.hub.port, l.address)));
  assert.deepEqual(bodies.map((b) => b.status), [200, 200]);
  assert.deepEqual(new Set(bodies.map((b) => sha(b.body))), new Set([sha(PNG), sha(GIF)]));
});

test("IMG.a4 attach to notes/welcome.md stores notes/welcome/NAME.png, and neither list nor the files drawer shows that directory", async (t) => {
  const ctx = await setup(t, { "notes/welcome.md": "Welcome.\n" });
  assert.equal((await attach(ctx.hub, "notes/welcome.md", "Welcome.\n", 0, 7, PNG)).code, 0);
  const [img] = imageLines((await showDoc(ctx.hub, "notes/welcome.md")).text);
  assert.match(img.address, new RegExp(`^notes/welcome/${ID}\\.png$`));
  assert.equal((await getRaw(ctx.hub.port, img.address)).status, 200);
  const listed = await run(ctx.hub, ["list"]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.ok(!/notes\/welcome\//.test(listed.stdout), `list shows the directory: ${listed.stdout}`);
  const page = await openPage(ctx, "notes/welcome.md");
  const tree = await page.eval(`(() => ({
    dirs: [...document.querySelectorAll(".md-file-drawer button.md-dir-toggle")].map((b) => b.dataset.dir),
    files: [...document.querySelectorAll(".md-file-drawer button.md-file")].map((b) => b.textContent),
  }))()`);
  assert.ok(!tree.dirs.includes("notes/welcome"), `the drawer shows notes/welcome: ${JSON.stringify(tree)}`);
  assert.ok(!tree.files.some((f) => f.includes(img.address.split("/").pop())), `the drawer lists the picture: ${JSON.stringify(tree)}`);
});

test("IMG.a5 JPEG, GIF, and WEBP keep their own suffix, and an address ending in .jpeg is drawn from /raw", async (t) => {
  const ctx = await setup(t, { "kinds.md": "Kinds.\n" });
  for (const [bytes, ext, type] of [[JPEG, "jpg", "image/jpeg"], [GIF, "gif", "image/gif"], [WEBP, "webp", "image/webp"]]) {
    const text = (await showDoc(ctx.hub, "kinds.md")).text;
    const out = await attach(ctx.hub, "kinds.md", text, 0, 5, bytes);
    assert.equal(out.code, 0, `${ext}: ${out.stderr}`);
    const img = imageLines((await showDoc(ctx.hub, "kinds.md")).text).find((l) => l.address.endsWith(`.${ext}`));
    assert.ok(img, `no .${ext} line`);
    assert.equal(img.alt, img.address.split("/").pop());
    const raw = await getRaw(ctx.hub.port, img.address);
    assert.equal(raw.status, 200);
    assert.equal(raw.type, type);
    assert.equal(sha(raw.body), sha(bytes));
  }
  // A .jpeg address is accepted where a document names one: the page draws it from /raw.
  await ctx.hub.create("jpeg.md", "Above.\n\n![shot.jpeg](jpeg/shot.jpeg)\n\nBelow.\n");
  const page = await openPage(ctx);
  const requests = [];
  const off = page.session.on("Network.requestWillBeSent", (p) => requests.push(p.request.url));
  await openFile(page, "jpeg.md");
  await waitFor(() => requests.some((u) => u.endsWith(`/raw/${REPO}/jpeg/shot.jpeg`)), "a request for the .jpeg address");
  off();
});

test("IMG.a6 exactly 2 MiB is accepted and stored byte for byte", async (t) => {
  const ctx = await setup(t, { "big.md": "Big.\n" });
  const out = await attach(ctx.hub, "big.md", "Big.\n", 0, 3, PNG_2MIB);
  assert.equal(out.code, 0, out.stderr);
  const [img] = imageLines((await showDoc(ctx.hub, "big.md")).text);
  const raw = await getRaw(ctx.hub.port, img.address);
  assert.equal(raw.body.length, MIB2);
  assert.equal(sha(raw.body), sha(PNG_2MIB));
});

test("IMG.a7 each refusal writes nothing: the body and its rev stay", async (t) => {
  const doc = "First paragraph.\n\nLast paragraph here.\n";
  const ctx = await setup(t);
  const id = await newTicket(ctx.hub, doc);
  const rel = `tickets/${id}.md`;
  const before = await showDoc(ctx.hub, rel);
  const twoBlocks = doc.slice(0, doc.indexOf("Last") + 4);
  const cases = [
    ["bytes that are not an image", ["--start", "1:0", "--end", "1:5", "--expect", "First"], TEXT, /error 400\nnot an image/],
    ["1 byte over 2 MiB", ["--start", "1:0", "--end", "1:5", "--expect", "First"], PNG_OVER, /error 400\nimage is too large/],
    ["empty stdin", ["--start", "1:0", "--end", "1:5", "--expect", "First"], Buffer.alloc(0), /error 400\nempty image/],
    ["a mismatched --expect, as when the document changed (409)", ["--start", "1:0", "--end", "1:5", "--expect", "Frist"], PNG, /error 409/],
    ["a range out of the document (400)", ["--start", "9:0", "--end", "9:1", "--expect", "x"], PNG, /error 400/],
    ["a missing --start", ["--end", "1:5", "--expect", "First"], PNG, /attach requires/],
    ["a missing --end", ["--start", "1:0", "--expect", "First"], PNG, /attach requires/],
    ["a missing --expect", ["--start", "1:0", "--end", "1:5"], PNG, /attach requires --expect/],
    ["a range that spans two blocks (400)", ["--start", "1:0", "--end", "3:4", "--expect", twoBlocks], PNG, /error 400/],
  ];
  for (const [what, args, bytes, error] of cases) {
    const out = await run(ctx.hub, ["attach", rel, ...args], bytes);
    assert.notEqual(out.code, 0, `${what}: accepted`);
    assert.match(out.stderr, error, `${what}: ${JSON.stringify(out.stderr)}`);
    assert.equal(out.stdout, "", `${what}: wrote on stdout`);
    const now = await showDoc(ctx.hub, rel);
    assert.equal(now.text, before.text, `${what}: the body changed`);
    assert.equal(now.rev, before.rev, `${what}: the rev moved`);
  }
  const missing = await run(ctx.hub, ["attach", "nothere.md", "--start", "1:0", "--end", "1:0", "--expect", ""], PNG);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /error 404/);
  // No listing of a picture directory exists: /raw answers 404 for any directory, so a stray
  // file from a refusal cannot be seen here. The last attach shows the directory took no name.
  const ok = await attach(ctx.hub, rel, before.text, 0, 5, PNG);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(imageLines((await showDoc(ctx.hub, rel)).text).length, 1);
});

test("IMG.a8 a page session holding the block makes attach exit 409, name the holder, and write nothing", async (t) => {
  const ctx = await setup(t, { "held.md": "Held paragraph.\n\nOther.\n" });
  const page = await openPage(ctx, "held.md");
  assert.ok(await page.clickOffset(3));
  await page.quiet();
  const before = await showDoc(ctx.hub, "held.md");
  const out = await attach(ctx.hub, "held.md", before.text, 0, 4, PNG);
  assert.notEqual(out.code, 0, "the attach was accepted");
  assert.match(out.stderr, /409/);
  assert.match(out.stderr, new RegExp(`held by ${USER}`), out.stderr);
  const after = await showDoc(ctx.hub, "held.md");
  assert.equal(after.text, before.text);
  assert.equal(after.rev, before.rev);
});

test("IMG.a9 ticket show prints the image line with the body, the same bytes show prints", async (t) => {
  const ctx = await setup(t);
  const id = await newTicket(ctx.hub, "Body text.\n");
  const rel = `tickets/${id}.md`;
  assert.equal((await attach(ctx.hub, rel, "Body text.\n", 0, 4, PNG)).code, 0);
  const shown = await run(ctx.hub, ["ticket", "show", id]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.equal(shown.stdout, (await showDoc(ctx.hub, rel)).text);
  assert.equal(imageLines(shown.stdout).length, 1);
});

test("IMG.a10 a new ticket title moves no file, and the line still resolves", async (t) => {
  const ctx = await setup(t);
  const id = await newTicket(ctx.hub, "Body text.\n");
  const rel = `tickets/${id}.md`;
  assert.equal((await attach(ctx.hub, rel, "Body text.\n", 0, 4, PNG)).code, 0);
  const [img] = imageLines((await showDoc(ctx.hub, rel)).text);
  const set = await run(ctx.hub, ["ticket", "set", id, "--title", "A different title"], "", USER);
  assert.equal(set.code, 0, set.stderr);
  const [same] = imageLines((await showDoc(ctx.hub, rel)).text);
  assert.equal(same.address, img.address);
  const raw = await getRaw(ctx.hub.port, img.address);
  assert.equal(raw.status, 200);
  assert.equal(sha(raw.body), sha(PNG));
});

// ---- B. The page draws the picture -------------------------------------------------------------

test("IMG.p1 an image line is drawn closed, requested from /raw, and loads", async (t) => {
  const ctx = await setup(t, { "draw.md": "Caret here.\n\nAbove.\n" });
  assert.equal((await attach(ctx.hub, "draw.md", "Caret here.\n\nAbove.\n", 13, 18, PNG)).code, 0);
  const [img] = imageLines((await showDoc(ctx.hub, "draw.md")).text);
  const page = await openPage(ctx);
  const requests = [];
  const off = page.session.on("Network.requestWillBeSent", (p) => requests.push(p.request.url));
  await openFile(page, "draw.md");
  assert.ok(await page.clickOffset(2));
  await page.quiet();
  await waitFor(() => requests.some((u) => u.endsWith(`/raw/${REPO}/${img.address}`)), `a request for /raw/${REPO}/${img.address}`);
  off();
  const drawn = await waitFor(() => page.eval(`(() => {
    const el = document.querySelector("#editor .md-image img");
    return el && el.complete && el.naturalWidth > 0 ? { width: el.naturalWidth, raw: !!el.closest(".md-raw") } : null;
  })()`), "the picture to load");
  assert.equal(drawn.width, 200);
  assert.equal(drawn.raw, false, "the image line is drawn raw with the caret elsewhere");
});

test("IMG.p2 an https:// address is used as it is", async (t) => {
  const ctx = await setup(t, { "web.md": "Caret here.\n\n![web.png](https://example.invalid/web.png)\n" });
  const page = await openPage(ctx, "web.md");
  const src = await page.eval(`(() => { const el = document.querySelector("#editor .md-image img"); return el && el.getAttribute("src"); })()`);
  assert.equal(src, "https://example.invalid/web.png");
});

test("IMG.p3 the document's picture directory does not appear in the files drawer", async (t) => {
  const ctx = await setup(t, { "shot.md": "Shot.\n", "other.md": "Other.\n" });
  assert.equal((await attach(ctx.hub, "shot.md", "Shot.\n", 0, 4, PNG)).code, 0);
  const page = await openPage(ctx, "other.md");
  const tree = await page.eval(`(() => ({
    dirs: [...document.querySelectorAll(".md-file-drawer button.md-dir-toggle")].map((b) => b.dataset.dir),
    files: [...document.querySelectorAll(".md-file-drawer button.md-file")].map((b) => b.textContent),
  }))()`);
  assert.ok(!tree.dirs.includes("shot"), `the drawer shows shot/: ${JSON.stringify(tree)}`);
  assert.ok(!tree.files.some((f) => /\.png$/.test(f)), `the drawer lists a picture: ${JSON.stringify(tree)}`);
});

// The matrix cells read box.svg, a file the harness puts in the repo root, not a picture stored
// by attach. Their fixtures cannot name a stored picture until the plan's image cells change.
test("IMG.p4 the matrix image cells still pass (their image is box.svg in the repo, not an attached picture)", async (t) => {
  const results = mkdtempSync(path.join(tmpdir(), "viewmark-qa-imgcells-"));
  t.after(() => rmSync(results, { recursive: true, force: true }));
  const suites = ["pointer", "delete", "enter", "empty-line", "typing", "tab-move", "selection"].map((s) => path.join(HERE, `${s}.browser.js`));
  const code = await new Promise((resolve) => {
    // The child is a test run of its own, not part of this one.
    const env = { ...process.env, VIEWMARK_QA_RESULTS: results };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ["--test", "--test-concurrency=2", "--test-name-pattern=^(CK\\.im\\..*|DL\\.im\\..*|EN\\.im\\..*|BG\\.im-p|BG\\.p-im)$", ...suites], { stdio: "ignore", env });
    child.on("close", resolve);
  });
  const runs = readdirSync(results).flatMap((f) => JSON.parse(readFileSync(path.join(results, f), "utf8")));
  assert.ok(runs.length > 0, `no image cells ran (exit ${code})`);
  const bad = runs.filter((r) => r.status !== "PASS").map((r) => `${r.id} ${r.route}: ${r.failed.join("; ").slice(0, 160)}`);
  assert.deepEqual(bad, [], `image cells failing:\n${bad.join("\n")}`);
});

// ---- C. A person pastes or picks a picture -----------------------------------------------------

async function pastePicture(ctx, file, offset, bytes = PNG) {
  const page = ctx.page || (ctx.page = await openPage(ctx));
  await openFile(page, file);
  await grantClipboard(page);
  await clipboardImage(page, bytes);
  assert.ok(await page.clickOffset(offset), `no point for ${offset}`);
  await page.quiet();
  const before = await showDoc(ctx.hub, file);
  await page.key("v", ["Ctrl"]);
  const after = await waitFor(async () => {
    const now = await showDoc(ctx.hub, file);
    return now.text !== before.text ? now : null;
  }, `the paste into ${file}`);
  await page.quiet();
  return { page, before, after };
}

test("IMG.u1 a pasted picture goes after the block that holds the caret, as its own paragraph, and the caret ends after it", async (t) => {
  const doc = "alpha beta\n\ngamma delta\n";
  const ctx = await setup(t, { "start.md": doc, "inside.md": doc, "end.md": doc, "gap.md": doc });
  for (const [file, offset] of [["start.md", 0], ["inside.md", "alpha be".length], ["end.md", "alpha beta".length]]) {
    const { page, after } = await pastePicture(ctx, file, offset);
    const [img] = imageLines(after.text);
    assert.ok(img, `${file}: no image line`);
    assert.match(img.address, new RegExp(`^${file.slice(0, -3)}/${ID}\\.png$`));
    assert.equal(after.text, `alpha beta\n\n${img.line}\n\ngamma delta\n`, `${file}: the paragraph was split or the line misplaced`);
    const caret = await page.caret();
    const lineEnd = img.index + img.line.length;
    assert.ok(caret.focus >= lineEnd && caret.focus <= lineEnd + 1, `${file}: the caret is at ${caret.focus}, not after the picture at ${lineEnd}`);
    const raw = await getRaw(ctx.hub.port, img.address);
    assert.equal(raw.status, 200);
    assert.deepEqual(pngSize(raw.body), { width: 200, height: 80 }, "the stored picture is not the pasted one");
  }
  // The caret on the empty line between the two paragraphs.
  const { after } = await pastePicture(ctx, "gap.md", "alpha beta\n".length);
  const [img] = imageLines(after.text);
  assert.ok(img, "gap.md: no image line");
  const between = [`alpha beta\n\n${img.line}\n\ngamma delta\n`, `alpha beta\n${img.line}\ngamma delta\n`];
  assert.ok(between.includes(after.text), `gap.md: the picture is not on the empty line between the paragraphs: ${JSON.stringify(after.text)}`);
});

test("IMG.u2 a picture pasted inside a block is drawn directly under that block, not where the caret was", async (t) => {
  const ctx = await setup(t, { "under.md": "alpha beta\n\ngamma delta\n" });
  const { page } = await pastePicture(ctx, "under.md", "alpha be".length);
  const boxes = await waitFor(() => page.eval(`(() => {
    const img = document.querySelector("#editor .md-image img");
    const lines = [...document.querySelectorAll("#editor .md-line")];
    const alpha = lines.find((l) => l.textContent.includes("alpha beta"));
    const gamma = lines.find((l) => l.textContent.includes("gamma delta"));
    if (!img || !img.complete || !alpha || !gamma) return null;
    const r = img.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, alphaBottom: alpha.getBoundingClientRect().bottom, gammaTop: gamma.getBoundingClientRect().top };
  })()`), "the picture drawn");
  assert.ok(boxes.top >= boxes.alphaBottom - 1, `the picture starts above the end of alpha beta: ${JSON.stringify(boxes)}`);
  assert.ok(boxes.bottom <= boxes.gammaTop + 1, `the picture runs into gamma delta: ${JSON.stringify(boxes)}`);
  assert.ok(boxes.top - boxes.alphaBottom < 40, `the picture is not directly under alpha beta: ${JSON.stringify(boxes)}`);
});

test("IMG.u3 a person picks a file, and the result is the same as a paste", async (t) => {
  const ctx = await setup(t, { "pick.md": "alpha beta\n\ngamma delta\n" });
  const page = await openPage(ctx, "pick.md");
  const picker = await page.eval(`(() => { const el = document.querySelector('input[type="file"]'); return el ? { accept: el.accept } : null; })()`);
  // Dropping a file from disk is the other way a file reaches the page; it is checked too, so
  // a missing picker does not hide whether the bytes path works.
  const dir = fixtureDir(ctx);
  const file = path.join(dir, "shot.png");
  writeFileSync(file, PNG);
  assert.ok(await page.clickOffset("alpha be".length));
  await page.quiet();
  await dropFiles(page, "alpha be".length, [file]);
  const dropped = await waitFor(async () => {
    const now = await showDoc(ctx.hub, "pick.md");
    return imageLines(now.text).length ? now : null;
  }, "the dropped file", 4000).catch(() => null);
  const droppedOk = dropped && sha((await getRaw(ctx.hub.port, imageLines(dropped.text)[0].address)).body) === sha(PNG);
  assert.ok(picker, `the page has no file picker, so a person cannot pick a file as images.md says; a dropped file ${droppedOk ? "does reach the document, byte for byte" : "does not reach the document either"}`);
  const dir2 = fixtureDir(ctx);
  const file2 = path.join(dir2, "picked.png");
  writeFileSync(file2, PNG);
  const doc = await page.session.send("DOM.getDocument", { depth: -1 });
  const found = await page.session.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: 'input[type="file"]' });
  await page.session.send("DOM.setFileInputFiles", { nodeId: found.nodeId, files: [file2] });
  const picked = await waitFor(async () => {
    const now = await showDoc(ctx.hub, "pick.md");
    return imageLines(now.text).length > (dropped ? 1 : 0) ? now : null;
  }, "the picked file");
  const last = imageLines(picked.text).pop();
  assert.equal(sha((await getRaw(ctx.hub.port, last.address)).body), sha(PNG));
});

test("IMG.u4 a paste is one edit: the bytes go once, the hub answers with the doc, and no data: address is written", async (t) => {
  const ctx = await setup(t, { "once.md": "alpha beta\n\ngamma delta\n" });
  const page = ctx.page = await openPage(ctx);
  const rec = recordFrames(page);
  const { after, before } = await pastePicture(ctx, "once.md", 3);
  rec.stop();
  const out = rec.frames.filter((f) => f.dir === "out");
  const attaches = out.filter((f) => f.opcode === 1 && /"type":"attach"/.test(f.text));
  const binaries = out.filter((f) => f.opcode === 2);
  assert.equal(attaches.length, 1, `attach frames sent: ${attaches.length}`);
  assert.equal(binaries.length, 1, `binary frames sent: ${binaries.length}`);
  const edits = out.filter((f) => f.opcode === 1 && /"type":"edit"/.test(f.text));
  assert.equal(edits.length, 0, "the paste also sent an edit");
  assert.ok(rec.frames.some((f) => f.dir === "in" && f.opcode === 1 && /"type":"(file|doc)"/.test(f.text) && f.text.includes(imageLines(after.text)[0].address)), "no doc answer carried the image line");
  assert.equal(after.rev, before.rev + 1, "the paste was not one edit");
  assert.ok(!after.text.includes("data:"), "a data: address was written");
});

test("IMG.u5 pasting text is the ordinary paste", async (t) => {
  const ctx = await setup(t, { "text.md": "alpha beta\n" });
  const page = await openPage(ctx, "text.md");
  await grantClipboard(page);
  await clipboardText(page, "XY");
  assert.ok(await page.clickOffset(5));
  await page.quiet();
  await page.key("v", ["Ctrl"]);
  await page.quiet();
  assert.equal((await showDoc(ctx.hub, "text.md")).text, "alphaXY beta\n");
});

test("IMG.u6 a paste over 2 MiB, or of bytes that are not an image, writes nothing and shows the person something within a second", async (t) => {
  const ctx = await setup(t, { "big.md": "alpha beta\n", "notimg.md": "alpha beta\n" });
  const page = await openPage(ctx, "big.md");
  await grantClipboard(page);
  // Noise does not compress, so the browser's clipboard copy stays over 2 MiB.
  await clipboardImage(page, png(900, 900, { noise: true }));
  assert.ok(await page.clickOffset(3));
  await page.quiet();
  const before = await showDoc(ctx.hub, "big.md");
  await page.key("v", ["Ctrl"]);
  const shown = await waitFor(() => page.eval(`(() => { const n = document.querySelector(".md-notice"); return n && n.textContent.trim() ? n.textContent : null; })()`), "feedback for the over-size paste", 1000);
  assert.ok(shown);
  await sleep(500);
  assert.equal((await showDoc(ctx.hub, "big.md")).text, before.text, "the over-size paste wrote");
  // A text file is not an image. The clipboard holds only pictures and text, so the file is dropped.
  await openFile(page, "notimg.md");
  const dir = fixtureDir(ctx);
  const file = path.join(dir, "note.txt");
  writeFileSync(file, TEXT);
  const before2 = await showDoc(ctx.hub, "notimg.md");
  assert.ok(await page.clickOffset(3));
  await page.quiet();
  await dropFiles(page, 3, [file]);
  const shown2 = await waitFor(() => page.eval(`(() => { const n = document.querySelector(".md-notice"); return n && n.textContent.trim() ? n.textContent : null; })()`), "feedback for the non-image", 1000);
  assert.ok(shown2);
  await sleep(500);
  assert.equal((await showDoc(ctx.hub, "notimg.md")).text, before2.text, "the non-image wrote");
});

test("IMG.u7 a picture pasted into a comment note leaves the note as text and writes no file", async (t) => {
  const doc = "See {c1}this{/c1} now.\n\n```comment c1\n:: 0\n@2026-10-05T16:00:00.000Z Ada\nNote.\n```\n";
  const ctx = await setup(t, { "note.md": doc });
  const page = await openPage(ctx, "note.md");
  await grantClipboard(page);
  await clipboardImage(page, PNG);
  assert.ok(await page.clickOffset(doc.indexOf("this") + 2));
  await page.quiet();
  const reply = await page.eval(`(() => { const b = document.querySelector('.md-comment-card[data-comment="c1"] button[aria-label="Reply"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  assert.ok(reply, "no Reply button on the card");
  await page.click(reply.x, reply.y);
  await waitFor(() => page.eval(`(() => { const a = document.activeElement; return !!a && (a.tagName === "TEXTAREA" || a.isContentEditable) && !!a.closest(".md-comment-card"); })()`), "the reply box focused");
  await page.key("v", ["Ctrl"]);
  await sleep(800);
  const after = await showDoc(ctx.hub, "note.md");
  assert.equal(after.text, doc, "the paste changed the document");
  const box = await page.eval(`(() => { const a = document.activeElement; return a ? (a.value ?? a.textContent ?? "") : ""; })()`);
  assert.ok(!/!\[|data:/.test(box), `the note holds an image reference: ${JSON.stringify(box)}`);
});

test("IMG.u8 a paste where another session holds the block is refused, writes nothing, and the holder's name flashes", async (t) => {
  const doc = "alpha beta\n\ngamma delta\n";
  const ctx = await setup(t, { "held.md": doc });
  const a = await openPage(ctx, "held.md");
  const b = await openPage(ctx, "held.md", OTHER);
  // B holds the blank line between the paragraphs, which the picture's line would replace.
  assert.ok(await b.clickOffset("alpha beta\n".length));
  await b.quiet();
  await a.until(() => a.eval(`[...document.querySelectorAll(".md-lock")].some((l) => l.textContent.includes(${JSON.stringify(OTHER)}))`), "A sees B's lock", 3000).catch(() => {});
  await grantClipboard(a);
  await clipboardImage(a, PNG);
  assert.ok(await a.clickOffset(3));
  await a.quiet();
  const before = await showDoc(ctx.hub, "held.md");
  const classes = () => a.eval(`[...document.querySelectorAll(".md-lock")].map((l) => l.className).join("|")`);
  const quiet = await classes();
  const rec = recordFrames(a);
  await a.key("v", ["Ctrl"]);
  // D26 is a flash of the holder's label. The owner's c4 accepts any visible feedback for a
  // refused paste, so a notice that names the holder counts too.
  const flashed = await waitFor(() => a.eval(`[...document.querySelectorAll(".md-lock")].some((l) => l.getAnimations && l.getAnimations().length > 0)`).then(async (anim) => anim || (await classes()) !== quiet
    || (await a.eval(`(document.querySelector(".md-notice") || {}).textContent || ""`)).includes(OTHER)), "the holder's name to flash or show (D26, c4)", 1500).catch(() => false);
  await sleep(500);
  rec.stop();
  assert.equal((await showDoc(ctx.hub, "held.md")).text, before.text, "the paste was written");
  assert.ok(rec.frames.some((f) => f.dir === "in" && /"status":409/.test(f.text)), "no 409 came back");
  assert.ok(flashed, "the holder's name neither flashed (D26) nor showed in a notice (c4)");
});

test("IMG.u9 a second session sees the picture without a reload, and the frames carry the line, not the bytes", async (t) => {
  const ctx = await setup(t, { "seen.md": "alpha beta\n\ngamma delta\n" });
  const b = await openPage(ctx, "seen.md", OTHER);
  // The second session's caret holds gamma delta, away from where the picture goes.
  assert.ok(await b.clickOffset("alpha beta\n\ngamma".length));
  await b.quiet();
  const rec = recordFrames(b);
  ctx.page = await openPage(ctx);
  const { after } = await pastePicture(ctx, "seen.md", 3, png(200, 80, { noise: true }));
  const [img] = imageLines(after.text);
  await waitFor(() => b.eval(`(() => { const el = document.querySelector("#editor .md-image img"); return !!el && el.complete && el.naturalWidth > 0; })()`), "the picture in the second session");
  rec.stop();
  const inbound = rec.frames.filter((f) => f.dir === "in");
  assert.ok(inbound.some((f) => f.text.includes(img.address)), "no frame named the image line");
  const biggest = Math.max(...inbound.map((f) => f.size));
  assert.ok(biggest < 16 * 1024, `a frame to the second session was ${biggest} bytes`);
});

// ---- D. Select and delete ----------------------------------------------------------------------

// The second picture is the 1 by 1 GIF. A click on a picture that small must still select it.
async function pictureDoc(ctx, file, text, count = 1, fixtures = [PNG, GIF]) {
  await ctx.hub.create(file, text);
  for (let i = 0; i < count; i += 1) {
    const now = (await showDoc(ctx.hub, file)).text;
    const out = await attach(ctx.hub, file, now, 0, 3, fixtures[i % fixtures.length]);
    assert.equal(out.code, 0, out.stderr);
  }
  return showDoc(ctx.hub, file);
}

async function clickPicture(page) {
  const pt = await waitFor(() => page.eval(`(() => {
    const el = document.querySelector("#editor .md-image img");
    if (!el || !el.complete || !el.naturalWidth) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`), "the picture drawn");
  await page.click(pt.x, pt.y);
  await page.quiet();
}

test("IMG.s1 a click on the picture selects the whole image line", async (t) => {
  const ctx = await setup(t);
  const doc = await pictureDoc(ctx, "sel.md", "One.\n\nTwo.\n");
  const [img] = imageLines(doc.text);
  const page = await openPage(ctx, "sel.md");
  await clickPicture(page);
  const caret = await page.caret();
  const selected = await page.eval(`!!document.querySelector("#editor .md-image.md-atom-selected")`);
  const lo = Math.min(caret.anchor, caret.focus);
  const hi = Math.max(caret.anchor, caret.focus);
  assert.ok(selected || (lo === img.index && hi === img.index + img.line.length), `the picture is not selected: selection ${caret.anchor}-${caret.focus}, line ${img.index}-${img.index + img.line.length}`);
});

for (const key of ["Backspace", "Delete"]) {
  test(`IMG.s2 ${key} with the picture selected removes the line in one edit`, async (t) => {
    const ctx = await setup(t);
    const doc = await pictureDoc(ctx, "del.md", "One.\n\nTwo.\n");
    const [img] = imageLines(doc.text);
    const page = await openPage(ctx, "del.md");
    await clickPicture(page);
    await page.key(key);
    await page.quiet();
    const after = await showDoc(ctx.hub, "del.md");
    assert.ok(!after.text.includes(img.line), `the line is still there: ${JSON.stringify(after.text)}`);
    assert.equal(after.rev, doc.rev + 1, "more than one edit");
    assert.equal(after.text.replace(/\n+/g, "\n"), "One.\nTwo.\n", `the text around the picture changed: ${JSON.stringify(after.text)}`);
  });
}

test("IMG.s3 Ctrl+Z puts the line back, and the picture loads", async (t) => {
  const ctx = await setup(t);
  const doc = await pictureDoc(ctx, "undo.md", "One.\n\nTwo.\n");
  const [img] = imageLines(doc.text);
  const page = await openPage(ctx, "undo.md");
  await clickPicture(page);
  await page.key("Backspace");
  await page.quiet();
  await page.key("z", ["Ctrl"]);
  await page.quiet();
  assert.equal((await showDoc(ctx.hub, "undo.md")).text, doc.text);
  await waitFor(() => page.eval(`(() => { const el = document.querySelector("#editor .md-image img"); return !!el && el.complete && el.naturalWidth > 0; })()`), "the picture loads again");
  assert.equal((await getRaw(ctx.hub.port, img.address)).status, 200);
});

test("IMG.s4 at the last close the hub deletes each file no line names, and keeps a named one", async (t) => {
  const ctx = await setup(t, { "away.md": "Away.\n" });
  const doc = await pictureDoc(ctx, "two.md", "One.\n\nTwo.\n", 2);
  const lines = imageLines(doc.text);
  assert.equal(lines.length, 2);
  const page = await openPage(ctx, "two.md");
  await clickPicture(page);
  await page.key("Backspace");
  await page.quiet();
  const left = imageLines((await showDoc(ctx.hub, "two.md")).text);
  assert.equal(left.length, 1);
  const gone = lines.find((l) => l.address !== left[0].address);
  assert.equal((await getRaw(ctx.hub.port, gone.address)).status, 200, "the file went before the last close");
  await openFile(page, "away.md");
  await waitFor(async () => (await getRaw(ctx.hub.port, gone.address)).status === 404, "the unnamed file deleted at the last close", 6000);
  assert.equal((await getRaw(ctx.hub.port, left[0].address)).status, 200, "a named file was deleted");
});

test("IMG.s5 a CLI diff that drops the line keeps the file while the document is open, and it goes at the last close", async (t) => {
  const ctx = await setup(t, { "away.md": "Away.\n" });
  const doc = await pictureDoc(ctx, "diff.md", "One.\n\nTwo.\n");
  const [img] = imageLines(doc.text);
  const page = await openPage(ctx, "diff.md");
  assert.ok(await page.clickOffset(1));
  await page.quiet();
  const diff = `@@\n One.\n \n-${img.line}\n \n Two.\n`;
  const out = await ctx.hub.edit("diff.md", diff);
  assert.equal(out.code, 0, out.stderr);
  assert.ok(!(await showDoc(ctx.hub, "diff.md")).text.includes(img.line));
  assert.equal((await getRaw(ctx.hub.port, img.address)).status, 200, "the file went while the document is open");
  await openFile(page, "away.md");
  await waitFor(async () => (await getRaw(ctx.hub.port, img.address)).status === 404, "the file deleted at the last close", 6000);
});

test("IMG.s6 retyping an address moves no bytes, and the old file goes at the last close", async (t) => {
  const ctx = await setup(t, { "away.md": "Away.\n" });
  const doc = await pictureDoc(ctx, "retype.md", "One.\n\nTwo.\n");
  const [img] = imageLines(doc.text);
  const renamed = img.address.replace(/\/(\w)/, "/z$1");
  const page = await openPage(ctx, "retype.md");
  assert.ok(await page.clickOffset(1));
  await page.quiet();
  const out = await ctx.hub.edit("retype.md", `@@\n-${img.line}\n+![${img.alt}](${renamed})\n`);
  assert.equal(out.code, 0, out.stderr);
  assert.equal((await getRaw(ctx.hub.port, renamed)).status, 404, "bytes moved to the retyped address");
  assert.equal((await getRaw(ctx.hub.port, img.address)).status, 200, "the old file went while the document is open");
  await openFile(page, "away.md");
  await waitFor(async () => (await getRaw(ctx.hub.port, img.address)).status === 404, "the old file deleted at the last close", 6000);
});

// ---- E. Moving and deleting the document ------------------------------------------------------

test("IMG.m1 a move carries the directory and rewrites the document's addresses", async (t) => {
  // move needs the destination directory to exist; archive/keep.md makes it.
  const ctx = await setup(t, { "notes/welcome.md": "Welcome.\n", "archive/keep.md": "Keep.\n" });
  assert.equal((await attach(ctx.hub, "notes/welcome.md", "Welcome.\n", 0, 7, PNG)).code, 0);
  const [img] = imageLines((await showDoc(ctx.hub, "notes/welcome.md")).text);
  const out = await run(ctx.hub, ["move", "notes/welcome.md", "--dir", "archive"]);
  assert.equal(out.code, 0, out.stderr);
  const moved = (await showDoc(ctx.hub, "archive/welcome.md")).text;
  const [now] = imageLines(moved);
  assert.equal(now.address, img.address.replace(/^notes\/welcome\//, "archive/welcome/"));
  const raw = await getRaw(ctx.hub.port, now.address);
  assert.equal(raw.status, 200);
  assert.equal(sha(raw.body), sha(PNG));
  assert.equal((await getRaw(ctx.hub.port, img.address)).status, 404);
});

test("IMG.m2 when the destination directory exists, the move is 409 and both stay", async (t) => {
  const ctx = await setup(t, { "notes/welcome.md": "Welcome.\n", "archive/welcome/other.md": "Other.\n" });
  assert.equal((await attach(ctx.hub, "notes/welcome.md", "Welcome.\n", 0, 7, PNG)).code, 0);
  const before = await showDoc(ctx.hub, "notes/welcome.md");
  const [img] = imageLines(before.text);
  const out = await run(ctx.hub, ["move", "notes/welcome.md", "--dir", "archive"]);
  assert.notEqual(out.code, 0, "the move was made");
  assert.match(out.stderr, /409/);
  assert.equal((await showDoc(ctx.hub, "notes/welcome.md")).text, before.text);
  assert.equal((await getRaw(ctx.hub.port, img.address)).status, 200);
  assert.equal((await showDoc(ctx.hub, "archive/welcome/other.md")).text, "Other.\n");
});

test("IMG.m3 another document that names a file in the moved directory is not rewritten", async (t) => {
  const ctx = await setup(t, { "notes/welcome.md": "Welcome.\n", "archive/keep.md": "Keep.\n" });
  assert.equal((await attach(ctx.hub, "notes/welcome.md", "Welcome.\n", 0, 7, PNG)).code, 0);
  const [img] = imageLines((await showDoc(ctx.hub, "notes/welcome.md")).text);
  const other = `Points at it.\n\n${img.line}\n`;
  await ctx.hub.create("other.md", other);
  assert.equal((await run(ctx.hub, ["move", "notes/welcome.md", "--dir", "archive"])).code, 0);
  assert.equal((await showDoc(ctx.hub, "other.md")).text, other);
});

test("IMG.d1 deleting the document removes its directory", async (t) => {
  const ctx = await setup(t, { "notes/welcome.md": "Welcome.\n" });
  assert.equal((await attach(ctx.hub, "notes/welcome.md", "Welcome.\n", 0, 7, PNG)).code, 0);
  const [img] = imageLines((await showDoc(ctx.hub, "notes/welcome.md")).text);
  const out = await run(ctx.hub, ["delete", "notes/welcome.md"]);
  assert.equal(out.code, 0, out.stderr);
  assert.equal((await getRaw(ctx.hub.port, img.address)).status, 404);
});

test("IMG.d2 ticket delete, and ticket purge of a closed ticket, remove the ticket's directory", async (t) => {
  const ctx = await setup(t);
  const one = await newTicket(ctx.hub, "One.\n");
  const two = await newTicket(ctx.hub, "Two.\n");
  assert.equal((await attach(ctx.hub, `tickets/${one}.md`, "One.\n", 0, 3, PNG)).code, 0);
  assert.equal((await attach(ctx.hub, `tickets/${two}.md`, "Two.\n", 0, 3, PNG)).code, 0);
  const [a] = imageLines((await showDoc(ctx.hub, `tickets/${one}.md`)).text);
  const [b] = imageLines((await showDoc(ctx.hub, `tickets/${two}.md`)).text);
  const del = await run(ctx.hub, ["ticket", "delete", one], "", USER);
  assert.equal(del.code, 0, del.stderr);
  assert.equal((await getRaw(ctx.hub.port, a.address)).status, 404, "ticket delete left the directory");
  assert.equal((await run(ctx.hub, ["ticket", "set", two, "--state", "closed"], "", USER)).code, 0);
  const purge = await run(ctx.hub, ["ticket", "purge"], "", USER);
  assert.equal(purge.code, 0, purge.stderr);
  assert.equal((await getRaw(ctx.hub.port, b.address)).status, 404, "ticket purge left the directory");
});

// ---- F. The upload -----------------------------------------------------------------------------

test("IMG.f1 the bytes travel as one binary frame, not base64 in text, and 2 MiB goes through", async (t) => {
  const ctx = await setup(t, { "frame.md": "alpha beta\n\ngamma delta\n" });
  const page = await openPage(ctx, "frame.md");
  const dir = fixtureDir(ctx);
  const file = path.join(dir, "big.png");
  writeFileSync(file, PNG_2MIB);
  assert.ok(await page.clickOffset(3));
  await page.quiet();
  const rec = recordFrames(page);
  await dropFiles(page, 3, [file]);
  const after = await waitFor(async () => {
    const now = await showDoc(ctx.hub, "frame.md");
    return imageLines(now.text).length ? now : null;
  }, "the 2 MiB picture", 8000);
  rec.stop();
  const out = rec.frames.filter((f) => f.dir === "out");
  const binary = out.filter((f) => f.opcode === 2);
  assert.equal(binary.length, 1, `binary frames: ${binary.length}`);
  assert.equal(binary[0].size, MIB2);
  const biggestText = Math.max(0, ...out.filter((f) => f.opcode === 1).map((f) => f.size));
  assert.ok(biggestText < 16 * 1024, `a text frame was ${biggestText} bytes`);
  const raw = await getRaw(ctx.hub.port, imageLines(after.text)[0].address);
  assert.equal(sha(raw.body), sha(PNG_2MIB));
});

test("IMG.f2 after the upload, the frames for later edits stay small", async (t) => {
  const ctx = await setup(t);
  await pictureDoc(ctx, "small.md", "One.\n\nTwo.\n");
  const page = await openPage(ctx, "small.md");
  assert.ok(await page.clickOffset(2));
  await page.quiet();
  const rec = recordFrames(page);
  await page.type("xyz");
  await page.quiet();
  rec.stop();
  const biggest = Math.max(...rec.frames.map((f) => f.size));
  assert.ok(rec.frames.length > 0, "no frames");
  assert.ok(biggest < 4 * 1024, `a frame for typing was ${biggest} bytes`);
});

// ---- Beyond the plan ---------------------------------------------------------------------------

// Found while building u4: after the person opens the same document again, a paste in the block
// their own caret is in is refused as held by their own name.
test("beyond the plan: a paste after the same document is opened again lands, not refused as held by the person", async (t) => {
  const ctx = await setup(t, { "again.md": "alpha beta\n\ngamma delta\n" });
  const page = ctx.page = await openPage(ctx, "again.md");
  await openFile(page, "again.md");
  await grantClipboard(page);
  await clipboardImage(page, PNG);
  assert.ok(await page.clickOffset(3));
  await page.quiet();
  const before = await showDoc(ctx.hub, "again.md");
  await page.key("v", ["Ctrl"]);
  await sleep(1500);
  const notice = await page.eval(`(document.querySelector(".md-notice") || {}).textContent || ""`);
  const after = await showDoc(ctx.hub, "again.md");
  assert.notEqual(after.text, before.text, `the paste was refused${notice ? `, with the notice ${JSON.stringify(notice)}` : ""}`);
});
