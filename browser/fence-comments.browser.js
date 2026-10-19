import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { AGENT, REPO, USER, cli, launchBrowser, Page, startHub } from "./harness.js";

// Ticket 4m94ewju: a comment on a source fence, an image, or a diagram is a comment fence that
// follows that block. Its token is a line range for a source fence and an x,y pin from the top
// left for an image or a diagram. Each test is an acceptance item or a page behavior in the
// ticket's Syntax section. A pin is dragged with real input, and only the drop is dispatched (see
// dragPinOnto).

const FENCE = "```javascript\nfunction f() {\n  return 1;\n  return 2;\n}\n```\n";
const note = (id, token, text) => `\`\`\`comment ${id}${token ? ` ${token}` : ""}\n:: 0\n@2026-10-16T15:00:00.000Z qa\n${text}\n\`\`\`\n`;

const run = (hub, args, input = "") => cli(hub.port, ["--user", AGENT, "--repo", REPO, ...args], input);

async function setup(t, text, { vim = false } = {}) {
  const hub = await startHub();
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await hub.close();
  });
  const file = await hub.create("f.md", text);
  const page = new Page(browser.session, hub.port);
  await page.init();
  if (vim) await page.session.send("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem("viewmark.vim", "1");` });
  await page.login(USER);
  await page.open(file);
  await page.quiet();
  return { hub, page, file };
}

// Waits for check to return something, and returns it.
async function waitFor(check, what, timeout = 5000) {
  const until = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) assert.fail(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

const box = (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; })()`;

// The rows of the drawn fence, each the top and bottom of its text.
const fenceRows = (page) => page.eval(`(() => {
  const fence = document.querySelector(".md-block-fence");
  const rows = new Map();
  const walker = document.createTreeWalker(fence, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) {
      const key = Math.round(r.top);
      const row = rows.get(key) || { top: r.top, bottom: r.bottom };
      row.bottom = Math.max(row.bottom, r.bottom);
      rows.set(key, row);
    }
  }
  return [...rows.values()].sort((a, b) => a.top - b.top);
})()`);

const currentThread = (page) => page.eval(`(() => { const c = document.querySelector(".md-comment-card.md-comment-current"); return c ? c.textContent : null; })()`);

async function addCommentFromButton(page, text) {
  const at = await waitFor(() => page.eval(box(".md-add-comment")), "the add-comment button");
  await page.click(at.left + at.width / 2, at.top + at.height / 2);
  await page.until(() => page.eval(`document.activeElement && document.activeElement.classList.contains("md-comment-body")`), "the note box");
  await page.type(text);
  await page.key("Enter", ["Ctrl"]);
  await page.quiet();
}

// ---- Line ranges on a source fence ------------------------------------------------------------

test("4m94ewju: a range comment after a highlighted fence draws a bar beside those lines only, and the fence keeps its bytes and its syntax colors", async (t) => {
  const text = `Intro.\n\n${FENCE}${note("c1", "2-3", "Both returns.")}\nEnd.\n`;
  const { hub, page, file } = await setup(t, text);
  assert.equal((await hub.show(file)).text, text);
  assert.ok(await page.eval(`document.querySelectorAll(".md-block-fence .token").length > 0`), "the fence has no syntax colors");
  const rows = await fenceRows(page);
  assert.equal(rows.length, 4, JSON.stringify(rows));
  const bar = await page.eval(box(".md-comment-bar"));
  assert.ok(bar, "no bar is drawn");
  assert.ok(bar.top <= rows[1].top + 1 && bar.bottom >= rows[2].bottom - 1, `the bar ${JSON.stringify(bar)} does not cover lines 2 and 3 ${JSON.stringify(rows.slice(1, 3))}`);
  assert.ok(bar.top > rows[0].bottom && bar.bottom < rows[3].top, `the bar ${JSON.stringify(bar)} reaches line 1 or line 4 ${JSON.stringify([rows[0], rows[3]])}`);
});

test("4m94ewju: a click on a fence's bar opens that thread", async (t) => {
  const { page } = await setup(t, `Intro.\n\n${FENCE}${note("c1", "2-3", "Both returns.")}\nEnd.\n`);
  const bar = await page.eval(box(".md-comment-bar"));
  await page.click(bar.left + bar.width / 2, bar.top + bar.height / 2);
  await page.quiet();
  const current = await waitFor(() => currentThread(page), "a current thread");
  assert.ok(current.includes("Both returns."), current);
});

test("4m94ewju: a highlight over lines 2 and 3 of a fence and Add comment write a range fence after it, and the fence keeps its bytes", async (t) => {
  const text = `Intro.\n\n${FENCE}\nEnd.\n`;
  const { hub, page, file } = await setup(t, text);
  const from = text.indexOf("  return 1;") + 4;
  const to = text.indexOf("  return 2;") + 6;
  const p = await page.eval(`window.__qaClickPoint(${from})`);
  const q = await page.eval(`window.__qaClickPoint(${to})`);
  assert.ok(p && q, "no points in the fence");
  await page.drag(p, q);
  await page.quiet();
  await addCommentFromButton(page, "Two lines.");
  const after = (await hub.show(file)).text;
  assert.ok(after.startsWith(`Intro.\n\n${FENCE}\`\`\`comment c1 2-3\n`), JSON.stringify(after));
  // The bar is drawn on the closed fence, so the caret leaves it first.
  assert.ok(await page.clickOffset(after.indexOf("End.") + 1));
  await page.quiet();
  assert.ok(await waitFor(() => page.eval(box(".md-comment-bar")), "the bar"), "no bar is drawn");
});

test("4m94ewju: a second range on the same fence is the next comment fence, and one line is stored as a single number", async (t) => {
  const text = `Intro.\n\n${FENCE}${note("c1", "2-3", "Both returns.")}\nEnd.\n`;
  const { hub, page, file } = await setup(t, text);
  const from = text.indexOf("}\n```\n```comment");
  const p = await page.eval(`window.__qaClickPoint(${from})`);
  const q = await page.eval(`window.__qaClickPoint(${from + 1})`);
  await page.drag(p, q);
  await page.quiet();
  await addCommentFromButton(page, "The brace.");
  const after = (await hub.show(file)).text;
  assert.ok(after.includes(`Both returns.\n\`\`\`\n\`\`\`comment c2 4\n`), JSON.stringify(after));
});

test("g92jk6em, 4m94ewju: with vim keys on, V and j from line 2 to line 3 of a fence, then gc, write the range 2-3", async (t) => {
  const text = `Intro.\n\n${FENCE}\nEnd.\n`;
  const { hub, page, file } = await setup(t, text, { vim: true });
  assert.ok(await page.clickOffset(text.indexOf("  return 1;") + 2));
  await page.quiet();
  await page.key("Escape");
  // Inside a code fence, j moves one line of code, as in stock vim (g92jk6em).
  for (const k of ["V", "j", "g", "c"]) await page.key(k);
  await page.until(() => page.eval(`document.activeElement && document.activeElement.classList.contains("md-comment-body")`), "the note box");
  await page.type("Two lines.");
  await page.key("Enter", ["Ctrl"]);
  await page.quiet();
  const after = (await hub.show(file)).text;
  assert.ok(after.startsWith(`Intro.\n\n${FENCE}\`\`\`comment c1 2-3\n`), JSON.stringify(after));
});

// ---- Pins on an image or a diagram -----------------------------------------------------------

// A pointer over a picture shows the pin in its top right corner, which a person drags.
async function hoverPin(page, img) {
  await page.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: img.left + img.width / 2, y: img.top + img.height / 2 });
  await waitFor(() => page.eval(`!!document.querySelector(".md-pin-corner")`), "the corner pin");
}

// The person's gesture with real input: the pointer over the picture shows its corner pin, a press
// on the pin and moves to the target start a real drag, and the page must accept it over the
// picture. Firefox under automation does not finish a native drop, in cage or headless, on either
// event path, so the drop itself is dispatched at the release point with the real drag's data.
async function dragPinOnto(page, img, fx, fy) {
  const to = { x: img.left + fx * img.width, y: img.top + fy * img.height };
  const send = async (type, x, y, extra = {}) => {
    await page.session.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra });
    await page.eval("1");
    await sleep(60);
  };
  await hoverPin(page, img);
  await page.eval(`(() => {
    const drag = window.__pinDrag = { started: false, accepted: null, over: null, data: null };
    window.addEventListener("dragstart", (e) => { drag.started = true; drag.data = e.dataTransfer; }, true);
    window.addEventListener("dragover", (e) => { drag.accepted = e.defaultPrevented; drag.over = e.target && e.target.tagName; drag.data = e.dataTransfer || drag.data; }, false);
    return true;
  })()`);
  const pin = await page.eval(box(".md-pin-corner"));
  await send("mouseMoved", pin.left + pin.width / 2, pin.top + pin.height / 2);
  await send("mousePressed", pin.left + pin.width / 2, pin.top + pin.height / 2, { buttons: 1 });
  for (let i = 1; i <= 8; i += 1) {
    await send("mouseMoved", pin.left + pin.width / 2 + ((to.x - pin.left - pin.width / 2) * i) / 8, pin.top + pin.height / 2 + ((to.y - pin.top - pin.height / 2) * i) / 8, { buttons: 1 });
  }
  const drag = await page.eval(`({ started: window.__pinDrag.started, accepted: window.__pinDrag.accepted, over: window.__pinDrag.over })`);
  assert.ok(drag.started, "pressing and moving the corner pin did not start a drag");
  assert.equal(drag.over, "IMG", `the drag is over ${drag.over}, not the picture`);
  assert.equal(drag.accepted, true, "the page does not accept the pin over the picture");
  await page.eval(`(() => {
    const target = document.elementFromPoint(${to.x}, ${to.y});
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientX: ${to.x}, clientY: ${to.y}, dataTransfer: window.__pinDrag.data }));
    return true;
  })()`);
  await send("mouseReleased", to.x, to.y, { buttons: 0 });
}

// The balloon's tip is its bottom center.
const tip = (pin) => ({ x: pin.left + pin.width / 2, y: pin.bottom });

test("4m94ewju: an image pin draws its balloon with the tip at those fractions of the picture, and the image line stays", async (t) => {
  const text = `Intro.\n\n![box](box.svg)\n${note("c1", "0.25,0.5", "A pin.")}\nEnd.\n`;
  const { hub, page, file } = await setup(t, text);
  const img = await waitFor(() => page.eval(`(() => { const i = document.querySelector(".md-image img"); if (!i || !i.complete || !i.naturalWidth) return null; const r = i.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`), "the picture drawn");
  const pin = await waitFor(() => page.eval(box(".md-comment-pin")), "the balloon");
  const at = tip(pin);
  const want = { x: img.left + 0.25 * img.width, y: img.top + 0.5 * img.height };
  assert.ok(Math.abs(at.x - want.x) < 2 && Math.abs(at.y - want.y) < 2, `the tip is at ${JSON.stringify(at)}, the picture's 0.25,0.5 is ${JSON.stringify(want)}, the picture is ${JSON.stringify(img)}`);
  assert.equal((await hub.show(file)).text, text);
});

test("4m94ewju: a mermaid pin draws its balloon with the tip at those fractions of the diagram, the source stays, and a mermaid fence has no bar", async (t) => {
  const text = `Intro.\n\n\`\`\`mermaid\nflowchart LR\n  A --> B\n\`\`\`\n${note("c1", "0.4,0.7", "This arrow.")}\nEnd.\n`;
  const { hub, page, file } = await setup(t, text);
  const svg = await waitFor(() => page.eval(box(".md-diagram svg")), "the diagram drawn", 10000);
  const pin = await waitFor(() => page.eval(box(".md-comment-pin")), "the balloon");
  const at = tip(pin);
  const want = { x: svg.left + 0.4 * svg.width, y: svg.top + 0.7 * svg.height };
  assert.ok(Math.abs(at.x - want.x) < 2 && Math.abs(at.y - want.y) < 2, `the tip is at ${JSON.stringify(at)}, the diagram's 0.4,0.7 is ${JSON.stringify(want)}, the diagram is ${JSON.stringify(svg)}`);
  assert.equal(await page.eval(`document.querySelectorAll(".md-comment-bar").length`), 0);
  assert.equal((await hub.show(file)).text, text);
});

test("4m94ewju: a click on a balloon opens that thread", async (t) => {
  const { page } = await setup(t, `Intro.\n\n![box](box.svg)\n${note("c1", "0.25,0.5", "A pin.")}\nEnd.\n`);
  const pin = await waitFor(() => page.eval(box(".md-comment-pin")), "the balloon");
  await page.click(pin.left + pin.width / 2, pin.top + pin.height / 2);
  await page.quiet();
  const current = await waitFor(() => currentThread(page), "a current thread");
  assert.ok(current.includes("A pin."), current);
});

test("4m94ewju: dropping the comment pin on a picture writes a pin at the drop point's fractions of the picture", async (t) => {
  const text = `Intro.\n\n![box](box.svg)\n\nEnd.\n`;
  const { hub, page, file } = await setup(t, text);
  const img = await waitFor(() => page.eval(`(() => { const i = document.querySelector(".md-image img"); if (!i || !i.complete || !i.naturalWidth) return null; const r = i.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`), "the picture drawn");
  await dragPinOnto(page, img, 0.3, 0.2);
  let after = "";
  await page.until(async () => {
    after = (await hub.show(file)).text;
    return /```comment c\d+ [0-9.]+,[0-9.]+\n/.test(after);
  }, "a pin fence");
  const [, px, py] = /```comment c\d+ ([0-9.]+),([0-9.]+)\n/.exec(after);
  assert.ok(Math.abs(Number(px) - 0.3) < 0.02 && Math.abs(Number(py) - 0.2) < 0.02, `the pin is ${px},${py} for a drop at 0.3,0.2 of the picture`);
  assert.ok(after.startsWith("Intro.\n\n![box](box.svg)\n```comment"), JSON.stringify(after));
});

const pinnedImage = [
  "Intro.",
  "",
  "![box](box.svg)",
  "```comment c1 0.25,0.5",
  ":: 0",
  "@2026-10-16T15:00:00.000Z qa",
  "A pin.",
  ":: 1",
  "@2026-10-16T15:01:00.000Z qa",
  "Still here.",
  "```",
  "End.",
  "",
].join("\n");

const balloonCenter = (pin) => ({ x: pin.left + pin.width / 2, y: pin.top + pin.height / 2 });

// Press the balloon and move to the release point. The caller releases, so a
// check can read the balloon while the pointer is still down.
async function pressBalloon(page, from, to) {
  const send = async (type, x, y, extra = {}) => {
    await page.session.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra });
    await page.eval("1");
    await sleep(40);
  };
  await send("mouseMoved", from.x, from.y);
  await send("mousePressed", from.x, from.y, { buttons: 1 });
  for (let i = 1; i <= 8; i += 1) {
    await send("mouseMoved", from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8, { buttons: 1 });
  }
  return async () => {
    await send("mouseReleased", to.x, to.y, { buttons: 0 });
  };
}

async function pinFractions(hub, file) {
  const text = (await hub.show(file)).text;
  const match = /```comment c1 ([0-9.]+),([0-9.]+)\n/.exec(text);
  assert.ok(match, JSON.stringify(text));
  return { text, x: match[1], y: match[2] };
}

test("g8w3qgk9: dragging an image pin stores the release as fractions of the picture and keeps the notes", async (t) => {
  const { hub, page, file } = await setup(t, pinnedImage);
  const img = await waitFor(() => pictureBox(page), "the picture drawn");
  const pin = await waitFor(() => page.eval(box(".md-comment-pin")), "the balloon");
  const to = { x: img.left + 0.62 * img.width, y: img.top + 0.28 * img.height };
  const release = await pressBalloon(page, balloonCenter(pin), to);
  await release();
  let stored = null;
  await page.until(async () => {
    stored = await pinFractions(hub, file);
    return Math.abs(Number(stored.x) - 0.62) < 0.02 && Math.abs(Number(stored.y) - 0.28) < 0.02;
  }, "the pin fractions");
  assert.equal(stored.text.includes("A pin.\n"), true);
  assert.equal(stored.text.includes("Still here.\n"), true);
  assert.equal(stored.text.includes("```comment c1 "), true);
  assert.equal((stored.text.match(/```comment /g) || []).length, 1);
  assert.equal(stored.text.includes("![box](box.svg)\n"), true);
  const drawn = await waitFor(() => pictureBox(page), "the picture still drawn");
  const moved = await waitFor(() => page.eval(box(".md-comment-pin")), "the moved balloon");
  const at = tip(moved);
  const want = { x: drawn.left + Number(stored.x) * drawn.width, y: drawn.top + Number(stored.y) * drawn.height };
  assert.ok(Math.abs(at.x - want.x) < 2 && Math.abs(at.y - want.y) < 2, `the tip is at ${JSON.stringify(at)}, the stored point is ${JSON.stringify(want)}`);
});

test("g8w3qgk9: a drag past one edge stores 0 or 1 on that axis and the pin stays on the picture", async (t) => {
  const { hub, page, file } = await setup(t, pinnedImage);
  const img = await waitFor(() => pictureBox(page), "the picture drawn");
  const pin = await waitFor(() => page.eval(box(".md-comment-pin")), "the balloon");
  const to = { x: img.right + 24, y: img.top + 0.6 * img.height };
  assert.ok(to.x > img.right && to.y > img.top && to.y < img.bottom);
  const release = await pressBalloon(page, balloonCenter(pin), to);
  const held = await page.eval(box(".md-comment-pin"));
  const heldTip = tip(held);
  assert.ok(Math.abs(heldTip.x - img.right) < 2, `while held, the tip x ${heldTip.x} left the right edge ${img.right}`);
  assert.ok(heldTip.y >= img.top - 2 && heldTip.y <= img.bottom + 2, `while held, the tip y ${heldTip.y} left the picture`);
  await release();
  let stored = null;
  await page.until(async () => {
    stored = await pinFractions(hub, file);
    return stored.x === "1";
  }, "the pin on the right edge");
  assert.ok(Math.abs(Number(stored.y) - 0.6) < 0.02, `the interior axis is ${stored.y}, not the release`);
  assert.notEqual(stored.y, "0");
  assert.notEqual(stored.y, "1");
  assert.equal(stored.text.includes("A pin.\n"), true);
  assert.equal(stored.text.includes("Still here.\n"), true);
  const drawn = await waitFor(() => pictureBox(page), "the picture still drawn");
  const moved = await page.eval(box(".md-comment-pin"));
  const at = tip(moved);
  assert.ok(Math.abs(at.x - drawn.right) < 2, `the tip x ${at.x} is off the right edge ${drawn.right}`);
  assert.ok(at.y >= drawn.top - 2 && at.y <= drawn.bottom + 2, `the tip y ${at.y} left the picture ${drawn.top}-${drawn.bottom}`);
});

test("g8w3qgk9: a release inside the picture stores that point, and a release past the top stores 0", async (t) => {
  const { hub, page, file } = await setup(t, pinnedImage);
  const img = await waitFor(() => pictureBox(page), "the picture drawn");
  const pin = await waitFor(() => page.eval(box(".md-comment-pin")), "the balloon");
  const inside = { x: img.left + 0.4 * img.width, y: img.top + 0.7 * img.height };
  assert.ok(inside.x > img.left && inside.x < img.right && inside.y > img.top && inside.y < img.bottom);
  let release = await pressBalloon(page, balloonCenter(pin), inside);
  await release();
  let stored = null;
  await page.until(async () => {
    stored = await pinFractions(hub, file);
    return Math.abs(Number(stored.x) - 0.4) < 0.02 && Math.abs(Number(stored.y) - 0.7) < 0.02;
  }, "the interior pin");
  assert.notEqual(stored.x, "0");
  assert.notEqual(stored.x, "1");
  assert.notEqual(stored.y, "0");
  assert.notEqual(stored.y, "1");
  const above = { x: img.left + 0.4 * img.width, y: img.top - 16 };
  assert.ok(above.y < img.top && above.x > img.left && above.x < img.right);
  const again = await waitFor(() => page.eval(box(".md-comment-pin")), "the balloon after the interior release");
  release = await pressBalloon(page, balloonCenter(again), above);
  const held = await page.eval(box(".md-comment-pin"));
  const heldTip = tip(held);
  assert.ok(Math.abs(heldTip.y - img.top) < 2, `while held, the tip y ${heldTip.y} left the top edge ${img.top}`);
  assert.ok(heldTip.x >= img.left - 2 && heldTip.x <= img.right + 2, `while held, the tip x ${heldTip.x} left the picture`);
  await release();
  await page.until(async () => {
    stored = await pinFractions(hub, file);
    return stored.y === "0";
  }, "the pin on the top edge");
  assert.ok(Math.abs(Number(stored.x) - 0.4) < 0.02, `the interior axis is ${stored.x}`);
  assert.equal(stored.text.includes("Still here.\n"), true);
  const drawn = await waitFor(() => pictureBox(page), "the picture still drawn");
  const moved = await page.eval(box(".md-comment-pin"));
  const at = tip(moved);
  assert.ok(Math.abs(at.y - drawn.top) < 2, `the tip y ${at.y} is off the top edge ${drawn.top}`);
  assert.ok(at.x >= drawn.left - 2 && at.x <= drawn.right + 2, `the tip x ${at.x} left the picture`);
});

const pinnedDiagram = [
  "Intro.",
  "",
  "```mermaid",
  "flowchart LR",
  "  A --> B",
  "```",
  "```comment c1 0.4,0.7",
  ":: 0",
  "@2026-10-16T15:00:00.000Z qa",
  "This arrow.",
  ":: 1",
  "@2026-10-16T15:01:00.000Z qa",
  "Still here.",
  "```",
  "End.",
  "",
].join("\n");

const diagramBox = (page) => page.eval(`(() => {
  const el = document.querySelector(".md-diagram svg");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!(r.width > 0) || !(r.height > 0)) return null;
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
})()`);

test("dragging a diagram pin stores the release as fractions of the diagram and keeps the svg and the notes", async (t) => {
  const { hub, page, file } = await setup(t, pinnedDiagram);
  const svg = await waitFor(() => diagramBox(page), "the diagram drawn", 10000);
  const pin = await waitFor(() => page.eval(box(".md-comment-pin")), "the balloon");
  const to = { x: svg.left + 0.55 * svg.width, y: svg.top + 0.33 * svg.height };
  assert.ok(to.x > svg.left && to.x < svg.right && to.y > svg.top && to.y < svg.bottom);
  const release = await pressBalloon(page, balloonCenter(pin), to);
  await release();
  let stored = null;
  await page.until(async () => {
    stored = await pinFractions(hub, file);
    return Math.abs(Number(stored.x) - 0.55) < 0.02 && Math.abs(Number(stored.y) - 0.33) < 0.02;
  }, "the diagram pin fractions");
  assert.equal(stored.text.includes("This arrow.\n"), true);
  assert.equal(stored.text.includes("Still here.\n"), true);
  assert.equal(stored.text.includes("```comment c1 "), true);
  assert.equal((stored.text.match(/```comment /g) || []).length, 1);
  assert.equal(stored.text.includes("```mermaid\nflowchart LR\n  A --> B\n```\n"), true);
  const drawn = await waitFor(() => diagramBox(page), "the diagram still drawn", 10000);
  const moved = await waitFor(() => page.eval(box(".md-comment-pin")), "the moved balloon");
  const at = tip(moved);
  const want = { x: drawn.left + Number(stored.x) * drawn.width, y: drawn.top + Number(stored.y) * drawn.height };
  assert.ok(Math.abs(at.x - want.x) < 2 && Math.abs(at.y - want.y) < 2, `the tip is at ${JSON.stringify(at)}, the stored point is ${JSON.stringify(want)}`);
});

test("a diagram drag past one edge stores 0 or 1 on that axis and the svg stays", async (t) => {
  const { hub, page, file } = await setup(t, pinnedDiagram);
  const svg = await waitFor(() => diagramBox(page), "the diagram drawn", 10000);
  const pin = await waitFor(() => page.eval(box(".md-comment-pin")), "the balloon");
  const to = { x: svg.right + 24, y: svg.top + 0.6 * svg.height };
  assert.ok(to.x > svg.right && to.y > svg.top && to.y < svg.bottom);
  const release = await pressBalloon(page, balloonCenter(pin), to);
  const held = await page.eval(box(".md-comment-pin"));
  const heldTip = tip(held);
  assert.ok(Math.abs(heldTip.x - svg.right) < 2, `while held, the tip x ${heldTip.x} left the right edge ${svg.right}`);
  assert.ok(heldTip.y >= svg.top - 2 && heldTip.y <= svg.bottom + 2, `while held, the tip y ${heldTip.y} left the diagram`);
  await release();
  let stored = null;
  await page.until(async () => {
    stored = await pinFractions(hub, file);
    return stored.x === "1";
  }, "the pin on the right edge");
  assert.ok(Math.abs(Number(stored.y) - 0.6) < 0.02, `the interior axis is ${stored.y}, not the release`);
  assert.notEqual(stored.y, "0");
  assert.notEqual(stored.y, "1");
  assert.equal(stored.text.includes("This arrow.\n"), true);
  assert.equal(stored.text.includes("Still here.\n"), true);
  const drawn = await waitFor(() => diagramBox(page), "the diagram still drawn", 10000);
  const moved = await page.eval(box(".md-comment-pin"));
  const at = tip(moved);
  assert.ok(Math.abs(at.x - drawn.right) < 2, `the tip x ${at.x} is off the right edge ${drawn.right}`);
  assert.ok(at.y >= drawn.top - 2 && at.y <= drawn.bottom + 2, `the tip y ${at.y} left the diagram ${drawn.top}-${drawn.bottom}`);
});

test("a press on a diagram pin that moves 3 pixels or less opens that thread and leaves the diagram drawn", async (t) => {
  const { hub, page, file } = await setup(t, pinnedDiagram);
  await waitFor(() => diagramBox(page), "the diagram drawn", 10000);
  const pin = await waitFor(() => page.eval(box(".md-comment-pin")), "the balloon");
  const from = balloonCenter(pin);
  const release = await pressBalloon(page, from, { x: from.x + 3, y: from.y });
  await release();
  await page.quiet();
  const current = await waitFor(() => currentThread(page), "a current thread");
  assert.ok(current.includes("This arrow."), current);
  const stored = await pinFractions(hub, file);
  assert.equal(stored.x, "0.4");
  assert.equal(stored.y, "0.7");
  assert.equal(stored.text.includes("Still here.\n"), true);
  const drawn = await waitFor(() => diagramBox(page), "the diagram still drawn", 10000);
  assert.ok(drawn.width > 0 && drawn.height > 0);
});

test("dragging an image pin with the window scrolled down leaves scrollY within 2 pixels", async (t) => {
  const above = [];
  const below = [];
  for (let i = 0; i < 40; i += 1) {
    above.push(`Filler line ${i + 1} sits above the picture.`, "");
    below.push(`Filler line ${i + 1} sits below the picture.`, "");
  }
  const text = `${above.join("\n")}\n${pinnedImage}\n${below.join("\n")}`;
  const { hub, page, file } = await setup(t, text);
  await waitFor(() => pictureBox(page), "the picture drawn");
  const before = await page.eval(`(() => {
    const img = document.querySelector(".md-image img");
    const top = img.getBoundingClientRect().top + window.scrollY;
    const y = Math.max(0, top - 200);
    window.scrollTo(0, y);
    return window.scrollY;
  })()`);
  assert.ok(before > 400, `the window did not scroll down, scrollY is ${before}`);
  const img = await waitFor(() => pictureBox(page), "the picture in view");
  const pin = await waitFor(() => page.eval(box(".md-comment-pin")), "the balloon");
  const to = { x: img.left + 0.62 * img.width, y: img.top + 0.28 * img.height };
  const release = await pressBalloon(page, balloonCenter(pin), to);
  await release();
  let stored = null;
  await page.until(async () => {
    stored = await pinFractions(hub, file);
    return Math.abs(Number(stored.x) - 0.62) < 0.02 && Math.abs(Number(stored.y) - 0.28) < 0.02;
  }, "the pin fractions");
  await page.frame();
  await sleep(50);
  const after = await page.eval("window.scrollY");
  assert.ok(Math.abs(after - before) <= 2, `scrollY moved from ${before} to ${after}`);
  assert.equal(stored.text.includes("A pin.\n"), true);
  assert.equal(stored.text.includes("Still here.\n"), true);
  assert.ok(await pictureBox(page), "the picture is not drawn after the drag");
});

// ---- A line edit keeps the range on the lines it marks -------------------------------------------

async function editInFence(t, keys, place) {
  const text = `Intro.\n\n${FENCE}${note("c1", "2-3", "Both returns.")}\nEnd.\n`;
  const { hub, page, file } = await setup(t, text);
  assert.ok(await page.clickOffset(place(text)));
  await page.quiet();
  for (const k of keys) {
    if (Array.isArray(k)) await page.key(k[0], k.slice(1));
    else await page.key(k);
  }
  await page.quiet();
  await sleep(300);
  return (await hub.show(file)).text;
}

test("4m94ewju: a line inserted above the range moves it down", async (t) => {
  const after = await editInFence(t, ["Enter"], (text) => text.indexOf("function f() {") + "function f() {".length);
  assert.ok(/```comment c1 3-4\n/.test(after), JSON.stringify(after));
});

test("4m94ewju: a line inserted inside the range extends its end", async (t) => {
  const after = await editInFence(t, ["Enter"], (text) => text.indexOf("  return 1;") + "  return 1;".length);
  assert.ok(/```comment c1 2-4\n/.test(after), JSON.stringify(after));
});

test("4m94ewju: a line deleted inside the range shrinks it", async (t) => {
  const after = await editInFence(t, ["Backspace"], (text) => text.indexOf("  return 2;"));
  assert.ok(/```comment c1 2\n/.test(after), JSON.stringify(after));
});

test("4m94ewju: editing the text of a line in the range does not change the numbers", async (t) => {
  const after = await editInFence(t, ["x"], (text) => text.indexOf("  return 1;") + 2);
  assert.ok(/```comment c1 2-3\n/.test(after), JSON.stringify(after));
  assert.ok(after.includes("  xreturn 1;"), JSON.stringify(after));
});

// ---- What the hub refuses ----------------------------------------------------------------------

test("4m94ewju: a prose comment still wraps its words in brace markers, and a comment on code text puts no brace markers in the fence", async (t) => {
  const hub = await startHub();
  t.after(() => hub.close());
  const text = `Intro words.\n\n${FENCE}`;
  const file = await hub.create("f.md", text);
  const prose = await run(hub, ["comment", "add", file, "--start", "1:0", "--end", "1:5", "--expect", "Intro"], "On prose.\n");
  assert.equal(prose.code, 0, prose.stderr);
  assert.ok((await hub.show(file)).text.startsWith("{c1}Intro{/c1} words."));
  const now = (await hub.show(file)).text;
  const line = now.split("\n").findIndex((l) => l === "function f() {") + 1;
  const over = await run(hub, ["comment", "add", file, "--start", `${line}:0`, "--end", `${line}:8`, "--expect", "function"], "In code.\n");
  assert.equal(over.code, 0, `exit ${over.code}: ${over.stderr}`);
  const after = (await hub.show(file)).text;
  assert.ok(after.includes(`${FENCE}\`\`\`comment c2 1\n`), `the comment is not the range 1 after the fence: ${JSON.stringify(after)}`);
  assert.ok(!/\{\/?c2\}/.test(after), `brace markers were written: ${JSON.stringify(after)}`);
});

for (const [name, token] of [
  ["a range that does not follow its block", "2-3"],
  ["a pin outside 0 to 1", "1.5,0.5"],
  ["a range outside the body lines", "2-9"],
]) {
  test(`4m94ewju: ${name} is 400 and writes nothing`, async (t) => {
    const hub = await startHub();
    t.after(() => hub.close());
    const base = name.includes("pin") ? "Intro.\n\n![box](box.svg)\n" : `Intro.\n\n${FENCE}`;
    const file = await hub.create("f.md", `${base}\nEnd.\n`);
    const before = await hub.show(file);
    const insert = name.includes("follow") ? `\n${note("c1", token, "Stray.")}` : note("c1", token, "Bad.");
    const anchor = name.includes("follow") ? "End." : name.includes("pin") ? "![box](box.svg)" : "```\n";
    const diff = name.includes("follow")
      ? `@@\n End.\n${insert.split("\n").filter((l, i, a) => i < a.length - 1).map((l) => `+${l}`).join("\n")}\n`
      : `@@\n ${anchor.replace(/\n$/, "")}\n${insert.split("\n").filter((l, i, a) => i < a.length - 1).map((l) => `+${l}`).join("\n")}\n`;
    const out = await run(hub, ["edit", file], diff);
    assert.equal(out.code, 144, `exit ${out.code}: ${out.stderr} ${out.stdout}`);
    const after = await hub.show(file);
    assert.equal(after.text, before.text);
  });
}

// ---- The owner's decisions of 2026-10-16 on adding a pin ----------------------------------------

const pictureBox = (page, n = 0) => page.eval(`(() => { const i = document.querySelectorAll(".md-image img")[${n}]; if (!i || !i.complete || !i.naturalWidth) return null; const r = i.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; })()`);

// The draggable pin drawn in a picture's top right corner, if any.
const cornerPin = (page, img) => page.eval(`(() => {
  const near = [...document.querySelectorAll("[draggable=true]")].filter((el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    return cx >= ${img.right} - 40 && cx <= ${img.right} + 4 && cy >= ${img.top} - 4 && cy <= ${img.top} + 40;
  });
  return near.length;
})()`);

test("4m94ewju: after a pin is dropped on a picture, the picture stays drawn and the caret is on a line above or below the image line", async (t) => {
  const text = "Intro.\n\n![box](box.svg)\n\nEnd.\n";
  const { page } = await setup(t, text);
  const img = await waitFor(() => pictureBox(page), "the picture drawn");
  assert.ok(await page.clickOffset(text.indexOf("End.") + 2));
  await page.quiet();
  await dragPinOnto(page, img, 0.5, 0.5);
  await page.quiet();
  await sleep(500);
  assert.ok(await pictureBox(page), "the picture is not drawn after the pin");
  const line = { from: text.indexOf("![box]"), to: text.indexOf("![box]") + "![box](box.svg)".length };
  const caret = await page.caret();
  if (caret.focus != null) assert.ok(caret.focus < line.from || caret.focus > line.to, `the caret is on the image line, at ${caret.focus}`);
});

test("4m94ewju: a pointer over a picture shows a draggable pin in its top right corner, and it goes when the pointer leaves, for each picture", async (t) => {
  const { page } = await setup(t, "Intro.\n\n![box](box.svg)\n\nMiddle.\n\n![box](box.svg)\n\nEnd.\n");
  for (const n of [0, 1]) {
    const img = await waitFor(() => pictureBox(page, n), `picture ${n + 1} drawn`);
    await page.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: img.left + img.width / 2, y: img.top + img.height / 2 });
    await sleep(300);
    assert.equal(await cornerPin(page, img), 1, `no draggable pin in picture ${n + 1}'s top right corner while the pointer is over it`);
    await page.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: img.right + 300, y: img.bottom + 200 });
    await sleep(300);
    assert.equal(await cornerPin(page, img), 0, `picture ${n + 1}'s pin stays after the pointer leaves`);
  }
});
