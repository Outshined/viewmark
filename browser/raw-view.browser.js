import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { AGENT, OTHER, REPO, USER, cli, launchBrowser, Page, startHub } from "./harness.js";

// Acceptance for ticket awtyv87s, the raw view, from the Acceptance section of its body.
// Each test names the part it checks. A title that says "default" checks a default QA
// chose where the request left a choice open; a failure there is a question for the owner,
// not a bug. Every action is a real key or mouse event, except focusing the toggle before
// Enter or Space, which has no other route.

const FOX = "the quick brown fox jumps over the lazy dog";
function fill77(text) {
  const lines = [];
  for (const word of text.split(" ")) {
    const last = lines.length - 1;
    if (last >= 0 && lines[last].length + 1 + word.length <= 77) lines[last] += ` ${word}`;
    else lines.push(word);
  }
  return lines.join("\n");
}
const WRAP = fill77(Array(14).fill(FOX).join(" "));
const BIG = `${`${FOX} `.repeat(30)}end`;
const CM = (id) => `\n\n\`\`\`comment ${id}\n:: 0\n@2026-10-05T16:00:00.000Z Ada\nNote ${id}.\n\`\`\`\n`;
const TOGGLE = "#editor button.md-view-toggle";

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
  return { hub, page, browser };
}

async function secondTab(browser, hub, user = USER) {
  const { session } = await browser.newSession();
  const page = new Page(session, hub.port);
  await page.init();
  await page.login(user);
  return page;
}

async function open(page, file) {
  await page.open(file);
  await page.until(() => page.eval(`document.querySelectorAll("#editor .md-line, #editor .md-atom").length > 0 && !!document.querySelector(${JSON.stringify(TOGGLE)})`), `${file} drawn with its toggle`);
}

const isRaw = (page) => page.eval(`(() => { const b = document.querySelector(${JSON.stringify(TOGGLE)}); return !!b && b.getAttribute("aria-pressed") === "true" && document.getElementById("editor").classList.contains("md-source"); })()`);

async function toggle(page) {
  const before = await isRaw(page);
  const pt = await page.eval(`(() => { const r = document.querySelector(${JSON.stringify(TOGGLE)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.click(pt.x, pt.y);
  await page.until(async () => (await isRaw(page)) !== before, "the view to change");
  await page.quiet();
}

// A line's own text, without the name label another session's hold adds to it.
const lines = (page) => page.eval(`[...document.querySelectorAll("#editor .md-line")].map((l) => { const c = l.cloneNode(true); for (const x of c.querySelectorAll(".md-lock")) x.remove(); return c.textContent; })`);
const show = async (hub, file) => (await hub.show(file)).text;
const glyph = (page, offset) => page.eval(`window.__qaGlyph(${offset})`);

async function place(page, offset) {
  assert.ok(await page.clickOffset(offset), `no point for offset ${offset}`);
  await page.quiet();
}

async function press(page, key, modifiers = [], times = 1) {
  for (let i = 0; i < times; i += 1) await page.key(key, modifiers);
  await page.quiet();
}

// Offsets where each visual line starts, measured in the page as drawn now.
async function visualStarts(page, from, to) {
  const mids = await page.eval(`(() => { const out = []; for (let o = ${from}; o < ${to}; o += 1) { const g = window.__qaGlyph(o); out.push(g ? (g.top + g.bottom) / 2 : null); } return out; })()`);
  const starts = [];
  let prev = null;
  mids.forEach((mid, i) => {
    if (mid == null) return;
    if (prev == null || Math.abs(mid - prev) > 3) starts.push(from + i);
    prev = mid;
  });
  return starts;
}

// The typed letter must be drawn where the caret was drawn just before the key (R99).
async function typedWhereCaret(page, hub, file, label) {
  const before = await show(hub, file);
  const caret = await page.caret();
  assert.ok(caret.rect, `${label}: the caret is not drawn`);
  await page.key("Q");
  await page.quiet();
  const after = await show(hub, file);
  let at = 0;
  while (at < after.length && before[at] === after[at]) at += 1;
  assert.equal(after[at], "Q", `${label}: the Q went to ${at}`);
  const q = await glyph(page, at);
  assert.ok(q, `${label}: the Q is not drawn`);
  const qy = (q.top + q.bottom) / 2;
  const cy = (caret.rect.top + caret.rect.bottom) / 2;
  const here = Math.abs(q.left - caret.rect.x) <= 3 && Math.abs(qy - cy) <= 3;
  // A Q at the end of a word that just fits carries the word onto the next line.
  const lead = at > 0 ? await glyph(page, at - 1) : null;
  const carried = lead && Math.abs(q.left - lead.right) <= 3 && Math.abs(qy - (lead.top + lead.bottom) / 2) <= 2 && Math.abs(qy - cy) > 3;
  assert.ok(here || carried, `${label}: the Q is drawn at x ${q.left.toFixed(1)} y ${qy.toFixed(1)}, but the caret was drawn at x ${caret.rect.x.toFixed(1)} y ${cy.toFixed(1)}`);
  await page.key("Backspace");
  await page.quiet();
  return at;
}

// ---- The toggle -------------------------------------------------------------------------

test("toggle: a toggle sends no edit, and the bytes and rev stay the same", async (t) => {
  const doc = "# Title\n\nSome **bold** text.\n\n- item\n";
  const { hub, page } = await setup(t, { "a.md": doc });
  await open(page, "a.md");
  const before = await hub.show("a.md");
  const sent = () => page.frames.filter((f) => f.dir === "out" && f.data && ["edit", "undo", "redo"].includes(f.data.type)).length;
  const edits = sent();
  await toggle(page);
  assert.equal(await isRaw(page), true);
  await toggle(page);
  assert.equal(sent(), edits, "a toggle sent an edit");
  const after = await hub.show("a.md");
  assert.equal(after.text, before.text);
  assert.equal(after.rev, before.rev);
});

test("toggle: the caret and the selection keep their offsets both ways, and the caret is drawn there", async (t) => {
  const doc = "alpha beta gamma\n\nsecond line here\n";
  const { page } = await setup(t, { "a.md": doc });
  await open(page, "a.md");
  const n = "alpha be".length;
  await place(page, n);
  for (const way of ["to raw", "back to rendered"]) {
    await toggle(page);
    const c = await page.caret();
    assert.equal(c.focus, n, `${way}: the caret moved to ${c.focus}`);
    const spot = await page.boundary(n);
    assert.ok(c.rect && spot && Math.abs(c.rect.x - spot.x) <= 2 && (c.rect.top + c.rect.bottom) / 2 >= spot.top - 2 && (c.rect.top + c.rect.bottom) / 2 <= spot.bottom + 2, `${way}: the caret is drawn at ${JSON.stringify(c.rect)}, the offset at ${JSON.stringify(spot)}`);
    const inView = await page.eval(`(() => { const r = getSelection().getRangeAt(0).getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; })()`);
    assert.equal(inView, true, `${way}: the caret's line is out of view`);
  }
  const a = "second ".length + doc.indexOf("second");
  await place(page, doc.indexOf("second"));
  await press(page, "→", ["Shift"], 7);
  const sel = await page.caret();
  assert.deepEqual([sel.anchor, sel.focus], [doc.indexOf("second"), a]);
  for (const way of ["to raw", "back to rendered"]) {
    await toggle(page);
    const c = await page.caret();
    assert.deepEqual([c.anchor, c.focus], [doc.indexOf("second"), a], `${way}: the selection changed`);
  }
});

test("toggle: the focus is back in the editor, and the next letter goes in at the caret where it is drawn", async (t) => {
  const doc = "alpha beta gamma\n";
  const { hub, page } = await setup(t, { "a.md": doc });
  await open(page, "a.md");
  await place(page, 8);
  await toggle(page);
  const focused = await page.eval(`(() => { const e = document.getElementById("editor"); return document.activeElement === e || e.contains(document.activeElement) && !document.activeElement.matches("button"); })()`);
  assert.equal(focused, true, "the focus is not in the editor after the toggle");
  const at = await typedWhereCaret(page, hub, "a.md", "raw after the toggle");
  assert.equal(at, 8);
  await toggle(page);
  assert.equal(await typedWhereCaret(page, hub, "a.md", "rendered after the toggle"), 8);
});

test("toggle: another tab on the same file keeps its own mode", async (t) => {
  const { hub, page: A, browser } = await setup(t, { "a.md": "alpha\n\nbeta\n" });
  await open(A, "a.md");
  await toggle(A);
  const B = await secondTab(browser, hub);
  await open(B, "a.md");
  assert.equal(await isRaw(B), false, "a second tab opened in raw mode");
  await toggle(B);
  assert.equal(await isRaw(A), true);
  await toggle(A);
  await sleep(300);
  assert.equal(await isRaw(B), true, "a toggle in the first tab changed the second");
});

test("toggle: one undo history covers both modes", async (t) => {
  const { hub, page } = await setup(t, { "a.md": "alpha\n" });
  await open(page, "a.md");
  await place(page, 5);
  await press(page, "a");
  await toggle(page);
  await press(page, "b");
  assert.equal(await show(hub, "a.md"), "alphaab\n");
  await press(page, "z", ["Ctrl"]);
  assert.equal(await show(hub, "a.md"), "alphaa\n");
  assert.equal((await page.caret()).focus, 6, "the first undo did not restore the caret");
  await press(page, "z", ["Ctrl"]);
  assert.equal(await show(hub, "a.md"), "alpha\n");
  assert.equal((await page.caret()).focus, 5, "the second undo did not restore the caret");
});

test("toggle (default, a question for the owner): the mode belongs to the tab, across another file and a reload, and a new tab starts rendered", async (t) => {
  const { hub, page, browser } = await setup(t, { "a.md": "alpha\n", "b.md": "beta\n" });
  await open(page, "a.md");
  await toggle(page);
  const since = page.frames.length;
  const fileButton = await page.eval(`(() => { const b = [...document.querySelectorAll(".file-block button.md-file")].find((x) => x.textContent.includes("b.md")); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + 10, y: r.top + r.height / 2 }; })()`);
  assert.ok(fileButton, "no b.md in the files list");
  await page.click(fileButton.x, fileButton.y);
  await page.until(() => page.frames.slice(since).some((f) => f.dir === "in" && f.data && f.data.type === "file" && f.data.path === "b.md"), "b.md opened from the files list");
  await page.quiet();
  assert.equal(await isRaw(page), true, "opening another file in the tab left raw mode");
  await open(page, "a.md");
  assert.equal(await isRaw(page), true, "a reload left raw mode");
  const C = await secondTab(browser, hub);
  await open(C, "a.md");
  assert.equal(await isRaw(C), false, "a new tab did not start rendered");
});

// ---- Nothing is rendered ------------------------------------------------------------------

test("nothing rendered: a table, a diagram, an image, headings, emphasis, links, and quotes are plain text", async (t) => {
  const doc = "# Heading\n\nSome **bold** and *italic* and [a link](https://x.test/) text.\n\n> quoted line\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```mermaid\ngraph TD\nA-->B\n```\n\n![box](box.svg)\n";
  const { page } = await setup(t, { "a.md": doc });
  await open(page, "a.md");
  await toggle(page);
  const found = await page.eval(`(() => {
    const e = document.getElementById("editor");
    const outside = (el) => !el.closest("button.md-view-toggle");
    return {
      tables: [...e.querySelectorAll("table, td, th")].filter(outside).length,
      svgs: [...e.querySelectorAll("svg")].filter(outside).length,
      images: [...e.querySelectorAll("img")].filter(outside).length,
      links: [...e.querySelectorAll("a")].filter(outside).length,
      elements: [...e.querySelectorAll(".md-line *")].filter((el) => el.tagName !== "BR" && outside(el) && !el.closest(".md-lock")).map((el) => el.tagName + "." + el.className),
    };
  })()`);
  assert.deepEqual([found.tables, found.svgs, found.images, found.links], [0, 0, 0, 0], JSON.stringify(found));
  assert.deepEqual(found.elements, [], "a raw line holds markup elements");
  assert.deepEqual(await lines(page), doc.split("\n"));
  const style = await page.eval(`(() => { const ls = [...document.querySelectorAll("#editor .md-line")]; const s = (i) => { const c = getComputedStyle(ls[i]); return c.fontSize + " " + c.fontWeight + " " + c.fontStyle; }; return { heading: s(0), body: s(2), quote: s(4) }; })()`);
  assert.equal(style.heading, style.body, "the heading is drawn in another size or weight");
  assert.equal(style.quote, style.body, "the quote is drawn in another style");
});

test("nothing rendered (default, a question for the owner): a code fence has no syntax colors", async (t) => {
  const doc = "Text.\n\n```js\nconst x = 1; // note\n```\n";
  const { page } = await setup(t, { "a.md": doc });
  await open(page, "a.md");
  await toggle(page);
  const colors = await page.eval(`[...document.querySelectorAll("#editor .md-line")].map((l) => [getComputedStyle(l).color, [...l.querySelectorAll("*")].filter((el) => el.tagName !== "BR").map((el) => getComputedStyle(el).color)])`);
  const all = new Set(colors.flatMap(([c, inner]) => [c, ...inner]));
  assert.equal(all.size, 1, `raw lines use ${all.size} colors: ${[...all].join(", ")}`);
});

test("nothing rendered (default, a question for the owner): the comment cards are not drawn", async (t) => {
  const { page } = await setup(t, { "a.md": "See {c1}this{/c1} now." + CM("c1") });
  await open(page, "a.md");
  const cards = () => page.eval(`document.querySelectorAll(".md-comment-card").length`);
  assert.equal(await cards(), 1);
  await toggle(page);
  assert.equal(await cards(), 0, "a comment card is drawn in raw mode");
  await toggle(page);
  assert.equal(await cards(), 1, "the card did not come back in rendered mode");
});

// ---- Sharing the file from raw mode --------------------------------------------------------

test("sharing: a block another session holds shows that user's name, a click does not take it, and a key that would touch it is refused and flashed", async (t) => {
  const doc = "alpha\n\nbeta\n";
  const { hub, page: A, browser } = await setup(t, { "a.md": doc });
  await open(A, "a.md");
  await toggle(A);
  const B = await secondTab(browser, hub, OTHER);
  await open(B, "a.md");
  await B.clickOffset(doc.indexOf("beta") + 2);
  await B.quiet();
  await A.until(() => A.eval(`[...document.querySelectorAll("#editor .md-line")].some((l) => l.textContent.includes("beta") && [...l.querySelectorAll(".md-lock")].some((x) => x.textContent.includes(${JSON.stringify(OTHER)})))`), "the raw tab names qa-two on beta", 3000);
  await place(A, 2);
  await A.clickOffset(doc.indexOf("beta") + 1);
  await A.quiet();
  const c = await A.caret();
  assert.ok(c.focus < doc.indexOf("beta"), `a click took the caret into the held block, to ${c.focus}`);
  await place(A, doc.indexOf("beta") - 1);
  await A.key("Delete");
  const flashed = await A.until(() => A.eval(`[...document.querySelectorAll("#editor .md-lock")].some((x) => [...x.classList].some((k) => k !== "md-lock") || x.getAnimations().length > 0) || !!document.querySelector("#editor .md-flash")`), "the refusal flashes", 1500).then(() => true, () => false);
  await A.quiet();
  assert.equal(await show(hub, "a.md"), doc, "a key that touched the held block changed the bytes");
  assert.equal(flashed, true, "the refusal did not flash");
});

test("sharing: an edit from the CLI or another tab shows in the raw tab within one second, and the caret keeps its place", async (t) => {
  const doc = "alpha\n\nbeta\n";
  const { hub, page: A, browser } = await setup(t, { "a.md": doc });
  await open(A, "a.md");
  await toggle(A);
  const n = doc.indexOf("beta") + 2;
  await place(A, n);
  const started = Date.now();
  const out = await hub.edit("a.md", "@@\n alpha\n+zero\n");
  assert.equal(out.code, 0, out.stderr);
  await A.until(async () => (await lines(A)).includes("zero"), "the CLI edit shows", 1000);
  assert.ok(Date.now() - started <= 1500);
  assert.equal((await A.caret()).focus, n + "zero\n".length, "the caret did not keep its place in the text");
  const B = await secondTab(browser, hub);
  await open(B, "a.md");
  await B.clickOffset(1);
  await B.quiet();
  await B.key("Z");
  await A.until(async () => (await lines(A))[0].includes("Z"), "the other tab's edit shows", 1000);
});

test("sharing (default, a question for the owner): typing inside a comment marker gets the answer the CLI gets for the same bytes", async (t) => {
  const doc = "See {c1}this{/c1} now." + CM("c1");
  const { hub, page } = await setup(t, { "a.md": doc, "twin.md": doc });
  await open(page, "a.md");
  await toggle(page);
  await place(page, "See {c".length);
  await page.key("x");
  await page.quiet();
  await sleep(200);
  const raw = await show(hub, "a.md");
  const out = await cli(hub.port, ["--user", AGENT, "--repo", REPO, "edit", "twin.md"], "@@\n-See {c1}this{/c1} now.\n+See {cx1}this{/c1} now.\n");
  const twin = await show(hub, "twin.md");
  if (out.code === 0) assert.equal(raw, twin, "the raw view's edit differs from the CLI's: raw mode keeps the caret out of the marker");
  else assert.equal(raw, doc, `the CLI was refused (${out.stderr.trim()}), but the raw view's edit went through`);
});

// ---- Every byte is drawn -------------------------------------------------------------------

test("every byte: the editor's text equals show, line for line, with nothing hidden", async (t) => {
  const doc = "# Title *em*\n\n- one\n\t- nested **b**\n\n> quote one\n> quote two\n\nred  \nblue\\\ngreen\n\n```js\nlet x = 1;\n```\n\nSee {c1}this{/c1} now." + CM("c1");
  const { hub, page } = await setup(t, { "a.md": doc });
  await open(page, "a.md");
  await toggle(page);
  assert.deepEqual(await lines(page), (await show(hub, "a.md")).split("\n"));
  const hidden = await page.eval(`[...document.querySelectorAll("#editor .md-line, #editor .md-line *")].filter((el) => !el.closest("button.md-view-toggle") && (getComputedStyle(el).display === "none" || getComputedStyle(el).visibility === "hidden")).length`);
  assert.equal(hidden, 0, "a part of a raw line is hidden");
});

test("every byte: a CRLF file is drawn one line per CRLF, → steps over each CRLF at once, and typing never leaves a lone CR", async (t) => {
  const doc = "one\r\ntwo\r\n\r\nthree\r\n";
  const { hub, page } = await setup(t, { "a.md": doc, "b.md": doc });
  await open(page, "b.md");
  await toggle(page);
  await place(page, 0);
  const stops = [];
  for (let i = 0; i < 5; i += 1) {
    await page.key("→");
    stops.push((await page.caret()).focus);
  }
  assert.deepEqual(stops, [1, 2, 3, 5, 6], "→ stopped inside a CRLF pair");
  await place(page, 3);
  await press(page, "→");
  await press(page, "x");
  assert.doesNotMatch(await show(hub, "b.md"), /\r(?!\n)/, "typing left a lone CR");
  await open(page, "a.md");
  // Whether the mode carries to another file is a separate default; this checks the lines.
  if (!(await isRaw(page))) await toggle(page);
  assert.deepEqual(await lines(page), ["one", "two", "", "three", ""]);
});

test("every byte: empty lines are drawn, several in a row and after the final newline", async (t) => {
  const { page } = await setup(t, { "a.md": "a\n\n\n\nb\n" });
  await open(page, "a.md");
  await toggle(page);
  const boxes = await page.eval(`[...document.querySelectorAll("#editor .md-line")].map((l) => { const r = l.getBoundingClientRect(); return [r.top, r.height]; })`);
  assert.equal(boxes.length, 6);
  for (let i = 0; i < boxes.length; i += 1) {
    assert.ok(boxes[i][1] > 5, `line ${i + 1} has no height`);
    if (i > 0) assert.ok(boxes[i][0] >= boxes[i - 1][0] + boxes[i - 1][1] - 1, `line ${i + 1} overlaps the line above`);
  }
});

test("every byte: a long line wraps at the pane's width, and the page never scrolls sideways", async (t) => {
  const doc = `${WRAP}\n\n${BIG}\n`;
  const { page } = await setup(t, { "a.md": doc });
  await open(page, "a.md");
  await toggle(page);
  const big = doc.indexOf(BIG);
  const starts = await visualStarts(page, big, big + BIG.length);
  assert.ok(starts.length >= 10, `the 1323-character line is drawn on ${starts.length} visual lines`);
  await place(page, big + 5);
  await press(page, "End");
  const scroll = await page.eval(`(() => { const e = document.getElementById("editor"); return { x: scrollX, left: e.scrollLeft, over: e.scrollWidth - e.clientWidth }; })()`);
  assert.equal(scroll.x, 0);
  assert.equal(scroll.left, 0);
  assert.ok(scroll.over <= 1, `the editor is ${scroll.over} px wider than its pane`);
});

// ---- Keys in raw mode ----------------------------------------------------------------------

test("keys: Enter writes one newline, with no marker, on an item, a quote, an empty item, a paragraph, and in a CRLF file", async (t) => {
  const cases = [
    ["li.md", "- one\n", 5, "- one\n\n"],
    ["q.md", "> one\n", 5, "> one\n\n"],
    ["empty.md", "- \n", 2, "- \n\n"],
    ["mid.md", "hello\n", 2, "he\nllo\n"],
    ["end.md", "hello\n", 5, "hello\n\n"],
    ["crlf.md", "one\r\ntwo\r\n", 3, "one\r\n\r\ntwo\r\n"],
  ];
  const { hub, page } = await setup(t, Object.fromEntries(cases.map(([f, d]) => [f, d])));
  for (const [file, , at, want] of cases) {
    await open(page, file);
    if (!(await isRaw(page))) await toggle(page);
    await place(page, at);
    await press(page, "Enter");
    assert.equal(await show(hub, file), want, file);
  }
});

test("keys: Backspace and Delete take one character, markers and newlines included", async (t) => {
  const cases = [
    ["a.md", "- x\n", 2, "Backspace", "-x\n"],
    ["b.md", "a\n\nb\n", 2, "Backspace", "a\nb\n"],
    ["c.md", "abc\n", 1, "Delete", "ac\n"],
    ["d.md", "a\n\nb\n", 1, "Delete", "a\nb\n"],
    ["e.md", "**b**\n", 2, "Backspace", "*b**\n"],
  ];
  const { hub, page } = await setup(t, Object.fromEntries(cases.map(([f, d]) => [f, d])));
  for (const [file, , at, key, want] of cases) {
    await open(page, file);
    if (!(await isRaw(page))) await toggle(page);
    await place(page, at);
    await press(page, key);
    assert.equal(await show(hub, file), want, `${file} ${key}`);
  }
});

test("keys: Tab writes a tab, on a list item too, and Shift+Tab changes nothing and keeps the focus", async (t) => {
  const { hub, page } = await setup(t, { "a.md": "- item\n" });
  await open(page, "a.md");
  await toggle(page);
  await place(page, 4);
  await press(page, "Tab");
  assert.equal(await show(hub, "a.md"), "- it\tem\n");
  await press(page, "Tab", ["Shift"]);
  assert.equal(await show(hub, "a.md"), "- it\tem\n");
  assert.equal(await page.eval(`document.getElementById("editor").contains(document.activeElement) || document.activeElement === document.getElementById("editor")`), true, "Shift+Tab moved the focus");
});

test("keys: → and ← step through every byte, markers included", async (t) => {
  const prose = "# **b** {c1}x{/c1} [l](u)";
  const { page } = await setup(t, { "a.md": prose + CM("c1") });
  await open(page, "a.md");
  await toggle(page);
  await place(page, 0);
  for (let i = 1; i <= prose.length; i += 1) {
    await page.key("→");
    const c = await page.caret();
    assert.equal(c.focus, i, `→ number ${i} went to ${c.focus}`);
  }
  for (let i = prose.length - 1; i >= 0; i -= 1) {
    await page.key("←");
    const c = await page.caret();
    assert.equal(c.focus, i, `← went to ${c.focus}, not ${i}`);
  }
});

test("keys: Home and End go to the start and end of the visual line (R74)", async (t) => {
  const doc = `alpha beta\n\n${BIG}\n`;
  const { page } = await setup(t, { "a.md": doc });
  await open(page, "a.md");
  await toggle(page);
  await place(page, 3);
  await press(page, "Home");
  assert.equal((await page.caret()).focus, 0);
  await press(page, "End");
  assert.equal((await page.caret()).focus, "alpha beta".length);
  const big = doc.indexOf(BIG);
  const starts = await visualStarts(page, big, big + BIG.length);
  const k = 3;
  const mid = Math.floor((starts[k] + starts[k + 1]) / 2);
  await place(page, mid);
  await press(page, "Home");
  assert.equal((await page.caret()).focus, starts[k], `Home on visual line ${k + 1} of the long line went to ${(await page.caret()).focus}`);
  await place(page, mid);
  await press(page, "End");
  const end = (await page.caret()).focus;
  assert.ok(end === starts[k + 1] || end === starts[k + 1] - 1, `End on visual line ${k + 1} went to ${end}, not ${starts[k + 1] - 1} or ${starts[k + 1]}`);
});

test("keys: ↑ and ↓ move to the visual line above or below and keep their goal x (R73)", async (t) => {
  const doc = `${BIG}\n`;
  const { page } = await setup(t, { "a.md": doc });
  await open(page, "a.md");
  await toggle(page);
  const starts = await visualStarts(page, 0, BIG.length);
  const at = starts[2] + 10;
  await place(page, at);
  const x0 = (await page.caret()).rect.x;
  await press(page, "↓");
  const down = await page.caret();
  assert.ok(down.focus >= starts[3] && down.focus < starts[4], `↓ from visual line 3 went to ${down.focus}, not into line 4 (${starts[3]}..${starts[4] - 1})`);
  assert.ok(Math.abs(down.rect.x - x0) <= 12, `↓ moved the caret from x ${x0} to x ${down.rect.x}`);
  await press(page, "↑");
  assert.equal((await page.caret()).focus, at, "↑ did not come back to the same offset");
});

test("keys: Ctrl+Backspace deletes back by the groups of R50", async (t) => {
  const { hub, page } = await setup(t, { "a.md": "x **bold**\n" });
  await open(page, "a.md");
  await toggle(page);
  await place(page, "x **bold**".length);
  await press(page, "Backspace", ["Ctrl"]);
  assert.equal(await show(hub, "a.md"), "x **bold\n");
  await press(page, "Backspace", ["Ctrl"]);
  assert.equal(await show(hub, "a.md"), "x **\n");
});

test("keys: a typed letter is drawn where the caret was, at the start and end of each visual line of a 1323-character line (R99)", async (t) => {
  const doc = `${BIG}\n`;
  const { hub, page } = await setup(t, { "a.md": doc });
  await open(page, "a.md");
  await toggle(page);
  const starts = await visualStarts(page, 0, BIG.length);
  for (let k = 1; k < Math.min(starts.length - 1, 6); k += 1) {
    await place(page, starts[k]);
    await typedWhereCaret(page, hub, "a.md", `start of visual line ${k + 1}`);
    // The right half of the last letter on the line above puts the caret after that letter.
    const last = starts[k] - 2;
    const pt = await page.eval(`(() => { const g = window.__qaGlyph(${last}); return { x: g.right - 1, y: (g.top + g.bottom) / 2 }; })()`);
    await page.click(pt.x, pt.y);
    await page.quiet();
    await typedWhereCaret(page, hub, "a.md", `end of visual line ${k}`);
  }
});

test("keys: a click, a double-click, Shift+click, copy and paste, undo, and redo act as R80, R84, R87, R91, and R92", async (t) => {
  const doc = "alpha beta gamma\n";
  const { hub, page } = await setup(t, { "a.md": doc });
  await open(page, "a.md");
  await toggle(page);
  const g = await glyph(page, 7);
  await page.click(g.left + 1, (g.top + g.bottom) / 2);
  await page.quiet();
  assert.equal((await page.caret()).focus, 7, "the left half of a glyph is not before it");
  await page.click(g.right - 1, (g.top + g.bottom) / 2);
  await page.quiet();
  assert.equal((await page.caret()).focus, 8, "the right half of a glyph is not after it");
  const w = await glyph(page, doc.indexOf("beta") + 1);
  await page.click(w.left + 1, (w.top + w.bottom) / 2, { clickCount: 1 });
  await page.click(w.left + 1, (w.top + w.bottom) / 2, { clickCount: 2 });
  await page.quiet();
  const word = await page.caret();
  assert.deepEqual([Math.min(word.anchor, word.focus), Math.max(word.anchor, word.focus)], [doc.indexOf("beta"), doc.indexOf("beta") + 4], "a double-click did not select the word");
  await place(page, 0);
  const e = await glyph(page, doc.indexOf("gamma"));
  await page.click(e.left + 1, (e.top + e.bottom) / 2, { modifiers: 8 });
  await page.quiet();
  const ext = await page.caret();
  assert.deepEqual([ext.anchor, ext.focus], [0, doc.indexOf("gamma")], "Shift+click did not extend the selection");
  await press(page, "c", ["Ctrl"]);
  await place(page, doc.length - 1);
  await press(page, "v", ["Ctrl"]);
  assert.equal(await show(hub, "a.md"), "alpha beta gammaalpha beta \n");
  await press(page, "z", ["Ctrl"]);
  assert.equal(await show(hub, "a.md"), doc);
  await press(page, "y", ["Ctrl"]);
  assert.equal(await show(hub, "a.md"), "alpha beta gammaalpha beta \n");
});

// ---- Rendered mode is unchanged ------------------------------------------------------------

test("rendered: a round trip through raw mode gives back the same drawing and the same caret", async (t) => {
  const doc = "# Title\n\nSome **bold** text.\n\n- one\n- two\n\n> quote\n\n| a |\n| --- |\n| 1 |\n";
  const { page } = await setup(t, { "a.md": doc });
  await open(page, "a.md");
  const n = doc.indexOf("bold") + 2;
  await place(page, n);
  const drawn = () => page.eval(`[...document.getElementById("editor").children].filter((el) => !el.matches("button.md-view-toggle")).map((el) => el.outerHTML).join("\\n")`);
  const before = await drawn();
  await toggle(page);
  await toggle(page);
  assert.equal(await drawn(), before, "the rendered drawing changed after a round trip");
  assert.equal((await page.caret()).focus, n);
});

// ---- The button ----------------------------------------------------------------------------

async function buttonBox(page) {
  return page.eval(`(() => {
    const b = document.querySelector(${JSON.stringify(TOGGLE)});
    const e = document.getElementById("editor").getBoundingClientRect();
    const r = b.getBoundingClientRect();
    return { count: document.querySelectorAll("button.md-view-toggle").length, left: r.left, right: r.right, top: r.top, bottom: r.bottom, paneTop: Math.max(0, e.top), paneRight: Math.min(innerWidth, e.right) };
  })()`);
}

// Every character box in the editor that meets the button's box.
const covered = (page) => page.eval(`(() => {
  const b = document.querySelector(${JSON.stringify(TOGGLE)}).getBoundingClientRect();
  const hits = [];
  const walker = document.createTreeWalker(document.getElementById("editor"), NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.parentElement.closest("button")) continue;
    for (let i = 0; i < n.length; i += 1) {
      if (/\\s/.test(n.data[i])) continue;
      const range = document.createRange();
      range.setStart(n, i);
      range.setEnd(n, i + 1);
      for (const r of range.getClientRects()) if (r.right > b.left && r.left < b.right && r.bottom > b.top && r.top < b.bottom) hits.push(n.data[i]);
    }
  }
  return hits.join("");
})()`);

test("button: one toggle sits in the top right corner of the document pane and covers no text", async (t) => {
  const { page } = await setup(t, { "a.md": `${BIG}\n\nsecond\n` });
  await open(page, "a.md");
  for (const mode of ["rendered", "raw"]) {
    const box = await buttonBox(page);
    assert.equal(box.count, 1);
    assert.ok(box.paneRight - box.right <= 16 && box.right <= box.paneRight, `${mode}: the button's right edge is ${box.paneRight - box.right} px from the pane's`);
    assert.ok(box.top - box.paneTop <= 16 && box.top >= box.paneTop, `${mode}: the button's top is ${box.top - box.paneTop} px below the pane's`);
    assert.equal(await covered(page), "", `${mode}: the button covers text`);
    if (mode === "rendered") await toggle(page);
  }
});

test("button: with a ticket open, it sits in the top right of the ticket's text pane, clear of the fields and the menu", async (t) => {
  const { hub, page } = await setup(t, {});
  const made = await cli(hub.port, ["--user", USER, "--repo", REPO, "ticket", "create", "--title", "A ticket"], `${BIG}\n`);
  assert.equal(made.code, 0, made.stderr);
  const id = made.stdout.trim().split("\n")[0];
  await page.session.send("Page.navigate", { url: `http://127.0.0.1:${hub.port}/?load=t#${REPO}/ticket/${id}` });
  await page.until(() => page.eval(`!!document.querySelector(".ticket-form") && !!document.querySelector(${JSON.stringify(TOGGLE)}) && document.querySelectorAll("#editor .md-line").length > 0`), "the ticket drawn", 8000);
  await page.quiet();
  const box = await buttonBox(page);
  assert.equal(box.count, 1);
  assert.ok(box.paneRight - box.right <= 16 && box.top - box.paneTop <= 16 && box.top >= box.paneTop, `the button is not in the text pane's top right corner: ${JSON.stringify(box)}`);
  const clash = await page.eval(`(() => {
    const b = document.querySelector(${JSON.stringify(TOGGLE)}).getBoundingClientRect();
    const meets = (r) => r.width > 0 && r.height > 0 && r.right > b.left && r.left < b.right && r.bottom > b.top && r.top < b.bottom;
    const others = [...document.querySelectorAll(".ticket-form *, .ticket-form, button, .md-ticket-menu, .md-doc-menu")].filter((el) => !el.matches("button.md-view-toggle") && !el.closest("button.md-view-toggle") && el.getClientRects().length > 0);
    return others.filter((el) => meets(el.getBoundingClientRect())).map((el) => el.tagName + "." + el.className);
  })()`);
  assert.deepEqual(clash, [], "the button overlaps a ticket field or a menu");
  assert.equal(await covered(page), "", "the button covers text");
});

test("button (default, a question for the owner): it stays in the visible corner of the pane while the document scrolls", async (t) => {
  const doc = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n\n") + "\n";
  const { page } = await setup(t, { "a.md": doc });
  await open(page, "a.md");
  await page.session.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 600, y: 450, deltaX: 0, deltaY: 1500 });
  await sleep(400);
  const scrolled = await page.eval("scrollY + document.getElementById('editor').scrollTop");
  assert.ok(scrolled > 200, `the page did not scroll (${scrolled})`);
  const box = await buttonBox(page);
  assert.ok(box.top >= box.paneTop && box.top - box.paneTop <= 16 && box.bottom <= 900, `after scrolling the button is at ${JSON.stringify(box)}`);
});

test("button: a button with aria-label and aria-pressed, toggled by Enter or Space", async (t) => {
  const { page } = await setup(t, { "a.md": "alpha\n" });
  await open(page, "a.md");
  const attrs = () => page.eval(`(() => { const b = document.querySelector(${JSON.stringify(TOGGLE)}); return { tag: b.tagName, label: b.getAttribute("aria-label"), pressed: b.getAttribute("aria-pressed") }; })()`);
  const a0 = await attrs();
  assert.equal(a0.tag, "BUTTON");
  assert.ok(a0.label && a0.label.trim() !== "", "no aria-label");
  assert.equal(a0.pressed, "false");
  for (const [key, want] of [["Enter", "true"], [" ", "false"]]) {
    await page.eval(`document.querySelector(${JSON.stringify(TOGGLE)}).focus()`);
    await page.key(key);
    await page.quiet();
    assert.equal((await attrs()).pressed, want, `${JSON.stringify(key)} on the focused button did not toggle it`);
  }
});

test("button: a click on it does not move the caret or change the selection", async (t) => {
  const doc = "alpha beta gamma\n";
  const { page } = await setup(t, { "a.md": doc });
  await open(page, "a.md");
  await place(page, 2);
  await press(page, "→", ["Shift"], 6);
  const before = await page.caret();
  for (const way of ["to raw", "to rendered"]) {
    await toggle(page);
    const c = await page.caret();
    assert.deepEqual([c.anchor, c.focus], [before.anchor, before.focus], `${way}: the click moved the selection`);
  }
});

// ---- The eye and the red line --------------------------------------------------------------

const icon = (page) => page.eval(`(() => {
  const b = document.querySelector(${JSON.stringify(TOGGLE)});
  const svg = b.querySelector("svg");
  const color = getComputedStyle(b).color;
  return {
    attrs: Object.fromEntries(["viewBox", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "aria-hidden"].map((a) => [a, svg.getAttribute(a)])),
    parts: [...svg.children].map((el) => ({ tag: el.tagName.toLowerCase(), stroke: getComputedStyle(el).stroke, current: getComputedStyle(el).stroke === color, x1: el.getAttribute("x1"), y1: el.getAttribute("y1"), x2: el.getAttribute("x2"), y2: el.getAttribute("y2") })),
  };
})()`);

test("glyph: the eye follows the icon rule in AGENTS.md, and in rendered mode is an outline and a pupil only", async (t) => {
  const { page } = await setup(t, { "a.md": "alpha\n" });
  await open(page, "a.md");
  const eye = await icon(page);
  assert.deepEqual(eye.attrs, { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" });
  assert.equal(eye.parts.length, 2, `the rendered eye has ${eye.parts.length} parts`);
  assert.ok(eye.parts.every((p) => p.current), "a part of the eye is not drawn in currentColor");
});

test("glyph: raw mode adds one red line from the lower left to the upper right, the only stroke that is not currentColor, gone in rendered mode", async (t) => {
  const { page } = await setup(t, { "a.md": "alpha\n" });
  await open(page, "a.md");
  await toggle(page);
  const eye = await icon(page);
  const odd = eye.parts.filter((p) => !p.current);
  assert.equal(eye.parts.length, 3);
  assert.equal(odd.length, 1, `${odd.length} parts are not currentColor`);
  const line = odd[0];
  assert.equal(line.tag, "line");
  const [x1, y1, x2, y2] = [line.x1, line.y1, line.x2, line.y2].map(Number);
  assert.ok((x1 < x2 && y1 > y2) || (x2 < x1 && y2 > y1), `the line runs from (${x1}, ${y1}) to (${x2}, ${y2})`);
  const [r, g, b] = line.stroke.match(/\d+/g).map(Number);
  assert.ok(r >= 150 && g <= 100 && b <= 100, `the line's stroke is ${line.stroke}`);
  await toggle(page);
  assert.equal((await icon(page)).parts.length, 2, "the line stayed in rendered mode");
});

// ---- Examining the source ------------------------------------------------------------------

test("source: Ctrl+A then Ctrl+C in raw mode puts the file's exact bytes on the clipboard", async (t) => {
  const doc = "# T\n\n- a\tb  \n\nSee {c1}this{/c1} now." + CM("c1");
  const { hub, page } = await setup(t, { "a.md": doc });
  await open(page, "a.md");
  await toggle(page);
  await page.eval(`window.__copied = null; document.addEventListener("copy", (e) => { window.__copied = e.clipboardData.getData("text/plain"); }); true`);
  await place(page, 2);
  await press(page, "a", ["Ctrl"]);
  await press(page, "c", ["Ctrl"]);
  await page.until(() => page.eval("window.__copied !== null"), "a copy", 2000);
  assert.equal(await page.eval("window.__copied"), await show(hub, "a.md"));
});

test("source: a comment added in rendered mode shows in raw mode as its markers and its fence", async (t) => {
  const doc = "alpha beta gamma\n";
  const { page } = await setup(t, { "a.md": doc });
  await open(page, "a.md");
  const w = await glyph(page, doc.indexOf("beta") + 1);
  await page.click(w.left + 1, (w.top + w.bottom) / 2, { clickCount: 1 });
  await page.click(w.left + 1, (w.top + w.bottom) / 2, { clickCount: 2 });
  await page.quiet();
  const add = await page.eval(`(() => { const b = document.querySelector(".md-add-comment"); if (!b || b.hidden) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  assert.ok(add, "no add-comment button");
  await page.click(add.x, add.y);
  await page.quiet();
  await toggle(page);
  const raw = await lines(page);
  assert.ok(raw.includes("alpha {c1}beta{/c1} gamma"), `the markers are not drawn: ${JSON.stringify(raw)}`);
  assert.ok(raw.includes("```comment c1"), `the fence is not drawn: ${JSON.stringify(raw)}`);
});

test("source: an edit made in rendered mode in another tab shows in the raw tab within one second", async (t) => {
  const { hub, page: A, browser } = await setup(t, { "a.md": "alpha\n\nbeta\n" });
  await open(A, "a.md");
  await toggle(A);
  const B = await secondTab(browser, hub);
  await open(B, "a.md");
  await B.clickOffset("alpha\n\nbe".length);
  await B.quiet();
  const started = Date.now();
  await B.key("Z");
  await A.until(async () => (await lines(A)).includes("beZta"), "the edit shows in the raw tab", 1000);
  assert.ok(Date.now() - started <= 1500);
  assert.equal(await show(hub, "a.md"), "alpha\n\nbeZta\n");
});

// ---- The font ------------------------------------------------------------------------------

async function widths(page) {
  return page.eval(`[...document.querySelectorAll("#editor .md-line")].slice(0, 5).filter((l) => l.textContent.length === 10).map((l) => { const r = document.createRange(); r.selectNodeContents(l); return r.getBoundingClientRect().width; })`);
}

test("font: raw text uses one monospace family that is not Courier, and ten i, ten M, and ten . measure the same", async (t) => {
  const { page } = await setup(t, { "a.md": "iiiiiiiiii\n\nMMMMMMMMMM\n\n..........\n" });
  await open(page, "a.md");
  await toggle(page);
  const w = await widths(page);
  assert.equal(w.length, 3);
  assert.ok(Math.max(...w) - Math.min(...w) <= 0.5, `widths ${w.map((x) => x.toFixed(1)).join(", ")}`);
  const families = await page.eval(`[...new Set([...document.querySelectorAll("#editor .md-line")].map((l) => getComputedStyle(l).fontFamily))]`);
  assert.equal(families.length, 1, `raw lines use ${families.join(" | ")}`);
  assert.match(families[0], /monospace/);
  await page.session.send("DOM.enable");
  await page.session.send("CSS.enable");
  const { root } = await page.session.send("DOM.getDocument", { depth: -1 });
  const { nodeId } = await page.session.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#editor .md-line" });
  const { fonts } = await page.session.send("CSS.getPlatformFontsForNode", { nodeId });
  assert.ok(fonts.length > 0, "no platform font reported");
  for (const f of fonts) assert.doesNotMatch(f.familyName, /courier/i, `the raw view uses ${f.familyName}`);
});

test("font: the size stays the body size, and rendered mode keeps its proportional font", async (t) => {
  const { page } = await setup(t, { "a.md": "iiiiiiiiii\n\nMMMMMMMMMM\n\n..........\n" });
  await open(page, "a.md");
  const size = () => page.eval(`getComputedStyle(document.querySelector("#editor .md-line")).fontSize`);
  const rendered = await widths(page);
  const renderedSize = await size();
  assert.ok(Math.max(...rendered) - Math.min(...rendered) > 5, `rendered widths ${rendered.map((x) => x.toFixed(1)).join(", ")} are not proportional`);
  await toggle(page);
  assert.equal(await size(), renderedSize, "the raw font size differs from the body size");
  await toggle(page);
  const back = await widths(page);
  assert.ok(Math.max(...back) - Math.min(...back) > 5, "rendered mode lost its proportional font after a round trip");
});
