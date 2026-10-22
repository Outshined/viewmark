import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "./harness.js";

// Ticket x5fxzp58. A step lands on the next drawn line, and the caret rect is on
// that line. End stays on the last drawn glyph of an open fence's opener. With
// vim keys on, ArrowLeft stays on the first letter of the function line.

const TEXT = ["para", "", "# Head", "", "next", "", "```js", "function f() {", "  return 1;", "}", "```", ""].join("\n");

function lineOf(doc, offset) {
  let start = offset;
  while (start > 0 && doc[start - 1] !== "\n") start -= 1;
  let end = offset;
  while (end < doc.length && doc[end] !== "\n") end += 1;
  return { start, end, text: doc.slice(start, end) };
}

async function setup(t, vim) {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  const file = await hub.create("caret.md", TEXT);
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  if (vim) await page.session.send("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem("viewmark.vim", "1");` });
  await page.login();
  await page.open(file);
  await page.quiet();
  return { page };
}

async function place(page, offset) {
  assert.equal(await page.clickOffset(offset), true, `no point at ${offset}`);
  await page.quiet();
}

function assertDrawn(caret, label) {
  assert.ok(caret && caret.rect, `${label}: no caret rect`);
  const height = caret.rect.bottom - caret.rect.top;
  assert.ok(height > 0, `${label}: caret height ${height}, rect ${JSON.stringify(caret.rect)}`);
  assert.equal(caret.rect.x === 0 && caret.rect.top === 0 && caret.rect.bottom === 0, false, `${label}: caret rect is the origin box`);
}

async function lineHolding(page, caret, label) {
  const y = (caret.rect.top + caret.rect.bottom) / 2;
  const lines = await page.eval(`[...document.querySelectorAll("#editor .md-line")].map((el) => {
    const r = el.getBoundingClientRect();
    return { text: el.textContent, top: r.top, bottom: r.bottom, height: r.height };
  })`);
  const line = lines.find((item) => item.height > 0 && y >= item.top - 1 && y <= item.bottom + 1);
  assert.ok(line, `${label}: no drawn line holds the caret at y ${y.toFixed(1)}`);
  return line;
}

test("x5fxzp58 vim off: arrows around a heading land on a drawn line", async (t) => {
  const { page } = await setup(t, false);
  const head = TEXT.indexOf("Head");
  const blankBefore = TEXT.indexOf("\n\n");
  const blankAfter = TEXT.indexOf("\n\n", head);
  await place(page, head);
  await page.key("ArrowDown");
  await page.quiet();
  let caret = await page.caret();
  assertDrawn(caret, "down after the heading");
  assert.notEqual(caret.focus, blankAfter + 1);
  assert.equal(lineOf(TEXT, caret.focus).text, "next");
  assert.match((await lineHolding(page, caret, "down after the heading")).text, /next/);

  await page.key("ArrowUp");
  await page.quiet();
  caret = await page.caret();
  assertDrawn(caret, "up onto the heading");
  assert.notEqual(caret.focus, blankAfter + 1);
  assert.match((await lineHolding(page, caret, "up onto the heading")).text, /Head/);

  await page.key("ArrowUp");
  await page.quiet();
  caret = await page.caret();
  assertDrawn(caret, "up onto the paragraph");
  assert.notEqual(caret.focus, blankBefore + 1);
  assert.equal(lineOf(TEXT, caret.focus).text, "para");
  assert.match((await lineHolding(page, caret, "up onto the paragraph")).text, /para/);

  await place(page, head);
  await page.key("ArrowLeft");
  await page.key("ArrowLeft");
  await page.key("ArrowLeft");
  await page.quiet();
  caret = await page.caret();
  assertDrawn(caret, "left off the heading");
  assert.notEqual(caret.focus, blankBefore + 1);
  assert.equal(lineOf(TEXT, caret.focus).text, "para");
  assert.match((await lineHolding(page, caret, "left off the heading")).text, /para/);
});

test("x5fxzp58 vim off: fence End stays on the opener and arrows leave the breaks", async (t) => {
  const { page } = await setup(t, false);
  const opener = TEXT.indexOf("```js");
  const openBreak = opener + "```js".length;
  const fn = TEXT.indexOf("function");
  const brace = TEXT.indexOf("}");
  const braceBreak = brace + 1;
  const closer = TEXT.lastIndexOf("```");
  assert.equal(TEXT[openBreak], "\n");
  assert.equal(TEXT[braceBreak], "\n");

  await place(page, fn);
  await page.key("ArrowUp");
  await page.quiet();
  let caret = await page.caret();
  assertDrawn(caret, "up onto the opener");
  assert.equal(lineOf(TEXT, caret.focus).text, "```js");
  assert.match((await lineHolding(page, caret, "up onto the opener")).text, /```js/);

  await page.key("Home");
  await page.quiet();
  caret = await page.caret();
  assertDrawn(caret, "home on the opener");
  assert.equal(lineOf(TEXT, caret.focus).text, "```js");
  assert.match((await lineHolding(page, caret, "home on the opener")).text, /```js/);

  await page.key("End");
  await page.quiet();
  caret = await page.caret();
  assertDrawn(caret, "end on the opener");
  assert.notEqual(caret.focus, fn);
  assert.ok(caret.focus <= openBreak, `end left the opener at ${caret.focus}`);
  assert.match((await lineHolding(page, caret, "end on the opener")).text, /```js/);

  await place(page, fn);
  await page.key("ArrowLeft");
  await page.quiet();
  caret = await page.caret();
  assertDrawn(caret, "left off the function line");
  assert.equal(lineOf(TEXT, caret.focus).text, "```js");
  assert.match((await lineHolding(page, caret, "left off the function line")).text, /```js/);

  await place(page, brace);
  await page.key("ArrowDown");
  await page.quiet();
  caret = await page.caret();
  assertDrawn(caret, "down off the last code line");
  assert.notEqual(caret.focus, braceBreak);
  assert.equal(lineOf(TEXT, caret.focus).text, "```");
  assert.ok(caret.focus >= closer);
  assert.match((await lineHolding(page, caret, "down off the last code line")).text, /```/);
});

test("x5fxzp58 vim on: j and k skip the blank after a heading, and ArrowLeft stays on the function letter", async (t) => {
  const { page } = await setup(t, true);
  const head = TEXT.indexOf("Head");
  const blankAfter = TEXT.indexOf("\n\n", head);
  const fn = TEXT.indexOf("function");
  await place(page, head);
  await page.key("Escape");
  await page.quiet();
  await page.key("ArrowDown");
  await page.quiet();
  let caret = await page.caret();
  assertDrawn(caret, "vim down after the heading");
  assert.notEqual(caret.focus, blankAfter + 1);
  assert.equal(lineOf(TEXT, caret.focus).text, "next");
  assert.match((await lineHolding(page, caret, "vim down after the heading")).text, /next/);

  await place(page, TEXT.indexOf("next"));
  await page.key("Escape");
  await page.quiet();
  await page.key("ArrowUp");
  await page.quiet();
  caret = await page.caret();
  assertDrawn(caret, "vim up onto the heading");
  assert.notEqual(caret.focus, blankAfter + 1);
  assert.match(lineOf(TEXT, caret.focus).text, /Head/);
  assert.match((await lineHolding(page, caret, "vim up onto the heading")).text, /Head/);

  await place(page, fn);
  await page.key("Escape");
  await page.quiet();
  await page.key("ArrowLeft");
  await page.quiet();
  caret = await page.caret();
  assert.equal(caret.focus, fn);
  assertDrawn(caret, "vim left on the function letter");
  assert.match((await lineHolding(page, caret, "vim left on the function letter")).text, /function/);
});
