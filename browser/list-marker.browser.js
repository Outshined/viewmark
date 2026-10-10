import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "./harness.js";

const DOC = "- alpha\n- beta\n\n1. alpha\n2. beta\n";
const NESTED = "\t1. mid\n\t\t1. aaa\n\t\t2. bbb\n> 1. quote\n> 2. other\n";

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

async function focusCaret(page, offset) {
  assert.equal(await page.clickOffset(offset), true, `click ${offset}`);
  await page.until(async () => {
    const caret = await page.caret();
    return caret && caret.focus === offset;
  }, `caret ${offset}`);
  await page.frame();
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
  await hub.create("lists.md", DOC + NESTED);
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

  const full = DOC + NESTED;
  const aaa = full.indexOf("aaa");
  const bbb = full.indexOf("bbb");
  const quote = full.indexOf("quote");
  const aaaClosed = await glyphLeft(page, aaa);
  await focusCaret(page, aaa);
  const aaaOpen = await glyphLeft(page, aaa);
  near(aaaOpen, aaaClosed, "third-level text stays when opened");
  near(aaaOpen, await glyphLeft(page, bbb), "third-level raw matches closed sibling");
  assert.match(await textIndent(page, aaa), /^-[\d.]+px$/, "third-level marker hangs");
  near(await glyphLeft(page, 2), bulletA, "top-level bullet stays put");
  near(await glyphLeft(page, 19), orderedClosed, "top-level ordered stays put");

  await focusCaret(page, quote);
  assert.equal(await textIndent(page, quote), "", "quoted item does not hang");
});
