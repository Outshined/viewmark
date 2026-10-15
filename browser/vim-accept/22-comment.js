import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "../harness.js";

// ‸ is the focus and « is the anchor. Neither character is stored.
const VIM = "viewmark.vim";

function parse(text) {
  let bytes = "";
  let anchor = null;
  let focus = null;
  for (const ch of text) {
    if (ch === "«") {
      if (anchor != null) throw new Error(`two anchors in ${JSON.stringify(text)}`);
      anchor = bytes.length;
    } else if (ch === "‸") {
      if (focus != null) throw new Error(`two carets in ${JSON.stringify(text)}`);
      focus = bytes.length;
    } else bytes += ch;
  }
  if (focus == null) throw new Error(`no caret in ${JSON.stringify(text)}`);
  if (anchor == null) anchor = focus;
  return { bytes, anchor, focus };
}

function show(doc, focus, anchor) {
  if (!Number.isInteger(focus)) return `(no caret ${focus}/${anchor})`;
  const markAnchor = anchor === focus ? null : anchor;
  let out = "";
  for (let i = 0; i <= doc.length; i += 1) {
    if (markAnchor === i) out += "«";
    if (focus === i) out += "‸";
    if (i < doc.length) out += doc[i];
  }
  return out;
}

async function setup(t, files) {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  const docs = typeof files === "string" ? { "a.md": files } : files;
  for (const [name, text] of Object.entries(docs)) await hub.create(name, text);
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  // The flag is read when the editor is created. Set it before the first navigation.
  await page.session.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `localStorage.setItem(${JSON.stringify(VIM)}, "1");`,
  });
  await page.login();
  assert.equal(await page.eval(`localStorage.getItem(${JSON.stringify(VIM)})`), "1");
  return { hub, page };
}

async function snap(page, hub, file) {
  const shown = await hub.show(file);
  const caret = await page.caret();
  const focus = caret && Number.isInteger(caret.focus) ? caret.focus : null;
  const anchor = caret && Number.isInteger(caret.anchor) ? caret.anchor : null;
  const status = await page.eval(`document.querySelector("span.md-vim-status") && document.querySelector("span.md-vim-status").textContent`);
  const block = await page.eval(`document.getElementById("editor").classList.contains("md-vim-block")`);
  return { ...shown, focus, anchor, status, block, picture: show(shown.text, focus, anchor == null ? focus : anchor) };
}

function detail(got) {
  return `got ${JSON.stringify(got.picture)} status ${got.status} block ${got.block} rev ${got.rev}`;
}

async function place(page, offset) {
  assert.equal(await page.clickOffset(offset), true, `no point at ${offset}`);
  await page.quiet();
  const caret = await page.caret();
  assert.equal(caret.focus, offset, `caret ${caret && caret.focus} after click at ${offset}`);
  assert.equal(caret.anchor, offset, `anchor ${caret && caret.anchor} after click at ${offset}`);
}

async function begin(page, hub, file, start) {
  await page.open(file);
  await page.until(() => page.eval(`!!document.querySelector("span.md-vim-status")`), "vim status");
  const want = parse(start);
  const shown = await hub.show(file);
  assert.equal(shown.text, want.bytes, `${file} bytes`);
  await place(page, want.focus);
  const status = await page.eval(`document.querySelector("span.md-vim-status").textContent`);
  assert.equal(status, "N", `status ${status} after placing ${start}`);
  return shown.rev;
}

// A span is one press per character. A comma separates presses.
async function keys(page, script) {
  for (const part of script.split(",")) {
    const token = part.trim();
    const names = token === "Backspace" || token === "Delete" ? [token] : [...token];
    for (const name of names) {
      await page.key(name);
      await page.quiet();
    }
  }
}

async function emptyNoteFocused(page) {
  const focused = await page.eval(`(() => {
    const el = document.activeElement;
    return !!el && el.tagName === "TEXTAREA" && el.classList.contains("md-comment-body") && el.value === "";
  })()`);
  assert.equal(focused, true, "the empty note is not focused");
}

test("visual gc adds a comment", async (t) => {
  const { hub, page } = await setup(t, {
    "word.md": "alpha beta\n",
    "line.md": "alpha beta\n",
    "item.md": "- item\n",
  });

  let rev = await begin(page, hub, "word.md", "‸alpha beta\n");
  await keys(page, "v, e, g, c");
  const word = await snap(page, hub, "word.md");
  assert.equal(word.text, "{c1}alpha{/c1} beta\n\n```comment c1\n\n```\n", detail(word));
  assert.equal(word.status, "V", detail(word));
  assert.equal(word.rev, rev + 1, detail(word));
  await emptyNoteFocused(page);

  rev = await begin(page, hub, "line.md", "‸alpha beta\n");
  await keys(page, "V, g, c");
  const line = await snap(page, hub, "line.md");
  assert.equal(line.text, "{c1}alpha beta{/c1}\n\n```comment c1\n\n```\n", detail(line));
  assert.equal(line.status, "VL", detail(line));
  assert.equal(line.rev, rev + 1, detail(line));
  await emptyNoteFocused(page);

  rev = await begin(page, hub, "item.md", "‸- item\n");
  await keys(page, "v, g, c");
  const item = await snap(page, hub, "item.md");
  assert.equal(item.text, "- item\n", detail(item));
  assert.equal(item.rev, rev, detail(item));
  assert.equal(item.status, "V", detail(item));
});

async function editorFocused(page) {
  const focused = await page.eval(`document.activeElement === document.getElementById("editor")`);
  assert.equal(focused, true, "the editor is not focused");
}

async function noCurrentCard(page) {
  const current = await page.eval(`!!document.querySelector(".md-comment-current")`);
  assert.equal(current, false, "a comment card is current");
}

async function wordMoves(page) {
  const before = await page.caret();
  assert.equal(Number.isInteger(before && before.focus), true, `no caret before w ${JSON.stringify(before)}`);
  await page.key("w");
  await page.quiet();
  const after = await page.caret();
  assert.equal(Number.isInteger(after && after.focus), true, `no caret after w ${JSON.stringify(after)}`);
  assert.notEqual(after.focus, before.focus, `w left the caret at ${before.focus}`);
}

test("ctrl-enter after visual gc returns to the editor", async (t) => {
  const { hub, page } = await setup(t, "alpha beta gamma\n");
  await begin(page, hub, "a.md", "‸alpha beta gamma\n");
  await keys(page, "v, e, g, c");
  await emptyNoteFocused(page);
  const drafting = await snap(page, hub, "a.md");
  assert.equal(drafting.status, "V", detail(drafting));
  await page.type("one");
  await page.quiet();
  await page.key("Enter", ["Ctrl"]);
  await page.quiet();
  await editorFocused(page);
  await noCurrentCard(page);
  const saved = await snap(page, hub, "a.md");
  assert.equal(saved.status, "N", detail(saved));
  assert.match(saved.text, /\none\n/);
  await wordMoves(page);

  await keys(page, "v, e, g, c");
  await emptyNoteFocused(page);
  await page.type("two");
  await page.quiet();
  await page.key("Enter", ["Ctrl"]);
  await page.quiet();
  const both = await snap(page, hub, "a.md");
  assert.equal(both.status, "N", detail(both));
  assert.match(both.text, /\none\n/);
  assert.match(both.text, /\ntwo\n/);
  await editorFocused(page);
  await noCurrentCard(page);
  await wordMoves(page);
});
