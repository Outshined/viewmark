import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "./harness.js";

// Ticket nd9gvgw7. The drawn node label is the line after flowchart TD.
// A bare id does not draw, so the line is an edge this mermaid renders.
// A click on that label opens the diagram with the caret on KennelLabel.
// Vim keys off and on share the offset. A one-line body stays on its start,
// which CK.mm.1 already locks.

const LABEL = "KennelLabel";
const TEXT = `Lead.\n\n\`\`\`mermaid\nflowchart TD\n  ${LABEL}-->Other\n\`\`\`\n`;
const VIM = "viewmark.vim";

async function setup(t) {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  const file = await hub.create("a.md", TEXT);
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.login();
  return { page, file };
}

async function labelPoint(page) {
  return page.eval(`(() => {
    const nodes = [...document.querySelectorAll("#editor .md-diagram .node")];
    for (const node of nodes) {
      if (node.closest(".edgeLabel, .edgePath")) continue;
      const text = node.querySelector(".label text, .label .nodeLabel, text, .nodeLabel");
      const raw = text ? text.textContent : "";
      if (!raw || !raw.includes(${JSON.stringify(LABEL)})) continue;
      const textBox = text.getBoundingClientRect();
      const box = textBox.width > 0 && textBox.height > 0 ? textBox : node.getBoundingClientRect();
      if (!(box.width > 0) || !(box.height > 0)) return null;
      return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
    }
    return null;
  })()`);
}

async function clickLabel(page) {
  await page.until(
    () => page.eval(`!!document.querySelector("#editor .md-diagram svg")`),
    "the diagram drawn",
    15000,
  );
  let point = null;
  await page.until(async () => {
    point = await labelPoint(page);
    return !!point;
  }, "the drawn label", 15000);
  await page.click(point.x, point.y);
  await page.quiet();
}

test("nd9gvgw7: a click on a diagram label lands on that label", { timeout: 180000 }, async (t) => {
  const { page, file } = await setup(t);
  const at = TEXT.indexOf(LABEL);
  assert.ok(at > TEXT.indexOf("flowchart TD"));
  assert.equal(TEXT.slice(at, at + LABEL.length), LABEL);
  const lineStart = TEXT.lastIndexOf("\n", at - 1) + 1;
  const lineEnd = TEXT.indexOf("\n", at);
  assert.equal(TEXT.slice(lineStart, lineEnd).trim(), `${LABEL}-->Other`);
  assert.equal(TEXT.slice(TEXT.lastIndexOf("\n", lineStart - 2) + 1, lineStart - 1), "flowchart TD");

  for (const vim of [false, true]) {
    if (vim) await page.eval(`localStorage.setItem(${JSON.stringify(VIM)}, "1")`);
    else await page.eval(`localStorage.removeItem(${JSON.stringify(VIM)})`);
    await page.open(file);
    assert.equal(await page.eval(`document.querySelector("#editor").classList.contains("md-vim-block")`), vim);
    await clickLabel(page);
    const caret = await page.caret();
    assert.equal(caret.focus, at, `vim ${vim ? "on" : "off"} landed at ${caret.focus}, not the label`);
    assert.equal(caret.anchor, caret.focus);
  }
});
