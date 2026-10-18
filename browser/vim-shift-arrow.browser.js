import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "./harness.js";

// Ticket vgf3mkb2, the owner's c15 in editing.md: with vim keys on, in Normal, Shift+→ moves
// where w does and Shift+← where b does, as in stock vim. The positions are stock vim 9.2's, run
// with no vimrc on `alpha beta gamma`: Shift+→ and w from column 1 go to column 7, 2 then
// Shift+→ and 2w to column 12, and Shift+← from column 7 back to column 1. With vim keys off,
// Shift+→ and Shift+← extend the selection (R70).

const TEXT = "alpha beta gamma\n\nsecond line here\n";

async function setup(t, vim) {
  const hub = await startHub();
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await hub.close();
  });
  const file = await hub.create("a.md", TEXT);
  const page = new Page(browser.session, hub.port);
  await page.init();
  if (vim) await page.session.send("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem("viewmark.vim", "1");` });
  await page.login();
  await page.open(file);
  return { hub, page, file };
}

async function at(page, offset, vim) {
  assert.ok(await page.clickOffset(offset), `no point at ${offset}`);
  await page.quiet();
  if (vim) {
    await page.key("Escape");
    await page.quiet();
  }
  const caret = await page.caret();
  assert.equal(caret.focus, offset, `the click did not put the caret at ${offset}`);
}

const MOVES = [
  { name: "Shift+→ from the start goes where w does", from: 0, keys: [["→", "Shift"]], to: 6 },
  { name: "2 then Shift+→ goes where 2w does", from: 0, keys: [["2"], ["→", "Shift"]], to: 11 },
  { name: "Shift+← from beta goes where b does", from: 6, keys: [["←", "Shift"]], to: 0 },
];

for (const move of MOVES) {
  test(`vgf3mkb2: with vim keys on, in Normal, ${move.name}, the caret stays collapsed, and nothing is written`, async (t) => {
    const { hub, page, file } = await setup(t, true);
    await at(page, move.from, true);
    const before = await hub.show(file);
    for (const [key, ...mods] of move.keys) await page.key(key, mods);
    await page.quiet();
    const caret = await page.caret();
    assert.equal(caret.focus, move.to, `the caret went to ${caret.focus}`);
    assert.equal(caret.anchor, caret.focus, `the caret is a selection from ${caret.anchor} to ${caret.focus}`);
    assert.equal(await page.eval(`document.querySelector(".md-vim-status").textContent`), "N");
    const after = await hub.show(file);
    assert.equal(after.text, TEXT, "the text changed");
    assert.equal(after.rev, before.rev, "an edit was written");
  });
}

test("vgf3mkb2: with vim keys off, Shift+→ and Shift+← extend the selection (R70)", async (t) => {
  const { page } = await setup(t, false);
  await at(page, 6, false);
  await page.key("→", ["Shift"]);
  await page.quiet();
  let caret = await page.caret();
  assert.deepEqual([caret.anchor, caret.focus], [6, 7], "Shift+→ did not extend the selection by one character");
  await page.key("←", ["Shift"]);
  await page.key("←", ["Shift"]);
  await page.quiet();
  caret = await page.caret();
  assert.deepEqual([caret.anchor, caret.focus], [6, 5], "Shift+← did not extend the selection back past the anchor");
});
