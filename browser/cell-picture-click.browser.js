import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "./harness.js";

// Ticket 6bqczuz7. A click in the center of a picture inside a table cell opens
// the table with the caret in that picture's syntax, not on the !. A click on
// a standalone picture still selects that line and leaves the picture drawn.

const SYNTAX = "![kennel](box.svg)";
const SOLO = "![box](box.svg)\n";
const TEXT = `Lead.\n\n| pic |\n| --- |\n| ${SYNTAX} |\n\nTail.\n\n${SOLO}`;
const VIM = "viewmark.vim";

async function setup(t) {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  const file = await hub.create("cell.md", TEXT);
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.eval(`localStorage.removeItem(${JSON.stringify(VIM)})`);
  await page.login();
  await page.open(file);
  return { page };
}

function pictureBox(page, where) {
  return page.eval(`(() => {
    const imgs = [...document.querySelectorAll("#editor .md-image img")].filter((img) => ${where});
    const img = imgs[0];
    if (!img || !img.complete || !(img.naturalWidth > 0)) return null;
    const box = img.getBoundingClientRect();
    if (!(box.width > 20) || !(box.height > 10)) return null;
    return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2, left: box.left, right: box.right };
  })()`);
}

test("6bqczuz7: a click in the center of a cell picture opens the table on that picture", { timeout: 180000 }, async (t) => {
  const { page } = await setup(t);
  const start = TEXT.indexOf(SYNTAX);
  const solo = TEXT.indexOf(SOLO);
  assert.equal(TEXT[start], "!");
  assert.ok(solo > start + SYNTAX.length);
  assert.equal(await page.eval(`document.querySelector("#editor").classList.contains("md-vim-block")`), false);

  let standalone = null;
  await page.until(async () => {
    standalone = await pictureBox(page, `!img.closest(".md-table")`);
    return !!standalone && !!(await pictureBox(page, `!!img.closest(".md-table")`));
  }, "both pictures drawn", 15000);
  assert.ok(standalone);
  await page.click(standalone.x, standalone.y);
  await page.quiet();
  const kept = await page.caret();
  assert.equal(kept.anchor, solo);
  assert.equal(kept.focus, solo + SOLO.length);
  assert.equal(await page.eval(`!!document.querySelector("#editor .md-image img")`), true);
  assert.equal(await page.eval(`!!document.querySelector("#editor .md-table")`), true);

  let point = null;
  await page.until(async () => {
    point = await pictureBox(page, `!!img.closest(".md-table")`);
    return !!point;
  }, "the cell picture", 15000);
  await page.click(point.x, point.y);
  await page.quiet();
  const caret = await page.caret();
  const frac = (point.x - point.left) / (point.right - point.left);
  let at = start + Math.floor(frac * SYNTAX.length + 1e-6);
  if (at >= start + SYNTAX.length) at = start + SYNTAX.length - 1;
  assert.equal(caret.focus, at, `landed at ${caret.focus}, source ${JSON.stringify(TEXT.slice(start, start + SYNTAX.length))}`);
  assert.equal(caret.anchor, caret.focus);
  assert.notEqual(caret.focus, start);
  assert.notEqual(TEXT[caret.focus], "!");
  assert.ok(caret.focus > start && caret.focus < start + SYNTAX.length);
  assert.equal(await page.eval(`document.querySelector("#editor .md-table")`), null);
  assert.equal(await page.eval(`document.querySelector("#editor").textContent.includes(${JSON.stringify(SYNTAX)})`), true);
  assert.equal(await page.eval(`!!document.querySelector("#editor .md-image img")`), true);
});
