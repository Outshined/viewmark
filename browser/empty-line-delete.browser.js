import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { launchBrowser, Page, startHub } from "./harness.js";

// Ticket s7v532j5. The owner, on Delete on an empty line: "Just pull the previous line up and deal
// with what that does to the markdown underneath." Under a list item or a quote, removing the
// blank line before a paragraph makes markdown read the paragraph as more of the item or the
// quote. So wherever the caret can stand on that blank line, Delete must leave the paragraph a
// paragraph, and leave no empty line drawn between the two blocks. If the page gives the caret no
// place on that line, there is no Delete there to check.

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

// The drawn lines, top to bottom, with their kind, text, and box.
const LINES = `[...document.querySelectorAll("#editor .md-line")].map((line) => {
  const r = line.getBoundingClientRect();
  return { kind: line.className, text: line.textContent, start: line.dataset.start, top: r.top, bottom: r.bottom, height: r.height };
})`;

for (const [label, body, kind] of [
  ["a list item", "- a\n\nnext\n", "md-li"],
  ["a quote", "> a\n\nnext\n", "md-quote"],
]) {
  test(`Delete on the empty line between ${label} and a paragraph keeps the paragraph, and pulls it up`, async (t) => {
    const { hub, page } = await setup(t);
    await hub.create("a.md", body);
    await page.open("a.md");
    await page.until(() => page.eval(`document.querySelectorAll("#editor .md-line").length > 0`), "the file drawn");
    // Aim at the empty line, the way a person would: a click on it, if it is drawn.
    const empty = await page.eval(`(() => {
      const line = [...document.querySelectorAll("#editor .md-line")].find((l) => l.textContent === "" && l.getBoundingClientRect().height > 4);
      if (!line) return null;
      const r = line.getBoundingClientRect();
      return { x: r.left + 20, y: (r.top + r.bottom) / 2 };
    })()`);
    if (!empty) {
      t.diagnostic("no empty line is drawn between the blocks, so the caret cannot stand there");
      return;
    }
    await page.click(empty.x, empty.y);
    await page.quiet();
    const placed = await page.caret();
    if (placed.anchor !== 4 || placed.focus !== 4) {
      t.diagnostic(`a click on the empty line put the caret at ${placed.anchor}, not on the blank line`);
      return;
    }
    await page.key("Delete");
    await page.quiet();
    await sleep(200);
    const text = (await hub.show("a.md")).text;
    assert.match(text, /^[->] a\n\n+next\n$/, `next is no longer its own paragraph: ${JSON.stringify(text)}`);
    const lines = await page.eval(LINES);
    const block = lines.find((line) => line.kind.includes(kind));
    const next = lines.find((line) => line.text === "next");
    assert.ok(block && next, `the two blocks are not drawn apart: ${JSON.stringify(lines.map((line) => line.text))}`);
    assert.ok(!next.kind.includes(kind), `next is drawn as part of ${label}: ${next.kind}`);
    const between = lines.filter((line) => line.top >= block.bottom - 1 && line.bottom <= next.top + 1 && line.height > 4);
    assert.deepEqual(between.map((line) => line.text), [], "an empty line is still drawn between the blocks after Delete");
  });
}
