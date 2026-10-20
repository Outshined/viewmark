import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "./harness.js";

// Ticket 4cypbkfe. In Normal, ^ lands on the marker. l from there moves one
// source character, and another l moves one more. Neither lands at the end of
// the line. x on the character after ^ l deletes that character.

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

async function focus(page) {
  return (await page.caret()).focus;
}

const LINES = [
  { name: "a list item", text: "- alpha\n", at: 4 },
  { name: "a heading", text: "# Title\n", at: 4 },
  { name: "a quote", text: "> quote\n", at: 4 },
  { name: "an ordered item", text: "1. one\n", at: 4 },
];

for (const line of LINES) {
  test(`4cypbkfe: with vim keys on, ^ then l on ${line.name} moves one character from the marker`, async (t) => {
    const { page } = await setup(t, line.text);
    await normalAt(page, line.at);
    await page.key("^");
    await page.quiet();
    assert.equal(await focus(page), 0, "^ did not land on the marker");
    await page.key("l");
    await page.quiet();
    const once = await focus(page);
    assert.equal(once, 1, `l left the caret at ${once}, not one character right of the marker`);
    assert.notEqual(once, line.text.length - 1, "l jumped to the end of the line");
    await page.key("l");
    await page.quiet();
    const twice = await focus(page);
    assert.equal(twice, 2, `the next l left the caret at ${twice}`);
    assert.notEqual(twice, line.text.length - 1, "the next l jumped to the end of the line");
  });
}

test("4cypbkfe: with vim keys on, ^ then l in a paragraph lands on the second character", async (t) => {
  const text = "alpha\n";
  const { page } = await setup(t, text);
  await normalAt(page, 3);
  await page.key("^");
  await page.quiet();
  assert.equal(await focus(page), 0);
  await page.key("l");
  await page.quiet();
  const at = await focus(page);
  assert.equal(at, 1, `l left the caret at ${at}`);
  assert.equal(text[at], "l");
});

test("4cypbkfe: with vim keys on, x after ^ l on a list item deletes the space", async (t) => {
  const { hub, page, file } = await setup(t, "- alpha\n");
  await normalAt(page, 4);
  await page.key("^");
  await page.key("l");
  await page.quiet();
  assert.equal(await focus(page), 1, "l did not land on the space");
  await page.key("x");
  await page.quiet();
  assert.equal((await hub.show(file)).text, "-alpha\n");
});
