import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "./harness.js";

// Ticket g92jk6em. With vim keys on, in the rendered view, j and k move one line of a code
// fence and keep the column as stock vim does, a count works, and V selects lines of code. In
// the raw view every source line is a vim line. The columns are stock vim 9.2's, run with no
// vimrc on the fence's three lines: from column 13 of line 1, j gives line 2 at its last
// column, 10, then line 3 at column 13, and k goes back the same way; 2j gives line 3 at
// column 13.

const TEXT = "Before the fence.\n\n```js\nconst alpha = 1;\nlet b = 2;\nconst gamma = 3;\n```\n\nAfter the fence.\n";
const L1 = TEXT.indexOf("const alpha");
const L2 = TEXT.indexOf("let b");
const L3 = TEXT.indexOf("const gamma");
const BEFORE = { start: 0, end: "Before the fence.".length };
const AFTER = { start: TEXT.indexOf("After"), end: TEXT.indexOf("After") + "After the fence.".length };
const line = (start, text) => ({ start, end: start + text.length });

async function setup(t) {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  const file = await hub.create("f.md", TEXT);
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.session.send("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem("viewmark.vim", "1");` });
  await page.login();
  await page.open(file);
  await page.quiet();
  return { hub, page, file };
}

async function at(page, offset) {
  assert.equal(await page.clickOffset(offset), true, `no point at ${offset}`);
  await page.quiet();
  await page.key("Escape");
  await page.quiet();
  assert.equal((await page.caret()).focus, offset, `the click did not put the caret at ${offset}`);
}

async function press(page, keys) {
  for (const key of keys) await page.key(key);
  await page.quiet();
  return (await page.caret()).focus;
}

function within(offset, span, label) {
  assert.ok(offset >= span.start && offset <= span.end, `${label}: the caret is at ${offset}, ${JSON.stringify(TEXT.slice(offset, offset + 12))}, not in ${span.start} to ${span.end}, ${JSON.stringify(TEXT.slice(span.start, span.end))}`);
}

test("g92jk6em: with vim keys on, j and k move one line of a code fence and keep the column as stock vim does", async (t) => {
  const { page } = await setup(t);
  await at(page, L1 + 12);
  assert.equal(await press(page, ["j"]), L2 + 9, "j from column 13 of line 1");
  assert.equal(await press(page, ["j"]), L3 + 12, "j again, to line 3");
  assert.equal(await press(page, ["k"]), L2 + 9, "k from line 3");
  assert.equal(await press(page, ["k"]), L1 + 12, "k again, to line 1");
});

const MOVES = [
  { name: "k from the fence's first line goes to the paragraph before it", from: L1, key: "k", to: BEFORE },
  { name: "j from the paragraph before the fence lands on the fence's first line", from: 0, key: "j", to: line(L1, "const alpha = 1;") },
  { name: "j from the fence's last line goes to the paragraph after it", from: L3, key: "j", to: AFTER },
  { name: "k from the paragraph after the fence lands on the fence's last line", from: AFTER.start, key: "k", to: line(L3, "const gamma = 3;") },
];

for (const { name, from, key, to } of MOVES) {
  test(`g92jk6em: with vim keys on, ${name}`, async (t) => {
    const { page } = await setup(t);
    await at(page, from);
    within(await press(page, [key]), to, name);
  });
}

test("g92jk6em: with vim keys on, 2j in a code fence moves two lines", async (t) => {
  const { page } = await setup(t);
  await at(page, L1 + 12);
  assert.equal(await press(page, ["2", "j"]), L3 + 12, "2j from column 13 of line 1");
});

test("g92jk6em: with vim keys on, V on one line of a code fence, then gc, writes that line's range", async (t) => {
  const { hub, page, file } = await setup(t);
  await at(page, L2 + 2);
  for (const key of ["V", "g", "c"]) await page.key(key);
  await page.until(() => page.eval(`document.activeElement && document.activeElement.classList.contains("md-comment-body")`), "the note box");
  await page.type("One line.");
  await page.key("Enter", ["Ctrl"]);
  await page.quiet();
  const after = (await hub.show(file)).text;
  const fence = /```comment c1 (\S+)\n/.exec(after);
  assert.ok(fence, `no comment fence: ${JSON.stringify(after)}`);
  assert.ok(fence[1] === "2" || fence[1] === "2-2", `V on line 2 wrote the range ${fence[1]}`);
});

test("g92jk6em: with vim keys on, in the raw view, j moves one source line at a time, through the fence's own lines", async (t) => {
  const { page } = await setup(t);
  const toggle = await page.eval(`(() => { const r = document.querySelector("button.md-view-toggle").getBoundingClientRect(); return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 }; })()`);
  await page.click(toggle.x, toggle.y);
  await page.until(() => page.eval(`document.querySelector("#editor.md-source") != null`), "the raw view");
  await page.quiet();
  await at(page, 0);
  const starts = [];
  let from = 0;
  while ((from = TEXT.indexOf("\n", from) + 1) > 0 && from < TEXT.length) starts.push(from);
  for (const start of starts) assert.equal(await press(page, ["j"]), start, `j to the source line at ${start}, ${JSON.stringify(TEXT.slice(start, TEXT.indexOf("\n", start)))}`);
});
