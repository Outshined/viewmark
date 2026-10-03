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
  assert.match(css, /\.token\.keyword\s*\{[^}]*color:\s*#d73a49;/);
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /The markdown is GitHub, GitLab, and Obsidian markdown\. A mermaid fence is a diagram\./);
  assert.match(readme, /HTML is not allowed in the document\./);
});

function mountEditor() {
  const listeners = {};
  let root = null;
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
  root = makeElement("div");
  root.setAttribute = () => {};
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
    assert.deepEqual(options, [{ startOnLoad: false, securityLevel: "strict", flowchart: { htmlLabels: false }, suppressErrorRendering: true }]);
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
    el.addEventListener = (type, fn) => {
      el.listeners[type] = fn;
    };
    el.focus = () => {
      el.focused = true;
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

test("comment cards edit the thread and line up with the highlight", () => {
  const mounted = mountSheet();
  try {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    assert.match(html, /<div class="sheet">\s*<div id="editor"><\/div>\s*<aside class="comments"><\/aside>/);
    const css = readFileSync(new URL("../editor.css", import.meta.url), "utf8");
    assert.match(css, /\.md-comment-author\s*\{[^}]*min-height:\s*1\.25em;/);
    assert.match(css, /@media \(max-width:\s*800px\)\s*\{[^]*aside\.comments\s*\{[^}]*width:\s*100%;/);
    assert.match(css, /@media \(max-width:\s*800px\)\s*\{[^]*\.sheet\s*\{[^}]*display:\s*block;/);
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
    assert.equal(author.tagName, "INPUT");
    assert.equal(author.placeholder, "Author");
    assert.equal(author.value, "");
    assert.equal(author.textContent, "");
    author.value = "Ada";
    mounted.aside.listeners.input({ target: author });
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
    assert.equal(view.getState().doc.includes("Ada"), false);
    const savedCard = mounted.findAll((node) => node.classList && node.classList.contains("md-comment-card"))[0];
    assert.equal(savedCard.childNodes[0].textContent, "Resolve");
    const savedNote = savedCard.childNodes[1];
    assert.equal(savedNote.childNodes[0].tagName, "INPUT");
    assert.equal(savedNote.childNodes[0].placeholder, "Author");
    assert.equal(savedNote.childNodes[0].value, "Ada");
    assert.equal(savedNote.childNodes[0].classList.contains("md-comment-author"), true);
    box = mounted.findAll((node) => node.tagName === "TEXTAREA")[0];
    assert.equal(box.value, "hi");
    assert.equal(box.focused, true);
    assert.equal(box.selectionStart, 2);
    assert.equal(box.selectionEnd, 2);
    assert.equal(view.getState().undo.length, 2);
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
    const showResolved = mounted.aside.childNodes[0];
    const showLabel = mounted.aside.childNodes[1];
    assert.equal(showResolved.type, "checkbox");
    assert.equal(showResolved.checked, false);
    assert.equal(showResolved.disabled, false);
    assert.equal(showResolved.styleProps.position, "absolute");
    assert.equal(showResolved.styleProps.top, "0px");
    assert.equal(showResolved.styleProps.left, "0px");
    assert.equal(showLabel.textContent, "show resolved");
    assert.equal(showLabel.styleProps.position, "absolute");
    assert.equal(showLabel.styleProps.top, "0px");
    assert.notEqual(showLabel.styleProps.left, "0px");

    globalThis.window.matchMedia = () => ({ matches: true });
    mounted.listeners.resize = null;
    aligned.destroy();
    const narrow = createEditor(mounted.root, second.doc, second.cursor);
    const stacked = mounted.findAll((node) => node.classList && node.classList.contains("md-comment-card"));
    assert.deepEqual(stacked.map((card) => card.dataset.comment), ["c1", "c2"]);
    assert.ok(stacked.every((card) => card.styleProps.position === "static"));
    assert.equal(mounted.aside.childNodes[0].styleProps.position, "static");
    assert.equal(mounted.aside.childNodes[1].styleProps.position, "static");
    assert.equal(mounted.aside.childNodes[1].textContent, "show resolved");
    narrow.destroy();
  } finally {
    mounted.restore();
  }
});

test("comment cards save, reply, resolve, and discard without writing keystrokes", () => {
  const mounted = mountSheet();
  const buttons = (label) => mounted.findAll((node) => node.tagName === "BUTTON" && node.textContent === label);
  const press = (label) => {
    const button = buttons(label).at(-1);
    assert.ok(button, label);
    button.listeners.click({ target: button, preventDefault() {} });
    return button;
  };
  const pressIn = (parent, label) => {
    const button = (parent.childNodes || []).find((node) => node.tagName === "BUTTON" && node.textContent === label);
    assert.ok(button, label);
    button.listeners.click({ target: button, preventDefault() {} });
    return button;
  };
  const areas = () => mounted.findAll((node) => node.tagName === "TEXTAREA");
  const cards = () => mounted.findAll((node) => node.classList && node.classList.contains("md-comment-card"));
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
    const checkbox = mounted.aside.childNodes[0];
    const label = mounted.aside.childNodes[1];
    assert.equal(checkbox.type, "checkbox");
    assert.equal(checkbox.checked, false);
    assert.equal(checkbox.disabled, false);
    assert.equal(checkbox.styleProps.position, "static");
    assert.equal(label.tagName, "LABEL");
    assert.equal(label.textContent, "show resolved");
    assert.equal(label.styleProps.position, "static");
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
    author.value = "Ada";
    mounted.aside.listeners.input({ target: author });
    let box = areas()[0];
    box.value = "hi";
    mounted.aside.listeners.input({ target: box });
    assert.equal(fresh.getState().doc, "hello {c1}fox{/c1} two deer\n\n```comment c1\n\n```\n");
    assert.equal(fresh.getState().doc.includes("Ada"), false);
    press("Cancel");
    assert.equal(fresh.getState().doc, "hello fox two deer\n");
    assert.equal(fresh.getState().undo.length, 2);
    fresh.destroy();
    mounted.setSelection(null);

    const opened = "hello {c1}fox{/c1} two deer\n\n```comment c1\n\n```\n";
    const saved = createEditor(mounted.root, opened, 0);
    let card = cards()[0];
    assert.equal(card.childNodes[0].textContent, "Resolve");
    assert.equal(card.childNodes[1].childNodes[0].tagName, "INPUT");
    assert.equal(card.childNodes[1].childNodes[0].placeholder, "Author");
    assert.equal(card.childNodes[1].childNodes[0].value, "");
    assert.equal(card.childNodes.at(-2).textContent, "Reply");
    assert.equal(card.childNodes.at(-1).textContent, "Delete");
    assert.equal(buttons("Save").length, 0);
    box = areas()[0];
    assert.equal(box.value, "");
    box.value = "yo";
    mounted.aside.listeners.input({ target: box });
    assert.equal(saved.getState().doc, opened);
    pressIn(card.childNodes[1], "Cancel");
    assert.equal(saved.getState().doc, opened);
    box = areas()[0];
    assert.equal(box.value, "");
    assert.equal(buttons("Save").length, 0);
    box.value = "hi";
    box.selectionStart = 2;
    box.selectionEnd = 2;
    mounted.aside.listeners.input({ target: box });
    const undoBefore = saved.getState().undo.length;
    card = cards()[0];
    pressIn(card.childNodes[1], "Save");
    assert.equal(saved.getState().doc, "hello {c1}fox{/c1} two deer\n\n```comment c1\nhi\n```\n");
    assert.equal(saved.getState().doc.includes("Ada"), false);
    assert.equal(saved.getState().undo.length, undoBefore + 1);
    card = cards()[0];
    pressIn(card, "Reply");
    assert.equal(saved.getState().doc, "hello {c1}fox{/c1} two deer\n\n```comment c1\nhi\n```\n");
    card = cards()[0];
    const reply = card.childNodes.at(-3);
    assert.equal(reply.childNodes[0].tagName, "INPUT");
    assert.equal(reply.childNodes[0].placeholder, "Author");
    assert.equal(reply.childNodes[0].value, "");
    assert.equal(reply.childNodes[1].tagName, "TEXTAREA");
    assert.equal(reply.childNodes[1].value, "");
    assert.equal(reply.childNodes[2].textContent, "Save");
    assert.equal(reply.childNodes[3].textContent, "Cancel");
    pressIn(reply, "Cancel");
    assert.equal(saved.getState().doc, "hello {c1}fox{/c1} two deer\n\n```comment c1\nhi\n```\n");
    assert.equal(areas().length, 1);
    card = cards()[0];
    pressIn(card, "Reply");
    card = cards()[0];
    const replyAgain = card.childNodes.at(-3);
    replyAgain.childNodes[0].value = "Ada";
    mounted.aside.listeners.input({ target: replyAgain.childNodes[0] });
    replyAgain.childNodes[1].value = "more";
    mounted.aside.listeners.input({ target: replyAgain.childNodes[1] });
    const undoReply = saved.getState().undo.length;
    pressIn(replyAgain, "Save");
    assert.equal(saved.getState().doc, "hello {c1}fox{/c1} two deer\n\n```comment c1\nhi\n::\nmore\n```\n");
    assert.equal(saved.getState().doc.includes("Ada"), false);
    assert.equal(saved.getState().undo.length, undoReply + 1);
    assert.deepEqual(areas().map((item) => item.value), ["hi", "more"]);
    const second = areas()[1];
    second.value = "less";
    mounted.aside.listeners.input({ target: second });
    pressIn(second.parentElement, "Save");
    assert.equal(saved.getState().doc, "hello {c1}fox{/c1} two deer\n\n```comment c1\nhi\n::\nless\n```\n");
    assert.equal(areas()[0].value, "hi");
    card = cards()[0];
    const undoResolve = saved.getState().undo.length;
    pressIn(card, "Resolve");
    assert.equal(saved.getState().undo.length, undoResolve + 1);
    assert.equal(saved.getState().doc, "hello {c1}fox{/c1} two deer\n\n```comment c1 resolved\nhi\n::\nless\n```\n");
    assert.equal(saved.getState().doc.includes("{c1}fox{/c1}"), true);
    assert.equal(cards().length, 0);
    assert.ok(mounted.findAll((node) => node.classList && node.classList.contains("md-comment")).length > 0);
    let toggle = mounted.aside.childNodes[0];
    assert.equal(toggle.checked, false);
    assert.equal(toggle.disabled, false);
    toggle.checked = true;
    toggle.listeners.change();
    assert.equal(cards().length, 1);
    assert.equal(areas()[0].value, "hi");
    assert.equal(areas()[1].value, "less");
    pressIn(cards()[0], "Resolve");
    assert.equal(saved.getState().doc, "hello {c1}fox{/c1} two deer\n\n```comment c1\nhi\n::\nless\n```\n");
    assert.equal(cards().length, 1);
    toggle = mounted.aside.childNodes[0];
    toggle.checked = false;
    toggle.listeners.change();
    assert.equal(cards().length, 1);
    pressIn(cards()[0], "Delete");
    assert.equal(saved.getState().doc, "hello fox two deer\n");
    saved.destroy();
    mounted.setSelection(null);

    const marked = "Say {c1}fox{/c1} now.\n\n```comment c1\n**hi**\n```\n";
    const notes = createEditor(mounted.root, marked, 0);
    assert.equal(areas().length, 1);
    assert.equal(areas()[0].value, "**hi**");
    pressIn(cards()[0], "Reply");
    const added = cards()[0].childNodes.at(-3);
    added.childNodes[1].value = "more";
    mounted.aside.listeners.input({ target: added.childNodes[1] });
    pressIn(added, "Save");
    assert.equal(notes.getState().doc, "Say {c1}fox{/c1} now.\n\n```comment c1\n**hi**\n::\nmore\n```\n");
    assert.deepEqual(areas().map((item) => item.value), ["**hi**", "more"]);
    notes.destroy();
    mounted.setSelection(null);

    const hidden = createEditor(mounted.root, "hello {c1}fox{/c1} two deer\n\n```comment c1 resolved\nhi\n```\n", 0);
    assert.equal(cards().length, 0);
    assert.ok(mounted.findAll((node) => node.classList && node.classList.contains("md-comment")).length > 0);
    const show = mounted.aside.childNodes[0];
    assert.equal(show.checked, false);
    assert.equal(show.disabled, false);
    assert.equal(mounted.aside.childNodes[1].textContent, "show resolved");
    show.checked = true;
    show.listeners.change();
    assert.equal(cards().length, 1);
    assert.equal(areas()[0].value, "hi");
    hidden.destroy();
  } finally {
    mounted.restore();
  }
});
