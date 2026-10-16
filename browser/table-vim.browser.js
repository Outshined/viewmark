import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "./harness.js";

// Ticket pn4hbr22: with vim keys on, k from below a table went to its first row, past the others.
// Stock vim is the default (R109), so k goes up one row at a time, as j goes down.

const TEXT = "Top.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\nAfter.\n";
const lineAt = (o) => TEXT.slice(TEXT.lastIndexOf("\n", o - 1) + 1, TEXT.indexOf("\n", o) < 0 ? TEXT.length : TEXT.indexOf("\n", o));

async function walk(t, from, key, until) {
  const hub = await startHub();
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await hub.close();
  });
  const file = await hub.create("t.md", TEXT);
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.session.send("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem("viewmark.vim", "1");` });
  await page.login();
  await page.open(file);
  assert.ok(await page.clickOffset(from));
  await page.quiet();
  await page.key("Escape");
  await page.quiet();
  const lines = [];
  for (let n = 0; n < 12; n += 1) {
    await page.key(key);
    await page.quiet();
    const line = lineAt((await page.caret()).focus);
    if (line && lines[lines.length - 1] !== line) lines.push(line);
    if (line === until) break;
  }
  return lines;
}

test("pn4hbr22: with vim keys on, k from below a table rests on its last row and goes up one row at a time", async (t) => {
  const lines = await walk(t, TEXT.indexOf("After.") + 1, "k", "Top.");
  assert.deepEqual(lines, ["| 3 | 4 |", "| 1 | 2 |", "|---|---|", "| a | b |", "Top."]);
});

test("pn4hbr22: with vim keys on, j from above a table goes down one row at a time", async (t) => {
  const lines = await walk(t, 1, "j", "After.");
  assert.deepEqual(lines, ["| a | b |", "|---|---|", "| 1 | 2 |", "| 3 | 4 |", "After."]);
});
