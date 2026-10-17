import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { vimKey, vimMatchStarts, vimSubmit, VIM_SEARCH_LIMIT } from "../src/vim.js";
import { codeSpanAt, createState, deleteForward, linkSpanAt, skipHidden, sourceLine } from "../src/doc.js";

const CARET = "‸";

function marked(text) {
  let doc = "";
  let cursor = null;
  let anchor = null;
  for (const ch of text) {
    if (ch === CARET) cursor = doc.length;
    else if (ch === "«") anchor = doc.length;
    else doc += ch;
  }
  if (cursor == null) throw new Error("missing caret");
  if (anchor == null) anchor = cursor;
  return { doc, cursor, anchor };
}

function show(doc, cursor, anchor = cursor) {
  let out = "";
  for (let i = 0; i <= doc.length; i += 1) {
    if (anchor !== cursor && i === anchor) out += "«";
    if (i === cursor) out += CARET;
    if (i < doc.length) out += doc[i];
  }
  return out;
}

function keyOf(item) {
  if (typeof item === "string") return { key: item, ctrl: false, meta: false, alt: false, shift: false };
  return { ctrl: false, meta: false, alt: false, shift: false, ...item };
}

function run(start, keys, opts = {}) {
  let { doc, cursor, anchor } = marked(start);
  let vim = opts.vim || {
    mode: opts.mode || "normal",
    input: { prefixRepeat: "", operator: null, motionRepeat: "", motion: null, keyBuffer: "" },
    register: { text: "", linewise: false },
    search: null,
    find: null,
    column: null,
    once: false,
  };
  const steps = [];
  for (const item of keys) {
    const result = vimKey({
      key: keyOf(item),
      vim,
      doc,
      anchor,
      cursor,
      raw: opts.raw === true,
      layout: opts.layout === true ? true : null,
      flag: opts.flag,
    });
    steps.push(result);
    vim = result.vim;
    const effect = result.effect;
    if (!effect) continue;
    if (effect.type === "caret") {
      anchor = effect.anchor;
      cursor = effect.cursor;
    } else if (effect.type === "splice") {
      doc = doc.slice(0, effect.from) + effect.text + doc.slice(effect.to);
      cursor = effect.caret;
      anchor = cursor;
    } else if (effect.type === "scroll" && Number.isInteger(effect.cursor)) {
      cursor = effect.cursor;
      anchor = Number.isInteger(effect.anchor) ? effect.anchor : effect.cursor;
    } else if (effect.type === "forward-delete") {
      const next = deleteForward(createState(doc, cursor, anchor));
      doc = next.doc;
      cursor = next.cursor;
      anchor = next.anchor;
    }
  }
  return { doc, cursor, anchor, vim, steps, show: show(doc, cursor, anchor) };
}

function last(out) {
  return out.steps[out.steps.length - 1];
}

function oneSplice(out) {
  const splices = out.steps.filter((step) => step.effect && step.effect.type === "splice");
  assert.equal(splices.length, 1);
  assert.equal(splices[0].match, "full");
  assert.equal(splices[0].consumed, true);
  assert.equal(Object.hasOwn(splices[0].effect, "group"), false);
  return splices[0].effect;
}

function assertView(out, command, repeat) {
  const effect = last(out).effect;
  assert.equal(last(out).match, "full");
  assert.equal(last(out).consumed, true);
  assert.equal(effect.type, "view-motion");
  assert.equal(effect.command, command);
  assert.equal(effect.repeat, repeat);
  assert.equal(Object.hasOwn(effect, "cursor"), false);
  assert.equal(Object.hasOwn(effect, "anchor"), false);
  assert.equal(Object.hasOwn(effect, "offset"), false);
}

test("sourceLine", () => {
  assert.deepEqual(sourceLine("alpha\nbeta\n", 7), { start: 6, end: 10, text: "beta", newline: true });
  assert.deepEqual(sourceLine("alpha", 2), { start: 0, end: 5, text: "alpha", newline: false });
});

test("codeSpanAt", () => {
  const line = "a `code` b";
  assert.deepEqual(codeSpanAt(line, 4), { open: 2, close: 7, start: 3, end: 7 });
  assert.deepEqual(codeSpanAt(line, 2), { open: 2, close: 7, start: 3, end: 7 });
  assert.deepEqual(codeSpanAt(line, 7), { open: 2, close: 7, start: 3, end: 7 });
  assert.equal(codeSpanAt(line, 8), null);
  assert.equal(codeSpanAt("plain", 1), null);
  assert.equal(codeSpanAt("``", 0), null);
  assert.equal(codeSpanAt("`a` `b`", 5).open, 4);
});

test("linkSpanAt", () => {
  const line = "see [text](https://x.test/p) now";
  const found = linkSpanAt(line, 6);
  assert.deepEqual(found, { start: 4, end: 28, labelStart: 5, labelEnd: 9 });
  assert.equal(linkSpanAt(line, 0), null);
  assert.equal(linkSpanAt(line, 28), null);
  assert.equal(linkSpanAt("see [text] now", 6), null);
  const image = "go ![alt](sample.svg) on";
  const picture = linkSpanAt(image, 5);
  assert.equal(picture.start, 3);
  assert.equal(picture.labelStart, 5);
  assert.equal(image.slice(picture.labelStart, picture.labelEnd), "alt");
});

test("skipHidden gap", () => {
  assert.equal(skipHidden("one\n\ntwo\n", 4, "forward"), 5);
  assert.equal(skipHidden("one\n\ntwo\n", 4, "backward"), 3);
  assert.equal(skipHidden("one\n\ntwo\n", 4, "nearer"), 3);
  assert.equal(skipHidden("one\n\ntwo\n", 4, "forward", { gap: false }), 4);
  assert.equal(skipHidden("one\n\ntwo\n", 4, "backward", { gap: false }), 4);
  const comment = "See {c1}this{/c1} now.";
  assert.equal(skipHidden(comment, 5, "forward"), 8);
  assert.equal(skipHidden(comment, 5, "forward", { gap: false }), 8);
  assert.equal(skipHidden(comment, 16, "backward", { gap: false }), 12);
  assert.equal(skipHidden("red  \nblue\n", 4, "forward", { gap: false }), 6);
  assert.equal(skipHidden("red  \nblue\n", 5, "backward", { gap: false }), 3);
  assert.equal(skipHidden("alpha\r\nbeta\r\n", 6, "forward", { gap: false }), 7);
  assert.equal(skipHidden("alpha\r\nbeta\r\n", 6, "backward", { gap: false }), 5);
});

test("vimKey is pure", () => {
  const src = readFileSync(new URL("../src/vim.js", import.meta.url), "utf8");
  assert.match(src, /from "\.\/doc\.js"/);
  assert.doesNotMatch(src, /editor\.js|codemirror|CodeMirror/);
  assert.doesNotMatch(src, /\bdocument\b|\bwindow\b/);
  const editor = readFileSync(new URL("../src/editor.js", import.meta.url), "utf8");
  assert.equal(editor.includes("vimKey"), true);
  const vim = {
    mode: "normal",
    input: { prefixRepeat: "2", operator: "d", motionRepeat: "", motion: null, keyBuffer: "" },
  };
  const snapshot = structuredClone(vim);
  const doc = "alpha\n";
  vimKey({ key: { key: "w" }, vim, doc, cursor: 0, anchor: 0 });
  assert.deepEqual(vim, snapshot);
});

test("flag off", () => {
  const vim = {
    mode: "normal",
    input: { prefixRepeat: "", operator: "d", motionRepeat: "", motion: null, keyBuffer: "g" },
  };
  const out = vimKey({
    flag: false,
    key: { key: "j" },
    vim,
    doc: "al pha\n\nbeta\n",
    cursor: 2,
    anchor: 2,
    raw: false,
    layout: true,
  });
  assert.equal(out.match, "none");
  assert.equal(out.consumed, false);
  assert.equal(out.effect, null);
  assert.equal(out.vim.input.operator, "d");
  assert.equal(out.vim.input.keyBuffer, "g");
  const letter = run("‸alpha\n", ["x"], { flag: false });
  assert.equal(letter.steps[0].consumed, false);
  assert.equal(letter.steps[0].effect, null);
  assert.equal(letter.doc, "alpha\n");
});

test("VK.1", () => {
  const out = run("al‸pha beta\n", ["d", "w"]);
  assert.equal(out.steps[0].match, "full");
  assert.equal(out.steps[0].effect, null);
  assert.equal(out.steps[0].vim.input.operator, "d");
  assert.equal(out.steps.filter((step) => step.effect && step.effect.type === "splice").length, 1);
  assert.equal(out.show, "al‸beta\n");
});

test("VK.2", () => {
  const out = run("‸alpha\n", ["g"]);
  assert.equal(out.steps[0].match, "partial");
  assert.equal(out.steps[0].consumed, true);
  assert.equal(out.steps[0].effect, null);
  assert.equal(out.vim.input.keyBuffer, "g");
  assert.equal(out.show, "‸alpha\n");
  assert.equal(out.doc, "alpha\n");
});

test("VK.3", () => {
  const out = run("‸alpha beta\n", ["d", "Q", "w"]);
  assert.equal(out.steps[1].match, "none");
  assert.equal(out.steps[1].consumed, true);
  assert.equal(out.steps[1].effect, null);
  assert.equal(out.vim.input.operator, null);
  assert.equal(out.vim.input.keyBuffer, "");
  assert.equal(out.doc, "alpha beta\n");
  assert.equal(out.show, "alpha ‸beta\n");
});

test("modifier key keeps a pending operator", () => {
  const held = {
    mode: "insert",
    input: { prefixRepeat: "2", operator: "d", motionRepeat: "4", motion: null, keyBuffer: "g" },
    register: { text: "kept", linewise: true },
    search: { pattern: "a", forward: false, whole: true },
    find: { ch: "x", forward: false, till: true },
    column: 4,
    once: true,
  };
  for (const name of ["Shift", "Control", "Alt", "Meta"]) {
    for (const ctrl of [false, true]) {
      const key = { key: name, ctrl, meta: name === "Meta", alt: name === "Alt", shift: name === "Shift" };
      const out = vimKey({ key, vim: held, doc: "alpha beta\n", cursor: 2, anchor: 2 });
      assert.equal(out.match, "none", name);
      assert.equal(out.consumed, false, name);
      assert.equal(out.effect, null, name);
      assert.deepEqual(out.vim, held, name);
    }
    const cut = run("al‸pha beta\n", ["d", { key: name, ctrl: name === "Control" }, { key: "ArrowRight", ctrl: true }]);
    const step = cut.steps[1];
    assert.equal(step.match, "none", name);
    assert.equal(step.consumed, false, name);
    assert.equal(step.effect, null, name);
    assert.equal(step.vim.input.prefixRepeat, "", name);
    assert.equal(step.vim.input.operator, "d", name);
    assert.equal(step.vim.input.motionRepeat, "", name);
    assert.equal(step.vim.input.keyBuffer, "", name);
    assert.equal(cut.show, "al‸beta\n", name);
    const effect = oneSplice(cut);
    assert.equal(effect.caret, 2, name);
    assert.equal(effect.text, "", name);
  }
  const prefix = run("‸a b c d e\n", ["2", "d", { key: "Shift" }, "w"]);
  assert.equal(prefix.steps[2].vim.input.prefixRepeat, "2");
  assert.equal(prefix.steps[2].vim.input.operator, "d");
  assert.equal(prefix.steps[2].consumed, false);
  assert.equal(prefix.show, "‸c d e\n");
  const motion = run("‸a b c d e\n", ["d", "3", { key: "Alt", ctrl: true }, "w"]);
  assert.equal(motion.steps[2].vim.input.operator, "d");
  assert.equal(motion.steps[2].vim.input.keyBuffer, "3");
  assert.equal(motion.steps[2].vim.input.motionRepeat, "");
  assert.equal(motion.show, "‸d e\n");
  const buffer = run("al‸pha\nbeta\n", ["g", { key: "Meta" }]);
  assert.equal(buffer.steps[1].match, "none");
  assert.equal(buffer.steps[1].consumed, false);
  assert.equal(buffer.steps[1].effect, null);
  assert.equal(buffer.vim.input.keyBuffer, "g");
  const other = run("al‸pha beta\n", ["d", "Q", { key: "ArrowRight", ctrl: true }]);
  assert.equal(other.steps[1].match, "none");
  assert.equal(other.steps[1].consumed, true);
  assert.equal(other.steps[1].effect, null);
  assert.equal(other.steps[1].vim.input.operator, null);
  assert.equal(other.steps[1].vim.input.keyBuffer, "");
  assert.equal(other.doc, "alpha beta\n");
  const lower = run("al‸pha beta\n", ["d", { key: "shift" }]);
  assert.equal(lower.steps[1].consumed, true);
  assert.equal(lower.steps[1].vim.input.operator, null);
});

test("VK.4", () => {
  for (const keys of [["3", "d", "2", "w"], ["2", "d", "3", "w"], ["6", "d", "w"]]) {
    const out = run("‸a b c d e f g h\n", keys);
    assert.equal(out.steps.filter((step) => step.effect && step.effect.type === "splice").length, 1);
    assert.equal(out.show, "‸g h\n");
  }
  for (const keys of [["3", "d", "w"], ["d", "3", "w"]]) {
    const out = run("‸a b c d e\n", keys);
    assert.equal(out.show, "‸d e\n");
  }
});

test("VK.5", () => {
  const zero = run("abc‸def\n", ["0"]);
  assert.equal(zero.show, "‸abcdef\n");
  assert.equal(zero.vim.input.prefixRepeat, "");
  assert.equal(zero.vim.input.keyBuffer, "");
  const ten = run("‸abcdefghijkl\n", ["1", "0", "l"]);
  assert.equal(ten.steps[0].match, "partial");
  assert.equal(ten.steps[1].match, "partial");
  assert.equal(ten.steps[1].vim.input.keyBuffer, "10");
  assertView(ten, "l", 10);
  assert.equal(ten.doc, "abcdefghijkl\n");
  assert.equal(ten.cursor, 0);
});

test("VK.6", () => {
  const out = run(`${CARET}${"a".repeat(12000)}`, ["1", "2", "0", "0", "0", "x"]);
  assert.equal(last(out).match, "full");
  const effect = oneSplice(out);
  assert.equal(effect.from, 0);
  assert.equal(effect.to, 10000);
  assert.equal(effect.text, "");
  assert.equal(effect.caret, 0);
  assert.equal(out.show, `${CARET}${"a".repeat(2000)}`);
});

test("VK.7", () => {
  const out = run("‸alpha beta\n", ["d", "c", "w"]);
  assert.equal(out.steps[1].match, "none");
  assert.equal(out.steps[1].effect, null);
  assert.equal(out.steps.filter((step) => step.effect && step.effect.type === "splice").length, 0);
  assert.equal(out.doc, "alpha beta\n");
  assert.equal(out.show, "alpha ‸beta\n");
});

test("VK.8", () => {
  const cut = run("al‸pha beta\n", ["d", "w"]);
  assert.equal(cut.show, "al‸beta\n");
  const out = run("al‸beta\n", ["d", "u"], { vim: { ...cut.vim, input: { prefixRepeat: "", operator: null, motionRepeat: "", motion: null, keyBuffer: "" }, register: cut.vim.register } });
  assert.equal(out.steps[1].match, "none");
  assert.equal(out.steps[1].consumed, true);
  assert.equal(out.steps[1].effect, null);
  assert.equal(out.doc, "albeta\n");
  assert.equal(out.show, "al‸beta\n");
});

test("VK.16", () => {
  const partial = run("‸alpha\nbeta\n", ['"']);
  assert.equal(partial.steps[0].match, "partial");
  assert.equal(partial.steps[0].consumed, true);
  assert.equal(partial.vim.input.keyBuffer, '"');
  assert.equal(partial.show, "‸alpha\nbeta\n");
  const accepted = run("‸alpha\nbeta\n", ['"', '"']);
  assert.equal(accepted.steps[1].match, "full");
  assert.equal(accepted.steps[1].effect, null);
  assert.equal(accepted.vim.input.keyBuffer, "");
  assert.equal(accepted.doc, "alpha\nbeta\n");
  // alpha and beta are one rendered block. The cell's duplicate is the raw source line.
  const put = run("‸alpha\nbeta\n", ['"', '"', "y", "y", "p"], { raw: true });
  assert.equal(put.show, "alpha\n‸alpha\nbeta\n");
  const inserted = put.steps.filter((step) => step.effect && step.effect.type === "splice" && step.effect.from === step.effect.to);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].effect.text, "alpha\n");
});

test("VN.1", () => {
  const right = run("al‸pha\n", ["l"]);
  assertView(right, "l", 1);
  assert.equal(right.show, "al‸pha\n");
  const left = run("al‸pha\n", ["h"]);
  assertView(left, "h", 1);
  const three = run("al‸pha\n", ["3", "l"]);
  assertView(three, "l", 3);
  assert.equal(three.doc, "alpha\n");
});

test("VN.2", () => {
  const back = run("al‸pha\n", ["Backspace"]);
  assertView(back, "h", 1);
  assert.equal(back.doc, "alpha\n");
  const space = run("al‸pha\n", [" "]);
  assertView(space, "l", 1);
  assert.equal(space.doc, "alpha\n");
  const del = run("al‸pha\n", ["Delete"]);
  assert.equal(del.steps[0].effect.type, "forward-delete");
  assert.equal(del.show, "al‸ha\n");
});

test("VN.3", () => {
  const joined = run("al‸pha\nbeta\n", ["j"]);
  assert.equal(joined.show, "al‸pha\nbeta\n");
  assert.equal(joined.vim.mode, "normal");
  const blocks = run("al‸pha\n\nbeta\n", ["j"]);
  assert.equal(blocks.show, "alpha\n\nbe‸ta\n");
  const raw = run("al‸pha\nbeta\n", ["j"], { raw: true });
  assert.equal(raw.show, "alpha\nbe‸ta\n");
});

test("VN.4", () => {
  const start = `‸${"x".repeat(40)}\n\nnext\n`;
  const down = run(start, ["ArrowDown"]);
  assert.equal(down.show, `${"x".repeat(40)}\n\n‸next\n`);
  const ctrl = run(start, [{ key: "n", ctrl: true }]);
  assert.equal(ctrl.show, down.show);
  const up = run(down.show, ["ArrowUp"]);
  assert.equal(up.cursor, 0);
  const ctrlUp = run(down.show, [{ key: "p", ctrl: true }]);
  assert.equal(ctrlUp.cursor, up.cursor);
});

test("VN.5", () => {
  // A paragraph is one vim line. The column crosses blocks, and raw source lines.
  const joined = run("alpha‸\nab\nalpha\n", ["j"]);
  assert.equal(joined.show, "alpha‸\nab\nalpha\n");
  const once = run("alpha‸\n\nab\n\nalpha\n", ["j"]);
  assert.equal(once.show, "alpha\n\nab‸\n\nalpha\n");
  assert.equal(once.vim.column, 5);
  const twice = run("alpha‸\n\nab\n\nalpha\n", ["j", "j"]);
  assert.equal(twice.show, "alpha\n\nab\n\nalpha‸\n");
  assert.equal(twice.vim.column, 5);
  const raw = run("alpha‸\nab\nalpha\n", ["j", "j"], { raw: true });
  assert.equal(raw.show, "alpha\nab\nalpha‸\n");
  const cleared = run("alpha‸\n\nab\n\nalpha\n", ["j", "h"]);
  assert.equal(cleared.steps[1].effect.command, "h");
  assert.equal(cleared.vim.column, null);
  const placed = vimKey({
    key: { key: "j" },
    vim: cleared.vim,
    doc: cleared.doc,
    cursor: cleared.cursor - 1,
    anchor: cleared.cursor - 1,
    raw: false,
    layout: null,
  });
  assert.equal(show(cleared.doc, placed.effect.cursor), "alpha\n\nab\n\na‸lpha\n");
});

test("VN.6", () => {
  const moved = run("al‸pha\n\nbeta\n", ["g", "j"]);
  assert.equal(moved.show, "alpha\n\nbe‸ta\n");
  const view = run("al‸pha\n\nbeta\n", ["g", "j"], { layout: true });
  assertView(view, "gj", 1);
  assert.equal(view.show, "al‸pha\n\nbeta\n");
  const down = run("al‸pha\n\nbeta\n", ["g", "ArrowDown"], { layout: true });
  assertView(down, "gj", 1);
  const up = run("alpha\n\nbe‸ta\n", ["g", "ArrowUp"], { layout: true });
  assertView(up, "gk", 1);
  assert.equal(Object.hasOwn(up.steps[1].effect, "cursor"), false);
});

test("VN.7", () => {
  assert.equal(run("‸alpha, beta\n", ["w"]).show, "alpha, ‸beta\n");
  assert.equal(run("‸alpha, beta\n", ["e"]).show, "alpha‸, beta\n");
  assert.equal(run("alpha, be‸ta\n", ["b"]).show, "alpha, ‸beta\n");
  assert.equal(run("alpha, be‸ta\n", ["g", "e"]).show, "alpha‸, beta\n");
  assert.equal(run("‸alpha\n", ["e"]).show, "alph‸a\n");
});

test("VN.8", () => {
  assert.equal(run("‸alpha,beta gamma\n", ["W"]).show, "alpha,beta ‸gamma\n");
  assert.equal(run("‸alpha,beta gamma\n", ["w"]).show, "alpha,beta ‸gamma\n");
  assert.equal(run("alpha,beta gam‸ma\n", ["E"]).show, run("alpha,beta gam‸ma\n", ["e"]).show);
  assert.equal(run("alpha,beta gam‸ma\n", ["g", "E"]).show, run("alpha,beta gam‸ma\n", ["g", "e"]).show);
});

test("VN.9", () => {
  assert.equal(run("al‸pha\nbeta\n", ["w"]).show, "alpha\n‸beta\n");
  assert.equal(run("alpha be‸ta\n\ngamma\n", ["w"]).show, "alpha beta\n\n‸gamma\n");
  assert.equal(run("alpha be‸ta\n", ["w"]).show, "alpha beta‸\n");
});

test("VN.10", () => {
  const back = run("alpha be‸ta\n", [{ key: "Backspace", ctrl: true }]);
  assert.equal(back.show, "alpha ‸beta\n");
  assert.equal(back.doc, "alpha beta\n");
  assert.equal(run("alpha be‸ta\n", [{ key: " ", ctrl: true }]).show, run("alpha be‸ta\n", ["W"]).show);
  assert.equal(run("‸alpha beta\n", [{ key: " ", shift: true }]).show, "alpha ‸beta\n");
  assert.equal(run("alpha be‸ta\n", [{ key: "Backspace", shift: true }]).show, "alpha ‸beta\n");
});

test("VN.11", () => {
  assert.equal(run("  al‸pha\n", ["0"]).show, "‸  alpha\n");
  assert.equal(run("  al‸pha\n", ["^"]).show, "  ‸alpha\n");
  assert.equal(run("- al‸pha\n", ["^"]).show, "‸- alpha\n");
  assert.equal(run("# Ti‸tle\n", ["^"]).show, "‸# Title\n");
});

test("VN.12", () => {
  const spaced = run("‸alpha \n", ["$"]);
  assert.equal(spaced.show, "alpha ‸\n");
  const broken = run("r‸ed  \nblue\n", ["$"]);
  assert.equal(broken.show, "red‸  \nblue\n");
  const line = sourceLine(broken.doc, 1);
  assert.equal(broken.cursor, 3);
  assert.ok(broken.cursor < line.end);
});

test("VN.13", () => {
  assert.equal(run("- al‸pha\n", ["Home"]).show, "‸- alpha\n");
  const long = `${CARET}${"x".repeat(80)}`;
  const end = run(long, ["End"]);
  assert.equal(end.cursor, 80);
  assert.equal(end.show, `${"x".repeat(80)}${CARET}`);
  const visual = run("- al‸pha\n", ["Home"], { mode: "visual" });
  assert.equal(visual.cursor, 0);
  assert.equal(visual.vim.mode, "visual");
});

test("VN.14", () => {
  assert.equal(run("al‸pha\n\n  beta\n", ["+"]).show, "alpha\n\n  ‸beta\n");
  assert.equal(run("  al‸pha\n", ["_"]).show, "  ‸alpha\n");
  assert.equal(run("  al‸pha\n\n  beta\n", ["2", "_"]).show, "  alpha\n\n  ‸beta\n");
  assert.equal(run("  al‸pha\n  beta\n", ["2", "_"], { raw: true }).show, "  alpha\n  ‸beta\n");
});

test("VN.15", () => {
  assert.equal(run("‸alpha beta\n", ["7", "|"]).show, "alpha ‸beta\n");
  assert.equal(run("\tab‸c\n", ["5", "|"]).show, "\t‸abc\n");
  assert.equal(run("‸alpha\n", ["2", "0", "|"]).show, "alpha‸\n");
});

test("VN.16", () => {
  assert.equal(run("alpha\nbe‸ta\n", ["g", "g"]).show, "‸alpha\nbeta\n");
  assert.equal(run("alpha\nbe‸ta\n", ["G"]).show, "alpha\nbeta‸\n");
  assert.equal(run("alpha\nbe‸ta\n", ["G"]).cursor, "alpha\nbeta".length);
  assert.equal(run("alpha\nbe‸ta\n", ["G"], { raw: true }).show, "alpha\nbeta‸\n");
  assert.equal(run("alpha\nbe‸ta", ["G"]).show, "alpha\nbeta‸");
});

test("r5kwsdqr G lands on the last line, not past a final newline or a comment fence", () => {
  const list = run("P‸ara one.\n\n- item\n", ["G"]);
  assert.equal(list.show, "Para one.\n\n- item‸\n");
  assert.equal(list.cursor, "Para one.\n\n- item".length);
  const doc = [
    "Para {c1}one{/c1}.",
    "",
    "- item",
    "",
    "```comment c1",
    ":: 0",
    "@2026-10-05T16:00:00.000Z Ada",
    "A note.",
    "```",
    "",
  ].join("\n");
  const marked = `${doc.slice(0, 1)}${CARET}${doc.slice(1)}`;
  const rendered = run(marked, ["G"]);
  const item = rendered.doc.indexOf("- item");
  const fence = rendered.doc.indexOf("```comment");
  assert.ok(rendered.cursor >= item && rendered.cursor <= item + "- item".length);
  assert.ok(rendered.cursor < fence);
  assert.equal(rendered.show.includes("- item‸\n"), true);
  const raw = run(marked, ["G"], { raw: true });
  const close = raw.doc.lastIndexOf("```");
  assert.ok(raw.cursor >= close && raw.cursor < raw.doc.length);
  assert.equal(raw.show.endsWith("```‸\n"), true);
  const opened = run(marked, ["G", "o"]);
  const openedFence = opened.doc.indexOf("```comment");
  assert.equal(opened.vim.mode, "insert");
  assert.ok(opened.cursor < openedFence);
  assert.ok(opened.doc.slice(0, openedFence).includes("- item\n"));
  assert.ok(opened.doc.endsWith("```\n"));
  assert.equal(run("al‸pha\n\n\n", ["G"]).show, "alpha\n\n‸\n");
  assert.equal(run("al‸pha\n\n\n", ["G"], { raw: true }).show, "alpha\n\n‸\n");
  assert.equal(run("‸\n", ["G"]).show, "‸\n");
  assert.equal(run("‸alpha\nbeta\n", ["9", "G"], { raw: true }).show, "alpha\n‸beta\n");
});

test("VN.17", () => {
  assert.equal(run("‸one\n\ntwo\n\nthree\n", ["2", "G"]).show, "one\n\n‸two\n\nthree\n");
  assert.equal(run("‸alpha\nbeta\ngamma\n", ["2", "G"], { raw: true }).show, "alpha\n‸beta\ngamma\n");
  assert.equal(run("‸one\n\ntwo\n", ["2", "G"]).show, "one\n\n‸two\n");
  assert.equal(run("‸one\n\ntwo\n", ["2", "G"], { raw: true }).show, "one\n‸\ntwo\n");
});

test("VN.18", () => {
  const view = run(`${CARET}${"x".repeat(200)}`, ["g", "0"], { layout: true });
  assertView(view, "g0", 1);
  assert.equal(view.cursor, 0);
  const end = run(`${CARET}${"x".repeat(40)}`, ["g", "$"], { layout: true });
  assertView(end, "g$", 1);
  const plain = run("  al‸pha\n", ["g", "0"]);
  assert.equal(plain.show, "‸  alpha\n");
  assert.equal(plain.steps[1].effect.type, "caret");
  assert.equal(run("  al‸pha\n", ["g", "^"]).show, "  ‸alpha\n");
  assert.equal(run("ab‸c\n", ["g", "$"]).show, "abc‸\n");
});

test("VN.19", () => {
  assert.equal(run("‸alpha beta\n", ["f", "b"]).show, "alpha ‸beta\n");
  assert.equal(run("alpha be‸ta\n", ["F", "a"]).show, "alph‸a beta\n");
  assert.equal(run("‸alpha\nbeta\n", ["f", "b"]).show, "‸alpha\nbeta\n");
  const repeat = run("‸a-b-c\n", ["f", "-", ";"]);
  assert.equal(repeat.show, "a-b‸-c\n");
  assert.equal(run(repeat.show, [","], { vim: repeat.vim }).show, "a‸-b-c\n");
});

test("VN.20", () => {
  assert.equal(run("‸alpha beta\n", ["t", "b"]).show, "alpha‸ beta\n");
  assert.equal(run("alpha be‸ta\n", ["T", "a"]).show, "alpha‸ beta\n");
  const repeat = run("‸a-b-c\n", ["t", "-", ";"]);
  assert.equal(repeat.show, "a-‸b-c\n");
  const further = run("‸a-b-c-d\n", ["t", "-", ";", ";"]);
  assert.equal(further.show, "a-b-‸c-d\n");
  assert.equal(run(further.show, [","], { vim: further.vim }).show, "a-‸b-c-d\n");
});

test("VN.21", () => {
  assert.equal(run("‸((a) b)\n", ["%"]).show, "((a) b‸)\n");
  assert.equal(run("(a)‸", ["%"]).show, "‸(a)");
  assert.equal(run("‸x (a) y\n", ["%"]).show, "x (a‸) y\n");
  assert.equal(run("(‸a) b\n", ["%"]).show, "(a‸) b\n");
  assert.equal(run("‸alpha\n", ["%"]).show, "‸alpha\n");
  assert.equal(run("‸(a\n", ["%"]).show, "‸(a\n");
});

test("VN.22", () => {
  assert.equal(run("‸one\n\ntwo\n\nthree\n", ["}"]).show, "one\n\n‸two\n\nthree\n");
  assert.equal(run("‸one\n\ntwo\n\nthree\n", ["2", "}"]).show, "one\n\ntwo\n\n‸three\n");
  assert.equal(run("one\n\ntwo\n\nthr‸ee\n", ["{"]).show, "one\n\n‸two\n\nthree\n");
});

test("VN.23", () => {
  for (const command of ["H", "M", "L"]) {
    const idle = run("‸alpha\nbeta\n", [command]);
    assert.equal(idle.steps[0].match, "full");
    assert.equal(idle.steps[0].effect, null);
    assert.equal(idle.show, "‸alpha\nbeta\n");
    const view = run("‸alpha\nbeta\n", [command], { layout: true });
    assertView(view, command, 1);
    assert.equal(view.show, "‸alpha\nbeta\n");
  }
});

test("VN.24", () => {
  let doc = "";
  const starts = [];
  for (let i = 0; i < 25; i += 1) {
    if (i) doc += "\n\n";
    starts.push(doc.length);
    doc += `p${i}`;
  }
  doc += "\n";
  const page = run(`${CARET}${doc}`, [{ key: "f", ctrl: true }]);
  assert.equal(page.cursor, starts[20]);
  const half = run(`${CARET}${doc}`, [{ key: "d", ctrl: true }]);
  assert.equal(half.cursor, starts[10]);
  const down = run(`${CARET}${doc}`, ["PageDown"]);
  assert.equal(down.cursor, starts[20]);
  const view = run(`${CARET}${doc}`, [{ key: "b", ctrl: true }], { layout: true });
  assertView(view, "ctrl-b", 1);
  assert.equal(view.cursor, 0);
  const counted = run(`${CARET}${doc}`, ["2", { key: "u", ctrl: true }], { layout: true });
  assertView(counted, "ctrl-u", 2);
  const rawDoc = Array.from({ length: 30 }, (_, i) => `L${i}`).join("\n") + "\n";
  const raw = run(`${CARET}${rawDoc}`, [{ key: "f", ctrl: true }], { raw: true });
  assert.equal(raw.doc.slice(raw.cursor, raw.cursor + 3), "L20");
});

test("VN.25", () => {
  assert.equal(run("al‸pha\n  beta\n", ["Enter"], { raw: true }).show, "alpha\n  ‸beta\n");
  assert.equal(run("al‸pha\n\n  beta\n", ["Enter"]).show, "alpha\n\n  ‸beta\n");
  const joined = run("al‸pha\n  beta\n", ["Enter"]);
  assert.equal(joined.doc, "alpha\n  beta\n");
  assert.equal(joined.show.includes("beta"), true);
  assert.equal(joined.cursor < joined.doc.indexOf("beta"), true);
});

test("VN.26", () => {
  const line = "  al‸pha\n";
  for (const [keys, edge, also] of [
    [["z", "z"], "center", false],
    [["z", "t"], "top", false],
    [["z", "b"], "bottom", false],
    [["z", "."], "center", true],
    [["z", "-"], "bottom", true],
    [["z", "Enter"], "top", true],
  ]) {
    const out = run(line, keys);
    assert.equal(last(out).effect.type, "scroll");
    assert.equal(last(out).effect.edge, edge);
    assert.equal(last(out).effect.alsoFirstNonBlank, also);
    assert.equal(out.doc, "  alpha\n");
    if (also) assert.equal(out.show, "  ‸alpha\n");
    else assert.equal(out.show, line);
  }
});

test("VN.27", () => {
  assert.equal(run("‸a b c d\n", ["3", "w"]).show, "a b c ‸d\n");
  assert.equal(run("‸one\ntwo\nthree\n", ["2", "j"], { raw: true }).show, "one\ntwo\n‸three\n");
  assert.equal(run("‸one\ntwo\nthree\n", ["2", "j"]).show, "‸one\ntwo\nthree\n");
  assert.equal(run("‸one\n\ntwo\n\nthree\n", ["2", "j"]).show, "one\n\ntwo\n\n‸three\n");
});

test("VW.1", () => {
  assert.equal(run("al‸pha\n\nbeta\n", ["j"]).show, "alpha\n\nbe‸ta\n");
  assert.equal(run("alpha\n\nbe‸ta\n", ["k"]).show, "al‸pha\n\nbeta\n");
});

// The quote mark on a list item inside a quote is not drawn. A column in that
// prefix has no glyph, and the page then puts the caret at offset 0.
test("czp4tesp j and k land on a drawn offset of a list item inside a quote", () => {
  const start = "T‸op.\n\n> quoted block\n> * List under a quoted block\n> * second list item\n\nAfter.\n";
  const quote = run(start, ["j"]);
  assert.equal(quote.show, "Top.\n\n>‸ quoted block\n> * List under a quoted block\n> * second list item\n\nAfter.\n");
  assert.equal(quote.vim.column, 1);
  const first = run(quote.show, ["j"], { vim: quote.vim });
  assert.equal(first.show, "Top.\n\n> quoted block\n> ‸* List under a quoted block\n> * second list item\n\nAfter.\n");
  assert.notEqual(first.cursor, 0);
  const second = run(first.show, ["j"], { vim: first.vim });
  assert.equal(second.show, "Top.\n\n> quoted block\n> * List under a quoted block\n> ‸* second list item\n\nAfter.\n");
  const after = run(second.show, ["j"], { vim: second.vim });
  assert.equal(after.show, "Top.\n\n> quoted block\n> * List under a quoted block\n> * second list item\n\nA‸fter.\n");

  const up1 = run("Top.\n\n> quoted block\n> * List under a quoted block\n> * second list item\n\nA‸fter.\n", ["k"]);
  assert.equal(up1.show, "Top.\n\n> quoted block\n> * List under a quoted block\n> ‸* second list item\n\nAfter.\n");
  const up2 = run(up1.show, ["k"], { vim: up1.vim });
  assert.equal(up2.show, "Top.\n\n> quoted block\n> ‸* List under a quoted block\n> * second list item\n\nAfter.\n");
  const up3 = run(up2.show, ["k"], { vim: up2.vim });
  assert.equal(up3.show, "Top.\n\n>‸ quoted block\n> * List under a quoted block\n> * second list item\n\nAfter.\n");
  assert.notEqual(up3.cursor, 0);

  const only = run("T‸op.\n\n> * first item\n> * second item\n\nAfter.\n", ["j"]);
  assert.equal(only.show, "Top.\n\n> ‸* first item\n> * second item\n\nAfter.\n");
  const onlyUp = run("Top.\n\n> * first item\n> * second item\n\nA‸fter.\n", ["k"]);
  assert.equal(onlyUp.show, "Top.\n\n> * first item\n> ‸* second item\n\nAfter.\n");

  const plain = run("T‸op.\n\n> one line\n> two line\n\nAfter.\n", ["j", "j"]);
  assert.equal(plain.show, "Top.\n\n> one line\n>‸ two line\n\nAfter.\n");

  const source = run("Top.\n\n>‸ quoted block\n> * List under a quoted block\n", ["j"], { raw: true });
  assert.equal(source.show, "Top.\n\n> quoted block\n>‸ * List under a quoted block\n");
});

test("VW.2", () => {
  const once = run("al‸pha\n\nbeta\n", ["j"], { raw: true });
  assert.equal(once.show, "alpha\n‸\nbeta\n");
  assert.equal(once.vim.column, 2);
  assert.equal(run(once.show, ["j"], { raw: true, vim: once.vim }).show, "alpha\n\nbe‸ta\n");
});

test("VW.3", () => {
  assert.equal(run("‸one\n\n\n", ["j"]).show, "one\n\n‸\n");
  assert.equal(run("‸one\n\n\n", ["j"], { raw: true }).show, "one\n‸\n\n");
});

test("VW.4", () => {
  const once = run("‸one\n\n\n\ntwo\n", ["j"]);
  assert.equal(once.show, "one\n\n‸\n\ntwo\n");
  const twice = run(once.show, ["j"], { vim: once.vim });
  assert.equal(twice.show, "one\n\n\n‸\ntwo\n");
  assert.equal(run(twice.show, ["j"], { vim: twice.vim }).show, "one\n\n\n\n‸two\n");
});

test("VW.5", () => {
  assert.equal(run("al‸pha\n\n   \n\nbeta\n", ["j"]).show, "alpha\n\n‸   \n\nbeta\n");
});

test("VW.6", () => {
  assert.equal(run("al‸pha\n\n**bold** text\n", ["j"]).show, "alpha\n\n**‸bold** text\n");
});

test("VW.7", () => {
  const raw = run("abcdef‸\nred  \nblue\n", ["j"], { raw: true });
  assert.equal(raw.show, "abcdef\nred‸  \nblue\n");
  const joined = run("abcdef‸\nred  \nblue\n", ["j"]);
  assert.equal(joined.show, "abcdef‸\nred  \nblue\n");
  const apart = run("abcdef‸\n\nred  \n", ["j"]);
  assert.equal(apart.show, "abcdef\n\nred‸  \n");
});

test("VW.8", () => {
  const joined = "abcdef‸\nSee {c1}this{/c1} now.";
  assert.equal(run(joined, ["j"]).show, joined);
  const apart = run("abcdef‸\n\nSee {c1}this{/c1} now.", ["j"]);
  assert.equal(apart.doc, "abcdef\n\nSee {c1}this{/c1} now.");
  assert.ok(apart.cursor > apart.doc.indexOf("See"));
  assert.equal(skipHidden(apart.doc, apart.cursor, "forward"), apart.cursor);
  assert.equal(skipHidden(apart.doc, apart.cursor, "backward"), apart.cursor);
  assert.equal(apart.show.includes("{c1}‸") || apart.show.includes("‸{c1}"), true);
  const right = run("See ‸{c1}this{/c1} now.", ["l"]);
  assertView(right, "l", 1);
  assert.equal(right.doc, "See {c1}this{/c1} now.");
  assert.equal(run("‸See {c1}this{/c1} now.", ["f", "c"]).show, "‸See {c1}this{/c1} now.");
  assert.equal(run("‸x {c1}a{/c1} y.", ["%"]).show, "x {c1}‸a{/c1} y.");
  assert.equal(run("‸x {c1}a{/c1} y.", ["%"]).doc, "x {c1}a{/c1} y.");
});

test("VW.9", () => {
  const out = run("‸x\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n", ["j"]);
  assert.equal(out.doc[out.cursor], "|");
  assert.equal(out.show.startsWith("x\n\n‸| a | b |"), true);
});

function lineAtCaret(out) {
  const start = out.doc.lastIndexOf("\n", Math.max(0, out.cursor - 1)) + 1;
  const end = out.doc.indexOf("\n", out.cursor);
  return out.doc.slice(start, end < 0 ? out.doc.length : end);
}

function press(out, key, opts) {
  return run(out.show, [key], { vim: out.vim, ...opts });
}

test("pn4hbr22 k from below a table lands on the last row and steps up", () => {
  const doc = "Top.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\nAfte‸r.\n";
  let out = run(doc, ["k"]);
  assert.equal(lineAtCaret(out), "");
  assert.equal(out.vim.column, 4);
  const up = ["| 3 | 4 |", "| 1 | 2 |", "|---|---|", "| a | b |", "Top."];
  for (const text of up) {
    out = press(out, "k");
    assert.equal(lineAtCaret(out), text);
    assert.equal(out.cursor - (out.doc.lastIndexOf("\n", Math.max(0, out.cursor - 1)) + 1), Math.min(4, text.length));
  }
  const under = run("Top.\n\n| a | b |\n|---|---|\n| 1 | 2 |\nAfte‸r.\n", ["k"]);
  assert.equal(lineAtCaret(under), "| 1 | 2 |");
  assert.equal(under.cursor - under.doc.indexOf("| 1 | 2 |"), 4);
  const counted = run("Top.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\nAfte‸r.\n", ["2", "k"]);
  assert.equal(lineAtCaret(counted), "| 3 | 4 |");
  const down = ["| a | b |", "|---|---|", "| 1 | 2 |", "| 3 | 4 |", "After."];
  let jay = run("‸Top.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\nAfter.\n", ["j"]);
  for (const text of down) {
    assert.equal(lineAtCaret(jay), text);
    jay = press(jay, "j");
  }
  const raw = run("Top.\n\n| a | b |\n|---|---|\n| 1 | 2 |\nAfte‸r.\n", ["k"], { raw: true });
  assert.equal(lineAtCaret(raw), "| 1 | 2 |");
});

test("pn4hbr22 dk from below a table deletes that table line", () => {
  const doc = "Top.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\nAfter.\n";
  const blank = run(doc.replace("\n\nAfter.", "\n‸\nAfter."), ["d", "k"]);
  assert.equal(blank.doc, "Top.\n\nAfter.\n");
  const after = run(doc.replace("After.", "‸After."), ["d", "k"]);
  assert.equal(after.doc, "Top.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n");
  const into = run(doc.replace("Top.", "‸Top."), ["d", "j"]);
  assert.equal(into.doc, "\nAfter.\n");
});

test("VW.10", () => {
  const out = run("‸x\n\n```mermaid\ngraph TD\nA-->B\n```\n", ["j"]);
  assert.equal(out.show.startsWith("x\n\n‸```mermaid\n"), true);
  assert.equal(out.doc[out.cursor], "`");
});

test("VW.11", () => {
  const doc = "al‸pha\r\nbeta\r\n";
  const three = run(doc, ["3", "l"], { raw: true });
  assertView(three, "l", 3);
  const one = run(doc, ["l"], { raw: true });
  assertView(one, "l", 1);
  assert.equal(one.doc, "alpha\r\nbeta\r\n");
  assert.equal(skipHidden(one.doc, one.doc.indexOf("\n"), "backward", { gap: false }), one.doc.indexOf("\r"));
});

test("VW.12", () => {
  const out = run("al‸pha\n\nbeta\n", ["v", "j"]);
  assert.equal(out.vim.mode, "visual");
  assert.equal(out.anchor, 2);
  assert.equal(out.show, "al«pha\n\nbet‸a\n");
  assert.notEqual(out.cursor, out.doc.indexOf("\n\n") + 1);
  assert.equal(out.doc, "alpha\n\nbeta\n");
});

test("VX.1", () => {
  const keys = ["Q", "K", "q", "@", "m", "'", "`", "(", ")", "R", "&", { key: "e", ctrl: true }, { key: "o", ctrl: true }, { key: "q", ctrl: true }, { key: "k", ctrl: true }, { key: "Insert" }];
  for (const key of keys) {
    const normal = run("‸alpha\n", [key]);
    assert.equal(normal.steps[0].match, "none", JSON.stringify(key));
    assert.equal(normal.steps[0].consumed, true);
    assert.equal(normal.steps[0].effect, null);
    assert.equal(normal.show, "‸alpha\n");
    assert.equal(normal.vim.mode, "normal");
    const visual = run("«alpha‸ beta\n", [key], { mode: "visual" });
    assert.equal(visual.steps[0].match, "none");
    assert.equal(visual.steps[0].consumed, true);
    assert.equal(visual.vim.mode, "visual");
    assert.equal(visual.show, "«alpha‸ beta\n");
  }
});

test("VX.2", () => {
  const out = run("‸alpha\n", ["q", "x"]);
  assert.equal(out.steps[0].match, "none");
  assert.equal(out.steps[1].effect.type, "forward-delete");
  assert.equal(out.show, "‸lpha\n");
});

test("VX.3", () => {
  for (const pair of ["gv", "gi", "gq", "gw", "zf", "zo", "zc", "za"]) {
    const out = run("‸alpha\n", [pair[0], pair[1]]);
    assert.equal(out.steps[0].match, "partial", pair);
    assert.equal(out.steps[1].match, "none", pair);
    assert.equal(out.steps[1].consumed, true);
    assert.equal(out.show, "‸alpha\n");
    assert.equal(out.vim.input.keyBuffer, "");
  }
});

test("VX.4", () => {
  const out = run("‸alpha\n", ['"', "a"]);
  assert.equal(out.steps[0].match, "partial");
  assert.equal(out.steps[1].match, "none");
  assert.equal(out.steps[1].consumed, true);
  assert.equal(out.vim.input.keyBuffer, "");
  assert.equal(out.vim.input.operator, null);
  assert.equal(out.show, "‸alpha\n");
});

test("VX.5", () => {
  const chords = ["a", "c", "v", "x", "y", "z"];
  for (const id of chords) {
    for (const mode of ["normal", "visual", "insert"]) {
      for (const field of ["ctrl", "meta"]) {
        const out = run("‸alpha\n", [{ key: id, [field]: true }], { mode });
        assert.equal(out.steps[0].match, "none", `${field}-${id} ${mode}`);
        assert.equal(out.steps[0].consumed, false);
        assert.equal(out.steps[0].effect, null);
        assert.equal(out.doc, "alpha\n");
      }
    }
  }
});

test("VX.6", () => {
  const dot = run("‸alpha\n", ["."]);
  assert.equal(dot.steps[0].match, "none");
  assert.equal(dot.steps[0].consumed, true);
  assert.equal(dot.steps[0].effect, null);
  assert.equal(dot.show, "‸alpha\n");
  const insert = run("al‸pha\n", [{ key: "r", ctrl: true }], { mode: "insert" });
  assert.equal(insert.steps[0].match, "none");
  assert.equal(insert.steps[0].consumed, false);
  assert.equal(insert.doc, "alpha\n");
  const object = run("‸alpha\n", ["d", "i", "("]);
  assert.equal(object.steps.filter((step) => step.effect && step.effect.type === "splice").length, 0);
  assert.equal(object.doc, "alpha\n");
  assert.equal(object.vim.input.operator, null);
  const ex = run("‸alpha\n", [":"]);
  assert.equal(ex.steps[0].effect.type, "prompt");
  assert.equal(ex.steps[0].effect.kind, "ex");
  assert.equal(ex.doc, "alpha\n");
});

test("VO.2", () => {
  const end = run("alpha ‸beta\n", ["d", "w"]);
  assert.equal(end.show, "alpha ‸\n");
  assert.equal(end.vim.mode, "normal");
  assert.equal(oneSplice(end).text, "");
  assert.equal(run("al‸pha beta\n", ["d", "w"]).show, "al‸beta\n");
  assert.equal(run("alpha ‸beta\n\ngamma\n", ["d", "w"]).show, "alpha ‸\n\ngamma\n");
});

test("VO.3", () => {
  const word = run("al‸pha beta\n", ["c", "w"]);
  assert.equal(word.show, "al‸ beta\n");
  assert.equal(word.vim.mode, "insert");
  assert.equal(oneSplice(word).text, "");
  const spaces = run("alpha‸   beta\n", ["c", "w"]);
  assert.equal(spaces.show, "alpha‸beta\n");
  assert.equal(spaces.vim.mode, "insert");
});

test("VO.4", () => {
  const joined = run("al‸pha\nbeta\n", ["d", "w"]);
  assert.equal(joined.show, "al‸beta\n");
  assert.equal(oneSplice(joined).text, "");
  const apart = run("al‸pha\n\nbeta\n", ["d", "w"]);
  assert.equal(apart.show, "al‸\n\nbeta\n");
  assert.equal(oneSplice(apart).text, "");
  const raw = run("al‸pha\nbeta\n", ["d", "w"], { raw: true });
  assert.equal(raw.show, "al‸\nbeta\n");
  assert.equal(oneSplice(raw).text, "");
  const joinedChange = run("al‸pha\nbeta\n", ["c", "w"]);
  assert.equal(joinedChange.show, "al‸beta\n");
  assert.equal(joinedChange.vim.mode, "insert");
  const apartChange = run("al‸pha\n\nbeta\n", ["c", "w"]);
  assert.equal(apartChange.show, "al‸\n\nbeta\n");
  assert.equal(apartChange.vim.mode, "insert");
  const rawChange = run("al‸pha\nbeta\n", ["c", "w"], { raw: true });
  assert.equal(rawChange.show, "al‸\nbeta\n");
  assert.equal(rawChange.vim.mode, "insert");
  const held = run("alpha‸\n\nbeta\n", ["d", "w"]);
  assert.equal(held.steps.filter((step) => step.effect && step.effect.type === "splice").length, 0);
  assert.equal(held.show, "alpha‸\n\nbeta\n");
  assert.equal(held.vim.mode, "normal");
  const rawHeld = run("alpha‸\nbeta\n", ["d", "w"], { raw: true });
  assert.equal(rawHeld.steps.filter((step) => step.effect && step.effect.type === "splice").length, 0);
  assert.equal(rawHeld.show, "alpha‸\nbeta\n");
});

test("VO.5", () => {
  assert.equal(run("‸alpha beta\n", ["d", "e"]).show, "‸ beta\n");
  assert.equal(run("‸alpha beta\n", ["d", "f", "b"]).show, "‸eta\n");
  assert.equal(run("‸(a [b] c) d\n", ["d", "%"]).show, "‸ d\n");
  const miss = run("‸alpha beta\n", ["d", "f", "q"]);
  assert.equal(miss.steps.filter((step) => step.effect && step.effect.type === "splice").length, 0);
  assert.equal(miss.show, "‸alpha beta\n");
  const bare = run("‸alpha beta\n", ["d", "%"]);
  assert.equal(bare.steps.filter((step) => step.effect && step.effect.type === "splice").length, 0);
  assert.equal(bare.show, "‸alpha beta\n");
});

test("VO.6", () => {
  assert.equal(run("‸alpha beta\n", ["d", "t", "b"]).show, "‸ beta\n");
  assert.equal(run("alpha be‸ta\n", ["d", "T", "a"]).show, "alpha ‸ta\n");
});

test("VO.7", () => {
  assert.equal(run("alpha be‸ta\n", ["d", "b"]).show, "alpha ‸ta\n");
  assert.equal(run("alpha be‸ta\n", ["d", "g", "e"]).show, "alph‸ta\n");
  assert.equal(run("alpha be‸ta\n", ["d", "F", "a"]).show, "alph‸ta\n");
});

test("VO.8", () => {
  const cut = run("al‸pha beta\n", ["d", "$"]);
  assert.equal(cut.show, "al‸\n");
  assert.equal(cut.vim.mode, "normal");
  assert.equal(oneSplice(cut).text, "");
  const big = run("al‸pha beta\n", ["D"]);
  assert.equal(big.show, "al‸\n");
  assert.equal(big.vim.mode, "normal");
  assert.equal(oneSplice(big).text, "");
  const change = run("al‸pha beta\n", ["C"]);
  assert.equal(change.show, "al‸\n");
  assert.equal(change.vim.mode, "insert");
  assert.equal(oneSplice(change).text, "");
  const motion = run("al‸pha beta\n", ["c", "$"]);
  assert.equal(motion.show, "al‸\n");
  assert.equal(motion.vim.mode, "insert");
});

test("VO.9", () => {
  const out = run("al‸pha\n\nbeta\n\ngamma\n", ["d", "j"]);
  assert.equal(out.show, "‸gamma\n");
  assert.equal(out.vim.mode, "normal");
  assert.equal(oneSplice(out).text, "");
});

test("VO.14", () => {
  const three = run("al‸pha\n", ["3", "x"]);
  assert.equal(three.show, "al‸\n");
  assert.equal(three.vim.mode, "normal");
  assert.equal(oneSplice(three).text, "");
  const five = run("al‸pha\n", ["5", "x"]);
  assert.equal(five.show, "al‸\n");
  assert.equal(oneSplice(five).text, "");
  const end = run("alpha‸\n", ["3", "x"]);
  assert.equal(end.show, "alpha‸\n");
  assert.equal(last(end).match, "full");
  assert.equal(last(end).effect, null);
});

test("VO.15", () => {
  const three = run("alp‸ha\n", ["3", "X"]);
  assert.equal(three.show, "‸ha\n");
  assert.equal(oneSplice(three).text, "");
  const short = run("al‸pha\n", ["3", "X"]);
  assert.equal(short.show, "‸pha\n");
  assert.equal(oneSplice(short).text, "");
});

test("VO.16", () => {
  const one = run("al‸pha\n", ["s"]);
  assert.equal(one.show, "al‸ha\n");
  assert.equal(one.vim.mode, "insert");
  assert.equal(oneSplice(one).text, "");
  const three = run("al‸pha\n", ["3", "s"]);
  assert.equal(three.show, "al‸\n");
  assert.equal(three.vim.mode, "insert");
  assert.equal(oneSplice(three).text, "");
});

test("VO.17", () => {
  const mid = run("one\n\nt‸wo\n\nthree\n", ["c", "c"]);
  assert.equal(mid.show, "one\n\n‸\n\nthree\n");
  assert.equal(mid.vim.mode, "insert");
  assert.equal(oneSplice(mid).text, "\n");
  const para = run("al‸pha\nbeta\n", ["c", "c"]);
  assert.equal(para.show, "‸\n");
  assert.equal(para.vim.mode, "insert");
  assert.equal(oneSplice(para).text, "\n");
  const raw = run("alpha\nbe‸ta\ngamma\n", ["c", "c"], { raw: true });
  assert.equal(raw.show, "alpha\n‸\ngamma\n");
  assert.equal(raw.vim.mode, "insert");
  assert.equal(oneSplice(raw).text, "\n");
  const midS = run("one\n\nt‸wo\n\nthree\n", ["S"]);
  assert.equal(midS.show, mid.show);
  assert.equal(midS.vim.mode, "insert");
  assert.equal(oneSplice(midS).text, "\n");
  const paraS = run("al‸pha\nbeta\n", ["S"]);
  assert.equal(paraS.show, "‸\n");
  assert.equal(paraS.vim.mode, "insert");
  const rawS = run("alpha\nbe‸ta\ngamma\n", ["S"], { raw: true });
  assert.equal(rawS.show, "alpha\n‸\ngamma\n");
  assert.equal(rawS.vim.mode, "insert");
  assert.equal(oneSplice(rawS).text, "\n");
});

test("VO.18", () => {
  const out = run("‸ab\n", ["x", "d", "h", "P"]);
  assert.equal(out.show, "‸ab\n");
  assert.equal(out.steps[0].effect.type, "forward-delete");
  assert.equal(out.steps[0].vim.register.text, "a");
  assert.equal(out.steps[0].vim.register.linewise, false);
  const dh = out.steps[2];
  assert.notEqual(dh.effect && dh.effect.type, "splice");
  assert.equal(dh.vim.register.text, "a");
  assert.equal(dh.vim.register.linewise, false);
  oneSplice(out);
});

test("VO.19c", () => {
  const out = run("«See {c1}th‸is{/c1} now.", ["d"], { mode: "visual" });
  assert.equal(out.show, "‸{c1}is{/c1} now.");
  assert.equal(out.vim.mode, "normal");
  const effect = oneSplice(out);
  assert.equal(effect.from, 0);
  assert.equal(effect.to, 10);
  assert.equal(effect.text, "{c1}");
  assert.equal(effect.caret, 0);
  assert.equal(effect.yank.text, "See {c1}th");
  assert.equal(effect.yank.linewise, false);
});

test("insert none", () => {
  const out = run("‸alpha\n", ["x"], { mode: "insert" });
  assert.equal(out.steps[0].match, "none");
  assert.equal(out.steps[0].consumed, false);
  assert.equal(out.steps[0].effect, null);
  assert.equal(out.doc, "alpha\n");
  const arrow = run("al‸pha\n", ["ArrowLeft"], { mode: "insert" });
  assert.equal(arrow.steps[0].consumed, false);
  assert.equal(arrow.steps[0].effect, null);
});

test("VB.1", () => {
  const inner = run("alpha b‸eta gamma\n", ["d", "i", "w"]);
  assert.equal(inner.steps[1].match, "partial");
  assert.equal(inner.steps[1].vim.input.operator, "d");
  assert.equal(inner.steps[1].vim.input.keyBuffer, "i");
  assert.equal(inner.show, "alpha ‸ gamma\n");
  assert.equal(inner.vim.mode, "normal");
  assert.equal(inner.vim.input.operator, null);
  assert.equal(inner.vim.input.keyBuffer, "");
  assert.equal(oneSplice(inner).text, "");
  const around = run("alpha b‸eta gamma\n", ["d", "a", "w"]);
  assert.equal(around.show, "alpha ‸gamma\n");
  assert.equal(oneSplice(around).text, "");
});

test("VB.2", () => {
  const out = run("alpha be‸ta", ["d", "a", "w"]);
  assert.equal(out.show, "alpha‸");
  assert.equal(out.doc, "alpha");
  assert.equal(oneSplice(out).text, "");
});

test("VB.3", () => {
  const out = run("alpha ‸ beta\n", ["d", "i", "w"]);
  assert.equal(out.show, "alpha  ‸\n");
  assert.equal(out.doc, "alpha  \n");
  assert.equal(oneSplice(out).text, "");
});

test("VB.4", () => {
  const changed = run("alpha b‸eta gamma\n", ["c", "i", "w"]);
  assert.equal(changed.show, "alpha ‸ gamma\n");
  assert.equal(changed.vim.mode, "insert");
  assert.equal(oneSplice(changed).text, "");
  const yanked = run("alpha b‸eta gamma\n", ["y", "i", "w", "0", "P"]);
  const yank = yanked.steps[2];
  assert.equal(yank.match, "full");
  assert.equal(yank.consumed, true);
  assert.equal(yank.effect.type, "splice");
  assert.equal(Object.hasOwn(yank.effect, "group"), false);
  assert.equal(yank.effect.text, "beta");
  assert.equal(yank.effect.from, 6);
  assert.equal(yank.effect.to, 10);
  assert.equal(yank.vim.register.text, "beta");
  assert.equal(yank.vim.register.linewise, false);
  assert.equal(yanked.doc, "betaalpha beta gamma\n");
  assert.equal(yanked.show, "‸betaalpha beta gamma\n");
  assert.equal(yanked.vim.mode, "normal");
});

test("VB.5", () => {
  const inner = run('say "he‸llo" now\n', ["d", "i", '"']);
  assert.equal(inner.show, 'say "‸" now\n');
  assert.equal(oneSplice(inner).text, "");
  const around = run('say "he‸llo" now\n', ["d", "a", '"']);
  assert.equal(around.show, "say ‸ now\n");
  assert.equal(oneSplice(around).text, "");
  const open = run('say "he‸llo now\n', ["d", "i", '"']);
  assert.equal(open.show, 'say "he‸llo now\n');
  assert.equal(open.doc, 'say "hello now\n');
  assert.equal(last(open).effect, null);
  assert.equal(open.vim.input.operator, null);
  assert.equal(open.vim.input.keyBuffer, "");
  const split = run('say "he‸llo\nnow" ok\n', ["d", "i", '"']);
  assert.equal(split.show, 'say "he‸llo\nnow" ok\n');
  assert.equal(split.doc, 'say "hello\nnow" ok\n');
  assert.equal(last(split).effect, null);
});

test("VB.6", () => {
  const tick = "`";
  const sample = "a " + tick + "co" + CARET + "de" + tick + " b\n";
  const inner = run(sample, ["d", "i", tick]);
  assert.equal(inner.show, "a " + tick + CARET + tick + " b\n");
  assert.equal(inner.doc, "a " + tick + tick + " b\n");
  assert.equal(oneSplice(inner).text, "");
  const around = run(sample, ["d", "a", tick]);
  assert.equal(around.show, "a ‸ b\n");
  assert.equal(around.doc, "a  b\n");
  assert.equal(oneSplice(around).text, "");
  const outside = run(CARET + "a " + tick + "code" + tick + " b\n", ["d", "i", tick]);
  assert.equal(outside.show, CARET + "a " + tick + "code" + tick + " b\n");
  assert.equal(outside.doc, "a " + tick + "code" + tick + " b\n");
  assert.equal(last(outside).effect, null);
  assert.equal(last(outside).match, "none");
});

test("VB.7", () => {
  const doc = "see [te‸xt](https://x.test/p) now\n";
  const inner = run(doc, ["d", "i", "["]);
  assert.equal(inner.show, "see [‸](https://x.test/p) now\n");
  assert.equal(oneSplice(inner).text, "");
  const around = run(doc, ["d", "a", "["]);
  assert.equal(around.show, "see ‸(https://x.test/p) now\n");
  assert.equal(oneSplice(around).text, "");
  const close = run(doc, ["d", "i", "]"]);
  assert.equal(close.show, inner.show);
  assert.equal(close.doc, inner.doc);
  const bare = run("see [te‸xt] now\n", ["d", "i", "["]);
  assert.equal(bare.show, "see [te‸xt] now\n");
  assert.equal(bare.doc, "see [text] now\n");
  assert.equal(last(bare).effect, null);
  assert.equal(bare.vim.input.operator, null);
});

test("VB.8", () => {
  const inner = run("one\n\nal‸pha\nbeta\n\ntwo\n", ["d", "i", "p"]);
  assert.equal(inner.show, "one\n\n‸\n\ntwo\n");
  assert.equal(inner.doc, "one\n\n\n\ntwo\n");
  assert.equal(oneSplice(inner).text, "");
  const around = run("one\n\nal‸pha\nbeta\n\ntwo\n", ["d", "a", "p"]);
  assert.equal(around.show, "one\n\n‸two\n");
  assert.equal(around.doc, "one\n\ntwo\n");
  assert.equal(oneSplice(around).text, "");
});

test("VB.9", () => {
  const out = run("say ‸hello\n", ["d", "i", '"']);
  assert.equal(out.show, "say ‸hello\n");
  assert.equal(out.doc, "say hello\n");
  assert.equal(last(out).match, "none");
  assert.equal(last(out).consumed, true);
  assert.equal(last(out).effect, null);
  assert.deepEqual(out.vim.input, {
    prefixRepeat: "",
    operator: null,
    motionRepeat: "",
    motion: null,
    keyBuffer: "",
  });
});

test("VB.10", () => {
  for (const ch of ["(", "{", "<", "t", "*", "_"]) {
    const out = run("al‸pha\n", ["d", "i", ch]);
    assert.equal(out.doc, "alpha\n", ch);
    assert.equal(out.show, "al‸pha\n", ch);
    assert.equal(last(out).match, "none", ch);
    assert.equal(last(out).consumed, true, ch);
    assert.equal(last(out).effect, null, ch);
    assert.equal(out.vim.input.operator, null, ch);
    assert.equal(out.vim.input.keyBuffer, "", ch);
  }
});

test("VD.1", () => {
  const out = run("al‸pha\n", [">", ">"]);
  assert.equal(out.show, "\t‸alpha\n");
  assert.equal(out.vim.mode, "normal");
  assert.equal(out.vim.input.operator, null);
  const effect = oneSplice(out);
  assert.equal(effect.text, "\talpha");
  assert.equal(effect.caret, 1);
  assert.equal(effect.yank, null);
});

test("VD.2", () => {
  const bullet = run("- a\n- ‸b\n", [">", ">"]);
  assert.equal(bullet.show, "- a\n\t‸- b\n");
  assert.equal(oneSplice(bullet).text, "\t- b");
  const ordered = run("1. a\n2. ‸b\n", [">", ">"]);
  assert.equal(ordered.show, "1. a\n\t‸1. b\n");
  assert.equal(oneSplice(ordered).text, "\t1. b");
});

test("VD.3", () => {
  const plain = run("\tal‸pha\n", ["<", "<"]);
  assert.equal(plain.show, "‸alpha\n");
  assert.equal(plain.doc, "alpha\n");
  assert.equal(oneSplice(plain).text, "alpha");
  const item = run("- a\n\t- ‸b\n", ["<", "<"]);
  assert.equal(item.show, "- a\n- ‸b\n");
  assert.equal(oneSplice(item).text, "- b");
  const spaces = run("  al‸pha\n", ["<", "<"]);
  assert.equal(spaces.show, "  al‸pha\n");
  assert.equal(spaces.doc, "  alpha\n");
  assert.equal(last(spaces).match, "full");
  assert.equal(last(spaces).consumed, true);
  assert.equal(last(spaces).effect, null);
  assert.equal(spaces.vim.input.operator, null);
  const top = run("- ‸a\n", ["<", "<"]);
  assert.equal(top.show, "- ‸a\n");
  assert.equal(top.doc, "- a\n");
  assert.equal(last(top).effect, null);
  const spaced = run("2. two\n    2. ‸x\n", ["<", "<"]);
  assert.equal(spaced.show, "2. two\n3. ‸x\n");
  assert.equal(oneSplice(spaced).text, "3. x");
  const nested = run("2. a\n\t2. ‸b\n", ["<", "<"]);
  assert.equal(nested.show, "2. a\n3. ‸b\n");
  assert.equal(oneSplice(nested).text, "3. b");
});

test("VD.4", () => {
  const count = run("‸a\nb\nc\nd\n", ["3", ">", ">"]);
  assert.equal(count.show, "\t‸a\n\tb\n\tc\nd\n");
  assert.equal(count.doc, "\ta\n\tb\n\tc\nd\n");
  assert.equal(oneSplice(count).text, "\ta\n\tb\n\tc");
  const motion = run("‸a\nb\nc\nd\n", [">", "j"]);
  assert.equal(motion.show, "\t‸a\n\tb\nc\nd\n");
  assert.equal(motion.doc, "\ta\n\tb\nc\nd\n");
  assert.equal(oneSplice(motion).text, "\ta\n\tb");
  const para = run("one\n\nal‸pha\nbeta\n\ntwo\n", [">", "i", "p"]);
  assert.equal(para.show, "one\n\n\t‸alpha\n\tbeta\n\ntwo\n");
  assert.equal(para.doc, "one\n\n\talpha\n\tbeta\n\ntwo\n");
  const effect = oneSplice(para);
  assert.equal(effect.text, "\talpha\n\tbeta");
  assert.equal(para.vim.input.operator, null);
});

test("VD.6", () => {
  const item = run("- a\n\t\t- ‸b\n", ["=", "="]);
  assert.equal(item.show, "- a\n\t‸- b\n");
  assert.equal(item.doc, "- a\n\t- b\n");
  assert.equal(oneSplice(item).text, "\t- b");
  const plain = run("al‸pha\n", ["=", "="]);
  assert.equal(plain.show, "al‸pha\n");
  assert.equal(plain.doc, "alpha\n");
  assert.equal(last(plain).match, "full");
  assert.equal(last(plain).effect, null);
  assert.equal(plain.vim.input.operator, null);
  const deeper = run("- a\n- ‸b\n", ["=", "="]);
  assert.equal(deeper.show, "- a\n\t‸- b\n");
  const numbered = run("1. a\n\t\t2. ‸b\n", ["=", "="]);
  assert.equal(numbered.show, "1. a\n\t‸1. b\n");
});

test("VB.11", () => {
  const out = run("‸alpha\n", ["i", "w"]);
  assert.equal(out.steps[0].vim.mode, "insert");
  assert.equal(out.steps[0].match, "full");
  assert.equal(out.steps[1].match, "none");
  assert.equal(out.steps[1].consumed, false);
  assert.equal(out.steps[1].effect, null);
  assert.equal(out.doc, "alpha\n");
  assert.equal(out.show, "‸alpha\n");
  const append = run("‸alpha\n", ["a", "w"]);
  assert.equal(append.steps[0].vim.mode, "insert");
  assert.equal(append.steps[1].match, "none");
  assert.equal(append.steps[1].consumed, false);
  assert.equal(append.doc, "alpha\n");
  const visual = run("alp‸ha\n", ["i", "w"], { mode: "visual" });
  assert.equal(visual.steps[0].match, "partial");
  assert.equal(visual.steps[0].vim.mode, "visual");
  assert.equal(visual.steps[0].vim.input.keyBuffer, "i");
  assert.equal(visual.vim.mode, "visual");
  assert.equal(visual.show, "«alpha‸\n");
  assert.equal(visual.doc, "alpha\n");
});

test("VI.6", () => {
  const below = run("al‸pha\nbeta\n", ["o"], { raw: true });
  assert.equal(below.show, "alpha\n‸\nbeta\n");
  assert.equal(below.doc, "alpha\n\nbeta\n");
  assert.equal(below.vim.mode, "insert");
  assert.equal(below.vim.once, false);
  assert.equal(oneSplice(below).text, "\n");
  assert.equal(oneSplice(below).from, oneSplice(below).to);
  const above = run("al‸pha\nbeta\n", ["O"], { raw: true });
  assert.equal(above.show, "‸\nalpha\nbeta\n");
  assert.equal(above.doc, "\nalpha\nbeta\n");
  assert.equal(above.vim.mode, "insert");
  assert.equal(oneSplice(above).text, "\n");
  const three = run("al‸pha\nbeta\n", ["3", "o"], { raw: true });
  assert.equal(three.show, "alpha\n\n\n‸\nbeta\n");
  assert.equal(three.doc, "alpha\n\n\n\nbeta\n");
  assert.equal(three.vim.mode, "insert");
  assert.equal(oneSplice(three).text, "\n\n\n");
  const threeAbove = run("al‸pha\nbeta\n", ["3", "O"], { raw: true });
  assert.equal(threeAbove.show, "\n\n‸\nalpha\nbeta\n");
  assert.equal(threeAbove.doc, "\n\n\nalpha\nbeta\n");
  assert.equal(oneSplice(threeAbove).text, "\n\n\n");
  const crlf = run("al‸pha\r\nbeta\r\n", ["o"], { raw: true });
  assert.equal(crlf.show, "alpha\r\n‸\r\nbeta\r\n");
  assert.equal(crlf.doc, "alpha\r\n\r\nbeta\r\n");
  assert.equal(crlf.vim.mode, "insert");
  assert.equal(oneSplice(crlf).text, "\r\n");
  const bare = run("al‸pha", ["o"], { raw: true });
  assert.equal(bare.show, "alpha\n‸");
  assert.equal(bare.doc, "alpha\n");
  assert.equal(oneSplice(bare).text, "\n");
  const bareThree = run("al‸pha", ["3", "o"], { raw: true });
  assert.equal(bareThree.show, "alpha\n\n\n‸");
  assert.equal(oneSplice(bareThree).text, "\n\n\n");
});

test("VI.7", () => {
  const plain = run("al‸pha\n", ["o"]);
  assert.equal(plain.show, "alpha\n\n‸\n");
  assert.equal(plain.doc, "alpha\n\n\n");
  assert.equal(plain.vim.mode, "insert");
  assert.equal(oneSplice(plain).text, "\n\n");
  assert.equal(oneSplice(plain).from, oneSplice(plain).to);
  const item = run("- al‸pha\n", ["o"]);
  assert.equal(item.show, "- alpha\n\n‸\n");
  assert.equal(item.doc, "- alpha\n\n\n");
  assert.equal(item.vim.mode, "insert");
  assert.equal(oneSplice(item).text, "\n\n");
  const heading = run("# Ti‸tle\n", ["o"]);
  assert.equal(heading.show, "# Title\n\n‸\n");
  assert.equal(heading.doc, "# Title\n\n\n");
  assert.equal(heading.vim.mode, "insert");
  assert.equal(oneSplice(heading).text, "\n\n");
  const three = run("al‸pha\n", ["3", "o"]);
  assert.equal(three.show, "alpha\n\n\n\n‸\n");
  assert.equal(three.doc, "alpha\n\n\n\n\n");
  assert.equal(three.vim.mode, "insert");
  assert.equal(oneSplice(three).text, "\n\n\n\n");
  const crlf = run("al‸pha\r\n", ["o"]);
  assert.equal(crlf.show, "alpha\r\n\r\n‸\r\n");
  assert.equal(crlf.doc, "alpha\r\n\r\n\r\n");
  assert.equal(oneSplice(crlf).text, "\r\n\r\n");
});

test("VI.9", () => {
  const above = run("al‸pha\n", ["O"]);
  assert.equal(above.show, "‸\n\nalpha\n");
  assert.equal(above.doc, "\n\nalpha\n");
  assert.equal(above.vim.mode, "insert");
  assert.equal(oneSplice(above).text, "\n\n");
  assert.equal(oneSplice(above).from, 0);
  const three = run("al‸pha\n", ["3", "O"]);
  assert.equal(three.show, "\n\n‸\n\nalpha\n");
  assert.equal(three.doc, "\n\n\n\nalpha\n");
  assert.equal(three.vim.mode, "insert");
  assert.equal(oneSplice(three).text, "\n\n\n\n");
});

test("VI.10", () => {
  const below = run("al‸pha\nbeta\n", ["o"]);
  assert.equal(below.show, "alpha\nbeta\n\n‸\n");
  assert.equal(below.doc, "alpha\nbeta\n\n\n");
  assert.equal(below.vim.mode, "insert");
  const effect = oneSplice(below);
  assert.equal(effect.text, "\n\n");
  assert.equal(effect.from, "alpha\nbeta\n".length);
  assert.equal(effect.to, effect.from);
  const inside = run("alpha\nbe‸ta\n", ["o"]);
  assert.equal(inside.show, below.show);
  assert.equal(inside.doc, below.doc);
  const above = run("al‸pha\nbeta\n", ["O"]);
  assert.equal(above.show, "‸\n\nalpha\nbeta\n");
  assert.equal(above.doc, "\n\nalpha\nbeta\n");
  assert.equal(above.vim.mode, "insert");
  assert.equal(oneSplice(above).text, "\n\n");
  assert.equal(oneSplice(above).from, 0);
  const aboveInside = run("alpha\nbe‸ta\n", ["O"]);
  assert.equal(aboveInside.show, above.show);
  assert.equal(aboveInside.doc, above.doc);
});

test("VJ.1", () => {
  const out = run("al‸pha\nbeta\n", ["J"], { raw: true });
  assert.equal(out.show, "alpha‸ beta\n");
  assert.equal(out.doc, "alpha beta\n");
  assert.equal(out.vim.mode, "normal");
  const effect = oneSplice(out);
  assert.equal(effect.text, " ");
  assert.equal(effect.caret, 5);
  assert.equal(effect.yank, null);
});

test("VJ.2", () => {
  const out = run("al‸pha \nbeta\n", ["J"]);
  assert.equal(out.show, "alpha ‸beta\n");
  assert.equal(out.doc, "alpha beta\n");
  assert.equal(out.vim.mode, "normal");
  const effect = oneSplice(out);
  assert.equal(effect.text, "");
  assert.equal(effect.yank, null);
});

test("VJ.3", () => {
  const out = run("on‸e\n\ntwo\n", ["J"]);
  assert.equal(out.show, "one‸two\n");
  assert.equal(out.doc, "onetwo\n");
  assert.equal(out.vim.mode, "normal");
  const effect = oneSplice(out);
  assert.equal(effect.text, "");
  assert.equal(effect.yank, null);
});

test("VJ.4", () => {
  const out = run("al‸pha\nbeta\n", ["g", "J"], { raw: true });
  assert.equal(out.steps[0].match, "partial");
  assert.equal(out.show, "alpha‸beta\n");
  assert.equal(out.doc, "alphabeta\n");
  assert.equal(out.vim.mode, "normal");
  const effect = oneSplice(out);
  assert.equal(effect.text, "");
  assert.equal(effect.caret, 5);
  assert.equal(effect.yank, null);
});

test("VJ.5", () => {
  const raw = run("‸a\nb\nc\nd\n", ["3", "J"], { raw: true });
  assert.equal(raw.show, "a b‸ c\nd\n");
  assert.equal(raw.doc, "a b c\nd\n");
  assert.equal(raw.vim.mode, "normal");
  const rawEffect = oneSplice(raw);
  assert.equal(rawEffect.text, " b ");
  assert.equal(rawEffect.caret, 3);
  assert.equal(rawEffect.yank, null);
  const rendered = run("‸a\n\nb\n\nc\n\nd\n", ["3", "J"]);
  assert.equal(rendered.show, "ab‸c\n\nd\n");
  assert.equal(rendered.doc, "abc\n\nd\n");
  assert.equal(rendered.vim.mode, "normal");
  const renderedEffect = oneSplice(rendered);
  assert.equal(renderedEffect.text, "b");
  assert.equal(renderedEffect.caret, 2);
  assert.equal(renderedEffect.yank, null);
});

test("VR.1", () => {
  const one = run("al‸pha\n", ["r", "x"]);
  assert.equal(one.steps[0].match, "partial");
  assert.equal(one.steps[0].vim.input.keyBuffer, "r");
  assert.equal(one.show, "al‸xha\n");
  assert.equal(one.doc, "alxha\n");
  assert.equal(one.vim.mode, "normal");
  assert.equal(one.vim.input.keyBuffer, "");
  const oneEffect = oneSplice(one);
  assert.equal(oneEffect.from, 2);
  assert.equal(oneEffect.to, 3);
  assert.equal(oneEffect.text, "x");
  assert.equal(oneEffect.caret, 2);
  assert.equal(oneEffect.yank, null);

  const three = run("al‸pha\n", ["3", "r", "x"]);
  assert.equal(three.steps[1].match, "partial");
  assert.equal(three.steps[1].vim.input.prefixRepeat, "3");
  assert.equal(three.steps[1].vim.input.keyBuffer, "r");
  assert.equal(three.show, "alxx‸x\n");
  assert.equal(three.doc, "alxxx\n");
  const threeEffect = oneSplice(three);
  assert.equal(threeEffect.from, 2);
  assert.equal(threeEffect.to, 5);
  assert.equal(threeEffect.text, "xxx");
  assert.equal(threeEffect.caret, 4);
  assert.equal(threeEffect.yank, null);

  const cancel = run("al‸pha\n", ["r", "Escape", "x"]);
  assert.equal(cancel.show, "al‸ha\n");
  const arrow = run("al‸pha\n", ["r", "ArrowLeft"]);
  assert.equal(arrow.show, "al‸pha\n");
  assert.equal(arrow.steps[1].match, "none");
  assert.equal(arrow.steps[1].consumed, true);
  assert.equal(arrow.steps[1].effect, null);
  assert.equal(arrow.vim.input.keyBuffer, "");
});

test("VR.2", () => {
  const end = run("alpha‸\nbeta\n", ["r", "x"]);
  assert.equal(end.show, "alpha‸\nbeta\n");
  assert.equal(end.doc, "alpha\nbeta\n");
  assert.equal(end.steps[1].match, "full");
  assert.equal(end.steps[1].effect, null);
  assert.equal(end.steps.some((step) => step.effect && step.effect.type === "forward-delete"), false);

  const over = run("al‸pha\n", ["5", "r", "x"]);
  assert.equal(over.show, "al‸pha\n");
  assert.equal(over.doc, "alpha\n");
  assert.equal(over.steps.at(-1).effect, null);
  assert.equal(over.vim.input.keyBuffer, "");

  const joined = run("alp‸ha\nbeta\n", ["3", "r", "x"]);
  assert.equal(joined.show, "alp‸ha\nbeta\n");
  assert.equal(joined.doc, "alpha\nbeta\n");
  const inside = run("alp‸ha\nbeta\n", ["2", "r", "x"]);
  assert.equal(inside.show, "alpx‸x\nbeta\n");
  assert.equal(oneSplice(inside).text, "xx");

  const marker = run("a‸{c1}bc\n", ["r", "x"]);
  assert.equal(marker.show, "a‸{c1}bc\n");
  assert.equal(marker.doc, "a{c1}bc\n");
  const insideMarker = run("ab{‸c1}x\n", ["r", "x"]);
  assert.equal(insideMarker.show, "ab{‸c1}x\n");
  const closer = run("ab‸{/c1}c\n", ["r", "x"]);
  assert.equal(closer.show, "ab‸{/c1}c\n");
  const reach = run("ab‸c{c1}de\n", ["3", "r", "x"]);
  assert.equal(reach.show, "ab‸c{c1}de\n");
  assert.equal(reach.doc, "abc{c1}de\n");
  const before = run("ab‸c{c1}de\n", ["r", "x"]);
  assert.equal(before.show, "ab‸x{c1}de\n");
  assert.equal(oneSplice(before).text, "x");

  const pending = run("al‸pha\n", ["d", "r", "x"]);
  assert.equal(pending.steps[1].match, "none");
  assert.equal(pending.vim.input.operator, null);
  assert.equal(pending.show, "al‸ha\n");
});

test("VR.3", () => {
  const out = run("al‸pha\n", ["r", "Enter"]);
  assert.equal(out.show, "al\n‸ha\n");
  assert.equal(out.doc, "al\nha\n");
  assert.equal(out.vim.mode, "normal");
  const effect = oneSplice(out);
  assert.equal(effect.from, 2);
  assert.equal(effect.to, 3);
  assert.equal(effect.text, "\n");
  assert.equal(effect.caret, 3);
  assert.equal(effect.yank, null);

  const counted = run("al‸pha\n", ["3", "r", "Enter"]);
  assert.equal(counted.show, "al\n‸\n");
  assert.equal(counted.doc, "al\n\n");
  const countedEffect = oneSplice(counted);
  assert.equal(countedEffect.text, "\n");
  assert.equal(countedEffect.from, 2);
  assert.equal(countedEffect.to, 5);
  assert.equal(countedEffect.caret, 3);

  const crlf = run("al‸pha\r\n", ["r", "Enter"]);
  assert.equal(crlf.show, "al\r\n‸ha\r\n");
  assert.equal(crlf.doc, "al\r\nha\r\n");
  assert.equal(oneSplice(crlf).text, "\r\n");
  assert.equal(oneSplice(crlf).caret, 4);
});

test("VR.4", () => {
  const once = run("‸alPha\n", ["~"]);
  assert.equal(once.show, "A‸lPha\n");
  assert.equal(once.doc, "AlPha\n");
  assert.equal(once.vim.mode, "normal");
  const onceEffect = oneSplice(once);
  assert.equal(onceEffect.text, "A");
  assert.equal(onceEffect.caret, 1);
  assert.equal(onceEffect.yank, null);

  const four = run("‸alPha\n", ["~", "~", "~", "~"]);
  assert.equal(four.show, "ALpH‸a\n");
  assert.equal(four.doc, "ALpHa\n");
  const counted = run("‸alPha\n", ["4", "~"]);
  assert.equal(counted.show, "ALpH‸a\n");
  const countedEffect = oneSplice(counted);
  assert.equal(countedEffect.text, "ALpH");
  assert.equal(countedEffect.from, 0);
  assert.equal(countedEffect.to, 4);
  assert.equal(countedEffect.caret, 4);

  const end = run("alpha‸\nbeta\n", ["~"]);
  assert.equal(end.show, "alpha‸\nbeta\n");
  assert.equal(end.steps[0].match, "full");
  assert.equal(end.steps[0].effect, null);
  const over = run("alP‸ha\n", ["3", "~"]);
  assert.equal(over.show, "alP‸ha\n");
  assert.equal(over.steps.at(-1).effect, null);
  const fit = run("alP‸ha\n", ["2", "~"]);
  assert.equal(fit.show, "alPHA‸\n");
  assert.equal(oneSplice(fit).text, "HA");

  const marker = run("a‸{c1}bc\n", ["~"]);
  assert.equal(marker.show, "a‸{c1}bc\n");
  assert.equal(marker.steps[0].effect, null);
  const reach = run("ab‸c{c1}d\n", ["2", "~"]);
  assert.equal(reach.show, "ab‸c{c1}d\n");
  const before = run("ab‸c{c1}d\n", ["~"]);
  assert.equal(before.show, "abC‸{c1}d\n");

  const pending = run("‸alPha\n", ["d", "~"]);
  assert.equal(pending.show, "‸alPha\n");
  assert.equal(pending.steps[1].effect, null);
  assert.equal(pending.vim.input.operator, null);
});

test("VR.5", () => {
  const word = run("al‸pha beta\n", ["g", "U", "w"]);
  assert.equal(word.show, "al‸PHA beta\n");
  assert.equal(word.doc, "alPHA beta\n");
  assert.equal(word.vim.mode, "normal");
  assert.equal(word.vim.input.operator, null);
  const wordEffect = oneSplice(word);
  assert.equal(wordEffect.from, 2);
  assert.equal(wordEffect.to, 6);
  assert.equal(wordEffect.text, "PHA ");
  assert.equal(wordEffect.caret, 2);
  assert.equal(wordEffect.yank, null);
  assert.equal(word.vim.register.text, "");

  const back = run("alpha be‸ta\n", ["g", "U", "b"]);
  assert.equal(back.show, "alpha ‸BEta\n");
  assert.equal(back.doc, "alpha BEta\n");
  const backEffect = oneSplice(back);
  assert.equal(backEffect.text, "BE");
  assert.equal(backEffect.from, 6);
  assert.equal(backEffect.to, 8);
  assert.equal(backEffect.caret, 6);

  const lower = run("AL‸PHA beta\n", ["g", "u", "w"]);
  assert.equal(lower.show, "AL‸pha beta\n");
  assert.equal(oneSplice(lower).text, "pha ");
  assert.equal(oneSplice(lower).caret, 2);
  const toggle = run("al‸PHa beta\n", ["g", "~", "w"]);
  assert.equal(toggle.show, "al‸phA beta\n");
  assert.equal(oneSplice(toggle).text, "phA ");
  assert.equal(oneSplice(toggle).caret, 2);
});

test("VR.6", () => {
  const upper = run("al‸pha\n", ["g", "U", "U"]);
  assert.equal(upper.show, "‸ALPHA\n");
  assert.equal(upper.doc, "ALPHA\n");
  assert.equal(upper.vim.mode, "normal");
  assert.equal(upper.vim.input.operator, null);
  const upperEffect = oneSplice(upper);
  assert.equal(upperEffect.text, "ALPHA\n");
  assert.equal(upperEffect.from, 0);
  assert.equal(upperEffect.to, 6);
  assert.equal(upperEffect.caret, 0);
  assert.equal(upperEffect.yank, null);

  const lower = run("AL‸PHA\n", ["g", "u", "u"]);
  assert.equal(lower.show, "‸alpha\n");
  assert.equal(lower.doc, "alpha\n");
  const lowerEffect = oneSplice(lower);
  assert.equal(lowerEffect.text, "alpha\n");
  assert.equal(lowerEffect.caret, 0);

  const toggle = run("al‸PHA\n", ["g", "~", "~"]);
  assert.equal(toggle.show, "‸ALpha\n");
  assert.equal(toggle.doc, "ALpha\n");
  const toggleEffect = oneSplice(toggle);
  assert.equal(toggleEffect.text, "ALpha\n");
  assert.equal(toggleEffect.caret, 0);

  assert.equal(run("al‸pha\n", ["g", "U", "g", "U"]).show, "‸ALPHA\n");
  assert.equal(run("AL‸PHA\n", ["g", "u", "g", "u"]).show, "‸alpha\n");
  assert.equal(run("al‸PHA\n", ["g", "~", "g", "~"]).show, "‸ALpha\n");
});

test("VR.7", () => {
  const out = run("‸straße\n", ["g", "U", "U"]);
  assert.equal(out.show, "‸STRAßE\n");
  assert.equal(out.doc, "STRAßE\n");
  const effect = oneSplice(out);
  assert.equal(effect.text, "STRAßE\n");
  assert.equal(effect.from, 0);
  assert.equal(effect.to, "straße\n".length);
  assert.equal(effect.caret, 0);
  assert.equal(effect.yank, null);
});

function taken(state, result) {
  let doc = state.doc;
  let cursor = state.cursor;
  let anchor = state.anchor;
  const effect = result.effect;
  if (effect && effect.type === "caret") {
    anchor = effect.anchor;
    cursor = effect.cursor;
  } else if (effect && effect.type === "splice") {
    doc = doc.slice(0, effect.from) + effect.text + doc.slice(effect.to);
    cursor = effect.caret;
    anchor = cursor;
  }
  return { doc, cursor, anchor, vim: result.vim, effect, result, show: show(doc, cursor, anchor) };
}

function submit(start, fields, opts = {}) {
  const base = opts.from || run(start, opts.keys || [], opts);
  const vim = base.vim;
  const snapshot = structuredClone(vim);
  const result = vimSubmit({
    line: fields.line,
    kind: fields.kind,
    forward: fields.forward,
    vim,
    doc: base.doc,
    cursor: base.cursor,
    anchor: base.anchor,
    raw: opts.raw === true,
    flag: fields.flag,
  });
  assert.deepEqual(vim, snapshot);
  return taken(base, result);
}

test("VS.1", () => {
  const slash = run("‸alpha beta\n", ["/"]);
  assert.equal(slash.steps[0].match, "full");
  assert.equal(slash.steps[0].consumed, true);
  assert.equal(slash.steps[0].effect.type, "prompt");
  assert.equal(slash.steps[0].effect.kind, "search");
  assert.equal(slash.steps[0].effect.forward, true);
  assert.equal(slash.show, "‸alpha beta\n");
  assert.equal(slash.doc, "alpha beta\n");
  assert.equal(slash.vim.mode, "normal");
  assert.equal(slash.steps.filter((step) => step.effect && step.effect.type === "splice").length, 0);

  const asked = run("alpha beta gam‸ma\n", ["?"]);
  assert.equal(asked.steps[0].effect.type, "prompt");
  assert.equal(asked.steps[0].effect.kind, "search");
  assert.equal(asked.steps[0].effect.forward, false);
  assert.equal(asked.show, "alpha beta gam‸ma\n");
  assert.equal(asked.doc, "alpha beta gamma\n");

  const beta = submit("‸alpha beta\n", { line: "beta", kind: "search", forward: true }, { from: slash });
  assert.equal(beta.result.match, "full");
  assert.equal(beta.result.consumed, true);
  assert.equal(beta.effect.type, "caret");
  assert.equal(beta.effect.anchor, beta.effect.cursor);
  assert.equal(beta.show, "alpha ‸beta\n");
  assert.equal(beta.doc, "alpha beta\n");
  assert.equal(beta.vim.mode, "normal");
  assert.equal(beta.vim.search.pattern, "beta");
  assert.equal(beta.vim.search.forward, true);
  assert.equal(beta.vim.search.whole, false);

  const wrapped = submit("alpha be‸ta\n", { line: "alpha", kind: "search", forward: true });
  assert.equal(wrapped.show, "‸alpha beta\n");
  assert.equal(wrapped.doc, "alpha beta\n");

  const backward = submit("alpha beta gam‸ma\n", { line: "alpha", kind: "search", forward: false }, { from: asked });
  assert.equal(backward.show, "‸alpha beta gamma\n");
  assert.equal(backward.vim.search.forward, false);

  const miss = submit("‸alpha\n", { line: "zeta", kind: "search", forward: true });
  assert.equal(miss.show, "‸alpha\n");
  assert.equal(miss.effect, null);
  assert.equal(miss.vim.mode, "normal");
  assert.equal(miss.vim.search.pattern, "zeta");
  assert.equal(run(miss.show, ["n"], { vim: miss.vim }).show, "‸alpha\n");

  const empty = submit("‸alpha beta\n", { line: "", kind: "search", forward: true }, { from: slash });
  assert.equal(empty.show, "‸alpha beta\n");
  assert.equal(empty.vim.search, null);

  const kept = submit("‸alpha\n", { line: "z".repeat(1001), kind: "search", forward: true }, { from: miss });
  assert.equal(kept.show, "‸alpha\n");
  assert.equal(kept.effect, null);
  assert.equal(kept.vim.search.pattern, "zeta");

  const pattern = "x".repeat(1000);
  const body = `y${pattern}\n`;
  const accepted = submit(`‸${body}`, { line: pattern, kind: "search", forward: true });
  assert.equal(accepted.cursor, 1);
  assert.equal(accepted.doc, body);
  assert.equal(accepted.vim.search.pattern.length, 1000);
  const refused = submit(`‸${"x".repeat(1001)}`, { line: "x".repeat(1001), kind: "search", forward: true });
  assert.equal(refused.cursor, 0);
  assert.equal(refused.effect, null);
  assert.equal(refused.vim.search, null);

  let state = submit("‸a x b x c x\n", { line: "x", kind: "search", forward: true });
  assert.equal(state.show, "a ‸x b x c x\n");
  state = run(state.show, ["n"], { vim: state.vim });
  assert.equal(state.steps[0].effect.type, "caret");
  assert.equal(state.show, "a x b ‸x c x\n");
  state = run(state.show, ["N"], { vim: state.vim });
  assert.equal(state.show, "a ‸x b x c x\n");
  assert.equal(state.vim.search.forward, true);
  state = run(state.show, ["n", "n", "n"], { vim: state.vim });
  assert.equal(state.show, "a ‸x b x c x\n");
  assert.equal(state.doc, "a x b x c x\n");
  assert.equal(state.steps.filter((step) => step.effect && step.effect.type === "splice").length, 0);

  let back = submit("x a x a ‸z\n", { line: "a", kind: "search", forward: false });
  assert.equal(back.show, "x a x ‸a z\n");
  back = run(back.show, ["n"], { vim: back.vim });
  assert.equal(back.show, "x ‸a x a z\n");
  back = run(back.show, ["n"], { vim: back.vim });
  assert.equal(back.show, "x a x ‸a z\n");
  assert.equal(back.vim.search.forward, false);
  back = run(back.show, ["N"], { vim: back.vim });
  assert.equal(back.show, "x ‸a x a z\n");

  const off = vimSubmit({
    flag: false,
    kind: "search",
    line: "beta",
    forward: true,
    vim: slash.vim,
    doc: slash.doc,
    cursor: 0,
    anchor: 0,
  });
  assert.equal(off.match, "none");
  assert.equal(off.consumed, false);
  assert.equal(off.effect, null);
});

test("VS.5", () => {
  const dot = submit("‸abc a.c\n", { line: "a.c", kind: "search", forward: true });
  assert.equal(dot.show, "abc ‸a.c\n");
  assert.equal(dot.doc, "abc a.c\n");
  const upper = submit("‸alpha Alpha\n", { line: "Alpha", kind: "search", forward: true });
  assert.equal(upper.show, "alpha ‸Alpha\n");
  const lower = submit("‸alpha Alpha\n", { line: "alpha", kind: "search", forward: true });
  assert.equal(lower.show, "‸alpha Alpha\n");

  const star = run("‸alpha alphabet alpha\n", ["*"]);
  assert.equal(star.steps[0].effect.type, "caret");
  assert.equal(star.show, "alpha alphabet ‸alpha\n");
  assert.equal(star.doc, "alpha alphabet alpha\n");
  assert.equal(star.vim.search.whole, true);
  assert.equal(star.vim.search.forward, true);
  const hash = run(star.show, ["#"], { vim: star.vim });
  assert.equal(hash.show, "‸alpha alphabet alpha\n");
  assert.equal(hash.doc, star.doc);
  assert.equal(hash.vim.search.forward, false);
  const gsub = run("‸alpha alphabet alpha\n", ["g", "*"]);
  assert.equal(gsub.show, "alpha ‸alphabet alpha\n");
  assert.equal(gsub.vim.search.whole, false);
  const ghash = run("alpha alphabet ‸alpha\n", ["g", "#"]);
  assert.equal(ghash.show, "alpha ‸alphabet alpha\n");
  const comma = run("‸alpha, alpha alpha,\n", ["*"]);
  assert.equal(comma.show, "alpha, alpha ‸alpha,\n");
  assert.equal(comma.doc, "alpha, alpha alpha,\n");

  const only = run("‸alpha alphabet\n", ["*"]);
  assert.equal(only.show, "‸alpha alphabet\n");
  const repeated = run(only.show, ["n"], { vim: only.vim });
  assert.equal(repeated.show, "‸alpha alphabet\n");
  assert.equal(repeated.doc, "alpha alphabet\n");

  for (const keys of [["n"], ["N"], ["*"], ["#"], ["d", "*"], ["d", "n"]]) {
    const out = run("‸alpha alphabet alpha\n", keys);
    assert.equal(out.doc, "alpha alphabet alpha\n", keys.join(""));
    assert.equal(out.steps.filter((step) => step.effect && step.effect.type === "splice").length, 0, keys.join(""));
  }
  const operator = run("‸alpha alphabet alpha\n", ["d", "*"]);
  assert.equal(operator.steps[1].match, "none");
  assert.equal(operator.vim.input.operator, null);
});

test("VS.11", () => {
  const searched = submit("‸one two one\n", { line: "two", kind: "search", forward: true });
  assert.equal(searched.show, "one ‸two one\n");
  const zeroed = run(searched.show, ["0"], { vim: searched.vim });
  assert.equal(zeroed.show, "‸one two one\n");
  const gn = run(zeroed.show, ["g", "n"], { vim: zeroed.vim });
  assert.equal(gn.show, "one «two‸ one\n");
  assert.equal(gn.vim.mode, "visual");
  assert.equal(gn.doc, "one two one\n");
  assert.equal(gn.anchor, 4);
  assert.equal(gn.cursor, 7);
  assert.equal(gn.steps.filter((step) => step.effect && step.effect.type === "splice").length, 0);

  const dgn = run(zeroed.show, ["d", "g", "n"], { vim: zeroed.vim });
  assert.equal(dgn.steps[2].match, "none");
  assert.equal(dgn.steps[2].consumed, true);
  assert.equal(dgn.steps[2].effect, null);
  assert.equal(dgn.show, "‸one two one\n");
  assert.equal(dgn.doc, "one two one\n");
  assert.equal(dgn.vim.mode, "normal");
  assert.equal(dgn.vim.input.operator, null);
  assert.equal(dgn.steps.filter((step) => step.effect && step.effect.type === "splice").length, 0);

  const missed = submit("‸one two one\n", { line: "zeta", kind: "search", forward: true });
  const stay = run(missed.show, ["g", "n"], { vim: missed.vim });
  assert.equal(stay.show, "‸one two one\n");
  assert.equal(stay.vim.mode, "normal");
  assert.equal(stay.doc, "one two one\n");

  const visual = run("«one two‸ one\n", ["g", "n"], { mode: "visual" });
  assert.equal(visual.vim.mode, "visual");
  assert.equal(visual.show, "«one two‸ one\n");
  assert.equal(visual.doc, "one two one\n");

  const end = run(searched.show, ["$"], { vim: searched.vim });
  assert.equal(end.show, "one two one‸\n");
  const backward = run(end.show, ["g", "N"], { vim: end.vim });
  assert.equal(backward.show, "one ‸two« one\n");
  assert.equal(backward.vim.mode, "visual");
  assert.equal(backward.cursor, 4);
  assert.equal(backward.anchor, 7);
  assert.equal(backward.doc, "one two one\n");
});

function ex(start, line, opts = {}) {
  const base = run(start, [":"], opts);
  assert.equal(base.steps[0].effect.type, "prompt");
  assert.equal(base.steps[0].effect.kind, "ex");
  assert.equal(base.show, start);
  return submit(start, { line, kind: "ex" }, { from: base, raw: opts.raw === true });
}

test("VE.1", () => {
  const once = ex("‸banana\nalpha\n", "s/a/o/");
  assert.equal(once.doc, "bonana\nalpha\n");
  assert.equal(once.vim.mode, "normal");
  assert.equal(once.effect.type, "splice");
  assert.equal(once.effect.yank, null);
  assert.equal(Object.hasOwn(once.effect, "group"), false);
  assert.equal(ex("‸banana\nalpha\n", "s/a/o/g").doc, "bonono\nalpha\n");
  assert.equal(ex("‸banana\nalpha\n", "%s/a/o/g").doc, "bonono\nolpho\n");
  assert.equal(ex("‸banana\nalpha\n", "%s/a/o/").doc, "bonana\nalpha\n");
  assert.equal(ex("‸banana\nalpha\n", "su/a/o/").doc, "bonana\nalpha\n");
  assert.equal(ex("‸banana\nalpha\n", "substitute/a/o/").doc, "bonana\nalpha\n");

  assert.equal(ex("‸a/xb\n", "s/\\/x/y/").doc, "ayb\n");
  assert.equal(ex("‸a\\%b\n", "s/\\%/y/").doc, "ayb\n");
  assert.equal(ex("‸ab\n", "s/a/$1&\\1/").doc, "$1&\\1b\n");

  for (const line of [
    "s/a/b/\\%", "s/a/b", "s//b/", "2,3s/a/b/", ".,$s/a/b/",
    "set", "sort", "start", "w", "q", "q!", "wq", "e",
    "g/a/d", "v/a/d", "norm x", "noh", "map", "reg", "delm a", "!ls", "re",
  ]) {
    const out = ex("‸banana\nalpha\n", line);
    assert.equal(out.doc, "banana\nalpha\n", line);
    assert.equal(out.vim.mode, "normal", line);
    if (line === "noh") {
      assert.equal(out.effect && out.effect.type, "nohlsearch", line);
      continue;
    }
    assert.equal(out.effect, null, line);
  }

  const found = submit("‸alpha beta\n", { line: "beta", kind: "search", forward: true });
  for (const name of ["noh", "nohl", "nohls", "nohlsearch"]) {
    const cleared = submit(found.show, { line: name, kind: "ex" }, { from: found });
    assert.equal(cleared.effect && cleared.effect.type, "nohlsearch", name);
    assert.equal(cleared.doc, found.doc, name);
    assert.equal(cleared.show, found.show, name);
    assert.equal(cleared.vim.search.pattern, "beta", name);
    assert.equal(cleared.vim.mode, "normal", name);
  }
  assert.equal(ex("‸alpha\n", "no").effect, null);
  assert.equal(ex("‸alpha\n", "nohlsearch x").effect, null);
  assert.equal(ex("‸alpha\n", "%noh").effect, null);
  assert.equal(VIM_SEARCH_LIMIT, 1000);
  assert.deepEqual(vimMatchStarts("alpha beta\n", "beta", false), [6]);
  assert.deepEqual(vimMatchStarts("alpha beta\n", "a", false), [0, 4, 9]);
  assert.deepEqual(vimMatchStarts("alpha beta\n", "a.c", false), []);
  assert.deepEqual(vimMatchStarts("a.c\n", "a.c", false), [0]);
  assert.deepEqual(vimMatchStarts("alpha\n", "", false), []);
  assert.deepEqual(vimMatchStarts("alpha\n", "a".repeat(1001), false), []);
  assert.deepEqual(vimMatchStarts("alpha alphabet alpha\n", "alpha", true), [0, 15]);

  const rendered = ex("alpha\nbe‸ta\ngamma\n", "d");
  const dd = run("alpha\nbe‸ta\ngamma\n", ["d", "d"]);
  assert.equal(rendered.doc, dd.doc);
  assert.equal(rendered.show, dd.show);
  const raw = ex("alpha\nbe‸ta\ngamma\n", "d", { raw: true });
  const rawDd = run("alpha\nbe‸ta\ngamma\n", ["d", "d"], { raw: true });
  assert.equal(raw.doc, rawDd.doc);
  assert.equal(raw.show, rawDd.show);
  assert.equal(raw.show, "alpha\n‸gamma\n");
  const emptied = ex("alpha\nbe‸ta\ngamma\n", "%d");
  assert.equal(emptied.doc, "");
  assert.equal(emptied.show, "‸");
  assert.equal(emptied.effect.type, "splice");
  assert.equal(emptied.effect.from, 0);
  assert.equal(emptied.effect.to, "alpha\nbeta\ngamma\n".length);

  const joined = ex("al‸pha\nbeta\n", "j");
  const jay = run("al‸pha\nbeta\n", ["J"]);
  assert.equal(joined.doc, jay.doc);
  assert.equal(joined.show, jay.show);
  assert.equal(joined.doc, "alpha beta\n");

  const yanked = ex("‸alpha\n", "y");
  assert.equal(yanked.doc, "alpha\n");
  assert.equal(yanked.vim.register.text, "alpha\n");
  assert.equal(yanked.vim.register.linewise, true);
  assert.equal(run(yanked.show, ["p"], { vim: yanked.vim }).show, "alpha\n‸alpha\n");

  assert.equal(ex("‸alpha\n", "u").effect.direction, "undo");
  assert.equal(ex("‸alpha\n", "undo").effect.direction, "undo");
  assert.equal(ex("‸alpha\n", "red").effect.direction, "redo");
  assert.equal(ex("‸alpha\n", "redo").effect.direction, "redo");
  assert.equal(ex("‸alpha\n", "u").effect.type, "history");
  assert.equal(ex("‸alpha\n", "re").effect, null);

  const visual = run("«alpha‸ beta\n", [":"], { mode: "visual" });
  assert.equal(visual.steps[0].effect.type, "caret");
  assert.equal(visual.vim.mode, "normal");
  assert.equal(visual.doc, "alpha beta\n");
  assert.equal(visual.show, "alpha‸ beta\n");
});

test("ex command prefixes", () => {
  const line = "alpha\nbe‸ta\ngamma\n";
  const brief = ex(line, "d");
  for (const name of ["delete", "del", "de"]) {
    const full = ex(line, name);
    assert.equal(full.doc, brief.doc, name);
    assert.equal(full.show, brief.show, name);
    assert.equal(full.vim.register.text, brief.vim.register.text, name);
    assert.equal(full.vim.register.linewise, brief.vim.register.linewise, name);
  }
  for (const name of ["%delete", "%del", "%d"]) {
    const emptied = ex(line, name);
    assert.equal(emptied.doc, "", name);
    assert.equal(emptied.show, "‸", name);
    assert.equal(emptied.effect.type, "splice", name);
    assert.equal(emptied.effect.text, "", name);
    assert.equal(emptied.effect.from, 0, name);
    assert.equal(emptied.effect.to, "alpha\nbeta\ngamma\n".length, name);
  }
  const bare = ex("alpha\nbe‸ta", "%delete");
  assert.equal(bare.doc, "");
  assert.equal(bare.effect.text, "");
  assert.equal(bare.effect.from, 0);
  assert.equal(bare.effect.to, "alpha\nbeta".length);
  assert.equal(bare.effect.yank.text, "alpha\nbeta\n");
  assert.equal(bare.vim.register.text, "alpha\nbeta\n");
  const joined = ex("al‸pha\nbeta\n", "join");
  const jay = ex("al‸pha\nbeta\n", "j");
  assert.equal(joined.doc, jay.doc);
  assert.equal(joined.show, jay.show);
  const yanked = ex("‸alpha\n", "yank");
  const briefY = ex("‸alpha\n", "y");
  assert.equal(yanked.doc, briefY.doc);
  assert.equal(yanked.vim.register.text, briefY.vim.register.text);
  assert.equal(yanked.vim.register.linewise, true);
  const undone = ex("‸alpha\n", "un");
  const briefU = ex("‸alpha\n", "u");
  assert.equal(undone.effect.type, briefU.effect.type);
  assert.equal(undone.effect.direction, briefU.effect.direction);
  assert.equal(undone.doc, briefU.doc);
  assert.equal(ex("‸alpha\n", "re").effect, null);
  assert.equal(ex("‸alpha\n", "re").doc, "alpha\n");
  assert.equal(ex(line, "delete x").effect, null);
  assert.equal(ex(line, "delete x").doc, "alpha\nbeta\ngamma\n");
  assert.equal(ex("al‸pha\nbeta\n", "%join").effect, null);
  assert.equal(ex("‸alpha\n", "%yank").effect, null);
  assert.equal(ex(line, ".,$delete").effect, null);
  for (const name of ["re", "set", "sort", "start"]) {
    const idle = ex("‸banana\nalpha\n", name);
    assert.equal(idle.effect, null, name);
    assert.equal(idle.doc, "banana\nalpha\n", name);
  }
});

test("VE.10", () => {
  const indent = ex("  ‸banana\n", "s/a/o/");
  assert.equal(indent.doc, "  bonana\n");
  assert.equal(indent.show, "  ‸bonana\n");
  assert.equal(indent.cursor, 2);
  assert.equal(indent.vim.mode, "normal");
  assert.equal(indent.vim.column, null);

  const every = ex("  ‸banana\n", "s/a/o/g");
  assert.equal(every.show, "  ‸bonono\n");
  assert.equal(every.doc, "  bonono\n");

  const second = ex("banana\n  ‸alpha\n", "s/a/o/");
  assert.equal(second.doc, "banana\n  olpha\n");
  assert.equal(second.show, "banana\n  ‸olpha\n");

  const last = ex("  banana\n  ‸alpha\n", "%s/a/o/g");
  assert.equal(last.doc, "  bonono\n  olpho\n");
  assert.equal(last.show, "  bonono\n  ‸olpho\n");

  const only = ex("  ‸banana\nalpha\n", "%s/b/c/");
  assert.equal(only.doc, "  canana\nalpha\n");
  assert.equal(only.show, "  ‸canana\nalpha\n");

  const none = ex("  ‸banana\n", "s/z/o/");
  assert.equal(none.show, "  ‸banana\n");
  assert.equal(none.effect, null);
  assert.equal(none.doc, "  banana\n");
});

test("VV.1", () => {
  const selected = run("al‸pha\n", ["v"]);
  assert.equal(selected.show, "al«p‸ha\n");
  assert.equal(selected.vim.mode, "visual");
  assert.equal(selected.doc, "alpha\n");
  assert.equal(selected.steps[0].effect.type, "caret");
  const cut = run("al‸pha\n", ["v", "d"]);
  assert.equal(cut.show, "al‸ha\n");
  assert.equal(cut.doc, "alha\n");
  assert.equal(cut.vim.mode, "normal");
  assert.equal(cut.vim.input.operator, null);
  assert.equal(oneSplice(cut).text, "");
  assert.equal(oneSplice(cut).yank.text, "p");
  const end = run("alpha‸\n", ["v"]);
  assert.equal(end.show, "alpha‸\n");
  assert.equal(end.anchor, end.cursor);
  assert.equal(end.vim.mode, "visual");
  assert.equal(end.doc, "alpha\n");
  const bare = run("alpha‸", ["v"]);
  assert.equal(bare.show, "alpha‸");
  assert.equal(bare.anchor, bare.cursor);
  assert.equal(bare.vim.mode, "visual");
  const empty = run("‸", ["v"]);
  assert.equal(empty.show, "‸");
  assert.equal(empty.anchor, empty.cursor);
  assert.equal(empty.vim.mode, "visual");
});

test("VV.2", () => {
  const word = "‸alpha beta gamma\n";
  const end = run(word, ["v", "e"]);
  assert.equal(end.show, "«alpha‸ beta gamma\n");
  assert.equal(end.vim.mode, "visual");
  assert.equal(end.steps[1].effect.type, "caret");
  assert.equal(end.steps[1].effect.anchor, 0);
  assert.equal(end.steps[1].effect.cursor, 5);
  const next = run(word, ["v", "w"]);
  assert.equal(next.show, "«alpha b‸eta gamma\n");
  assert.equal(next.vim.mode, "visual");
  assert.equal(next.steps[1].effect.cursor, 7);
  const dollar = run(word, ["v", "$"]);
  assert.equal(dollar.show, "«alpha beta gamma‸\n");
  assert.equal(dollar.vim.mode, "visual");
  assert.equal(dollar.steps[1].effect.type, "caret");
  assert.equal(run(word, ["v", "E"]).show, end.show);
  assert.equal(run(word, ["v", "W"]).show, next.show);
  const view = run("«a‸lpha\n", ["l"], { mode: "visual" });
  assertView(view, "l", 1);
  assert.equal(view.vim.mode, "visual");
  assert.equal(view.show, "«a‸lpha\n");
  const screen = run("«a‸lpha\n", ["g", "0"], { mode: "visual", layout: true });
  assertView(screen, "g0", 1);
  assert.equal(screen.vim.mode, "visual");
  const cut = run("‸alpha beta\n", ["v", "w", "d"]);
  assert.equal(cut.show, "‸eta\n");
  assert.equal(cut.doc, "eta\n");
  assert.equal(cut.vim.mode, "normal");
});

test("VV.3", () => {
  const word = "‸alpha beta\n";
  const deleted = run(word, ["v", "e", "d"]);
  assert.equal(deleted.show, "‸ beta\n");
  assert.equal(deleted.doc, " beta\n");
  assert.equal(deleted.vim.mode, "normal");
  assert.equal(deleted.vim.input.operator, null);
  assert.equal(oneSplice(deleted).text, "");
  const changed = run(word, ["v", "e", "c"]);
  assert.equal(changed.show, "‸ beta\n");
  assert.equal(changed.doc, " beta\n");
  assert.equal(changed.vim.mode, "insert");
  assert.equal(changed.vim.input.operator, null);
  assert.equal(oneSplice(changed).text, "");
  const substituted = run(word, ["v", "e", "s"]);
  assert.equal(substituted.show, changed.show);
  assert.equal(substituted.doc, changed.doc);
  assert.equal(substituted.vim.mode, "insert");
  assert.equal(oneSplice(substituted).text, "");
  const yanked = run(word, ["v", "e", "y"]);
  assert.equal(yanked.show, "‸alpha beta\n");
  assert.equal(yanked.doc, "alpha beta\n");
  assert.equal(yanked.vim.mode, "normal");
  assert.equal(yanked.vim.input.operator, null);
  const yank = oneSplice(yanked);
  assert.equal(yank.text, "alpha");
  assert.equal(yank.from, 0);
  assert.equal(yank.to, 5);
  assert.equal(yank.caret, 0);
  assert.equal(yank.yank.text, "alpha");
  assert.equal(yank.yank.linewise, false);
  assert.equal(yanked.vim.register.text, "alpha");
  assert.equal(yanked.vim.register.linewise, false);
  const upper = run(word, ["v", "e", "U"]);
  assert.equal(upper.show, "‸ALPHA beta\n");
  assert.equal(upper.doc, "ALPHA beta\n");
  assert.equal(upper.vim.mode, "normal");
  assert.equal(upper.vim.input.operator, null);
  const raised = oneSplice(upper);
  assert.equal(raised.type, "splice");
  assert.equal(raised.text, "ALPHA");
  assert.notEqual(raised.type, "history");
  assert.equal(raised.yank, null);
  const lower = run("‸ALPHA beta\n", ["v", "e", "u"]);
  assert.equal(lower.show, "‸alpha beta\n");
  assert.equal(lower.doc, "alpha beta\n");
  assert.equal(lower.vim.mode, "normal");
  const dropped = oneSplice(lower);
  assert.equal(dropped.type, "splice");
  assert.equal(dropped.text, "alpha");
  assert.notEqual(dropped.type, "history");
});

test("VV.4", () => {
  const collapse = run("al‸pha\n", ["v", "v"]);
  assert.equal(collapse.vim.mode, "normal");
  assert.equal(collapse.anchor, collapse.cursor);
  assert.equal(collapse.show, "alp‸ha\n");
  assert.equal(collapse.doc, "alpha\n");
  const lineOff = run("al‸pha\n", ["V", "V"]);
  assert.equal(lineOff.vim.mode, "normal");
  assert.equal(lineOff.anchor, lineOff.cursor);
  assert.equal(lineOff.doc, "alpha\n");
  const toLine = run("al‸pha\n", ["v", "V"]);
  assert.equal(toLine.vim.mode, "visual-line");
  assert.notEqual(toLine.anchor, toLine.cursor);
  assert.equal(toLine.doc, "alpha\n");
  const toChar = run("al‸pha\n", ["V", "v"]);
  assert.equal(toChar.vim.mode, "visual");
  assert.equal(toChar.doc, "alpha\n");
  const selected = run("alpha\n\nbe‸ta\n\ngamma\n", ["V"]);
  assert.equal(selected.vim.mode, "visual-line");
  assert.equal(selected.show, "alpha\n\n«beta‸\n\ngamma\n");
  const raw = run("alpha\nbe‸ta\ngamma\n", ["V"], { raw: true });
  assert.equal(raw.vim.mode, "visual-line");
  assert.equal(raw.show, "alpha\n«beta‸\ngamma\n");
});

test("VV.9", () => {
  const word = "‸alpha beta\n";
  for (const key of ["S", "R"]) {
    const visual = run(word, ["v", "e", key]);
    assert.equal(visual.steps[2].match, "none", key);
    assert.equal(visual.steps[2].consumed, true, key);
    assert.equal(visual.steps[2].effect, null, key);
    assert.equal(visual.vim.mode, "visual", key);
    assert.equal(visual.show, "«alpha‸ beta\n", key);
    assert.equal(visual.doc, "alpha beta\n", key);
  }
  const rendered = "alpha\n\nbe‸ta\n\ngamma\n";
  const changed = run(rendered, ["V", "S"]);
  assert.equal(changed.show, "alpha\n\n‸\n\ngamma\n");
  assert.equal(changed.doc, "alpha\n\n\n\ngamma\n");
  assert.equal(changed.vim.mode, "insert");
  const splice = oneSplice(changed);
  assert.equal(splice.text, "\n");
  assert.equal(splice.caret, 7);
  const replaced = run(rendered, ["V", "R"]);
  assert.equal(replaced.show, changed.show);
  assert.equal(replaced.doc, changed.doc);
  assert.equal(replaced.vim.mode, "insert");
  assert.equal(oneSplice(replaced).text, "\n");
  const raw = run("alpha\nbe‸ta\ngamma\n", ["V", "S"], { raw: true });
  assert.equal(raw.show, "alpha\n‸\ngamma\n");
  assert.equal(raw.doc, "alpha\n\ngamma\n");
  assert.equal(raw.vim.mode, "insert");
  assert.equal(oneSplice(raw).text, "\n");
  const rawR = run("alpha\nbe‸ta\ngamma\n", ["V", "R"], { raw: true });
  assert.equal(rawR.show, raw.show);
  assert.equal(rawR.doc, raw.doc);
  assert.equal(rawR.vim.mode, "insert");
});

test("VV.10", () => {
  const rendered = run("alpha\n\nbe‸ta\n\ngamma\n", ["V", "d"]);
  assert.equal(rendered.show, "alpha\n\n‸gamma\n");
  assert.equal(rendered.doc, "alpha\n\ngamma\n");
  assert.equal(rendered.vim.mode, "normal");
  assert.equal(rendered.vim.input.operator, null);
  const gap = oneSplice(rendered);
  assert.equal(gap.text, "");
  assert.equal(gap.yank.text, "beta\n\n");
  assert.equal(gap.yank.linewise, true);
  const raw = run("alpha\nbe‸ta\ngamma\n", ["V", "d"], { raw: true });
  assert.equal(raw.show, "alpha\n‸gamma\n");
  assert.equal(raw.doc, "alpha\ngamma\n");
  assert.equal(raw.vim.mode, "normal");
  const line = oneSplice(raw);
  assert.equal(line.text, "");
  assert.equal(line.yank.text, "beta\n");
  assert.equal(line.yank.linewise, true);
  const alone = run("alpha\n\nbe‸ta\n\ngamma\n", ["V"]);
  assert.equal(alone.vim.mode, "visual-line");
  assert.equal(alone.show, "alpha\n\n«beta‸\n\ngamma\n");
  assert.equal(alone.doc, "alpha\n\nbeta\n\ngamma\n");
});

function noCommentAdd(out) {
  assert.equal(out.steps.some((step) => step.effect && step.effect.type === "comment-add"), false);
}

test("visual gc adds a comment", () => {
  const visual = run("«alp‸ha", ["g", "c"], { mode: "visual" });
  assert.equal(visual.doc, "alpha");
  assert.equal(visual.anchor, 0);
  assert.equal(visual.cursor, 3);
  assert.equal(visual.show, "«alp‸ha");
  assert.equal(visual.vim.mode, "visual");
  assert.equal(visual.vim.input.keyBuffer, "");
  assert.equal(visual.vim.input.operator, null);
  assert.equal(last(visual).match, "full");
  assert.equal(last(visual).consumed, true);
  assert.equal(last(visual).effect.type, "comment-add");

  const line = run("«alp‸ha", ["g", "c"], { mode: "visual-line" });
  assert.equal(line.doc, "alpha");
  assert.equal(line.anchor, 0);
  assert.equal(line.cursor, 3);
  assert.equal(line.vim.mode, "visual-line");
  assert.equal(last(line).effect.type, "comment-add");

  const normal = run("alp‸ha", ["g", "c"]);
  assert.equal(normal.doc, "alpha");
  assert.equal(normal.show, "alp‸ha");
  assert.equal(normal.vim.mode, "normal");
  noCommentAdd(normal);

  const pending = run("alp‸ha", ["d", "g", "c"]);
  assert.equal(pending.doc, "alpha");
  assert.equal(pending.show, "alp‸ha");
  noCommentAdd(pending);

  const upper = run("«alp‸ha", ["g", "C"], { mode: "visual" });
  assert.equal(upper.doc, "alpha");
  assert.equal(upper.anchor, 0);
  assert.equal(upper.cursor, 3);
  assert.equal(upper.show, "«alp‸ha");
  assert.equal(upper.vim.mode, "visual");
  noCommentAdd(upper);

  const empty = run("alp‸ha", ["g", "c"], { mode: "visual" });
  assert.equal(empty.doc, "alpha");
  assert.equal(empty.anchor, empty.cursor);
  assert.equal(empty.vim.mode, "visual");
  noCommentAdd(empty);

  const alt = run("«alp‸ha", ["g", { key: "c", alt: true }], { mode: "visual" });
  assert.equal(alt.doc, "alpha");
  assert.equal(alt.show, "«alp‸ha");
  assert.equal(alt.vim.mode, "visual");
  noCommentAdd(alt);

  const off = run("«alp‸ha", ["g", "c"], { mode: "visual", flag: false });
  assert.equal(off.doc, "alpha");
  assert.equal(off.anchor, 0);
  assert.equal(off.cursor, 3);
  noCommentAdd(off);
});

function noCommentEffect(out) {
  for (const step of out.steps) {
    const type = step.effect && step.effect.type;
    assert.notEqual(type, "comment-add");
    assert.notEqual(type, "comment-current");
  }
}

function assertCommentCurrent(out, id, mode) {
  const step = last(out);
  assert.equal(step.match, "full");
  assert.equal(step.consumed, true);
  assert.deepEqual(step.effect, { type: "comment-current", id });
  assert.equal(out.vim.mode, mode);
  assert.equal(out.vim.input.keyBuffer, "");
  assert.equal(out.vim.input.operator, null);
}

test("gc on a comment makes that thread current", () => {
  const prose = "See {c1}mine{/c1} now.";
  const on = run("See {c1}m‸ine{/c1} now.", ["g", "c"]);
  assert.equal(on.doc, prose);
  assert.equal(on.show, "See {c1}m‸ine{/c1} now.");
  assertCommentCurrent(on, "c1", "normal");

  const lastChar = run("See {c1}min‸e{/c1} now.", ["g", "c"]);
  assert.equal(lastChar.doc, prose);
  assertCommentCurrent(lastChar, "c1", "normal");

  const off = run("See {c1}mine{/c1} ‸now.", ["g", "c"]);
  assert.equal(off.doc, prose);
  assert.equal(off.vim.mode, "normal");
  noCommentEffect(off);

  const opener = run("See ‸{c1}mine{/c1} now.", ["g", "c"]);
  assert.equal(opener.doc, prose);
  noCommentEffect(opener);

  const closer = run("See {c1}mine‸{/c1} now.", ["g", "c"]);
  assert.equal(closer.doc, prose);
  noCommentEffect(closer);

  const nested = "{c1}aa{c2}bb{/c2}cc{/c1}";
  const inner = run("{c1}aa{c2}b‸b{/c2}cc{/c1}", ["g", "c"]);
  assert.equal(inner.doc, nested);
  assertCommentCurrent(inner, "c2", "normal");
  const before = run("{c1}a‸a{c2}bb{/c2}cc{/c1}", ["g", "c"]);
  assertCommentCurrent(before, "c1", "normal");
  const after = run("{c1}aa{c2}bb{/c2}c‸c{/c1}", ["g", "c"]);
  assertCommentCurrent(after, "c1", "normal");

  const held = run("See {c1}«mine‸{/c1} now.", ["g", "c"], { mode: "visual" });
  assert.equal(held.doc, prose);
  assert.equal(held.show, "See {c1}«mine‸{/c1} now.");
  assertCommentCurrent(held, "c1", "visual");

  const heldLine = run("See {c1}«mine‸{/c1} now.", ["g", "c"], { mode: "visual-line" });
  assert.equal(heldLine.doc, prose);
  assertCommentCurrent(heldLine, "c1", "visual-line");

  const crossing = run("«See {c1}mi‸ne{/c1} now.", ["g", "c"], { mode: "visual" });
  assert.equal(crossing.doc, prose);
  assert.equal(crossing.vim.mode, "visual");
  assert.equal(last(crossing).effect.type, "comment-add");

  const empty = run("See {c1}m‸ine{/c1} now.", ["g", "c"], { mode: "visual" });
  assert.equal(empty.doc, prose);
  assert.equal(empty.anchor, empty.cursor);
  assertCommentCurrent(empty, "c1", "visual");

  const pending = run("See {c1}m‸ine{/c1} now.", ["d", "g", "c"]);
  assert.equal(pending.doc, prose);
  noCommentEffect(pending);

  const upper = run("See {c1}m‸ine{/c1} now.", ["g", "C"]);
  assert.equal(upper.doc, prose);
  noCommentEffect(upper);

  const alt = run("See {c1}m‸ine{/c1} now.", ["g", { key: "c", alt: true }]);
  assert.equal(alt.doc, prose);
  noCommentEffect(alt);

  const flag = run("See {c1}m‸ine{/c1} now.", ["g", "c"], { flag: false });
  assert.equal(flag.doc, prose);
  noCommentEffect(flag);
});

function withMarks(doc, anchor, cursor) {
  let out = "";
  for (let i = 0; i <= doc.length; i += 1) {
    if (i === anchor) out += "«";
    if (i === cursor) out += CARET;
    if (i < doc.length) out += doc[i];
  }
  return out;
}

test("visual gc inside a source fence writes the line-range selection", () => {
  const fence = "```js\none\ntwo\nthree\n```\n";
  const two = fence.indexOf("two");
  const three = fence.indexOf("three");
  const closer = fence.indexOf("```", 3);
  const visual = run(withMarks(fence, two, two + 2), ["g", "c"], { mode: "visual" });
  assert.equal(visual.doc, fence);
  assert.equal(visual.vim.mode, "visual");
  assert.equal(visual.vim.input.keyBuffer, "");
  assert.deepEqual(last(visual).effect, { type: "comment-add", anchor: two, cursor: three });

  const line = run(withMarks(fence, two + 1, three + 2), ["g", "c"], { mode: "visual-line" });
  assert.equal(line.vim.mode, "visual-line");
  assert.deepEqual(last(line).effect, { type: "comment-add", anchor: two, cursor: closer });

  const opener = run(withMarks(fence, 0, 3), ["g", "c"], { mode: "visual" });
  assert.deepEqual(last(opener).effect, { type: "comment-add" });

  const before = `see\n${fence}`;
  const outside = run(withMarks(before, 0, before.indexOf("two") + 1), ["g", "c"], { mode: "visual" });
  assert.deepEqual(last(outside).effect, { type: "comment-add" });
  const after = `${fence}tail\n`;
  const past = run(withMarks(after, after.indexOf("two"), after.indexOf("tail") + 2), ["g", "c"], { mode: "visual" });
  assert.deepEqual(last(past).effect, { type: "comment-add" });

  const host = "```js\none\ntwo\nthree\nfour\n```\n";
  const marked = `${host}\`\`\`comment c1 2-3\n\n\`\`\`\n`;
  const onTwo = marked.indexOf("two");
  const onThree = marked.indexOf("three");
  const onFour = marked.indexOf("four");
  const onOne = marked.indexOf("one");
  const normal = run(withMarks(marked, onTwo + 1, onTwo + 1), ["g", "c"]);
  assertCommentCurrent(normal, "c1", "normal");
  const off = run(withMarks(marked, onOne + 1, onOne + 1), ["g", "c"]);
  noCommentEffect(off);
  const later = run(withMarks(marked, onFour + 1, onFour + 1), ["g", "c"]);
  noCommentEffect(later);

  const held = run(withMarks(marked, onTwo, onTwo + 2), ["g", "c"], { mode: "visual" });
  assert.equal(held.vim.mode, "visual");
  assert.deepEqual(last(held).effect, {
    type: "comment-current",
    id: "c1",
    anchor: onTwo,
    cursor: onThree,
  });
  const wider = run(withMarks(marked, onTwo + 1, onFour + 1), ["g", "c"], { mode: "visual" });
  assert.deepEqual(last(wider).effect, {
    type: "comment-add",
    anchor: onTwo,
    cursor: marked.indexOf("```", 3),
  });

  const nested = `${host}\`\`\`comment c1 1-4\n\n\`\`\`\n\`\`\`comment c2 2-3\n\n\`\`\`\n`;
  const inner = run(withMarks(nested, nested.indexOf("two"), nested.indexOf("two") + 2), ["g", "c"], { mode: "visual" });
  assert.deepEqual(last(inner).effect, {
    type: "comment-current",
    id: "c2",
    anchor: nested.indexOf("two"),
    cursor: nested.indexOf("three"),
  });
  const tied = `${host}\`\`\`comment c1 2-3\n\n\`\`\`\n\`\`\`comment c2 2-3\n\n\`\`\`\n`;
  const same = run(withMarks(tied, tied.indexOf("two") + 1, tied.indexOf("two") + 1), ["g", "c"]);
  assertCommentCurrent(same, "c1", "normal");
});

function insertedSplice(out) {
  const splices = out.steps.filter((step) => step.effect && step.effect.type === "splice" && step.effect.from === step.effect.to);
  assert.equal(splices.length, 1);
  assert.equal(splices[0].match, "full");
  assert.equal(splices[0].consumed, true);
  assert.equal(Object.hasOwn(splices[0].effect, "group"), false);
  return splices[0].effect;
}

test("VY.1", () => {
  const put = run("‸alpha\n\nbeta\n", ["y", "y", "p"]);
  assert.equal(put.show, "alpha\n\n‸alpha\n\nbeta\n");
  assert.equal(put.doc, "alpha\n\nalpha\n\nbeta\n");
  assert.equal(put.vim.mode, "normal");
  assert.equal(put.vim.register.text, "alpha\n");
  assert.equal(put.vim.register.linewise, true);
  const effect = insertedSplice(put);
  assert.equal(effect.text, "alpha\n\n");
  assert.equal(effect.caret, "alpha\n\n".length);
  assert.equal(effect.yank, null);

  const spaced = run("  ‸alpha\n\nbeta\n", ["y", "y", "p"]);
  assert.equal(spaced.show, "  alpha\n\n  ‸alpha\n\nbeta\n");
  assert.equal(insertedSplice(spaced).text, "  alpha\n\n");
  assert.equal(insertedSplice(spaced).caret, "  alpha\n\n  ".length);

  const before = run("‸alpha\n\nbeta\n", ["y", "y", "P"]);
  assert.equal(before.show, "‸alpha\nalpha\n\nbeta\n");
  assert.equal(insertedSplice(before).text, "alpha\n");

  const end = run("‸alpha\n", ["y", "y", "p"]);
  assert.equal(end.show, "alpha\n‸alpha\n");
  assert.equal(insertedSplice(end).text, "alpha\n");

  const raw = run("‸alpha\nbeta\n", ["y", "y", "p"], { raw: true });
  assert.equal(raw.show, "alpha\n‸alpha\nbeta\n");
  assert.equal(raw.doc, "alpha\nalpha\nbeta\n");
  assert.equal(insertedSplice(raw).text, "alpha\n");

  const crlf = run("‸alpha\r\n\r\nbeta\r\n", ["y", "y", "p"]);
  assert.equal(crlf.show, "alpha\r\n\r\n‸alpha\r\n\r\nbeta\r\n");
  assert.equal(insertedSplice(crlf).text, "alpha\r\n\r\n");
});

test("linewise yank of an unterminated line", () => {
  const yanked = run("alpha\n‸beta", ["y", "y"]);
  assert.equal(yanked.doc, "alpha\nbeta");
  assert.equal(yanked.vim.register.text, "alpha\nbeta\n");
  assert.equal(yanked.vim.register.linewise, true);
  const yank = oneSplice(yanked);
  assert.equal(yank.text, "alpha\nbeta");
  assert.equal(yank.from, 0);
  assert.equal(yank.to, "alpha\nbeta".length);
  assert.equal(yank.yank.text, "alpha\nbeta\n");
  assert.equal(yank.yank.linewise, true);
  const put = run(yanked.show, ["p"], { vim: yanked.vim });
  assert.equal(put.show, "alpha\nbeta\n‸alpha\nbeta\n");
  assert.equal(put.doc, "alpha\nbeta\nalpha\nbeta\n");
  const inserted = insertedSplice(put);
  assert.equal(inserted.text, "\nalpha\nbeta\n");
  assert.equal(inserted.from, "alpha\nbeta".length);
  assert.equal(inserted.to, inserted.from);
  assert.equal(inserted.yank, null);

  const crlf = run("alpha\r\n‸beta", ["y", "y"]);
  assert.equal(crlf.doc, "alpha\r\nbeta");
  assert.equal(crlf.vim.register.text, "alpha\r\nbeta\r\n");
  assert.equal(oneSplice(crlf).text, "alpha\r\nbeta");
  assert.equal(oneSplice(crlf).yank.text, "alpha\r\nbeta\r\n");
  assert.equal(run(crlf.show, ["p"], { vim: crlf.vim }).show, "alpha\r\nbeta\r\n‸alpha\r\nbeta\r\n");

  const visual = run("alpha\n‸beta", ["V", "y"]);
  assert.equal(visual.doc, "alpha\nbeta");
  assert.equal(visual.vim.register.text, "alpha\nbeta\n");
  const visualYank = oneSplice(visual);
  assert.equal(visualYank.text, "alpha\nbeta");
  assert.equal(visualYank.yank.text, "alpha\nbeta\n");

  const cut = run("alpha\n‸beta", ["V", "d"]);
  assert.equal(cut.doc, "");
  assert.equal(cut.vim.register.text, "alpha\nbeta\n");
  assert.equal(oneSplice(cut).text, "");
  assert.equal(oneSplice(cut).yank.text, "alpha\nbeta\n");
  assert.equal(oneSplice(cut).from, 0);
  assert.equal(oneSplice(cut).to, "alpha\nbeta".length);

  const exed = run("alpha\n‸beta", ["V", "x"]);
  assert.equal(exed.doc, "");
  const exedEffect = oneSplice(exed);
  assert.equal(exedEffect.text, "");
  assert.equal(exedEffect.from, 0);
  assert.equal(exedEffect.to, "alpha\nbeta".length);
  assert.equal(exedEffect.yank.text, "alpha\nbeta\n");
  assert.equal(exedEffect.yank.linewise, true);

  const only = run("‸\n", ["y", "y"]);
  assert.equal(only.doc, "\n");
  assert.equal(only.vim.register.text, "\n");
  assert.equal(oneSplice(only).yank.text, "\n");
  const pasted = run(only.show, ["p"], { vim: only.vim });
  assert.equal(pasted.steps[0].effect.type, "splice");

  const shifted = run("- a\n- ‸b", ["y", "y", "]", "p"]);
  assert.equal(shifted.doc, "- a\n- b\n\t- b\n");
  assert.equal(shifted.show, "- a\n- b\n\t‸- b\n");
  assert.equal(shifted.vim.register.text, "- b\n");
});

test("VD.7", () => {
  const after = run("- a\n- ‸b\n", ["y", "y", "]", "p"]);
  assert.equal(after.steps[2].match, "partial");
  assert.equal(after.steps[2].vim.input.keyBuffer, "]");
  assert.equal(after.show, "- a\n- b\n\t‸- b\n");
  assert.equal(after.doc, "- a\n- b\n\t- b\n");
  assert.equal(after.vim.mode, "normal");
  assert.equal(after.vim.input.keyBuffer, "");
  const effect = insertedSplice(after);
  assert.equal(effect.text, "\t- b\n");
  assert.equal(effect.caret, "- a\n- b\n\t".length);
  assert.equal(effect.yank, null);

  const before = run("- a\n- ‸b\n", ["y", "y", "[", "p"]);
  assert.equal(before.steps[2].match, "partial");
  assert.equal(before.show, "- a\n\t‸- b\n- b\n");
  assert.equal(before.doc, "- a\n\t- b\n- b\n");
  assert.equal(before.vim.mode, "normal");
  const above = insertedSplice(before);
  assert.equal(above.text, "\t- b\n");
  assert.equal(above.caret, "- a\n\t".length);

  const plain = run("- a\n- ‸b\n", ["y", "y", "p"]);
  assert.equal(plain.show, "- a\n- b\n‸- b\n");
  assert.equal(insertedSplice(plain).text, "- b\n");

  const paragraph = run("‸alpha\n\nbeta\n", ["y", "y", "]", "p"]);
  assert.equal(paragraph.show, "alpha\n\n‸alpha\n\nbeta\n");
  assert.equal(insertedSplice(paragraph).text, "alpha\n\n");

  const miss = run("- a\n- ‸b\n", ["]", "x"]);
  assert.equal(miss.steps[0].match, "partial");
  assert.equal(miss.steps[1].match, "none");
  assert.equal(miss.steps[1].consumed, true);
  assert.equal(miss.steps[1].effect, null);
  assert.equal(miss.doc, "- a\n- b\n");
  assert.equal(miss.vim.input.keyBuffer, "");
  assert.equal(miss.show, "- a\n- ‸b\n");
});

test("VD.5", () => {
  const indent = run("al‸pha\n", ["i", { key: "t", ctrl: true }]);
  assert.equal(indent.show, "\tal‸pha\n");
  assert.equal(indent.doc, "\talpha\n");
  assert.equal(indent.vim.mode, "insert");
  assert.equal(indent.steps[0].vim.mode, "insert");
  const added = indent.steps[1].effect;
  assert.equal(indent.steps[1].match, "full");
  assert.equal(indent.steps[1].consumed, true);
  assert.equal(added.type, "splice");
  assert.equal(added.from, 0);
  assert.equal(added.to, 0);
  assert.equal(added.text, "\t");
  assert.equal(added.caret, 3);
  assert.equal(added.yank, null);

  const twice = run("al‸pha\n", ["i", { key: "t", ctrl: true }, { key: "t", ctrl: true }]);
  assert.equal(twice.show, "\t\tal‸pha\n");
  assert.equal(twice.vim.mode, "insert");

  const outdent = run("\tal‸pha\n", ["i", { key: "d", ctrl: true }]);
  assert.equal(outdent.show, "al‸pha\n");
  assert.equal(outdent.doc, "alpha\n");
  assert.equal(outdent.vim.mode, "insert");
  const removed = outdent.steps[1].effect;
  assert.equal(removed.type, "splice");
  assert.equal(removed.from, 0);
  assert.equal(removed.to, 1);
  assert.equal(removed.text, "");
  assert.equal(removed.caret, 2);

  const one = run("\t\tal‸pha\n", ["i", { key: "d", ctrl: true }]);
  assert.equal(one.show, "\tal‸pha\n");
  assert.equal(one.doc, "\talpha\n");
  assert.equal(one.vim.mode, "insert");

  const bare = run("al‸pha\n", ["i", { key: "d", ctrl: true }]);
  assert.equal(bare.show, "al‸pha\n");
  assert.equal(bare.doc, "alpha\n");
  assert.equal(bare.vim.mode, "insert");
  assert.equal(bare.steps[1].match, "full");
  assert.equal(bare.steps[1].consumed, true);
  assert.equal(bare.steps[1].effect, null);

  let body = "";
  for (let i = 0; i < 25; i += 1) {
    if (i) body += "\n\n";
    body += `p${i}`;
  }
  body += "\n";
  const start = `${CARET}${body}`;
  const half = run(start, [{ key: "d", ctrl: true }]);
  assert.equal(half.vim.mode, "normal");
  assert.equal(half.show, run(start, ["1", "0", "j"]).show);
  assert.equal(half.doc, body);
  const view = run("‸alpha\n", [{ key: "d", ctrl: true }], { layout: true });
  assertView(view, "ctrl-d", 1);
  assert.equal(view.vim.mode, "normal");
  assert.equal(view.doc, "alpha\n");
});

test("Y yanks the line", () => {
  const line = run("‸alpha\n\nbeta\n", ["Y", "p"]);
  const doubled = run("‸alpha\n\nbeta\n", ["y", "y", "p"]);
  assert.equal(line.show, doubled.show);
  assert.equal(line.doc, doubled.doc);
  assert.equal(line.vim.register.text, "alpha\n");
  assert.equal(line.vim.register.linewise, true);
});

test("dd stores the line", () => {
  const out = run("‸one\n\ntwo\n", ["d", "d"]);
  assert.equal(out.vim.register.text, "one\n");
  assert.equal(out.vim.register.linewise, true);
});

test("ctrl-o none clears once", () => {
  const out = run("al‸pha\n", ["i", { key: "o", ctrl: true }, "Q"]);
  assert.equal(out.doc, "alpha\n");
  assert.equal(out.show, "al‸pha\n");
  assert.equal(out.vim.mode, "insert");
  assert.equal(out.vim.once, false);
});

test("ctrl-o visual e keeps once", () => {
  const moved = run("‸alpha beta\n", ["i", { key: "o", ctrl: true }, "v", "e"]);
  assert.equal(moved.vim.mode, "visual");
  assert.equal(moved.vim.once, true);
  const cut = run("‸alpha beta\n", ["i", { key: "o", ctrl: true }, "v", "e", "d"]);
  assert.equal(cut.vim.mode, "insert");
  assert.equal(cut.doc, " beta\n");
});
