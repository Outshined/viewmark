import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "./harness.js";

// Ticket 7ntztqb4. The block in character visual covers the last glyph of the
// selection. Delete and comment take that glyph and leave the one after it.

const TEXT = "one two three\n";
const VIM = "viewmark.vim";

async function setup(t) {
  const hub = await startHub();
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await hub.close();
  });
  const file = await hub.create("a.md", TEXT);
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.session.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `localStorage.setItem(${JSON.stringify(VIM)}, "1");`,
  });
  await page.login();
  await page.open(file);
  assert.ok(await page.clickOffset(0), "no glyph on the first character");
  await page.quiet();
  await page.key("Escape");
  await page.quiet();
  assert.equal((await page.caret()).focus, 0);
  return { hub, page, file };
}

async function blockGlyphs(page) {
  return page.eval(`(() => {
    const mark = document.querySelector(".md-vim-block-mark");
    if (!mark) return [];
    const rect = mark.getBoundingClientRect();
    if (!(rect.width > 1) || !(rect.height > 1)) return [];
    const root = document.getElementById("editor");
    let max = 0;
    for (const line of root.querySelectorAll(".md-line")) {
      const end = Number(line.dataset.end);
      if (end > max) max = end;
    }
    const hit = [];
    for (let i = 0; i <= max; i += 1) {
      const glyph = window.__qaGlyph(i);
      if (!glyph || !(glyph.right > glyph.left) || !(glyph.bottom > glyph.top)) continue;
      const x = (glyph.left + glyph.right) / 2;
      const y = (glyph.top + glyph.bottom) / 2;
      if (x >= rect.left - 1 && x <= rect.right + 1 && y >= rect.top - 1 && y <= rect.bottom + 1) hit.push(i);
    }
    return hit;
  })()`);
}

async function press(page, keys) {
  for (const key of keys) {
    await page.key(key);
    await page.quiet();
  }
}

async function twoWords(page, keys) {
  await press(page, keys);
  const caret = await page.caret();
  const lo = Math.min(caret.anchor, caret.focus);
  const hi = Math.max(caret.anchor, caret.focus);
  assert.equal(lo, 0, `anchor ${caret.anchor}`);
  assert.equal(hi, "one two".length, `focus ${caret.focus}`);
  const covered = await blockGlyphs(page);
  assert.deepEqual(covered, [6], `block covers ${JSON.stringify(covered)}`);
  assert.ok(covered[0] >= lo && covered[0] < hi);
  assert.equal(TEXT[covered[0]], "o");
}

test("7ntztqb4: vee puts the block on the last letter, and d includes it", { timeout: 180000 }, async (t) => {
  const { hub, page, file } = await setup(t);
  await twoWords(page, ["v", "e", "e"]);
  await press(page, ["d"]);
  assert.equal((await hub.show(file)).text, " three\n");
});

test("7ntztqb4: vee puts the block on the last letter, and gc includes it", { timeout: 180000 }, async (t) => {
  const { hub, page, file } = await setup(t);
  await twoWords(page, ["v", "e", "e"]);
  await press(page, ["g", "c"]);
  assert.equal((await hub.show(file)).text, "{c1}one two{/c1} three\n\n```comment c1\n\n```\n");
});

test("7ntztqb4: l puts the block on the last letter, and d includes it", { timeout: 180000 }, async (t) => {
  const { hub, page, file } = await setup(t);
  await twoWords(page, ["v", "l", "l", "l", "l", "l", "l"]);
  await press(page, ["d"]);
  assert.equal((await hub.show(file)).text, " three\n");
});
