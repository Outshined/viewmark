import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "./harness.js";

// The path strip is fixed across the top of the editor. Scrolling a long document
// back to the top has to leave the first line, and a caret on it, below that strip.

const LINES = 80;

function body() {
  const lines = [];
  for (let i = 0; i < LINES; i += 1) lines.push(`row ${String(i).padStart(2, "0")} stays visible`);
  return `${lines.join("\n\n")}\n`;
}

function measure(page) {
  return page.eval(`(() => {
    const strip = document.querySelector("#editor .md-path-strip");
    const line = [...document.querySelectorAll("#editor .md-line")].find((el) => el.textContent.includes("row 00"));
    const sr = strip.getBoundingClientRect();
    const lr = line.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(line);
    const text = range.getBoundingClientRect();
    return {
      scrollY: window.scrollY,
      stripBottom: sr.bottom,
      stripTop: sr.top,
      stripHeight: sr.height,
      lineTop: lr.top,
      lineBottom: lr.bottom,
      textTop: text.top,
      textBottom: text.bottom,
      text: line.textContent,
    };
  })()`);
}

test("bkmujvq5: the first line and its caret sit below the path strip", async (t) => {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  const file = await hub.create("long-top.md", body());
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.login();
  await page.open(file);

  await page.eval("window.scrollTo(0, document.scrollingElement.scrollHeight); true");
  await page.frame();
  const down = await page.eval("window.scrollY");
  assert.ok(down > 200, `the long document did not scroll (${down})`);
  await page.eval("window.scrollTo(0, 0); true");
  await page.frame();
  const atTop = await measure(page);
  assert.equal(atTop.scrollY, 0);
  assert.ok(atTop.text.includes("row 00"), atTop.text);
  assert.ok(atTop.stripHeight > 20, `strip height ${atTop.stripHeight}`);
  assert.ok(atTop.textTop >= atTop.stripBottom - 1, `first line text ${atTop.textTop} is under the strip ${atTop.stripBottom}`);
  assert.ok(atTop.lineTop >= atTop.stripBottom - 1, `first line ${atTop.lineTop} is under the strip ${atTop.stripBottom}`);

  const point = await page.eval(`(() => {
    const line = [...document.querySelectorAll("#editor .md-line")].find((el) => el.textContent.includes("row 00"));
    const rect = line.getBoundingClientRect();
    return { x: rect.left + 12, y: (rect.top + rect.bottom) / 2 };
  })()`);
  assert.ok(point.y >= atTop.stripBottom - 1, `click ${point.y} is on the strip`);
  await page.click(point.x, point.y);
  await page.quiet();
  const clicked = await page.caret();
  const stripBottom = await page.eval(`document.querySelector("#editor .md-path-strip").getBoundingClientRect().bottom`);
  assert.equal(clicked.focus, 0);
  assert.ok(clicked.rect, "no caret rect");
  assert.ok(clicked.rect.top >= stripBottom - 1, `caret top ${clicked.rect.top} is under the strip ${stripBottom}`);
  assert.ok(clicked.rect.bottom > stripBottom, `caret bottom ${clicked.rect.bottom} is not on the first line`);

  await page.eval("window.scrollTo(0, document.scrollingElement.scrollHeight); true");
  await page.frame();
  await page.eval(`document.getElementById("editor").focus(); true`);
  await page.key("Home", ["Ctrl"]);
  await page.quiet();
  const jumped = await page.caret();
  const afterJump = await measure(page);
  assert.equal(jumped.focus, 0);
  assert.ok(jumped.rect, "no caret rect after jumping to the top");
  assert.ok(jumped.rect.top >= afterJump.stripBottom - 1, `jumped caret ${jumped.rect.top} is under the strip ${afterJump.stripBottom}`);
  assert.ok(afterJump.textTop >= afterJump.stripBottom - 1, `jumped line ${afterJump.textTop} is under the strip ${afterJump.stripBottom}`);
});
