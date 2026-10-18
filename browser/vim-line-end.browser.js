import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "./harness.js";

// Ticket qvqa6h7q. With vim keys on, in Normal, $, l on a line's last character, and j or k onto
// a shorter line put the caret on that line's last character, and the block caret covers it, as
// stock vim's cursor does. x there deletes that character and nothing else, and x and X never
// delete a line break (R119). Stock vim is the default (R109).

async function setup(t, text) {
  const hub = await startHub();
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await hub.close();
  });
  const file = await hub.create("a.md", text);
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.session.send("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem("viewmark.vim", "1");` });
  await page.login();
  await page.open(file);
  return { hub, page, file };
}

async function normalAt(page, offset) {
  assert.ok(await page.clickOffset(offset), `no point at ${offset}`);
  await page.quiet();
  await page.key("Escape");
  await page.quiet();
  assert.equal((await page.caret()).focus, offset, `the click did not put the caret at ${offset}`);
}

// The block caret's box, or null when it draws nothing.
const block = (page) => page.eval(`(() => {
  const mark = document.querySelector(".md-vim-block-mark");
  if (!mark) return null;
  const r = mark.getBoundingClientRect();
  return r.width > 1 && r.height > 1 ? { width: r.width, height: r.height } : null;
})()`);

const CASES = [
  { name: "$ in a paragraph", text: "alpha beta\n\ngamma\n", at: 7, keys: ["$"], caret: 9, after: "alpha bet\n\ngamma\n" },
  { name: "l on a line's last character", text: "alpha beta\n\ngamma\n", at: 9, keys: ["l"], caret: 9, after: "alpha bet\n\ngamma\n" },
  { name: "k onto a shorter line", text: "# Hi\nA longer paragraph line.\n", at: 19, keys: ["k"], caret: 3, after: "# H\nA longer paragraph line.\n" },
  { name: "j onto a shorter line", text: "A longer paragraph line.\n\nShort.\n", at: 14, keys: ["j"], caret: 31, after: "A longer paragraph line.\n\nShort\n" },
  { name: "$ in a list item", text: "- one\n- two\n", at: 3, keys: ["$"], caret: 4, after: "- on\n- two\n" },
  { name: "$ on the last line", text: "alpha\n", at: 1, keys: ["$"], caret: 4, after: "alph\n" },
  { name: "$ on a line that ends in a space", text: "alpha \n", at: 0, keys: ["$"], caret: 5, after: "alpha\n" },
];

for (const c of CASES) {
  test(`qvqa6h7q: with vim keys on, ${c.name} puts the caret on the line's last character under the block, and x deletes only that character`, async (t) => {
    const { hub, page, file } = await setup(t, c.text);
    await normalAt(page, c.at);
    for (const key of c.keys) await page.key(key);
    await page.quiet();
    assert.equal((await page.caret()).focus, c.caret, `${c.keys.join("")} put the caret at ${(await page.caret()).focus}`);
    assert.ok(await block(page), "the block caret covers no character");
    await page.key("x");
    await page.quiet();
    assert.equal((await hub.show(file)).text, c.after);
  });
}

test("qvqa6h7q: with vim keys on, x on an empty line and X at the start of a paragraph change nothing", async (t) => {
  const text = "one\n\n\n\ntwo\n\nthree\n";
  const { hub, page, file } = await setup(t, text);
  await normalAt(page, 5);
  await page.key("x");
  await page.quiet();
  assert.equal((await hub.show(file)).text, text, "x on the empty line changed the text");
  await normalAt(page, text.indexOf("three"));
  await page.key("X");
  await page.quiet();
  assert.equal((await hub.show(file)).text, text, "X at the start of three changed the text");
});
