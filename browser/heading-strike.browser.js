import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "./harness.js";

// The plan test never paints. The line under the caret is raw, so the caret
// rests on the last line while the struck lines are read.

const TEXT = [
  "# ~~retired~~",
  "## ~~retired~~",
  "### ~~retired~~",
  "#### ~~retired~~",
  "##### ~~retired~~",
  "###### ~~retired~~",
  "# ~~retired",
  "# `~~retired~~`",
  "",
  "~~gone~~",
  "- ~~**G8. Landing.** see `master` now.~~",
  "1. ~~one~~",
  "> ~~one~~",
  "",
  "tail",
].join("\n") + "\n";

const LINE = `(() => {
  const textOf = (el) => [...el.childNodes].filter((node) => node.nodeType !== 1 || !node.classList.contains("md-lock")).map((node) => node.textContent).join("");
  const deco = (el) => getComputedStyle(el).textDecoration;
  return [...document.querySelectorAll("#editor .md-line")].map((el) => {
    const strike = el.querySelector(".md-strike");
    const code = el.querySelector(".md-code");
    return {
      className: el.className,
      text: textOf(el),
      decorations: [el, ...el.querySelectorAll("*")].map(deco),
      strike: strike ? { text: strike.textContent, decoration: deco(strike) } : null,
      code: code ? { text: code.textContent, className: code.className, decoration: deco(code) } : null,
    };
  });
})()`;

function has(className, token) {
  return String(className).split(/\s+/).includes(token);
}

function struck(decoration) {
  return /line-through/.test(decoration || "");
}

test("3wvczcz4: a rendered line strikes a closed ~~ pair, and the raw view and the hub keep the tildes", async (t) => {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  const file = await hub.create("heading-strike.md", TEXT);
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.login();
  await page.open(file);

  const tail = TEXT.lastIndexOf("tail");
  assert.equal(await page.clickOffset(tail), true, "no glyph on the tail line");
  await page.until(async () => {
    const caret = await page.caret();
    return caret && caret.focus >= tail && caret.focus <= tail + 4;
  }, "the caret on the tail line");
  await page.quiet();

  const lines = await page.eval(LINE);
  for (let level = 1; level <= 6; level += 1) {
    const found = lines.filter((item) => has(item.className, `md-h${level}`) && item.strike);
    assert.equal(found.length, 1, `rendered h${level}: ${JSON.stringify(lines.map((item) => item.text))}`);
    const line = found[0];
    assert.equal(has(line.className, "md-raw"), false, `h${level} is the raw line`);
    assert.equal(line.text, "retired", `h${level} draws ${JSON.stringify(line.text)}`);
    assert.equal(line.strike.text, "retired");
    assert.match(line.strike.decoration, /line-through/, `h${level} text-decoration ${line.strike.decoration}`);
  }

  const open = lines.filter((item) => item.text === "~~retired");
  assert.equal(open.length, 1, `unclosed heading: ${JSON.stringify(lines.map((item) => item.text))}`);
  assert.equal(has(open[0].className, "md-h1"), true);
  assert.equal(has(open[0].className, "md-raw"), false);
  assert.equal(open[0].strike, null, "an unclosed ~~ is struck");
  assert.equal(open[0].decorations.some(struck), false, `unclosed text-decoration ${open[0].decorations.join(" | ")}`);

  const code = lines.filter((item) => item.code && item.code.text === "~~retired~~");
  assert.equal(code.length, 1, `code span: ${JSON.stringify(lines.map((item) => item.text))}`);
  assert.equal(has(code[0].className, "md-h1"), true);
  assert.equal(has(code[0].code.className, "md-code"), true);
  assert.equal(has(code[0].code.className, "md-strike"), false);
  assert.equal(code[0].strike, null, "a ~~ pair inside a code span is struck");
  assert.equal(code[0].text, "~~retired~~");
  assert.equal(struck(code[0].code.decoration), false, `code text-decoration ${code[0].code.decoration}`);
  assert.equal(code[0].decorations.some(struck), false, `code line text-decoration ${code[0].decorations.join(" | ")}`);

  const paragraph = lines.filter((item) => has(item.className, "md-p") && item.text === "gone");
  assert.equal(paragraph.length, 1, `paragraph: ${JSON.stringify(lines.map((item) => item.text))}`);
  assert.equal(has(paragraph[0].className, "md-raw"), false);
  assert.equal(paragraph[0].strike.text, "gone");
  assert.match(paragraph[0].strike.decoration, /line-through/, `paragraph text-decoration ${paragraph[0].strike.decoration}`);

  const bullet = lines.filter((item) => has(item.className, "md-li") && item.text.includes("G8. Landing."));
  assert.equal(bullet.length, 1, `bullet: ${JSON.stringify(lines.map((item) => item.text))}`);
  assert.equal(has(bullet[0].className, "md-raw"), false);
  assert.equal(bullet[0].text, "G8. Landing. see master now.");
  assert.equal(bullet[0].text.includes("~~"), false);
  assert.equal(bullet[0].strike.text, "G8. Landing.");
  assert.match(bullet[0].strike.decoration, /line-through/, `bullet text-decoration ${bullet[0].strike.decoration}`);
  assert.equal(bullet[0].code.text, "master");
  assert.equal(has(bullet[0].code.className, "md-code"), true);
  assert.equal(has(bullet[0].code.className, "md-strike"), true);
  assert.equal(struck(bullet[0].code.decoration), true, `code text-decoration ${bullet[0].code.decoration}`);

  const ordered = lines.filter((item) => has(item.className, "md-ol"));
  assert.equal(ordered.length, 1, `ordered: ${JSON.stringify(lines.map((item) => item.text))}`);
  assert.equal(has(ordered[0].className, "md-raw"), false);
  assert.equal(ordered[0].text, "one");
  assert.equal(ordered[0].strike.text, "one");
  assert.match(ordered[0].strike.decoration, /line-through/, `ordered text-decoration ${ordered[0].strike.decoration}`);

  const quote = lines.filter((item) => has(item.className, "md-quote"));
  assert.equal(quote.length, 1, `quote: ${JSON.stringify(lines.map((item) => item.text))}`);
  assert.equal(has(quote[0].className, "md-raw"), false);
  assert.equal(quote[0].text, "one");
  assert.equal(quote[0].strike.text, "one");
  assert.match(quote[0].strike.decoration, /line-through/, `quote text-decoration ${quote[0].strike.decoration}`);

  const stored = await hub.show(file);
  assert.equal(stored.text, TEXT, "the hub dropped the tildes");

  await page.until(() => page.eval(`!!document.querySelector("#editor button.md-view-toggle")`), "the raw view toggle");
  const point = await page.eval(`(() => {
    const rect = document.querySelector("#editor button.md-view-toggle").getBoundingClientRect();
    return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
  })()`);
  await page.click(point.x, point.y);
  await page.until(() => page.eval(`document.getElementById("editor").classList.contains("md-source")`), "the raw view");
  await page.quiet();

  const raw = await page.eval(LINE);
  assert.deepEqual(raw.map((item) => item.text), TEXT.split("\n"));
  assert.equal(raw.some((item) => item.strike), false, "the raw view strikes a ~~ pair");
  for (const item of raw) {
    if (!item.text.includes("~~")) continue;
    assert.equal(item.decorations.some(struck), false, `raw text-decoration ${item.decorations.join(" | ")} on ${JSON.stringify(item.text)}`);
  }
  assert.equal((await hub.show(file)).text, TEXT, "the raw view wrote the document");
});
