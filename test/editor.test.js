import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import {
  plan,
  mapOffset,
  stepOver,
  snapMove,
  placeMove,
  createState,
  createEditor,
  startPage,
  addComment,
  insert,
  backspace,
  deleteForward,
  undo,
  redo,
  selectedSlice,
  cut,
  sampleDocument,
  initialCursor,
  formatHash,
  parseHash,
} from "../src/editor.js";

const A = "**hello**\nnext\n";
const B = "# Title\n\n";
const C = "x![a](b)y";
const D = "| a | b |\n| --- | --- |\n| 1 | 2 |\n";
const E = "```mermaid\nA-->B\n```\n";
const F = "Go\n![alt](sample.svg)\n";

test("T-bold-rendered", () => {
  const p = plan(A, 10);
  const line0 = p.lines[0];
  const line1 = p.lines[1];
  assert.equal(line0.raw, false);
  assert.equal(line0.runs.length, 1);
  assert.equal(line0.runs[0].text, "hello");
  assert.equal(line0.runs[0].start, 2);
  assert.equal(line0.runs[0].end, 7);
  assert.ok(line0.runs[0].classes.includes("md-strong"));
  assert.equal(line0.runs[0].text.length, line0.runs[0].end - line0.runs[0].start);
  assert.equal(line1.raw, true);
  assert.equal(line1.text, "next");
  assert.equal(line1.start, 10);
  assert.equal(line1.end, 14);
  assert.ok(line1.classes.includes("md-raw"));
});

test("T-raw-line", () => {
  const p = plan(A, 0);
  const line0 = p.lines[0];
  const line1 = p.lines[1];
  assert.equal(line0.raw, true);
  assert.equal(line0.text, "**hello**");
  assert.equal(line0.start, 0);
  assert.equal(line0.end, 9);
  assert.equal(line0.text.length, line0.end - line0.start);
  assert.equal(line0.runs.length, 1);
  assert.equal(line0.runs[0].text, "**hello**");
  assert.equal(line0.runs[0].start, 0);
  assert.equal(line0.runs[0].end, 9);
  assert.deepEqual(line0.runs[0].classes, ["md-strong"]);
  assert.equal(line0.runs[0].classes.includes("md-syntax"), false);
  assert.equal(line0.runs[0].text.length, line0.runs[0].end - line0.runs[0].start);
  assert.equal(line0.runs.map((run) => run.text).join(""), line0.text);
  assert.ok(line0.classes.includes("md-raw"));
  assert.ok(line0.classes.includes("md-p"));
  assert.equal(line0.marker, undefined);
  assert.equal(line1.raw, false);
  assert.equal(line1.runs.length, 1);
  assert.equal(line1.runs[0].text, "next");
  assert.equal(line1.runs[0].start, 10);
  assert.equal(line1.runs[0].end, 14);
  assert.ok(line1.runs[0].classes.includes("md-p"));
  assert.equal(line1.runs[0].text.length, line1.runs[0].end - line1.runs[0].start);
});

test("T-heading-hides-marker", () => {
  const p = plan(B, 8);
  const heading = p.lines[0];
  assert.equal(heading.raw, false);
  assert.equal(heading.runs.length, 1);
  assert.equal(heading.runs[0].text, "Title");
  assert.equal(heading.runs[0].start, 2);
  assert.equal(heading.runs[0].end, 7);
  assert.ok(heading.runs[0].classes.includes("md-h1"));
  assert.equal(heading.runs[0].text.length, heading.runs[0].end - heading.runs[0].start);
  assert.equal(p.lines[1].raw, true);
  assert.equal(p.lines[1].start, 8);
  assert.equal(p.lines[1].end, 8);
  assert.equal(p.lines[1].empty, true);
});

test("T-map-offset", () => {
  assert.equal(mapOffset(2, 3), 5);

  const text = { nodeType: 3, length: 5, parentElement: null };
  const run = {
    nodeType: 1,
    dataset: { start: "2", end: "7" },
    classList: { contains() { return false; } },
    parentElement: null,
    childNodes: [text],
  };
  text.parentElement = run;
  assert.equal(mapOffset(text, 3), 5);

  const br = {
    nodeType: 1,
    nodeName: "BR",
    dataset: {},
    classList: { contains() { return false; } },
    parentElement: null,
    childNodes: [],
  };
  const empty = {
    nodeType: 1,
    dataset: { start: "8", end: "8" },
    classList: { contains() { return false; } },
    parentElement: null,
    childNodes: [br],
  };
  br.parentElement = empty;
  assert.equal(mapOffset(br, 0), 8);
  assert.equal(mapOffset(empty, 0), 8);

  const atom = {
    nodeType: 1,
    dataset: { start: "1", end: "8" },
    classList: { contains(name) { return name === "md-atom"; } },
    parentElement: null,
    childNodes: [],
  };
  const parent = {
    nodeType: 1,
    dataset: {},
    classList: { contains() { return false; } },
    parentElement: null,
    childNodes: [atom],
  };
  atom.parentElement = parent;
  assert.equal(mapOffset(parent, 0), 1);
  assert.equal(mapOffset(parent, 1), 8);
});

test("T-insert-undo-redo", () => {
  let s = createState("ab", 1);
  s = insert(s, "X");
  assert.equal(s.doc, "aXb");
  assert.equal(s.cursor, 2);
  assert.equal(s.anchor, 2);
  s = undo(s);
  assert.equal(s.doc, "ab");
  assert.equal(s.cursor, 1);
  s = redo(s);
  assert.equal(s.doc, "aXb");
  assert.equal(s.cursor, 2);

  const again = redo(s);
  assert.equal(again, s);

  s = undo(s);
  s = insert(s, "Y");
  assert.equal(s.doc, "aYb");
  assert.equal(s.cursor, 2);
  assert.equal(s.redo.length, 0);
  const stuck = redo(s);
  assert.equal(stuck.doc, "aYb");
});

test("T-backspace", () => {
  let s = createState("aXb", 2);
  s = backspace(s);
  assert.equal(s.doc, "ab");
  assert.equal(s.cursor, 1);

  const start = createState("ab", 0);
  assert.equal(backspace(start), start);
  assert.equal(start.undo.length, 0);
});

test("T-delete", () => {
  let s = createState("aXb", 1);
  s = deleteForward(s);
  assert.equal(s.doc, "ab");
  assert.equal(s.cursor, 1);

  const end = createState("ab", 2);
  assert.equal(deleteForward(end), end);
  assert.equal(end.undo.length, 0);
});

test("T-backspace-atom", () => {
  let s = createState(D, 33);
  s = backspace(s);
  assert.equal(s.doc, "\n");
  assert.equal(s.cursor, 0);

  s = createState(C, 8, 1);
  s = backspace(s);
  assert.equal(s.doc, "xy");
  assert.equal(s.cursor, 1);
});

test("T-raw-image-backspace", () => {
  const token = "![alt](sample.svg)";
  assert.equal(token.length, 18);
  let s = createState(token, 18);
  s = backspace(s);
  assert.equal(s.doc, "![alt](sample.svg");
  assert.equal(s.cursor, 17);
});

test("T-table-atom", () => {
  assert.equal(D.length, 34);
  for (const cursor of [0, 4]) {
    const open = plan(D, cursor);
    assert.equal(open.blocks.filter((b) => b.type === "table").length, 0);
    const pipes = open.lines.filter((line) => line.text.includes("|"));
    assert.equal(pipes.length, 3);
    assert.equal(pipes.map((line) => line.text).join("\n"), "| a | b |\n| --- | --- |\n| 1 | 2 |");
    assert.ok(pipes.every((line) => line.classes.includes("md-p")));
    for (const line of pipes) {
      assert.equal(line.runs.map((run) => run.text).join(""), line.text);
      assert.ok(line.text.includes("|"));
    }
  }
  const closed = plan(D, 33);
  const tables = closed.blocks.filter((b) => b.type === "table");
  assert.equal(tables.length, 1);
  assert.equal(tables[0].start, 0);
  assert.equal(tables[0].end, 33);
  assert.equal(tables[0].runs, undefined);
  assert.equal(closed.atoms.filter((a) => a.type === "table").length, 1);
  assert.ok(closed.lines.every((line) => line.start >= 33));
  assert.equal(tables[0].header[0].text, "a");
  assert.equal(tables[0].header[0].start, 2);
  assert.equal(tables[0].header[0].end, 3);
  assert.equal(tables[0].header[1].text, "b");
  assert.equal(tables[0].header[1].start, 6);
  assert.equal(tables[0].header[1].end, 7);
  assert.equal(tables[0].rows[0][0].text, "1");
  assert.equal(tables[0].rows[0][0].start, 26);
  assert.equal(tables[0].rows[0][0].end, 27);
  assert.equal(tables[0].rows[0][1].text, "2");
  assert.equal(tables[0].rows[0][1].start, 30);
  assert.equal(tables[0].rows[0][1].end, 31);

  let inside = createState(D, 4);
  inside = backspace(inside);
  assert.equal(inside.cursor, 3);
  assert.equal(inside.doc.startsWith("| a"), true);
  assert.notEqual(inside.doc, "\n");
});

test("T-image-atom", () => {
  const p = plan(F, 0);
  assert.equal(p.lines[0].raw, true);
  assert.equal(p.lines[0].start, 0);
  assert.equal(p.lines[0].end, 2);
  assert.equal(p.lines[0].text, "Go");
  const image = p.atoms.find((a) => a.type === "image");
  assert.ok(image);
  assert.equal(image.start, 3);
  assert.equal(image.end, 21);
  assert.equal(image.alt, "alt");
  assert.equal(image.url, "sample.svg");
  const imageLine = p.lines[1];
  assert.equal(imageLine.raw, false);
  assert.ok(imageLine.parts.some((part) => part.type === "image" && part.start === 3));
});

test("T-diagram-atom", () => {
  assert.equal(E.length, 21);
  for (const cursor of [0, 12]) {
    const open = plan(E, cursor);
    assert.equal(open.blocks.filter((b) => b.type === "diagram").length, 0);
    const code = open.lines.filter((line) => line.classes.includes("md-codeblock"));
    assert.equal(code.length, 3);
    assert.equal(code.map((line) => line.text).join("\n"), "```mermaid\nA-->B\n```");
    assert.ok(code.every((line) => line.runs.map((run) => run.text).join("") === line.text));
  }
  const closed = plan(E, 20);
  const diagrams = closed.blocks.filter((b) => b.type === "diagram");
  assert.equal(diagrams.length, 1);
  assert.equal(diagrams[0].start, 0);
  assert.equal(diagrams[0].end, 20);
  assert.equal(diagrams[0].runs, undefined);
  assert.equal(diagrams[0].bodyStart, 11);
  assert.equal(closed.atoms.filter((a) => a.type === "diagram").length, 1);
  assert.ok(closed.lines.every((line) => line.start >= 20));
});

test("T-step-over", () => {
  const end = 1 + "![a](b)".length;
  assert.equal(stepOver(C, 1, "forward"), end);
  assert.equal(stepOver(C, end, "backward"), 1);
  assert.equal(stepOver(C, 4, "forward"), end);
  assert.equal(stepOver(C, 4, "backward"), 1);
  assert.equal(stepOver(C, 0, "forward"), 0);
  assert.equal(stepOver(D, 0, "forward"), 33);
  assert.equal(stepOver(D, 33, "backward"), 0);
  assert.equal(stepOver(E, 4, "forward"), 20);
  assert.equal(stepOver(E, 20, "backward"), 0);
});

test("T-snap-rendered", () => {
  assert.equal(snapMove("![alt](sample.svg)", 0, 1, "forward"), 1);
  assert.equal(snapMove("Go\n![alt](sample.svg)\n", 0, 10, "forward"), 21);
  assert.equal(snapMove(D, 0, 4, "forward"), 4);
  assert.equal(snapMove(D, 33, 4, "forward"), 33);
  assert.equal(snapMove(E, 0, 12, "forward"), 12);
  assert.equal(snapMove(E, 20, 12, "forward"), 20);
  assert.equal(placeMove(D, 33, 4, "forward", "line"), 0);
  assert.equal(placeMove(D, 33, 4, "forward", "character"), 0);
  assert.equal(placeMove(D, 33, 4, "backward", "character"), 32);
  assert.equal(placeMove(D, 0, 4, "forward", "character"), 4);
  assert.equal(placeMove(E, 20, 12, "forward", "line"), 20);
  assert.equal(placeMove(E, 20, 12, "backward", "line"), 0);
  assert.equal(placeMove(E, 20, 12, "forward", "character"), 0);
  assert.equal(placeMove(E, 20, 12, "backward", "character"), 19);
  assert.equal(placeMove(F, 0, 10, "forward", "character"), 21);
  assert.equal(placeMove("x\n" + D, 0, 40, "forward", "line"), 2);
  assert.equal(placeMove("x\n" + D, 40, 0, "backward", "line"), 34);
  assert.equal(placeMove("x\n" + E, 0, 30, "forward", "line"), 30);
  assert.equal(placeMove("x\n" + E, 0, 30, "forward", "character"), 2);

  const fenced = "a\n```js\ncode\n```\n";
  const openFence = fenced.indexOf("```js");
  const codeAt = fenced.indexOf("code");
  const closeFence = fenced.lastIndexOf("```");
  assert.equal(placeMove(fenced, 1, codeAt, "forward", "line"), openFence);
  assert.equal(placeMove(fenced, codeAt, 0, "backward", "line"), openFence + "```js".length);
  assert.equal(placeMove(fenced, codeAt + "code".length, fenced.length, "forward", "character"), closeFence);
  assert.equal(placeMove(fenced, codeAt + "code".length, closeFence, "forward", "character"), closeFence);
  assert.equal(placeMove(fenced, openFence, codeAt, "forward", "character"), codeAt);
});

test("selection replace and ends", () => {
  let s = createState("abcdef", 5, 2);
  assert.equal(selectedSlice(s), "cde");
  s = insert(s, "X");
  assert.equal(s.doc, "abXf");
  assert.equal(s.cursor, 3);
  assert.equal(s.undo.length, 1);

  s = createState("abcdef", 5, 2);
  s = backspace(s);
  assert.equal(s.doc, "abf");
  assert.equal(s.cursor, 2);

  s = createState("abcdef", 2, 5);
  s = deleteForward(s);
  assert.equal(s.doc, "abf");
  assert.equal(s.cursor, 2);

  const cutResult = cut(createState("abcdef", 5, 2));
  assert.equal(cutResult.text, "cde");
  assert.equal(cutResult.state.doc, "abf");
  assert.equal(cutResult.state.cursor, 2);

  s = createState("ab", 1);
  s = insert(s, "\n");
  assert.equal(s.doc, "a\nb");
  assert.equal(s.cursor, 2);

  s = createState("ab", 0);
  s = undo(s);
  assert.equal(s.doc, "ab");
  assert.equal(s.undo.length, 0);
});

test("marks hide their markers", () => {
  const em = plan("*b*\n", 4);
  assert.equal(em.lines[0].runs[0].text, "b");
  assert.equal(em.lines[0].runs[0].start, 1);
  assert.equal(em.lines[0].runs[0].end, 2);
  assert.ok(em.lines[0].runs[0].classes.includes("md-em"));

  const under = plan("_c_\n", 4);
  assert.equal(under.lines[0].runs[0].text, "c");
  assert.equal(under.lines[0].runs[0].start, 1);
  assert.equal(under.lines[0].runs[0].end, 2);
  assert.ok(under.lines[0].runs[0].classes.includes("md-em"));

  const spaced = plan("``` diagram\nA\n```\n", 30);
  assert.equal(spaced.blocks.some((block) => block.type === "diagram"), false);
  assert.ok(spaced.lines.some((line) => line.classes.includes("md-codeblock") && line.text === "A"));
  assert.equal(spaced.lines[0].collapsed, true);
  assert.equal(spaced.lines[0].text.startsWith("```"), true);

  const strong = plan("__a__\n", 6);
  assert.equal(strong.lines[0].runs[0].text, "a");
  assert.equal(strong.lines[0].runs[0].start, 2);
  assert.equal(strong.lines[0].runs[0].end, 3);
  assert.ok(strong.lines[0].runs[0].classes.includes("md-strong"));

  const code = plan("x `ab` y\n", 9);
  const codeRun = code.lines[0].runs.find((run) => run.classes.includes("md-code"));
  assert.equal(codeRun.text, "ab");
  assert.equal(codeRun.start, 3);
  assert.equal(codeRun.end, 5);

  const link = plan("a [bc](d) e\n", 12);
  const linkRun = link.lines[0].runs.find((run) => run.classes.includes("md-link"));
  assert.equal(linkRun.text, "bc");
  assert.equal(linkRun.start, 3);
  assert.equal(linkRun.end, 5);
  assert.equal(linkRun.href, "d");

  const quote = plan("> hi\n", 5);
  assert.equal(quote.lines[0].runs[0].text, "hi");
  assert.equal(quote.lines[0].runs[0].start, 2);
  assert.equal(quote.lines[0].runs[0].end, 4);
  assert.ok(quote.lines[0].runs[0].classes.includes("md-quote"));

  const item = plan("- item\n", 7);
  assert.equal(item.lines[0].runs[0].text, "item");
  assert.equal(item.lines[0].runs[0].start, 2);
  assert.equal(item.lines[0].runs[0].end, 6);
  assert.ok(item.lines[0].runs[0].classes.includes("md-li"));

  const ordered = plan("12. num\n", 8);
  assert.equal(ordered.lines[0].runs[0].text, "num");
  assert.equal(ordered.lines[0].runs[0].start, 4);
  assert.equal(ordered.lines[0].runs[0].end, 7);
  assert.ok(ordered.lines[0].runs[0].classes.includes("md-ol"));

  for (const marker of ["---", "***", "___"]) {
    const hr = plan(`${marker}\n`, marker.length + 1);
    assert.equal(hr.lines[0].hr, true);
    assert.ok(hr.lines[0].classes.includes("md-hr"));
    assert.equal(hr.lines[0].runs.length, 0);
    assert.equal(hr.lines[0].start, 0);
    assert.equal(hr.lines[0].end, marker.length);
  }

  const fence = plan("```js\nfull\n```\n", 20);
  const codeLines = fence.lines.filter((line) => line.classes.includes("md-codeblock"));
  assert.equal(codeLines.length, 3);
  assert.equal(codeLines[0].runs[0].text, "```js");
  assert.equal(codeLines[0].runs[0].start, 0);
  assert.equal(codeLines[0].runs[0].end, 5);
  assert.equal(codeLines[0].collapsed, true);
  assert.equal(codeLines[1].collapsed, undefined);
  assert.equal(codeLines[1].runs.map((run) => run.text).join(""), "full");
  assert.equal(codeLines[1].runs[0].text, "full");
  assert.equal(codeLines[1].runs[0].text.length, codeLines[1].runs[0].end - codeLines[1].runs[0].start);
  assert.equal(codeLines[2].collapsed, true);
  const onFence = plan("```js\nfull\n```\n", 0);
  assert.equal(onFence.lines[0].collapsed, false);
  assert.equal(onFence.lines[0].raw, true);
  assert.equal(onFence.lines[0].runs[0].text, "```js");
  assert.equal(onFence.lines[2].collapsed, true);

  const h2 = plan("## Sub\n", 7);
  assert.equal(h2.lines[0].runs[0].text, "Sub");
  assert.equal(h2.lines[0].runs[0].start, 3);
  assert.ok(h2.lines[0].runs[0].classes.includes("md-h2"));
});

test("T-ordered-list", () => {
  const p = plan("12. num\nnext\n", 8);
  const line0 = p.lines[0];
  assert.equal(line0.raw, false);
  assert.equal(line0.runs.length, 1);
  assert.equal(line0.runs[0].text, "num");
  assert.equal(line0.runs[0].start, 4);
  assert.equal(line0.runs[0].end, 7);
  assert.ok(line0.runs[0].classes.includes("md-ol"));
  assert.ok(line0.classes.includes("md-ol"));
  assert.equal(line0.marker, "12. ");
  assert.equal(p.lines[1].raw, true);
  assert.equal(p.lines[1].text, "next");

  const paren = plan("1) also\n", 8);
  const run = paren.lines[0].runs[0];
  assert.equal(paren.lines[0].runs.length, 1);
  assert.equal(run.text, "also");
  assert.equal(run.start, 3);
  assert.equal(run.end, 7);
  assert.ok(run.classes.includes("md-ol"));
  assert.equal(paren.lines[0].marker, "1) ");

  const raw = plan("12. num\n", 0);
  assert.equal(raw.lines[0].raw, true);
  assert.equal(raw.lines[0].runs.length, 1);
  assert.equal(raw.lines[0].runs[0].text, "12. num");
  assert.equal(raw.lines[0].runs[0].start, 0);
  assert.equal(raw.lines[0].runs[0].end, 7);
  assert.ok(raw.lines[0].runs[0].classes.includes("md-ol"));
  assert.equal(raw.lines[0].runs[0].classes.includes("md-syntax"), false);
  assert.equal(raw.lines[0].runs[0].text.length, raw.lines[0].runs[0].end - raw.lines[0].runs[0].start);
  assert.equal(raw.lines[0].runs.map((run) => run.text).join(""), "12. num");
  assert.ok(raw.lines[0].classes.includes("md-raw"));
  assert.ok(raw.lines[0].classes.includes("md-ol"));
  assert.equal(raw.lines[0].marker, undefined);
});

test("T-active-format", () => {
  const bold = plan("A **bold** x\n", 0).lines[0];
  const expected = [
    ["A ", 0, 2, ["md-p"]],
    ["**bold**", 2, 10, ["md-strong"]],
    [" x", 10, 12, ["md-p"]],
  ];
  assert.equal(bold.raw, true);
  assert.equal(bold.runs.length, expected.length);
  let text = "";
  for (let i = 0; i < expected.length; i += 1) {
    const run = bold.runs[i];
    const [wantText, start, end, classes] = expected[i];
    assert.equal(run.text, wantText);
    assert.equal(run.start, start);
    assert.equal(run.end, end);
    assert.equal(run.text.length, run.end - run.start);
    assert.deepEqual(run.classes, classes);
    assert.equal(run.classes.includes("md-syntax"), false);
    if (i > 0) assert.equal(bold.runs[i - 1].end, run.start);
    text += run.text;
  }
  assert.equal(text, bold.text);
  assert.equal(text, "A **bold** x");
  assert.ok(bold.classes.includes("md-raw"));
  assert.ok(bold.classes.includes("md-p"));

  const heading = plan("# **T**\n", 0).lines[0];
  assert.equal(heading.runs.length, 2);
  assert.equal(heading.runs[0].text, "# ");
  assert.equal(heading.runs[0].start, 0);
  assert.equal(heading.runs[0].end, 2);
  assert.ok(heading.runs[0].classes.includes("md-h1"));
  assert.equal(heading.runs[0].classes.includes("md-syntax"), false);
  assert.equal(heading.runs[1].text, "**T**");
  assert.equal(heading.runs[1].start, 2);
  assert.equal(heading.runs[1].end, 7);
  assert.deepEqual(heading.runs[1].classes, ["md-strong"]);
  assert.equal(heading.runs[1].classes.includes("md-syntax"), false);
  assert.equal(heading.runs.map((run) => run.text).join(""), "# **T**");
  assert.equal(heading.runs[0].end, heading.runs[1].start);
  assert.ok(heading.classes.includes("md-raw"));
  assert.ok(heading.classes.includes("md-h1"));
  assert.equal(heading.marker, undefined);

  const ordered = plan("12. num\n", 0).lines[0];
  assert.equal(ordered.runs.length, 1);
  assert.equal(ordered.runs[0].text, "12. num");
  assert.equal(ordered.runs[0].start, 0);
  assert.equal(ordered.runs[0].end, 7);
  assert.ok(ordered.runs[0].classes.includes("md-ol"));
  assert.equal(ordered.runs[0].classes.includes("md-syntax"), false);
  assert.equal(ordered.marker, undefined);

  const em = plan("*em*\n", 2).lines[0];
  assert.equal(em.raw, true);
  assert.equal(em.runs.length, 1);
  assert.equal(em.runs[0].text, "*em*");
  assert.equal(em.runs[0].start, 0);
  assert.equal(em.runs[0].end, 4);
  assert.ok(em.runs[0].classes.includes("md-em"));
  assert.equal(em.runs[0].classes.includes("md-syntax"), false);

  const under = plan("_em_\n", 2).lines[0];
  assert.equal(under.runs.length, 1);
  assert.equal(under.runs[0].text, "_em_");
  assert.deepEqual(under.runs[0].classes, ["md-em"]);

  const us = plan("__ab__\n", 0).lines[0];
  assert.equal(us.runs.length, 1);
  assert.equal(us.runs[0].text, "__ab__");
  assert.deepEqual(us.runs[0].classes, ["md-strong"]);

  const both = plan("***both***\n", 0).lines[0];
  assert.equal(both.runs.length, 1);
  assert.equal(both.runs[0].text, "***both***");
  assert.deepEqual(both.runs[0].classes, ["md-strong", "md-em"]);
  assert.equal(both.runs[0].classes.includes("md-syntax"), false);

  const starUnder = plan("**_z_**\n", 0).lines[0];
  assert.equal(starUnder.runs.length, 1);
  assert.equal(starUnder.runs[0].text, "**_z_**");
  assert.deepEqual(starUnder.runs[0].classes, ["md-strong", "md-em"]);

  const underStar = plan("_**z**_\n", 0).lines[0];
  assert.equal(underStar.runs.length, 1);
  assert.equal(underStar.runs[0].text, "_**z**_");
  assert.deepEqual(underStar.runs[0].classes, ["md-em", "md-strong"]);

  const code = plan("`ab`\n", 2).lines[0];
  assert.equal(code.raw, true);
  assert.equal(code.runs.length, 1);
  assert.equal(code.runs[0].text, "`ab`");
  assert.equal(code.runs[0].start, 0);
  assert.equal(code.runs[0].end, 4);
  assert.ok(code.runs[0].classes.includes("md-code"));
  assert.equal(code.runs[0].classes.includes("md-syntax"), false);

  const codeMid = plan("x `ab` y\n", 0).lines[0];
  const codeRun = codeMid.runs.find((run) => run.classes.includes("md-code"));
  assert.equal(codeRun.text, "`ab`");
  assert.equal(codeRun.start, 2);
  assert.equal(codeRun.end, 6);
  assert.deepEqual(codeRun.classes, ["md-code"]);
  assert.equal(codeMid.runs.map((run) => run.text).join(""), "x `ab` y");

  const link = plan("[bc](d)\n", 3).lines[0];
  assert.equal(link.raw, true);
  assert.equal(link.runs.length, 1);
  assert.equal(link.runs[0].text, "[bc](d)");
  assert.equal(link.runs[0].start, 0);
  assert.equal(link.runs[0].end, 7);
  assert.ok(link.runs[0].classes.includes("md-link"));
  assert.equal(link.runs[0].classes.includes("md-syntax"), false);
  assert.equal(link.runs[0].href, "d");

  const linked = plan("a [bc](d) e\n", 0).lines[0];
  const linkRun = linked.runs.find((run) => run.classes.includes("md-link"));
  assert.equal(linkRun.text, "[bc](d)");
  assert.equal(linkRun.start, 2);
  assert.equal(linkRun.end, 9);
  assert.equal(linkRun.href, "d");
  assert.deepEqual(linkRun.classes, ["md-link"]);
  assert.equal(linked.runs.map((run) => run.text).join(""), "a [bc](d) e");

  const strongLink = plan("[**b**](u)\n", 0).lines[0];
  assert.equal(strongLink.runs.length, 1);
  assert.equal(strongLink.runs[0].text, "[**b**](u)");
  assert.deepEqual(strongLink.runs[0].classes, ["md-strong", "md-link"]);
  assert.equal(strongLink.runs[0].href, "u");

  const neighbors = plan("**a** *b*\n", 0).lines[0];
  assert.equal(neighbors.runs.length, 3);
  assert.equal(neighbors.runs[0].text, "**a**");
  assert.deepEqual(neighbors.runs[0].classes, ["md-strong"]);
  assert.equal(neighbors.runs[1].text, " ");
  assert.deepEqual(neighbors.runs[1].classes, ["md-p"]);
  assert.equal(neighbors.runs[2].text, "*b*");
  assert.deepEqual(neighbors.runs[2].classes, ["md-em"]);

  const sideBySide = plan("*a***b**\n", 0).lines[0];
  assert.equal(sideBySide.runs[0].text, "*a*");
  assert.deepEqual(sideBySide.runs[0].classes, ["md-em"]);
  assert.equal(sideBySide.runs[1].text, "**b**");
  assert.deepEqual(sideBySide.runs[1].classes, ["md-strong"]);

  const pair = plan("[a](u)[b](v)\n", 0).lines[0];
  assert.equal(pair.runs.length, 2);
  assert.equal(pair.runs[0].text, "[a](u)");
  assert.equal(pair.runs[0].href, "u");
  assert.equal(pair.runs[1].text, "[b](v)");
  assert.equal(pair.runs[1].href, "v");
  assert.deepEqual(pair.runs[0].classes, ["md-link"]);
  assert.deepEqual(pair.runs[1].classes, ["md-link"]);

  const emLink = plan("[*e*](u)\n", 0).lines[0];
  assert.equal(emLink.runs.length, 1);
  assert.equal(emLink.runs[0].text, "[*e*](u)");
  assert.deepEqual(emLink.runs[0].classes, ["md-em", "md-link"]);
  assert.equal(emLink.runs[0].href, "u");

  const quote = plan("> hi\n", 0).lines[0];
  assert.equal(quote.runs.length, 1);
  assert.equal(quote.runs[0].text, "> hi");
  assert.ok(quote.runs[0].classes.includes("md-quote"));
  assert.equal(quote.runs[0].classes.includes("md-syntax"), false);

  const quoteEm = plan("> *em*\n", 0).lines[0];
  assert.equal(quoteEm.runs[0].text, "> ");
  assert.ok(quoteEm.runs[0].classes.includes("md-quote"));
  assert.equal(quoteEm.runs[0].classes.includes("md-syntax"), false);
  assert.equal(quoteEm.runs[1].text, "*em*");
  assert.deepEqual(quoteEm.runs[1].classes, ["md-em"]);

  const item = plan("- item\n", 0).lines[0];
  assert.equal(item.runs.length, 1);
  assert.equal(item.runs[0].text, "- item");
  assert.ok(item.runs[0].classes.includes("md-li"));
  assert.equal(item.runs[0].classes.includes("md-syntax"), false);

  const paren = plan("1) also\n", 0).lines[0];
  assert.equal(paren.runs.length, 1);
  assert.equal(paren.runs[0].text, "1) also");
  assert.ok(paren.runs[0].classes.includes("md-ol"));
  assert.equal(paren.runs[0].classes.includes("md-syntax"), false);

  const listed = plan("12. **n**\n", 0).lines[0];
  assert.equal(listed.runs[0].text, "12. ");
  assert.equal(listed.runs[0].end, 4);
  assert.ok(listed.runs[0].classes.includes("md-ol"));
  assert.equal(listed.runs[0].classes.includes("md-syntax"), false);
  assert.equal(listed.runs[1].text, "**n**");
  assert.deepEqual(listed.runs[1].classes, ["md-strong"]);

  const hidden = plan("**a**\n**b**\n", 0);
  assert.equal(hidden.lines[0].runs[0].text, "**a**");
  assert.deepEqual(hidden.lines[0].runs[0].classes, ["md-strong"]);
  assert.equal(hidden.lines[1].raw, false);
  assert.equal(hidden.lines[1].runs[0].text, "b");
  assert.equal(hidden.lines[1].runs[0].start, 8);
  assert.equal(hidden.lines[1].runs[0].end, 9);
  assert.ok(hidden.lines[1].runs[0].classes.includes("md-strong"));

  const shifted = plan("next\n**hello**\n", 6).lines[1];
  assert.equal(shifted.raw, true);
  assert.equal(shifted.runs.length, 1);
  assert.equal(shifted.runs[0].text, "**hello**");
  assert.equal(shifted.runs[0].start, 5);
  assert.equal(shifted.runs[0].end, 14);
  assert.deepEqual(shifted.runs[0].classes, ["md-strong"]);

  const image = plan("x![a](b)y", 0);
  assert.equal(image.atoms.some((atom) => atom.type === "image"), false);
  assert.equal(image.lines[0].parts.some((part) => part.type === "image"), false);
  assert.equal(image.lines[0].runs.map((run) => run.text).join(""), "x![a](b)y");
  const token = image.lines[0].runs.find((run) => run.text.includes("!["));
  assert.ok(token);
  assert.deepEqual(token.classes, ["md-syntax"]);
  assert.equal(token.text, "![a](b)");
  assert.equal(token.start, 1);
  assert.equal(token.end, 8);
  assert.equal(token.text.length, token.end - token.start);
  assert.deepEqual(image.lines[0].runs[0].classes, ["md-p"]);
  assert.equal(image.lines[0].runs[0].text, "x");
  assert.deepEqual(image.lines[0].runs[2].classes, ["md-p"]);
  assert.equal(image.lines[0].runs[2].text, "y");
});

test("cursor line stays one text node around an image", () => {
  const p = plan(C, 0);
  assert.equal(p.lines[0].raw, true);
  assert.equal(p.lines[0].text, C);
  assert.equal(p.atoms.some((atom) => atom.type === "image"), false);
  assert.equal(stepOver(C, 1, "forward"), 8);
});

test("sample focuses the wrapped line", () => {
  const doc = sampleDocument();
  assert.match(doc, /^# /m);
  assert.match(doc, /\*\*[^*]+\*\*/);
  assert.match(doc, /wrapped/);
  assert.match(doc, /^- /m);
  assert.match(doc, /^1\. \S/m);
  assert.match(doc, /^2\. \S/m);
  assert.match(doc, /\[[^\]]+\]\([^)]+\)/);
  assert.match(doc, /\| --- \|/);
  assert.match(doc, /!\[[^\]]*\]\(sample\.svg\)/);
  assert.match(doc, /```mermaid\ngraph TD\nA-->B\n```/);
  assert.ok(doc.indexOf("```python\nx = 1\n```") < doc.indexOf("```mermaid"));
  assert.match(doc, /^- two\n {2}- sub\n\t- tabbed\n/m);
  const first = doc.indexOf("\n1. first\n");
  const nested = doc.indexOf("\n   1. nested\n");
  const second = doc.indexOf("\n2. second\n");
  assert.ok(first >= 0 && first < nested && nested < second);
  const cursor = initialCursor(doc);
  const p = plan(doc, cursor);
  const raw = p.lines.find((line) => line.raw);
  assert.ok(raw);
  assert.ok(raw.text.includes("wrapped"));
  assert.ok(raw.text.length >= 280);
  assert.ok(cursor >= raw.start && cursor <= raw.end);
  for (const line of p.lines) {
    if (line.raw && !line.empty) assert.equal(line.text.length, line.end - line.start);
    for (const run of line.runs) assert.equal(run.text.length, run.end - run.start);
  }
});

function assertPlainList(run, plain) {
  assert.ok(run.classes.includes(plain));
  assert.equal(run.classes.includes("md-syntax"), false);
}

test("T-nested-lists", () => {
  const doc = "- a\n  - b\n\t- c\n1. d\n   2. e\n\t3.\tf\n";
  const lines = plan(doc, 0).lines;
  assert.equal(lines[0].raw, true);
  assert.equal(lines[0].indent, 0);

  const sub = lines[1];
  assert.equal(sub.raw, false);
  assert.equal(sub.indent, 2);
  assert.equal(sub.runs.length, 1);
  assert.equal(sub.runs[0].text, "b");
  assert.equal(sub.runs[0].start, 8);
  assertPlainList(sub.runs[0], "md-li");
  assert.ok(sub.classes.includes("md-li"));
  assert.equal(Object.hasOwn(sub, "marker"), false);

  const tabbed = lines[2];
  assert.equal(tabbed.indent, 4);
  assert.equal(tabbed.runs[0].text, "c");
  assert.equal(tabbed.runs[0].start, 13);
  assertPlainList(tabbed.runs[0], "md-li");
  assert.equal(Object.hasOwn(tabbed, "marker"), false);

  const first = lines[3];
  assert.equal(first.indent, 0);
  assert.equal(first.runs[0].text, "d");
  assert.equal(first.runs[0].start, 18);
  assertPlainList(first.runs[0], "md-ol");
  assert.equal(first.marker, "1. ");

  const nested = lines[4];
  assert.equal(nested.indent, 3);
  assert.equal(nested.runs[0].text, "e");
  assert.equal(nested.runs[0].start, 26);
  assertPlainList(nested.runs[0], "md-ol");
  assert.equal(nested.marker, "2. ");

  const orderedTab = lines[5];
  assert.equal(orderedTab.indent, 4);
  assert.equal(orderedTab.runs[0].text, "f");
  assert.equal(orderedTab.runs[0].start, 32);
  assertPlainList(orderedTab.runs[0], "md-ol");
  assert.equal(orderedTab.marker, "3.\t");

  const rawBullet = plan("  - b\n", 0).lines[0];
  assert.equal(rawBullet.raw, true);
  assert.equal(rawBullet.text, "  - b");
  assert.equal(rawBullet.indent, 2);
  assert.equal(rawBullet.runs.map((run) => run.text).join(""), "  - b");
  assert.ok(rawBullet.runs.every((run) => run.classes.includes("md-li")));
  assert.equal(rawBullet.runs.some((run) => run.classes.includes("md-syntax")), false);
  assert.equal(Object.hasOwn(rawBullet, "marker"), false);

  const rawTab = plan("\t- c\n", 0).lines[0];
  assert.equal(rawTab.raw, true);
  assert.equal(rawTab.text, "\t- c");
  assert.equal(rawTab.indent, 4);
  assert.equal(rawTab.runs.map((run) => run.text).join(""), "\t- c");
  assert.ok(rawTab.runs.every((run) => run.classes.includes("md-li")));
  assert.equal(rawTab.runs.some((run) => run.classes.includes("md-syntax")), false);

  const ten = plan("1234567890. x\n", 16).lines[0];
  assert.equal(ten.text, "1234567890. x");
  assert.equal(ten.classes.includes("md-ol"), false);
  assert.equal(ten.runs.some((run) => run.classes.includes("md-ol")), false);
  assert.equal(ten.indent, 0);

  const nine = plan("123456789. x\n", 20).lines[0];
  assert.ok(nine.classes.includes("md-ol"));
  assert.equal(nine.marker, "123456789. ");
  assert.equal(nine.runs[0].text, "x");
  assert.equal(nine.indent, 0);

  const same = plan("12. num\nnext\n", 8);
  assert.equal(same.lines[0].raw, false);
  assert.equal(same.lines[0].runs[0].text, "num");
  assert.equal(same.lines[0].runs[0].start, 4);
  assert.equal(same.lines[0].marker, "12. ");
  assert.equal(same.lines[0].indent, 0);

  const fifth = plan("-     x\n", 20).lines[0];
  assert.equal(fifth.runs[0].text, " x");
  assert.equal(fifth.runs[0].start, 5);
  assert.equal(Object.hasOwn(fifth, "marker"), false);

  const fourSpaces = plan("1.     x\n", 20).lines[0];
  assert.equal(fourSpaces.marker, "1.    ");
  assert.equal(fourSpaces.runs[0].text, " x");

  const stopped = plan(" \t- z\n", 20).lines[0];
  assert.equal(stopped.indent, 4);
  assert.equal(stopped.runs[0].text, "z");
  assert.equal(stopped.runs[0].start, 4);

  const deep = plan("    - x\n", 20).lines[0];
  assert.equal(deep.indent, 4);
  assert.equal(deep.runs[0].text, "x");
  assert.ok(deep.classes.includes("md-li"));

  const twoTabs = plan("\t\t- x\n", 20).lines[0];
  assert.equal(twoTabs.indent, 8);
  assert.equal(twoTabs.runs[0].text, "x");

  const paren = plan("\t1)\tq\n", 20).lines[0];
  assert.equal(paren.indent, 4);
  assert.equal(paren.marker, "1)\t");
  assert.equal(paren.runs[0].text, "q");

  const css = readFileSync(new URL("../editor.css", import.meta.url), "utf8");
  assert.match(css, /\.editor \{[^}]*tab-size: 4;/);
  assert.match(css, /\.md-line\.md-li \{[^}]*margin-left: calc\(1\.3em \+ var\(--indent, 0\) \* 1ch\);/);
  assert.match(css, /\.md-line\.md-ol \{[^}]*margin-left: calc\(1\.3em \+ var\(--indent, 0\) \* 1ch\);/);
  assert.match(css, /\.md-raw\.md-li,\n\.md-raw\.md-ol \{[^}]*margin-left: 1\.3em;/);
  assert.equal(css.includes("#3a3424"), false);
  assert.equal(css.includes(".md-line.md-raw"), false);
  const src = readFileSync(new URL("../src/editor.js", import.meta.url), "utf8");
  assert.match(src, /The markdown this editor supports is GitHub, GitLab, and Obsidian markdown\./);
  assert.match(src, /A mermaid fence is a diagram\./);
  assert.equal(src.includes("innerHTML"), false);
});

test("T-tab-key", () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const listeners = {};
  let shown = [];
  let selection = null;

  function makeElement() {
    return {
      nodeType: 1,
      className: "",
      dataset: {},
      styleProps: {},
      childNodes: [],
      parentElement: null,
      classList: { add() {}, remove() {}, contains() { return false; } },
      style: {
        setProperty(name, value) {
          this.owner.styleProps[name] = value;
        },
      },
      appendChild(child) {
        child.parentElement = this;
        this.childNodes.push(child);
        return child;
      },
      setAttribute() {},
      querySelectorAll() { return []; },
    };
  }

  function wire(node) {
    node.style.owner = node;
    return node;
  }

  function contains(root, node) {
    let current = node;
    while (current) {
      if (current === root) return true;
      current = current.parentElement;
    }
    return false;
  }

  const root = wire(makeElement());
  root.addEventListener = (type, fn) => {
    listeners[type] = fn;
  };
  root.replaceChildren = (...nodes) => {
    root.childNodes = nodes;
    for (const node of nodes) node.parentElement = root;
    shown = nodes;
  };
  root.contains = (node) => contains(root, node);
  globalThis.NodeFilter = globalThis.NodeFilter || { SHOW_TEXT: 4 };
  globalThis.document = {
    createElement: () => wire(makeElement()),
    createTextNode: (text) => ({ nodeType: 3, textContent: text, length: text.length, parentElement: null }),
    createTreeWalker: () => ({ nextNode: () => null }),
    createRange: () => ({
      setStart() {},
      collapse() {},
      selectNode() {},
      setStartAfter() {},
      setStartBefore() {},
    }),
  };
  globalThis.window = {
    getSelection() {
      const current = selection;
      selection = null;
      return current;
    },
  };

  function key(extra = {}) {
    const event = {
      key: "Tab",
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      defaultPrevented: false,
      ...extra,
      preventDefault() {
        event.defaultPrevented = true;
      },
    };
    listeners.keydown(event);
    return event;
  }

  try {
    const nested = "- a\n  - b\n\t- c\n1. d\n   2. e\n\t3.\tf\n";
    const view = createEditor(root, nested, 4);
    assert.equal(shown[0].styleProps["--indent"], "0");
    assert.equal(shown[0].dataset.marker, undefined);
    assert.equal(shown[0].className.includes("md-li"), true);
    assert.equal(shown[1].styleProps["--indent"], "2");
    assert.equal(shown[1].className.includes("md-raw"), true);
    assert.equal(shown[1].className.includes("md-li"), true);
    assert.equal(shown[1].dataset.marker, undefined);
    assert.equal(shown[3].styleProps["--indent"], "0");
    assert.equal(shown[3].dataset.marker, "1. ");
    assert.equal(shown[4].styleProps["--indent"], "3");
    assert.equal(shown[4].dataset.marker, "2. ");
    assert.equal(shown[5].styleProps["--indent"], "4");
    assert.equal(shown[5].dataset.marker, "3.\t");
    view.destroy();

    const editor = createEditor(root, "ab", 1);
    const text = shown[0].childNodes[0].childNodes[0];
    assert.equal(text.textContent, "ab");
    selection = {
      rangeCount: 1,
      anchorNode: text,
      anchorOffset: 0,
      focusNode: text,
      focusOffset: 0,
    };
    let event = key();
    assert.equal(event.defaultPrevented, true);
    assert.equal(editor.getState().doc, "\tab");
    assert.equal(editor.getState().cursor, 1);
    selection = null;

    listeners.beforeinput({
      inputType: "insertText",
      data: "\t",
      preventDefault() {},
    });
    assert.equal(editor.getState().doc, "\tab");
    assert.equal(editor.getState().cursor, 1);

    event = key();
    assert.equal(editor.getState().doc, "\t\tab");
    assert.equal(editor.getState().cursor, 2);

    event = key({ shiftKey: true });
    assert.equal(event.defaultPrevented, false);
    assert.equal(editor.getState().doc, "\t\tab");
    for (const flag of ["ctrlKey", "altKey", "metaKey"]) {
      event = key({ [flag]: true });
      assert.equal(event.defaultPrevented, false);
      assert.equal(editor.getState().doc, "\t\tab");
    }

    listeners.beforeinput({
      inputType: "insertText",
      data: "Z",
      preventDefault() {},
    });
    assert.equal(editor.getState().doc, "\t\tZab");

    listeners.paste({
      preventDefault() {},
      clipboardData: { getData: () => "\t" },
    });
    assert.equal(editor.getState().doc, "\t\tZ\tab");
    editor.destroy();
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("prism keyword joins", () => {
  const source = readFileSync(new URL("../vendor/prism.js", import.meta.url), "utf8");
  const context = {};
  vm.createContext(context);
  vm.runInContext(source, context);
  const Prism = context.Prism;
  assert.ok(Prism);
  assert.equal(Prism.languages.js, Prism.languages.javascript);
  assert.equal(Prism.languages.ts, Prism.languages.typescript);
  assert.equal(Prism.languages.py, Prism.languages.python);
  assert.equal(Prism.languages.sh, Prism.languages.bash);
  assert.equal(Prism.languages.shell, Prism.languages.bash);
  assert.equal(Prism.languages.yml, Prism.languages.yaml);
  assert.equal(Prism.languages.html, Prism.languages.markup);
  assert.ok(Prism.languages.xml);
  assert.ok(Prism.languages.mermaid);
  const line = "def";
  const tokens = Prism.tokenize(line, Prism.languages.python);
  const textOf = (token) => {
    if (typeof token === "string") return token;
    if (Array.isArray(token)) return token.map(textOf).join("");
    return textOf(token.content);
  };
  const hasKeyword = (token) => {
    if (!token || typeof token === "string") return false;
    if (Array.isArray(token)) return token.some(hasKeyword);
    if (token.type === "keyword") return true;
    return hasKeyword(token.content);
  };
  assert.equal(tokens.map(textOf).join(""), line);
  assert.equal(hasKeyword(tokens), true);

  const previous = globalThis.Prism;
  globalThis.Prism = Prism;
  try {
    const bodyOf = (lang, text) => {
      const doc = `\`\`\`${lang}\n${text}\n\`\`\`\n`;
      const found = plan(doc, doc.length).lines.find((item) => item.text === text);
      assert.ok(found);
      assert.equal(found.runs.map((run) => run.text).join(""), text);
      for (let i = 1; i < found.runs.length; i += 1) assert.equal(found.runs[i - 1].end, found.runs[i].start);
      return found;
    };
    const keywordRun = (block, text) => block.runs.find((run) => run.text === text && run.classes.includes("keyword"));
    assert.deepEqual(keywordRun(bodyOf("py", "def"), "def").classes, ["md-codeblock", "token", "keyword"]);
    assert.ok(keywordRun(bodyOf("python", "def"), "def"));
    assert.ok(keywordRun(bodyOf("js", "return"), "return"));
    assert.ok(keywordRun(bodyOf("ts", "return"), "return"));
    assert.ok(keywordRun(bodyOf("sh", "fi"), "fi"));
    assert.ok(keywordRun(bodyOf("shell", "fi"), "fi"));
    const yaml = bodyOf("yml", "a: true");
    assert.ok(yaml.runs.some((run) => run.text === "true" && run.classes.includes("boolean") && run.classes.includes("token")));
    const html = bodyOf("html", "<div>");
    assert.ok(html.runs.some((run) => run.classes.includes("tag")));
    const xml = bodyOf("xml", "<div>");
    assert.equal(xml.runs.map((run) => run.text).join(""), "<div>");
    const plain = bodyOf("diagram", "A");
    assert.equal(plain.runs.length, 1);
    assert.deepEqual(plain.runs[0].classes, ["md-codeblock"]);
    const fences = plan("```js\nfull\n```\n", 100);
    assert.equal(fences.lines[0].runs[0].text, "```js");
    assert.deepEqual(fences.lines[0].runs[0].classes, ["md-codeblock"]);
  } finally {
    if (previous === undefined) delete globalThis.Prism;
    else globalThis.Prism = previous;
  }

  const mermaid = readFileSync(new URL("../vendor/mermaid.min.js", import.meta.url), "utf8");
  assert.match(mermaid, /globalThis\.mermaid\s*=/);
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const prismAt = html.indexOf('<script src="vendor/prism.js"></script>');
  const mermaidAt = html.indexOf('<script src="vendor/mermaid.min.js"></script>');
  const moduleAt = html.indexOf('<script type="module" src="src/editor.js"></script>');
  assert.ok(prismAt >= 0 && prismAt < mermaidAt && mermaidAt < moduleAt);
  const css = readFileSync(new URL("../editor.css", import.meta.url), "utf8");
  assert.match(css, /\.md-fence-collapsed\s*\{[^}]*height:\s*0;[^}]*overflow:\s*hidden;[^}]*margin:\s*0;[^}]*min-height:\s*0;/);
  assert.match(css, /\.token\.keyword\s*\{[^}]*color:\s*#ff7b72;/);
  assert.match(css, /:root\s*\{[^}]*color-scheme:\s*dark;/);
  assert.match(css, /body\s*\{[^}]*background:\s*#1c1b19;[^}]*color:\s*#e7e2d8;/);
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /The markdown is GitHub, GitLab, and Obsidian markdown\. A mermaid fence is a diagram\./);
  assert.match(readme, /HTML is not allowed in the document\./);
});

function nodeListView(kids) {
  const list = {
    get length() {
      return kids.length;
    },
    item(index) {
      return index >= 0 && index < kids.length ? kids[index] : null;
    },
    [Symbol.iterator]() {
      return kids[Symbol.iterator]();
    },
  };
  return new Proxy(list, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && /^(0|[1-9]\d*)$/.test(prop)) {
        const index = Number(prop);
        return index < kids.length ? kids[index] : undefined;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function mountEditor(options = {}) {
  const nodeList = options.nodeList === true;
  const listeners = {};
  let root = null;
  function makeElement(tag) {
    const kids = [];
    const el = {
      nodeType: 1,
      tagName: String(tag).toUpperCase(),
      nodeName: String(tag).toUpperCase(),
      localName: String(tag).toLowerCase(),
      className: "",
      dataset: {},
      childNodes: nodeList ? nodeListView(kids) : kids,
      parentElement: null,
      styleProps: {},
      listeners: {},
      focused: false,
      hidden: false,
      value: "",
      attrs: new Map(),
    };
    if (nodeList) el._kids = kids;
    el.style = {
      setProperty(name, value) {
        el.styleProps[name] = value;
      },
    };
    el.classList = {
      contains(name) {
        return el.className.split(/\s+/).filter(Boolean).includes(name);
      },
      add(name) {
        if (!el.classList.contains(name)) el.className = `${el.className} ${name}`.trim();
      },
      remove(name) {
        el.className = el.className.split(/\s+/).filter((item) => item && item !== name).join(" ");
      },
    };
    if (nodeList) {
      Object.defineProperty(el, "nextSibling", {
        get() {
          const siblings = el.parentElement && el.parentElement._kids;
          if (!siblings) return null;
          const index = siblings.indexOf(el);
          if (index < 0 || index + 1 >= siblings.length) return null;
          return siblings[index + 1];
        },
      });
      el.removeChild = (child) => {
        const index = el._kids.indexOf(child);
        if (index >= 0) el._kids.splice(index, 1);
        if (child.parentElement === el) child.parentElement = null;
        return child;
      };
      el.appendChild = (child) => {
        if (child.parentElement && typeof child.parentElement.removeChild === "function") {
          child.parentElement.removeChild(child);
        }
        child.parentElement = el;
        el._kids.push(child);
        return child;
      };
      el.insertBefore = (node, before) => {
        if (node.parentElement && typeof node.parentElement.removeChild === "function") {
          node.parentElement.removeChild(node);
        }
        if (before == null) return el.appendChild(node);
        const index = el._kids.indexOf(before);
        if (index < 0) return el.appendChild(node);
        node.parentElement = el;
        el._kids.splice(index, 0, node);
        return node;
      };
      el.replaceChildren = (...children) => {
        for (const child of [...el._kids]) child.parentElement = null;
        el._kids.length = 0;
        for (const child of children) el.appendChild(child);
      };
    } else {
      el.appendChild = (child) => {
        child.parentElement = el;
        el.childNodes.push(child);
        return child;
      };
      el.replaceChildren = (...children) => {
        for (const child of el.childNodes) child.parentElement = null;
        el.childNodes = [];
        for (const child of children) el.appendChild(child);
      };
    }
    el.append = (...children) => {
      for (const child of children) el.appendChild(child);
    };
    el.setAttribute = (name, value) => {
      el.attrs.set(name, String(value));
      if (name === "hidden") el.hidden = true;
    };
    el.getAttribute = (name) => (el.attrs.has(name) ? el.attrs.get(name) : null);
    el.hasAttribute = (name) => el.attrs.has(name);
    el.removeAttribute = (name) => {
      el.attrs.delete(name);
      if (name === "hidden") el.hidden = false;
    };
    el.addEventListener = (type, fn) => {
      el.listeners[type] = fn;
    };
    el.removeEventListener = (type, fn) => {
      if (el.listeners[type] === fn) delete el.listeners[type];
    };
    el.focus = () => {
      el.focused = true;
    };
    Object.defineProperty(el, "textContent", {
      get() {
        const list = nodeList ? el._kids : el.childNodes;
        return list.map((child) => (child.textContent == null ? "" : child.textContent)).join("");
      },
      set(value) {
        const text = value == null ? "" : String(value);
        el.replaceChildren({ nodeType: 3, textContent: text, length: text.length, parentElement: el, childNodes: [] });
      },
    });
    Object.defineProperty(el, "isConnected", {
      get() {
        let node = el;
        while (node) {
          if (node === root) return true;
          node = node.parentElement;
        }
        return false;
      },
    });
    el.closest = (selector) => {
      const parts = selector.split(",").map((part) => part.trim());
      let node = el;
      while (node) {
        for (const part of parts) {
          if (part.startsWith(".") && node.classList && node.classList.contains(part.slice(1))) return node;
          if (node.tagName === part.toUpperCase()) return node;
        }
        node = node.parentElement;
      }
      return null;
    };
    return el;
  }
  root = makeElement("div");
  root.setAttribute = () => {};
  root.querySelectorAll = () => [];
  root.addEventListener = (type, fn) => {
    listeners[type] = fn;
  };
  root.contains = (node) => {
    let current = node;
    while (current) {
      if (current === root) return true;
      current = current.parentElement;
    }
    return false;
  };
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = {
    createElement: (tag) => makeElement(tag),
    createElementNS: (_ns, tag) => makeElement(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: text, length: String(text).length, parentElement: null, childNodes: [] }),
    createTreeWalker: () => ({ nextNode: () => null }),
    createRange: () => ({
      setStart() {},
      collapse() {},
      selectNode() {},
      setStartAfter() {},
      setStartBefore() {},
    }),
  };
  globalThis.window = { getSelection: () => null };
  const findAll = (predicate) => {
    const found = [];
    const walk = (node) => {
      if (predicate(node)) found.push(node);
      for (const child of node.childNodes || []) walk(child);
    };
    for (const child of root.childNodes) walk(child);
    return found;
  };
  return {
    root,
    listeners,
    findAll,
    restore() {
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
    },
  };
}

test("backspace at the visual start of a line joins it upward", () => {
  const mounted = mountEditor();
  globalThis.NodeFilter = globalThis.NodeFilter || { SHOW_TEXT: 4 };
  const press = () => {
    mounted.listeners.beforeinput({
      inputType: "deleteContentBackward",
      preventDefault() {},
    });
  };
  const caret = (node, offset) => {
    globalThis.window.getSelection = () => ({
      rangeCount: 1,
      anchorNode: node,
      anchorOffset: offset,
      focusNode: node,
      focusOffset: offset,
      removeAllRanges() {},
      addRange() {},
      getRangeAt() {
        return {
          startContainer: node,
          startOffset: offset,
          endContainer: node,
          endOffset: offset,
          collapsed: true,
        };
      },
    });
  };
  const lineText = (text) => mounted.findAll((node) => node.classList && node.classList.contains("md-line") && node.textContent === text)[0];
  try {
    const transport = holdingTransport();
    const held = createEditor(mounted.root, "hello\nworld\n", 0, transport);
    caret(lineText("world"), 0);
    press();
    const edit = transport.sent.find((message) => message.type === "edit");
    assert.equal(edit.op, "backspace");
    assert.equal(edit.cursor, 6);
    assert.equal(edit.anchor, 6);
    const lock = transport.sent.filter((message) => message.type === "lock").at(-1);
    assert.equal(Math.min(lock.anchor, lock.cursor), 5);
    assert.equal(Math.max(lock.anchor, lock.cursor), 6);
    held.destroy();

    const view = createEditor(mounted.root, "hello\nworld\n", 0);
    caret(lineText("world"), 0);
    press();
    assert.equal(view.getState().doc, "helloworld\n");
    assert.equal(view.getState().cursor, 5);
    assert.equal(view.getState().anchor, 5);
    press();
    assert.equal(view.getState().doc, "hellworld\n");
    assert.equal(view.getState().cursor, 4);
    view.destroy();

    const word = createEditor(mounted.root, "hello\nworld\n", 0);
    const inside = mounted.findAll((node) => node.nodeType === 3 && node.textContent === "world")[0];
    caret(inside, 1);
    press();
    assert.equal(word.getState().doc, "hello\norld\n");
    assert.equal(word.getState().cursor, 6);
    word.destroy();

    const empty = createEditor(mounted.root, "hello\n\nworld", 0);
    const blank = mounted.findAll((node) => node.classList && node.classList.contains("md-line") && node.dataset.start === node.dataset.end && node.textContent === "")[0];
    caret(blank, 0);
    press();
    assert.equal(empty.getState().doc, "hello\nworld");
    assert.equal(empty.getState().cursor, 5);
    assert.equal(empty.getState().anchor, 5);
    empty.destroy();

    const heading = createEditor(mounted.root, "hello\n# Title\n", 0);
    const title = mounted.findAll((node) => node.nodeType === 3 && node.textContent === "Title")[0];
    caret(title, 0);
    press();
    assert.equal(heading.getState().doc, "hello# Title\n");
    assert.equal(heading.getState().cursor, 5);
    heading.destroy();
  } finally {
    mounted.restore();
  }
});

test("enter at the end of a line inserts a blank line below the caret", () => {
  const mounted = mountEditor();
  const press = (inputType) => {
    mounted.listeners.beforeinput({
      inputType,
      preventDefault() {},
    });
  };
  const lockReaches = (sent, offset) => sent.some((message) => {
    if (message.type !== "lock") return false;
    const lo = Math.min(message.anchor, message.cursor);
    const hi = Math.max(message.anchor, message.cursor);
    return lo <= offset && hi >= offset;
  });
  try {
    const transport = holdingTransport();
    const held = createEditor(mounted.root, "hello\nworld\n", 5, transport);
    press("insertParagraph");
    const edit = transport.sent.find((message) => message.type === "edit");
    assert.equal(edit.op, "insert");
    assert.equal(edit.text, "\n");
    assert.equal(edit.cursor, 5);
    assert.equal(edit.anchor, 5);
    const lock = transport.sent.filter((message) => message.type === "lock").at(-1);
    assert.equal(Math.min(lock.anchor, lock.cursor), 5);
    assert.equal(Math.max(lock.anchor, lock.cursor), 6);
    assert.ok(transport.sent.indexOf(lock) < transport.sent.indexOf(edit));
    held.destroy();

    const broken = holdingTransport();
    const shiftEnter = createEditor(mounted.root, "hello\nworld\n", 5, broken);
    press("insertLineBreak");
    const breakEdit = broken.sent.find((message) => message.type === "edit");
    assert.equal(breakEdit.op, "insert");
    assert.equal(breakEdit.text, "\n");
    assert.equal(breakEdit.cursor, 5);
    assert.equal(breakEdit.anchor, 5);
    const breakLock = broken.sent.filter((message) => message.type === "lock").at(-1);
    assert.equal(Math.min(breakLock.anchor, breakLock.cursor), 5);
    assert.equal(Math.max(breakLock.anchor, breakLock.cursor), 6);
    assert.ok(broken.sent.indexOf(breakLock) < broken.sent.indexOf(breakEdit));
    shiftEnter.destroy();

    const view = createEditor(mounted.root, "hello\nworld\n", 5);
    press("insertParagraph");
    assert.equal(view.getState().doc, "hello\n\nworld\n");
    assert.equal(view.getState().cursor, 6);
    assert.equal(view.getState().anchor, 6);
    view.destroy();

    const middleTransport = holdingTransport();
    const middleHeld = createEditor(mounted.root, "hello\nworld\n", 2, middleTransport);
    press("insertParagraph");
    const middleEdit = middleTransport.sent.find((message) => message.type === "edit");
    assert.equal(middleEdit.op, "insert");
    assert.equal(middleEdit.text, "\n");
    assert.equal(middleEdit.cursor, 2);
    assert.equal(middleEdit.anchor, 2);
    assert.equal(lockReaches(middleTransport.sent, 6), false);
    middleHeld.destroy();

    const middle = createEditor(mounted.root, "hello\nworld\n", 2);
    press("insertParagraph");
    assert.equal(middle.getState().doc, "he\nllo\nworld\n");
    assert.equal(middle.getState().cursor, 3);
    assert.equal(middle.getState().anchor, 3);
    middle.destroy();

    const rejecting = {
      username: "",
      sent: [],
      subscribe(fn) {
        this.listener = fn;
        return () => {};
      },
      send(message) {
        this.sent.push(message);
        if (message.type === "lock" && this.listener) this.listener({ type: "error", status: 409 });
      },
    };
    const blocked = createEditor(mounted.root, "hello\nworld\n", 5, rejecting);
    press("insertParagraph");
    assert.equal(rejecting.sent.some((message) => message.type === "edit"), false);
    assert.equal(blocked.getState().doc, "hello\nworld\n");
    assert.equal(blocked.getState().cursor, 5);
    assert.equal(blocked.getState().anchor, 5);
    blocked.destroy();
  } finally {
    mounted.restore();
  }
});

test("fence clicks open source", () => {
  const mounted = mountEditor();
  try {
    const table = createEditor(mounted.root, D, 33);
    const header = mounted.findAll((node) => node.tagName === "TH" && node.textContent === "a")[0];
    const body = mounted.findAll((node) => node.tagName === "TD" && node.textContent === "1")[0];
    assert.equal(header.dataset.start, "2");
    assert.equal(header.dataset.end, "3");
    assert.equal(body.dataset.start, "26");
    assert.equal(body.dataset.end, "27");
    mounted.listeners.click({ target: body, clientX: 0, clientY: 0, preventDefault() {} });
    assert.equal(table.getState().cursor, 26);
    assert.equal(table.getState().anchor, 26);
    assert.equal(mounted.findAll((node) => node.classList && node.classList.contains("md-table")).length, 0);
    assert.ok(mounted.findAll((node) => node.className && node.className.includes("|")).length > 0 || mounted.findAll((node) => (node.textContent || "").includes("|")).length > 0);
    table.destroy();

    const closed = createEditor(mounted.root, D, 33);
    const atom = mounted.findAll((node) => node.classList && node.classList.contains("md-table"))[0];
    mounted.listeners.click({ target: atom, clientX: 0, clientY: 0, preventDefault() {} });
    assert.equal(closed.getState().cursor, 0);
    assert.equal(closed.getState().anchor, 0);
    closed.destroy();

    const imageView = createEditor(mounted.root, F, 0);
    const image = mounted.findAll((node) => node.classList && node.classList.contains("md-image"))[0];
    mounted.listeners.click({ target: image, clientX: 1, clientY: 1, preventDefault() {} });
    assert.equal(imageView.getState().cursor, 3);
    assert.equal(imageView.getState().anchor, 3);
    assert.equal(mounted.findAll((node) => node.classList && node.classList.contains("md-image")).length, 0);
    assert.ok(mounted.findAll((node) => (node.textContent || "").includes("![alt]")).length > 0);
    imageView.destroy();

    const diagram = createEditor(mounted.root, E, 20);
    const box = mounted.findAll((node) => node.classList && node.classList.contains("md-diagram"))[0];
    const pre = mounted.findAll((node) => node.tagName === "PRE")[0];
    assert.equal(box.dataset.bodyStart, "11");
    assert.equal(pre.textContent, "A-->B");
    mounted.listeners.click({ target: box, clientX: 0, clientY: 0, preventDefault() {} });
    assert.equal(diagram.getState().cursor, 11);
    assert.equal(diagram.getState().anchor, 11);
    assert.equal(mounted.findAll((node) => node.classList && node.classList.contains("md-diagram")).length, 0);
    assert.ok(mounted.findAll((node) => node.className && node.className.includes("md-codeblock")).length >= 3);
    diagram.destroy();

    createEditor(mounted.root, "```js\nfull\n```\n", 20).destroy();
    const brs = mounted.findAll((node) => node.tagName === "BR" && node.classList && node.classList.contains("md-fence-collapsed"));
    assert.equal(brs.length, 2);
    assert.equal(brs[0].dataset.start, "0");
    assert.equal(brs[0].dataset.end, "5");
    assert.equal(brs[1].dataset.start, "11");
    assert.equal(brs[1].dataset.end, "14");
  } finally {
    mounted.restore();
  }
});

test("mermaid render replaces source", async () => {
  const previousMermaid = globalThis.mermaid;
  const previousParser = globalThis.DOMParser;
  const options = [];
  let renders = 0;
  let parsed = 0;
  const mounted = mountEditor();
  globalThis.mermaid = {
    initialize(value) {
      options.push(value);
    },
    render(id, text) {
      renders += 1;
      return Promise.resolve({ svg: `<svg id="${id}">${text}</svg>` });
    },
  };
  globalThis.DOMParser = class {
    parseFromString(value, type) {
      parsed += 1;
      assert.equal(type, "image/svg+xml");
      return {
        documentElement: {
          nodeType: 1,
          tagName: "SVG",
          nodeName: "svg",
          localName: "svg",
          className: "",
          dataset: { value },
          childNodes: [],
          parentElement: null,
          classList: { contains() { return false; }, add() {}, remove() {} },
          textContent: "",
        },
      };
    }
  };
  try {
    const doc = "```mermaid\nA-->B\n```\n```mermaid\nC-->D\n```\n";
    const view = createEditor(mounted.root, doc, doc.length);
    const pres = mounted.findAll((node) => node.tagName === "PRE");
    assert.deepEqual(pres.map((node) => node.textContent), ["A-->B", "C-->D"]);
    assert.deepEqual(options, [{ startOnLoad: false, securityLevel: "strict", theme: "dark", flowchart: { htmlLabels: false }, suppressErrorRendering: true }]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(renders, 2);
    const boxes = mounted.findAll((node) => node.classList && node.classList.contains("md-diagram"));
    assert.equal(parsed, 2);
    assert.equal(boxes.length, 2);
    assert.ok(boxes.every((box) => box.childNodes.some((child) => child.localName === "svg")));
    assert.ok(boxes[0].childNodes.some((child) => child.dataset.value.includes("A-->B")));
    view.destroy();

    let release;
    globalThis.mermaid.render = () => new Promise((resolve) => {
      release = resolve;
    });
    const pending = createEditor(mounted.root, E, 20);
    await Promise.resolve();
    assert.equal(typeof release, "function");
    const old = mounted.findAll((node) => node.classList && node.classList.contains("md-diagram"))[0];
    assert.equal(old.childNodes.some((child) => child.tagName === "PRE"), true);
    mounted.listeners.click({ target: old, clientX: 0, clientY: 0, preventDefault() {} });
    assert.equal(old.isConnected, false);
    const parsedBefore = parsed;
    release({ svg: "<svg></svg>" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(parsed, parsedBefore);
    assert.equal(old.childNodes.some((child) => child.localName === "svg"), false);
    pending.destroy();

    globalThis.mermaid.render = () => Promise.reject(new Error("bad diagram"));
    const failed = createEditor(mounted.root, E, 20);
    const failedBox = mounted.findAll((node) => node.classList && node.classList.contains("md-diagram"))[0];
    assert.equal(failedBox.textContent, "A-->B");
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(failedBox.textContent.includes("A-->B"));
    assert.ok(failedBox.textContent.includes("bad diagram"));
    failed.destroy();
  } finally {
    mounted.restore();
    if (previousMermaid === undefined) delete globalThis.mermaid;
    else globalThis.mermaid = previousMermaid;
    if (previousParser === undefined) delete globalThis.DOMParser;
    else globalThis.DOMParser = previousParser;
  }
});

test("comment spans hide markers off the cursor line", () => {
  const off = plan("Say {c1}fox{/c1} now.\n", 22).lines[0];
  assert.equal(off.raw, false);
  assert.deepEqual(off.runs.map((run) => [run.text, run.start, run.end]), [
    ["Say ", 0, 4],
    ["fox", 8, 11],
    [" now.", 16, 21],
  ]);
  assert.ok(off.runs[0].classes.includes("md-p"));
  assert.equal(off.runs[0].classes.includes("md-syntax"), false);
  assert.ok(off.runs[1].classes.includes("md-comment"));
  assert.equal(off.runs[1].classes.includes("md-syntax"), false);
  assert.ok(off.runs[2].classes.includes("md-p"));

  const raw = plan("Say {c1}fox{/c1} now.\n", 0).lines[0];
  assert.equal(raw.raw, true);
  assert.equal(raw.runs.map((run) => run.text).join(""), "Say {c1}fox{/c1} now.");
  const marker = raw.runs.find((run) => run.text === "{c1}");
  assert.deepEqual(marker.classes, ["md-syntax"]);
  const fox = raw.runs.find((run) => run.text === "fox");
  assert.ok(fox.classes.includes("md-comment"));
  assert.equal(fox.classes.includes("md-syntax"), false);
  assert.equal(marker.end, fox.start);

  const bold = plan("**a {c1}fox{/c1} b**\n", 40).lines[0];
  const boldFox = bold.runs.find((run) => run.text === "fox");
  assert.ok(boldFox.classes.includes("md-strong"));
  assert.ok(boldFox.classes.includes("md-comment"));
  assert.equal(boldFox.classes.includes("md-syntax"), false);
  const boldRaw = plan("**a {c1}fox{/c1} b**\n", 0).lines[0];
  assert.equal(boldRaw.runs.map((run) => run.text).join(""), "**a {c1}fox{/c1} b**");
  assert.deepEqual(boldRaw.runs.find((run) => run.text === "{c1}").classes, ["md-syntax"]);
  const boldRawFox = boldRaw.runs.find((run) => run.text === "fox");
  assert.ok(boldRawFox.classes.includes("md-strong"));
  assert.ok(boldRawFox.classes.includes("md-comment"));
  assert.equal(boldRawFox.classes.includes("md-syntax"), false);

  const crossed = plan("{c1}ab\ncd{/c1}\n", 7);
  assert.equal(crossed.lines[0].raw, false);
  assert.equal(crossed.lines[0].runs[0].text, "ab");
  assert.equal(crossed.lines[0].runs[0].start, 4);
  assert.equal(crossed.lines[0].runs[0].end, 6);
  assert.ok(crossed.lines[0].runs[0].classes.includes("md-comment"));
  assert.equal(crossed.lines[1].raw, true);
  assert.equal(crossed.lines[1].runs.map((run) => run.text).join(""), "cd{/c1}");

  const fenced = plan("```python\n{c1}x{/c1}\n```\n", 30);
  assert.equal(fenced.comments.length, 0);
  assert.ok(fenced.lines.some((line) => line.text.includes("{c1}x{/c1}")));
  assert.equal(fenced.lines.some((line) => line.runs.some((run) => run.classes.includes("md-comment"))), false);
});

test("a resolved fence keeps the span and a :: line splits notes", () => {
  const plain = plan("Say {c1}fox{/c1} now.\n\n```comment c1\n**hi**\n```\n", 40);
  assert.equal(plain.comments[0].resolved, false);
  assert.equal(plain.comments[0].body, "**hi**");
  const resolved = "Say {c1}fox{/c1} now.\n\n```comment c1 resolved\nhi\n::\nmore\n```\n";
  const planned = plan(resolved, 40);
  assert.equal(planned.comments.length, 1);
  assert.equal(planned.comments[0].id, "c1");
  assert.equal(planned.comments[0].resolved, true);
  assert.equal(planned.comments[0].body, "hi\n::\nmore");
  assert.equal(planned.lines.some((line) => line.text.includes("resolved") || line.text.includes("::")), false);
  const fox = planned.lines[0].runs.find((run) => run.text === "fox");
  assert.ok(fox.classes.includes("md-comment"));
});

test("comment threads stay out of the editor lines", () => {
  const doc = "Say {c1}fox{/c1} now.\n\n```comment c1\n**hi**\n```\n";
  const planned = plan(doc, 22);
  assert.equal(planned.comments.length, 1);
  assert.equal(planned.comments[0].id, "c1");
  assert.equal(planned.comments[0].body, "**hi**");
  assert.equal(planned.comments[0].start, doc.indexOf("```comment"));
  assert.equal(planned.comments[0].end, doc.length);
  for (const line of planned.lines) {
    assert.equal(line.runs.some((run) => run.text.includes("**hi**")), false);
    assert.equal(line.text.includes("```comment"), false);
  }
});

test("addComment wraps a free range and appends an empty thread", () => {
  const added = addComment("hello fox\n", 6, 9);
  assert.deepEqual(added, {
    id: "c1",
    cursor: 10,
    doc: "hello {c1}fox{/c1}\n\n```comment c1\n\n```\n",
  });
  assert.deepEqual(addComment("hello fox\n", 9, 6), added);
  assert.equal(addComment("hello fox\n", 6, 6), null);
  assert.equal(addComment("hello fox", 6, 9).doc, "hello {c1}fox{/c1}\n\n```comment c1\n\n```\n");

  const nested = addComment(added.doc, 10, 12);
  assert.equal(nested.id, "c2");
  assert.ok(nested.doc.startsWith("hello {c1}{c2}fo"));
  assert.equal(addComment(added.doc, 11, 20), null);
  assert.equal(addComment(added.doc, 0, 4).id, "c2");

  const hole = "a {c1}b{/c1} c {c3}d{/c3}\n";
  assert.equal(addComment(hole, 0, 1).id, "c2");
  assert.equal(addComment("hello {c1} there\n", 0, 5).id, "c2");
  assert.equal(addComment("hello\n\n```comment c1\n\n```\n", 0, 5).id, "c2");
  assert.equal(addComment("```python\nx\n```\n", 12, 13), null);
  assert.equal(addComment(D, 2, 3), null);
  assert.equal(addComment(E, 4, 8), null);
});

test("deleting an empty comment interior drops the span and the thread", () => {
  const marked = "A {c1}x{/c1} B\n\n```comment c1\nhi\n```\n";
  let emptied = backspace(createState(marked, 7));
  assert.equal(emptied.doc, "A  B\n\n");
  assert.equal(emptied.cursor, 2);
  assert.equal(emptied.undo.length, 1);
  emptied = undo(emptied);
  assert.equal(emptied.doc, marked);
  assert.equal(emptied.cursor, 7);

  const partial = backspace(createState("A {c1}xy{/c1} B\n\n```comment c1\nhi\n```\n", 8));
  assert.equal(partial.doc, "A {c1}x{/c1} B\n\n```comment c1\nhi\n```\n");
  assert.equal(partial.cursor, 7);

  const forward = deleteForward(createState(marked, 6));
  assert.equal(forward.doc, "A  B\n\n");
  assert.equal(forward.cursor, 2);

  const kept = "A {c1}x{/c1} B\n\n```comment c1\nhi\n```\nafter\n";
  const removed = backspace(createState(kept, 7));
  assert.equal(removed.doc, "A  B\n\nafter\n");
  assert.equal(removed.cursor, 2);

  let replaced = createState("A {c1}xy{/c1} B\n\n```comment c1\nhi\n```\n", 8, 6);
  replaced = insert(replaced, "");
  assert.equal(replaced.doc, "A  B\n\n");
  replaced = undo(replaced);
  assert.equal(replaced.doc, "A {c1}xy{/c1} B\n\n```comment c1\nhi\n```\n");
});

function mountSheet() {
  const listeners = {};
  let root = null;
  let selection = null;
  function makeElement(tag) {
    const el = {
      nodeType: 1,
      tagName: String(tag).toUpperCase(),
      nodeName: String(tag).toUpperCase(),
      localName: String(tag).toLowerCase(),
      className: "",
      dataset: {},
      childNodes: [],
      parentElement: null,
      styleProps: {},
      listeners: {},
      value: "",
      hidden: false,
      selectionStart: 0,
      selectionEnd: 0,
      focused: false,
      attrs: new Map(),
    };
    el.style = {
      setProperty(name, value) {
        el.styleProps[name] = value;
      },
    };
    el.classList = {
      contains(name) {
        return el.className.split(/\s+/).filter(Boolean).includes(name);
      },
      add(name) {
        if (!el.classList.contains(name)) el.className = `${el.className} ${name}`.trim();
      },
      remove(name) {
        el.className = el.className.split(/\s+/).filter((item) => item && item !== name).join(" ");
      },
    };
    el.appendChild = (child) => {
      child.parentElement = el;
      el.childNodes.push(child);
      return child;
    };
    el.append = (...children) => {
      for (const child of children) el.appendChild(child);
    };
    el.replaceChildren = (...children) => {
      for (const child of el.childNodes) child.parentElement = null;
      el.childNodes = [];
      for (const child of children) el.appendChild(child);
    };
    el.removeChild = (child) => {
      el.childNodes = el.childNodes.filter((item) => item !== child);
      child.parentElement = null;
      return child;
    };
    el.insertBefore = (node, before) => {
      if (!before) return el.appendChild(node);
      const index = el.childNodes.indexOf(before);
      if (index < 0) return el.appendChild(node);
      node.parentElement = el;
      el.childNodes.splice(index, 0, node);
      return node;
    };
    el.setAttribute = (name, value) => {
      el.attrs.set(name, String(value));
      if (name === "hidden") el.hidden = true;
      if (name === "type") el.type = String(value);
    };
    el.getAttribute = (name) => (el.attrs.has(name) ? el.attrs.get(name) : null);
    el.hasAttribute = (name) => el.attrs.has(name);
    el.removeAttribute = (name) => {
      el.attrs.delete(name);
      if (name === "hidden") el.hidden = false;
    };
    el.addEventListener = (type, fn) => {
      el.listeners[type] = fn;
    };
    el.removeEventListener = (type, fn) => {
      if (el.listeners[type] === fn) delete el.listeners[type];
    };
    el.focus = () => {
      el.focused = true;
    };
    el.blur = () => {
      el.focused = false;
    };
    Object.defineProperty(el, "offsetHeight", { get() { return 30; } });
    el.getBoundingClientRect = () => {
      const top = el.dataset && el.dataset.start != null && el.dataset.start !== "" ? Number(el.dataset.start) : 0;
      return { top, left: 0, right: 20, bottom: top + 10, width: 20, height: 10 };
    };
    Object.defineProperty(el, "textContent", {
      get() {
        return el.childNodes.map((child) => (child.textContent == null ? "" : child.textContent)).join("");
      },
      set(value) {
        const text = value == null ? "" : String(value);
        el.replaceChildren({ nodeType: 3, textContent: text, length: text.length, parentElement: el, childNodes: [] });
      },
    });
    Object.defineProperty(el, "isConnected", {
      get() {
        let node = el;
        while (node) {
          if (node === root) return true;
          node = node.parentElement;
        }
        return false;
      },
    });
    el.closest = (selector) => {
      const parts = selector.split(",").map((part) => part.trim());
      let node = el;
      while (node) {
        for (const part of parts) {
          if (part.startsWith(".") && node.classList && node.classList.contains(part.slice(1))) return node;
          if (node.tagName === part.toUpperCase()) return node;
        }
        node = node.parentElement;
      }
      return null;
    };
    return el;
  }
  const sheet = makeElement("div");
  sheet.className = "sheet";
  root = makeElement("div");
  const aside = makeElement("aside");
  aside.className = "comments";
  sheet.append(root, aside);
  const body = makeElement("body");
  root.setAttribute = () => {};
  root.querySelectorAll = () => [];
  root.addEventListener = (type, fn) => {
    listeners[type] = fn;
  };
  root.contains = (node) => {
    let current = node;
    while (current) {
      if (current === root) return true;
      current = current.parentElement;
    }
    return false;
  };
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = {
    body,
    createElement: (tag) => makeElement(tag),
    createElementNS: (_ns, tag) => makeElement(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: text, length: String(text).length, parentElement: null, childNodes: [] }),
    createTreeWalker: () => ({ nextNode: () => null }),
    createRange: () => ({
      setStart() {},
      collapse() {},
      selectNode() {},
      setStartAfter() {},
      setStartBefore() {},
    }),
  };
  globalThis.window = {
    getSelection: () => selection,
    matchMedia: () => ({ matches: false }),
  };
  const findAll = (predicate) => {
    const found = [];
    const walk = (node) => {
      if (predicate(node)) found.push(node);
      for (const child of node.childNodes || []) walk(child);
    };
    walk(sheet);
    walk(body);
    return found;
  };
  return {
    root,
    aside,
    body,
    listeners,
    findAll,
    setSelection(value) {
      selection = value;
    },
    restore() {
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
    },
  };
}

function docMenuOf(aside) {
  const button = (aside.childNodes || []).find((node) => node.classList && node.classList.contains("md-doc-menu"));
  const panel = (aside.childNodes || []).find((node) => node.classList && node.classList.contains("md-doc-menu-panel"));
  const checkbox = panel && (panel.childNodes || []).find((node) => node.tagName === "INPUT" && node.type === "checkbox");
  const label = panel && (panel.childNodes || []).find((node) => node.tagName === "LABEL");
  const commit = panel && (panel.childNodes || []).find((node) => node.classList && node.classList.contains("md-doc-commit"));
  return { button, panel, checkbox, label, commit };
}

test("comment cards edit the thread and line up with the highlight", () => {
  const mounted = mountSheet();
  try {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    assert.match(html, /<body>\s*<dialog class="md-login">\s*<form>\s*<label>Username<input class="md-login-name" name="username" autocomplete="username" placeholder="Username"><\/label>\s*<button type="submit">Continue<\/button>\s*<\/form>\s*<\/dialog>\s*<div class="sheet">\s*<nav class="files"><button type="button" class="md-new-file">\+<\/button><\/nav>\s*<div id="editor"><\/div>\s*<aside class="comments"><\/aside>/);
    const css = readFileSync(new URL("../editor.css", import.meta.url), "utf8");
    assert.match(css, /dialog\.md-login\s*\{[^}]*background:\s*#242320/);
    assert.match(css, /dialog\.md-login\s*\{[^}]*color:\s*#e7e2d8/);
    assert.match(css, /dialog\.md-login\s*\{[^}]*border:\s*1px solid #3f3c37/);
    assert.match(css, /dialog\.md-login\s*\{[^}]*border-radius:\s*6px/);
    assert.match(css, /dialog\.md-login\s*\{[^}]*padding:\s*1rem 1\.1rem/);
    assert.match(css, /dialog\.md-login\s*\{[^}]*width:\s*18rem/);
    assert.match(css, /dialog\.md-login input\s*\{[^}]*background:\s*#1c1b19/);
    assert.match(css, /dialog\.md-login input\s*\{[^}]*border:\s*1px solid #4a463f/);
    assert.match(css, /dialog\.md-login input\s*\{[^}]*color:\s*inherit/);
    assert.match(css, /dialog\.md-login input\s*\{[^}]*width:\s*100%/);
    assert.match(css, /dialog\.md-login input\s*\{[^}]*box-sizing:\s*border-box/);
    assert.match(css, /dialog\.md-login input\s*\{[^}]*font:\s*inherit/);
    assert.match(css, /dialog\.md-login button\[type="submit"\]\s*\{[^}]*border:\s*1px solid #5c574e/);
    assert.match(css, /dialog\.md-login button\[type="submit"\]\s*\{[^}]*background:\s*#2a2826/);
    assert.match(css, /dialog\.md-login button\[type="submit"\]\s*\{[^}]*color:\s*#e7e2d8/);
    assert.match(css, /dialog\.md-login::backdrop\s*\{[^}]*background:\s*rgba\(0,\s*0,\s*0,\s*0\.55\)/);
    assert.match(css, /\.md-comment-author\s*\{[^}]*min-height:\s*1\.25em;/);
    assert.match(css, /\.md-comment-text\s*\{[^}]*white-space:\s*pre-wrap;/);
    assert.match(css, /\.md-comment-text\s*\{[^}]*overflow-wrap:\s*anywhere;/);
    assert.match(css, /\.md-comment-text\s*\{[^}]*cursor:\s*text;/);
    assert.match(css, /\.md-comment-text\s*\{[^}]*min-height:\s*1\.25em;/);
    assert.match(css, /@media \(max-width:\s*800px\)\s*\{[^]*aside\.comments\s*\{[^}]*width:\s*100%;/);
    assert.match(css, /@media \(max-width:\s*800px\)\s*\{[^]*aside\.comments\s*\{[^}]*padding:\s*calc\(1\.75rem \+ 0\.65rem\) 1\.4rem 2rem/);
    assert.equal(/@media \(max-width:\s*800px\)\s*\{[^]*button\.md-doc-menu/.test(css), false);
    assert.match(css, /@media \(max-width:\s*800px\)\s*\{[^]*\.sheet\s*\{[^}]*display:\s*block;/);
    assert.match(css, /aside\.comments\s*\{[^}]*position:\s*relative;/);
    const menuRule = css.match(/button\.md-doc-menu\s*\{[^}]*\}/);
    assert.ok(menuRule);
    assert.match(menuRule[0], /position:\s*absolute/);
    assert.match(menuRule[0], /top:\s*0\.45rem/);
    assert.match(menuRule[0], /right:\s*0\.45rem/);
    assert.match(menuRule[0], /z-index:\s*5/);
    assert.match(menuRule[0], /height:\s*1\.75rem/);
    const panelRule = css.match(/div\.md-doc-menu-panel\s*\{[^}]*\}/);
    assert.ok(panelRule);
    assert.match(panelRule[0], /position:\s*absolute/);
    assert.match(panelRule[0], /top:\s*2\.2rem/);
    assert.match(panelRule[0], /right:\s*0\.45rem/);
    assert.match(panelRule[0], /z-index:\s*6/);
    assert.match(css, /div\.md-doc-menu-panel\[hidden\]\s*\{[^}]*display:\s*none/);
    assert.equal(/button\.md-commit\s*\{/.test(css), false);
    const src = readFileSync(new URL("../src/editor.js", import.meta.url), "utf8");
    assert.equal(src.includes("innerHTML"), false);

    const view = createEditor(mounted.root, "hello fox two deer\n", 0);
    const text = mounted.root.childNodes[0].childNodes[0].childNodes[0];
    assert.equal(text.textContent, "hello fox two deer");
    mounted.listeners.mousedown({ clientX: 0, clientY: 0 });
    mounted.setSelection({
      rangeCount: 1,
      anchorNode: text,
      anchorOffset: 6,
      focusNode: text,
      focusOffset: 9,
      getRangeAt() {
        return {
          collapsed: false,
          commonAncestorContainer: text,
          getClientRects() {
            return [{ top: 40, left: 8, right: 72, bottom: 58, width: 64, height: 18 }];
          },
        };
      },
    });
    mounted.listeners.mouseup({ clientX: 30, clientY: 12 });
    const button = mounted.findAll((node) => node.className === "md-add-comment")[0];
    assert.equal(button.textContent, "Add comment");
    assert.equal(button.hidden, false);
    assert.equal(button.styleProps.left, "72px");
    assert.equal(button.styleProps.top, "40px");
    let prevented = false;
    button.listeners.mousedown({
      preventDefault() {
        prevented = true;
      },
    });
    assert.equal(prevented, true);
    assert.equal(view.getState().doc, "hello {c1}fox{/c1} two deer\n\n```comment c1\n\n```\n");
    assert.equal(view.getState().cursor, 10);
    let box = mounted.findAll((node) => node.tagName === "TEXTAREA")[0];
    assert.equal(box.value, "");
    assert.equal(box.className.includes("md-comment-body"), true);
    assert.equal(box.focused, true);
    assert.equal(box.selectionStart, 0);
    const author = mounted.findAll((node) => node.classList && node.classList.contains("md-comment-author"))[0];
    assert.equal(author.tagName, "SPAN");
    assert.equal(author.textContent, "");
    assert.equal(mounted.findAll((node) => node.getAttribute && node.getAttribute("aria-label") === "Resolve").length, 0);
    assert.equal(mounted.findAll((node) => node.getAttribute && node.getAttribute("aria-label") === "Reply").length, 0);
    assert.equal(mounted.findAll((node) => node.getAttribute && node.getAttribute("aria-label") === "Delete").length, 0);
    assert.equal(mounted.findAll((node) => (node.textContent || "").includes("```comment")).length, 0);

    const mark = mounted.findAll((node) => node.classList && node.classList.contains("md-comment"))[0];
    mounted.listeners.click({
      target: mark,
      clientX: 1,
      clientY: 1,
      preventDefault() {},
    });
    box.focused = false;
    let clickPrevented = false;
    mounted.listeners.click({
      target: mark,
      clientX: 1,
      clientY: 1,
      preventDefault() {
        clickPrevented = true;
      },
    });
    assert.equal(clickPrevented, true);
    box = mounted.findAll((node) => node.tagName === "TEXTAREA")[0];
    assert.equal(box.focused, true);

    box.value = "h";
    box.selectionStart = 1;
    box.selectionEnd = 1;
    mounted.aside.listeners.input({ target: box });
    box.value = "hi";
    box.selectionStart = 2;
    box.selectionEnd = 2;
    mounted.aside.listeners.input({ target: box });
    assert.equal(view.getState().doc, "hello {c1}fox{/c1} two deer\n\n```comment c1\n\n```\n");
    assert.equal(view.getState().undo.length, 1);
    const save = mounted.findAll((node) => node.tagName === "BUTTON" && node.textContent === "Save")[0];
    save.listeners.click({ target: save });
    assert.equal(view.getState().doc, "hello {c1}fox{/c1} two deer\n\n```comment c1\nhi\n```\n");
    const savedCard = mounted.findAll((node) => node.classList && node.classList.contains("md-comment-card"))[0];
    const savedNote = savedCard.childNodes[0];
    const savedRow = savedNote.childNodes[0];
    const savedAuthor = savedRow.childNodes[0];
    assert.equal(savedRow.classList.contains("md-comment-author-row"), true);
    assert.equal(savedAuthor.tagName, "SPAN");
    assert.equal(savedAuthor.textContent, "");
    assert.equal(savedAuthor.classList.contains("md-comment-author"), true);
    assert.equal(savedRow.childNodes[1].getAttribute("aria-label"), "Resolve");
    assert.equal(savedRow.childNodes[1].classList.contains("icon-btn"), true);
    assert.equal(savedRow.childNodes[1].classList.contains("resolve"), true);
    assert.equal(savedRow.childNodes[1].textContent, "");
    assert.equal(savedRow.childNodes.at(-1).classList.contains("md-comment-link"), true);
    assert.equal(savedRow.childNodes.length, 3);
    assert.equal(mounted.findAll((node) => node.tagName === "TEXTAREA").length, 0);
    const savedText = savedNote.childNodes[1];
    assert.equal(savedText.tagName, "DIV");
    assert.equal(savedText.classList.contains("md-comment-text"), true);
    assert.equal(savedText.textContent, "hi");
    assert.equal(mounted.findAll((node) => node.tagName === "BUTTON" && node.textContent === "Save").length, 0);
    assert.equal(mounted.findAll((node) => node.tagName === "BUTTON" && node.textContent === "Cancel").length, 0);
    assert.equal(view.getState().undo.length, 2);
    mounted.aside.listeners.click({ target: savedText, preventDefault() {} });
    box = mounted.findAll((node) => node.tagName === "TEXTAREA")[0];
    assert.equal(box.value, "hi");
    assert.equal(box.focused, true);
    assert.equal(box.selectionStart, 2);
    assert.equal(box.selectionEnd, 2);
    let undoPrevented = false;
    mounted.aside.listeners.keydown({
      key: "z",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      target: box,
      preventDefault() {
        undoPrevented = true;
      },
    });
    assert.equal(undoPrevented, true);
    assert.equal(view.getState().doc, "hello {c1}fox{/c1} two deer\n\n```comment c1\n\n```\n");
    box = mounted.findAll((node) => node.tagName === "TEXTAREA")[0];
    assert.equal(box.value, "");

    view.destroy();
    mounted.setSelection(null);

    const first = addComment("one fox two deer\n", 4, 7);
    const deerAt = first.doc.indexOf("deer");
    const second = addComment(first.doc, deerAt, deerAt + 4);
    globalThis.window.matchMedia = () => ({ matches: false });
    const aligned = createEditor(mounted.root, second.doc, second.cursor);
    const cards = mounted.findAll((node) => node.classList && node.classList.contains("md-comment-card"));
    assert.equal(cards.length, 2);
    assert.deepEqual(cards.map((card) => card.dataset.comment), ["c1", "c2"]);
    const tops = cards.map((card) => Number.parseFloat(card.styleProps.top));
    assert.equal(cards[0].styleProps.position, "absolute");
    assert.equal(cards[0].styleProps.top, "42px");
    assert.ok(tops[1] >= tops[0] + 30);
    const menu = docMenuOf(mounted.aside);
    assert.equal(mounted.aside.childNodes[0], menu.button);
    assert.equal(mounted.aside.childNodes[1], menu.panel);
    assert.equal(menu.button.tagName, "BUTTON");
    assert.equal(menu.button.type, "button");
    assert.equal(menu.button.getAttribute("aria-label"), "Menu");
    assert.equal(menu.button.childNodes.filter((node) => node.classList && node.classList.contains("md-doc-menu-bar")).length, 0);
    assert.equal(menu.button.childNodes.length, 1);
    assert.equal(menu.button.childNodes[0].localName, "svg");
    assert.deepEqual(iconPaths(menu.button), ["M4 6h16M4 12h16M4 18h16"]);
    assert.equal(menu.button.textContent, "");
    assert.equal(menu.button.childNodes.every((node) => node.nodeType === 1), true);
    assert.equal(menu.panel.hidden, true);
    assert.equal(menu.checkbox.type, "checkbox");
    assert.equal(menu.checkbox.checked, false);
    assert.equal(menu.checkbox.disabled, false);
    assert.equal(menu.checkbox.parentElement, menu.panel);
    assert.notEqual(mounted.aside.childNodes[0], menu.checkbox);
    assert.equal(menu.label.tagName, "LABEL");
    assert.equal(menu.label.textContent, "show resolved");
    assert.equal(menu.label.parentElement, menu.panel);
    assert.equal((menu.panel.childNodes || []).some((node) => node.textContent === "Delete"), false);
    assert.ok(Number.parseFloat(cards[0].styleProps.top) >= menu.button.offsetHeight);
    const keptButton = menu.button;
    const keptPanel = menu.panel;
    menu.button.listeners.click({ preventDefault() {} });
    assert.equal(menu.panel.hidden, false);
    menu.button.listeners.click({ preventDefault() {} });
    assert.equal(menu.panel.hidden, true);
    menu.checkbox.checked = true;
    menu.checkbox.listeners.change();
    const rerendered = docMenuOf(mounted.aside);
    assert.equal(rerendered.button, keptButton);
    assert.equal(rerendered.panel, keptPanel);
    assert.equal(rerendered.panel.hidden, true);
    assert.equal(rerendered.checkbox.checked, true);
    assert.equal(rerendered.checkbox.parentElement, keptPanel);
    assert.equal(mounted.findAll((node) => node.classList && node.classList.contains("md-comment-card")).length, 2);
    rerendered.checkbox.checked = false;
    rerendered.checkbox.listeners.change();

    globalThis.window.matchMedia = () => ({ matches: true });
    mounted.listeners.resize = null;
    aligned.destroy();
    const narrow = createEditor(mounted.root, second.doc, second.cursor);
    const stacked = mounted.findAll((node) => node.classList && node.classList.contains("md-comment-card"));
    assert.deepEqual(stacked.map((card) => card.dataset.comment), ["c1", "c2"]);
    assert.ok(stacked.every((card) => card.styleProps.position === "static"));
    const narrowMenu = docMenuOf(mounted.aside);
    assert.equal(mounted.aside.childNodes[0], narrowMenu.button);
    assert.equal(narrowMenu.button.getAttribute("aria-label"), "Menu");
    assert.equal(narrowMenu.button.styleProps.position, undefined);
    assert.equal(narrowMenu.button.styleProps.top, undefined);
    assert.equal(narrowMenu.checkbox.type, "checkbox");
    assert.equal(narrowMenu.checkbox.parentElement, narrowMenu.panel);
    assert.notEqual(mounted.aside.childNodes[0], narrowMenu.checkbox);
    assert.equal(narrowMenu.label.textContent, "show resolved");
    assert.equal(narrowMenu.panel.hidden, true);
    narrow.destroy();
  } finally {
    mounted.restore();
  }
});

test("comment cards save, reply, resolve, and discard without writing keystrokes", () => {
  const mounted = mountSheet();
  const matchesLabel = (node, label) => node && node.tagName === "BUTTON" && (
    node.textContent === label || (typeof node.getAttribute === "function" && node.getAttribute("aria-label") === label)
  );
  const buttons = (label) => mounted.findAll((node) => matchesLabel(node, label));
  const press = (label) => {
    const button = buttons(label).at(-1);
    assert.ok(button, label);
    button.listeners.click({ target: button, preventDefault() {} });
    return button;
  };
  const pressIn = (parent, label) => {
    const walk = (node) => {
      if (!node) return null;
      if (matchesLabel(node, label)) return node;
      for (const child of node.childNodes || []) {
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    const button = walk(parent);
    assert.ok(button, label);
    button.listeners.click({ target: button, preventDefault() {} });
    return button;
  };
  const areas = () => mounted.findAll((node) => node.tagName === "TEXTAREA");
  const texts = () => mounted.findAll((node) => node.classList && node.classList.contains("md-comment-text"));
  const cards = () => mounted.findAll((node) => node.classList && node.classList.contains("md-comment-card"));
  const openText = (node) => {
    mounted.aside.listeners.click({ target: node, preventDefault() {} });
  };
  const chooseFox = () => {
    const text = mounted.root.childNodes[0].childNodes[0].childNodes[0];
    mounted.listeners.mousedown({ clientX: 0, clientY: 0 });
    mounted.setSelection({
      rangeCount: 1,
      anchorNode: text,
      anchorOffset: 6,
      focusNode: text,
      focusOffset: 9,
      getRangeAt() {
        return {
          collapsed: false,
          commonAncestorContainer: text,
          getClientRects() {
            return [{ top: 12, left: 0, right: 40, bottom: 28, width: 40, height: 16 }];
          },
        };
      },
    });
    mounted.listeners.mouseup({ clientX: 30, clientY: 12 });
  };
  try {
    const fresh = createEditor(mounted.root, "hello fox two deer\n", 0);
    const openedMenu = docMenuOf(mounted.aside);
    const checkbox = openedMenu.checkbox;
    const label = openedMenu.label;
    assert.equal(checkbox.type, "checkbox");
    assert.equal(checkbox.checked, false);
    assert.equal(checkbox.disabled, false);
    assert.equal(checkbox.parentElement, openedMenu.panel);
    assert.notEqual(mounted.aside.childNodes[0], checkbox);
    assert.equal(label.tagName, "LABEL");
    assert.equal(label.textContent, "show resolved");
    assert.equal(label.parentElement, openedMenu.panel);
    assert.equal(openedMenu.panel.hidden, true);
    chooseFox();
    const add = mounted.findAll((node) => node.className === "md-add-comment")[0];
    add.listeners.mousedown({ preventDefault() {} });
    assert.equal(fresh.getState().doc, "hello {c1}fox{/c1} two deer\n\n```comment c1\n\n```\n");
    assert.equal(buttons("Resolve").length, 0);
    assert.equal(buttons("Reply").length, 0);
    assert.equal(buttons("Delete").length, 0);
    assert.equal(buttons("Save").length, 1);
    assert.equal(buttons("Cancel").length, 1);
    const author = mounted.findAll((node) => node.classList && node.classList.contains("md-comment-author"))[0];
    assert.equal(author.tagName, "SPAN");
    assert.equal(author.textContent, "");
    mounted.aside.listeners.input({ target: author });
    let box = areas()[0];
    box.value = "hi";
    mounted.aside.listeners.input({ target: box });
    assert.equal(fresh.getState().doc, "hello {c1}fox{/c1} two deer\n\n```comment c1\n\n```\n");
    press("Cancel");
    assert.equal(fresh.getState().doc, "hello fox two deer\n");
    assert.equal(fresh.getState().undo.length, 2);
    fresh.destroy();
    mounted.setSelection(null);

    const opened = "hello {c1}fox{/c1} two deer\n\n```comment c1\n\n```\n";
    const saved = createEditor(mounted.root, opened, 0);
    let card = cards()[0];
    const idleRow = card.childNodes[0].childNodes[0];
    assert.equal(idleRow.classList.contains("md-comment-author-row"), true);
    assert.equal(idleRow.childNodes[0].tagName, "SPAN");
    assert.equal(idleRow.childNodes[0].textContent, "");
    assert.equal(idleRow.childNodes[0].classList.contains("md-comment-author"), true);
    assert.equal(idleRow.childNodes[1].getAttribute("aria-label"), "Resolve");
    assert.equal(idleRow.childNodes[1].hidden, true);
    assert.equal(idleRow.childNodes.at(-1).getAttribute("aria-label"), "Copy link");
    assert.equal(idleRow.childNodes.at(-1).hidden, true);
    assert.equal(idleRow.childNodes.length, 3);
    assert.equal(card.childNodes.at(-2).getAttribute("aria-label"), "Reply");
    assert.equal(card.childNodes.at(-2).textContent, "");
    assert.equal(card.childNodes.at(-2).hidden, true);
    assert.equal(card.childNodes.at(-1).getAttribute("aria-label"), "Delete");
    assert.equal(card.childNodes.at(-1).classList.contains("danger"), true);
    assert.equal(card.childNodes.at(-1).textContent, "");
    assert.equal(card.childNodes.at(-1).hidden, true);
    assert.equal(buttons("Save").length, 0);
    assert.equal(areas().length, 0);
    let text = card.childNodes[0].childNodes[1];
    assert.equal(text.tagName, "DIV");
    assert.equal(text.classList.contains("md-comment-text"), true);
    assert.equal(text.textContent, "");
    openText(text.childNodes[0]);
    assert.equal(saved.getState().doc, opened);
    box = areas()[0];
    assert.equal(box.tagName, "TEXTAREA");
    assert.equal(box.value, "");
    assert.equal(box.focused, true);
    assert.equal(box.selectionStart, 0);
    assert.equal(box.selectionEnd, 0);
    assert.equal(buttons("Save").length, 1);
    assert.equal(buttons("Cancel").length, 1);
    box.value = "yo";
    mounted.aside.listeners.input({ target: box });
    assert.equal(saved.getState().doc, opened);
    card = cards()[0];
    pressIn(card.childNodes[0], "Cancel");
    assert.equal(saved.getState().doc, opened);
    assert.equal(areas().length, 0);
    text = cards()[0].childNodes[0].childNodes[1];
    assert.equal(text.textContent, "");
    assert.equal(buttons("Save").length, 0);
    openText(text);
    box = areas()[0];
    box.value = "hi";
    box.selectionStart = 2;
    box.selectionEnd = 2;
    mounted.aside.listeners.input({ target: box });
    const undoBefore = saved.getState().undo.length;
    card = cards()[0];
    pressIn(card.childNodes[0], "Save");
    assert.equal(saved.getState().doc, "hello {c1}fox{/c1} two deer\n\n```comment c1\nhi\n```\n");
    assert.equal(saved.getState().doc.includes("Ada"), false);
    assert.equal(saved.getState().undo.length, undoBefore + 1);
    card = cards()[0];
    pressIn(card, "Reply");
    assert.equal(saved.getState().doc, "hello {c1}fox{/c1} two deer\n\n```comment c1\nhi\n```\n");
    card = cards()[0];
    const reply = card.childNodes.at(-3);
    assert.equal(reply.childNodes[0].classList.contains("md-comment-author-row"), true);
    assert.equal(reply.childNodes[0].childNodes[0].tagName, "SPAN");
    assert.equal(reply.childNodes[0].childNodes[0].textContent, "");
    assert.equal(reply.childNodes[0].childNodes.length, 2);
    assert.equal(reply.childNodes[0].childNodes.at(-1).getAttribute("aria-label"), "Copy link");
    assert.equal(reply.childNodes[1].tagName, "TEXTAREA");
    assert.equal(reply.childNodes[1].value, "");
    assert.equal(reply.childNodes[2].textContent, "Save");
    assert.equal(reply.childNodes[3].textContent, "Cancel");
    pressIn(reply, "Cancel");
    assert.equal(saved.getState().doc, "hello {c1}fox{/c1} two deer\n\n```comment c1\nhi\n```\n");
    assert.equal(areas().length, 0);
    assert.equal(texts()[0].textContent, "hi");
    card = cards()[0];
    pressIn(card, "Reply");
    card = cards()[0];
    const replyAgain = card.childNodes.at(-3);
    assert.equal(replyAgain.childNodes[0].childNodes[0].tagName, "SPAN");
    replyAgain.childNodes[1].value = "more";
    mounted.aside.listeners.input({ target: replyAgain.childNodes[1] });
    const undoReply = saved.getState().undo.length;
    pressIn(replyAgain, "Save");
    assert.equal(saved.getState().doc, "hello {c1}fox{/c1} two deer\n\n```comment c1\nhi\n::\nmore\n```\n");
    assert.equal(saved.getState().undo.length, undoReply + 1);
    assert.equal(areas().length, 0);
    assert.deepEqual(texts().map((item) => item.textContent), ["hi", "more"]);
    openText(texts()[1]);
    assert.equal(saved.getState().doc, "hello {c1}fox{/c1} two deer\n\n```comment c1\nhi\n::\nmore\n```\n");
    assert.equal(cards()[0].childNodes[0].childNodes[1].textContent, "hi");
    assert.equal(cards()[0].childNodes[0].childNodes[1].classList.contains("md-comment-text"), true);
    assert.equal(areas().length, 1);
    const second = areas()[0];
    assert.equal(second.value, "more");
    second.value = "less";
    mounted.aside.listeners.input({ target: second });
    pressIn(second.parentElement, "Save");
    assert.equal(saved.getState().doc, "hello {c1}fox{/c1} two deer\n\n```comment c1\nhi\n::\nless\n```\n");
    assert.equal(areas().length, 0);
    assert.deepEqual(texts().map((item) => item.textContent), ["hi", "less"]);
    card = cards()[0];
    const undoResolve = saved.getState().undo.length;
    pressIn(card, "Resolve");
    assert.equal(saved.getState().undo.length, undoResolve + 1);
    assert.equal(saved.getState().doc, "hello {c1}fox{/c1} two deer\n\n```comment c1 resolved\nhi\n::\nless\n```\n");
    assert.equal(saved.getState().doc.includes("{c1}fox{/c1}"), true);
    assert.equal(cards().length, 0);
    assert.ok(mounted.findAll((node) => node.classList && node.classList.contains("md-comment")).length > 0);
    let toggle = docMenuOf(mounted.aside).checkbox;
    assert.equal(toggle.checked, false);
    assert.equal(toggle.disabled, false);
    assert.notEqual(mounted.aside.childNodes[0], toggle);
    toggle.checked = true;
    toggle.listeners.change();
    assert.equal(cards().length, 1);
    assert.equal(areas().length, 0);
    assert.deepEqual(texts().map((item) => item.textContent), ["hi", "less"]);
    pressIn(cards()[0], "Resolve");
    assert.equal(saved.getState().doc, "hello {c1}fox{/c1} two deer\n\n```comment c1\nhi\n::\nless\n```\n");
    assert.equal(cards().length, 1);
    toggle = docMenuOf(mounted.aside).checkbox;
    assert.equal(toggle.checked, true);
    toggle.checked = false;
    toggle.listeners.change();
    assert.equal(cards().length, 1);
    const undoDelete = saved.getState().undo.length;
    pressIn(cards()[0], "Delete");
    assert.equal(saved.getState().undo.length, undoDelete + 1);
    assert.equal(saved.getState().doc, "hello fox two deer\n");
    mounted.listeners.keydown({
      key: "z",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      preventDefault() {},
    });
    assert.equal(saved.getState().doc, "hello {c1}fox{/c1} two deer\n\n```comment c1\nhi\n::\nless\n```\n");
    saved.destroy();
    mounted.setSelection(null);

    const knownDoc = "hello {c1}fox{/c1} two deer\n\n```comment c1\nhi\n```\n";
    const known = createEditor(mounted.root, knownDoc, 0);
    assert.equal(areas().length, 0);
    assert.equal(texts()[0].textContent, "hi");
    openText(texts()[0]);
    assert.equal(known.getState().doc, knownDoc);
    let edit = areas()[0];
    assert.equal(edit.value, "hi");
    assert.equal(edit.focused, true);
    assert.equal(edit.selectionStart, 2);
    assert.equal(edit.selectionEnd, 2);
    edit.value = "yo";
    mounted.aside.listeners.input({ target: edit });
    pressIn(edit.parentElement, "Cancel");
    assert.equal(known.getState().doc, knownDoc);
    assert.equal(areas().length, 0);
    assert.equal(texts()[0].textContent, "hi");
    openText(texts()[0].childNodes[0]);
    edit = areas()[0];
    edit.value = "yo";
    mounted.aside.listeners.input({ target: edit });
    pressIn(edit.parentElement, "Save");
    assert.equal(areas().length, 0);
    assert.equal(texts()[0].textContent, "yo");
    assert.equal(known.getState().doc, "hello {c1}fox{/c1} two deer\n\n```comment c1\nyo\n```\n");
    known.destroy();
    mounted.setSelection(null);

    const marked = "Say {c1}fox{/c1} now.\n\n```comment c1\n**hi**\n```\n";
    const notes = createEditor(mounted.root, marked, 0);
    assert.equal(areas().length, 0);
    assert.equal(texts()[0].textContent, "**hi**");
    assert.equal(mounted.findAll((node) => node.classList && node.classList.contains("md-strong")).length, 0);
    pressIn(cards()[0], "Reply");
    const added = cards()[0].childNodes.at(-3);
    added.childNodes[1].value = "more";
    mounted.aside.listeners.input({ target: added.childNodes[1] });
    pressIn(added, "Save");
    assert.equal(notes.getState().doc, "Say {c1}fox{/c1} now.\n\n```comment c1\n**hi**\n::\nmore\n```\n");
    assert.equal(areas().length, 0);
    assert.deepEqual(texts().map((item) => item.textContent), ["**hi**", "more"]);
    assert.equal(mounted.findAll((node) => node.classList && node.classList.contains("md-strong")).length, 0);
    notes.destroy();
    mounted.setSelection(null);

    const hidden = createEditor(mounted.root, "hello {c1}fox{/c1} two deer\n\n```comment c1 resolved\nhi\n```\n", 0);
    assert.equal(cards().length, 0);
    assert.ok(mounted.findAll((node) => node.classList && node.classList.contains("md-comment")).length > 0);
    const showMenu = docMenuOf(mounted.aside);
    const show = showMenu.checkbox;
    assert.equal(show.checked, false);
    assert.equal(show.disabled, false);
    assert.equal(show.parentElement, showMenu.panel);
    assert.notEqual(mounted.aside.childNodes[0], show);
    assert.equal(showMenu.label.textContent, "show resolved");
    show.checked = true;
    show.listeners.change();
    assert.equal(cards().length, 1);
    assert.equal(areas().length, 0);
    assert.equal(texts()[0].textContent, "hi");
    hidden.destroy();
  } finally {
    mounted.restore();
  }
});

test("comment cards follow highlight order", () => {
  const mounted = mountSheet();
  const cards = () => mounted.findAll((node) => node.classList && node.classList.contains("md-comment-card"));
  try {
    const first = addComment("alpha beta\n", 6, 10);
    assert.equal(first.doc.slice(0, 5), "alpha");
    const second = addComment(first.doc, 0, 5);
    assert.equal(second.id, "c2");
    assert.ok(second.doc.startsWith("{c2}alpha{/c2}"));
    assert.deepEqual(plan(second.doc, 0).comments.map((comment) => comment.id), ["c1", "c2"]);

    globalThis.window.matchMedia = () => ({ matches: false });
    const wide = createEditor(mounted.root, second.doc, 0);
    assert.equal(wide.getState().doc, second.doc);
    assert.deepEqual(plan(wide.getState().doc, 0).comments.map((comment) => comment.id), ["c1", "c2"]);
    assert.deepEqual(cards().map((card) => card.dataset.comment), ["c2", "c1"]);
    assert.equal(cards()[0].styleProps.position, "absolute");
    assert.ok(Number.parseFloat(cards()[0].styleProps.top) < Number.parseFloat(cards()[1].styleProps.top));
    wide.destroy();

    globalThis.window.matchMedia = () => ({ matches: true });
    const narrow = createEditor(mounted.root, second.doc, 0);
    const stacked = cards();
    assert.deepEqual(stacked.map((card) => card.dataset.comment), ["c2", "c1"]);
    assert.ok(stacked.every((card) => card.styleProps.position === "static"));
    narrow.destroy();

    globalThis.window.matchMedia = () => ({ matches: false });
    const base = "hello\n\n```comment c1\nhi\n```\n\n```comment c3\nthere\n```\n";
    const added = addComment(base, 0, 5);
    assert.equal(added.id, "c2");
    assert.deepEqual(plan(added.doc, 0).comments.map((comment) => comment.id), ["c1", "c3", "c2"]);
    const spanless = createEditor(mounted.root, added.doc, 0);
    assert.equal(spanless.getState().doc, added.doc);
    assert.deepEqual(cards().map((card) => card.dataset.comment), ["c2", "c1", "c3"]);
    const tops = cards().map((card) => Number.parseFloat(card.styleProps.top));
    assert.ok(tops[0] < tops[1] && tops[1] < tops[2]);
    spanless.destroy();
  } finally {
    mounted.restore();
  }
});

test("comment cards mark the thread being acted on", () => {
  const mounted = mountSheet();
  const cards = () => mounted.findAll((node) => node.classList && node.classList.contains("md-comment-card"));
  const marks = () => mounted.findAll((node) => node.classList && node.classList.contains("md-comment") && node.dataset && node.dataset.comment);
  const texts = () => mounted.findAll((node) => node.classList && node.classList.contains("md-comment-text"));
  const areas = () => mounted.findAll((node) => node.tagName === "TEXTAREA");
  const currentCards = () => cards().filter((card) => card.classList.contains("md-comment-current"));
  const editing = (id) => marks().filter((mark) => mark.dataset.comment === id && mark.classList.contains("md-comment-editing"));
  const pressIn = (parent, label) => {
    const matches = (node) => node && node.tagName === "BUTTON" && (
      node.textContent === label || (typeof node.getAttribute === "function" && node.getAttribute("aria-label") === label)
    );
    const walk = (node) => {
      if (!node) return null;
      if (matches(node)) return node;
      for (const child of node.childNodes || []) {
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    const button = walk(parent);
    assert.ok(button, label);
    button.listeners.click({ target: button, preventDefault() {} });
  };
  const clickEditor = (target, preventDefault) => {
    const event = { target, clientX: 1, clientY: 1 };
    if (preventDefault) event.preventDefault = preventDefault;
    else event.preventDefault = () => {};
    mounted.listeners.click(event);
  };
  try {
    const css = readFileSync(new URL("../editor.css", import.meta.url), "utf8");
    assert.match(css, /\.md-comment\s*\{[^}]*background:\s*#6b5e45;/);
    assert.match(css, /\.md-comment\s*\{[^}]*color:\s*#e7e2d8;/);
    assert.match(css, /\.md-comment \.md-syntax\s*\{[^}]*color:\s*#c4b8a4;/);
    assert.match(css, /\.md-comment\.md-comment-editing\s*\{[^}]*background:\s*#3d5270;/);
    assert.match(css, /\.md-comment\.md-comment-editing\s*\{[^}]*color:\s*#e7e2d8;/);
    assert.match(css, /\.md-comment-card\s*\{[^}]*border:\s*1px solid #3f3c37;/);
    assert.match(css, /\.md-comment-card\.md-comment-current\s*\{[^}]*border:\s*2px solid #e7e2d8;/);
    const src = readFileSync(new URL("../src/editor.js", import.meta.url), "utf8");
    assert.equal(src.includes("innerHTML"), false);

    const knownDoc = "hello {c1}fox{/c1} two deer\n\n```comment c1\nhi\n```\n";
    const byCard = createEditor(mounted.root, knownDoc, 0);
    assert.equal(currentCards().length, 0);
    assert.equal(marks().some((mark) => mark.classList.contains("md-comment-editing")), false);
    mounted.aside.listeners.click({ target: cards()[0], preventDefault() {} });
    assert.equal(currentCards().length, 1);
    assert.equal(currentCards()[0].dataset.comment, "c1");
    assert.equal(editing("c1").length, 0);
    assert.equal(areas().length, 0);
    byCard.destroy();

    const known = createEditor(mounted.root, knownDoc, 0);
    assert.equal(currentCards().length, 0);
    assert.equal(texts()[0].textContent, "hi");
    assert.equal(typeof globalThis.document.caretPositionFromPoint, "undefined");
    assert.doesNotThrow(() => clickEditor(marks()[0]));
    assert.equal(currentCards().length, 1);
    assert.equal(currentCards()[0].dataset.comment, "c1");
    assert.equal(editing("c1").length, 0);
    assert.equal(areas().length, 0);
    mounted.aside.listeners.click({ target: texts()[0], preventDefault() {} });
    assert.equal(currentCards().length, 1);
    assert.equal(editing("c1").length, marks().filter((mark) => mark.dataset.comment === "c1").length);
    assert.ok(editing("c1").length > 0);
    assert.equal(areas().length, 1);
    const note = areas()[0].parentElement;
    pressIn(note, "Cancel");
    assert.equal(known.getState().doc, knownDoc);
    assert.equal(currentCards().length, 1);
    assert.equal(currentCards()[0].dataset.comment, "c1");
    assert.equal(editing("c1").length, 0);
    assert.equal(areas().length, 0);
    assert.equal(texts()[0].textContent, "hi");
    const held = currentCards()[0];
    assert.equal(typeof globalThis.document.caretPositionFromPoint, "undefined");
    let queries = 0;
    mounted.root.querySelectorAll = () => {
      queries += 1;
      return [];
    };
    const plain = mounted.root.childNodes[0];
    assert.equal(plain.classList.contains("md-comment"), false);
    assert.doesNotThrow(() => clickEditor(plain, null));
    assert.equal(queries, 0);
    assert.equal(held.classList.contains("md-comment-current"), false);
    assert.equal(currentCards().length, 0);
    known.destroy();

    const fresh = createEditor(mounted.root, "hello fox two deer\n", 0);
    const text = mounted.root.childNodes[0].childNodes[0].childNodes[0];
    mounted.listeners.mousedown({ clientX: 0, clientY: 0 });
    mounted.setSelection({
      rangeCount: 1,
      anchorNode: text,
      anchorOffset: 6,
      focusNode: text,
      focusOffset: 9,
      getRangeAt() {
        return {
          collapsed: false,
          commonAncestorContainer: text,
          getClientRects() {
            return [{ top: 12, left: 0, right: 40, bottom: 28, width: 40, height: 16 }];
          },
        };
      },
    });
    mounted.listeners.mouseup({ clientX: 30, clientY: 12 });
    const add = mounted.findAll((node) => node.className === "md-add-comment")[0];
    add.listeners.mousedown({ preventDefault() {} });
    assert.equal(fresh.getState().doc, "hello {c1}fox{/c1} two deer\n\n```comment c1\n\n```\n");
    assert.equal(currentCards().length, 1);
    assert.equal(currentCards()[0].dataset.comment, "c1");
    assert.equal(editing("c1").length, marks().length);
    assert.ok(editing("c1").length > 0);
    const freshMark = marks()[0];
    clickEditor(freshMark);
    let prevented = false;
    clickEditor(freshMark, () => {
      prevented = true;
    });
    const box = areas()[0];
    assert.equal(prevented, true);
    assert.equal(box.focused, true);
    assert.equal(currentCards().length, 1);
    assert.equal(editing("c1").length, marks().filter((mark) => mark.dataset.comment === "c1").length);
    pressIn(areas()[0].parentElement, "Cancel");
    assert.equal(fresh.getState().doc, "hello fox two deer\n");
    assert.equal(currentCards().length, 0);
    fresh.destroy();
    mounted.setSelection(null);

    const first = addComment("alpha beta\n", 6, 10);
    const second = addComment(first.doc, 0, 5);
    const paired = createEditor(mounted.root, second.doc, 0);
    assert.deepEqual(cards().map((card) => card.dataset.comment), ["c2", "c1"]);
    const authorOf = (card) => {
      let found = null;
      const walk = (node) => {
        if (!node || found) return;
        if (node.classList && node.classList.contains("md-comment-author")) found = node;
        for (const child of node.childNodes || []) walk(child);
      };
      walk(card);
      return found;
    };
    const leading = cards().find((card) => card.dataset.comment === "c2");
    const idle = cards().find((card) => card.dataset.comment === "c1");
    const idleAuthor = authorOf(idle);
    mounted.aside.listeners.click({ target: leading, preventDefault() {} });
    assert.equal(leading.classList.contains("md-comment-current"), true);
    assert.equal(idle.classList.contains("md-comment-current"), false);
    mounted.aside.listeners.click({ target: idleAuthor, preventDefault() {} });
    assert.equal(authorOf(idle), idleAuthor);
    assert.equal(idle.classList.contains("md-comment-current"), true);
    assert.equal(leading.classList.contains("md-comment-current"), false);
    assert.deepEqual(currentCards().map((card) => card.dataset.comment), ["c1"]);
    mounted.aside.listeners.click({ target: cards()[1], preventDefault() {} });
    assert.deepEqual(currentCards().map((card) => card.dataset.comment), ["c1"]);
    mounted.aside.listeners.click({ target: texts().find((node) => node.dataset.comment === "c1"), preventDefault() {} });
    assert.deepEqual(currentCards().map((card) => card.dataset.comment), ["c1"]);
    assert.ok(editing("c1").length > 0);
    assert.equal(editing("c2").length, 0);
    assert.ok(marks().some((mark) => mark.dataset.comment === "c2" && !mark.classList.contains("md-comment-editing")));
    pressIn(areas()[0].parentElement, "Cancel");
    assert.deepEqual(currentCards().map((card) => card.dataset.comment), ["c1"]);
    assert.equal(editing("c1").length, 0);
    assert.equal(editing("c2").length, 0);
    pressIn(cards().find((card) => card.dataset.comment === "c2"), "Reply");
    assert.deepEqual(currentCards().map((card) => card.dataset.comment), ["c2"]);
    assert.ok(editing("c2").length > 0);
    assert.equal(editing("c1").length, 0);
    const reply = cards().find((card) => card.dataset.comment === "c2").childNodes.at(-3);
    pressIn(reply, "Cancel");
    assert.deepEqual(currentCards().map((card) => card.dataset.comment), ["c2"]);
    assert.equal(editing("c2").length, 0);
    assert.equal(areas().length, 0);
    pressIn(cards().find((card) => card.dataset.comment === "c2"), "Reply");
    const replyAgain = cards().find((card) => card.dataset.comment === "c2").childNodes.at(-3);
    replyAgain.childNodes[1].value = "more";
    mounted.aside.listeners.input({ target: replyAgain.childNodes[1] });
    pressIn(replyAgain, "Save");
    assert.ok(paired.getState().doc.includes("more"));
    assert.deepEqual(currentCards().map((card) => card.dataset.comment), ["c2"]);
    assert.equal(editing("c2").length, 0);
    assert.equal(areas().length, 0);
    pressIn(cards().find((card) => card.dataset.comment === "c1"), "Delete");
    assert.equal(cards().some((card) => card.dataset.comment === "c1"), false);
    assert.deepEqual(currentCards().map((card) => card.dataset.comment), ["c2"]);
    pressIn(cards()[0], "Delete");
    assert.equal(cards().length, 0);
    assert.equal(currentCards().length, 0);
    paired.destroy();

    const resolved = createEditor(mounted.root, knownDoc, 0);
    pressIn(cards()[0], "Resolve");
    assert.equal(cards().length, 0);
    assert.equal(resolved.getState().doc.includes("```comment c1 resolved"), true);
    const toggle = docMenuOf(mounted.aside).checkbox;
    assert.notEqual(mounted.aside.childNodes[0], toggle);
    toggle.checked = true;
    toggle.listeners.change();
    assert.equal(cards().length, 1);
    assert.equal(cards()[0].dataset.resolved, "true");
    assert.deepEqual(currentCards().map((card) => card.dataset.comment), ["c1"]);
    pressIn(cards()[0], "Resolve");
    assert.equal(resolved.getState().doc, knownDoc);
    assert.deepEqual(currentCards().map((card) => card.dataset.comment), ["c1"]);
    mounted.aside.listeners.click({ target: texts()[0], preventDefault() {} });
    areas()[0].value = "yo";
    mounted.aside.listeners.input({ target: areas()[0] });
    pressIn(areas()[0].parentElement, "Save");
    assert.equal(resolved.getState().doc, "hello {c1}fox{/c1} two deer\n\n```comment c1\nyo\n```\n");
    assert.deepEqual(currentCards().map((card) => card.dataset.comment), ["c1"]);
    assert.equal(editing("c1").length, 0);
    assert.equal(areas().length, 0);
    resolved.destroy();

    const caretView = createEditor(mounted.root, knownDoc, 0);
    const savedMark = marks().find((mark) => mark.dataset.comment === "c1");
    const word = savedMark.childNodes.find((node) => node.nodeType === 3);
    const placed = 1;
    const wordStart = Number(savedMark.dataset.start);
    globalThis.document.caretPositionFromPoint = () => ({ offsetNode: word, offset: placed });
    assert.doesNotThrow(() => clickEditor(savedMark));
    assert.equal(caretView.getState().cursor, wordStart + placed);
    assert.equal(caretView.getState().anchor, wordStart + placed);
    assert.equal(currentCards().length, 1);
    assert.equal(currentCards()[0].dataset.comment, "c1");
    assert.equal(areas().length, 0);
    assert.equal(editing("c1").length, 0);
    delete globalThis.document.caretPositionFromPoint;
    caretView.destroy();
  } finally {
    mounted.restore();
  }
});

function holdingTransport() {
  let listener = null;
  const sent = [];
  return {
    username: "",
    sent,
    send(message) {
      sent.push(message);
    },
    subscribe(fn) {
      listener = fn;
      return () => {
        if (listener === fn) listener = null;
      };
    },
    deliver(message) {
      if (listener) listener(message);
    },
  };
}

function walkNodes(node, predicate, found = []) {
  if (predicate(node)) found.push(node);
  for (const child of node.childNodes || []) walkNodes(child, predicate, found);
  return found;
}

function iconPaths(button) {
  const kids = button && button.childNodes ? [...button.childNodes] : [];
  const svg = kids.find((node) => node && node.localName === "svg");
  if (!svg || !svg.childNodes) return [];
  return [...svg.childNodes].filter((node) => node && node.localName === "path").map((node) => node.getAttribute("d"));
}

test("comment actions stay hidden until the card is current", () => {
  const mounted = mountSheet();
  const knownDoc = "hello {c1}fox{/c1} two deer\n\n```comment c1\nhi\n```\n";
  const cards = () => mounted.findAll((node) => node.classList && node.classList.contains("md-comment-card"));
  const labeled = (root, label) => {
    const found = [];
    const walk = (node) => {
      if (!node) return;
      if (node.tagName === "BUTTON" && typeof node.getAttribute === "function" && node.getAttribute("aria-label") === label) found.push(node);
      for (const child of node.childNodes || []) walk(child);
    };
    walk(root);
    return found;
  };
  const stroke = (button) => {
    assert.equal(button.classList.contains("icon-btn"), true);
    assert.equal(button.type, "button");
    assert.equal(button.textContent, "");
    const svg = button.childNodes[0];
    assert.equal(svg.localName, "svg");
    assert.equal(svg.getAttribute("viewBox"), "0 0 24 24");
    assert.equal(svg.getAttribute("aria-hidden"), "true");
    const path = svg.childNodes[0];
    assert.equal(path.getAttribute("fill"), "none");
    assert.equal(path.getAttribute("stroke"), "currentColor");
    assert.equal(path.getAttribute("stroke-width"), "2");
    assert.equal(path.getAttribute("stroke-linecap"), "round");
    assert.equal(path.getAttribute("stroke-linejoin"), "round");
    return path.getAttribute("d");
  };
  try {
    const css = readFileSync(new URL("../editor.css", import.meta.url), "utf8");
    assert.match(css, /\.md-comment-card button\.icon-btn\[hidden\]\s*\{[^}]*display:\s*none/);

    const adaTransport = holdingTransport();
    adaTransport.username = "Ada";
    const named = createEditor(mounted.root, knownDoc, 0, adaTransport);
    const adaAuthor = mounted.findAll((node) => node.classList && node.classList.contains("md-comment-author"))[0];
    assert.equal(adaAuthor.tagName, "SPAN");
    assert.equal(adaAuthor.textContent, "Ada");
    assert.equal(named.getState().doc, knownDoc);
    assert.equal(named.getState().doc.includes("Ada"), false);
    named.destroy();

    const view = createEditor(mounted.root, knownDoc, 0);
    const card = cards()[0];
    assert.equal(card.classList.contains("md-comment-current"), false);
    const row = card.childNodes[0].childNodes[0];
    const author = row.childNodes[0];
    assert.equal(author.tagName, "SPAN");
    assert.equal(author.classList.contains("md-comment-author"), true);
    assert.equal(author.textContent, "");
    const resolve = row.childNodes[1];
    const link = row.childNodes.at(-1);
    const reply = card.childNodes.at(-2);
    const remove = card.childNodes.at(-1);
    assert.equal(row.childNodes.length, 3);
    assert.equal(resolve.getAttribute("aria-label"), "Resolve");
    assert.equal(resolve.classList.contains("resolve"), true);
    assert.equal(stroke(resolve), "M20 6 9 17l-5-5");
    assert.equal(reply.getAttribute("aria-label"), "Reply");
    assert.equal(stroke(reply), "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z");
    assert.equal(remove.getAttribute("aria-label"), "Delete");
    assert.equal(remove.classList.contains("danger"), true);
    assert.equal(stroke(remove), "M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14");
    assert.equal(link.classList.contains("md-comment-link"), true);
    assert.equal(link.classList.contains("icon-btn"), true);
    assert.equal(link.getAttribute("aria-label"), "Copy link");
    assert.equal(link.childNodes[0].localName, "svg");
    for (const button of [resolve, reply, remove, link]) assert.equal(button.hidden, true);

    mounted.aside.listeners.click({ target: card, preventDefault() {} });
    assert.equal(card.classList.contains("md-comment-current"), true);
    for (const button of [resolve, reply, remove, link]) assert.equal(button.hidden, false);
    assert.equal(row.childNodes[0], author);

    const line = mounted.root.childNodes[0];
    mounted.listeners.click({ target: line, clientX: 1, clientY: 1, preventDefault() {} });
    assert.equal(card.classList.contains("md-comment-current"), false);
    for (const button of [resolve, reply, remove, link]) assert.equal(button.hidden, true);

    mounted.aside.listeners.click({ target: author, preventDefault() {} });
    assert.equal(card.classList.contains("md-comment-current"), true);
    for (const button of [resolve, reply, remove, link]) assert.equal(button.hidden, false);

    const beforeDelete = view.getState().undo.length;
    remove.listeners.click({ target: remove, preventDefault() {} });
    assert.equal(view.getState().undo.length, beforeDelete + 1);
    assert.equal(view.getState().doc, "hello fox two deer\n");
    mounted.listeners.keydown({
      key: "z",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      preventDefault() {},
    });
    assert.equal(view.getState().doc, knownDoc);

    const restored = cards()[0];
    mounted.aside.listeners.click({ target: restored, preventDefault() {} });
    const restoredResolve = labeled(restored, "Resolve")[0];
    const beforeResolve = view.getState().undo.length;
    restoredResolve.listeners.click({ target: restoredResolve, preventDefault() {} });
    assert.equal(view.getState().undo.length, beforeResolve + 1);
    assert.equal(view.getState().doc.includes("```comment c1 resolved"), true);
    view.destroy();

    const first = addComment("alpha beta\n", 6, 10);
    const second = addComment(first.doc, 0, 5);
    const paired = createEditor(mounted.root, second.doc, 0);
    const leading = cards().find((item) => item.dataset.comment === "c2");
    const idle = cards().find((item) => item.dataset.comment === "c1");
    mounted.aside.listeners.click({ target: leading, preventDefault() {} });
    assert.equal(labeled(leading, "Resolve")[0].hidden, false);
    assert.equal(labeled(leading, "Reply")[0].hidden, false);
    assert.equal(labeled(leading, "Delete")[0].hidden, false);
    assert.equal(labeled(leading, "Copy link").every((button) => button.hidden === false), true);
    assert.equal(labeled(idle, "Resolve")[0].hidden, true);
    assert.equal(labeled(idle, "Reply")[0].hidden, true);
    assert.equal(labeled(idle, "Delete")[0].hidden, true);
    assert.equal(labeled(idle, "Copy link").every((button) => button.hidden === true), true);
    mounted.aside.listeners.click({ target: idle, preventDefault() {} });
    assert.equal(labeled(leading, "Resolve")[0].hidden, true);
    assert.equal(labeled(idle, "Resolve")[0].hidden, false);
    assert.equal(labeled(idle, "Copy link").every((button) => button.hidden === false), true);
    paired.destroy();
  } finally {
    mounted.restore();
  }
});

test("an insert renders only from the doc message", () => {
  const mounted = mountEditor();
  const transport = holdingTransport();
  try {
    const view = createEditor(mounted.root, "ab", 1, transport);
    assert.equal(mounted.root.textContent, "ab");
    mounted.listeners.beforeinput({
      inputType: "insertText",
      data: "X",
      preventDefault() {},
    });
    assert.equal(mounted.root.textContent, "ab");
    assert.equal(view.getState().doc, "ab");
    assert.equal(transport.sent.some((message) => message.type === "edit" && message.op === "insert" && message.text === "X" && message.path === "" && message.rev === 0), true);
    transport.deliver({
      type: "doc",
      rev: 1,
      text: "aXb",
      from: 1,
      to: 1,
      inserted: "X",
      actor: "",
      cursor: 2,
      anchor: 2,
    });
    assert.equal(view.getState().doc, "aXb");
    assert.equal(view.getState().cursor, 2);
    assert.equal(mounted.root.textContent, "aXb");

    transport.sent.length = 0;
    mounted.listeners.keydown({
      key: "z",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      preventDefault() {},
    });
    assert.equal(mounted.root.textContent, "aXb");
    assert.equal(transport.sent.some((message) => message.type === "undo" && message.path === "" && message.rev === 1), true);
    transport.deliver({
      type: "doc",
      rev: 2,
      text: "ab",
      from: 1,
      to: 2,
      inserted: "",
      actor: "",
      cursor: 1,
      anchor: 1,
    });
    assert.equal(mounted.root.textContent, "ab");

    transport.sent.length = 0;
    mounted.listeners.keydown({
      key: "y",
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      shiftKey: false,
      preventDefault() {},
    });
    assert.equal(mounted.root.textContent, "ab");
    assert.equal(transport.sent.some((message) => message.type === "redo" && message.path === "" && message.rev === 2), true);
    transport.deliver({ type: "error", status: 409 });
    assert.equal(view.getState().doc, "ab");
    assert.equal(view.getState().cursor, 1);
    assert.equal(view.getState().anchor, 1);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

function insertText(mounted, data) {
  mounted.listeners.beforeinput({
    inputType: "insertText",
    data,
    preventDefault() {},
  });
}

function docMessage(rev, text, cursor, inserted) {
  return {
    type: "doc",
    rev,
    text,
    from: cursor - inserted.length,
    to: cursor - inserted.length,
    inserted,
    actor: "",
    cursor,
    anchor: cursor,
  };
}

test("a second insert waits until this actor's doc", () => {
  const mounted = mountEditor();
  const transport = holdingTransport();
  try {
    const view = createEditor(mounted.root, "ab", 1, transport);
    insertText(mounted, "X");
    insertText(mounted, "Y");
    const edits = transport.sent.filter((message) => message.type === "edit");
    assert.equal(edits.length, 1);
    assert.equal(edits[0].text, "X");
    assert.equal(edits[0].rev, 0);
    transport.deliver(docMessage(1, "aXb", 2, "X"));
    const held = transport.sent.filter((message) => message.type === "edit");
    assert.equal(held.length, 2);
    assert.equal(held[1].text, "Y");
    assert.equal(held[1].rev, 1);
    assert.equal(held[1].cursor, 2);
    assert.equal(held[1].anchor, 2);
    transport.deliver(docMessage(2, "aXbY", 3, "Y"));
    assert.equal(view.getState().doc, "aXbY");
    assert.equal(view.getState().cursor, 3);
    assert.equal(transport.sent.filter((message) => message.type === "edit").length, 2);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("a 409 on an edit drops held keystrokes", () => {
  const mounted = mountEditor();
  const transport = holdingTransport();
  try {
    const view = createEditor(mounted.root, "ab", 1, transport);
    insertText(mounted, "X");
    insertText(mounted, "Y");
    transport.deliver({ type: "error", status: 409 });
    assert.equal(transport.sent.some((message) => message.type === "edit" && message.text === "Y"), false);
    assert.equal(view.getState().cursor, 1);
    assert.equal(view.getState().anchor, 1);
    insertText(mounted, "Z");
    const edits = transport.sent.filter((message) => message.type === "edit");
    assert.equal(edits.length, 2);
    assert.equal(edits[1].text, "Z");
    assert.equal(edits[1].rev, 0);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("undo waits until the in-flight edit's doc", () => {
  const mounted = mountEditor();
  const transport = holdingTransport();
  try {
    const view = createEditor(mounted.root, "ab", 1, transport);
    insertText(mounted, "X");
    mounted.listeners.keydown({
      key: "z",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      preventDefault() {},
    });
    assert.equal(transport.sent.some((message) => message.type === "undo"), false);
    const at = transport.sent.length;
    transport.deliver(docMessage(1, "aXb", 2, "X"));
    assert.equal(transport.sent.length, at + 1);
    assert.equal(transport.sent[at].type, "undo");
    assert.equal(transport.sent[at].rev, 1);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("redo waits until the in-flight edit's doc", () => {
  const mounted = mountEditor();
  const transport = holdingTransport();
  try {
    const view = createEditor(mounted.root, "ab", 1, transport);
    insertText(mounted, "X");
    mounted.listeners.keydown({
      key: "y",
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      shiftKey: false,
      preventDefault() {},
    });
    assert.equal(transport.sent.some((message) => message.type === "redo"), false);
    const at = transport.sent.length;
    transport.deliver(docMessage(1, "aXb", 2, "X"));
    assert.equal(transport.sent.length, at + 1);
    assert.equal(transport.sent[at].type, "redo");
    assert.equal(transport.sent[at].rev, 1);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("only the oldest held edit is sent and a skipped rev drops the rest", () => {
  const mounted = mountEditor();
  const transport = holdingTransport();
  try {
    const view = createEditor(mounted.root, "ab", 1, transport);
    insertText(mounted, "X");
    insertText(mounted, "Y");
    insertText(mounted, "Z");
    assert.equal(transport.sent.filter((message) => message.type === "edit").length, 1);
    transport.deliver({ type: "ping" });
    assert.equal(transport.sent.some((message) => message.type === "pong"), true);
    assert.equal(transport.sent.filter((message) => message.type === "edit").length, 1);
    transport.deliver(docMessage(1, "aXb", 2, "X"));
    let edits = transport.sent.filter((message) => message.type === "edit");
    assert.equal(edits.length, 2);
    assert.equal(edits[1].text, "Y");
    assert.equal(edits[1].rev, 1);
    assert.equal(edits[1].cursor, 2);
    transport.deliver(docMessage(2, "aXbY", 3, "Y"));
    edits = transport.sent.filter((message) => message.type === "edit");
    assert.equal(edits.length, 3);
    assert.equal(edits[2].text, "Z");
    assert.equal(edits[2].rev, 2);
    assert.equal(edits[2].cursor, 3);
    view.destroy();

    const skipped = holdingTransport();
    const again = createEditor(mounted.root, "ab", 1, skipped);
    insertText(mounted, "X");
    insertText(mounted, "Y");
    skipped.deliver({
      type: "doc",
      rev: 5,
      text: "NO",
      from: 0,
      to: 0,
      inserted: "NO",
      actor: "",
      cursor: 2,
      anchor: 2,
    });
    assert.equal(again.getState().doc, "ab");
    assert.equal(skipped.sent.some((message) => message.type === "open" && message.rev === 0), true);
    assert.equal(skipped.sent.some((message) => message.type === "edit" && message.text === "Y"), false);
    insertText(mounted, "Z");
    edits = skipped.sent.filter((message) => message.type === "edit");
    assert.equal(edits.length, 2);
    assert.equal(edits[1].text, "Z");
    assert.equal(edits[1].rev, 0);
    skipped.deliver({ type: "file", rev: 8, text: "ab", cursor: 1, anchor: 1 });
    skipped.deliver(docMessage(9, "aZb", 2, "Z"));
    assert.equal(skipped.sent.some((message) => message.type === "edit" && message.text === "Y"), false);
    assert.equal(again.getState().doc, "aZb");
    assert.equal(again.getState().cursor, 2);
    again.destroy();
  } finally {
    mounted.restore();
  }
});

test("a skipped doc rev sends open and waits for file", () => {
  const mounted = mountEditor();
  const transport = holdingTransport();
  try {
    const view = createEditor(mounted.root, "hello", 0, transport);
    transport.deliver({
      type: "doc",
      rev: 2,
      text: "NO",
      from: 0,
      to: 0,
      inserted: "NO",
      actor: "",
      cursor: 2,
      anchor: 2,
    });
    assert.equal(view.getState().doc, "hello");
    assert.equal(transport.sent.some((message) => message.type === "open" && message.path === "" && message.rev === 0), true);
    transport.deliver({
      type: "doc",
      rev: 3,
      text: "NOPE",
      from: 0,
      to: 0,
      inserted: "NOPE",
      actor: "",
      cursor: 4,
      anchor: 4,
    });
    assert.equal(view.getState().doc, "hello");
    transport.deliver({ type: "file", rev: 8, text: "yes\n", cursor: 1, anchor: 1 });
    assert.equal(view.getState().doc, "yes\n");
    assert.equal(view.getState().cursor, 1);
    transport.deliver({
      type: "doc",
      rev: 9,
      text: "yes!\n",
      from: 3,
      to: 3,
      inserted: "!",
      actor: "",
      cursor: 4,
      anchor: 4,
    });
    assert.equal(view.getState().doc, "yes!\n");
    assert.equal(view.getState().cursor, 4);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("another user's doc shifts a caret at or after to", () => {
  const mounted = mountEditor();
  const transport = holdingTransport();
  transport.username = "me";
  try {
    const view = createEditor(mounted.root, "hello\n", 5, transport);
    transport.deliver({
      type: "doc",
      rev: 1,
      text: "helXlo\n",
      from: 3,
      to: 3,
      inserted: "X",
      actor: "other",
      cursor: 4,
      anchor: 4,
    });
    assert.equal(view.getState().doc, "helXlo\n");
    assert.equal(view.getState().cursor, 6);
    assert.equal(view.getState().anchor, 6);
    view.destroy();

    const earlier = holdingTransport();
    earlier.username = "me";
    const stayed = createEditor(mounted.root, "hello\n", 2, earlier);
    earlier.deliver({
      type: "doc",
      rev: 1,
      text: "helXlo\n",
      from: 3,
      to: 3,
      inserted: "X",
      actor: "other",
      cursor: 4,
      anchor: 4,
    });
    assert.equal(stayed.getState().cursor, 2);
    assert.equal(stayed.getState().anchor, 2);
    stayed.destroy();
  } finally {
    mounted.restore();
  }
});

test("locks name another user and a rejected lock does not take the caret", () => {
  const mounted = mountEditor();
  const transport = holdingTransport();
  transport.username = "me";
  try {
    const view = createEditor(mounted.root, "one\ntwo\n", 0, transport);
    transport.deliver({
      type: "locks",
      lines: [
        { index: 0, username: "me" },
        { index: 1, username: "ada" },
      ],
    });
    const marks = walkNodes(mounted.root, (node) => node.classList && node.classList.contains("md-lock"));
    assert.deepEqual(marks.map((mark) => mark.textContent), ["ada"]);
    const firstLine = mounted.root.childNodes[0];
    assert.equal(walkNodes(firstLine, (node) => node.classList && node.classList.contains("md-lock")).length, 0);
    transport.sent.length = 0;
    transport.deliver({
      type: "file",
      rev: 2,
      path: "p.md",
      text: "one\ntwo\n",
      cursor: 0,
      anchor: 0,
      locks: [{ index: 0, username: "ada" }],
    });
    const remarked = walkNodes(mounted.root, (node) => node.classList && node.classList.contains("md-lock"));
    assert.deepEqual(remarked.map((mark) => mark.textContent), ["ada"]);
    assert.equal(walkNodes(mounted.root.childNodes[0], (node) => node.classList && node.classList.contains("md-lock")).length, 1);
    assert.equal(transport.sent.some((message) => message.type === "lock" && message.anchor === 0 && message.cursor === 0 && message.path === "p.md" && message.rev === 2 && message.lines === undefined), true);

    const lines = mounted.root.childNodes;
    const origin = lines[0].childNodes[0].childNodes[0];
    const next = lines[1].childNodes[0].childNodes[0];
    assert.equal(origin.textContent, "one");
    assert.equal(next.textContent, "two");
    const rejecting = {
      username: "me",
      sent: [],
      subscribe(fn) {
        this.listener = fn;
        return () => {};
      },
      send(message) {
        this.sent.push(message);
        if (message.type === "lock" && this.listener) this.listener({ type: "error", status: 409 });
      },
    };
    view.destroy();
    const blocked = createEditor(mounted.root, "a\nb\n", 0, rejecting);
    const text = mounted.root.childNodes.map((line) => line.childNodes[0] && line.childNodes[0].childNodes[0]).filter((node) => node && node.nodeType === 3);
    assert.equal(text[0].textContent, "a");
    assert.equal(text[1].textContent, "b");
    mounted.listeners.mousedown({ clientX: 0, clientY: 0 });
    mounted.setSelection = null;
    const selection = {
      rangeCount: 1,
      anchorNode: text[0],
      anchorOffset: 0,
      focusNode: text[1],
      focusOffset: 1,
      getRangeAt() {
        return { collapsed: false, commonAncestorContainer: mounted.root };
      },
    };
    globalThis.window.getSelection = () => selection;
    mounted.listeners.mouseup({ clientX: 20, clientY: 20 });
    assert.equal(rejecting.sent.some((message) => message.type === "lock" && message.anchor === 0 && message.cursor === 3 && message.path === "" && message.rev === 0 && message.lines === undefined), true);
    assert.equal(blocked.getState().cursor, 0);
    assert.equal(blocked.getState().anchor, 0);
    blocked.destroy();
  } finally {
    mounted.restore();
  }
});

test('files ["b.md","sub/a.md"] show b.md and a collapsed sub', () => {
  const mounted = mountEditor();
  const css = readFileSync(new URL("../editor.css", import.meta.url), "utf8");
  const sheetRule = css.match(/\.sheet\s*\{[^}]*\}/g).find((block) => block.includes("grid-template-columns"));
  assert.match(sheetRule, /grid-template-columns:\s*16rem\s+minmax\(0,\s*1fr\)\s+20rem/);
  assert.equal(/justify-content:\s*center/.test(sheetRule), false);
  for (const block of css.match(/\.editor\s*\{[^}]*\}/g)) {
    assert.equal(/max-width:\s*46rem/.test(block), false);
  }
  const fileMark = css.match(/\.file-tree button\.md-file::before\s*\{[^}]*\}/);
  const dirMark = css.match(/\.file-tree button\.md-dir-toggle::before\s*\{[^}]*\}/);
  assert.ok(fileMark);
  assert.ok(dirMark);
  assert.match(fileMark[0], /clip-path:\s*polygon\(0 0, 68% 0, 100% 28%, 100% 100%, 0 100%\)/);
  assert.match(dirMark[0], /clip-path:\s*polygon\(0 22%, 8% 22%, 14% 0, 48% 0, 54% 22%, 100% 22%, 100% 100%, 0 100%\)/);
  const nav = document.createElement("nav");
  nav.className = "files";
  const input = document.createElement("input");
  input.placeholder = "Username";
  nav.appendChild(input);
  const sheet = document.createElement("div");
  sheet.appendChild(nav);
  sheet.appendChild(mounted.root);
  const transport = holdingTransport();
  try {
    const view = createEditor(mounted.root, "x", 0, transport);
    transport.deliver({ type: "docs", files: ["b.md", "empty/notes.txt", "sub/a.md"] });
    const labeled = (text) => walkNodes(nav, (node) => node.tagName === "BUTTON" && node.textContent === text);
    assert.equal(labeled("b.md").length, 1);
    assert.equal(labeled("sub").length, 1);
    assert.equal(labeled("a.md").length, 0);
    assert.equal(labeled("empty").length, 0);
    assert.equal(labeled("notes.txt").length, 0);
    assert.equal(nav.childNodes[0].classList.contains("md-repo-row"), true);
    assert.ok(nav.childNodes.indexOf(input) > 0);
    const before = transport.sent.length;
    labeled("sub")[0].listeners.click({ preventDefault() {} });
    assert.equal(transport.sent.length, before);
    assert.equal(labeled("a.md").length, 1);
    assert.equal(labeled("b.md").length, 1);
    labeled("a.md")[0].listeners.click({ preventDefault() {} });
    const opened = transport.sent.filter((message) => message.type === "open");
    assert.deepEqual(opened.map((message) => message.path), ["sub/a.md"]);
    assert.equal(opened[0].rev, 0);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test('files ["sub/a.markdown"] show a collapsed sub', () => {
  const mounted = mountEditor();
  const nav = document.createElement("nav");
  nav.className = "files";
  const input = document.createElement("input");
  input.placeholder = "Username";
  nav.appendChild(input);
  const sheet = document.createElement("div");
  sheet.appendChild(nav);
  sheet.appendChild(mounted.root);
  const transport = holdingTransport();
  try {
    const view = createEditor(mounted.root, "x", 0, transport);
    transport.deliver({ type: "docs", files: ["sub/a.markdown"] });
    const labeled = (text) => walkNodes(nav, (node) => node.tagName === "BUTTON" && node.textContent === text);
    assert.equal(labeled("sub").length, 1);
    assert.equal(labeled("a.markdown").length, 0);
    const before = transport.sent.length;
    labeled("sub")[0].listeners.click({ preventDefault() {} });
    assert.equal(transport.sent.length, before);
    assert.equal(labeled("a.markdown").length, 1);
    labeled("a.markdown")[0].listeners.click({ preventDefault() {} });
    const opened = transport.sent.filter((message) => message.type === "open");
    assert.deepEqual(opened.map((message) => message.path), ["sub/a.markdown"]);
    transport.deliver({ type: "docs", files: ["Dir/Readme.MD", "Dir/Notes.MarkDown", "Dir/skip.txt", "Dir/no.md.bak"] });
    assert.equal(labeled("a.markdown").length, 0);
    assert.equal(labeled("Dir").length, 1);
    assert.equal(labeled("Readme.MD").length, 0);
    assert.equal(labeled("Notes.MarkDown").length, 0);
    labeled("Dir")[0].listeners.click({ preventDefault() {} });
    assert.equal(labeled("Readme.MD").length, 1);
    assert.equal(labeled("Notes.MarkDown").length, 1);
    assert.equal(labeled("skip.txt").length, 0);
    assert.equal(labeled("no.md.bak").length, 0);
    labeled("Notes.MarkDown")[0].listeners.click({ preventDefault() {} });
    assert.deepEqual(
      transport.sent.filter((message) => message.type === "open").map((message) => message.path),
      ["sub/a.markdown", "Dir/Notes.MarkDown"],
    );
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("a comment.add focuses the id the doc message added", () => {
  const mounted = mountSheet();
  const transport = holdingTransport();
  try {
    const view = createEditor(mounted.root, "hello fox two deer\n", 0, transport);
    const text = mounted.root.childNodes[0].childNodes[0].childNodes[0];
    mounted.listeners.mousedown({ clientX: 0, clientY: 0 });
    mounted.setSelection({
      rangeCount: 1,
      anchorNode: text,
      anchorOffset: 6,
      focusNode: text,
      focusOffset: 9,
      getRangeAt() {
        return {
          collapsed: false,
          commonAncestorContainer: text,
          getClientRects() {
            return [{ top: 12, left: 0, right: 40, bottom: 28, width: 40, height: 16 }];
          },
        };
      },
    });
    mounted.listeners.mouseup({ clientX: 30, clientY: 12 });
    const add = mounted.findAll((node) => node.className === "md-add-comment")[0];
    add.listeners.mousedown({ preventDefault() {} });
    assert.equal(view.getState().doc, "hello fox two deer\n");
    assert.equal(view.getState().anchor, 6);
    assert.equal(view.getState().cursor, 9);
    assert.equal(mounted.findAll((node) => node.tagName === "TEXTAREA").length, 0);
    const fence = transport.sent.filter((message) => message.type === "lock");
    const added = transport.sent.filter((message) => message.type === "edit" && message.op === "comment.add");
    assert.equal(fence.length, 1);
    assert.equal(fence[0].anchor, 6);
    assert.equal(fence[0].cursor, "hello fox two deer\n".length);
    assert.equal(fence[0].path, "");
    assert.equal(fence[0].rev, 0);
    assert.equal(fence[0].lines, undefined);
    assert.equal(added.length, 1);
    assert.equal(added[0].anchor, 6);
    assert.equal(added[0].cursor, 9);
    assert.equal(added[0].id, undefined);
    assert.equal(added[0].path, "");
    assert.equal(added[0].rev, 0);
    assert.ok(transport.sent.indexOf(fence[0]) < transport.sent.indexOf(added[0]));
    const next = "hello {c9}fox{/c9} two deer\n\n```comment c9\n\n```\n";
    transport.deliver({
      type: "doc",
      rev: 1,
      text: next,
      from: 0,
      to: "hello fox two deer\n".length,
      inserted: next,
      actor: "",
      cursor: 10,
      anchor: 10,
    });
    assert.equal(view.getState().doc, next);
    const card = mounted.findAll((node) => node.classList && node.classList.contains("md-comment-card"))[0];
    assert.equal(card.dataset.comment, "c9");
    assert.equal(card.classList.contains("md-comment-current"), true);
    const box = mounted.findAll((node) => node.tagName === "TEXTAREA")[0];
    assert.equal(box.value, "");
    assert.equal(box.focused, true);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("username opens, closes, and reopens the socket", () => {
  const mounted = mountEditor();
  globalThis.window.matchMedia = () => ({ matches: false });
  const nav = document.createElement("nav");
  nav.className = "files";
  const sheet = document.createElement("div");
  const aside = document.createElement("aside");
  aside.className = "comments";
  sheet.append(nav, mounted.root, aside);
  document.getElementById = (id) => (id === "editor" ? mounted.root : null);
  const storage = {
    data: { "viewmark.username": "" },
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : null;
    },
    setItem(key, value) {
      this.data[key] = String(value);
    },
  };
  const sockets = [];
  function factory(url) {
    const handlers = {};
    const socket = {
      url,
      sent: [],
      closed: false,
      addEventListener(type, fn) {
        handlers[type] = fn;
      },
      send(data) {
        this.sent.push(data);
      },
      close() {
        this.closed = true;
      },
      emit(type, event) {
        if (handlers[type]) handlers[type](event);
      },
    };
    sockets.push(socket);
    return socket;
  }
  function loginDialog() {
    for (const child of document.body.childNodes) {
      if (child.classList && child.classList.contains("md-login")) return child;
    }
    return null;
  }
  function loginInput(dialog) {
    return walkNodes(dialog, (node) => node.classList && node.classList.contains("md-login-name"))[0];
  }
  try {
    document.body = document.createElement("body");
    const blank = startPage({
      document: globalThis.document,
      sessionStorage: storage,
      socketFactory: factory,
      location: { protocol: "http:", host: "viewmark.test" },
    });
    assert.equal(sockets.length, 0);
    const created = loginDialog();
    assert.equal(created.open, true);
    assert.equal(created.getAttribute("open"), "");
    const createdInput = loginInput(created);
    assert.equal(createdInput.focused, true);
    const label = walkNodes(created, (node) => node.tagName === "LABEL")[0];
    assert.equal(label.childNodes[0].nodeType, 3);
    assert.equal(label.childNodes[0].textContent, "Username");
    assert.equal(label.childNodes[1], createdInput);
    assert.equal(createdInput.listeners.input, undefined);
    assert.equal(createdInput.listeners.change, undefined);
    assert.equal(storage.data["viewmark.username"], "");
    blank.close();

    document.body = document.createElement("body");
    storage.data["viewmark.username"] = "  ";
    const page = startPage({
      document: globalThis.document,
      sessionStorage: storage,
      socketFactory: factory,
      location: { protocol: "http:", host: "viewmark.test" },
    });
    assert.equal(sockets.length, 0);
    const dialog = loginDialog();
    assert.equal(dialog.open, true);
    const input = loginInput(dialog);
    const form = walkNodes(dialog, (node) => node.tagName === "FORM")[0];
    let blurred = 0;
    input.blur = () => {
      blurred += 1;
    };
    function submit(value) {
      input.value = value;
      let prevented = false;
      form.listeners.submit({
        preventDefault() {
          prevented = true;
        },
      });
      return prevented;
    }
    assert.equal(submit("   "), true);
    assert.equal(dialog.open, true);
    assert.equal(sockets.length, 0);
    assert.equal(storage.data["viewmark.username"], "  ");
    assert.equal(blurred, 0);
    assert.equal(submit("a<b"), true);
    assert.equal(dialog.open, true);
    assert.equal(sockets.length, 0);
    assert.equal(storage.data["viewmark.username"], "  ");
    let cancelled = false;
    dialog.listeners.cancel({
      preventDefault() {
        cancelled = true;
      },
    });
    assert.equal(cancelled, true);
    assert.equal(dialog.open, true);
    let escaped = false;
    dialog.listeners.keydown({
      key: "Escape",
      preventDefault() {
        escaped = true;
      },
    });
    assert.equal(escaped, true);
    let otherKey = false;
    dialog.listeners.keydown({
      key: "a",
      preventDefault() {
        otherKey = true;
      },
    });
    assert.equal(otherKey, false);
    assert.equal(sockets.length, 0);

    assert.equal(submit("  Ada  "), true);
    assert.equal(storage.data["viewmark.username"], "Ada");
    assert.equal(dialog.open, false);
    assert.equal(dialog.hasAttribute("open"), false);
    assert.equal(blurred, 1);
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].url, "ws://viewmark.test/api/ws");
    assert.equal(mounted.root.textContent.includes("Viewmark"), false);
    sockets[0].emit("open");
    assert.deepEqual(JSON.parse(sockets[0].sent[0]), { type: "hello", username: "Ada" });
    assert.deepEqual(JSON.parse(sockets[0].sent[1]), { type: "repos", username: "Ada" });
    assert.equal(sockets[0].sent.length, 2);
    assert.equal(sockets[0].sent.some((frame) => {
      const message = JSON.parse(frame);
      return message.type === "list" || message.type === "tickets";
    }), false);
    sockets[0].emit("message", { data: JSON.stringify({ type: "ping" }) });
    assert.deepEqual(JSON.parse(sockets[0].sent[2]), { type: "pong", username: "Ada" });
    sockets[0].emit("message", { data: JSON.stringify({ type: "docs", files: ["b.md", "sub/a.md"] }) });
    const labeled = (text) => walkNodes(nav, (node) => node.tagName === "BUTTON" && node.textContent === text);
    assert.equal(labeled("b.md").length, 1);
    assert.equal(labeled("a.md").length, 0);
    const opensBefore = sockets[0].sent.length;
    labeled("sub")[0].listeners.click({ preventDefault() {} });
    assert.equal(sockets[0].sent.length, opensBefore);
    assert.equal(labeled("a.md").length, 1);
    sockets[0].emit("message", { data: JSON.stringify({ type: "file", rev: 4, text: "ab", cursor: 1, anchor: 1, path: "b.md" }) });
    assert.equal(mounted.root.textContent, "ab");
    mounted.listeners.beforeinput({
      inputType: "insertText",
      data: "Q",
      preventDefault() {},
    });
    assert.equal(mounted.root.textContent, "ab");
    const edit = JSON.parse(sockets[0].sent.at(-1));
    assert.equal(edit.type, "edit");
    assert.equal(edit.op, "insert");
    assert.equal(edit.text, "Q");
    assert.equal(edit.username, "Ada");
    assert.equal(edit.path, "b.md");
    assert.equal(edit.rev, 4);
    assert.equal(edit.anchor, 1);
    assert.equal(edit.cursor, 1);
    sockets[0].emit("message", {
      data: JSON.stringify({
        type: "doc",
        rev: 5,
        text: "aQb",
        from: 1,
        to: 1,
        inserted: "Q",
        actor: "Ada",
        cursor: 2,
        anchor: 2,
      }),
    });
    assert.equal(mounted.root.textContent, "aQb");
    page.close();
    assert.equal(sockets[0].closed, true);
    const closedFrames = sockets[0].sent.length;
    sockets[0].emit("open");
    sockets[0].emit("message", { data: JSON.stringify({ type: "docs", files: ["late.md"] }) });
    assert.equal(sockets[0].sent.length, closedFrames);
    assert.equal(labeled("late.md").length, 0);

    storage.data["viewmark.username"] = "ada";
    const again = startPage({
      document: globalThis.document,
      sessionStorage: storage,
      socketFactory: factory,
      location: { protocol: "http:", host: "viewmark.test" },
    });
    assert.equal(dialog.open, false);
    assert.equal(sockets.length, 2);
    sockets[1].emit("open");
    assert.deepEqual(JSON.parse(sockets[1].sent[0]), { type: "hello", username: "ada" });
    assert.deepEqual(JSON.parse(sockets[1].sent[1]), { type: "repos", username: "ada" });
    assert.equal(sockets[1].sent.length, 2);
    again.close();
    assert.equal(sockets[1].closed, true);

    const secure = startPage({
      document: globalThis.document,
      sessionStorage: storage,
      socketFactory: factory,
      location: { protocol: "https:", host: "viewmark.test" },
    });
    assert.equal(sockets.length, 3);
    assert.equal(sockets[2].url, "wss://viewmark.test/api/ws");
    assert.equal(dialog.open, false);
    secure.close();
    assert.equal(sockets[2].closed, true);
  } finally {
    mounted.restore();
  }
});

test("T-repo-select", () => {
  const mounted = mountEditor();
  const css = readFileSync(new URL("../editor.css", import.meta.url), "utf8");
  const rowRule = css.match(/div\.md-repo-row\s*\{[^}]*\}/);
  assert.ok(rowRule);
  assert.match(rowRule[0], /display:\s*flex/);
  assert.match(rowRule[0], /align-items:\s*center/);
  assert.match(rowRule[0], /gap:\s*0\.45rem/);
  assert.match(rowRule[0], /margin:\s*0 0 0\.8rem/);
  assert.match(rowRule[0], /flex:\s*none/);
  const rule = css.match(/select\.md-repo\s*\{[^}]*\}/);
  assert.ok(rule);
  assert.match(rule[0], /flex:\s*1 1 auto/);
  assert.match(rule[0], /width:\s*auto/);
  assert.match(rule[0], /min-width:\s*0/);
  assert.match(rule[0], /margin:\s*0;/);
  assert.equal(/flex:\s*none/.test(rule[0]), false);
  assert.equal(/width:\s*100%/.test(rule[0]), false);
  assert.equal(/margin:\s*0 0 0\.8rem/.test(rule[0]), false);
  assert.match(rule[0], /background:\s*#1c1b19/);
  assert.match(rule[0], /border:\s*1px solid #4a463f/);
  assert.match(rule[0], /font:\s*inherit/);
  assert.match(rule[0], /color:\s*inherit/);
  assert.match(rule[0], /box-sizing:\s*border-box/);
  const nav = document.createElement("nav");
  nav.className = "files";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "md-new-file";
  button.textContent = "+";
  nav.appendChild(button);
  const sheet = document.createElement("div");
  sheet.append(nav, mounted.root);
  const transport = holdingTransport();
  try {
    const view = createEditor(mounted.root, "kept", 0, transport);
    const row = nav.childNodes[0];
    assert.equal(row.tagName, "DIV");
    assert.equal(row.classList.contains("md-repo-row"), true);
    assert.equal(row.childNodes[0].tagName, "LABEL");
    assert.equal(row.childNodes[0].textContent, "Repo");
    const select = row.childNodes[1];
    assert.equal(select.tagName, "SELECT");
    assert.equal(select.classList.contains("md-repo"), true);
    assert.equal(nav.childNodes[1].classList.contains("file-block"), true);
    assert.equal(button.parentElement.classList.contains("md-pane-head"), true);
    assert.equal(button.parentElement.childNodes[0].textContent, "Files");
    assert.equal(select.childNodes.length, 0);
    assert.deepEqual(transport.sent.filter((message) => message.type === "repo" || message.type === "list" || message.type === "tickets"), []);
    transport.deliver({
      type: "repos",
      repos: [
        { name: "alpha", description: "Alpha notes", path: "/a" },
        { name: "beta", description: "Beta notes", path: "/b" },
      ],
    });
    assert.equal(nav.childNodes[0], row);
    assert.equal(select.parentElement, row);
    assert.equal(row.childNodes[0].textContent, "Repo");
    assert.equal(row.childNodes[1], select);
    assert.deepEqual(select.childNodes.map((option) => option.value), ["", "alpha", "beta"]);
    assert.deepEqual(select.childNodes.map((option) => option.textContent), ["", "Alpha notes", "Beta notes"]);
    assert.equal(select.value, "");
    assert.equal(select.selectedIndex, 0);
    assert.equal(select.childNodes[0].selected, true);
    assert.deepEqual(transport.sent.filter((message) => message.type === "repo" || message.type === "list" || message.type === "tickets"), []);
    transport.deliver({ type: "docs", files: ["b.md", "sub/a.md"] });
    const labeled = (text) => walkNodes(nav, (node) => node.tagName === "BUTTON" && node.textContent === text);
    assert.equal(labeled("b.md").length, 1);
    assert.equal(labeled("sub").length, 1);
    assert.equal(labeled("a.md").length, 0);
    assert.equal(view.getState().doc, "kept");
    transport.deliver({
      type: "repos",
      repos: [{ name: "beta", description: "Second shelf", path: "/b" }],
    });
    assert.deepEqual(select.childNodes.map((option) => option.value), ["", "beta"]);
    assert.deepEqual(select.childNodes.map((option) => option.textContent), ["", "Second shelf"]);
    assert.equal(select.value, "");
    assert.equal(select.selectedIndex, 0);
    assert.equal(select.childNodes[0].selected, true);
    assert.equal(labeled("b.md").length, 1);
    assert.equal(view.getState().doc, "kept");
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("T-repo-switch", () => {
  const mounted = mountEditor();
  const nav = document.createElement("nav");
  nav.className = "files";
  const sheet = document.createElement("div");
  sheet.append(nav, mounted.root);
  const storage = {
    data: {},
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : null;
    },
    setItem(key, value) {
      this.data[key] = String(value);
    },
    removeItem(key) {
      delete this.data[key];
    },
  };
  const transport = holdingTransport();
  try {
    const view = createEditor(mounted.root, "", 0, transport, storage);
    const select = nav.childNodes[0].childNodes[1];
    assert.equal(nav.childNodes[0].classList.contains("md-repo-row"), true);
    assert.equal(nav.childNodes[0].childNodes[0].textContent, "Repo");
    assert.equal(select.classList.contains("md-repo"), true);
    transport.deliver({
      type: "repos",
      repos: [
        { name: "alpha", description: "Alpha notes", path: "/a" },
        { name: "beta", description: "Beta notes", path: "/b" },
      ],
    });
    assert.equal(transport.sent.length, 0);
    assert.deepEqual(select.childNodes.map((option) => option.value), ["", "alpha", "beta"]);
    assert.deepEqual(select.childNodes.map((option) => option.textContent), ["", "Alpha notes", "Beta notes"]);
    assert.equal(select.value, "");
    assert.equal(select.selectedIndex, 0);
    assert.equal(select.childNodes[0].selected, true);
    select.value = "alpha";
    select.listeners.change();
    assert.equal(storage.data["viewmark.repo"], "alpha");
    assert.deepEqual(transport.sent.map((message) => message.type), ["repo", "list", "tickets"]);
    assert.equal(transport.sent[0].name, "alpha");
    assert.equal(transport.sent[0].username, "");
    transport.deliver({ type: "docs", files: ["a.md", "sub/b.md"] });
    transport.deliver({ type: "tickets", tickets: [ticketFixture("aaaaaaaa", "Alpha", "new", T0)] });
    transport.deliver({
      type: "file",
      rev: 3,
      text: "old file",
      path: "tickets/aaaaaaaa.md",
      cursor: 0,
      anchor: 0,
      ticket: ticketFixture("aaaaaaaa", "Alpha", "new", T0),
    });
    const labeled = (text) => walkNodes(nav, (node) => node.tagName === "BUTTON" && node.textContent === text);
    const form = walkNodes(sheet, (node) => node.classList && node.classList.contains("ticket-form"))[0];
    assert.equal(mounted.root.textContent.includes("old file"), true);
    assert.equal(labeled("a.md").length, 1);
    assert.equal(walkNodes(nav, (node) => node.classList && node.classList.contains("md-ticket-node")).length, 1);
    assert.equal(form.hidden, false);
    const before = transport.sent.length;
    select.value = "beta";
    select.listeners.change();
    assert.equal(storage.data["viewmark.repo"], "beta");
    assert.equal(view.getState().doc, "");
    assert.equal(mounted.root.textContent.includes("old file"), false);
    assert.equal(labeled("a.md").length, 0);
    assert.equal(labeled("sub").length, 0);
    assert.equal(walkNodes(nav, (node) => node.classList && node.classList.contains("md-ticket-node")).length, 0);
    assert.equal(form.hidden, true);
    const frames = transport.sent.slice(before);
    assert.deepEqual(frames.map((message) => message.type), ["repo", "list", "tickets"]);
    assert.equal(frames[0].name, "beta");
    assert.equal(frames[0].username, "");
    assert.equal(mounted.root.textContent.includes("old file"), false);
    transport.deliver({ type: "file", rev: 1, text: "new file", path: "b.md", cursor: 0, anchor: 0 });
    assert.equal(view.getState().doc, "new file");
    assert.equal(mounted.root.textContent.includes("new file"), true);
    const afterFile = transport.sent.length;
    transport.deliver({
      type: "repos",
      repos: [
        { name: "alpha", description: "Alpha notes", path: "/a" },
        { name: "beta", description: "Beta notes", path: "/b" },
      ],
    });
    assert.equal(transport.sent.length, afterFile);
    assert.deepEqual(select.childNodes.map((option) => option.value), ["", "alpha", "beta"]);
    assert.equal(select.value, "beta");
    assert.equal(select.childNodes[0].selected, false);
    assert.equal(select.childNodes.find((option) => option.value === "beta").selected, true);
    assert.equal(view.getState().doc, "new file");
    select.value = "beta";
    select.listeners.change();
    assert.equal(transport.sent.length, afterFile);
    transport.deliver({
      type: "repos",
      repos: [{ name: "alpha", description: "Alpha notes", path: "/a" }],
    });
    assert.equal(transport.sent.length, afterFile);
    assert.equal(view.getState().doc, "");
    assert.equal(mounted.root.textContent.includes("new file"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(storage.data, "viewmark.repo"), false);
    assert.deepEqual(select.childNodes.map((option) => option.value), ["", "alpha"]);
    assert.equal(select.value, "");
    assert.equal(select.selectedIndex, 0);
    assert.equal(select.childNodes[0].selected, true);
    view.destroy();

    storage.data["viewmark.repo"] = "alpha";
    const storedTransport = holdingTransport();
    const again = createEditor(mounted.root, "stale", 0, storedTransport, storage);
    const storedSelect = nav.childNodes[0].childNodes[1];
    storedTransport.deliver({
      type: "repos",
      repos: [
        { name: "beta", description: "Beta notes", path: "/b" },
        { name: "alpha", description: "Alpha notes", path: "/a" },
      ],
    });
    assert.deepEqual(storedSelect.childNodes.map((option) => option.value), ["", "beta", "alpha"]);
    assert.equal(storedSelect.value, "alpha");
    assert.equal(storedSelect.childNodes[0].selected, false);
    assert.equal(storedSelect.childNodes.find((option) => option.value === "alpha").selected, true);
    assert.equal(storedSelect.childNodes.find((option) => option.value === "alpha").textContent, "Alpha notes");
    assert.deepEqual(storedTransport.sent.map((message) => message.type), ["repo", "list", "tickets"]);
    assert.equal(storedTransport.sent[0].name, "alpha");
    const once = storedTransport.sent.length;
    storedTransport.deliver({
      type: "repos",
      repos: [
        { name: "alpha", description: "Alpha notes", path: "/a" },
        { name: "beta", description: "Beta notes", path: "/b" },
      ],
    });
    assert.equal(storedTransport.sent.length, once);
    assert.equal(storedSelect.value, "alpha");
    storedSelect.value = "alpha";
    storedSelect.listeners.change();
    assert.equal(storedTransport.sent.length, once);
    again.destroy();

    const sockets = [];
    function factory(url) {
      const handlers = {};
      const socket = {
        url,
        sent: [],
        closed: false,
        addEventListener(type, fn) {
          handlers[type] = fn;
        },
        send(data) {
          this.sent.push(data);
        },
        close() {
          this.closed = true;
        },
        emit(type, event) {
          if (handlers[type]) handlers[type](event);
        },
      };
      sockets.push(socket);
      return socket;
    }
    storage.data["viewmark.username"] = "Ada";
    storage.data["viewmark.repo"] = "alpha";
    document.body = document.createElement("body");
    document.getElementById = (id) => (id === "editor" ? mounted.root : null);
    const page = startPage({
      document: globalThis.document,
      sessionStorage: storage,
      socketFactory: factory,
      location: { protocol: "http:", host: "viewmark.test" },
    });
    assert.equal(sockets.length, 1);
    sockets[0].emit("open");
    assert.deepEqual(JSON.parse(sockets[0].sent[0]), { type: "hello", username: "Ada" });
    assert.deepEqual(JSON.parse(sockets[0].sent[1]), { type: "repos", username: "Ada" });
    assert.equal(sockets[0].sent.length, 2);
    sockets[0].emit("message", {
      data: JSON.stringify({
        type: "repos",
        repos: [
          { name: "beta", description: "Beta notes", path: "/b" },
          { name: "alpha", description: "Alpha notes", path: "/a" },
        ],
      }),
    });
    assert.equal(sockets[0].sent.length, 5);
    assert.deepEqual(JSON.parse(sockets[0].sent[2]), { type: "repo", name: "alpha", username: "Ada" });
    assert.deepEqual(JSON.parse(sockets[0].sent[3]), { type: "list", username: "Ada" });
    assert.deepEqual(JSON.parse(sockets[0].sent[4]), { type: "tickets", username: "Ada" });
    const pageSelect = walkNodes(nav, (node) => node.classList && node.classList.contains("md-repo"))[0];
    assert.deepEqual(pageSelect.childNodes.map((option) => option.value), ["", "beta", "alpha"]);
    assert.equal(pageSelect.value, "alpha");
    assert.equal(pageSelect.childNodes.find((option) => option.value === "alpha").selected, true);
    sockets[0].emit("message", {
      data: JSON.stringify({ type: "file", rev: 1, text: "page file", path: "a.md", cursor: 0, anchor: 0 }),
    });
    assert.equal(mounted.root.textContent.includes("page file"), true);
    const chosen = sockets[0].sent.length;
    pageSelect.value = "beta";
    pageSelect.listeners.change();
    assert.equal(mounted.root.textContent.includes("page file"), false);
    assert.deepEqual(JSON.parse(sockets[0].sent[chosen]), { type: "repo", name: "beta", username: "Ada" });
    assert.deepEqual(JSON.parse(sockets[0].sent[chosen + 1]), { type: "list", username: "Ada" });
    assert.deepEqual(JSON.parse(sockets[0].sent[chosen + 2]), { type: "tickets", username: "Ada" });
    assert.equal(sockets[0].sent.length, chosen + 3);
    sockets[0].emit("message", {
      data: JSON.stringify({ type: "file", rev: 1, text: "beta file", path: "b.md", cursor: 0, anchor: 0 }),
    });
    assert.equal(mounted.root.textContent.includes("beta file"), true);
    const stayed = sockets[0].sent.length;
    sockets[0].emit("message", {
      data: JSON.stringify({
        type: "repos",
        repos: [
          { name: "alpha", description: "Alpha notes", path: "/a" },
          { name: "beta", description: "Beta notes", path: "/b" },
        ],
      }),
    });
    assert.equal(sockets[0].sent.length, stayed);
    assert.equal(mounted.root.textContent.includes("beta file"), true);
    sockets[0].emit("message", {
      data: JSON.stringify({ type: "repos", repos: [{ name: "alpha", description: "Alpha notes", path: "/a" }] }),
    });
    assert.equal(sockets[0].sent.length, stayed);
    assert.equal(mounted.root.textContent.includes("beta file"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(storage.data, "viewmark.repo"), false);
    assert.deepEqual(pageSelect.childNodes.map((option) => option.value), ["", "alpha"]);
    assert.equal(pageSelect.value, "");
    assert.equal(pageSelect.selectedIndex, 0);
    assert.equal(pageSelect.childNodes[0].selected, true);
    page.close();
    assert.equal(sockets[0].closed, true);
  } finally {
    mounted.restore();
  }
});

test("username focus stays on the field through the first character", () => {
  const mounted = mountEditor();
  const nav = document.createElement("nav");
  nav.className = "files";
  const sheet = document.createElement("div");
  sheet.append(nav, mounted.root);
  document.getElementById = (id) => (id === "editor" ? mounted.root : null);
  document.body = document.createElement("body");
  const sockets = [];
  function factory(url) {
    const handlers = {};
    const socket = {
      url,
      sent: [],
      closed: false,
      addEventListener(type, fn) {
        handlers[type] = fn;
      },
      send(data) {
        this.sent.push(data);
      },
      close() {
        this.closed = true;
      },
      emit(type, event) {
        if (handlers[type]) handlers[type](event);
      },
    };
    sockets.push(socket);
    return socket;
  }
  try {
    const page = startPage({
      document: globalThis.document,
      sessionStorage: { getItem() { return null; }, setItem() {} },
      socketFactory: factory,
      location: { protocol: "http:", host: "viewmark.test" },
    });
    assert.equal(sockets.length, 0);
    const dialog = document.body.childNodes.find((node) => node.classList && node.classList.contains("md-login"));
    const input = walkNodes(dialog, (node) => node.classList && node.classList.contains("md-login-name"))[0];
    const form = walkNodes(dialog, (node) => node.tagName === "FORM")[0];
    assert.equal(dialog.open, true);
    document.activeElement = input;
    globalThis.NodeFilter = globalThis.NodeFilter || { SHOW_TEXT: 4 };
    const host = {
      nodeType: 1,
      dataset: { start: "0", end: "0" },
      closest() {
        return null;
      },
      scrollIntoView() {},
    };
    const text = { nodeType: 3, length: 0, parentElement: host };
    document.createTreeWalker = () => {
      let pending = text;
      return {
        nextNode() {
          const node = pending;
          pending = null;
          return node;
        },
      };
    };
    document.createRange = () => ({
      setStart() {},
      collapse() {},
    });
    let added = false;
    globalThis.window.getSelection = () => ({
      rangeCount: 0,
      removeAllRanges() {},
      addRange() {
        document.activeElement = mounted.root;
        added = true;
      },
    });
    input.value = "Ada";
    assert.equal(typeof input.listeners.input, "undefined");
    assert.equal(typeof input.listeners.change, "undefined");
    if (typeof input.listeners.input === "function") input.listeners.input();
    if (typeof input.listeners.change === "function") input.listeners.change();
    assert.equal(added, false);
    assert.equal(document.activeElement, input);
    assert.equal(sockets.length, 0);
    let prevented = false;
    form.listeners.submit({
      preventDefault() {
        prevented = true;
      },
    });
    assert.equal(prevented, true);
    assert.equal(sockets.length, 1);
    sockets[0].emit("open");
    assert.deepEqual(JSON.parse(sockets[0].sent[0]), { type: "hello", username: "Ada" });
    page.close();
    assert.equal(sockets[0].closed, true);
  } finally {
    mounted.restore();
  }
});

test("Enter on notes/idea creates notes/idea.md and a file message shows the row", () => {
  const mounted = mountEditor();
  const css = readFileSync(new URL("../editor.css", import.meta.url), "utf8");
  assert.match(css, /\.md-new-file\s*\{[^}]*border:\s*1px solid #c4b8a4;/);
  assert.match(css, /\.md-new-file\s*\{[^}]*border-radius:\s*0\.35rem;/);
  assert.match(css, /button\s*\{[^}]*border:\s*1px solid #c4b8a4;/);
  assert.match(css, /button\s*\{[^}]*border-radius:\s*0\.35rem;/);
  assert.match(css, /\.md-new-ticket\s*\{[^}]*border:\s*1px solid #c4b8a4;/);
  assert.match(css, /button\.md-doc-menu\s*\{[^}]*border:\s*1px solid #c4b8a4;/);
  assert.match(css, /button\.md-doc-menu\s*\{[^}]*border-radius:\s*0\.35rem;/);
  assert.match(css, /\.ticket-tree button\.md-ticket-expand\s*\{[^}]*border:\s*1px solid #c4b8a4;/);
  assert.match(css, /\.ticket-tree button\.md-ticket\s*\{[^}]*border:\s*1px solid #c4b8a4;/);
  assert.match(css, /\.file-tree button\s*\{[^}]*border:\s*1px solid #c4b8a4;/);
  assert.match(css, /\.ticket-form button\.md-ticket-link,\s*\.ticket-form button\.md-ticket-option,\s*\.ticket-form button\.md-ticket-rely\s*\{[^}]*border:\s*1px solid #c4b8a4;/);
  assert.match(css, /\.ticket-form button\.md-ticket-link,\s*\.ticket-form button\.md-ticket-option,\s*\.ticket-form button\.md-ticket-rely\s*\{[^}]*border-radius:\s*0\.35rem;/);
  assert.match(css, /:root\s*\{[^}]*--danger:\s*#ff7b72;/);
  assert.match(css, /\.icon-btn svg\s*\{[^}]*width:\s*1\.1em;/);
  assert.match(css, /\.icon-btn svg\s*\{[^}]*height:\s*1\.1em;/);
  assert.match(css, /\.icon-btn svg\s*\{[^}]*display:\s*block;/);
  assert.match(css, /\.icon-btn\.danger\s*\{[^}]*color:\s*var\(--danger\)/);
  assert.match(css, /\.icon-btn\.resolve\s*\{[^}]*color:\s*#8fdb8a;/);
  assert.match(css, /label,\s*\.md-ticket-label\s*\{[^}]*font-weight:\s*700;/);
  assert.match(css, /\.md-line\.md-hr\s*\{[^}]*border:\s*0;/);
  assert.match(css, /\.md-new-file\s*\{[^}]*background:\s*none;/);
  assert.match(css, /\.md-new-file\s*\{[^}]*font:\s*inherit;/);
  assert.equal(/\.md-new-file\s*\{[^}]*width:\s*100%/.test(css), false);
  assert.equal(/\.md-new-file\s*\{[^}]*display:\s*block/.test(css), false);
  const nav = document.createElement("nav");
  nav.className = "files";
  const sheet = document.createElement("div");
  sheet.appendChild(nav);
  sheet.appendChild(mounted.root);
  const transport = holdingTransport();
  try {
    const view = createEditor(mounted.root, "x", 0, transport);
    const buttons = () => walkNodes(nav, (node) => node.classList && node.classList.contains("md-new-file"));
    assert.equal(buttons().length, 1);
    assert.equal(nav.childNodes[0].classList.contains("md-repo-row"), true);
    const fileBlock = () => walkNodes(nav, (node) => node.classList && node.classList.contains("file-block"))[0];
    assert.equal(nav.childNodes[1], fileBlock());
    const button = buttons()[0];
    assert.equal(button.textContent, "");
    assert.equal(button.getAttribute("aria-label"), "New file");
    assert.equal(button.classList.contains("icon-btn"), true);
    assert.deepEqual(iconPaths(button), ["M12 5v14M5 12h14"]);
    const plusPath = [...button.childNodes].find((node) => node.localName === "svg").childNodes[0];
    assert.equal(plusPath.getAttribute("fill"), "none");
    assert.equal(plusPath.getAttribute("stroke"), "currentColor");
    assert.equal(plusPath.getAttribute("stroke-width"), "2");
    assert.equal(plusPath.getAttribute("stroke-linecap"), "round");
    assert.equal(plusPath.getAttribute("stroke-linejoin"), "round");
    assert.equal(button.type, "button");
    const head = button.parentElement;
    assert.equal(head.classList.contains("md-pane-head"), true);
    assert.equal(head.childNodes[0].classList.contains("md-pane-heading"), true);
    assert.equal(head.childNodes[0].textContent, "Files");
    assert.equal(head.childNodes[1], button);
    const field = walkNodes(nav, (node) => node.classList && node.classList.contains("md-new-name"))[0];
    assert.equal(field.tagName, "INPUT");
    assert.equal(field.parentElement, fileBlock());
    assert.ok(fileBlock().childNodes.indexOf(head) < fileBlock().childNodes.indexOf(field));
    assert.equal(field.hasAttribute("hidden"), true);
    assert.equal(field.hidden, true);
    button.listeners.click({ preventDefault() {} });
    assert.equal(field.hasAttribute("hidden"), false);
    assert.equal(field.hidden, false);
    transport.deliver({ type: "docs", files: ["notes/idea.md"] });
    const labeled = (text) => walkNodes(nav, (node) => node.tagName === "BUTTON" && node.textContent === text);
    assert.equal(labeled("notes").length, 1);
    assert.equal(labeled("idea.md").length, 0);
    const tree = walkNodes(nav, (node) => node.classList && node.classList.contains("file-tree"))[0];
    assert.equal(tree.parentElement, fileBlock());
    assert.ok(fileBlock().childNodes.indexOf(field) < fileBlock().childNodes.indexOf(tree));
    assert.equal(walkNodes(tree, (node) => node.classList && node.classList.contains("md-new-file")).length, 0);
    field.value = "notes/idea";
    field.listeners.keydown({ key: "Enter", preventDefault() {} });
    assert.deepEqual(transport.sent.at(-1), { type: "create", path: "notes/idea.md", username: "" });
    assert.equal(transport.sent.at(-1).rev, undefined);
    const afterCreate = transport.sent.length;
    field.value = "   ";
    field.listeners.keydown({ key: "Enter", preventDefault() {} });
    assert.equal(transport.sent.length, afterCreate);
    field.value = "skip";
    field.listeners.keydown({ key: "Escape", preventDefault() {} });
    assert.equal(transport.sent.length, afterCreate);
    assert.equal(field.hasAttribute("hidden"), true);
    button.listeners.click({ preventDefault() {} });
    field.value = "///notes/other.markdown";
    field.listeners.keydown({ key: "Enter", preventDefault() {} });
    assert.deepEqual(transport.sent.at(-1), { type: "create", path: "notes/other.markdown", username: "" });
    button.listeners.click({ preventDefault() {} });
    field.value = "notes/idea.md";
    field.listeners.keydown({ key: "Enter", preventDefault() {} });
    assert.equal(transport.sent.at(-1).path, "notes/idea.md");
    transport.deliver({ type: "file", path: "notes/idea.md", rev: 0, text: "", locks: [] });
    assert.equal(view.getState().doc, "");
    assert.equal(labeled("idea.md").length, 1);
    view.destroy();
    const again = createEditor(mounted.root, "x", 0, transport);
    assert.equal(buttons().length, 1);
    assert.equal(walkNodes(nav, (node) => node.classList && node.classList.contains("md-new-name")).length, 1);
    assert.equal(nav.childNodes[0].classList.contains("md-repo-row"), true);
    assert.equal(walkNodes(nav, (node) => node.classList && node.classList.contains("md-repo-row")).length, 1);
    assert.equal(walkNodes(nav, (node) => node.classList && node.classList.contains("md-repo")).length, 1);
    assert.equal(walkNodes(nav, (node) => node.tagName === "LABEL" && node.textContent === "Repo").length, 1);
    assert.equal(nav.childNodes[0].childNodes[0].textContent, "Repo");
    assert.equal(nav.childNodes[0].childNodes[1].classList.contains("md-repo"), true);
    assert.equal(nav.childNodes[1], fileBlock());
    assert.equal(buttons()[0].parentElement.classList.contains("md-pane-head"), true);
    again.destroy();
  } finally {
    mounted.restore();
  }
});

test("NodeList childNodes places the file block as the next sibling of the repo row", () => {
  const mounted = mountEditor({ nodeList: true });
  const nav = document.createElement("nav");
  nav.className = "files";
  const sheet = document.createElement("div");
  sheet.appendChild(nav);
  sheet.appendChild(mounted.root);
  const transport = holdingTransport();
  try {
    assert.equal(typeof nav.childNodes.indexOf, "undefined");
    assert.equal(typeof nav.insertBefore, "function");
    assert.equal(nav.nextSibling, mounted.root);
    const view = createEditor(mounted.root, "x", 0, transport);
    const row = nav.childNodes[0];
    assert.equal(row.classList.contains("md-repo-row"), true);
    assert.equal(row.childNodes[0].tagName, "LABEL");
    assert.equal(row.childNodes[0].textContent, "Repo");
    const select = row.childNodes[1];
    assert.equal(select.classList.contains("md-repo"), true);
    const block = row.nextSibling;
    assert.ok(block);
    assert.equal(block.classList.contains("file-block"), true);
    const head = block.childNodes[0];
    assert.equal(head.classList.contains("md-pane-head"), true);
    assert.equal(head.childNodes[0].tagName, "H2");
    assert.equal(head.childNodes[0].classList.contains("md-pane-heading"), true);
    assert.equal(head.childNodes[1].classList.contains("md-new-file"), true);
    assert.equal(head.childNodes[1].textContent, "");
    assert.equal(head.childNodes[1].getAttribute("aria-label"), "New file");
    assert.deepEqual(iconPaths(head.childNodes[1]), ["M12 5v14M5 12h14"]);
    assert.equal(typeof nav.childNodes.indexOf, "undefined");
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("commit button checkpoints the active repo", () => {
  const mounted = mountEditor();
  const css = readFileSync(new URL("../editor.css", import.meta.url), "utf8");
  const rule = css.match(/button\.md-doc-commit\s*\{[^}]*\}/);
  assert.ok(rule);
  assert.match(rule[0], /font:\s*inherit/);
  assert.match(rule[0], /color:\s*inherit/);
  assert.match(rule[0], /background:\s*#1c1b19/);
  assert.match(rule[0], /border:\s*1px solid #4a463f/);
  assert.match(rule[0], /box-sizing:\s*border-box/);
  assert.equal(/button\.md-commit\s*\{/.test(css), false);
  const nav = document.createElement("nav");
  nav.className = "files";
  const aside = document.createElement("aside");
  aside.className = "comments";
  const sheet = document.createElement("div");
  sheet.append(nav, mounted.root, aside);
  const storage = {
    data: {},
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : null;
    },
    setItem(key, value) {
      this.data[key] = String(value);
    },
    removeItem(key) {
      delete this.data[key];
    },
  };
  const transport = holdingTransport();
  try {
    const view = createEditor(mounted.root, "ab\ncd\n", 0, transport, storage);
    const commits = () => walkNodes(aside, (node) => node.classList && node.classList.contains("md-doc-commit"));
    const plus = walkNodes(nav, (node) => node.classList && node.classList.contains("md-new-file"))[0];
    const tree = walkNodes(nav, (node) => node.classList && node.classList.contains("file-tree"))[0];
    assert.equal(walkNodes(nav, (node) => node.classList && node.classList.contains("md-commit")).length, 0);
    assert.equal(commits().length, 1);
    const menu = docMenuOf(aside);
    assert.equal(menu.button.getAttribute("aria-label"), "Menu");
    assert.equal(menu.panel.hidden, true);
    assert.equal(menu.commit, commits()[0]);
    const button = commits()[0];
    assert.equal(button.tagName, "BUTTON");
    assert.equal(button.type, "button");
    assert.equal(button.textContent, "Commit repo");
    assert.equal(button.hidden, true);
    assert.equal(button.hasAttribute("hidden"), true);
    assert.equal(nav.childNodes[0].classList.contains("md-repo-row"), true);
    assert.equal(nav.childNodes[0].childNodes[0].textContent, "Repo");
    assert.equal(nav.childNodes[1].classList.contains("file-block"), true);
    assert.equal(plus.parentElement.classList.contains("md-pane-head"), true);
    assert.equal(tree.parentElement, nav.childNodes[1]);
    const select = nav.childNodes[0].childNodes[1];
    transport.deliver({
      type: "repos",
      repos: [
        { name: "alpha", description: "Alpha notes", path: "/a" },
        { name: "beta", description: "Beta notes", path: "/b" },
      ],
    });
    assert.equal(button.hidden, true);
    assert.equal(transport.sent.length, 0);
    select.value = "alpha";
    select.listeners.change();
    assert.equal(button.hidden, false);
    assert.equal(button.hasAttribute("hidden"), false);
    transport.deliver({ type: "file", rev: 1, text: "ab\ncd\n", path: "a.md", cursor: 0, anchor: 0 });
    const before = transport.sent.length;
    button.listeners.click({ preventDefault() {} });
    assert.equal(transport.sent.length, before + 1);
    const frame = transport.sent.at(-1);
    assert.deepEqual(frame, { type: "commit", username: "" });
    assert.equal(frame.rev, undefined);
    assert.equal(frame.message, undefined);
    const field = walkNodes(nav, (node) => node.classList && node.classList.contains("md-new-name"))[0];
    plus.listeners.click({ preventDefault() {} });
    field.value = "notes/idea";
    field.listeners.keydown({ key: "Enter", preventDefault() {} });
    assert.equal(transport.sent.at(-1).type, "create");
    const line = mounted.root.childNodes[1];
    const text = line.childNodes[0].childNodes[0];
    assert.equal(text.textContent, "cd");
    document.caretPositionFromPoint = () => ({ offsetNode: text, offset: 0 });
    mounted.listeners.click({ target: text, clientX: 1, clientY: 1, preventDefault() {} });
    assert.equal(view.getState().cursor, 3);
    assert.equal(view.getState().anchor, 3);
    transport.deliver({ type: "error", status: 409 });
    assert.equal(view.getState().cursor, 3);
    assert.equal(view.getState().anchor, 3);
    transport.deliver({ type: "error", status: 409 });
    assert.equal(view.getState().cursor, 0);
    assert.equal(view.getState().anchor, 0);
    select.value = "beta";
    select.listeners.change();
    assert.equal(button.hidden, false);
    transport.deliver({ type: "repos", repos: [{ name: "alpha", description: "Alpha notes", path: "/a" }] });
    assert.equal(button.hidden, true);
    assert.equal(button.hasAttribute("hidden"), true);
    const quiet = transport.sent.length;
    button.listeners.click({ preventDefault() {} });
    assert.equal(transport.sent.length, quiet);
    view.destroy();
    assert.equal(button.listeners.click, undefined);
    assert.equal(commits().length, 1);

    storage.data["viewmark.repo"] = "alpha";
    const storedTransport = holdingTransport();
    const again = createEditor(mounted.root, "stale", 0, storedTransport, storage);
    const storedButton = commits()[0];
    assert.equal(commits().length, 1);
    assert.equal(storedButton.hidden, true);
    assert.equal(storedButton.textContent, "Commit repo");
    storedTransport.deliver({
      type: "repos",
      repos: [
        { name: "beta", description: "Beta notes", path: "/b" },
        { name: "alpha", description: "Alpha notes", path: "/a" },
      ],
    });
    assert.equal(storedButton.hidden, false);
    assert.equal(storedButton.hasAttribute("hidden"), false);
    const marked = storedTransport.sent.length;
    storedButton.listeners.click({ preventDefault() {} });
    assert.equal(storedTransport.sent.length, marked + 1);
    assert.deepEqual(storedTransport.sent[marked], { type: "commit", username: "" });
    assert.equal(storedTransport.sent[marked].rev, undefined);
    assert.equal(storedTransport.sent[marked].message, undefined);
    again.destroy();
    assert.equal(storedButton.listeners.click, undefined);
  } finally {
    mounted.restore();
  }
});

test("a create 409 does not restore the caret and a later 409 does", () => {
  const mounted = mountEditor();
  const nav = document.createElement("nav");
  nav.className = "files";
  const input = document.createElement("input");
  nav.appendChild(input);
  const sheet = document.createElement("div");
  sheet.append(nav, mounted.root);
  const transport = holdingTransport();
  try {
    const view = createEditor(mounted.root, "ab\ncd\n", 0, transport);
    const button = walkNodes(nav, (node) => node.classList && node.classList.contains("md-new-file"))[0];
    const field = walkNodes(nav, (node) => node.classList && node.classList.contains("md-new-name"))[0];
    button.listeners.click({ preventDefault() {} });
    field.value = "notes/idea";
    field.listeners.keydown({ key: "Enter", preventDefault() {} });
    assert.deepEqual(transport.sent.at(-1), { type: "create", path: "notes/idea.md", username: "" });
    const line = mounted.root.childNodes[1];
    const text = line.childNodes[0].childNodes[0];
    assert.equal(text.textContent, "cd");
    document.caretPositionFromPoint = () => ({ offsetNode: text, offset: 0 });
    mounted.listeners.click({ target: text, clientX: 1, clientY: 1, preventDefault() {} });
    assert.equal(view.getState().cursor, 3);
    assert.equal(view.getState().anchor, 3);
    transport.deliver({ type: "error", status: 409 });
    assert.equal(view.getState().cursor, 3);
    assert.equal(view.getState().anchor, 3);
    transport.deliver({ type: "error", status: 409 });
    assert.equal(view.getState().cursor, 0);
    assert.equal(view.getState().anchor, 0);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("createEditor without activeElement does not throw", () => {
  const mounted = mountEditor();
  try {
    assert.equal(document.activeElement, undefined);
    const view = createEditor(mounted.root, "ab", 0);
    assert.equal(view.getState().doc, "ab");
    view.destroy();
  } finally {
    mounted.restore();
  }
});

const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-02T00:00:00.000Z";
const T2 = "2026-10-03T00:00:00.000Z";
const T3 = "2026-10-04T00:00:00.000Z";

function ticketFixture(id, title, state, created, parent = "", depends = [], reporter = "Ada", type = "task", priority = "medium") {
  return { id, title, state, type, priority, parent, depends: depends.slice(), reporter, created };
}

function mountTicketPage() {
  const mounted = mountSheet();
  const nav = document.createElement("nav");
  nav.className = "files";
  mounted.root.parentElement.insertBefore(nav, mounted.root);
  mounted.nav = nav;
  return mounted;
}

function byClass(root, className) {
  return walkNodes(root, (node) => node.classList && node.classList.contains(className));
}

function filterBox(nav, name) {
  return walkNodes(nav, (node) => node.dataset && node.dataset.filter === name)[0];
}

function ticketNode(nav, id) {
  return byClass(nav, "md-ticket-node").find((node) => node.dataset && node.dataset.id === id);
}

function rootTicketIds(nav) {
  const tree = byClass(nav, "ticket-tree")[0];
  return byClass(tree, "md-ticket-node")
    .filter((node) => node.parentElement === tree)
    .map((node) => node.dataset.id);
}

function rowOf(nav, id) {
  const node = ticketNode(nav, id);
  return node && node.childNodes.find((child) => child.classList && child.classList.contains("md-ticket-row"));
}

function ticketSpans(nav, id) {
  const row = rowOf(nav, id);
  const open = row && row.childNodes.find((node) => node.tagName === "BUTTON" && node.classList.contains("md-ticket"));
  return open ? open.childNodes.filter((node) => node.tagName === "SPAN") : [];
}

test("T-ticket-rows", () => {
  const mounted = mountTicketPage();
  const css = readFileSync(new URL("../editor.css", import.meta.url), "utf8");
  const src = readFileSync(new URL("../src/editor.js", import.meta.url), "utf8");
  const rowRule = css.match(/\.ticket-tree \.md-ticket-row\s*\{[^}]*\}/);
  const titleRule = css.match(/\.ticket-tree \.md-ticket-title\s*\{[^}]*\}/);
  const stateRule = css.match(/\.ticket-tree \.md-ticket-state\s*\{[^}]*\}/);
  const inputs = css.match(/\.ticket-form input[\s\S]*?\{[^}]*\}/);
  assert.ok(rowRule);
  assert.match(rowRule[0], /white-space:\s*nowrap/);
  assert.match(rowRule[0], /overflow:\s*hidden/);
  assert.match(titleRule[0], /text-overflow:\s*ellipsis/);
  assert.match(titleRule[0], /overflow:\s*hidden/);
  assert.match(stateRule[0], /flex-shrink:\s*0/);
  assert.match(stateRule[0], /white-space:\s*nowrap/);
  assert.equal(/\.ticket-tree button\.md-ticket-expand::before\s*\{/.test(css), false);
  assert.equal(/clip-path:\s*polygon\(0 0, 100% 50%, 0 100%\)/.test(css), false);
  assert.equal(/clip-path:\s*polygon\(0 0, 100% 0, 50% 100%\)/.test(css), false);
  assert.match(src, /function iconButton\(action, className\)/);
  assert.match(src, /minus:\s*\["M5 12h14"\]/);
  assert.match(css, /nav\.files\s*\{[^}]*grid-column:\s*1/);
  assert.match(css, /nav\.files\s*\{[^}]*grid-row:\s*1\s*\/\s*span\s*2/);
  assert.match(css, /nav\.files\s*\{[^}]*display:\s*flex/);
  assert.match(css, /nav\.files\s*\{[^}]*flex-direction:\s*column/);
  assert.match(css, /nav\.files\s*\{[^}]*height:\s*100vh/);
  assert.equal(/overflow:\s*(?:hidden|auto|clip)/.test(css.match(/nav\.files\s*\{[^}]*\}/)[0]), false);
  assert.match(css, /div\.md-repo-row\s*\{[^}]*flex:\s*none/);
  assert.match(css, /\.file-block\s*\{[^}]*flex:\s*1 1 0/);
  assert.match(css, /\.file-block\s*\{[^}]*min-height:\s*0/);
  assert.match(css, /\.file-block\s*\{[^}]*overflow:\s*auto/);
  assert.match(css, /\.file-block\s*\{[^}]*margin-bottom:\s*0\.4rem/);
  assert.match(css, /\.ticket-block\s*\{[^}]*flex:\s*1 1 0/);
  assert.match(css, /\.ticket-block\s*\{[^}]*min-height:\s*0/);
  assert.match(css, /\.ticket-block\s*\{[^}]*position:\s*relative/);
  assert.match(css, /\.ticket-block\s*\{[^}]*overflow:\s*visible/);
  assert.equal(/0\.8rem/.test(css.match(/\.ticket-block\s*\{[^}]*\}/)[0]), false);
  const drawerRule = css.match(/\.md-ticket-drawer\s*\{[^}]*\}/)[0];
  assert.match(drawerRule, /position:\s*relative/);
  assert.match(drawerRule, /left:\s*0/);
  assert.match(drawerRule, /width:\s*100%/);
  assert.match(drawerRule, /background:\s*#1c1b19/);
  assert.equal(/position:\s*absolute/.test(drawerRule), false);
  assert.equal(/left:\s*100%/.test(drawerRule), false);
  assert.equal(/calc\(100vw - 16rem\)/.test(drawerRule), false);
  const wideRule = css.match(/\.md-ticket-wide\s*\{[^}]*\}/)[0];
  assert.match(wideRule, /position:\s*fixed/);
  assert.match(wideRule, /left:\s*0/);
  assert.match(wideRule, /width:\s*100vw/);
  assert.match(wideRule, /z-index:\s*4/);
  assert.match(wideRule, /transition:\s*width 0\.5s,\s*left 0\.5s/);
  assert.match(css, /\.ticket-tree \.md-ticket-row:hover\s*\{[^}]*background:\s*#2c3440/);
  assert.match(css, /\.md-ticket-drawer:not\(\.md-ticket-wide\)[^{]*\.ticket-tree \.md-ticket-row[^{]*\{[^}]*grid-template-columns:\s*1\.1em 8rem minmax\(0,\s*1fr\);/);
  assert.match(css, /\.md-ticket-drawer:not\(\.md-ticket-wide\)[^{]*button\.md-ticket[^{]*\{[^}]*grid-template-columns:\s*8rem minmax\(0,\s*1fr\);/);
  assert.match(css, /\.md-ticket-drawer:not\(\.md-ticket-wide\)[^{]*\.md-ticket-priority[^{]*\{[^}]*display:\s*none/);
  assert.match(css, /\.md-ticket-drawer:not\(\.md-ticket-wide\)[^{]*\.md-ticket-state[^{]*\{[^}]*display:\s*none/);
  assert.match(css, /\.md-ticket-drawer:not\(\.md-ticket-wide\)[^{]*\.md-ticket-type[^{]*\{[^}]*display:\s*none/);
  const sortButtonRule = css.match(/\.ticket-tree \.md-ticket-columns button\s*\{[^}]*\}/);
  assert.ok(sortButtonRule);
  assert.match(sortButtonRule[0], /font-weight:\s*bold/);
  assert.equal(/border:\s*0/.test(sortButtonRule[0]), false);
  assert.match(css, /\.ticket-tree\s*\{[^}]*height:\s*100%/);
  assert.match(css, /\.ticket-tree\s*\{[^}]*overflow:\s*auto/);
  assert.match(css, /\.ticket-tree\s*\{[^}]*scrollbar-gutter:\s*stable/);
  assert.match(css, /\.ticket-tree\s*\{[^}]*background:\s*#242320/);
  assert.match(css, /\.ticket-tree\s*\{[^}]*border:\s*1px solid #4a463f/);
  const gutterTracks = /grid-template-columns:\s*1\.1em 8rem minmax\(0,\s*1fr\) 5\.5rem 7\.5rem 8\.5rem/;
  const fieldTracks = /grid-template-columns:\s*8rem minmax\(0,\s*1fr\) 5\.5rem 7\.5rem 8\.5rem/;
  assert.match(css.match(/\.ticket-tree \.md-ticket-row\s*\{[^}]*\}/)[0], gutterTracks);
  assert.match(css.match(/\.ticket-tree \.md-ticket-row\s*\{[^}]*\}/)[0], /column-gap:\s*0\.75rem/);
  assert.match(css.match(/\.ticket-tree \.md-ticket-columns\s*\{[^}]*\}/)[0], gutterTracks);
  assert.match(css.match(/\.ticket-tree \.md-ticket-columns\s*\{[^}]*\}/)[0], /column-gap:\s*0\.75rem/);
  assert.match(css.match(/\.ticket-tree button\.md-ticket\s*\{[^}]*\}/)[0], fieldTracks);
  assert.match(css.match(/\.ticket-tree button\.md-ticket\s*\{[^}]*\}/)[0], /column-gap:\s*0\.75rem/);
  const idRule = css.match(/\.ticket-tree \.md-ticket-id,[\s\S]*?\{[^}]*\}/);
  assert.ok(idRule);
  assert.match(idRule[0], /\.md-ticket-priority/);
  assert.match(idRule[0], /\.md-ticket-state/);
  assert.match(idRule[0], /\.md-ticket-type/);
  assert.match(idRule[0], /min-width:\s*0/);
  assert.match(idRule[0], /overflow:\s*hidden/);
  assert.match(idRule[0], /text-overflow:\s*ellipsis/);
  assert.match(idRule[0], /white-space:\s*nowrap/);
  assert.match(css, /\.ticket-tree button\.md-ticket\s*\{[^}]*display:\s*grid/);
  assert.match(css, /\.md-ticket-columns\s*\{[^}]*position:\s*sticky/);
  assert.match(css, /\.md-ticket-current\s*\{[^}]*background:\s*#3d5a80/);
  assert.match(css.match(/\.editor\s*\{[^}]*\}/)[0], /min-height:\s*100vh/);
  assert.match(css, /aside\.comments\s*\{[^}]*grid-column:\s*3/);
  assert.match(css, /aside\.comments\s*\{[^}]*grid-row:\s*1\s*\/\s*span\s*2/);
  assert.match(css, /#editor\s*\{[^}]*grid-column:\s*2/);
  assert.match(css, /#editor\s*\{[^}]*grid-row:\s*1\s*\/\s*span\s*2/);
  assert.match(css, /\.ticket-form\s*\{[^}]*grid-column:\s*2/);
  assert.match(css, /\.ticket-form\s*\{[^}]*grid-row:\s*1/);
  assert.match(css, /\.ticket-form:not\(\[hidden\]\)\s*\+\s*#editor\s*\{[^}]*grid-row:\s*2/);
  assert.match(css, /@media \(max-width:\s*800px\)\s*\{[^]*\.sheet\s*\{[^}]*display:\s*block;/);
  assert.match(css, /@media \(max-width:\s*800px\)\s*\{[^]*\.md-ticket-drawer\s*\{[^}]*position:\s*static/);
  assert.match(css, /@media \(max-width:\s*800px\)\s*\{[^]*\.md-ticket-wide\s*\{[^}]*position:\s*static/);
  assert.match(css, /@media \(max-width:\s*800px\)\s*\{[^]*\.md-ticket-wide\s*\{[^}]*width:\s*auto/);
  assert.equal(/@media \(max-width:\s*800px\)\s*\{[^]*\.md-ticket-wide\s*\{[^}]*position:\s*fixed/.test(css), false);
  assert.match(css, /@media \(max-width:\s*800px\)\s*\{[^]*\.md-ticket-drawer\[hidden\]\s*\{[^}]*display:\s*block/);
  assert.match(css, /@media \(max-width:\s*800px\)\s*\{[^]*\.ticket-tree\s*\{[^}]*max-height:\s*50vh/);
  assert.match(css, /@media \(max-width:\s*800px\)\s*\{[^]*min-height:\s*40vh/);
  assert.match(inputs[0], /background:\s*#1c1b19/);
  assert.match(inputs[0], /border:\s*1px solid #4a463f/);
  assert.equal(css.includes("#3a3424"), false);
  assert.equal(/\.md-line\.md-raw\s*\{/.test(css), false);
  assert.equal(src.includes("innerHTML"), false);
  assert.equal(src.slice(src.indexOf("export function startPage")).includes("querySelector"), false);
  const transport = holdingTransport();
  try {
    const view = createEditor(mounted.root, "notes", 0, transport);
    assert.deepEqual(transport.sent.filter((message) => message.type === "tickets"), []);
    assert.equal(view.getState().doc, "notes");
    const sheet = mounted.root.parentElement;
    const form = byClass(sheet, "ticket-form")[0];
    assert.equal(form.hidden, true);
    assert.equal(sheet.childNodes.indexOf(form), sheet.childNodes.indexOf(mounted.root) - 1);
    const tree = byClass(mounted.nav, "file-tree")[0];
    const tickets = byClass(mounted.nav, "ticket-tree")[0];
    const block = byClass(mounted.nav, "ticket-block")[0];
    const fileBlock = byClass(mounted.nav, "file-block")[0];
    const head = byClass(block, "md-pane-head")[0];
    const heading = byClass(head, "md-pane-heading")[0];
    assert.equal(heading.tagName, "H2");
    assert.equal(heading.textContent, "Tickets");
    assert.equal(byClass(mounted.nav, "ticket-block").length, 1);
    assert.equal(byClass(mounted.nav, "ticket-tree").length, 1);
    assert.equal(byClass(mounted.nav, "md-ticket-label").length, 0);
    assert.equal(byClass(mounted.nav, "md-show-closed").length, 0);
    assert.equal(byClass(mounted.nav, "md-show-closed-label").length, 0);
    const drawer = byClass(block, "md-ticket-drawer")[0];
    const name = byClass(block, "md-new-ticket-name")[0];
    assert.equal(heading.parentElement, head);
    assert.equal(drawer.hidden, false);
    assert.equal(drawer.hasAttribute("hidden"), false);
    assert.equal(drawer.classList.contains("md-ticket-wide"), false);
    assert.equal(tickets.parentElement, drawer);
    assert.equal(drawer.parentElement, block);
    assert.equal(block.childNodes.indexOf(name) + 1, block.childNodes.indexOf(drawer));
    assert.equal(block.childNodes.at(-1), drawer);
    assert.equal(tree.parentElement, fileBlock);
    assert.equal(mounted.nav.childNodes.includes(head), false);
    assert.equal(mounted.nav.childNodes.includes(tickets), false);
    assert.equal(mounted.nav.childNodes[0].classList.contains("md-repo-row"), true);
    assert.ok(mounted.nav.childNodes.indexOf(fileBlock) < mounted.nav.childNodes.indexOf(block));
    assert.ok(block.childNodes.indexOf(head) < block.childNodes.indexOf(drawer));
    const columns = byClass(tickets, "md-ticket-columns")[0];
    assert.ok(columns);
    assert.equal(columns.classList.contains("md-ticket-node"), false);
    assert.deepEqual(
      columns.childNodes.filter((node) => node.textContent).map((node) => [node.tagName, node.textContent]),
      [
        ["BUTTON", "ID"],
        ["BUTTON", "Title"],
        ["BUTTON", "Priority"],
        ["BUTTON", "State"],
        ["BUTTON", "Type"],
      ],
    );
    for (const label of ["ID", "Title", "Priority", "State", "Type"]) {
      const button = columns.childNodes.find((node) => node.tagName === "BUTTON" && node.textContent === label);
      assert.equal(button.getAttribute("aria-label"), `Sort by ${label}`);
      assert.equal(button.type, "button");
      assert.equal(button.childNodes.some((node) => String(node.tagName || "").toLowerCase() === "svg"), false);
    }
    block.listeners.pointerenter();
    assert.equal(drawer.hidden, false);
    assert.equal(drawer.hasAttribute("hidden"), false);
    assert.equal(drawer.classList.contains("md-ticket-wide"), true);
    assert.equal(drawer.hasAttribute("hidden"), false);
    const plus = byClass(mounted.nav, "md-new-ticket")[0];
    assert.equal(plus.parentElement, head);
    assert.equal(head.childNodes[0], heading);
    assert.equal(plus.textContent, "");
    assert.equal(plus.getAttribute("aria-label"), "New ticket");
    assert.deepEqual(iconPaths(plus), ["M12 5v14M5 12h14"]);
    assert.equal(plus.type, "button");
    const list = [
      ticketFixture("cccccccc", "Cedar", "triaged", T2, "", [], "Ada", "bug"),
      ticketFixture("aaaaaaaa", "Alpha", "new", T0, "", [], "Ada", "enhancement"),
      ticketFixture("dddddddd", "Delta", "in progress", T0),
      ticketFixture("bbbbbbbb", "Bravo", "new", T1, "aaaaaaaa"),
      ticketFixture("eeeeeeee", "Echo", "new", T3, "aaaaaaaa"),
    ];
    transport.deliver({ type: "tickets", tickets: list });
    assert.equal(transport.sent.filter((message) => message.type === "tickets").length, 0);
    assert.equal(view.getState().doc, "notes");
    assert.deepEqual(rootTicketIds(mounted.nav), ["aaaaaaaa", "dddddddd", "cccccccc"]);
    for (const ticket of list) {
      const row = rowOf(mounted.nav, ticket.id);
      if (ticket.state === "new" && ticket.parent === "aaaaaaaa") {
        assert.equal(row, undefined);
        continue;
      }
      const spans = ticketSpans(mounted.nav, ticket.id);
      assert.deepEqual(spans.map((span) => span.className), [
        "md-ticket-id",
        "md-ticket-title",
        "md-ticket-priority",
        "md-ticket-state",
        "md-ticket-type",
      ]);
      assert.deepEqual(spans.map((span) => span.textContent), [
        ticket.id,
        ticket.title,
        ticket.priority,
        ticket.state,
        ticket.type,
      ]);
      assert.equal(row.textContent.includes(ticket.title), true);
      assert.equal(row.textContent.includes(ticket.state), true);
    }
    const alpha = ticketNode(mounted.nav, "aaaaaaaa");
    const expand = byClass(alpha, "md-ticket-expand")[0];
    assert.equal(expand.textContent, "");
    assert.equal(expand.tagName, "BUTTON");
    assert.equal(expand.getAttribute("aria-label"), "expand");
    assert.deepEqual(iconPaths(expand), ["M9 6l6 6-6 6"]);
    assert.equal(byClass(ticketNode(mounted.nav, "dddddddd"), "md-ticket-expand").length, 0);
    const before = transport.sent.length;
    expand.listeners.click({ preventDefault() {}, stopPropagation() {} });
    assert.equal(transport.sent.length, before);
    const opened = byClass(ticketNode(mounted.nav, "aaaaaaaa"), "md-ticket-expand")[0];
    assert.equal(opened.getAttribute("aria-label"), "collapse");
    assert.deepEqual(iconPaths(opened), ["M6 9l6 6 6-6"]);
    assert.equal(opened.classList.contains("md-ticket-expanded"), true);
    const nest = byClass(ticketNode(mounted.nav, "aaaaaaaa"), "md-ticket-children")[0];
    assert.deepEqual(
      nest.childNodes.filter((node) => node.classList.contains("md-ticket-node")).map((node) => node.dataset.id),
      ["bbbbbbbb", "eeeeeeee"],
    );
    assert.deepEqual(ticketSpans(mounted.nav, "aaaaaaaa").map((span) => span.textContent), [
      "aaaaaaaa",
      "Alpha",
      "medium",
      "new",
      "enhancement",
    ]);
    assert.equal(ticketSpans(mounted.nav, "cccccccc").find((span) => span.classList.contains("md-ticket-type")).textContent, "bug");
    assert.deepEqual(ticketSpans(mounted.nav, "bbbbbbbb").map((span) => span.textContent), [
      "bbbbbbbb",
      "Bravo",
      "medium",
      "new",
      "task",
    ]);
    const open = byClass(ticketNode(mounted.nav, "bbbbbbbb"), "md-ticket").find((node) => node.tagName === "BUTTON");
    open.listeners.click({ preventDefault() {} });
    assert.deepEqual(transport.sent.at(-1), { type: "open", path: "tickets/bbbbbbbb.md", rev: 0, username: "" });
    assert.equal(drawer.hidden, false);
    assert.equal(drawer.classList.contains("md-ticket-wide"), true);
    view.destroy();
    assert.equal(plus.listeners.click, undefined);
  } finally {
    mounted.restore();
  }
});

test("T-ticket-drawer", () => {
  const mounted = mountTicketPage();
  const transport = holdingTransport();
  const pending = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms) => {
    const handle = { fn, ms };
    pending.push(handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    const index = pending.indexOf(handle);
    if (index >= 0) pending.splice(index, 1);
  };
  try {
    const view = createEditor(mounted.root, "x", 0, transport);
    const alpha = ticketFixture("aaaaaaaa", "Alpha", "new", T1, "", [], "Ada", "task", "low");
    const bravo = ticketFixture("bbbbbbbb", "Bravo", "new", T0, "", [], "Ada", "task", "high");
    const zed = ticketFixture("dddddddd", "Zed", "new", T0, "bbbbbbbb");
    const ann = ticketFixture("eeeeeeee", "Ann", "new", T2, "bbbbbbbb");
    transport.deliver({ type: "tickets", tickets: [alpha, bravo, zed, ann] });
    const block = byClass(mounted.nav, "ticket-block")[0];
    const drawer = byClass(block, "md-ticket-drawer")[0];
    const css = readFileSync(new URL("../editor.css", import.meta.url), "utf8");
    assert.equal(drawer.hidden, false);
    assert.equal(drawer.hasAttribute("hidden"), false);
    assert.equal(drawer.classList.contains("md-ticket-wide"), false);
    assert.match(css, /\.md-ticket-drawer:not\(\.md-ticket-wide\)[^{]*\.md-ticket-priority[^{]*\{[^}]*display:\s*none/);
    assert.deepEqual(rootTicketIds(mounted.nav), ["bbbbbbbb", "aaaaaaaa"]);
    block.listeners.pointerenter();
    assert.equal(drawer.hidden, false);
    assert.equal(drawer.classList.contains("md-ticket-wide"), true);
    const columns = byClass(mounted.nav, "md-ticket-columns")[0];
    const heading = (label) => columns.childNodes.find((node) => node.tagName === "BUTTON" && node.textContent === label);
    const svgOf = (button) => button && button.childNodes.find((node) => String(node.tagName || "").toLowerCase() === "svg");
    const pathOf = (button) => {
      const svg = svgOf(button);
      return svg && svg.childNodes.find((node) => String(node.tagName || "").toLowerCase() === "path");
    };
    const title = heading("Title");
    const idHead = heading("ID");
    for (const label of ["ID", "Title", "Priority", "State", "Type"]) {
      assert.equal(heading(label).getAttribute("aria-label"), `Sort by ${label}`);
    }
    const expand = byClass(ticketNode(mounted.nav, "bbbbbbbb"), "md-ticket-expand")[0];
    expand.listeners.click({ preventDefault() {}, stopPropagation() {} });
    const childIds = () => {
      const nest = byClass(ticketNode(mounted.nav, "bbbbbbbb"), "md-ticket-children")[0];
      return nest.childNodes.filter((node) => node.classList.contains("md-ticket-node")).map((node) => node.dataset.id);
    };
    assert.deepEqual(childIds(), ["dddddddd", "eeeeeeee"]);
    title.listeners.click({ preventDefault() {} });
    assert.deepEqual(rootTicketIds(mounted.nav), ["aaaaaaaa", "bbbbbbbb"]);
    assert.deepEqual(childIds(), ["eeeeeeee", "dddddddd"]);
    const asc = pathOf(title);
    assert.equal(svgOf(title).getAttribute("viewBox"), "0 0 24 24");
    assert.equal(svgOf(title).getAttribute("aria-hidden"), "true");
    assert.equal(asc.getAttribute("fill"), "none");
    assert.equal(asc.getAttribute("stroke"), "currentColor");
    assert.equal(asc.getAttribute("stroke-width"), "2");
    assert.equal(asc.getAttribute("stroke-linecap"), "round");
    assert.equal(asc.getAttribute("stroke-linejoin"), "round");
    assert.equal(asc.getAttribute("d"), "M12 19V5M5 12l7-7 7 7");
    assert.equal(svgOf(idHead), undefined);
    title.listeners.click({ preventDefault() {} });
    assert.deepEqual(rootTicketIds(mounted.nav), ["bbbbbbbb", "aaaaaaaa"]);
    assert.deepEqual(childIds(), ["dddddddd", "eeeeeeee"]);
    assert.equal(pathOf(title).getAttribute("d"), "M12 5v14M19 12l-7 7-7-7");
    title.listeners.click({ preventDefault() {} });
    assert.deepEqual(rootTicketIds(mounted.nav), ["bbbbbbbb", "aaaaaaaa"]);
    assert.deepEqual(childIds(), ["dddddddd", "eeeeeeee"]);
    assert.equal(svgOf(title), undefined);
    idHead.listeners.click({ preventDefault() {} });
    assert.deepEqual(rootTicketIds(mounted.nav), ["aaaaaaaa", "bbbbbbbb"]);
    assert.ok(svgOf(idHead));
    assert.equal(svgOf(title), undefined);
    assert.equal(svgOf(heading("Priority")), undefined);
    assert.equal(svgOf(heading("State")), undefined);
    assert.equal(svgOf(heading("Type")), undefined);
    heading("Priority").listeners.click({ preventDefault() {} });
    assert.deepEqual(rootTicketIds(mounted.nav), ["bbbbbbbb", "aaaaaaaa"]);
    assert.equal(svgOf(idHead), undefined);
    assert.equal(pathOf(heading("Priority")).getAttribute("d"), "M12 19V5M5 12l7-7 7 7");
    heading("Priority").listeners.click({ preventDefault() {} });
    heading("Priority").listeners.click({ preventDefault() {} });
    assert.equal(svgOf(heading("Priority")), undefined);
    const alphaRow = rowOf(mounted.nav, "aaaaaaaa");
    const bravoRow = rowOf(mounted.nav, "bbbbbbbb");
    const alphaOpen = byClass(alphaRow, "md-ticket").find((node) => node.tagName === "BUTTON");
    alphaOpen.listeners.click({ preventDefault() {} });
    assert.equal(rowOf(mounted.nav, "aaaaaaaa"), alphaRow);
    assert.equal(alphaRow.classList.contains("md-ticket-current"), true);
    assert.equal(bravoRow.classList.contains("md-ticket-current"), false);
    assert.equal(drawer.hidden, false);
    const bravoOpen = byClass(bravoRow, "md-ticket").find((node) => node.tagName === "BUTTON");
    bravoOpen.listeners.click({ preventDefault() {} });
    assert.equal(rowOf(mounted.nav, "bbbbbbbb"), bravoRow);
    assert.equal(rowOf(mounted.nav, "aaaaaaaa"), alphaRow);
    assert.equal(bravoRow.classList.contains("md-ticket-current"), true);
    assert.equal(alphaRow.classList.contains("md-ticket-current"), false);
    assert.equal(drawer.hidden, false);
    block.listeners.pointerleave();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].ms, 200);
    assert.equal(drawer.hidden, false);
    assert.equal(drawer.classList.contains("md-ticket-wide"), true);
    block.listeners.pointerenter();
    assert.equal(pending.length, 0);
    assert.equal(drawer.hidden, false);
    assert.equal(drawer.classList.contains("md-ticket-wide"), true);
    block.listeners.pointerleave();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].ms, 200);
    const hide = pending.pop();
    hide.fn();
    assert.equal(drawer.hidden, false);
    assert.equal(drawer.hasAttribute("hidden"), false);
    assert.equal(drawer.classList.contains("md-ticket-wide"), false);
    block.listeners.pointerenter();
    assert.equal(drawer.hidden, false);
    assert.equal(drawer.classList.contains("md-ticket-wide"), true);
    block.listeners.pointerleave();
    assert.equal(pending.length, 1);
    bravoOpen.listeners.click({ preventDefault() {} });
    assert.equal(pending.length, 0);
    assert.equal(drawer.hidden, false);
    assert.equal(drawer.classList.contains("md-ticket-wide"), true);
    assert.equal(bravoRow.classList.contains("md-ticket-current"), true);
    block.listeners.pointerleave();
    assert.equal(pending.length, 1);
    view.destroy();
    assert.equal(pending.length, 0);
    assert.equal(drawer.hidden, false);
    assert.equal(block.listeners.pointerenter, undefined);
    assert.equal(block.listeners.pointerleave, undefined);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    mounted.restore();
  }
});

test("T-ticket-closed", () => {
  const mounted = mountTicketPage();
  const transport = holdingTransport();
  try {
    const view = createEditor(mounted.root, "x", 0, transport);
    const alpha = ticketFixture("aaaaaaaa", "Alpha", "new", T0);
    const bravo = ticketFixture("bbbbbbbb", "Bravo", "closed", T1);
    const cedar = ticketFixture("cccccccc", "Cedar", "closed", T2, "aaaaaaaa");
    const delta = ticketFixture("dddddddd", "Delta", "closed", T3, "", [], "Ada");
    transport.deliver({ type: "tickets", tickets: [cedar, alpha, bravo, delta] });
    transport.deliver({
      type: "file",
      path: "tickets/dddddddd.md",
      rev: 2,
      text: "open closed\n",
      cursor: 0,
      anchor: 0,
      locks: [],
      ticket: delta,
    });
    assert.equal(ticketNode(mounted.nav, "bbbbbbbb"), undefined);
    assert.equal(ticketNode(mounted.nav, "cccccccc"), undefined);
    assert.equal(ticketNode(mounted.nav, "dddddddd"), undefined);
    assert.equal(byClass(ticketNode(mounted.nav, "aaaaaaaa"), "md-ticket-expand").length, 0);
    const box = filterBox(mounted.nav, "closed");
    assert.equal(box.checked, false);
    const before = transport.sent.length;
    box.checked = true;
    box.listeners.change();
    assert.equal(transport.sent.length, before);
    assert.ok(ticketNode(mounted.nav, "bbbbbbbb"));
    assert.ok(ticketNode(mounted.nav, "dddddddd"));
    assert.equal(rowOf(mounted.nav, "dddddddd").textContent.includes("Delta"), true);
    assert.equal(rowOf(mounted.nav, "dddddddd").textContent.includes("closed"), true);
    assert.equal(rowOf(mounted.nav, "bbbbbbbb").textContent.includes("bbbbbbbb"), true);
    assert.equal(rowOf(mounted.nav, "bbbbbbbb").textContent.includes("Bravo"), true);
    const expand = byClass(ticketNode(mounted.nav, "aaaaaaaa"), "md-ticket-expand")[0];
    assert.equal(expand.textContent, "");
    expand.listeners.click({ preventDefault() {} });
    assert.equal(ticketNode(mounted.nav, "cccccccc").parentElement.classList.contains("md-ticket-children"), true);
    assert.equal(ticketNode(mounted.nav, "aaaaaaaa").parentElement.classList.contains("ticket-tree"), true);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("T-ticket-orphan", () => {
  const mounted = mountTicketPage();
  const transport = holdingTransport();
  try {
    const view = createEditor(mounted.root, "x", 0, transport);
    const alpha = ticketFixture("aaaaaaaa", "Alpha", "closed", T0);
    const bravo = ticketFixture("bbbbbbbb", "Bravo", "new", T1, "aaaaaaaa");
    transport.deliver({ type: "tickets", tickets: [alpha, bravo] });
    transport.deliver({
      type: "file",
      path: "tickets/bbbbbbbb.md",
      rev: 1,
      text: "child\n",
      cursor: 0,
      anchor: 0,
      locks: [],
      ticket: bravo,
    });
    assert.equal(ticketNode(mounted.nav, "aaaaaaaa"), undefined);
    assert.equal(ticketNode(mounted.nav, "bbbbbbbb").parentElement.classList.contains("ticket-tree"), true);
    const box = filterBox(mounted.nav, "closed");
    box.checked = true;
    box.listeners.change();
    assert.equal(ticketNode(mounted.nav, "aaaaaaaa").parentElement.classList.contains("ticket-tree"), true);
    assert.equal(ticketNode(mounted.nav, "bbbbbbbb").parentElement.classList.contains("md-ticket-children"), true);
    assert.equal(byClass(ticketNode(mounted.nav, "aaaaaaaa"), "md-ticket-expand")[0].textContent, "");
    box.checked = false;
    box.listeners.change();
    assert.equal(ticketNode(mounted.nav, "aaaaaaaa"), undefined);
    assert.equal(ticketNode(mounted.nav, "bbbbbbbb").parentElement.classList.contains("ticket-tree"), true);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("T-pane-head", () => {
  const mounted = mountTicketPage();
  const css = readFileSync(new URL("../editor.css", import.meta.url), "utf8");
  const headRule = css.match(/\.md-pane-head\s*\{[^}]*\}/);
  const headingRule = css.match(/h2\.md-pane-heading\s*\{[^}]*\}/);
  const blockRule = css.match(/\.file-block\s*\{[^}]*\}/);
  const filterRule = css.match(/button\.md-ticket-filter\s*\{[^}]*\}/);
  const allRule = css.match(/button\.md-ticket-filter-all\s*\{[^}]*\}/);
  const treeRule = css.match(/\.file-tree\s*\{[^}]*\}/);
  assert.ok(headRule);
  assert.ok(headingRule);
  assert.ok(blockRule);
  assert.ok(filterRule);
  assert.ok(allRule);
  assert.ok(treeRule);
  assert.match(headRule[0], /display:\s*flex/);
  assert.match(headRule[0], /align-items:\s*center/);
  assert.match(headRule[0], /justify-content:\s*space-between/);
  assert.match(headingRule[0], /margin:\s*0/);
  assert.match(headingRule[0], /font:\s*inherit/);
  assert.match(headingRule[0], /font-weight:\s*700/);
  assert.match(blockRule[0], /border:\s*1px solid #4a463f/);
  assert.match(blockRule[0], /padding:\s*0\.4rem/);
  assert.match(blockRule[0], /margin-bottom:\s*0\.4rem/);
  assert.equal(/margin:\s*0 0 0\.8rem/.test(blockRule[0]), false);
  assert.match(filterRule[0], /display:\s*block/);
  assert.match(filterRule[0], /width:\s*100%/);
  assert.match(filterRule[0], /box-sizing:\s*border-box/);
  assert.match(filterRule[0], /background:\s*#1c1b19/);
  assert.match(filterRule[0], /border:\s*1px solid #4a463f/);
  assert.match(filterRule[0], /color:\s*inherit/);
  assert.match(filterRule[0], /font:\s*inherit/);
  assert.match(filterRule[0], /text-align:\s*left/);
  assert.match(filterRule[0], /padding:\s*0\.15rem 0\.35rem/);
  assert.match(filterRule[0], /margin:\s*0 0 0\.45rem/);
  assert.match(allRule[0], /border:\s*1px solid #c4b8a4/);
  assert.match(allRule[0], /border-radius:\s*0\.35rem/);
  assert.match(allRule[0], /background:\s*none/);
  assert.match(allRule[0], /font:\s*inherit/);
  assert.equal(/button\.md-ticket-filter-all\s*\{[^}]*width:\s*100%/.test(css), false);
  assert.match(treeRule[0], /padding:\s*0\.4rem 0/);
  assert.equal(/border:/.test(treeRule[0]), false);
  const transport = holdingTransport();
  try {
    const view = createEditor(mounted.root, "x", 0, transport);
    assert.equal(mounted.nav.childNodes[0].classList.contains("md-repo-row"), true);
    const fileBlock = byClass(mounted.nav, "file-block")[0];
    const ticketBlock = byClass(mounted.nav, "ticket-block")[0];
    const tree = byClass(mounted.nav, "file-tree")[0];
    assert.equal(mounted.nav.childNodes[1], fileBlock);
    assert.equal(tree.parentElement, fileBlock);
    assert.equal(fileBlock.parentElement, mounted.nav);
    const heads = byClass(mounted.nav, "md-pane-head");
    assert.equal(heads.length, 2);
    const filesHead = heads.find((head) => head.parentElement === fileBlock);
    const ticketsHead = heads.find((head) => head.parentElement === ticketBlock);
    const filesHeading = filesHead.childNodes[0];
    const ticketsHeading = ticketsHead.childNodes[0];
    assert.equal(filesHeading.tagName, "H2");
    assert.equal(filesHeading.classList.contains("md-pane-heading"), true);
    assert.equal(filesHeading.textContent, "Files");
    assert.equal(filesHead.childNodes[1].classList.contains("md-new-file"), true);
    assert.equal(filesHead.childNodes[1].textContent, "");
    assert.equal(filesHead.childNodes[1].getAttribute("aria-label"), "New file");
    assert.equal(ticketsHeading.tagName, "H2");
    assert.equal(ticketsHeading.classList.contains("md-pane-heading"), true);
    assert.equal(ticketsHeading.textContent, "Tickets");
    assert.equal(ticketsHead.childNodes[1].classList.contains("md-new-ticket"), true);
    assert.equal(ticketsHead.childNodes[1].textContent, "");
    assert.equal(ticketsHead.childNodes[1].getAttribute("aria-label"), "New ticket");
    const name = byClass(fileBlock, "md-new-name")[0];
    assert.ok(fileBlock.childNodes.indexOf(filesHead) < fileBlock.childNodes.indexOf(name));
    assert.ok(fileBlock.childNodes.indexOf(name) < fileBlock.childNodes.indexOf(tree));
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("T-ticket-filter", () => {
  const mounted = mountTicketPage();
  const transport = holdingTransport();
  try {
    const view = createEditor(mounted.root, "x", 0, transport);
    const low = ticketFixture("aaaaaaaa", "Low", "new", T0, "", [], "Ada", "task", "low");
    const med = ticketFixture("bbbbbbbb", "Med", "new", T1, "", [], "Ada", "task", "medium");
    const bug = ticketFixture("cccccccc", "Bug", "new", T2, "", [], "Ada", "bug", "high");
    const child = ticketFixture("dddddddd", "Enhance", "new", T3, "cccccccc", [], "Ada", "enhancement", "medium");
    const done = ticketFixture("eeeeeeee", "Done", "closed", T0, "", [], "Ada", "task", "high");
    transport.deliver({ type: "tickets", tickets: [low, med, bug, child, done] });
    transport.deliver({
      type: "file",
      path: "tickets/eeeeeeee.md",
      rev: 1,
      text: "done\n",
      cursor: 0,
      anchor: 0,
      locks: [],
      ticket: done,
    });
    assert.equal(ticketNode(mounted.nav, "eeeeeeee"), undefined);
    assert.equal(view.getState().doc, "done\n");
    const filter = byClass(mounted.nav, "md-ticket-filter")[0];
    const menu = byClass(mounted.nav, "md-ticket-filter-menu")[0];
    const name = byClass(mounted.nav, "md-new-ticket-name")[0];
    const tickets = byClass(mounted.nav, "ticket-tree")[0];
    const block = byClass(mounted.nav, "ticket-block")[0];
    assert.equal(filter.textContent, "Filter");
    assert.equal(filter.type, "button");
    assert.equal(filter.parentElement, block);
    assert.equal(menu.hidden, true);
    assert.equal(menu.hasAttribute("hidden"), true);
    assert.ok(block.childNodes.indexOf(filter) < block.childNodes.indexOf(menu));
    assert.ok(block.childNodes.indexOf(menu) < block.childNodes.indexOf(name));
    const drawer = byClass(block, "md-ticket-drawer")[0];
    assert.equal(tickets.parentElement, drawer);
    assert.ok(block.childNodes.indexOf(name) < block.childNodes.indexOf(drawer));
    const labels = menu.childNodes.filter((node) => node.tagName === "LABEL");
    assert.deepEqual(labels.map((label) => label.textContent), ["closed", "low", "medium", "high", "task", "enhancement", "defect"]);
    assert.deepEqual(
      labels.map((label) => label.childNodes.find((node) => node.tagName === "INPUT").dataset.filter),
      ["closed", "low", "medium", "high", "task", "enhancement", "bug"],
    );
    const box = (key) => filterBox(menu, key);
    assert.equal(box("closed").checked, false);
    for (const key of ["low", "medium", "high", "task", "enhancement", "bug"]) assert.equal(box(key).checked, true);
    const beforeOpen = transport.sent.length;
    filter.listeners.click({ preventDefault() {} });
    assert.equal(transport.sent.length, beforeOpen);
    assert.equal(menu.hidden, false);
    byClass(ticketNode(mounted.nav, "cccccccc"), "md-ticket-expand")[0].listeners.click({ preventDefault() {}, stopPropagation() {} });
    assert.equal(ticketNode(mounted.nav, "dddddddd").parentElement.classList.contains("md-ticket-children"), true);
    const beforeLow = transport.sent.length;
    box("low").checked = false;
    box("low").listeners.change();
    assert.equal(transport.sent.length, beforeLow);
    assert.equal(menu.hidden, false);
    assert.equal(ticketNode(mounted.nav, "aaaaaaaa"), undefined);
    assert.ok(ticketNode(mounted.nav, "bbbbbbbb"));
    box("bug").checked = false;
    box("bug").listeners.change();
    assert.equal(menu.hidden, false);
    assert.equal(ticketNode(mounted.nav, "cccccccc"), undefined);
    assert.equal(ticketNode(mounted.nav, "dddddddd").parentElement.classList.contains("ticket-tree"), true);
    assert.equal(ticketNode(mounted.nav, "eeeeeeee"), undefined);
    const all = byClass(menu, "md-ticket-filter-all")[0];
    assert.equal(all.textContent, "show all");
    const beforeAll = transport.sent.length;
    all.listeners.click({ preventDefault() {} });
    assert.equal(transport.sent.length, beforeAll);
    assert.equal(menu.hidden, false);
    for (const key of ["closed", "low", "medium", "high", "task", "enhancement", "bug"]) assert.equal(box(key).checked, true);
    assert.ok(ticketNode(mounted.nav, "aaaaaaaa"));
    assert.ok(ticketNode(mounted.nav, "bbbbbbbb"));
    assert.ok(ticketNode(mounted.nav, "cccccccc"));
    assert.equal(ticketNode(mounted.nav, "dddddddd").parentElement.classList.contains("md-ticket-children"), true);
    assert.ok(ticketNode(mounted.nav, "eeeeeeee"));
    box("closed").checked = false;
    box("closed").listeners.change();
    assert.equal(ticketNode(mounted.nav, "eeeeeeee"), undefined);
    assert.equal(view.getState().doc, "done\n");
    const beforeClosed = transport.sent.length;
    box("closed").checked = true;
    box("closed").listeners.change();
    assert.equal(transport.sent.length, beforeClosed);
    assert.ok(ticketNode(mounted.nav, "eeeeeeee"));
    assert.equal(menu.hidden, false);
    view.destroy();
    assert.equal(filter.listeners.click, undefined);
    assert.equal(box("low").listeners.change, undefined);
    assert.equal(all.listeners.click, undefined);
  } finally {
    mounted.restore();
  }
});

test("T-ticket-create", () => {
  const mounted = mountTicketPage();
  const transport = holdingTransport();
  try {
    const view = createEditor(mounted.root, "x", 0, transport);
    const button = byClass(mounted.nav, "md-new-ticket")[0];
    const field = byClass(mounted.nav, "md-new-ticket-name")[0];
    assert.equal(field.hidden, true);
    button.listeners.click({ preventDefault() {} });
    assert.equal(field.hidden, false);
    assert.equal(field.focused, true);
    field.value = "  File the bug  ";
    field.listeners.keydown({ key: "Enter", preventDefault() {} });
    const created = transport.sent.at(-1);
    assert.equal(created.type, "ticket.create");
    assert.equal(created.title, "File the bug");
    assert.equal(Object.hasOwn(created, "priority"), false);
    assert.equal("path" in created, false);
    assert.equal(created.rev, undefined);
    assert.equal(field.hidden, true);
    button.listeners.click({ preventDefault() {} });
    field.value = "   ";
    const afterBlank = transport.sent.length;
    field.listeners.keydown({ key: "Enter", preventDefault() {} });
    assert.equal(transport.sent.length, afterBlank);
    assert.equal(field.hidden, false);
    assert.equal(field.value, "   ");
    field.listeners.keydown({ key: "Escape", preventDefault() {} });
    assert.equal(transport.sent.length, afterBlank);
    assert.equal(field.hidden, true);
    assert.equal(field.value, "");
    view.destroy();
    assert.equal(button.listeners.click, undefined);
    const again = createEditor(mounted.root, "x", 0, transport);
    assert.equal(byClass(mounted.nav, "md-new-ticket").length, 1);
    again.destroy();
  } finally {
    mounted.restore();
  }
});

test("T-ticket-title", () => {
  const mounted = mountTicketPage();
  const transport = holdingTransport();
  try {
    const view = createEditor(mounted.root, "x", 0, transport);
    const alpha = ticketFixture("aaaaaaaa", "Alpha", "new", T0);
    transport.deliver({ type: "tickets", tickets: [alpha] });
    transport.deliver({
      type: "file",
      path: "tickets/aaaaaaaa.md",
      rev: 4,
      text: "hello\n",
      cursor: 0,
      anchor: 0,
      locks: [],
      ticket: alpha,
    });
    const form = byClass(mounted.root.parentElement, "ticket-form")[0];
    assert.equal(form.hidden, false);
    const heading = () => byClass(form, "md-ticket-heading")[0];
    const input = () => byClass(form, "md-ticket-title-input")[0];
    assert.equal(heading().textContent, "Alpha");
    assert.equal(input().hidden, true);
    const sets = () => transport.sent.filter((message) => message.type === "ticket.set");
    heading().listeners.click();
    assert.equal(input().hidden, false);
    input().value = "Nope";
    input().listeners.keydown({ key: "Escape", preventDefault() {} });
    assert.equal(sets().length, 0);
    assert.equal(heading().textContent, "Alpha");
    assert.equal(input().hidden, true);
    heading().listeners.click();
    input().value = "bad\ttitle";
    input().listeners.blur();
    assert.equal(sets().length, 0);
    assert.equal(heading().textContent, "Alpha");
    heading().listeners.click();
    input().value = "   ";
    input().listeners.blur();
    assert.equal(sets().length, 0);
    assert.equal(heading().textContent, "Alpha");
    heading().listeners.click();
    input().value = "  Alpha  ";
    input().listeners.blur();
    assert.equal(sets().length, 0);
    heading().listeners.click();
    input().value = "  Beta  ";
    input().listeners.blur();
    assert.deepEqual(sets().at(-1), {
      type: "ticket.set",
      path: "tickets/aaaaaaaa.md",
      rev: 4,
      title: "Beta",
      username: "",
    });
    assert.equal(sets().length, 1);
    assert.equal(view.getState().doc, "hello\n");
    assert.equal(mounted.root.textContent.includes("hello"), true);
    heading().listeners.click();
    input().value = "Beta";
    input().listeners.blur();
    assert.equal(sets().length, 1);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("T-ticket-fields", () => {
  const mounted = mountTicketPage();
  const transport = holdingTransport();
  try {
    const view = createEditor(mounted.root, "x", 0, transport);
    const alpha = ticketFixture("aaaaaaaa", "Alpha", "new", T0, "bbbbbbbb", ["bbbbbbbb"]);
    const bravo = ticketFixture("bbbbbbbb", "Bravo", "triaged", T1);
    const cedar = ticketFixture("cccccccc", "Cedar", "closed", T2);
    transport.deliver({ type: "tickets", tickets: [cedar, bravo, alpha] });
    transport.deliver({
      type: "file",
      path: "tickets/aaaaaaaa.md",
      rev: 6,
      text: "hello\nnext\n",
      cursor: 0,
      anchor: 0,
      locks: [],
      ticket: alpha,
    });
    const form = byClass(mounted.root.parentElement, "ticket-form")[0];
    const state = () => byClass(form, "md-ticket-state")[0];
    const parent = () => byClass(form, "md-ticket-parent")[0];
    const dependRow = (id) => byClass(byClass(form, "md-ticket-depends")[0], "md-ticket-link").find((node) => node.dataset.id === id);
    assert.deepEqual(
      state().childNodes.map((option) => option.textContent),
      ["new", "triaged", "in progress", "closed"],
    );
    assert.deepEqual(
      state().childNodes.map((option) => option.value),
      ["new", "triaged", "in progress", "closed"],
    );
    assert.equal(byClass(parent(), "md-ticket-parent-value")[0].textContent, "Bravo");
    assert.equal(dependRow("bbbbbbbb").textContent, "Bravo");
    assert.equal(dependRow("cccccccc"), undefined);
    assert.equal(byClass(form, "md-ticket-reporter")[0].textContent, "Ada");
    assert.equal(byClass(form, "md-ticket-reporter")[0].tagName, "DIV");
    assert.equal(byClass(form, "md-ticket-created")[0].textContent, T0);
    const sets = () => transport.sent.filter((message) => message.type === "ticket.set");
    state().value = "triaged";
    state().listeners.change();
    assert.equal(sets().length, 1);
    const text = mounted.root.childNodes[1].childNodes[0].childNodes[0];
    assert.equal(text.textContent, "next");
    document.caretPositionFromPoint = () => ({ offsetNode: text, offset: 1 });
    mounted.listeners.click({ target: text, clientX: 1, clientY: 1, preventDefault() {} });
    assert.equal(view.getState().cursor, 7);
    const beforeReject = transport.sent.length;
    transport.deliver({ type: "error", status: 409 });
    assert.equal(transport.sent.length, beforeReject);
    assert.equal(view.getState().cursor, 7);
    assert.equal(view.getState().doc, "hello\nnext\n");
    assert.equal(state().value, "new");
    assert.equal(byClass(parent(), "md-ticket-parent-value")[0].textContent, "Bravo");
    assert.equal(dependRow("cccccccc"), undefined);
    state().value = "new";
    state().listeners.change();
    assert.equal(sets().length, 1);
    state().value = "in progress";
    state().listeners.change();
    byClass(parent(), "md-ticket-remove")[0].listeners.click({ preventDefault() {} });
    const depends = byClass(form, "md-ticket-depends")[0];
    const dependMatch = byClass(depends, "md-ticket-match")[0];
    dependMatch.value = "ce";
    dependMatch.listeners.input();
    assert.equal(dependMatch.value, "Cedar");
    assert.equal(dependMatch.selectionStart, 2);
    assert.equal(dependMatch.selectionEnd, "Cedar".length);
    byClass(depends, "md-ticket-add")[0].listeners.click({ preventDefault() {} });
    assert.deepEqual(sets().slice(1), [
      { type: "ticket.set", path: "tickets/aaaaaaaa.md", rev: 6, state: "in progress", username: "" },
      { type: "ticket.set", path: "tickets/aaaaaaaa.md", rev: 6, parent: "", username: "" },
      { type: "ticket.set", path: "tickets/aaaaaaaa.md", rev: 6, depends: ["bbbbbbbb", "cccccccc"], username: "" },
    ]);
    assert.equal(sets().every((message) => message.reporter === undefined && message.created === undefined), true);
    const typeSelect = () => byClass(form, "md-ticket-type")[0];
    assert.deepEqual(typeSelect().childNodes.map((option) => option.textContent), ["bug", "enhancement", "task"]);
    assert.deepEqual(typeSelect().childNodes.map((option) => option.value), ["bug", "enhancement", "task"]);
    assert.equal(typeSelect().value, "task");
    assert.equal(typeSelect().parentElement.childNodes[0].textContent, "Type");
    const fieldColumn = () => state().parentElement.parentElement;
    assert.equal(fieldColumn().childNodes.indexOf(typeSelect().parentElement), fieldColumn().childNodes.indexOf(state().parentElement) + 1);
    assert.ok(fieldColumn().childNodes.indexOf(typeSelect().parentElement) < fieldColumn().childNodes.indexOf(parent()));
    const beforeType = sets().length;
    typeSelect().value = "task";
    typeSelect().listeners.change();
    assert.equal(sets().length, beforeType);
    typeSelect().value = "bug";
    typeSelect().listeners.change();
    assert.deepEqual(sets().at(-1), {
      type: "ticket.set",
      path: "tickets/aaaaaaaa.md",
      rev: 6,
      ticketType: "bug",
      username: "",
    });
    assert.equal(rowOf(mounted.nav, "aaaaaaaa").textContent.includes("bug"), false);
    transport.deliver({ type: "error", status: 400 });
    assert.equal(view.getState().cursor, 7);
    assert.equal(state().value, "new");
    assert.equal(typeSelect().value, "task");
    const prioritySelect = () => byClass(form, "md-ticket-priority")[0];
    assert.deepEqual(prioritySelect().childNodes.map((option) => option.textContent), ["low", "medium", "high"]);
    assert.deepEqual(prioritySelect().childNodes.map((option) => option.value), ["low", "medium", "high"]);
    assert.equal(prioritySelect().value, "medium");
    assert.equal(prioritySelect().parentElement.childNodes[0].textContent, "Priority");
    assert.equal(
      fieldColumn().childNodes.indexOf(prioritySelect().parentElement),
      fieldColumn().childNodes.indexOf(typeSelect().parentElement) + 1,
    );
    assert.ok(fieldColumn().childNodes.indexOf(prioritySelect().parentElement) < fieldColumn().childNodes.indexOf(parent()));
    const beforePriority = sets().length;
    prioritySelect().value = "medium";
    prioritySelect().listeners.change();
    assert.equal(sets().length, beforePriority);
    prioritySelect().value = "high";
    prioritySelect().listeners.change();
    assert.deepEqual(sets().at(-1), {
      type: "ticket.set",
      path: "tickets/aaaaaaaa.md",
      rev: 6,
      priority: "high",
      username: "",
    });
    assert.equal(rowOf(mounted.nav, "aaaaaaaa").textContent.includes("high"), false);
    assert.equal(rowOf(mounted.nav, "aaaaaaaa").textContent.includes("Alpha"), true);
    assert.equal(rowOf(mounted.nav, "aaaaaaaa").textContent.includes("new"), true);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("T-ticket-notice", () => {
  const mounted = mountTicketPage();
  const transport = holdingTransport();
  try {
    const view = createEditor(mounted.root, "x", 0, transport);
    const alpha = ticketFixture("aaaaaaaa", "Alpha", "new", T0);
    transport.deliver({ type: "tickets", tickets: [alpha] });
    transport.deliver({
      type: "file",
      path: "tickets/aaaaaaaa.md",
      rev: 3,
      text: "Body line\n",
      cursor: 0,
      anchor: 0,
      locks: [],
      ticket: { ...alpha, priority: "high" },
    });
    const form = byClass(mounted.root.parentElement, "ticket-form")[0];
    assert.equal(byClass(form, "md-ticket-priority")[0].value, "high");
    transport.deliver({ type: "doc", rev: 4, text: "Body line!\n", actor: "Bea" });
    assert.equal(view.getState().doc, "Body line!\n");
    assert.equal(byClass(form, "md-ticket-heading")[0].textContent, "Alpha");
    assert.equal(byClass(form, "md-ticket-reporter")[0].textContent, "Ada");
    assert.equal(byClass(form, "md-ticket-created")[0].textContent, T0);
    transport.deliver({
      type: "ticket",
      path: "tickets/aaaaaaaa.md",
      rev: 8,
      title: "Alpha two",
      state: "triaged",
      ticketType: "enhancement",
      parent: "",
      depends: [],
      reporter: "Bea",
      created: T2,
    });
    assert.equal(view.getState().doc, "Body line!\n");
    assert.equal(mounted.root.textContent.includes("Body line!"), true);
    assert.equal(byClass(form, "md-ticket-heading")[0].textContent, "Alpha two");
    assert.equal(byClass(form, "md-ticket-reporter")[0].textContent, "Bea");
    assert.equal(byClass(form, "md-ticket-created")[0].textContent, T2);
    assert.equal(byClass(form, "md-ticket-state")[0].value, "triaged");
    assert.equal(byClass(form, "md-ticket-type")[0].value, "enhancement");
    assert.equal(byClass(form, "md-ticket-priority")[0].value, "medium");
    assert.equal(rowOf(mounted.nav, "aaaaaaaa").textContent.includes("Alpha two"), true);
    assert.equal(rowOf(mounted.nav, "aaaaaaaa").textContent.includes("triaged"), true);
    assert.equal(rowOf(mounted.nav, "aaaaaaaa").textContent.includes("enhancement"), true);
    assert.equal(rowOf(mounted.nav, "aaaaaaaa").textContent.includes("medium"), true);
    transport.deliver({
      type: "ticket",
      path: "tickets/aaaaaaaa.md",
      rev: 9,
      title: "Alpha two",
      state: "triaged",
      ticketType: "enhancement",
      priority: "low",
      parent: "",
      depends: [],
      reporter: "Bea",
      created: T2,
    });
    assert.equal(byClass(form, "md-ticket-priority")[0].value, "low");
    assert.equal(rowOf(mounted.nav, "aaaaaaaa").textContent.includes("low"), true);
    assert.equal(rowOf(mounted.nav, "aaaaaaaa").textContent.includes("Alpha two"), true);
    assert.equal(rowOf(mounted.nav, "aaaaaaaa").textContent.includes("triaged"), true);
    const state = byClass(form, "md-ticket-state")[0];
    state.value = "closed";
    state.listeners.change();
    assert.deepEqual(transport.sent.filter((message) => message.type === "ticket.set").at(-1), {
      type: "ticket.set",
      path: "tickets/aaaaaaaa.md",
      rev: 9,
      state: "closed",
      username: "",
    });
    transport.deliver({ type: "file", path: "notes.md", rev: 1, text: "plain\n", locks: [] });
    assert.equal(form.hidden, true);
    assert.equal(view.getState().doc, "plain\n");
    assert.equal(byClass(form, "md-ticket-heading").length, 0);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("T-ticket-gone", () => {
  const mounted = mountTicketPage();
  const transport = holdingTransport();
  try {
    const view = createEditor(mounted.root, "x", 0, transport);
    const alpha = ticketFixture("aaaaaaaa", "Keep me", "new", T0);
    const bravo = ticketFixture("bbbbbbbb", "Stay", "new", T1);
    transport.deliver({ type: "tickets", tickets: [alpha, bravo] });
    transport.deliver({
      type: "file",
      path: "tickets/aaaaaaaa.md",
      rev: 2,
      text: "Keep me\n",
      cursor: 0,
      anchor: 0,
      locks: [],
      ticket: alpha,
    });
    const form = byClass(mounted.root.parentElement, "ticket-form")[0];
    assert.equal(form.hidden, false);
    assert.equal(view.getState().doc, "Keep me\n");
    const before = transport.sent.length;
    transport.deliver({ type: "tickets", tickets: [bravo] });
    assert.equal(transport.sent.length, before);
    assert.equal(form.hidden, true);
    assert.equal(byClass(form, "md-ticket-heading").length, 0);
    assert.equal(view.getState().doc, "");
    assert.equal(mounted.root.textContent.includes("Keep me"), false);
    assert.equal(ticketNode(mounted.nav, "aaaaaaaa"), undefined);
    assert.ok(ticketNode(mounted.nav, "bbbbbbbb"));
    mounted.listeners.beforeinput({
      inputType: "insertText",
      data: "Z",
      preventDefault() {},
    });
    assert.equal(transport.sent.length, before);
    assert.equal(view.getState().doc, "");
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("file titles and move drops", () => {
  const mounted = mountEditor();
  const css = readFileSync(new URL("../editor.css", import.meta.url), "utf8");
  const fileRule = css.match(/\.file-block\s*\{[^}]*\}/);
  const ticketRule = css.match(/\.ticket-block\s*\{[^}]*\}/);
  assert.ok(fileRule);
  assert.ok(ticketRule);
  for (const rule of [fileRule[0], ticketRule[0]]) {
    assert.match(rule, /border:\s*1px solid #4a463f/);
    assert.match(rule, /padding:\s*0\.4rem/);
    assert.equal(/margin:\s*0 0 0\.8rem/.test(rule), false);
  }
  assert.match(fileRule[0], /margin-bottom:\s*0\.4rem/);
  const lineRule = css.match(/\.md-drop-line\s*\{[^}]*\}/);
  const targetRule = css.match(/\.md-dir\.md-drop-target\s*>\s*\.md-dir-toggle\s*\{[^}]*\}/);
  assert.ok(lineRule);
  assert.ok(targetRule);
  assert.match(lineRule[0], /height:\s*2px/);
  assert.match(lineRule[0], /background:\s*#e7e2d8/);
  assert.match(lineRule[0], /pointer-events:\s*none/);
  assert.match(targetRule[0], /background:\s*#3d5a80/);
  const nav = document.createElement("nav");
  nav.className = "files";
  const sheet = document.createElement("div");
  sheet.appendChild(nav);
  sheet.appendChild(mounted.root);
  const transport = holdingTransport();
  const files = ["archive/keep.md", "notes/idea.md", "notes/sub/deep.md", "plain.md"];
  const titles = { "notes/idea.md": "Idea Title", "plain.md": "", "archive/keep.md": "Keep" };
  const buttonPath = (rel) => walkNodes(nav, (node) => node.tagName === "BUTTON" && node.dataset && node.dataset.path === rel)[0];
  const buttonDir = (rel) => walkNodes(nav, (node) => node.tagName === "BUTTON" && node.dataset && node.dataset.dir === rel)[0];
  try {
    const view = createEditor(mounted.root, "x", 0, transport);
    const block = byClass(nav, "ticket-block")[0];
    const fileBlock = byClass(nav, "file-block")[0];
    const tree = byClass(nav, "file-tree")[0];
    assert.equal(block.parentElement, nav);
    assert.equal(tree.parentElement, fileBlock);
    assert.equal(fileBlock.parentElement, nav);
    assert.equal(byClass(nav, "ticket-tree").length, 1);
    assert.equal(byClass(nav, "ticket-tree")[0].parentElement.classList.contains("md-ticket-drawer"), true);
    assert.equal(byClass(nav, "ticket-tree")[0].parentElement.parentElement, block);
    transport.deliver({ type: "docs", files, titles });
    assert.equal(buttonDir("notes").textContent, "notes");
    assert.equal(buttonPath("notes/idea.md"), undefined);
    buttonDir("notes").listeners.click({ preventDefault() {} });
    const idea = buttonPath("notes/idea.md");
    assert.equal(idea.textContent, "Idea Title");
    assert.equal(idea.dataset.path, "notes/idea.md");
    assert.equal(buttonPath("plain.md").textContent, "plain.md");
    assert.equal(idea.draggable, true);
    assert.equal(idea.getAttribute("draggable"), "true");
    assert.equal(buttonDir("notes").draggable, true);
    assert.equal(buttonDir("notes").getAttribute("draggable"), "true");
    assert.equal(typeof idea.listeners.dragstart, "function");
    assert.equal(typeof buttonDir("notes").listeners.dragstart, "function");
    transport.deliver({ type: "docs", files });
    assert.equal(buttonPath("notes/idea.md").textContent, "idea.md");
    assert.equal(buttonDir("notes").textContent, "notes");
    transport.deliver({ type: "docs", files, titles });
    assert.equal(buttonPath("notes/idea.md").textContent, "Idea Title");
    buttonDir("archive").listeners.click({ preventDefault() {} });
    buttonDir("notes").listeners.dragstart({});
    const beforeSelf = transport.sent.length;
    buttonDir("notes").listeners.drop({ preventDefault() {}, stopPropagation() {} });
    assert.equal(transport.sent.length, beforeSelf);
    buttonDir("notes").listeners.dragstart({});
    buttonDir("notes/sub").listeners.drop({ preventDefault() {}, stopPropagation() {} });
    assert.equal(transport.sent.length, beforeSelf);
    let fileDropStopped = false;
    const fileDrop = () => ({
      preventDefault() {},
      stopPropagation() { fileDropStopped = true; },
    });
    buttonPath("notes/idea.md").listeners.dragstart({});
    fileDropStopped = false;
    buttonPath("archive/keep.md").listeners.drop(fileDrop());
    assert.equal(fileDropStopped, true);
    assert.deepEqual(transport.sent.at(-1), { type: "move", path: "notes/idea.md", dir: "archive", username: "" });
    assert.equal(transport.sent.at(-1).rev, undefined);
    buttonPath("notes/idea.md").listeners.dragstart({});
    fileDropStopped = false;
    buttonPath("plain.md").listeners.drop(fileDrop());
    assert.equal(fileDropStopped, true);
    assert.deepEqual(transport.sent.at(-1), { type: "move", path: "notes/idea.md", dir: "", username: "" });
    assert.equal(transport.sent.at(-1).rev, undefined);
    buttonDir("notes/sub").listeners.click({ preventDefault() {} });
    buttonPath("notes/idea.md").listeners.dragstart({});
    fileDropStopped = false;
    buttonPath("notes/sub/deep.md").listeners.drop(fileDrop());
    assert.equal(fileDropStopped, true);
    assert.deepEqual(transport.sent.at(-1), { type: "move", path: "notes/idea.md", dir: "notes/sub", username: "" });
    assert.equal(transport.sent.at(-1).rev, undefined);
    buttonDir("notes").listeners.dragstart({});
    const beforeDescendantFile = transport.sent.length;
    buttonPath("notes/sub/deep.md").listeners.drop(fileDrop());
    assert.equal(transport.sent.length, beforeDescendantFile);
    buttonPath("notes/idea.md").listeners.dragstart({});
    buttonDir("notes").listeners.drop({ preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(transport.sent.at(-1), { type: "move", path: "notes/idea.md", dir: "notes", username: "" });
    assert.equal(transport.sent.at(-1).rev, undefined);
    buttonDir("notes").listeners.dragstart({});
    buttonDir("archive").listeners.drop({ preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(transport.sent.at(-1), { type: "move", path: "notes", dir: "archive", username: "" });
    assert.equal(transport.sent.at(-1).rev, undefined);
    buttonDir("notes").listeners.dragstart({});
    tree.listeners.drop({ preventDefault() {} });
    assert.deepEqual(transport.sent.at(-1), { type: "move", path: "notes", dir: "", username: "" });
    buttonDir("archive").listeners.click({ preventDefault() {} });
    const over = { preventDefault() {}, stopPropagation() {} };
    const marks = () => byClass(tree, "md-drop-target");
    const lines = () => byClass(tree, "md-drop-line");
    const sentAt = transport.sent.length;
    buttonPath("notes/idea.md").listeners.dragstart({});
    buttonDir("archive").listeners.dragover(over);
    const archiveWrap = buttonDir("archive").parentElement;
    assert.equal(archiveWrap.classList.contains("md-dir-collapsed"), true);
    assert.equal(archiveWrap.classList.contains("md-drop-target"), true);
    assert.equal(lines().length, 0);
    assert.equal(transport.sent.length, sentAt);
    buttonPath("plain.md").listeners.dragover(over);
    assert.equal(archiveWrap.classList.contains("md-drop-target"), false);
    assert.equal(marks().length, 0);
    assert.equal(lines().length, 1);
    assert.equal(lines()[0].tagName, "DIV");
    assert.equal(lines()[0].parentElement, tree);
    assert.equal(tree.childNodes[tree.childNodes.indexOf(lines()[0]) + 1], buttonDir("notes").parentElement);
    buttonPath("notes/idea.md").listeners.dragend({});
    assert.equal(marks().length, 0);
    assert.equal(lines().length, 0);
    buttonPath("notes/idea.md").listeners.dragstart({});
    buttonDir("archive").listeners.dragover(over);
    assert.equal(buttonDir("archive").parentElement.classList.contains("md-drop-target"), true);
    buttonPath("notes/idea.md").listeners.dragend({});
    assert.equal(marks().length, 0);
    assert.equal(lines().length, 0);
    buttonPath("notes/idea.md").listeners.dragstart({});
    buttonPath("plain.md").listeners.dragover(over);
    assert.equal(lines().length, 1);
    buttonDir("notes").listeners.dragstart({});
    buttonDir("notes").listeners.dragover(over);
    assert.equal(marks().length, 0);
    assert.equal(lines().length, 0);
    buttonDir("notes/sub").listeners.dragover(over);
    assert.equal(marks().length, 0);
    assert.equal(lines().length, 0);
    assert.equal(transport.sent.length, sentAt);
    transport.deliver({
      type: "docs",
      files,
      titles: { "notes/idea.md": "Zebra", "plain.md": "", "archive/keep.md": "Keep" },
    });
    assert.equal(buttonPath("notes/idea.md").textContent, "Zebra");
    assert.equal(buttonDir("archive").parentElement.classList.contains("md-dir-collapsed"), true);
    buttonPath("notes/idea.md").listeners.dragstart({});
    buttonDir("notes").listeners.dragover(over);
    const notesKids = byClass(buttonDir("notes").parentElement, "md-dir-children")[0];
    const nested = lines();
    assert.equal(buttonDir("notes").parentElement.classList.contains("md-drop-target"), false);
    assert.equal(nested.length, 1);
    assert.equal(nested[0].parentElement, notesKids);
    const kidList = notesKids.childNodes;
    assert.equal(kidList[kidList.indexOf(nested[0]) - 1], buttonPath("notes/idea.md"));
    assert.equal(kidList[kidList.indexOf(nested[0]) + 1], buttonDir("notes/sub").parentElement);
    buttonPath("notes/idea.md").listeners.dragend({});
    assert.equal(lines().length, 0);
    buttonPath("notes/idea.md").listeners.dragstart({});
    tree.listeners.dragover({ preventDefault() {} });
    assert.equal(lines().length, 1);
    assert.equal(lines()[0].parentElement, tree);
    assert.equal(tree.childNodes[tree.childNodes.indexOf(lines()[0]) + 1], buttonDir("notes").parentElement);
    buttonPath("notes/idea.md").listeners.dragend({});
    assert.equal(marks().length, 0);
    assert.equal(lines().length, 0);
    fileDropStopped = false;
    buttonPath("notes/idea.md").listeners.dragstart({});
    buttonPath("plain.md").listeners.drop(fileDrop());
    assert.equal(fileDropStopped, true);
    assert.deepEqual(transport.sent.at(-1), { type: "move", path: "notes/idea.md", dir: "", username: "" });
    transport.deliver({ type: "tickets", tickets: [ticketFixture("aaaaaaaa", "Alpha", "new", T0)] });
    const row = rowOf(nav, "aaaaaaaa");
    const ticketButton = byClass(row, "md-ticket")[0];
    assert.notEqual(row.draggable, true);
    assert.equal(row.getAttribute("draggable"), null);
    assert.notEqual(ticketButton.draggable, true);
    assert.equal(ticketButton.getAttribute("draggable"), null);
    assert.equal(ticketButton.listeners.dragstart, undefined);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("shift-arrow keeps the anchor and an unshifted arrow collapses", () => {
  const mounted = mountEditor();
  globalThis.NodeFilter = globalThis.NodeFilter || { SHOW_TEXT: 4 };
  const textOf = (value) => mounted.findAll((node) => node.nodeType === 3 && node.textContent === value)[0];
  try {
    const view = createEditor(mounted.root, "hello fox", 0);
    const text = textOf("hello fox");
    assert.equal(text.textContent, "hello fox");
    text.parentElement.scrollIntoView = () => {};
    const yieldNone = globalThis.document.createTreeWalker;
    globalThis.document.createTreeWalker = () => {
      let pending = text;
      return {
        nextNode() {
          const node = pending;
          pending = null;
          return node;
        },
      };
    };
    let anchorNode = text;
    let anchorOffset = 0;
    let focusNode = text;
    let focusOffset = 0;
    const samePoint = () => anchorNode === focusNode && anchorOffset === focusOffset;
    const sel = {
      rangeCount: 1,
      collapse(node, offset) {
        anchorNode = focusNode = node;
        anchorOffset = focusOffset = offset;
      },
      setBaseAndExtent(baseNode, baseOffset, extentNode, extentOffset) {
        anchorNode = baseNode;
        anchorOffset = baseOffset;
        focusNode = extentNode;
        focusOffset = extentOffset;
      },
      removeAllRanges() {},
      addRange() {},
      modify(action, direction) {
        if (action === "move" && !samePoint()) {
          anchorNode = focusNode;
          anchorOffset = focusOffset;
          return;
        }
        const step = direction === "forward" ? 1 : -1;
        focusOffset += step;
        anchorOffset = focusOffset;
        anchorNode = focusNode;
      },
      getRangeAt() {
        return { startContainer: focusNode, startOffset: focusOffset, collapsed: samePoint() };
      },
    };
    globalThis.window.getSelection = () => sel;
    const press = (key, extra = {}) => {
      mounted.listeners.keydown({
        key,
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        ...extra,
        preventDefault() {},
      });
    };
    press("ArrowRight", { shiftKey: true });
    assert.equal(view.getState().anchor, 0);
    assert.equal(view.getState().cursor, 1);
    press("ArrowRight", { shiftKey: true });
    assert.equal(view.getState().anchor, 0);
    assert.equal(view.getState().cursor, 2);
    press("ArrowLeft", { shiftKey: true });
    assert.equal(view.getState().anchor, 0);
    assert.equal(view.getState().cursor, 1);
    press("ArrowRight");
    assert.equal(view.getState().anchor, 2);
    assert.equal(view.getState().cursor, 2);
    press("ArrowRight", { shiftKey: true, ctrlKey: true });
    assert.equal(view.getState().anchor, 3);
    assert.equal(view.getState().cursor, 3);
    press("ArrowRight", { shiftKey: true, altKey: true });
    assert.equal(view.getState().anchor, 4);
    assert.equal(view.getState().cursor, 4);
    press("ArrowRight", { shiftKey: true, metaKey: true });
    assert.equal(view.getState().anchor, 5);
    assert.equal(view.getState().cursor, 5);
    view.destroy();
    globalThis.document.createTreeWalker = yieldNone;

    const lines = createEditor(mounted.root, "hello fox\nnext\n", 0);
    const first = textOf("hello fox");
    const second = textOf("next");
    let node = first;
    const lineSel = {
      rangeCount: 1,
      collapse() {},
      setBaseAndExtent() {},
      modify(_action, direction, granularity) {
        if (granularity === "line") node = direction === "forward" ? second : first;
      },
      getRangeAt() {
        return { startContainer: node, startOffset: 0, collapsed: true };
      },
    };
    globalThis.window.getSelection = () => lineSel;
    mounted.listeners.keydown({
      key: "ArrowDown",
      shiftKey: true,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      preventDefault() {},
    });
    assert.equal(lines.getState().anchor, 0);
    assert.equal(lines.getState().cursor, 10);
    assert.equal(selectedSlice(lines.getState()), "hello fox\n");
    lines.destroy();

    const down = createEditor(mounted.root, "hello fox\nnext\n", 0);
    node = textOf("hello fox");
    globalThis.window.getSelection = () => lineSel;
    mounted.listeners.keydown({
      key: "ArrowDown",
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      preventDefault() {},
    });
    assert.equal(down.getState().anchor, 10);
    assert.equal(down.getState().cursor, 10);
    down.destroy();
  } finally {
    mounted.restore();
  }
});

test("ctrl-enter saves a comment body and enter does not", () => {
  const mounted = mountSheet();
  const doc = "hello {c1}fox{/c1} two\n\n```comment c1\nhi\n```\n";
  const transport = holdingTransport();
  const saves = () => transport.sent.filter((message) => message.type === "edit" && message.op === "comment.save");
  const press = (target, extra) => {
    let prevented = false;
    mounted.aside.listeners.keydown({
      key: "Enter",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      target,
      ...extra,
      preventDefault() {
        prevented = true;
      },
    });
    return prevented;
  };
  try {
    const view = createEditor(mounted.root, doc, 0, transport);
    const note = mounted.findAll((node) => node.classList && node.classList.contains("md-comment-text"))[0];
    mounted.aside.listeners.click({ target: note, preventDefault() {} });
    const box = mounted.findAll((node) => node.tagName === "TEXTAREA")[0];
    const author = mounted.findAll((node) => node.classList && node.classList.contains("md-comment-author"))[0];
    assert.equal(box.classList.contains("md-comment-body"), true);
    box.value = "yo";
    assert.equal(press(author, { ctrlKey: true }), false);
    assert.equal(saves().length, 0);
    assert.equal(press(box), false);
    assert.equal(saves().length, 0);
    assert.equal(box.value, "yo");
    assert.equal(press(box, { ctrlKey: true }), true);
    assert.equal(saves().length, 1);
    assert.equal(saves()[0].id, "c1");
    assert.equal(saves()[0].body, "yo");
    view.destroy();

    const again = holdingTransport();
    const meta = createEditor(mounted.root, doc, 0, again);
    const metaNote = mounted.findAll((node) => node.classList && node.classList.contains("md-comment-text"))[0];
    mounted.aside.listeners.click({ target: metaNote, preventDefault() {} });
    const metaBox = mounted.findAll((node) => node.tagName === "TEXTAREA")[0];
    metaBox.value = "via meta";
    let prevented = false;
    mounted.aside.listeners.keydown({
      key: "Enter",
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      shiftKey: false,
      target: metaBox,
      preventDefault() {
        prevented = true;
      },
    });
    const metaSaves = again.sent.filter((message) => message.type === "edit" && message.op === "comment.save");
    assert.equal(prevented, true);
    assert.equal(metaSaves.length, 1);
    assert.equal(metaSaves[0].body, "via meta");
    meta.destroy();
  } finally {
    mounted.restore();
  }
});

test("detail 2 selects the word and detail 3 selects the line", () => {
  const mounted = mountSheet();
  globalThis.NodeFilter = globalThis.NodeFilter || { SHOW_TEXT: 4 };
  const textOf = (value) => mounted.findAll((node) => node.nodeType === 3 && node.textContent === value)[0];
  const click = (target, detail) => {
    mounted.listeners.click({
      target,
      clientX: 4,
      clientY: 4,
      detail,
      preventDefault() {},
    });
  };
  try {
    const view = createEditor(mounted.root, "hello fox two", 0);
    const text = textOf("hello fox two");
    assert.equal(text.textContent, "hello fox two");
    mounted.listeners.mousedown({ clientX: 0, clientY: 0 });
    mounted.setSelection({
      rangeCount: 1,
      anchorNode: text,
      anchorOffset: 0,
      focusNode: text,
      focusOffset: 5,
      getRangeAt() {
        return { collapsed: false, commonAncestorContainer: text };
      },
    });
    mounted.listeners.mouseup({ clientX: 24, clientY: 0 });
    assert.equal(view.getState().anchor, 0);
    assert.equal(view.getState().cursor, 5);
    globalThis.document.caretPositionFromPoint = () => ({ offsetNode: text, offset: 7 });
    click(text, 2);
    assert.equal(view.getState().anchor, 0);
    assert.equal(view.getState().cursor, 5);
    click(text, 2);
    assert.equal(view.getState().anchor, 6);
    assert.equal(view.getState().cursor, 9);
    assert.equal(selectedSlice(view.getState()), "fox");
    click(text, 1);
    assert.equal(view.getState().anchor, 7);
    assert.equal(view.getState().cursor, 7);
    view.destroy();

    const lined = createEditor(mounted.root, "hello fox two\nnext\n", 0);
    const lineText = textOf("hello fox two");
    globalThis.document.caretPositionFromPoint = () => ({ offsetNode: lineText, offset: 7 });
    click(lineText, 3);
    assert.equal(lined.getState().anchor, 0);
    assert.equal(lined.getState().cursor, 13);
    assert.equal(selectedSlice(lined.getState()), "hello fox two");
    lined.destroy();

    const blank = createEditor(mounted.root, "hello\n\nfox\n", 0);
    const empty = mounted.findAll((node) => node.tagName === "BR" && node.parentElement && node.parentElement.dataset.start === node.parentElement.dataset.end)[0];
    const at = Number(empty.parentElement.dataset.start);
    globalThis.document.caretPositionFromPoint = () => ({ offsetNode: empty, offset: 0 });
    click(empty, 3);
    assert.equal(blank.getState().anchor, at);
    assert.equal(blank.getState().cursor, at);
    assert.equal(selectedSlice(blank.getState()), "");
    blank.destroy();
  } finally {
    mounted.restore();
  }
});

test("the state select and the reporter sit in different columns", () => {
  const mounted = mountTicketPage();
  const css = readFileSync(new URL("../editor.css", import.meta.url), "utf8");
  assert.match(css, /\.ticket-form\s*\{[^}]*display:\s*grid;/);
  assert.match(css, /\.ticket-form\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*minmax\(0,\s*1fr\)/);
  assert.match(css, /\.ticket-form label\.md-ticket-field\s*\{[^}]*display:\s*flex;/);
  assert.equal(/\.ticket-form label\.md-ticket-field select\s*\{[^}]*flex:\s*1 1 auto;/.test(css), false);
  assert.match(css, /\.ticket-form \.md-ticket-label\s*\{[^}]*font-weight:\s*700;/);
  const factRule = css.match(/\.md-ticket-fact\s*\{[^}]*\}/);
  assert.ok(factRule);
  assert.match(factRule[0], /display:\s*flex;/);
  assert.match(factRule[0], /flex-direction:\s*row;/);
  const reporterRule = css.match(/\.md-ticket-reporter,\s*\.md-ticket-created,\s*\.md-ticket-fact-id\s*\{[^}]*\}/);
  assert.ok(reporterRule);
  assert.equal(/font-size:\s*0\.85rem/.test(reporterRule[0]), false);
  assert.match(css, /@media \(max-width:\s*800px\)\s*\{[^]*\.ticket-form\s*\{[^}]*display:\s*block;/);
  const transport = holdingTransport();
  try {
    const view = createEditor(mounted.root, "x", 0, transport);
    const alpha = ticketFixture("aaaaaaaa", "Alpha", "new", T0, "bbbbbbbb", ["bbbbbbbb"]);
    const bravo = ticketFixture("bbbbbbbb", "Bravo", "triaged", T1);
    transport.deliver({ type: "tickets", tickets: [bravo, alpha] });
    transport.deliver({
      type: "file",
      path: "tickets/aaaaaaaa.md",
      rev: 1,
      text: "hello\n",
      cursor: 0,
      anchor: 0,
      locks: [],
      ticket: alpha,
    });
    const form = byClass(mounted.root.parentElement, "ticket-form")[0];
    const state = byClass(form, "md-ticket-state")[0];
    const reporter = byClass(form, "md-ticket-reporter")[0];
    const left = state.parentElement.parentElement;
    const right = reporter.parentElement.parentElement;
    assert.notEqual(left, right);
    assert.equal(left.classList.contains("md-ticket-column"), true);
    assert.equal(right.classList.contains("md-ticket-column"), true);
    assert.equal(left.parentElement, form);
    assert.equal(right.parentElement, form);
    assert.deepEqual(left.childNodes.map((node) => node.className), [
      "md-ticket-heading",
      "md-ticket-title-input",
      "md-ticket-field",
      "md-ticket-field",
      "md-ticket-field",
      "md-ticket-field md-ticket-parent",
      "md-ticket-depends",
      "md-ticket-children",
    ]);
    assert.deepEqual(
      left.childNodes.filter((node) => node.classList.contains("md-ticket-field")).map((node) => node.childNodes[0].textContent),
      ["State", "Type", "Priority", "Parent"],
    );
    for (const name of ["State", "Type", "Priority"]) {
      const label = left.childNodes.find((node) => node.classList.contains("md-ticket-field") && node.childNodes[0].textContent === name);
      assert.equal(label.childNodes[1].tagName, "SELECT");
      assert.equal(label.childNodes[0].classList.contains("md-ticket-label"), true);
    }
    assert.equal(byClass(left, "md-ticket-depend").length, 0);
    assert.equal(byClass(byClass(left, "md-ticket-depends")[0], "md-ticket-link")[0].textContent, "Bravo");
    assert.equal(byClass(right, "md-ticket-state").length, 0);
    assert.equal(byClass(right, "md-ticket-link").length, 0);
    assert.equal(byClass(right, "md-ticket-heading").length, 0);
    assert.deepEqual(right.childNodes.map((node) => node.className), [
      "md-ticket-fact",
      "md-ticket-fact",
      "md-ticket-fact",
      "md-ticket-relied",
    ]);
    assert.deepEqual(
      right.childNodes.slice(0, 3).map((node) => [node.childNodes[0].textContent, node.childNodes[1].className]),
      [
        ["Id", "md-ticket-fact-id"],
        ["Reporter", "md-ticket-reporter"],
        ["Created", "md-ticket-created"],
      ],
    );
    assert.equal(right.childNodes[0].childNodes[1].textContent, "aaaaaaaa");
    assert.equal(reporter.parentElement.classList.contains("md-ticket-fact"), true);
    assert.equal(byClass(right, "md-ticket-relied")[0].childNodes[0].textContent, "Relied on by");
    const heading = byClass(form, "md-ticket-heading")[0];
    const input = byClass(form, "md-ticket-title-input")[0];
    assert.equal(input.hidden, true);
    heading.listeners.click();
    assert.equal(input.hidden, false);
    input.value = "Beta";
    input.listeners.blur();
    assert.equal(transport.sent.filter((message) => message.type === "ticket.set").at(-1).title, "Beta");
    const src = readFileSync(new URL("../src/editor.js", import.meta.url), "utf8");
    assert.match(src, /split\(\/\\s\+\/\)/);
    const width = byClass(form, "md-ticket-state")[0].styleProps.width;
    assert.equal(width, "20px");
    for (const name of ["md-ticket-state", "md-ticket-type", "md-ticket-priority"]) {
      const select = byClass(form, name)[0];
      assert.equal(select.styleProps.width, width);
      assert.equal(select.styleProps["max-width"], width);
      assert.equal(select.styleProps.flex, "none");
    }
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("a clipped ticket select grows by the scroll gap and the three widths stay equal", () => {
  const mounted = mountTicketPage();
  const transport = holdingTransport();
  const word = "enhancement".length;
  const border = 2;
  const typeContent = word + 4;
  const gap = typeContent - (word - border);
  const fitted = `${word + gap}px`;
  const phrase = word + 29;
  const create = document.createElement;
  document.createElement = (tag) => {
    const el = create(tag);
    const kind = String(tag).toLowerCase();
    if (kind === "span") {
      el.getBoundingClientRect = () => {
        const text = typeof el.textContent === "string" ? el.textContent : "";
        const width = text.includes(" ") ? phrase : text.length;
        return { top: 0, left: 0, right: width, bottom: 10, width, height: 10 };
      };
    }
    if (kind === "select") {
      Object.defineProperty(el, "clientWidth", {
        get() {
          const width = Number.parseFloat(el.styleProps.width);
          if (!Number.isFinite(width)) return 0;
          return width - border;
        },
      });
      Object.defineProperty(el, "scrollWidth", {
        get() {
          const client = el.clientWidth;
          if (el.classList.contains("md-ticket-type")) return Math.max(client, typeContent);
          return client;
        },
      });
    }
    return el;
  };
  try {
    const view = createEditor(mounted.root, "x", 0, transport);
    const alpha = ticketFixture("aaaaaaaa", "Alpha", "new", T0);
    transport.deliver({ type: "tickets", tickets: [alpha] });
    transport.deliver({
      type: "file",
      path: "tickets/aaaaaaaa.md",
      rev: 1,
      text: "hello\n",
      cursor: 0,
      anchor: 0,
      locks: [],
      ticket: alpha,
    });
    const form = byClass(mounted.root.parentElement, "ticket-form")[0];
    const selects = ["md-ticket-state", "md-ticket-type", "md-ticket-priority"].map((name) => byClass(form, name)[0]);
    assert.deepEqual(selects.map((select) => select.styleProps.width), [fitted, fitted, fitted]);
    for (const select of selects) {
      assert.equal(select.styleProps["max-width"], fitted);
      assert.equal(select.styleProps.flex, "none");
      assert.equal(select.scrollWidth <= select.clientWidth, true);
    }
    assert.notEqual(fitted, `${phrase}px`);
    const css = readFileSync(new URL("../editor.css", import.meta.url), "utf8");
    assert.equal(/\.ticket-form label\.md-ticket-field select\s*\{[^}]*flex:\s*1 1 auto;/.test(css), false);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("ticket parent, depends, and children share a completion control", () => {
  const mounted = mountTicketPage();
  const transport = holdingTransport();
  const previousHistory = globalThis.history;
  const previousLocation = globalThis.location;
  const storage = {
    data: { "viewmark.repo": "viewmark" },
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : null;
    },
    setItem(key, value) {
      this.data[key] = String(value);
    },
    removeItem(key) {
      delete this.data[key];
    },
  };
  globalThis.history = {
    replaceState() {},
  };
  globalThis.location = { pathname: "/app", search: "", hash: "" };
  const Q0 = "2026-08-01T00:00:00.000Z";
  const Q1 = "2026-08-02T00:00:00.000Z";
  const Q2 = "2026-08-03T00:00:00.000Z";
  const Q3 = "2026-08-04T00:00:00.000Z";
  const Q4 = "2026-08-05T00:00:00.000Z";
  const Q5 = "2026-08-06T00:00:00.000Z";
  try {
    const view = createEditor(mounted.root, "x", 0, transport, storage);
    const alpha = ticketFixture("aaaaaaaa", "Alpha", "new", T0, "bbbbbbbb", ["bbbbbbbb"]);
    const bravo = ticketFixture("bbbbbbbb", "Bravo", "triaged", T1);
    const cedar = { ...ticketFixture("cccccccc", "Cedar", "new", T2, "aaaaaaaa"), rev: 0 };
    const delta = { ...ticketFixture("dddddddd", "Delta", "new", T3), rev: 4 };
    const echo = ticketFixture("eeeeeeee", "Echo", "new", "2026-09-01T00:00:00.000Z", "", ["aaaaaaaa"]);
    const extra = ticketFixture("nnnnnnnn", "bravo extra", "new", "2026-10-05T00:00:00.000Z");
    const quests = [
      ticketFixture("ffffffff", "Quest", "new", Q0),
      ticketFixture("gggggggg", "Queen", "new", Q1),
      ticketFixture("hhhhhhhh", "Quill", "new", Q2),
      ticketFixture("jjjjjjjj", "Quote", "new", Q3),
      ticketFixture("kkkkkkkk", "Quick", "new", Q4),
      ticketFixture("mmmmmmmm", "Quiet", "new", Q5),
    ];
    const tickets = [alpha, bravo, cedar, delta, echo, extra, ...quests];
    transport.deliver({ type: "tickets", tickets });
    transport.deliver({
      type: "file",
      path: "tickets/aaaaaaaa.md",
      rev: 6,
      text: "hello\n",
      cursor: 0,
      anchor: 0,
      locks: [],
      ticket: alpha,
    });
    const form = byClass(mounted.root.parentElement, "ticket-form")[0];
    const sets = () => transport.sent.filter((message) => message.type === "ticket.set");
    const block = (className) => byClass(form, className)[0];
    const parent = block("md-ticket-parent");
    const depends = block("md-ticket-depends");
    const children = block("md-ticket-children");
    assert.deepEqual(
      ["State", "Type", "Priority", "Parent", "Depends", "Children"].map((label) => (
        byClass(form, "md-ticket-label").some((node) => node.textContent === label)
      )),
      [true, true, true, true, true, true],
    );
    assert.equal(byClass(parent, "md-ticket-parent-value")[0].textContent, "Bravo");
    assert.equal(byClass(parent, "md-ticket-add")[0].textContent, "+");
    assert.equal(byClass(parent, "md-ticket-remove")[0].textContent, "-");
    assert.equal(byClass(depends, "md-ticket-match")[0].tagName, "INPUT");
    assert.equal(block("md-ticket-menu").hidden, true);
    assert.deepEqual(
      byClass(depends, "md-ticket-link").map((node) => node.dataset.id),
      ["bbbbbbbb"],
    );
    assert.deepEqual(
      byClass(children, "md-ticket-link").map((node) => node.textContent),
      ["Cedar"],
    );
    assert.deepEqual(
      byClass(block("md-ticket-relied"), "md-ticket-rely").map((node) => node.textContent),
      ["Echo"],
    );

    const before = sets().length;
    byClass(depends, "md-ticket-remove")[0].listeners.click({ preventDefault() {} });
    assert.equal(sets().length, before);
    byClass(depends, "md-ticket-link")[0].listeners.click({ preventDefault() {} });
    assert.equal(byClass(depends, "md-ticket-link")[0].classList.contains("md-ticket-selected"), true);
    byClass(depends, "md-ticket-remove")[0].listeners.click({ preventDefault() {} });
    assert.deepEqual(sets().at(-1), {
      type: "ticket.set",
      path: "tickets/aaaaaaaa.md",
      rev: 6,
      depends: [],
      username: "",
    });

    const dependMatch = byClass(depends, "md-ticket-match")[0];
    dependMatch.value = "rav";
    dependMatch.listeners.input();
    assert.equal(dependMatch.value, "rav");
    assert.equal(byClass(depends, "md-ticket-menu")[0].hidden, true);
    dependMatch.value = "aaaaaaaa";
    dependMatch.listeners.input();
    assert.equal(dependMatch.value, "aaaaaaaa");
    assert.equal(byClass(depends, "md-ticket-menu")[0].hidden, true);
    const beforeSelf = sets().length;
    byClass(depends, "md-ticket-add")[0].listeners.click({ preventDefault() {} });
    assert.equal(sets().length, beforeSelf);

    dependMatch.value = "BRA";
    dependMatch.listeners.input();
    assert.equal(dependMatch.value, "Bravo");
    assert.equal(dependMatch.selectionStart, 3);
    assert.equal(dependMatch.selectionEnd, "Bravo".length);
    assert.deepEqual(
      byClass(byClass(depends, "md-ticket-menu")[0], "md-ticket-option").map((node) => node.dataset.id),
      ["bbbbbbbb", "nnnnnnnn"],
    );
    dependMatch.value = "bravo e";
    dependMatch.selectionStart = "bravo e".length;
    dependMatch.selectionEnd = "bravo e".length;
    dependMatch.listeners.input();
    assert.equal(dependMatch.value, "bravo extra");
    assert.equal(dependMatch.selectionStart, "bravo e".length);
    assert.equal(dependMatch.selectionEnd, "bravo extra".length);
    assert.deepEqual(
      byClass(byClass(depends, "md-ticket-menu")[0], "md-ticket-option").map((node) => node.dataset.id),
      ["nnnnnnnn"],
    );
    dependMatch.value = "b";
    dependMatch.selectionStart = 0;
    dependMatch.selectionEnd = 0;
    dependMatch.listeners.input();
    const options = byClass(byClass(depends, "md-ticket-menu")[0], "md-ticket-option");
    assert.equal(options[1].textContent, "bravo extra");
    options[1].listeners.click({ preventDefault() {} });
    assert.equal(dependMatch.value, "bravo extra");
    assert.equal(byClass(depends, "md-ticket-menu")[0].hidden, true);
    byClass(depends, "md-ticket-add")[0].listeners.click({ preventDefault() {} });
    assert.equal(dependMatch.value, "");
    assert.deepEqual(sets().at(-1), {
      type: "ticket.set",
      path: "tickets/aaaaaaaa.md",
      rev: 6,
      depends: ["bbbbbbbb", "nnnnnnnn"],
      username: "",
    });

    dependMatch.value = "q";
    dependMatch.listeners.input();
    assert.equal(dependMatch.value, "Quest");
    assert.equal(dependMatch.selectionStart, 1);
    assert.deepEqual(
      byClass(byClass(depends, "md-ticket-menu")[0], "md-ticket-option").map((node) => node.dataset.id),
      ["ffffffff", "gggggggg", "hhhhhhhh", "jjjjjjjj", "kkkkkkkk"],
    );
    dependMatch.value = "ggg";
    dependMatch.selectionStart = 0;
    dependMatch.selectionEnd = 0;
    dependMatch.listeners.input();
    assert.equal(dependMatch.value, "gggggggg");
    assert.equal(dependMatch.selectionStart, 3);
    assert.equal(dependMatch.selectionEnd, "gggggggg".length);
    assert.equal(byClass(byClass(depends, "md-ticket-menu")[0], "md-ticket-option")[0].textContent, "Queen");

    byClass(parent, "md-ticket-remove")[0].listeners.click({ preventDefault() {} });
    assert.deepEqual(sets().at(-1), {
      type: "ticket.set",
      path: "tickets/aaaaaaaa.md",
      rev: 6,
      parent: "",
      username: "",
    });
    const parentMatch = byClass(parent, "md-ticket-match")[0];
    parentMatch.value = "de";
    parentMatch.listeners.input();
    assert.equal(parentMatch.value, "Delta");
    byClass(parent, "md-ticket-add")[0].listeners.click({ preventDefault() {} });
    assert.deepEqual(sets().at(-1), {
      type: "ticket.set",
      path: "tickets/aaaaaaaa.md",
      rev: 6,
      parent: "dddddddd",
      username: "",
    });

    const childRow = byClass(children, "md-ticket-link")[0];
    childRow.listeners.click({ preventDefault() {} });
    byClass(children, "md-ticket-remove")[0].listeners.click({ preventDefault() {} });
    assert.deepEqual(sets().at(-1), {
      type: "ticket.set",
      path: "tickets/cccccccc.md",
      rev: 0,
      parent: "",
      username: "",
    });
    const childMatch = byClass(children, "md-ticket-match")[0];
    childMatch.value = "de";
    childMatch.listeners.input();
    byClass(children, "md-ticket-add")[0].listeners.click({ preventDefault() {} });
    assert.deepEqual(sets().at(-1), {
      type: "ticket.set",
      path: "tickets/dddddddd.md",
      rev: 4,
      parent: "aaaaaaaa",
      username: "",
    });
    assert.equal(sets().every((message) => message.path !== "tickets/aaaaaaaa.md" || message.rev === 6), true);

    const next = tickets.map((ticket) => (
      ticket.id === "dddddddd" ? { ...ticket, parent: "aaaaaaaa", rev: 5 } : ticket
    ));
    transport.deliver({ type: "tickets", tickets: next });
    const refreshed = byClass(byClass(form, "md-ticket-children")[0], "md-ticket-link");
    assert.deepEqual(refreshed.map((node) => node.dataset.id), ["cccccccc", "dddddddd"]);
    refreshed[1].listeners.click({ preventDefault() {} });
    byClass(byClass(form, "md-ticket-children")[0], "md-ticket-remove")[0].listeners.click({ preventDefault() {} });
    assert.deepEqual(sets().at(-1), {
      type: "ticket.set",
      path: "tickets/dddddddd.md",
      rev: 5,
      parent: "",
      username: "",
    });

    transport.deliver({
      type: "repos",
      repos: [{ name: "viewmark", description: "Viewmark" }],
    });
    const rely = byClass(form, "md-ticket-rely")[0];
    assert.equal(rely.tagName, "BUTTON");
    assert.equal(rely.textContent, "Echo");
    rely.listeners.click({ preventDefault() {} });
    assert.deepEqual(transport.sent.at(-1), {
      type: "open",
      path: "tickets/eeeeeeee.md",
      rev: 6,
      username: "",
    });
    assert.equal(globalThis.location.hash, "#viewmark/ticket/eeeeeeee");
    view.destroy();
  } finally {
    if (previousHistory === undefined) delete globalThis.history;
    else globalThis.history = previousHistory;
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
    mounted.restore();
  }
});

test("T-hash-grammar", () => {
  assert.deepEqual(parseHash("#viewmark/ticket/mp27ndxf"), { repo: "viewmark", kind: "ticket", id: "mp27ndxf" });
  assert.equal(formatHash({ repo: "viewmark", kind: "ticket", id: "mp27ndxf" }), "#viewmark/ticket/mp27ndxf");
  const comment = { repo: "viewmark", kind: "comment", path: "docs/a.md", id: "c 1" };
  assert.equal(formatHash(comment), "#viewmark/comment/docs%2Fa.md/c%201");
  assert.deepEqual(parseHash(formatHash(comment)), comment);
  assert.equal(formatHash({ repo: "viewmark", kind: "doc", path: "docs/a.md" }), "#viewmark/doc/docs%2Fa.md");
  assert.deepEqual(parseHash("#viewmark/doc/docs%2Fa.md"), { repo: "viewmark", kind: "doc", path: "docs/a.md" });
  assert.equal(parseHash("#viewmark/comment/docs/a.md/c1"), null);
  assert.equal(parseHash("#viewmark/nope/a"), null);
  assert.equal(parseHash("#viewmark/doc/%"), null);
  assert.equal(parseHash("#"), null);
  assert.equal(parseHash("#_no/doc/a"), null);
  const max = "a".repeat(64);
  assert.equal(parseHash(`#${max}/doc/a`).repo, max);
  assert.equal(parseHash(`#${"b".repeat(65)}/doc/a`), null);
  assert.equal(formatHash({ repo: "bad repo", kind: "doc", path: "a" }), "");
  assert.equal(formatHash({ repo: "viewmark", kind: "ticket", id: "a/b" }), "");
});

test("T-deep-link", () => {
  const css = readFileSync(new URL("../editor.css", import.meta.url), "utf8");
  assert.match(css, /\.md-comment-author-row\s*\{[^}]*display:\s*flex/);
  assert.match(css, /\.md-comment-author-row\s*\{[^}]*justify-content:\s*space-between/);
  assert.match(css, /button\.md-doc-link\s*\{[^}]*text-align:\s*left/);
  assert.match(css, /button\.md-doc-link\[hidden\]\s*\{[^}]*display:\s*none/);
  const mounted = mountTicketPage();
  const create = document.createElement;
  document.createElement = (tag) => {
    const el = create(tag);
    el.scrollIntoView = function scrollIntoView() {
      this.scrolled = true;
    };
    return el;
  };
  const windowListeners = {};
  window.addEventListener = (type, fn, options) => {
    const bucket = windowListeners[type] || (windowListeners[type] = []);
    bucket.push(fn);
    const signal = options && options.signal;
    if (signal && typeof signal.addEventListener === "function") {
      signal.addEventListener("abort", () => {
        const index = bucket.indexOf(fn);
        if (index >= 0) bucket.splice(index, 1);
      });
    }
  };
  const fireHash = () => {
    for (const fn of windowListeners.hashchange || []) fn();
  };
  const previousHistory = globalThis.history;
  const previousLocation = globalThis.location;
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const urls = [];
  const writes = [];
  globalThis.history = {
    replaceState(_state, _title, url) {
      urls.push(url);
    },
  };
  globalThis.location = {
    origin: "https://viewmark.test",
    pathname: "/app",
    search: "",
    hash: "#viewmark/comment/docs%2Fa.md/c1",
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: {
      clipboard: {
        writeText(text) {
          writes.push(text);
          return Promise.resolve();
        },
      },
    },
  });
  const storage = {
    data: { "viewmark.repo": "other" },
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : null;
    },
    setItem(key, value) {
      this.data[key] = String(value);
    },
    removeItem(key) {
      delete this.data[key];
    },
  };
  const transport = holdingTransport();
  const opens = () => transport.sent.filter((message) => message.type === "open");
  const entryLink = () => walkNodes(mounted.aside, (node) => node.classList && node.classList.contains("md-doc-link"))[0];
  try {
    const view = createEditor(mounted.root, "", 0, transport, storage);
    assert.equal(entryLink().hidden, true);
    assert.equal(entryLink().textContent, "link to this entry");
    assert.equal(transport.sent.length, 0);
    transport.deliver({
      type: "repos",
      repos: [
        { name: "other", description: "Other" },
        { name: "viewmark", description: "Viewmark" },
      ],
    });
    const select = walkNodes(mounted.nav, (node) => node.classList && node.classList.contains("md-repo"))[0];
    assert.equal(select.value, "viewmark");
    assert.equal(storage.data["viewmark.repo"], "viewmark");
    assert.deepEqual(transport.sent.slice(0, 4).map((message) => message.type), ["repo", "list", "tickets", "open"]);
    assert.equal(transport.sent[0].name, "viewmark");
    assert.equal(opens()[0].path, "docs/a.md");
    assert.equal(urls.length, 0);
    assert.equal(entryLink().hidden, false);
    const menu = docMenuOf(mounted.aside);
    assert.deepEqual(menu.panel.childNodes.map((node) => node.textContent), ["", "show resolved", "link to this entry", "Commit repo"]);
    fireHash();
    assert.equal(opens().length, 1);
    const commentDoc = "See {c1}fox{/c1}.\n\n```comment c1 resolved\nhi\n```\n";
    transport.deliver({ type: "file", rev: 1, text: commentDoc, path: "docs/a.md", cursor: 0, anchor: 0 });
    const card = mounted.findAll((node) => node.classList && node.classList.contains("md-comment-card"))[0];
    assert.equal(card.dataset.comment, "c1");
    assert.equal(card.classList.contains("md-comment-current"), true);
    assert.equal(card.scrolled, true);
    assert.equal(docMenuOf(mounted.aside).checkbox.checked, true);
    assert.equal(opens().length, 1);
    const row = card.childNodes[0].childNodes[0];
    assert.equal(row.childNodes[0].classList.contains("md-comment-author"), true);
    const copy = row.childNodes.at(-1);
    assert.equal(copy.classList.contains("md-comment-link"), true);
    assert.equal(copy.classList.contains("icon-btn"), true);
    assert.equal(copy.getAttribute("aria-label"), "Copy link");
    assert.equal(row.childNodes.length, 3);
    assert.equal(row.childNodes[1].getAttribute("aria-label"), "Resolve");
    assert.equal(row.childNodes[1].classList.contains("resolve"), true);
    assert.equal(row.childNodes.filter((node) => node.classList && node.classList.contains("md-comment-link")).length, 1);
    assert.equal(copy.childNodes.length, 1);
    assert.equal(copy.childNodes[0].localName, "svg");
    assert.deepEqual(iconPaths(copy), [
      "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",
      "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
    ]);
    assert.equal(copy.textContent.includes("Copy link"), false);
    copy.listeners.click({ target: copy, preventDefault() {}, stopPropagation() {} });
    mounted.aside.listeners.click({ target: copy, preventDefault() {} });
    assert.deepEqual(writes, [`https://viewmark.test/app${formatHash({ repo: "viewmark", kind: "comment", path: "docs/a.md", id: "c1" })}`]);
    assert.equal(view.getState().doc, commentDoc);
    assert.equal(mounted.findAll((node) => node.tagName === "TEXTAREA").length, 0);
    entryLink().listeners.click({ preventDefault() {} });
    assert.equal(writes.at(-1), `https://viewmark.test/app${formatHash({ repo: "viewmark", kind: "doc", path: "docs/a.md" })}`);
    assert.equal(view.getState().doc, commentDoc);
    transport.deliver({ type: "docs", files: ["docs/a.md", "other.md"] });
    const other = walkNodes(mounted.nav, (node) => node.dataset && node.dataset.path === "other.md")[0];
    other.listeners.click({ preventDefault() {} });
    assert.equal(opens().at(-1).path, "other.md");
    assert.equal(globalThis.location.hash, "#viewmark/doc/other.md");
    assert.equal(urls.at(-1), "/app#viewmark/doc/other.md");
    const opened = opens().length;
    fireHash();
    assert.equal(opens().length, opened);
    const linked = "Go [ticket](#viewmark/ticket/mp27ndxf) now.\n\n";
    transport.deliver({ type: "file", rev: 2, text: linked, path: "other.md", cursor: linked.length, anchor: linked.length });
    const anchor = mounted.findAll((node) => node.tagName === "A")[0];
    assert.equal(anchor.href, "#viewmark/ticket/mp27ndxf");
    mounted.listeners.click({ target: anchor, clientX: 1, clientY: 1, preventDefault() {} });
    assert.equal(opens().at(-1).path, "tickets/mp27ndxf.md");
    assert.equal(globalThis.location.hash, "#viewmark/ticket/mp27ndxf");
    assert.equal(urls.at(-1), "/app#viewmark/ticket/mp27ndxf");
    fireHash();
    assert.equal(opens().filter((message) => message.path === "tickets/mp27ndxf.md").length, 1);
    entryLink().listeners.click({ preventDefault() {} });
    assert.equal(writes.at(-1), "https://viewmark.test/app#viewmark/ticket/mp27ndxf");
    const marked = transport.sent.length;
    globalThis.location.hash = "#other/doc/b.md";
    fireHash();
    assert.equal(select.value, "other");
    assert.equal(transport.sent[marked].type, "repo");
    assert.equal(transport.sent[marked].name, "other");
    assert.equal(opens().at(-1).path, "b.md");
    const afterSwitch = opens().length;
    fireHash();
    assert.equal(opens().length, afterSwitch);
    select.value = "viewmark";
    select.listeners.change();
    assert.equal(entryLink().hidden, true);
    assert.equal(opens().length, afterSwitch);
    view.destroy();

    globalThis.location.hash = "#viewmark/ticket/mp27ndxf";
    const transport2 = holdingTransport();
    const again = createEditor(mounted.root, "", 0, transport2, storage);
    fireHash();
    globalThis.location.hash = "#other/doc/b.md";
    transport2.deliver({
      type: "repos",
      repos: [
        { name: "other", description: "Other" },
        { name: "viewmark", description: "Viewmark" },
      ],
    });
    const secondOpens = transport2.sent.filter((message) => message.type === "open");
    assert.equal(secondOpens.length, 1);
    assert.equal(secondOpens[0].path, "tickets/mp27ndxf.md");
    assert.equal(transport2.sent[0].name, "viewmark");
    again.destroy();
  } finally {
    if (previousHistory === undefined) delete globalThis.history;
    else globalThis.history = previousHistory;
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
    if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
    mounted.restore();
  }
});
