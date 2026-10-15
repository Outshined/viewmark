import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "../harness.js";

// The flag is read once, when the editor is created. A later write does not turn keys on.
const VIM = "viewmark.vim";
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

function markedText(bytes, focus, anchor = focus) {
  let out = "";
  for (let i = 0; i <= bytes.length; i += 1) {
    if (anchor !== focus && i === anchor) out += "«";
    if (i === focus) out += "‸";
    if (i < bytes.length) out += bytes[i];
  }
  return out;
}

function published(page, file) {
  let text = null;
  let rev = null;
  for (let i = page.frames.length - 1; i >= 0; i -= 1) {
    const data = page.frames[i].dir === "in" && page.frames[i].data;
    if (!data || (data.path != null && data.path !== file)) continue;
    if (rev == null && typeof data.rev === "number" && (data.type === "doc" || data.type === "file" || data.type === "noop")) rev = data.rev;
    if (text == null && typeof data.text === "string" && (data.type === "doc" || data.type === "file")) text = data.text;
    if (text != null && rev != null) return { text, rev };
  }
  throw new Error(`no published text for ${file}`);
}

function sent(page, at, type) {
  return page.frames.slice(at).filter((frame) => frame.dir === "out" && frame.data && frame.data.type === type);
}

function heard(page, at, type) {
  return page.frames.slice(at).filter((frame) => frame.dir === "in" && frame.data && frame.data.type === type);
}

function mode(page) {
  return page.eval(`(document.querySelector(".md-vim-status") || {}).textContent || ""`);
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
  await page.session.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `localStorage.setItem(${JSON.stringify(VIM)}, "1");`,
  });
  await page.login();
  return { hub, page };
}

async function showRaw(page) {
  for (let i = 0; i < 3 && !(await page.eval(`document.querySelector("#editor.md-source") != null`)); i += 1) {
    const point = await page.eval(`(() => {
      const button = document.querySelector("button.md-view-toggle");
      const r = button.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await page.click(point.x, point.y);
    await page.quiet();
  }
  assert.equal(await page.eval(`document.querySelector("#editor.md-source") != null`), true);
}

async function readCaret(page, file) {
  const caret = await page.caret();
  if (!caret || caret.none || !caret.inside) {
    const pub = published(page, file);
    assert.fail(`no caret in the editor; bytes ${JSON.stringify(pub.text)}`);
  }
  return caret;
}

async function openAt(page, file, sample, { raw = false } = {}) {
  await page.open(file);
  if (raw) await showRaw(page);
  const doc = marked(sample);
  assert.ok(await page.clickOffset(doc.focus), `no point for offset ${doc.focus} of ${JSON.stringify(sample)}`);
  await page.quiet();
  const caret = await readCaret(page, file);
  const pub = published(page, file);
  assert.equal(markedText(pub.text, caret.focus, caret.anchor), sample);
  return { bytes: doc.bytes, focus: doc.focus, anchor: doc.anchor, rev: pub.rev };
}

async function press(page, keys) {
  const at = page.frames.length;
  for (const key of keys) {
    if (typeof key === "string") await page.key(key);
    else await page.key(key.key, key.modifiers);
    await page.quiet();
  }
  return at;
}

async function expectAt(page, file, sample, rev) {
  const caret = await readCaret(page, file);
  const pub = published(page, file);
  const got = markedText(pub.text, caret.focus, caret.anchor);
  assert.equal(got, sample);
  assert.equal(pub.rev, rev, got);
  return pub;
}

async function expectSame(page, file, before, label) {
  const caret = await readCaret(page, file);
  const pub = published(page, file);
  const got = markedText(pub.text, caret.focus, caret.anchor);
  const want = markedText(before.bytes, before.focus, before.anchor);
  assert.equal(got, want, label || "");
  assert.equal(pub.rev, before.rev, label ? `${label} ${got}` : got);
  return pub;
}

async function expectSplice(page, file, at, sample, beforeRev) {
  const caret = await readCaret(page, file);
  const pub = published(page, file);
  const got = markedText(pub.text, caret.focus, caret.anchor);
  assert.equal(sent(page, at, "edit").length, 1, got);
  assert.equal(got, sample);
  assert.equal(pub.rev, beforeRev + 1, got);
  return pub;
}

async function confirm(hub, file, pub) {
  const shown = await hub.show(file);
  assert.equal(shown.text, pub.text);
  assert.equal(shown.rev, pub.rev);
}

async function submitLine(page, line) {
  await page.key(":");
  await page.quiet();
  await page.until(() => page.eval(`!!document.querySelector("input.md-vim-line")`), "vim line");
  for (const ch of line) await page.key(ch);
  assert.equal(await page.eval(`document.querySelector("input.md-vim-line").value`), `:${line}`);
  await page.key("Enter");
  await page.quiet();
}

test("VR.1 (ticket 7vdep2z4)", async (t) => {
  const one = "vr1-one.md";
  const three = "vr1-three.md";
  const { hub, page } = await setup(t, { [one]: "alpha\n", [three]: "alpha\n" });
  const first = await openAt(page, one, "al‸pha\n");
  const rx = await press(page, ["r", "x"]);
  await confirm(hub, one, await expectSplice(page, one, rx, "al‸xha\n", first.rev));
  const second = await openAt(page, three, "al‸pha\n");
  const counted = await press(page, ["3", "r", "x"]);
  await confirm(hub, three, await expectSplice(page, three, counted, "alxx‸x\n", second.rev));
});

test("VR.2 (ticket 7vdep2z4)", async (t) => {
  const end = "vr2-end.md";
  const over = "vr2-over.md";
  const noteSample = `See {c1}this‸{/c1} now.${CM}`;
  const note = "vr2-note.md";
  const { hub, page } = await setup(t, {
    [end]: "alpha\nbeta\n",
    [over]: "alpha\n",
    [note]: marked(noteSample).bytes,
  });
  const atEnd = await openAt(page, end, "alpha‸\nbeta\n");
  await press(page, ["r", "x"]);
  await confirm(hub, end, await expectSame(page, end, atEnd));
  const tooFar = await openAt(page, over, "al‸pha\n");
  await press(page, ["5", "r", "x"]);
  await confirm(hub, over, await expectSame(page, over, tooFar));
  const inside = await openAt(page, note, noteSample);
  await press(page, ["r", "x"]);
  await confirm(hub, note, await expectSame(page, note, inside, "VR.2a"));
});

test("VR.3 (ticket 7vdep2z4)", async (t) => {
  const file = "vr3.md";
  const { hub, page } = await setup(t, { [file]: "alpha\n" });
  const placed = await openAt(page, file, "al‸pha\n");
  const at = await press(page, ["r", "Enter"]);
  await confirm(hub, file, await expectSplice(page, file, at, "al\n‸ha\n", placed.rev));
});

test("VR.4 (ticket 7vdep2z4)", async (t) => {
  const once = "vr4-once.md";
  const four = "vr4-four.md";
  const end = "vr4-end.md";
  const { hub, page } = await setup(t, { [once]: "alPha\n", [four]: "alPha\n", [end]: "alpha\nbeta\n" });
  const single = await openAt(page, once, "‸alPha\n");
  const tilde = await press(page, ["~"]);
  await confirm(hub, once, await expectSplice(page, once, tilde, "A‸lPha\n", single.rev));
  const counted = await openAt(page, four, "‸alPha\n");
  const many = await press(page, ["4", "~"]);
  await confirm(hub, four, await expectSplice(page, four, many, "ALpH‸a\n", counted.rev));
  const atEnd = await openAt(page, end, "alpha‸\nbeta\n");
  await press(page, ["~"]);
  await confirm(hub, end, await expectSame(page, end, atEnd));
});

test("VR.5 (ticket 7vdep2z4)", async (t) => {
  const word = "vr5-word.md";
  const back = "vr5-back.md";
  const { hub, page } = await setup(t, { [word]: "alpha beta\n", [back]: "alpha beta\n" });
  const forward = await openAt(page, word, "al‸pha beta\n");
  const upper = await press(page, ["g", "U", "w"]);
  await confirm(hub, word, await expectSplice(page, word, upper, "al‸PHA beta\n", forward.rev));
  const backward = await openAt(page, back, "alpha be‸ta\n");
  const behind = await press(page, ["g", "U", "b"]);
  await confirm(hub, back, await expectSplice(page, back, behind, "alpha ‸BEta\n", backward.rev));
});

test("VR.6 (ticket 7vdep2z4)", async (t) => {
  const upper = "vr6-upper.md";
  const lower = "vr6-lower.md";
  const toggle = "vr6-toggle.md";
  const { hub, page } = await setup(t, { [upper]: "alpha\n", [lower]: "ALPHA\n", [toggle]: "alPHA\n" });
  const up = await openAt(page, upper, "al‸pha\n");
  const gUU = await press(page, ["g", "U", "U"]);
  await confirm(hub, upper, await expectSplice(page, upper, gUU, "‸ALPHA\n", up.rev));
  const down = await openAt(page, lower, "AL‸PHA\n");
  const guu = await press(page, ["g", "u", "u"]);
  await confirm(hub, lower, await expectSplice(page, lower, guu, "‸alpha\n", down.rev));
  const mixed = await openAt(page, toggle, "al‸PHA\n");
  const gtt = await press(page, ["g", "~", "~"]);
  await confirm(hub, toggle, await expectSplice(page, toggle, gtt, "‸ALpha\n", mixed.rev));
});

test("VR.7 (ticket 7vdep2z4)", async (t) => {
  const file = "vr7.md";
  const { hub, page } = await setup(t, { [file]: "straße\n" });
  const placed = await openAt(page, file, "‸straße\n");
  const at = await press(page, ["g", "U", "U"]);
  await confirm(hub, file, await expectSplice(page, file, at, "‸STRAßE\n", placed.rev));
});

test("VU.1 (ticket 7vdep2z4)", async (t) => {
  const file = "vu1.md";
  const { hub, page } = await setup(t, { [file]: "alpha beta\n" });
  const placed = await openAt(page, file, "al‸pha beta\n");
  const cutAt = await press(page, ["d", "w"]);
  const cut = published(page, file);
  assert.equal(cut.rev, placed.rev + 1, cut.text);
  assert.notEqual(cut.text, placed.bytes, cut.text);
  assert.equal(sent(page, cutAt, "edit").length, 1, cut.text);
  const undoAt = await press(page, ["u"]);
  assert.equal(sent(page, undoAt, "undo").length, 1);
  const restored = published(page, file);
  assert.equal(restored.text, "alpha beta\n");
  assert.equal(restored.rev, cut.rev + 1, restored.text);
  assert.equal(await mode(page), "N", restored.text);
  const redoAt = await press(page, [{ key: "r", modifiers: ["Ctrl"] }]);
  assert.equal(sent(page, redoAt, "redo").length, 1);
  const again = await expectAt(page, file, "al‸beta\n", restored.rev + 1);
  assert.equal(await mode(page), "N", again.text);
  await confirm(hub, file, again);
});

test("VU.2 (ticket 7vdep2z4)", async (t) => {
  const file = "vu2.md";
  const { hub, page } = await setup(t, { [file]: "alpha beta\n" });
  const placed = await openAt(page, file, "al‸pha beta\n");
  const cutAt = await press(page, ["d", "w"]);
  const cut = published(page, file);
  assert.equal(cut.rev, placed.rev + 1, cut.text);
  assert.notEqual(cut.text, placed.bytes, cut.text);
  const undoAt = await press(page, ["u"]);
  assert.equal(sent(page, undoAt, "undo").length, 1, cut.text);
  const restored = await expectAt(page, file, "al‸pha beta\n", cut.rev + 1);
  const caret = await readCaret(page, file);
  assert.equal(caret.anchor, caret.focus, restored.text);
  await confirm(hub, file, restored);
});

test("VU.3 (ticket 7vdep2z4)", async (t) => {
  const words = "vu3-words.md";
  const raw = "vu3-raw.md";
  const sub = "vu3-sub.md";
  const { hub, page } = await setup(t, {
    [words]: "a b c d\n",
    [raw]: "alpha\nbeta\n",
    [sub]: "banana\nalpha\n",
  });

  const wordStart = await openAt(page, words, "‸a b c d\n");
  const wordAt = await press(page, ["3", "d", "w"]);
  const wordCut = published(page, words);
  assert.equal(sent(page, wordAt, "edit").length, 1, wordCut.text);
  assert.equal(wordCut.rev, wordStart.rev + 1, wordCut.text);
  assert.notEqual(wordCut.text, wordStart.bytes, wordCut.text);
  const wordUndo = await press(page, ["u"]);
  const wordBack = published(page, words);
  assert.equal(sent(page, wordUndo, "undo").length, 1, wordBack.text);
  assert.equal(wordBack.text, "a b c d\n");
  assert.equal(wordBack.rev, wordCut.rev + 1, wordBack.text);
  await confirm(hub, words, wordBack);

  const rawStart = await openAt(page, raw, "al‸pha\nbeta\n", { raw: true });
  const openAtLine = await press(page, ["3", "o"]);
  const opened = published(page, raw);
  assert.equal(sent(page, openAtLine, "edit").length, 1, opened.text);
  assert.equal(opened.rev, rawStart.rev + 1, opened.text);
  assert.notEqual(opened.text, rawStart.bytes, opened.text);
  await press(page, ["Escape"]);
  const escaped = published(page, raw);
  assert.equal(escaped.text, opened.text, escaped.text);
  assert.equal(escaped.rev, opened.rev, escaped.text);
  assert.equal(await mode(page), "N", escaped.text);
  const rawUndo = await press(page, ["u"]);
  const rawBack = published(page, raw);
  assert.equal(sent(page, rawUndo, "undo").length, 1, rawBack.text);
  assert.equal(rawBack.text, "alpha\nbeta\n");
  assert.equal(rawBack.rev, escaped.rev + 1, rawBack.text);
  await confirm(hub, raw, rawBack);

  const subStart = await openAt(page, sub, "‸banana\nalpha\n");
  const subAt = page.frames.length;
  await submitLine(page, "%s/a/o/g");
  const replaced = published(page, sub);
  assert.equal(sent(page, subAt, "edit").length, 1, replaced.text);
  assert.equal(replaced.rev, subStart.rev + 1, replaced.text);
  assert.notEqual(replaced.text, subStart.bytes, replaced.text);
  const subUndo = await press(page, ["u"]);
  const subBack = published(page, sub);
  assert.equal(sent(page, subUndo, "undo").length, 1, subBack.text);
  assert.equal(subBack.text, "banana\nalpha\n");
  assert.equal(subBack.rev, replaced.rev + 1, subBack.text);
  await confirm(hub, sub, subBack);
});

test("VU.4 (ticket 7vdep2z4)", async (t) => {
  const file = "vu4.md";
  const { hub, page } = await setup(t, { [file]: "alpha beta\n" });
  const placed = await openAt(page, file, "al‸pha beta\n");
  await press(page, ["c", "w"]);
  assert.equal(await mode(page), "I", published(page, file).text);
  await press(page, ["x", "y"]);
  await press(page, ["Escape"]);
  const typed = published(page, file);
  assert.equal(await mode(page), "N", typed.text);
  assert.notEqual(typed.text, placed.bytes, typed.text);
  assert.equal(typed.text.includes("xy"), true, typed.text);
  const undoAt = await press(page, ["u"]);
  assert.equal(sent(page, undoAt, "undo").length, 1, typed.text);
  const restored = await expectAt(page, file, "al‸pha beta\n", typed.rev + 1);
  // No edit precedes cw, so the second u is that empty earlier change.
  const againAt = await press(page, ["u"]);
  assert.equal(sent(page, againAt, "undo").length, 1);
  assert.equal(heard(page, againAt, "noop").length, 1, published(page, file).text);
  const stayed = await expectSame(page, file, { bytes: restored.text, focus: marked("al‸pha beta\n").focus, anchor: marked("al‸pha beta\n").focus, rev: restored.rev });
  await confirm(hub, file, stayed);
});

test("VU.5 (ticket 7vdep2z4)", async (t) => {
  const file = "vu5.md";
  const { hub, page } = await setup(t, { [file]: "alpha\n" });
  const placed = await openAt(page, file, "‸alpha\n");
  const at = await press(page, ["u"]);
  assert.equal(sent(page, at, "undo").length, 1);
  assert.equal(heard(page, at, "noop").length, 1, published(page, file).text);
  await confirm(hub, file, await expectSame(page, file, placed));
});

test("VU.6 (ticket 7vdep2z4)", async (t) => {
  const file = "vu6.md";
  const { hub, page } = await setup(t, { [file]: "alpha beta\n" });
  const placed = await openAt(page, file, "‸alpha beta\n");
  const cutAt = await press(page, ["x"]);
  const cut = await expectAt(page, file, "‸lpha beta\n", placed.rev + 1);
  assert.equal(sent(page, cutAt, "edit").length, 1, cut.text);
  const dotAt = await press(page, ["."]);
  const stayed = await expectAt(page, file, "‸lpha beta\n", cut.rev);
  assert.equal(cut.rev - placed.rev, 1, stayed.text);
  assert.equal(stayed.rev - cut.rev, 0, stayed.text);
  assert.equal(sent(page, dotAt, "edit").length, 0, stayed.text);
  await confirm(hub, file, stayed);
});
