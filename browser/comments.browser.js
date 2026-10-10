import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { REPO, cli, launchBrowser, Page, startHub } from "./harness.js";

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
  return { hub, page };
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
  await cardClick(page, "c1");
  await cardDelete(page, "c1");
  assert.equal(await bytes(hub, "a.md"), "See this now.\n");
  await open(page, "r.md");
  const box = await page.eval(`(() => { const r = document.getElementById("show-resolved").getBoundingClientRect(); return { x: r.left + 4, y: r.top + 4 }; })()`);
  await page.click(box.x, box.y);
  await page.quiet();
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

test("dragging a selection that holds a whole comment moves the comment", async (t) => {
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

test("dragging or cutting one marker never leaves it twice", async (t) => {
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
