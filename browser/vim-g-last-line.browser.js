import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { launchBrowser, Page, startHub } from "./harness.js";

// Ticket r5kwsdqr. With vim keys on, G goes to the last line of the file, as stock vim does. A
// final newline does not start another line, and a comment's fence at the end of the file is not
// a line G lands on, so the caret is on the last line the page draws. In the raw view each source
// line is a vim line, and G lands on the last one's first non-blank.

const VIM = "viewmark.vim";
const NOTE = "```comment c1\n:: 0\n@2026-10-05T16:00:00.000Z qa\nA note.\n```\n";
const LIST = "Para one.\n\n- item\n";
const FENCED = `Para {c1}one{/c1}.\n\n- item\n\n${NOTE}`;
const INDENTED = "alpha\n  indented last\n";

async function setup(t, files) {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  for (const [name, text] of Object.entries(files)) await hub.create(name, text);
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.session.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `localStorage.setItem(${JSON.stringify(VIM)}, "1");`,
  });
  await page.login();
  return { hub, page };
}

async function showRaw(page) {
  for (let i = 0; i < 4; i += 1) {
    if (await page.eval(`document.getElementById("editor").classList.contains("md-source")`)) return;
    const point = await page.eval(`(() => {
      const button = document.querySelector("button.md-view-toggle");
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
    })()`);
    assert.ok(point, "no button.md-view-toggle");
    await page.click(point.x, point.y);
    await page.quiet();
  }
  assert.equal(await page.eval(`document.querySelector("#editor.md-source") != null`), true, "#editor.md-source");
}

// Opens the file, puts the caret at offset 1 with a click, and presses G.
async function pressG(page, file, raw = false) {
  await page.open(file);
  if (raw) await showRaw(page);
  assert.equal(await page.clickOffset(1), true, `${file}: no point at offset 1`);
  await page.quiet();
  await page.key("G");
  await page.quiet();
  return page.caret();
}

// The drawn line that holds a text offset, with its box.
function lineOf(page, offset) {
  return page.eval(`(() => {
    const line = [...document.querySelectorAll("#editor .md-line")].find((el) => !el.classList.contains("md-paragraph-gap") && ${offset} >= Number(el.dataset.start) && ${offset} <= Number(el.dataset.end));
    if (!line) return null;
    const r = line.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, text: line.textContent };
  })()`);
}

async function drawnOn(page, caret, offset, label) {
  const line = await lineOf(page, offset);
  assert.ok(line, `${label}: no drawn line holds offset ${offset}`);
  assert.ok(caret.rect, `${label}: the caret is not drawn`);
  const mid = (caret.rect.top + caret.rect.bottom) / 2;
  assert.ok(mid >= line.top - 1 && mid <= line.bottom + 1, `${label}: the caret is drawn at y ${mid.toFixed(1)}, not on ${JSON.stringify(line.text)} at ${line.top.toFixed(1)} to ${line.bottom.toFixed(1)}`);
}

async function stored(hub, file, word) {
  let got = await hub.show(file);
  const started = Date.now();
  while (!String(got.text).includes(word) && Date.now() - started < 3000) {
    await sleep(50);
    got = await hub.show(file);
  }
  assert.ok(String(got.text).includes(word), `${file}: ${JSON.stringify(word)} is not stored: ${JSON.stringify(got.text)}`);
  return got.text;
}

// `- item` starts at 11 in LIST and at 20 in FENCED. The page draws the marker, not its text, so
// the first non-blank is the line's start or the start of `item`, which are drawn in one place.
const ITEM = { "list.md": LIST.indexOf("- item"), "fenced.md": FENCED.indexOf("- item") };

for (const file of ["list.md", "fenced.md"]) {
  test(`r5kwsdqr: with vim keys on, G in ${file} lands on the first non-blank of - item, the last line the page draws`, async (t) => {
    const { page } = await setup(t, { "list.md": LIST, "fenced.md": FENCED });
    const at = ITEM[file];
    const caret = await pressG(page, file);
    assert.ok(caret.focus === at || caret.focus === at + 2, `G put the caret at ${caret.focus}, not at ${at} or ${at + 2}, the start of - item`);
    assert.equal(caret.anchor, caret.focus, `G left a selection from ${caret.anchor} to ${caret.focus}`);
    await drawnOn(page, caret, at + 2, `${file} G`);
  });
}

test("r5kwsdqr: with vim keys on, G and then o write the new line under - item, before a comment's fence at the end of the file", async (t) => {
  const { hub, page } = await setup(t, { "fenced.md": FENCED });
  await pressG(page, "fenced.md");
  for (const key of ["o", "n", "e", "x", "t"]) await page.key(key);
  await page.quiet();
  const text = await stored(hub, "fenced.md", "next");
  const item = text.indexOf("- item");
  const word = text.indexOf("next");
  const fence = text.indexOf("```comment c1");
  assert.ok(item >= 0 && fence >= 0, `the list or the fence is gone: ${JSON.stringify(text)}`);
  assert.ok(word > item && word < fence, `next was written at ${word}, not between - item at ${item} and the fence at ${fence}: ${JSON.stringify(text)}`);
  await drawnOn(page, await page.caret(), word, "o next");
});

test("r5kwsdqr: with vim keys on, in the raw view G lands on the first non-blank of the last source line", async (t) => {
  const { page } = await setup(t, { "list.md": LIST, "indented.md": INDENTED });
  let caret = await pressG(page, "list.md", true);
  assert.equal(caret.focus, LIST.indexOf("- item"), `list.md: G put the caret at ${caret.focus}`);
  assert.equal(caret.anchor, caret.focus, `list.md: G left a selection from ${caret.anchor} to ${caret.focus}`);
  caret = await pressG(page, "indented.md", true);
  assert.equal(caret.focus, INDENTED.indexOf("indented"), `indented.md: G put the caret at ${caret.focus}`);
  assert.equal(caret.anchor, caret.focus, `indented.md: G left a selection from ${caret.anchor} to ${caret.focus}`);
});
