import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "./harness.js";

// Ticket 4wch9t9w. With vim keys on, j from the line above an open mermaid fence
// walks the source, and the step off the closer lands on the following prose.
// The block mark stays on that prose and inside the window. The blank under the
// fence has no height once the diagram closes, so that step must not stop there.
// h and l on the closer stay on that line. A fence of only A-->B never draws
// an svg, so the source is a graph mermaid can draw.

const TEXT = "Above.\n\n```mermaid\ngraph TD\nA-->B\n```\n\nAfter.\n";

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
  const graph = TEXT.indexOf("graph TD");
  const source = TEXT.indexOf("A-->B");
  const closer = TEXT.lastIndexOf("```");
  const prose = TEXT.indexOf("After.");
  const focus = async () => (await page.caret()).focus;
  await normalAt(page, 0);
  await page.key("j");
  await page.quiet();
  assert.equal(await focus(), opener, "j from the line above did not land on the opener");
  await page.key("j");
  await page.quiet();
  assert.equal(await focus(), graph, "j from the opener did not land on the graph line");
  await page.key("j");
  await page.quiet();
  assert.equal(await focus(), source, "j from the graph line did not land on the source");
  await page.key("j");
  await page.quiet();
  assert.equal(await focus(), closer, "j from the source did not land on the closer");
  await page.key("l");
  await page.quiet();
  assert.equal(await focus(), closer + 1, "l on the closer left that line");
  await page.key("l");
  await page.quiet();
  assert.equal(await focus(), closer + 2, "l did not reach the last backtick");
  await page.key("l");
  await page.quiet();
  assert.equal(await focus(), closer + 2, "l on the last backtick left it");
  await page.key("0");
  await page.quiet();
  assert.equal(await focus(), closer, "0 did not land on the first backtick");
  await page.key("h");
  await page.quiet();
  assert.equal(await focus(), closer, "h on the first backtick left it");
  await page.key("$");
  await page.quiet();
  assert.equal(await focus(), closer + 2, "$ did not land on the last backtick");
  await page.key("0");
  await page.quiet();
  await page.key("w");
  await page.quiet();
  assert.equal(await focus(), prose, "w from the closer did not land on the following prose");
  await page.key("b");
  await page.quiet();
  assert.equal(await focus(), closer, "b from the prose did not land on the closer");
  await page.key("j");
  await page.quiet();
  await page.until(
    () => page.eval(`!!document.querySelector("#editor .md-diagram svg")`),
    "the diagram to settle",
    15000,
  );
  await page.quiet();
  assert.equal(await focus(), prose, "j off the closer did not land on the following prose");
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
