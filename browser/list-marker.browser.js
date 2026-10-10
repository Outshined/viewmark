import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "./harness.js";

const DOC = "- alpha\n- beta\n\n1. alpha\n2. beta\n";
const NESTED = "\t1. mid\n\t\t1. aaa\n\t\t2. bbb\n> 1. quote\n> 2. other\n";
const WIDE = "1. one\n2. two\n\n10. ten\n11. eleven\n\n100. hundred\n101. more\n";

function near(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 1, `${label}: ${actual} vs ${expected}`);
}

async function glyphLeft(page, offset) {
  const left = await page.eval(`(() => {
    const glyph = window.__qaGlyph(${offset});
    return glyph && glyph.left;
  })()`);
  assert.equal(typeof left, "number", `glyph ${offset} left`);
  return left;
}

async function textIndent(page, offset) {
  return page.eval(`(() => {
    const hit = window.__qaTextAt(${offset});
    const line = hit && hit.node.parentElement && hit.node.parentElement.closest(".md-line");
    return line ? line.style.textIndent : null;
  })()`);
}

async function hangMargin(page, offset) {
  return page.eval(`(() => {
    const hit = window.__qaTextAt(${offset});
    const line = hit && hit.node.parentElement && hit.node.parentElement.closest(".md-line");
    const hang = line && line.querySelector(".md-raw-hang");
    return hang ? hang.style.marginLeft : "";
  })()`);
}

// The caret has to sit on the drawn glyph at that offset. A letter typed there
// has to land on that same x, including when the line stops being a list.
async function assertCaretOn(page, offset) {
  await focusCaret(page, offset);
  const caret = await page.caret();
  const glyph = await page.eval(`window.__qaGlyph(${offset})`);
  assert.ok(caret && caret.rect && caret.fallback !== true, `caret rect ${offset}`);
  assert.ok(glyph, `glyph ${offset}`);
  near(caret.rect.x, glyph.left, `caret x at ${offset}`);
  const middle = (caret.rect.top + caret.rect.bottom) / 2;
  assert.ok(middle >= glyph.top - 1 && middle <= glyph.bottom + 1, `caret y at ${offset}: ${middle}`);
}

async function assertTypedAtCaret(page, offset) {
  await assertCaretOn(page, offset);
  const before = await page.caret();
  await page.type("Q");
  await page.quiet();
  near(await glyphLeft(page, offset), before.rect.x, `typed Q at ${offset}`);
  await page.key("Backspace");
  await page.quiet();
  await page.until(async () => {
    const caret = await page.caret();
    return caret && caret.focus === offset;
  }, `restored ${offset}`);
}

// The item offset of an empty marker has no glyph. The caret there is where
// the next letter is drawn, in both axes, not the marker's right edge.
async function assertEmptyItemCaret(page, marker) {
  const offset = marker.length;
  await focusCaret(page, 0);
  assert.match(await textIndent(page, 0), /^-[\d.]+px$/, `hang indent for ${JSON.stringify(marker)}`);
  assert.equal(await hangMargin(page, 0), "", `hang margin for ${JSON.stringify(marker)}`);
  for (let at = 0; at < offset; at += 1) await assertCaretOn(page, at);
  await page.key("→");
  await page.until(async () => {
    const caret = await page.caret();
    return caret && caret.focus === offset;
  }, `item caret ${offset}`);
  await page.frame();
  const before = await page.caret();
  assert.ok(before && before.rect && before.fallback !== true, `caret rect ${offset}`);
  assert.equal(await page.eval(`window.__qaGlyph(${offset})`), null, `glyph at empty item ${offset}`);
  await page.type("Q");
  await page.quiet();
  const glyph = await page.eval(`window.__qaGlyph(${offset})`);
  assert.ok(glyph, `typed Q at ${offset}`);
  near(before.rect.x, glyph.left, `empty caret x at ${offset}`);
  near(before.rect.top, glyph.top, `empty caret y at ${offset}`);
  await page.key("Backspace");
  await page.quiet();
  await page.until(async () => {
    const caret = await page.caret();
    return caret && caret.focus === offset;
  }, `restored empty ${offset}`);
  await page.key("←");
  await page.until(async () => {
    const caret = await page.caret();
    return caret && caret.focus === offset - 1;
  }, `left from empty item ${offset}`);
  await assertCaretOn(page, offset - 1);
}

async function focusCaret(page, offset) {
  assert.equal(await page.clickOffset(offset), true, `click ${offset}`);
  await page.until(async () => {
    const caret = await page.caret();
    return caret && caret.focus === offset;
  }, `caret ${offset}`);
  await page.frame();
}

// A wide marker used to paint across the item text. Its right edge stays at or
// before that text, and the text stays on the closed sibling's column.
async function assertMarkerFits(page, textOffset, closedOffset, snug) {
  await focusCaret(page, textOffset);
  const edges = await page.eval(`(() => {
    const hit = window.__qaTextAt(${textOffset});
    const line = hit && hit.node.parentElement && hit.node.parentElement.closest(".md-line");
    const hang = line && line.querySelector(".md-raw-hang");
    const rect = hang && hang.getBoundingClientRect();
    const glyph = window.__qaGlyph(${textOffset});
    return rect && glyph && { markerRight: rect.right, textLeft: glyph.left };
  })()`);
  assert.ok(edges, `marker edges at ${textOffset}`);
  assert.ok(edges.markerRight <= edges.textLeft + 1, `overlap at ${textOffset}: marker ${edges.markerRight} text ${edges.textLeft}`);
  if (snug) near(edges.markerRight, edges.textLeft, `wide marker meets text at ${textOffset}`);
  else assert.ok(edges.textLeft - edges.markerRight > 1, `narrow marker keeps a gap at ${textOffset}: ${edges.textLeft - edges.markerRight}`);
  near(await glyphLeft(page, textOffset), await glyphLeft(page, closedOffset), `text ${textOffset} matches closed ${closedOffset}`);
}

// The line under the caret is raw. Its sibling stays closed, so that sibling's
// glyph is the gutter the raw marker has to match.
async function hungPair(page, caret, openOffset, closedOffset) {
  await focusCaret(page, caret);
  const open = await glyphLeft(page, openOffset);
  const closed = await glyphLeft(page, closedOffset);
  near(open, closed, `glyphs ${openOffset} and ${closedOffset} at caret ${caret}`);
  return closed;
}

test("a raw list marker hangs in the bullet gutter", async (t) => {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  await hub.create("lists.md", DOC + NESTED + WIDE);
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.login();
  await page.open("lists.md");

  const bulletClosed = await hungPair(page, 3, 2, 10);
  const marker = await glyphLeft(page, 0);
  const bulletA = await glyphLeft(page, 2);
  assert.ok(marker < bulletA, `marker ${marker} vs text ${bulletA}`);
  near(bulletA, bulletClosed, "bullet text vs closed");
  const bulletAgain = await hungPair(page, 11, 10, 2);
  near(bulletAgain, bulletClosed, "closed bullet after the other caret");
  const bulletRaw = await glyphLeft(page, 10);
  near(bulletRaw, bulletClosed, "raw bullet after the other caret");

  const orderedClosed = await hungPair(page, 20, 19, 28);
  const orderedAgain = await hungPair(page, 29, 28, 19);
  near(orderedAgain, orderedClosed, "closed ordered after the other caret");
  const orderedRaw = await glyphLeft(page, 28);
  near(orderedRaw, orderedClosed, "raw ordered after the other caret");

  const full = DOC + NESTED + WIDE;
  const aaa = full.indexOf("aaa");
  const bbb = full.indexOf("bbb");
  const quote = full.indexOf("quote");
  const aaaClosed = await glyphLeft(page, aaa);
  await focusCaret(page, aaa);
  const aaaOpen = await glyphLeft(page, aaa);
  near(aaaOpen, aaaClosed, "third-level text stays when opened");
  near(aaaOpen, await glyphLeft(page, bbb), "third-level raw matches closed sibling");
  assert.match(await textIndent(page, aaa), /^-[\d.]+px$/, "third-level marker hangs");
  assert.equal(await hangMargin(page, aaa), "", "third-level marker has no margin pull");
  near(await glyphLeft(page, 2), bulletA, "top-level bullet stays put");
  near(await glyphLeft(page, 19), orderedClosed, "top-level ordered stays put");

  // A closed item hides the marker, so the line is opened on its text first.
  // The caret there is the marker's end, and a click on the line start stays.
  await focusCaret(page, 2);
  for (const at of [0, 1, 2]) await assertCaretOn(page, at);
  await assertTypedAtCaret(page, 0);
  await assertTypedAtCaret(page, 1);
  await assertTypedAtCaret(page, 2);

  const orderedAt = full.indexOf("1. alpha");
  await focusCaret(page, orderedAt + 3);
  for (const at of [0, 1, 2, 3]) await assertCaretOn(page, orderedAt + at);
  await assertTypedAtCaret(page, orderedAt + 3);

  const nestedMarker = "\t\t1. ";
  assert.equal(full.slice(aaa - nestedMarker.length, aaa), nestedMarker);
  await focusCaret(page, aaa);
  for (let at = aaa - nestedMarker.length; at <= aaa; at += 1) await assertCaretOn(page, at);

  await focusCaret(page, quote);
  assert.equal(await textIndent(page, quote), "", "quoted item does not hang");
  assert.equal(await hangMargin(page, quote), "", "quoted item has no hang");
  await assertCaretOn(page, quote);

  // A marker wider than the gutter hangs left until its right edge meets the item text.
  await assertMarkerFits(page, full.indexOf("one"), full.indexOf("two"), false);
  await assertMarkerFits(page, full.indexOf("ten"), full.indexOf("eleven"), true);
  const hundred = full.indexOf("hundred");
  await assertMarkerFits(page, hundred, full.indexOf("more"), true);
  const hundredMarker = "100. ";
  assert.equal(full.slice(hundred - hundredMarker.length, hundred), hundredMarker);
  await focusCaret(page, hundred);
  for (let at = hundred - hundredMarker.length; at <= hundred; at += 1) await assertCaretOn(page, at);
  await assertTypedAtCaret(page, hundred);

  // Enter at the source start of an item leaves the caret before its marker.
  await focusCaret(page, 2);
  await page.key("←");
  await page.key("←");
  await page.until(async () => {
    const caret = await page.caret();
    return caret && caret.focus === 0;
  }, "arrow to the marker start");
  await page.key("Enter");
  await page.quiet();
  await page.until(async () => {
    const caret = await page.caret();
    return caret && caret.focus === 1;
  }, "enter before the item");
  await assertCaretOn(page, 1);
  await assertTypedAtCaret(page, 1);
  await focusCaret(page, 3);
  await page.key("←");
  await page.until(async () => {
    const caret = await page.caret();
    return caret && caret.focus === 2;
  }, "arrow between - and the space");
  const between = await page.caret();
  const betweenBoundary = await page.boundary(2);
  near(between.rect.x, betweenBoundary.x, "caret between - and the space");
  await assertTypedAtCaret(page, 2);
  await page.key("←");
  await page.until(async () => {
    const caret = await page.caret();
    return caret && caret.focus === 1;
  }, "arrow before the marker");
  const before = await page.caret();
  const beforeBoundary = await page.boundary(1);
  near(before.rect.x, beforeBoundary.x, "caret before the marker after ←");
});

test("an empty item caret sits where the next letter is drawn", async (t) => {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  await hub.create("empty-bullet.md", "- \n");
  await hub.create("empty-nested.md", "\t\t1. \n");
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.login();

  await page.open("empty-bullet.md");
  await assertEmptyItemCaret(page, "- ");

  await page.open("empty-nested.md");
  await assertEmptyItemCaret(page, "\t\t1. ");
});
