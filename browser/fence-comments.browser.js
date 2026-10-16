import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { AGENT, REPO, USER, cli, launchBrowser, Page, startHub } from "./harness.js";

// Ticket 4m94ewju: a comment on a source fence, an image, or a diagram is a comment fence that
// follows that block. Its token is a line range for a source fence and an x,y pin from the top
// left for an image or a diagram. Each test is an acceptance item or a page behavior in the
// ticket's Syntax section. The pin source is dropped with dispatched drag events, because
// Firefox over BiDi cannot drag.

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
  assert.ok(await page.eval(box(".md-comment-bar")), "no bar is drawn");
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

test("4m94ewju: with vim keys on, V and j from line 2 to line 3 of a fence, then gc, write the range 2-3", async (t) => {
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
  const x = img.left + 0.3 * img.width;
  const y = img.top + 0.2 * img.height;
  await page.eval(`(() => {
    const source = document.querySelector(".md-pin-source");
    const data = new DataTransfer();
    source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: data }));
    const target = document.elementFromPoint(${x}, ${y});
    for (const type of ["dragenter", "dragover", "drop"]) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y}, dataTransfer: data }));
    source.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: data }));
    return true;
  })()`);
  let after = "";
  await page.until(async () => {
    after = (await hub.show(file)).text;
    return /```comment c\d+ [0-9.]+,[0-9.]+\n/.test(after);
  }, "a pin fence");
  const [, px, py] = /```comment c\d+ ([0-9.]+),([0-9.]+)\n/.exec(after);
  assert.ok(Math.abs(Number(px) - 0.3) < 0.02 && Math.abs(Number(py) - 0.2) < 0.02, `the pin is ${px},${py} for a drop at 0.3,0.2 of the picture`);
  assert.ok(after.startsWith("Intro.\n\n![box](box.svg)\n```comment"), JSON.stringify(after));
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

test("4m94ewju: a prose comment still wraps its words in brace markers, and brace markers over a fence are still 409", async (t) => {
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
  assert.equal(over.code, 153, `exit ${over.code}: ${over.stderr}`);
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
