import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { OTHER, launchBrowser, Page, startHub } from "./harness.js";

// A comment highlight grows a handle at each end. Dragging one handle moves
// that marker; the note and the fence stay. One edit.

const CM = (id) => `\n\n\`\`\`comment ${id}\n:: 0\n@2026-10-05T16:00:00.000Z Ada\nNote ${id}.\n\`\`\`\n`;
const P = "See {c1}this{/c1} now.";

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
  return { hub, browser, page };
}

async function open(page, file) {
  await page.open(file);
  await page.until(() => page.eval(`document.querySelectorAll("#editor .md-line").length > 0`), `${file} drawn`);
}

async function bytes(hub, file) {
  await sleep(150);
  return (await hub.show(file)).text;
}

function editsSince(page, since) {
  return page.frames.slice(since).filter((frame) => frame.dir === "out" && frame.data && frame.data.type === "edit");
}

async function hover(page, offset) {
  const point = await page.eval(`window.__qaClickPoint(${offset})`);
  assert.ok(point, `no point for offset ${offset}`);
  await page.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await page.frame();
  return point;
}

async function handles(page) {
  return page.eval(`(() => [...document.querySelectorAll("#editor .md-comment-handle")].map((el) => {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      edge: el.dataset.edge,
      comment: el.dataset.comment,
      start: el.dataset.start,
      end: el.dataset.end,
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      w: r.width,
      h: r.height,
      radius: style.borderRadius,
    };
  }))()`);
}

async function dragHandle(page, edge, to) {
  const from = await page.eval(`(() => {
    const el = document.querySelector('#editor .md-comment-handle[data-edge="${edge}"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  assert.ok(from, `no ${edge} handle`);
  const since = page.frames.length;
  await page.drag(from, to);
  await page.quiet();
  return editsSince(page, since);
}

test("dragging a comment handle moves that end, and an empty drag writes nothing", async (t) => {
  const crossed = "See {c1}this{/c1} and {c2}that{/c2}.";
  const fenced = `${P}\n\n\`\`\`python\nx\n\`\`\`\n`;
  const table = `${P}\n\n| a | b |\n| --- | --- |\n| c | d |\n`;
  const two = "One {c1}alpha{/c1} two {c2}beta{/c2}.";
  const { hub, page } = await setup(t, {
    "a.md": P + CM("c1"),
    "cross.md": crossed + CM("c1") + CM("c2").slice(1),
    "fence.md": fenced + CM("c1"),
    "table.md": table + CM("c1"),
    "two.md": two + CM("c1") + CM("c2").slice(1),
  });

  await open(page, "a.md");
  assert.ok(await page.clickOffset(P.length + 1), "no blank line under the sentence");
  await page.quiet();
  const renderedRaw = await page.eval(`document.querySelector("#editor .md-line").classList.contains("md-raw")`);
  assert.equal(renderedRaw, false);

  await hover(page, P.indexOf("this") + 2);
  let ends = await handles(page);
  assert.deepEqual(ends.map((handle) => handle.edge).sort(), ["end", "start"]);
  assert.equal(ends.every((handle) => handle.comment === "c1" && handle.start === handle.end), true);
  assert.equal(ends.every((handle) => handle.w === handle.h && handle.w >= 8 && handle.radius !== "0px"), true);
  const drawnRendered = await page.eval(`window.__qaDrawn().text`);
  assert.equal(drawnRendered.includes("{c1}"), false);
  assert.equal(drawnRendered.includes("{/c1}"), false);

  await hover(page, P.indexOf("now") + 1);
  assert.deepEqual(await handles(page), []);

  await hover(page, P.indexOf("this") + 2);
  const endAt = await page.eval(`window.__qaClickPoint(21)`);
  assert.ok(endAt, "no point past now");
  let edits = await dragHandle(page, "end", endAt);
  assert.equal(edits.length, 1, `end drag sent ${edits.map((frame) => frame.data.op).join(",")}`);
  assert.equal(edits[0].data.op, "insert");
  let after = await bytes(hub, "a.md");
  assert.equal(after, `See {c1}this now{/c1}.${CM("c1")}`);
  whole(after, "end handle");

  await page.eval(`document.getElementById("editor").focus()`);
  await page.key("z", ["Ctrl"]);
  await page.quiet();
  assert.equal(await bytes(hub, "a.md"), P + CM("c1"));

  await hover(page, P.indexOf("this") + 2);
  const startAt = await page.eval(`window.__qaClickPoint(0)`);
  assert.ok(startAt, "no point before See");
  edits = await dragHandle(page, "start", startAt);
  assert.equal(edits.length, 1, `start drag sent ${edits.map((frame) => frame.data.op).join(",")}`);
  assert.equal(edits[0].data.op, "insert");
  after = await bytes(hub, "a.md");
  assert.equal(after, `{c1}See this{/c1} now.${CM("c1")}`);
  whole(after, "start handle");

  await page.eval(`document.getElementById("editor").focus()`);
  await page.key("z", ["Ctrl"]);
  await page.quiet();
  assert.equal(await bytes(hub, "a.md"), P + CM("c1"));

  await hover(page, P.indexOf("this") + 2);
  const beforeEmpty = await handles(page);
  const endBefore = beforeEmpty.find((handle) => handle.edge === "end");
  const startHandle = beforeEmpty.find((handle) => handle.edge === "start");
  assert.equal(startHandle.start, "8");
  edits = await dragHandle(page, "end", { x: startHandle.x, y: startHandle.y });
  assert.equal(edits.length, 0, `empty drag wrote ${edits.map((frame) => JSON.stringify(frame.data)).join(";")}`);
  assert.equal(await bytes(hub, "a.md"), P + CM("c1"));
  const endAfter = (await handles(page)).find((handle) => handle.edge === "end");
  assert.ok(endAfter, "the end handle did not come back");
  assert.ok(Math.abs(endAfter.x - endBefore.x) < 2 && Math.abs(endAfter.y - endBefore.y) < 2, "the end handle did not return");

  assert.ok(await page.clickOffset(P.indexOf("this") + 2), "no point on this");
  await page.quiet();
  await hover(page, P.indexOf("this") + 2);
  const raw = await page.eval(`(() => {
    const line = document.querySelector("#editor .md-line");
    const markers = [...line.querySelectorAll(".md-comment-marker")].map((el) => ({
      text: el.textContent,
      kids: el.childNodes.length,
      edge: el.dataset.edge,
    }));
    return { raw: line.classList.contains("md-raw"), drawn: window.__qaDrawn().text, markers };
  })()`);
  assert.equal(raw.raw, true);
  assert.equal(raw.drawn.includes("{c1}"), false);
  assert.equal(raw.drawn.includes("{/c1}"), false);
  assert.equal(raw.markers.length, 2);
  assert.equal(raw.markers.every((marker) => marker.text === "" && marker.kids === 0), true);
  const rawEnd = await page.eval(`window.__qaClickPoint(21)`);
  edits = await dragHandle(page, "end", rawEnd);
  assert.equal(edits.length, 1);
  after = await bytes(hub, "a.md");
  assert.equal(after, `See {c1}this now{/c1}.${CM("c1")}`);
  whole(after, "raw end handle");

  await open(page, "cross.md");
  await page.clickOffset(crossed.indexOf("this") + 1);
  await page.quiet();
  await hover(page, crossed.indexOf("this") + 1);
  const insideThat = crossed.indexOf("that") + 2;
  const crossAt = await page.eval(`window.__qaClickPoint(${insideThat})`);
  assert.ok(crossAt, "no point inside that");
  edits = await dragHandle(page, "end", crossAt);
  assert.equal(edits.length, 0);
  assert.equal(await bytes(hub, "cross.md"), crossed + CM("c1") + CM("c2").slice(1));

  await open(page, "fence.md");
  await page.clickOffset(P.indexOf("this") + 1);
  await page.quiet();
  await hover(page, P.indexOf("this") + 1);
  const codeAt = fenced.indexOf("\nx\n") + 2;
  const fencePoint = await page.eval(`window.__qaClickPoint(${codeAt})`);
  assert.ok(fencePoint, "no point on the fenced x");
  edits = await dragHandle(page, "end", fencePoint);
  assert.equal(edits.length, 0);
  assert.equal(await bytes(hub, "fence.md"), fenced + CM("c1"));

  await open(page, "table.md");
  await page.clickOffset(P.indexOf("this") + 1);
  await page.quiet();
  await hover(page, P.indexOf("this") + 1);
  const cellAt = table.indexOf("| c |") + 2;
  const tablePoint = await page.eval(`window.__qaClickPoint(${cellAt})`);
  assert.ok(tablePoint, "no point in the table cell");
  edits = await dragHandle(page, "end", tablePoint);
  assert.equal(edits.length, 0);
  assert.equal(await bytes(hub, "table.md"), table + CM("c1"));

  await open(page, "two.md");
  const alpha = two.indexOf("alpha") + 1;
  const beta = two.indexOf("beta") + 1;
  assert.ok(await page.clickOffset(alpha));
  await page.quiet();
  const borders = async () => page.eval(`(() => [...document.querySelectorAll("#editor .md-comment")].map((el) => ({
    id: el.dataset.comment,
    current: el.classList.contains("md-comment-current"),
    border: getComputedStyle(el).borderTopWidth,
  })))()`);
  let marks = await borders();
  const alphaMark = marks.find((mark) => mark.id === "c1");
  const betaMark = marks.find((mark) => mark.id === "c2");
  assert.ok(alphaMark && alphaMark.current, "alpha is not the current highlight");
  assert.equal(alphaMark.border, "2px");
  assert.ok(betaMark && !betaMark.current);
  assert.ok(parseFloat(alphaMark.border) > parseFloat(betaMark.border));
  assert.ok(await page.clickOffset(beta));
  await page.quiet();
  marks = await borders();
  assert.equal(marks.find((mark) => mark.id === "c1").current, false);
  assert.equal(marks.find((mark) => mark.id === "c2").border, "2px");
  assert.ok(await page.clickOffset(1));
  await page.quiet();
  marks = await borders();
  assert.equal(marks.some((mark) => mark.current), false);
});

test("a handle dragged into a block another session holds is refused with that user's name", async (t) => {
  const doc = `${P}\n\nHeld line stays.\n`;
  const { hub, browser, page: A } = await setup(t, { "a.md": doc + CM("c1") });
  const { session } = await browser.newSession();
  const B = new Page(session, hub.port);
  await B.init();
  await B.login(OTHER);
  await A.open("a.md");
  await B.open("a.md");
  const held = doc.indexOf("Held") + 2;
  assert.ok(await A.clickOffset(P.indexOf("this") + 2));
  await A.quiet();
  assert.ok(await B.clickOffset(held));
  await B.quiet();
  await sleep(300);
  await hover(A, P.indexOf("this") + 2);
  const into = await A.eval(`window.__qaClickPoint(${held})`);
  assert.ok(into, "no point on the held line");
  const since = A.frames.length;
  const edits = await dragHandle(A, "end", into);
  const answer = A.frames.slice(since).find((frame) => frame.dir === "in" && frame.data && frame.data.type === "error");
  assert.ok(answer, `no refusal among ${edits.length} edits`);
  assert.equal(answer.data.status, 409);
  assert.equal(answer.data.heldBy, OTHER);
  assert.equal(await bytes(hub, "a.md"), doc + CM("c1"));
  await A.until(
    () => A.eval(`window.__qa.flashes.some((flash) => flash.name.includes(${JSON.stringify(OTHER)}))`),
    "the other user's name flashes",
    3000,
  );
  const named = await A.eval(`[...document.querySelectorAll("#editor .md-lock")].some((label) => label.textContent.includes(${JSON.stringify(OTHER)}))`);
  assert.equal(named, true);
});
