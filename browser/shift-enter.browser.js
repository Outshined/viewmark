import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { launchBrowser, Page, startHub } from "./harness.js";

// Ticket negjtfrn. Shift+Enter writes a hard break inside the block, in the form D28 gives. The
// owner approved that form on a condition: "Fine, as long as the markdown is valid and the
// rendered version makes sense." These tests press Shift+Enter, type a word or nothing, move the
// caret to another block, and check the bytes and the drawing: the new line is in the same block,
// and no backslash is drawn.

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
  await page.login();
  return { hub, page };
}

// Shift+Enter at offset `at`, then the word, then a click on `end` so the block is drawn rendered.
async function breakAndLeave(t, body, at, word) {
  const { hub, page } = await setup(t);
  await hub.create("a.md", body);
  await page.open("a.md");
  await page.until(() => page.eval(`document.querySelectorAll("#editor .md-line").length > 0`), "the file drawn");
  assert.ok(await page.clickOffset(at));
  await page.quiet();
  await page.key("Enter", ["Shift"]);
  await page.quiet();
  if (word) {
    await page.type(word);
    await page.quiet();
  }
  const end = await page.eval(`window.__qaWordPoint("end", 1)`);
  await page.click(end.x, end.y);
  await page.quiet();
  await sleep(200);
  const drawn = await page.eval(`(() => {
    const lines = [...document.querySelectorAll("#editor .md-line")].filter((line) => !line.textContent.includes("end"));
    return { text: lines.map((line) => line.textContent).join("\\n"), kinds: lines.map((line) => line.className) };
  })()`);
  return { hub, page, text: (await hub.show("a.md")).text, drawn };
}

// The box of the first drawn glyph of a word.
const glyph = (page, word) => page.eval(`(() => {
  const found = window.__qaFindText(${JSON.stringify(word)}, 1);
  if (!found) return null;
  const r = window.__qaDrawnRect(found.drawn, found.from);
  return r && { left: r.left, top: r.top };
})()`);

for (const [label, body, at, bytes, kind] of [
  ["an item", "- alpha\n\nend\n", 7, "- alpha\\\nbeta\n\nend\n", "md-li"],
  ["a quote", "> alpha\n\nend\n", 7, "> alpha\\\n> beta\n\nend\n", "md-quote"],
  ["a paragraph", "alpha\n\nend\n", 5, "alpha\\\nbeta\n\nend\n", "md-p"],
]) {
  test(`Shift+Enter in ${label}, then a word: one block, the word on its own line under the first, and no backslash drawn`, async (t) => {
    const { page, text, drawn } = await breakAndLeave(t, body, at, "beta");
    assert.equal(text, bytes);
    assert.ok(!drawn.text.includes("\\"), `a backslash is drawn: ${JSON.stringify(drawn.text)}`);
    assert.ok(drawn.kinds.filter((k) => k.includes(kind)).length >= 1, `no ${kind} line is drawn: ${drawn.kinds.join(", ")}`);
    const alpha = await glyph(page, "alpha");
    const beta = await glyph(page, "beta");
    assert.ok(alpha && beta, "alpha or beta is not drawn");
    assert.ok(beta.top > alpha.top + 4, `beta is not on a line under alpha: ${beta.top} vs ${alpha.top}`);
    assert.ok(Math.abs(beta.left - alpha.left) <= 1, `beta does not start where alpha does, so it is not in the same block: ${beta.left} vs ${alpha.left}`);
  });
}

for (const [label, body] of [
  ["an item", "- alpha\n\nend\n"],
  ["a quote", "> alpha\n\nend\n"],
]) {
  test(`Shift+Enter at the end of ${label}, with nothing typed after it: no backslash is drawn`, async (t) => {
    const { text, drawn } = await breakAndLeave(t, body, 7, "");
    assert.ok(!drawn.text.includes("\\"), `a backslash is drawn: ${JSON.stringify(drawn.text)}, from ${JSON.stringify(text)}`);
  });
}

// Ticket acc28bfp. A backslash ends a block only while the caret is still on the empty line
// Shift+Enter opened. Leaving that line drops it, so the stored file is as it was. A word after
// the break keeps the backslash. The tests above check the drawing and skip a paragraph.
for (const [label, body, at, kept] of [
  ["a paragraph", "alpha\n\nend\n", 5, "alpha\\\nbeta\n\nend\n"],
  ["an item", "- alpha\n\nend\n", 7, "- alpha\\\nbeta\n\nend\n"],
  ["a quote", "> alpha\n\nend\n", 7, "> alpha\\\n> beta\n\nend\n"],
]) {
  test(`acc28bfp: Shift+Enter at the end of ${label}, then leaving the empty line, stores no block-ending backslash`, async (t) => {
    const { text } = await breakAndLeave(t, body, at, "");
    assert.equal(text, body);
  });
  test(`acc28bfp: Shift+Enter in ${label}, then a word, stores the backslash`, async (t) => {
    const { text } = await breakAndLeave(t, body, at, "beta");
    assert.equal(text, kept);
  });
}
