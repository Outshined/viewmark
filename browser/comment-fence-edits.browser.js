import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { launchBrowser, Page, startHub } from "./harness.js";

// Ticket 8r57d6f2. No page edit, typed or by a vim operator, with vim keys on or off, changes the
// bytes of a comment fence or the blank line between two fences that both stay. Only the comment
// commands and the cards change those. Ticket jhd65qg4: dd that removes a comment's text and its
// markers deletes that thread, the way its author would, and leaves the other thread. dd past
// the last fence deletes the caret's line or nothing, and never moves the caret to 0. Typing at
// the end of a document that ends in fences writes a new paragraph after them, and the threads
// stay as they were.

const fence = (id, who, text) => `\`\`\`comment ${id} resolved\n:: 0\n@2026-10-16T12:00:00.000Z ${who}\n${text}\n\`\`\`\n`;
const FENCES = `${fence("c1", "qa", "First thread.")}\n${fence("c2", "qa", "Second thread.")}`;
const TEXT = `Para {c1}one{/c1}.\n\nSecond {c2}paragraph{/c2}.\n\n${FENCES}`;

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
  await page.quiet();
  return { hub, page, file };
}

// The fences as stored: from the first opener to the end of the file.
const fencesOf = (text) => text.slice(text.indexOf("```comment"));

async function intact(hub, file, label) {
  await sleep(300);
  const text = (await hub.show(file)).text;
  assert.ok(fencesOf(text).startsWith(FENCES), `${label}: the stored threads changed: ${JSON.stringify(fencesOf(text))}`);
  return text;
}

async function endOfFile(page) {
  // A click below the last line puts the caret after everything, where a person starts a new
  // paragraph.
  await page.clickBelow();
  await page.quiet();
}

for (const vim of [true, false]) {
  test(`8r57d6f2: with vim keys ${vim ? "on" : "off"}, typing at the end of a document that ends in comment fences writes a new paragraph after them, and the threads stay intact`, async (t) => {
    const { hub, page, file } = await setup(t, vim);
    await endOfFile(page);
    if (vim) await page.key("i");
    await page.type("tail");
    await page.quiet();
    const text = await intact(hub, file, "typing at the end");
    assert.ok(/```\n\n*tail\n?$/.test(text), `tail is not a paragraph after the fences: ${JSON.stringify(text.slice(-40))}`);
    // Backspace at the start of that paragraph must not join it into the last fence's closer.
    assert.ok(await page.clickOffset(text.indexOf("tail")));
    await page.quiet();
    if (vim) await page.key("i");
    await page.key("Backspace");
    await page.quiet();
    const after = await intact(hub, file, "Backspace at the start of tail");
    assert.ok(after.includes("tail"), "the new paragraph was lost");
  });
}

test("jhd65qg4: with vim keys on, dd of a commented paragraph deletes that thread and leaves the other", async (t) => {
  const { hub, page, file } = await setup(t, true);
  assert.ok(await page.clickOffset(TEXT.indexOf("Second") + 2));
  await page.quiet();
  await page.key("Escape");
  await page.key("d");
  await page.key("d");
  await page.quiet();
  await sleep(300);
  const first = (await hub.show(file)).text;
  assert.equal(first.includes("Second"), false, `the paragraph stayed: ${JSON.stringify(first)}`);
  assert.equal(first.includes("paragraph"), false);
  assert.equal(first.includes("```comment c2"), false);
  assert.equal(first.includes("Second thread."), false);
  assert.equal(first.includes("Para {c1}one{/c1}."), true);
  assert.ok(first.includes(fence("c1", "qa", "First thread.")), `c1 changed: ${JSON.stringify(first)}`);
  for (let n = 0; n < 3; n += 1) {
    await page.key("d");
    await page.key("d");
    await page.quiet();
    await sleep(300);
    const later = (await hub.show(file)).text;
    assert.ok(later.includes(fence("c1", "qa", "First thread.")), `dd ${n + 2} changed c1: ${JSON.stringify(later)}`);
    assert.equal(later.includes("```comment c2"), false);
  }
});

test("8r57d6f2: with vim keys on, dd with the caret past the last comment fence deletes nothing in the threads and leaves the caret off 0", async (t) => {
  const { hub, page, file } = await setup(t, true);
  await endOfFile(page);
  await page.key("Escape");
  await page.quiet();
  await page.key("d");
  await page.key("d");
  await page.quiet();
  await intact(hub, file, "dd past the last fence");
  const caret = await page.caret();
  assert.notEqual(caret.focus, 0, "dd put the caret at offset 0");
  await page.key("i");
  await page.type("x");
  await page.quiet();
  await intact(hub, file, "typing after dd");
});
