import test from "node:test";
import assert from "node:assert/strict";
import {
  plan,
  mapOffset,
  stepOver,
  snapMove,
  createState,
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
  const p = plan(D, 0);
  const tables = p.blocks.filter((b) => b.type === "table");
  assert.equal(tables.length, 1);
  assert.equal(tables[0].start, 0);
  assert.equal(tables[0].end, 33);
  assert.equal(tables[0].runs, undefined);
  assert.equal(p.atoms.filter((a) => a.type === "table").length, 1);
  assert.ok(p.lines.every((line) => line.start >= 33));
  assert.ok(p.blocks.every((b) => b.type !== "line" || b.raw !== true || b.start >= 33));
  const inside = plan(D, 4);
  assert.equal(inside.blocks[0].type, "table");
  assert.ok(inside.lines.every((line) => line.raw !== true || line.start >= 33));
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
  const p = plan(E, 0);
  const diagrams = p.blocks.filter((b) => b.type === "diagram");
  assert.equal(diagrams.length, 1);
  assert.equal(diagrams[0].start, 0);
  assert.equal(diagrams[0].end, 20);
  assert.equal(diagrams[0].runs, undefined);
  assert.equal(p.atoms.filter((a) => a.type === "diagram").length, 1);
  assert.ok(p.lines.every((line) => line.start >= 20));
  const inside = plan(E, 12);
  assert.equal(inside.blocks[0].type, "diagram");
  assert.equal(inside.blocks[0].end, 20);
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
  assert.equal(snapMove("| a | b |\n| --- | --- |\n| 1 | 2 |\n", 0, 4, "forward"), 33);
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
  assert.equal(spaced.blocks[0].type, "diagram");
  assert.equal(spaced.blocks[0].info, "diagram");

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
  assert.equal(codeLines[1].runs[0].text, "full");
  assert.equal(codeLines[1].runs[0].text.length, codeLines[1].runs[0].end - codeLines[1].runs[0].start);

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
  assert.match(doc, /```mermaid[\s\S]*```/);
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
