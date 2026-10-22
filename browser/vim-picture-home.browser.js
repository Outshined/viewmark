import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "./harness.js";

// Ticket r84sx9dx. With vim keys on, a click selects a standalone picture and
// ArrowLeft leaves the caret on the newline after it. That newline is a
// paragraph gap. Home stays on the picture line, at its start, for a picture
// near the top, one in the middle, and one near the bottom. The document is
// taller than the window, and Home does not go to the last paragraph.

const LINE = "![box](box.svg)\n";
const PROSE = "Paragraph is ordinary prose and not a picture.\n\n";
const LAST = "Last paragraph of the document.\n";

function documentText() {
  let text = PROSE.repeat(8);
  const pictures = [];
  for (const name of ["top", "middle", "bottom"]) {
    pictures.push({ name, start: text.length, gap: text.length + LINE.length });
    text += `${LINE}\n${PROSE.repeat(name === "bottom" ? 8 : 30)}`;
  }
  text += LAST;
  return { text, pictures, last: text.lastIndexOf("Last paragraph") };
}

async function setup(t, text) {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  const file = await hub.create("a.md", text);
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.session.send("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem("viewmark.vim", "1");` });
  await page.login();
  await page.open(file);
  await page.quiet();
  return { page };
}

function picturePoint(page, start) {
  return page.eval(`(() => {
    const host = [...document.querySelectorAll("#editor .md-image")].find((el) => Number(el.dataset.start) === ${start});
    const img = host && host.querySelector("img");
    if (!img || !img.complete || !img.naturalWidth) return null;
    (host.closest(".md-line") || host).scrollIntoView({ block: "center" });
    const box = img.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) return null;
    return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
  })()`);
}

test("r84sx9dx: with vim keys on, Home from the newline after a picture stays on that picture", { timeout: 120000 }, async (t) => {
  const { text, pictures, last } = documentText();
  const { page } = await setup(t, text);
  const tall = await page.eval("document.documentElement.scrollHeight > innerHeight + 200");
  assert.equal(tall, true, "the document is not taller than the window");
  for (const picture of pictures) {
    assert.equal(text[picture.gap], "\n", picture.name);
    assert.equal(text[picture.gap - 1], "\n", picture.name);
    let point = null;
    await page.until(async () => {
      point = await picturePoint(page, picture.start);
      return point != null;
    }, `${picture.name} picture drawn`);
    await page.click(point.x, point.y);
    await page.quiet();
    const selected = await page.caret();
    assert.equal(Math.min(selected.anchor, selected.focus), picture.start, `${picture.name}: the click did not start at the picture`);
    assert.equal(Math.max(selected.anchor, selected.focus), picture.gap, `${picture.name}: the click did not end on the newline after the picture`);
    await page.key("ArrowLeft");
    await page.quiet();
    const gap = await page.caret();
    assert.equal(gap.focus, picture.gap, `${picture.name}: ArrowLeft left ${gap.focus}, not the newline after the picture`);
    assert.equal(gap.anchor, picture.gap, `${picture.name}: ArrowLeft did not collapse the selection`);
    await page.key("Home");
    await page.quiet();
    const home = await page.caret();
    assert.equal(home.focus, picture.start, `${picture.name}: Home landed at ${home.focus}, ${JSON.stringify(text.slice(home.focus, home.focus + 16))}`);
    assert.equal(home.anchor, picture.start, picture.name);
    assert.notEqual(home.focus, last, `${picture.name}: Home landed on the last paragraph`);
    const line = await page.eval(`(() => {
      const row = [...document.querySelectorAll("#editor .md-line")].find((el) => Number(el.dataset.start) === ${picture.start} && !el.classList.contains("md-paragraph-gap"));
      if (!row) return null;
      const box = row.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, text: row.textContent.slice(0, 16) };
    })()`);
    assert.ok(line, `${picture.name}: the picture line is not drawn`);
    assert.equal(line.text.startsWith("![box]"), true, `${picture.name}: ${line.text}`);
    assert.ok(home.rect, `${picture.name}: Home left no caret rect`);
    const mid = (home.rect.top + home.rect.bottom) / 2;
    assert.ok(mid >= line.top - 2 && mid <= line.bottom + 2, `${picture.name}: the caret is at y ${mid}, outside the picture line ${line.top} to ${line.bottom}`);
    await page.key("Home");
    await page.quiet();
    assert.equal((await page.caret()).focus, picture.start, `${picture.name}: Home from the picture line left it`);
  }
});
