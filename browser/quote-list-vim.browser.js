import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { launchBrowser, Page, startHub } from "./harness.js";

// Ticket czp4tesp: with vim keys on, j or k onto a list item inside a quote sent the caret to
// offset 0, the top of the document. In the owner's Test Page a large picture filled the window,
// so the caret seemed to move behind it.

const TEXT = "Top.\n\n> quoted block\n> * List under a quoted block\n> * second list item\n\nAfter.\n";
const lineOf = (find) => {
  const from = TEXT.indexOf(find);
  return { from: TEXT.lastIndexOf("\n", from) + 1, to: TEXT.indexOf("\n", from), name: find };
};
const STOPS = [lineOf("> quoted block"), lineOf("List under a quoted block"), lineOf("second list item"), lineOf("After.")];

async function setup(t, at = 1) {
  const hub = await startHub();
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await hub.close();
  });
  const file = await hub.create("q.md", TEXT);
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.session.send("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem("viewmark.vim", "1");` });
  await page.login();
  await page.open(file);
  assert.ok(await page.clickOffset(at));
  await page.quiet();
  await page.key("Escape");
  await page.quiet();
  return page;
}

async function expectOn(page, stop, key) {
  await page.key(key);
  await page.quiet();
  await sleep(150);
  const caret = await page.caret();
  assert.ok(caret.focus >= stop.from && caret.focus <= stop.to, `${key} put the caret at ${caret.focus}, not on the line ${JSON.stringify(stop.name)} (${stop.from} to ${stop.to})`);
}

test("czp4tesp: with vim keys on, j steps from a quote's line onto each list item inside the quote, then out of it", async (t) => {
  const page = await setup(t);
  for (const stop of STOPS) await expectOn(page, stop, "j");
});

test("czp4tesp: with vim keys on, k steps up from below a quote onto each list item inside it, then onto the quote's line", async (t) => {
  const page = await setup(t, TEXT.indexOf("After.") + 1);
  for (const stop of STOPS.slice(0, 3).reverse()) await expectOn(page, stop, "k");
});
