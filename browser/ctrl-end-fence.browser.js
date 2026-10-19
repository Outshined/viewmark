import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "./harness.js";

// Ticket 2q8vxkb8. With vim keys off, Ctrl+End in a document whose end is a
// comment fence lands on the last line the page draws, not on the zero-height
// blank before that fence. Ctrl+Shift+End selects to that same place. In the
// raw view the key still goes to the end of the document. A document with no
// trailing fence still lands on the end of its last drawn line.

const DOC = [
  "Para {c1}one{/c1}.",
  "",
  "- item",
  "",
  "```comment c1",
  ":: 0",
  "@2026-10-05T16:00:00.000Z qa",
  "A note.",
  "```",
  "",
].join("\n");
const ITEM_END = DOC.indexOf("- item") + "- item".length;
const GAP = ITEM_END + 1;
const PLAIN = "Para one.\n\n- item\n";
const PLAIN_END = PLAIN.indexOf("- item") + "- item".length;

assert.equal(DOC[ITEM_END], "\n");
assert.equal(DOC[GAP], "\n");
assert.equal(DOC.slice(GAP + 1, GAP + 12), "```comment ");
assert.equal(PLAIN_END, 17);
assert.equal(PLAIN[PLAIN_END], "\n");

async function setup(t, docs) {
  const hub = await startHub();
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await hub.close();
  });
  const files = {};
  for (const [name, text] of Object.entries(docs)) files[name] = await hub.create(name, text);
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.login();
  return { hub, page, files };
}

async function place(page, offset) {
  assert.equal(await page.clickOffset(offset), true, `no point at offset ${offset}`);
  await page.quiet();
  const caret = await page.caret();
  assert.equal(caret.focus, offset, `the click put the caret at ${caret.focus}, not ${offset}`);
  assert.equal(caret.anchor, offset);
  const focused = await page.eval(`(() => {
    const root = document.getElementById("editor");
    return document.activeElement === root || root.contains(document.activeElement);
  })()`);
  assert.equal(focused, true, "the editor is not focused");
  assert.equal(await page.eval(`document.querySelector(".md-vim-status")`), null, "vim keys are on");
  return caret;
}

function focusLine(page) {
  return page.eval(`(() => {
    const sel = window.getSelection();
    if (!sel || !sel.focusNode) return null;
    const node = sel.focusNode.nodeType === 1 ? sel.focusNode : sel.focusNode.parentElement;
    const line = node && node.closest ? node.closest(".md-line") : null;
    if (!line) return null;
    const rect = line.getBoundingClientRect();
    return {
      gap: line.classList.contains("md-paragraph-gap"),
      li: line.classList.contains("md-li"),
      height: rect.height,
      top: rect.top,
      bottom: rect.bottom,
      text: line.textContent,
    };
  })()`);
}

function gapBox(page) {
  return page.eval(`(() => {
    const line = [...document.querySelectorAll("#editor .md-paragraph-gap")].find((el) => Number(el.dataset.start) === ${GAP});
    if (!line) return null;
    const rect = line.getBoundingClientRect();
    return { height: rect.height };
  })()`);
}

// The caret's line is the list item, drawn at that line's height, and the blank
// before the fence stays a paragraph gap of height 0.
async function assertOnItem(page, caret, anchor, focus, label) {
  assert.equal(caret.inside, true, `${label}: the selection is outside the editor`);
  assert.equal(caret.anchor, anchor, `${label}: anchor is ${caret.anchor}, not ${anchor}`);
  assert.equal(caret.focus, focus, `${label}: focus is ${caret.focus}, not ${focus}`);
  const line = await focusLine(page);
  assert.ok(line, `${label}: the caret is not on a line`);
  assert.equal(line.gap, false, `${label}: the caret is on the blank before the fence`);
  assert.equal(line.li, true, `${label}: the caret is not on the list item`);
  assert.ok(line.text.includes("item"), `${label}: the line is ${JSON.stringify(line.text)}`);
  assert.ok(line.height > 1, `${label}: the item line is ${line.height} px tall`);
  if (anchor === focus) {
    assert.ok(caret.rect, `${label}: the caret is not drawn`);
    const height = caret.rect.bottom - caret.rect.top;
    assert.ok(height > 1, `${label}: the caret is ${height} px tall`);
    const mid = (caret.rect.top + caret.rect.bottom) / 2;
    assert.ok(mid >= line.top - 1 && mid <= line.bottom + 1, `${label}: the caret is drawn at y ${mid.toFixed(1)}, the item line is ${line.top.toFixed(1)} to ${line.bottom.toFixed(1)}`);
  }
  const gap = await gapBox(page);
  assert.ok(gap, `${label}: the blank before the fence is not a paragraph gap`);
  assert.ok(gap.height < 1, `${label}: the blank before the fence is ${gap.height} px tall`);
}

async function showRaw(page) {
  const point = await page.eval(`(() => {
    const button = document.querySelector("button.md-view-toggle");
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
  })()`);
  assert.ok(point, "no button.md-view-toggle");
  await page.click(point.x, point.y);
  await page.quiet();
  assert.equal(await page.eval(`document.getElementById("editor").classList.contains("md-source")`), true, "the raw view did not open");
}

test("2q8vxkb8: Ctrl+End before a trailing comment fence lands on the last drawn line", async (t) => {
  const { hub, page, files } = await setup(t, { "fence.md": DOC });
  await page.open(files["fence.md"]);
  await place(page, 1);
  await page.key("End", ["Ctrl"]);
  await page.quiet();
  await assertOnItem(page, await page.caret(), ITEM_END, ITEM_END, "Ctrl+End");
  assert.equal((await hub.show(files["fence.md"])).text, DOC);
});

test("2q8vxkb8: Ctrl+Shift+End selects to the last drawn line before a trailing comment fence", async (t) => {
  const { hub, page, files } = await setup(t, { "fence.md": DOC });
  await page.open(files["fence.md"]);
  await place(page, 1);
  await page.key("End", ["Ctrl", "Shift"]);
  await page.quiet();
  await assertOnItem(page, await page.caret(), 1, ITEM_END, "Ctrl+Shift+End");
  assert.equal((await hub.show(files["fence.md"])).text, DOC);
});

test("2q8vxkb8: in raw mode Ctrl+End still goes to the end of the document", async (t) => {
  const { hub, page, files } = await setup(t, { "fence.md": DOC });
  await page.open(files["fence.md"]);
  await place(page, 1);
  await showRaw(page);
  const focused = await page.eval(`(() => {
    const root = document.getElementById("editor");
    const active = document.activeElement;
    return (active === root || root.contains(active)) && !(active && active.matches && active.matches("button"));
  })()`);
  assert.equal(focused, true, "the raw view left focus off the editor");
  const kept = await page.caret();
  assert.equal(kept.focus, 1, `the raw view moved the caret to ${kept.focus}`);
  await page.key("End", ["Ctrl"]);
  await page.quiet();
  const caret = await page.caret();
  assert.equal(await page.eval(`document.getElementById("editor").classList.contains("md-source")`), true, "Ctrl+End left the raw view");
  assert.equal(caret.focus, DOC.length, `raw Ctrl+End put the caret at ${caret.focus}, not ${DOC.length}`);
  assert.equal(caret.anchor, DOC.length, `raw Ctrl+End left a selection from ${caret.anchor}`);
  assert.notEqual(caret.focus, ITEM_END);
  assert.equal((await hub.show(files["fence.md"])).text, DOC);
});

test("2q8vxkb8: Ctrl+End in a document with no trailing comment fence lands on the last drawn line", async (t) => {
  const { hub, page, files } = await setup(t, { "plain.md": PLAIN });
  await page.open(files["plain.md"]);
  await place(page, 1);
  await page.key("End", ["Ctrl"]);
  await page.quiet();
  const caret = await page.caret();
  assert.equal(caret.focus, PLAIN_END, `Ctrl+End put the caret at ${caret.focus}, not ${PLAIN_END}`);
  assert.equal(caret.anchor, PLAIN_END);
  const line = await focusLine(page);
  assert.ok(line, "the caret is not on a line");
  assert.equal(line.gap, false, "the caret is on a paragraph gap");
  assert.equal(line.li, true, "the caret is not on the list item");
  assert.ok(line.text.includes("item"), `the line is ${JSON.stringify(line.text)}`);
  assert.ok(line.height > 1, `the item line is ${line.height} px tall`);
  assert.ok(caret.rect, "the caret is not drawn");
  const height = caret.rect.bottom - caret.rect.top;
  assert.ok(height > 1, `the caret is ${height} px tall`);
  const mid = (caret.rect.top + caret.rect.bottom) / 2;
  assert.ok(mid >= line.top - 1 && mid <= line.bottom + 1, `the caret is drawn at y ${mid.toFixed(1)}, the item line is ${line.top.toFixed(1)} to ${line.bottom.toFixed(1)}`);
  assert.equal((await hub.show(files["plain.md"])).text, PLAIN);
});
