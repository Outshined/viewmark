import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { AGENT, launchBrowser, Page, startHub } from "./harness.js";

// Ticket arh58dxz. While a comment handle is held and moved, the highlight covers the range a
// release at that point would store, and no edit goes out until release. A release stores the
// range drawn just before it, in one edit, and a drag that would store nothing writes nothing.
// In the raw block a marker takes no room, so the text sits where it would with no comment.
//
// The drawn range is read from the page: the characters of the paragraph whose middles lie in
// the comment's highlight boxes, and the characters inside its highlight elements. The expected
// range comes from the text alone: the end that is not dragged, and the boundary nearest the
// pointer, which is where a click there puts the caret. The stored range comes from the hub's
// bytes. A press, moves with the button held, and a release are plain mouse events, which
// Firefox delivers. Firefox is the only browser these tests drive, so nothing here is skipped.

const CM = (id) => `\n\n\`\`\`comment ${id}\n:: 0\n@2026-10-05T16:00:00.000Z ${AGENT}\nNote ${id}.\n\`\`\`\n`;
const MARK = /\{\/?[A-Za-z][\w-]*\}/g;
const LEAD = "Other line.\n\n";
const BODY = "One {c0}two{/c0} three {c1}four five{/c1} six {c2}seven{/c2} eight.";
const FENCES = CM("c0") + CM("c1").slice(1) + CM("c2").slice(1);
const DOC = LEAD + BODY + FENCES;
// The paragraph as drawn, and the offset in DOC of each of its characters.
const TEXT = BODY.replace(MARK, "");
const AT = charOffsets(BODY).map((offset) => LEAD.length + offset);
// c1 covers "four five": characters 14 to 23 of TEXT.
const STORED = [TEXT.indexOf("four"), TEXT.indexOf(" six")];

function charOffsets(prose) {
  const out = [];
  let at = 0;
  for (const match of prose.matchAll(MARK)) {
    for (; at < match.index; at += 1) out.push(at);
    at = match.index + match[0].length;
  }
  for (; at < prose.length; at += 1) out.push(at);
  return out;
}

const show = (range) => `[${range[0]}, ${range[1]}) ${JSON.stringify(TEXT.slice(range[0], range[1]))}`;

// The runs of "#" in a string of flags, one per character, as [start, end) pairs.
function runs(flags) {
  const out = [];
  for (let i = 0; i < flags.length; i += 1) {
    if (flags[i] !== "#") continue;
    let j = i;
    while (j < flags.length && flags[j] === "#") j += 1;
    out.push([i, j]);
    i = j;
  }
  return out;
}

// c1's range in the hub's bytes, in characters of TEXT. The rest of the file must be as it was:
// the lead line, the paragraph's text, c0's and c2's markers, and every fence.
function storedRange(text, label) {
  const fences = DOC.slice(LEAD.length + BODY.length);
  assert.ok(text.startsWith(LEAD), `${label}: the lead line changed: ${JSON.stringify(text.slice(0, 40))}`);
  assert.ok(text.endsWith(fences), `${label}: a fence changed: ${JSON.stringify(text)}`);
  const prose = text.slice(LEAD.length, text.length - fences.length);
  assert.equal(prose.replace(MARK, ""), TEXT, `${label}: the paragraph's text changed: ${JSON.stringify(prose)}`);
  const strip = (s) => s.replace("{c1}", "").replace("{/c1}", "");
  assert.equal(strip(prose), strip(BODY), `${label}: c0 or c2 moved: ${JSON.stringify(prose)}`);
  assert.equal(prose.split("{c1}").length, 2, `${label}: c1 opens more than once: ${JSON.stringify(prose)}`);
  assert.equal(prose.split("{/c1}").length, 2, `${label}: c1 closes more than once: ${JSON.stringify(prose)}`);
  const open = prose.indexOf("{c1}");
  const close = prose.indexOf("{/c1}");
  return [prose.slice(0, open).replace(MARK, "").length, prose.slice(0, close).replace(MARK, "").length];
}

async function setup(t, docs) {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  for (const [name, text] of Object.entries(docs)) await hub.create(name, text);
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.login();
  return { hub, page };
}

async function open(page, file) {
  await page.open(file);
  await page.until(() => page.eval(`document.querySelectorAll("#editor .md-line").length > 0`), `${file} drawn`);
}

const editsSince = (page, since) => page.frames.slice(since).filter((frame) => frame.dir === "out" && frame.data && frame.data.type === "edit");

// The paragraph as drawn: its text, whether it is the raw block, and two strings of flags, one
// per character: "#" where the character is inside a c1 highlight element (dom), and "#" where
// its middle lies inside one of the boxes c1's highlight paints (geo).
const DRAWN = `(() => {
  const line = [...document.querySelectorAll("#editor .md-line")].find((el) => el.textContent.includes("eight"));
  if (!line) return null;
  const boxes = [...line.querySelectorAll('.md-comment[data-comment="c1"]')].flatMap((el) => [...el.getClientRects()]).filter((r) => r.width > 0);
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  let text = "";
  let dom = "";
  let geo = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement.closest(".md-lock, .md-comment-handle")) continue;
    const marked = !!node.parentElement.closest('.md-comment[data-comment="c1"]');
    for (let i = 0; i < node.length; i += 1) {
      const range = document.createRange();
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const r = range.getClientRects()[0] || range.getBoundingClientRect();
      const x = (r.left + r.right) / 2;
      const y = (r.top + r.bottom) / 2;
      text += node.data[i];
      dom += marked ? "#" : ".";
      geo += boxes.some((b) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) ? "#" : ".";
    }
  }
  return { raw: line.classList.contains("md-raw"), text, dom, geo };
})()`;

async function drawn(page) {
  const seen = await page.eval(DRAWN);
  assert.ok(seen, "the paragraph is not drawn");
  assert.equal(seen.text, TEXT, `the paragraph draws ${JSON.stringify(seen.text)}`);
  return seen;
}

// The highlight covers exactly range, by its boxes and by its elements. Returns the range drawn.
async function expectDrawn(page, range, label) {
  const seen = await drawn(page);
  const geo = runs(seen.geo);
  const dom = runs(seen.dom);
  const said = (found) => found.map(show).join(" + ") || "nothing";
  assert.deepEqual(geo, [range], `${label}: the highlight covers ${said(geo)}, not ${show(range)}`);
  assert.deepEqual(dom, [range], `${label}: the highlight elements hold ${said(dom)}, not ${show(range)}`);
  return geo[0];
}

// A point in the glyph of TEXT[index], at part of its width from its left edge.
async function glyphPoint(page, index, part) {
  const box = await page.eval(`window.__qaGlyph(${AT[index]})`);
  assert.ok(box, `no glyph for ${JSON.stringify(TEXT[index])} at ${index}`);
  return { x: box.left + (box.right - box.left) * part, y: (box.top + box.bottom) / 2 };
}

// The caret in "Other line." leaves the paragraph rendered; on "One" it makes it the raw block.
// Neither press lands on a highlight, so no comment is current and no border is drawn.
async function placeCaret(page, kind) {
  const offset = kind === "raw" ? AT[TEXT.indexOf("One") + 1] : 3;
  assert.ok(await page.clickOffset(offset), `no point for offset ${offset}`);
  await page.quiet();
  const seen = await drawn(page);
  assert.equal(seen.raw, kind === "raw", `the paragraph is ${seen.raw ? "the raw block" : "rendered"}, not ${kind}`);
  await expectDrawn(page, STORED, `${kind}, before the drag`);
}

// Hovers c1 so its handles show, then presses the button on one handle. The pointer stays down.
async function pressHandle(page, edge) {
  const over = await glyphPoint(page, TEXT.indexOf("four") + 1, 0.5);
  await page.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: over.x, y: over.y });
  await page.frame();
  const selector = `#editor .md-comment-handle[data-comment="c1"][data-edge="${edge}"]`;
  await page.until(() => page.eval(`!!document.querySelector(${JSON.stringify(selector)})`), `the ${edge} handle`, 2000);
  const from = await page.eval(`(() => {
    const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await page.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
  await page.session.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1, buttons: 1 });
  return from;
}

// Moves the held pointer from one point to another in ten steps, as a hand does, and waits for
// the page to draw.
async function glide(page, from, to) {
  for (let step = 1; step <= 10; step += 1) {
    const x = from.x + ((to.x - from.x) * step) / 10;
    const y = from.y + ((to.y - from.y) * step) / 10;
    await page.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
  }
  await page.frame();
  await sleep(30);
  await page.frame();
  return to;
}

async function release(page, at) {
  await page.session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 1, buttons: 0 });
  await page.quiet();
  await sleep(150);
}

// Nothing went out and the hub's bytes are as they were.
async function unwritten(hub, page, file, since, label) {
  const edits = editsSince(page, since);
  assert.equal(edits.length, 0, `${label}: ${edits.length} edit frames went out: ${edits.map((frame) => JSON.stringify(frame.data)).join("; ")}`);
  assert.equal((await hub.show(file)).text, DOC, `${label}: the hub's bytes changed`);
}

// For each handle: two places the held pointer stops at, in the left quarter of a glyph, so the
// boundary nearest the pointer is the one before that glyph; a place inside another comment,
// where a release would cross it and store nothing; and the other end, where a release would
// leave the comment empty and store nothing.
const ROUTES = {
  end: {
    first: TEXT.indexOf("five"),
    second: TEXT.indexOf(" seven"),
    cross: TEXT.indexOf("seven") + 2,
    empty: TEXT.indexOf("four"),
    range: (boundary) => [STORED[0], boundary],
  },
  start: {
    first: TEXT.indexOf("three"),
    second: TEXT.indexOf("four") + 2,
    cross: TEXT.indexOf("two") + 1,
    empty: TEXT.indexOf(" six"),
    range: (boundary) => [boundary, STORED[1]],
  },
};

for (const kind of ["rendered", "raw"]) {
  for (const edge of ["end", "start"]) {
    const route = ROUTES[edge];
    const block = kind === "raw" ? "the raw block" : "a rendered block";

    test(`the ${edge} handle held in ${block}: the highlight follows the pointer to two places, keeps its stored range where a release would store nothing, sends no edit, and the release stores the range drawn just before it (ticket arh58dxz)`, async (t) => {
      const file = `${kind}-${edge}.md`;
      const { hub, page } = await setup(t, { [file]: DOC });
      await open(page, file);
      await placeCaret(page, kind);
      const first = await glyphPoint(page, route.first, 0.25);
      const second = await glyphPoint(page, route.second, 0.25);
      const cross = await glyphPoint(page, route.cross, 0.25);
      const since = page.frames.length;
      let at = await pressHandle(page, edge);

      at = await glide(page, at, first);
      const seen = await drawn(page);
      assert.equal(seen.raw, kind === "raw", `the paragraph became ${seen.raw ? "the raw block" : "rendered"} during the drag`);
      await expectDrawn(page, route.range(route.first), `${kind} ${edge}, first place`);
      await unwritten(hub, page, file, since, `${kind} ${edge}, first place`);

      at = await glide(page, at, second);
      await expectDrawn(page, route.range(route.second), `${kind} ${edge}, second place`);
      await unwritten(hub, page, file, since, `${kind} ${edge}, second place`);

      at = await glide(page, at, cross);
      await expectDrawn(page, STORED, `${kind} ${edge}, inside another comment, where a release stores nothing`);
      await unwritten(hub, page, file, since, `${kind} ${edge}, inside another comment`);

      at = await glide(page, at, second);
      const before = await expectDrawn(page, route.range(route.second), `${kind} ${edge}, back at the second place`);
      await unwritten(hub, page, file, since, `${kind} ${edge}, back at the second place`);

      await release(page, at);
      const edits = editsSince(page, since);
      assert.equal(edits.length, 1, `${kind} ${edge}: the release sent ${edits.length} edit frames: ${edits.map((frame) => JSON.stringify(frame.data)).join("; ")}`);
      const stored = storedRange((await hub.show(file)).text, `${kind} ${edge}`);
      assert.deepEqual(stored, before, `${kind} ${edge}: the hub stored ${show(stored)}, but the highlight just before release was ${show(before)}`);
    });

    test(`the ${edge} handle held in ${block}: a drag released where it started, or where a release would store nothing, writes nothing, and the highlight shows its stored range again (ticket arh58dxz)`, async (t) => {
      const file = `${kind}-${edge}-back.md`;
      const { hub, page } = await setup(t, { [file]: DOC });
      await open(page, file);
      await placeCaret(page, kind);
      const first = await glyphPoint(page, route.first, 0.25);
      const empty = await glyphPoint(page, route.empty, 0.25);
      const cross = await glyphPoint(page, route.cross, 0.25);

      let since = page.frames.length;
      const start = await pressHandle(page, edge);
      let at = await glide(page, start, first);
      await expectDrawn(page, route.range(route.first), `${kind} ${edge}, first place`);
      at = await glide(page, at, empty);
      await expectDrawn(page, STORED, `${kind} ${edge}, at the other end, where a release stores nothing`);
      at = await glide(page, at, start);
      await expectDrawn(page, STORED, `${kind} ${edge}, back where the drag started`);
      await unwritten(hub, page, file, since, `${kind} ${edge}, back where the drag started`);
      await release(page, at);
      await unwritten(hub, page, file, since, `${kind} ${edge}, released where it started`);
      await expectDrawn(page, STORED, `${kind} ${edge}, after a release where the drag started`);

      // The release where it started put the caret at the handle's boundary, in the paragraph.
      await placeCaret(page, kind);
      since = page.frames.length;
      at = await pressHandle(page, edge);
      at = await glide(page, at, first);
      await expectDrawn(page, route.range(route.first), `${kind} ${edge}, second drag, first place`);
      at = await glide(page, at, cross);
      await expectDrawn(page, STORED, `${kind} ${edge}, second drag, inside another comment`);
      await release(page, at);
      await unwritten(hub, page, file, since, `${kind} ${edge}, released inside another comment`);
      await expectDrawn(page, STORED, `${kind} ${edge}, after a release inside another comment`);
    });

    // The left quarter of a glyph is nearest the boundary before it, and the right quarter is
    // nearest the boundary after it, where a click there puts the caret. These places are in the
    // right quarter of a glyph, outside every highlight.
    test(`the ${edge} handle held in ${block}: with the pointer in the right quarter of a glyph, the highlight ends at the boundary after that glyph, where a click there puts the caret, and the release stores that range (tickets arh58dxz, uz5rme4t)`, async (t) => {
      const file = `${kind}-${edge}-right.md`;
      const { hub, page } = await setup(t, { [file]: DOC });
      await open(page, file);
      const glyphs = edge === "end" ? [TEXT.indexOf("six"), TEXT.indexOf("six") + 2] : [TEXT.indexOf("three") + 1, TEXT.indexOf("three") + 3];
      for (const index of glyphs) {
        const point = await glyphPoint(page, index, 0.75);
        await page.click(point.x, point.y);
        await page.quiet();
        const caret = await page.caret();
        assert.equal(caret.focus, AT[index] + 1, `a click in the right quarter of ${JSON.stringify(TEXT[index])} put the caret at ${caret.focus}, not after it at ${AT[index] + 1}`);
      }
      await placeCaret(page, kind);
      const points = [];
      for (const index of glyphs) points.push(await glyphPoint(page, index, 0.75));
      const since = page.frames.length;
      let at = await pressHandle(page, edge);
      const seen = [];
      for (let i = 0; i < glyphs.length; i += 1) {
        at = await glide(page, at, points[i]);
        const drawnNow = await drawn(page);
        seen.push({ geo: runs(drawnNow.geo), dom: runs(drawnNow.dom) });
        await unwritten(hub, page, file, since, `${kind} ${edge}, pointer on ${JSON.stringify(TEXT[glyphs[i]])}`);
      }
      await release(page, at);
      const edits = editsSince(page, since);
      assert.equal(edits.length, 1, `${kind} ${edge}: the release sent ${edits.length} edit frames`);
      const stored = storedRange((await hub.show(file)).text, `${kind} ${edge}`);
      const wanted = glyphs.map((index) => route.range(index + 1));
      const said = (found) => found.map(show).join(" + ") || "nothing";
      const story = glyphs.map((index, i) => `pointer in the right quarter of ${JSON.stringify(TEXT[index])} at ${index}: highlight ${said(seen[i].geo)}, elements ${said(seen[i].dom)}, wanted ${show(wanted[i])}`).join("; ");
      const got = { drawn: seen, stored };
      const expected = { drawn: wanted.map((range) => ({ geo: [range], dom: [range] })), stored: wanted[wanted.length - 1] };
      assert.deepEqual(got, expected, `${kind} ${edge}: ${story}; the release stored ${show(stored)}`);
    });
  }
}

// The space a raw marker takes. Each sample is a paragraph with a comment and the same paragraph
// with none. QA's sample has a space at each marker; the other has both markers inside a word.
const SAMPLES = [
  { marked: "See {c1}this{/c1} now.", plain: "See this now." },
  { marked: "Un{c1}believ{/c1}able tale.", plain: "Unbelievable tale." },
];

// The gap before the highlight's first character and the gap after its last one, in px, with the
// caret in the paragraph. offsets are the four characters' offsets in the file drawn.
async function gaps(page, offsets) {
  return page.eval(`(() => {
    const g = (offset) => window.__qaGlyph(offset);
    const [before, first, last, next] = ${JSON.stringify(offsets)}.map(g);
    const line = document.querySelector("#editor .md-line");
    if (!before || !first || !last || !next) return { missing: true };
    return {
      raw: line.classList.contains("md-raw"),
      current: !!document.querySelector("#editor .md-comment.md-comment-current"),
      start: first.left - before.right,
      end: next.left - last.right,
    };
  })()`);
}

// Moves the caret with → until it is at offset.
async function arrowTo(page, offset) {
  for (let i = 0; i < 40; i += 1) {
    if ((await page.caret()).focus === offset) return;
    await page.key("→");
    await page.quiet();
  }
  assert.fail(`→ never reached offset ${offset}`);
}

// Measures each sample with and without its comment, with the caret placed the way each named
// placement says. Returns one row per sample and placement.
async function measureGaps(t, placements) {
  const docs = {};
  SAMPLES.forEach((sample, i) => {
    docs[`marked-${i}.md`] = sample.marked + CM("c1");
    docs[`plain-${i}.md`] = sample.plain + "\n";
  });
  const { page } = await setup(t, docs);
  const rows = [];
  for (let i = 0; i < SAMPLES.length; i += 1) {
    const { marked, plain } = SAMPLES[i];
    const open0 = marked.indexOf("{c1}");
    const close = marked.indexOf("{/c1}");
    const size = close - open0 - 4;
    // Offsets of the character before the highlight, its first and last characters, and the
    // character after it, in each file.
    const sides = {
      marked: { offsets: [open0 - 1, open0 + 4, close - 1, close + 5], first: open0 + 4, end: marked.length },
      plain: { offsets: [open0 - 1, open0, open0 + size - 1, open0 + size], first: open0, end: plain.length },
    };
    for (const placement of placements) {
      const row = { sample: marked, placement };
      for (const side of ["plain", "marked"]) {
        const at = sides[side];
        await open(page, `${side}-${i}.md`);
        if (placement === "before the highlight") assert.ok(await page.clickOffset(1));
        else if (placement === "after the highlight") assert.ok(await page.clickOffset(at.end - 2));
        else if (placement === "inside the highlight, by arrow keys") {
          assert.ok(await page.clickOffset(0));
          await page.quiet();
          await arrowTo(page, at.first + 1);
        }
        await page.quiet();
        const measured = await gaps(page, at.offsets);
        assert.equal(measured.missing, undefined, `${placement}: a glyph is missing in ${side}-${i}.md`);
        assert.equal(measured.raw, true, `${placement}: the paragraph in ${side}-${i}.md is not the raw block`);
        row[side] = measured;
      }
      rows.push(row);
    }
  }
  return rows;
}

const report = (rows, gap) => rows.map((row) => `${JSON.stringify(row.sample)} with the caret ${row.placement}: ${gap} gap ${row.marked[gap].toFixed(2)} px${row.marked.current ? " (comment current)" : ""}, with no comment ${row.plain[gap].toFixed(2)} px`).join("; ");

const OFF_OR_KEYS = ["before the highlight", "after the highlight", "inside the highlight, by arrow keys"];

test("the end-marker gap: with the caret in the paragraph, before the highlight, after it, or inside it by arrow keys, the highlight's last character is as far from the next character as with no comment, within 1 px (ticket arh58dxz)", async (t) => {
  const rows = await measureGaps(t, OFF_OR_KEYS);
  assert.ok(rows.every((row) => Math.abs(row.marked.end - row.plain.end) <= 1), report(rows, "end"));
});

// The ticket body's criterion for the gap before the highlight, as the body states it.
test("the start-marker gap: with the caret in the paragraph, before the highlight, after it, or inside it by arrow keys, the character before the highlight is as far from its first character as with no comment, within 1 px (ticket arh58dxz)", async (t) => {
  const rows = await measureGaps(t, OFF_OR_KEYS);
  assert.ok(rows.every((row) => Math.abs(row.marked.start - row.plain.start) <= 1), report(rows, "start"));
});
