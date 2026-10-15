import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { setTimeout as sleep } from "node:timers/promises";
import { launchBrowser, Page, startHub, supports } from "./harness.js";

// Ticket rqeaewqz. h and l land on a character. The block caret covers that
// character, and x deletes it instead of the one beside it.

const FILE = "a.md";
const BODY = "abcdefghij\n\nklmnopqrst\n";
const VIM = "viewmark.vim";

function redSpan(png) {
  let at = 8;
  let width = 0;
  let height = 0;
  let bpp = 4;
  const idat = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString("ascii", at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bpp = data[9] === 6 ? 4 : 3;
    }
    if (type === "IDAT") idat.push(data);
    at += 12 + length;
  }
  if (width === 0 || height === 0 || idat.length === 0) return null;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  let prev = Buffer.alloc(stride);
  let min = width;
  let max = -1;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 255;
    }
    for (let x = 0; x < width; x += 1) {
      const i = x * bpp;
      if (cur[i] > 200 && cur[i + 1] < 60 && cur[i + 2] < 60) {
        if (x < min) min = x;
        if (x > max) max = x;
      }
    }
    prev = cur;
  }
  if (max < min) return null;
  return { min, max, width };
}

function centersIn(glyphs, box) {
  return glyphs.filter((glyph) => {
    const x = (glyph.left + glyph.right) / 2;
    const y = (glyph.top + glyph.bottom) / 2;
    return x >= box.left - 1 && x <= box.right + 1 && y >= box.top - 1 && y <= box.bottom + 1;
  }).map((glyph) => glyph.i);
}

async function probe(page) {
  return page.eval(`(() => {
    const root = document.getElementById("editor");
    const lines = [...root.querySelectorAll(".md-line")];
    let max = 0;
    for (const line of lines) {
      const end = Number(line.dataset.end);
      if (end > max) max = end;
    }
    const glyphs = [];
    for (let i = 0; i <= max; i += 1) {
      const glyph = window.__qaGlyph(i);
      if (!glyph || !(glyph.right > glyph.left) || !(glyph.bottom > glyph.top)) continue;
      glyphs.push({ i, left: glyph.left, right: glyph.right, top: glyph.top, bottom: glyph.bottom });
    }
    const mark = document.querySelector(".md-vim-block-mark");
    const rect = mark ? mark.getBoundingClientRect() : null;
    return {
      glyphs,
      mark: rect && rect.width > 1 && rect.height > 1
        ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
        : null,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    };
  })()`);
}

async function paintOffsets(page, seen) {
  const caret = await page.caret();
  const here = seen.glyphs.find((glyph) => glyph.i === caret.focus);
  if (!here) return [];
  const row = seen.glyphs.filter((glyph) => Math.abs(glyph.top - here.top) < 2);
  const left = Math.min(...row.map((glyph) => glyph.left));
  const right = Math.max(...row.map((glyph) => glyph.right));
  const top = Math.min(...row.map((glyph) => glyph.top));
  const bottom = Math.max(...row.map((glyph) => glyph.bottom));
  const clip = {
    x: Math.max(0, left + seen.scrollX),
    y: Math.max(0, top + seen.scrollY),
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
    scale: 1,
  };
  await page.eval(`(() => {
    if (document.getElementById("qa-caret-color")) return true;
    const style = document.createElement("style");
    style.id = "qa-caret-color";
    style.textContent = "#editor, #editor * { caret-color: rgb(255, 0, 0) !important; }";
    document.head.appendChild(style);
    return true;
  })()`);
  for (let round = 0; round < 10; round += 1) {
    await page.frame();
    const shot = await page.session.send("Page.captureScreenshot", { format: "png", clip });
    const span = redSpan(Buffer.from(shot.data, "base64"));
    if (span && span.max - span.min >= 4) {
      const scale = span.width / clip.width;
      const box = {
        left: clip.x - seen.scrollX + span.min / scale,
        right: clip.x - seen.scrollX + (span.max + 1) / scale,
        top,
        bottom,
      };
      return centersIn(row, box);
    }
    await sleep(60);
  }
  return [];
}

async function blockOffsets(page) {
  const seen = await probe(page);
  if (seen.mark) return centersIn(seen.glyphs, seen.mark);
  if (!supports("paint")) return [];
  return paintOffsets(page, seen);
}

async function stop(page, key, offset) {
  if (key) {
    await page.key(key);
    await page.quiet();
  }
  const caret = await page.caret();
  const covered = await blockOffsets(page);
  const where = key ? `after ${key}` : "at the click";
  assert.equal(caret.focus, offset, `${where}: caret ${caret.focus}`);
  assert.equal(caret.anchor, offset, `${where}: anchor ${caret.anchor}`);
  assert.deepEqual(covered, [offset], `${where}: block covers ${JSON.stringify(covered)}, wanted ${offset} (${BODY[offset]})`);
  assert.equal(await page.eval(`document.querySelector(".md-vim-status").textContent`), "N", where);
}

test("x deletes the character under the block caret (ticket rqeaewqz)", async (t) => {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  await hub.create(FILE, BODY);
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.session.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `localStorage.setItem(${JSON.stringify(VIM)}, "1");`,
  });
  await page.login();
  await page.open(FILE);
  assert.equal(await page.eval(`localStorage.getItem(${JSON.stringify(VIM)})`), "1");
  assert.ok(await page.clickOffset(0), "no glyph on the first character");
  await page.quiet();

  await stop(page, "", 0);
  await stop(page, "l", 1);
  await stop(page, "l", 2);
  await stop(page, "l", 3);
  await stop(page, "j", 15);
  await stop(page, "l", 16);
  await stop(page, "h", 15);
  await stop(page, "k", 3);
  await stop(page, "l", 4);
  await stop(page, "h", 3);

  const before = await hub.show(FILE);
  assert.equal(before.text, BODY);
  const caret = await page.caret();
  assert.equal(caret.focus, 3);
  assert.equal(before.text[caret.focus], "d");
  assert.equal(before.text[caret.focus - 1], "c");
  await page.key("x");
  await page.quiet();
  const after = await hub.show(FILE);
  assert.equal(after.text, "abcefghij\n\nklmnopqrst\n");
  assert.equal(after.rev, before.rev + 1);
  const now = await page.caret();
  assert.equal(now.focus, 3, "x jumped off the deleted character");
  assert.equal(now.anchor, 3);
  assert.equal(after.text[now.focus], "e");
  assert.equal(after.text[now.focus - 1], "c", "x deleted the character left of the block");
  const covered = await blockOffsets(page);
  assert.deepEqual(covered, [3], `after x the block covers ${JSON.stringify(covered)}`);
});
