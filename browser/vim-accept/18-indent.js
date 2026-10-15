import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "../harness.js";

// The flag is read once, when the editor is created. A later write does not turn keys on.
const VIM = "viewmark.vim";
const TICKET = "7vdep2z4";
const CTRL_T = { key: "t", modifiers: ["Ctrl"] };
const CTRL_D = { key: "d", modifiers: ["Ctrl"] };

function marks(text) {
  const focusMark = text.indexOf("‸");
  const anchorMark = text.indexOf("«");
  if (focusMark < 0) throw new Error("missing focus mark");
  const focus = focusMark - (anchorMark >= 0 && anchorMark < focusMark ? 1 : 0);
  const anchor = anchorMark < 0 ? focus : anchorMark - (focusMark < anchorMark ? 1 : 0);
  return { body: text.replace(/[‸«]/g, ""), focus, anchor };
}

function markedAt(body, focus, anchor) {
  if (!Number.isInteger(focus)) return body;
  const spots = [];
  if (Number.isInteger(anchor) && anchor !== focus) spots.push([anchor, "«"]);
  spots.push([focus, "‸"]);
  spots.sort((a, b) => a[0] - b[0] || (a[1] === "«" ? -1 : 1));
  let out = "";
  let prev = 0;
  for (const [at, mark] of spots) {
    const i = Math.max(0, Math.min(body.length, at));
    out += body.slice(prev, i) + mark;
    prev = i;
  }
  return out + body.slice(prev);
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
  // Runs on the next document, before its scripts, so the editor is created with the flag on.
  await page.session.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `localStorage.setItem(${JSON.stringify(VIM)}, "1");`,
  });
  await page.login();
  assert.equal(await page.eval(`localStorage.getItem(${JSON.stringify(VIM)})`), "1");
  return { hub, page };
}

async function mode(page) {
  return page.eval(`document.querySelector(".md-vim-status").textContent`);
}

async function press(page, keys) {
  for (const key of keys) {
    if (typeof key === "string") await page.key(key);
    else await page.key(key.key, key.modifiers);
  }
  await page.quiet();
}

// Two presses of an operator are one splice, so the rev moves by one.
// A command that writes no bytes does not publish.
async function accept(hub, page, file, start, keys, end, { rev = 1, status = "N" } = {}) {
  const from = marks(start);
  const to = marks(end);
  await hub.create(file, from.body);
  await page.open(file);
  assert.equal(await page.clickOffset(from.focus), true, `${file} no point at ${from.focus}`);
  await page.quiet();
  const placed = await page.caret();
  assert.equal(placed.focus, from.focus, `${file} click focus`);
  assert.equal(placed.anchor, from.anchor, `${file} click anchor`);
  assert.equal(await mode(page), "N", `${file} before the command`);
  const before = await hub.show(file);
  assert.equal(before.text, from.body, `${file} before`);
  await press(page, keys);
  const after = await hub.show(file);
  const caret = await page.caret();
  const snap = markedAt(after.text, caret && caret.focus, caret && caret.anchor);
  const detail = `${file} got ${JSON.stringify(snap)} rev ${after.rev} status ${JSON.stringify(await mode(page))}`;
  assert.equal(after.text, to.body, detail);
  assert.equal(caret.focus, to.focus, detail);
  assert.equal(caret.anchor, to.anchor, detail);
  assert.equal(after.rev, before.rev + rev, detail);
  assert.equal(await mode(page), status, detail);
}

async function cell(t, cases) {
  const { hub, page } = await setup(t);
  const errors = [];
  for (const item of cases) {
    try {
      await accept(hub, page, item.file, item.start, item.keys, item.end, item.opts);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  assert.equal(errors.length, 0, errors.join("\n"));
}

test(`VD.1 (ticket ${TICKET})`, async (t) => {
  await cell(t, [
    { file: "vd1.md", start: "al‸pha\n", keys: [">", ">"], end: "\t‸alpha\n" },
  ]);
});

test(`VD.2 (ticket ${TICKET})`, async (t) => {
  await cell(t, [
    { file: "vd2-bullet.md", start: "- a\n- ‸b\n", keys: [">", ">"], end: "- a\n\t‸- b\n" },
    { file: "vd2-ordered.md", start: "1. a\n2. ‸b\n", keys: [">", ">"], end: "1. a\n\t‸1. b\n" },
  ]);
});

test(`VD.3 (ticket ${TICKET})`, async (t) => {
  const spaces = "  al‸pha\n";
  const top = "- ‸a\n";
  await cell(t, [
    { file: "vd3-tab.md", start: "\tal‸pha\n", keys: ["<", "<"], end: "‸alpha\n" },
    { file: "vd3-item.md", start: "- a\n\t- ‸b\n", keys: ["<", "<"], end: "- a\n- ‸b\n" },
    { file: "vd3-spaces.md", start: spaces, keys: ["<", "<"], end: spaces, opts: { rev: 0 } },
    { file: "vd3-top.md", start: top, keys: ["<", "<"], end: top, opts: { rev: 0 } },
  ]);
});

test(`VD.4 (ticket ${TICKET})`, async (t) => {
  const lines = "‸a\nb\nc\nd\n";
  await cell(t, [
    { file: "vd4-count.md", start: lines, keys: ["3", ">", ">"], end: "\t‸a\n\tb\n\tc\nd\n" },
    { file: "vd4-motion.md", start: lines, keys: [">", "j"], end: "\t‸a\n\tb\nc\nd\n" },
    {
      file: "vd4-para.md",
      start: "one\n\nal‸pha\nbeta\n\ntwo\n",
      keys: [">", "i", "p"],
      end: "one\n\n\t‸alpha\n\tbeta\n\ntwo\n",
    },
  ]);
});

test(`VD.5 (ticket ${TICKET})`, async (t) => {
  await cell(t, [
    { file: "vd5-in.md", start: "al‸pha\n", keys: ["i", CTRL_T], end: "\tal‸pha\n", opts: { status: "I" } },
    { file: "vd5-out.md", start: "\tal‸pha\n", keys: ["i", CTRL_D], end: "al‸pha\n", opts: { status: "I" } },
  ]);
});

test(`VD.6 (ticket ${TICKET})`, async (t) => {
  const plain = "al‸pha\n";
  await cell(t, [
    { file: "vd6-item.md", start: "- a\n\t\t- ‸b\n", keys: ["=", "="], end: "- a\n\t‸- b\n" },
    { file: "vd6-plain.md", start: plain, keys: ["=", "="], end: plain, opts: { rev: 0 } },
  ]);
});

test(`VD.7 (ticket ${TICKET})`, async (t) => {
  const item = "- a\n- ‸b\n";
  await cell(t, [
    { file: "vd7-after.md", start: item, keys: ["y", "y", "]", "p"], end: "- a\n- b\n\t‸- b\n" },
    { file: "vd7-before.md", start: item, keys: ["y", "y", "[", "p"], end: "- a\n\t‸- b\n- b\n" },
  ]);
});
