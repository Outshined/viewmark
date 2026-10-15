import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { launchBrowser, Page, startHub } from "../harness.js";

// The flag is read once, when the editor is created. A later write does not turn keys on.
const FILE = "a.md";
const VIM = "viewmark.vim";
const CARET = "‸";
const ANCHOR = "«";

function marked(text) {
  let doc = "";
  let focus = null;
  let anchor = null;
  for (const ch of text) {
    if (ch === CARET) {
      if (focus != null) throw new Error("two carets");
      focus = doc.length;
    } else if (ch === ANCHOR) {
      if (anchor != null) throw new Error("two anchors");
      anchor = doc.length;
    } else {
      doc += ch;
    }
  }
  if (focus == null) throw new Error("missing caret");
  if (anchor == null) anchor = focus;
  return { doc, focus, anchor };
}

function sent(page, type) {
  return page.frames.filter((frame) => frame.dir === "out" && frame.data && frame.data.type === type).length;
}

async function setup(t, body) {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  await hub.create(FILE, body);
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  // Runs on the next document, before its scripts, so the editor is created with the flag on.
  await page.session.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `localStorage.setItem(${JSON.stringify(VIM)}, "1");`,
  });
  await page.login();
  await page.open(FILE);
  return { hub, page };
}

async function place(page, offset) {
  assert.ok(await page.clickOffset(offset), `no point at ${offset}`);
  await page.quiet();
  const caret = await page.caret();
  assert.equal(caret.focus, offset);
  assert.equal(caret.anchor, offset);
}

async function openMarked(t, text) {
  const parsed = marked(text);
  const session = await setup(t, parsed.doc);
  await place(session.page, parsed.focus);
  return session;
}

// A span is one press per character. The caller splits on commas before this.
async function press(page, span) {
  for (const key of span) await page.key(key);
}

function status(page) {
  return page.eval(`document.querySelector("span.md-vim-status").textContent`);
}

async function taken(hub, page, file) {
  await page.quiet();
  const shown = await hub.show(file);
  const caret = await page.caret();
  return { text: shown.text, rev: shown.rev, focus: caret.focus, anchor: caret.anchor };
}

function assertTaken(got, text, rev, label = "") {
  const want = marked(text);
  assert.equal(got.text, want.doc, label);
  assert.equal(got.rev, rev, label);
  assert.equal(got.focus, want.focus, label);
  assert.equal(got.anchor, want.anchor, label);
}

test("VK.1 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await openMarked(t, "al‸pha beta\n");
  const before = await hub.show(FILE);
  const edits = sent(page, "edit");
  await page.key("d");
  await page.quiet();
  assert.equal(await status(page), "d");
  await sleep(3000);
  assert.equal(await status(page), "d");
  await page.key("w");
  assertTaken(await taken(hub, page, FILE), "al‸beta\n", before.rev + 1);
  assert.equal(sent(page, "edit") - edits, 1);
});

test("VK.2 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await openMarked(t, "‸alpha\n");
  const before = await taken(hub, page, FILE);
  const edits = sent(page, "edit");
  await page.key("g");
  assertTaken(await taken(hub, page, FILE), "‸alpha\n", before.rev);
  assert.equal(sent(page, "edit"), edits);
  assert.equal(await status(page), "g");
});

test("VK.3 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await openMarked(t, "‸alpha beta\n");
  const before = await hub.show(FILE);
  const edits = sent(page, "edit");
  await press(page, "d");
  await press(page, "Q");
  await press(page, "w");
  assertTaken(await taken(hub, page, FILE), "alpha ‸beta\n", before.rev);
  assert.equal(sent(page, "edit"), edits);
});

test("VK.4 (ticket 7vdep2z4)", async (t) => {
  const cases = [
    ["‸a b c d e f g h\n", "3d2w", "‸g h\n"],
    ["‸a b c d e f g h\n", "2d3w", "‸g h\n"],
    ["‸a b c d e f g h\n", "6dw", "‸g h\n"],
    ["‸a b c d e\n", "3dw", "‸d e\n"],
    ["‸a b c d e\n", "d3w", "‸d e\n"],
  ];
  const { hub, page } = await openMarked(t, cases[0][0]);
  for (let i = 0; i < cases.length; i += 1) {
    const [start, span, want] = cases[i];
    const file = i === 0 ? FILE : `k${i}.md`;
    if (i > 0) {
      await hub.create(file, marked(start).doc);
      await page.open(file);
      await place(page, marked(start).focus);
    }
    const before = await hub.show(file);
    const edits = sent(page, "edit");
    await press(page, span);
    assertTaken(await taken(hub, page, file), want, before.rev + 1, span);
    assert.equal(sent(page, "edit") - edits, 1, span);
  }
});

test("VK.5 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await openMarked(t, "abc‸def\n");
  let before = await hub.show(FILE);
  await page.key("0");
  assertTaken(await taken(hub, page, FILE), "‸abcdef\n", before.rev);

  const file = "k.md";
  await hub.create(file, marked("‸abcdefghijkl\n").doc);
  await page.open(file);
  await place(page, 0);
  before = await hub.show(file);
  await press(page, "10l");
  assertTaken(await taken(hub, page, file), "abcdefghij‸kl\n", before.rev);
});

test("VK.6 (ticket 7vdep2z4)", async (t) => {
  const line = "a".repeat(12000);
  const { hub, page } = await openMarked(t, CARET + line);
  const before = await hub.show(FILE);
  const edits = sent(page, "edit");
  await press(page, "12000x");
  // The repeat is capped at 10000, so 2000 a's stay.
  assertTaken(await taken(hub, page, FILE), CARET + "a".repeat(2000), before.rev + 1);
  assert.equal(sent(page, "edit") - edits, 1);
});

test("VK.7 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await openMarked(t, "‸alpha beta\n");
  const before = await hub.show(FILE);
  const edits = sent(page, "edit");
  await press(page, "dc");
  await press(page, "w");
  assertTaken(await taken(hub, page, FILE), "alpha ‸beta\n", before.rev);
  assert.equal(sent(page, "edit"), edits);
});

test("VK.8 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await openMarked(t, "al‸pha beta\n");
  const before = await hub.show(FILE);
  const edits = sent(page, "edit");
  await press(page, "dw");
  assertTaken(await taken(hub, page, FILE), "al‸beta\n", before.rev + 1);
  assert.equal(sent(page, "edit") - edits, 1);
  const mid = await hub.show(FILE);
  const undos = sent(page, "undo");
  const midEdits = sent(page, "edit");
  await press(page, "d");
  await press(page, "u");
  assertTaken(await taken(hub, page, FILE), "al‸beta\n", mid.rev);
  assert.equal(sent(page, "undo"), undos);
  assert.equal(sent(page, "edit"), midEdits);
});
