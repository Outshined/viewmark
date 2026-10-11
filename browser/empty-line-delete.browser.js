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
    const hasKind = (line, name) => line.kind.split(/\s+/).includes(name);
    const apart = async (where) => {
      const text = (await hub.show("a.md")).text;
      assert.equal(text, body, `${where}: the blank left the file: ${JSON.stringify(text)}`);
      const lines = await page.eval(LINES);
      const block = lines.find((line) => hasKind(line, kind) && line.text.includes("a") && !line.text.includes("next"));
      const next = lines.find((line) => line.text === "next");
      assert.ok(block && next, `${where}: the two blocks are not drawn apart: ${JSON.stringify(lines.map((line) => line.text))}`);
      assert.ok(!hasKind(next, kind), `${where}: next is drawn as part of ${label}: ${next.kind}`);
      const between = lines.filter((line) => line.top >= block.bottom - 1 && line.bottom <= next.top + 1 && line.height > 4);
      assert.deepEqual(between.map((line) => line.text), [], `${where}: an empty line is drawn between the blocks`);
    };
    await apart("before Delete");
    // The blank is not a stop. ↓ from the item and ↑ from the paragraph go past it.
    assert.ok(await page.clickOffset(2), "no point on a");
    await page.quiet();
    await page.key("↓");
    await page.quiet();
    assert.notEqual((await page.caret()).focus, 4, "↓ stopped on the blank line");
    assert.ok(await page.clickOffset(5), "no point on next");
    await page.quiet();
    await page.key("↑");
    await page.quiet();
    assert.notEqual((await page.caret()).focus, 4, "↑ stopped on the blank line");
    // If a click can still put the caret on that blank, Delete must not fold next in.
    const empty = await page.eval(`(() => {
      const line = [...document.querySelectorAll("#editor .md-line")].find((l) => l.textContent === "" && l.getBoundingClientRect().height > 4);
      if (!line) return null;
      const r = line.getBoundingClientRect();
      return { x: r.left + 20, y: (r.top + r.bottom) / 2 };
    })()`);
    if (empty) {
      await page.click(empty.x, empty.y);
      await page.quiet();
    } else if (await page.clickOffset(4)) {
      await page.quiet();
    }
    const placed = await page.caret();
    if (placed.anchor === 4 && placed.focus === 4) {
      await page.key("Delete");
      await page.quiet();
      await sleep(200);
    }
    await apart("after Delete");
  });
}
