import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { vimKey } from "../src/vim.js";
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
  assert.equal(run("alpha\nbe‸ta\n", ["G"]).show, "alpha\nbeta\n‸");
  assert.equal(run("alpha\nbe‸ta\n", ["G"]).cursor, "alpha\nbeta\n".length);
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
  assert.equal(out.show, "al«pha\n\nbe‸ta\n");
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
