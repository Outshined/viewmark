import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import zlib from "node:zlib";
import { launchBrowser, Page, startHub } from "./harness.js";

// Ticket 77fvpzwf: the cards of comments pinned to a picture sat away from the picture, and a
// click on a pin scrolled the page to the top. The owner decided that a card sits at the same
// distance from the top of the document as its anchor, and that a pinned comment's card shows the
// pin's glyph before the author's name. The pins here are far enough apart that no cards overlap.

// A solid picture of w by h, big enough to cover several lines of text.
function png(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head[8] = 8;
  head[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x60)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const note = (id, token, text) => `\`\`\`comment ${id}${token ? ` ${token}` : ""}\n:: 0\n@2026-10-16T22:00:00.000Z qa\n${text}\n\`\`\`\n`;
const PARAS = Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 2} of the text above the picture.`).join("\n\n");
const TEXT = `{c4}Paragraph{/c4} 1 has a prose comment.\n\n${PARAS}\n\n![big.png](doc/big.png)\n${note("c1", "0.5,0.1", "Pin one.")}${note("c2", "0.5,0.5", "Pin two.")}${note("c3", "0.5,0.9", "Pin three.")}\nAfter the picture.\n\n${note("c4", "", "On prose.")}`;

async function setup(t) {
  const hub = await startHub();
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await hub.close();
  });
  hub.plant("doc.md", TEXT);
  hub.plant("doc/big.png", png(400, 600));
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.login();
  await page.open("doc.md");
  await page.until(() => page.eval(`document.querySelectorAll(".md-comment-pin").length === 3 && document.querySelectorAll(".md-comment-card").length === 4`), "the pins and the cards");
  await page.quiet();
  await sleep(300);
  return page;
}

// Pin tips and card tops, from the top of the document.
const layout = (page) => page.eval(`(() => {
  const out = { y: scrollY, pins: {}, cards: {} };
  for (const p of document.querySelectorAll(".md-comment-pin")) { const r = p.getBoundingClientRect(); out.pins[p.dataset.comment] = r.bottom + scrollY; }
  for (const c of document.querySelectorAll(".md-comment-card")) { const id = (/^\\((c\\d+)\\)/.exec(c.textContent) || [])[1]; const r = c.getBoundingClientRect(); if (id) out.cards[id] = r.top + scrollY; }
  return out;
})()`);

function beside(l) {
  for (const id of ["c1", "c2", "c3"]) {
    assert.ok(Math.abs(l.cards[id] - l.pins[id]) <= 4, `${id}'s card is at ${Math.round(l.cards[id])}, its pin's tip at ${Math.round(l.pins[id])}`);
  }
}

test("77fvpzwf: each pinned comment's card has its top at its pin's tip, from the top of the document", async (t) => {
  const page = await setup(t);
  beside(await layout(page));
});

test("77fvpzwf: with the page scrolled to the picture, a click on a pin opens its thread and does not scroll", async (t) => {
  const page = await setup(t);
  const before = await layout(page);
  await page.eval(`window.scrollTo(0, ${Math.round(before.pins.c2 - 500)}); true`);
  await sleep(300);
  const y = await page.eval("scrollY");
  const pin = await page.eval(`(() => { const r = document.querySelector(".md-comment-pin[data-comment='c2']").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.click(pin.x, pin.y);
  await page.quiet();
  await sleep(400);
  const after = await layout(page);
  assert.ok(Math.abs(after.y - y) <= 2, `the page scrolled from ${Math.round(y)} to ${Math.round(after.y)}`);
  const current = await page.eval(`(() => { const c = document.querySelector(".md-comment-card.md-comment-current"); return c ? c.textContent.slice(0, 4) : null; })()`);
  assert.equal(current, "(c2)");
  beside(after);
});

test("77fvpzwf: scrolling the page moves each card with its pin", async (t) => {
  const page = await setup(t);
  const view = () => page.eval(`(() => { const o = {}; for (const id of ["c1", "c2", "c3"]) { const p = document.querySelector(".md-comment-pin[data-comment='" + id + "']").getBoundingClientRect(); const c = [...document.querySelectorAll(".md-comment-card")].find((x) => x.textContent.startsWith("(" + id + ")")).getBoundingClientRect(); o[id] = c.top - p.bottom; } return o; })()`);
  const before = await view();
  await page.eval("window.scrollBy(0, 300); true");
  await sleep(300);
  const after = await view();
  for (const id of ["c1", "c2", "c3"]) assert.ok(Math.abs(after[id] - before[id]) <= 2, `${id}: the card moved ${Math.round(after[id] - before[id])} px against its pin`);
});

test("77fvpzwf: a pinned comment's card shows the pin glyph before the author's name, and a prose comment's card does not", async (t) => {
  const page = await setup(t);
  const marks = await page.eval(`(() => {
    const out = {};
    for (const c of document.querySelectorAll(".md-comment-card")) {
      const id = (/^\\((c\\d+)\\)/.exec(c.textContent) || [])[1];
      const mark = c.querySelector("svg.md-comment-pin-mark, .md-comment-pin-mark");
      const line = mark ? mark.parentElement : null;
      out[id] = { mark: !!mark, first: !!line && line.firstElementChild === mark, author: line ? line.textContent.trim() : null };
    }
    return out;
  })()`);
  for (const id of ["c1", "c2", "c3"]) {
    assert.ok(marks[id] && marks[id].mark, `${id}'s card has no pin glyph`);
    assert.ok(marks[id].first && marks[id].author.startsWith("qa"), `${id}'s pin glyph is not before the author's name: ${JSON.stringify(marks[id])}`);
  }
  assert.ok(marks.c4 && !marks.c4.mark, "the prose comment's card has a pin glyph");
});
