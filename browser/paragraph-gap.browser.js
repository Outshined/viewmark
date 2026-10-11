import test from "node:test";
import assert from "node:assert/strict";
import { REPO, USER, cli, launchBrowser, Page, startHub } from "./harness.js";

// Ticket yjd3apk5, the Acceptance section of its body. In formatted text the blank line between
// two paragraphs is padding, not a line (R7): it takes no height and the caret never stops on it.
// Enter at the end of a paragraph writes that blank line (R24), and the caret's line is drawn
// directly under the paragraph. The cells check bytes and offsets; this file checks the drawing.
// Every action is a real key or mouse event.

const TOGGLE = "#editor button.md-view-toggle";

async function setup(t, docs) {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  for (const [name, text] of Object.entries(docs)) await hub.create(name, text);
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.login();
  return { hub, page };
}

async function open(page, file, offset) {
  await page.open(file);
  await page.quiet();
  assert.ok(await page.clickOffset(offset), `no point for offset ${offset}`);
  await page.quiet();
}

async function bytes(hub, file) {
  const out = await cli(hub.port, ["--user", USER, "--repo", REPO, "show", file]);
  assert.equal(out.code, 0, out.stderr);
  return out.stdout;
}

// Each drawn line of the editor, top to bottom, with its text and box.
const lines = (page) => page.eval(`[...document.querySelectorAll("#editor .md-line")].map((el) => {
  const r = el.getBoundingClientRect();
  return { text: el.textContent, top: r.top, bottom: r.bottom, height: r.height };
})`);

const lineOf = (all, text) => {
  const found = all.find((l) => l.text === text);
  assert.ok(found, `no line ${JSON.stringify(text)} in ${JSON.stringify(all.map((l) => l.text))}`);
  return found;
};

const middle = (box) => (box.top + box.bottom) / 2;

// The caret as drawn, and the line that holds it.
async function caretAndLine(page) {
  const caret = await page.caret();
  assert.ok(caret.rect, "the caret is not drawn");
  const y = middle(caret.rect);
  const line = (await lines(page)).find((l) => l.height > 0 && y >= l.top && y <= l.bottom);
  assert.ok(line, `no drawn line holds the caret at y ${y.toFixed(1)}`);
  return { caret, y, line };
}

// Lines with height between two y values: what the eye sees as empty lines in a gap.
const between = (all, top, bottom) => all.filter((l) => l.height > 1 && l.top >= top - 1 && l.bottom <= bottom + 1);

test("Enter at the end of a paragraph: the caret's line is drawn directly under it, with no empty line between", async (t) => {
  const { hub, page } = await setup(t, { "a.md": "hello\n" });
  await open(page, "a.md", 5);
  await page.key("Enter");
  await page.quiet();
  assert.equal(await bytes(hub, "a.md"), "hello\n\n\n", "Enter at the end of a paragraph writes a blank line and the caret's line (R24)");
  const { caret, y, line } = await caretAndLine(page);
  assert.equal(caret.focus, 7, "the caret is not on the line after the blank line");
  const hello = lineOf(await lines(page), "hello");
  const extra = between(await lines(page), hello.bottom, line.top);
  assert.deepEqual(extra.map((l) => ({ text: l.text, top: +l.top.toFixed(1), height: +l.height.toFixed(1) })), [], "an empty line is drawn between hello and the caret's line");
  assert.ok(Math.abs(line.top - hello.bottom) <= 1, `the caret's line starts at y ${line.top.toFixed(1)}, not where hello's line ends, ${hello.bottom.toFixed(1)}; the caret is drawn at y ${y.toFixed(1)}`);
});

// A ticket's body is stored without a final newline, so Enter at the end of a ticket's text is
// Enter at the end of a file that does not end in a newline.
async function enterAtEnd(t, where) {
  const { hub, page } = await setup(t, { "a.md": "hello" });
  let rel = "a.md";
  if (where === "ticket") {
    const made = await cli(hub.port, ["--user", USER, "--repo", REPO, "ticket", "create", "--title", "T"], "hello");
    assert.equal(made.code, 0, made.stderr);
    rel = `tickets/${made.stdout.trim().split("\n")[0]}.md`;
    await page.session.send("Page.navigate", { url: `http://127.0.0.1:${page.port}/?load=2#${REPO}/ticket/${encodeURIComponent(rel.slice(8, -3))}` });
    await page.until(() => page.eval(`[...document.querySelectorAll("#editor .md-line")].some((l) => l.textContent === "hello")`), "the ticket's text");
    await page.quiet();
    assert.ok(await page.clickOffset(5), "no point for offset 5");
    await page.quiet();
  } else {
    await open(page, "a.md", 5);
  }
  await page.key("Enter");
  await page.quiet();
  assert.equal(await bytes(hub, rel), "hello\n\n", "Enter at the end writes a blank line and the caret's line (R24)");
  const { y, line } = await caretAndLine(page);
  const hello = lineOf(await lines(page), "hello");
  const extra = between(await lines(page), hello.bottom, line.top);
  assert.deepEqual(extra.map((l) => ({ text: l.text, top: +l.top.toFixed(1), height: +l.height.toFixed(1) })), [], `${where}: an empty line is drawn between hello and the caret's line`);
  assert.ok(Math.abs(line.top - hello.bottom) <= 1, `${where}: the caret's line starts at y ${line.top.toFixed(1)}, not where hello's line ends, ${hello.bottom.toFixed(1)}; the caret is drawn at y ${y.toFixed(1)}`);
  await page.key("w");
  await page.quiet();
  const glyph = await page.eval(`window.__qaGlyph(7)`);
  assert.ok(glyph && Math.abs(middle(glyph) - y) <= 2, `${where}: the w is drawn at y ${glyph ? middle(glyph).toFixed(1) : "?"}, but the caret was drawn at y ${y.toFixed(1)} (R99)`);
}

test("Enter at the end of a file with no final newline: the caret's line is directly under the paragraph, and a letter stays there", async (t) => {
  await enterAtEnd(t, "document");
});

test("Enter at the end of a ticket's text: the caret's line is directly under the paragraph, and a letter stays there", async (t) => {
  await enterAtEnd(t, "ticket");
});

test("a letter typed after Enter is drawn where the caret was, and hello does not move", async (t) => {
  const { hub, page } = await setup(t, { "a.md": "hello\n" });
  await open(page, "a.md", 5);
  await page.key("Enter");
  await page.quiet();
  const before = await caretAndLine(page);
  const helloBefore = lineOf(await lines(page), "hello");
  await page.key("w");
  await page.quiet();
  assert.equal(await bytes(hub, "a.md"), "hello\n\nw\n");
  const glyph = await page.eval(`window.__qaGlyph(7)`);
  assert.ok(glyph, "the w is not drawn");
  assert.ok(Math.abs(middle(glyph) - before.y) <= 2, `the w is drawn at y ${middle(glyph).toFixed(1)}, but the caret was drawn at y ${before.y.toFixed(1)} (R99)`);
  const helloAfter = lineOf(await lines(page), "hello");
  assert.ok(Math.abs(helloAfter.top - helloBefore.top) <= 1, `hello moved from y ${helloBefore.top.toFixed(1)} to ${helloAfter.top.toFixed(1)}`);
  const w = lineOf(await lines(page), "w");
  assert.ok(Math.abs(w.top - helloAfter.bottom) <= 1, `w's line starts at y ${w.top.toFixed(1)}, not where hello's line ends, ${helloAfter.bottom.toFixed(1)}`);
});

test("between two paragraphs the blank line takes no height, with the caret in either one", async (t) => {
  const { page } = await setup(t, { "a.md": "hello\n\nnext\n" });
  for (const offset of [2, 9]) {
    await open(page, "a.md", offset);
    const all = await lines(page);
    const hello = lineOf(all, "hello");
    const next = lineOf(all, "next");
    const extra = between(all, hello.bottom, next.top);
    assert.deepEqual(extra.map((l) => ({ text: l.text, top: +l.top.toFixed(1), height: +l.height.toFixed(1) })), [], `caret at ${offset}: an empty line is drawn between the paragraphs`);
    assert.ok(Math.abs(next.top - hello.bottom) <= 1, `caret at ${offset}: next starts at y ${next.top.toFixed(1)}, not where hello's line ends, ${hello.bottom.toFixed(1)}`);
    assert.ok(hello.height > next.height || offset === 9, `caret at ${offset}: hello's last line has no padding (${hello.height.toFixed(1)} px)`);
  }
});

test("Enter, then one Backspace, gives back hello with the caret drawn at its end (R18)", async (t) => {
  const { hub, page } = await setup(t, { "a.md": "hello\n" });
  await open(page, "a.md", 5);
  await page.key("Enter");
  await page.quiet();
  await page.key("Backspace");
  await page.quiet();
  assert.equal(await bytes(hub, "a.md"), "hello\n", "one Backspace did not take back everything Enter wrote");
  const { caret, y } = await caretAndLine(page);
  assert.equal(caret.focus, 5, "the caret is not at the end of hello");
  const o = await page.eval(`window.__qaGlyph(4)`);
  assert.ok(Math.abs(caret.rect.x - o.right) <= 2 && Math.abs(y - middle(o)) <= 2, `the caret is drawn at x ${caret.rect.x.toFixed(1)} y ${y.toFixed(1)}, not after the o of hello at x ${o.right.toFixed(1)} y ${middle(o).toFixed(1)}`);
});

test("the caret never stops on the blank line between two paragraphs", async (t) => {
  const { page } = await setup(t, { "a.md": "hello\n\nnext\n" });
  const BLANK = 6;
  const moves = [
    ["→ from the end of hello", 5, "→"],
    ["← from the start of next", 7, "←"],
    ["↓ from hello", 2, "↓"],
    ["↑ from next", 9, "↑"],
  ];
  for (const [what, offset, key] of moves) {
    await open(page, "a.md", offset);
    await page.key(key);
    await page.quiet();
    const caret = await page.caret();
    assert.notEqual(caret.focus, BLANK, `${what} left the caret on the blank line`);
  }
  // A click in the gap: in hello's padding, under its text.
  await open(page, "a.md", 2);
  const hello = lineOf(await lines(page), "hello");
  const o = await page.eval(`window.__qaGlyph(2)`);
  await page.click(o.left + 1, hello.bottom - 3);
  await page.quiet();
  assert.notEqual((await page.caret()).focus, BLANK, "a click in the gap left the caret on the blank line");
});

test("the caret never stops on the blank line Enter wrote", async (t) => {
  const { page } = await setup(t, { "a.md": "hello\n" });
  await open(page, "a.md", 5);
  await page.key("Enter");
  await page.quiet();
  await page.key("←");
  await page.quiet();
  assert.equal((await page.caret()).focus, 5, "← from the caret's line did not go to the end of hello");
  await page.key("→");
  await page.quiet();
  assert.equal((await page.caret()).focus, 7, "→ from the end of hello did not go to the caret's line");
});

test("the raw view still draws the blank line as a line (R107)", async (t) => {
  const { page } = await setup(t, { "a.md": "hello\n\nnext\n" });
  await open(page, "a.md", 2);
  await page.until(() => page.eval(`!!document.querySelector(${JSON.stringify(TOGGLE)})`), "the raw view toggle");
  const pt = await page.eval(`(() => { const r = document.querySelector(${JSON.stringify(TOGGLE)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.click(pt.x, pt.y);
  await page.until(() => page.eval(`document.getElementById("editor").classList.contains("md-source")`), "the raw view");
  await page.quiet();
  const all = await lines(page);
  const hello = lineOf(all, "hello");
  const next = lineOf(all, "next");
  const blank = between(all, hello.bottom, next.top);
  assert.equal(blank.length, 1, `the raw view does not draw the blank line as one line: ${JSON.stringify(all)}`);
  assert.equal(blank[0].text.trim(), "", "the line between is not empty");
});
