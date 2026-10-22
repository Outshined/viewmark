import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import zlib from "node:zlib";
import { REPO, USER, cli, onPath, Page, startHub } from "./harness.js";
import { launchFirefox } from "./firefox.js";

// Ticket hup4797q: a picture copied in Firefox with Copy Image and pasted into a ticket was drawn,
// and then gone after a forced reload. These tests copy the picture the way a person does, with
// Firefox's own context menu, and paste it with Ctrl+V. Firefox is the only browser these tests
// drive, and Copy Image is Firefox's menu item. They need a clipboard that holds pictures: cage,
// or VIEWMARK_HEADED=1.

const FIREFOX = process.env.VIEWMARK_FIREFOX || "firefox";
const ready = onPath(FIREFOX) && (onPath(process.env.VIEWMARK_CAGE || "cage") || process.env.VIEWMARK_HEADED === "1");
const skip = ready ? false : "needs firefox, and cage or VIEWMARK_HEADED=1";

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, "ascii"), data])) >>> 0, 8 + data.length);
  return out;
}

// A 640 by 480 RGB picture with bands of color and a noisy strip, so the copy is not trivial.
function picture() {
  const width = 640;
  const height = 480;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = [];
  let seed = 7;
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const noisy = y > 200 && y < 280;
      row[1 + x * 3] = noisy ? seed & 255 : (x * 255) / width;
      row[2 + x * 3] = noisy ? (seed >> 8) & 255 : (y * 255) / height;
      row[3 + x * 3] = Math.floor(x / 40) % 2 ? 200 : 40;
    }
    rows.push(row);
  }
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([head, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

async function rawStatus(port, address) {
  const response = await fetch(`http://127.0.0.1:${port}/raw/${REPO}/${address}`);
  return { status: response.status, size: (await response.arrayBuffer()).byteLength };
}

async function bytes(hub, rel) {
  const out = await cli(hub.port, ["--user", USER, "--repo", REPO, "show", rel]);
  assert.equal(out.code, 0, out.stderr);
  return out.stdout;
}

const drawn = (page) => page.eval(`[...document.querySelectorAll("#editor img")].map((img) => ({ src: img.getAttribute("src"), width: img.naturalWidth }))`);

// The hub, Firefox, a logged-in page, and the picture copied with Copy Image from its own tab.
async function setup(t) {
  const hub = await startHub();
  const dir = mkdtempSync(path.join(tmpdir(), "viewmark-qa-picture-"));
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const file = path.join(dir, "picture.png");
  writeFileSync(file, picture());
  browser = await launchFirefox();
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.login();
  const tab = await browser.newSession();
  await tab.session.send("Page.navigate", { url: `file://${file}` });
  await browser.activate(tab.targetId);
  const box = await tab.session.send("Runtime.evaluate", { expression: `(() => { const img = document.images[0]; const r = img.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: img.naturalWidth }; })()` });
  assert.equal(box.result.value.width, 640, "the picture did not load in its tab");
  await browser.contextMenu(tab.session, box.result.value.x, box.result.value.y, "context-copyimage-contents");
  await browser.activate(browser.targetId);
  return { hub, browser, page };
}

// Pastes with Ctrl+V and waits for the image line in the bytes.
async function paste(page, hub, rel) {
  const before = await bytes(hub, rel);
  await page.key("v", ["Ctrl"]);
  let after = before;
  for (let i = 0; i < 50 && after === before; i += 1) {
    await sleep(100);
    after = await bytes(hub, rel);
  }
  const line = /!\[[^\]]*\]\(([^)\s]+)\)/.exec(after);
  assert.ok(line, `no image line after the paste into ${rel}: ${JSON.stringify(after)}`);
  await page.quiet();
  return { text: after, address: line[1] };
}

// The file is served, it survives a forced reload and is drawn after it, and it is still there
// once the page has left the document and the hub has swept the pictures no line names.
async function survives(page, hub, rel, address, reopen) {
  const first = await rawStatus(hub.port, address);
  assert.equal(first.status, 200, `/raw ${address} right after the paste`);
  assert.ok(first.size > 0);
  await page.session.send("Page.reload", { ignoreCache: true });
  await reopen();
  assert.ok((await bytes(hub, rel)).includes(address), `the image line left ${rel} on the reload`);
  await page.until(async () => (await drawn(page)).some((img) => img.src.endsWith(address) && img.width === 640), `the picture drawn after the reload of ${rel}`, 5000);
  assert.deepEqual(await rawStatus(hub.port, address), first, `/raw ${address} after the reload`);
  await page.session.send("Page.navigate", { url: "about:blank" });
  await sleep(1500);
  assert.deepEqual(await rawStatus(hub.port, address), first, `/raw ${address} after the page left ${rel}`);
}

test("Copy Image, then a paste at the top of a document: stored, and kept through a forced reload and the page leaving", { skip }, async (t) => {
  const { hub, page } = await setup(t);
  await hub.create("top.md", "alpha beta\n\ngamma delta\n");
  await page.open("top.md");
  assert.ok(await page.clickOffset(0));
  await page.quiet();
  await page.key("Home", ["Ctrl"]);
  await page.quiet();
  const { text, address } = await paste(page, hub, "top.md");
  assert.match(text, /^alpha beta\n\n!\[/, "the picture is not after the first paragraph (R91)");
  await survives(page, hub, "top.md", address, () => page.open("top.md"));
});

test("Copy Image, then a paste at the bottom of a document, after its last word: stored and kept", { skip }, async (t) => {
  const { hub, page } = await setup(t);
  for (const [rel, body] of [["end.md", "alpha beta\n\ngamma delta\n"], ["bare.md", "alpha beta\n\ngamma delta"]]) {
    await hub.create(rel, body);
    await page.open(rel);
    assert.ok(await page.clickOffset("alpha beta\n\ngamma delta".length));
    await page.quiet();
    const { text, address } = await paste(page, hub, rel);
    assert.match(text, /gamma delta\n\n!\[[^\]]*\]\([^)]+\)\n$/, `${rel}: the picture is not the last line`);
    await survives(page, hub, rel, address, () => page.open(rel));
  }
});

test("Copy Image, then a paste into a ticket's text: stored and kept", { skip }, async (t) => {
  const { hub, page } = await setup(t);
  const made = await cli(hub.port, ["--user", USER, "--repo", REPO, "ticket", "create", "--title", "Shot"], "Pasting an image.");
  assert.equal(made.code, 0, made.stderr);
  const id = made.stdout.trim().split("\n")[0];
  const rel = `tickets/${id}.md`;
  const reopen = async () => {
    page.loads = (page.loads || 0) + 1;
    await page.session.send("Page.navigate", { url: `http://127.0.0.1:${page.port}/?load=${page.loads}#${REPO}/ticket/${encodeURIComponent(id)}` });
    await page.until(() => page.eval(`[...document.querySelectorAll("#editor .md-line")].some((line) => line.textContent.includes("Pasting"))`), "the ticket's text");
    await page.quiet();
  };
  await reopen();
  assert.ok(await page.clickOffset("Pasting an image.".length));
  await page.quiet();
  const { address } = await paste(page, hub, rel);
  assert.ok(address.startsWith(`tickets/${id}/`), `the picture is not in the ticket's directory: ${address}`);
  await survives(page, hub, rel, address, reopen);
});
