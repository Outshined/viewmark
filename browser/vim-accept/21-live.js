import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { launchBrowser, OTHER, Page, startHub, USER } from "../harness.js";

// The flag is read once, when the editor is created. A later write does not turn keys on.
const FILE = "a.md";
const VIM = "viewmark.vim";
const CARET = "‸";
const ANCHOR = "«";
const EDIT_KEYS = new Set(["type", "op", "anchor", "cursor", "text", "caret", "rev", "path", "username"]);
const MODE_VALUES = new Set(["normal", "insert", "visual", "visual-line"]);

function marked(text) {
  let doc = "";
  let cursor = null;
  let anchor = null;
  for (const ch of text) {
    if (ch === CARET) cursor = doc.length;
    else if (ch === ANCHOR) anchor = doc.length;
    else doc += ch;
  }
  if (cursor == null) throw new Error("missing caret");
  if (anchor == null) anchor = cursor;
  return { doc, cursor, anchor };
}

function show(doc, cursor, anchor = cursor) {
  let out = "";
  for (let i = 0; i <= doc.length; i += 1) {
    if (anchor !== cursor && i === anchor) out += ANCHOR;
    if (i === cursor) out += CARET;
    if (i < doc.length) out += doc[i];
  }
  return out;
}

// One hunk covering the whole file, so the agent's old lines match once.
function wholeDiff(before, after) {
  const lines = (text) => {
    const parts = text.split("\n");
    const last = parts.pop();
    return { parts: text.endsWith("\n") ? parts : [...parts, last], newline: text.endsWith("\n") };
  };
  const oldLines = lines(before);
  const newLines = lines(after);
  const out = ["--- a", "+++ b", `@@ -1,${oldLines.parts.length} +1,${newLines.parts.length} @@`];
  for (const line of oldLines.parts) out.push(`-${line}`);
  if (!oldLines.newline) out.push("\\ No newline at end of file");
  for (const line of newLines.parts) out.push(`+${line}`);
  if (!newLines.newline) out.push("\\ No newline at end of file");
  return `${out.join("\n")}\n`;
}

function mirror(page) {
  for (let i = page.frames.length - 1; i >= 0; i -= 1) {
    const data = page.frames[i].dir === "in" && page.frames[i].data;
    if (data && (data.type === "doc" || data.type === "file") && typeof data.text === "string") return data.text;
  }
  return null;
}

function outbound(page, since) {
  return page.frames.slice(since).filter((frame) => frame.dir === "out" && frame.data).map((frame) => frame.data);
}

function modeLeak(data) {
  const json = JSON.stringify(data);
  if (json.includes(VIM)) return VIM;
  if (Object.prototype.hasOwnProperty.call(data, "mode")) return "mode";
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string" && MODE_VALUES.has(value) && !(key === "op" && value === "insert")) return `${key}:${value}`;
  }
  if (/"normal"|"visual"|"visual-line"/.test(json)) return json;
  return "";
}

function leaks(page) {
  for (const frame of page.frames) {
    if (frame.dir !== "out" || !frame.data) continue;
    const hit = modeLeak(frame.data);
    if (hit) return hit;
  }
  return "";
}

// A linewise put of the original yank after the first line. The caret is the first character of that line.
function linewisePut(before, line) {
  const nl = before.indexOf("\n");
  const bytes = `${before.slice(0, nl + 1)}${line}${before.slice(nl + 1)}`;
  const focus = nl + 1;
  return { bytes, show: show(bytes, focus, focus) };
}

const labelOn = (page, text, name) => page.eval(`[...window.__qaRoot().querySelectorAll(".md-line, .md-atom")].some((block) => block.textContent.includes(${JSON.stringify(text)}) && [...block.querySelectorAll(".md-lock")].some((label) => label.textContent.includes(${JSON.stringify(name)})))`);

async function setup(t) {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  browser = await launchBrowser();
  const A = await loggedIn(browser.session, hub.port);
  return { hub, browser, A };
}

async function loggedIn(session, port, user = USER) {
  const page = new Page(session, port);
  await page.init();
  await page.session.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `localStorage.setItem(${JSON.stringify(VIM)}, "1");`,
  });
  await page.login(user);
  return page;
}

async function otherPage(browser, port) {
  const { session } = await browser.newSession();
  return loggedIn(session, port, OTHER);
}

async function status(page) {
  return page.eval(`(() => { const el = document.querySelector("span.md-vim-status"); return el ? el.textContent : ""; })()`);
}

async function revOf(hub) {
  return (await hub.show(FILE)).rev;
}

async function view(page, hub) {
  const bytes = (await hub.show(FILE)).text;
  const caret = await page.caret();
  const focus = caret && Number.isInteger(caret.focus) ? caret.focus : null;
  const anchor = caret && Number.isInteger(caret.anchor) ? caret.anchor : focus;
  return {
    bytes,
    focus,
    anchor,
    show: focus == null ? "no caret" : show(bytes, focus, anchor),
    page: mirror(page),
  };
}

async function placeCaret(page, offset) {
  assert.equal(await page.clickOffset(offset), true, `no point at ${offset}`);
  await page.quiet();
  const caret = await page.caret();
  assert.equal(caret.focus, offset, `caret ${caret && caret.focus} is not ${offset}`);
  assert.equal(caret.anchor, offset, `anchor ${caret && caret.anchor} is not ${offset}`);
}

// Insert is not in the harness key table. The page still has to see the key.
async function press(page, name, modifiers = []) {
  if (name === "Insert") {
    const base = { key: "Insert", code: "Insert", windowsVirtualKeyCode: 45, modifiers: 0 };
    await page.session.send("Input.dispatchKeyEvent", { ...base, type: "rawKeyDown" });
    await page.session.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
    return;
  }
  await page.key(name, modifiers);
}

async function tap(page, name, modifiers = []) {
  await press(page, name, modifiers);
  await page.quiet();
}

async function span(page, text) {
  for (const ch of text) await tap(page, ch);
}

async function agentEdit(hub, next) {
  const current = (await hub.show(FILE)).text;
  const done = await hub.edit(FILE, wholeDiff(current, next));
  assert.equal(done.code, 0, `${done.stderr}${done.stdout}`);
  return current;
}

function got(id, seen) {
  return `${id} got ${JSON.stringify(seen.show)} bytes ${JSON.stringify(seen.bytes)}`;
}

test("VL.1 (ticket 7vdep2z4)", async (t) => {
  const body = marked("‸one\n\ntwo\n").doc;
  const { hub, browser, A } = await setup(t);
  await hub.create(FILE, body);
  await A.open(FILE);
  const B = await otherPage(browser, hub.port);
  await B.open(FILE);
  await placeCaret(A, 0);
  await sleep(300);
  const rev0 = await revOf(hub);
  const since = A.frames.length;
  await tap(A, "j");
  const edits = outbound(A, since).filter((frame) => frame.type === "edit");
  assert.equal(edits.length, 0, `VL.1 edits ${JSON.stringify(edits)}`);
  assert.equal(await revOf(hub), rev0);
  const seen = await view(A, hub);
  assert.equal(seen.show, "one\n\n‸two\n", got("VL.1", seen));
  await B.until(() => labelOn(B, "two", USER), "qa-bot on two", 3000);
  assert.equal(await labelOn(B, "one", USER), false, "qa-bot still on one");
  assert.equal(leaks(A), "");
});

test("VL.2 (ticket 7vdep2z4)", async (t) => {
  const start = "‸one\n\ntwo\n";
  const body = marked(start).doc;
  const { hub, browser, A } = await setup(t);
  await hub.create(FILE, body);
  await A.open(FILE);
  const B = await otherPage(browser, hub.port);
  await B.open(FILE);
  await placeCaret(A, 0);
  // t¦wo is the boundary before w.
  await placeCaret(B, body.indexOf("two") + 1);
  await sleep(300);
  const rev0 = await revOf(hub);
  const since = A.frames.length;
  await tap(A, "j");
  assert.equal(outbound(A, since).filter((frame) => frame.type === "edit").length, 0);
  assert.equal(await revOf(hub), rev0);
  const seen = await view(A, hub);
  assert.equal(seen.show, start, got("VL.2", seen));
  assert.equal((await hub.show(FILE)).text, body);
});

test("VL.3 (ticket 7vdep2z4)", async (t) => {
  const start = "on‸e\n\ntwo\n";
  const body = marked(start).doc;
  const { hub, browser, A } = await setup(t);
  await hub.create(FILE, body);
  await A.open(FILE);
  const B = await otherPage(browser, hub.port);
  await B.open(FILE);
  await placeCaret(A, marked(start).cursor);
  await placeCaret(B, body.indexOf("two") + 1);
  await sleep(300);
  const rev0 = await revOf(hub);
  const since = A.frames.length;
  await span(A, "dj");
  const error = A.frames.slice(since).find((frame) => frame.dir === "in" && frame.data && frame.data.type === "error");
  assert.ok(error, "the hub sent no refusal");
  assert.equal(error.data.status, 409);
  assert.equal(error.data.heldBy, OTHER);
  await A.until(
    () => A.eval(`window.__qa.flashes.some((flash) => flash.name.includes(${JSON.stringify(OTHER)}) && flash.block.includes("two"))`),
    "the label on two flashes",
    3000,
  );
  assert.equal(await status(A), "N", `VL.3 status ${JSON.stringify(await status(A))}`);
  const seen = await view(A, hub);
  assert.equal(seen.show, start, got("VL.3", seen));
  assert.equal(mirror(A), body, `VL.3 A bytes ${JSON.stringify(mirror(A))}`);
  assert.equal(mirror(B), body, `VL.3 B bytes ${JSON.stringify(mirror(B))}`);
  assert.equal(await revOf(hub), rev0);
  await tap(A, "p");
  const after = await view(A, hub);
  assert.equal(after.show, start, `VL.3 register got ${JSON.stringify(after.show)}`);
  assert.equal(await status(A), "N");
  assert.equal(mirror(B), body, `VL.3 B after put ${JSON.stringify(mirror(B))}`);
});

test("VL.4 (ticket 7vdep2z4)", async (t) => {
  const start = "al‸pha beta\n";
  const { doc, cursor } = marked(start);
  const { hub, A } = await setup(t);
  await hub.create(FILE, doc);
  await A.open(FILE);
  await placeCaret(A, cursor);
  const rev0 = await revOf(hub);
  await tap(A, "d");
  assert.equal(await revOf(hub), rev0, "d edited");
  const since = A.frames.length;
  await agentEdit(hub, `zero\n\n${doc}`);
  await A.until(() => mirror(A) === `zero\n\n${doc}`, `prepend, page has ${JSON.stringify(mirror(A))}`);
  await A.quiet();
  const beforeW = await view(A, hub);
  const st = await status(A);
  assert.equal(outbound(A, since).filter((frame) => frame.type === "edit").length, 0);
  await tap(A, "w");
  const seen = await view(A, hub);
  const moved = (await revOf(hub)) - rev0;
  assert.equal(
    `${moved}\n${st}\n${seen.show}`,
    "1\nN\nzero\n\nalpha ‸beta\n",
    `VL.4 got status ${JSON.stringify(st)} before ${JSON.stringify(beforeW.show)} after ${JSON.stringify(seen.show)} rev +${moved}`,
  );
});

test("VL.5 (ticket 7vdep2z4)", async (t) => {
  const body = marked("‸alpha\n").doc;
  const { hub, browser, A } = await setup(t);
  await hub.create(FILE, body);
  // B holds the line first, so B's x is an edit on that line. A's yank does not take it.
  const B = await otherPage(browser, hub.port);
  await B.open(FILE);
  await placeCaret(B, 0);
  await sleep(300);
  await A.open(FILE);
  // Open leaves the selection unset until the editor is focused. The click is the caret the cell names.
  await placeCaret(A, 0);
  const revYank = await revOf(hub);
  await span(A, "yy");
  assert.equal(await revOf(hub), revYank, "yy edited");
  assert.equal((await hub.show(FILE)).text, body);
  await tap(B, "x");
  await span(B, "yy");
  const before = (await hub.show(FILE)).text;
  await A.until(() => mirror(A) === before, `A did not see ${JSON.stringify(before)}`);
  await A.quiet();
  // B still holds the line, so A's put is refused until B leaves a.md.
  await hub.create("z.md", "z\n");
  await B.open("z.md");
  const revPut = await revOf(hub);
  await tap(A, "p");
  const seen = await view(A, hub);
  const expected = linewisePut(before, "alpha\n");
  assert.equal(seen.bytes, expected.bytes, got("VL.5", seen));
  assert.equal(seen.show, expected.show, got("VL.5", seen));
  assert.equal(await revOf(hub), revPut + 1);
  assert.equal(await status(A), "N");
});

test("VL.6 (ticket 7vdep2z4)", async (t) => {
  const start = "al‸pha beta\n";
  const { doc, cursor } = marked(start);
  const { hub, A } = await setup(t);
  await hub.create(FILE, doc);
  await A.open(FILE);
  await placeCaret(A, cursor);
  const rev0 = await revOf(hub);
  await span(A, "dw");
  assert.equal(await revOf(hub), rev0 + 1, "dw did not edit once");
  const current = (await hub.show(FILE)).text;
  await agentEdit(hub, `${current}T`);
  await A.until(() => mirror(A) === `${current}T`, `append, page has ${JSON.stringify(mirror(A))}`);
  await A.quiet();
  assert.equal(await revOf(hub), rev0 + 2);
  await tap(A, "u");
  const seen = await view(A, hub);
  assert.equal(seen.bytes, "alpha beta\nT", got("VL.6", seen));
  assert.equal(seen.show, "al‸pha beta\nT", got("VL.6", seen));
  assert.equal(await revOf(hub), rev0 + 3);
  assert.equal(await status(A), "N");
});

test("VL.7 (ticket 7vdep2z4)", async (t) => {
  const body = "one\n\ntwo\n";
  const { hub, A } = await setup(t);
  await hub.create(FILE, body);
  await A.open(FILE);
  await placeCaret(A, 0);
  const arrowAt = A.frames.length;
  await tap(A, "↓");
  const arrowOut = outbound(A, arrowAt);
  await placeCaret(A, 0);
  const motionAt = A.frames.length;
  const rev0 = await revOf(hub);
  await tap(A, "j");
  const motionOut = outbound(A, motionAt);
  const arrowLocks = arrowOut.filter((frame) => frame.type === "lock");
  const motionLocks = motionOut.filter((frame) => frame.type === "lock");
  assert.deepEqual(motionOut.map((frame) => frame.type), motionLocks.map(() => "lock"), `VL.7 motion ${JSON.stringify(motionOut)}`);
  assert.equal(motionLocks.length, arrowLocks.length, `VL.7 locks motion ${motionLocks.length} arrow ${arrowLocks.length}`);
  assert.equal(await revOf(hub), rev0);
  if (arrowLocks[0] && motionLocks[0]) assert.deepEqual(Object.keys(motionLocks[0]).sort(), Object.keys(arrowLocks[0]).sort());
  await placeCaret(A, 0);
  const editAt = A.frames.length;
  await tap(A, "x");
  const editOut = outbound(A, editAt);
  const edits = editOut.filter((frame) => frame.type === "edit");
  assert.equal(edits.length, 1, `VL.7 edits ${JSON.stringify(editOut)}`);
  assert.ok(editOut.every((frame) => frame.type === "edit" || frame.type === "lock"), JSON.stringify(editOut));
  for (const key of Object.keys(edits[0])) assert.ok(EDIT_KEYS.has(key), `VL.7 edit field ${key}`);
  assert.equal(edits[0].type, "edit");
  assert.equal(typeof edits[0].op, "string");
  assert.equal(typeof edits[0].rev, "number");
  assert.equal(typeof edits[0].path, "string");
  assert.equal(await revOf(hub), rev0 + 1);
  const seen = await view(A, hub);
  assert.equal(seen.bytes, "ne\n\ntwo\n", got("VL.7", seen));
  assert.equal(leaks(A), "", leaks(A));
});

test("VX.1 (ticket 7vdep2z4)", async (t) => {
  const body = "alpha\n";
  const keys = [
    ["Q"],
    ["K"],
    ["q"],
    ["@"],
    ["m"],
    ["'"],
    ["`"],
    ["("],
    [")"],
    ["R"],
    ["&"],
    ["e", ["Ctrl"]],
    ["o", ["Ctrl"]],
    ["q", ["Ctrl"]],
    ["k", ["Ctrl"]],
    ["Insert"],
  ];
  const { hub, A } = await setup(t);
  await hub.create(FILE, body);
  await A.open(FILE);
  const rev0 = await revOf(hub);
  for (const [name, modifiers] of keys) {
    await placeCaret(A, 0);
    await tap(A, name, modifiers || []);
    const seen = await view(A, hub);
    assert.equal(seen.show, "‸alpha\n", `VX.1 ${name} ${got("VX.1", seen)}`);
    assert.equal(seen.bytes, body);
    assert.equal(await status(A), "N", `VX.1 ${name} status ${JSON.stringify(await status(A))}`);
  }
  await placeCaret(A, 0);
  await tap(A, "v");
  const selected = await view(A, hub);
  assert.notEqual(selected.anchor, selected.focus, `VX.1 v got ${JSON.stringify(selected.show)}`);
  assert.equal(await status(A), "V");
  for (const [name, modifiers] of keys) {
    await tap(A, name, modifiers || []);
    const seen = await view(A, hub);
    assert.equal(seen.show, selected.show, `VX.1 visual ${name} ${got("VX.1", seen)}`);
    assert.equal(seen.bytes, body);
    assert.equal(await status(A), "V", `VX.1 visual ${name} status ${JSON.stringify(await status(A))}`);
  }
  assert.equal(await revOf(hub), rev0);
  assert.equal(leaks(A), "");
});

test("VX.2 (ticket 7vdep2z4)", async (t) => {
  const body = marked("‸alpha\n").doc;
  const { hub, A } = await setup(t);
  await hub.create(FILE, body);
  await A.open(FILE);
  await placeCaret(A, 0);
  const rev0 = await revOf(hub);
  await tap(A, "q");
  assert.equal((await view(A, hub)).show, "‸alpha\n");
  assert.equal(await revOf(hub), rev0);
  await tap(A, "x");
  const seen = await view(A, hub);
  assert.equal(seen.show, "‸lpha\n", got("VX.2", seen));
  assert.equal(await revOf(hub), rev0 + 1);
  assert.equal(await status(A), "N");
});

test("VX.3 (ticket 7vdep2z4)", async (t) => {
  const body = "alpha\n";
  const { hub, A } = await setup(t);
  await hub.create(FILE, body);
  await A.open(FILE);
  const rev0 = await revOf(hub);
  for (const pair of ["gv", "gi", "gq", "gw", "zf", "zo", "zc", "za"]) {
    await placeCaret(A, 0);
    await span(A, pair);
    const seen = await view(A, hub);
    assert.equal(seen.show, "‸alpha\n", `VX.3 ${pair} ${got("VX.3", seen)}`);
    assert.equal(await status(A), "N", `VX.3 ${pair} status ${JSON.stringify(await status(A))}`);
  }
  assert.equal(await revOf(hub), rev0);
});

test("VX.4 (ticket 7vdep2z4)", async (t) => {
  const body = marked("‸alpha\n").doc;
  const { hub, A } = await setup(t);
  await hub.create(FILE, body);
  await A.open(FILE);
  await placeCaret(A, 0);
  const rev0 = await revOf(hub);
  await span(A, '"a');
  const seen = await view(A, hub);
  assert.equal(seen.show, "‸alpha\n", got("VX.4", seen));
  assert.equal(await status(A), "N", `VX.4 status ${JSON.stringify(await status(A))}`);
  assert.equal(await revOf(hub), rev0);
});

test("VX.5 (ticket 7vdep2z4)", async (t) => {
  const body = "alpha 10\n";
  const { hub, A } = await setup(t);
  await hub.create(FILE, body);
  await A.open(FILE);
  await placeCaret(A, 0);
  const rev0 = await revOf(hub);
  await tap(A, "x");
  await tap(A, "u");
  assert.equal((await hub.show(FILE)).text, body, "undo did not restore");
  await tap(A, "y", ["Ctrl"]);
  let seen = await view(A, hub);
  assert.equal(seen.show, "‸lpha 10\n", `VX.5 redo ${got("VX.5", seen)}`);
  assert.equal(await status(A), "N");
  await tap(A, "u");
  assert.equal((await hub.show(FILE)).text, body);
  assert.equal(await revOf(hub), rev0 + 4);

  await placeCaret(A, body.indexOf("1"));
  await tap(A, "x", ["Ctrl"]);
  seen = await view(A, hub);
  assert.equal(seen.bytes, body, `VX.5 normal cut ${got("VX.5", seen)}`);

  await placeCaret(A, 0);
  await tap(A, "a", ["Ctrl"]);
  seen = await view(A, hub);
  assert.equal(seen.bytes, body, `VX.5 normal select-all ${got("VX.5", seen)}`);
  assert.deepEqual([seen.anchor, seen.focus].sort((a, b) => a - b), [0, body.length]);

  await placeCaret(A, 0);
  await tap(A, "v");
  assert.equal(await status(A), "V");
  await tap(A, "a", ["Ctrl"]);
  seen = await view(A, hub);
  assert.equal(seen.bytes, body, `VX.5 visual select-all ${got("VX.5", seen)}`);
  assert.deepEqual([seen.anchor, seen.focus].sort((a, b) => a - b), [0, body.length]);

  await placeCaret(A, 0);
  await tap(A, "v");
  await tap(A, "x", ["Ctrl"]);
  seen = await view(A, hub);
  assert.equal(seen.bytes, "lpha 10\n", `VX.5 visual cut ${got("VX.5", seen)}`);
  await tap(A, "u");
  assert.equal((await hub.show(FILE)).text, body, "visual cut did not undo");

  await placeCaret(A, body.indexOf("1"));
  await tap(A, "i");
  assert.equal(await status(A), "I");
  await tap(A, "x", ["Ctrl"]);
  seen = await view(A, hub);
  assert.equal(seen.bytes, body, `VX.5 insert cut ${got("VX.5", seen)}`);
  await tap(A, "a", ["Ctrl"]);
  seen = await view(A, hub);
  assert.equal(seen.bytes, body, `VX.5 insert select-all ${got("VX.5", seen)}`);
  assert.deepEqual([seen.anchor, seen.focus].sort((a, b) => a - b), [0, body.length]);

  await placeCaret(A, "alpha".length);
  await A.session.send("Browser.grantPermissions", {
    origin: `http://127.0.0.1:${hub.port}`,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });
  const written = await A.eval(`navigator.clipboard.writeText("Z").then(() => "ok", (error) => String(error))`);
  assert.equal(written, "ok", written);
  await tap(A, "v", ["Ctrl"]);
  seen = await view(A, hub);
  assert.equal(seen.bytes, "alphaZ 10\n", `VX.5 paste ${got("VX.5", seen)}`);
  assert.equal(seen.show, "alphaZ‸ 10\n", `VX.5 paste ${got("VX.5", seen)}`);
  assert.equal(await status(A), "N", `VX.5 paste status ${JSON.stringify(await status(A))}`);
  assert.equal(leaks(A), "");
});

test("VX.6 (ticket 7vdep2z4)", async (t) => {
  const body = "alpha beta\n";
  const outside = ["set", "sort", "start", "w", "q", "q!", "wq", "e", "g/a/d", "v/a/d", "norm x", "noh", "map", "reg", "delm a", "!ls"];
  const objects = ["(", "{", "<", "t", "*", "_"];
  const { hub, A } = await setup(t);
  await hub.create(FILE, body);
  await A.open(FILE);
  const rev0 = await revOf(hub);
  for (const ch of objects) {
    await placeCaret(A, 2);
    await span(A, `di${ch}`);
    const seen = await view(A, hub);
    assert.equal(seen.show, "al‸pha beta\n", `VX.6 di${ch} ${got("VX.6", seen)}`);
    assert.equal(await status(A), "N", `VX.6 di${ch} status ${JSON.stringify(await status(A))}`);
  }
  for (const command of outside) {
    await placeCaret(A, 0);
    await tap(A, ":");
    assert.equal(await A.eval(`!!document.querySelector("input.md-vim-line")`), true, `:${command} did not open`);
    await span(A, command);
    await tap(A, "Enter");
    assert.equal(await A.eval(`!document.querySelector("input.md-vim-line")`), true, `:${command} stayed open`);
    const seen = await view(A, hub);
    assert.equal(seen.bytes, body, `VX.6 :${command} ${got("VX.6", seen)}`);
    assert.equal(await status(A), "N", `VX.6 :${command} status ${JSON.stringify(await status(A))}`);
  }
  assert.equal(await revOf(hub), rev0);

  await placeCaret(A, 0);
  await tap(A, "x");
  assert.equal((await hub.show(FILE)).text, "lpha beta\n");
  const revDot = await revOf(hub);
  await tap(A, ".");
  let seen = await view(A, hub);
  assert.equal(seen.show, "‸lpha beta\n", `VX.6 dot ${got("VX.6", seen)}`);
  assert.equal(await revOf(hub), revDot);

  await placeCaret(A, 2);
  await tap(A, "i");
  assert.equal(await status(A), "I");
  await A.eval(`sessionStorage.removeItem("qaCtrlR");
    window.addEventListener("keydown", (event) => {
      if (event.key === "r" && event.ctrlKey) sessionStorage.setItem("qaCtrlR", event.defaultPrevented ? "1" : "0");
    }, false); true`);
  const revInsert = await revOf(hub);
  await press(A, "r", ["Ctrl"]);
  await sleep(400);
  let prevented = null;
  const started = Date.now();
  while (prevented == null && Date.now() - started < 5000) {
    try {
      prevented = await A.eval(`sessionStorage.getItem("qaCtrlR")`);
    } catch {
      prevented = null;
    }
    if (prevented == null) await sleep(50);
  }
  assert.equal(prevented, "0", `VX.6 Ctrl+R defaultPrevented ${JSON.stringify(prevented)}`);
  await A.until(() => A.eval(`!!document.querySelector("span.md-vim-status")`), "status after Ctrl+R", 10000);
  await A.quiet();
  seen = await view(A, hub);
  assert.equal(seen.bytes, "lpha beta\n", `VX.6 Ctrl+R ${got("VX.6", seen)}`);
  assert.equal(await revOf(hub), revInsert);
});
