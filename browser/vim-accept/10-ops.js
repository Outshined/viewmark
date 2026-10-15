import test from "node:test";
import assert from "node:assert/strict";
import { createState, insert } from "../../src/doc.js";
import { launchBrowser, Page, startHub } from "../harness.js";

// The flag is read once, when the editor is created. A later write does not turn keys on.
const VIM = "viewmark.vim";
const CARET = "‸";
const ANCHOR = "«";

function marked(text) {
  let doc = "";
  let focus = null;
  let anchor = null;
  for (const ch of text) {
    if (ch === CARET) focus = doc.length;
    else if (ch === ANCHOR) anchor = doc.length;
    else doc += ch;
  }
  if (focus == null) throw new Error(`missing caret in ${JSON.stringify(text)}`);
  if (anchor == null) anchor = focus;
  return { doc, focus, anchor };
}

function show(doc, focus, anchor = focus) {
  let out = "";
  for (let i = 0; i <= doc.length; i += 1) {
    if (anchor !== focus && i === anchor) out += ANCHOR;
    if (i === focus) out += CARET;
    if (i < doc.length) out += doc[i];
  }
  return out;
}

function seen(text, caret) {
  if (!caret || !Number.isInteger(caret.focus) || !Number.isInteger(caret.anchor)) {
    return `caret ${JSON.stringify(caret)} text ${JSON.stringify(text)}`;
  }
  return show(text, caret.focus, caret.anchor);
}

function editsSince(page, since) {
  return page.frames.slice(since).filter((frame) => frame.dir === "out" && frame.data && frame.data.type === "edit");
}

function insertMode(keys) {
  return keys === "C" || keys.startsWith("c");
}

async function setup(t) {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.session.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `localStorage.setItem(${JSON.stringify(VIM)}, "1");`,
  });
  await page.login();
  return { hub, page };
}

async function status(page) {
  return page.eval(`document.querySelector(".md-vim-status").textContent`);
}

// The toggle rebuilds the lines, so the caret is placed after the source view is up.
async function showRaw(page) {
  for (let n = 0; n < 4; n += 1) {
    if (await page.eval(`!!document.querySelector("#editor.md-source")`)) return;
    const point = await page.eval(`(() => {
      const button = document.querySelector("button.md-view-toggle");
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
    })()`);
    assert.ok(point, "no raw toggle");
    await page.click(point.x, point.y);
    await page.quiet();
  }
  assert.equal(await page.eval(`!!document.querySelector("#editor.md-source")`), true);
}

async function place(page, offset) {
  assert.equal(await page.clickOffset(offset), true, `no point at ${offset}`);
  await page.quiet();
  const caret = await page.caret();
  assert.equal(caret.focus, offset, `focus ${JSON.stringify(caret)}`);
  assert.equal(caret.anchor, offset, `anchor ${JSON.stringify(caret)}`);
}

// Colon opens the line, which already shows the mark. The rest of the span is the command.
async function sendKeys(page, spec) {
  const keys = [...spec];
  if (keys[0] === ":") {
    await page.key(":");
    await page.quiet();
    const ready = await page.eval(`(() => {
      const input = document.querySelector("input.md-vim-line");
      return !!input && document.activeElement === input && String(input.value).startsWith(":");
    })()`);
    assert.equal(ready, true, "vim line");
    for (const key of keys.slice(1)) await page.key(key);
    await page.key("Enter");
    await page.quiet();
    return;
  }
  for (const key of keys) await page.key(key);
  await page.quiet();
}

async function runCase(hub, page, file, item) {
  const { doc, focus } = marked(item.start);
  await hub.create(file, doc);
  await page.open(file);
  assert.equal(await page.eval(`localStorage.getItem(${JSON.stringify(VIM)})`), "1");
  if (item.raw) await showRaw(page);
  await place(page, focus);
  const before = await hub.show(file);
  assert.equal(before.text, doc, file);
  const since = page.frames.length;
  await sendKeys(page, item.keys);
  const after = await hub.show(file);
  const caret = await page.caret();
  const got = seen(after.text, caret);
  const label = `${item.raw ? "raw " : ""}${item.keys}`;
  assert.equal(got, item.expect, label);
  assert.equal(after.rev, before.rev + 1, `${label} rev ${got}`);
  assert.equal(editsSince(page, since).length, 1, `${label} ${got}`);
  assert.equal(await status(page), insertMode(item.keys) ? "I" : "N", `${label} ${got}`);
  if (item.after) await item.after(page, caret, got);
}

async function cases(t, list) {
  const { hub, page } = await setup(t);
  for (let i = 0; i < list.length; i += 1) await runCase(hub, page, `d${i}.md`, list[i]);
}

// A second undo on an empty stack is a noop, so the command added one entry.
async function undoOnce(hub, page, file, before, changedText, rev) {
  if ((await status(page)) === "I") {
    await page.key("Escape");
    await page.quiet();
    const stayed = await hub.show(file);
    assert.equal(stayed.text, changedText, `${file} escape`);
    assert.equal(stayed.rev, rev, `${file} escape rev`);
  }
  await page.key("u");
  await page.quiet();
  const undone = await hub.show(file);
  assert.equal(undone.text, before, `${file} undo ${JSON.stringify(undone.text)}`);
  assert.equal(undone.rev, rev + 1, `${file} undo rev`);
  await page.key("u");
  await page.quiet();
  const second = await hub.show(file);
  assert.equal(second.text, before, `${file} second undo ${JSON.stringify(second.text)}`);
  assert.equal(second.rev, undone.rev, `${file} second undo rev`);
}

function assertInsertFrame(data, before, after, caret, label) {
  assert.equal(data.op, "insert", `${label} op ${data && data.op} ${seen(after, caret)}`);
  assert.equal(Object.hasOwn(data, "group"), false, `${label} ${seen(after, caret)}`);
  assert.equal(typeof data.text, "string", label);
  assert.equal(Number.isInteger(data.anchor), true, `${label} anchor`);
  assert.equal(Number.isInteger(data.cursor), true, `${label} cursor`);
  assert.equal(Number.isInteger(data.caret), true, `${label} caret`);
  // The hub's insert, not a raw splice: a formatted line break gains a leading newline.
  const next = insert(createState(before, data.cursor, data.anchor), data.text, data.paste === true, data.raw === true);
  assert.ok(next && next.doc !== before, `${label} ${seen(after, caret)}`);
  assert.equal(next.doc, after, `${label} ${seen(after, caret)}`);
  assert.equal(caret.focus, data.caret, `${label} ${seen(after, caret)}`);
  assert.equal(caret.anchor, data.caret, `${label} ${seen(after, caret)}`);
}

async function oneSplice(hub, page, file, item) {
  await hub.create(file, item.body);
  await page.open(file);
  assert.equal(await page.eval(`localStorage.getItem(${JSON.stringify(VIM)})`), "1");
  await place(page, item.at);
  if (item.keys === "p") {
    const rev = (await hub.show(file)).rev;
    const since = page.frames.length;
    await page.key("y");
    await page.key("y");
    await page.quiet();
    const yanked = await hub.show(file);
    assert.equal(yanked.text, item.body, `${item.keys} yy ${JSON.stringify(yanked.text)}`);
    assert.equal(yanked.rev, rev, `${item.keys} yy rev`);
    assert.equal(editsSince(page, since).length, 0, `${item.keys} yy edits`);
  }
  const before = await hub.show(file);
  const since = page.frames.length;
  await sendKeys(page, item.keys);
  const after = await hub.show(file);
  const caret = await page.caret();
  const got = seen(after.text, caret);
  assert.equal(after.rev, before.rev + 1, `${item.keys} rev ${got}`);
  const edits = editsSince(page, since);
  assert.equal(edits.length, 1, `${item.keys} ${got}`);
  assertInsertFrame(edits[0].data, before.text, after.text, caret, item.keys);
  assert.equal(await status(page), insertMode(item.keys) ? "I" : "N", `${item.keys} ${got}`);
  await undoOnce(hub, page, file, before.text, after.text, after.rev);
}

async function emptyBetween(page, caret, got) {
  const lines = await page.eval(`(() => [...document.querySelectorAll("#editor .md-line")].map((line) => ({
    start: Number(line.dataset.start),
    text: line.textContent,
  })))()`);
  const at = lines.findIndex((line) => line.text === "" && line.start === caret.focus);
  assert.ok(at > 0, `${got} empty line ${JSON.stringify(lines)}`);
  assert.equal(lines.slice(0, at).some((line) => line.text.includes("one")), true, `${got} ${JSON.stringify(lines)}`);
  assert.equal(lines.slice(at + 1).some((line) => line.text.includes("three")), true, `${got} ${JSON.stringify(lines)}`);
}

test("VO.1 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t);
  const commands = [
    { keys: "3dw", body: "a b c d e\n", at: 0 },
    { keys: "dd", body: "alpha\nbeta\n", at: 2 },
    { keys: "3x", body: "alpha\n", at: 2 },
    { keys: "cc", body: "alpha\nbeta\n", at: 2 },
    { keys: "J", body: "one\n\ntwo\n", at: 2 },
    { keys: ">>", body: "alpha\n", at: 2 },
    { keys: "p", body: "alpha\n", at: 0 },
    { keys: ":%s/a/b/g", body: "banana\nalpha\n", at: 0 },
  ];
  for (let i = 0; i < commands.length; i += 1) await oneSplice(hub, page, `o${i}.md`, commands[i]);
});

test("VO.2 (ticket 7vdep2z4)", async (t) => {
  await cases(t, [
    { start: "alpha ‸beta\n", keys: "dw", expect: "alpha ‸\n" },
    { start: "al‸pha beta\n", keys: "dw", expect: "al‸beta\n" },
  ]);
});

test("VO.3 (ticket 7vdep2z4)", async (t) => {
  await cases(t, [
    { start: "al‸pha beta\n", keys: "cw", expect: "al‸ beta\n" },
    { start: "alpha‸   beta\n", keys: "cw", expect: "alpha‸beta\n" },
  ]);
});

test("VO.4 (ticket 7vdep2z4)", async (t) => {
  await cases(t, [
    { start: "al‸pha\nbeta\n", keys: "dw", expect: "al‸beta\n" },
    { start: "al‸pha\n\nbeta\n", keys: "dw", expect: "al‸\n\nbeta\n" },
    { start: "al‸pha\nbeta\n", keys: "dw", expect: "al‸\nbeta\n", raw: true },
    { start: "al‸pha\nbeta\n", keys: "cw", expect: "al‸beta\n" },
    { start: "al‸pha\n\nbeta\n", keys: "cw", expect: "al‸\n\nbeta\n" },
    { start: "al‸pha\nbeta\n", keys: "cw", expect: "al‸\nbeta\n", raw: true },
  ]);
});

test("VO.5 (ticket 7vdep2z4)", async (t) => {
  await cases(t, [
    { start: "‸alpha beta\n", keys: "de", expect: "‸ beta\n" },
    { start: "‸alpha beta\n", keys: "dfb", expect: "‸eta\n" },
    { start: "‸(a [b] c) d\n", keys: "d%", expect: "‸ d\n" },
  ]);
});

test("VO.6 (ticket 7vdep2z4)", async (t) => {
  await cases(t, [
    { start: "‸alpha beta\n", keys: "dtb", expect: "‸ beta\n" },
    { start: "alpha be‸ta\n", keys: "dTa", expect: "alpha ‸ta\n" },
  ]);
});

test("VO.7 (ticket 7vdep2z4)", async (t) => {
  await cases(t, [
    { start: "alpha be‸ta\n", keys: "db", expect: "alpha ‸ta\n" },
    { start: "alpha be‸ta\n", keys: "dge", expect: "alph‸ta\n" },
    { start: "alpha be‸ta\n", keys: "dFa", expect: "alph‸ta\n" },
  ]);
});

test("VO.8 (ticket 7vdep2z4)", async (t) => {
  await cases(t, [
    { start: "al‸pha beta\n", keys: "d$", expect: "al‸\n" },
    { start: "al‸pha beta\n", keys: "D", expect: "al‸\n" },
    { start: "al‸pha beta\n", keys: "C", expect: "al‸\n" },
  ]);
});

test("VO.9 (ticket 7vdep2z4)", async (t) => {
  await cases(t, [
    { start: "al‸pha\n\nbeta\n\ngamma\n", keys: "dj", expect: "‸gamma\n" },
    { start: "al‸pha\nbeta\ngamma\n", keys: "dj", expect: "‸gamma\n", raw: true },
    { start: "alpha\nbe‸ta\ngamma\n", keys: "dk", expect: "‸gamma\n", raw: true },
  ]);
});

test("VO.10 (ticket 7vdep2z4)", async (t) => {
  await cases(t, [
    { start: "al‸pha\nbeta\n", keys: "dd", expect: "‸" },
    { start: "alpha\n\nbe‸ta\n\ngamma\n", keys: "dd", expect: "alpha\n\n‸\ngamma\n" },
    { start: "alpha\nbe‸ta\ngamma\n", keys: "dd", expect: "alpha\n‸gamma\n", raw: true },
    { start: "alpha\nbe‸ta\ngamma\n", keys: "2dd", expect: "alpha\n‸", raw: true },
  ]);
});

test("VO.11 (ticket 7vdep2z4)", async (t) => {
  await cases(t, [
    { start: "one\n\nt‸wo\n\nthree\n", keys: "dd", expect: "one\n\n‸\nthree\n", after: emptyBetween },
  ]);
});

test("VO.12 (ticket 7vdep2z4)", async (t) => {
  await cases(t, [
    { start: "‸one\n\ntwo\n\nthree\n", keys: "2dd", expect: "‸\nthree\n" },
    { start: "‸one\n\ntwo\n\nthree\n", keys: "2dd", expect: "‸two\n\nthree\n", raw: true },
  ]);
});
