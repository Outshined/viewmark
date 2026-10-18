import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "./harness.js";

// Ticket swhggkdt. With vim keys on, in Normal, Shift+↓ and Shift+↑ page down and up, as Ctrl-F
// and Ctrl-B do in stock vim (editing.md, R109). Stock vim's help lists <S-Down> and <PageDown>
// with CTRL-F, and <S-Up> and <PageUp> with CTRL-B. With vim keys off, they extend the selection
// (R70).

const TEXT = `${Array.from({ length: 60 }, (_, i) => `Paragraph ${String(i + 1).padStart(2, "0")} of the body.`).join("\n\n")}\n`;
const START = TEXT.indexOf("Paragraph 05") + 2;
const NEXT_END = TEXT.indexOf("Paragraph 06") + "Paragraph 06 of the body.".length;

async function setup(t, vim) {
  const hub = await startHub();
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await hub.close();
  });
  const file = await hub.create("long.md", TEXT);
  const page = new Page(browser.session, hub.port);
  await page.init();
  if (vim) await page.session.send("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem("viewmark.vim", "1");` });
  await page.login();
  return { hub, page, file };
}

// A fresh load, so the window is at the top, then the caret at START in Normal.
async function fromStart(page, file, vim) {
  await page.open(file);
  await page.quiet();
  assert.ok(await page.clickOffset(START), `no point at ${START}`);
  await page.quiet();
  if (vim) {
    await page.key("Escape");
    await page.quiet();
  }
  assert.equal((await page.caret()).focus, START, "the click did not put the caret at START");
}

async function press(page, key, mods = []) {
  await page.key(key, mods);
  await page.quiet();
  return page.caret();
}

test("swhggkdt: with vim keys on, in Normal, Shift+↓ goes where Ctrl-F does, more than one line, and Shift+↑ where Ctrl-B does, with the caret collapsed and nothing written", async (t) => {
  const { hub, page, file } = await setup(t, true);
  await fromStart(page, file, true);
  const byF = (await press(page, "f", ["Ctrl"])).focus;
  const byB = (await press(page, "b", ["Ctrl"])).focus;
  assert.ok(byF > NEXT_END, `Ctrl-F from paragraph 5 went to ${byF}, not past paragraph 6`);
  const before = await hub.show(file);
  await fromStart(page, file, true);
  let caret = await press(page, "↓", ["Shift"]);
  assert.equal(caret.focus, byF, `Shift+↓ went to ${caret.focus}, Ctrl-F to ${byF}`);
  assert.equal(caret.anchor, caret.focus, "Shift+↓ left a selection");
  caret = await press(page, "↑", ["Shift"]);
  assert.equal(caret.focus, byB, `Shift+↑ went to ${caret.focus}, Ctrl-B to ${byB}`);
  assert.equal(caret.anchor, caret.focus, "Shift+↑ left a selection");
  assert.equal(await page.eval(`document.querySelector(".md-vim-status").textContent`), "N");
  const after = await hub.show(file);
  assert.equal(after.text, TEXT, "the text changed");
  assert.equal(after.rev, before.rev, "an edit was written");
});

test("swhggkdt: with vim keys off, Shift+↓ and Shift+↑ extend the selection (R70)", async (t) => {
  const { page, file } = await setup(t, false);
  await fromStart(page, file, false);
  let caret = await press(page, "↓", ["Shift"]);
  assert.equal(caret.anchor, START, "Shift+↓ moved the anchor");
  assert.ok(caret.focus > START, `Shift+↓ did not extend the selection: ${caret.anchor} to ${caret.focus}`);
  caret = await press(page, "↑", ["Shift"]);
  assert.equal(caret.anchor, START, "Shift+↑ moved the anchor");
  assert.ok(caret.focus <= START, `Shift+↑ did not bring the selection back: ${caret.anchor} to ${caret.focus}`);
});
