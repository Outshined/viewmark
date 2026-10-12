import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "./harness.js";

// Acceptance for ticket jxzuzfy9: in a table row, a pipe with a backslash just before it belongs
// to the cell. The cell draws it as a pipe, without the backslash, inside a code span too.

const TABLE = "x\n\n| a \\| b | c |\n| --- | --- |\n| 1 \\| 2 | 3 |\n| `p \\| q` | r \\|\n";

async function setup(t) {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  await hub.create("t.md", TABLE);
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.login();
  await page.open("t.md");
  await page.until(() => page.eval(`!!document.querySelector("#editor table")`), "the table drawn");
  await page.quiet();
  return { hub, browser, page };
}

const cells = (page) => page.eval(`[...document.querySelectorAll("#editor table tr")].map((tr) => [...tr.children].map((cell) => cell.textContent.trim()))`);

test("a table cell keeps an escaped pipe as a pipe, without the backslash, inside a code span too (ticket jxzuzfy9)", async (t) => {
  const { page } = await setup(t);
  assert.deepEqual(await cells(page), [["a | b", "c"], ["1 | 2", "3"], ["p | q", "r |"]]);
  const code = await page.eval(`(() => { const row = document.querySelectorAll("#editor table tr")[2]; const el = row && row.children[0] && row.children[0].querySelector("code"); return el ? el.textContent : null; })()`);
  assert.equal(code, "p | q", "the first cell of the last row holds the code span");
});

test("a click on a cell with an escaped pipe, or after one, puts the caret at the start of that cell's text (ticket jxzuzfy9)", async (t) => {
  for (const [cell, before] of [["1 | 2", "1 \\| 2"], ["3", "3 |\n"]]) {
    await t.test(cell, async (t) => {
      const { page } = await setup(t);
      const point = await page.eval(`window.__qaTarget("cell", ${JSON.stringify(cell)})`);
      assert.ok(point, `no cell drawn as ${JSON.stringify(cell)}: the cells are ${JSON.stringify(await cells(page))}`);
      await page.click(point.x, point.y);
      await page.quiet();
      const caret = await page.eval("window.__qaCaret()");
      assert.equal(caret.focus, TABLE.indexOf(before), `the caret is at ${caret.focus}`);
    });
  }
});
