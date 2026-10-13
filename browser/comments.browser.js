import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { OTHER, REPO, cli, launchBrowser, Page, startHub, supports } from "./harness.js";

// Comments in the page: deleting a thread, and moving or cutting text that holds comment
// markers. Every action is a real key or mouse event. After each one the bytes must keep every
// comment whole: each id opens once and closes once, in that order, and has one fence, and
// every fence has its markers.

const CM = (id, resolved = false) => `\n\n\`\`\`comment ${id}${resolved ? " resolved" : ""}\n:: 0\n@2026-10-05T16:00:00.000Z Ada\nNote ${id}.\n\`\`\`\n`;
const P = "See {c1}this{/c1} now.";

// The prose before the first comment fence, and the fence ids.
function split(text) {
  const at = text.search(/\n*```comment /);
  return { prose: at < 0 ? text : text.slice(0, at), fences: [...text.matchAll(/^```comment ([A-Za-z][\w-]*)/gm)].map((m) => m[1]) };
}

function whole(text, label) {
  const { prose, fences } = split(text);
  const opens = [...prose.matchAll(/\{([A-Za-z][\w-]*)\}/g)].map((m) => [m[1], m.index]);
  const closes = [...prose.matchAll(/\{\/([A-Za-z][\w-]*)\}/g)].map((m) => [m[1], m.index]);
  const ids = new Set([...opens.map((o) => o[0]), ...closes.map((c) => c[0]), ...fences]);
  for (const id of ids) {
    const o = opens.filter((x) => x[0] === id);
    const c = closes.filter((x) => x[0] === id);
    const f = fences.filter((x) => x === id);
    assert.equal(o.length, 1, `${label}: ${id} opens ${o.length} times in ${JSON.stringify(text)}`);
    assert.equal(c.length, 1, `${label}: ${id} closes ${c.length} times in ${JSON.stringify(text)}`);
    assert.ok(o[0][1] < c[0][1], `${label}: ${id} closes before it opens in ${JSON.stringify(text)}`);
    assert.equal(f.length, 1, `${label}: ${id} has ${f.length} fences in ${JSON.stringify(text)}`);
  }
  // Two comments may sit side by side or one inside the other, but may not cross.
  const spans = [...ids].map((id) => [opens.find((x) => x[0] === id)[1], closes.find((x) => x[0] === id)[1], id]);
  for (const a of spans) for (const b of spans) {
    if (a[0] < b[0] && b[0] < a[1] && a[1] < b[1]) assert.fail(`${label}: ${a[2]} and ${b[2]} cross in ${JSON.stringify(text)}`);
  }
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
  return { hub, page, browser };
}

async function open(page, file) {
  await page.open(file);
  await page.until(() => page.eval(`document.querySelectorAll("#editor .md-line").length > 0`), `${file} drawn`);
}

async function place(page, offset) {
  assert.ok(await page.clickOffset(offset), `no point for offset ${offset}`);
  await page.quiet();
}

async function shiftRight(page, count) {
  for (let i = 0; i < count; i += 1) await page.key("→", ["Shift"]);
  await page.quiet();
}

async function bytes(hub, file) {
  await sleep(150);
  return (await hub.show(file)).text;
}

async function cardDelete(page, id) {
  const button = `.md-comment-card[data-comment="${id}"] button[aria-label="Delete"]`;
  await page.until(() => page.eval(`(() => { const b = document.querySelector('${button}'); return !!b && b.getClientRects().length > 0; })()`), `the Delete button on ${id}`, 2000);
  const pt = await page.eval(`(() => { const r = document.querySelector('${button}').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.click(pt.x, pt.y);
  await page.quiet();
}

async function cardClick(page, id) {
  const pt = await page.eval(`(() => { const c = document.querySelector('.md-comment-card[data-comment="${id}"]'); if (!c) return null; const r = c.getBoundingClientRect(); return { x: r.left + 20, y: r.top + 12 }; })()`);
  assert.ok(pt, `no card for ${id}`);
  await page.click(pt.x, pt.y);
  await page.quiet();
}

// Drags the current selection and drops it at a text offset, as dragging selected text does.
async function dropAt(page, offset) {
  const target = await page.eval(`window.__qaClickPoint(${offset})`);
  const source = await page.eval("(() => { const r = getSelection().getRangeAt(0).getClientRects()[0]; return r && { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 }; })()");
  assert.ok(target && source, "no drag source or target");
  let data = null;
  const off = page.session.on("Input.dragIntercepted", (params) => {
    data = params.data;
  });
  await page.session.send("Input.setInterceptDrags", { enabled: true });
  try {
    await page.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: source.x, y: source.y });
    await page.session.send("Input.dispatchMouseEvent", { type: "mousePressed", x: source.x, y: source.y, button: "left", clickCount: 1, buttons: 1 });
    for (let step = 1; step <= 10; step += 1) {
      await page.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: source.x + ((target.x - source.x) * step) / 10, y: source.y + ((target.y - source.y) * step) / 10, button: "left", buttons: 1 });
    }
    assert.ok(data, "the browser started no drag");
    for (const type of ["dragEnter", "dragOver", "drop"]) await page.session.send("Input.dispatchDragEvent", { type, x: target.x, y: target.y, data });
  } finally {
    await page.session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: target.x, y: target.y, button: "left", clickCount: 1, buttons: 0 });
    await page.session.send("Input.setInterceptDrags", { enabled: false });
    off();
  }
  await page.quiet();
}

const cards = (page) => page.eval(`[...document.querySelectorAll(".md-comment-card")].map((c) => c.dataset.comment)`);

test("Delete on a card removes the thread and its markers, and the caret keeps its place", async (t) => {
  const { hub, page } = await setup(t, { "a.md": P + CM("c1") });
  await open(page, "a.md");
  await place(page, P.indexOf("this") + 2);
  await cardDelete(page, "c1");
  assert.equal(await bytes(hub, "a.md"), "See this now.\n");
  assert.deepEqual(await cards(page), []);
  const caret = await page.caret();
  assert.equal(caret.focus, "See th".length, `the caret moved to ${caret.focus}, not its place in the text`);
});

test("Delete on a card with the caret elsewhere, and on a resolved thread", async (t) => {
  const { hub, page } = await setup(t, { "a.md": P + CM("c1"), "r.md": P + CM("c1", true) });
  await open(page, "a.md");
  await place(page, P.indexOf("now") + 1);
  assert.equal(await page.eval(`(() => {
    const card = document.querySelector('.md-comment-card[data-comment="c1"]');
    const rect = card.getBoundingClientRect();
    return document.elementFromPoint(rect.right - 6, rect.top + 6) === card;
  })()`), true);
  assert.equal(await page.eval(`document.querySelectorAll("button.md-attach, button.md-doc-commit").length`), 0);
  await cardClick(page, "c1");
  await cardDelete(page, "c1");
  assert.equal(await bytes(hub, "a.md"), "See this now.\n");
  await open(page, "r.md");
  const box = await page.eval(`(() => { const r = document.getElementById("show-resolved").getBoundingClientRect(); return { x: r.left + 4, y: r.top + 4 }; })()`);
  await page.click(box.x, box.y);
  await page.quiet();
  assert.equal(await page.eval(`document.getElementById("show-resolved").checked`), true, "the click did not reach the show resolved box");
  await cardClick(page, "c1");
  await cardDelete(page, "c1");
  assert.equal(await bytes(hub, "r.md"), "See this now.\n");
});

test("Delete on one card leaves the other comment whole", async (t) => {
  const doc = "A {c1}one{/c1} B {c2}two{/c2} C." + CM("c1") + CM("c2").slice(1);
  const { hub, page } = await setup(t, { "a.md": doc, "l.md": "- item {c1}one{/c1}\n- two" + CM("c1") });
  await open(page, "a.md");
  await place(page, "A {c1}o".length);
  await cardDelete(page, "c1");
  const after = await bytes(hub, "a.md");
  assert.equal(split(after).prose, "A one B {c2}two{/c2} C.");
  whole(after, "one of two");
  await open(page, "l.md");
  await place(page, "- item {c1}o".length);
  await cardDelete(page, "c1");
  assert.equal(await bytes(hub, "l.md"), "- item one\n- two\n");
});

test("Ctrl+Z after Delete on a card brings the comment back", async (t) => {
  const { hub, page } = await setup(t, { "a.md": P + CM("c1") });
  await open(page, "a.md");
  await place(page, P.indexOf("this") + 2);
  await cardDelete(page, "c1");
  // No click in between: the delete leaves the focus in the editor.
  await page.key("z", ["Ctrl"]);
  await page.quiet();
  assert.equal(await bytes(hub, "a.md"), P + CM("c1"));
});

test("deleting all of a comment's text removes the thread, and Ctrl+Z restores it", async (t) => {
  const { hub, page } = await setup(t, { "a.md": P + CM("c1") });
  await open(page, "a.md");
  await place(page, P.indexOf("this"));
  await shiftRight(page, 4);
  await page.key("Backspace");
  await page.quiet();
  const gone = await bytes(hub, "a.md");
  // The blank line left where the fence was is what BS.cm.1 expects; only the prose is compared.
  assert.equal(split(gone).prose.trimEnd(), "See  now.");
  assert.equal(split(gone).fences.length, 0);
  whole(gone, "emptied");
  await page.key("z", ["Ctrl"]);
  await page.quiet();
  assert.equal(await bytes(hub, "a.md"), P + CM("c1"));
});

test("a selection delete across one marker keeps the comment on what is left", async (t) => {
  const { hub, page } = await setup(t, { "a.md": P + CM("c1") });
  await open(page, "a.md");
  await place(page, P.indexOf("this") + 2);
  await shiftRight(page, 5);
  await page.key("Backspace");
  await page.quiet();
  const after = await bytes(hub, "a.md");
  assert.equal(split(after).prose, "See {c1}th{/c1}ow.");
  whole(after, "across the closing marker");
});

test("typing at a marker's edge goes inside after the opening marker and outside after the closing one", async (t) => {
  const { hub, page } = await setup(t, { "a.md": P + CM("c1") });
  await open(page, "a.md");
  await place(page, P.indexOf("this"));
  await page.type("X");
  await page.quiet();
  await place(page, P.indexOf("{/c1}") + 6);
  await page.type("Y");
  await page.quiet();
  assert.equal(split(await bytes(hub, "a.md")).prose, "See {c1}Xthis{/c1}Y now.");
});

test("dragging a selection that holds a whole comment moves the comment", { skip: supports("drag") ? false : "Firefox over BiDi cannot drag a selection" }, async (t) => {
  const { hub, page } = await setup(t, { "a.md": P + CM("c1") });
  await open(page, "a.md");
  await place(page, "See ".length);
  await shiftRight(page, 6);
  await dropAt(page, P.length);
  const after = await bytes(hub, "a.md");
  whole(after, "drag-moved comment");
  assert.equal(split(after).prose, "See  now.{c1}this{/c1}");
});

test("cutting and pasting a whole comment never leaves its markers twice", async (t) => {
  const { hub, page } = await setup(t, { "a.md": P + CM("c1") });
  await open(page, "a.md");
  await place(page, "See ".length);
  await shiftRight(page, 6);
  await page.key("x", ["Ctrl"]);
  await page.quiet();
  const cut = await bytes(hub, "a.md");
  whole(cut, "after the cut");
  assert.ok(!split(cut).prose.includes("this"), `the cut left the text: ${JSON.stringify(cut)}`);
  await place(page, split(cut).prose.length);
  await page.key("v", ["Ctrl"]);
  await page.quiet();
  const pasted = await bytes(hub, "a.md");
  whole(pasted, "after the paste");
  assert.equal(split(pasted).prose.split("this").length - 1, 1, `"this" appears more than once: ${JSON.stringify(pasted)}`);
});

test("dragging or cutting one marker never leaves it twice", { skip: supports("drag") ? false : "Firefox over BiDi cannot drag a selection" }, async (t) => {
  const { hub, page } = await setup(t, { "d.md": P + CM("c1"), "x.md": P + CM("c1") });
  await open(page, "d.md");
  await place(page, P.indexOf("{/c1}"));
  await shiftRight(page, 1);
  await dropAt(page, P.length - 1);
  whole(await bytes(hub, "d.md"), "dragged closing marker");
  await open(page, "x.md");
  await place(page, P.indexOf("{/c1}"));
  await shiftRight(page, 1);
  await page.key("x", ["Ctrl"]);
  await page.quiet();
  await place(page, P.length - 1);
  await page.key("v", ["Ctrl"]);
  await page.quiet();
  whole(await bytes(hub, "x.md"), "cut and pasted closing marker");
});

// Ticket jh65rvmr: the opening marker goes after the line's markdown marker, so the line keeps its kind.
for (const [kind, line, keep] of [
  ["a bullet item", "- two item here", /\n- \{c1\}two item here\{\/c1\}\n/],
  ["a star item", "* two item here", /\n\* \{c1\}two item here\{\/c1\}\n/],
  ["an ordered item", "2. two item here", /\n2\. \{c1\}two item here\{\/c1\}\n/],
  ["a quote line", "> two item here", /\n> \{c1\}two item here\{\/c1\}\n/],
  ["a heading", "## two item here", /\n## \{c1\}two item here\{\/c1\}\n/],
]) {
  test(`a comment added over a triple-clicked ${kind} keeps its kind`, async (t) => {
    const src = `Intro.\n\n${line}\n\nAfter.\n`;
    const { hub, page } = await setup(t, { "a.md": src });
    await open(page, "a.md");
    const p = await page.eval(`window.__qaClickPoint(${src.indexOf("two") + 2})`);
    await page.click(p.x, p.y, { clickCount: 1 });
    await page.click(p.x, p.y, { clickCount: 2 });
    await page.click(p.x, p.y, { clickCount: 3 });
    await page.quiet();
    const add = await page.eval(`(() => { const b = document.querySelector(".md-add-comment"); if (!b || b.hidden) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    assert.ok(add, "no add-comment button");
    await page.click(add.x, add.y);
    await page.quiet();
    const after = await bytes(hub, "a.md");
    assert.match(split(after).prose, keep, `the line lost its kind: ${JSON.stringify(after)}`);
    whole(after, kind);
  });
}

test("the CLI cannot delete a thread in the block the person's caret holds", async (t) => {
  const { hub, page } = await setup(t, { "a.md": P + CM("c1") });
  await open(page, "a.md");
  await place(page, P.indexOf("this") + 2);
  // Only the thread's author can delete it, and note 0 is Ada's.
  const out = await cli(hub.port, ["--user", "Ada", "--repo", REPO, "comment", "delete", "a.md", "c1"]);
  assert.notEqual(out.code, 0, "the delete was not refused");
  assert.match(out.stderr, /409|held/, out.stderr);
  assert.equal(await bytes(hub, "a.md"), P + CM("c1"));
});

test("a thread the CLI deletes in another block leaves the page's caret in place", async (t) => {
  const doc = "Other line.\n\n" + P + CM("c1");
  const { hub, page } = await setup(t, { "a.md": doc });
  await open(page, "a.md");
  await place(page, 3);
  const out = await cli(hub.port, ["--user", "Ada", "--repo", REPO, "comment", "delete", "a.md", "c1"]);
  assert.equal(out.code, 0, out.stderr);
  await page.until(async () => (await cards(page)).length === 0, "the card goes");
  await page.quiet();
  assert.equal(await bytes(hub, "a.md"), "Other line.\n\nSee this now.\n");
  const caret = await page.caret();
  assert.equal(caret.focus, 3, `the caret moved to ${caret.focus}`);
});

// ---- Handles at each end of a highlight (ticket y8qvyrzz, R105) ------------------------------

const LEAD = "Other line.\n\n";
const HDOC = LEAD + P + CM("c1");
const at = (needle, plus = 0) => LEAD.length + P.indexOf(needle) + plus;
const TOGGLE = "#editor button.md-view-toggle";

async function hover(page, offset) {
  const point = await page.eval(`window.__qaClickPoint(${offset})`);
  assert.ok(point, `no point for offset ${offset}`);
  await page.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await page.frame();
  await sleep(50);
  return point;
}

const handles = (page) => page.eval(`[...document.querySelectorAll("#editor .md-comment-handle")]
  .filter((el) => getComputedStyle(el).display !== "none")
  .map((el) => {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return { edge: el.dataset.edge, comment: el.dataset.comment, x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, radius: style.borderRadius };
  })`);

// The left and right edges of the comment's highlight, and its vertical middle.
const highlight = (page, id) => page.eval(`(() => {
  const rects = [...document.querySelectorAll('#editor .md-comment[data-comment="${id}"]')].flatMap((el) => [...el.getClientRects()]).filter((r) => r.width > 0);
  if (!rects.length) return null;
  return { left: Math.min(...rects.map((r) => r.left)), right: Math.max(...rects.map((r) => r.right)), y: (rects[0].top + rects[0].bottom) / 2 };
})()`);

const editsSince = (page, since) => page.frames.slice(since).filter((frame) => frame.dir === "out" && frame.data && frame.data.type === "edit");

// Presses the handle with the real mouse, moves in steps, and lets go over the target point.
async function dragHandle(page, edge, to) {
  const from = await page.eval(`(() => {
    const el = document.querySelector('#editor .md-comment-handle[data-edge="${edge}"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  assert.ok(from, `no ${edge} handle to press`);
  const since = page.frames.length;
  await page.drag(from, to);
  await page.quiet();
  await sleep(150);
  return editsSince(page, since);
}

const fenceOf = (text, id) => (new RegExp("^```comment " + id + "[\\s\\S]*?^```$", "m").exec(text) || [""])[0];

test("handles: with the pointer over a rendered highlight, a rounded handle shows at each end, and none elsewhere", async (t) => {
  const { page } = await setup(t, { "a.md": HDOC });
  await open(page, "a.md");
  await place(page, 3);
  assert.equal(await page.eval(`[...document.querySelectorAll("#editor .md-line")].find((l) => l.textContent.includes("now")).classList.contains("md-raw")`), false, "the commented paragraph is not rendered");
  await hover(page, at("this", 2));
  const shown = await handles(page);
  assert.deepEqual(shown.map((h) => h.edge).sort(), ["end", "start"], `handles over the highlight: ${JSON.stringify(shown)}`);
  assert.ok(shown.every((h) => h.comment === "c1" && h.w >= 8 && Math.abs(h.w - h.h) < 0.5 && h.radius !== "0px"), `the handles are not round: ${JSON.stringify(shown)}`);
  const box = await highlight(page, "c1");
  const start = shown.find((h) => h.edge === "start");
  const end = shown.find((h) => h.edge === "end");
  assert.ok(Math.abs(start.x - box.left) <= 3 && Math.abs(start.y - box.y) <= 4, `start handle at ${start.x},${start.y}, highlight starts at ${box.left},${box.y}`);
  assert.ok(Math.abs(end.x - box.right) <= 3 && Math.abs(end.y - box.y) <= 4, `end handle at ${end.x},${end.y}, highlight ends at ${box.right},${box.y}`);
  await hover(page, at("now", 1));
  assert.deepEqual(await handles(page), [], "handles stay with the pointer on now");
  await hover(page, 3);
  assert.deepEqual(await handles(page), [], "handles stay with the pointer on another paragraph");
});

test("handles: in the raw block the markers are drawn as the handles, and the caret cannot aim inside them", async (t) => {
  const { page } = await setup(t, { "a.md": HDOC });
  await open(page, "a.md");
  await place(page, at("this", 2));
  const drawn = await page.eval(`(() => {
    const line = [...document.querySelectorAll("#editor .md-line")].find((l) => l.textContent.includes("now"));
    const markers = [...line.querySelectorAll(".md-comment-marker")].map((el) => ({ text: el.textContent, edge: el.dataset.edge }));
    return { raw: line.classList.contains("md-raw"), text: line.textContent, markers };
  })()`);
  assert.equal(drawn.raw, true, "the block is not raw");
  assert.ok(!drawn.text.includes("{c1}") && !drawn.text.includes("{/c1}"), `the raw block draws marker characters: ${JSON.stringify(drawn.text)}`);
  assert.deepEqual(drawn.markers.map((m) => m.edge), ["start", "end"]);
  assert.ok(drawn.markers.every((m) => m.text === ""), "a marker box holds text");
  await hover(page, at("this", 2));
  assert.deepEqual((await handles(page)).map((h) => h.edge).sort(), ["end", "start"], "no handles over the raw highlight");
  // → from before the opening marker to the end of the line never stops inside a marker.
  await place(page, at("{c1}"));
  const inside = (o) => (o > at("{c1}") && o < at("{c1}", 4)) || (o > at("{/c1}") && o < at("{/c1}", 5));
  const stops = [];
  for (let i = 0; i < 12; i += 1) {
    await page.key("→");
    await page.quiet();
    stops.push((await page.caret()).focus);
  }
  assert.ok(!stops.some(inside), `→ stopped inside a marker: ${stops.join(",")}`);
  assert.ok(stops.includes(at("this")) && stops.includes(at("{/c1}", 5)), `→ skipped a marker edge: ${stops.join(",")}`);
  // A click on the middle of each drawn marker box lands on an edge of that marker. The walk
  // above left the block, so the caret goes back into the comment first.
  await place(page, at("this", 2));
  for (const edge of ["start", "end"]) {
    const pt = await page.eval(`(() => { const el = [...document.querySelectorAll("#editor .md-comment-marker")].find((m) => m.dataset.edge === "${edge}"); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await page.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
    await page.click(pt.x, pt.y);
    await page.quiet();
    const focus = (await page.caret()).focus;
    assert.ok(!inside(focus), `a click on the ${edge} marker put the caret at ${focus}, inside it`);
  }
});

test("handles: dragging the end handle past now moves only that marker, in one edit, and Ctrl+Z puts it back", async (t) => {
  const { hub, page } = await setup(t, { "a.md": HDOC });
  await open(page, "a.md");
  await place(page, 3);
  await hover(page, at("this", 2));
  const target = await page.eval(`window.__qaClickPoint(${at(".")})`);
  const edits = await dragHandle(page, "end", target);
  assert.equal(edits.length, 1, `the drag sent ${edits.length} edits`);
  const after = await bytes(hub, "a.md");
  assert.equal(split(after).prose, LEAD + "See {c1}this now{/c1}.");
  assert.equal(fenceOf(after, "c1"), fenceOf(HDOC, "c1"), "the thread changed");
  whole(after, "end handle dragged");
  await page.key("z", ["Ctrl"]);
  await page.quiet();
  assert.equal(await bytes(hub, "a.md"), HDOC, "Ctrl+Z did not put the end marker back");
});

test("handles: dragging the start handle before See moves only that marker, and Ctrl+Z puts it back", async (t) => {
  const { hub, page } = await setup(t, { "a.md": HDOC });
  await open(page, "a.md");
  await place(page, 3);
  await hover(page, at("this", 2));
  const target = await page.eval(`window.__qaClickPoint(${LEAD.length})`);
  const edits = await dragHandle(page, "start", target);
  assert.equal(edits.length, 1, `the drag sent ${edits.length} edits`);
  const after = await bytes(hub, "a.md");
  assert.equal(split(after).prose, LEAD + "{c1}See this{/c1} now.");
  assert.equal(fenceOf(after, "c1"), fenceOf(HDOC, "c1"), "the thread changed");
  whole(after, "start handle dragged");
  await page.key("z", ["Ctrl"]);
  await page.quiet();
  assert.equal(await bytes(hub, "a.md"), HDOC, "Ctrl+Z did not put the start marker back");
});

test("handles: a drag that would empty the comment, cross another, or reach into a fence or a table writes nothing, and the handle goes back", async (t) => {
  const crossed = "See {c1}this{/c1} and {c2}that{/c2}.";
  const fenced = `${P}\n\n\`\`\`python\nx = 1\n\`\`\`\n`;
  const table = `${P}\n\n| a | b |\n| --- | --- |\n| c | d |\n`;
  const docs = {
    "empty.md": HDOC,
    "cross.md": LEAD + crossed + CM("c1") + CM("c2").slice(1),
    "fence.md": LEAD + fenced + CM("c1"),
    "table.md": LEAD + table + CM("c1"),
  };
  const { hub, page } = await setup(t, docs);
  const cases = [
    ["empty.md", "an empty comment", async () => (await handles(page)).find((h) => h.edge === "start")],
    ["cross.md", "crossing c2", () => page.eval(`window.__qaClickPoint(${LEAD.length + crossed.indexOf("that") + 2})`)],
    ["fence.md", "into a fence", () => page.eval(`window.__qaClickPoint(${LEAD.length + fenced.indexOf("x = 1") + 2})`)],
    ["table.md", "into a table", () => page.eval(`window.__qaClickPoint(${LEAD.length + table.indexOf("| c |") + 2})`)],
  ];
  for (const [file, label, target] of cases) {
    await open(page, file);
    await place(page, 3);
    await hover(page, at("this", 2));
    const before = (await handles(page)).find((h) => h.edge === "end");
    assert.ok(before, `${label}: no end handle`);
    const to = await target();
    assert.ok(to, `${label}: no target point`);
    const edits = await dragHandle(page, "end", { x: to.x, y: to.y });
    assert.equal(edits.length, 0, `${label}: the drag sent ${edits.length} edits`);
    const after = await bytes(hub, file);
    assert.equal(after, docs[file], `${label}: the bytes changed`);
    whole(after, label);
    await hover(page, at("this", 2));
    const back = (await handles(page)).find((h) => h.edge === "end");
    assert.ok(back && Math.abs(back.x - before.x) < 2 && Math.abs(back.y - before.y) < 2, `${label}: the end handle did not go back (${JSON.stringify(back)} vs ${JSON.stringify(before)})`);
  }
});

test("handles: a drag into a block another session holds is refused with 409, and that session's name flashes", async (t) => {
  const doc = `${LEAD}${P}\n\nHeld line stays.\n`;
  const { hub, browser, page: A } = await setup(t, { "a.md": doc + CM("c1") });
  const { session } = await browser.newSession();
  const B = new Page(session, hub.port);
  await B.init();
  await B.login(OTHER);
  await open(A, "a.md");
  await open(B, "a.md");
  const held = doc.indexOf("Held") + 2;
  await place(B, held);
  await place(A, 3);
  await sleep(300);
  await hover(A, at("this", 2));
  const into = await A.eval(`window.__qaClickPoint(${held})`);
  const since = A.frames.length;
  await dragHandle(A, "end", into);
  const answer = A.frames.slice(since).find((frame) => frame.dir === "in" && frame.data && frame.data.type === "error");
  assert.ok(answer, "the hub sent no refusal");
  assert.equal(answer.data.status, 409);
  assert.equal(await bytes(hub, "a.md"), doc + CM("c1"), "the bytes changed");
  whole(await bytes(hub, "a.md"), "refused drag");
  await A.until(() => A.eval(`window.__qa.flashes.some((flash) => flash.name.includes(${JSON.stringify(OTHER)}))`), `${OTHER}'s name flashes`, 3000);
});

// The raw view draws every byte and does not interpret markdown, and a click inside a marker
// stays on that byte (R107, the owner's decision of 2026-10-10). So the raw view draws the
// markers as text and no handles over them.
test("handles: the raw view draws no handles, and its markers stay as text (R107)", async (t) => {
  const { page } = await setup(t, { "a.md": HDOC });
  await open(page, "a.md");
  await page.until(() => page.eval(`!!document.querySelector(${JSON.stringify(TOGGLE)})`), "the raw view toggle");
  const pt = await page.eval(`(() => { const r = document.querySelector(${JSON.stringify(TOGGLE)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.click(pt.x, pt.y);
  await page.until(() => page.eval(`document.getElementById("editor").classList.contains("md-source")`), "the raw view");
  await page.quiet();
  await place(page, 3);
  await hover(page, at("this", 2));
  assert.deepEqual(await handles(page), [], "handles show in the raw view");
  const text = await page.eval(`document.getElementById("editor").textContent`);
  assert.ok(text.includes("See {c1}this{/c1} now."), `the markers are not drawn as text: ${JSON.stringify(text)}`);
});

// The controls at the top of the comments column take their own clicks, with or without a
// resolved thread, and no comment card covers them.
for (const [label, doc] of [
  ["with no resolved thread", P + CM("c1")],
  ["with a resolved thread", "See {c1}this{/c1} now {c2}too{/c2}." + CM("c1") + CM("c2", true).slice(1)],
]) {
  test(`the comments column's controls are not covered by a card, ${label}`, async (t) => {
    const { page } = await setup(t, { "a.md": doc });
    await open(page, "a.md");
    await page.until(() => page.eval(`!!document.querySelector(".md-comment-card")`), "a comment card");
    const covered = await page.eval(`(() => {
      const aside = document.querySelector("aside.comments") || document.querySelector(".comments");
      const controls = [...aside.querySelectorAll("button, input")].filter((el) => !el.closest(".md-comment-card") && el.getClientRects().length > 0);
      const out = [];
      for (const el of controls) {
        const r = el.getBoundingClientRect();
        for (const [x, y] of [[r.left + 2, r.top + 2], [r.right - 2, r.top + 2], [r.left + 2, r.bottom - 2], [r.right - 2, r.bottom - 2], [(r.left + r.right) / 2, (r.top + r.bottom) / 2]]) {
          const hit = document.elementFromPoint(x, y);
          if (hit && hit !== el && !el.contains(hit)) { out.push((el.textContent || el.id || el.className).trim() + " at " + Math.round(x) + "," + Math.round(y) + " is under " + hit.tagName + "." + String(hit.className).split(" ")[0]); break; }
        }
      }
      return out;
    })()`);
    assert.deepEqual(covered, [], covered.join("; "));
  });
}

// Ticket b9xa86zd: the add-comment button covers no text a person might click. In the comments
// column it lines up with the selection, so a selection on the line of an existing comment must
// not put the button over that comment's card.
test("the add-comment button does not cover a comment card on the selection's line, and a click on the card adds no comment", async (t) => {
  const doc = "See {c1}this{/c1} now and more words here." + CM("c1");
  const { hub, page } = await setup(t, { "a.md": doc });
  await open(page, "a.md");
  await page.until(() => page.eval(`!!document.querySelector(".md-comment-card")`), "a comment card");
  await place(page, 0);
  const word = await page.eval(`window.__qaWordPoint("words", 1)`);
  await page.click(word.x, word.y, { clickCount: 2 });
  await page.quiet();
  await page.until(() => page.eval(`(() => { const b = document.querySelector(".md-add-comment"); return !!b && !b.hidden && b.getClientRects().length > 0; })()`), "the add-comment button");
  const covered = await page.eval(`(() => {
    const card = document.querySelector(".md-comment-card").getBoundingClientRect();
    const out = [];
    for (let x = card.left + 4; x < card.right - 2; x += 16) {
      for (let y = card.top + 4; y < card.bottom - 2; y += 6) {
        const hit = document.elementFromPoint(x, y);
        if (hit && hit.closest(".md-add-comment")) out.push(Math.round(x) + "," + Math.round(y));
      }
    }
    return out;
  })()`);
  assert.deepEqual(covered, [], `the add-comment button covers the card at ${covered.length} points, such as ${covered.slice(0, 3).join("; ")}`);
  const corner = await page.eval(`(() => { const r = document.querySelector(".md-comment-card").getBoundingClientRect(); return { x: r.left + 30, y: r.top + 10 }; })()`);
  await page.click(corner.x, corner.y);
  await page.quiet();
  await sleep(300);
  assert.equal((await hub.show("a.md")).text, doc, "a click on the card changed the file");
});

// Ticket mar9nkqb: the add-comment button is drawn half a line below the bottom of the
// highlighted area, across the last highlighted character, in front of everything else, and in
// the window. The tolerances are QA's reading of the ticket: the top within a quarter line of
// that place, and the middle of the last highlighted character, in text order, inside the
// button's left and right edges.
const NOTE = (id, lines) => `\n\n\`\`\`comment ${id}\n:: 0\n@2026-10-05T16:00:00.000Z Ada\n${Array.from({ length: lines }, (_, i) => `Note ${id} line ${i + 1} with some more words to wrap the card.`).join("\n")}\n\`\`\`\n`;
const PLACED = [
  "First {c1}paragraph{/c1} has a comment and apple.",
  "Second {c2}paragraph{/c2} has a comment and banana.",
  "Third {c3}paragraph{/c3} has a comment and cherry.",
  "Fourth paragraph has no comment and damson.",
  "Fifth paragraph has no comment and elder.",
  "A long paragraph that runs on and on so that it wraps across several lines in the editor column, with the word fig near its very end, then grape.",
].join("\n\n") + NOTE("c1", 4) + NOTE("c2", 4) + NOTE("c3", 4);

// Where the button is, and where the ticket puts it, read from the page's own layout.
function buttonPlace(page) {
  return page.eval(`(() => {
    const b = document.querySelector(".md-add-comment");
    const sel = getSelection();
    if (!sel.rangeCount) return { error: "no selection" };
    const range = sel.getRangeAt(0);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    if (rects.length === 0) return { error: "the selection draws nothing" };
    const bottom = Math.max(...rects.map((r) => r.bottom));
    let glyph = null;
    let node = range.endContainer, offset = range.endOffset;
    if (node.nodeType === 3 && offset > 0) {
      const one = document.createRange();
      one.setStart(node, offset - 1);
      one.setEnd(node, offset);
      glyph = [...one.getClientRects()].find((r) => r.width > 0) || null;
    }
    const lastRect = rects.filter((r) => Math.abs(r.bottom - bottom) < 1).pop();
    const middle = glyph ? (glyph.left + glyph.right) / 2 : lastRect.right - 1;
    const holder = node.nodeType === 3 ? node.parentElement : node;
    let pitch = parseFloat(getComputedStyle(holder).lineHeight);
    if (!Number.isFinite(pitch)) pitch = (glyph || lastRect).height * 1.2;
    const out = { selected: String(sel), bottom, middle, pitch, drawn: !!b && !b.hidden && b.getClientRects().length > 0 };
    if (!out.drawn) return out;
    const r = b.getBoundingClientRect();
    out.button = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    const points = [[r.left + 2, r.top + 2], [r.right - 2, r.top + 2], [(r.left + r.right) / 2, (r.top + r.bottom) / 2], [r.left + 2, r.bottom - 2], [r.right - 2, r.bottom - 2]];
    out.covered = points.map(([x, y]) => { const hit = document.elementFromPoint(x, y); return hit && hit.closest(".md-add-comment") ? null : Math.round(x) + "," + Math.round(y) + " " + (hit ? hit.tagName + "." + String(hit.className).split(" ")[0] : "nothing"); }).filter(Boolean);
    out.window = { width: innerWidth, height: innerHeight };
    return out;
  })()`);
}

function assertPlaced(at, what) {
  assert.ok(!at.error, `${what}: ${at.error}`);
  assert.ok(at.drawn, `${what}: no add-comment button after selecting ${JSON.stringify(at.selected)}`);
  const want = at.bottom + at.pitch / 2;
  const b = at.button;
  const where = `${what}: the button is at x ${Math.round(b.left)} to ${Math.round(b.right)}, y ${Math.round(b.top)} to ${Math.round(b.bottom)}`;
  assert.ok(Math.abs(b.top - want) <= at.pitch / 4, `${where}. Its top should be half a line, ${(at.pitch / 2).toFixed(1)} px, below the highlight's bottom at y ${Math.round(at.bottom)}, so near y ${Math.round(want)}`);
  assert.ok(b.left <= at.middle && at.middle <= b.right, `${where}. It should span x ${Math.round(at.middle)}, the middle of the last highlighted character`);
  // Outside the window, elementFromPoint finds nothing, so the window is checked before the cover.
  assert.ok(b.left >= 0 && b.top >= 0 && b.right <= at.window.width && b.bottom <= at.window.height, `${where}, outside the ${at.window.width} by ${at.window.height} window`);
  assert.deepEqual(at.covered, [], `${where}. Something else is drawn over it`);
}

const PLACEMENTS = [
  ["a word double-clicked on a line that has a comment card", { word: "apple" }],
  ["a word double-clicked on a line with no card", { word: "damson" }],
  ["the last word of a wrapped paragraph, double-clicked", { word: "grape" }],
  ["a Shift+click selection across lines of a wrapped paragraph", { from: "runs", to: "fig" }],
  ["a selection made backwards with Shift+←", { back: "elder" }],
];

for (const [name, how] of PLACEMENTS) {
  test(`the add-comment button: ${name}, is half a line below the highlight, across its last character (ticket mar9nkqb)`, async (t) => {
    const { page } = await setup(t, { "a.md": PLACED });
    await open(page, "a.md");
    await page.until(() => page.eval(`document.querySelectorAll(".md-comment-card").length === 3`), "three comment cards");
    await place(page, 0);
    if (how.word) {
      const word = await page.eval(`window.__qaWordPoint(${JSON.stringify(how.word)}, 1)`);
      await page.click(word.x, word.y, { clickCount: 2 });
    } else if (how.from) {
      await place(page, PLACED.indexOf(how.from));
      const end = await page.eval(`window.__qaClickPoint(${PLACED.indexOf(how.to) + how.to.length})`);
      await page.click(end.x, end.y, { modifiers: 8 });
    } else {
      await place(page, PLACED.indexOf(how.back) + how.back.length);
      for (let i = 0; i < how.back.length; i += 1) await page.key("←", ["Shift"]);
    }
    await page.quiet();
    await sleep(150);
    const at = await buttonPlace(page);
    assertPlaced(at, name);
  });
}

// The highlight moves when the page scrolls, and the button has to move with it. Left behind, it
// sits over text away from the highlight and takes the press meant for that text.
test("the add-comment button: after the page scrolls under the pointer, is half a line below the highlight, across its last character (ticket mar9nkqb)", async (t) => {
  const filler = Array.from({ length: 40 }, (_, i) => `Filler paragraph number ${i + 1} sits here.`).join("\n\n");
  const doc = "First {c1}paragraph{/c1} has a comment.\n\n" + filler + NOTE("c1", 2);
  const { page } = await setup(t, { "a.md": doc });
  await open(page, "a.md");
  await page.until(() => page.eval(`document.querySelectorAll(".md-comment-card").length === 1`), "a comment card");
  const word = await page.eval(`window.__qaWordPoint("number", 6)`);
  await page.click(word.x, word.y, { clickCount: 2 });
  await page.quiet();
  await sleep(150);
  assertPlaced(await buttonPlace(page), "before the scroll");
  const highlight = async () => page.eval(`Math.max(...[...getSelection().getRangeAt(0).getClientRects()].filter((r) => r.width > 0).map((r) => r.bottom))`);
  const before = await highlight();
  await page.session.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: word.x, y: word.y, deltaX: 0, deltaY: 120 });
  await page.until(async () => (await highlight()) < before - 60, "the page scrolled", 3000);
  await sleep(300);
  assertPlaced(await buttonPlace(page), `after a 120 px scroll, with the highlight's bottom gone from y ${Math.round(before)} to y ${Math.round(await highlight())}`);
});

// Ticket mar9nkqb, the owner's answer of 2026-10-13: when the button's place under the highlight
// is not inside the window, the page makes room for it there. QA's reading: for a selection just
// made, the page scrolls until the whole button is inside the window, and at the end of the
// document it adds room to scroll into. A scroll the person makes is left alone.
const ROOM = Array.from({ length: 60 }, (_, i) => `Filler paragraph ${i + 1} holds the word mark${i + 1}x here.`).join("\n\n") + "\n\nThe last paragraph ends with omega.\n";

// Scrolls the page until the line holding `word` ends at the bottom of the window, or as far as
// the page goes. Returns the bottom of that line, and the window's height.
function lineToBottom(page, word) {
  return page.eval(`(() => {
    const editor = document.getElementById("editor");
    const walk = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let node = walk.nextNode();
    while (node && !node.data.includes(${JSON.stringify(word)})) node = walk.nextNode();
    const line = node && (node.parentElement.closest(".md-line") || node.parentElement);
    if (!line) return { error: "no line drawn for " + ${JSON.stringify(word)} };
    line.scrollIntoView({ block: "end" });
    if (${JSON.stringify(word)} === "omega") {
      editor.scrollTop = editor.scrollHeight;
      scrollTo(0, document.documentElement.scrollHeight);
    }
    return { bottom: line.getBoundingClientRect().bottom, height: innerHeight };
  })()`);
}

for (const [name, word] of [["a word on the window's last line", "mark30x"], ["the last word of the document, scrolled to its end", "omega"]]) {
  test(`the add-comment button: ${name}, double-clicked, the page makes room and the button is half a line below the highlight, in the window (ticket mar9nkqb)`, async (t) => {
    const { page } = await setup(t, { "a.md": ROOM });
    await open(page, "a.md");
    await place(page, 0);
    const moved = await lineToBottom(page, word);
    assert.ok(!moved.error, moved.error);
    await sleep(200);
    const point = await page.eval(`window.__qaWordPoint(${JSON.stringify(word)}, 1)`);
    assert.ok(point && point.y < moved.height, `the word ${word} is not in the window: ${JSON.stringify(point)}`);
    await page.click(point.x, point.y, { clickCount: 2 });
    await page.quiet();
    await sleep(400);
    const at = await buttonPlace(page);
    assertPlaced(at, `${name}, its line's bottom at y ${Math.round(moved.bottom)} in a ${moved.height} px window before the double-click`);
  });
}

// QA's reading: the room is made for a selection just made. When the person scrolls the
// highlight down and out of the window, the page does not scroll it back.
test("the add-comment button: after the person scrolls the highlight below the window, the page leaves the scroll where the person put it (ticket mar9nkqb)", async (t) => {
  const { page } = await setup(t, { "a.md": ROOM });
  await open(page, "a.md");
  await place(page, 0);
  await page.eval(`(() => { const p = window.__qaWordPoint("mark30x", 1); const hit = document.elementFromPoint(p.x, Math.min(innerHeight - 1, Math.max(0, p.y))); (hit.closest(".md-line") || hit).scrollIntoView({ block: "center" }); })()`);
  await sleep(200);
  const word = await page.eval(`window.__qaWordPoint("mark30x", 1)`);
  await page.click(word.x, word.y, { clickCount: 2 });
  await page.quiet();
  await sleep(300);
  assertPlaced(await buttonPlace(page), "before the scroll");
  const highlight = async () => page.eval(`Math.max(...[...getSelection().getRangeAt(0).getClientRects()].filter((r) => r.width > 0).map((r) => r.bottom))`);
  const before = await highlight();
  const height = await page.eval("innerHeight");
  const delta = Math.round(height - before + 40);
  await page.session.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: word.x, y: word.y, deltaX: 0, deltaY: -delta });
  await page.until(async () => (await highlight()) > before + delta - 30, "the page scrolled up", 3000);
  await sleep(400);
  const settled = await highlight();
  await sleep(600);
  const later = await highlight();
  assert.ok(settled > height, `the wheel left the highlight's bottom at y ${Math.round(settled)}, inside the ${height} px window`);
  assert.ok(Math.abs(later - settled) < 1, `the page scrolled by itself after the person's scroll: the highlight's bottom went from y ${Math.round(settled)} to y ${Math.round(later)}`);
});
