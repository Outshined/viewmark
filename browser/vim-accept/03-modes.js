import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "../harness.js";

// The flag is read once, when the editor is created. A later write does not turn keys on.
const FILE = "a.md";
const VIM = "viewmark.vim";
const TICKET = "7vdep2z4";
const LIMIT = 180_000;

function marked(text) {
  let bytes = "";
  let focus = null;
  let anchor = null;
  for (const ch of text) {
    if (ch === "‸") {
      if (focus != null) throw new Error("two carets");
      focus = bytes.length;
    } else if (ch === "«") {
      if (anchor != null) throw new Error("two anchors");
      anchor = bytes.length;
    } else {
      bytes += ch;
    }
  }
  if (focus == null) throw new Error("missing caret");
  if (anchor == null) anchor = focus;
  return { bytes, focus, anchor };
}

function withMarks(bytes, focus, anchor) {
  const text = typeof bytes === "string" ? bytes : "";
  if (!Number.isInteger(focus)) return `${text}[focus ${focus} anchor ${anchor}]`;
  const mark = Number.isInteger(anchor) ? anchor : focus;
  let out = "";
  for (let i = 0; i <= text.length; i += 1) {
    if (mark !== focus && i === mark) out += "«";
    if (i === focus) out += "‸";
    if (i < text.length) out += text[i];
  }
  return out;
}

function ctrl(key) {
  return { key, mod: ["Ctrl"] };
}

const ESC = { key: "Escape" };

async function setup(t, body, extra = {}) {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  await hub.create(FILE, body);
  for (const [name, text] of Object.entries(extra)) await hub.create(name, text);
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.session.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `localStorage.setItem(${JSON.stringify(VIM)}, "1");`,
  });
  await page.login();
  await page.open(FILE);
  assert.equal(await page.eval(`localStorage.getItem(${JSON.stringify(VIM)})`), "1");
  return { hub, page };
}

async function place(page, focus) {
  assert.equal(await page.clickOffset(focus), true, `no point at ${focus}`);
  await page.quiet();
  const caret = await page.caret();
  assert.equal(caret.focus, focus);
  assert.equal(caret.anchor, focus);
  assert.equal(await page.eval(`document.querySelector(".md-vim-status").textContent`), "N");
}

async function press(page, steps) {
  for (const step of steps) {
    if (typeof step === "string") {
      for (const ch of step) await page.key(ch);
    } else {
      await page.key(step.key, step.mod || []);
    }
  }
}

function sent(page, since, type) {
  const frames = page.frames.slice(since).filter((frame) => frame.dir === "out" && frame.data);
  if (type === "history") return frames.filter((frame) => frame.data.type === "undo" || frame.data.type === "redo").map((frame) => frame.data.type);
  return frames.filter((frame) => frame.data.type === type);
}

async function finish(page, hub, file = FILE) {
  await page.quiet();
  const shown = await hub.show(file);
  const caret = await page.caret();
  const focus = caret ? caret.focus : null;
  const anchor = caret ? caret.anchor : null;
  const status = await page.eval(`document.querySelector(".md-vim-status").textContent`);
  return { text: shown.text, rev: shown.rev, focus, anchor, status, marks: withMarks(shown.text, focus, anchor) };
}

function expectState(got, marks, status, rev) {
  assert.equal(got.marks, marks);
  assert.equal(got.status, status, got.marks);
  assert.equal(got.rev, rev, got.marks);
}

function expectEdits(page, since, count, got) {
  assert.equal(sent(page, since, "edit").length, count, got.marks);
}

async function begin(t, source, extra) {
  const { bytes, focus } = marked(source);
  const { hub, page } = await setup(t, bytes, extra);
  await place(page, focus);
  return { hub, page, bytes, focus };
}

test("VM.1 (ticket 7vdep2z4)", { timeout: LIMIT }, async (t) => {
  const { hub, page } = await begin(t, "‸alpha\n");
  const before = await hub.show(FILE);
  const since = page.frames.length;
  await press(page, ["i", "x"]);
  const got = await finish(page, hub);
  expectState(got, "x‸alpha\n", "I", before.rev + 1);
  expectEdits(page, since, 1, got);
});

test("VM.2 (ticket 7vdep2z4)", { timeout: LIMIT }, async (t) => {
  const { hub, page } = await begin(t, "alpha‸\n");
  const before = await hub.show(FILE);
  const since = page.frames.length;
  await press(page, ["i", "x"]);
  let got = await finish(page, hub);
  expectState(got, "alphax‸\n", "I", before.rev + 1);
  await press(page, [ESC]);
  got = await finish(page, hub);
  expectState(got, "alphax‸\n", "N", before.rev + 1);
  expectEdits(page, since, 1, got);
});

test("VM.3 (ticket 7vdep2z4)", { timeout: LIMIT }, async (t) => {
  const source = "alpha‸\n";
  const { bytes, focus } = marked(source);
  const { hub, page } = await setup(t, bytes, { "b.md": bytes });

  async function escapeWith(file, key) {
    await page.open(file);
    await place(page, focus);
    const before = await hub.show(file);
    const since = page.frames.length;
    await press(page, ["i", "x", key]);
    const got = await finish(page, hub, file);
    expectState(got, "alphax‸\n", "N", before.rev + 1);
    expectEdits(page, since, 1, got);
  }

  await escapeWith(FILE, ctrl("["));
  await escapeWith("b.md", ctrl("Escape"));
});

test("VM.4 (ticket 7vdep2z4)", { timeout: LIMIT }, async (t) => {
  const { hub, page, bytes, focus } = await begin(t, "‸alpha beta\n");
  const before = await hub.show(FILE);
  const since = page.frames.length;

  await press(page, ["V"]);
  let got = await finish(page, hub);
  assert.equal(got.status, "VL", got.marks);
  assert.equal(got.text, bytes, got.marks);
  assert.equal(got.rev, before.rev, got.marks);
  assert.notEqual(got.anchor, got.focus, got.marks);
  const lineFocus = got.focus;

  await press(page, [ESC]);
  got = await finish(page, hub);
  assert.equal(got.status, "N", got.marks);
  assert.equal(got.text, bytes, got.marks);
  assert.equal(got.rev, before.rev, got.marks);
  assert.equal(got.focus, lineFocus, got.marks);
  assert.equal(got.anchor, lineFocus, got.marks);

  await place(page, focus);
  await press(page, ["v"]);
  got = await finish(page, hub);
  assert.equal(got.status, "V", got.marks);
  assert.equal(got.text, bytes, got.marks);
  await press(page, ["e"]);
  got = await finish(page, hub);
  expectState(got, "«alpha‸ beta\n", "V", before.rev);
  await press(page, [ESC]);
  got = await finish(page, hub);
  expectState(got, "alpha‸ beta\n", "N", before.rev);
  expectEdits(page, since, 0, got);
});

test("VM.5 (ticket 7vdep2z4)", { timeout: LIMIT }, async (t) => {
  const { hub, page } = await begin(t, "‸alpha beta\n");
  const before = await hub.show(FILE);
  const since = page.frames.length;
  await press(page, ["d"]);
  let got = await finish(page, hub);
  expectState(got, "‸alpha beta\n", "d", before.rev);
  await press(page, [ESC]);
  got = await finish(page, hub);
  expectState(got, "‸alpha beta\n", "N", before.rev);
  await press(page, ["w"]);
  got = await finish(page, hub);
  expectState(got, "alpha ‸beta\n", "N", before.rev);
  expectEdits(page, since, 0, got);
});

test("VM.6 (ticket 7vdep2z4)", { timeout: LIMIT }, async (t) => {
  const { hub, page } = await begin(t, "al‸pha beta\n");
  const before = await hub.show(FILE);
  const since = page.frames.length;
  await press(page, ["i", ctrl("o"), "dw"]);
  const got = await finish(page, hub);
  expectState(got, "al‸beta\n", "I", before.rev + 1);
  expectEdits(page, since, 1, got);
});

test("VM.7 (ticket 7vdep2z4)", { timeout: LIMIT }, async (t) => {
  const { hub, page } = await begin(t, "alpha\nbe‸ta\ngamma\n");
  const before = await hub.show(FILE);
  const since = page.frames.length;
  await press(page, ["i", ctrl("o"), "dd"]);
  const got = await finish(page, hub);
  expectState(got, "alpha\n‸gamma\n", "I", before.rev + 1);
  expectEdits(page, since, 1, got);
});

test("VM.8 (ticket 7vdep2z4)", { timeout: LIMIT }, async (t) => {
  const { hub, page } = await begin(t, "ALPHA\nBE‸TA\n");
  const before = await hub.show(FILE);
  const since = page.frames.length;
  await press(page, ["i", ctrl("o"), "gu", "u"]);
  const got = await finish(page, hub);
  expectState(got, "ALPHA\n‸beta\n", "I", before.rev + 1);
  expectEdits(page, since, 1, got);
  assert.deepEqual(sent(page, since, "history"), [], `${got.marks} undo frame`);
});

test("VM.9 (ticket 7vdep2z4)", { timeout: LIMIT }, async (t) => {
  const { hub, page } = await begin(t, "al‸pha\n");
  const before = await hub.show(FILE);
  const since = page.frames.length;
  await press(page, ["i", ctrl("o"), "g", ESC]);
  let got = await finish(page, hub);
  expectState(got, "al‸pha\n", "I", before.rev);
  expectEdits(page, since, 0, got);
  await press(page, ["x"]);
  got = await finish(page, hub);
  expectState(got, "alx‸pha\n", "I", before.rev + 1);
  expectEdits(page, since, 1, got);
});

test("VM.10 (ticket 7vdep2z4)", { timeout: LIMIT }, async (t) => {
  const { hub, page } = await begin(t, "al‸pha\nbeta\n");
  const before = await hub.show(FILE);
  const since = page.frames.length;
  await press(page, ["i", ctrl("o"), "j", "x"]);
  const got = await finish(page, hub);
  expectState(got, "alpha\nbex‸ta\n", "I", before.rev + 1);
  expectEdits(page, since, 1, got);
});

test("VM.11 (ticket 7vdep2z4)", { timeout: LIMIT }, async (t) => {
  const { hub, page } = await begin(t, "al‸pha\n");
  const before = await hub.show(FILE);
  const since = page.frames.length;
  await press(page, ["i", ctrl("o"), "Q"]);
  let got = await finish(page, hub);
  expectState(got, "al‸pha\n", "I", before.rev);
  expectEdits(page, since, 0, got);
  await press(page, ["x"]);
  got = await finish(page, hub);
  expectState(got, "alx‸pha\n", "I", before.rev + 1);
  expectEdits(page, since, 1, got);
});

test("VM.12 (ticket 7vdep2z4)", { timeout: LIMIT }, async (t) => {
  const source = "‸alpha beta\n";
  const { bytes, focus } = marked(source);
  const { hub, page } = await setup(t, bytes, { "b.md": bytes });
  await place(page, focus);
  const before = await hub.show(FILE);
  const since = page.frames.length;
  await press(page, ["i", ctrl("o"), "v", "e", "d"]);
  let got = await finish(page, hub);
  expectState(got, "‸ beta\n", "I", before.rev + 1);
  assert.notEqual(got.status, "N", got.marks);
  expectEdits(page, since, 1, got);

  await page.open("b.md");
  await place(page, focus);
  const other = await hub.show("b.md");
  const from = page.frames.length;
  await press(page, ["i", ctrl("o"), "v"]);
  got = await finish(page, hub, "b.md");
  assert.equal(got.status, "V", got.marks);
  assert.equal(got.text, bytes, got.marks);
  assert.equal(got.rev, other.rev, got.marks);
  const at = got.focus;
  await press(page, [ESC]);
  got = await finish(page, hub, "b.md");
  assert.equal(got.marks, withMarks(bytes, at, at), got.marks);
  assert.equal(got.status, "I", got.marks);
  assert.equal(got.rev, other.rev, got.marks);
  expectEdits(page, from, 0, got);
});

test("VM.13 (ticket 7vdep2z4)", { timeout: LIMIT }, async (t) => {
  const { hub, page } = await begin(t, "al‸pha\n");
  const before = await hub.show(FILE);
  const since = page.frames.length;
  await press(page, ["i", ctrl("o"), "c"]);
  let got = await finish(page, hub);
  expectState(got, "al‸pha\n", "c", before.rev);
  expectEdits(page, since, 0, got);
  await press(page, ["w"]);
  got = await finish(page, hub);
  expectState(got, "al‸\n", "I", before.rev + 1);
  expectEdits(page, since, 1, got);
});

test("VM.14 (ticket 7vdep2z4)", { timeout: LIMIT }, async (t) => {
  const { hub, page } = await begin(t, "al‸pha\n");
  const before = await hub.show(FILE);
  const since = page.frames.length;
  await press(page, ["i", ctrl("o"), "a", "x"]);
  const got = await finish(page, hub);
  expectState(got, "alpx‸ha\n", "I", before.rev + 1);
  expectEdits(page, since, 1, got);
});
