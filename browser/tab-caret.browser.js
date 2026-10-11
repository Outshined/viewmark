import assert from "node:assert/strict";
import { test } from "node:test";
import zlib from "node:zlib";
import { launchBrowser, Page, startHub, startProxy, supports } from "./harness.js";

const DOC = "one\n\n\t\n\ntwo\n";

function redCaret(png) {
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
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i += 1) {
      const left = i >= bpp ? cur[i - bpp] : 0;
      const up = prev[i];
      const upLeft = i >= bpp ? prev[i - bpp] : 0;
      let value = line[i];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const guess = left + up - upLeft;
        const da = Math.abs(guess - left);
        const db = Math.abs(guess - up);
        const dc = Math.abs(guess - upLeft);
        value += da <= db && da <= dc ? left : db <= dc ? up : upLeft;
      }
      cur[i] = value & 255;
    }
    for (let x = 0; x < width; x += 1) {
      const i = x * bpp;
      if (cur[i] > 200 && cur[i + 1] < 80 && cur[i + 2] < 80) return { x, y };
    }
    prev = cur;
  }
  return null;
}

async function paintedCaret(page, newline) {
  await page.ensureRedCaret();
  const box = await page.eval(`(() => {
    const el = [...document.querySelectorAll(".md-break")].find((node) => Number(node.dataset.start) === ${newline});
    const line = el && el.closest(".md-line");
    if (!line) return null;
    const rect = line.getBoundingClientRect();
    return { top: rect.top, height: rect.height, scrollX: window.scrollX, scrollY: window.scrollY };
  })()`);
  assert.ok(box, "the tab line is not drawn");
  const clipY = Math.max(0, box.top + box.scrollY - 2);
  const clipH = box.height + 40;
  for (let round = 0; round < 12; round += 1) {
    const shot = await page.session.send("Page.captureScreenshot", {
      format: "png",
      clip: { x: 0, y: clipY, width: 800, height: clipH, scale: 1 },
    });
    const point = redCaret(Buffer.from(shot.data, "base64"));
    if (point != null) return { x: point.x - box.scrollX, y: clipY + point.y - box.scrollY };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("the caret is not painted");
}

test("a tab on a blank line draws the caret on the letter's line", { skip: supports("paint") ? false : "Firefox screenshots leave out the caret" }, async () => {
  let hub = null;
  let proxy = null;
  let browser = null;
  try {
    hub = await startHub();
    proxy = await startProxy(hub.port);
    browser = await launchBrowser();
    const page = new Page(browser.session, proxy.port);
    await page.init();
    await page.login();
    await hub.create("tab-caret.md", DOC);
    await page.open("tab-caret.md");
    const newline = DOC.indexOf("\t") + 1;
    assert.equal(DOC[newline], "\n");
    assert.equal(await page.clickOffset(newline), true);
    await page.quiet();
    assert.equal((await hub.show("tab-caret.md")).text, DOC);
    const caret = await page.caret();
    assert.equal(caret.focus, newline);
    const caretAt = await paintedCaret(page, newline);
    await page.type("Q");
    await page.quiet();
    assert.equal((await hub.show("tab-caret.md")).text, "one\n\n\tQ\n\ntwo\n");
    const glyph = await page.eval(`window.__qaGlyph(${newline})`);
    assert.ok(glyph, "typed Q has no glyph");
    assert.ok(Math.abs(glyph.top - caretAt.y) <= 1, `caret y ${caretAt.y}, Q y ${glyph.top}`);
    assert.ok(Math.abs(glyph.left - caretAt.x) <= 1, `caret x ${caretAt.x}, Q x ${glyph.left}`);
  } finally {
    if (browser) await browser.close();
    if (proxy) await proxy.close();
    if (hub) await hub.close();
  }
});

test("a click on a line of only a space rests at its start", async () => {
  const doc = "one\n\n \n\ntwo\n";
  let hub = null;
  let proxy = null;
  let browser = null;
  try {
    hub = await startHub();
    proxy = await startProxy(hub.port);
    browser = await launchBrowser();
    const page = new Page(browser.session, proxy.port);
    await page.init();
    await page.login();
    await hub.create("space-caret.md", doc);
    await page.open("space-caret.md");
    const point = await page.eval(`(() => {
      const line = [...document.querySelectorAll(".md-line")].find((node) => node.dataset.start === "5" && node.dataset.end === "5");
      if (!line) return null;
      const rect = line.getBoundingClientRect();
      return { x: rect.left + 4, y: (rect.top + rect.bottom) / 2, far: rect.left + 40 };
    })()`);
    assert.ok(point, "the space line is not drawn");
    await page.click(point.x, point.y);
    await page.quiet();
    assert.equal((await hub.show("space-caret.md")).text, doc);
    const caret = await page.caret();
    assert.equal(caret.focus, 5);
    assert.equal(caret.anchor, 5);
    await page.click(point.far, point.y);
    await page.quiet();
    const again = await page.caret();
    assert.equal(again.focus, 5);
    assert.equal(again.anchor, 5);
  } finally {
    if (browser) await browser.close();
    if (proxy) await proxy.close();
    if (hub) await hub.close();
  }
});
