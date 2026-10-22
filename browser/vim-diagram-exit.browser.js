import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "./harness.js";

// Ticket 4wch9t9w. With vim keys on, j from an open mermaid fence's opener walks
// the source, and the step off the closer lands on the following prose. The
// block mark stays on that prose and inside the window. The blank under the
// fence has no height once the diagram closes, so that step must not stop there.

const TEXT = "Above.\n\n```mermaid\nA-->B\n```\n\nAfter.\n";

async function setup(t, text) {
  const hub = await startHub();
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await hub.close();
  });
  const file = await hub.create("a.md", text);
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.session.send("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem("viewmark.vim", "1");` });
  await page.login();
  await page.open(file);
  return { hub, page, file };
}

async function normalAt(page, offset) {
  assert.ok(await page.clickOffset(offset), `no point at ${offset}`);
  await page.quiet();
  await page.key("Escape");
  await page.quiet();
  assert.equal((await page.caret()).focus, offset, `the click did not put the caret at ${offset}`);
}

test("4wch9t9w: with vim keys on, j off a mermaid closer lands on the following prose under the block mark", { timeout: 120000 }, async (t) => {
  const { page } = await setup(t, TEXT);
  const opener = TEXT.indexOf("```mermaid");
  const prose = TEXT.indexOf("After.");
  await normalAt(page, 0);
  await page.key("j");
  await page.quiet();
  assert.equal((await page.caret()).focus, opener, "j from the line above did not land on the opener");
  await page.key("j");
  await page.quiet();
  await page.key("j");
  await page.quiet();
  await page.key("j");
  await page.quiet();
  await page.until(
    () => page.eval(`!!document.querySelector("#editor .md-diagram svg")`),
    "the diagram to settle",
    15000,
  );
  await page.quiet();
  assert.equal((await page.caret()).focus, prose, "j off the closer did not land on the following prose");
  const mark = await page.eval(`(() => {
    const node = document.querySelector(".md-vim-block-mark");
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return {
      width: box.width,
      height: box.height,
      top: box.top,
      bottom: box.bottom,
      left: box.left,
      right: box.right,
      innerHeight,
      innerWidth,
    };
  })()`);
  assert.ok(mark, "the block mark is missing");
  assert.ok(mark.width > 1 && mark.height > 1, "the block mark covers no glyph");
  assert.ok(mark.top >= 0 && mark.bottom <= mark.innerHeight, `the block mark is outside the window at y ${mark.top}`);
  assert.ok(mark.left >= 0 && mark.right <= mark.innerWidth, `the block mark is outside the window at x ${mark.left}`);
});
