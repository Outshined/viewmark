import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import zlib from "node:zlib";
import { launchBrowser, Page, startHub } from "./harness.js";

// Ticket agrd2gk6: the highlight's add-comment button draws the comment balloon that a picture's
// corner pin draws, with no words, the accessible name Add comment, and a tooltip (p4sbujyz).

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

const TEXT = "Alpha beta gamma delta.\n\n![pic.png](doc/pic.png)\n\nEnd.\n";

async function setup(t) {
  const hub = await startHub();
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await hub.close();
  });
  hub.plant("doc.md", TEXT);
  hub.plant("doc/pic.png", png(300, 160));
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.login();
  await page.open("doc.md");
  await page.quiet();
  // A double-click on beta makes a highlight that can take a comment.
  const p = await page.eval(`window.__qaClickPoint(${TEXT.indexOf("beta") + 2})`);
  await page.click(p.x, p.y, { clickCount: 2 });
  await page.quiet();
  await page.until(() => page.eval(`!!document.querySelector(".md-add-comment")`), "the add-comment button");
  return { hub, page };
}

const svgOf = (sel) => `(() => { const s = document.querySelector(${JSON.stringify(sel)} + " svg"); if (!s) return null; const path = s.querySelector("path"); const at = (n) => (path && path.getAttribute(n)) || s.getAttribute(n); return { viewBox: s.getAttribute("viewBox"), fill: at("fill"), stroke: at("stroke"), width: at("stroke-width"), cap: at("stroke-linecap"), join: at("stroke-linejoin"), hidden: s.getAttribute("aria-hidden"), d: path ? path.getAttribute("d") : null }; })()`;

test("agrd2gk6: the add-comment button draws the comment balloon, the same as a picture's corner pin, as the stroke icon AGENTS.md describes", async (t) => {
  const { page } = await setup(t);
  const button = await page.eval(svgOf(".md-add-comment"));
  assert.ok(button, "the button has no SVG");
  assert.deepEqual({ ...button, d: undefined }, { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", width: "2", cap: "round", join: "round", hidden: "true", d: undefined });
  const img = await page.eval(`(() => { const r = document.querySelector(".md-image img").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: img.x, y: img.y });
  await page.until(() => page.eval(`!!document.querySelector(".md-pin-corner svg")`), "the corner pin");
  const pin = await page.eval(svgOf(".md-pin-corner"));
  assert.equal(button.d, pin.d, "the button's balloon is not the corner pin's");
});

test("agrd2gk6: the add-comment button shows no words, keeps the accessible name Add comment, and has a tooltip of six words or fewer", async (t) => {
  const { page } = await setup(t);
  const b = await page.eval(`(() => { const b = document.querySelector(".md-add-comment"); return { text: b.textContent.trim(), label: b.getAttribute("aria-label"), title: b.getAttribute("title") }; })()`);
  assert.equal(b.text, "");
  assert.equal(b.label, "Add comment");
  assert.ok(b.title && b.title.trim().split(/\s+/).length <= 6, `the tooltip is ${JSON.stringify(b.title)}`);
});

test("agrd2gk6: a click on the balloon still adds a comment on the highlight", async (t) => {
  const { hub, page } = await setup(t);
  const at = await page.eval(`(() => { const r = document.querySelector(".md-add-comment").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.click(at.x, at.y);
  await page.until(() => page.eval(`document.activeElement && document.activeElement.classList.contains("md-comment-body")`), "the note box");
  await page.type("A note.");
  await page.key("Enter", ["Ctrl"]);
  await page.quiet();
  await sleep(300);
  assert.ok((await hub.show("doc.md")).text.startsWith("Alpha {c1}beta{/c1} gamma delta."));
});

// Ticket nzemzu3s: a hidden highlight balloon is display none. Adding a comment from it, deleting
// that comment, or collapsing the highlight leaves the balloon undrawn. A highlight that can take
// a comment still shows the same balloon.
const BALLOON_D = "M12 19l-2-3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3h-3l-2 3z";

const balloonState = `(() => {
  const b = document.querySelector("button.md-add-comment");
  const sel = getSelection();
  const base = {
    collapsed: !sel || sel.isCollapsed,
    selected: sel ? sel.toString() : "",
  };
  if (!b) return { present: false, ...base };
  const s = getComputedStyle(b);
  const rects = [...b.getClientRects()];
  const path = b.querySelector("path");
  return {
    present: true,
    hidden: b.hidden,
    display: s.display,
    rects: rects.length,
    w: rects[0] ? rects[0].width : 0,
    label: b.getAttribute("aria-label"),
    title: b.getAttribute("title"),
    text: (b.textContent || "").trim(),
    d: path ? path.getAttribute("d") : "",
    ...base,
  };
})()`;

function assertDrawn(state, what) {
  assert.equal(state.present, true, `${what}: ${JSON.stringify(state)}`);
  assert.equal(state.hidden, false, `${what}: ${JSON.stringify(state)}`);
  assert.notEqual(state.display, "none", `${what}: ${JSON.stringify(state)}`);
  assert.ok(state.rects > 0 && state.w > 0, `${what}: ${JSON.stringify(state)}`);
  assert.equal(state.label, "Add comment", what);
  assert.equal(state.title, "Add comment", what);
  assert.equal(state.text, "", what);
  assert.equal(state.d, BALLOON_D, what);
}

function assertNotDrawn(state, what) {
  assert.equal(state.present, true, `${what}: ${JSON.stringify(state)}`);
  assert.equal(state.hidden, true, `${what}: ${JSON.stringify(state)}`);
  assert.equal(state.display, "none", `${what}: ${JSON.stringify(state)}`);
  assert.equal(state.rects, 0, `${what}: ${JSON.stringify(state)}`);
}

async function balloonAt(page) {
  return page.eval(`(() => { const b = document.querySelector(".md-add-comment"); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
}

test("nzemzu3s: collapsing the highlight hides the balloon, and a highlight that can take a comment still shows it", async (t) => {
  const { hub, page } = await setup(t);
  assertDrawn(await page.eval(balloonState), "the highlight shows the balloon");
  await page.clickOffset(TEXT.indexOf("Alpha") + 1);
  await page.quiet();
  assertNotDrawn(await page.eval(balloonState), "collapsing the highlight");
  const again = await page.eval(`window.__qaClickPoint(${TEXT.indexOf("beta") + 2})`);
  await page.click(again.x, again.y, { clickCount: 2 });
  await page.quiet();
  await page.until(() => page.eval(`(() => { const b = document.querySelector(".md-add-comment"); return !!b && !b.hidden && b.getClientRects().length > 0; })()`), "the balloon again");
  assertDrawn(await page.eval(balloonState), "the highlight shows the balloon again");
  const at = await balloonAt(page);
  assert.ok(at && at.w > 0 && at.h > 0, "the balloon has no box to click");
  await page.click(at.x, at.y);
  await page.until(() => page.eval(`document.activeElement && document.activeElement.classList.contains("md-comment-body")`), "the note box");
  await page.quiet();
  assertNotDrawn(await page.eval(balloonState), "after adding a comment from the balloon");
  assert.ok((await hub.show("doc.md")).text.startsWith("Alpha {c1}beta{/c1} gamma delta."));
});

test("nzemzu3s: after the comment added from the balloon is deleted, the balloon is not drawn", async (t) => {
  const { hub, page } = await setup(t);
  const at = await balloonAt(page);
  await page.click(at.x, at.y);
  await page.until(() => page.eval(`document.activeElement && document.activeElement.classList.contains("md-comment-body")`), "the note box");
  await page.quiet();
  assertNotDrawn(await page.eval(balloonState), "after adding a comment from the balloon");
  await page.type("A note.");
  await page.key("Enter", ["Ctrl"]);
  await page.quiet();
  const card = await page.eval(`(() => { const c = document.querySelector('.md-comment-card[data-comment="c1"]'); if (!c) return null; const r = c.getBoundingClientRect(); return { x: r.left + 20, y: r.top + 12 }; })()`);
  assert.ok(card, "no card for the comment");
  await page.click(card.x, card.y);
  await page.quiet();
  const button = `.md-comment-card[data-comment="c1"] button[aria-label="Delete"]`;
  await page.until(() => page.eval(`(() => { const b = document.querySelector('${button}'); return !!b && b.getClientRects().length > 0; })()`), "the Delete button");
  const del = await page.eval(`(() => { const r = document.querySelector('${button}').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.click(del.x, del.y);
  await page.quiet();
  assertNotDrawn(await page.eval(balloonState), "after deleting the comment");
  await sleep(300);
  assert.equal((await hub.show("doc.md")).text, TEXT);
});
