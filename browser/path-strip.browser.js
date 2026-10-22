import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "./harness.js";

// The path strip is fixed across the top of the editor. Scrolling a long document
// back to the top has to leave the first line, and a caret on it, below that strip.
// ArrowUp onto a paragraph, a fence line, or a heading at that edge has to leave
// the caret below the strip too. A caret whose top is above the strip bottom is covered.

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
  // A click a few pixels in hits a glyph on the first line, not its first offset.
  const onLine = await page.eval(`(() => {
    const line = [...document.querySelectorAll("#editor .md-line")].find((el) => el.textContent.includes("row 00"));
    const nodes = [line, ...line.querySelectorAll("[data-start]")];
    let start = Infinity;
    let end = -Infinity;
    for (const node of nodes) {
      if (!node.dataset || node.dataset.start == null || node.dataset.start === "") continue;
      const from = Number(node.dataset.start);
      const to = node.dataset.end == null || node.dataset.end === "" ? from : Number(node.dataset.end);
      if (Number.isFinite(from)) start = Math.min(start, from);
      if (Number.isFinite(to)) end = Math.max(end, to);
    }
    return {
      start,
      end,
      stripBottom: document.querySelector("#editor .md-path-strip").getBoundingClientRect().bottom,
    };
  })()`);
  assert.ok(Number.isFinite(onLine.start) && Number.isFinite(onLine.end) && onLine.start <= onLine.end, `no span for the first line`);
  assert.ok(Number.isFinite(clicked.focus) && clicked.focus >= onLine.start && clicked.focus <= onLine.end, `caret ${clicked.focus} is off the first line ${onLine.start}-${onLine.end}`);
  assert.ok(clicked.rect, "no caret rect");
  assert.ok(clicked.rect.top >= onLine.stripBottom - 1, `caret top ${clicked.rect.top} is under the strip ${onLine.stripBottom}`);
  assert.ok(clicked.rect.bottom > onLine.stripBottom, `caret bottom ${clicked.rect.bottom} is not on the first line`);

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

function para(n) {
  return `para ${String(n).padStart(2, "0")} stays visible under the strip`;
}

// The tail is longer than a window, so a line in the middle can scroll under the strip.
function arrowBody() {
  const lead = [];
  for (let i = 0; i < 40; i += 1) lead.push(para(i));
  const tail = [];
  for (let i = 40; i < 120; i += 1) tail.push(para(i));
  // The blank under a heading is a real line, so the paragraph sits on the next line.
  // One ArrowUp then enters the heading. The blank under the fence is padding.
  return [
    lead.join("\n\n"),
    "```\nfence line stays visible\n```",
    "after the fence stays visible",
    "## Heading stays visible\nafter the heading stays visible",
    tail.join("\n\n"),
  ].join("\n\n") + "\n";
}

function sourceLine(doc, text) {
  const start = doc.indexOf(text);
  assert.ok(start >= 0, text);
  assert.equal(doc.indexOf(text, start + 1), -1, `${text} is not unique`);
  let end = start;
  while (end < doc.length && doc[end] !== "\n") end += 1;
  return { start, end };
}

function fenceSpan(doc) {
  const start = doc.indexOf("```");
  assert.equal(doc.slice(start, start + 4), "```\n");
  const close = doc.indexOf("\n```", start + 4);
  assert.ok(close > start);
  assert.equal(doc.slice(close, close + 5), "\n```\n");
  return { start, end: close + 4 };
}

function edge(page, fromText, coveredText) {
  return page.eval(`(() => {
    const strip = document.querySelector("#editor .md-path-strip");
    const lines = [...document.querySelectorAll("#editor .md-line")];
    const from = lines.find((el) => el.textContent.includes(${JSON.stringify(fromText)}));
    const covered = lines.find((el) => el.textContent.includes(${JSON.stringify(coveredText)}));
    if (!strip || !from || !covered || from === covered) return null;
    const box = (el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const text = range.getBoundingClientRect();
      const line = el.getBoundingClientRect();
      return { textTop: text.top, lineTop: line.top };
    };
    const bottom = strip.getBoundingClientRect().bottom;
    const rect = from.getBoundingClientRect();
    const dy = rect.top - (bottom + 8);
    if (Math.abs(dy) > 1) window.scrollBy(0, dy);
    const fromBox = box(from);
    const coveredBox = box(covered);
    let caretTop = null;
    const sel = getSelection();
    if (sel && sel.rangeCount) {
      const rects = sel.getRangeAt(0).getClientRects();
      const hit = [...rects].find((item) => item.height > 0 || item.width > 0);
      if (hit) caretTop = hit.top;
    }
    return {
      stripBottom: strip.getBoundingClientRect().bottom,
      scrollY: window.scrollY,
      caretTop,
      from: fromBox,
      covered: coveredBox,
    };
  })()`);
}

// Scroll the caret's line until it is the first line clear of the strip, so the
// construct above it sits under the strip. That is the line ArrowUp enters.
async function parkClearOfStrip(page, fromText, coveredText) {
  let seen = await edge(page, fromText, coveredText);
  assert.ok(seen, `${fromText} or ${coveredText} is not drawn`);
  await page.frame();
  seen = await edge(page, fromText, coveredText);
  assert.ok(seen, `${fromText} or ${coveredText} is not drawn`);
  await page.frame();
  seen = await edge(page, fromText, coveredText);
  assert.ok(seen, `${fromText} or ${coveredText} is not drawn`);
  assert.ok(seen.scrollY > 0, `${fromText} did not scroll`);
  assert.ok(
    Math.abs(seen.from.lineTop - (seen.stripBottom + 8)) <= 3,
    `parked ${fromText} at ${seen.from.lineTop}, strip ${seen.stripBottom}`,
  );
  assert.ok(
    seen.covered.textTop < seen.stripBottom - 1,
    `${coveredText} top ${seen.covered.textTop} is already clear of the strip ${seen.stripBottom}`,
  );
  return seen;
}

test("xzva569a: ArrowUp leaves the caret below the path strip", async (t) => {
  const doc = arrowBody();
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  const file = await hub.create("arrow-strip.md", doc);
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.login();
  await page.open(file);
  const tall = await page.eval("document.scrollingElement.scrollHeight > window.innerHeight + 400");
  assert.equal(tall, true, "the document fits in the window");
  assert.equal(await page.eval(`document.querySelector(".md-vim-status")`), null, "vim keys are on");

  const cases = [
    {
      label: "paragraph",
      from: para(50),
      covered: para(49),
      inside(focus) {
        const line = sourceLine(doc, para(49));
        return focus >= line.start && focus <= line.end;
      },
    },
    {
      label: "fence line",
      from: "after the fence stays visible",
      covered: "fence line stays visible",
      rawClass: "md-codeblock",
      inside(focus) {
        const span = fenceSpan(doc);
        return focus >= span.start && focus <= span.end;
      },
    },
    {
      label: "heading",
      from: "after the heading stays visible",
      covered: "Heading stays visible",
      rawClass: "md-h2",
      inside(focus) {
        const line = sourceLine(doc, "## Heading stays visible");
        return focus >= line.start && focus <= line.end;
      },
    },
  ];

  for (const item of cases) {
    const from = sourceLine(doc, item.from);
    const at = from.start + 2;
    assert.notEqual(doc[at], "\n");
    const shown = await page.eval(`(() => {
      const line = [...document.querySelectorAll("#editor .md-line")].find((el) => el.textContent.includes(${JSON.stringify(item.from)}));
      if (!line) return false;
      line.scrollIntoView({ block: "center" });
      return true;
    })()`);
    assert.equal(shown, true, `${item.label}: ${item.from} is not drawn`);
    await page.frame();
    assert.equal(await page.clickOffset(at), true, `${item.label}: no point at offset ${at}`);
    await page.quiet();
    const placed = await page.caret();
    assert.ok(placed.focus >= from.start && placed.focus <= from.end, `${item.label}: the click put the caret at ${placed.focus}, not on ${item.from}`);
    const focused = await page.eval(`(() => {
      const root = document.getElementById("editor");
      return document.activeElement === root || root.contains(document.activeElement);
    })()`);
    assert.equal(focused, true, `${item.label}: the editor is not focused`);
    const parked = await parkClearOfStrip(page, item.from, item.covered);
    assert.ok(parked.caretTop != null, `${item.label}: no caret rect before ArrowUp`);
    assert.ok(parked.caretTop >= parked.stripBottom - 1, `${item.label}: caret top ${parked.caretTop} is under the strip before ArrowUp`);
    await page.key("↑");
    await page.quiet();
    const caret = await page.caret();
    const stripBottom = await page.eval(`document.querySelector("#editor .md-path-strip").getBoundingClientRect().bottom`);
    assert.ok(Number.isInteger(caret.focus), `${item.label}: the caret is not in the page`);
    assert.ok(item.inside(caret.focus), `${item.label}: ArrowUp landed at ${caret.focus}, not on ${item.covered}`);
    const line = await page.eval(`(() => {
      const sel = getSelection();
      const node = sel && sel.focusNode && (sel.focusNode.nodeType === 1 ? sel.focusNode : sel.focusNode.parentElement);
      const host = node && node.closest && node.closest(".md-line");
      return host ? { raw: host.classList.contains("md-raw"), classes: [...host.classList], text: host.textContent } : null;
    })()`);
    assert.ok(line && line.text.includes(item.covered), `${item.label}: the caret line is ${line && line.text}`);
    if (item.rawClass) {
      assert.equal(line.raw, true, `${item.label}: the line did not open`);
      assert.ok(line.classes.includes(item.rawClass), `${item.label}: classes ${line.classes.join(" ")}`);
    }
    assert.ok(caret.rect, `${item.label}: no caret rect`);
    assert.ok(caret.rect.top >= stripBottom - 1, `${item.label}: caret top ${caret.rect.top} is under the strip ${stripBottom}`);
    assert.ok(caret.rect.bottom > stripBottom, `${item.label}: caret bottom ${caret.rect.bottom} is not below the strip ${stripBottom}`);
  }
});
