import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "./harness.js";

// Leaving Insert puts the caret where stock vim puts the cursor: on the last character typed, or
// one to the left of where Insert began when nothing was typed, and never left of the line's
// start. Escape and Ctrl-[ are the same. Ticket s4sgk32f; stock vim is the default (R109).

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
  assert.ok(await page.clickOffset(offset));
  await page.quiet();
  await page.key("Escape");
  await page.quiet();
  assert.ok(await page.clickOffset(offset));
  await page.quiet();
}

const CASES = [
  { name: "A, xy, Escape at the end of a line", text: "alpha beta\n", at: 2, keys: [["A"], "xy", ["Escape"]], doc: "alpha betaxy\n", caret: 11 },
  { name: "cw on keys, key bindings, Escape in the middle of a line", text: "alpha keys to\n", at: 6, keys: [["c"], ["w"], "key bindings", ["Escape"]], doc: "alpha key bindings to\n", caret: 17 },
  { name: "A, x, Ctrl-[", text: "alpha\n", at: 1, keys: [["A"], "x", ["[", "Ctrl"]], doc: "alphax\n", caret: 5 },
  { name: "i at the line's start, nothing typed, Escape", text: "alpha\n", at: 0, keys: [["i"], ["Escape"]], doc: "alpha\n", caret: 0 },
];

for (const c of CASES) {
  test(`s4sgk32f: ${c.name} leaves the caret where stock vim's cursor is`, async (t) => {
    const { hub, page, file } = await setup(t, c.text);
    await normalAt(page, c.at);
    for (const k of c.keys) {
      if (Array.isArray(k)) await page.key(k[0], k.slice(1));
      else await page.type(k);
    }
    await page.quiet();
    assert.equal((await hub.show(file)).text, c.doc);
    assert.equal((await page.caret()).focus, c.caret);
    assert.equal(await page.eval(`document.querySelector(".md-vim-status").textContent`), "N");
  });
}
