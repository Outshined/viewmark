import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import zlib from "node:zlib";
import { launchBrowser, Page, startHub } from "./harness.js";

// A page built like the owner's Test Page, which turned up czp4tesp: a heading, a picture with an
// angle-bracket address, a lone number, a quote holding a list, text after the quote, a numbered
// list with tab-indented items under it, an empty item and a line after it, loose items, a picture
// with pins, a source fence, a table, a rule, and a prose comment. The walks check that the caret
// moves through the page in order, stops on every drawn line of text, never jumps to the top, and
// never lands in the stored comments. The typing tests check that a letter goes in at the caret on
// each kind of line. A picture that turns back into its markdown on its line must be drawn again
// when the caret leaves it, and the caret is never drawn inside a picture. Tickets this page has
// caught or covers: czp4tesp, g92jk6em, pn4hbr22, r5kwsdqr, 8r57d6f2. The vim walks fail until g92jk6em
// and pn4hbr22 are fixed.

// A solid picture of w by h, big enough to cover several lines of text.
function png(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head[8] = 8;
  head[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x60)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const PNG = png(400, 220);

const TEXT = [
  "# Test Page",
  "",
  "![top.png](<Test Page/top.png>)",
  "",
  "1",
  "",
  "> quoted block",
  "> * List under a quoted block",
  "> * second list in a quoted block",
  "",
  "",
  "Not in quoted block.",
  "1. numbered item ",
  "2. second numbered item",
  "\t* unordered under second",
  "\t* ",
  "unordered second under second numbered",
  "",
  "* Another list item ",
  "",
  "* Third list item",
  "",
  "1. first",
  "2. second",
  "3. third",
  "",
  "Image pasted in:",
  "",
  "![pins.png](<Test Page/pins.png>)",
  "```comment c1 0.62,0.78",
  ":: 0",
  "@2026-10-16T22:04:35.575Z qa",
  "Dog!",
  "```",
  "",
  "A fence:",
  "",
  "```javascript",
  "function f() {",
  "  return 1;",
  "}",
  "```",
  "",
  "| a | b |",
  "|---|---|",
  "| 1 | 2 |",
  "",
  "---",
  "",
  "Last {c2}commented{/c2} line.",
  "",
  "```comment c2",
  ":: 0",
  "@2026-10-16T22:05:00.000Z qa",
  "A prose note.",
  "```",
  "",
  "End of page.",
  "",
].join("\n");

// The drawn lines of text a walk must stop on, in order, by the text each holds.
const STOPS = [
  "Test Page", "1", "quoted block", "List under a quoted block", "second list in a quoted block",
  "Not in quoted block.", "numbered item", "second numbered item", "unordered under second",
  "unordered second under second numbered", "Another list item", "Third list item", "first", "second", "third",
  "Image pasted in:", "A fence:", "function f() {", "  return 1;", "}", "| a | b |", "| 1 | 2 |", "commented", "End of page.",
];

// Each stop's line, found in order so a repeated word finds its own line.
const LINES = (() => {
  const out = [];
  let from = 0;
  for (const text of STOPS) {
    const at = TEXT.indexOf(text, from);
    assert.ok(at >= 0, `stop ${text}`);
    const start = TEXT.lastIndexOf("\n", at - 1) + 1;
    const end = TEXT.indexOf("\n", at);
    out.push({ text, start, end, at });
    from = end;
  }
  // The empty item `\t* ` and the line after it are drawn as one row, so a stop on either is on it.
  const lazy = out.find((l) => l.text === "unordered second under second numbered");
  lazy.start = TEXT.lastIndexOf("\n", lazy.start - 2) + 1;
  return out;
})();

const COMMENTS = [...TEXT.matchAll(/```comment[^\n]*\n[\s\S]*?\n```/g)].map((m) => ({ from: m.index, to: m.index + m[0].length }));
const inComment = (offset) => COMMENTS.some((c) => offset > c.from && offset < c.to);

async function setup(t, vim) {
  const hub = await startHub();
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await hub.close();
  });
  hub.plant("Test Page.md", TEXT);
  hub.plant("Test Page/top.png", PNG);
  hub.plant("Test Page/pins.png", PNG);
  const page = new Page(browser.session, hub.port);
  await page.init();
  if (vim) await page.session.send("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem("viewmark.vim", "1");` });
  await page.login();
  await page.open("Test Page.md");
  await page.quiet();
  return { hub, page };
}

// A click at a text offset, after scrolling it into the window as a person would.
async function clickAt(page, offset) {
  await page.eval(`(() => { const p = window.__qaClickPoint(${offset}); if (p && (p.y < 40 || p.y > innerHeight - 40)) window.scrollBy(0, p.y - innerHeight / 2); return true; })()`);
  await page.quiet();
  return page.clickOffset(offset);
}

// After each step: when the caret is off an image line, every picture is drawn, and the caret is
// not drawn inside a picture's box.
async function pictures(page, offset, step) {
  const onImage = TEXT.slice(TEXT.lastIndexOf("\n", offset - 1) + 1).startsWith("![");
  const state = await page.eval(`(() => ({
    pictures: [...document.querySelectorAll(".md-image img")].map((i) => { const r = i.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, drawn: i.complete && i.naturalWidth > 0 && r.height > 20 }; }),
  }))()`);
  const caret = await page.caret();
  if (!onImage) assert.equal(state.pictures.filter((p) => p.drawn).length, 2, `${step}: off the image lines, not both pictures are drawn: ${JSON.stringify(state.pictures)}`);
  if (caret.rect) {
    const mid = (caret.rect.top + caret.rect.bottom) / 2;
    const inside = state.pictures.find((p) => p.drawn && mid > p.top + 2 && mid < p.bottom - 2);
    assert.ok(!inside, `${step}: the caret is drawn at y ${Math.round(mid)}, inside a picture at ${Math.round(inside && inside.top)} to ${Math.round(inside && inside.bottom)}`);
  }
}

async function walk(page, key, from, until, limit = 120) {
  assert.ok(await clickAt(page, from), `no point at ${from}`);
  await page.quiet();
  const seen = [(await page.caret()).focus];
  for (let n = 0; n < limit; n += 1) {
    await page.key(key);
    await page.quiet();
    const focus = (await page.caret()).focus;
    seen.push(focus);
    await pictures(page, focus, `${key} press ${n + 1}, offset ${focus}`);
    if (until(focus)) break;
  }
  return seen;
}

function check(seen, forward) {
  const lines = forward ? LINES : [...LINES].reverse();
  for (let i = 1; i < seen.length; i += 1) {
    const a = seen[i - 1];
    const b = seen[i];
    assert.ok(b !== 0 || (!forward && a !== 0 && LINES[0].start === 0 && b === 0 && i === seen.length - 1), `press ${i} put the caret at offset 0, from ${a}: ${JSON.stringify(seen)}`);
    assert.ok(forward ? b > a : b < a, `press ${i} moved the caret from ${a} to ${b}, not ${forward ? "down" : "up"}: ${JSON.stringify(seen)}`);
    assert.ok(!inComment(b), `press ${i} put the caret at ${b}, inside a stored comment`);
  }
  let k = 0;
  for (const offset of seen) {
    if (k < lines.length && offset >= lines[k].start && offset <= lines[k].end) k += 1;
  }
  assert.equal(k, lines.length, `the walk did not stop on ${JSON.stringify(lines[k] && lines[k].text)}: it went ${JSON.stringify(seen.map((o) => TEXT.slice(TEXT.lastIndexOf("\n", o - 1) + 1, TEXT.lastIndexOf("\n", o - 1) + 15)))}`);
}

const FIRST = LINES[0].at + 2;
const LAST = LINES[LINES.length - 1].at + 2;
const onLast = (o) => o >= LINES[LINES.length - 1].start && o <= LINES[LINES.length - 1].end;
const onFirst = (o) => o >= LINES[0].start && o <= LINES[0].end;

test("construct walk (g92jk6em): with vim keys on, j from the top stops on every drawn line in order, and never jumps to the top or into a stored comment", async (t) => {
  const { page } = await setup(t, true);
  await clickAt(page, FIRST);
  await page.key("Escape");
  check(await walk(page, "j", FIRST, onLast), true);
});

test("construct walk (g92jk6em, pn4hbr22): with vim keys on, k from the bottom stops on every drawn line in order, and never jumps to the top or into a stored comment", async (t) => {
  const { page } = await setup(t, true);
  await clickAt(page, LAST);
  await page.key("Escape");
  check(await walk(page, "k", LAST, onFirst), false);
});

test("construct walk: with vim keys off, ↓ from the top stops on every drawn line in order, and never jumps to the top or into a stored comment", async (t) => {
  const { page } = await setup(t, false);
  check(await walk(page, "↓", FIRST, onLast), true);
});

test("construct walk: with vim keys off, ↑ from the bottom stops on every drawn line in order, and never jumps to the top or into a stored comment", async (t) => {
  const { page } = await setup(t, false);
  check(await walk(page, "↑", LAST, onFirst), false);
});

// ---- A letter typed on each kind of line ------------------------------------------------------

const TYPED = STOPS.filter((s) => s.trim().length > 2 && s !== "commented");

for (const vim of [false, true]) {
  test(`construct typing: with vim keys ${vim ? "on" : "off"}, a click in the text of each kind of line and a typed letter put the letter at the click`, async (t) => {
    const { hub, page } = await setup(t, vim);
    const failures = [];
    for (const line of LINES.filter((l) => TYPED.includes(l.text))) {
      const before = (await hub.show("Test Page.md")).text;
      const at = before.indexOf(line.text, before.indexOf(line.text) >= 0 ? 0 : 0) + Math.min(3, line.text.length - 1);
      if (!(await clickAt(page, at))) {
        failures.push(`${JSON.stringify(line.text)}: no point at ${at}`);
        continue;
      }
      await page.quiet();
      // A click on a closed table opens it with the caret at the start of the cell (R81), so a
      // second click puts the caret where the person means to type.
      if (line.text.startsWith("|")) {
        assert.ok(await clickAt(page, at));
        await page.quiet();
      }
      if (vim) {
        await page.key("Escape");
        await page.quiet();
        assert.ok(await clickAt(page, at));
        await page.quiet();
        await page.key("i");
      }
      await page.key("Z");
      await page.quiet();
      await sleep(150);
      const after = (await hub.show("Test Page.md")).text;
      if (after !== before.slice(0, at) + "Z" + before.slice(at)) {
        let i = 0;
        while (i < after.length && after[i] === before[i]) i += 1;
        failures.push(`${JSON.stringify(line.text)}: clicked at ${at}, Z went to ${i}`);
      }
      if (vim) {
        await page.key("Escape");
        await page.key("u");
      } else {
        await page.key("z", ["Ctrl"]);
      }
      await page.quiet();
      await sleep(150);
      const undone = (await hub.show("Test Page.md")).text;
      if (undone !== before) failures.push(`${JSON.stringify(line.text)}: undo did not put the text back`);
    }
    assert.deepEqual(failures, []);
  });
}
