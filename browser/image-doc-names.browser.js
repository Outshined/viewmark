import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { AGENT, REPO, cli, launchBrowser, Page, startHub } from "./harness.js";

// Ticket t37rgtxg: a picture in a document whose name holds a space, a tab, or parentheses is
// deleted when the person opens another document. Each test is one acceptance criterion in that
// ticket's body. The bytes are read back only through GET /raw and the CLI.

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const GIF = Buffer.from("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");

// How long a kept file is watched after the last close. The cleanup runs as the session lets go
// of the document, so a file it deletes is gone well inside this.
const WATCH_MS = 2000;

function getRaw(port, address) {
  const rel = address.split("/").map(encodeURIComponent).join("/");
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: `/raw/${REPO}/${rel}`, method: "GET", headers: { Connection: "close" } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

const run = (hub, args, input = "") => cli(hub.port, ["--user", AGENT, "--repo", REPO, ...args], input);

// The image lines the hub wrote, each a whole line: ![NAME](ADDRESS), the name being the
// address's last part.
function imageLines(text) {
  return text.split("\n").flatMap((line) => {
    const m = /^!\[([^\]]+)\]\((.+)\/\1\)$/.exec(line);
    return m ? [{ line, name: m[1], address: `${m[2]}/${m[1]}` }] : [];
  });
}

async function waitFor(check, what, timeout = 5000) {
  const until = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) assert.fail(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

async function setup(t, docs) {
  const hub = await startHub();
  const ctx = { hub, browser: null };
  t.after(async () => {
    if (ctx.browser) await ctx.browser.close();
    await hub.close();
  });
  for (const [file, text] of Object.entries(docs)) hub.plant(file, text);
  return ctx;
}

async function openPage(ctx, file) {
  ctx.browser = await launchBrowser();
  const page = new Page(ctx.browser.session, ctx.hub.port);
  await page.init();
  await page.login();
  await page.open(file);
  return page;
}

// Another document chosen on the same page, as the person picks it from the files drawer.
async function switchTo(page, file) {
  const since = page.frames.length;
  await page.eval(`location.hash = ${JSON.stringify(`#${REPO}/doc/${encodeURIComponent(file)}`)}; true`);
  await page.until(() => page.frames.slice(since).some((f) => f.dir === "in" && f.data && f.data.type === "file" && f.data.path === file), `${file} open`);
  await page.quiet();
}

function pasteFile(page, bytes, type) {
  const b64 = Buffer.from(bytes).toString("base64");
  return page.eval(`(() => {
    const bin = atob(${JSON.stringify(b64)});
    const raw = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) raw[i] = bin.charCodeAt(i);
    const data = new DataTransfer();
    data.items.add(new File([raw], "shot", { type: ${JSON.stringify(type)} }));
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: data });
    document.getElementById("editor").dispatchEvent(event);
    return true;
  })()`);
}

// The new picture's line, wherever the paste put it.
async function pastePicture(page, hub, file, bytes, type) {
  const before = new Set(imageLines((await hub.show(file)).text).map((img) => img.line));
  await pasteFile(page, bytes, type);
  let added = [];
  await waitFor(async () => {
    added = imageLines((await hub.show(file)).text).filter((img) => !before.has(img.line));
    return added.length === 1;
  }, `the image line in ${file}`);
  await page.quiet();
  return added[0];
}

// The drawn pictures, in document order, with whether each one loaded.
const drawn = (page) => page.eval(`[...document.querySelectorAll("#editor .md-image img")].map((img) => ({ src: img.getAttribute("src"), loaded: img.complete && img.naturalWidth > 0 }))`);

async function assertKept(hub, img, what) {
  const until = Date.now() + WATCH_MS;
  for (;;) {
    const raw = await getRaw(hub.port, img.address);
    assert.equal(raw.status, 200, `${what}: /raw ${img.address} is ${raw.status}`);
    if (Date.now() > until) return raw;
    await sleep(100);
  }
}

// ---- Pasted pictures and the last close -------------------------------------------------------

const PASTED = [
  { file: "My Notes.md", why: "a space" },
  { file: "Tab\there.md", why: "a tab" },
  { file: "Plan (draft).md", why: "parentheses" },
  { file: "plain.md", why: "no space, as before the fix" },
  { file: "sub/deep.md", why: "a subdirectory, as before the fix" },
];

for (const { file, why } of PASTED) {
  test(`t37rgtxg: in ${JSON.stringify(file)}, ${why}, a pasted picture is drawn as soon as it is pasted`, async (t) => {
    const ctx = await setup(t, { [file]: "alpha beta\n" });
    const page = await openPage(ctx, file);
    assert.ok(await page.clickOffset(3));
    await page.quiet();
    const img = await pastePicture(page, ctx.hub, file, PNG, "image/png");
    const pictures = await waitFor(async () => {
      const now = await drawn(page);
      return now.length === 1 && now[0].loaded ? now : null;
    }, `the picture drawn from ${JSON.stringify(img.line)}`).catch(async (err) => {
      throw new Error(`${err.message}: drawn ${JSON.stringify(await drawn(page))}`);
    });
    assert.equal(pictures.length, 1);
  });

  test(`t37rgtxg: in ${JSON.stringify(file)}, ${why}, a pasted picture is kept when the person opens another document, and is drawn after a forced reload`, async (t) => {
    const ctx = await setup(t, { [file]: "alpha beta\n", "away.md": "Away.\n" });
    const page = await openPage(ctx, file);
    assert.ok(await page.clickOffset(3));
    await page.quiet();
    const kept = await pastePicture(page, ctx.hub, file, PNG, "image/png");
    const dropped = await pastePicture(page, ctx.hub, file, GIF, "image/gif");
    // The second picture's line goes, from the CLI, with the page's caret back in alpha beta so
    // the page holds no lock on that line. Its file stays while the page has the document open,
    // and goes at the last close. Its 404 shows the cleanup ran.
    assert.ok(await page.clickOffset(1));
    await page.quiet();
    const out = await run(ctx.hub, ["edit", file], `@@\n-${dropped.line}\n`);
    assert.equal(out.code, 0, out.stderr);
    assert.equal((await getRaw(ctx.hub.port, dropped.address)).status, 200, "the dropped picture went while the document is open");

    await switchTo(page, "away.md");
    await waitFor(async () => (await getRaw(ctx.hub.port, dropped.address)).status === 404, "the cleanup at the last close");
    const raw = await assertKept(ctx.hub, kept, "after the person opened away.md");
    assert.ok(raw.body.equals(PNG), "the stored bytes are not the pasted picture");

    // A forced reload, as Ctrl+Shift+R, then back to the document.
    await page.session.send("Page.reload", { ignoreCache: true });
    await page.until(() => page.eval(`document.readyState === "complete" && !!document.querySelector("#editor")`), "the page back after the reload");
    await page.open(file);
    assert.ok((await ctx.hub.show(file)).text.includes(kept.line), "the image line is gone");
    await assertKept(ctx.hub, kept, "after the reload");
    await waitFor(async () => {
      const now = await drawn(page);
      return now.length === 1 && now[0].loaded;
    }, "the picture drawn after the reload");
  });
}

// ---- attach from the CLI ----------------------------------------------------------------------

for (const file of ["My Notes.md", "Tab\there.md", "Plan (draft).md"]) {
  test(`t37rgtxg: attach from the CLI on ${JSON.stringify(file)} leaves the file in place after the command exits`, async (t) => {
    const ctx = await setup(t, { [file]: "alpha beta\n" });
    const out = await run(ctx.hub, ["attach", file, "--start", "1:0", "--end", "1:5", "--expect", "alpha"], PNG);
    assert.equal(out.code, 0, out.stderr);
    const [img] = imageLines((await ctx.hub.show(file)).text);
    assert.ok(img, "no image line");
    const raw = await assertKept(ctx.hub, img, "after attach exited");
    assert.ok(raw.body.equals(PNG));
  });
}

// ---- move ----------------------------------------------------------------------------------------

const MOVES = [
  { from: "My Notes.md", dir: "archive" },
  { from: "Tab\there.md", dir: "archive" },
  { from: "Plan (draft).md", dir: "archive" },
  { from: "plain.md", dir: "Old Notes" },
  { from: "Old Notes/space.md", dir: "archive" },
];

for (const { from, dir } of MOVES) {
  test(`t37rgtxg: move ${JSON.stringify(from)} --dir ${JSON.stringify(dir)} writes a line that names the moved file, and /raw serves it after the last close`, async (t) => {
    // move needs the destination directory to exist; keep.md makes it.
    const ctx = await setup(t, { [from]: "alpha beta\n", [`${dir}/keep.md`]: "Keep.\n", "away.md": "Away.\n" });
    const page = await openPage(ctx, from);
    assert.ok(await page.clickOffset(3));
    await page.quiet();
    await pastePicture(page, ctx.hub, from, PNG, "image/png");
    // The page stays on the document through the move, so the file is there for the move to
    // carry whatever the last close does before it.
    const out = await run(ctx.hub, ["move", from, "--dir", dir]);
    assert.equal(out.code, 0, out.stderr);
    const moved = `${dir}/${from.split("/").pop()}`;
    const dirOf = moved.replace(/\.md$/, "");
    const text = (await ctx.hub.show(moved)).text;
    const [img] = imageLines(text);
    assert.ok(img, `no image line in ${JSON.stringify(text)}`);
    assert.equal(img.address, `${dirOf}/${img.name}`, "the line does not name the moved directory");
    await switchTo(page, "away.md");
    const raw = await assertKept(ctx.hub, img, "after the last close of the moved document");
    assert.ok(raw.body.equals(PNG));
  });
}

// ---- An unclosed ![alt]( before a picture ------------------------------------------------------

const UNCLOSED = [
  { name: "inline code", file: "span.md", text: "Type `![alt](` and then the address.\n\nalpha beta\n" },
  { name: "a fence", file: "fence.md", text: "```\n![alt](\n```\n\nalpha beta\n" },
];

for (const { name, file, text } of UNCLOSED) {
  test(`t37rgtxg: with an unclosed ![alt]( in ${name} before a picture, the picture is kept at the last close`, async (t) => {
    const ctx = await setup(t, { [file]: text, "away.md": "Away.\n" });
    const page = await openPage(ctx, file);
    assert.ok(await page.clickOffset(text.indexOf("alpha") + 3));
    await page.quiet();
    const img = await pastePicture(page, ctx.hub, file, PNG, "image/png");
    await switchTo(page, "away.md");
    await assertKept(ctx.hub, img, "after the person opened away.md");
  });

  test(`t37rgtxg: with an unclosed ![alt]( in ${name} before a picture, move rewrites the picture's line`, async (t) => {
    const ctx = await setup(t, { [file]: text, "archive/keep.md": "Keep.\n", "away.md": "Away.\n" });
    const page = await openPage(ctx, file);
    assert.ok(await page.clickOffset(text.indexOf("alpha") + 3));
    await page.quiet();
    await pastePicture(page, ctx.hub, file, PNG, "image/png");
    // The page stays on the document, so the file is there for the move to carry.
    const out = await run(ctx.hub, ["move", file, "--dir", "archive"]);
    assert.equal(out.code, 0, out.stderr);
    const moved = `archive/${file}`;
    const [img] = imageLines((await ctx.hub.show(moved)).text);
    assert.ok(img, "no image line after the move");
    assert.equal(img.address, `${moved.replace(/\.md$/, "")}/${img.name}`, "the line does not name the moved directory");
    assert.equal((await getRaw(ctx.hub.port, img.address)).status, 200);
  });
}

// ---- Other markdown viewers ------------------------------------------------------------------

// The destination of an image line as CommonMark reads it, or null if CommonMark does not read
// the line as an image. Either <...> with no line ending and no unescaped < or >, or a bare run
// with no space or control character whose parentheses balance. Backslash escapes are undone.
function commonMarkDestination(line) {
  const m = /^!\[[^\]]*\]\(/.exec(line);
  if (!m) return null;
  let i = m[0].length;
  const unescape = (s) => s.replace(/\\([!-/:-@[-`{-~])/g, "$1");
  if (line[i] === "<") {
    let j = i + 1;
    while (j < line.length && line[j] !== ">") {
      if (line[j] === "\\") j += 1;
      else if (line[j] === "<" || line[j] === "\n") return null;
      j += 1;
    }
    if (line[j] !== ">" || line[j + 1] !== ")") return null;
    return unescape(line.slice(i + 1, j));
  }
  let depth = 0;
  let j = i;
  for (; j < line.length; j += 1) {
    const ch = line[j];
    if (ch === "\\") { j += 1; continue; }
    if (ch.charCodeAt(0) <= 0x20 || ch === "\x7f") return null;
    if (ch === "(") depth += 1;
    if (ch === ")") {
      if (depth === 0) break;
      depth -= 1;
    }
  }
  if (j === i || line[j] !== ")" || j !== line.length - 1) return null;
  return unescape(line.slice(i, j));
}

// The address a viewer requests: characters a URL cannot hold are percent-encoded, and an
// existing %XX is kept, as CommonMark renderers do.
const href = (dest) => dest.replace(/%(?![0-9a-fA-F]{2})|[^A-Za-z0-9\-._~!$&'()*+,;=:@/?#%]/gu, (c) => encodeURIComponent(c));

function getHref(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: `/raw/${REPO}/${path}`, method: "GET", headers: { Connection: "close" } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

for (const file of ["My Notes.md", "Tab\there.md", "Plan (draft).md", "plain.md"]) {
  test(`t37rgtxg: the image line the hub writes in ${JSON.stringify(file)} is one a CommonMark viewer reads as that picture`, async (t) => {
    const ctx = await setup(t, { [file]: "alpha beta\n" });
    const out = await run(ctx.hub, ["attach", file, "--start", "1:0", "--end", "1:5", "--expect", "alpha"], PNG);
    assert.equal(out.code, 0, out.stderr);
    const line = (await ctx.hub.show(file)).text.split("\n").find((l) => l.startsWith("!["));
    assert.ok(line, "no image line");
    const dest = commonMarkDestination(line);
    assert.ok(dest !== null, `CommonMark does not read ${JSON.stringify(line)} as an image`);
    const raw = await getHref(ctx.hub.port, href(dest));
    assert.equal(raw.status, 200, `${JSON.stringify(line)}: a viewer asks for ${href(dest)}, and /raw answers ${raw.status}`);
    assert.ok(raw.body.equals(PNG));
  });
}
