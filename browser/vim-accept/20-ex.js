import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "../harness.js";

// The flag is read once, when the editor is created. A later write does not turn keys on.
const VIM = "viewmark.vim";
const TICKET = "7vdep2z4";
const TIMEOUT = 180_000;

function cell(id) {
  return `${id} (ticket ${TICKET})`;
}

// ‸ is the focus and « is the anchor. Neither character is part of the document.
function marked(spec) {
  let focus = null;
  let anchor = null;
  let text = "";
  for (const ch of spec) {
    if (ch === "‸") focus = text.length;
    else if (ch === "«") anchor = text.length;
    else text += ch;
  }
  if (focus == null) throw new Error(`missing caret in ${JSON.stringify(spec)}`);
  if (anchor == null) anchor = focus;
  return { text, focus, anchor };
}

function prefixes(word) {
  const out = [];
  for (let i = 1; i <= word.length; i += 1) out.push(word.slice(0, i));
  return out;
}

function lastChangedLine(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  let last = 0;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if ((a[i] || "") !== (b[i] || "")) last = i;
  }
  return last;
}

function firstNonBlank(text, line) {
  const lines = text.split("\n");
  let offset = 0;
  for (let i = 0; i < line; i += 1) offset += lines[i].length + 1;
  const body = lines[line] || "";
  const lead = /^[ \t]*/.exec(body);
  return offset + (lead ? lead[0].length : 0);
}

async function setup(t, files) {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  for (const [file, text] of Object.entries(files)) await hub.create(file, text);
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  // Runs on the next document, before its scripts, so the editor is created with the flag on.
  await page.session.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `localStorage.setItem(${JSON.stringify(VIM)}, "1");`,
  });
  await page.login();
  return { hub, page };
}

function lineValue(page) {
  return page.eval(`(() => {
    const node = document.querySelector("input.md-vim-line");
    return node ? node.value : null;
  })()`);
}

function vimStatus(page) {
  return page.eval(`(() => {
    const node = document.querySelector(".md-vim-status");
    return node ? node.textContent : "";
  })()`);
}

async function place(page, offset) {
  assert.ok(await page.clickOffset(offset), `no point at ${offset}`);
  await page.quiet();
  const caret = await page.caret();
  assert.equal(caret.focus, offset, `click left the caret at ${caret.focus}, not ${offset}`);
  assert.equal(caret.anchor, offset, `click left an anchor at ${caret.anchor}`);
}

async function openMarked(page, file, spec) {
  const mark = marked(spec);
  await page.open(file);
  assert.equal(await page.eval(`localStorage.getItem(${JSON.stringify(VIM)})`), "1");
  await place(page, mark.focus);
  return mark;
}

// Colon opens the ex line. Each character is its own key, then Enter submits.
async function typeEx(page, command) {
  await page.key(":");
  await page.quiet();
  assert.equal(await lineValue(page), ":", `colon opened ${JSON.stringify(await lineValue(page))} for ${command}`);
  for (const ch of command) await page.key(ch);
  assert.equal(await lineValue(page), `:${command}`, `ex line ${JSON.stringify(await lineValue(page))}`);
  await page.key("Enter");
  await page.quiet();
  assert.equal(await lineValue(page), null, `ex line stayed open after ${command}`);
}

async function substitute(page, hub, file, spec, command, want) {
  const mark = await openMarked(page, file, spec);
  const before = await hub.show(file);
  assert.equal(before.text, mark.text, file);
  await typeEx(page, command);
  const now = await hub.show(file);
  assert.equal(now.text, want, `${command} got ${JSON.stringify(now.text)}`);
  assert.equal(now.rev, before.rev + 1, `${command} rev ${before.rev} -> ${now.rev}`);
  const at = firstNonBlank(want, lastChangedLine(before.text, want));
  const caret = await page.caret();
  assert.equal(caret.focus, at, `${command} caret ${caret.focus} is not the first non-blank ${at}`);
  assert.equal(caret.anchor, caret.focus, command);
  assert.equal(await vimStatus(page), "N", command);
}

async function refused(page, hub, file, command) {
  const before = await hub.show(file);
  await typeEx(page, command);
  const now = await hub.show(file);
  assert.equal(now.text, before.text, `${command} got ${JSON.stringify(now.text)}`);
  assert.equal(now.rev, before.rev, `${command} rev ${before.rev} -> ${now.rev}`);
  assert.equal(await vimStatus(page), "N", command);
}

test(cell("VE.1"), { timeout: TIMEOUT }, async (t) => {
  const start = "banana\nalpha\n";
  const { hub, page } = await setup(t, { "s.md": start, "sg.md": start });
  await substitute(page, hub, "s.md", "‸banana\nalpha\n", "s/a/o/", "bonana\nalpha\n");
  await substitute(page, hub, "sg.md", "‸banana\nalpha\n", "s/a/o/g", "bonono\nalpha\n");
});

test(cell("VE.2"), { timeout: TIMEOUT }, async (t) => {
  const start = "banana\nalpha\n";
  const { hub, page } = await setup(t, { "all.md": start, "first.md": start });
  await substitute(page, hub, "all.md", "‸banana\nalpha\n", "%s/a/o/g", "bonono\nolpho\n");
  await substitute(page, hub, "first.md", "‸banana\nalpha\n", "%s/a/o/", "bonana\nalpha\n");
});

test(cell("VE.3"), { timeout: TIMEOUT }, async (t) => {
  const start = "banana\nalpha\n";
  const names = prefixes("substitute");
  const files = {};
  for (const name of names) files[`${name}.md`] = start;
  const { hub, page } = await setup(t, files);
  for (const name of names) {
    await substitute(page, hub, `${name}.md`, "‸banana\nalpha\n", `${name}/a/o/`, "bonana\nalpha\n");
  }
});

test(cell("VE.4"), { timeout: TIMEOUT }, async (t) => {
  const { hub, page } = await setup(t, {
    "slash.md": "a/xb\n",
    "percent.md": "a\\%b\n",
    "literal.md": "ab\n",
  });
  await substitute(page, hub, "slash.md", "‸a/xb\n", "s/\\/x/y/", "ayb\n");
  await substitute(page, hub, "percent.md", "‸a\\%b\n", "s/\\%/y/", "ayb\n");
  await substitute(page, hub, "literal.md", "‸ab\n", "s/a/$1&\\1/", "$1&\\1b\n");
});

test(cell("VE.5"), { timeout: TIMEOUT }, async (t) => {
  const file = "a.md";
  const start = "banana\nalpha\n";
  const { hub, page } = await setup(t, { [file]: start });
  await openMarked(page, file, "‸banana\nalpha\n");
  for (const command of ["s/a/b/\\%", "s/a/b", "s//b/", "2,3s/a/b/", ".,$s/a/b/"]) {
    await refused(page, hub, file, command);
  }
  const before = await hub.show(file);
  assert.equal(await vimStatus(page), "N");
  await page.key("v");
  await page.quiet();
  assert.equal(await vimStatus(page), "V");
  await page.key(":");
  await page.quiet();
  const now = await hub.show(file);
  assert.equal(await lineValue(page), null, "colon in visual opened the ex line");
  assert.equal(now.text, before.text, `: visual got ${JSON.stringify(now.text)}`);
  assert.equal(now.rev, before.rev, ": visual moved rev");
  assert.equal(await vimStatus(page), "N");
});

test(cell("VE.6"), { timeout: TIMEOUT }, async (t) => {
  const start = "alpha\nbeta\ngamma\n";
  const { hub, page } = await setup(t, { "line.md": start, "all.md": start });

  await openMarked(page, "line.md", "alpha\nbe‸ta\ngamma\n");
  const lineBefore = await hub.show("line.md");
  await typeEx(page, "d");
  const line = await hub.show("line.md");
  assert.equal(line.text, "", `d got ${JSON.stringify(line.text)}`);
  assert.equal(line.rev, lineBefore.rev + 1, `d rev ${lineBefore.rev} -> ${line.rev}`);
  const lineCaret = await page.caret();
  assert.equal(lineCaret.focus, 0, `d caret ${lineCaret.focus}`);
  assert.equal(lineCaret.anchor, lineCaret.focus);
  assert.equal(await vimStatus(page), "N");

  await openMarked(page, "all.md", "alpha\nbe‸ta\ngamma\n");
  const allBefore = await hub.show("all.md");
  await typeEx(page, "%d");
  const all = await hub.show("all.md");
  assert.equal(all.text, "", `%d got ${JSON.stringify(all.text)}`);
  assert.equal(all.rev, allBefore.rev + 1, `%d rev ${allBefore.rev} -> ${all.rev}`);
  const allCaret = await page.caret();
  assert.equal(allCaret.focus, 0, `%d caret ${allCaret.focus}`);
  assert.equal(allCaret.anchor, 0);
  assert.equal(await vimStatus(page), "N");
});

test(cell("VE.7"), { timeout: TIMEOUT }, async (t) => {
  const { hub, page } = await setup(t, { "join.md": "alpha\nbeta\n", "yank.md": "alpha\n" });

  await openMarked(page, "join.md", "al‸pha\nbeta\n");
  const joinBefore = await hub.show("join.md");
  await typeEx(page, "j");
  const joined = await hub.show("join.md");
  assert.equal(joined.text, "alpha beta\n", `j got ${JSON.stringify(joined.text)}`);
  assert.equal(joined.rev, joinBefore.rev + 1, `j rev ${joinBefore.rev} -> ${joined.rev}`);
  assert.equal(await vimStatus(page), "N");

  await openMarked(page, "yank.md", "‸alpha\n");
  const yankBefore = await hub.show("yank.md");
  await typeEx(page, "y");
  const yanked = await hub.show("yank.md");
  assert.equal(yanked.text, "alpha\n", `y got ${JSON.stringify(yanked.text)}`);
  assert.equal(yanked.rev, yankBefore.rev, `y rev ${yankBefore.rev} -> ${yanked.rev}`);
  assert.equal(await vimStatus(page), "N");
  await page.key("p");
  await page.quiet();
  const pasted = await hub.show("yank.md");
  assert.equal(pasted.text, "alpha\nalpha\n", `p got ${JSON.stringify(pasted.text)}`);
  assert.equal(pasted.rev, yanked.rev + 1, `p rev ${yanked.rev} -> ${pasted.rev}`);
  const caret = await page.caret();
  assert.equal(caret.focus, "alpha\n".length, `p caret ${caret.focus}`);
  assert.equal(caret.anchor, caret.focus);
});

test(cell("VE.8"), { timeout: TIMEOUT }, async (t) => {
  const file = "a.md";
  const { hub, page } = await setup(t, { [file]: "banana\n" });
  await openMarked(page, file, "‸banana\n");

  await page.key("x");
  await page.quiet();
  let cur = await hub.show(file);
  assert.equal(cur.text, "anana\n", `x got ${JSON.stringify(cur.text)}`);
  const edited = cur.text;
  const editedCaret = await page.caret();

  const undoFrom = cur.rev;
  await page.key("u");
  await page.quiet();
  cur = await hub.show(file);
  assert.equal(cur.text, "banana\n", `u got ${JSON.stringify(cur.text)}`);
  const undone = { text: cur.text, caret: await page.caret(), revDelta: cur.rev - undoFrom };
  assert.equal(await vimStatus(page), "N");

  // A redo is waiting. :re must not take it.
  const reFrom = cur;
  await typeEx(page, "re");
  cur = await hub.show(file);
  assert.equal(cur.text, reFrom.text, `re got ${JSON.stringify(cur.text)}`);
  assert.equal(cur.rev, reFrom.rev, "re moved rev");
  assert.equal(await vimStatus(page), "N");

  await place(page, 0);
  await page.key("x");
  await page.quiet();
  cur = await hub.show(file);
  assert.equal(cur.text, edited, `x before :u got ${JSON.stringify(cur.text)}`);
  const exUFrom = cur.rev;
  await typeEx(page, "u");
  cur = await hub.show(file);
  assert.equal(cur.text, undone.text, `:u got ${JSON.stringify(cur.text)}`);
  assert.equal(cur.rev - exUFrom, undone.revDelta, ":u rev");
  let caret = await page.caret();
  assert.equal(caret.focus, undone.caret.focus, `:u caret ${caret.focus}`);
  assert.equal(caret.anchor, undone.caret.anchor, ":u anchor");
  assert.equal(await vimStatus(page), "N");

  await place(page, 0);
  await page.key("x");
  await page.quiet();
  cur = await hub.show(file);
  assert.equal(cur.text, edited);
  const exUndoFrom = cur.rev;
  await typeEx(page, "undo");
  cur = await hub.show(file);
  assert.equal(cur.text, undone.text, `:undo got ${JSON.stringify(cur.text)}`);
  assert.equal(cur.rev - exUndoFrom, undone.revDelta, ":undo rev");
  caret = await page.caret();
  assert.equal(caret.focus, undone.caret.focus, `:undo caret ${caret.focus}`);
  assert.equal(caret.anchor, undone.caret.anchor, ":undo anchor");
  assert.equal(await vimStatus(page), "N");

  const again = cur;
  await typeEx(page, "re");
  cur = await hub.show(file);
  assert.equal(cur.text, again.text, `re after undo got ${JSON.stringify(cur.text)}`);
  assert.equal(cur.rev, again.rev, "re after undo moved rev");
  assert.equal(await vimStatus(page), "N");

  const redFrom = cur.rev;
  await typeEx(page, "red");
  cur = await hub.show(file);
  assert.equal(cur.text, edited, `:red got ${JSON.stringify(cur.text)}`);
  const redDelta = cur.rev - redFrom;
  caret = await page.caret();
  assert.equal(caret.focus, editedCaret.focus, `:red caret ${caret.focus}`);
  assert.equal(caret.anchor, editedCaret.anchor, ":red anchor");
  assert.equal(await vimStatus(page), "N");

  await page.key("u");
  await page.quiet();
  cur = await hub.show(file);
  assert.equal(cur.text, undone.text, `u before :redo got ${JSON.stringify(cur.text)}`);
  const redoFrom = cur.rev;
  await typeEx(page, "redo");
  cur = await hub.show(file);
  assert.equal(cur.text, edited, `:redo got ${JSON.stringify(cur.text)}`);
  assert.equal(cur.rev - redoFrom, redDelta, ":redo rev");
  caret = await page.caret();
  assert.equal(caret.focus, editedCaret.focus, `:redo caret ${caret.focus}`);
  assert.equal(caret.anchor, editedCaret.anchor, ":redo anchor");
  assert.equal(await vimStatus(page), "N");

  await page.key("u");
  await page.quiet();
  cur = await hub.show(file);
  assert.equal(cur.text, undone.text, `u before Ctrl+R got ${JSON.stringify(cur.text)}`);
  const ctrlFrom = cur.rev;
  await page.key("r", ["Ctrl"]);
  await page.quiet();
  cur = await hub.show(file);
  assert.equal(cur.text, edited, `Ctrl+R got ${JSON.stringify(cur.text)}`);
  assert.equal(cur.rev - ctrlFrom, redDelta, "Ctrl+R rev");
  caret = await page.caret();
  assert.equal(caret.focus, editedCaret.focus, `Ctrl+R caret ${caret.focus}`);
  assert.equal(caret.anchor, editedCaret.anchor, "Ctrl+R anchor");
});

test(cell("VE.9"), { timeout: TIMEOUT }, async (t) => {
  const file = "a.md";
  const { hub, page } = await setup(t, { [file]: "banana\nalpha\n" });
  await openMarked(page, file, "‸banana\nalpha\n");
  for (const command of [
    "set", "sort", "start", "w", "q", "q!", "wq", "e",
    "g/a/d", "v/a/d", "norm x", "noh", "map", "reg", "delm a", "!ls",
  ]) {
    await refused(page, hub, file, command);
  }
});

test(cell("VE.10"), { timeout: TIMEOUT }, async (t) => {
  const { hub, page } = await setup(t, { "a.md": "  banana\n" });
  await substitute(page, hub, "a.md", "  ‸banana\n", "s/a/o/", "  bonana\n");
});
