import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "../harness.js";

// The flag is read once, when the editor is created. A later write does not turn keys on.
const VIM = "viewmark.vim";
// A marker is a comment only when its thread is stored after the prose.
const CM = "\n\n```comment c1\n:: 0\n@2026-10-05T16:00:00.000Z Ada\nNote.\n```\n";

function marked(text) {
  const bytes = text.replace(/[‸«]/g, "");
  const focusAt = text.indexOf("‸");
  const anchorAt = text.indexOf("«");
  const position = (at) => at - (anchorAt >= 0 && anchorAt < at ? 1 : 0) - (focusAt >= 0 && focusAt < at ? 1 : 0);
  const focus = focusAt < 0 ? null : position(focusAt);
  const anchor = anchorAt < 0 ? focus : position(anchorAt);
  return { bytes, focus, anchor };
}

function withCaret(text, focus, anchor = focus) {
  let out = "";
  const atFocus = Number.isInteger(focus) ? focus : -1;
  const atAnchor = Number.isInteger(anchor) ? anchor : atFocus;
  for (let i = 0; i <= text.length; i += 1) {
    if (atAnchor !== atFocus && i === atAnchor) out += "«";
    if (i === atFocus) out += "‸";
    if (i < text.length) out += text[i];
  }
  return out;
}

function markerSpans(text) {
  const spans = [];
  for (const match of text.matchAll(/\{\/?[A-Za-z][\w-]*\}/g)) {
    spans.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
  }
  return spans;
}

function insideMarker(text, offset) {
  return markerSpans(text).some((span) => offset > span.start && offset < span.end);
}

function lineText(text, offset) {
  let start = Math.max(0, Math.min(text.length, offset));
  while (start > 0 && text[start - 1] !== "\n") start -= 1;
  let end = start;
  while (end < text.length && text[end] !== "\n") end += 1;
  if (end > start && text[end - 1] === "\r") end -= 1;
  return text.slice(start, end);
}

async function setup(t, docs) {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  for (const [file, text] of Object.entries(docs)) await hub.create(file, text);
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.session.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `localStorage.setItem(${JSON.stringify(VIM)}, "1");`,
  });
  await page.login();
  return { hub, page };
}

async function openFile(page, file) {
  await page.open(file);
  assert.equal(await page.eval(`localStorage.getItem(${JSON.stringify(VIM)})`), "1");
}

// Raw is the source view. The caret is placed after the toggle, on the bytes it shows.
async function enterRaw(page) {
  for (let i = 0; i < 4; i += 1) {
    if (await page.eval(`document.getElementById("editor").classList.contains("md-source")`)) return;
    const point = await page.eval(`(() => {
      const button = document.querySelector("button.md-view-toggle");
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
    })()`);
    assert.ok(point, "no raw toggle");
    await page.click(point.x, point.y);
    await page.quiet();
  }
  assert.equal(await page.eval(`document.getElementById("editor").classList.contains("md-source")`), true, "#editor.md-source");
}

async function place(page, text, offset) {
  assert.equal(insideMarker(text, offset), false, `refusing a caret inside a marker at ${offset}`);
  assert.equal(await page.clickOffset(offset), true, `no point at offset ${offset}`);
  await page.quiet();
  const caret = await page.caret();
  const got = withCaret(text, caret && caret.focus, caret && caret.anchor);
  assert.ok(caret && !caret.none && caret.inside, `no caret after click, got ${got}`);
  assert.equal(caret.focus, offset, `click placed ${got}`);
  assert.equal(caret.anchor, offset, `click placed ${got}`);
  return caret;
}

async function press(page, sequence) {
  for (const key of sequence) {
    await page.key(key);
    await page.quiet();
  }
}

async function snap(hub, page, file) {
  const shown = await hub.show(file);
  const caret = await page.caret();
  return { text: shown.text, rev: shown.rev, caret };
}

function shown(snap) {
  const caret = snap.caret || {};
  return withCaret(snap.text, caret.focus, caret.anchor);
}

function sourceShape(page) {
  return page.eval(`(() => {
    const root = document.getElementById("editor");
    return {
      source: root.classList.contains("md-source"),
      tables: root.querySelectorAll(".md-table").length,
      diagrams: root.querySelectorAll(".md-diagram").length,
      lines: [...root.querySelectorAll(".md-line")].map((el) => ({
        raw: el.classList.contains("md-raw"),
        text: el.textContent,
      })),
    };
  })()`);
}

// Glyphs whose centers sit in the selection's boxes, against glyphs in [lo, hi).
function selectionCover(page, lo, hi) {
  return page.eval(`(() => {
    const lo = ${lo};
    const hi = ${hi};
    const sel = getSelection();
    if (!sel || sel.rangeCount === 0) return { none: true, covered: [], selected: [] };
    const range = sel.getRangeAt(0);
    const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
    const hit = (box) => {
      const x = (box.left + box.right) / 2;
      const y = (box.top + box.bottom) / 2;
      return rects.some((rect) => x >= rect.left - 1 && x <= rect.right + 1 && y >= rect.top && y <= rect.bottom);
    };
    const covered = [];
    const root = document.getElementById("editor");
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement && node.parentElement.closest("button, .md-lock")) continue;
      const tagged = node.parentElement && node.parentElement.closest("[data-start]");
      if (!tagged) continue;
      const start = Number(tagged.dataset.start);
      const end = Number(tagged.dataset.end);
      if (end - start !== node.length) continue;
      for (let i = 0; i < node.length; i += 1) {
        const glyph = document.createRange();
        glyph.setStart(node, i);
        glyph.setEnd(node, i + 1);
        const box = glyph.getClientRects()[0];
        if (!box || !(box.width > 0) || !(box.height > 0)) continue;
        if (hit(box)) covered.push(start + i);
      }
    }
    const selected = [];
    for (let i = lo; i < hi; i += 1) if (window.__qaGlyph(i)) selected.push(i);
    return { covered, selected };
  })()`);
}

test("VW.8 (ticket 7vdep2z4)", async (t) => {
  const starts = {
    "8a.md": marked(`abcdef‸\nSee {c1}this{/c1} now.${CM}`),
    "8b.md": marked(`See ‸{c1}this{/c1} now.${CM}`),
    "8c.md": marked(`‸See {c1}this{/c1} now.${CM}`),
    "8d.md": marked(`‸x {c1}a{/c1} y.${CM}`),
  };
  const { hub, page } = await setup(t, Object.fromEntries(Object.entries(starts).map(([file, doc]) => [file, doc.bytes])));
  const failures = [];
  const run = async (id, fn) => {
    try {
      await fn();
    } catch (err) {
      failures.push(`${id}: ${err.message}`);
    }
  };

  await run("VW.8a", async () => {
    const file = "8a.md";
    const start = starts[file];
    await openFile(page, file);
    await place(page, start.bytes, start.focus);
    const before = await snap(hub, page, file);
    await press(page, ["j"]);
    const after = await snap(hub, page, file);
    const got = shown(after);
    assert.equal(after.text, before.text, `VW.8a bytes\n${got}`);
    assert.equal(after.rev, before.rev, `VW.8a rev ${before.rev} -> ${after.rev}\n${got}`);
    assert.equal(after.caret.anchor, after.caret.focus, `VW.8a selection\n${got}`);
    assert.equal(after.caret.focus, before.caret.focus, `VW.8a caret\n${got}`);
    assert.equal(insideMarker(after.text, after.caret.focus), false, `VW.8a inside a marker\n${got}`);
    assert.equal(lineText(after.text, after.caret.focus), "abcdef", `VW.8a not on abcdef\n${got}`);
  });

  await run("VW.8b", async () => {
    const file = "8b.md";
    const start = starts[file];
    const want = marked(`See {c1}‸this{/c1} now.${CM}`);
    await openFile(page, file);
    await place(page, start.bytes, start.focus);
    const before = await snap(hub, page, file);
    await press(page, ["l"]);
    const after = await snap(hub, page, file);
    assert.equal(after.text, want.bytes, `VW.8b bytes\n${shown(after)}`);
    assert.equal(after.rev, before.rev, `VW.8b rev ${before.rev} -> ${after.rev}\n${shown(after)}`);
    assert.equal(shown(after), withCaret(want.bytes, want.focus, want.anchor), `VW.8b caret\n${shown(after)}`);
    assert.equal(insideMarker(after.text, after.caret.focus), false, `VW.8b inside a marker\n${shown(after)}`);
  });

  await run("VW.8c", async () => {
    const file = "8c.md";
    const start = starts[file];
    await openFile(page, file);
    await place(page, start.bytes, start.focus);
    const before = await snap(hub, page, file);
    await press(page, ["f", "c"]);
    const after = await snap(hub, page, file);
    assert.equal(after.text, before.text, `VW.8c bytes\n${shown(after)}`);
    assert.equal(after.rev, before.rev, `VW.8c rev ${before.rev} -> ${after.rev}\n${shown(after)}`);
    assert.equal(shown(after), shown(before), `VW.8c caret\n${shown(after)}`);
  });

  await run("VW.8d", async () => {
    const file = "8d.md";
    const start = starts[file];
    const want = marked(`x {c1}‸a{/c1} y.${CM}`);
    await openFile(page, file);
    await place(page, start.bytes, start.focus);
    const before = await snap(hub, page, file);
    await press(page, ["%"]);
    const after = await snap(hub, page, file);
    assert.equal(after.text, want.bytes, `VW.8d bytes\n${shown(after)}`);
    assert.equal(after.rev, before.rev, `VW.8d rev ${before.rev} -> ${after.rev}\n${shown(after)}`);
    assert.equal(shown(after), withCaret(want.bytes, want.focus, want.anchor), `VW.8d caret\n${shown(after)}`);
    assert.equal(insideMarker(after.text, after.caret.focus), false, `VW.8d inside a marker\n${shown(after)}`);
  });

  assert.deepEqual(failures, []);
});

test("VW.9 (ticket 7vdep2z4)", async (t) => {
  const start = marked("‸x\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n");
  const want = marked("x\n\n‸| a | b |\n| --- | --- |\n| 1 | 2 |\n");
  const file = "9.md";
  const { hub, page } = await setup(t, { [file]: start.bytes });
  await openFile(page, file);
  await place(page, start.bytes, start.focus);
  const before = await snap(hub, page, file);
  await press(page, ["j"]);
  const after = await snap(hub, page, file);
  const shape = await sourceShape(page);
  assert.equal(after.text, want.bytes, `VW.9 bytes\n${shown(after)}`);
  assert.equal(after.rev, before.rev, `VW.9 rev ${before.rev} -> ${after.rev}\n${shown(after)}`);
  assert.equal(shown(after), withCaret(want.bytes, want.focus), `VW.9 caret\n${shown(after)}`);
  assert.equal(shape.tables, 0, `VW.9 table stayed closed\n${JSON.stringify(shape)}\n${shown(after)}`);
  assert.ok(
    shape.lines.some((line) => line.raw && line.text.includes("| a | b |")),
    `VW.9 table is not source\n${JSON.stringify(shape)}\n${shown(after)}`,
  );
});

test("VW.10 (ticket 7vdep2z4)", async (t) => {
  const start = marked("‸x\n\n```mermaid\ngraph TD\nA-->B\n```\n");
  const want = marked("x\n\n‸```mermaid\ngraph TD\nA-->B\n```\n");
  const file = "10.md";
  const { hub, page } = await setup(t, { [file]: start.bytes });
  await openFile(page, file);
  await place(page, start.bytes, start.focus);
  const before = await snap(hub, page, file);
  // VW.10a
  await press(page, ["j"]);
  const after = await snap(hub, page, file);
  const shape = await sourceShape(page);
  assert.equal(after.text, want.bytes, `VW.10a bytes\n${shown(after)}`);
  assert.equal(after.rev, before.rev, `VW.10a rev ${before.rev} -> ${after.rev}\n${shown(after)}`);
  assert.equal(shown(after), withCaret(want.bytes, want.focus), `VW.10a caret\n${shown(after)}`);
  assert.equal(shape.diagrams, 0, `VW.10a diagram stayed drawn\n${JSON.stringify(shape)}\n${shown(after)}`);
  assert.ok(
    shape.lines.some((line) => line.text.includes("```mermaid")),
    `VW.10a diagram is not source\n${JSON.stringify(shape)}\n${shown(after)}`,
  );
});

test("VW.11 (ticket 7vdep2z4)", async (t) => {
  const start = marked("al‸pha\r\nbeta\r\n");
  const want = marked("alpha\r\n‸beta\r\n");
  const file = "11.md";
  const { hub, page } = await setup(t, { [file]: start.bytes });
  await openFile(page, file);
  await enterRaw(page);
  await place(page, start.bytes, start.focus);
  const before = await snap(hub, page, file);
  await press(page, ["3", "l", "l"]);
  const after = await snap(hub, page, file);
  assert.equal(await page.eval(`document.getElementById("editor").classList.contains("md-source")`), true, `VW.11 left raw\n${shown(after)}`);
  assert.equal(after.text, want.bytes, `VW.11 bytes\n${shown(after)}`);
  assert.equal(after.rev, before.rev, `VW.11 rev ${before.rev} -> ${after.rev}\n${shown(after)}`);
  assert.equal(shown(after), withCaret(want.bytes, want.focus), `VW.11 caret\n${shown(after)}`);
});

test("VW.12 (ticket 7vdep2z4)", async (t) => {
  const start = marked("al‸pha\n\nbeta\n");
  const file = "12.md";
  const { hub, page } = await setup(t, { [file]: start.bytes });
  await openFile(page, file);
  await place(page, start.bytes, start.focus);
  const before = await snap(hub, page, file);
  await press(page, ["v", "j"]);
  const after = await snap(hub, page, file);
  const focus = after.caret.focus;
  const anchor = after.caret.anchor;
  const blank = after.text.indexOf("\n\n") + 1;
  assert.equal(after.text, start.bytes, `VW.12 bytes\n${shown(after)}`);
  assert.equal(after.rev, before.rev, `VW.12 rev ${before.rev} -> ${after.rev}\n${shown(after)}`);
  assert.equal(lineText(after.text, focus), "beta", `VW.12 caret is not on beta\n${shown(after)}`);
  assert.notEqual(focus, blank, `VW.12 caret is on the blank\n${shown(after)}`);
  assert.notEqual(anchor, focus, `VW.12 selection collapsed\n${shown(after)}`);
  const lo = Math.min(anchor, focus);
  const hi = Math.max(anchor, focus);
  const cover = await selectionCover(page, lo, hi);
  const chars = (offsets) => offsets.map((offset) => after.text[offset]).join("");
  assert.deepEqual(
    cover.covered,
    cover.selected,
    `VW.12 selection covers ${JSON.stringify(chars(cover.covered))}, selected ${JSON.stringify(chars(cover.selected))}\n${shown(after)}`,
  );
});
