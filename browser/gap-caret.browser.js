import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "./harness.js";

// Ticket 6a2t6dy5. The blank between a fence, a table, a diagram, an image, or a
// rule and the block after it is space, as the blank between two paragraphs is.
// Up from the next block lands on the last line of the block above, and down
// from that line lands on the next block. A second blank stays a line. A
// trailing blank with nothing after it stays a line. The raw view still draws
// every source line.

const TOGGLE = "#editor button.md-view-toggle";

// One blank, then the next block. The last line of the block above is the line
// that ends at the first of those two newlines.
const CASES = [
  ["a fence", "```js\nlet x\nlet y\n```\n\nafter\n", "after"],
  ["a table", "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n\nafter\n", "after"],
  ["a diagram", "```mermaid\ngraph TD\nA-->B\n```\n\nafter\n", "after"],
  ["an image", "![box](box.svg)\n\nafter\n", "after"],
  ["a rule", "---\n\nafter\n", "after"],
  ["two fences", "```\na\n```\n\n```\nb\n```\n", "b"],
  ["two tables", "| a |\n| --- |\n| 1 |\n\n| b |\n| --- |\n| 2 |\n", "b"],
];

function lineOf(doc, offset) {
  const at = Math.max(0, Math.min(doc.length, offset));
  let start = at;
  while (start > 0 && doc[start - 1] !== "\n") start -= 1;
  let end = at;
  while (end < doc.length && doc[end] !== "\n") end += 1;
  return { start, end, text: doc.slice(start, end) };
}

function marked(doc, offset) {
  if (!Number.isInteger(offset) || offset < 0 || offset > doc.length) return String(offset);
  return doc.slice(0, offset) + "‸" + doc.slice(offset);
}

// gap is the newline that ends the block above. The blank line is the next
// newline. The next block starts after that.
function edges(doc) {
  const gap = doc.indexOf("\n\n");
  assert.ok(gap > 0, marked(doc, 0));
  const last = lineOf(doc, gap);
  return { gap, last, blank: gap + 1, below: gap + 2 };
}

function onLine(focus, line) {
  return Number.isInteger(focus) && focus >= line.start && focus <= line.end;
}

async function setup(t, docs) {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  const files = {};
  for (const [name, text] of Object.entries(docs)) files[name] = await hub.create(name, text);
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.login();
  return { hub, page, files };
}

async function place(page, doc, offset) {
  assert.ok(await page.clickOffset(offset), `no point for ${JSON.stringify(marked(doc, offset))}`);
  await page.quiet();
}

async function readCaret(page) {
  const caret = await page.caret();
  assert.ok(Number.isInteger(caret.focus), "the caret is not in the page");
  return caret;
}

function onCaret(caret, line) {
  return onLine(caret.focus, line) || onLine(caret.anchor, line);
}

function hits(caret, offset) {
  return caret.focus === offset || caret.anchor === offset;
}

// The diagram swaps its source for a picture after the file is drawn. Mermaid
// inserts nodes before that picture, so a diagram without an svg has not drawn.
async function settle(page, doc) {
  if (!doc.includes("```mermaid")) return;
  await page.until(
    () => page.eval(`!!document.querySelector("#editor .md-diagram svg")`),
    "the diagram to settle",
    15000,
  );
  await page.quiet();
}

async function openAt(page, file, doc, offset) {
  await page.open(file);
  await settle(page, doc);
  await place(page, doc, offset);
}

function clickOf(doc, needle) {
  const at = doc.indexOf(needle);
  assert.ok(at >= 0, needle);
  return at;
}

// A click in a fence or a table opens that block, so the caret can sit on a
// later line of it. The measured Up starts on the block's first line.
async function onFirstLine(page, doc, below) {
  const first = lineOf(doc, below);
  for (let hop = 0; hop < 8; hop += 1) {
    const caret = await readCaret(page);
    if (caret.anchor === caret.focus && onLine(caret.focus, first)) return;
    assert.ok(caret.focus > first.end, `${JSON.stringify(marked(doc, caret.focus))} is above the next block`);
    await page.key("↑");
    await page.quiet();
  }
  const caret = await readCaret(page);
  assert.ok(caret.anchor === caret.focus && onLine(caret.focus, first), `the caret is not on the next block's first line at ${JSON.stringify(marked(doc, caret.focus))}`);
}

async function arrowCaret(page) {
  const caret = await readCaret(page);
  assert.equal(caret.anchor, caret.focus, `the arrow left a range at ${caret.anchor}..${caret.focus}`);
  return caret;
}

test("6a2t6dy5 the caret skips the blank under a fence, a table, a diagram, an image, or a rule", { timeout: 300000 }, async (t) => {
  const docs = {};
  for (const [name, doc] of CASES) docs[`${name}.md`] = doc;
  const doubled = {};
  const trailed = {};
  for (const [name, doc] of CASES) {
    const edge = edges(doc);
    doubled[`${name} second.md`] = doc.slice(0, edge.gap) + "\n" + doc.slice(edge.gap);
    // A lead paragraph holds the opening caret, so a table stays closed and the
    // trailing blank is not the padding under an open row.
    trailed[`${name} trail.md`] = `Lead\n\n${doc.slice(0, edge.gap + 1)}\n`;
  }
  const raw = [
    "```js",
    "let x",
    "```",
    "",
    "---",
    "",
    "| a | b |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "```mermaid",
    "A-->B",
    "```",
    "",
    "![box](box.svg)",
    "",
    "after",
  ].join("\n") + "\n";
  const { hub, page, files } = await setup(t, { ...docs, ...doubled, ...trailed, "raw.md": raw });

  for (const [name, doc, needle] of CASES) {
    const edge = edges(doc);
    const file = files[`${name}.md`];
    const at = clickOf(doc, needle);
    assert.ok(at >= edge.below, `${name}: the click is not on the next block`);
    await openAt(page, file, doc, at);
    assert.ok(onCaret(await readCaret(page), lineOf(doc, at)), `${name}: the click missed ${JSON.stringify(needle)}`);

    const gap = await page.eval(`(() => {
      const nodes = [...document.querySelectorAll("#editor .md-line, #editor .md-atom")];
      const gapEl = nodes.find((el) => el.classList.contains("md-line") && Number(el.dataset.start) === ${edge.blank});
      if (!gapEl) return null;
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, height: r.height };
      };
      const g = box(gapEl);
      const rest = nodes.filter((el) => el !== gapEl && !el.classList.contains("md-paragraph-gap")).map(box).filter((b) => b.height > 0);
      const above = rest.filter((b) => b.bottom <= g.top + 1).sort((a, b) => b.bottom - a.bottom)[0];
      const below = rest.filter((b) => b.top >= g.bottom - 1).sort((a, b) => a.top - b.top)[0];
      const room = above && below ? below.top - above.bottom : null;
      return {
        height: g.height,
        gap: gapEl.classList.contains("md-paragraph-gap"),
        room,
        x: above ? above.left + 24 : null,
        y: above && below ? (above.bottom + below.top) / 2 : null,
      };
    })()`);
    assert.ok(gap, `${name}: the blank line is not in the page`);
    assert.equal(gap.gap, true, `${name}: the blank is not the gap under the block`);
    assert.ok(gap.height <= 1, `${name}: the blank is drawn as a line (${gap.height}px)`);
    if (gap.room > 4) {
      await page.click(gap.x, gap.y);
      await page.quiet();
      assert.equal(hits(await readCaret(page), edge.blank), false, `${name}: a click in the gap left the caret on the blank`);
      await place(page, doc, at);
    }
    await onFirstLine(page, doc, edge.below);

    await page.key("↑");
    await page.quiet();
    const up = await arrowCaret(page);
    assert.equal(hits(up, edge.blank), false, `${name}: ↑ stopped on the blank at ${JSON.stringify(marked(doc, up.focus))}`);
    assert.ok(onLine(up.focus, edge.last), `${name}: ↑ from the next block left the caret at ${JSON.stringify(marked(doc, up.focus))}, not on the last line ${JSON.stringify(edge.last.text)}`);

    await page.key("↓");
    await page.quiet();
    const down = await arrowCaret(page);
    const next = lineOf(doc, at);
    assert.equal(hits(down, edge.blank), false, `${name}: ↓ stopped on the blank at ${JSON.stringify(marked(doc, down.focus))}`);
    assert.ok(down.focus >= edge.below && down.focus <= next.end, `${name}: ↓ from the block left the caret at ${JSON.stringify(marked(doc, down.focus))}, not on the next block`);
    assert.equal((await hub.show(file)).text, doc, `${name}: an arrow changed the file`);
  }

  for (const [name, doc, needle] of CASES) {
    const edge = edges(doc);
    const text = doc.slice(0, edge.gap) + "\n" + doc.slice(edge.gap);
    const first = edge.gap + 1;
    const second = edge.gap + 2;
    const below = edge.gap + 3;
    const file = files[`${name} second.md`];
    const at = clickOf(text, needle);
    assert.equal(text[second], "\n", `${name}: the second blank is not an empty line`);
    assert.ok(at >= below, `${name}: the click is not after the second blank`);
    await openAt(page, file, text, at);
    const heights = await page.eval(`(() => {
      const box = (offset) => {
        const el = [...document.querySelectorAll("#editor .md-line")].find((line) => Number(line.dataset.start) === offset && Number(line.dataset.end) === offset);
        if (!el) return null;
        return { height: el.getBoundingClientRect().height, gap: el.classList.contains("md-paragraph-gap") };
      };
      return { first: box(${first}), second: box(${second}) };
    })()`);
    assert.ok(heights.first && heights.first.height <= 1 && heights.first.gap === true, `${name}: the first of the two blanks is drawn as a line (${JSON.stringify(heights.first)})`);
    assert.ok(heights.second && heights.second.height > 8 && heights.second.gap === false, `${name}: the second blank is not drawn as a line (${JSON.stringify(heights.second)})`);
    await onFirstLine(page, text, below);
    await page.key("↑");
    await page.quiet();
    const up = await arrowCaret(page);
    assert.equal(up.focus, second, `${name}: ↑ from the next block left the caret at ${JSON.stringify(marked(text, up.focus))}, not on the second blank`);
    assert.equal(hits(up, first), false, `${name}: ↑ stopped on the first blank`);
    await page.key("↓");
    await page.quiet();
    const down = await arrowCaret(page);
    assert.ok(down.focus >= below, `${name}: ↓ from the second blank left the caret at ${JSON.stringify(marked(text, down.focus))}`);
    assert.equal(hits(down, second), false, `${name}: ↓ stayed on the second blank`);
    assert.equal(hits(down, first), false, `${name}: ↓ stopped on the first blank`);
    assert.equal((await hub.show(file)).text, text, `${name}: an arrow changed the doubled file`);
  }

  for (const [name, doc] of CASES) {
    const edge = edges(doc);
    const block = doc.slice(0, edge.gap + 1);
    const text = `Lead\n\n${block}\n`;
    const blockStart = "Lead\n\n".length;
    const blank = text.length - 1;
    const file = files[`${name} trail.md`];
    assert.equal(text[blank], "\n", `${name}: the trailing blank is not an empty line`);
    assert.equal(text.slice(blank + 1), "", `${name}: something follows the trailing blank`);
    await page.open(file);
    await settle(page, text);
    await page.quiet();
    const drawn = await page.eval(`(() => {
      const el = [...document.querySelectorAll("#editor .md-line")].find((line) => Number(line.dataset.start) === ${blank} && Number(line.dataset.end) === ${blank});
      if (!el) return null;
      return { height: el.getBoundingClientRect().height, gap: el.classList.contains("md-paragraph-gap") };
    })()`);
    assert.ok(drawn && drawn.height > 8 && drawn.gap === false, `${name}: the trailing blank is not drawn as a line (${JSON.stringify(drawn)})`);
    await place(page, text, blank);
    assert.equal((await readCaret(page)).focus, blank, `${name}: the caret cannot sit on the trailing blank`);
    await page.key("↑");
    await page.quiet();
    const up = await arrowCaret(page);
    assert.equal(hits(up, blank), false, `${name}: ↑ stayed on the trailing blank`);
    assert.ok(up.focus >= blockStart && up.focus < blank, `${name}: ↑ from the trailing blank left the caret at ${JSON.stringify(marked(text, up.focus))}, not on the block above`);
    if (block.indexOf("\n") === block.length - 1) {
      await page.key("↓");
      await page.quiet();
      assert.equal((await arrowCaret(page)).focus, blank, `${name}: ↓ from the block did not return to the trailing blank`);
    }
    assert.equal((await hub.show(file)).text, text, `${name}: an arrow changed the trailing file`);
  }

  const rawFile = files["raw.md"];
  // A file that ends in a newline draws the empty line after that newline.
  const rawLines = raw.split("\n");
  const rawBlank = raw.indexOf("\n\nafter\n") + 1;
  await openAt(page, rawFile, raw, raw.indexOf("after"));
  await page.until(() => page.eval(`!!document.querySelector(${JSON.stringify(TOGGLE)})`), "the raw view toggle");
  const pt = await page.eval(`(() => { const r = document.querySelector(${JSON.stringify(TOGGLE)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.click(pt.x, pt.y);
  await page.until(() => page.eval(`document.getElementById("editor").classList.contains("md-source")`), "the raw view");
  await page.quiet();
  const drawn = await page.eval(`[...document.querySelectorAll("#editor .md-line")].map((line) => {
    const r = line.getBoundingClientRect();
    const copy = line.cloneNode(true);
    for (const lock of copy.querySelectorAll(".md-lock")) lock.remove();
    return { text: copy.textContent, height: r.height, source: line.classList.contains("md-source-line") };
  })`);
  assert.deepEqual(drawn.map((line) => line.text), rawLines, "the raw view does not draw each source line");
  for (const [index, line] of drawn.entries()) {
    assert.equal(line.source, true, `raw line ${index} is not a source line`);
    assert.ok(line.height > 4, `raw line ${index} ${JSON.stringify(line.text)} has no height`);
  }
  await place(page, raw, raw.indexOf("after"));
  await page.key("↑");
  await page.quiet();
  const rawUp = await arrowCaret(page);
  assert.equal(rawUp.focus, rawBlank, `in the raw view ↑ skipped the blank before after, landing at ${JSON.stringify(marked(raw, rawUp.focus))}`);
});
