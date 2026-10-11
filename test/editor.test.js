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
  wordSpan,
} from "../src/editor.js";
import { splitCommentNote, lockSpans, lockIndexAt, blockSpan, commentRangeReason, skipHidden, lineCaret, enterInsert, enterBreak, moveText } from "../src/doc.js";
import { createMemoryTransport, createSocketTransport, retryDelay } from "../src/session.js";

const A = "**hello**\nnext\n";
const B = "# Title\n\n";
const C = "x![a](b)y";
const D = "| a | b |\n| --- | --- |\n| 1 | 2 |\n";
const E = "```mermaid\nA-->B\n```\n";
const F = "Go\n![alt](sample.svg)\n";

test("T-bold-rendered", () => {
  const inside = plan(A, 10);
  const insideProse = inside.lines.filter((line) => !line.empty);
  assert.equal(insideProse.length, 1);
  assert.equal(insideProse[0].text, "**hello** next");

  const p = plan(A, A.length);
  const prose = p.lines.filter((line) => !line.empty);
  assert.equal(prose.length, 1);
  const line0 = prose[0];
  assert.equal(line0.raw, false);
  const hello = line0.runs.find((run) => run.text === "hello");
  assert.equal(hello.start, 2);
  assert.equal(hello.end, 7);
  assert.ok(hello.classes.includes("md-strong"));
  assert.equal(hello.text.length, hello.end - hello.start);
  assert.equal(line0.runs.map((run) => run.text).join(""), "hello next");
  const space = line0.runs.find((run) => run.start === 9);
  assert.equal(space.text, " ");
  assert.equal(space.end, 10);
  assert.equal(A[space.start], "\n");
  const next = line0.runs.find((run) => run.text === "next");
  assert.equal(next.start, 10);
  assert.equal(next.end, 14);
  assert.ok(next.classes.includes("md-p"));
  assert.equal(next.text.length, next.end - next.start);
});

test("T-raw-line", () => {
  const p = plan(A, 0);
  const prose = p.lines.filter((line) => !line.empty);
  assert.equal(prose.length, 1);
  const line0 = prose[0];
  assert.equal(line0.raw, true);
  assert.equal(line0.text, "**hello** next");
  assert.equal(line0.start, 0);
  assert.equal(line0.end, 14);
  assert.equal(line0.text.length, line0.end - line0.start);
  assert.equal(line0.runs.map((run) => run.text).join(""), line0.text);
  assert.ok(line0.classes.includes("md-raw"));
  assert.ok(line0.classes.includes("md-p"));
  assert.equal(line0.marker, undefined);
  const bold = line0.runs.find((run) => run.text === "**hello**");
  assert.equal(bold.start, 0);
  assert.equal(bold.end, 9);
  assert.deepEqual(bold.classes, ["md-strong"]);
  assert.equal(bold.classes.includes("md-syntax"), false);
  assert.equal(bold.text.length, bold.end - bold.start);
  const space = line0.runs.find((run) => run.start === 9);
  assert.equal(space.text, " ");
  assert.equal(space.end, 10);
  assert.equal(A[9], "\n");
  const next = line0.runs.find((run) => run.text === "next");
  assert.equal(next.start, 10);
  assert.equal(next.end, 14);
  assert.ok(next.classes.includes("md-p"));
  for (const run of line0.runs) assert.equal(run.text.length, run.end - run.start);
});

function proseBlocks(doc, cursor) {
  return plan(doc, cursor).lines.filter((line) => !line.empty);
}

function shownText(block) {
  return block.runs.map((run) => run.text).join("");
}

test("wrapped paragraph is one block", () => {
  const doc = "Alpha\nBeta\n";
  assert.equal(doc.length, 11);
  assert.equal(doc[5], "\n");
  assert.equal(doc[10], "\n");
  const shown = [];
  for (const cursor of [0, 5, 6, 10, 11]) {
    const blocks = proseBlocks(doc, cursor);
    assert.equal(blocks.length, 1);
    const block = blocks[0];
    assert.equal(block.start, 0);
    assert.equal(block.end, 10);
    assert.equal(shownText(block), "Alpha Beta");
    assert.equal(shownText(block).includes("\n"), false);
    const space = block.runs.find((run) => run.start === 5);
    assert.equal(space.text, " ");
    assert.equal(space.end, 6);
    assert.equal(doc[space.start], "\n");
    assert.equal(block.runs.some((run) => run.text === "Alpha" && run.text === "Beta"), false);
    shown.push(shownText(block));
  }
  assert.deepEqual(shown, ["Alpha Beta", "Alpha Beta", "Alpha Beta", "Alpha Beta", "Alpha Beta"]);
  assert.equal(doc, "Alpha\nBeta\n");

  const bare = "Alpha\nBeta";
  assert.equal(bare.length, 10);
  const bareBlock = proseBlocks(bare, 0)[0];
  assert.equal(proseBlocks(bare, 0).length, 1);
  assert.equal(proseBlocks(bare, 9).length, 1);
  assert.equal(shownText(bareBlock), "Alpha Beta");
  assert.equal(bareBlock.end, 10);
  assert.equal(bare[5], "\n");

  const split = "Alpha\n\nBeta\n";
  const splitBlocks = proseBlocks(split, 0);
  assert.equal(splitBlocks.length, 2);
  assert.equal(shownText(splitBlocks[0]), "Alpha");
  assert.equal(shownText(splitBlocks[1]), "Beta");

  const spaced = "Alpha\n \nBeta\n";
  assert.equal(shownText(proseBlocks(spaced, 0)[0]), "Alpha   Beta");
  assert.equal(spaced[6], " ");

  const item = proseBlocks("- Alpha\nBeta\n", 0);
  assert.equal(item.length, 1);
  assert.ok(item[0].classes.includes("md-li"));
  assert.equal(shownText(item[0]), "- Alpha Beta");
  const quoted = proseBlocks("> Alpha\nBeta\n", 0);
  assert.equal(quoted.length, 1);
  assert.ok(quoted[0].classes.includes("md-quote"));
  assert.equal(shownText(quoted[0]), "Alpha Beta");
  assert.equal(shownText(quoted[0]).includes(">"), false);
  assert.equal(proseBlocks("```js\nlet x\n```\n", 20).filter((line) => line.classes.includes("md-codeblock")).length, 1);
});

test("wrapped paragraph hard break hides its marker", () => {
  const spaces = "red  \nblue\n";
  assert.equal(spaces.length, 11);
  const spacesBlock = proseBlocks(spaces, 0)[0];
  assert.equal(proseBlocks(spaces, 0).length, 1);
  assert.equal(proseBlocks(spaces, 6).length, 1);
  assert.equal(shownText(spacesBlock), "redblue");
  assert.equal(spacesBlock.runs.some((run) => run.text.includes(" ")), false);
  const spacesBreak = spacesBlock.parts.find((part) => part.type === "break");
  assert.equal(spacesBreak.start, 5);
  assert.equal(spacesBreak.end, 6);
  assert.equal(spaces[3], " ");
  assert.equal(spaces[4], " ");
  assert.equal(spaces[5], "\n");
  assert.equal(spaces, "red  \nblue\n");

  const three = "red   \nblue\n";
  const threeBlock = proseBlocks(three, 0)[0];
  assert.equal(shownText(threeBlock), "redblue");
  assert.equal(threeBlock.parts.find((part) => part.type === "break").start, 6);
  assert.equal(three, "red   \nblue\n");

  const slash = "red\\\nblue\n";
  assert.equal(slash.length, 10);
  const slashBlock = proseBlocks(slash, 0)[0];
  assert.equal(shownText(slashBlock), "redblue");
  assert.equal(slashBlock.runs.some((run) => run.text.includes("\\")), false);
  assert.equal(slashBlock.parts.find((part) => part.type === "break").start, 4);
  assert.equal(slash[3], "\\");
  assert.equal(slash, "red\\\nblue\n");

  const one = "red \nblue\n";
  const oneBlock = proseBlocks(one, 0)[0];
  assert.equal(shownText(oneBlock), "red  blue");
  assert.equal(oneBlock.parts.some((part) => part.type === "break"), false);
  const mapped = oneBlock.runs.find((run) => run.start === 4);
  assert.equal(mapped.text, " ");
  assert.equal(one[4], "\n");
  assert.equal(one, "red \nblue\n");

  const kept = "red\\ \nblue\n";
  const keptBlock = proseBlocks(kept, 0)[0];
  assert.equal(shownText(keptBlock), "red\\  blue");
  assert.equal(keptBlock.parts.some((part) => part.type === "break"), false);
  assert.equal(kept[3], "\\");

  const mixed = "red  \nblue\ngreen\n";
  const mixedBlock = proseBlocks(mixed, 0)[0];
  assert.equal(proseBlocks(mixed, 11).length, 1);
  assert.equal(shownText(mixedBlock), "redblue green");
  assert.equal(mixedBlock.parts.filter((part) => part.type === "break").length, 1);
  assert.equal(mixedBlock.parts.find((part) => part.type === "break").start, 5);
  const soft = mixedBlock.runs.find((run) => run.start === 10);
  assert.equal(soft.text, " ");
  assert.equal(mixed[10], "\n");

  const only = "a  \n";
  const onlyBlock = proseBlocks(only, 0)[0];
  assert.equal(shownText(onlyBlock), "a");
  assert.equal(onlyBlock.parts.find((part) => part.type === "break").start, 3);
  assert.equal(only[3], "\n");
  assert.equal(only, "a  \n");

  assert.equal(shownText(proseBlocks("red  ", 0)[0]), "red  ");
  assert.equal(proseBlocks("red  ", 0)[0].parts.some((part) => part.type === "break"), false);
  assert.equal(shownText(proseBlocks("red\\", 0)[0]), "red\\");
  assert.equal(proseBlocks("red\\", 0)[0].parts.some((part) => part.type === "break"), false);
});

test("wrapped paragraph maps the joining space and edits at that newline", () => {
  const mounted = mountEditor();
  globalThis.NodeFilter = globalThis.NodeFilter || { SHOW_TEXT: 4 };
  const doc = "Alpha\nBeta\n";
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
  const press = (inputType, data) => {
    mounted.listeners.beforeinput({
      inputType,
      data,
      preventDefault() {},
    });
  };
  try {
    for (const cursor of [0, 5, 6]) {
      const view = createEditor(mounted.root, doc, cursor);
      const lines = mounted.findAll((node) => node.classList && node.classList.contains("md-line") && (node.textContent || "").includes("Alpha"));
      assert.equal(lines.length, 1);
      assert.equal(lines[0].textContent.includes("Beta"), true);
      assert.equal(lines[0].textContent.includes("\n"), false);
      assert.equal(view.getState().doc, doc);
      view.destroy();
    }

    const view = createEditor(mounted.root, doc, 0);
    const space = mounted.findAll((node) => node.nodeType === 3 && node.textContent === " ")[0];
    assert.ok(space);
    assert.equal(mapOffset(space, 0), 5);
    assert.equal(view.getState().doc[mapOffset(space, 0)], "\n");
    assert.equal(mapOffset(space, 1), 6);
    caret(space, 1);
    press("deleteContentBackward");
    assert.equal(view.getState().doc, "AlphaBeta\n");
    assert.equal(view.getState().cursor, 5);
    view.destroy();

    const typing = createEditor(mounted.root, doc, 0);
    const again = mounted.findAll((node) => node.nodeType === 3 && node.textContent === " ")[0];
    caret(again, 0);
    press("insertText", "X");
    assert.equal(typing.getState().doc, "AlphaX\nBeta\n");
    assert.equal(typing.getState().cursor, 6);
    typing.destroy();

    const hard = createEditor(mounted.root, "red  \nblue\n", 0);
    const br = mounted.findAll((node) => node.tagName === "BR" && node.parentElement && node.parentElement.dataset.start === "5")[0];
    assert.ok(br);
    assert.equal(mapOffset(br, 0), 5);
    assert.equal(hard.getState().doc[5], "\n");
    const blue = mounted.findAll((node) => node.nodeType === 3 && node.textContent === "blue")[0];
    caret(blue, 0);
    press("deleteContentBackward");
    assert.equal(hard.getState().doc, "redblue\n");
    assert.equal(hard.getState().cursor, 3);
    hard.destroy();
  } finally {
    mounted.restore();
  }
});

test("quoted paragraph is one block", () => {
  const doc = "> hi\nthere\n";
  assert.equal(doc.length, 11);
  assert.equal(doc[4], "\n");
  assert.equal(doc[10], "\n");
  assert.deepEqual(lockSpans(doc), [{ start: 0, end: 10 }]);
  const shown = [];
  for (const cursor of [0, 1, 2, 4, 5, 9, 10, 11]) {
    const blocks = proseBlocks(doc, cursor);
    assert.equal(blocks.length, 1);
    const block = blocks[0];
    assert.equal(block.start, 0);
    assert.equal(block.end, 10);
    assert.equal(block.raw, cursor <= 10);
    assert.deepEqual(block.classes, cursor <= 10 ? ["md-raw", "md-quote"] : ["md-quote"]);
    assert.equal(shownText(block), "hi there");
    assert.equal(shownText(block).includes(">"), false);
    assert.equal(shownText(block).includes("\n"), false);
    const space = block.runs.find((run) => run.start === 4);
    assert.equal(space.text, " ");
    assert.equal(space.end, 5);
    assert.equal(doc[space.start], "\n");
    assert.ok(space.classes.includes("md-quote"));
    const hi = block.runs.find((run) => run.text === "hi");
    assert.equal(hi.start, 2);
    assert.equal(hi.end, 4);
    assert.ok(hi.classes.includes("md-quote"));
    const there = block.runs.find((run) => run.text === "there");
    assert.equal(there.start, 5);
    assert.equal(there.end, 10);
    for (const run of block.runs) assert.equal(run.text.length, run.end - run.start);
    shown.push(shownText(block));
  }
  assert.deepEqual(shown, ["hi there", "hi there", "hi there", "hi there", "hi there", "hi there", "hi there", "hi there"]);
  assert.equal(doc, "> hi\nthere\n");

  const bare = "> hi\nthere";
  const bareBlock = proseBlocks(bare, 0)[0];
  assert.equal(proseBlocks(bare, 0).length, 1);
  assert.equal(proseBlocks(bare, bare.length).length, 1);
  assert.equal(shownText(bareBlock), "hi there");
  assert.equal(bareBlock.end, bare.length);
  assert.equal(bare[4], "\n");

  const marked = "> **hi**\nthere\n";
  const rawMarked = proseBlocks(marked, 0)[0];
  assert.equal(proseBlocks(marked, 0).length, 1);
  assert.equal(proseBlocks(marked, 5).length, 1);
  assert.equal(rawMarked.raw, true);
  assert.equal(shownText(rawMarked), "**hi** there");
  assert.equal(shownText(rawMarked).includes(">"), false);
  const stars = rawMarked.runs.find((run) => run.text === "**hi**");
  assert.equal(stars.start, 2);
  assert.equal(stars.end, 8);
  assert.ok(stars.classes.includes("md-strong"));
  const renderedMarked = proseBlocks(marked, marked.length)[0];
  assert.equal(renderedMarked.raw, false);
  assert.deepEqual(renderedMarked.classes, ["md-quote"]);
  assert.equal(shownText(renderedMarked), "hi there");
  assert.equal(shownText(renderedMarked).includes(">"), false);
  assert.equal(shownText(renderedMarked).includes("*"), false);
  const markedHi = renderedMarked.runs.find((run) => run.text === "hi");
  assert.equal(markedHi.start, 4);
  assert.equal(markedHi.end, 6);
  assert.ok(markedHi.classes.includes("md-strong"));
  assert.equal(marked, "> **hi**\nthere\n");

  const triple = "> one\ntwo\nthree\n";
  assert.equal(shownText(proseBlocks(triple, triple.indexOf("two"))[0]), "one two three");
  assert.equal(proseBlocks(triple, triple.indexOf("three")).length, 1);
  assert.ok(proseBlocks(triple, triple.indexOf("three"))[0].classes.includes("md-quote"));

  const split = "> hi\n\nthere\n";
  const splitBlocks = proseBlocks(split, 0);
  assert.equal(splitBlocks.length, 2);
  assert.equal(shownText(splitBlocks[0]), "> hi");
  assert.equal(shownText(splitBlocks[1]), "there");

  const nextQuote = "> a\nb\n> c\n";
  const nextBlocks = proseBlocks(nextQuote, 0);
  assert.equal(nextBlocks.length, 2);
  assert.equal(shownText(nextBlocks[0]), "a b");
  assert.ok(nextBlocks[0].classes.includes("md-quote"));
  assert.equal(shownText(nextBlocks[1]), "c");
  assert.ok(nextBlocks[1].classes.includes("md-quote"));
  const onSecond = proseBlocks(nextQuote, nextQuote.lastIndexOf(">"));
  assert.equal(onSecond.length, 2);
  assert.equal(shownText(onSecond[0]), "a b");
  assert.equal(onSecond[0].raw, false);
  assert.equal(shownText(onSecond[1]), "> c");
  assert.equal(onSecond[1].raw, true);

  const child = "> - a\n  - b\n";
  const childBlocks = proseBlocks(child, 0);
  assert.equal(childBlocks.length, 2);
  assert.equal(shownText(childBlocks[0]), "- a");
  assert.equal(shownText(childBlocks[1]), "b");

  const headed = "> a\nb\n# C\n";
  const headedBlocks = proseBlocks(headed, 0);
  assert.equal(headedBlocks.length, 2);
  assert.equal(shownText(headedBlocks[0]), "a b");
  assert.ok(headedBlocks[0].classes.includes("md-quote"));
  assert.equal(shownText(headedBlocks[1]), "C");
  assert.equal(doc, "> hi\nthere\n");
});

test("a trailing newline is not its own block", () => {
  const doc = "Alpha\nBeta\n";
  for (const cursor of [0, doc.length]) {
    const blocks = plan(doc, cursor).blocks;
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].start, 0);
    assert.equal(blocks[0].end, 10);
    assert.equal(blocks.some((block) => block.start === doc.length && block.end === doc.length), false);
  }
  const atEnd = plan(doc, doc.length).blocks;
  assert.equal(atEnd.length, 1);
  assert.equal(atEnd[0].end < doc.length, true);

  const empty = plan("", 0).blocks;
  assert.equal(empty.length, 1);
  assert.equal(empty[0].empty, true);
  assert.equal(empty[0].start, 0);
  assert.equal(empty[0].end, 0);

  const only = "\n";
  for (const cursor of [0, only.length]) {
    const blocks = plan(only, cursor).blocks;
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].empty, true);
    assert.equal(blocks[0].start, 0);
    assert.equal(blocks[0].end, 0);
    assert.equal(blocks.some((block) => block.start === only.length), false);
  }

  const bare = "Alpha\nBeta";
  const bareBlocks = plan(bare, bare.length).blocks;
  assert.equal(bareBlocks.length, 1);
  assert.equal(bareBlocks[0].end, bare.length);
  assert.equal(bareBlocks[0].raw, true);

  // The empty line after a final newline is drawn only while the caret is on it.
  const mounted = mountEditor();
  try {
    const away = createEditor(mounted.root, doc, 0);
    const hidden = mounted.findAll((node) => node.classList && node.classList.contains("md-line") && node.dataset && node.dataset.start === String(doc.length));
    assert.equal(hidden.length, 0);
    away.destroy();
    const onIt = createEditor(mounted.root, doc, doc.length);
    const line = mounted.findAll((node) => node.classList && node.classList.contains("md-line") && node.dataset && node.dataset.start === String(doc.length) && node.dataset.end === String(doc.length))[0];
    assert.ok(line);
    const br = line.childNodes.find((node) => String(node.nodeName).toUpperCase() === "BR");
    assert.ok(br);
    assert.equal(mapOffset(br, 0), doc.length);
    onIt.destroy();
  } finally {
    mounted.restore();
  }
});

test("a blank between quotes keeps the quote bar", () => {
  const paired = "> Alpha\n\n> Beta\n";
  const blocks = plan(paired, 0).blocks;
  assert.equal(blocks.length, 3);
  assert.equal(blocks[1].empty, true);
  assert.equal(blocks[1].start, 8);
  assert.equal(blocks[1].end, 8);
  assert.ok(blocks[1].classes.includes("md-quote"));
  assert.equal(blocks.some((block) => block.start === paired.length && block.end === paired.length), false);
  const onBlank = plan(paired, 8).blocks[1];
  assert.equal(onBlank.raw, true);
  assert.equal(onBlank.empty, true);
  assert.ok(onBlank.classes.includes("md-quote"));
  assert.deepEqual(lockSpans(paired), [
    { start: 0, end: 7 },
    { start: 8, end: 8 },
    { start: 9, end: 15 },
  ]);

  const gap = "> a\n\n\n> b\n";
  const gapBlocks = plan(gap, 0).blocks;
  assert.equal(gapBlocks.length, 4);
  assert.equal(gapBlocks[1].empty, true);
  assert.equal(gapBlocks[2].empty, true);
  assert.ok(gapBlocks[1].classes.includes("md-quote"));
  assert.ok(gapBlocks[2].classes.includes("md-quote"));

  const list = "> a\n\n- b\n";
  const listBlocks = plan(list, 0).blocks;
  assert.equal(listBlocks.length, 3);
  assert.equal(listBlocks[1].empty, true);
  assert.equal(listBlocks[1].classes.includes("md-quote"), false);

  for (const doc of ["> a\n\npara\n", "> a\n\n# H\n", "> a\n\n---\n", "> a\n\n```\nx\n```\n"]) {
    const blank = plan(doc, 0).blocks.find((block) => block.empty);
    assert.ok(blank, doc);
    assert.equal(blank.classes.includes("md-quote"), false);
  }

  const tail = "> a\n\n";
  const tailBlocks = plan(tail, 0).blocks;
  assert.equal(tailBlocks.length, 2);
  assert.equal(tailBlocks[1].empty, true);
  assert.equal(tailBlocks[1].classes.includes("md-quote"), false);

  const items = "> - a\n\n> - b\n";
  const itemBlocks = plan(items, 0).blocks;
  assert.equal(itemBlocks.length, 3);
  assert.equal(itemBlocks[1].empty, true);
  assert.ok(itemBlocks[1].classes.includes("md-quote"));
  assert.equal(lockSpans(items).length, 3);
});

test("a plain paragraph keeps its mark and a blank stays a line", () => {
  const paired = plan("one\n\ntwo\n", 0).blocks;
  assert.equal(paired.length, 3);
  assert.ok(paired[0].classes.includes("md-paragraph"));
  assert.equal(paired[1].empty, true);
  assert.ok(paired[1].classes.includes("md-paragraph-gap"));
  assert.equal(paired[1].classes.includes("md-paragraph"), false);
  assert.ok(paired[2].classes.includes("md-paragraph"));

  const inTwo = plan("one\n\ntwo\n", 6).blocks;
  assert.equal(inTwo[1].empty, true);
  assert.ok(inTwo[1].classes.includes("md-paragraph-gap"));
  assert.equal(inTwo[2].raw, true);
  assert.ok(inTwo[0].classes.includes("md-paragraph"));
  assert.ok(inTwo[2].classes.includes("md-paragraph"));

  const onBlank = plan("one\n\ntwo\n", 4).blocks;
  assert.equal(onBlank[1].empty, true);
  assert.equal(onBlank[1].raw, true);
  assert.ok(onBlank[1].classes.includes("md-paragraph-gap"));
  assert.equal(onBlank[1].classes.includes("md-paragraph"), false);

  const entered = plan("hello\n\n\n", 7).blocks;
  assert.equal(entered.length, 3);
  assert.ok(entered[1].classes.includes("md-paragraph-gap"));
  assert.equal(entered[2].empty, true);
  assert.equal(entered[2].raw, true);
  assert.equal(entered[2].classes.includes("md-paragraph-gap"), false);
  const away = plan("hello\n\n\n", 2).blocks;
  assert.ok(away[1].classes.includes("md-paragraph-gap"));
  assert.equal(away[2].classes.includes("md-paragraph-gap"), false);

  const wide = plan("one\n\n\ntwo\n", 0).blocks;
  const empties = wide.filter((block) => block.empty);
  assert.equal(empties.length, 2);
  assert.equal(empties.some((block) => block.classes.includes("md-paragraph-gap")), false);
  assert.equal(empties.some((block) => block.classes.includes("md-paragraph")), false);
  assert.ok(wide[0].classes.includes("md-paragraph"));
  assert.ok(wide[3].classes.includes("md-paragraph"));

  const list = plan("- a\n\n- b\n", 0).blocks;
  assert.equal(list.some((block) => block.classes.includes("md-paragraph")), false);
  assert.equal(list.some((block) => block.classes.includes("md-paragraph-gap")), false);

  const quoted = plan("> a\n\n> b\n", 0).blocks;
  assert.equal(quoted.some((block) => block.classes.includes("md-paragraph")), false);
  assert.equal(quoted.some((block) => block.classes.includes("md-paragraph-gap")), false);

  const headed = plan("a\n\n# H\n", 0).blocks;
  assert.ok(headed[0].classes.includes("md-paragraph"));
  assert.equal(headed[1].empty, true);
  assert.equal(headed[1].classes.includes("md-paragraph-gap"), false);
  assert.equal(headed[1].classes.includes("md-paragraph"), false);
  assert.equal(headed[2].classes.includes("md-paragraph"), false);

  for (const doc of ["a\n\n![x](y)\n", "![x](y)\n\nb\n"]) {
    for (const cursor of [0, doc.length]) {
      const blocks = plan(doc, cursor).blocks;
      const image = blocks.find((block) => !block.empty && imageBlock(block));
      assert.ok(image, doc);
      assert.equal(image.classes.includes("md-paragraph"), false, doc);
      const blank = blocks.find((block) => block.empty);
      assert.ok(blank, doc);
      assert.equal(blank.classes.includes("md-paragraph-gap"), false, doc);
      assert.equal(blank.classes.includes("md-paragraph"), false, doc);
    }
  }
  assert.ok(plan("a\n\n![x](y)\n", 0).blocks[0].classes.includes("md-paragraph"));
  assert.ok(plan("![x](y)\n\nb\n", 0).blocks[2].classes.includes("md-paragraph"));

  const joined = plan("one\ntwo\n", 0).blocks;
  assert.equal(joined.length, 1);
  assert.ok(joined[0].classes.includes("md-paragraph"));
  assert.equal(joined[0].classes.includes("md-paragraph-gap"), false);

  const rule = plan("---\n", 0).blocks;
  assert.equal(rule.some((block) => block.classes.includes("md-paragraph")), false);
});

test("movement skips the blank between paragraphs", () => {
  assert.equal(placeMove("one\n\ntwo\n", 1, 4, "forward", "line"), 5);
  assert.equal(placeMove("one\n\ntwo\n", 5, 4, "backward", "line"), 3);
  assert.equal(placeMove("one\n\ntwo\n", 4, 4, "forward", "line"), 5);
  assert.equal(placeMove("one\n\ntwo\n", 4, 4, "backward", "line"), 3);
  assert.equal(placeMove("one\n\ntwo\n", 0, 6, "forward", "line"), 6);
  assert.equal(placeMove("one\n\ntwo\n", 6, 0, "backward", "line"), 0);
  assert.equal(placeMove("one\n\ntwo\n", 1, 4, "forward", "character"), 5);
  assert.equal(placeMove("one\n\ntwo\n", 5, 4, "backward", "character"), 3);
  assert.equal(placeMove("hello\n\n\n", 5, 6, "forward", "character"), 7);
  assert.equal(placeMove("hello\n\n\n", 7, 6, "backward", "character"), 5);
  assert.equal(skipHidden("one\n\ntwo\n", 4, "forward"), 5);
  assert.equal(skipHidden("one\n\ntwo\n", 4, "backward"), 3);
  assert.equal(skipHidden("one\n\ntwo\n", 4, "nearer"), 3);
  assert.equal(skipHidden("hello\n\n\n", 6, "nearer"), 5);
});

function imageBlock(block) {
  return imageText(block.text) || (block.parts || []).some((part) => part && part.type === "image");
}

function imageText(text) {
  const core = typeof text === "string" ? text.trim() : "";
  return core.startsWith("![") && core.endsWith(")");
}

test("the last line of a paragraph is half a line taller", () => {
  const css = readFileSync(new URL("../editor.css", import.meta.url), "utf8");
  assert.match(css, /\.md-line\.md-paragraph\s*\{[^}]*padding-bottom:\s*calc\(1\.55em \/ 2\);/);
  assert.match(
    css,
    /\.md-line\.md-paragraph-gap\s*,\s*\.md-line\.md-paragraph-gap br\s*\{[^}]*height:\s*0;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;[^}]*margin:\s*0;/,
  );
});

test("a blank between paragraphs takes no line and keeps its offset", () => {
  const doc = "one\n\ntwo\n";
  const blank = doc.indexOf("\n\n") + 1;
  const caret = doc.indexOf("two") + 1;
  assert.equal(doc[blank], "\n");
  assert.equal(doc[caret], "w");
  const mounted = mountEditor();
  try {
    const view = createEditor(mounted.root, doc, caret);
    const lines = mounted.findAll((node) => node.classList && node.classList.contains("md-line") && !node.classList.contains("md-source-line"));
    const gap = lines.find((node) => node.classList.contains("md-paragraph-gap"));
    assert.ok(gap);
    assert.equal(lines.filter((node) => node.classList.contains("md-paragraph-gap")).length, 1);
    assert.equal(gap.classList.contains("md-paragraph"), false);
    const br = gap.childNodes.find((node) => String(node.nodeName).toUpperCase() === "BR");
    assert.ok(br);
    assert.equal(mapOffset(br, 0), blank);
    const paragraphs = lines.filter((node) => node.classList.contains("md-paragraph"));
    assert.equal(paragraphs.length, 2);
    assert.equal(paragraphs.some((node) => node.textContent.includes("one")), true);
    assert.equal(paragraphs.some((node) => node.textContent.includes("two")), true);
    pressViewToggle(mounted.root);
    assert.equal(mounted.root.classList.contains("md-source"), true);
    assert.equal(mounted.findAll((node) => node.classList && node.classList.contains("md-paragraph")).length, 0);
    assert.equal(mounted.findAll((node) => node.classList && node.classList.contains("md-paragraph-gap")).length, 0);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("quoted paragraph hard break hides its marker", () => {
  const spaces = "> red  \nblue\n";
  assert.equal(spaces.length, 13);
  assert.equal(spaces[7], "\n");
  for (const cursor of [0, 7, 8, 12, 13]) {
    const blocks = proseBlocks(spaces, cursor);
    assert.equal(blocks.length, 1);
    assert.ok(blocks[0].classes.includes("md-quote"));
    assert.equal(blocks[0].classes.includes("md-p"), false);
  }
  const spacesBlock = proseBlocks(spaces, 0)[0];
  assert.equal(shownText(spacesBlock), "redblue");
  assert.equal(shownText(spacesBlock).includes(">"), false);
  assert.equal(spacesBlock.runs.some((run) => run.text.includes(" ")), false);
  assert.equal(spacesBlock.runs.some((run) => run.text.includes(">")), false);
  const spacesBreak = spacesBlock.parts.find((part) => part.type === "break");
  assert.equal(spacesBreak.start, 7);
  assert.equal(spacesBreak.end, 8);
  assert.equal(spaces[5], " ");
  assert.equal(spaces[6], " ");
  assert.equal(spaces, "> red  \nblue\n");
  const red = spacesBlock.runs.find((run) => run.text === "red");
  assert.equal(red.start, 2);
  assert.equal(red.end, 5);
  const blue = spacesBlock.runs.find((run) => run.text === "blue");
  assert.equal(blue.start, 8);
  assert.equal(blue.end, 12);

  const three = "> red   \nblue\n";
  const threeBlock = proseBlocks(three, 0)[0];
  assert.equal(shownText(threeBlock), "redblue");
  assert.equal(threeBlock.parts.find((part) => part.type === "break").start, 8);
  assert.equal(three, "> red   \nblue\n");

  const slash = "> red\\\nblue\n";
  assert.equal(slash.length, 12);
  const slashBlock = proseBlocks(slash, 0)[0];
  assert.equal(shownText(slashBlock), "redblue");
  assert.equal(slashBlock.runs.some((run) => run.text.includes("\\")), false);
  assert.equal(slashBlock.runs.some((run) => run.text.includes(">")), false);
  assert.equal(slashBlock.parts.find((part) => part.type === "break").start, 6);
  assert.equal(slash[5], "\\");
  assert.equal(slash, "> red\\\nblue\n");

  const one = "> red \nblue\n";
  const oneBlock = proseBlocks(one, 0)[0];
  assert.equal(shownText(oneBlock), "red  blue");
  assert.equal(oneBlock.parts.some((part) => part.type === "break"), false);
  const mapped = oneBlock.runs.find((run) => run.start === 6);
  assert.equal(mapped.text, " ");
  assert.equal(one[6], "\n");
  assert.equal(one, "> red \nblue\n");

  const kept = "> red\\ \nblue\n";
  const keptBlock = proseBlocks(kept, 0)[0];
  assert.equal(shownText(keptBlock), "red\\  blue");
  assert.equal(keptBlock.parts.some((part) => part.type === "break"), false);
  assert.equal(keptBlock.runs.some((run) => run.text.includes(">")), false);
  assert.equal(kept[5], "\\");

  const mixed = "> red  \nblue\ngreen\n";
  const mixedBlock = proseBlocks(mixed, 0)[0];
  assert.equal(proseBlocks(mixed, 12).length, 1);
  assert.equal(shownText(mixedBlock), "redblue green");
  assert.equal(mixedBlock.parts.filter((part) => part.type === "break").length, 1);
  assert.equal(mixedBlock.parts.find((part) => part.type === "break").start, 7);
  const soft = mixedBlock.runs.find((run) => run.start === 12);
  assert.equal(soft.text, " ");
  assert.equal(mixed[12], "\n");

  const tail = "> red\nblue  \n";
  const tailBlock = proseBlocks(tail, 0)[0];
  assert.equal(shownText(tailBlock), "red blue");
  assert.equal(tailBlock.parts.filter((part) => part.type === "break").length, 1);
  assert.equal(tailBlock.parts.find((part) => part.type === "break").start, 12);
  assert.equal(tail, "> red\nblue  \n");

  const markerSpace = ">  \nblue\n";
  assert.equal(markerSpace[1], " ");
  assert.equal(markerSpace[2], " ");
  assert.equal(markerSpace[3], "\n");
  const markerBlock = proseBlocks(markerSpace, 0)[0];
  assert.equal(markerBlock.parts.some((part) => part.type === "break"), false);
  assert.equal(shownText(markerBlock), "  blue");
  assert.equal(shownText(markerBlock).includes(">"), false);

  const markerBreak = ">   \nblue\n";
  const markerBreakBlock = proseBlocks(markerBreak, 0)[0];
  assert.equal(shownText(markerBreakBlock), "blue");
  assert.equal(markerBreakBlock.parts.find((part) => part.type === "break").start, 4);
  assert.equal(markerBreak[4], "\n");
  assert.equal(markerBreak, ">   \nblue\n");
});

test("quoted paragraph maps the joining space and keeps the source", () => {
  const mounted = mountEditor();
  globalThis.NodeFilter = globalThis.NodeFilter || { SHOW_TEXT: 4 };
  const doc = "> hi\nthere\n";
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
  const press = (inputType, data) => {
    mounted.listeners.beforeinput({
      inputType,
      data,
      preventDefault() {},
    });
  };
  try {
    for (const cursor of [0, 4, 5]) {
      const view = createEditor(mounted.root, doc, cursor);
      const lines = mounted.findAll((node) => node.classList && node.classList.contains("md-line") && node.classList.contains("md-quote"));
      assert.equal(lines.length, 1);
      assert.equal(lines[0].textContent.includes("hi"), true);
      assert.equal(lines[0].textContent.includes("there"), true);
      assert.equal(lines[0].textContent.includes(">"), false);
      assert.equal(lines[0].textContent.includes("\n"), false);
      assert.equal(view.getState().doc, doc);
      view.destroy();
    }

    const view = createEditor(mounted.root, doc, 0);
    const space = mounted.findAll((node) => node.nodeType === 3 && node.textContent === " ")[0];
    assert.ok(space);
    assert.equal(mapOffset(space, 0), 4);
    assert.equal(view.getState().doc[mapOffset(space, 0)], "\n");
    assert.equal(mapOffset(space, 1), 5);
    caret(space, 1);
    press("deleteContentBackward");
    assert.equal(view.getState().doc, "> hithere\n");
    assert.equal(view.getState().cursor, 4);
    view.destroy();

    const typing = createEditor(mounted.root, doc, 0);
    const again = mounted.findAll((node) => node.nodeType === 3 && node.textContent === " ")[0];
    caret(again, 0);
    press("insertText", "X");
    assert.equal(typing.getState().doc, "> hiX\nthere\n");
    assert.equal(typing.getState().cursor, 5);
    typing.destroy();

    const hard = createEditor(mounted.root, "> red  \nblue\n", 0);
    const br = mounted.findAll((node) => node.tagName === "BR" && node.parentElement && node.parentElement.dataset.start === "7")[0];
    assert.ok(br);
    assert.equal(mapOffset(br, 0), 7);
    assert.equal(hard.getState().doc[7], "\n");
    const blue = mounted.findAll((node) => node.nodeType === 3 && node.textContent === "blue")[0];
    caret(blue, 0);
    press("deleteContentBackward");
    assert.equal(hard.getState().doc, "> redblue\n");
    assert.equal(hard.getState().cursor, 5);
    hard.destroy();
  } finally {
    mounted.restore();
  }
});

test("list item is one block", () => {
  const doc = "- Alpha\nBeta\n";
  assert.equal(doc.length, 13);
  assert.equal(doc[7], "\n");
  assert.equal(doc[12], "\n");
  assert.deepEqual(lockSpans(doc), [{ start: 0, end: 12 }]);
  const shown = [];
  for (const cursor of [0, 1, 2, 7, 8, 12, 13]) {
    const blocks = proseBlocks(doc, cursor);
    assert.equal(blocks.length, 1);
    const block = blocks[0];
    assert.equal(block.start, 0);
    assert.equal(block.end, 12);
    assert.equal(block.raw, cursor <= 12);
    assert.deepEqual(block.classes, cursor <= 12 ? ["md-raw", "md-li"] : ["md-li"]);
    assert.equal(Object.hasOwn(block, "marker"), false);
    assert.equal(block.indent, 0);
    assert.equal(shownText(block), cursor <= 12 ? "- Alpha Beta" : "Alpha Beta");
    assert.equal(shownText(block).includes("\n"), false);
    const space = block.runs.find((run) => run.start === 7);
    assert.equal(space.text, " ");
    assert.equal(space.end, 8);
    assert.equal(doc[space.start], "\n");
    assert.ok(space.classes.includes("md-li"));
    if (cursor <= 12) {
      assert.equal(block.runs.filter((run) => run.text.includes("-")).length, 1);
      assert.equal(block.runs[0].text.startsWith("- "), true);
    } else {
      assert.equal(shownText(block).includes("-"), false);
      const alpha = block.runs.find((run) => run.text === "Alpha");
      assert.equal(alpha.start, 2);
      assert.equal(alpha.end, 7);
      assert.ok(alpha.classes.includes("md-li"));
    }
    const beta = block.runs.find((run) => run.text === "Beta");
    assert.equal(beta.start, 8);
    assert.equal(beta.end, 12);
    for (const run of block.runs) assert.equal(run.text.length, run.end - run.start);
    shown.push(shownText(block));
  }
  assert.deepEqual(shown, [
    "- Alpha Beta",
    "- Alpha Beta",
    "- Alpha Beta",
    "- Alpha Beta",
    "- Alpha Beta",
    "- Alpha Beta",
    "Alpha Beta",
  ]);
  assert.equal(doc, "- Alpha\nBeta\n");

  const bare = "- Alpha\nBeta";
  assert.equal(proseBlocks(bare, 0).length, 1);
  assert.equal(proseBlocks(bare, bare.length).length, 1);
  assert.equal(shownText(proseBlocks(bare, bare.length)[0]), "- Alpha Beta");
  assert.equal(proseBlocks(bare, bare.length)[0].raw, true);
  assert.equal(proseBlocks(bare, bare.length)[0].end, bare.length);

  const triple = "- one\ntwo\nthree\n";
  assert.equal(proseBlocks(triple, triple.indexOf("two")).length, 1);
  assert.equal(shownText(proseBlocks(triple, triple.indexOf("two"))[0]), "- one two three");
  assert.equal(shownText(proseBlocks(triple, triple.length)[0]), "one two three");
  assert.ok(proseBlocks(triple, triple.indexOf("three"))[0].classes.includes("md-li"));

  const split = "- Alpha\n\nBeta\n";
  const splitBlocks = proseBlocks(split, 0);
  assert.equal(splitBlocks.length, 2);
  assert.equal(shownText(splitBlocks[0]), "- Alpha");
  assert.ok(splitBlocks[0].classes.includes("md-li"));
  assert.equal(shownText(splitBlocks[1]), "Beta");
  assert.equal(splitBlocks[1].classes.includes("md-li"), false);

  const spaced = "- a\n \nb\n";
  assert.equal(shownText(proseBlocks(spaced, spaced.length)[0]), "a  b");
  assert.equal(spaced[4], " ");

  const siblings = "- Alpha\nBeta\n- Gamma\n";
  const siblingBlocks = proseBlocks(siblings, siblings.length);
  assert.equal(siblingBlocks.length, 2);
  assert.equal(shownText(siblingBlocks[0]), "Alpha Beta");
  assert.equal(Object.hasOwn(siblingBlocks[0], "marker"), false);
  assert.ok(siblingBlocks[0].classes.includes("md-li"));
  assert.equal(shownText(siblingBlocks[1]), "Gamma");
  assert.equal(shownText(siblingBlocks[0]).includes("Gamma"), false);
  assert.equal(proseBlocks(siblings, siblings.indexOf("Beta")).length, 2);
  assert.equal(shownText(proseBlocks(siblings, siblings.indexOf("Beta"))[0]), "- Alpha Beta");

  const nested = "- a\nmore\n  - b\n- c\n";
  assert.deepEqual(lockSpans(nested), [
    { start: 0, end: 8 },
    { start: 9, end: 14 },
    { start: 15, end: 18 },
  ]);
  for (const cursor of [0, 2, 4, 8, 9, 11, 14, 15, 18, 19]) {
    const blocks = proseBlocks(nested, cursor);
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0].end, 8);
    assert.equal(blocks[1].start, 9);
    assert.equal(blocks[1].end, 14);
    assert.equal(blocks[2].start, 15);
    assert.equal(shownText(blocks[0]).includes("b"), false);
    assert.equal(shownText(blocks[0]).includes("c"), false);
    assert.equal(blocks[1].indent, 2);
    assert.equal(blocks[2].indent, 0);
  }
  const onParent = proseBlocks(nested, 4);
  assert.equal(onParent[0].raw, true);
  assert.equal(shownText(onParent[0]), "- a more");
  assert.equal(onParent[1].raw, false);
  assert.equal(shownText(onParent[1]), "b");
  assert.equal(shownText(onParent[1]).includes("-"), false);
  assert.equal(onParent[2].raw, false);
  assert.equal(shownText(onParent[2]), "c");
  const onChild = proseBlocks(nested, 11);
  assert.equal(onChild[0].raw, false);
  assert.equal(shownText(onChild[0]), "a more");
  assert.equal(shownText(onChild[0]).includes("-"), false);
  assert.equal(onChild[1].raw, true);
  assert.equal(shownText(onChild[1]), "  - b");
  assert.equal(onChild[1].classes.includes("md-raw"), true);
  assert.equal(Object.hasOwn(onChild[1], "marker"), false);
  assert.equal(onChild[2].raw, false);
  const onTail = proseBlocks(nested, nested.length);
  assert.equal(shownText(onTail[0]), "a more");
  assert.equal(shownText(onTail[1]), "b");
  assert.equal(shownText(onTail[2]), "c");
  assert.equal(nested, "- a\nmore\n  - b\n- c\n");

  const continued = "- Alpha\n  continues\n  - Beta\n  after\n- Gamma\n";
  assert.equal(continued.length, 45);
  const continuedBlocks = proseBlocks(continued, continued.length);
  assert.equal(continuedBlocks.length, 3);
  assert.equal(shownText(continuedBlocks[0]), "Alpha continues");
  assert.equal(continuedBlocks[0].runs.find((run) => run.start === 7).text, " ");
  assert.equal(continued.slice(8, 10), "  ");
  assert.equal(shownText(continuedBlocks[1]), "Beta after");
  assert.equal(continuedBlocks[1].indent, 2);
  assert.equal(continuedBlocks[1].runs.find((run) => run.start === 28).text, " ");
  assert.equal(shownText(continuedBlocks[2]), "Gamma");
  assert.equal(shownText(continuedBlocks[0]).includes("Beta"), false);
  assert.equal(shownText(continuedBlocks[0]).includes("after"), false);
  const continuedRaw = proseBlocks(continued, 0);
  assert.equal(shownText(continuedRaw[0]), "- Alpha continues");
  assert.equal(shownText(continuedRaw[1]), "Beta after");
  const onBeta = proseBlocks(continued, continued.indexOf("Beta"));
  assert.equal(shownText(onBeta[0]), "Alpha continues");
  assert.equal(shownText(onBeta[1]), "  - Beta after");
  assert.equal(onBeta[1].raw, true);
  assert.equal(Object.hasOwn(onBeta[1], "marker"), false);

  const ordered = "1. Alpha\n2 next\n1) Beta\n";
  assert.equal(ordered.length, 24);
  assert.deepEqual(lockSpans(ordered), [
    { start: 0, end: 15 },
    { start: 16, end: 23 },
  ]);
  const orderedRaw = proseBlocks(ordered, 0);
  assert.equal(orderedRaw.length, 2);
  assert.equal(orderedRaw[0].raw, true);
  assert.deepEqual(orderedRaw[0].classes, ["md-raw", "md-ol"]);
  assert.equal(Object.hasOwn(orderedRaw[0], "marker"), false);
  assert.equal(shownText(orderedRaw[0]), "1. Alpha 2 next");
  assert.equal(orderedRaw[0].runs.filter((run) => run.text.includes("1.")).length, 1);
  assert.equal(shownText(orderedRaw[1]), "Beta");
  assert.equal(orderedRaw[1].marker, "1) ");
  const onTwo = proseBlocks(ordered, ordered.indexOf("2"));
  assert.equal(onTwo.length, 2);
  assert.equal(onTwo[0].raw, true);
  assert.equal(shownText(onTwo[0]), "1. Alpha 2 next");
  assert.equal(Object.hasOwn(onTwo[0], "marker"), false);
  const orderedRendered = proseBlocks(ordered, ordered.length);
  assert.equal(shownText(orderedRendered[0]), "Alpha 2 next");
  assert.equal(shownText(orderedRendered[0]).includes("1."), false);
  assert.equal(orderedRendered[0].marker, "1. ");
  assert.deepEqual(orderedRendered[0].classes, ["md-ol"]);
  assert.equal(orderedRendered[0].runs.find((run) => run.start === 8).text, " ");
  assert.equal(ordered[8], "\n");
  assert.equal(shownText(orderedRendered[1]), "Beta");
  assert.equal(orderedRendered[1].marker, "1) ");

  const nestedOrdered = "1. a\n   2. b\n   more\n";
  const nestedOrderedBlocks = proseBlocks(nestedOrdered, nestedOrdered.length);
  assert.equal(nestedOrderedBlocks.length, 2);
  assert.equal(shownText(nestedOrderedBlocks[0]), "a");
  assert.equal(nestedOrderedBlocks[0].marker, "1. ");
  assert.equal(shownText(nestedOrderedBlocks[0]).includes("more"), false);
  assert.equal(shownText(nestedOrderedBlocks[1]), "b more");
  assert.equal(nestedOrderedBlocks[1].marker, "2. ");
  assert.equal(nestedOrderedBlocks[1].indent, 3);
  const onMore = proseBlocks(nestedOrdered, nestedOrdered.indexOf("more"));
  assert.equal(onMore.length, 2);
  assert.equal(shownText(onMore[0]), "a");
  assert.equal(shownText(onMore[1]), "   2. b more");
  assert.equal(onMore[1].raw, true);
  assert.equal(Object.hasOwn(onMore[1], "marker"), false);

  for (const bullet of ["+", "*"]) {
    const marked = `${bullet} Alpha\nBeta\n`;
    assert.deepEqual(lockSpans(marked), [{ start: 0, end: 12 }]);
    assert.equal(shownText(proseBlocks(marked, 0)[0]), `${bullet} Alpha Beta`);
    assert.equal(shownText(proseBlocks(marked, marked.length)[0]), "Alpha Beta");
    assert.equal(proseBlocks(marked, marked.indexOf("Beta")).length, 1);
    assert.ok(proseBlocks(marked, marked.length)[0].classes.includes("md-li"));
    assert.equal(Object.hasOwn(proseBlocks(marked, marked.length)[0], "marker"), false);
  }

  const tabbed = "\t- Alpha\nmore\n";
  const tabbedRendered = proseBlocks(tabbed, tabbed.length)[0];
  assert.equal(shownText(tabbedRendered), "Alpha more");
  assert.equal(shownText(tabbedRendered).includes("-"), false);
  assert.equal(shownText(tabbedRendered).includes("\t"), false);
  assert.equal(tabbedRendered.indent, 4);
  assert.equal(Object.hasOwn(tabbedRendered, "marker"), false);
  assert.equal(shownText(proseBlocks(tabbed, 0)[0]), "\t- Alpha more");

  const quotedItem = proseBlocks("> - a\n  - b\n", 0);
  assert.equal(quotedItem.length, 2);
  assert.equal(shownText(quotedItem[0]), "- a");
  assert.equal(shownText(quotedItem[1]), "b");

  const headed = proseBlocks("- Alpha\n# H\n", 0);
  assert.equal(headed.length, 2);
  assert.equal(shownText(headed[0]), "- Alpha");
  assert.equal(shownText(headed[1]), "H");

  const ruledDoc = "- Alpha\n---\nBeta\n";
  const ruled = proseBlocks(ruledDoc, ruledDoc.length);
  assert.equal(ruled.length, 3);
  assert.equal(shownText(ruled[0]), "Alpha");
  assert.equal(ruled[1].hr, true);
  assert.equal(shownText(ruled[2]), "Beta");

  const fenced = "- Alpha\n```js\nx\n```\n";
  assert.equal(shownText(proseBlocks(fenced, 0)[0]), "- Alpha");
  assert.equal(proseBlocks(fenced, 0).filter((line) => line.classes.includes("md-codeblock")).length, 1);

  const tableDoc = "- Alpha\n| a |\n| --- |\n| 1 |\n";
  assert.equal(shownText(proseBlocks(tableDoc, 0)[0]), "- Alpha");
  assert.equal(plan(tableDoc, tableDoc.length).blocks.some((block) => block.type === "table"), true);
  assert.equal(doc, "- Alpha\nBeta\n");
});

test("list item hard break hides its marker", () => {
  const spaces = "- red  \nblue\n";
  assert.equal(spaces.length, 13);
  assert.equal(spaces[7], "\n");
  for (const cursor of [0, 7, 8, 12, 13]) {
    const blocks = proseBlocks(spaces, cursor);
    assert.equal(blocks.length, 1);
    assert.ok(blocks[0].classes.includes("md-li"));
    assert.equal(blocks[0].classes.includes("md-p"), false);
    assert.equal(blocks[0].raw, cursor <= 12);
    assert.equal(shownText(blocks[0]), cursor <= 12 ? "- redblue" : "redblue");
  }
  const spacesBlock = proseBlocks(spaces, 0)[0];
  assert.equal(spacesBlock.runs.some((run) => run.text.includes("  ")), false);
  const spacesBreak = spacesBlock.parts.find((part) => part.type === "break");
  assert.equal(spacesBreak.start, 7);
  assert.equal(spacesBreak.end, 8);
  assert.equal(spaces[5], " ");
  assert.equal(spaces[6], " ");
  assert.equal(spaces, "- red  \nblue\n");
  const renderedSpaces = proseBlocks(spaces, spaces.length)[0];
  assert.equal(shownText(renderedSpaces), "redblue");
  assert.equal(renderedSpaces.runs.some((run) => run.text.includes(" ")), false);
  assert.equal(renderedSpaces.runs.some((run) => run.text.includes("-")), false);
  assert.equal(renderedSpaces.parts.find((part) => part.type === "break").start, 7);

  const three = "- red   \nblue\n";
  const threeBlock = proseBlocks(three, three.length)[0];
  assert.equal(shownText(threeBlock), "redblue");
  assert.equal(threeBlock.parts.find((part) => part.type === "break").start, 8);
  assert.equal(shownText(proseBlocks(three, 0)[0]), "- redblue");
  assert.equal(three, "- red   \nblue\n");

  const slash = "- red\\\nblue\n";
  assert.equal(slash.length, 12);
  const slashBlock = proseBlocks(slash, 0)[0];
  assert.equal(shownText(slashBlock), "- redblue");
  assert.equal(slashBlock.runs.some((run) => run.text.includes("\\")), false);
  assert.equal(slashBlock.parts.find((part) => part.type === "break").start, 6);
  assert.equal(slash[5], "\\");
  assert.equal(shownText(proseBlocks(slash, slash.length)[0]), "redblue");
  assert.equal(slash, "- red\\\nblue\n");

  const one = "- red \nblue\n";
  const oneBlock = proseBlocks(one, 0)[0];
  assert.equal(shownText(oneBlock), "- red  blue");
  assert.equal(oneBlock.parts.some((part) => part.type === "break"), false);
  const mapped = oneBlock.runs.find((run) => run.start === 6);
  assert.equal(mapped.text, " ");
  assert.equal(one[6], "\n");
  assert.equal(shownText(proseBlocks(one, one.length)[0]), "red  blue");
  assert.equal(one, "- red \nblue\n");

  const kept = "- red\\ \nblue\n";
  const keptBlock = proseBlocks(kept, 0)[0];
  assert.equal(shownText(keptBlock), "- red\\  blue");
  assert.equal(keptBlock.parts.some((part) => part.type === "break"), false);
  assert.equal(kept[5], "\\");
  assert.equal(shownText(proseBlocks(kept, kept.length)[0]), "red\\  blue");

  const mixed = "- red  \nblue\ngreen\n";
  const mixedBlock = proseBlocks(mixed, 0)[0];
  assert.equal(proseBlocks(mixed, mixed.indexOf("green")).length, 1);
  assert.equal(shownText(mixedBlock), "- redblue green");
  assert.equal(mixedBlock.parts.filter((part) => part.type === "break").length, 1);
  assert.equal(mixedBlock.parts.find((part) => part.type === "break").start, 7);
  const soft = mixedBlock.runs.find((run) => run.start === 12);
  assert.equal(soft.text, " ");
  assert.equal(mixed[12], "\n");
  assert.equal(shownText(proseBlocks(mixed, mixed.length)[0]), "redblue green");

  const tail = "- red\nblue  \n";
  const tailBlock = proseBlocks(tail, 0)[0];
  assert.equal(shownText(tailBlock), "- red blue");
  assert.equal(tailBlock.parts.filter((part) => part.type === "break").length, 1);
  assert.equal(tailBlock.parts.find((part) => part.type === "break").start, 12);
  assert.equal(shownText(proseBlocks(tail, tail.length)[0]), "red blue");
  assert.equal(tail, "- red\nblue  \n");

  const markerSpace = "-  \nblue\n";
  assert.equal(markerSpace[1], " ");
  assert.equal(markerSpace[2], " ");
  assert.equal(markerSpace[3], "\n");
  const markerBlock = proseBlocks(markerSpace, 0)[0];
  assert.equal(markerBlock.parts.some((part) => part.type === "break"), false);
  assert.equal(shownText(markerBlock), "-   blue");
  assert.equal(shownText(proseBlocks(markerSpace, markerSpace.length)[0]), " blue");

  const separator = "-     x\nmore\n";
  const separatorBlock = proseBlocks(separator, separator.length)[0];
  assert.equal(separatorBlock.parts.some((part) => part.type === "break"), false);
  assert.equal(shownText(separatorBlock), " x more");
  assert.equal(shownText(proseBlocks(separator, 0)[0]), "-     x more");

  const numbered = "1. alpha  \nbeta\n";
  assert.equal(shownText(proseBlocks(numbered, 0)[0]), "1. alphabeta");
  assert.equal(shownText(proseBlocks(numbered, numbered.length)[0]), "alphabeta");
  assert.equal(proseBlocks(numbered, 0)[0].parts.find((part) => part.type === "break").start, 10);
  assert.equal(proseBlocks(numbered, numbered.length)[0].marker, "1. ");
  assert.equal(numbered, "1. alpha  \nbeta\n");

  const numberOnly = "1. \nbeta\n";
  assert.equal(proseBlocks(numberOnly, 0)[0].parts.some((part) => part.type === "break"), false);
  assert.equal(shownText(proseBlocks(numberOnly, 0)[0]), "1.  beta");
  assert.equal(shownText(proseBlocks(numberOnly, numberOnly.length)[0]), " beta");
  assert.equal(proseBlocks(numberOnly, numberOnly.length)[0].marker, "1. ");
});

test("list item maps the joining space and keeps the source", () => {
  const mounted = mountEditor();
  globalThis.NodeFilter = globalThis.NodeFilter || { SHOW_TEXT: 4 };
  const doc = "- Alpha\nBeta\n";
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
  const press = (inputType, data) => {
    mounted.listeners.beforeinput({
      inputType,
      data,
      preventDefault() {},
    });
  };
  try {
    for (const cursor of [0, 7, 8]) {
      const view = createEditor(mounted.root, doc, cursor);
      const lines = mounted.findAll((node) => node.classList && node.classList.contains("md-line") && node.classList.contains("md-li"));
      assert.equal(lines.length, 1);
      assert.equal(lines[0].textContent.includes("Alpha"), true);
      assert.equal(lines[0].textContent.includes("Beta"), true);
      assert.equal(lines[0].textContent.includes("\n"), false);
      assert.equal(lines[0].textContent.includes("-"), true);
      assert.equal(lines[0].classList.contains("md-raw"), true);
      assert.equal(lines[0].dataset.marker, undefined);
      assert.equal(view.getState().doc, doc);
      view.destroy();
    }

    const rendered = createEditor(mounted.root, doc, doc.length);
    const renderedLines = mounted.findAll((node) => node.classList && node.classList.contains("md-line") && node.classList.contains("md-li"));
    assert.equal(renderedLines.length, 1);
    assert.equal(renderedLines[0].textContent, "Alpha Beta");
    assert.equal(renderedLines[0].classList.contains("md-raw"), false);
    assert.equal(renderedLines[0].dataset.marker, undefined);
    assert.equal(rendered.getState().doc, doc);
    rendered.destroy();

    const view = createEditor(mounted.root, doc, 0);
    const space = mounted.findAll((node) => node.nodeType === 3 && node.textContent === " ")[0];
    assert.ok(space);
    assert.equal(mapOffset(space, 0), 7);
    assert.equal(view.getState().doc[mapOffset(space, 0)], "\n");
    assert.equal(mapOffset(space, 1), 8);
    caret(space, 1);
    press("deleteContentBackward");
    assert.equal(view.getState().doc, "- AlphaBeta\n");
    assert.equal(view.getState().cursor, 7);
    view.destroy();

    const typing = createEditor(mounted.root, doc, 0);
    const again = mounted.findAll((node) => node.nodeType === 3 && node.textContent === " ")[0];
    caret(again, 0);
    press("insertText", "X");
    assert.equal(typing.getState().doc, "- AlphaX\nBeta\n");
    assert.equal(typing.getState().cursor, 8);
    typing.destroy();

    const hard = createEditor(mounted.root, "- red  \nblue\n", 0);
    const br = mounted.findAll((node) => node.tagName === "BR" && node.parentElement && node.parentElement.dataset.start === "7")[0];
    assert.ok(br);
    assert.equal(mapOffset(br, 0), 7);
    assert.equal(hard.getState().doc[7], "\n");
    const blue = mounted.findAll((node) => node.nodeType === 3 && node.textContent === "blue")[0];
    caret(blue, 0);
    press("deleteContentBackward");
    assert.equal(hard.getState().doc, "- redblue\n");
    assert.equal(hard.getState().cursor, 5);
    hard.destroy();

    const orderedDoc = "1. Alpha\nBeta\n";
    const orderedRaw = createEditor(mounted.root, orderedDoc, 0);
    const rawOrdered = mounted.findAll((node) => node.classList && node.classList.contains("md-line") && node.classList.contains("md-ol"));
    assert.equal(rawOrdered.length, 1);
    assert.equal(rawOrdered[0].textContent, "1. Alpha Beta");
    assert.equal(rawOrdered[0].dataset.marker, undefined);
    assert.equal(rawOrdered[0].classList.contains("md-raw"), true);
    assert.equal(orderedRaw.getState().doc, orderedDoc);
    orderedRaw.destroy();

    const ordered = createEditor(mounted.root, orderedDoc, orderedDoc.length);
    const orderedLines = mounted.findAll((node) => node.classList && node.classList.contains("md-line") && node.classList.contains("md-ol"));
    assert.equal(orderedLines.length, 1);
    assert.equal(orderedLines[0].textContent, "Alpha Beta");
    assert.equal(orderedLines[0].dataset.marker, "1. ");
    assert.equal(orderedLines[0].classList.contains("md-raw"), false);
    assert.equal(ordered.getState().doc, orderedDoc);
    ordered.destroy();

    const nestedDoc = "- a\nmore\n  - b\n- c\n";
    const nested = createEditor(mounted.root, nestedDoc, 0);
    const items = mounted.findAll((node) => node.classList && node.classList.contains("md-line") && node.classList.contains("md-li"));
    assert.equal(items.length, 3);
    assert.equal(items[0].textContent, "- a more");
    assert.equal(items[0].textContent.includes("b"), false);
    assert.equal(items[1].textContent, "b");
    assert.equal(items[1].styleProps["--indent"], "2");
    assert.equal(items[2].textContent, "c");
    assert.equal(nested.getState().doc, nestedDoc);
    nested.destroy();
  } finally {
    mounted.restore();
  }
});

test("bwx2b8ru numbered continuation reflow", () => {
  const doc = "1. alpha\n   continues\n";
  assert.equal(doc[8], "\n");
  assert.equal(doc.slice(9, 12), "   ");
  const rawBlocks = proseBlocks(doc, 0);
  const renderedBlocks = proseBlocks(doc, doc.length);
  assert.equal(shownText(rawBlocks[0]), "1. alpha continues");
  assert.equal(shownText(renderedBlocks[0]), "alpha continues");
  for (const block of [rawBlocks[0], renderedBlocks[0]]) {
    assert.ok(block.parts.some((part) => part.start <= 8 && 8 < part.end));
    assert.ok(block.parts.some((part) => part.start <= 9 && part.end > 11));
  }
  const mounted = mountEditor();
  globalThis.NodeFilter = globalThis.NodeFilter || { SHOW_TEXT: 4 };
  try {
    const view = createEditor(mounted.root, doc, 0);
    const lines = mounted.findAll((node) => node.classList && node.classList.contains("md-line") && node.classList.contains("md-ol"));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].textContent.split("\u200b").join(""), "1. alpha continues");
    const space = mounted.findAll((node) => node.nodeType === 3 && node.textContent === " ")[0];
    assert.ok(space);
    assert.equal(mapOffset(space, 0), 8);
    const indent = mounted.findAll((node) => node.nodeType === 3 && node.textContent === "\u200b\u200b\u200b")[0];
    assert.ok(indent);
    assert.equal(mapOffset(indent, 0), 9);
    assert.equal(mapOffset(indent, 1), 10);
    assert.equal(view.getState().doc, doc);
    view.destroy();
  } finally {
    mounted.restore();
  }
  assert.equal(doc, "1. alpha\n   continues\n");
});

test("w3hccq8y bullet continuation reflow", () => {
  const doc = "x\n\n- alpha\n  beta\n";
  assert.equal(doc[10], "\n");
  assert.equal(doc.slice(11, 13), "  ");
  const outside = proseBlocks(doc, 0);
  const rendered = outside.find((block) => block.classes.includes("md-li"));
  assert.equal(shownText(rendered), "alpha beta");
  const inside = proseBlocks(doc, doc.indexOf("-"));
  const raw = inside.find((block) => block.classes.includes("md-li"));
  assert.equal(shownText(raw), "- alpha beta");
  for (const block of [rendered, raw]) {
    assert.ok(block.parts.some((part) => part.start <= 10 && 10 < part.end));
    assert.ok(block.parts.some((part) => part.start <= 11 && part.end > 12));
  }
  const mounted = mountEditor();
  globalThis.NodeFilter = globalThis.NodeFilter || { SHOW_TEXT: 4 };
  try {
    const view = createEditor(mounted.root, doc, 0);
    const lines = mounted.findAll((node) => node.classList && node.classList.contains("md-line") && node.classList.contains("md-li"));
    assert.equal(lines.length, 1);
    assert.ok(lines[0].textContent.split("\u200b").join("").includes("alpha beta"));
    const space = mounted.findAll((node) => node.nodeType === 3 && node.textContent === " ")[0];
    assert.ok(space);
    assert.equal(mapOffset(space, 0), 10);
    const indent = mounted.findAll((node) => node.nodeType === 3 && node.textContent === "\u200b\u200b")[0];
    assert.ok(indent);
    assert.equal(mapOffset(indent, 0), 11);
    assert.equal(mapOffset(indent, 1), 12);
    assert.equal(view.getState().doc, doc);
    view.destroy();
  } finally {
    mounted.restore();
  }
  assert.equal(doc, "x\n\n- alpha\n  beta\n");
});

test("quoted item is one block", () => {
  const doc = "> - Alpha\nBeta\n";
  assert.equal(doc.length, 15);
  assert.equal(doc[9], "\n");
  assert.equal(doc[14], "\n");
  assert.deepEqual(lockSpans(doc), [{ start: 0, end: 14 }]);
  const shown = [];
  for (const cursor of [0, 2, 4, 9, 10, 14, 15]) {
    const blocks = proseBlocks(doc, cursor);
    assert.equal(blocks.length, 1);
    const block = blocks[0];
    assert.equal(block.start, 0);
    assert.equal(block.end, 14);
    assert.equal(block.raw, cursor <= 14);
    assert.deepEqual(block.classes, cursor <= 14 ? ["md-raw", "md-quote", "md-li"] : ["md-quote", "md-li"]);
    assert.equal(Object.hasOwn(block, "marker"), false);
    assert.equal(block.indent, 0);
    assert.equal(shownText(block), cursor <= 14 ? "- Alpha Beta" : "Alpha Beta");
    assert.equal(shownText(block).includes(">"), false);
    assert.equal(shownText(block).includes("\n"), false);
    const space = block.runs.find((run) => run.start === 9);
    assert.equal(space.text, " ");
    assert.equal(space.end, 10);
    assert.equal(doc[space.start], "\n");
    assert.ok(space.classes.includes("md-li"));
    if (cursor <= 14) {
      assert.equal(block.runs.filter((run) => run.text.includes("-")).length, 1);
      assert.equal(block.runs[0].text.startsWith("- "), true);
    } else {
      assert.equal(shownText(block).includes("-"), false);
      const alpha = block.runs.find((run) => run.text === "Alpha");
      assert.equal(alpha.start, 4);
      assert.equal(alpha.end, 9);
      assert.ok(alpha.classes.includes("md-li"));
    }
    const beta = block.runs.find((run) => run.text === "Beta");
    assert.equal(beta.start, 10);
    assert.equal(beta.end, 14);
    for (const run of block.runs) assert.equal(run.text.length, run.end - run.start);
    shown.push(shownText(block));
  }
  assert.deepEqual(shown, [
    "- Alpha Beta",
    "- Alpha Beta",
    "- Alpha Beta",
    "- Alpha Beta",
    "- Alpha Beta",
    "- Alpha Beta",
    "Alpha Beta",
  ]);
  assert.equal(doc, "> - Alpha\nBeta\n");

  const bare = "> - Alpha\nBeta";
  assert.equal(proseBlocks(bare, 0).length, 1);
  assert.equal(proseBlocks(bare, bare.length).length, 1);
  assert.equal(shownText(proseBlocks(bare, bare.length)[0]), "- Alpha Beta");
  assert.equal(proseBlocks(bare, bare.length)[0].raw, true);
  assert.equal(proseBlocks(bare, bare.length)[0].end, bare.length);

  const one = "> - a\n";
  const oneRaw = proseBlocks(one, 0)[0];
  assert.equal(shownText(oneRaw), "- a");
  assert.equal(shownText(oneRaw).includes(">"), false);
  assert.deepEqual(oneRaw.classes, ["md-raw", "md-quote", "md-li"]);
  assert.equal(Object.hasOwn(oneRaw, "marker"), false);
  const oneRendered = proseBlocks(one, one.length)[0];
  assert.equal(shownText(oneRendered), "a");
  assert.equal(shownText(oneRendered).includes("-"), false);
  assert.equal(shownText(oneRendered).includes(">"), false);
  assert.deepEqual(oneRendered.classes, ["md-quote", "md-li"]);

  for (const bullet of ["+", "*"]) {
    const marked = `> ${bullet} Alpha\nBeta\n`;
    assert.deepEqual(lockSpans(marked), [{ start: 0, end: 14 }]);
    assert.equal(shownText(proseBlocks(marked, 0)[0]), `${bullet} Alpha Beta`);
    assert.equal(shownText(proseBlocks(marked, 0)[0]).includes(">"), false);
    assert.equal(proseBlocks(marked, 0)[0].runs.filter((run) => run.text.includes(bullet)).length, 1);
    const markedRendered = proseBlocks(marked, marked.length)[0];
    assert.equal(shownText(markedRendered), "Alpha Beta");
    assert.equal(shownText(markedRendered).includes(bullet), false);
    assert.equal(shownText(markedRendered).includes(">"), false);
    assert.deepEqual(markedRendered.classes, ["md-quote", "md-li"]);
    assert.equal(Object.hasOwn(markedRendered, "marker"), false);
  }

  const ordered = "> 1. Alpha\nmore\n";
  assert.equal(ordered.length, 16);
  assert.deepEqual(lockSpans(ordered), [{ start: 0, end: 15 }]);
  const orderedRaw = proseBlocks(ordered, 0)[0];
  assert.equal(proseBlocks(ordered, 0).length, 1);
  assert.equal(orderedRaw.raw, true);
  assert.deepEqual(orderedRaw.classes, ["md-raw", "md-quote", "md-ol"]);
  assert.equal(Object.hasOwn(orderedRaw, "marker"), false);
  assert.equal(shownText(orderedRaw), "1. Alpha more");
  assert.equal(shownText(orderedRaw).includes(">"), false);
  assert.equal(orderedRaw.runs.filter((run) => run.text.includes("1.")).length, 1);
  const orderedSpace = orderedRaw.runs.find((run) => run.start === 10);
  assert.equal(orderedSpace.text, " ");
  assert.equal(ordered[10], "\n");
  const orderedRendered = proseBlocks(ordered, ordered.length)[0];
  assert.equal(shownText(orderedRendered), "Alpha more");
  assert.equal(shownText(orderedRendered).includes("1."), false);
  assert.equal(shownText(orderedRendered).includes(">"), false);
  assert.equal(orderedRendered.marker, "1. ");
  assert.deepEqual(orderedRendered.classes, ["md-quote", "md-ol"]);
  assert.equal(orderedRendered.runs.find((run) => run.text === "Alpha").start, 5);

  const orderedLine = "> 1. a\n";
  assert.equal(shownText(proseBlocks(orderedLine, 0)[0]), "1. a");
  assert.equal(shownText(proseBlocks(orderedLine, 0)[0]).includes(">"), false);
  assert.deepEqual(proseBlocks(orderedLine, 0)[0].classes, ["md-raw", "md-quote", "md-ol"]);
  assert.equal(Object.hasOwn(proseBlocks(orderedLine, 0)[0], "marker"), false);
  assert.equal(shownText(proseBlocks(orderedLine, orderedLine.length)[0]), "a");
  assert.equal(proseBlocks(orderedLine, orderedLine.length)[0].marker, "1. ");
  assert.deepEqual(proseBlocks(orderedLine, orderedLine.length)[0].classes, ["md-quote", "md-ol"]);

  const paren = "> 1) Alpha\nmore\n";
  assert.deepEqual(lockSpans(paren), [{ start: 0, end: 15 }]);
  assert.equal(shownText(proseBlocks(paren, 0)[0]), "1) Alpha more");
  assert.equal(shownText(proseBlocks(paren, 0)[0]).includes(">"), false);
  assert.equal(proseBlocks(paren, paren.length)[0].marker, "1) ");
  assert.equal(shownText(proseBlocks(paren, paren.length)[0]), "Alpha more");
  assert.ok(proseBlocks(paren, paren.length)[0].classes.includes("md-quote"));
  assert.ok(proseBlocks(paren, paren.length)[0].classes.includes("md-ol"));

  const wide = "> 10. Alpha\nmore\n";
  assert.equal(shownText(proseBlocks(wide, 0)[0]), "10. Alpha more");
  assert.equal(proseBlocks(wide, wide.length)[0].marker, "10. ");
  assert.equal(shownText(proseBlocks(wide, wide.length)[0]), "Alpha more");
  assert.equal(shownText(proseBlocks(wide, wide.length)[0]).includes(">"), false);

  const notItem = "> -Alpha\n";
  const notBlock = proseBlocks(notItem, 0)[0];
  assert.deepEqual(notBlock.classes, ["md-raw", "md-quote"]);
  assert.equal(shownText(notBlock), "> -Alpha");
  assert.equal(shownText(proseBlocks(notItem, notItem.length)[0]), "-Alpha");
  assert.equal(proseBlocks(notItem, notItem.length)[0].classes.includes("md-li"), false);

  const indented = ">   - child\n";
  const indentedRaw = proseBlocks(indented, 0)[0];
  assert.equal(shownText(indentedRaw), "  - child");
  assert.equal(shownText(indentedRaw).includes(">"), false);
  assert.deepEqual(indentedRaw.classes, ["md-raw", "md-quote", "md-li"]);
  assert.equal(indentedRaw.indent, 2);
  const indentedRendered = proseBlocks(indented, indented.length)[0];
  assert.equal(shownText(indentedRendered), "child");
  assert.equal(shownText(indentedRendered).includes("-"), false);
  assert.equal(shownText(indentedRendered).includes(">"), false);
  assert.deepEqual(indentedRendered.classes, ["md-quote", "md-li"]);
  assert.equal(indentedRendered.indent, 2);

  const spaces = "> - red  \nblue\n";
  assert.equal(shownText(proseBlocks(spaces, 0)[0]), "- redblue");
  assert.equal(shownText(proseBlocks(spaces, 0)[0]).includes(">"), false);
  assert.equal(proseBlocks(spaces, 0)[0].parts.find((part) => part.type === "break").start, 9);
  assert.equal(shownText(proseBlocks(spaces, spaces.length)[0]), "redblue");
  assert.equal(shownText(proseBlocks(spaces, spaces.length)[0]).includes("-"), false);
  assert.equal(shownText(proseBlocks(spaces, spaces.length)[0]).includes(">"), false);

  const soft = "> - red \nblue\n";
  assert.equal(shownText(proseBlocks(soft, 0)[0]), "- red  blue");
  assert.equal(proseBlocks(soft, 0)[0].parts.some((part) => part.type === "break"), false);
  assert.equal(shownText(proseBlocks(soft, soft.length)[0]), "red  blue");

  const mounted = mountEditor();
  globalThis.NodeFilter = globalThis.NodeFilter || { SHOW_TEXT: 4 };
  try {
    const rawView = createEditor(mounted.root, doc, 0);
    const rawLine = mounted.findAll((node) => node.classList && node.classList.contains("md-line") && node.classList.contains("md-quote"));
    assert.equal(rawLine.length, 1);
    assert.ok(rawLine[0].classList.contains("md-li"));
    assert.ok(rawLine[0].classList.contains("md-raw"));
    assert.equal(rawLine[0].textContent, "- Alpha Beta");
    assert.equal(rawLine[0].textContent.includes(">"), false);
    assert.equal(rawLine[0].dataset.marker, undefined);
    assert.equal(rawView.getState().doc, doc);
    rawView.destroy();

    const renderedView = createEditor(mounted.root, doc, doc.length);
    const renderedLine = mounted.findAll((node) => node.classList && node.classList.contains("md-line") && node.classList.contains("md-quote"));
    assert.equal(renderedLine.length, 1);
    assert.ok(renderedLine[0].classList.contains("md-li"));
    assert.equal(renderedLine[0].classList.contains("md-raw"), false);
    assert.equal(renderedLine[0].textContent, "Alpha Beta");
    assert.equal(renderedLine[0].textContent.includes("-"), false);
    assert.equal(renderedLine[0].textContent.includes(">"), false);
    assert.equal(renderedLine[0].dataset.marker, undefined);
    assert.equal(renderedView.getState().doc, doc);
    renderedView.destroy();

    const orderedView = createEditor(mounted.root, ordered, ordered.length);
    const orderedLineEl = mounted.findAll((node) => node.classList && node.classList.contains("md-line") && node.classList.contains("md-ol"));
    assert.equal(orderedLineEl.length, 1);
    assert.ok(orderedLineEl[0].classList.contains("md-quote"));
    assert.equal(orderedLineEl[0].classList.contains("md-raw"), false);
    assert.equal(orderedLineEl[0].textContent, "Alpha more");
    assert.equal(orderedLineEl[0].dataset.marker, "1. ");
    assert.equal(orderedView.getState().doc, ordered);
    orderedView.destroy();

    const orderedRawView = createEditor(mounted.root, ordered, 0);
    const orderedRawEl = mounted.findAll((node) => node.classList && node.classList.contains("md-line") && node.classList.contains("md-ol"));
    assert.equal(orderedRawEl.length, 1);
    assert.ok(orderedRawEl[0].classList.contains("md-quote"));
    assert.ok(orderedRawEl[0].classList.contains("md-raw"));
    assert.equal(orderedRawEl[0].textContent, "1. Alpha more");
    assert.equal(orderedRawEl[0].textContent.includes(">"), false);
    assert.equal(orderedRawEl[0].dataset.marker, undefined);
    orderedRawView.destroy();
  } finally {
    mounted.restore();
  }
});

test("a quoted list keeps the bar with the parent quote", () => {
  const doc = "> Parent\n> - alpha\n> - beta\n>   - child\n> 1. one\n";
  assert.equal(doc.length, 49);
  const blocks = plan(doc, doc.length).blocks;
  assert.equal(blocks.length, 5);
  assert.equal(blocks.some((block) => block.raw), false);
  assert.equal(shownText(blocks[0]), "Parent");
  assert.deepEqual(blocks[0].classes, ["md-quote"]);
  assert.equal(blocks[0].classes.includes("md-li"), false);
  assert.equal(blocks[0].classes.includes("md-ol"), false);
  assert.equal(shownText(blocks[1]), "alpha");
  assert.equal(shownText(blocks[2]), "beta");
  assert.equal(shownText(blocks[3]), "child");
  assert.equal(shownText(blocks[4]), "one");
  for (const block of blocks) assert.ok(block.classes.includes("md-quote"));
  assert.ok(blocks[1].classes.includes("md-li"));
  assert.ok(blocks[2].classes.includes("md-li"));
  assert.ok(blocks[3].classes.includes("md-li"));
  assert.ok(blocks[4].classes.includes("md-ol"));
  assert.equal(blocks[1].indent, 0);
  assert.ok(blocks[3].indent > blocks[1].indent);
  assert.equal(blocks[4].marker.trimEnd(), "1.");
  assert.equal(blocks[0].end < blocks[1].start, true);
  assert.equal(blocks[1].end < blocks[2].start, true);
  assert.equal(blocks[2].end < blocks[3].start, true);
  assert.equal(blocks[3].end < blocks[4].start, true);

  const plain = "- a\n  - b\n1. c\n";
  const plainBlocks = plan(plain, plain.length).blocks;
  assert.equal(plainBlocks.length, 3);
  for (const block of plainBlocks) assert.equal(block.classes.includes("md-quote"), false);
  assert.ok(plainBlocks[1].indent > plainBlocks[0].indent);
  assert.ok(plainBlocks[2].classes.includes("md-ol"));
  assert.equal(shownText(plainBlocks[0]), "a");
  assert.equal(shownText(plainBlocks[1]), "b");
  assert.equal(shownText(plainBlocks[2]), "c");

  const continued = "- a\n  more\n";
  const continuedBlocks = plan(continued, continued.length).blocks;
  assert.equal(continuedBlocks.length, 1);
  assert.ok(continuedBlocks[0].classes.includes("md-li"));
  assert.equal(shownText(continuedBlocks[0]).includes("more"), true);
  assert.equal(shownText(continuedBlocks[0]).includes("-"), false);

  const prose = "-Alpha\n";
  const proseBlocksAtEnd = plan(prose, prose.length).blocks;
  assert.equal(proseBlocksAtEnd.length, 1);
  assert.equal(proseBlocksAtEnd[0].classes.includes("md-li"), false);
  assert.equal(proseBlocksAtEnd[0].classes.includes("md-p"), true);
  assert.equal(shownText(proseBlocksAtEnd[0]), "-Alpha");

  const css = readFileSync(new URL("../editor.css", import.meta.url), "utf8");
  const quotedItem = css.match(/\.md-line\.md-quote\.md-li\s*,\s*\.md-line\.md-quote\.md-ol\s*\{[^}]*\}/);
  assert.ok(quotedItem);
  assert.match(quotedItem[0], /margin-left:\s*0\s*;/);
  assert.match(quotedItem[0], /padding-left:[^;]*var\(--indent/);
  assert.equal(/margin-left:[^;]*var\(--indent/.test(quotedItem[0]), false);

  const mounted = mountEditor();
  try {
    const view = createEditor(mounted.root, doc, doc.length);
    const lines = mounted.findAll((node) => node.classList && node.classList.contains("md-line"));
    // The caret is past the final newline, so the empty line is drawn after the quotes.
    assert.equal(lines.length, 6);
    for (const line of lines.slice(0, 5)) assert.ok(line.classList.contains("md-quote"));
    assert.equal(lines[5].classList.contains("md-quote"), false);
    assert.equal(lines[5].dataset.start, String(doc.length));
    assert.equal(lines[5].dataset.end, String(doc.length));
    assert.equal(lines[0].classList.contains("md-li"), false);
    assert.equal(lines[3].classList.contains("md-li"), true);
    assert.ok(Number(lines[3].styleProps["--indent"]) > Number(lines[1].styleProps["--indent"]));
    assert.equal(lines[4].classList.contains("md-ol"), true);
    assert.equal(String(lines[4].dataset.marker).trimEnd(), "1.");
    assert.equal(view.getState().doc, doc);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("quoted item child is not quoted", () => {
  const doc = "> - a\n  - b\n";
  assert.deepEqual(lockSpans(doc), [
    { start: 0, end: 5 },
    { start: 6, end: 11 },
  ]);
  const atParent = proseBlocks(doc, 0);
  assert.equal(atParent.length, 2);
  assert.equal(shownText(atParent[0]), "- a");
  assert.equal(shownText(atParent[0]).includes(">"), false);
  assert.equal(shownText(atParent[0]).includes("b"), false);
  assert.deepEqual(atParent[0].classes, ["md-raw", "md-quote", "md-li"]);
  assert.equal(atParent[0].end, 5);
  assert.equal(atParent[1].raw, false);
  assert.equal(shownText(atParent[1]), "b");
  assert.equal(shownText(atParent[1]).includes("-"), false);
  assert.equal(atParent[1].classes.includes("md-quote"), false);
  assert.deepEqual(atParent[1].classes, ["md-li"]);
  assert.equal(atParent[1].indent, 2);
  assert.equal(atParent[0].indent, 0);
  assert.equal(atParent[1].start, 6);

  const onChild = proseBlocks(doc, 8);
  assert.equal(shownText(onChild[0]), "a");
  assert.equal(shownText(onChild[0]).includes(">"), false);
  assert.equal(shownText(onChild[0]).includes("-"), false);
  assert.ok(onChild[0].classes.includes("md-quote"));
  assert.ok(onChild[0].classes.includes("md-li"));
  assert.equal(onChild[0].raw, false);
  assert.equal(shownText(onChild[1]), "  - b");
  assert.equal(onChild[1].raw, true);
  assert.equal(onChild[1].classes.includes("md-quote"), false);
  assert.ok(onChild[1].classes.includes("md-raw"));
  assert.equal(shownText(onChild[0]).includes("b"), false);

  const nested = "> - Alpha\n  - Beta\nGamma\n";
  assert.equal(nested.length, 25);
  assert.deepEqual(lockSpans(nested), [
    { start: 0, end: 9 },
    { start: 10, end: 24 },
  ]);
  const blocks = proseBlocks(nested, 0);
  assert.equal(blocks.length, 2);
  assert.equal(shownText(blocks[0]), "- Alpha");
  assert.equal(shownText(blocks[0]).includes("Beta"), false);
  assert.equal(shownText(blocks[0]).includes("Gamma"), false);
  assert.equal(blocks[0].end, 9);
  assert.equal(shownText(blocks[1]), "Beta Gamma");
  assert.equal(blocks[1].start, 10);
  assert.equal(blocks[1].end, 24);
  assert.equal(blocks[1].classes.includes("md-quote"), false);
  const join = blocks[1].runs.find((run) => run.start === 18);
  assert.equal(join.text, " ");
  assert.equal(nested[18], "\n");
  assert.equal(blocks[1].indent, 2);

  const sibling = "> - Alpha\n- Beta\n";
  assert.deepEqual(lockSpans(sibling), [
    { start: 0, end: 9 },
    { start: 10, end: 16 },
  ]);
  const sib = proseBlocks(sibling, sibling.length);
  assert.equal(sib.length, 2);
  assert.equal(shownText(sib[0]), "Alpha");
  assert.ok(sib[0].classes.includes("md-quote"));
  assert.ok(sib[0].classes.includes("md-li"));
  assert.equal(shownText(sib[0]).includes("Beta"), false);
  assert.equal(shownText(sib[1]), "Beta");
  assert.equal(sib[1].classes.includes("md-quote"), false);
  assert.ok(sib[1].classes.includes("md-li"));
  assert.equal(doc, "> - a\n  - b\n");
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

test("backspace on the empty line Enter leaves under a paragraph restores it", () => {
  const doc = "hello\n\n\n";
  assert.equal(doc.length, 8);
  assert.equal(enterInsert("hello\n", 5).text, "\n\n");
  const next = backspace(createState(doc, 7));
  assert.equal(next.doc, "hello\n");
  assert.equal(next.cursor, 5);
  assert.equal(next.anchor, 5);
  const returned = backspace(createState(doc, 7));
  assert.equal(returned.doc, "hello\n");
  assert.equal(returned.cursor, 5);
  assert.equal(backspace(createState("hello\n", 3)).doc, "helo\n");
  assert.equal(backspace(createState("- ab\n", 4)).doc, "- a\n");
  assert.equal(backspace(createState("> ab\n", 4)).doc, "> a\n");
  const split = "hello\n\n world\n";
  assert.equal(split[7], " ");
  const inside = backspace(createState(split, 7));
  assert.equal(inside.doc, "hello\n world\n");
  assert.equal(inside.cursor, 6);
});

test("collapsed caret removes a blank line and keeps a joining newline", () => {
  const between = "Title\n\nBody\n";
  assert.equal(between[5], "\n");
  assert.equal(between[6], "\n");
  assert.equal(between[7], "B");
  const backBetween = backspace(createState(between, 6));
  assert.equal(backBetween.doc, "Title\nBody\n");
  assert.equal(backBetween.cursor, 5);
  assert.equal(backBetween.anchor, 5);
  assert.equal(backBetween.doc[backBetween.cursor], "\n");
  const delBetween = deleteForward(createState(between, 6));
  assert.equal(delBetween.doc, "Title\nBody\n");
  assert.equal(delBetween.cursor, 6);
  assert.equal(delBetween.anchor, 6);
  assert.equal(delBetween.doc[delBetween.cursor], "B");

  const last = "Title\n\n";
  assert.equal(last.length, 7);
  const backLast = backspace(createState(last, 6));
  assert.equal(backLast.doc, "Title\n");
  assert.equal(backLast.cursor, 5);
  assert.equal(backLast.doc[backLast.cursor], "\n");
  const delLast = deleteForward(createState(last, 6));
  assert.equal(delLast.doc, "Title\n");
  assert.equal(delLast.cursor, 5);
  assert.equal(delLast.anchor, 5);
  assert.equal(delLast.doc[delLast.cursor], "\n");

  const leading = createState("\nBody", 0);
  assert.equal(backspace(leading), leading);
  const delLead = deleteForward(leading);
  assert.equal(delLead.doc, "Body");
  assert.equal(delLead.cursor, 0);
  assert.equal(delLead.anchor, 0);

  const joined = "hello\nworld";
  const backWord = backspace(createState(joined, 6));
  assert.equal(backWord.doc, "helloworld");
  assert.equal(backWord.cursor, 5);
  const delWord = deleteForward(createState(joined, 6));
  assert.equal(delWord.doc, "hello\norld");
  assert.equal(delWord.cursor, 6);
  assert.equal(delWord.doc[delWord.cursor], "o");

  const backBreak = backspace(createState(joined, 5));
  assert.equal(backBreak.doc, "hell\nworld");
  assert.equal(backBreak.cursor, 4);
  const delBreak = deleteForward(createState(joined, 5));
  assert.equal(delBreak.doc, "helloworld");
  assert.equal(delBreak.cursor, 5);
});

test("T-backspace-atom", () => {
  // The caret on the newline after the last row is inside the atom, so backspace
  // deletes one source character.
  let s = createState(D, 33);
  s = backspace(s);
  assert.equal(s.doc, "| a | b |\n| --- | --- |\n| 1 | 2 \n");
  assert.equal(s.cursor, 32);

  s = createState(D, 33, 0);
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

const CM_FENCE = "\n\n```comment c1\n:: 0\n@2026-10-05T16:00:00.000Z Ada\nNote.\n```\n";
const CM_DOC = `See {c1}this{/c1} now.${CM_FENCE}`;

function bothMarkers(next) {
  assert.ok(next);
  assert.equal(next.doc.includes("{c1}"), true);
  assert.equal(next.doc.includes("{/c1}"), true);
  assert.equal(next.doc.includes("```comment c1"), true);
  assert.equal(next.changes[0].removed.includes("{c1}"), false);
  assert.equal(next.changes[0].removed.includes("{/c1}"), false);
}

test("BS.cm.2", () => {
  const next = backspace(createState(CM_DOC, 8));
  bothMarkers(next);
  assert.equal(next.doc, `See{c1}this{/c1} now.${CM_FENCE}`);
  assert.equal(next.cursor, 7);
  assert.equal(next.anchor, 7);
});

test("BS.cm.4", () => {
  const next = backspace(createState(CM_DOC, 17));
  bothMarkers(next);
  assert.equal(next.doc, `See {c1}thi{/c1} now.${CM_FENCE}`);
  assert.equal(next.cursor, 16);
  assert.equal(next.anchor, 16);
});

test("DL.cm.2", () => {
  const next = deleteForward(createState(CM_DOC, 12));
  bothMarkers(next);
  assert.equal(next.doc, `See {c1}this{/c1}now.${CM_FENCE}`);
  assert.equal(next.cursor, 12);
  assert.equal(next.anchor, 12);
});

test("SX.10", () => {
  const next = backspace(createState(CM_DOC, 10, 0));
  assert.ok(next);
  assert.equal(next.doc, `{c1}is{/c1} now.${CM_FENCE}`);
  assert.equal(next.cursor, 0);
  assert.equal(next.anchor, 0);
  assert.equal(next.changes[0].inserted, "{c1}");
  assert.equal(next.doc.includes("{/c1}"), true);
  assert.equal(next.doc.includes("```comment c1"), true);
});

test("BG.ws.3", () => {
  const doc = "a  \n  \nb\n";
  assert.equal(doc[4], " ");
  assert.equal(doc[6], "\n");
  for (const cursor of [4, 6]) {
    const next = backspace(createState(doc, cursor));
    assert.equal(next.doc, "a  \nb\n");
    assert.equal(next.cursor, 1);
    assert.equal(next.anchor, 1);
  }
  const blocks = plan(doc, 4).blocks;
  const slot = blocks.find((block) => block.slot === 4);
  assert.ok(slot);
  assert.equal(slot.start, 4);
  assert.equal(blocks.filter((block) => block.type === "line").length, 3);
  // Deleting the character in front of that newline leaves the caret on it.
  const probed = backspace(createState("a  \n  x\nb\n", 7));
  assert.equal(probed.doc, doc);
  assert.equal(probed.cursor, 6);
  assert.equal(lineCaret(doc, 4), 4);
  assert.equal(lineCaret(doc, 5), 4);
  assert.equal(lineCaret(doc, 6), 4);
  assert.equal(lineCaret(doc, 3), 3);
  assert.equal(lineCaret("red  \n", 5), 5);
  const mounted = mountEditor();
  try {
    const view = createEditor(mounted.root, doc, 6);
    const slotBr = mounted.findAll((node) => node.tagName === "BR" && node.parentElement && node.parentElement.dataset.start === "4" && node.parentElement.dataset.end === "4")[0];
    const breakBr = mounted.findAll((node) => node.tagName === "BR" && node.parentElement && node.parentElement.classList && node.parentElement.classList.contains("md-break") && node.parentElement.dataset.start === "6")[0];
    assert.ok(slotBr);
    assert.ok(breakBr);
    assert.equal(mapOffset(slotBr, 0), 4);
    assert.equal(mapOffset(breakBr, 0), 6);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("BG.ws.space", () => {
  const doc = "one\n\n \n\ntwo\n";
  assert.equal(doc[5], " ");
  assert.equal(doc[6], "\n");
  for (const cursor of [5, 6]) {
    for (const op of [backspace, deleteForward]) {
      const next = op(createState(doc, cursor));
      assert.equal(next.doc, "one\n\n\ntwo\n");
      assert.equal(next.cursor, 4);
      assert.equal(next.anchor, 4);
    }
  }
  const slot = plan(doc, 6).blocks.find((block) => block.slot === 5);
  assert.ok(slot);
  assert.ok(slot.parts.some((part) => part.type === "break" && part.start === 6));
  assert.equal(lineCaret(doc, 5), 5);
  assert.equal(lineCaret(doc, 6), 5);
});

test("BG.ws.tab", () => {
  const doc = "one\n\n\t\n\ntwo\n";
  assert.equal(doc[5], "\t");
  assert.equal(doc[6], "\n");
  for (const cursor of [5, 6]) {
    for (const op of [backspace, deleteForward]) {
      const next = op(createState(doc, cursor));
      assert.equal(next.doc, "one\n\n\ntwo\n");
      assert.equal(next.cursor, 4);
      assert.equal(next.anchor, 4);
    }
  }
  assert.equal(lineCaret(doc, 5), 5);
  assert.equal(lineCaret(doc, 6), 5);
});

test("a tab on a blank line shares that line with its break", () => {
  const doc = "one\n\n\t\n\ntwo\n";
  const mounted = mountEditor();
  try {
    const view = createEditor(mounted.root, doc, 6);
    const line = mounted.findAll((node) => node.classList && node.classList.contains("md-line") && node.dataset && node.dataset.start === "5" && node.dataset.end === "5")[0];
    assert.ok(line);
    const onLine = (node) => {
      let current = node;
      while (current) {
        if (current === line) return true;
        current = current.parentElement;
      }
      return false;
    };
    const brs = mounted.findAll((node) => node.tagName === "BR" && onLine(node));
    assert.equal(brs.length, 2);
    const slotBr = brs.find((node) => node.parentElement.dataset.start === "5" && node.parentElement.dataset.end === "5");
    const breakBr = brs.find((node) => node.parentElement.classList && node.parentElement.classList.contains("md-break"));
    assert.ok(slotBr);
    assert.ok(breakBr);
    assert.equal(mapOffset(slotBr, 0), 5);
    assert.equal(mapOffset(breakBr, 0), 6);
    assert.equal(breakBr.parentElement.styleProps.display, "block");
    assert.equal(breakBr.parentElement.styleProps["margin-top"], "-1lh");
    const blank = mounted.findAll((node) => node.classList && node.classList.contains("md-line") && node.dataset && node.dataset.start === "4" && node.dataset.end === "4")[0];
    assert.equal(blank.childNodes.length, 1);
    assert.equal(blank.childNodes[0].tagName, "BR");
    assert.equal(blank.childNodes[0].parentElement.classList.contains("md-break"), false);
    view.destroy();
  } finally {
    mounted.restore();
  }

  const hard = mountEditor();
  try {
    const view = createEditor(hard.root, "hello  \nworld\n", 0);
    const breakBr = hard.findAll((node) => node.tagName === "BR" && node.parentElement && node.parentElement.classList && node.parentElement.classList.contains("md-break"))[0];
    assert.ok(breakBr);
    assert.equal(mapOffset(breakBr, 0), 7);
    assert.equal(breakBr.parentElement.styleProps["margin-top"], undefined);
    assert.equal(breakBr.parentElement.styleProps.display, undefined);
    const hello = hard.findAll((node) => node.nodeType === 3 && node.textContent === "hello")[0];
    assert.ok(hello);
    assert.equal(hard.findAll((node) => node.nodeType === 3 && node.textContent === "  ").length, 0);
    view.destroy();
  } finally {
    hard.restore();
  }
});

test("a blank line indents its break by the hidden whitespace and a click rests at the start", () => {
  const mounted = mountEditor();
  const create = document.createElement;
  document.createElement = (tag) => {
    const el = create(tag);
    const kind = String(tag).toUpperCase();
    if (kind === "SPAN" || kind === "BR") {
      el.getBoundingClientRect = () => {
        if (kind === "BR") return { left: 30, top: 1, right: 30, bottom: 11, width: 0, height: 10 };
        const text = el.textContent || "";
        const width = text === "\t" ? 18.5 : text === " " ? 4.5 : 0;
        return { left: 0, top: 0, right: width, bottom: 0, width, height: 0 };
      };
    }
    return el;
  };
  const press = (view, node, x) => {
    document.caretPositionFromPoint = () => ({ offsetNode: node, offset: 0 });
    const event = {
      target: node,
      clientX: x,
      clientY: 6,
      detail: 1,
      button: 0,
      shiftKey: false,
      preventDefault() {},
    };
    mounted.listeners.mousedown(event);
    mounted.listeners.click(event);
    return view.getState();
  };
  try {
    const tab = createEditor(mounted.root, "one\n\n\t\n\ntwo\n", 0);
    const tabBreak = mounted.findAll((node) => node.classList && node.classList.contains("md-break") && node.dataset && node.dataset.start === "6")[0];
    assert.ok(tabBreak);
    assert.equal(tabBreak.styleProps.display, "block");
    assert.equal(tabBreak.styleProps["margin-top"], "-1lh");
    assert.equal(tabBreak.styleProps["margin-left"], "18.5px");
    assert.equal(press(tab, tabBreak, 4).cursor, 5);
    assert.equal(press(tab, tabBreak, 31).cursor, 6);
    tab.destroy();

    const space = createEditor(mounted.root, "one\n\n \n\ntwo\n", 0);
    const spaceBreak = mounted.findAll((node) => node.classList && node.classList.contains("md-break") && node.dataset && node.dataset.start === "6")[0];
    assert.ok(spaceBreak);
    assert.equal(spaceBreak.styleProps["margin-left"], "4.5px");
    assert.equal(press(space, spaceBreak, 4).cursor, 5);
    assert.equal(press(space, spaceBreak, 4).anchor, 5);
    assert.equal(press(space, spaceBreak, 31).cursor, 6);
    space.destroy();
  } finally {
    mounted.restore();
  }
});

test("BG.hbe-p", () => {
  const next = backspace(createState("red  \n\ntwo\n", 6));
  assert.equal(next.doc, "red  \ntwo\n");
  assert.equal(next.cursor, 3);
});

test("BG.bse-p", () => {
  const next = backspace(createState("red\\\n\ntwo\n", 5));
  assert.equal(next.doc, "red\\\ntwo\n");
  assert.equal(next.cursor, 3);
});

test("BS.hb.1", () => {
  const next = backspace(createState("red  \nblue\n", 6));
  assert.equal(next.doc, "redblue\n");
  assert.equal(next.cursor, 3);
  assert.equal(next.anchor, 3);
});

test("BS.hb.2", () => {
  const next = backspace(createState("red\\\nblue\n", 5));
  assert.equal(next.doc, "redblue\n");
  assert.equal(next.cursor, 3);
  assert.equal(next.anchor, 3);
});

test("DL.hb.1", () => {
  const next = deleteForward(createState("red  \nblue\n", 3));
  assert.equal(next.doc, "redblue\n");
  assert.equal(next.cursor, 3);
  assert.equal(next.anchor, 3);
});

test("DL.hb.2", () => {
  const next = deleteForward(createState("red\\\nblue\n", 3));
  assert.equal(next.doc, "redblue\n");
  assert.equal(next.cursor, 3);
  assert.equal(next.anchor, 3);
});

test("BS.tb.1", () => {
  let s = createState("| a | b |\n| --- | --- |\n| 1 | 2 |\n\n", 34);
  s = backspace(s);
  assert.equal(s.doc, "| a | b |\n| --- | --- |\n| 1 | 2 |\n");
  assert.equal(s.cursor, 33);
  assert.equal(plan(s.doc, s.cursor).blocks.some((block) => block.type === "table"), false);
  s = backspace(s);
  assert.equal(s.doc, "| a | b |\n| --- | --- |\n| 1 | 2 \n");
  assert.equal(s.cursor, 32);
});

test("a click or an arrow leaves a hidden marker", () => {
  const comment = "See {c1}this{/c1} now.";
  assert.equal(skipHidden(comment, 5, "nearer"), 4);
  assert.equal(skipHidden(comment, 7, "nearer"), 8);
  assert.equal(skipHidden(comment, 5, "forward"), 8);
  assert.equal(skipHidden(comment, 16, "backward"), 12);
  assert.equal(skipHidden(comment, 4, "forward"), 4);
  assert.equal(skipHidden(comment, 8, "backward"), 8);
  const spaces = "red  \nblue\n";
  assert.equal(skipHidden(spaces, 4, "forward"), 6);
  assert.equal(skipHidden(spaces, 5, "backward"), 3);
  assert.equal(skipHidden(spaces, 3, "forward"), 3);
  assert.equal(skipHidden(spaces, 5, "nearer"), 5);
  assert.equal(skipHidden(spaces, 4, "nearer"), 3);
  const slash = "red\\\nblue\n";
  assert.equal(skipHidden(slash, 4, "forward"), 5);
  assert.equal(skipHidden(slash, 4, "backward"), 3);
  const widened = backspace(createState("red   \n", 5));
  assert.equal(widened.doc, "red  \n");
  assert.equal(widened.cursor, 3);
});

test("T-table-atom", () => {
  assert.equal(D.length, 34);
  for (const cursor of [0, 4, 33]) {
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
  const closed = plan(D, D.length);
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

test("code fence is one block", () => {
  const codeBlock = (doc, cursor) => {
    const blocks = plan(doc, cursor).blocks.filter((block) => block.classes && block.classes.includes("md-codeblock"));
    assert.equal(blocks.length, 1);
    return blocks[0];
  };
  const js = "```js\nlet x\nmore\n```\n";
  assert.equal(js.length, 21);
  assert.deepEqual([5, 11, 16, 20].map((offset) => js[offset]), ["\n", "\n", "\n", "\n"]);
  assert.deepEqual(lockSpans(js), [{ start: 0, end: 20 }]);

  const block = codeBlock(js, 21);
  assert.equal(block.raw, false);
  assert.equal(block.start, 0);
  assert.equal(block.end, 20);
  assert.equal(block.text, "let xmore");
  assert.equal(block.text.includes("`"), false);
  assert.ok(block.classes.includes("md-codeblock"));
  assert.equal(block.classes.includes("md-raw"), false);
  assert.equal(block.collapsed, undefined);
  assert.deepEqual(
    block.parts.filter((part) => part.type === "break").map((part) => [part.start, part.end]),
    [[11, 12]],
  );
  assert.equal(block.runs.map((run) => run.text).join(""), "let xmore");
  assert.ok(block.runs.every((run) => run.classes.includes("md-codeblock")));

  const atEnd = codeBlock(js, 20);
  assert.equal(atEnd.raw, true);
  assert.equal(atEnd.text, "```jslet xmore```");

  const raw = codeBlock(js, 0);
  assert.equal(raw.raw, true);
  assert.equal(raw.start, 0);
  assert.equal(raw.end, 20);
  assert.equal(raw.text, "```jslet xmore```");
  assert.deepEqual(raw.runs.map((run) => run.text), ["```js", "let x", "more", "```"]);
  assert.deepEqual(
    raw.parts.filter((part) => part.type === "break").map((part) => [part.start, part.end]),
    [[5, 6], [11, 12], [16, 17]],
  );
  assert.equal(raw.parts.some((part) => part.type === "break" && part.start === 20), false);
  assert.equal(raw.runs.some((run) => run.classes.includes("token")), false);
  assert.ok(raw.classes.includes("md-raw"));
  assert.ok(raw.classes.includes("md-codeblock"));

  const short = "```js\nlet x\n```\n";
  const shortBlock = codeBlock(short, 20);
  assert.equal(shortBlock.raw, false);
  assert.equal(shortBlock.text, "let x");
  assert.equal(shortBlock.parts.some((part) => part.type === "break"), false);

  const bare = "```\n```\n";
  const empty = codeBlock(bare, bare.length);
  assert.equal(empty.raw, false);
  assert.deepEqual(empty.parts, []);
  assert.equal(empty.text, "");
  assert.equal(empty.end, bare.length - 1);
  const opened = codeBlock(bare, empty.end);
  assert.equal(opened.raw, true);
  assert.equal(opened.text, "``````");

  const unclosed = "```js\nlet x\n";
  const unclosedBlock = codeBlock(unclosed, unclosed.length);
  assert.equal(unclosedBlock.raw, false);
  assert.equal(unclosedBlock.text, "let x");
  assert.equal(unclosedBlock.end, lockSpans(unclosed)[0].end);
});

test("T-diagram-atom", () => {
  assert.equal(E.length, 21);
  for (const cursor of [0, 12, 20]) {
    const open = plan(E, cursor);
    assert.equal(open.blocks.filter((b) => b.type === "diagram").length, 0);
    const code = open.lines.filter((line) => line.classes.includes("md-codeblock"));
    assert.equal(code.length, 3);
    assert.equal(code.map((line) => line.text).join("\n"), "```mermaid\nA-->B\n```");
    assert.ok(code.every((line) => line.runs.map((run) => run.text).join("") === line.text));
  }
  const closed = plan(E, E.length);
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
  assert.equal(snapMove(D, 33, 4, "forward"), 4);
  assert.equal(snapMove(D, D.length, 4, "forward"), 33);
  assert.equal(snapMove(E, 0, 12, "forward"), 12);
  assert.equal(snapMove(E, 20, 12, "forward"), 12);
  assert.equal(snapMove(E, E.length, 12, "forward"), 20);
  assert.equal(placeMove(D, D.length, 4, "forward", "line"), 0);
  assert.equal(placeMove(D, D.length, 4, "forward", "character"), 0);
  assert.equal(placeMove(D, D.length, 4, "backward", "character"), 33);
  assert.equal(placeMove(D, 33, 4, "forward", "character"), 4);
  assert.equal(placeMove(D, 0, 4, "forward", "character"), 4);
  assert.equal(placeMove(E, E.length, 12, "forward", "line"), 20);
  assert.equal(placeMove(E, E.length, 12, "backward", "line"), 0);
  assert.equal(placeMove(E, E.length, 12, "forward", "character"), 0);
  assert.equal(placeMove(E, E.length, 12, "backward", "character"), 20);
  assert.equal(placeMove(E, 20, 12, "forward", "character"), 12);
  assert.equal(placeMove(F, 0, 10, "forward", "character"), 21);
  assert.equal(placeMove("x\n" + D, 0, 40, "forward", "line"), 2);
  assert.equal(placeMove("x\n" + D, 40, 0, "backward", "line"), 35);
  assert.equal(placeMove("x\n" + E, 0, 30, "forward", "line"), 30);
  assert.equal(placeMove("x\n" + E, 0, 30, "forward", "character"), 2);

  const fenced = "a\n```js\ncode\n```\n";
  const openFence = fenced.indexOf("```js");
  const codeAt = fenced.indexOf("code");
  const closeFence = fenced.lastIndexOf("```");
  assert.equal(placeMove(fenced, 1, codeAt, "forward", "line"), codeAt);
  assert.equal(placeMove(fenced, codeAt, 0, "backward", "line"), 0);
  assert.equal(placeMove(fenced, codeAt + "code".length, fenced.length, "forward", "character"), fenced.length);
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
  assert.equal(spaced.lines.filter((line) => line.classes.includes("md-codeblock")).length, 1);
  assert.equal(spaced.lines[0].text, "A");
  assert.equal(spaced.lines[0].text.includes("`"), false);
  assert.equal(spaced.lines[0].collapsed, undefined);
  assert.equal(spaced.lines[0].raw, false);

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
  assert.equal(codeLines.length, 1);
  assert.equal(codeLines[0].raw, false);
  assert.equal(codeLines[0].collapsed, undefined);
  assert.equal(codeLines[0].text, "full");
  assert.equal(codeLines[0].text.includes("`"), false);
  assert.equal(codeLines[0].runs.map((run) => run.text).join(""), "full");
  assert.equal(codeLines[0].runs[0].start, 6);
  assert.equal(codeLines[0].runs[codeLines[0].runs.length - 1].end, 10);
  assert.equal(codeLines[0].runs[0].text.length, codeLines[0].runs[0].end - codeLines[0].runs[0].start);
  const onFence = plan("```js\nfull\n```\n", 0).lines.filter((line) => line.classes.includes("md-codeblock"));
  assert.equal(onFence.length, 1);
  assert.equal(onFence[0].collapsed, undefined);
  assert.equal(onFence[0].raw, true);
  assert.equal(onFence[0].text, "```jsfull```");
  assert.equal(onFence[0].runs.some((run) => run.classes.includes("token")), false);

  const h2 = plan("## Sub\n", 7);
  assert.equal(h2.lines[0].runs[0].text, "Sub");
  assert.equal(h2.lines[0].runs[0].start, 3);
  assert.ok(h2.lines[0].runs[0].classes.includes("md-h2"));
});

test("T-ordered-list", () => {
  const p = plan("12. num\n\nnext\n", 9);
  const line0 = p.lines[0];
  assert.equal(line0.raw, false);
  assert.equal(line0.runs.length, 1);
  assert.equal(line0.runs[0].text, "num");
  assert.equal(line0.runs[0].start, 4);
  assert.equal(line0.runs[0].end, 7);
  assert.ok(line0.runs[0].classes.includes("md-ol"));
  assert.ok(line0.classes.includes("md-ol"));
  assert.equal(line0.marker, "12. ");
  assert.equal(p.lines[2].raw, true);
  assert.equal(p.lines[2].text, "next");

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
  const hiddenLines = hidden.lines.filter((line) => !line.empty);
  assert.equal(hiddenLines.length, 1);
  assert.equal(hiddenLines[0].raw, true);
  assert.equal(hiddenLines[0].runs.map((run) => run.text).join(""), "**a** **b**");
  const hiddenA = hiddenLines[0].runs.find((run) => run.text === "**a**");
  assert.deepEqual(hiddenA.classes, ["md-strong"]);
  const hiddenB = hiddenLines[0].runs.find((run) => run.text === "**b**");
  assert.equal(hiddenB.start, 6);
  assert.equal(hiddenB.end, 11);
  assert.deepEqual(hiddenB.classes, ["md-strong"]);

  const shiftedPlan = plan("next\n**hello**\n", 6);
  const shiftedLines = shiftedPlan.lines.filter((line) => !line.empty);
  assert.equal(shiftedLines.length, 1);
  const shifted = shiftedLines[0];
  assert.equal(shifted.raw, true);
  const shiftedHello = shifted.runs.find((run) => run.text === "**hello**");
  assert.equal(shiftedHello.start, 5);
  assert.equal(shiftedHello.end, 14);
  assert.deepEqual(shiftedHello.classes, ["md-strong"]);

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

  const same = plan("12. num\n\nnext\n", 9);
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
  assert.match(css, /\.md-raw\.md-li,\n\.md-raw\.md-ol \{[^}]*margin-left: calc\(1\.3em \+ var\(--indent, 0\) \* 1ch\);/);
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
    assert.equal(event.defaultPrevented, true);
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

test("a raw marker hangs in flow so the caret sits on its glyphs", () => {
  const mounted = mountEditor();
  const create = globalThis.document.createElement;
  globalThis.document.createElement = (tag) => {
    const el = create(tag);
    if (String(tag).toLowerCase() === "canvas") {
      el.getContext = () => ({
        measureText(text) {
          return { width: String(text).length * 8 };
        },
      });
    }
    return el;
  };
  globalThis.window.getComputedStyle = () => ({ font: "16px sans-serif", tabSize: "4" });
  const hangOf = (line) => (line.childNodes || []).find((node) => node.classList && node.classList.contains("md-raw-hang"));
  const px = (value) => Number.parseFloat(value || "0");
  const gutterOf = (indent) => 1.3 * 16 + indent * 8;
  const nearPx = (actual, expected) => Math.abs(actual - expected) < 1e-6;
  const textAt = (node, index) => {
    const found = [];
    const walk = (current) => {
      if (!current) return;
      if (current.nodeType === 3) found.push(current);
      for (const child of current.childNodes || []) walk(child);
    };
    walk(node);
    return found[index];
  };
  try {
    const bullet = createEditor(mounted.root, "- alpha\n- beta\n", 0);
    const lines = mounted.findAll((node) => node.classList && node.classList.contains("md-line") && node.classList.contains("md-li"));
    assert.equal(lines.length, 2);
    const raw = lines[0];
    const hang = hangOf(raw);
    assert.ok(hang);
    assert.equal(hang.style.marginLeft || "", "");
    assert.equal(hang.style.marginRight || "", "");
    assert.equal(px(raw.style.marginLeft), 0);
    assert.ok(nearPx(px(raw.style.paddingLeft), gutterOf(0)));
    assert.ok(nearPx(px(raw.style.textIndent), -gutterOf(0)));
    assert.equal(hang.textContent, "- ");
    assert.equal(raw.childNodes[0], hang);
    const gap = raw.childNodes[1];
    assert.equal(gap.classList.contains("md-raw-gap"), true);
    assert.equal(gap.textContent, " ");
    assert.equal(gap.style.whiteSpace, "pre");
    assert.equal(hang.style.letterSpacing, "1px");
    assert.ok(nearPx(px(gap.style.letterSpacing), gutterOf(0) - 16 - 2 - 8));
    assert.equal(gap.dataset.start, "2");
    assert.equal(gap.dataset.end, "2");
    assert.equal(mapOffset(textAt(gap, 0), 0), 2);
    assert.equal(raw.childNodes[2].textContent, "alpha");
    assert.equal(raw.childNodes[2].parentElement, raw);
    const markerText = textAt(hang, 0);
    assert.equal(markerText.textContent, "- ");
    assert.equal(mapOffset(markerText, 0), 0);
    assert.equal(mapOffset(markerText, 1), 1);
    assert.equal(mapOffset(markerText, 2), 2);
    assert.equal(mapOffset(textAt(raw.childNodes[2], 0), 0), 2);
    assert.equal(hangOf(lines[1]), undefined);
    assert.equal(lines[1].style.textIndent || "", "");
    assert.equal(lines[1].textContent, "beta");
    bullet.destroy();

    const marked = createEditor(mounted.root, "- **a**\n", 0);
    const strongLine = mounted.findAll((node) => node.classList && node.classList.contains("md-li") && node.classList.contains("md-raw"))[0];
    const strongHang = hangOf(strongLine);
    assert.equal(strongHang.textContent, "- ");
    assert.equal(strongHang.style.marginLeft || "", "");
    assert.equal(strongLine.childNodes[1].classList.contains("md-raw-gap"), true);
    assert.equal(strongLine.childNodes[2].textContent, "**a**");
    assert.equal(strongLine.childNodes[2].classList.contains("md-strong"), true);
    assert.equal(mapOffset(textAt(strongLine.childNodes[2], 0), 0), 2);
    marked.destroy();

    const task = createEditor(mounted.root, "- [ ] box\n", 0);
    const taskLine = mounted.findAll((node) => node.classList && node.classList.contains("md-li") && node.classList.contains("md-raw") && node.textContent && node.textContent.includes("[ ]"))[0];
    const taskHang = hangOf(taskLine);
    assert.equal(taskHang.textContent, "- ");
    const taskItem = taskLine.childNodes.filter((node) => node !== taskHang && !(node.classList && node.classList.contains("md-raw-gap")));
    assert.equal(taskItem.map((node) => node.textContent).join(""), "[ ] box");
    task.destroy();

    const nested = createEditor(mounted.root, "\t\t1. aaa\n\t\t2. bbb\n", 0);
    const ordered = mounted.findAll((node) => node.classList && node.classList.contains("md-line") && node.classList.contains("md-ol"));
    const nestedHang = hangOf(ordered[0]);
    assert.equal(nestedHang.textContent, "\t\t1. ");
    assert.equal(nestedHang.style.marginLeft || "", "");
    assert.equal(nestedHang.style.marginRight || "", "");
    assert.equal(nestedHang.style.letterSpacing || "", "");
    assert.ok(nearPx(px(ordered[0].style.textIndent), -88));
    assert.ok(nearPx(px(ordered[0].style.paddingLeft), 88));
    assert.ok(nearPx(px(ordered[0].style.marginLeft), gutterOf(8) - 88));
    assert.equal(ordered[0].childNodes.some((node) => node.classList && node.classList.contains("md-raw-gap")), false);
    assert.equal(ordered[0].childNodes[1].textContent, "aaa");
    assert.equal(mapOffset(textAt(nestedHang, 0), 0), 0);
    assert.equal(mapOffset(textAt(nestedHang, 0), 5), 5);
    assert.equal(mapOffset(textAt(ordered[0].childNodes[1], 0), 0), 5);
    assert.equal(hangOf(ordered[1]), undefined);
    assert.equal(ordered[1].textContent, "bbb");
    nested.destroy();

    const tabbed = createEditor(mounted.root, "1.\talpha\n", 0);
    const tabLine = mounted.findAll((node) => node.classList && node.classList.contains("md-ol") && node.classList.contains("md-raw"))[0];
    const tabHang = hangOf(tabLine);
    assert.equal(tabHang.textContent, "1.\t");
    assert.equal(tabHang.style.marginLeft || "", "");
    assert.equal(tabHang.style.marginRight || "", "");
    assert.ok(nearPx(px(tabLine.style.textIndent), -32));
    assert.ok(nearPx(px(tabLine.style.paddingLeft), 32));
    assert.ok(nearPx(px(tabLine.style.marginLeft), gutterOf(0) - 32));
    assert.equal(tabLine.childNodes.some((node) => node.classList && node.classList.contains("md-raw-gap")), false);
    assert.equal(tabLine.childNodes[1].textContent, "alpha");
    assert.equal(mapOffset(textAt(tabLine.childNodes[1], 0), 0), 3);
    tabbed.destroy();

    const quoted = createEditor(mounted.root, "> - item\n> - other\n", 0);
    const quoteLines = mounted.findAll((node) => node.classList && node.classList.contains("md-quote"));
    assert.equal(quoteLines.length, 2);
    assert.equal(hangOf(quoteLines[0]), undefined);
    assert.equal(quoteLines[0].style.textIndent || "", "");
    assert.equal(quoteLines[0].textContent.startsWith("- item"), true);
    assert.equal(hangOf(quoteLines[1]), undefined);
    quoted.destroy();

    const wide = createEditor(mounted.root, "100. hundred\n101. more\n", 0);
    const wideLines = mounted.findAll((node) => node.classList && node.classList.contains("md-line") && node.classList.contains("md-ol"));
    const wideHang = hangOf(wideLines[0]);
    assert.equal(wideHang.textContent, "100. ");
    assert.equal(wideHang.style.marginLeft || "", "");
    assert.equal(wideHang.style.marginRight || "", "");
    assert.equal(wideHang.style.letterSpacing || "", "");
    assert.ok(nearPx(px(wideLines[0].style.textIndent), -40));
    assert.ok(nearPx(px(wideLines[0].style.paddingLeft), 40));
    assert.ok(nearPx(px(wideLines[0].style.marginLeft), gutterOf(0) - 40));
    assert.equal(wideLines[0].childNodes.some((node) => node.classList && node.classList.contains("md-raw-gap")), false);
    assert.equal(wideLines[0].childNodes[1].textContent, "hundred");
    assert.equal(mapOffset(textAt(wideLines[0].childNodes[1], 0), 0), 5);
    assert.equal(hangOf(wideLines[1]), undefined);
    wide.destroy();

    const joined = createEditor(mounted.root, "- Alpha\nBeta\n", 0);
    const joinedLine = mounted.findAll((node) => node.classList && node.classList.contains("md-li") && node.classList.contains("md-raw"))[0];
    const joinedHang = hangOf(joinedLine);
    assert.equal(joinedHang.textContent, "- ");
    const space = mounted.findAll((node) => (
      node.nodeType === 3
      && node.textContent === " "
      && !(node.parentElement && node.parentElement.classList && node.parentElement.classList.contains("md-raw-gap"))
    ))[0];
    assert.equal(mapOffset(space, 0), 7);
    assert.equal(mapOffset(space, 1), 8);
    joined.destroy();
  } finally {
    mounted.restore();
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
    const fences = plan("```js\nfull\n```\n", 100).lines.filter((line) => line.classes.includes("md-codeblock"));
    assert.equal(fences.length, 1);
    assert.equal(fences[0].raw, false);
    assert.equal(fences[0].text, "full");
    assert.ok(fences[0].runs.every((run) => run.classes.includes("md-codeblock")));
    const rawFence = plan("```js\nfull\n```\n", 0).lines.filter((line) => line.classes.includes("md-codeblock"));
    assert.equal(rawFence.length, 1);
    assert.equal(rawFence[0].raw, true);
    assert.equal(rawFence[0].text, "```jsfull```");
    assert.equal(rawFence[0].runs.some((run) => run.classes.includes("token")), false);
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
  assert.match(readme, /The markdown is the dialect used by GitHub, GitLab, and Obsidian\. A fenced block tagged `mermaid` is drawn as a diagram\./);
  assert.match(readme, /HTML in the document is stored as text and is not rendered\./);
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
        // The menu is pinned on the editor. Its labels are not the document.
        return list.map((child) => {
          if (child.classList && child.classList.contains("md-doc-menu-panel")) return "";
          return child.textContent == null ? "" : child.textContent;
        }).join("");
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
  const documentListeners = new Map();
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
    addEventListener(type, fn) {
      const list = documentListeners.get(type);
      if (list) list.push(fn);
      else documentListeners.set(type, [fn]);
    },
    removeEventListener(type, fn) {
      const list = documentListeners.get(type);
      if (!list) return;
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    },
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
    documentListeners,
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
  const world = () => mounted.findAll((node) => node.nodeType === 3 && node.textContent === "world")[0];
  try {
    const transport = holdingTransport();
    const held = createEditor(mounted.root, "hello\nworld\n", 0, transport);
    caret(world(), 0);
    press();
    const edit = transport.sent.find((message) => message.type === "edit");
    assert.equal(edit.op, "backspace");
    assert.equal(edit.cursor, 6);
    assert.equal(edit.anchor, 6);
    assert.equal(transport.sent.some((message) => message.type === "lock"), false);
    held.destroy();

    const view = createEditor(mounted.root, "hello\nworld\n", 0);
    caret(world(), 0);
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

    const blankLine = () => mounted.findAll((node) => node.classList && node.classList.contains("md-line") && node.dataset.start === node.dataset.end && node.textContent === "")[0];
    const emptyTransport = holdingTransport();
    const emptyHeld = createEditor(mounted.root, "hello\n\nworld", 0, emptyTransport);
    caret(blankLine(), 0);
    press();
    const blankEdit = emptyTransport.sent.find((message) => message.type === "edit");
    assert.equal(blankEdit.op, "backspace");
    assert.equal(blankEdit.anchor, 6);
    assert.equal(blankEdit.cursor, 6);
    const blankLocks = emptyTransport.sent.filter((message) => message.type === "lock");
    assert.equal(blankLocks.length, 1);
    assert.equal(blankLocks[0].anchor, 6);
    assert.equal(blankLocks[0].cursor, 6);
    assert.ok(emptyTransport.sent.indexOf(blankLocks[0]) < emptyTransport.sent.indexOf(blankEdit));
    emptyHeld.destroy();

    const empty = createEditor(mounted.root, "hello\n\nworld", 0);
    caret(blankLine(), 0);
    press();
    assert.equal(empty.getState().doc, "hello\nworld");
    assert.equal(empty.getState().cursor, 5);
    assert.equal(empty.getState().anchor, 5);
    assert.equal(empty.getState().doc[empty.getState().cursor], "\n");
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

test("enter on a list item continues that item", () => {
  const mounted = mountEditor();
  const press = (inputType, data) => {
    mounted.listeners.beforeinput({
      inputType,
      data,
      preventDefault() {},
    });
  };
  const enter = (doc, cursor, inputType = "insertParagraph") => {
    const view = createEditor(mounted.root, doc, cursor);
    press(inputType);
    const state = view.getState();
    view.destroy();
    return state;
  };
  try {
    const bullet = enter("- alpha", 7);
    assert.equal(bullet.doc, "- alpha\n- ");
    assert.equal(bullet.cursor, 10);
    assert.equal(bullet.anchor, 10);
    assert.equal(bullet.doc.slice(0, bullet.cursor), "- alpha\n- ");

    const child = enter("  - child", 9);
    assert.equal(child.doc, "  - child\n  - ");
    assert.equal(child.cursor, child.doc.length);
    assert.equal(child.doc.endsWith("\n  - "), true);

    const ordered = enter("1. alpha", 8);
    assert.equal(ordered.doc, "1. alpha\n2. ");
    assert.equal(ordered.cursor, ordered.doc.length);

    const paren = enter("3) alpha", 8);
    assert.equal(paren.doc, "3) alpha\n4) ");
    assert.equal(paren.cursor, paren.doc.length);

    const quoted = enter("> - alpha", 9);
    assert.equal(quoted.doc, "> - alpha\n> - ");
    assert.equal(quoted.cursor, quoted.doc.length);

    const nested = enter(">   - child", 11);
    assert.equal(nested.doc, ">   - child\n>   - ");
    assert.equal(nested.cursor, nested.doc.length);

    const quotedOrdered = enter("> 1. alpha", 10);
    assert.equal(quotedOrdered.doc, "> 1. alpha\n> 2. ");
    assert.equal(quotedOrdered.cursor, quotedOrdered.doc.length);

    const heading = enter("# Title", 2);
    assert.equal(heading.doc, "\n# Title");
    assert.equal(heading.cursor, 3);

    const split = enter("- alpha", 4);
    assert.equal(split.doc, "- al\n- pha");
    assert.equal(split.cursor, 7);
    assert.equal(split.doc[split.cursor], "p");

    const joined = enter("- alpha\nbeta", 10);
    assert.equal(joined.doc, "- alpha\nbe\n- ta");
    assert.equal(joined.cursor, 13);

    const joinedQuote = enter("> alpha\nbeta", 10);
    assert.equal(joinedQuote.doc, "> alpha\nbe\n> ta");
    assert.equal(joinedQuote.cursor, 13);

    const joinedOrdered = enter("1. alpha\nbeta", 11);
    assert.equal(joinedOrdered.doc, "1. alpha\nbe\n2. ta");
    assert.equal(joinedOrdered.cursor, 15);

    const afterBlank = enter("- alpha\n\nbeta", 11);
    assert.equal(afterBlank.doc, "- alpha\n\nbe\n\nta");
    assert.equal(afterBlank.cursor, 13);

    const task = enter("- [ ] alpha", 11);
    assert.equal(task.doc, "- [ ] alpha\n- [ ] ");
    assert.equal(task.cursor, task.doc.length);

    const checked = enter("- [x] alpha", 11);
    assert.equal(checked.doc, "- [x] alpha\n- [ ] ");
    assert.equal(checked.cursor, checked.doc.length);

    const prose = enter("hello", 5);
    assert.equal(prose.doc, "hello\n\n");
    assert.equal(prose.cursor, 7);

    const left = enter("- a\n- ", 6);
    assert.equal(left.doc, "- a\n\n");
    assert.equal(left.cursor, 5);

    for (const inputType of ["insertLineBreak", "insertParagraph"]) {
      const again = enter("- alpha", 7, inputType);
      assert.equal(again.doc, "- alpha\n- ");
      assert.equal(again.cursor, 10);
    }
  } finally {
    mounted.restore();
  }
});

test("enter on an empty list item leaves the list", () => {
  const mounted = mountEditor();
  const press = (inputType = "insertParagraph") => {
    mounted.listeners.beforeinput({
      inputType,
      preventDefault() {},
    });
  };
  const show = (state) => state.doc.slice(0, state.cursor) + "‸" + state.doc.slice(state.cursor);
  const enter = (marked, inputType) => {
    const at = marked.indexOf("‸");
    const view = createEditor(mounted.root, marked.replace("‸", ""), at);
    press(inputType);
    const state = view.getState();
    view.destroy();
    return show(state);
  };
  const cases = [
    ["- alpha\n- ‸\n", "- alpha\n\n‸\n"],
    ["- ‸\n", "‸\n"],
    ["- alpha\n- ‸\n- gamma\n", "- alpha\n\n‸\n- gamma\n"],
    ["1. alpha\n2. ‸\n", "1. alpha\n\n‸\n"],
    ["- a\n  - ‸\n", "- a\n- ‸\n"],
    ["- a\n\t- ‸\n", "- a\n- ‸\n"],
    ["> - alpha\n> - ‸\n", "> - alpha\n> ‸\n"],
    ["- [ ] ‸\n", "‸\n"],
    ["- [x] ‸\n", "‸\n"],
    ["- [X] ‸\n", "‸\n"],
    ["- [ ] alpha\n- [ ] ‸\n", "- [ ] alpha\n\n‸\n"],
    ["- alpha‸\n", "- alpha\n- ‸\n"],
    ["- alpha‸", "- alpha\n- ‸"],
    ["  - child‸", "  - child\n  - ‸"],
    ["> - alpha‸", "> - alpha\n> - ‸"],
    ["1. alpha‸", "1. alpha\n2. ‸"],
  ];
  try {
    for (const inputType of ["insertParagraph", "insertLineBreak"]) {
      for (const [before, after] of cases) {
        assert.equal(enter(before, inputType), after, `${inputType} ${JSON.stringify(before)}`);
      }
    }
    const view = createEditor(mounted.root, "- a", 3);
    press();
    press();
    assert.equal(show(view.getState()), "- a\n\n‸");
    press("deleteContentBackward");
    press("deleteContentBackward");
    assert.equal(show(view.getState()), "- a‸");
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("unxhe3dc enter before a list marker", () => {
  const mounted = mountEditor();
  const press = (inputType, data) => {
    mounted.listeners.beforeinput({
      inputType,
      data,
      preventDefault() {},
    });
  };
  const enter = (doc, cursor) => {
    const view = createEditor(mounted.root, doc, cursor);
    press("insertParagraph");
    const state = view.getState();
    view.destroy();
    return state;
  };
  try {
    const beforeBullet = enter("- alpha\n", 0);
    assert.equal(beforeBullet.doc, "\n- alpha\n");
    assert.equal(beforeBullet.cursor, 1);
    assert.equal(beforeBullet.anchor, 1);

    const afterProse = enter("beta\n- alpha\n", 5);
    assert.equal(afterProse.doc, "beta\n\n- alpha\n");
    assert.equal(afterProse.cursor, 6);

    const beforeOrdered = enter("1. alpha\n", 0);
    assert.equal(beforeOrdered.doc, "\n1. alpha\n");
    assert.equal(beforeOrdered.cursor, 1);

    const afterMarker = enter("- alpha\n", 2);
    assert.equal(afterMarker.doc, "- \n- alpha\n");
    assert.equal(afterMarker.doc.slice(0, afterMarker.cursor), "- \n- ");

    const continued = enter("- alpha", 7);
    assert.equal(continued.doc, "- alpha\n- ");
    assert.equal(continued.cursor, 10);
  } finally {
    mounted.restore();
  }
});


test("enter renumbers the following ordered items and deletes a selection first", () => {
  const apply = (doc, anchor, cursor) => {
    const brk = enterBreak(doc, anchor, cursor);
    const base = createState(doc, cursor, anchor);
    const next = typeof brk.anchor === "number"
      ? insert({ ...base, anchor: brk.anchor, cursor: brk.cursor }, brk.text)
      : insert(base, brk.text);
    const caret = typeof brk.caret === "number" ? brk.caret : next.cursor;
    return { doc: next.doc, cursor: caret };
  };

  const followed = apply("1. alpha\n2. beta\n", 8, 8);
  assert.equal(followed.doc, "1. alpha\n2. \n3. beta\n");
  assert.equal(followed.cursor, 12);

  const two = apply("1. alpha\n2. beta\n3. gamma\n", 8, 8);
  assert.equal(two.doc, "1. alpha\n2. \n3. beta\n4. gamma\n");
  assert.equal(two.cursor, 12);

  const nested = apply("1. alpha\n  1. child\n2. beta\n", 8, 8);
  assert.equal(nested.doc, "1. alpha\n2. \n  1. child\n3. beta\n");
  assert.equal(nested.cursor, 12);

  const stopped = apply("1. alpha\n\n2. beta\n", 8, 8);
  assert.equal(stopped.doc, "1. alpha\n2. \n\n2. beta\n");
  assert.equal(stopped.cursor, 12);

  const wider = apply("9. alpha\n10. beta\n", 8, 8);
  assert.equal(wider.doc, "9. alpha\n10. \n11. beta\n");
  assert.equal(wider.cursor, 13);

  const alone = apply("1. alpha\n", 8, 8);
  assert.equal(alone.doc, "1. alpha\n2. \n");
  assert.equal(alone.cursor, 12);

  const empty = apply("1. alpha\n2. \n", 12, 12);
  assert.equal(empty.doc, "1. alpha\n\n\n");
  assert.equal(empty.cursor, 10);

  const pushed = apply("1. alpha\n2. beta\n", 0, 0);
  assert.equal(pushed.doc, "\n1. alpha\n2. beta\n");
  assert.equal(pushed.cursor, 1);

  const prose = apply("alpha beta\n", 2, 8);
  assert.equal(prose.doc, "al\n\nta\n");
  assert.equal(prose.cursor, 4);

  const item = apply("- alpha\n", 4, 6);
  assert.equal(item.doc, "- al\n- a\n");
  assert.equal(item.cursor, 7);
});

test("enter continues a quote, and an empty quote line leaves it", () => {
  const enter = (doc, cursor) => {
    const base = createState(doc, cursor);
    const brk = enterInsert(base.doc, base.cursor);
    return typeof brk.anchor === "number"
      ? insert({ ...base, anchor: brk.anchor, cursor: brk.cursor }, brk.text)
      : insert(base, brk.text);
  };
  const cases = [
    ["> alpha\n", 7, "> alpha\n> \n", 10],
    ["> alpha\n", 4, "> al\n> pha\n", 7],
    ["> alpha\n", 2, "> \n> alpha\n", 5],
    ["> alpha\n> \n", 10, "> alpha\n\n\n", 9],
    ["> \n", 2, "\n", 0],
    ["> alpha\n> beta\n", 7, "> alpha\n> \n> beta\n", 10],
    ["> alpha\nbeta\n", 10, "> alpha\nbe\n> ta\n", 13],
    ["> alpha\nbeta\n", 12, "> alpha\nbeta\n> \n", 15],
  ];
  for (const [doc, cursor, next, at] of cases) {
    const entered = enter(doc, cursor);
    assert.equal(entered.doc, next);
    assert.equal(entered.cursor, at);
    assert.equal(entered.anchor, at);
  }
  const stopped = enter("> alpha\n\nbeta\n", 11);
  assert.equal(stopped.doc, "> alpha\n\nbe\n\nta\n");
  assert.equal(stopped.cursor, 13);
  assert.equal(stopped.anchor, 13);
  const paragraph = enter("hello\n", 2);
  assert.equal(paragraph.doc, "he\n\nllo\n");
  assert.equal(paragraph.cursor, 4);
  const quotedList = enter("> - alpha", 9);
  assert.equal(quotedList.doc, "> - alpha\n> - ");
  assert.equal(quotedList.cursor, quotedList.doc.length);
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
    assert.equal(edit.text, "\n\n");
    assert.equal(edit.cursor, 6);
    assert.equal(edit.anchor, 5);
    assert.equal(transport.sent.some((message) => message.type === "lock"), false);
    held.destroy();

    const broken = holdingTransport();
    const shiftEnter = createEditor(mounted.root, "hello\nworld\n", 5, broken);
    press("insertLineBreak");
    const breakEdit = broken.sent.find((message) => message.type === "edit");
    assert.equal(breakEdit.op, "insert");
    assert.equal(breakEdit.text, "\n\n");
    assert.equal(breakEdit.cursor, 6);
    assert.equal(breakEdit.anchor, 5);
    assert.equal(broken.sent.some((message) => message.type === "lock"), false);
    shiftEnter.destroy();

    const view = createEditor(mounted.root, "hello\nworld\n", 5);
    press("insertParagraph");
    assert.equal(view.getState().doc, "hello\n\nworld\n");
    assert.equal(view.getState().cursor, 7);
    assert.equal(view.getState().anchor, 7);
    view.destroy();

    const middleTransport = holdingTransport();
    const middleHeld = createEditor(mounted.root, "hello\nworld\n", 2, middleTransport);
    press("insertParagraph");
    const middleEdit = middleTransport.sent.find((message) => message.type === "edit");
    assert.equal(middleEdit.op, "insert");
    assert.equal(middleEdit.text, "\n\n");
    assert.equal(middleEdit.cursor, 2);
    assert.equal(middleEdit.anchor, 2);
    assert.equal(lockReaches(middleTransport.sent, 6), false);
    middleHeld.destroy();

    const middle = createEditor(mounted.root, "hello\nworld\n", 2);
    press("insertParagraph");
    assert.equal(middle.getState().doc, "he\n\nllo\nworld\n");
    assert.equal(middle.getState().cursor, 4);
    assert.equal(middle.getState().anchor, 4);
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
    assert.equal(rejecting.sent.some((message) => message.type === "lock"), false);
    assert.equal(rejecting.sent.some((message) => message.type === "edit"), true);
    assert.equal(blocked.getState().doc, "hello\nworld\n");
    assert.equal(blocked.getState().cursor, 5);
    assert.equal(blocked.getState().anchor, 5);
    blocked.destroy();
  } finally {
    mounted.restore();
  }
});

test("enter writes a blank line where the caret line would join", () => {
  const apply = (doc, cursor) => {
    const brk = enterBreak(doc, cursor, cursor);
    const base = createState(doc, cursor);
    const next = typeof brk.anchor === "number"
      ? insert({ ...base, anchor: brk.anchor, cursor: brk.cursor }, brk.text)
      : insert(base, brk.text);
    return { doc: next.doc, cursor: typeof brk.caret === "number" ? brk.caret : next.cursor };
  };
  const end = apply("hello\n", 5);
  assert.equal(end.doc, "hello\n\n\n");
  assert.equal(end.cursor, 7);
  const gap = apply("hello\n\nworld\n", 5);
  assert.equal(gap.doc, "hello\n\n\n\nworld\n");
  assert.equal(gap.cursor, 7);
  const heading = apply("# Title\nmore\n", 7);
  assert.equal(heading.doc, "# Title\n\n\nmore\n");
  assert.equal(heading.cursor, 8);
  const between = apply("one\n\ntwo\n", 4);
  assert.equal(between.doc, "one\n\n\n\ntwo\n");
  assert.equal(between.cursor, 5);
  const joined = apply("alpha\nbeta\n", 5);
  assert.equal(joined.doc, "alpha\n\nbeta\n");
  assert.equal(joined.cursor, 7);
});

test("a drag moves the selection in one undo step", () => {
  const after = moveText(createState("alpha beta\n", 5, 0), 10);
  assert.equal(after.doc, " betaalpha\n");
  assert.equal(after.cursor, 10);
  assert.equal(after.anchor, 10);
  assert.equal(after.changes.length, 2);
  assert.deepEqual(after.changes[0], { from: 0, to: 5, inserted: "", removed: "alpha" });
  assert.deepEqual(after.changes[1], { from: 5, to: 5, inserted: "alpha", removed: "" });
  const back = undo(after);
  assert.equal(back.doc, "alpha beta\n");
  assert.equal(back.undo.length, 0);
  const before = moveText(createState("alpha beta\n", 10, 6), 0);
  assert.equal(before.doc, "betaalpha \n");
  assert.equal(before.cursor, 4);
  const inside = moveText(createState("alpha beta\n", 5, 0), 3);
  assert.equal(inside.doc, "alpha beta\n");
  assert.equal(inside.changes, undefined);
});

test("enter before a blank line keeps the caret line from joining", () => {
  const mounted = mountEditor();
  globalThis.NodeFilter = globalThis.NodeFilter || { SHOW_TEXT: 4 };
  const press = (inputType, data) => {
    mounted.listeners.beforeinput({
      inputType,
      data,
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
  const helloEnd = () => {
    const node = mounted.findAll((item) => item.nodeType === 3 && item.textContent === "hello")[0];
    assert.ok(node);
    caret(node, node.length);
  };
  const rejecting = () => ({
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
  });
  const events = [
    { inputType: "insertParagraph" },
    { inputType: "insertLineBreak" },
    { inputType: "insertText", data: "\n" },
  ];
  try {
    for (const event of events) {
      const transport = holdingTransport();
      const held = createEditor(mounted.root, "hello\n\nworld\n", 0, transport);
      helloEnd();
      press(event.inputType, event.data);
      const edit = transport.sent.find((message) => message.type === "edit");
      assert.equal(edit.op, "insert");
      assert.equal(edit.text, "\n\n");
      assert.equal(edit.cursor, 5);
      assert.equal(edit.anchor, 5);
      assert.equal(transport.sent.some((message) => message.type === "lock"), false);
      held.destroy();

      const view = createEditor(mounted.root, "hello\n\nworld\n", 0);
      helloEnd();
      press(event.inputType, event.data);
      assert.equal(view.getState().doc, "hello\n\n\n\nworld\n");
      assert.equal(view.getState().cursor, 7);
      assert.equal(view.getState().anchor, 7);
      view.destroy();

      const blockedTransport = rejecting();
      const blocked = createEditor(mounted.root, "hello\n\nworld\n", 0, blockedTransport);
      helloEnd();
      press(event.inputType, event.data);
      assert.equal(blockedTransport.sent.some((message) => message.type === "lock"), false);
      assert.equal(blockedTransport.sent.some((message) => message.type === "edit"), true);
      assert.equal(blocked.getState().doc, "hello\n\nworld\n");
      blocked.destroy();
    }
  } finally {
    mounted.restore();
  }
});

test("delete on an empty line removes that line", () => {
  const mounted = mountEditor();
  const press = () => {
    mounted.listeners.beforeinput({
      inputType: "deleteContentForward",
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
  const emptyBr = (start) => {
    const br = mounted.findAll((node) => {
      if (node.tagName !== "BR") return false;
      const line = node.parentElement;
      return line && line.dataset && line.dataset.start === start && line.dataset.start === line.dataset.end;
    })[0];
    assert.ok(br);
    return br;
  };
  const rejecting = () => ({
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
  });
  try {
    const transport = holdingTransport();
    const held = createEditor(mounted.root, "hello\n\nworld", 0, transport);
    caret(emptyBr("6"), 0);
    press();
    const edit = transport.sent.find((message) => message.type === "edit");
    assert.equal(edit.op, "delete");
    assert.equal(edit.cursor, 6);
    assert.equal(edit.anchor, 6);
    const locks = transport.sent.filter((message) => message.type === "lock");
    assert.equal(locks.length, 1);
    assert.equal(locks[0].anchor, 6);
    assert.equal(locks[0].cursor, 6);
    assert.ok(transport.sent.indexOf(locks[0]) < transport.sent.indexOf(edit));
    held.destroy();

    const view = createEditor(mounted.root, "hello\n\nworld", 0);
    caret(emptyBr("6"), 0);
    press();
    assert.equal(view.getState().doc, "hello\nworld");
    assert.equal(view.getState().cursor, 6);
    assert.equal(view.getState().anchor, 6);
    assert.equal(view.getState().doc[view.getState().cursor], "w");
    view.destroy();

    const joined = createEditor(mounted.root, "one\n\ntwo\n", 0);
    caret(emptyBr("4"), 0);
    press();
    assert.equal(joined.getState().doc, "one\ntwo\n");
    assert.equal(joined.getState().cursor, 4);
    assert.equal(joined.getState().doc[joined.getState().cursor], "t");
    joined.destroy();

    const heading = createEditor(mounted.root, "# Title\n\n- a\n", 0);
    caret(emptyBr("8"), 0);
    press();
    assert.equal(heading.getState().doc, "# Title\n- a\n");
    assert.equal(heading.getState().cursor, 8);
    assert.equal(heading.getState().doc[heading.getState().cursor], "-");
    heading.destroy();

    const item = createEditor(mounted.root, "- a\n\n# Next\n", 0);
    caret(emptyBr("4"), 0);
    press();
    assert.equal(item.getState().doc, "- a\n# Next\n");
    assert.equal(item.getState().cursor, 4);
    assert.equal(item.getState().doc[item.getState().cursor], "#");
    item.destroy();

    const trailingDoc = "hello\n";
    const trailingView = createEditor(mounted.root, trailingDoc, 0);
    const phantom = mounted.findAll((node) => {
      if (!node.classList || !node.classList.contains("md-line")) return false;
      return node.dataset
        && node.dataset.start === String(trailingDoc.length)
        && node.dataset.end === String(trailingDoc.length);
    });
    assert.equal(phantom.length, 0);
    trailingView.destroy();

    const leadingTransport = holdingTransport();
    const leadingHeld = createEditor(mounted.root, "\nworld", 0, leadingTransport);
    caret(emptyBr("0"), 0);
    press();
    const leadingEdit = leadingTransport.sent.find((message) => message.type === "edit");
    assert.equal(leadingEdit.op, "delete");
    assert.equal(leadingEdit.cursor, 0);
    assert.equal(leadingEdit.anchor, 0);
    assert.equal(leadingTransport.sent.some((message) => message.type === "lock"), false);
    leadingHeld.destroy();

    const leading = createEditor(mounted.root, "\nworld", 0);
    caret(emptyBr("0"), 0);
    press();
    assert.equal(leading.getState().doc, "world");
    assert.equal(leading.getState().cursor, 0);
    assert.equal(leading.getState().anchor, 0);
    leading.destroy();

    const insideTransport = holdingTransport();
    const insideHeld = createEditor(mounted.root, "hello\nworld", 0, insideTransport);
    const inside = mounted.findAll((node) => node.nodeType === 3 && node.textContent === "world")[0];
    caret(inside, 1);
    press();
    const insideEdit = insideTransport.sent.find((message) => message.type === "edit");
    assert.equal(insideEdit.op, "delete");
    assert.equal(insideEdit.cursor, 7);
    insideHeld.destroy();

    const word = createEditor(mounted.root, "hello\nworld", 0);
    const wordText = mounted.findAll((node) => node.nodeType === 3 && node.textContent === "world")[0];
    caret(wordText, 1);
    press();
    assert.equal(word.getState().doc, "hello\nwrld");
    assert.equal(word.getState().cursor, 7);
    word.destroy();

    const end = createEditor(mounted.root, "ab", 0);
    const letters = mounted.findAll((node) => node.nodeType === 3 && node.textContent === "ab")[0];
    caret(letters, letters.length);
    press();
    assert.equal(end.getState().doc, "ab");
    assert.equal(end.getState().cursor, 2);
    assert.equal(end.getState().anchor, 2);
    end.destroy();

    const blockedTransport = rejecting();
    const blocked = createEditor(mounted.root, "hello\n\nworld", 0, blockedTransport);
    caret(emptyBr("6"), 0);
    press();
    assert.equal(blockedTransport.sent.some((message) => message.type === "edit"), false);
    assert.equal(blocked.getState().doc, "hello\n\nworld");
    blocked.destroy();
  } finally {
    mounted.restore();
  }
});

test("word delete on an empty line removes that line", () => {
  const mounted = mountEditor();
  globalThis.NodeFilter = globalThis.NodeFilter || { SHOW_TEXT: 4 };
  const press = (inputType) => {
    mounted.listeners.beforeinput({ inputType, preventDefault() {} });
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
  const emptyBr = (start) => {
    const br = mounted.findAll((node) => {
      if (node.tagName !== "BR") return false;
      const line = node.parentElement;
      return line && line.dataset && line.dataset.start === start && line.dataset.start === line.dataset.end;
    })[0];
    assert.ok(br);
    return br;
  };
  try {
    const back = holdingTransport();
    const backHeld = createEditor(mounted.root, "one\n\ntwo\n", 0, back);
    caret(emptyBr("4"), 0);
    press("deleteWordBackward");
    const backEdit = back.sent.find((message) => message.type === "edit");
    assert.equal(backEdit.op, "backspace");
    assert.equal(backEdit.anchor, 4);
    assert.equal(backEdit.cursor, 4);
    assert.equal(back.sent.some((message) => message.type === "edit" && message.anchor !== 4), false);
    backHeld.destroy();

    const forward = holdingTransport();
    const forwardHeld = createEditor(mounted.root, "one\n\ntwo\n", 0, forward);
    caret(emptyBr("4"), 0);
    press("deleteWordForward");
    const forwardEdit = forward.sent.find((message) => message.type === "edit");
    assert.equal(forwardEdit.op, "backspace");
    assert.equal(forwardEdit.cursor, 4);
    forwardHeld.destroy();

    const applied = createEditor(mounted.root, "one\n\ntwo\n", 0);
    caret(emptyBr("4"), 0);
    press("deleteWordBackward");
    assert.equal(applied.getState().doc, "one\ntwo\n");
    assert.equal(applied.getState().cursor, 3);
    applied.destroy();

    const appliedForward = createEditor(mounted.root, "one\n\ntwo\n", 0);
    caret(emptyBr("4"), 0);
    press("deleteWordForward");
    assert.equal(appliedForward.getState().doc, "one\ntwo\n");
    assert.equal(appliedForward.getState().cursor, 3);
    appliedForward.destroy();

    const leading = holdingTransport();
    const leadingHeld = createEditor(mounted.root, "\ntwo\n", 0, leading);
    caret(emptyBr("0"), 0);
    press("deleteWordForward");
    const leadingEdit = leading.sent.find((message) => message.type === "edit");
    assert.equal(leadingEdit.op, "delete");
    assert.equal(leadingEdit.cursor, 0);
    leadingHeld.destroy();

    const word = createEditor(mounted.root, "alpha beta\n", 0);
    const text = mounted.findAll((node) => node.nodeType === 3 && node.textContent === "alpha beta")[0];
    caret(text, "alpha beta".length);
    press("deleteWordBackward");
    assert.equal(word.getState().doc, "alpha \n");
    word.destroy();
  } finally {
    mounted.restore();
  }
});

test("fence clicks open source", () => {
  const mounted = mountEditor();
  try {
    const table = createEditor(mounted.root, D, D.length);
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

    const closed = createEditor(mounted.root, D, D.length);
    const atom = mounted.findAll((node) => node.classList && node.classList.contains("md-table"))[0];
    mounted.listeners.click({ target: atom, clientX: 0, clientY: 0, preventDefault() {} });
    assert.equal(closed.getState().cursor, 0);
    assert.equal(closed.getState().anchor, 0);
    closed.destroy();

    const imageView = createEditor(mounted.root, F, 0);
    const image = mounted.findAll((node) => node.classList && node.classList.contains("md-image"))[0];
    mounted.listeners.click({ target: image, clientX: 1, clientY: 1, preventDefault() {} });
    assert.equal(imageView.getState().anchor, 3);
    assert.equal(imageView.getState().cursor, F.length);
    assert.equal(mounted.findAll((node) => node.classList && node.classList.contains("md-image")).length, 1);
    mounted.listeners.beforeinput({ inputType: "deleteContentBackward", preventDefault() {} });
    assert.equal(imageView.getState().doc, "Go\n");
    imageView.destroy();

    const imageDelete = createEditor(mounted.root, F, 0);
    const imageAgain = mounted.findAll((node) => node.classList && node.classList.contains("md-image"))[0];
    mounted.listeners.click({ target: imageAgain, clientX: 1, clientY: 1, preventDefault() {} });
    mounted.listeners.beforeinput({ inputType: "deleteContentForward", preventDefault() {} });
    assert.equal(imageDelete.getState().doc, "Go\n");
    imageDelete.destroy();

    const diagram = createEditor(mounted.root, E, E.length);
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

    const source = createEditor(mounted.root, "```js\nfull\n```\n", 20);
    const codeNodes = mounted.findAll((node) => node.classList && node.classList.contains("md-line") && node.classList.contains("md-codeblock"));
    assert.equal(codeNodes.length, 1);
    assert.equal(codeNodes[0].textContent, "full");
    assert.equal(mounted.findAll((node) => node.classList && node.classList.contains("md-fence-collapsed")).length, 0);
    source.destroy();

    const bare = "```\n```\n";
    const emptyFence = createEditor(mounted.root, bare, bare.length);
    const emptyLine = mounted.findAll((node) => node.classList && node.classList.contains("md-codeblock"))[0];
    assert.equal(emptyLine.dataset.start, String(bare.length - 1));
    assert.equal(emptyLine.dataset.end, String(bare.length - 1));
    const emptyBr = emptyLine.childNodes.find((node) => String(node.nodeName).toUpperCase() === "BR");
    assert.ok(emptyBr);
    assert.equal(mapOffset(emptyBr, 0), bare.length - 1);
    emptyFence.destroy();
  } finally {
    mounted.restore();
  }
});

test("an image line has a caret mark at its start and through its newline", () => {
  const mounted = mountEditor();
  const doc = "x\n\n![box](box.svg)\n";
  const view = createEditor(mounted.root, doc, doc.length);
  try {
    const image = mounted.findAll((node) => node.classList && node.classList.contains("md-image"))[0];
    const line = image.parentElement;
    const marks = line.childNodes.filter((node) => node.classList && node.classList.contains("md-image-caret"));
    assert.equal(marks.length, 2);
    assert.equal(marks[0].dataset.edge, "start");
    assert.equal(marks[0].dataset.start, "3");
    assert.equal(marks[0].dataset.end, "4");
    assert.equal(marks[0].textContent.length, 1);
    assert.equal(Number(marks[0].dataset.end) - Number(marks[0].dataset.start), marks[0].textContent.length);
    assert.equal(marks[0].styleProps["pointer-events"], "none");
    assert.equal(marks[1].styleProps["pointer-events"], "none");
    assert.equal(marks[1].dataset.edge, "end");
    assert.equal(marks[1].classList.contains("md-break"), true);
    assert.equal(marks[1].dataset.start, "18");
    assert.equal(marks[1].dataset.end, "19");
    assert.equal(marks[1].textContent.length > 1, true);
    assert.notEqual(Number(marks[1].dataset.end) - Number(marks[1].dataset.start), marks[1].textContent.length);
    const startText = marks[0].childNodes[0];
    const endText = marks[1].childNodes[0];
    assert.equal(mapOffset(startText, 0), 3);
    assert.equal(mapOffset(startText, 1), 3);
    assert.equal(mapOffset(endText, 0), 18);
    assert.equal(mapOffset(endText, 1), 19);
    assert.equal(mapOffset(endText, endText.textContent.length), 19);
    assert.equal(mapOffset(line, 0), 3);
    assert.equal(mapOffset(line, line.childNodes.length), 19);
    mounted.listeners.click({ target: image, clientX: 1, clientY: 1, preventDefault() {} });
    assert.equal(view.getState().anchor, 3);
    assert.equal(view.getState().cursor, doc.length);
    assert.equal(mounted.findAll((node) => node.classList && node.classList.contains("md-image")).length, 1);
    assert.equal(mounted.findAll((node) => node.classList && node.classList.contains("md-image-caret")).length, 2);

    const inlineDoc = "x![a](b)y\n";
    const inline = createEditor(mounted.root, inlineDoc, inlineDoc.length);
    const inlineImage = mounted.findAll((node) => node.classList && node.classList.contains("md-image")).pop();
    assert.equal(inlineImage.parentElement.childNodes.some((node) => node.classList && node.classList.contains("md-image-caret")), false);
    inline.destroy();
  } finally {
    view.destroy();
    mounted.restore();
  }
});

test("CB.5 pasting list items on the empty line under a list stays one list", () => {
  const mounted = mountEditor();
  const doc = "- a\n- b\n\n";
  const at = doc.length - 1;
  try {
    const view = createEditor(mounted.root, doc, at);
    mounted.listeners.paste({
      preventDefault() {},
      clipboardData: { getData: () => "- a\n- b" },
    });
    assert.equal(view.getState().doc, "- a\n- b\n- a\n- b\n");
    assert.equal(view.getState().cursor, "- a\n- b\n- a\n- b".length);
    view.destroy();

    const typed = createEditor(mounted.root, doc, at);
    mounted.listeners.beforeinput({
      inputType: "insertText",
      data: "x",
      preventDefault() {},
    });
    assert.equal(typed.getState().doc, "- a\n- b\n\nx\n");
    typed.destroy();
  } finally {
    mounted.restore();
  }
});

test("a paste inside a paragraph sends the picture at that caret", async () => {
  const mounted = mountEditor();
  const parent = {
    childNodes: [],
    appendChild(child) {
      this.childNodes.push(child);
      child.parentElement = this;
      return child;
    },
  };
  mounted.root.parentElement = parent;
  const sent = [];
  const binaries = [];
  let deliver = null;
  const transport = {
    username: "ada",
    memory: false,
    send(message) { sent.push(message); },
    sendBinary(bytes) { binaries.push(Uint8Array.from(bytes)); },
    subscribe(fn) {
      deliver = fn;
      return () => {};
    },
  };
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const editor = createEditor(mounted.root, "alpha beta\n", 8, transport);
  try {
    deliver({ type: "file", path: "pic.md", rev: 0, text: "alpha beta\n", cursor: 8, anchor: 8 });
    const file = {
      type: "image/png",
      name: "dot.png",
      arrayBuffer() {
        return Promise.resolve(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength));
      },
    };
    mounted.listeners.paste({
      preventDefault() {},
      clipboardData: { getData: () => "", files: [file] },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(editor.getState().doc, "alpha beta\n");
    const attach = sent.filter((message) => message.type === "attach");
    assert.equal(attach.length, 1);
    assert.equal(attach[0].cursor, 8);
    assert.equal(attach[0].path, "pic.md");
    assert.deepEqual(binaries[0], png);

    await new Promise((resolve) => setTimeout(resolve, 0));
    sent.length = 0;
    const dataUrl = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
    mounted.listeners.paste({
      preventDefault() {},
      clipboardData: { getData: () => dataUrl },
    });
    assert.equal(editor.getState().doc, "alpha beta\n");
    assert.equal(sent.filter((message) => message.type === "attach").length, 1);
    assert.equal(sent.some((message) => message.type === "edit"), false);

    await new Promise((resolve) => setTimeout(resolve, 0));
    sent.length = 0;
    mounted.listeners.paste({
      preventDefault() {},
      clipboardData: { getData: () => "see data:image/png;base64,@@" },
    });
    assert.equal(editor.getState().doc, "alpha beta\n");
    assert.equal(sent.length, 0);
    const notice = parent.childNodes.find((node) => node.className === "md-notice");
    assert.equal(notice.textContent, "not an image");
    assert.equal(notice.attrs.get("role"), "status");

    await new Promise((resolve) => setTimeout(resolve, 0));
    mounted.listeners.paste({
      preventDefault() {},
      clipboardData: { getData: () => "![a](https://example.com/a.png)" },
    });
    const edit = sent.find((message) => message.type === "edit");
    assert.equal(edit.text, "![a](https://example.com/a.png)");
    assert.equal(editor.getState().doc, "alpha beta\n");
  } finally {
    editor.destroy();
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
    const pending = createEditor(mounted.root, E, E.length);
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
    const failed = createEditor(mounted.root, E, E.length);
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
  const crossedLines = crossed.lines.filter((line) => !line.empty);
  assert.equal(crossedLines.length, 1);
  assert.equal(crossedLines[0].raw, true);
  assert.equal(crossedLines[0].runs.map((run) => run.text).join(""), "{c1}ab cd{/c1}");
  const crossedAb = crossedLines[0].runs.find((run) => run.text === "ab");
  assert.equal(crossedAb.start, 4);
  assert.equal(crossedAb.end, 6);
  assert.ok(crossedAb.classes.includes("md-comment"));
  const crossedOff = plan("{c1}ab\ncd{/c1}\n", 100);
  const crossedShown = crossedOff.lines.filter((line) => !line.empty);
  assert.equal(crossedShown.length, 1);
  assert.equal(crossedShown[0].raw, false);
  assert.equal(crossedShown[0].runs.map((run) => run.text).join(""), "ab cd");

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

function applyChanges(text, changes) {
  let doc = text;
  for (const change of changes) doc = doc.slice(0, change.from) + change.inserted + doc.slice(change.to);
  return doc;
}

test("addComment wraps a free range and appends an empty thread", () => {
  const added = addComment("hello fox\n", 6, 9);
  const marks = { from: 6, to: 9, inserted: "{c1}fox{/c1}", removed: "fox" };
  const fence = "\n```comment c1\n\n```\n";
  assert.deepEqual(added, {
    id: "c1",
    cursor: 10,
    doc: "hello {c1}fox{/c1}\n\n```comment c1\n\n```\n",
    changes: [
      marks,
      { from: "hello {c1}fox{/c1}\n".length, to: "hello {c1}fox{/c1}\n".length, inserted: fence, removed: "" },
    ],
  });
  assert.equal(applyChanges("hello fox\n", added.changes), added.doc);
  assert.ok(added.changes[0].to < added.changes[1].from);
  assert.equal(added.changes.some((change) => change.from <= 6 && change.to >= added.doc.indexOf("```comment")), false);
  assert.deepEqual(addComment("hello fox\n", 9, 6), added);
  const bare = addComment("hello fox", 6, 9);
  assert.equal(bare.doc, "hello {c1}fox{/c1}\n\n```comment c1\n\n```\n");
  assert.equal(applyChanges("hello fox", bare.changes), bare.doc);
  assert.equal(bare.changes.length, 2);
  assert.equal(addComment("hello fox\n", 6, 6), null);

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
  const commented = addComment(D, 2, 3);
  assert.notEqual(commented, null);
  assert.match(commented.doc, /\{c1\}a\{\/c1\}/);
  assert.match(commented.doc, /```comment c1/);
  assert.ok(commented.doc.startsWith("| "));
  assert.equal(addComment(E, 4, 8), null);
});

test("commentRangeReason names a fence, a table, or a split", () => {
  const added = addComment("hello fox\n", 6, 9);
  assert.equal(commentRangeReason("hello fox\n", 6, 6), null);
  assert.equal(commentRangeReason("```\ncode\n```\n", 0, 0), null);
  assert.equal(commentRangeReason("```python\nx\n```\n", 12, 13), "overlaps a fence");
  assert.equal(commentRangeReason(E, 4, 8), "overlaps a fence");
  assert.equal(commentRangeReason(D, 2, 3), null);
  assert.equal(commentRangeReason(D, 2, 7), "overlaps a table");
  assert.equal(commentRangeReason(D, 0, 3), "overlaps a table");
  assert.equal(commentRangeReason(added.doc, 11, 20), "splits a comment");
  assert.equal(commentRangeReason(added.doc, 10, 12), null);
  assert.equal(commentRangeReason(added.doc, 0, 4), null);
  assert.equal(addComment("```python\nx\n```\n", 12, 13), null);
  const commented = addComment(D, 2, 3);
  assert.notEqual(commented, null);
  assert.match(commented.doc, /\{c1\}a\{\/c1\}/);
  assert.match(commented.doc, /```comment c1/);
  assert.ok(commented.doc.startsWith("| "));
  assert.equal(addComment(added.doc, 11, 20), null);
  const mounted = mountEditor();
  try {
    const view = createEditor(mounted.root, commented.doc, commented.doc.length);
    const cell = mounted.findAll((node) => node.tagName === "TH" && node.textContent === "a" && node.closest(".md-table"))[0];
    assert.ok(cell);
    const marked = mounted.findAll((node) => node.classList && node.classList.contains("md-comment") && node.closest("th") === cell);
    assert.ok(marked.length > 0);
    assert.equal(cell.textContent.includes("{"), false);
    view.destroy();
  } finally {
    mounted.restore();
  }
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
    Object.defineProperty(el, "offsetHeight", { configurable: true, get() { return 30; } });
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
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
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
  const row = (aside.childNodes || []).find((node) => node.classList && node.classList.contains("md-show-resolved"));
  const checkbox = row && (row.childNodes || []).find((node) => node.tagName === "INPUT" && node.type === "checkbox");
  const label = row && (row.childNodes || []).find((node) => node.tagName === "LABEL");
  return { row, checkbox, label };
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
    const authorRule = css.match(/\.md-comment-author\s*\{[^}]*\}/);
    assert.ok(authorRule);
    assert.match(authorRule[0], /min-height:\s*1\.25em/);
    assert.match(authorRule[0], /font-weight:\s*700/);
    assert.equal(authorRule[0].includes("background"), false);
    assert.equal(authorRule[0].includes("border"), false);
    assert.match(css, /\.md-comment-text\s*\{[^}]*white-space:\s*pre-wrap;/);
    assert.match(css, /\.md-comment-text\s*\{[^}]*overflow-wrap:\s*anywhere;/);
    assert.match(css, /\.md-comment-text\s*\{[^}]*cursor:\s*text;/);
    assert.match(css, /\.md-comment-text\s*\{[^}]*min-height:\s*1\.25em;/);
    assert.match(css, /@media \(max-width:\s*800px\)\s*\{[^]*aside\.comments\s*\{[^}]*width:\s*100%;/);
    assert.match(css, /@media \(max-width:\s*800px\)\s*\{[^]*aside\.comments\s*\{[^}]*padding:\s*calc\(1\.75rem \+ 0\.65rem\) 1\.4rem 2rem/);
    assert.equal(/@media \(max-width:\s*800px\)\s*\{[^]*button\.md-doc-menu/.test(css), false);
    assert.match(css, /@media \(max-width:\s*800px\)\s*\{[^]*\.sheet\s*\{[^}]*display:\s*block;/);
    assert.match(css, /aside\.comments\s*\{[^}]*position:\s*relative;/);
    assert.match(css, /button\.md-doc-menu\s*\{/);
    assert.match(css, /div\.md-doc-menu-panel/);
    assert.equal(/button\.md-doc-link/.test(css), false);
    const resolvedRule = css.match(/\.md-show-resolved\s*\{[^}]*\}/);
    assert.ok(resolvedRule);
    assert.match(resolvedRule[0], /display:\s*flex/);
    assert.match(resolvedRule[0], /align-items:\s*center/);
    assert.match(resolvedRule[0], /gap:\s*0\.35rem/);
    assert.match(resolvedRule[0], /margin:\s*0/);
    assert.match(resolvedRule[0], /padding:\s*0\.45rem 2\.4rem 0\.2rem 0\.45rem/);
    assert.match(css, /\.md-show-resolved\[hidden\]\s*\{[^}]*display:\s*none/);
    assert.match(css, /\.md-show-resolved label\s*\{[^}]*margin:\s*0/);
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
    assert.equal(button.styleProps.left, `${mounted.aside.getBoundingClientRect().left}px`);
    assert.equal(button.styleProps.top, "40px");
    let prevented = false;
    button.listeners.mousedown({
      button: 1,
      preventDefault() {
        prevented = true;
      },
    });
    assert.equal(prevented, false);
    assert.equal(view.getState().doc, "hello fox two deer\n");
    button.listeners.mousedown({
      button: 0,
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
    assert.equal(view.getState().doc, "hello {c1}fox{/c1} two deer\n\n```comment c1\n:: 0\nhi\n```\n");
    const savedCard = mounted.findAll((node) => node.classList && node.classList.contains("md-comment-card"))[0];
    const savedNote = savedCard.childNodes[0];
    const savedRow = savedNote.childNodes[0];
    const savedBy = savedRow.childNodes[0];
    const savedAuthor = savedBy.childNodes[0];
    assert.equal(savedRow.classList.contains("md-comment-author-row"), true);
    assert.equal(savedBy.tagName, "DIV");
    assert.equal(savedBy.classList.contains("md-comment-by"), true);
    assert.equal(savedBy.childNodes.length, 1);
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
    assert.equal(savedText.dataset.note, "0");
    assert.equal(mounted.findAll((node) => node.tagName === "BUTTON" && node.textContent === "Save").length, 0);
    assert.equal(mounted.findAll((node) => node.tagName === "BUTTON" && node.textContent === "Cancel").length, 0);
    assert.equal(view.getState().undo.length, 2);
    mounted.aside.listeners.click({ target: savedText, preventDefault() {} });
    assert.equal(mounted.findAll((node) => node.tagName === "TEXTAREA").length, 0);
    assert.equal(savedText.textContent, "hi");
    assert.equal(view.getState().doc, "hello {c1}fox{/c1} two deer\n\n```comment c1\n:: 0\nhi\n```\n");

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
    assert.equal(cards[0].styleProps.top, "12px");
    assert.ok(tops[1] >= tops[0] + 30);
    const menu = docMenuOf(mounted.aside);
    assert.equal(mounted.aside.childNodes[0].classList.contains("md-attach-input"), true);
    assert.equal(mounted.aside.childNodes[0].hidden, true);
    assert.equal(mounted.aside.childNodes[1], menu.row);
    assert.equal(menu.row.hidden, true);
    assert.equal(menu.row.hasAttribute("hidden"), true);
    assert.equal(cards[0], mounted.aside.childNodes[2]);
    assert.equal(mounted.findAll((node) => node.classList && node.classList.contains("md-doc-commit")).length, 0);
    assert.equal(mounted.findAll((node) => node.classList && node.classList.contains("md-attach")).length, 0);
    assert.equal(mounted.findAll((node) => node.tagName === "BUTTON" && node.textContent === "Commit repo").length, 0);
    assert.equal(mounted.findAll((node) => node.classList && node.classList.contains("md-doc-link")).length, 0);
    assert.equal(menu.checkbox.type, "checkbox");
    assert.equal(menu.checkbox.id, "show-resolved");
    assert.equal(menu.checkbox.checked, false);
    assert.equal(menu.checkbox.disabled, false);
    assert.equal(menu.checkbox.parentElement, menu.row);
    assert.equal(menu.row.classList.contains("md-show-resolved"), true);
    assert.notEqual(mounted.aside.childNodes[0], menu.checkbox);
    assert.equal(menu.label.tagName, "LABEL");
    assert.equal(menu.label.textContent, "show resolved");
    assert.equal(menu.label.parentElement, menu.row);
    const keptInput = mounted.aside.childNodes[0];
    menu.checkbox.checked = true;
    menu.checkbox.listeners.change();
    const rerendered = docMenuOf(mounted.aside);
    assert.equal(mounted.aside.childNodes[0], keptInput);
    assert.equal(rerendered.checkbox.checked, true);
    assert.equal(rerendered.checkbox.parentElement, rerendered.row);
    assert.equal(rerendered.row.classList.contains("md-show-resolved"), true);
    assert.equal(rerendered.row.hidden, true);
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
    assert.equal(mounted.aside.childNodes[0].classList.contains("md-attach-input"), true);
    assert.equal(mounted.aside.childNodes[1], narrowMenu.row);
    assert.equal(narrowMenu.checkbox.type, "checkbox");
    assert.equal(narrowMenu.checkbox.parentElement, narrowMenu.row);
    assert.equal(narrowMenu.row.hidden, true);
    assert.notEqual(mounted.aside.childNodes[0], narrowMenu.checkbox);
    assert.equal(narrowMenu.label.textContent, "show resolved");
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
    assert.equal(checkbox.parentElement, openedMenu.row);
    assert.equal(openedMenu.row.hidden, true);
    assert.notEqual(mounted.aside.childNodes[0], checkbox);
    assert.equal(label.tagName, "LABEL");
    assert.equal(label.textContent, "show resolved");
    assert.equal(label.parentElement, openedMenu.row);
    assert.equal(mounted.aside.childNodes[0].classList.contains("md-attach-input"), true);
    chooseFox();
    const add = mounted.findAll((node) => node.className === "md-add-comment")[0];
    add.listeners.mousedown({ button: 0, preventDefault() {} });
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

    const opened = "hello {c1}fox{/c1} two deer\n\n```comment c1\n:: 0\nhi\n```\n";
    const saved = createEditor(mounted.root, opened, 0);
    let card = cards()[0];
    const idleRow = card.childNodes[0].childNodes[0];
    assert.equal(idleRow.classList.contains("md-comment-author-row"), true);
    assert.equal(idleRow.childNodes[0].tagName, "DIV");
    assert.equal(idleRow.childNodes[0].classList.contains("md-comment-by"), true);
    assert.equal(idleRow.childNodes[0].childNodes.length, 1);
    assert.equal(idleRow.childNodes[0].childNodes[0].tagName, "SPAN");
    assert.equal(idleRow.childNodes[0].childNodes[0].textContent, "");
    assert.equal(idleRow.childNodes[0].childNodes[0].classList.contains("md-comment-author"), true);
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
    assert.equal(text.textContent, "hi");
    openText(text.childNodes[0]);
    assert.equal(saved.getState().doc, opened);
    assert.equal(areas().length, 0);
    assert.equal(buttons("Save").length, 0);
    assert.equal(buttons("Cancel").length, 0);
    card = cards()[0];
    pressIn(card, "Reply");
    assert.equal(saved.getState().doc, "hello {c1}fox{/c1} two deer\n\n```comment c1\n:: 0\nhi\n```\n");
    card = cards()[0];
    const reply = card.childNodes.at(-3);
    assert.equal(reply.childNodes[0].classList.contains("md-comment-author-row"), true);
    assert.equal(reply.childNodes[0].childNodes[0].tagName, "DIV");
    assert.equal(reply.childNodes[0].childNodes[0].classList.contains("md-comment-by"), true);
    assert.equal(reply.childNodes[0].childNodes[0].childNodes[0].tagName, "SPAN");
    assert.equal(reply.childNodes[0].childNodes[0].childNodes[0].textContent, "");
    assert.equal(reply.childNodes[0].childNodes[0].childNodes.length, 1);
    assert.equal(reply.childNodes[0].childNodes.length, 2);
    assert.equal(reply.childNodes[0].childNodes.at(-1).getAttribute("aria-label"), "Copy link");
    assert.equal(reply.childNodes[1].tagName, "TEXTAREA");
    assert.equal(reply.childNodes[1].value, "");
    assert.equal(reply.childNodes[2].textContent, "Save");
    assert.equal(reply.childNodes[3].textContent, "Cancel");
    pressIn(reply, "Cancel");
    assert.equal(saved.getState().doc, "hello {c1}fox{/c1} two deer\n\n```comment c1\n:: 0\nhi\n```\n");
    assert.equal(areas().length, 0);
    assert.equal(texts()[0].textContent, "hi");
    card = cards()[0];
    pressIn(card, "Reply");
    card = cards()[0];
    const replyAgain = card.childNodes.at(-3);
    assert.equal(replyAgain.childNodes[0].childNodes[0].childNodes[0].tagName, "SPAN");
    replyAgain.childNodes[1].value = "more";
    mounted.aside.listeners.input({ target: replyAgain.childNodes[1] });
    const undoReply = saved.getState().undo.length;
    pressIn(replyAgain, "Save");
    assert.equal(saved.getState().doc, "hello {c1}fox{/c1} two deer\n\n```comment c1\n:: 0\nhi\n:: 1\nmore\n```\n");
    assert.equal(saved.getState().undo.length, undoReply + 1);
    assert.equal(areas().length, 0);
    assert.deepEqual(texts().map((item) => item.textContent), ["hi", "more"]);
    assert.deepEqual(texts().map((item) => item.dataset.note), ["0", "1"]);
    openText(texts()[1]);
    assert.equal(saved.getState().doc, "hello {c1}fox{/c1} two deer\n\n```comment c1\n:: 0\nhi\n:: 1\nmore\n```\n");
    assert.equal(cards()[0].childNodes[0].childNodes[1].textContent, "hi");
    assert.equal(cards()[0].childNodes[0].childNodes[1].classList.contains("md-comment-text"), true);
    assert.equal(areas().length, 0);
    assert.deepEqual(texts().map((item) => item.textContent), ["hi", "more"]);
    card = cards()[0];
    const undoResolve = saved.getState().undo.length;
    pressIn(card, "Resolve");
    assert.equal(saved.getState().undo.length, undoResolve + 1);
    assert.equal(saved.getState().doc, "hello {c1}fox{/c1} two deer\n\n```comment c1 resolved\n:: 0\nhi\n:: 1\nmore\n```\n");
    assert.equal(saved.getState().doc.includes("{c1}fox{/c1}"), true);
    assert.equal(cards().length, 0);
    assert.equal(mounted.findAll((node) => node.classList && node.classList.contains("md-comment")).length, 0);
    let shown = docMenuOf(mounted.aside);
    assert.equal(shown.row.hidden, false);
    let toggle = shown.checkbox;
    assert.equal(toggle.checked, false);
    assert.equal(toggle.disabled, false);
    assert.notEqual(mounted.aside.childNodes[0], toggle);
    toggle.checked = true;
    toggle.listeners.change();
    assert.equal(cards().length, 1);
    assert.ok(mounted.findAll((node) => node.classList && node.classList.contains("md-comment")).length > 0);
    assert.equal(areas().length, 0);
    assert.deepEqual(texts().map((item) => item.textContent), ["hi", "more"]);
    pressIn(cards()[0], "Resolve");
    assert.equal(saved.getState().doc, "hello {c1}fox{/c1} two deer\n\n```comment c1\n:: 0\nhi\n:: 1\nmore\n```\n");
    assert.equal(cards().length, 1);
    toggle = docMenuOf(mounted.aside).checkbox;
    assert.equal(toggle.checked, true);
    assert.equal(docMenuOf(mounted.aside).row.hidden, true);
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
    assert.equal(saved.getState().doc, "hello {c1}fox{/c1} two deer\n\n```comment c1\n:: 0\nhi\n:: 1\nmore\n```\n");
    saved.destroy();
    mounted.setSelection(null);

    const knownDoc = "hello {c1}fox{/c1} two deer\n\n```comment c1\nhi\n```\n";
    const known = createEditor(mounted.root, knownDoc, 0);
    assert.equal(areas().length, 0);
    assert.equal(texts()[0].textContent, "hi");
    openText(texts()[0]);
    assert.equal(known.getState().doc, knownDoc);
    assert.equal(areas().length, 0);
    assert.equal(texts()[0].textContent, "hi");
    openText(texts()[0].childNodes[0]);
    assert.equal(areas().length, 0);
    assert.equal(texts()[0].textContent, "hi");
    assert.equal(known.getState().doc, knownDoc);
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
    assert.equal(notes.getState().doc, "Say {c1}fox{/c1} now.\n\n```comment c1\n:: 0\n**hi**\n:: 1\nmore\n```\n");
    assert.equal(areas().length, 0);
    assert.deepEqual(texts().map((item) => item.textContent), ["**hi**", "more"]);
    assert.equal(mounted.findAll((node) => node.classList && node.classList.contains("md-strong")).length, 0);
    notes.destroy();
    mounted.setSelection(null);

    const hidden = createEditor(mounted.root, "hello {c1}fox{/c1} two deer\n\n```comment c1 resolved\nhi\n```\n", 0);
    assert.equal(cards().length, 0);
    assert.equal(mounted.findAll((node) => node.classList && node.classList.contains("md-comment")).length, 0);
    const showMenu = docMenuOf(mounted.aside);
    const show = showMenu.checkbox;
    assert.equal(show.checked, false);
    assert.equal(show.disabled, false);
    assert.equal(show.parentElement, showMenu.row);
    assert.equal(showMenu.row.classList.contains("md-show-resolved"), true);
    assert.equal(showMenu.row.hidden, false);
    assert.equal(showMenu.row.hasAttribute("hidden"), false);
    assert.equal(mounted.aside.childNodes[0].classList.contains("md-attach-input"), true);
    assert.equal(mounted.aside.childNodes[1], showMenu.row);
    assert.notEqual(mounted.aside.childNodes[0], show);
    assert.equal(showMenu.label.textContent, "show resolved");
    assert.equal(showMenu.label.parentElement, showMenu.row);
    show.checked = true;
    show.listeners.change();
    assert.ok(mounted.findAll((node) => node.classList && node.classList.contains("md-comment")).length > 0);
    assert.equal(cards().length, 1);
    assert.equal(docMenuOf(mounted.aside).row.hidden, false);
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

test("comment cards stay near their anchors", () => {
  const mounted = mountSheet();
  const cards = () => mounted.findAll((node) => node.classList && node.classList.contains("md-comment-card"));
  try {
    let doc = "one two three\n";
    const first = addComment(doc, 0, 3);
    doc = first.doc;
    const twoAt = doc.indexOf("two");
    const second = addComment(doc, twoAt, twoAt + 3);
    doc = second.doc;
    const threeAt = doc.indexOf("three");
    const third = addComment(doc, threeAt, threeAt + 5);
    doc = third.doc;
    assert.equal(doc.indexOf("one"), 4);
    assert.equal(doc.indexOf("two"), 17);
    assert.equal(doc.indexOf("three"), 30);
    globalThis.window.matchMedia = () => ({ matches: false });
    const view = createEditor(mounted.root, doc, 0);
    assert.deepEqual(cards().map((card) => card.dataset.comment), ["c1", "c2", "c3"]);
    assert.deepEqual(cards().map((card) => card.styleProps.top), ["12px", "54px", "96px"]);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("comment cards start below the shown comment controls", () => {
  const mounted = mountSheet();
  let onResize = null;
  globalThis.window.addEventListener = (type, fn) => {
    if (type === "resize") onResize = fn;
  };
  const box = (top, height, left = 0, width = 120) => ({
    top, left, right: left + width, bottom: top + height, width, height,
  });
  try {
    globalThis.window.matchMedia = () => ({ matches: false });
    const view = createEditor(mounted.root, "hello {c1}fox{/c1} two deer\n\n```comment c1\n:: 0\nhi\n```\n", 0);
    const card = () => mounted.findAll((node) => node.classList && node.classList.contains("md-comment-card"))[0];
    const input = mounted.aside.childNodes[0];
    const row = docMenuOf(mounted.aside).row;
    assert.equal(input.classList.contains("md-attach-input"), true);
    assert.equal(card().styleProps.top, "12px");
    const asideTop = 100;
    mounted.aside.getBoundingClientRect = () => box(asideTop, 500, 0, 320);
    input.getBoundingClientRect = () => box(asideTop + 200, 30);
    onResize();
    assert.equal(card().styleProps.top, "12px");
    const show = (el) => {
      el.hidden = false;
      el.removeAttribute("hidden");
    };
    show(input);
    onResize();
    assert.equal(card().styleProps.top, "230px");
    input.hidden = true;
    input.setAttribute("hidden", "");
    onResize();
    assert.equal(card().styleProps.top, "12px");
    show(row);
    row.getBoundingClientRect = () => box(asideTop + 80, 36);
    onResize();
    assert.equal(card().styleProps.top, "128px");
    globalThis.window.matchMedia = () => ({ matches: true });
    onResize();
    assert.equal(card().styleProps.position, "static");
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("crowded comment cards stay short and in anchor order", () => {
  const mounted = mountSheet();
  const cards = () => mounted.findAll((node) => node.classList && node.classList.contains("md-comment-card"));
  let onResize = null;
  globalThis.window.addEventListener = (type, fn) => {
    if (type === "resize") onResize = fn;
  };
  const usedHeight = (card) => {
    const max = card.styleProps["max-height"];
    if (typeof max === "string" && max.endsWith("px")) return Number.parseFloat(max);
    return card.offsetHeight;
  };
  const assertStacked = () => {
    const placed = cards();
    for (let i = 1; i < placed.length; i += 1) {
      const prev = Number.parseFloat(placed[i - 1].styleProps.top);
      const next = Number.parseFloat(placed[i].styleProps.top);
      assert.ok(next >= prev + usedHeight(placed[i - 1]));
    }
  };
  const clickCard = (index) => {
    const card = cards()[index];
    mounted.aside.listeners.click({ target: card, preventDefault() {} });
  };
  try {
    let doc = "one two three\n";
    const first = addComment(doc, 0, 3);
    doc = first.doc;
    const twoAt = doc.indexOf("two");
    const second = addComment(doc, twoAt, twoAt + 3);
    doc = second.doc;
    const threeAt = doc.indexOf("three");
    const third = addComment(doc, threeAt, threeAt + 5);
    doc = third.doc;
    globalThis.window.matchMedia = () => ({ matches: false });
    const view = createEditor(mounted.root, doc, 0);
    assert.equal(typeof onResize, "function");
    assert.deepEqual(cards().map((card) => card.dataset.comment), ["c1", "c2", "c3"]);
    const starts = { c1: "100", c2: "140", c3: "180" };
    for (const node of mounted.findAll((node) => node.classList && node.classList.contains("md-comment") && node.dataset)) {
      if (starts[node.dataset.comment]) node.dataset.start = starts[node.dataset.comment];
    }
    for (const card of cards()) {
      Object.defineProperty(card, "offsetHeight", { configurable: true, get() { return 290; } });
    }
    onResize();
    assert.deepEqual(cards().map((card) => card.styleProps.top), ["100px", "140px", "180px"]);
    assert.equal(cards()[0].styleProps["max-height"], "28px");
    assert.equal(cards()[0].styleProps.overflow, "hidden");
    assert.equal(cards()[1].styleProps["max-height"], "28px");
    assert.equal(cards()[1].styleProps.overflow, "hidden");
    assert.equal(cards()[2].styleProps["max-height"] || "", "");
    assert.equal(cards()[2].styleProps.overflow || "", "");
    assertStacked();

    clickCard(1);
    assert.equal(cards()[1].classList.contains("md-comment-current"), true);
    assert.equal(cards()[1].styleProps["max-height"] || "", "");
    assert.equal(cards()[1].styleProps.overflow || "", "");
    assert.deepEqual(cards().map((card) => card.styleProps.top), ["100px", "140px", "442px"]);
    assertStacked();

    clickCard(0);
    assert.equal(cards()[0].classList.contains("md-comment-current"), true);
    assert.equal(cards()[1].classList.contains("md-comment-current"), false);
    assert.deepEqual(cards().map((card) => card.styleProps.top), ["100px", "402px", "426px"]);
    assert.equal(cards()[1].styleProps["max-height"], "12px");
    assert.equal(cards()[1].styleProps.overflow, "hidden");
    assert.ok(Number.parseFloat(cards()[1].styleProps.top) - 140 < 800);
    assert.ok(Number.parseFloat(cards()[2].styleProps.top) - 180 < 800);
    assertStacked();

    globalThis.window.matchMedia = () => ({ matches: true });
    onResize();
    assert.ok(cards().every((card) => card.styleProps.position === "static"));
    assert.ok(cards().every((card) => (card.styleProps["max-height"] || "") === ""));
    assert.ok(cards().every((card) => (card.styleProps.overflow || "") === ""));
    view.destroy();
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

    const ownedDoc = "hello {c1}fox{/c1} two deer\n\n```comment c1\n@2026-10-04T20:30:22.000Z Ada\nhi\n```\n";
    const owned = createMemoryTransport(ownedDoc, 0);
    owned.username = "Ada";
    const known = createEditor(mounted.root, ownedDoc, 0, owned);
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
    assert.equal(known.getState().doc, ownedDoc);
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
    add.listeners.mousedown({ button: 0, preventDefault() {} });
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
    assert.equal(editing("c1").length, 0);
    assert.equal(editing("c2").length, 0);
    assert.equal(areas().length, 0);
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
    assert.equal(areas().length, 0);
    assert.equal(resolved.getState().doc, knownDoc);
    assert.equal(texts()[0].textContent, "hi");
    assert.deepEqual(currentCards().map((card) => card.dataset.comment), ["c1"]);
    assert.equal(editing("c1").length, 0);
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
    assert.equal(adaAuthor.textContent, "");
    assert.equal(named.getState().doc, knownDoc);
    assert.equal(named.getState().doc.includes("Ada"), false);
    named.destroy();

    const view = createEditor(mounted.root, knownDoc, 0);
    const card = cards()[0];
    assert.equal(card.classList.contains("md-comment-current"), false);
    const row = card.childNodes[0].childNodes[0];
    const by = row.childNodes[0];
    const author = by.childNodes[0];
    assert.equal(by.tagName, "DIV");
    assert.equal(by.classList.contains("md-comment-by"), true);
    assert.equal(by.childNodes.length, 1);
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
    assert.equal(stroke(remove), "M18 6 6 18M6 6l12 12");
    assert.equal(link.classList.contains("md-comment-link"), true);
    assert.equal(link.classList.contains("icon-btn"), true);
    assert.equal(link.getAttribute("aria-label"), "Copy link");
    assert.equal(link.childNodes[0].localName, "svg");
    for (const button of [resolve, reply, remove, link]) assert.equal(button.hidden, true);

    mounted.aside.listeners.click({ target: card, preventDefault() {} });
    assert.equal(card.classList.contains("md-comment-current"), true);
    for (const button of [resolve, reply, remove, link]) assert.equal(button.hidden, false);
    assert.equal(row.childNodes[0], by);
    assert.equal(by.childNodes[0], author);

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

test("a comment note keeps the poster who saved it", () => {
  assert.deepEqual(splitCommentNote("hi"), { time: "", author: "", text: "hi" });
  assert.deepEqual(splitCommentNote(""), { time: "", author: "", text: "" });
  assert.deepEqual(splitCommentNote(null), { time: "", author: "", text: "" });
  assert.deepEqual(splitCommentNote("@2026-10-04T20:30:22.000Z Grok\nquestion"), {
    time: "2026-10-04T20:30:22.000Z",
    author: "Grok",
    text: "question",
  });
  assert.deepEqual(splitCommentNote("@2026-10-04T20:30:22.000Z Ada Lovelace\nquestion\nmore"), {
    time: "2026-10-04T20:30:22.000Z",
    author: "Ada Lovelace",
    text: "question\nmore",
  });
  assert.deepEqual(splitCommentNote("@2026-10-04T20:30:22.000Z Grok"), {
    time: "2026-10-04T20:30:22.000Z",
    author: "Grok",
    text: "",
  });
  assert.deepEqual(splitCommentNote("@2026-10-04T20:30:22.000Z Grok\n"), {
    time: "2026-10-04T20:30:22.000Z",
    author: "Grok",
    text: "",
  });
  assert.deepEqual(splitCommentNote("question\n@2026-10-04T20:30:22.000Z Grok"), {
    time: "",
    author: "",
    text: "question\n@2026-10-04T20:30:22.000Z Grok",
  });
  assert.deepEqual(splitCommentNote("@2026-10-04T20:30:22.000Z"), {
    time: "",
    author: "",
    text: "@2026-10-04T20:30:22.000Z",
  });
  assert.deepEqual(splitCommentNote("@2026-10-04T20:30:22Z Grok\nquestion"), {
    time: "",
    author: "",
    text: "@2026-10-04T20:30:22Z Grok\nquestion",
  });

  const css = readFileSync(new URL("../editor.css", import.meta.url), "utf8");
  const timeRule = css.match(/\.md-comment-time\s*\{[^}]*\}/);
  assert.ok(timeRule);
  assert.match(timeRule[0], /font-size:\s*0\.75rem/);
  assert.match(timeRule[0], /font-weight:\s*400/);
  assert.equal(timeRule[0].includes("background"), false);
  assert.equal(timeRule[0].includes("border"), false);

  const mounted = mountSheet();
  const authors = () => mounted.findAll((node) => node.classList && node.classList.contains("md-comment-author"));
  const times = () => mounted.findAll((node) => node.classList && node.classList.contains("md-comment-time"));
  const texts = () => mounted.findAll((node) => node.classList && node.classList.contains("md-comment-text"));
  const areas = () => mounted.findAll((node) => node.tagName === "TEXTAREA");
  const cards = () => mounted.findAll((node) => node.classList && node.classList.contains("md-comment-card"));
  const press = (label) => {
    const button = mounted.findAll((node) => node.tagName === "BUTTON" && (
      node.textContent === label || (typeof node.getAttribute === "function" && node.getAttribute("aria-label") === label)
    )).at(-1);
    assert.ok(button, label);
    button.listeners.click({ target: button, preventDefault() {} });
  };
  const named = (doc, name) => {
    const memory = createMemoryTransport(doc, 0);
    memory.username = name;
    return createEditor(mounted.root, doc, 0, memory);
  };
  try {
    globalThis.NodeFilter = globalThis.NodeFilter || { SHOW_TEXT: 4 };
    const grok = "@2026-10-04T20:30:22.000Z Grok\nquestion";
    const paul = "@2026-10-04T21:15:00.000Z Paul\nreply";
    const doc = `See {c1}fox{/c1}.\n\n\`\`\`comment c1\n${grok}\n::\n${paul}\n\`\`\`\n`;
    const view = named(doc, "Ada");
    assert.deepEqual(authors().map((node) => node.textContent), ["Grok", "Paul"]);
    assert.deepEqual(times().map((node) => node.tagName), ["SPAN", "TIME", "TIME"]);
    assert.deepEqual(times().map((node) => node.textContent), ["(c1)", "2026-10-04 20:30", "2026-10-04 21:15"]);
    assert.deepEqual(times().filter((node) => node.tagName === "TIME").map((node) => node.getAttribute("datetime")), [
      "2026-10-04T20:30:22.000Z",
      "2026-10-04T21:15:00.000Z",
    ]);
    assert.deepEqual(texts().map((node) => node.textContent), ["question", "reply"]);
    assert.equal(view.getState().doc, doc);
    assert.equal(view.getState().doc.includes("Ada"), false);
    const firstBy = cards()[0].childNodes[0].childNodes[0].childNodes[0];
    assert.equal(firstBy.classList.contains("md-comment-by"), true);
    assert.equal(firstBy.childNodes[0].tagName, "SPAN");
    assert.equal(firstBy.childNodes[0].textContent, "(c1)");
    assert.equal(firstBy.childNodes[1].classList.contains("md-comment-author"), true);
    assert.equal(firstBy.childNodes[1].textContent, "Grok");
    assert.equal(firstBy.childNodes[2].tagName, "TIME");
    assert.equal(firstBy.childNodes[2].classList.contains("md-comment-time"), true);
    assert.equal(firstBy.childNodes[2].textContent, "2026-10-04 20:30");
    const firstRow = firstBy.parentElement;
    assert.equal(firstRow.childNodes[0], firstBy);
    assert.equal(firstRow.childNodes[1].getAttribute("aria-label"), "Resolve");
    assert.equal(firstRow.childNodes.at(-1).getAttribute("aria-label"), "Copy link");

    press("Reply");
    assert.equal(view.getState().doc, doc);
    const reply = cards()[0].childNodes.at(-3);
    const replyBy = reply.childNodes[0].childNodes[0];
    assert.equal(replyBy.classList.contains("md-comment-by"), true);
    assert.equal(replyBy.childNodes.length, 1);
    assert.equal(replyBy.childNodes[0].textContent, "Ada");
    assert.equal(authors()[0].textContent, "Grok");
    assert.equal(authors()[1].textContent, "Paul");
    assert.equal(times().length, 3);
    reply.childNodes[1].value = "thanks";
    press("Save");
    const saved = view.getState().doc;
    const stamped = saved.match(/@(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) Ada\nthanks/);
    assert.ok(stamped);
    assert.equal(saved.includes("@2026-10-04T20:30:22.000Z Grok\nquestion"), true);
    assert.equal(saved.includes("@2026-10-04T21:15:00.000Z Paul\nreply"), true);
    assert.deepEqual(authors().map((node) => node.textContent), ["Grok", "Paul", "Ada"]);
    const clocks = () => times().filter((node) => node.tagName === "TIME");
    assert.equal(clocks()[2].getAttribute("datetime"), stamped[1]);
    assert.equal(clocks()[2].textContent, stamped[1].replace("T", " ").slice(0, 16));
    assert.equal(times().filter((node) => node.tagName === "SPAN").every((node) => node.textContent === "(c1)"), true);
    assert.deepEqual(texts().map((node) => node.textContent), ["question", "reply", "thanks"]);

    const beforeGrok = view.getState().doc;
    mounted.aside.listeners.click({ target: texts()[0], preventDefault() {} });
    assert.equal(areas().length, 0);
    assert.equal(view.getState().doc, beforeGrok);
    assert.equal(texts()[0].textContent, "question");
    assert.equal(authors()[0].textContent, "Grok");
    mounted.aside.listeners.click({ target: texts()[2], preventDefault() {} });
    const adaBox = areas()[0];
    assert.equal(adaBox.value, "thanks");
    const undoSame = view.getState().undo.length;
    press("Save");
    assert.equal(view.getState().doc, beforeGrok);
    assert.equal(view.getState().undo.length, undoSame);
    assert.equal(texts()[2].textContent, "thanks");
    mounted.aside.listeners.click({ target: texts()[2], preventDefault() {} });
    areas()[0].value = "cheers";
    press("Save");
    const edited = view.getState().doc;
    assert.equal(edited.includes(`${stamped[1]} Ada\ncheers`), true);
    assert.equal(edited.includes("thanks"), false);
    assert.equal(edited.includes("@2026-10-04T20:30:22.000Z Grok\nquestion"), true);
    assert.equal(edited.includes("@2026-10-04T21:15:00.000Z Paul\nreply"), true);
    assert.equal(authors()[2].textContent, "Ada");
    assert.equal(clocks()[2].getAttribute("datetime"), stamped[1]);
    assert.equal(texts()[2].textContent, "cheers");
    view.destroy();

    const plain = "See {c1}fox{/c1}.\n\n```comment c1\nhi\n```\n";
    const headerless = named(plain, "Ada");
    assert.equal(authors()[0].textContent, "");
    assert.equal(times().length, 0);
    assert.equal(headerless.getState().doc.includes("Ada"), false);
    mounted.aside.listeners.click({ target: texts()[0], preventDefault() {} });
    assert.equal(areas().length, 0);
    assert.equal(headerless.getState().doc, plain);
    assert.equal(headerless.getState().doc.includes("@"), false);
    assert.equal(texts()[0].textContent, "hi");
    assert.equal(authors()[0].textContent, "");
    headerless.destroy();

    const laterDoc = "See {c1}fox{/c1}.\n\n```comment c1\nhi\n@2026-10-04T20:30:22.000Z Grok\n```\n";
    const later = named(laterDoc, "Ada");
    assert.equal(authors()[0].textContent, "");
    assert.equal(times().length, 0);
    assert.equal(texts()[0].textContent, "hi\n@2026-10-04T20:30:22.000Z Grok");
    assert.equal(later.getState().doc, laterDoc);
    later.destroy();

    const fresh = named("hello fox two deer\n", "Ada");
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
    add.listeners.mousedown({ button: 0, preventDefault() {} });
    assert.equal(authors()[0].textContent, "Ada");
    assert.equal(times().length, 0);
    assert.equal(areas()[0].value, "");
    areas()[0].value = "hello";
    press("Save");
    const freshDoc = fresh.getState().doc;
    const freshStamp = freshDoc.match(/@(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) Ada\nhello/);
    assert.ok(freshStamp);
    assert.equal(freshDoc.includes(`:: 0\n@${freshStamp[1]} Ada\nhello`), true);
    assert.equal(authors()[0].textContent, "Ada");
    assert.equal(times().length, 2);
    assert.equal(times()[0].tagName, "SPAN");
    assert.equal(times()[0].textContent, "(c1)");
    assert.equal(times()[1].tagName, "TIME");
    assert.equal(times()[1].getAttribute("datetime"), freshStamp[1]);
    assert.equal(times()[1].textContent, freshStamp[1].replace("T", " ").slice(0, 16));
    assert.equal(texts()[0].textContent, "hello");
    press("Reply");
    const unsaved = cards()[0].childNodes.at(-3);
    const unsavedBy = unsaved.childNodes[0].childNodes[0];
    assert.equal(unsavedBy.childNodes[0].textContent, "Ada");
    assert.equal(unsavedBy.childNodes.length, 1);
    assert.equal(authors()[0].textContent, "Ada");
    assert.equal(times().length, 2);
    assert.equal(fresh.getState().doc, freshDoc);
    unsaved.childNodes[1].value = "more";
    press("Save");
    assert.equal(fresh.getState().doc.includes(`${freshStamp[1]} Ada\nhello`), true);
    assert.match(fresh.getState().doc, /:: 1\n@\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z Ada\nmore/);
    assert.deepEqual(authors().map((node) => node.textContent), ["Ada", "Ada"]);
    fresh.destroy();
    mounted.setSelection(null);
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

test("a 409 naming qa-two flashes that lock, drops the queued edit, and keeps the granted caret", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const mounted = mountEditor();
  const transport = holdingTransport();
  transport.username = "me";
  const doc = "one\n\ntwo\n";
  const locks = {
    type: "locks",
    lines: [
      { index: 0, username: "qa-two" },
      { index: 2, username: "ada" },
    ],
  };
  const lineHolding = (text) => {
    const node = walkNodes(mounted.root, (item) => item.nodeType === 3 && item.textContent === text)[0];
    assert.ok(node, text);
    const line = node.parentElement.closest(".md-line");
    assert.ok(line);
    return line;
  };
  const lockNamed = (name) => {
    const marks = walkNodes(mounted.root, (node) => node.classList && node.classList.contains("md-lock") && node.textContent === name);
    assert.equal(marks.length, 1);
    return marks[0];
  };
  try {
    const view = createEditor(mounted.root, doc, 6, transport);
    const granted = view.getState().cursor;
    assert.equal(granted, 6);
    transport.deliver(locks);
    const holder = lockNamed("qa-two");
    assert.equal(holder.className, "md-lock");
    assert.equal(holder.closest(".md-line").textContent.includes("one"), true);
    assert.equal(lockNamed("ada").closest(".md-line").textContent.includes("two"), true);
    insertText(mounted, "X");
    insertText(mounted, "Y");
    transport.deliver({ type: "error", status: 409, heldBy: "qa-two" });
    const flashed = lockNamed("qa-two");
    assert.equal(flashed.classList.contains("md-lock"), true);
    assert.equal(flashed.classList.contains("md-flash"), true);
    assert.notEqual(flashed.className, "md-lock");
    assert.equal(flashed.closest(".md-line").textContent.includes("one"), true);
    assert.equal(flashed.closest(".md-line").textContent.includes("qa-two"), true);
    assert.equal(lockNamed("ada").className, "md-lock");
    assert.equal(lineHolding("two").classList.contains("md-flash"), false);
    assert.equal(transport.sent.some((message) => message.type === "edit" && message.text === "Y"), false);
    assert.equal(view.getState().doc, doc);
    assert.equal(view.getState().cursor, granted);
    assert.equal(view.getState().anchor, granted);
    insertText(mounted, "Z");
    assert.equal(transport.sent.filter((message) => message.type === "edit").at(-1).text, "Z");
    t.mock.timers.tick(999);
    transport.deliver(locks);
    assert.equal(lockNamed("qa-two").classList.contains("md-flash"), true);
    assert.notEqual(lockNamed("qa-two").className, "md-lock");
    assert.equal(lockNamed("ada").className, "md-lock");
    t.mock.timers.tick(1);
    assert.equal(lockNamed("qa-two").className, "md-lock");
    transport.deliver(locks);
    assert.equal(lockNamed("qa-two").className, "md-lock");
    assert.equal(view.getState().cursor, granted);
    assert.equal(view.getState().anchor, granted);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("a 409 with no holder marks the caret's line", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const mounted = mountEditor();
  const transport = holdingTransport();
  transport.username = "me";
  const doc = "one\n\ntwo\n";
  const locks = {
    type: "locks",
    lines: [
      { index: 0, username: "qa-two" },
      { index: 2, username: "ada" },
    ],
  };
  const lineHolding = (text) => {
    const node = walkNodes(mounted.root, (item) => item.nodeType === 3 && item.textContent === text)[0];
    assert.ok(node, text);
    const line = node.parentElement.closest(".md-line");
    assert.ok(line);
    return line;
  };
  const lockNamed = (name) => {
    const marks = walkNodes(mounted.root, (node) => node.classList && node.classList.contains("md-lock") && node.textContent === name);
    assert.equal(marks.length, 1);
    return marks[0];
  };
  try {
    const view = createEditor(mounted.root, doc, 6, transport);
    const granted = view.getState().cursor;
    assert.equal(granted, 6);
    transport.deliver(locks);
    insertText(mounted, "X");
    insertText(mounted, "Y");
    transport.deliver({ type: "error", status: 409 });
    const caretLine = lineHolding("two");
    assert.equal(caretLine.classList.contains("md-line"), true);
    assert.equal(caretLine.classList.contains("md-flash"), true);
    assert.equal(caretLine.textContent.includes("two"), true);
    assert.equal(lineHolding("one").classList.contains("md-flash"), false);
    assert.equal(lockNamed("qa-two").className, "md-lock");
    assert.equal(lockNamed("ada").className, "md-lock");
    assert.equal(transport.sent.some((message) => message.type === "edit" && message.text === "Y"), false);
    assert.equal(view.getState().doc, doc);
    assert.equal(view.getState().cursor, granted);
    assert.equal(view.getState().anchor, granted);
    t.mock.timers.tick(999);
    transport.deliver(locks);
    assert.equal(lineHolding("two").classList.contains("md-flash"), true);
    assert.equal(lineHolding("one").classList.contains("md-flash"), false);
    assert.equal(lockNamed("ada").className, "md-lock");
    t.mock.timers.tick(1);
    assert.equal(lineHolding("two").classList.contains("md-flash"), false);
    transport.deliver(locks);
    assert.equal(lineHolding("two").classList.contains("md-flash"), false);
    assert.equal(view.getState().cursor, granted);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("a collapsed boundary delete is not sent", () => {
  const mounted = mountEditor();
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
  const press = (inputType) => {
    mounted.listeners.beforeinput({
      inputType,
      preventDefault() {},
    });
  };
  const caret = (node, anchor, focus) => {
    globalThis.window.getSelection = () => ({
      rangeCount: 1,
      anchorNode: node,
      anchorOffset: anchor,
      focusNode: node,
      focusOffset: focus,
      removeAllRanges() {},
      addRange() {},
      getRangeAt() {
        const start = Math.min(anchor, focus);
        const end = Math.max(anchor, focus);
        return {
          startContainer: node,
          startOffset: start,
          endContainer: node,
          endOffset: end,
          collapsed: start === end,
        };
      },
    });
  };
  try {
    const view = createEditor(mounted.root, "hello", 0, rejecting);
    const node = mounted.findAll((item) => item.nodeType === 3 && item.textContent === "hello")[0];
    assert.ok(node);
    caret(node, 0, 0);
    press("deleteContentBackward");
    caret(node, node.length, node.length);
    press("deleteContentForward");
    assert.equal(rejecting.sent.some((message) => message.type === "edit"), false);
    assert.equal(view.getState().doc, "hello");
    caret(node, 0, 4);
    press("deleteContentForward");
    const edit = rejecting.sent.find((message) => message.type === "edit");
    assert.equal(edit.op, "delete");
    assert.notEqual(edit.anchor, edit.cursor);
    assert.equal(view.getState().doc, "hello");
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("a noop sends the queued insert at the same rev", () => {
  const mounted = mountEditor();
  const transport = holdingTransport();
  try {
    const view = createEditor(mounted.root, "ab", 1, transport);
    insertText(mounted, "X");
    insertText(mounted, "Y");
    assert.equal(transport.sent.filter((message) => message.type === "edit").length, 1);
    transport.deliver({ type: "noop", path: "other.md", rev: 0 });
    transport.deliver({ type: "noop", path: "", rev: 1 });
    assert.equal(transport.sent.filter((message) => message.type === "edit").length, 1);
    assert.equal(view.getState().doc, "ab");
    assert.equal(view.getState().cursor, 1);
    transport.deliver({ type: "noop", path: "", rev: 0 });
    const edits = transport.sent.filter((message) => message.type === "edit");
    assert.equal(edits.length, 2);
    assert.equal(edits[1].op, "insert");
    assert.equal(edits[1].text, "Y");
    assert.equal(edits[1].rev, 0);
    assert.equal(edits[1].cursor, 1);
    assert.equal(edits[1].anchor, 1);
    assert.equal(view.getState().doc, "ab");
    assert.equal(view.getState().cursor, 1);
    assert.equal(view.getState().anchor, 1);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("silence reopens and the file sends the queued insert at its caret", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const mounted = mountEditor();
  const transport = holdingTransport();
  try {
    const view = createEditor(mounted.root, "ab", 1, transport);
    insertText(mounted, "X");
    insertText(mounted, "Y");
    insertText(mounted, "Z");
    assert.equal(transport.sent.filter((message) => message.type === "edit").length, 1);
    t.mock.timers.tick(1999);
    assert.equal(transport.sent.some((message) => message.type === "open"), false);
    t.mock.timers.tick(1);
    assert.equal(transport.sent.some((message) => message.type === "open" && message.path === "" && message.rev === 0), true);
    assert.equal(transport.sent.filter((message) => message.type === "edit").length, 1);
    transport.deliver({ type: "noop", path: "", rev: 0 });
    transport.deliver({
      type: "doc",
      rev: 1,
      text: "ZZ",
      from: 0,
      to: 0,
      inserted: "ZZ",
      actor: "",
      cursor: 2,
      anchor: 2,
    });
    assert.equal(view.getState().doc, "ab");
    assert.equal(view.getState().cursor, 1);
    assert.equal(transport.sent.filter((message) => message.type === "edit").length, 1);
    transport.deliver({ type: "file", path: "", rev: 4, text: "ab", cursor: 0, anchor: 0 });
    assert.equal(view.getState().doc, "ab");
    assert.equal(view.getState().cursor, 0);
    assert.equal(view.getState().anchor, 0);
    let edits = transport.sent.filter((message) => message.type === "edit");
    assert.equal(edits.length, 2);
    assert.equal(edits[1].op, "insert");
    assert.equal(edits[1].text, "Y");
    assert.equal(edits[1].rev, 4);
    assert.equal(edits[1].cursor, 0);
    assert.equal(edits[1].anchor, 0);
    assert.equal(edits.some((message) => message.text === "Z"), false);
    transport.deliver({ type: "error", status: 409 });
    assert.equal(transport.sent.filter((message) => message.type === "edit").some((message) => message.text === "Z"), false);
    assert.equal(view.getState().doc, "ab");
    assert.equal(view.getState().cursor, 0);
    assert.equal(view.getState().anchor, 0);
    insertText(mounted, "W");
    edits = transport.sent.filter((message) => message.type === "edit");
    assert.equal(edits.at(-1).text, "W");
    assert.equal(edits.at(-1).rev, 4);
    assert.equal(edits.at(-1).cursor, 0);
    assert.equal(edits.some((message) => message.text === "Z"), false);
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

    const doc = "hello fox\n\nalpha\n";
    const added = addComment(doc, 6, 9);
    const caret = doc.indexOf("alpha") + 2;
    const page = holdingTransport();
    page.username = "me";
    const shifted = createEditor(mounted.root, doc, caret, page);
    page.deliver({
      type: "doc",
      rev: 1,
      text: added.doc,
      changes: added.changes.map(({ from, to, inserted }) => ({ from, to, inserted })),
      actor: "other",
      cursor: added.cursor,
      anchor: added.cursor,
    });
    const markDelta = added.changes[0].inserted.length - (added.changes[0].to - added.changes[0].from);
    assert.equal(shifted.getState().cursor, caret + markDelta);
    assert.equal(shifted.getState().anchor, caret + markDelta);
    assert.equal(shifted.getState().doc[shifted.getState().cursor], "p");
    assert.ok(shifted.getState().cursor < added.doc.indexOf("```"));
    shifted.destroy();

    const endTransport = holdingTransport();
    endTransport.username = "me";
    const atEnd = createEditor(mounted.root, "one\n", 4, endTransport);
    endTransport.deliver({
      type: "doc",
      rev: 1,
      text: "one\n\n\nlast\n",
      from: 4,
      to: 4,
      inserted: "\n\nlast\n",
      actor: "other",
      cursor: 11,
      anchor: 11,
    });
    assert.equal(atEnd.getState().doc, "one\n\n\nlast\n");
    assert.equal(atEnd.getState().cursor, 4);
    assert.equal(atEnd.getState().anchor, 4);
    atEnd.destroy();
  } finally {
    mounted.restore();
  }
});

test("local undo snapshots omit change lists", () => {
  const mounted = mountEditor();
  try {
    const view = createEditor(mounted.root, "ab", 1);
    mounted.listeners.beforeinput({ inputType: "insertText", data: "X", preventDefault() {} });
    const state = view.getState();
    assert.equal(state.doc, "aXb");
    assert.equal(Object.hasOwn(state, "changes"), false);
    assert.equal(state.undo.length, 1);
    assert.deepEqual(state.undo[0], { doc: "ab", cursor: 1, anchor: 1 });
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("moving inside a paragraph keeps one held span", () => {
  const mounted = mountEditor();
  const transport = holdingTransport();
  try {
    const doc = "Alpha\nBeta\n";
    assert.equal(doc.length, 11);
    assert.equal(lockIndexAt(doc, 0), 0);
    assert.equal(lockIndexAt(doc, 10), 0);
    const clickAt = (needle, offset) => {
      const node = walkNodes(mounted.root, (item) => item.nodeType === 3 && item.textContent === needle)[0];
      assert.ok(node, needle);
      globalThis.document.caretPositionFromPoint = () => ({ offsetNode: node, offset });
      mounted.listeners.click({ clientX: 4, clientY: 4, detail: 1, target: node });
    };
    const view = createEditor(mounted.root, doc, 0, transport);
    transport.sent.length = 0;
    clickAt("Beta", 1);
    assert.equal(view.getState().cursor, doc.indexOf("Beta") + 1);
    assert.equal(view.getState().anchor, view.getState().cursor);
    assert.equal(lockIndexAt(doc, view.getState().cursor), 0);
    assert.equal(transport.sent.some((message) => message.type === "lock"), false);
    view.destroy();

    const next = "Alpha\nBeta\n\nGamma\n";
    const moved = createEditor(mounted.root, next, 0, transport);
    transport.sent.length = 0;
    clickAt("Gamma", 0);
    assert.notEqual(lockIndexAt(next, 0), lockIndexAt(next, moved.getState().cursor));
    assert.equal(lockIndexAt(next, moved.getState().cursor), lockIndexAt(next, next.indexOf("Gamma")));
    const locks = transport.sent.filter((message) => message.type === "lock");
    assert.equal(locks.length, 1);
    assert.equal(locks[0].anchor, moved.getState().anchor);
    assert.equal(locks[0].cursor, moved.getState().cursor);
    transport.sent.length = 0;
    clickAt("Gamma", 2);
    assert.equal(transport.sent.some((message) => message.type === "lock"), false);
    assert.equal(lockIndexAt(next, moved.getState().cursor), lockIndexAt(next, next.indexOf("Gamma")));
    moved.destroy();
  } finally {
    delete globalThis.document.caretPositionFromPoint;
    mounted.restore();
  }
});

test("a closed table names every overlapping row span", () => {
  const mounted = mountEditor();
  const transport = holdingTransport();
  transport.username = "me";
  const doc = "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n";
  try {
    const view = createEditor(mounted.root, doc, doc.length, transport);
    transport.deliver({
      type: "locks",
      lines: [
        { index: 0, username: "me" },
        { index: 1, username: "ada" },
        { index: 2, username: "bea" },
      ],
    });
    const table = walkNodes(mounted.root, (node) => node.classList && node.classList.contains("md-table"))[0];
    assert.ok(table);
    const marks = walkNodes(table, (node) => node.classList && node.classList.contains("md-lock"));
    assert.deepEqual(marks.map((mark) => mark.textContent), ["ada", "bea"]);
    view.destroy();
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
        { index: 0, username: "ada" },
      ],
    });
    const marks = walkNodes(mounted.root, (node) => node.classList && node.classList.contains("md-lock"));
    assert.deepEqual(marks.map((mark) => mark.textContent), ["ada"]);
    assert.equal(walkNodes(mounted.root.childNodes[0], (node) => node.classList && node.classList.contains("md-lock")).length, 1);
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

    const origin = walkNodes(mounted.root, (node) => node.nodeType === 3 && node.textContent === "one")[0];
    const next = walkNodes(mounted.root, (node) => node.nodeType === 3 && node.textContent === "two")[0];
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
    const blocked = createEditor(mounted.root, "a\n\nb\n", 0, rejecting);
    const text = ["a", "b"].map((value) => walkNodes(mounted.root, (node) => node.nodeType === 3 && node.textContent === value)[0]);
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
    assert.equal(rejecting.sent.some((message) => message.type === "lock" && message.anchor === 0 && message.cursor === 4 && message.path === "" && message.rev === 0 && message.lines === undefined), true);
    assert.equal(blocked.getState().cursor, 0);
    assert.equal(blocked.getState().anchor, 0);
    blocked.destroy();
  } finally {
    mounted.restore();
  }
});

test("another tab of this user is not this session", () => {
  const mounted = mountEditor();
  const transport = holdingTransport();
  transport.username = "qa-bot";
  transport.token = "tab-a";
  const doc = "alpha\n\nbeta\n";
  const beta = "alpha\n\nbe".length;
  try {
    const view = createEditor(mounted.root, doc, beta, transport);
    const alphaIndex = lockIndexAt(doc, 2);
    const betaIndex = lockIndexAt(doc, beta);
    assert.notEqual(alphaIndex, betaIndex);
    transport.deliver({
      type: "locks",
      lines: [
        { index: alphaIndex, username: "qa-bot", token: "tab-b" },
        { index: betaIndex, username: "qa-bot", token: "tab-a" },
      ],
    });
    const marked = (text) => {
      const block = [...mounted.root.childNodes].find((node) => node.textContent && node.textContent.includes(text));
      assert.ok(block, text);
      return walkNodes(block, (node) => node.classList && node.classList.contains("md-lock")).map((mark) => mark.textContent);
    };
    assert.deepEqual(marked("alpha"), ["qa-bot"]);
    assert.deepEqual(marked("beta"), []);

    transport.deliver({
      type: "doc",
      rev: 1,
      text: "alxpha\n\nbeta\n",
      from: 2,
      to: 2,
      inserted: "x",
      actor: "qa-bot",
      token: "tab-b",
      cursor: 3,
      anchor: 3,
    });
    assert.equal(view.getState().doc, "alxpha\n\nbeta\n");
    assert.equal(view.getState().cursor, beta + 1);
    assert.equal(view.getState().anchor, beta + 1);

    const at = view.getState().cursor;
    transport.deliver({
      type: "doc",
      rev: 2,
      text: "alxpha\n\nbeyta\n",
      from: at,
      to: at,
      inserted: "y",
      actor: "qa-bot",
      token: "tab-a",
      cursor: at + 1,
      anchor: at + 1,
    });
    assert.equal(view.getState().doc, "alxpha\n\nbeyta\n");
    assert.equal(view.getState().cursor, at + 1);
    assert.equal(view.getState().anchor, at + 1);

    const stayed = view.getState().cursor;
    const end = view.getState().doc.length;
    transport.deliver({
      type: "doc",
      rev: 3,
      text: `${view.getState().doc}Z`,
      from: end,
      to: end,
      inserted: "Z",
      actor: "qa-bot",
      cursor: end + 1,
      anchor: end + 1,
    });
    assert.equal(view.getState().cursor, stayed);
    assert.equal(view.getState().anchor, stayed);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("a same-username doc with another token does not release a queued edit", () => {
  const mounted = mountEditor();
  const transport = holdingTransport();
  transport.username = "qa-bot";
  transport.token = "tab-a";
  try {
    const view = createEditor(mounted.root, "ab", 1, transport);
    insertText(mounted, "X");
    insertText(mounted, "Y");
    assert.equal(transport.sent.filter((message) => message.type === "edit").length, 1);
    transport.deliver({
      type: "doc",
      rev: 1,
      text: "Zab",
      from: 0,
      to: 0,
      inserted: "Z",
      actor: "qa-bot",
      token: "tab-b",
      cursor: 1,
      anchor: 1,
    });
    assert.equal(transport.sent.filter((message) => message.type === "edit").length, 1);
    assert.equal(view.getState().doc, "Zab");
    assert.equal(view.getState().cursor, 2);
    assert.equal(view.getState().anchor, 2);
    transport.deliver({
      type: "doc",
      rev: 2,
      text: "ZaXb",
      from: 2,
      to: 2,
      inserted: "X",
      actor: "qa-bot",
      token: "tab-a",
      cursor: 3,
      anchor: 3,
    });
    const edits = transport.sent.filter((message) => message.type === "edit");
    assert.equal(edits.length, 2);
    assert.equal(edits[1].text, "Y");
    assert.equal(view.getState().cursor, 3);
    view.destroy();
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
  const filePaths = [
    "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z",
    "M14 2v4a2 2 0 0 0 2 2h4",
  ];
  const folderPath = [
    "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
  ];
  const treeButtons = css.match(/\.file-tree button\s*\{[^}]*\}/);
  assert.ok(treeButtons);
  assert.match(treeButtons[0], /display:\s*flex/);
  assert.match(treeButtons[0], /align-items:\s*center/);
  assert.match(treeButtons[0], /gap:\s*0\.4rem/);
  assert.match(treeButtons[0], /width:\s*100%/);
  assert.equal(/display:\s*block/.test(treeButtons[0]), false);
  assert.match(css, /\.file-tree button svg\s*\{[^}]*flex:\s*none/);
  assert.equal(/\.file-tree button\.md-file::before/.test(css), false);
  assert.equal(/\.file-tree button\.md-dir-toggle::before/.test(css), false);
  assert.equal(/polygon\(0 0, 68% 0, 100% 28%, 100% 100%, 0 100%\)/.test(css), false);
  assert.equal(/polygon\(0 22%, 8% 22%, 14% 0, 48% 0, 54% 22%, 100% 22%, 100% 100%, 0 100%\)/.test(css), false);
  const strokeIcon = (button) => {
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
  };
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
    const fileButton = labeled("b.md")[0];
    const dirButton = labeled("sub")[0];
    assert.equal(fileButton.classList.contains("icon-btn"), true);
    assert.equal(fileButton.classList.contains("md-file"), true);
    assert.equal(fileButton.getAttribute("aria-label"), null);
    assert.deepEqual(iconPaths(fileButton), filePaths);
    strokeIcon(fileButton);
    assert.equal(dirButton.classList.contains("icon-btn"), true);
    assert.equal(dirButton.classList.contains("md-dir-toggle"), true);
    assert.equal(dirButton.getAttribute("aria-label"), null);
    assert.deepEqual(iconPaths(dirButton), folderPath);
    strokeIcon(dirButton);
    assert.equal(nav.childNodes[0].classList.contains("md-repo-row"), true);
    assert.ok(nav.childNodes.indexOf(input) > 0);
    const before = transport.sent.length;
    labeled("sub")[0].listeners.click({ preventDefault() {} });
    assert.equal(transport.sent.length, before);
    assert.equal(labeled("a.md").length, 1);
    assert.equal(labeled("b.md").length, 1);
    assert.deepEqual(iconPaths(labeled("a.md")[0]), filePaths);
    assert.deepEqual(iconPaths(labeled("sub")[0]), folderPath);
    strokeIcon(labeled("a.md")[0]);
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
    add.listeners.mousedown({ button: 0, preventDefault() {} });
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
    assert.match(storage.data["viewmark.session"], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.deepEqual(JSON.parse(sockets[0].sent[0]), { type: "hello", username: "Ada", session: storage.data["viewmark.session"] });
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
    assert.deepEqual(JSON.parse(sockets[1].sent[0]), { type: "hello", username: "ada", session: storage.data["viewmark.session"] });
    assert.equal(JSON.parse(sockets[1].sent[0]).session, JSON.parse(sockets[0].sent[0]).session);
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
    assert.deepEqual(JSON.parse(sockets[0].sent[0]), { type: "hello", username: "Ada", session: storage.data["viewmark.session"] });
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
    const hello = JSON.parse(sockets[0].sent[0]);
    assert.match(hello.session, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.deepEqual(hello, { type: "hello", username: "Ada", session: hello.session });
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
  assert.match(css, /button\.md-ticket-pane-menu\s*\{[^}]*position:\s*absolute;/);
  assert.match(css, /button\.md-ticket-pane-menu\s*\{[^}]*top:\s*8px;/);
  assert.match(css, /button\.md-ticket-pane-menu\s*\{[^}]*right:\s*8px;/);
  assert.match(css, /\.ticket-tree button\.md-ticket-expand\s*\{[^}]*border:\s*1px solid #c4b8a4;/);
  assert.match(css, /\.ticket-tree button\.md-ticket\s*\{[^}]*border:\s*0;/);
  assert.match(css, /\.file-tree button\s*\{[^}]*border:\s*0;/);
  assert.match(css, /button\.md-ticket-pane-item,\s*button\.md-ticket-filter-all,\s*\.ticket-form button\.md-ticket-link,\s*\.ticket-form button\.md-ticket-option\s*\{[^}]*border:\s*0;/);
  assert.match(css, /button\.md-ticket-pane-item,\s*button\.md-ticket-filter-all,\s*\.ticket-form button\.md-ticket-link,\s*\.ticket-form button\.md-ticket-option\s*\{[^}]*background:\s*none;/);
  assert.match(css, /button\.md-ticket-pane-item,\s*button\.md-ticket-filter-all,\s*\.ticket-form button\.md-ticket-link,\s*\.ticket-form button\.md-ticket-option\s*\{[^}]*width:\s*100%;/);
  assert.match(css, /button\.md-ticket-pane-item,\s*button\.md-ticket-filter-all,\s*\.ticket-form button\.md-ticket-link,\s*\.ticket-form button\.md-ticket-option\s*\{[^}]*text-align:\s*left;/);
  assert.match(css, /button\.md-ticket-pane-item:hover,\s*button\.md-ticket-filter-all:hover,\s*\.ticket-form button\.md-ticket-link:hover,\s*\.ticket-form button\.md-ticket-option:hover\s*\{[^}]*background:\s*#2c3440;/);
  assert.match(css, /\.ticket-form button\.md-ticket-link,\s*\.ticket-form button\.md-ticket-option\s*\{[^}]*border-radius:\s*0\.35rem;/);
  assert.match(css, /:root\s*\{[^}]*--danger:\s*#ff7b72;/);
  assert.match(css, /\.icon-btn svg\s*\{[^}]*width:\s*1\.1em;/);
  assert.match(css, /\.icon-btn svg\s*\{[^}]*height:\s*1\.1em;/);
  assert.match(css, /\.icon-btn svg\s*\{[^}]*display:\s*block;/);
  assert.match(css, /button\.icon-btn:not\(\.md-file\):not\(\.md-dir-toggle\)\s*\{[^}]*width:\s*1\.75rem;/);
  assert.match(css, /button\.icon-btn:not\(\.md-file\):not\(\.md-dir-toggle\)\s*\{[^}]*height:\s*1\.75rem;/);
  assert.match(css, /button\.icon-btn:not\(\.md-file\):not\(\.md-dir-toggle\)\s*\{[^}]*display:\s*inline-flex;/);
  assert.match(css, /button\.icon-btn:not\(\.md-file\):not\(\.md-dir-toggle\)\s*\{[^}]*align-items:\s*center;/);
  assert.match(css, /button\.icon-btn:not\(\.md-file\):not\(\.md-dir-toggle\)\s*\{[^}]*justify-content:\s*center;/);
  assert.match(css, /button\.icon-btn:not\(\.md-file\):not\(\.md-dir-toggle\)\s*\{[^}]*padding:\s*0;/);
  assert.match(css, /button\.icon-btn:not\(\.md-file\):not\(\.md-dir-toggle\)\s*\{[^}]*box-sizing:\s*border-box;/);
  assert.match(css, /button\.icon-btn:not\(\.md-file\):not\(\.md-dir-toggle\)\s*\{[^}]*flex:\s*none;/);
  assert.match(css, /button\.icon-btn:not\(\.md-file\):not\(\.md-dir-toggle\)\s*\{[^}]*background:\s*none;/);
  assert.equal(/\.md-comment-card button\.icon-btn\s*\{[^}]*1\.25rem/.test(css), false);
  assert.equal(/\.md-comment-author-row > button\.md-comment-link\s*\{[^}]*1\.25rem/.test(css), false);
  assert.match(css, /\.icon-btn\.danger\s*\{[^}]*color:\s*var\(--danger\)/);
  assert.equal(/\.icon-btn\.danger\s*\{[^}]*background/.test(css), false);
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
    assert.equal(tree.parentElement.classList.contains("md-file-drawer"), true);
    assert.equal(tree.parentElement.parentElement, fileBlock());
    assert.ok(fileBlock().childNodes.indexOf(field) < fileBlock().childNodes.indexOf(tree.parentElement));
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

test("document menu offers Attach image and Delete file", () => {
  const mounted = mountEditor();
  const css = readFileSync(new URL("../editor.css", import.meta.url), "utf8");
  const rule = css.match(/button\.md-doc-menu\s*\{[^}]*\}/);
  assert.ok(rule);
  assert.match(rule[0], /position:\s*absolute/);
  assert.match(rule[0], /top:\s*0\.35rem/);
  assert.match(rule[0], /right:\s*calc\(0\.35rem \+ 1\.75rem \+ 4px\)/);
  assert.match(rule[0], /z-index:\s*2/);
  assert.match(rule[0], /background:\s*#1c1b19/);
  assert.match(css, /div\.md-doc-menu-panel\s*\{[^}]*position:\s*absolute/);
  assert.match(css, /div\.md-doc-menu-panel\[hidden\]\s*\{[^}]*display:\s*none/);
  assert.match(css, /button\.md-doc-menu-item\s*\{[^}]*text-align:\s*left/);
  assert.match(css, /button\.icon-btn\.md-view-toggle[^{]*\{[^}]*right:\s*0\.35rem/);
  assert.equal(/button\.md-doc-commit/.test(css), false);
  assert.equal(/button\.md-doc-link/.test(css), false);
  assert.equal(/button\.md-commit\s*\{/.test(css), false);
  const nav = document.createElement("nav");
  nav.className = "files";
  const aside = document.createElement("aside");
  aside.className = "comments";
  const sheet = document.createElement("div");
  sheet.append(nav, mounted.root, aside);
  const transport = holdingTransport();
  const click = (node) => node.listeners.click({ preventDefault() {}, stopPropagation() {} });
  const pointer = (target) => {
    for (const fn of mounted.documentListeners.get("pointerdown") || []) fn({ target });
  };
  const confirm = () => walkNodes(sheet, (node) => node.tagName === "DIALOG" && node.classList && node.classList.contains("md-confirm"))[0];
  try {
    const view = createEditor(mounted.root, "ab\n\ncd\n", 0, transport);
    assert.equal(sheet.textContent.includes("Commit repo"), false);
    assert.equal(walkNodes(sheet, (node) => node.classList && node.classList.contains("md-doc-commit")).length, 0);
    assert.equal(walkNodes(sheet, (node) => node.classList && node.classList.contains("md-attach")).length, 0);
    assert.equal(walkNodes(aside, (node) => node.tagName === "BUTTON" && node.textContent === "Attach image").length, 0);
    const input = walkNodes(aside, (node) => node.classList && node.classList.contains("md-attach-input"))[0];
    assert.equal(aside.childNodes[0], input);
    assert.equal(input.hidden, true);
    assert.equal(input.getAttribute("type"), "file");
    assert.equal(input.getAttribute("accept"), "image/png,image/jpeg,image/gif,image/webp");
    const button = walkNodes(mounted.root, (node) => node.classList && node.classList.contains("md-doc-menu"))[0];
    const panel = walkNodes(mounted.root, (node) => node.classList && node.classList.contains("md-doc-menu-panel"))[0];
    const toggle = viewToggleOf(mounted.root);
    assert.equal(button.tagName, "BUTTON");
    assert.equal(button.type, "button");
    assert.equal(button.classList.contains("icon-btn"), true);
    assert.equal(button.getAttribute("aria-label"), "Menu");
    assert.equal(button.getAttribute("aria-haspopup"), "menu");
    assert.equal(button.getAttribute("aria-expanded"), "false");
    assert.deepEqual(iconPaths(button), ["M4 6h16M4 12h16M4 18h16"]);
    assert.equal(panel.getAttribute("role"), "menu");
    assert.equal(panel.hidden, true);
    assert.deepEqual(panel.childNodes.map((node) => node.textContent), ["Attach image", "Delete file"]);
    assert.equal(mounted.root.childNodes.at(-1), toggle);
    assert.ok(mounted.root.childNodes.indexOf(button) < mounted.root.childNodes.indexOf(toggle));
    assert.equal(mounted.root.childNodes.indexOf(panel), mounted.root.childNodes.indexOf(button) + 1);
    assert.notEqual(mounted.root.childNodes[0], button);

    click(button);
    assert.equal(panel.hidden, false);
    assert.equal(button.getAttribute("aria-expanded"), "true");
    pointer(button);
    pointer(panel.childNodes[0]);
    assert.equal(panel.hidden, false);
    pointer(mounted.root.childNodes[0]);
    assert.equal(panel.hidden, true);
    assert.equal(button.getAttribute("aria-expanded"), "false");
    click(button);
    click(button);
    assert.equal(panel.hidden, true);

    let clicks = 0;
    input.click = () => {
      clicks += 1;
    };
    click(button);
    click(panel.childNodes[0]);
    assert.equal(clicks, 1);
    assert.equal(panel.hidden, true);
    click(button);
    click(panel.childNodes[1]);
    assert.equal(panel.hidden, true);
    assert.equal(confirm(), undefined);
    assert.equal(transport.sent.some((message) => message.type === "delete"), false);

    transport.deliver({ type: "file", rev: 1, text: "ab\n\ncd\n", path: "notes/a.md", cursor: 0, anchor: 0, locks: [] });
    click(button);
    click(panel.childNodes[1]);
    const dialog = confirm();
    assert.equal(panel.hidden, true);
    assert.equal(dialog.open, true);
    assert.equal(walkNodes(dialog, (node) => node.classList && node.classList.contains("md-confirm-text"))[0].textContent, "Delete a.md?");
    const before = transport.sent.length;
    walkNodes(dialog, (node) => node.tagName === "BUTTON" && node.textContent === "Delete")[0].listeners.click({ preventDefault() {} });
    assert.deepEqual(transport.sent[before], { type: "delete", path: "notes/a.md", username: "" });
    assert.equal(dialog.open, false);

    transport.deliver({ type: "file", rev: 1, text: "ticket\n", path: "tickets/aaaaaaaa.md", cursor: 0, anchor: 0, locks: [] });
    const quiet = transport.sent.length;
    click(button);
    click(panel.childNodes[1]);
    assert.equal(panel.hidden, true);
    assert.equal(confirm().open, false);
    assert.equal(transport.sent.length, quiet);
    assert.equal(transport.sent.some((message) => message.type === "commit"), false);
    assert.equal(sheet.textContent.includes("Commit repo"), false);
    view.destroy();
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
    const view = createEditor(mounted.root, "ab\n\ncd\n", 0, transport);
    const button = walkNodes(nav, (node) => node.classList && node.classList.contains("md-new-file"))[0];
    const field = walkNodes(nav, (node) => node.classList && node.classList.contains("md-new-name"))[0];
    button.listeners.click({ preventDefault() {} });
    field.value = "notes/idea";
    field.listeners.keydown({ key: "Enter", preventDefault() {} });
    assert.deepEqual(transport.sent.at(-1), { type: "create", path: "notes/idea.md", username: "" });
    const text = mounted.findAll((node) => node.nodeType === 3 && node.textContent === "cd")[0];
    assert.equal(text.textContent, "cd");
    document.caretPositionFromPoint = () => ({ offsetNode: text, offset: 0 });
    mounted.listeners.click({ target: text, clientX: 1, clientY: 1, preventDefault() {} });
    assert.equal(view.getState().cursor, 4);
    assert.equal(view.getState().anchor, 4);
    transport.deliver({ type: "error", status: 409 });
    assert.equal(view.getState().cursor, 4);
    assert.equal(view.getState().anchor, 4);
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
  return byClass(tree, "md-ticket-node").map((node) => node.dataset.id);
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
  assert.match(css, /\.file-tree\s*\{[^}]*overflow:\s*auto/);
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
  assert.match(wideRule, /width:\s*80vw/);
  assert.match(wideRule, /z-index:\s*4/);
  assert.match(wideRule, /transition:\s*width 0\.5s,\s*left 0\.5s/);
  assert.equal(/top:\s*0/.test(wideRule), false);
  assert.equal(/bottom:\s*0/.test(wideRule), false);
  assert.match(css, /\.ticket-tree \.md-ticket-row:hover\s*\{[^}]*background:\s*#2c3440/);
  assert.match(css, /\.md-ticket-drawer:not\(\.md-ticket-wide\)[^{]*\.ticket-tree \.md-ticket-row[^{]*\{[^}]*grid-template-columns:\s*1\.1em minmax\(0,\s*1fr\);/);
  assert.match(css, /\.md-ticket-drawer:not\(\.md-ticket-wide\)[^{]*button\.md-ticket[^{]*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/);
  assert.match(css, /\.md-ticket-drawer:not\(\.md-ticket-wide\)[^{]*\.md-ticket-id[^{]*\{[^}]*display:\s*none/);
  assert.match(css, /\.md-ticket-drawer:not\(\.md-ticket-wide\)[^{]*\.md-ticket-priority[^{]*\{[^}]*display:\s*none/);
  assert.match(css, /\.md-ticket-drawer:not\(\.md-ticket-wide\)[^{]*\.md-ticket-state[^{]*\{[^}]*display:\s*none/);
  assert.match(css, /\.md-ticket-drawer:not\(\.md-ticket-wide\)[^{]*\.md-ticket-type[^{]*\{[^}]*display:\s*none/);
  const sortButtonRule = css.match(/\.ticket-tree \.md-ticket-columns button\s*\{[^}]*\}/);
  assert.ok(sortButtonRule);
  assert.match(sortButtonRule[0], /font-weight:\s*bold/);
  assert.equal(/border:\s*0/.test(sortButtonRule[0]), true);
  assert.match(css, /\.ticket-tree\s*\{[^}]*height:\s*100%/);
  assert.match(css, /\.ticket-tree\s*\{[^}]*overflow:\s*auto/);
  assert.match(css, /\.ticket-tree\s*\{[^}]*scrollbar-gutter:\s*stable/);
  assert.match(css, /\.ticket-tree\s*\{[^}]*background:\s*#1c1b19/);
  assert.match(css, /\.ticket-tree \.md-ticket-columns\s*\{[^}]*background:\s*#1c1b19/);
  const treeRule = css.match(/\.ticket-tree\s*\{[^}]*\}/)[0];
  assert.equal(/border:\s*1px solid #4a463f/.test(treeRule), false);
  assert.match(css, /\.md-ticket-drawer:not\(\.md-ticket-wide\)\s+\.ticket-tree\s*\{[^}]*border:\s*0/);
  assert.match(css, /\.md-ticket-wide\s+\.ticket-tree\s*\{[^}]*border:\s*1px solid #4a463f/);
  assert.match(css, /\.md-ticket-drawer:not\(\.md-ticket-wide\)\s+\.md-ticket-columns\s*\{[^}]*display:\s*none/);
  const gutterTracks = /grid-template-columns:\s*1\.1em 8rem minmax\(0,\s*1fr\) 5\.5rem 7rem 7\.5rem 8\.5rem/;
  const fieldTracks = /grid-template-columns:\s*8rem minmax\(0,\s*1fr\) 5\.5rem 7rem 7\.5rem 8\.5rem/;
  assert.match(css.match(/\.ticket-tree \.md-ticket-row\s*\{[^}]*\}/)[0], gutterTracks);
  assert.match(css.match(/\.ticket-tree \.md-ticket-row\s*\{[^}]*\}/)[0], /column-gap:\s*0\.75rem/);
  assert.match(css.match(/\.ticket-tree \.md-ticket-columns\s*\{[^}]*\}/)[0], gutterTracks);
  assert.match(css.match(/\.ticket-tree \.md-ticket-columns\s*\{[^}]*\}/)[0], /column-gap:\s*0\.75rem/);
  assert.match(css.match(/\.ticket-tree button\.md-ticket\s*\{[^}]*\}/)[0], fieldTracks);
  assert.match(css.match(/\.ticket-tree button\.md-ticket\s*\{[^}]*\}/)[0], /column-gap:\s*0\.75rem/);
  const idRule = css.match(/\.ticket-tree \.md-ticket-id,[\s\S]*?\{[^}]*\}/);
  assert.ok(idRule);
  assert.match(idRule[0], /\.md-ticket-priority/);
  assert.match(idRule[0], /\.md-ticket-assignee/);
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
  assert.match(css, /\.ticket-form:not\(\[hidden\]\)\s*\+\s*#editor\s*\{[^}]*grid-row:\s*2[^}]*border:\s*1px solid #4a463f/);
  const ticketBody = css.match(/\.ticket-form:not\(\[hidden\]\)\s*\+\s*#editor\s*\{[^}]*\}/)[0];
  assert.match(ticketBody, /align-self:\s*stretch/);
  assert.match(ticketBody, /min-height:\s*0/);
  assert.match(ticketBody, /overflow:\s*auto/);
  const sheetHas = css.match(/\.sheet:has\(\.ticket-form:not\(\[hidden\]\)\)\s*\{[^}]*\}/)[0];
  assert.match(sheetHas, /height:\s*calc\(100vh - 2rem\)/);
  assert.match(sheetHas, /grid-template-rows:\s*auto minmax\(0,\s*1fr\)/);
  assert.match(css, /@media \(max-width:\s*800px\)\s*\{[^]*\.sheet:has\(\.ticket-form:not\(\[hidden\]\)\)\s*\{[^}]*height:\s*auto/);
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
    assert.equal(heading.parentElement, head);
    assert.equal(drawer.hidden, false);
    assert.equal(drawer.hasAttribute("hidden"), false);
    assert.equal(drawer.classList.contains("md-ticket-wide"), false);
    assert.equal(tickets.parentElement, drawer);
    assert.equal(drawer.parentElement, block);
    assert.equal(block.childNodes.at(-1), drawer);
    assert.equal(tree.parentElement.classList.contains("md-file-drawer"), true);
    assert.equal(tree.parentElement.parentElement, fileBlock);
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
        ["BUTTON", "Assignee"],
        ["BUTTON", "State"],
        ["BUTTON", "Type"],
      ],
    );
    for (const label of ["ID", "Title", "Priority", "Assignee", "State", "Type"]) {
      const button = columns.childNodes.find((node) => node.tagName === "BUTTON" && node.textContent === label);
      assert.equal(button.getAttribute("aria-label"), `Sort by ${label}`);
      assert.equal(button.type, "button");
      assert.equal(button.childNodes.some((node) => String(node.tagName || "").toLowerCase() === "svg"), false);
    }
    block.listeners.pointerenter();
    assert.equal(drawer.hidden, false);
    assert.equal(drawer.hasAttribute("hidden"), false);
    assert.equal(drawer.classList.contains("md-ticket-wide"), true);
    assert.equal(drawer.styleProps.top, "0px");
    assert.equal(drawer.styleProps.height, "10px");
    assert.equal(drawer.styleProps.width, "80vw");
    assert.equal(drawer.styleProps.transition, "");
    drawer.styleProps.width = "12px";
    block.listeners.pointerenter();
    assert.equal(drawer.styleProps.width, "12px");
    assert.equal(drawer.styleProps.transition, "");
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
    assert.deepEqual(rootTicketIds(mounted.nav), ["aaaaaaaa", "dddddddd", "bbbbbbbb", "cccccccc", "eeeeeeee"]);
    for (const ticket of list) {
      const row = rowOf(mounted.nav, ticket.id);
      const spans = ticketSpans(mounted.nav, ticket.id);
      assert.deepEqual(spans.map((span) => span.className), [
        "md-ticket-id",
        "md-ticket-title",
        "md-ticket-priority",
        "md-ticket-assignee",
        "md-ticket-state",
        "md-ticket-type",
      ]);
      assert.deepEqual(spans.map((span) => span.textContent), [
        ticket.id,
        ticket.title,
        ticket.priority,
        ticket.assignee || "",
        ticket.state,
        ticket.type,
      ]);
      assert.equal(row.textContent.includes(ticket.title), true);
      assert.equal(row.textContent.includes(ticket.state), true);
      assert.equal(ticketNode(mounted.nav, ticket.id).parentElement.classList.contains("ticket-tree"), true);
      assert.equal(byClass(ticketNode(mounted.nav, ticket.id), "md-ticket-expand").length, 0);
      assert.equal(byClass(ticketNode(mounted.nav, ticket.id), "md-ticket-children").length, 0);
    }
    assert.deepEqual(ticketSpans(mounted.nav, "aaaaaaaa").map((span) => span.textContent), [
      "aaaaaaaa",
      "Alpha",
      "medium",
      "",
      "new",
      "enhancement",
    ]);
    assert.equal(ticketSpans(mounted.nav, "cccccccc").find((span) => span.classList.contains("md-ticket-type")).textContent, "bug");
    assert.deepEqual(ticketSpans(mounted.nav, "bbbbbbbb").map((span) => span.textContent), [
      "bbbbbbbb",
      "Bravo",
      "medium",
      "",
      "new",
      "task",
    ]);
    const open = byClass(ticketNode(mounted.nav, "bbbbbbbb"), "md-ticket").find((node) => node.tagName === "BUTTON");
    open.listeners.click({ preventDefault() {} });
    assert.deepEqual(transport.sent.at(-1), { type: "open", path: "tickets/bbbbbbbb.md", rev: 0, username: "" });
    assert.equal(drawer.hidden, false);
    assert.equal(drawer.classList.contains("md-ticket-wide"), true);
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
      block.listeners.pointerleave();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].ms, 200);
      const hide = pending.pop();
      drawer.styleProps.transition = "none";
      hide.fn();
      assert.equal(drawer.classList.contains("md-ticket-wide"), false);
      assert.equal(drawer.styleProps.top, "");
      assert.equal(drawer.styleProps.height, "");
      assert.equal(drawer.styleProps.width, "");
      assert.equal(drawer.styleProps.transition, "");
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
    view.destroy();
    assert.equal(plus.listeners.click, undefined);
  } finally {
    mounted.restore();
  }
});

test("T-file-drawer", () => {
  const mounted = mountTicketPage();
  const css = readFileSync(new URL("../editor.css", import.meta.url), "utf8");
  const buttonRule = css.match(/\.file-tree button\s*\{[^}]*\}/)[0];
  assert.match(buttonRule, /white-space:\s*nowrap/);
  assert.match(buttonRule, /overflow:\s*hidden/);
  assert.match(buttonRule, /text-overflow:\s*ellipsis/);
  const treeRule = css.match(/\.file-tree\s*\{[^}]*\}/)[0];
  assert.match(treeRule, /overflow:\s*auto/);
  assert.match(treeRule, /min-height:\s*0/);
  const blockRule = css.match(/\.file-block\s*\{[^}]*\}/)[0];
  assert.match(blockRule, /display:\s*flex/);
  assert.match(blockRule, /flex-direction:\s*column/);
  assert.match(blockRule, /flex:\s*1 1 0/);
  assert.match(blockRule, /min-height:\s*0/);
  assert.match(blockRule, /min-width:\s*0/);
  assert.equal(/overflow:\s*auto/.test(blockRule), false);
  const drawerRule = css.match(/\.md-file-drawer\s*\{[^}]*\}/)[0];
  assert.match(drawerRule, /position:\s*relative/);
  assert.match(drawerRule, /flex:\s*1 1 0/);
  assert.match(drawerRule, /min-width:\s*0/);
  assert.match(drawerRule, /min-height:\s*0/);
  assert.match(drawerRule, /width:\s*100%/);
  assert.match(drawerRule, /transition:\s*width 0\.5s,\s*left 0\.5s/);
  const wideRule = css.match(/\.md-file-wide\s*\{[^}]*\}/)[0];
  assert.match(wideRule, /position:\s*relative/);
  assert.equal(/position:\s*fixed/.test(wideRule), false);
  assert.equal(/left:\s*0/.test(wideRule), false);
  assert.match(wideRule, /z-index:\s*4/);
  assert.match(wideRule, /background:\s*#1c1b19/);
  assert.match(wideRule, /box-sizing:\s*border-box/);
  assert.equal(/width:\s*80vw/.test(wideRule), false);
  assert.match(css, /@media \(max-width:\s*800px\)\s*\{[^]*\.md-file-wide\s*\{[^}]*position:\s*static/);
  assert.match(css, /@media \(max-width:\s*800px\)\s*\{[^]*\.md-file-wide\s*\{[^}]*width:\s*auto/);
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
    transport.deliver({ type: "docs", files: ["alpha.md", "bravo.md"] });
    const fileBlock = byClass(mounted.nav, "file-block")[0];
    const panel = byClass(fileBlock, "md-file-drawer")[0];
    const tree = byClass(panel, "file-tree")[0];
    const head = byClass(fileBlock, "md-pane-head")[0];
    const columnStays = () => {
      assert.equal(fileBlock.classList.contains("md-file-wide"), false);
      assert.equal(fileBlock.styleProps.width, undefined);
      assert.equal(fileBlock.styleProps.top, undefined);
      assert.equal(fileBlock.styleProps.height, undefined);
      assert.equal(fileBlock.styleProps.left, undefined);
      assert.equal(head.parentElement, fileBlock);
      assert.equal(panel.parentElement, fileBlock);
    };
    assert.equal(head.parentElement, fileBlock);
    assert.equal(panel.parentElement, fileBlock);
    assert.equal(tree.parentElement, panel);
    assert.equal(byClass(panel, "md-pane-head").length, 0);
    assert.ok(fileBlock.childNodes.indexOf(head) < fileBlock.childNodes.indexOf(panel));
    const buttons = byClass(tree, "md-file");
    assert.equal(buttons.length, 2);
    const buttonNodes = buttons.slice();
    buttons[0].scrollWidth = 100;
    buttons[1].scrollWidth = 300;
    const plus = byClass(head, "md-new-file")[0];
    plus.scrollWidth = 5000;
    panel.getBoundingClientRect = () => ({ top: 18, left: 8, right: 168, bottom: 218, width: 160, height: 200 });
    globalThis.window.getComputedStyle = (el) => (
      el === panel
        ? { paddingLeft: "20px", paddingRight: "20px" }
        : { paddingLeft: "0px", paddingRight: "0px" }
    );
    globalThis.window.innerWidth = 400;
    fileBlock.listeners.pointerenter();
    assert.equal(panel.classList.contains("md-file-wide"), true);
    assert.equal(panel.classList.contains("md-ticket-wide"), false);
    assert.equal(fileBlock.parentElement, mounted.nav);
    assert.equal(byClass(fileBlock, "md-pane-head")[0], head);
    const wideButtons = byClass(tree, "md-file");
    assert.equal(wideButtons.length, buttonNodes.length);
    for (let i = 0; i < buttonNodes.length; i += 1) assert.equal(wideButtons[i], buttonNodes[i]);
    assert.equal(byClass(fileBlock, "ticket-tree").length, 0);
    assert.equal(byClass(fileBlock, "md-ticket").length, 0);
    assert.equal(panel.styleProps.top, undefined);
    assert.equal(panel.styleProps.height, undefined);
    assert.equal(panel.styleProps.left, undefined);
    assert.equal(panel.styleProps.width, "320px");
    assert.equal(panel.styleProps.transition, "");
    columnStays();
    fileBlock.listeners.pointerleave();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].ms, 200);
    assert.equal(panel.classList.contains("md-file-wide"), true);
    assert.equal(panel.styleProps.width, "320px");
    fileBlock.listeners.pointerenter();
    assert.equal(pending.length, 0);
    assert.equal(panel.classList.contains("md-file-wide"), true);
    assert.equal(panel.styleProps.top, undefined);
    assert.equal(panel.styleProps.height, undefined);
    assert.equal(panel.styleProps.left, undefined);
    assert.equal(panel.styleProps.width, "320px");
    fileBlock.listeners.pointerleave();
    assert.equal(pending.length, 1);
    pending.pop().fn();
    assert.equal(panel.classList.contains("md-file-wide"), true);
    assert.equal(panel.styleProps.width, "160px");
    assert.equal(pending[0].ms, 500);
    fileBlock.listeners.pointerenter();
    assert.equal(pending.length, 0);
    assert.equal(panel.classList.contains("md-file-wide"), true);
    assert.equal(panel.styleProps.width, "320px");
    fileBlock.listeners.pointerleave();
    pending.pop().fn();
    pending.pop().fn();
    assert.equal(panel.classList.contains("md-file-wide"), false);
    assert.equal(panel.styleProps.top, undefined);
    assert.equal(panel.styleProps.height, undefined);
    assert.equal(panel.styleProps.left, undefined);
    assert.equal(panel.styleProps.width, "");
    assert.equal(panel.styleProps.transition, "");
    columnStays();
    buttons[0].scrollWidth = 0;
    delete buttons[1].scrollWidth;
    globalThis.window.innerWidth = 100;
    fileBlock.listeners.pointerenter();
    assert.equal(panel.styleProps.width, "160px");
    assert.equal(panel.styleProps.top, undefined);
    assert.equal(panel.styleProps.height, undefined);
    assert.equal(panel.styleProps.left, undefined);
    fileBlock.listeners.pointerleave();
    pending.pop().fn();
    pending.pop().fn();
    buttons[1].scrollWidth = 300;
    globalThis.window.innerWidth = 0;
    fileBlock.listeners.pointerenter();
    assert.equal(panel.styleProps.width, "340px");
    fileBlock.listeners.pointerleave();
    pending.pop().fn();
    pending.pop().fn();
    globalThis.window.getComputedStyle = (el) => (
      el === panel
        ? { paddingLeft: "20px", paddingRight: "20px", borderLeft: "1px", borderRight: "1px" }
        : { paddingLeft: "0px", paddingRight: "0px" }
    );
    fileBlock.listeners.pointerenter();
    assert.equal(panel.styleProps.width, "342px");
    fileBlock.listeners.pointerleave();
    pending.pop().fn();
    pending.pop().fn();
    globalThis.window.getComputedStyle = (el) => (
      el === panel
        ? { paddingLeft: "20px", paddingRight: "20px" }
        : { paddingLeft: "0px", paddingRight: "0px" }
    );
    delete globalThis.window.innerWidth;
    fileBlock.listeners.pointerenter();
    assert.equal(panel.styleProps.width, "340px");
    globalThis.window.innerWidth = 1000;
    fileBlock.listeners.pointerleave();
    pending.pop().fn();
    pending.pop().fn();
    buttons[1].scrollWidth = 100;
    fileBlock.listeners.pointerenter();
    assert.equal(panel.styleProps.width, "160px");
    const enter = fileBlock.listeners.pointerenter;
    let intrinsic = 220;
    const origCreate = document.createElement;
    document.createElement = (tag) => {
      const el = origCreate(tag);
      if (String(tag).toUpperCase() !== "BUTTON") return el;
      Object.defineProperty(el, "scrollWidth", {
        configurable: true,
        get() {
          const props = el.styleProps || {};
          if (props.width === "max-content" && props.flex === "0 0 auto") return intrinsic;
          return 900;
        },
      });
      return el;
    };
    try {
      transport.deliver({ type: "docs", files: ["alpha.md", "bravo.md"] });
      assert.equal(fileBlock.listeners.pointerenter, enter);
      assert.equal(panel.classList.contains("md-file-wide"), true);
      assert.equal(panel.styleProps.width, "260px");
      const sample = byClass(panel, "md-file")[0];
      assert.equal(sample.styleProps.width, undefined);
      assert.equal(sample.styleProps.flex, undefined);
      assert.equal(sample.styleProps["min-width"], undefined);
      columnStays();
      intrinsic = 30;
      transport.deliver({ type: "docs", files: ["a.md"] });
      assert.equal(fileBlock.listeners.pointerenter, enter);
      assert.equal(panel.classList.contains("md-file-wide"), true);
      assert.equal(panel.styleProps.width, "160px");
      columnStays();
    } finally {
      document.createElement = origCreate;
    }
    fileBlock.listeners.pointerleave();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].ms, 200);
    view.destroy();
    assert.equal(pending.length, 0);
    assert.equal(fileBlock.listeners.pointerenter, undefined);
    assert.equal(fileBlock.listeners.pointerleave, undefined);
    assert.equal(panel.classList.contains("md-file-wide"), true);
    assert.equal(fileBlock.classList.contains("md-file-wide"), false);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
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
    const alpha = { ...ticketFixture("aaaaaaaa", "Alpha", "new", T1, "", [], "Ada", "task", "low"), assignee: "bea" };
    const bravo = { ...ticketFixture("bbbbbbbb", "Bravo", "new", T0, "", [], "Ada", "task", "high"), assignee: "ada" };
    const zed = ticketFixture("dddddddd", "Zed", "new", T0, "bbbbbbbb");
    const ann = { ...ticketFixture("eeeeeeee", "Ann", "new", T2, "bbbbbbbb"), assignee: "cara" };
    transport.deliver({ type: "tickets", tickets: [alpha, bravo, zed, ann] });
    const block = byClass(mounted.nav, "ticket-block")[0];
    const drawer = byClass(block, "md-ticket-drawer")[0];
    const css = readFileSync(new URL("../editor.css", import.meta.url), "utf8");
    assert.equal(drawer.hidden, false);
    assert.equal(drawer.hasAttribute("hidden"), false);
    assert.equal(drawer.classList.contains("md-ticket-wide"), false);
    assert.match(css, /\.md-ticket-drawer:not\(\.md-ticket-wide\)[^{]*\.md-ticket-priority[^{]*\{[^}]*display:\s*none/);
    assert.deepEqual(rootTicketIds(mounted.nav), ["bbbbbbbb", "dddddddd", "aaaaaaaa", "eeeeeeee"]);
    block.listeners.pointerenter();
    assert.equal(drawer.hidden, false);
    assert.equal(drawer.classList.contains("md-ticket-wide"), true);
    assert.equal(drawer.styleProps.width, "80vw");
    const columns = byClass(mounted.nav, "md-ticket-columns")[0];
    const heading = (label) => columns.childNodes.find((node) => node.tagName === "BUTTON" && node.textContent === label);
    const svgOf = (button) => button && button.childNodes.find((node) => String(node.tagName || "").toLowerCase() === "svg");
    const pathOf = (button) => {
      const svg = svgOf(button);
      return svg && svg.childNodes.find((node) => String(node.tagName || "").toLowerCase() === "path");
    };
    const title = heading("Title");
    const idHead = heading("ID");
    assert.deepEqual(
      columns.childNodes.filter((node) => node.tagName === "BUTTON").map((node) => node.textContent),
      ["ID", "Title", "Priority", "Assignee", "State", "Type"],
    );
    for (const label of ["ID", "Title", "Priority", "Assignee", "State", "Type"]) {
      assert.equal(heading(label).getAttribute("aria-label"), `Sort by ${label}`);
    }
    title.listeners.click({ preventDefault() {} });
    assert.deepEqual(rootTicketIds(mounted.nav), ["aaaaaaaa", "eeeeeeee", "bbbbbbbb", "dddddddd"]);
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
    assert.deepEqual(rootTicketIds(mounted.nav), ["dddddddd", "bbbbbbbb", "eeeeeeee", "aaaaaaaa"]);
    assert.equal(pathOf(title).getAttribute("d"), "M12 5v14M19 12l-7 7-7-7");
    title.listeners.click({ preventDefault() {} });
    assert.deepEqual(rootTicketIds(mounted.nav), ["bbbbbbbb", "dddddddd", "aaaaaaaa", "eeeeeeee"]);
    assert.equal(svgOf(title), undefined);
    idHead.listeners.click({ preventDefault() {} });
    assert.deepEqual(rootTicketIds(mounted.nav), ["aaaaaaaa", "bbbbbbbb", "dddddddd", "eeeeeeee"]);
    assert.ok(svgOf(idHead));
    assert.equal(svgOf(title), undefined);
    assert.equal(svgOf(heading("Priority")), undefined);
    assert.equal(svgOf(heading("State")), undefined);
    assert.equal(svgOf(heading("Type")), undefined);
    heading("Priority").listeners.click({ preventDefault() {} });
    assert.deepEqual(rootTicketIds(mounted.nav), ["bbbbbbbb", "aaaaaaaa", "dddddddd", "eeeeeeee"]);
    assert.equal(svgOf(idHead), undefined);
    assert.equal(pathOf(heading("Priority")).getAttribute("d"), "M12 19V5M5 12l7-7 7 7");
    heading("Priority").listeners.click({ preventDefault() {} });
    heading("Priority").listeners.click({ preventDefault() {} });
    assert.equal(svgOf(heading("Priority")), undefined);
    heading("Assignee").listeners.click({ preventDefault() {} });
    assert.deepEqual(rootTicketIds(mounted.nav), ["dddddddd", "bbbbbbbb", "aaaaaaaa", "eeeeeeee"]);
    assert.equal(pathOf(heading("Assignee")).getAttribute("d"), "M12 19V5M5 12l7-7 7 7");
    assert.equal(svgOf(heading("Priority")), undefined);
    heading("Assignee").listeners.click({ preventDefault() {} });
    assert.deepEqual(rootTicketIds(mounted.nav), ["eeeeeeee", "aaaaaaaa", "bbbbbbbb", "dddddddd"]);
    heading("Assignee").listeners.click({ preventDefault() {} });
    assert.deepEqual(rootTicketIds(mounted.nav), ["bbbbbbbb", "dddddddd", "aaaaaaaa", "eeeeeeee"]);
    assert.equal(svgOf(heading("Assignee")), undefined);
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
    drawer.styleProps.width = "12px";
    block.listeners.pointerenter();
    assert.equal(pending.length, 0);
    assert.equal(drawer.hidden, false);
    assert.equal(drawer.classList.contains("md-ticket-wide"), true);
    assert.equal(drawer.styleProps.width, "12px");
    block.listeners.pointerleave();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].ms, 200);
    const hide = pending.pop();
    hide.fn();
    assert.equal(drawer.hidden, false);
    assert.equal(drawer.hasAttribute("hidden"), false);
    assert.equal(drawer.classList.contains("md-ticket-wide"), false);
    assert.equal(drawer.styleProps.top, "");
    assert.equal(drawer.styleProps.height, "");
    assert.equal(drawer.styleProps.width, "");
    assert.equal(drawer.styleProps.transition, "");
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
    assert.equal(byClass(ticketNode(mounted.nav, "aaaaaaaa"), "md-ticket-expand").length, 0);
    assert.equal(ticketNode(mounted.nav, "cccccccc").parentElement.classList.contains("ticket-tree"), true);
    assert.equal(ticketNode(mounted.nav, "aaaaaaaa").parentElement.classList.contains("ticket-tree"), true);
    assert.equal(ticketNode(mounted.nav, "bbbbbbbb").parentElement.classList.contains("ticket-tree"), true);
    assert.equal(ticketNode(mounted.nav, "dddddddd").parentElement.classList.contains("ticket-tree"), true);
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
    assert.equal(ticketNode(mounted.nav, "bbbbbbbb").parentElement.classList.contains("ticket-tree"), true);
    assert.equal(byClass(ticketNode(mounted.nav, "aaaaaaaa"), "md-ticket-expand").length, 0);
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
  const menuRule = css.match(/\.md-ticket-filter-menu\s*\{[^}]*\}/);
  const allRule = css.match(/button\.md-ticket-filter-all\s*\{[^}]*\}/);
  const treeRule = css.match(/\.file-tree\s*\{[^}]*\}/);
  assert.ok(headRule);
  assert.ok(headingRule);
  assert.ok(blockRule);
  assert.ok(filterRule);
  assert.ok(menuRule);
  assert.ok(allRule);
  assert.ok(treeRule);
  assert.match(headRule[0], /display:\s*flex/);
  assert.match(headRule[0], /align-items:\s*center/);
  assert.match(headRule[0], /justify-content:\s*flex-start/);
  assert.match(css, /\.md-pane-head \.md-new-file,\s*\.md-pane-head \.md-new-ticket\s*\{[^}]*margin-left:\s*auto/);
  assert.match(headingRule[0], /margin:\s*0/);
  assert.match(headingRule[0], /font:\s*inherit/);
  assert.match(headingRule[0], /font-weight:\s*700/);
  assert.match(blockRule[0], /border:\s*1px solid #4a463f/);
  assert.match(blockRule[0], /padding:\s*0\.4rem/);
  assert.match(blockRule[0], /margin-bottom:\s*0\.4rem/);
  assert.equal(/margin:\s*0 0 0\.8rem/.test(blockRule[0]), false);
  assert.match(filterRule[0], /padding:\s*0/);
  assert.match(filterRule[0], /width:\s*auto/);
  assert.match(filterRule[0], /margin:\s*0/);
  assert.match(filterRule[0], /background:\s*none/);
  assert.equal(/button\.md-ticket-filter\s*\{[^}]*width:\s*100%/.test(css), false);
  assert.equal(/button\.md-ticket-filter\s*\{[^}]*margin-left:\s*auto/.test(css), false);
  assert.match(menuRule[0], /position:\s*absolute/);
  assert.match(menuRule[0], /z-index:\s*5/);
  assert.match(menuRule[0], /top:\s*1\.9rem/);
  assert.match(menuRule[0], /right:\s*0\.4rem/);
  assert.match(menuRule[0], /box-sizing:\s*border-box/);
  assert.match(menuRule[0], /min-width:\s*9rem/);
  assert.match(menuRule[0], /padding:\s*0\.35rem 0\.45rem/);
  assert.match(menuRule[0], /background:\s*#242320/);
  assert.match(menuRule[0], /border:\s*1px solid #c4b8a4/);
  assert.match(menuRule[0], /border-radius:\s*0\.35rem/);
  assert.match(css, /\.md-ticket-filter-menu\[hidden\]\s*\{[^}]*display:\s*none/);
  assert.match(allRule[0], /border-radius:\s*0\.35rem/);
  assert.match(allRule[0], /font:\s*inherit/);
  assert.equal(/border:\s*1px solid #c4b8a4/.test(allRule[0]), false);
  assert.match(css, /button\.md-ticket-filter-all[^{]*\{[^}]*border:\s*0/);
  assert.match(css, /button\.md-ticket-filter-all[^{]*\{[^}]*background:\s*none/);
  assert.match(css, /button\.md-ticket-filter-all[^{]*\{[^}]*width:\s*100%/);
  assert.match(css, /button\.md-ticket-filter-all[^{]*\{[^}]*text-align:\s*left/);
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
    assert.equal(tree.parentElement.classList.contains("md-file-drawer"), true);
    assert.equal(tree.parentElement.parentElement, fileBlock);
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
    assert.equal(ticketsHead.childNodes[2].classList.contains("md-ticket-filter"), true);
    assert.equal(ticketsHead.childNodes[2].textContent, "");
    assert.equal(ticketsHead.childNodes[2].getAttribute("aria-label"), "Filter");
    assert.deepEqual(iconPaths(ticketsHead.childNodes[2]), ["M22 3H2l8 9.46V19l4 2v-6.54L22 3z"]);
    const name = byClass(fileBlock, "md-new-name")[0];
    assert.ok(fileBlock.childNodes.indexOf(filesHead) < fileBlock.childNodes.indexOf(name));
    assert.ok(fileBlock.childNodes.indexOf(name) < fileBlock.childNodes.indexOf(tree.parentElement));
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("T-ticket-filter", () => {
  const mounted = mountTicketPage();
  const css = readFileSync(new URL("../editor.css", import.meta.url), "utf8");
  const menuRule = css.match(/\.md-ticket-filter-menu\s*\{[^}]*\}/);
  assert.ok(menuRule);
  assert.match(menuRule[0], /position:\s*absolute/);
  assert.match(menuRule[0], /z-index:\s*5/);
  assert.equal(/button\.md-ticket-filter\s*\{[^}]*width:\s*100%/.test(css), false);
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
    const tickets = byClass(mounted.nav, "ticket-tree")[0];
    const block = byClass(mounted.nav, "ticket-block")[0];
    const head = byClass(block, "md-pane-head")[0];
    assert.equal(filter.textContent, "");
    assert.equal(filter.type, "button");
    assert.equal(filter.getAttribute("aria-label"), "Filter");
    assert.deepEqual(iconPaths(filter), ["M22 3H2l8 9.46V19l4 2v-6.54L22 3z"]);
    const filterSvg = [...filter.childNodes].find((node) => node.localName === "svg");
    assert.equal(filterSvg.getAttribute("viewBox"), "0 0 24 24");
    assert.equal(filterSvg.getAttribute("aria-hidden"), "true");
    const filterPath = filterSvg.childNodes[0];
    assert.equal(filterPath.getAttribute("fill"), "none");
    assert.equal(filterPath.getAttribute("stroke"), "currentColor");
    assert.equal(filterPath.getAttribute("stroke-width"), "2");
    assert.equal(filterPath.getAttribute("stroke-linecap"), "round");
    assert.equal(filterPath.getAttribute("stroke-linejoin"), "round");
    assert.equal(filter.parentElement, head);
    assert.equal(head.childNodes[1].classList.contains("md-new-ticket"), true);
    assert.equal(head.childNodes[2], filter);
    assert.equal(menu.hidden, true);
    assert.equal(menu.hasAttribute("hidden"), true);
    assert.equal(menu.parentElement, block);
    assert.ok(block.childNodes.indexOf(head) < block.childNodes.indexOf(menu));
    const drawer = byClass(block, "md-ticket-drawer")[0];
    assert.equal(tickets.parentElement, drawer);
    assert.equal(byClass(mounted.nav, "md-new-ticket-name").length, 0);
    assert.ok(block.childNodes.indexOf(menu) < block.childNodes.indexOf(drawer));
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
    drawer.classList.add("md-ticket-wide");
    filter.listeners.click({ preventDefault() {} });
    assert.equal(transport.sent.length, beforeOpen);
    assert.equal(menu.hidden, false);
    mounted.listeners.pointerdown({ target: filter });
    assert.equal(menu.hidden, false);
    mounted.listeners.pointerdown({ target: box("low") });
    assert.equal(menu.hidden, false);
    assert.equal(drawer.classList.contains("md-ticket-wide"), true);
    assert.equal(ticketNode(mounted.nav, "dddddddd").parentElement.classList.contains("ticket-tree"), true);
    assert.equal(byClass(ticketNode(mounted.nav, "cccccccc"), "md-ticket-expand").length, 0);
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
    assert.equal(ticketNode(mounted.nav, "dddddddd").parentElement.classList.contains("ticket-tree"), true);
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
    mounted.listeners.pointerdown({ target: mounted.root });
    assert.equal(menu.hidden, true);
    view.destroy();
    assert.equal(filter.listeners.click, undefined);
    assert.equal(box("low").listeners.change, undefined);
    assert.equal(all.listeners.click, undefined);
  } finally {
    mounted.restore();
  }
});

test("T-ticket-create", () => {
  const css = readFileSync(new URL("../editor.css", import.meta.url), "utf8");
  const titleRule = css.match(/\.ticket-form \.md-ticket-title-input\s*\{[^}]*\}/);
  assert.ok(titleRule);
  assert.match(titleRule[0], /margin:\s*0 0 0\.8rem/);
  assert.equal(/margin-top:\s*0\.2rem/.test(titleRule[0]), false);
  const mounted = mountTicketPage();
  const transport = holdingTransport();
  try {
    const view = createEditor(mounted.root, "x", 0, transport);
    const button = byClass(mounted.nav, "md-new-ticket")[0];
    assert.equal(byClass(mounted.nav, "md-new-ticket-name").length, 0);
    button.listeners.click({ preventDefault() {} });
    const created = transport.sent.at(-1);
    assert.equal(created.type, "ticket.create");
    assert.equal(created.title, "New ticket");
    assert.equal(Object.hasOwn(created, "priority"), false);
    assert.equal("path" in created, false);
    assert.equal(created.rev, undefined);
    assert.equal(byClass(mounted.nav, "md-new-ticket-name").length, 0);
    const fresh = ticketFixture("aaaaaaaa", "New ticket", "new", T0);
    transport.deliver({ type: "tickets", tickets: [fresh] });
    transport.deliver({
      type: "file",
      path: "tickets/aaaaaaaa.md",
      rev: 1,
      text: "\n",
      cursor: 0,
      anchor: 0,
      locks: [],
      ticket: fresh,
    });
    const form = byClass(mounted.root.parentElement, "ticket-form")[0];
    const heading = byClass(form, "md-ticket-heading")[0];
    const input = byClass(form, "md-ticket-title-input")[0];
    assert.equal(heading.hidden, true);
    assert.equal(input.hidden, false);
    assert.equal(input.focused, true);
    assert.equal(input.value, "New ticket");
    assert.equal(input.selectionStart, 0);
    assert.equal(input.selectionEnd, "New ticket".length);
    const deletes = () => transport.sent.filter((message) => message.type === "ticket.delete");
    input.listeners.keydown({ key: "Escape", preventDefault() {} });
    assert.equal(deletes().length, 0);
    assert.equal(heading.hidden, false);
    assert.equal(heading.textContent, "New ticket");
    assert.equal(input.hidden, true);
    heading.listeners.click();
    assert.equal(input.hidden, false);
    input.value = "  Filed  ";
    input.listeners.keydown({ key: "Enter", preventDefault() {} });
    assert.equal(deletes().length, 0);
    assert.deepEqual(transport.sent.filter((message) => message.type === "ticket.set").at(-1), {
      type: "ticket.set",
      path: "tickets/aaaaaaaa.md",
      rev: 1,
      title: "Filed",
      username: "",
    });
    view.destroy();
    assert.equal(button.listeners.click, undefined);
    const again = createEditor(mounted.root, "x", 0, transport);
    assert.equal(byClass(mounted.nav, "md-new-ticket").length, 1);
    assert.equal(byClass(mounted.nav, "md-new-ticket-name").length, 0);
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
    assert.equal(input().selectionStart, input().selectionEnd);
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
      ["new", "triaged", "in progress", "blocked", "pending review", "closed"],
    );
    assert.deepEqual(
      state().childNodes.map((option) => option.value),
      ["new", "triaged", "in progress", "blocked", "pending review", "closed"],
    );
    assert.equal(byClass(parent(), "md-ticket-match")[0].value, "Bravo");
    assert.equal(dependRow("bbbbbbbb").textContent, "Bravo");
    assert.equal(dependRow("cccccccc"), undefined);
    assert.equal(byClass(form, "md-ticket-reporter")[0].textContent, "Ada");
    assert.equal(byClass(form, "md-ticket-reporter")[0].tagName, "DIV");
    assert.equal(byClass(form, "md-ticket-created")[0].textContent, T0);
    const sets = () => transport.sent.filter((message) => message.type === "ticket.set");
    state().value = "triaged";
    state().listeners.change();
    assert.equal(sets().length, 1);
    const text = mounted.findAll((node) => node.nodeType === 3 && node.textContent === "next")[0];
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
    assert.equal(byClass(parent(), "md-ticket-match")[0].value, "Bravo");
    assert.equal(dependRow("cccccccc"), undefined);
    state().value = "new";
    state().listeners.change();
    assert.equal(sets().length, 1);
    state().value = "in progress";
    state().listeners.change();
    const parentInput = byClass(parent(), "md-ticket-match")[0];
    parentInput.value = "";
    parentInput.listeners.input();
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

test("a focused ticket field keeps unsaved text when another client sets the ticket", () => {
  const mounted = mountTicketPage();
  const transport = holdingTransport();
  const previous = Object.getOwnPropertyDescriptor(globalThis.document, "activeElement");
  try {
    const view = createEditor(mounted.root, "x", 0, transport);
    const alpha = { ...ticketFixture("aaaaaaaa", "Alpha", "new", T0), assignee: "bob" };
    transport.deliver({ type: "tickets", tickets: [alpha] });
    transport.deliver({
      type: "file",
      path: "tickets/aaaaaaaa.md",
      rev: 1,
      text: "Body\n",
      cursor: 0,
      anchor: 0,
      locks: [],
      ticket: alpha,
    });
    const form = byClass(mounted.root.parentElement, "ticket-form")[0];
    const assignee = byClass(form, "md-ticket-assignee")[0];
    const priority = byClass(form, "md-ticket-priority")[0];
    const heading = byClass(form, "md-ticket-heading")[0];
    const titleInput = byClass(form, "md-ticket-title-input")[0];
    assert.equal(assignee.value, "bob");
    assignee.value = "unsaved";
    globalThis.document.activeElement = assignee;
    const notice = (fields) => {
      transport.deliver({
        type: "ticket",
        path: "tickets/aaaaaaaa.md",
        rev: fields.rev,
        title: "Alpha",
        state: "new",
        ticketType: "task",
        priority: "medium",
        assignee: "bob",
        parent: "",
        depends: [],
        reporter: "Ada",
        created: T0,
        ...fields,
      });
    };
    notice({ assignee: "carl", priority: "high", rev: 2 });
    assert.equal(byClass(form, "md-ticket-assignee")[0], assignee, "the assignee field was replaced");
    assert.equal(byClass(form, "md-ticket-assignee")[0].value, "unsaved");
    assert.equal(globalThis.document.activeElement, byClass(form, "md-ticket-assignee")[0]);
    assert.equal(priority, byClass(form, "md-ticket-priority")[0], "the priority field was replaced");
    assert.equal(priority.value, "high");
    assignee.listeners.keydown({ key: "Escape", preventDefault() {} });
    assert.equal(assignee.value, "carl");
    notice({ assignee: "dana", priority: "high", rev: 3 });
    assert.equal(byClass(form, "md-ticket-assignee")[0], assignee);
    assert.equal(assignee.value, "dana");
    globalThis.document.activeElement = null;
    notice({ assignee: "erin", rev: 4 });
    assert.equal(assignee.value, "erin");
    heading.listeners.click();
    titleInput.value = "Draft title";
    globalThis.document.activeElement = titleInput;
    notice({ title: "Remote title", assignee: "erin", rev: 5 });
    assert.equal(byClass(form, "md-ticket-title-input")[0], titleInput, "the title field was replaced");
    assert.equal(titleInput.value, "Draft title");
    assert.equal(titleInput.hidden, false);
    assert.equal(globalThis.document.activeElement, titleInput);
    assert.equal(byClass(form, "md-ticket-assignee")[0].value, "erin");
    view.destroy();
  } finally {
    if (previous) Object.defineProperty(globalThis.document, "activeElement", previous);
    else delete globalThis.document.activeElement;
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
    assert.equal(tree.parentElement.classList.contains("md-file-drawer"), true);
    assert.equal(tree.parentElement.parentElement, fileBlock);
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
    assert.equal(kidList[kidList.indexOf(nested[0]) - 1], buttonPath("notes/idea.md").parentElement);
    assert.equal(kidList[kidList.indexOf(nested[0]) - 1].classList.contains("md-file-row"), true);
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
    assert.equal(view.getState().anchor, 2);
    assert.equal(view.getState().cursor, 6);
    press("ArrowRight", { shiftKey: true, altKey: true });
    assert.equal(view.getState().anchor, 7);
    assert.equal(view.getState().cursor, 7);
    press("ArrowRight", { shiftKey: true, metaKey: true });
    assert.equal(view.getState().anchor, 8);
    assert.equal(view.getState().cursor, 8);
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

function pressWord(mounted, doc, cursor, key, extra, raw) {
  const view = createEditor(mounted.root, doc, cursor);
  if (raw) pressViewToggle(mounted.root);
  keyDown(mounted, key, extra);
  const state = view.getState();
  const out = { doc: state.doc, anchor: state.anchor, cursor: state.cursor };
  view.destroy();
  return out;
}

function assertWord(mounted, doc, cursor, key, extra, anchor, focus) {
  for (const raw of [false, true]) {
    const state = pressWord(mounted, doc, cursor, key, extra, raw);
    const where = raw ? "raw" : "rendered";
    assert.equal(state.doc, doc, where);
    assert.equal(state.anchor, anchor, where);
    assert.equal(state.cursor, focus, where);
  }
}

test("MV.sh.4", () => {
  const mounted = mountEditor();
  try {
    assertWord(mounted, "hello fox\n", 0, "ArrowRight", { ctrlKey: true }, 6, 6);
    assertWord(mounted, "hello fox\n", 3, "ArrowRight", { ctrlKey: true }, 6, 6);
    assertWord(mounted, "hello fox\n", 0, "ArrowRight", { ctrlKey: true, shiftKey: true }, 0, 6);
  } finally {
    mounted.restore();
  }
});

test("MV.cw.1", () => {
  const mounted = mountEditor();
  try {
    assertWord(mounted, "hello fox\n", 9, "ArrowLeft", { ctrlKey: true }, 6, 6);
  } finally {
    mounted.restore();
  }
});

test("MV.cw.2", () => {
  const mounted = mountEditor();
  try {
    assertWord(mounted, "hello fox\n", 5, "ArrowRight", { ctrlKey: true }, 6, 6);
  } finally {
    mounted.restore();
  }
});

test("MV.cw.3", () => {
  const mounted = mountEditor();
  try {
    assertWord(mounted, "x **bold** y\n", 6, "ArrowRight", { ctrlKey: true }, 11, 11);
  } finally {
    mounted.restore();
  }
});

test("MV.cw.4", () => {
  const mounted = mountEditor();
  try {
    assertWord(mounted, "alpha\nbeta\n", 6, "ArrowLeft", { ctrlKey: true }, 0, 0);
  } finally {
    mounted.restore();
  }
});

test("MV.cw.5", () => {
  const mounted = mountEditor();
  try {
    assertWord(mounted, "hello fox\n", 6, "ArrowRight", { ctrlKey: true }, 9, 9);
    assertWord(mounted, "hello fox\n", 9, "ArrowRight", { ctrlKey: true }, 9, 9);
  } finally {
    mounted.restore();
  }
});

test("MV.cw.6", () => {
  const mounted = mountEditor();
  try {
    assertWord(mounted, "don't stop\n", 0, "ArrowRight", { ctrlKey: true }, 6, 6);
  } finally {
    mounted.restore();
  }
});

test("MV.cw.7", () => {
  const mounted = mountEditor();
  try {
    assertWord(mounted, "x **bold** y\n", 11, "ArrowLeft", { ctrlKey: true }, 2, 2);
  } finally {
    mounted.restore();
  }
});

test("comment notes use record ids and replies do not lock", () => {
  const mounted = mountSheet();
  const texts = () => mounted.findAll((node) => node.classList && node.classList.contains("md-comment-text"));
  const areas = () => mounted.findAll((node) => node.tagName === "TEXTAREA");
  const press = (label) => {
    const button = mounted.findAll((node) => node.tagName === "BUTTON" && (
      node.textContent === label || (typeof node.getAttribute === "function" && node.getAttribute("aria-label") === label)
    )).at(-1);
    assert.ok(button, label);
    button.listeners.click({ target: button, preventDefault() {} });
  };
  try {
    const zero = "Say {c1}fox{/c1} now.\n\n```comment c1\n:: 0\n@2026-10-04T20:30:22.000Z Ada\nhi\n```\n";
    const zeroMemory = createMemoryTransport(zero, 0);
    zeroMemory.username = "Ada";
    const shown = createEditor(mounted.root, zero, 0, zeroMemory);
    assert.equal(texts().length, 1);
    assert.equal(texts()[0].textContent, "hi");
    assert.equal(texts()[0].dataset.note, "0");
    assert.equal(texts()[0].textContent.includes("::"), false);
    mounted.aside.listeners.click({ target: texts()[0], preventDefault() {} });
    assert.equal(areas()[0].value, "hi");
    assert.equal(areas()[0].dataset.note, "0");
    press("Cancel");
    shown.destroy();

    const explicit = "Say {c1}fox{/c1} now.\n\n```comment c1\n:: 4\n@2026-10-04T20:30:22.000Z Ada\nonly\n```\n";
    const memory = createMemoryTransport(explicit, 0);
    memory.username = "Ada";
    const sent = [];
    const send = memory.send.bind(memory);
    memory.send = (message) => {
      sent.push({ ...message });
      send(message);
    };
    const next = createEditor(mounted.root, explicit, 0, memory);
    assert.equal(texts().length, 1);
    assert.equal(texts()[0].textContent, "only");
    assert.equal(texts()[0].dataset.note, "4");
    assert.equal(mounted.findAll((node) => node.textContent === ":: 4").length, 0);
    press("Reply");
    assert.equal(areas()[0].dataset.reply, "true");
    assert.equal(areas()[0].dataset.note, "5");
    areas()[0].value = "more";
    press("Save");
    const replies = sent.filter((message) => message.type === "comment.reply");
    assert.equal(replies.length, 1);
    assert.equal(replies[0].id, "c1");
    assert.equal(replies[0].text, "more");
    assert.equal(replies[0].path, "");
    assert.equal("rev" in replies[0], false);
    assert.equal("note" in replies[0], false);
    assert.equal(sent.some((message) => message.type === "lock" || message.op === "comment.save"), false);
    const replied = next.getState().doc;
    assert.equal(replied.includes(":: 4\n@2026-10-04T20:30:22.000Z Ada\nonly\n"), true);
    assert.match(replied, /:: 5\n@\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z Ada\nmore/);
    assert.deepEqual(texts().map((item) => item.dataset.note), ["4", "5"]);
    assert.deepEqual(texts().map((item) => item.textContent), ["only", "more"]);
    sent.length = 0;
    mounted.aside.listeners.click({ target: texts()[0], preventDefault() {} });
    assert.equal(areas()[0].value, "only");
    areas()[0].value = "yo";
    press("Save");
    const edits = sent.filter((message) => message.type === "comment.edit");
    assert.equal(edits.length, 1);
    assert.equal(edits[0].id, "c1");
    assert.equal(edits[0].note, 4);
    assert.equal(edits[0].text, "yo");
    assert.equal(edits[0].rev, 1);
    assert.equal(edits[0].path, "");
    assert.equal(next.getState().doc.includes(":: 4\n@2026-10-04T20:30:22.000Z Ada\nyo\n"), true);
    assert.equal(texts()[0].textContent, "yo");
    next.destroy();
  } finally {
    mounted.restore();
  }
});

test("the socket transport transmits comment messages", () => {
  const sent = [];
  let openHandler = null;
  const transport = createSocketTransport({
    username: "Ada",
    socketFactory() {
      return {
        addEventListener(type, fn) {
          if (type === "open") openHandler = fn;
        },
        removeEventListener() {},
        send(data) {
          sent.push(JSON.parse(data));
        },
        close() {},
      };
    },
    location: { protocol: "http:", host: "viewmark.test" },
  });
  assert.equal(typeof openHandler, "function");
  openHandler();
  sent.length = 0;
  transport.send({ type: "comment.reply", path: "a.md", id: "c1", text: "hi" });
  transport.send({ type: "comment.edit", path: "a.md", id: "c1", note: 4, rev: 2, text: "yo" });
  assert.deepEqual(sent, [
    { type: "comment.reply", path: "a.md", id: "c1", text: "hi", username: "Ada" },
    { type: "comment.edit", path: "a.md", id: "c1", note: 4, rev: 2, text: "yo", username: "Ada" },
  ]);
  transport.close();
});

test("ctrl-enter saves a comment body and enter does not", () => {
  const mounted = mountSheet();
  const doc = "hello {c1}fox{/c1} two\n\n```comment c1\n@2026-10-04T20:30:22.000Z Ada\nhi\n```\n";
  const transport = holdingTransport();
  transport.username = "Ada";
  const saves = () => transport.sent.filter((message) => message.type === "comment.edit");
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
    assert.equal(saves()[0].type, "comment.edit");
    assert.equal(saves()[0].id, "c1");
    assert.equal(saves()[0].note, 0);
    assert.equal(saves()[0].text, "yo");
    assert.equal(saves()[0].path, "");
    assert.equal(saves()[0].rev, 0);
    assert.equal(view.getState().doc, doc);
    assert.equal(transport.sent.some((message) => message.op === "comment.save" || message.type === "lock"), false);
    view.destroy();

    const again = holdingTransport();
    again.username = "Ada";
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
    const metaSaves = again.sent.filter((message) => message.type === "comment.edit");
    assert.equal(prevented, true);
    assert.equal(metaSaves.length, 1);
    assert.equal(metaSaves[0].type, "comment.edit");
    assert.equal(metaSaves[0].note, 0);
    assert.equal(metaSaves[0].text, "via meta");
    assert.equal(metaSaves[0].rev, 0);
    assert.equal(meta.getState().doc, doc);
    meta.destroy();
  } finally {
    mounted.restore();
  }
});

test("wordSpan trims markers and keeps the host of a url", () => {
  const bold = "a **bold** b";
  const at = bold.indexOf("bold");
  assert.deepEqual(wordSpan(bold, at), [at, at + "bold".length]);
  assert.equal(bold.slice(at, at + 4), "bold");
  const url = "https://x.test/p";
  const host = wordSpan(url, url.indexOf("test"));
  assert.equal(url.slice(host[0], host[1]), "x.test");
  const em = "_em_";
  assert.equal(em.slice(...wordSpan(em, 1)), "em");
  assert.equal("snake_case".slice(...wordSpan("snake_case", 3)), "snake_case");
  assert.equal("don't".slice(...wordSpan("don't", 2)), "don't");
  assert.equal("~~gone~~".slice(...wordSpan("~~gone~~", 3)), "gone");
  const spaces = "a    b";
  const gap = spaces.indexOf("    ") + 2;
  assert.deepEqual(wordSpan(spaces, gap), [gap, gap]);
  const punct = "alpha, beta.";
  const beta = punct.indexOf("beta");
  assert.equal(punct.slice(...wordSpan(punct, beta + 1)), "beta");
});

// T3.p.1 T3.sp.1 T3.h.1 T3.li.1 T3.li.2 T3.q.1 T3.fc.1. The range starts after
// the first line's marker and stops before the block's closing newline.
test("blockSpan selects the block after its marker", () => {
  const taken = (doc, needle) => {
    const at = doc.indexOf(needle);
    const [start, end] = blockSpan(doc, at);
    return doc.slice(start, end);
  };
  const paragraph = "x\n\nhello fox two\nnext\n";
  assert.equal(taken(paragraph, "fox"), "hello fox two\nnext");
  const wrapped = "x\n\nalpha\nbeta\n";
  assert.equal(taken(wrapped, "beta"), "alpha\nbeta");
  const heading = "x\n\n# Title\n";
  assert.equal(taken(heading, "Title"), "Title");
  assert.equal(taken(heading, "#"), "Title");
  assert.equal(taken("x\n\n## Title\n", "#"), "Title");
  const item = "x\n\n- alpha\n";
  assert.equal(taken(item, "alpha"), "alpha");
  assert.equal(taken(item, "-"), "alpha");
  const items = "x\n\n- one\n- two\n";
  assert.equal(taken(items, "one"), "one");
  assert.equal(taken(items, "two"), "two");
  const quote = "x\n\n> alpha\n";
  assert.equal(taken(quote, "alpha"), "alpha");
  assert.equal(taken(quote, ">"), "alpha");
  const fence = "x\n\n```js\nlet y\nlet z\n```\n";
  assert.equal(taken(fence, "z"), "let y\nlet z");
  assert.equal(taken(fence, "```"), "let y\nlet z");
  assert.deepEqual(blockSpan(fence, fence.lastIndexOf("```")), blockSpan(fence, fence.indexOf("z")));

  assert.equal(taken("- [ ] buy milk\n", "-"), "buy milk");
  assert.equal(taken("- [x] buy milk\n", "-"), "buy milk");
  assert.equal(taken("- [X] buy milk\n", "buy"), "buy milk");
  assert.equal(taken("> - [ ] buy\n", ">"), "buy");
  assert.equal(taken("* alpha\n", "*"), "alpha");
  assert.equal(taken("+ alpha\n", "+"), "alpha");
  assert.equal(taken("12. twelve\n", "1"), "twelve");
  assert.equal(taken("1) one\n", "1"), "one");
  assert.equal(taken("> - alpha\n", ">"), "alpha");
  assert.equal(taken("> one\ntwo\nthree\n", "three"), "one\ntwo\nthree");
  assert.equal(taken("- one\n  two\n", "two"), "one\n  two");
  const nested = "- one\n  - two\n";
  assert.equal(taken(nested, "one"), "one");
  assert.equal(taken(nested, "two"), "two");

  const diagram = "```mermaid\nA-->B\n```\n";
  assert.equal(taken(diagram, "A"), "A-->B");
  assert.deepEqual(blockSpan(diagram, 0), blockSpan(diagram, diagram.indexOf("A")));
  const emptyFence = "```\n```\n";
  assert.deepEqual(blockSpan(emptyFence, 0), [4, 4]);
  const unclosed = "```js\nlet y\n";
  assert.equal(unclosed.slice(...blockSpan(unclosed, 0)), "let y");
  const after = "```js\nlet y\n```\n\nnext\n";
  assert.equal(taken(after, "let"), "let y");
  assert.equal(taken(after, "next"), "next");

  const table = "| a | b |\n| --- | --- |\n| 1 | 2 |\n";
  assert.equal(taken(table, "1"), "| 1 | 2 |");
  assert.equal(taken(table, "a"), "| a | b |\n| --- | --- |");
  assert.deepEqual(blockSpan("hello\n", "hello\n".length), [6, 6]);
  assert.deepEqual(blockSpan("", 0), [0, 0]);
});

test("detail 2 selects the word and detail 3 selects the block", () => {
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
    assert.equal(lined.getState().cursor, 18);
    assert.equal(selectedSlice(lined.getState()), "hello fox two\nnext");
    lined.destroy();

    const blank = createEditor(mounted.root, "hello\n\nfox\n", 0);
    const empty = mounted.findAll((node) => node.tagName === "BR" && node.parentElement && node.parentElement.dataset.start === node.parentElement.dataset.end)[0];
    const at = Number(empty.parentElement.dataset.start);
    globalThis.document.caretPositionFromPoint = () => ({ offsetNode: empty, offset: 0 });
    click(empty, 3);
    assert.notEqual(blank.getState().cursor, at);
    assert.notEqual(blank.getState().anchor, at);
    assert.equal(blank.getState().anchor, 0);
    assert.equal(blank.getState().cursor, 5);
    assert.equal(selectedSlice(blank.getState()), "hello");
    blank.destroy();
  } finally {
    mounted.restore();
  }
});

test("a double-click selects the word under the first press", () => {
  const mounted = mountEditor();
  const press = (target, detail) => {
    mounted.listeners.mousedown({ clientX: 4, clientY: 4, detail, button: 0 });
    mounted.listeners.mouseup({ clientX: 4, clientY: 4, detail, button: 0 });
    mounted.listeners.click({
      target,
      clientX: 4,
      clientY: 4,
      detail,
      button: 0,
      preventDefault() {},
    });
  };
  try {
    const doc = "x\n\n```js\nlet foo = 1\n```\n";
    const view = createEditor(mounted.root, doc, 0);
    assert.equal(mounted.root.textContent.includes("```"), false);
    const foo = mounted.findAll((node) => node.nodeType === 3 && node.textContent.includes("foo"))[0];
    assert.ok(foo);
    globalThis.document.caretPositionFromPoint = () => ({ offsetNode: foo, offset: foo.textContent.indexOf("foo") });
    press(foo, 1);
    assert.equal(mounted.root.textContent.includes("```"), true);
    assert.equal(view.getState().anchor, view.getState().cursor);
    assert.equal(doc.slice(view.getState().cursor, view.getState().cursor + 3), "foo");
    globalThis.document.caretPositionFromPoint = () => ({ offsetNode: foo, offset: 0 });
    press(foo, 2);
    assert.equal(selectedSlice(view.getState()), "foo");
    assert.equal(mounted.root.textContent.includes("```"), true);
    view.destroy();

    const tripleDoc = "x\n\n```js\nlet y\nlet z\n```\n";
    const triple = createEditor(mounted.root, tripleDoc, 0);
    const zed = mounted.findAll((node) => node.nodeType === 3 && node.textContent.includes("z"))[0];
    assert.ok(zed);
    globalThis.document.caretPositionFromPoint = () => ({ offsetNode: zed, offset: zed.textContent.indexOf("z") });
    press(zed, 1);
    assert.equal(mounted.root.textContent.includes("```"), true);
    assert.equal(tripleDoc.slice(triple.getState().cursor, triple.getState().cursor + 1), "z");
    press(zed, 2);
    const opener = mounted.findAll((node) => node.nodeType === 3 && node.textContent.includes("```"))[0];
    globalThis.document.caretPositionFromPoint = () => ({ offsetNode: opener || zed, offset: 0 });
    press(opener || zed, 3);
    assert.equal(selectedSlice(triple.getState()), "let y\nlet z");
    triple.destroy();
  } finally {
    delete globalThis.document.caretPositionFromPoint;
    mounted.restore();
  }
});

// DC.cm.1. The first press lands on the word. Rendering it draws handles, and
// the second press lands on one. The word from the first press is the selection.
test("DC.cm.1 a double-click on a comment word selects it when the second press hits a handle", () => {
  const mounted = mountEditor();
  const rect = { left: 8, right: 48, top: 8, bottom: 28, width: 40, height: 20 };
  const create = globalThis.document.createElement;
  globalThis.document.createElement = (tag) => {
    const el = create(tag);
    el.getClientRects = () => [rect];
    return el;
  };
  const prose = "x\n\nSee {c1}this{/c1} now.";
  const doc = `${prose}\n\n\`\`\`comment c1\n:: 0\n@2026-10-05T16:00:00.000Z Ada\nNote.\n\`\`\`\n`;
  const press = (target, detail) => {
    const event = {
      target,
      clientX: 20,
      clientY: 18,
      detail,
      button: 0,
      preventDefault() {},
    };
    mounted.listeners.mousedown(event);
    mounted.listeners.mouseup(event);
    mounted.listeners.click(event);
  };
  try {
    assert.equal(prose.slice(11, 15), "this");
    const view = createEditor(mounted.root, doc, 0);
    const word = mounted.findAll((node) => node.nodeType === 3 && node.textContent === "this" && node.parentElement && node.parentElement.classList.contains("md-comment"))[0];
    assert.ok(word);
    globalThis.document.caretPositionFromPoint = () => ({ offsetNode: word, offset: 1 });
    mounted.listeners.mousemove({ target: word, clientX: 20, clientY: 18, button: 0 });
    press(word, 1);
    assert.equal(view.getState().anchor, view.getState().cursor);
    assert.equal(view.getState().cursor, prose.indexOf("this") + 1);
    const handle = mounted.findAll((node) => node.classList && node.classList.contains("md-comment-handle"))[0];
    assert.ok(handle, "the first press did not show a handle");
    press(handle, 2);
    assert.equal(view.getState().anchor, 11);
    assert.equal(view.getState().cursor, 15);
    assert.equal(selectedSlice(view.getState()), "this");
    assert.equal(view.getState().doc, doc);
    view.destroy();
  } finally {
    delete globalThis.document.caretPositionFromPoint;
    mounted.restore();
  }
});

test("a press that stays on a comment handle places the caret", () => {
  const mounted = mountEditor();
  const prose = "x\n\nSee {c1}this{/c1} now.";
  const doc = `${prose}\n\n\`\`\`comment c1\n:: 0\n@2026-10-05T16:00:00.000Z Ada\nNote.\n\`\`\`\n`;
  const press = (target, detail) => {
    const event = {
      target,
      clientX: 20,
      clientY: 18,
      detail,
      button: 0,
      preventDefault() {},
    };
    mounted.listeners.mousedown(event);
    mounted.listeners.mouseup(event);
    mounted.listeners.click(event);
  };
  try {
    const view = createEditor(mounted.root, doc, 0);
    const word = mounted.findAll((node) => node.nodeType === 3 && node.textContent === "this" && node.parentElement && node.parentElement.classList.contains("md-comment"))[0];
    assert.ok(word);
    word.parentElement.getClientRects = () => [{ left: 8, right: 48, top: 8, bottom: 28, width: 40, height: 20 }];
    globalThis.document.caretPositionFromPoint = () => ({ offsetNode: word, offset: 1 });
    mounted.listeners.mousemove({ target: word, clientX: 20, clientY: 18, button: 0 });
    const handle = mounted.findAll((node) => node.classList && node.classList.contains("md-comment-handle"))[0];
    assert.ok(handle);
    press(handle, 1);
    assert.equal(view.getState().anchor, prose.indexOf("this") + 1);
    assert.equal(view.getState().cursor, prose.indexOf("this") + 1);
    assert.equal(view.getState().doc, doc);
    view.destroy();
  } finally {
    delete globalThis.document.caretPositionFromPoint;
    mounted.restore();
  }
});

test("a same-line render does not scroll the caret", () => {
  const mounted = mountEditor();
  globalThis.NodeFilter = globalThis.NodeFilter || { SHOW_TEXT: 4 };
  try {
    const view = createEditor(mounted.root, "hello fox\n", 0);
    const text = mounted.findAll((node) => node.nodeType === 3 && node.textContent === "hello fox")[0];
    assert.ok(text);
    let scrolls = 0;
    text.parentElement.scrollIntoView = () => {
      scrolls += 1;
    };
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
    let reads = 0;
    let tops = [20, 20];
    globalThis.window.getSelection = () => ({
      rangeCount: 1,
      anchorNode: text,
      anchorOffset: 1,
      focusNode: text,
      focusOffset: 1,
      removeAllRanges() {},
      addRange() {},
      setBaseAndExtent() {},
      getRangeAt() {
        return {
          getClientRects() {
            const top = tops[Math.min(reads, tops.length - 1)];
            reads += 1;
            return [{ top, left: 0, right: 8, bottom: top + 16, width: 8, height: 16 }];
          },
        };
      },
    });
    globalThis.document.caretPositionFromPoint = () => ({ offsetNode: text, offset: 1 });
    const click = () => {
      reads = 0;
      mounted.listeners.click({ target: text, clientX: 4, clientY: 4, preventDefault() {} });
    };
    click();
    assert.equal(scrolls, 0);
    tops = [20, 48];
    click();
    assert.equal(scrolls, 1);
    globalThis.window.innerWidth = 800;
    globalThis.window.innerHeight = 600;
    tops = [20, 80];
    click();
    assert.equal(scrolls, 1);
    view.destroy();
  } finally {
    delete globalThis.document.caretPositionFromPoint;
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
  assert.match(css, /\.ticket-form \.md-ticket-label\s*\{[^}]*width:\s*8rem;/);
  assert.match(css, /\.ticket-form \.md-ticket-label\s*\{[^}]*text-align:\s*right;/);
  const factRule = css.match(/\.md-ticket-fact\s*\{[^}]*\}/);
  assert.ok(factRule);
  assert.match(factRule[0], /display:\s*flex;/);
  assert.match(factRule[0], /flex-direction:\s*row;/);
  const reporterRule = css.match(/\.md-ticket-reporter,\s*\.md-ticket-created,\s*\.md-ticket-fact-id\s*\{[^}]*\}/);
  assert.ok(reporterRule);
  assert.equal(/font-size:\s*0\.85rem/.test(reporterRule[0]), false);
  assert.match(reporterRule[0], /color:\s*inherit/);
  assert.equal(/#9c968c/.test(reporterRule[0]), false);
  const linkRule = css.match(/\.ticket-form \.md-ticket-links\s*\{[^}]*\}/);
  assert.ok(linkRule);
  assert.match(linkRule[0], /height:\s*6\.5rem/);
  assert.match(linkRule[0], /overflow:\s*auto/);
  assert.match(linkRule[0], /border:\s*1px solid #4a463f/);
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
      "md-ticket-field",
      "md-ticket-field md-ticket-parent",
      "md-ticket-depends",
    ]);
    assert.deepEqual(
      left.childNodes.filter((node) => node.classList.contains("md-ticket-field")).map((node) => node.childNodes[0].textContent),
      ["State", "Type", "Priority", "Assignee", "Parent"],
    );
    const priorityLabel = left.childNodes.find((node) => node.childNodes[0] && node.childNodes[0].textContent === "Priority");
    const assigneeLabel = left.childNodes[left.childNodes.indexOf(priorityLabel) + 1];
    assert.equal(assigneeLabel.childNodes[0].textContent, "Assignee");
    assert.equal(assigneeLabel.childNodes[1].classList.contains("md-ticket-assignee"), true);
    assert.equal(assigneeLabel.childNodes[1].tagName, "INPUT");
    assert.equal(byClass(left, "md-ticket-children").length, 0);
    assert.equal(byClass(left, "md-ticket-blocks").length, 0);
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
    ]);
    assert.deepEqual(
      right.childNodes.map((node) => [node.childNodes[0].textContent, node.childNodes[1].className]),
      [
        ["Id", "md-ticket-fact-id"],
        ["Reporter", "md-ticket-reporter"],
        ["Created", "md-ticket-created"],
      ],
    );
    assert.equal(right.childNodes[0].childNodes[1].textContent, "aaaaaaaa");
    assert.equal(reporter.parentElement.classList.contains("md-ticket-fact"), true);
    assert.equal(byClass(form, "md-ticket-delete").length, 0);
    assert.equal(byClass(right, "md-ticket-blocks").length, 0);
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
      ["State", "Type", "Priority", "Assignee", "Parent", "Depends", "Children", "Blocks"].map((label) => (
        byClass(form, "md-ticket-label").some((node) => node.textContent === label)
      )),
      [true, true, true, true, true, true, true, true],
    );
    assert.equal(byClass(parent, "md-ticket-add").length, 0);
    assert.equal(byClass(parent, "md-ticket-remove").length, 0);
    assert.equal(byClass(parent, "md-ticket-parent-value").length, 0);
    assert.equal(byClass(parent, "md-ticket-match")[0].value, "Bravo");
    const dependAdd = byClass(depends, "md-ticket-add")[0];
    assert.equal(dependAdd.classList.contains("icon-btn"), true);
    assert.equal(dependAdd.getAttribute("aria-label"), "Add");
    assert.equal(dependAdd.textContent, "");
    assert.equal(dependAdd.type, "button");
    const dependAddSvg = dependAdd.childNodes.find((node) => node.tagName === "SVG");
    assert.equal(dependAddSvg.getAttribute("viewBox"), "0 0 24 24");
    assert.equal(dependAddSvg.getAttribute("aria-hidden"), "true");
    const dependAddPath = dependAddSvg.childNodes.find((node) => node.tagName === "PATH");
    assert.equal(dependAddPath.getAttribute("d"), "M12 5v14M5 12h14");
    assert.equal(dependAddPath.getAttribute("fill"), "none");
    assert.equal(dependAddPath.getAttribute("stroke"), "currentColor");
    assert.equal(dependAddPath.getAttribute("stroke-width"), "2");
    assert.equal(dependAddPath.getAttribute("stroke-linecap"), "round");
    assert.equal(dependAddPath.getAttribute("stroke-linejoin"), "round");
    const dependRemove = byClass(depends, "md-ticket-remove")[0];
    assert.equal(dependRemove.classList.contains("icon-btn"), true);
    assert.equal(dependRemove.type, "button");
    assert.equal(dependRemove.getAttribute("aria-label"), "Remove");
    assert.equal(dependRemove.textContent, "");
    const dependRemoveSvg = dependRemove.childNodes.find((node) => node.tagName === "SVG");
    assert.equal(dependRemoveSvg.getAttribute("aria-hidden"), "true");
    const dependRemovePath = dependRemoveSvg.childNodes.find((node) => node.tagName === "PATH");
    assert.equal(dependRemovePath.getAttribute("d"), "M5 12h14");
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
      byClass(block("md-ticket-blocks"), "md-ticket-link").map((node) => node.textContent),
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
    const beforeDependPick = sets().length;
    options[1].listeners.click({ preventDefault() {} });
    assert.equal(sets().length, beforeDependPick);
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

    mounted.listeners.pointerdown({ target: form });
    assert.equal(byClass(depends, "md-ticket-menu")[0].hidden, true);
    const beforeOutside = sets().length;
    dependMatch.value = "qu";
    dependMatch.listeners.input();
    assert.equal(dependMatch.value, "Quest");
    assert.equal(byClass(depends, "md-ticket-menu")[0].hidden, false);
    const inside = byClass(depends, "md-ticket-option")[0];
    mounted.listeners.pointerdown({ target: inside });
    assert.equal(byClass(depends, "md-ticket-menu")[0].hidden, false);
    assert.equal(sets().length, beforeOutside);
    mounted.listeners.pointerdown({ target: form });
    assert.equal(byClass(depends, "md-ticket-menu")[0].hidden, true);
    assert.equal(sets().length, beforeOutside);
    assert.equal(dependMatch.value, "qu");

    const parentMatch = byClass(parent, "md-ticket-match")[0];
    parentMatch.value = "";
    parentMatch.listeners.input();
    assert.deepEqual(sets().at(-1), {
      type: "ticket.set",
      path: "tickets/aaaaaaaa.md",
      rev: 6,
      parent: "",
      username: "",
    });
    parentMatch.value = "de";
    parentMatch.listeners.input();
    assert.equal(parentMatch.value, "Delta");
    const beforeParentPick = sets().length;
    byClass(byClass(parent, "md-ticket-menu")[0], "md-ticket-option")[0].listeners.click({ preventDefault() {} });
    assert.equal(parentMatch.value, "Delta");
    assert.equal(byClass(parent, "md-ticket-menu")[0].hidden, true);
    assert.equal(sets().length, beforeParentPick + 1);
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
    const blocks = byClass(form, "md-ticket-blocks")[0];
    const echoRow = byClass(blocks, "md-ticket-link")[0];
    assert.equal(echoRow.tagName, "BUTTON");
    assert.equal(echoRow.textContent, "Echo");
    echoRow.listeners.click({ preventDefault() {} });
    byClass(blocks, "md-ticket-remove")[0].listeners.click({ preventDefault() {} });
    assert.deepEqual(sets().at(-1), {
      type: "ticket.set",
      path: "tickets/eeeeeeee.md",
      rev: 0,
      depends: [],
      username: "",
    });
    assert.equal(sets().some((message) => message.path === "tickets/aaaaaaaa.md" && message.depends && message.depends.includes("aaaaaaaa")), false);
    const bare = ticketFixture("pppppppp", "", "new", "2026-11-01T00:00:00.000Z");
    const quot = ticketFixture("qqqqqqqq", "Quot", "new", "2026-11-02T00:00:00.000Z", "pppppppp");
    transport.deliver({ type: "tickets", tickets: [bare, quot] });
    transport.deliver({
      type: "file",
      path: "tickets/qqqqqqqq.md",
      rev: 2,
      text: "q\n",
      locks: [],
      ticket: quot,
    });
    assert.equal(byClass(form, "md-ticket-match")[0].value, "pppppppp");
    const missing = ticketFixture("ssssssss", "Solo", "new", "2026-11-04T00:00:00.000Z", "zzzzzzzz");
    transport.deliver({ type: "tickets", tickets: [missing] });
    transport.deliver({
      type: "file",
      path: "tickets/ssssssss.md",
      rev: 1,
      text: "s\n",
      locks: [],
      ticket: missing,
    });
    assert.equal(byClass(form, "md-ticket-match")[0].value, "zzzzzzzz");
    const none = ticketFixture("rrrrrrrr", "Roto", "new", "2026-11-03T00:00:00.000Z");
    transport.deliver({ type: "tickets", tickets: [none] });
    transport.deliver({
      type: "file",
      path: "tickets/rrrrrrrr.md",
      rev: 1,
      text: "r\n",
      locks: [],
      ticket: none,
    });
    assert.equal(byClass(form, "md-ticket-match").length, 0);
    assert.equal(byClass(form, "md-ticket-parent").length, 0);
    assert.equal(byClass(form, "md-ticket-depends").length, 0);
    assert.equal(byClass(form, "md-ticket-children").length, 0);
    assert.equal(byClass(form, "md-ticket-blocks").length, 0);
    view.destroy();
  } finally {
    if (previousHistory === undefined) delete globalThis.history;
    else globalThis.history = previousHistory;
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
    mounted.restore();
  }
});

test("moving a child from one parent to another is one set on the child", () => {
  const mounted = mountTicketPage();
  const transport = holdingTransport();
  try {
    const view = createEditor(mounted.root, "x", 0, transport);
    const alpha = { ...ticketFixture("aaaaaaaa", "Alpha", "new", T0), rev: 7 };
    const bravo = { ...ticketFixture("bbbbbbbb", "Bravo", "new", T1), rev: 9 };
    const cedar = { ...ticketFixture("cccccccc", "Cedar", "new", T2, "aaaaaaaa"), rev: 3 };
    const sets = () => transport.sent.filter((message) => message.type === "ticket.set");
    const form = () => byClass(mounted.root.parentElement, "ticket-form")[0];
    const showChildren = () => {
      if (byClass(form(), "md-ticket-children").length > 0) return;
      const panel = byClass(form(), "md-ticket-pane-panel")[0];
      const choice = byClass(panel, "md-ticket-pane-choice").find((node) => node.textContent === "Children");
      const box = choice.childNodes.find((node) => node.tagName === "INPUT");
      box.checked = true;
      box.listeners.change();
    };
    const childLinkIds = () => {
      showChildren();
      const block = byClass(form(), "md-ticket-children")[0];
      return byClass(block, "md-ticket-link").map((node) => node.dataset.id);
    };
    const openTicketFile = (ticket, rev) => {
      transport.deliver({
        type: "file",
        path: `tickets/${ticket.id}.md`,
        rev,
        text: "x\n",
        cursor: 0,
        anchor: 0,
        locks: [],
        ticket: { ...ticket, rev },
      });
    };
    const addChild = (prefix) => {
      const children = byClass(form(), "md-ticket-children")[0];
      const match = byClass(children, "md-ticket-match")[0];
      match.value = prefix;
      match.selectionStart = 0;
      match.selectionEnd = 0;
      match.listeners.input();
      byClass(children, "md-ticket-add")[0].listeners.click({ preventDefault() {} });
    };

    transport.deliver({ type: "tickets", tickets: [alpha, bravo, cedar] });
    openTicketFile(bravo, 9);
    assert.deepEqual(childLinkIds(), []);
    addChild("Ce");
    assert.deepEqual(sets(), [
      {
        type: "ticket.set",
        path: "tickets/cccccccc.md",
        rev: 3,
        parent: "bbbbbbbb",
        username: "",
      },
    ]);
    assert.equal(transport.sent.some((message) => message.type === "ticket.set" && message.path === "tickets/aaaaaaaa.md"), false);

    const underBravo = { ...cedar, parent: "bbbbbbbb", rev: 4 };
    transport.deliver({ type: "tickets", tickets: [alpha, bravo, underBravo] });
    assert.deepEqual(childLinkIds(), ["cccccccc"]);
    openTicketFile(alpha, 7);
    assert.deepEqual(childLinkIds(), []);

    addChild("Ce");
    assert.deepEqual(sets(), [
      {
        type: "ticket.set",
        path: "tickets/cccccccc.md",
        rev: 3,
        parent: "bbbbbbbb",
        username: "",
      },
      {
        type: "ticket.set",
        path: "tickets/cccccccc.md",
        rev: 4,
        parent: "aaaaaaaa",
        username: "",
      },
    ]);
    assert.equal(transport.sent.some((message) => message.type === "ticket.set" && message.path === "tickets/bbbbbbbb.md"), false);

    const underAlpha = { ...cedar, parent: "aaaaaaaa", rev: 5 };
    transport.deliver({ type: "tickets", tickets: [alpha, bravo, underAlpha] });
    assert.deepEqual(childLinkIds(), ["cccccccc"]);
    openTicketFile(bravo, 9);
    assert.deepEqual(childLinkIds(), []);
    view.destroy();
  } finally {
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
  assert.equal(/button\.md-doc-link/.test(css), false);
  assert.match(css, /button\.md-doc-menu\s*\{/);
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
  const docLinks = () => walkNodes(mounted.aside, (node) => node.classList && node.classList.contains("md-doc-link"));
  try {
    const view = createEditor(mounted.root, "", 0, transport, storage);
    assert.equal(docLinks().length, 0);
    assert.equal(walkNodes(mounted.aside, (node) => node.classList && node.classList.contains("md-doc-commit")).length, 0);
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
    assert.equal(docLinks().length, 0);
    assert.equal(walkNodes(mounted.root.parentElement, (node) => node.tagName === "BUTTON" && node.textContent === "Commit repo").length, 0);
    assert.equal(walkNodes(mounted.aside, (node) => node.classList && node.classList.contains("md-attach")).length, 0);
    const fileInput = walkNodes(mounted.aside, (node) => node.classList && node.classList.contains("md-attach-input"));
    assert.equal(fileInput.length, 1);
    assert.equal(fileInput[0].hidden, true);
    assert.equal(fileInput[0].getAttribute("type"), "file");
    assert.equal(mounted.aside.childNodes[0], fileInput[0]);
    const docMenu = walkNodes(mounted.root, (node) => node.classList && node.classList.contains("md-doc-menu"));
    const docPanel = walkNodes(mounted.root, (node) => node.classList && node.classList.contains("md-doc-menu-panel"));
    assert.equal(docMenu.length, 1);
    assert.equal(docMenu[0].getAttribute("aria-label"), "Menu");
    assert.equal(docPanel.length, 1);
    assert.equal(docPanel[0].getAttribute("role"), "menu");
    assert.deepEqual(docPanel[0].childNodes.map((node) => node.textContent), ["Attach image", "Delete file"]);
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
    assert.equal(row.childNodes[0].classList.contains("md-comment-by"), true);
    assert.equal(row.childNodes[0].childNodes[0].classList.contains("md-comment-author"), true);
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
    assert.equal(docLinks().length, 0);
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
    assert.equal(docLinks().length, 0);
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
    assert.equal(docLinks().length, 0);
    assert.equal(walkNodes(mounted.root.parentElement, (node) => node.tagName === "BUTTON" && node.textContent === "Commit repo").length, 0);
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

test("T-file-delete", () => {
  const mounted = mountEditor();
  const css = readFileSync(new URL("../editor.css", import.meta.url), "utf8");
  const src = readFileSync(new URL("../src/editor.js", import.meta.url), "utf8");
  const glyph = "M18 6 6 18M6 6l12 12";
  assert.match(src, /delete:\s*\[\s*"M18 6 6 18M6 6l12 12"\s*\]/);
  const rowRule = css.match(/\.md-file-row\s*\{[^}]*\}/);
  assert.ok(rowRule);
  assert.match(rowRule[0], /display:\s*flex/);
  assert.match(rowRule[0], /align-items:\s*center/);
  assert.match(rowRule[0], /gap:\s*0\.25rem/);
  const nameRule = css.match(/\.md-file-row > button\.md-file\s*\{[^}]*\}/);
  assert.ok(nameRule);
  assert.match(nameRule[0], /flex:\s*1 1 auto/);
  const deleteRule = css.match(/\.file-tree button\.md-file-delete\s*\{[^}]*\}/);
  assert.ok(deleteRule);
  assert.match(deleteRule[0], /width:\s*1\.75rem/);
  const currentRule = css.match(/\.file-tree button\.md-file\.md-file-current\s*\{[^}]*\}/);
  assert.ok(currentRule);
  assert.match(currentRule[0], /background:\s*#3d5a80/);
  assert.match(currentRule[0], /border:\s*1px solid #c4b8a4/);
  const confirmRule = css.match(/dialog\.md-confirm\s*\{[^}]*\}/);
  assert.ok(confirmRule);
  assert.match(confirmRule[0], /background:\s*#242320/);
  assert.match(confirmRule[0], /color:\s*#e7e2d8/);
  assert.match(confirmRule[0], /border:\s*1px solid #3f3c37/);
  assert.match(confirmRule[0], /border-radius:\s*6px/);
  assert.match(confirmRule[0], /width:\s*18rem/);
  const actionsRule = css.match(/dialog\.md-confirm \.md-confirm-actions\s*\{[^}]*\}/);
  assert.ok(actionsRule);
  assert.match(actionsRule[0], /display:\s*flex/);
  assert.match(actionsRule[0], /gap:\s*0\.5rem/);
  const nav = document.createElement("nav");
  nav.className = "files";
  const sheet = document.createElement("div");
  sheet.append(nav, mounted.root);
  const transport = holdingTransport();
  const labeled = (text) => walkNodes(nav, (node) => node.tagName === "BUTTON" && node.textContent === text);
  const confirm = () => walkNodes(sheet, (node) => node.tagName === "DIALOG" && node.classList && node.classList.contains("md-confirm"))[0];
  try {
    const view = createEditor(mounted.root, "a\nb\n", 0, transport);
    transport.deliver({ type: "docs", files: ["b.md", "sub/a.md"] });
    transport.deliver({ type: "tickets", tickets: [ticketFixture("aaaaaaaa", "Alpha", "new", T0)] });
    const name = labeled("b.md")[0];
    assert.equal(name.getAttribute("aria-label"), null);
    assert.equal(name.classList.contains("icon-btn"), true);
    assert.equal(name.classList.contains("md-file"), true);
    const row = name.parentElement;
    assert.equal(row.classList.contains("md-file-row"), true);
    assert.equal([...row.childNodes].some((node) => node.classList && node.classList.contains("md-file-delete")), false);
    const head = name.closest(".file-block").childNodes.find((node) => node.classList && node.classList.contains("md-pane-head"));
    assert.equal(head.childNodes[1].classList.contains("md-new-file"), true);
    const trash = head.childNodes[2];
    assert.ok(trash);
    assert.equal(trash.classList.contains("md-file-delete"), true);
    assert.equal(trash.parentElement, head);
    assert.equal(trash.classList.contains("icon-btn"), true);
    assert.equal(trash.classList.contains("danger"), true);
    assert.equal(trash.getAttribute("aria-label"), "Delete file");
    assert.deepEqual(iconPaths(trash), [glyph]);
    const sub = labeled("sub")[0];
    assert.equal([...sub.parentElement.childNodes].some((node) => node.classList && node.classList.contains("md-file-delete")), false);

    const clickTrash = () => trash.listeners.click({ preventDefault() {} });
    const idle = transport.sent.length;
    clickTrash();
    assert.equal(transport.sent.length, idle);
    assert.equal(confirm(), undefined);
    const ticketButton = walkNodes(nav, (node) => node.tagName === "BUTTON" && node.dataset && node.dataset.path === "tickets/aaaaaaaa.md")[0];
    ticketButton.listeners.click({ preventDefault() {} });
    assert.equal(transport.sent.at(-1).type, "open");
    assert.equal(transport.sent.at(-1).path, "tickets/aaaaaaaa.md");
    const ticketSent = transport.sent.length;
    clickTrash();
    assert.equal(transport.sent.length, ticketSent);
    assert.equal(transport.sent.some((message) => message.type === "delete"), false);
    assert.equal(confirm(), undefined);
    name.listeners.click({ preventDefault() {} });
    const before = transport.sent.length;
    clickTrash();
    const dialog = confirm();
    assert.equal(walkNodes(sheet, (node) => node.classList && node.classList.contains("md-confirm")).length, 1);
    assert.equal(dialog.open, true);
    assert.equal(dialog.getAttribute("open"), "");
    const question = byClass(dialog, "md-confirm-text")[0];
    const actions = byClass(dialog, "md-confirm-actions")[0];
    assert.equal(question.textContent, "Delete b.md?");
    assert.equal(question.parentElement, dialog);
    assert.equal(actions.parentElement, dialog);
    assert.ok(dialog.childNodes.indexOf(question) < dialog.childNodes.indexOf(actions));
    assert.deepEqual(actions.childNodes.map((node) => node.textContent), ["Cancel", "Delete"]);
    const named = (text) => walkNodes(dialog, (node) => node.tagName === "BUTTON" && node.textContent === text)[0];
    assert.equal(named("Cancel").textContent, "Cancel");
    assert.equal(named("Delete").textContent, "Delete");
    named("Cancel").listeners.click({ preventDefault() {} });
    assert.equal(transport.sent.length, before);
    assert.equal(dialog.open, false);

    clickTrash();
    dialog.listeners.keydown({ key: "Escape", preventDefault() {} });
    assert.equal(transport.sent.length, before);
    assert.equal(dialog.open, false);

    clickTrash();
    dialog.listeners.cancel({ preventDefault() {} });
    assert.equal(transport.sent.length, before);
    assert.equal(dialog.open, false);

    let modals = 0;
    dialog.showModal = () => {
      modals += 1;
    };
    clickTrash();
    assert.equal(modals, 1);
    assert.equal(dialog.open, true);
    named("Cancel").listeners.click({ preventDefault() {} });
    assert.equal(transport.sent.length, before);

    const trace = [];
    dialog.close = () => {
      trace.push("close");
      dialog.open = false;
    };
    dialog.showModal = () => {
      trace.push(dialog.open ? "show-open" : "show-closed");
      if (dialog.open) throw new Error("already open");
      dialog.open = true;
    };
    clickTrash();
    assert.deepEqual(trace, ["show-open", "close", "show-closed"]);
    assert.equal(dialog.open, true);
    named("Cancel").listeners.click({ preventDefault() {} });
    assert.equal(transport.sent.length, before);
    dialog.listeners.keydown({ key: "Escape", preventDefault() {} });
    assert.equal(transport.sent.length, before);
    clickTrash();
    dialog.listeners.cancel({ preventDefault() {} });
    assert.equal(transport.sent.length, before);
    assert.equal(dialog.open, false);

    dialog.showModal = () => {
      dialog.open = true;
    };
    let openAtClose = null;
    dialog.close = () => {
      openAtClose = dialog.open;
      dialog.open = false;
    };
    let openAtSend = null;
    const send = transport.send.bind(transport);
    transport.send = (message) => {
      if (message.type === "delete") openAtSend = dialog.open;
      send(message);
    };
    clickTrash();
    named("Delete").listeners.click({ preventDefault() {} });
    assert.equal(openAtClose, true);
    assert.equal(openAtSend, false);
    assert.equal(dialog.open, false);
    assert.deepEqual(transport.sent[before], { type: "delete", path: "b.md", username: "" });
    assert.equal(transport.sent.length, before + 1);
    assert.equal(transport.sent.slice(before).some((message) => message.type === "open"), false);
    transport.deliver({ type: "file", rev: 0, text: "a\nb\n", path: "b.md", cursor: 0, anchor: 0, locks: [] });

    globalThis.NodeFilter = globalThis.NodeFilter || { SHOW_TEXT: 4 };
    const text = ["a", "b"].map((value) => walkNodes(mounted.root, (node) => node.nodeType === 3 && node.textContent === value)[0]);
    assert.equal(text[0].textContent, "a");
    assert.equal(text[1].textContent, "b");
    globalThis.window.getSelection = () => ({
      rangeCount: 1,
      anchorNode: text[0],
      anchorOffset: 0,
      focusNode: text[1],
      focusOffset: 1,
      getRangeAt() {
        return { collapsed: false, commonAncestorContainer: mounted.root };
      },
    });
    mounted.listeners.mousedown({ clientX: 0, clientY: 0 });
    mounted.listeners.mouseup({ clientX: 20, clientY: 20 });
    assert.equal(view.getState().anchor, 0);
    assert.equal(view.getState().cursor, 3);
    globalThis.window.getSelection = () => ({ rangeCount: 0 });
    insertText(mounted, "X");
    insertText(mounted, "Y");
    assert.equal(transport.sent.filter((message) => message.type === "edit" && message.text === "Y").length, 0);
    transport.deliver({ type: "error", status: 409 });
    assert.equal(view.getState().doc, "a\nb\n");
    assert.equal(view.getState().anchor, 0);
    assert.equal(view.getState().cursor, 3);
    assert.equal(transport.sent.filter((message) => message.type === "edit" && message.text === "Y").length, 0);
    transport.deliver(docMessage(1, "a\nb\n", 3, ""));
    assert.equal(transport.sent.filter((message) => message.type === "edit" && message.text === "Y").length, 1);

    labeled("sub")[0].listeners.click({ preventDefault() {} });
    labeled("a.md")[0].listeners.click({ preventDefault() {} });
    const current = walkNodes(nav, (node) => node.classList && node.classList.contains("md-file-current"));
    assert.equal(current.length, 1);
    assert.equal(current[0].tagName, "BUTTON");
    assert.equal(current[0].dataset.path, "sub/a.md");
    assert.equal(current[0].getAttribute("aria-label"), null);
    assert.equal(labeled("b.md")[0].classList.contains("md-file-current"), false);
    assert.equal([...labeled("sub")[0].parentElement.childNodes].some((node) => node.classList && node.classList.contains("md-file-delete")), false);
    const nested = transport.sent.length;
    clickTrash();
    assert.equal(transport.sent.length, nested);
    assert.equal(byClass(confirm(), "md-confirm-text")[0].textContent, "Delete a.md?");
    walkNodes(confirm(), (node) => node.tagName === "BUTTON" && node.textContent === "Cancel")[0].listeners.click({ preventDefault() {} });
    assert.equal(transport.sent.length, nested);
    assert.equal(confirm().open, false);
    transport.deliver({ type: "file", rev: 2, text: "hello\n", path: "sub/a.md", cursor: 0, anchor: 0, locks: [] });
    assert.equal(view.getState().doc, "hello\n");
    assert.equal(walkNodes(nav, (node) => node.classList && node.classList.contains("md-file-current")).length, 1);
    assert.equal(walkNodes(nav, (node) => node.classList && node.classList.contains("md-file-current"))[0].dataset.path, "sub/a.md");
    assert.ok(ticketNode(nav, "aaaaaaaa"));
    const kept = transport.sent.length;
    transport.deliver({ type: "deleted", path: "other.md" });
    assert.equal(view.getState().doc, "hello\n");
    assert.equal(transport.sent.length, kept);
    transport.deliver({ type: "deleted", path: "sub/a.md" });
    assert.equal(view.getState().doc, "");
    assert.equal(view.getState().cursor, 0);
    assert.equal(walkNodes(nav, (node) => node.classList && node.classList.contains("md-file-current")).length, 0);
    assert.equal(labeled("b.md").length, 1);
    assert.equal(labeled("a.md").length, 1);
    assert.ok(ticketNode(nav, "aaaaaaaa"));
    const quiet = transport.sent.length;
    mounted.listeners.beforeinput({ inputType: "insertText", data: "Z", preventDefault() {} });
    assert.equal(transport.sent.length, quiet);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("a ticket pane menu shows relation fields and Blocks writes the other ticket", () => {
  const mounted = mountTicketPage();
  const transport = holdingTransport();
  const writes = [];
  const previousHistory = globalThis.history;
  const previousLocation = globalThis.location;
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  globalThis.history = { replaceState() {} };
  globalThis.location = { origin: "https://viewmark.test", pathname: "/app", search: "", hash: "" };
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
  const css = readFileSync(new URL("../editor.css", import.meta.url), "utf8");
  assert.match(css, /button\.md-ticket-pane-menu\s*\{[^}]*position:\s*absolute;/);
  assert.match(css, /button\.md-ticket-pane-menu\s*\{[^}]*top:\s*8px;/);
  assert.match(css, /button\.md-ticket-pane-menu\s*\{[^}]*right:\s*8px;/);
  assert.match(css, /button\.icon-btn:not\(\.md-file\):not\(\.md-dir-toggle\)\s*\{[^}]*width:\s*1\.75rem/);
  assert.match(css, /button\.icon-btn:not\(\.md-file\):not\(\.md-dir-toggle\)\s*\{[^}]*height:\s*1\.75rem/);
  assert.match(css, /button\.md-doc-menu\s*\{/);
  assert.equal(/\.md-ticket-delete/.test(css), false);
  try {
    const view = createEditor(mounted.root, "hello\n", 0, transport, storage);
    const form = () => byClass(mounted.root.parentElement, "ticket-form")[0];
    const menuButton = () => byClass(form(), "md-ticket-pane-menu")[0];
    const panel = () => byClass(form(), "md-ticket-pane-panel")[0];
    const sets = () => transport.sent.filter((message) => message.type === "ticket.set");
    const relationBox = (name) => {
      const choice = byClass(panel(), "md-ticket-pane-choice").find((node) => node.textContent === name);
      return choice.childNodes.find((node) => node.tagName === "INPUT");
    };
    const setRelation = (name, checked) => {
      const box = relationBox(name);
      box.checked = checked;
      box.listeners.change();
    };
    const inEditor = (node) => {
      let current = node;
      while (current) {
        if (current === mounted.root) return true;
        current = current.parentElement;
      }
      return false;
    };
    assert.equal(byClass(mounted.root.parentElement, "md-ticket-pane-menu").length, 0);
    assert.equal(byClass(mounted.root, "md-doc-menu").length, 1);
    transport.deliver({
      type: "repos",
      repos: [{ name: "viewmark", description: "Viewmark" }],
    });
    transport.deliver({ type: "file", path: "docs/a.md", rev: 1, text: "plain\n", cursor: 0, anchor: 0, locks: [] });
    assert.equal(byClass(mounted.root.parentElement, "md-ticket-pane-menu").length, 0);
    assert.equal(byClass(mounted.root.parentElement, "md-ticket-pane-panel").length, 0);
    assert.equal(view.getState().doc, "plain\n");
    const alpha = ticketFixture("aaaaaaaa", "Alpha", "new", T0);
    const bravo = ticketFixture("bbbbbbbb", "Bravo", "new", T1);
    const openAlpha = (ticket = alpha) => {
      transport.deliver({ type: "tickets", tickets: [ticket, bravo] });
      transport.deliver({
        type: "file",
        path: "tickets/aaaaaaaa.md",
        rev: 1,
        text: "hello\n",
        cursor: 0,
        anchor: 0,
        locks: [],
        ticket,
      });
    };
    openAlpha();
    assert.equal(byClass(form(), "md-ticket-parent").length, 0);
    assert.equal(byClass(form(), "md-ticket-depends").length, 0);
    assert.equal(byClass(form(), "md-ticket-children").length, 0);
    assert.equal(byClass(form(), "md-ticket-blocks").length, 0);
    const left = byClass(form(), "md-ticket-column")[0];
    const labels = left.childNodes.map((node) => node.childNodes[0] && node.childNodes[0].textContent);
    const priorityAt = labels.indexOf("Priority");
    assert.equal(labels[priorityAt + 1], "Assignee");
    assert.equal(labels.includes("Parent"), false);
    assert.equal(byClass(form(), "md-ticket-assignee")[0].value, "");
    const button = menuButton();
    assert.equal(byClass(form(), "md-ticket-pane-menu").length, 1);
    assert.equal(button.classList.contains("icon-btn"), true);
    assert.equal(button.parentElement, form());
    assert.equal(inEditor(button), false);
    assert.equal(button.getAttribute("aria-label"), "Menu");
    assert.equal(button.getAttribute("aria-haspopup"), "menu");
    assert.equal(button.getAttribute("aria-expanded"), "false");
    const glyph = button.childNodes[0];
    assert.equal(glyph.localName, "svg");
    assert.equal(glyph.getAttribute("viewBox"), "0 0 24 24");
    assert.equal(glyph.getAttribute("aria-hidden"), "true");
    const path = glyph.childNodes.find((node) => node.localName === "path");
    assert.equal(path.getAttribute("d"), "M4 6h16M4 12h16M4 18h16");
    assert.equal(path.getAttribute("fill"), "none");
    assert.equal(path.getAttribute("stroke"), "currentColor");
    assert.equal(path.getAttribute("stroke-width"), "2");
    assert.equal(path.getAttribute("stroke-linecap"), "round");
    assert.equal(path.getAttribute("stroke-linejoin"), "round");
    assert.equal(panel().hidden, true);
    assert.equal(panel().getAttribute("role"), "menu");
    assert.deepEqual(panel().childNodes.map((node) => node.textContent), [
      "Copy link",
      "Delete ticket",
      "",
      "Show fields",
      "Parent",
      "Depends",
      "Children",
      "Blocks",
    ]);
    assert.equal(panel().childNodes[2].classList.contains("md-ticket-pane-sep"), true);
    assert.equal(panel().childNodes[2].getAttribute("role"), "separator");
    assert.equal(panel().childNodes[3].textContent, "Show fields");
    assert.equal(panel().childNodes[3].childNodes.some((node) => node.tagName === "INPUT"), false);
    assert.deepEqual(
      panel().childNodes.filter((node) => node.childNodes.some((child) => child.tagName === "INPUT")).map((node) => node.textContent),
      ["Parent", "Depends", "Children", "Blocks"],
    );
    assert.equal(panel().childNodes.filter((node) => node.tagName === "BUTTON" && node.textContent === "Delete ticket").length, 1);
    for (const name of ["Parent", "Depends", "Children", "Blocks"]) {
      const box = relationBox(name);
      assert.equal(box.checked, false);
      assert.equal(box.getAttribute("data-relation"), name.toLowerCase());
    }
    button.listeners.click({ preventDefault() {} });
    assert.equal(panel().hidden, false);
    assert.equal(menuButton().getAttribute("aria-expanded"), "true");
    mounted.listeners.pointerdown({ target: panel() });
    assert.equal(panel().hidden, false);
    mounted.listeners.pointerdown({ target: menuButton() });
    assert.equal(panel().hidden, false);
    mounted.listeners.pointerdown({ target: mounted.root });
    assert.equal(panel().hidden, true);
    assert.equal(menuButton().getAttribute("aria-expanded"), "false");
    menuButton().listeners.click({ preventDefault() {} });
    let prevented = false;
    mounted.listeners.keydown({
      key: "Escape",
      preventDefault() {
        prevented = true;
      },
    });
    assert.equal(prevented, false);
    assert.equal(panel().hidden, true);
    assert.equal(menuButton().getAttribute("aria-expanded"), "false");
    menuButton().listeners.click({ preventDefault() {} });
    assert.equal(panel().hidden, false);
    menuButton().listeners.keydown({ key: "Escape", preventDefault() {} });
    assert.equal(panel().hidden, true);
    assert.equal(menuButton().getAttribute("aria-expanded"), "false");
    menuButton().listeners.click({ preventDefault() {} });
    panel().listeners.keydown({ key: "Escape", preventDefault() {} });
    assert.equal(panel().hidden, true);
    assert.equal(menuButton().getAttribute("aria-expanded"), "false");
    menuButton().listeners.click({ preventDefault() {} });
    panel().childNodes[0].listeners.click({ preventDefault() {} });
    assert.deepEqual(writes, ["https://viewmark.test/app#viewmark/ticket/aaaaaaaa"]);
    assert.equal(writes[0].includes("\n"), false);
    assert.equal(panel().hidden, true);
    setRelation("Parent", true);
    assert.equal(byClass(form(), "md-ticket-parent").length, 1);
    assert.equal(relationBox("Parent").checked, true);
    assert.equal(panel().hidden, false);
    transport.deliver({ type: "tickets", tickets: [alpha, bravo] });
    assert.equal(byClass(form(), "md-ticket-parent").length, 1);
    assert.equal(relationBox("Parent").checked, true);
    setRelation("Parent", false);
    assert.equal(byClass(form(), "md-ticket-parent").length, 0);
    transport.deliver({ type: "file", path: "notes.md", rev: 1, text: "notes\n", cursor: 0, anchor: 0, locks: [] });
    assert.equal(form().hidden, true);
    assert.equal(byClass(form(), "md-ticket-pane-menu").length, 0);
    openAlpha();
    assert.equal(byClass(form(), "md-ticket-parent").length, 0);
    assert.equal(relationBox("Parent").checked, false);
    const beforeBlocks = sets().length;
    setRelation("Blocks", true);
    assert.equal(byClass(form(), "md-ticket-blocks").length, 1);
    const blocks = () => byClass(form(), "md-ticket-blocks")[0];
    const match = byClass(blocks(), "md-ticket-match")[0];
    match.value = "aaaaaaaa";
    match.listeners.input();
    assert.equal(byClass(blocks(), "md-ticket-menu")[0].hidden, true);
    byClass(blocks(), "md-ticket-add")[0].listeners.click({ preventDefault() {} });
    assert.equal(sets().length, beforeBlocks);
    match.value = "Br";
    match.listeners.input();
    assert.equal(match.value, "Bravo");
    byClass(blocks(), "md-ticket-add")[0].listeners.click({ preventDefault() {} });
    assert.deepEqual(sets().at(-1), {
      type: "ticket.set",
      path: "tickets/bbbbbbbb.md",
      rev: 0,
      depends: ["aaaaaaaa"],
      username: "",
    });
    assert.equal(sets().slice(beforeBlocks).every((message) => message.path === "tickets/bbbbbbbb.md"), true);
    const linked = { ...bravo, depends: ["aaaaaaaa"], rev: 1 };
    transport.deliver({ type: "tickets", tickets: [alpha, linked] });
    const row = byClass(blocks(), "md-ticket-link")[0];
    assert.equal(row.textContent, "Bravo");
    row.listeners.click({ preventDefault() {} });
    byClass(blocks(), "md-ticket-remove")[0].listeners.click({ preventDefault() {} });
    assert.deepEqual(sets().at(-1), {
      type: "ticket.set",
      path: "tickets/bbbbbbbb.md",
      rev: 1,
      depends: [],
      username: "",
    });
    const cedar = ticketFixture("cccccccc", "Cedar", "new", T2, "aaaaaaaa");
    transport.deliver({ type: "tickets", tickets: [alpha, bravo, cedar] });
    assert.equal(byClass(form(), "md-ticket-children").length, 1);
    assert.equal(relationBox("Children").checked, true);
    assert.equal(byClass(byClass(form(), "md-ticket-children")[0], "md-ticket-link")[0].textContent, "Cedar");
    assert.equal(relationBox("Blocks").checked, true);
    const assignee = () => byClass(form(), "md-ticket-assignee")[0];
    const assigneeSets = () => sets().filter((message) => Object.hasOwn(message, "assignee"));
    assignee().value = "ada\nbea";
    assignee().listeners.blur();
    assert.equal(assigneeSets().length, 0);
    assert.equal(assignee().value, "");
    assignee().value = "nope";
    assignee().listeners.keydown({ key: "Escape", preventDefault() {} });
    assignee().listeners.blur();
    assert.equal(assignee().value, "");
    assert.equal(assigneeSets().length, 0);
    assignee().value = "  ada  ";
    assignee().listeners.keydown({ key: "Enter", preventDefault() {} });
    assert.deepEqual(assigneeSets().at(-1), {
      type: "ticket.set",
      path: "tickets/aaaaaaaa.md",
      rev: 1,
      assignee: "ada",
      username: "",
    });
    transport.deliver({
      type: "ticket",
      path: "tickets/aaaaaaaa.md",
      rev: 2,
      title: "Alpha",
      state: "new",
      ticketType: "task",
      priority: "medium",
      assignee: "ada",
      parent: "",
      depends: [],
      reporter: "Ada",
      created: T0,
    });
    assert.equal(assignee().value, "ada");
    assert.equal(labels.indexOf("Assignee") > labels.indexOf("Priority"), true);
    const refreshed = byClass(form(), "md-ticket-column")[0].childNodes.map((node) => node.childNodes[0] && node.childNodes[0].textContent);
    assert.equal(refreshed[refreshed.indexOf("Priority") + 1], "Assignee");
    assignee().value = "nope";
    assignee().listeners.keydown({ key: "Escape", preventDefault() {} });
    assignee().listeners.blur();
    assert.equal(assignee().value, "ada");
    assert.equal(assigneeSets().length, 1);
    assignee().value = "bea\t";
    assignee().listeners.blur();
    assert.equal(assignee().value, "ada");
    assert.equal(assigneeSets().length, 1);
    assignee().value = "  ";
    assignee().listeners.blur();
    assert.deepEqual(assigneeSets().at(-1).assignee, "");
    const filterLabels = byClass(mounted.nav, "md-ticket-filter-menu")[0].childNodes.filter((node) => node.tagName === "LABEL").map((node) => node.textContent);
    assert.deepEqual(filterLabels, ["closed", "low", "medium", "high", "task", "enhancement", "defect"]);
    assert.equal(filterLabels.includes("assignee"), false);
    assert.equal(filterLabels.includes("Assignee"), false);
    view.destroy();
  } finally {
    if (previousHistory === undefined) delete globalThis.history;
    else globalThis.history = previousHistory;
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
    if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
    else delete globalThis.navigator;
    mounted.restore();
  }
});

test("T-ticket-delete", () => {
  const mounted = mountTicketPage();
  const transport = holdingTransport();
  const writes = [];
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
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
  try {
    const view = createEditor(mounted.root, "hello\n", 0, transport);
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
    assert.equal(byClass(form, "md-ticket-delete").length, 0);
    const idNode = byClass(form, "md-ticket-fact-id")[0];
    assert.equal(idNode.childNodes[0].nodeType, 3);
    assert.equal(idNode.childNodes[0].textContent, "aaaaaaaa");
    const copy = idNode.childNodes[1];
    assert.equal(copy.classList.contains("md-ticket-copy-id"), true);
    assert.equal(copy.classList.contains("icon-btn"), true);
    assert.equal(copy.classList.contains("danger"), false);
    assert.equal(copy.getAttribute("aria-label"), "Copy ticket id");
    assert.equal(copy.parentElement, idNode);
    const svg = copy.childNodes[0];
    assert.equal(svg.localName, "svg");
    assert.equal(svg.getAttribute("viewBox"), "0 0 24 24");
    assert.equal(svg.getAttribute("aria-hidden"), "true");
    const rects = svg.childNodes.filter((node) => node.localName === "rect");
    assert.equal(rects.length, 2);
    for (const rect of rects) {
      assert.equal(rect.getAttribute("fill"), "none");
      assert.equal(rect.getAttribute("stroke"), "currentColor");
      assert.equal(rect.getAttribute("stroke-width"), "2");
      assert.equal(rect.getAttribute("stroke-linecap"), "round");
      assert.equal(rect.getAttribute("stroke-linejoin"), "round");
      assert.equal(rect.getAttribute("width"), "12");
      assert.equal(rect.getAttribute("height"), "12");
      assert.equal(rect.getAttribute("rx"), "2");
      assert.equal(rect.getAttribute("ry"), "2");
    }
    assert.equal(rects[0].getAttribute("x"), "4");
    assert.equal(rects[0].getAttribute("y"), "4");
    assert.equal(rects[1].getAttribute("x"), "8");
    assert.equal(rects[1].getAttribute("y"), "8");
    copy.listeners.click({ preventDefault() {} });
    assert.deepEqual(writes, ["aaaaaaaa"]);
    assert.equal(idNode.textContent, "aaaaaaaa");
    const menuButton = byClass(form, "md-ticket-pane-menu")[0];
    const deleteItem = () => byClass(form, "md-ticket-pane-panel")[0].childNodes.find((node) => node.tagName === "BUTTON" && node.textContent === "Delete ticket");
    assert.equal(byClass(form, "md-ticket-pane-panel")[0].childNodes.filter((node) => node.tagName === "BUTTON" && node.textContent === "Delete ticket").length, 1);
    const before = transport.sent.length;
    menuButton.listeners.click({ preventDefault() {} });
    deleteItem().listeners.click({ preventDefault() {} });
    assert.equal(transport.sent.length, before);
    const dialog = walkNodes(mounted.body, (node) => node.tagName === "DIALOG" && node.classList && node.classList.contains("md-confirm"))[0];
    assert.equal(dialog.open, true);
    assert.equal(byClass(dialog, "md-confirm-text")[0].textContent, "Delete aaaaaaaa?");
    const cancel = walkNodes(dialog, (node) => node.tagName === "BUTTON" && node.textContent === "Cancel")[0];
    cancel.listeners.click({ preventDefault() {} });
    assert.equal(transport.sent.length, before);
    assert.equal(dialog.open, false);
    assert.equal(idNode.textContent, "aaaaaaaa");
    menuButton.listeners.click({ preventDefault() {} });
    deleteItem().listeners.click({ preventDefault() {} });
    const yes = walkNodes(dialog, (node) => node.tagName === "BUTTON" && node.textContent === "Delete")[0];
    let openAtClose = null;
    dialog.close = () => {
      openAtClose = dialog.open;
      dialog.open = false;
    };
    let openAtSend = null;
    const send = transport.send.bind(transport);
    transport.send = (message) => {
      if (message.type === "ticket.delete") openAtSend = dialog.open;
      send(message);
    };
    yes.listeners.click({ preventDefault() {} });
    assert.equal(openAtClose, true);
    assert.equal(openAtSend, false);
    assert.equal(dialog.open, false);
    assert.deepEqual(transport.sent[before], { type: "ticket.delete", id: "aaaaaaaa", username: "" });
    assert.equal(view.getState().doc, "hello\n");
    transport.deliver({ type: "error", status: 409 });
    assert.equal(view.getState().doc, "hello\n");
    assert.equal(view.getState().cursor, 0);
    assert.equal(byClass(form, "md-ticket-fact-id")[0].textContent, "aaaaaaaa");
    assert.ok(ticketNode(mounted.nav, "aaaaaaaa"));
    transport.deliver({ type: "deleted", path: "tickets/aaaaaaaa.md" });
    assert.equal(view.getState().doc, "");
    assert.equal(view.getState().cursor, 0);
    assert.ok(ticketNode(mounted.nav, "aaaaaaaa"));
    assert.equal(byClass(mounted.nav, "md-ticket").length > 0, true);
    view.destroy();
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
    else delete globalThis.navigator;
    mounted.restore();
  }
});

test("a dropped socket retries until close", () => {
  assert.equal(retryDelay(0, 0), 250);
  assert.equal(retryDelay(0, 1), 500);
  assert.equal(retryDelay(1, 0), 500);
  assert.equal(retryDelay(6, 1), 30000);
  assert.equal(retryDelay(7, 1), 30000);

  function install(random) {
    const sockets = [];
    const timers = [];
    function factory(url) {
      const handlers = {};
      const socket = {
        url,
        sent: [],
        closed: false,
        addEventListener(type, fn) {
          handlers[type] = fn;
        },
        removeEventListener(type, fn) {
          if (handlers[type] === fn) delete handlers[type];
        },
        send(data) {
          this.sent.push(JSON.parse(data));
        },
        close() {
          this.closed = true;
        },
        emit(type, event) {
          const fn = handlers[type];
          if (fn) fn(event);
        },
      };
      sockets.push(socket);
      return socket;
    }
    const transport = createSocketTransport({
      username: "Ada",
      socketFactory: factory,
      location: { protocol: "http:", host: "viewmark.test" },
      random,
      schedule(fn, ms) {
        const timer = { fn, ms };
        timers.push(timer);
        return timer;
      },
    });
    return { sockets, timers, transport };
  }

  const seen = [];
  const dropped = install(() => 0);
  dropped.transport.subscribe((message) => seen.push(message));
  assert.equal(dropped.sockets.length, 1);
  dropped.sockets[0].emit("error");
  assert.equal(dropped.timers.length, 0);
  dropped.sockets[0].emit("open");
  assert.deepEqual(dropped.sockets[0].sent, [
    { type: "hello", username: "Ada" },
    { type: "repos", username: "Ada" },
  ]);
  assert.deepEqual(seen, []);
  dropped.sockets[0].emit("close");
  assert.equal(dropped.timers.length, 1);
  assert.equal(dropped.timers[0].ms, 250);
  dropped.transport.send({ type: "list" });
  dropped.timers[0].fn();
  assert.equal(dropped.sockets.length, 2);
  dropped.transport.send({ type: "tickets" });
  dropped.sockets[1].emit("open");
  assert.deepEqual(dropped.sockets[1].sent, [
    { type: "hello", username: "Ada" },
    { type: "repos", username: "Ada" },
  ]);
  assert.deepEqual(seen, [{ type: "reconnect" }]);
  const scheduled = dropped.timers.length;
  dropped.transport.close();
  assert.equal(dropped.sockets[1].closed, true);
  dropped.sockets[1].emit("close");
  assert.equal(dropped.timers.length, scheduled);
  dropped.timers[0].fn();
  assert.equal(dropped.sockets.length, 2);

  const early = install(() => 0);
  const earlySeen = [];
  early.transport.subscribe((message) => earlySeen.push(message));
  early.sockets[0].emit("close");
  assert.equal(early.timers[0].ms, 250);
  early.timers[0].fn();
  early.sockets[1].emit("close");
  assert.equal(early.timers[1].ms, 500);
  early.timers[1].fn();
  early.sockets[2].emit("open");
  assert.deepEqual(early.sockets[2].sent.map((message) => message.type), ["hello", "repos"]);
  assert.deepEqual(earlySeen, []);
  early.sockets[2].emit("close");
  assert.equal(early.timers[2].ms, 250);
  early.transport.close();
  early.timers[2].fn();
  assert.equal(early.sockets.length, 3);
});

test("createSocketTransport sends session on every hello when the option is set", () => {
  const sockets = [];
  const timers = [];
  function factory(url) {
    const handlers = {};
    const socket = {
      url,
      sent: [],
      closed: false,
      addEventListener(type, fn) {
        handlers[type] = fn;
      },
      removeEventListener(type, fn) {
        if (handlers[type] === fn) delete handlers[type];
      },
      send(data) {
        this.sent.push(JSON.parse(data));
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
  const transport = createSocketTransport({
    username: "Ada",
    session: "tok_1",
    socketFactory: factory,
    location: { protocol: "http:", host: "viewmark.test" },
    random: () => 0,
    schedule(fn, ms) {
      const timer = { fn, ms };
      timers.push(timer);
      return timer;
    },
  });
  sockets[0].emit("open");
  assert.deepEqual(sockets[0].sent, [
    { type: "hello", username: "Ada", session: "tok_1" },
    { type: "repos", username: "Ada" },
  ]);
  sockets[0].emit("close");
  timers[0].fn();
  sockets[1].emit("open");
  assert.deepEqual(sockets[1].sent, [
    { type: "hello", username: "Ada", session: "tok_1" },
    { type: "repos", username: "Ada" },
  ]);
  transport.close();
});

test("startPage keeps one viewmark.session and mints 32 letters without randomUUID", () => {
  const mounted = mountEditor();
  document.getElementById = (id) => (id === "editor" ? mounted.root : null);
  document.body = document.createElement("body");
  const storage = {
    data: { "viewmark.username": "Ada", "viewmark.session": "not a token" },
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
  const cryptoObj = globalThis.crypto;
  const previousUUID = cryptoObj.randomUUID;
  cryptoObj.randomUUID = undefined;
  try {
    const page = startPage({
      document: globalThis.document,
      sessionStorage: storage,
      socketFactory: factory,
      location: { protocol: "http:", host: "viewmark.test" },
    });
    const token = storage.data["viewmark.session"];
    assert.match(token, /^[A-Za-z0-9]{32}$/);
    sockets[0].emit("open");
    assert.deepEqual(JSON.parse(sockets[0].sent[0]), { type: "hello", username: "Ada", session: token });
    page.close();
    const again = startPage({
      document: globalThis.document,
      sessionStorage: storage,
      socketFactory: factory,
      location: { protocol: "http:", host: "viewmark.test" },
    });
    sockets[1].emit("open");
    assert.equal(storage.data["viewmark.session"], token);
    assert.deepEqual(JSON.parse(sockets[1].sent[0]), { type: "hello", username: "Ada", session: token });
    again.close();
  } finally {
    if (previousUUID === undefined) delete cryptoObj.randomUUID;
    else cryptoObj.randomUUID = previousUUID;
    mounted.restore();
  }
});

test("a same-text file keeps the caret a same-span click did not lock", () => {
  const mounted = mountEditor();
  document.getElementById = (id) => (id === "editor" ? mounted.root : null);
  document.body = document.createElement("body");
  const storage = {
    data: { "viewmark.username": "Ada" },
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
  const page = startPage({
    document: globalThis.document,
    sessionStorage: storage,
    socketFactory: factory,
    location: { protocol: "http:", host: "viewmark.test" },
  });
  try {
    const doc = "alpha\n";
    const at = 2;
    sockets[0].emit("open");
    sockets[0].emit("message", { data: JSON.stringify({ type: "file", rev: 1, text: doc, path: "a.md", cursor: 0, anchor: 0 }) });
    sockets[0].sent.length = 0;
    const node = mounted.findAll((item) => item.nodeType === 3 && item.textContent === "alpha")[0];
    assert.ok(node);
    document.caretPositionFromPoint = () => ({ offsetNode: node, offset: at });
    mounted.listeners.click({ clientX: 4, clientY: 4, detail: 1, target: node });
    assert.equal(sockets[0].sent.some((frame) => JSON.parse(frame).type === "lock"), false);
    sockets[0].emit("message", { data: JSON.stringify({ type: "file", rev: 1, text: doc, path: "a.md", cursor: 0, anchor: 0 }) });
    const locks = sockets[0].sent.map((frame) => JSON.parse(frame)).filter((message) => message.type === "lock");
    assert.equal(locks.at(-1).cursor, at);
    assert.equal(locks.at(-1).anchor, at);
    mounted.listeners.beforeinput({ inputType: "insertText", data: "x", preventDefault() {} });
    const edit = JSON.parse(sockets[0].sent.at(-1));
    assert.equal(edit.type, "edit");
    assert.equal(edit.cursor, at);
    assert.equal(edit.anchor, at);
    const changed = "Alpha\n";
    sockets[0].emit("message", { data: JSON.stringify({ type: "file", rev: 2, text: changed, path: "a.md", cursor: 4, anchor: 4 }) });
    const moved = sockets[0].sent.map((frame) => JSON.parse(frame)).filter((message) => message.type === "lock");
    assert.equal(moved.at(-1).cursor, 4);
    assert.equal(moved.at(-1).anchor, 4);
    sockets[0].emit("message", { data: JSON.stringify({ type: "file", rev: 2, text: changed, path: "b.md", cursor: 1, anchor: 1 }) });
    const other = sockets[0].sent.map((frame) => JSON.parse(frame)).filter((message) => message.type === "lock");
    assert.equal(other.at(-1).cursor, 1);
    assert.equal(other.at(-1).anchor, 1);
  } finally {
    delete document.caretPositionFromPoint;
    page.close();
    mounted.restore();
  }
});

test("a renamed file keeps the caret offset", () => {
  const mounted = mountEditor();
  const transport = holdingTransport();
  const text = "# Em\n\nmove me\n";
  try {
    const view = createEditor(mounted.root, "", 0, transport);
    transport.deliver({ type: "file", path: "m.md", rev: 1, text, cursor: 8, anchor: 8, locks: [] });
    assert.equal(view.getState().cursor, 8);
    assert.equal(view.getState().anchor, 8);
    transport.sent.length = 0;
    transport.deliver({ type: "file", path: "keep/m.md", rev: 1, text, locks: [] });
    assert.equal(view.getState().doc, text);
    assert.equal(view.getState().cursor, 8);
    assert.equal(view.getState().anchor, 8);
    const lock = transport.sent.filter((message) => message.type === "lock").at(-1);
    assert.equal(lock.path, "keep/m.md");
    assert.equal(lock.cursor, 8);
    assert.equal(lock.anchor, 8);
    transport.deliver({ type: "file", path: "keep/m.md", rev: 1, text, cursor: 6, anchor: 10, locks: [] });
    transport.deliver({ type: "file", path: "else/m.md", rev: 1, text, locks: [] });
    assert.equal(view.getState().cursor, 6);
    assert.equal(view.getState().anchor, 10);
    transport.deliver({ type: "file", path: "other/m.md", rev: 1, text, cursor: 1, anchor: 1, locks: [] });
    assert.equal(view.getState().cursor, 1);
    assert.equal(view.getState().anchor, 1);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("a rename's doc is not the next edit and the reopen keeps the caret", () => {
  const mounted = mountEditor();
  const transport = holdingTransport();
  const text = "# Em\n\nmove me\n";
  try {
    const view = createEditor(mounted.root, "", 0, transport);
    transport.deliver({ type: "file", path: "m.md", rev: 1, text, cursor: 8, anchor: 3, locks: [] });
    transport.deliver({ type: "file", path: "keep/m.md", rev: 1, text, locks: [] });
    assert.equal(view.getState().cursor, 8);
    assert.equal(view.getState().anchor, 3);
    transport.sent.length = 0;
    transport.deliver({ type: "doc", path: "keep/m.md", rev: 1, text });
    assert.equal(view.getState().doc, text);
    assert.equal(view.getState().cursor, 8);
    assert.equal(transport.sent.some((message) => message.type === "open" && message.path === "keep/m.md"), true);
    transport.deliver({ type: "file", path: "keep/m.md", rev: 1, text, cursor: 0, anchor: 0, locks: [] });
    assert.equal(view.getState().doc, text);
    assert.equal(view.getState().cursor, 8);
    assert.equal(view.getState().anchor, 3);
    transport.deliver({ type: "file", path: "keep/m.md", rev: 2, text: "x# Em\n\nmove me\n", cursor: 1, anchor: 1, locks: [] });
    assert.equal(view.getState().cursor, 1);
    view.destroy();

    const plain = holdingTransport();
    const again = createEditor(mounted.root, "ab", 1, plain);
    plain.deliver({ type: "doc", rev: 4, text: "ab", actor: "other" });
    assert.equal(plain.sent.some((message) => message.type === "open"), true);
    plain.deliver({ type: "file", rev: 4, text: "ab", cursor: 0, anchor: 0, path: "a.md" });
    assert.equal(again.getState().cursor, 0);
    assert.equal(again.getState().anchor, 0);
    again.destroy();
  } finally {
    mounted.restore();
  }
});

test("reconnect keeps the open document and sends no edit", () => {
  const mounted = mountEditor();
  const nav = document.createElement("nav");
  nav.className = "files";
  const sheet = document.createElement("div");
  sheet.append(nav, mounted.root);
  const transport = holdingTransport();
  try {
    const view = createEditor(mounted.root, "", 0, transport);
    const select = nav.childNodes[0].childNodes[1];
    transport.deliver({ type: "repos", repos: [{ name: "docs", description: "Docs" }] });
    select.value = "docs";
    select.listeners.change();
    transport.sent.length = 0;
    transport.deliver({ type: "file", rev: 4, text: "ab", cursor: 1, anchor: 1, path: "b.md" });
    assert.equal(mounted.root.textContent, "ab");
    assert.equal(view.getState().doc, "ab");
    transport.sent.length = 0;
    transport.deliver({ type: "reconnect" });
    assert.deepEqual(transport.sent.map((message) => message.type), ["repo", "list", "tickets", "open"]);
    assert.equal(transport.sent[0].name, "docs");
    assert.equal(transport.sent[3].path, "b.md");
    assert.equal(mounted.root.textContent, "ab");
    assert.equal(view.getState().doc, "ab");
    const before = transport.sent.length;
    mounted.listeners.beforeinput({
      inputType: "insertText",
      data: "Q",
      preventDefault() {},
    });
    assert.equal(transport.sent.length, before);
    assert.equal(transport.sent.some((message) => message.type === "edit"), false);
    assert.equal(mounted.root.textContent, "ab");
    assert.equal(view.getState().doc, "ab");
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("a different hello build reloads the page", () => {
  const mounted = mountEditor();
  const previousLocation = globalThis.location;
  let content = "aaa";
  globalThis.document.querySelector = (selector) => {
    if (selector !== 'meta[name="viewmark-build"]') return null;
    if (content == null) return null;
    return {
      getAttribute(name) {
        if (name === "content") return content;
        if (name === "name") return "viewmark-build";
        return null;
      },
    };
  };
  const reloads = [];
  globalThis.location = {
    reload() {
      reloads.push("reload");
    },
  };
  const transport = holdingTransport();
  let closes = 0;
  transport.close = () => {
    closes += 1;
  };
  try {
    const view = createEditor(mounted.root, "ab", 0, transport);
    content = "bbb";
    transport.deliver({ type: "hello", build: "aaa" });
    transport.deliver({ type: "hello", build: "" });
    transport.deliver({ type: "hello", build: "aaa" });
    assert.equal(reloads.length, 0);
    assert.equal(closes, 0);
    assert.equal(view.getState().doc, "ab");
    transport.deliver({ type: "hello", build: "bbb" });
    assert.deepEqual(reloads, ["reload"]);
    assert.equal(closes, 1);
    view.destroy();

    content = null;
    const again = holdingTransport();
    let againCloses = 0;
    again.close = () => {
      againCloses += 1;
    };
    const second = createEditor(mounted.root, "ab", 0, again);
    again.deliver({ type: "hello", build: "ccc" });
    again.deliver({ type: "hello", build: "ccc" });
    again.deliver({ type: "hello", build: "" });
    assert.equal(reloads.length, 1);
    assert.equal(againCloses, 0);
    again.deliver({ type: "hello", build: "ddd" });
    assert.deepEqual(reloads, ["reload", "reload"]);
    assert.equal(againCloses, 1);
    assert.equal(second.getState().doc, "ab");
    second.destroy();
  } finally {
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
    mounted.restore();
  }
});

function spanText(doc, span) {
  return doc.slice(span.start, span.end);
}

test("lock spans cut paragraphs, quotes, lists, fences, and tables", () => {
  const para = "ab\ncd\n\nef";
  assert.deepEqual(lockSpans(para), [
    { start: 0, end: 5 },
    { start: 6, end: 6 },
    { start: 7, end: 9 },
  ]);
  assert.equal(lockIndexAt(para, 0), 0);
  assert.equal(lockIndexAt(para, 5), 0);
  assert.equal(lockIndexAt(para, 6), 1);
  assert.equal(lockIndexAt(para, 9), 2);

  const broken = "ab\n# T\n---\nef";
  assert.deepEqual(lockSpans(broken).map((span) => spanText(broken, span)), ["ab", "# T", "---", "ef"]);

  const blanks = "a\n\n\nb";
  assert.deepEqual(lockSpans(blanks).map((span) => spanText(blanks, span)), ["a", "", "", "b"]);

  const paired = "Alpha\nBeta\n";
  assert.deepEqual(lockSpans(paired), [{ start: 0, end: 10 }]);
  assert.equal(lockIndexAt(paired, paired.length), 0);
  assert.deepEqual(lockSpans("\n"), [{ start: 0, end: 0 }]);
  assert.equal(lockIndexAt("\n", 1), 0);
  assert.deepEqual(lockSpans("\n\n"), [
    { start: 0, end: 0 },
    { start: 1, end: 1 },
  ]);
  assert.deepEqual(lockSpans(""), [{ start: 0, end: 0 }]);
  assert.equal(lockIndexAt("", 0), 0);

  const quote = "> hi\nthere\n";
  assert.deepEqual(lockSpans(quote), [{ start: 0, end: 10 }]);
  assert.equal(lockIndexAt(quote, 10), 0);
  assert.equal(lockIndexAt(quote, quote.length), 0);

  const quotes = "> a\nb\n> c";
  assert.deepEqual(lockSpans(quotes).map((span) => spanText(quotes, span)), ["> a\nb", "> c"]);

  const headed = "> a\nb\n# C";
  assert.deepEqual(lockSpans(headed).map((span) => spanText(headed, span)), ["> a\nb", "# C"]);

  const fencedQuote = "> a\n```js\ncode\n```";
  const fencedSpans = lockSpans(fencedQuote);
  assert.equal(spanText(fencedQuote, fencedSpans[0]), "> a");
  assert.equal(spanText(fencedQuote, fencedSpans[1]), "```js\ncode\n```");

  const tableQuote = "> a\n| a |\n| --- |\n| 1 |";
  const tableSpans = lockSpans(tableQuote);
  assert.equal(spanText(tableQuote, tableSpans[0]), "> a");
  assert.equal(spanText(tableQuote, tableSpans[1]), "| a |\n| --- |");
  assert.equal(spanText(tableQuote, tableSpans[2]), "| 1 |");

  const child = "> - a\n  - b\n";
  assert.deepEqual(lockSpans(child), [
    { start: 0, end: 5 },
    { start: 6, end: 11 },
  ]);
  const orderedChild = "> 1. a\n   1. b";
  assert.deepEqual(lockSpans(orderedChild).map((span) => spanText(orderedChild, span)), ["> 1. a", "   1. b"]);

  const nested = "- a\nmore\n  - b\n- c";
  assert.deepEqual(lockSpans(nested).map((span) => spanText(nested, span)), ["- a\nmore", "  - b", "- c"]);
  const paren = "1) a\n   1) b\n2) c";
  assert.deepEqual(lockSpans(paren).map((span) => spanText(paren, span)), ["1) a", "   1) b", "2) c"]);

  const listBreaks = "- a\n# H\n- b\n---\n- c";
  assert.deepEqual(lockSpans(listBreaks).map((span) => spanText(listBreaks, span)), ["- a", "# H", "- b", "---", "- c"]);

  const listFence = "- a\n```\nx\n```\n- b";
  const listFenceSpans = lockSpans(listFence);
  assert.equal(spanText(listFence, listFenceSpans[0]), "- a");
  assert.equal(spanText(listFence, listFenceSpans[1]), "```\nx\n```");
  assert.equal(spanText(listFence, listFenceSpans[2]), "- b");

  const listTable = "- a\n| a |\n| --- |\n| b |";
  assert.deepEqual(lockSpans(listTable).map((span) => spanText(listTable, span)), ["- a", "| a |\n| --- |", "| b |"]);

  const image = "ab ![x](y) cd";
  assert.deepEqual(lockSpans(image), [{ start: 0, end: image.length }]);
  const splitImage = "ab\n![x](y)\ncd";
  assert.deepEqual(lockSpans(splitImage).map((span) => spanText(splitImage, span)), ["ab", "![x](y)", "cd"]);

  const comment = ["```comment c1 resolved", ":: 0", "", "alpha", ":: 01", ":: 1", "beta", "```"].join("\n");
  assert.deepEqual(lockSpans(comment).map((span) => spanText(comment, span)), [
    "```comment c1 resolved",
    ":: 0\n\nalpha\n:: 01",
    ":: 1\nbeta",
    "```",
  ]);
  assert.equal(lockIndexAt(comment, comment.indexOf(":: 0")), 1);
  assert.equal(lockIndexAt(comment, comment.indexOf(":: 1")), 2);

  const emptyThread = "```comment c1\n\n```";
  assert.deepEqual(lockSpans(emptyThread).map((span) => spanText(emptyThread, span)), ["```comment c1", "", "```"]);

  const mermaid = "```mermaid\ngraph TD\nA-->B\n```";
  assert.equal(lockSpans(mermaid).length, 1);
  assert.equal(spanText(mermaid, lockSpans(mermaid)[0]), mermaid);
  assert.equal(lockIndexAt(mermaid, mermaid.length), 0);

  const openFence = "```js\ncode";
  assert.equal(lockSpans(openFence).length, 1);
  assert.equal(spanText(openFence, lockSpans(openFence)[0]), openFence);
});

test("lock spans cover the sample document", () => {
  const doc = sampleDocument();
  const spans = lockSpans(doc);
  for (let cursor = 0; cursor <= doc.length; cursor += 1) {
    const index = lockIndexAt(doc, cursor);
    assert.equal(index >= 0, true);
    if (cursor === doc.length && doc.endsWith("\n")) assert.equal(index, spans.length - 1);
    else assert.equal(cursor >= spans[index].start && cursor <= spans[index].end, true);
  }
  for (let i = 1; i < spans.length; i += 1) {
    assert.equal(spans[i].start, spans[i - 1].end + 1);
  }

  const at = (needle) => lockIndexAt(doc, doc.indexOf(needle));
  assert.equal(spanText(doc, spans[at("# Viewmark")]), "# Viewmark");
  assert.notEqual(at("# Viewmark"), at("A **bold**"));
  assert.equal(spanText(doc, spans[at("---")]), "---");
  assert.notEqual(at("- two"), at("- sub"));
  assert.notEqual(at("- sub"), at("- tabbed"));
  assert.notEqual(at("- one"), at("- two"));
  assert.notEqual(at("1. first"), at("1. nested"));
  assert.notEqual(at("1. first"), at("2. second"));
  assert.equal(at("| a | b |"), at("| --- | --- |"));
  assert.notEqual(at("| a | b |"), at("| 1 | 2 |"));
  assert.equal(spanText(doc, spans[at("![alt]")]), "![alt](sample.svg)");
  assert.equal(at("```python"), at("x = 1"));
  assert.equal(at("```python"), at("```\n"));
  const mermaid = doc.indexOf("```mermaid");
  assert.equal(lockIndexAt(doc, mermaid), lockIndexAt(doc, doc.indexOf("graph TD")));
  assert.equal(lockIndexAt(doc, mermaid), lockIndexAt(doc, doc.indexOf("```", mermaid + 3)));
  assert.notEqual(at("```python"), lockIndexAt(doc, mermaid));
});

test("dismissLogin calls close while the dialog is still open", () => {
  const mounted = mountEditor();
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
  function factory() {
    const socket = {
      sent: [],
      closed: false,
      addEventListener() {},
      send(data) {
        this.sent.push(data);
      },
      close() {
        this.closed = true;
      },
    };
    sockets.push(socket);
    return socket;
  }
  const env = () => ({
    document: globalThis.document,
    sessionStorage: storage,
    socketFactory: factory,
    location: { protocol: "http:", host: "viewmark.test" },
  });
  try {
    document.body = document.createElement("body");
    const page = startPage(env());
    const dialog = [...document.body.childNodes].find((node) => node.classList && node.classList.contains("md-login"));
    let openAtClose = null;
    dialog.close = () => {
      openAtClose = dialog.open;
      dialog.open = false;
      dialog.removeAttribute("open");
    };
    const input = walkNodes(dialog, (node) => node.classList && node.classList.contains("md-login-name"))[0];
    const form = walkNodes(dialog, (node) => node.tagName === "FORM")[0];
    input.value = "Ada";
    form.listeners.submit({ preventDefault() {} });
    assert.equal(openAtClose, true);
    assert.equal(dialog.open, false);
    assert.equal(dialog.hasAttribute("open"), false);
    assert.equal(sockets.length, 1);
    page.close();

    document.body = document.createElement("body");
    storage.data["viewmark.username"] = "Ada";
    const preset = document.createElement("dialog");
    preset.className = "md-login";
    preset.open = true;
    preset.setAttribute("open", "");
    const presetForm = document.createElement("form");
    const presetInput = document.createElement("input");
    presetInput.className = "md-login-name";
    presetForm.appendChild(presetInput);
    preset.appendChild(presetForm);
    document.body.appendChild(preset);
    let storedOpen = null;
    preset.close = () => {
      storedOpen = preset.open;
      preset.open = false;
      preset.removeAttribute("open");
    };
    const again = startPage(env());
    assert.equal(storedOpen, true);
    assert.equal(preset.open, false);
    assert.equal(preset.hasAttribute("open"), false);
    again.close();
  } finally {
    mounted.restore();
  }
});

test("a saved note opens only for its author", () => {
  const mounted = mountSheet();
  const ada = "@2026-10-04T20:30:22.000Z Ada\nquestion";
  const grok = "@2026-10-04T21:15:00.000Z Grok\nreply";
  const doc = `See {c1}fox{/c1}.\n\n\`\`\`comment c1\n:: 0\n${ada}\n:: 1\n${grok}\n:: 2\nbare\n\`\`\`\n`;
  const memory = createMemoryTransport(doc, 0);
  memory.username = "Ada";
  const texts = () => mounted.findAll((node) => node.classList && node.classList.contains("md-comment-text"));
  const areas = () => mounted.findAll((node) => node.tagName === "TEXTAREA");
  const times = () => mounted.findAll((node) => node.classList && node.classList.contains("md-comment-time"));
  const press = (label) => {
    const button = mounted.findAll((node) => node.tagName === "BUTTON" && node.textContent === label).at(-1);
    button.listeners.click({ target: button, preventDefault() {} });
  };
  try {
    const view = createEditor(mounted.root, doc, 0, memory);
    assert.deepEqual(texts().map((node) => node.textContent), ["question", "reply", "bare"]);
    assert.deepEqual(times().map((node) => node.textContent), ["(c1)", "2026-10-04 20:30", "2026-10-04 21:15"]);
    assert.equal(times()[0].tagName, "SPAN");
    assert.equal(times()[1].tagName, "TIME");
    mounted.aside.listeners.click({ target: texts()[1], preventDefault() {} });
    assert.equal(areas().length, 0);
    mounted.aside.listeners.click({ target: texts()[2], preventDefault() {} });
    assert.equal(areas().length, 0);
    assert.equal(view.getState().doc, doc);
    mounted.aside.listeners.click({ target: texts()[0], preventDefault() {} });
    const box = areas()[0];
    assert.equal(box.value, "question");
    assert.equal(box.selectionStart, "question".length);
    assert.equal(box.selectionEnd, "question".length);
    box.value = "edited";
    press("Save");
    assert.equal(view.getState().doc.includes("@2026-10-04T20:30:22.000Z Ada\nedited"), true);
    assert.equal(view.getState().doc.includes("@2026-10-04T21:15:00.000Z Grok\nreply"), true);
    assert.equal(view.getState().doc.includes("\nbare\n"), true);

    const freshMemory = createMemoryTransport("hello fox two deer\n", 0);
    freshMemory.username = "Ada";
    const fresh = createEditor(mounted.root, "hello fox two deer\n", 0, freshMemory);
    const word = mounted.root.childNodes[0].childNodes[0].childNodes[0];
    mounted.listeners.mousedown({ clientX: 0, clientY: 0 });
    mounted.setSelection({
      rangeCount: 1,
      anchorNode: word,
      anchorOffset: 6,
      focusNode: word,
      focusOffset: 9,
      getRangeAt() {
        return {
          collapsed: false,
          commonAncestorContainer: word,
          getClientRects() {
            return [{ top: 12, left: 0, right: 40, bottom: 28, width: 40, height: 16 }];
          },
        };
      },
    });
    mounted.listeners.mouseup({ clientX: 30, clientY: 12 });
    mounted.findAll((node) => node.className === "md-add-comment")[0].listeners.mousedown({ button: 0, preventDefault() {} });
    areas()[0].value = "hi";
    press("Save");
    const saved = fresh.getState().doc;
    assert.match(saved, /@\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z Ada\nhi/);
    mounted.aside.listeners.click({ target: texts()[0], preventDefault() {} });
    assert.equal(areas()[0].value, "hi");
    let undoPrevented = false;
    mounted.aside.listeners.keydown({
      key: "z",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      target: areas()[0],
      preventDefault() {
        undoPrevented = true;
      },
    });
    assert.equal(undoPrevented, true);
    assert.equal(fresh.getState().doc, "hello {c1}fox{/c1} two deer\n\n```comment c1\n\n```\n");
    assert.equal(areas()[0].value, "");
    fresh.destroy();
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("resolved highlights follow the show resolved checkbox", () => {
  const mounted = mountSheet();
  const doc = [
    "Say {c1}one{/c1} and {c2}two{/c2}.",
    "",
    "```comment c1 resolved",
    "@2026-10-04T20:30:22.000Z Ada",
    "hi",
    "```",
    "",
    "```comment c2",
    "@2026-10-04T21:15:00.000Z Bea",
    "there",
    "```",
    "",
  ].join("\n");
  const text = (value) => mounted.findAll((node) => node.nodeType === 3 && node.textContent === value)[0];
  const cards = () => mounted.findAll((node) => node.classList && node.classList.contains("md-comment-card"));
  try {
    const view = createEditor(mounted.root, doc, 0);
    const marked = (value) => text(value).parentElement.classList.contains("md-comment");
    assert.equal(text("one").textContent, "one");
    assert.equal(marked("one"), false);
    assert.equal(text("one").parentElement.dataset.comment, "c1");
    assert.equal(marked("two"), true);
    assert.equal(text("two").parentElement.dataset.comment, "c2");
    assert.deepEqual(cards().map((card) => card.dataset.comment), ["c2"]);
    const checkbox = docMenuOf(mounted.aside).checkbox;
    assert.equal(checkbox.checked, false);
    checkbox.checked = true;
    checkbox.listeners.change();
    assert.equal(marked("one"), true);
    assert.equal(marked("two"), true);
    assert.deepEqual(cards().map((card) => card.dataset.comment).sort(), ["c1", "c2"]);
    const shown = docMenuOf(mounted.aside).checkbox;
    shown.checked = false;
    shown.listeners.change();
    assert.equal(marked("one"), false);
    assert.equal(marked("two"), true);
    assert.deepEqual(cards().map((card) => card.dataset.comment), ["c2"]);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("a file message marks only the open path", () => {
  const mounted = mountTicketPage();
  const transport = holdingTransport();
  const currentFiles = () => walkNodes(mounted.nav, (node) => node.classList && node.classList.contains("md-file-current"));
  const currentTickets = () => walkNodes(mounted.nav, (node) => node.classList && node.classList.contains("md-ticket-current"));
  try {
    const view = createEditor(mounted.root, "old\n", 0, transport);
    transport.deliver({ type: "docs", files: ["notes.md"] });
    transport.deliver({ type: "file", path: "notes.md", rev: 1, text: "old\n", cursor: 0, anchor: 0, locks: [] });
    assert.equal(currentFiles().length, 1);
    assert.equal(currentFiles()[0].dataset.path, "notes.md");
    assert.equal(currentTickets().length, 0);
    const fresh = ticketFixture("aaaaaaaa", "New ticket", "new", T0);
    transport.deliver({ type: "tickets", tickets: [fresh] });
    assert.equal(rowOf(mounted.nav, "aaaaaaaa").classList.contains("md-ticket-current"), false);
    assert.equal(currentFiles().length, 1);
    transport.deliver({
      type: "file",
      path: "tickets/aaaaaaaa.md",
      rev: 1,
      text: "\n",
      cursor: 0,
      anchor: 0,
      locks: [],
      ticket: fresh,
    });
    assert.equal(currentFiles().length, 0);
    assert.equal(currentTickets().length, 1);
    assert.equal(currentTickets()[0], rowOf(mounted.nav, "aaaaaaaa"));
    transport.deliver({ type: "file", path: "notes.md", rev: 2, text: "back\n", cursor: 0, anchor: 0, locks: [] });
    assert.equal(currentTickets().length, 0);
    assert.equal(currentFiles().length, 1);
    assert.equal(currentFiles()[0].dataset.path, "notes.md");
    assert.equal(view.getState().doc, "back\n");
    view.destroy();
  } finally {
    mounted.restore();
  }
});

function fireDocument(mounted, type) {
  for (const fn of mounted.documentListeners.get(type) || []) fn();
}

function textNode(root, value) {
  const found = walkNodes(root, (node) => node.nodeType === 3 && node.textContent === value);
  return found[0];
}

test("a selectionchange stores the caret and sends no lock", () => {
  const mounted = mountEditor();
  const transport = holdingTransport();
  const doc = "one\n\ntwo\n";
  try {
    const view = createEditor(mounted.root, doc, 0, transport);
    const two = textNode(mounted.root, "two");
    assert.ok(two);
    globalThis.window.getSelection = () => ({
      rangeCount: 1,
      anchorNode: two,
      anchorOffset: 1,
      focusNode: two,
      focusOffset: 1,
      getRangeAt() {
        return {
          startContainer: two,
          startOffset: 1,
          endContainer: two,
          endOffset: 1,
          collapsed: true,
          commonAncestorContainer: two,
        };
      },
    });
    transport.sent.length = 0;
    fireDocument(mounted, "selectionchange");
    assert.equal(view.getState().cursor, doc.indexOf("two") + 1);
    assert.equal(view.getState().anchor, view.getState().cursor);
    assert.equal(transport.sent.some((message) => message.type === "lock"), false);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("placeCaret does not move state", () => {
  const mounted = mountEditor();
  globalThis.NodeFilter = globalThis.NodeFilter || { SHOW_TEXT: 4 };
  try {
    const view = createEditor(mounted.root, "alpha beta\n", 1);
    const text = textNode(mounted.root, "alpha beta");
    assert.ok(text);
    text.parentElement.scrollIntoView = () => {};
    let reported = 6;
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
    const selection = {
      rangeCount: 1,
      get anchorNode() { return text; },
      get anchorOffset() { return reported; },
      get focusNode() { return text; },
      get focusOffset() { return reported; },
      removeAllRanges() {},
      addRange() {
        fireDocument(mounted, "selectionchange");
      },
      setBaseAndExtent() {
        fireDocument(mounted, "selectionchange");
      },
      getRangeAt() {
        return {
          startContainer: text,
          startOffset: reported,
          endContainer: text,
          endOffset: reported,
          collapsed: true,
          commonAncestorContainer: text,
        };
      },
    };
    globalThis.window.getSelection = () => selection;
    reported = 1;
    fireDocument(mounted, "selectionchange");
    assert.equal(view.getState().cursor, 1);
    assert.equal(view.getState().anchor, 1);
    reported = 6;
    view.focus();
    assert.equal(view.getState().cursor, 1);
    assert.equal(view.getState().anchor, 1);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("a locks message leaves that caret", () => {
  const mounted = mountEditor();
  const transport = holdingTransport();
  transport.username = "me";
  const doc = "one\n\ntwo\n";
  try {
    const view = createEditor(mounted.root, doc, 0, transport);
    const one = textNode(mounted.root, "one");
    const block = one.parentElement.closest(".md-line");
    assert.ok(block);
    globalThis.window.getSelection = () => ({
      rangeCount: 1,
      anchorNode: one,
      anchorOffset: 2,
      focusNode: one,
      focusOffset: 2,
      getRangeAt() {
        return {
          startContainer: one,
          startOffset: 2,
          endContainer: one,
          endOffset: 2,
          collapsed: true,
          commonAncestorContainer: one,
        };
      },
    });
    fireDocument(mounted, "selectionchange");
    assert.equal(view.getState().cursor, 2);
    const replaced = [];
    const original = mounted.root.replaceChildren;
    mounted.root.replaceChildren = (...nodes) => {
      replaced.push(nodes);
      return original.apply(mounted.root, nodes);
    };
    let placed = 0;
    globalThis.window.getSelection = () => ({
      rangeCount: 1,
      anchorNode: one,
      anchorOffset: 2,
      focusNode: one,
      focusOffset: 2,
      removeAllRanges() { placed += 1; },
      addRange() { placed += 1; },
      setBaseAndExtent() { placed += 1; },
      getRangeAt() {
        return { collapsed: true, commonAncestorContainer: one, startContainer: one, startOffset: 2, endContainer: one, endOffset: 2 };
      },
    });
    transport.deliver({
      type: "locks",
      lines: [
        { index: 0, username: "ada" },
        { index: 2, username: "bea" },
      ],
    });
    assert.equal(replaced.length, 0);
    assert.equal(placed, 0);
    assert.equal(block.isConnected, true);
    assert.equal(mounted.root.childNodes.includes(block), true);
    const ada = walkNodes(block, (node) => node.classList && node.classList.contains("md-lock") && node.textContent === "ada");
    assert.equal(ada.length, 1);
    assert.equal(view.getState().cursor, 2);
    assert.equal(view.getState().anchor, 2);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("compositionend inserts at the caret from compositionstart", () => {
  const mounted = mountEditor();
  const transport = holdingTransport();
  const doc = "- alpha\n";
  try {
    const view = createEditor(mounted.root, doc, 4, transport);
    const text = textNode(mounted.root, "- alpha");
    assert.ok(text);
    assert.equal(view.getState().cursor, 4);
    mounted.listeners.compositionstart();
    globalThis.window.getSelection = () => ({
      rangeCount: 1,
      anchorNode: text,
      anchorOffset: 5,
      focusNode: text,
      focusOffset: 5,
      getRangeAt() {
        return {
          startContainer: text,
          startOffset: 5,
          endContainer: text,
          endOffset: 5,
          collapsed: true,
          commonAncestorContainer: text,
        };
      },
    });
    fireDocument(mounted, "selectionchange");
    assert.equal(view.getState().cursor, 4);
    assert.equal(view.getState().anchor, 4);
    assert.equal(transport.sent.some((message) => message.type === "edit"), false);
    mounted.listeners.compositionend({ data: "é" });
    const edits = transport.sent.filter((message) => message.type === "edit");
    assert.equal(edits.length, 1);
    assert.equal(edits[0].op, "insert");
    assert.equal(edits[0].text, "é");
    assert.equal(edits[0].cursor, 4);
    assert.equal(edits[0].anchor, 4);
    assert.equal(view.getState().cursor, 4);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("the first Home stops after a marker and the second keeps the line start", () => {
  const mounted = mountEditor();
  globalThis.NodeFilter = globalThis.NodeFilter || { SHOW_TEXT: 4 };
  try {
    const view = createEditor(mounted.root, "- alpha\n", 4);
    const text = textNode(mounted.root, "- alpha");
    assert.ok(text);
    text.parentElement.scrollIntoView = () => {};
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
    let offset = 0;
    globalThis.window.getSelection = () => ({
      rangeCount: 1,
      anchorNode: text,
      anchorOffset: offset,
      focusNode: text,
      focusOffset: offset,
      removeAllRanges() {},
      addRange() {},
      setBaseAndExtent() {},
      getRangeAt() {
        return {
          startContainer: text,
          startOffset: offset,
          endContainer: text,
          endOffset: offset,
          collapsed: true,
          commonAncestorContainer: text,
        };
      },
    });
    fireDocument(mounted, "selectionchange");
    assert.equal(view.getState().cursor, 2);
    assert.equal(view.getState().anchor, 2);
    fireDocument(mounted, "selectionchange");
    assert.equal(view.getState().cursor, 0);
    assert.equal(view.getState().anchor, 0);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("wnu2mutk Ctrl+A selects through the final newline", () => {
  const mounted = mountEditor();
  globalThis.NodeFilter = globalThis.NodeFilter || { SHOW_TEXT: 4 };
  try {
    const doc = "alpha\n\nbeta\n";
    const view = createEditor(mounted.root, doc, 2);
    mounted.listeners.keydown({
      key: "a",
      shiftKey: false,
      ctrlKey: true,
      altKey: false,
      metaKey: false,
      preventDefault() {},
    });
    assert.equal(view.getState().anchor, 0);
    assert.equal(view.getState().cursor, doc.length);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("keyup claims the caret selectionchange stored", () => {
  const mounted = mountEditor();
  const transport = holdingTransport();
  const doc = "one\n\ntwo\n";
  try {
    const view = createEditor(mounted.root, doc, 0, transport);
    const two = textNode(mounted.root, "two");
    globalThis.window.getSelection = () => ({
      rangeCount: 1,
      anchorNode: two,
      anchorOffset: 0,
      focusNode: two,
      focusOffset: 0,
      getRangeAt() {
        return {
          startContainer: two,
          startOffset: 0,
          endContainer: two,
          endOffset: 0,
          collapsed: true,
          commonAncestorContainer: two,
        };
      },
    });
    transport.sent.length = 0;
    fireDocument(mounted, "selectionchange");
    assert.equal(transport.sent.some((message) => message.type === "lock"), false);
    mounted.listeners.keyup();
    const locks = transport.sent.filter((message) => message.type === "lock");
    assert.equal(locks.length, 1);
    assert.equal(locks[0].anchor, doc.indexOf("two"));
    assert.equal(locks[0].cursor, doc.indexOf("two"));
    assert.equal(view.getState().cursor, doc.indexOf("two"));
    view.destroy();
  } finally {
    mounted.restore();
  }
});

function pressTab(mounted) {
  mounted.listeners.keydown({
    key: "Tab",
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    preventDefault() {},
  });
}

function sourceSelection(mounted, doc, anchor, cursor) {
  const el = {
    nodeType: 1,
    dataset: { start: "0", end: String(doc.length) },
    classList: { contains() { return false; } },
    parentElement: mounted.root,
  };
  const node = { nodeType: 3, textContent: doc, length: doc.length, parentElement: el };
  globalThis.window.getSelection = () => ({
    rangeCount: 1,
    anchorNode: node,
    anchorOffset: anchor,
    focusNode: node,
    focusOffset: cursor,
    getRangeAt() {
      return {
        startContainer: node,
        startOffset: Math.min(anchor, cursor),
        endContainer: node,
        endOffset: Math.max(anchor, cursor),
        collapsed: anchor === cursor,
        commonAncestorContainer: node,
      };
    },
  });
}

test("tab on a dragged list selection indents each item and keeps the selection", () => {
  const mounted = mountEditor();
  const transport = holdingTransport();
  const doc = "- a\n- b\n- c\n";
  try {
    const view = createEditor(mounted.root, doc, 0, transport);
    sourceSelection(mounted, doc, 4, 11);
    transport.sent.length = 0;
    pressTab(mounted);
    const edits = transport.sent.filter((message) => message.type === "edit");
    assert.equal(edits.length, 1);
    assert.equal(edits[0].op, "insert");
    assert.equal(edits[0].text, "\t- b\n\t- c");
    assert.equal(edits[0].anchor, 4);
    assert.equal(edits[0].cursor, 11);
    transport.deliver({
      type: "doc",
      rev: 1,
      text: "- a\n\t- b\n\t- c\n",
      actor: "",
      cursor: 13,
      anchor: 13,
      undo: [],
      redo: [],
    });
    assert.equal(view.getState().doc, "- a\n\t- b\n\t- c\n");
    assert.equal(view.getState().anchor, 5);
    assert.equal(view.getState().cursor, 13);
    const raw = walkNodes(mounted.root, (node) => node.classList && node.classList.contains("md-raw")).map((node) => node.textContent);
    assert.ok(raw.some((text) => text.includes("\t- b")));
    assert.ok(raw.some((text) => text.includes("\t- c")));
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("tab on a list item writes the tab at the line start and keeps the caret", () => {
  const mounted = mountEditor();
  const transport = holdingTransport();
  const doc = "- a\n- b\n";
  try {
    const view = createEditor(mounted.root, doc, 7, transport);
    globalThis.window.getSelection = () => null;
    transport.sent.length = 0;
    pressTab(mounted);
    const edits = transport.sent.filter((message) => message.type === "edit");
    assert.equal(edits.length, 1);
    assert.equal(edits[0].text, "\t- b");
    assert.equal(edits[0].anchor, 4);
    assert.equal(edits[0].cursor, 7);
    transport.deliver({
      type: "doc",
      rev: 1,
      text: "- a\n\t- b\n",
      actor: "",
      cursor: 8,
      anchor: 8,
      undo: [],
      redo: [],
    });
    assert.equal(view.getState().doc, "- a\n\t- b\n");
    assert.equal(view.getState().cursor, 8);
    assert.equal(view.getState().anchor, 8);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

function pressShiftTab(mounted) {
  mounted.listeners.keydown({
    key: "Tab",
    shiftKey: true,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    preventDefault() {},
  });
}

test("shift tab gives an ordered item the next number at its new level", () => {
  const mounted = mountEditor();
  const outdent = (doc, cursor) => {
    const view = createEditor(mounted.root, doc, cursor);
    globalThis.window.getSelection = () => null;
    pressShiftTab(mounted);
    const state = view.getState();
    view.destroy();
    return state;
  };
  try {
    const top = "1. one\n2. two\n\t1. a\n\t2. \n";
    const topped = outdent(top, top.length - 1);
    assert.equal(topped.doc, "1. one\n2. two\n\t1. a\n3. \n");
    assert.equal(topped.cursor, topped.doc.length - 1);
    assert.notEqual(topped.doc, "1. one\n2. two\n\t1. a\n4. \n");

    const nested = "\t1. one\n\t2. two\n\t\t1. a\n\t\t2. \n";
    const nestedOut = outdent(nested, nested.length - 1);
    assert.equal(nestedOut.doc, "\t1. one\n\t2. two\n\t\t1. a\n\t3. \n");
    assert.equal(nestedOut.cursor, nestedOut.doc.length - 1);

    const afterThree = "\t3. two dot three\n\t\t2. x";
    const four = outdent(afterThree, afterThree.length);
    assert.equal(four.doc, "\t3. two dot three\n\t4. x");
    assert.equal(four.cursor, four.doc.length);

    const twoDot = "2. two dot\n\t2. x";
    const three = outdent(twoDot, twoDot.length);
    assert.equal(three.doc, "2. two dot\n3. x");
    assert.notEqual(three.doc, "2. two dot\n4. x");

    const spaced = "2. two dot\n    2. x";
    assert.equal(outdent(spaced, spaced.length).doc, "2. two dot\n3. x");

    const paren = "2) two dot\n\t2) x";
    assert.equal(outdent(paren, paren.length).doc, "2) two dot\n3) x");

    const only = "1. one\n2. two\n\t1. a\n\t2. b\n3. three\n";
    const line = only.indexOf("\t2. b");
    const kept = outdent(only, line + "\t2. b".length);
    assert.equal(kept.doc, "1. one\n2. two\n\t1. a\n3. b\n3. three\n");

    const bullet = "- a\n\t- b\n";
    assert.equal(outdent(bullet, bullet.length - 1).doc, "- a\n- b\n");

    const stay = "1. a\n2. b\n";
    assert.equal(outdent(stay, stay.length - 1).doc, stay);

    const grown = "9. y\n\t9. x";
    const grew = outdent(grown, grown.lastIndexOf("x"));
    assert.equal(grew.doc, "9. y\n10. x");
    assert.equal(grew.doc[grew.cursor], "x");

    const shrunkSrc = "2. y\n\t10. x";
    const shrunk = outdent(shrunkSrc, shrunkSrc.lastIndexOf("x"));
    assert.equal(shrunk.doc, "2. y\n3. x");
    assert.equal(shrunk.doc[shrunk.cursor], "x");

    const both = "1. a\n\t1. b\n\t2. c\n";
    const view = createEditor(mounted.root, both, 0);
    sourceSelection(mounted, both, both.indexOf("\t1."), both.indexOf("\t2. c") + "\t2. c".length);
    pressShiftTab(mounted);
    assert.equal(view.getState().doc, "1. a\n2. b\n3. c\n");
    view.destroy();

    const nestedEnter = "1. one\n\t2. item";
    assert.equal(enterInsert(nestedEnter, nestedEnter.length).text, "\n\t3. ");
    const between = "1. one\n2. two\n\t1. a\n\t2. item";
    assert.equal(enterInsert(between, between.length).text, "\n\t3. ");
  } finally {
    mounted.restore();
  }
});

test("uwtqazmt crlf newlines", () => {
  const blank = backspace(createState("one\r\n\r\ntwo\r\n", 5));
  assert.equal(blank.doc, "one\r\ntwo\r\n");
  assert.equal(blank.cursor, 3);

  const base = createState("one\r\ntwo\r\n", 3);
  const brk = enterInsert(base.doc, base.cursor);
  const entered = typeof brk.anchor === "number"
    ? insert({ ...base, anchor: brk.anchor, cursor: brk.cursor }, brk.text)
    : insert(base, brk.text);
  assert.equal(entered.doc, "one\r\n\r\ntwo\r\n");
  assert.equal(entered.cursor, 7);
  assert.deepEqual(plan(entered.doc, entered.cursor).lines.map((line) => line.text), ["one", "", "two"]);
  assert.equal(skipHidden(entered.doc, 4, "backward"), 3);

  const mid = insert(createState("one\r\n\r\n\r\n\r\ntwo\r\n", 7), "x");
  assert.equal(mid.doc, "one\r\n\r\nx\r\n\r\ntwo\r\n");
  assert.equal(mid.cursor, 8);

  const lf = insert(createState("one\n\ntwo\n", 4), "a\r\nb");
  assert.equal(lf.doc, "one\n\na\nb\ntwo\n");
  assert.equal(lf.cursor, 8);

  const joined = deleteForward(createState("ab\r\ncd", 3));
  assert.equal(joined.doc, "abcd");
  assert.equal(joined.cursor, 2);

  const cr5 = deleteForward(createState("one\r\ntwo\r\n", 3));
  assert.equal(cr5.doc, "onetwo\r\n");
  assert.equal(cr5.cursor, 3);
  const cr6 = deleteForward(createState("one\r\n\r\ntwo\r\n", 3));
  assert.equal(cr6.doc, "one\r\ntwo\r\n");
  assert.equal(cr6.cursor, 3);
});

test("a click collapses a range for the browser and the timer restores it", () => {
  const mounted = mountEditor();
  const transport = holdingTransport();
  const anchor = { nodeType: 3, isConnected: true };
  const focus = { nodeType: 3, isConnected: true };
  const calls = [];
  let timer = null;
  const selection = {
    rangeCount: 1,
    isCollapsed: false,
    anchorNode: anchor,
    anchorOffset: 1,
    focusNode: focus,
    focusOffset: 4,
    collapse(node, offset) {
      calls.push(["collapse", node, offset]);
      this.isCollapsed = true;
      this.anchorNode = node;
      this.anchorOffset = offset;
      this.focusNode = node;
      this.focusOffset = offset;
    },
    setBaseAndExtent(node, offset, focusNode, focusOffset) {
      calls.push(["restore", node, offset, focusNode, focusOffset]);
      this.isCollapsed = false;
      this.anchorNode = node;
      this.anchorOffset = offset;
      this.focusNode = focusNode;
      this.focusOffset = focusOffset;
    },
  };
  try {
    createEditor(mounted.root, "alpha beta\n", 0, transport);
    globalThis.window.getSelection = () => selection;
    globalThis.window.setTimeout = (fn) => {
      timer = fn;
      return 0;
    };
    mounted.listeners.click({ button: 0, shiftKey: true, detail: 1, target: mounted.root, preventDefault() {} });
    assert.deepEqual(calls, [["collapse", focus, 4]]);
    assert.equal(typeof timer, "function");
    timer();
    assert.deepEqual(calls[1], ["restore", anchor, 1, focus, 4]);
    assert.equal(selection.isCollapsed, false);

    calls.length = 0;
    timer = null;
    selection.isCollapsed = false;
    selection.rangeCount = 1;
    selection.anchorNode = anchor;
    selection.focusNode = focus;
    mounted.listeners.click({ button: 1, shiftKey: true, detail: 1, target: mounted.root, preventDefault() {} });
    assert.deepEqual(calls, []);
    assert.equal(timer, null);

    selection.isCollapsed = true;
    mounted.listeners.click({ button: 0, shiftKey: true, detail: 1, target: mounted.root, preventDefault() {} });
    assert.deepEqual(calls, []);
    assert.equal(timer, null);
  } finally {
    mounted.restore();
  }
});

function viewToggleOf(root) {
  for (const child of root.childNodes) {
    if (child.classList && child.classList.contains("md-view-toggle")) return child;
  }
  return null;
}

function pressViewToggle(root) {
  const button = viewToggleOf(root);
  button.listeners.click({ button: 0, preventDefault() {}, stopPropagation() {} });
  return button;
}

function sourceLinesOf(root) {
  const lines = [];
  for (const child of root.childNodes) {
    if (!child.classList || !child.classList.contains("md-source-line")) continue;
    let text = "";
    for (const node of child.childNodes) {
      if (node.classList && node.classList.contains("md-lock")) continue;
      if (node.nodeType === 3) text += node.textContent;
    }
    lines.push({
      text,
      start: Number(child.dataset.start),
      end: Number(child.dataset.end),
      className: child.className,
    });
  }
  return lines;
}

function joinedSource(root) {
  return sourceLinesOf(root).map((line) => line.text).join("\n");
}

function strokeValues(button) {
  const svg = [...button.childNodes].find((node) => node.localName === "svg");
  const found = [];
  const walk = (node) => {
    if (!node) return;
    if (typeof node.getAttribute === "function" && node.getAttribute("stroke") != null) found.push(node.getAttribute("stroke"));
    for (const child of node.childNodes || []) walk(child);
  };
  walk(svg);
  return { svg, found };
}

function slashLine(button) {
  const svg = [...button.childNodes].find((node) => node.localName === "svg");
  return [...svg.childNodes].find((node) => node.localName === "line") || null;
}

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    setItem(key, value) {
      data[key] = String(value);
    },
    data,
  };
}

function keyDown(mounted, key, extra = {}) {
  mounted.listeners.keydown({
    key,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    preventDefault() {},
    ...extra,
  });
}

function input(mounted, inputType, data) {
  mounted.listeners.beforeinput({
    inputType,
    data,
    preventDefault() {},
  });
}

test("raw mode is a view and Enter stores one newline", () => {
  const css = readFileSync(new URL("../editor.css", import.meta.url), "utf8");
  assert.match(css, /#editor\.md-source\s*\{[^}]*font-family:\s*ui-monospace,\s*SFMono-Regular,\s*Menlo,\s*Consolas,\s*monospace;/);
  assert.match(css, /button\.icon-btn\.md-view-toggle/);
  assert.equal(css.includes(".md-line.md-raw"), false);
  assert.match(css, /\.editor \{[^}]*tab-size: 4;/);

  const mounted = mountEditor();
  try {
    const transport = holdingTransport();
    const view = createEditor(mounted.root, "- one", 5, transport);
    const button = viewToggleOf(mounted.root);
    assert.equal(button.tagName, "BUTTON");
    assert.equal(button.type, "button");
    assert.equal(button.getAttribute("aria-label"), "Raw");
    assert.equal(button.getAttribute("aria-pressed"), "false");
    assert.equal(button.classList.contains("icon-btn"), true);
    assert.notEqual(mounted.root.childNodes[0], button);
    assert.equal(mounted.root.childNodes[0].classList.contains("md-line"), true);
    const renderedIcon = strokeValues(button);
    assert.equal(renderedIcon.svg.getAttribute("viewBox"), "0 0 24 24");
    assert.equal(renderedIcon.svg.getAttribute("aria-hidden"), "true");
    assert.equal(renderedIcon.svg.getAttribute("fill"), "none");
    assert.equal(renderedIcon.svg.getAttribute("stroke"), "currentColor");
    assert.equal(renderedIcon.svg.getAttribute("stroke-width"), "2");
    assert.equal(renderedIcon.svg.getAttribute("stroke-linecap"), "round");
    assert.equal(renderedIcon.svg.getAttribute("stroke-linejoin"), "round");
    assert.equal(slashLine(button), null);
    assert.equal(renderedIcon.found.every((stroke) => stroke === "currentColor"), true);
    assert.equal(mounted.root.classList.contains("md-source"), false);

    view.getState();
    mounted.listeners.keydown({
      key: "a",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      preventDefault() {},
    });
    assert.equal(view.getState().anchor, 0);
    assert.equal(view.getState().cursor, 5);
    transport.sent.length = 0;
    pressViewToggle(mounted.root);
    assert.equal(transport.sent.some((message) => message.type === "edit" || message.type === "undo" || message.type === "redo"), false);
    assert.equal(view.getState().doc, "- one");
    assert.equal(view.getState().anchor, 0);
    assert.equal(view.getState().cursor, 5);
    assert.equal(mounted.root.focused, true);
    assert.equal(button.getAttribute("aria-pressed"), "true");
    assert.equal(mounted.root.classList.contains("md-source"), true);
    const slash = slashLine(button);
    assert.equal(slash.getAttribute("x1"), "3");
    assert.equal(slash.getAttribute("y1"), "21");
    assert.equal(slash.getAttribute("x2"), "21");
    assert.equal(slash.getAttribute("y2"), "3");
    assert.equal(slash.getAttribute("stroke"), "rgb(220, 38, 38)");
    const rawStrokes = strokeValues(button).found;
    assert.deepEqual(rawStrokes.filter((stroke) => stroke !== "currentColor"), ["rgb(220, 38, 38)"]);
    assert.equal(joinedSource(mounted.root), "- one");
    view.destroy();

    const broken = {
      getItem() {
        throw new Error("closed");
      },
      setItem() {
        throw new Error("closed");
      },
    };
    const stored = createEditor(mounted.root, "a\n", 0, holdingTransport(), broken);
    pressViewToggle(mounted.root);
    assert.equal(stored.getState().doc, "a\n");
    stored.destroy();

    const typing = createEditor(mounted.root, "- one", 5);
    pressViewToggle(mounted.root);
    input(mounted, "insertParagraph");
    assert.equal(typing.getState().doc, "- one\n");
    assert.equal(typing.getState().cursor, 6);
    assert.equal(typing.getState().doc.includes("\n- "), false);
    input(mounted, "insertText", "Z");
    assert.equal(typing.getState().doc, "- one\nZ");
    assert.equal(typing.getState().cursor, 7);
    typing.destroy();

    const crlf = createEditor(mounted.root, "a\r\nb", 4);
    pressViewToggle(mounted.root);
    input(mounted, "insertParagraph");
    assert.equal(crlf.getState().doc, "a\r\nb\r\n");
    assert.equal(joinedSource(mounted.root), "a\nb\n");
    const drawnCrlf = sourceLinesOf(mounted.root);
    assert.deepEqual(drawnCrlf.map((line) => line.text), ["a", "b", ""]);
    assert.equal(drawnCrlf[0].end, 1);
    assert.equal(drawnCrlf[1].end, 4);
    crlf.destroy();

    const stepping = createEditor(mounted.root, "one\r\ntwo\r\n\r\nthree\r\n", 0);
    pressViewToggle(mounted.root);
    assert.deepEqual(sourceLinesOf(mounted.root).map((line) => line.text), ["one", "two", "", "three", ""]);
    const stops = [];
    for (let i = 0; i < 5; i += 1) {
      keyDown(mounted, "ArrowRight");
      stops.push(stepping.getState().cursor);
    }
    assert.deepEqual(stops, [1, 2, 3, 5, 6]);
    keyDown(mounted, "ArrowLeft");
    assert.equal(stepping.getState().cursor, 5);
    keyDown(mounted, "ArrowLeft");
    assert.equal(stepping.getState().cursor, 3);
    keyDown(mounted, "ArrowRight");
    assert.equal(stepping.getState().cursor, 5);
    stepping.destroy();

    const plain = createEditor(mounted.root, "- one", 2);
    pressViewToggle(mounted.root);
    input(mounted, "deleteContentBackward");
    assert.equal(plain.getState().doc, "-one");
    assert.equal(plain.getState().cursor, 1);
    input(mounted, "deleteContentForward");
    assert.equal(plain.getState().doc, "-ne");
    assert.equal(plain.getState().cursor, 1);
    plain.destroy();

    const erasing = holdingTransport();
    const erase = createEditor(mounted.root, "- one", 2, erasing);
    pressViewToggle(mounted.root);
    erasing.sent.length = 0;
    input(mounted, "deleteContentBackward");
    const back = erasing.sent.find((message) => message.type === "edit");
    assert.equal(back.op, "insert");
    assert.equal(back.text, "");
    assert.equal(back.anchor, 1);
    assert.equal(back.cursor, 2);
    assert.equal(erasing.sent.some((message) => message.op === "backspace" || message.op === "delete"), false);
    erase.destroy();

    const tabbed = holdingTransport();
    const tabs = createEditor(mounted.root, "- one", 5, tabbed);
    pressViewToggle(mounted.root);
    tabbed.sent.length = 0;
    keyDown(mounted, "Tab", { shiftKey: true });
    assert.equal(tabbed.sent.some((message) => message.type === "edit"), false);
    assert.equal(tabs.getState().doc, "- one");
    keyDown(mounted, "Tab");
    const tab = tabbed.sent.find((message) => message.type === "edit");
    assert.equal(tab.op, "insert");
    assert.equal(tab.text, "\t");
    tabs.destroy();

    const memoryTab = createEditor(mounted.root, "- one", 5);
    pressViewToggle(mounted.root);
    keyDown(mounted, "Tab");
    assert.equal(memoryTab.getState().doc, "- one\t");
    memoryTab.destroy();

    const moving = createEditor(mounted.root, "- one\nmore\n", 4);
    pressViewToggle(mounted.root);
    keyDown(mounted, "ArrowLeft");
    assert.equal(moving.getState().cursor, 3);
    keyDown(mounted, "Home");
    assert.equal(moving.getState().cursor, 0);
    keyDown(mounted, "End");
    assert.equal(moving.getState().cursor, 5);
    keyDown(mounted, "ArrowRight");
    assert.equal(moving.getState().cursor, 6);
    moving.destroy();

    const columns = createEditor(mounted.root, "abcd\nxy\nABCDEF\n", 12);
    pressViewToggle(mounted.root);
    keyDown(mounted, "ArrowUp");
    assert.equal(columns.getState().cursor, 7);
    keyDown(mounted, "ArrowUp");
    assert.equal(columns.getState().cursor, 4);
    keyDown(mounted, "ArrowDown");
    assert.equal(columns.getState().cursor, 7);
    keyDown(mounted, "ArrowDown");
    assert.equal(columns.getState().cursor, 12);
    columns.destroy();

    const history = createEditor(mounted.root, "Z", 1);
    input(mounted, "insertText", "a");
    assert.equal(history.getState().doc, "Za");
    pressViewToggle(mounted.root);
    input(mounted, "insertText", "b");
    assert.equal(history.getState().doc, "Zab");
    keyDown(mounted, "z", { ctrlKey: true });
    assert.equal(history.getState().doc, "Za");
    keyDown(mounted, "z", { ctrlKey: true });
    assert.equal(history.getState().doc, "Z");
    history.destroy();

    const round = createEditor(mounted.root, "- one\n", 3);
    pressViewToggle(mounted.root);
    assert.equal(joinedSource(mounted.root), "- one\n");
    pressViewToggle(mounted.root);
    assert.equal(round.getState().doc, "- one\n");
    assert.equal(round.getState().cursor, 3);
    assert.equal(round.getState().anchor, 3);
    assert.equal(mounted.root.classList.contains("md-source"), false);
    assert.equal(sourceLinesOf(mounted.root).length, 0);
    assert.equal(mounted.root.childNodes[0].classList.contains("md-li"), true);
    assert.equal(slashLine(viewToggleOf(mounted.root)), null);
    round.destroy();
  } finally {
    mounted.restore();
  }
});

test("raw mode draws every byte and starts rendered for each document", () => {
  const mounted = mountSheet();
  const count = (name) => mounted.findAll((node) => node.classList && node.classList.contains(name)).length;
  try {
    const doc = "hello {c1}fox{/c1} two\n\n```comment c1\nhi\n```\n";
    const at = doc.indexOf("{c1}") + 1;
    const transport = holdingTransport();
    const view = createEditor(mounted.root, doc, at, transport);
    assert.ok(count("md-comment-card") > 0);
    pressViewToggle(mounted.root);
    assert.equal(view.getState().doc, doc);
    assert.equal(view.getState().cursor, at);
    assert.equal(joinedSource(mounted.root), doc);
    assert.ok(count("md-comment-card") > 0);
    assert.equal(joinedSource(mounted.root).includes("{c1}"), true);
    assert.equal(joinedSource(mounted.root).includes("```comment c1"), true);
    transport.sent.length = 0;
    input(mounted, "insertText", "Q");
    const edit = transport.sent.find((message) => message.type === "edit");
    assert.equal(edit.op, "insert");
    assert.equal(edit.text, "Q");
    assert.equal(edit.anchor, at);
    assert.equal(edit.cursor, at);
    pressViewToggle(mounted.root);
    assert.equal(view.getState().doc, doc);
    assert.equal(view.getState().cursor, at);
    assert.ok(count("md-comment-card") > 0);
    assert.equal(mounted.root.classList.contains("md-source"), false);
    view.destroy();

    const rich = [
      "> hi",
      "red  ",
      "blue",
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
      "```mermaid",
      "graph TD",
      "```",
      "![alt](sample.svg)",
      "```js",
      "const x = 1",
      "```",
      "",
    ].join("\n");
    const drawn = createEditor(mounted.root, rich, 0);
    pressViewToggle(mounted.root);
    assert.equal(joinedSource(mounted.root), rich);
    const lines = sourceLinesOf(mounted.root);
    assert.equal(lines[0].text, "> hi");
    assert.equal(lines[0].className.includes("md-quote"), false);
    assert.equal(lines[1].text, "red  ");
    assert.equal(lines[2].text, "blue");
    assert.equal(lines[lines.length - 1].text, "");
    assert.equal(lines[lines.length - 1].start, lines[lines.length - 1].end);
    assert.equal(count("md-table"), 0);
    assert.equal(count("md-diagram"), 0);
    assert.equal(count("md-image"), 0);
    assert.equal(count("md-break"), 0);
    assert.equal(count("md-comment-card"), 0);
    assert.equal(mounted.findAll((node) => node.tagName === "IMG" || node.tagName === "TABLE").length, 0);
    assert.equal(mounted.findAll((node) => node.classList && node.classList.contains("token")).length, 0);
    const tail = createEditor(mounted.root, "a\n", 0);
    pressViewToggle(mounted.root);
    const tailLines = sourceLinesOf(mounted.root);
    assert.equal(tailLines.length, 2);
    assert.equal(tailLines[0].text, "a");
    assert.equal(tailLines[1].text, "");
    assert.equal(tailLines[1].start, 2);
    assert.equal(tailLines[1].end, 2);
    tail.destroy();
    drawn.destroy();

    const refused = holdingTransport();
    refused.username = "bea";
    const held = createEditor(mounted.root, "- one\n", 2, refused);
    pressViewToggle(mounted.root);
    refused.deliver({ type: "locks", lines: [{ index: 0, username: "ada" }] });
    refused.sent.length = 0;
    input(mounted, "insertText", "Q");
    assert.equal(refused.sent.some((message) => message.type === "edit" && message.op === "insert" && message.text === "Q"), true);
    refused.deliver({ type: "error", status: 409, heldBy: "ada" });
    assert.equal(held.getState().doc, "- one\n");
    const label = mounted.findAll((node) => node.classList && node.classList.contains("md-lock") && node.textContent === "ada")[0];
    assert.equal(label.classList.contains("md-flash"), true);
    held.destroy();

    const storage = memoryStorage({ "viewmark.raw": "1" });
    const writes = [];
    const setItem = storage.setItem;
    storage.setItem = (key, value) => {
      writes.push(key);
      setItem.call(storage, key, value);
    };
    const first = createEditor(mounted.root, "hello\n", 1, holdingTransport(), storage);
    assert.equal(mounted.root.classList.contains("md-source"), false);
    assert.equal(viewToggleOf(mounted.root).getAttribute("aria-pressed"), "false");
    pressViewToggle(mounted.root);
    assert.equal(mounted.root.classList.contains("md-source"), true);
    assert.equal(writes.includes("viewmark.raw"), false);
    assert.equal(storage.getItem("viewmark.raw"), "1");
    first.destroy();
    const next = holdingTransport();
    const second = createEditor(mounted.root, "hello\n", 1, next, storage);
    assert.equal(mounted.root.classList.contains("md-source"), false);
    assert.equal(viewToggleOf(mounted.root).getAttribute("aria-pressed"), "false");
    pressViewToggle(mounted.root);
    assert.equal(mounted.root.classList.contains("md-source"), true);
    next.deliver({
      type: "file",
      rev: 1,
      path: "a.md",
      text: "hello\n",
      cursor: 1,
      anchor: 1,
    });
    assert.equal(mounted.root.classList.contains("md-source"), false);
    pressViewToggle(mounted.root);
    next.deliver({
      type: "file",
      rev: 2,
      path: "a.md",
      text: "hello!\n",
      cursor: 1,
      anchor: 1,
    });
    assert.equal(mounted.root.classList.contains("md-source"), true);
    assert.equal(joinedSource(mounted.root), "hello!\n");
    next.deliver({
      type: "file",
      rev: 4,
      path: "b.md",
      text: "beta\n",
      cursor: 2,
      anchor: 2,
    });
    assert.equal(mounted.root.classList.contains("md-source"), false);
    assert.equal(viewToggleOf(mounted.root).getAttribute("aria-pressed"), "false");
    assert.equal(sourceLinesOf(mounted.root).length, 0);
    assert.equal(second.getState().cursor, 2);
    assert.equal(second.getState().doc, "beta\n");
    assert.equal(writes.includes("viewmark.raw"), false);
    second.destroy();
    const fresh = memoryStorage();
    const third = createEditor(mounted.root, "beta\n", 0, holdingTransport(), fresh);
    assert.equal(mounted.root.classList.contains("md-source"), false);
    assert.equal(viewToggleOf(mounted.root).getAttribute("aria-pressed"), "false");
    assert.equal(fresh.getItem("viewmark.raw"), null);
    pressViewToggle(mounted.root);
    assert.equal(fresh.getItem("viewmark.raw"), null);
    third.destroy();
  } finally {
    mounted.restore();
  }
});

test("raw mode keeps a caret inside a comment marker", () => {
  const doc = "See {c1}this{/c1} now.";
  const at = "See {c".length;
  assert.equal(at, 6);
  const mounted = mountEditor();
  globalThis.NodeFilter = globalThis.NodeFilter || { SHOW_TEXT: 4 };
  const stuck = (container, offset) => {
    globalThis.window.getSelection = () => ({
      rangeCount: 1,
      collapse() {},
      setBaseAndExtent() {},
      removeAllRanges() {},
      addRange() {},
      modify() {},
      getRangeAt() {
        return { startContainer: container, startOffset: offset };
      },
    });
  };
  try {
    const transport = holdingTransport();
    const typing = createEditor(mounted.root, doc, at, transport);
    assert.equal(mounted.root.classList.contains("md-source"), false);
    pressViewToggle(mounted.root);
    assert.equal(typing.getState().cursor, at);
    assert.equal(typing.getState().anchor, at);
    const text = mounted.findAll((node) => node.nodeType === 3 && node.textContent === doc)[0];
    stuck(text, at);
    typing.moveCaret("forward", "character", false);
    assert.equal(typing.getState().cursor, at);
    assert.equal(typing.getState().anchor, at);
    transport.sent.length = 0;
    input(mounted, "insertText", "x");
    const edit = transport.sent.find((message) => message.type === "edit");
    assert.equal(edit.op, "insert");
    assert.equal(edit.text, "x");
    assert.equal(edit.anchor, at);
    assert.equal(edit.cursor, at);
    typing.destroy();

    const accepted = createEditor(mounted.root, doc, at);
    pressViewToggle(mounted.root);
    input(mounted, "insertText", "x");
    assert.equal(accepted.getState().doc, "See {cx1}this{/c1} now.");
    assert.equal(accepted.getState().cursor, at + 1);
    accepted.destroy();

    const rendered = createEditor(mounted.root, doc, at);
    assert.equal(rendered.getState().cursor, at);
    const parent = {
      nodeType: 1,
      dataset: { start: "0", end: String(doc.length) },
      classList: { contains() { return false; } },
      parentElement: null,
    };
    stuck({ nodeType: 3, parentElement: parent, length: doc.length }, at);
    keyDown(mounted, "ArrowRight");
    assert.equal(rendered.getState().cursor, 8);
    assert.equal(rendered.getState().anchor, 8);
    rendered.destroy();
  } finally {
    mounted.restore();
  }
});

function undoKey(mounted, shift = false) {
  keyDown(mounted, "z", { ctrlKey: true, shiftKey: shift });
}

test("UR.1", () => {
  const mounted = mountEditor();
  try {
    const view = createEditor(mounted.root, "alpha\n", 5);
    input(mounted, "insertText", "x");
    input(mounted, "insertText", "y");
    assert.equal(view.getState().doc, "alphaxy\n");
    assert.equal(view.getState().cursor, 7);
    undoKey(mounted);
    assert.equal(view.getState().doc, "alpha\n");
    assert.equal(view.getState().cursor, 5);
    assert.equal(view.getState().anchor, 5);
    input(mounted, "insertText", " ");
    input(mounted, "insertText", "q");
    undoKey(mounted);
    assert.equal(view.getState().doc, "alpha\n");
    assert.equal(view.getState().cursor, 5);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("UR.g.1", () => {
  const mounted = mountEditor();
  try {
    const view = createEditor(mounted.root, "alpha\n", 5);
    input(mounted, "insertText", "x");
    input(mounted, "insertText", "y");
    input(mounted, "insertText", "z");
    assert.equal(view.getState().doc, "alphaxyz\n");
    undoKey(mounted);
    assert.equal(view.getState().doc, "alpha\n");
    assert.equal(view.getState().cursor, 5);
    assert.equal(view.getState().anchor, 5);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("UR.g.2", () => {
  const mounted = mountEditor();
  try {
    const view = createEditor(mounted.root, "alpha\n", 2);
    input(mounted, "insertText", "x");
    input(mounted, "insertText", "y");
    const afterRun = view.getState().doc;
    keyDown(mounted, "ArrowLeft");
    const caret = view.getState().cursor;
    const anchor = view.getState().anchor;
    input(mounted, "insertText", "z");
    assert.notEqual(view.getState().doc, afterRun);
    undoKey(mounted);
    assert.equal(view.getState().doc, afterRun);
    assert.equal(view.getState().cursor, caret);
    assert.equal(view.getState().anchor, anchor);
    assert.equal(afterRun, "alxypha\n");
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("UR.g.3", () => {
  const mounted = mountEditor();
  const now = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  try {
    const view = createEditor(mounted.root, "alpha\n", 5);
    input(mounted, "insertText", "x");
    clock += 1500;
    input(mounted, "insertText", "y");
    undoKey(mounted);
    assert.equal(view.getState().doc, "alphax\n");
    assert.equal(view.getState().cursor, 6);
    assert.equal(view.getState().anchor, 6);
    clock += 1000;
    input(mounted, "insertText", "y");
    clock += 1000;
    input(mounted, "insertText", "z");
    undoKey(mounted);
    assert.equal(view.getState().doc, "alphax\n");
    assert.equal(view.getState().cursor, 6);
    view.destroy();
  } finally {
    Date.now = now;
    mounted.restore();
  }
});

test("UR.g.4", () => {
  const mounted = mountEditor();
  try {
    const view = createEditor(mounted.root, "alpha\n", 5);
    input(mounted, "insertText", "x");
    input(mounted, "insertText", "y");
    input(mounted, "insertText", "z");
    undoKey(mounted);
    assert.equal(view.getState().doc, "alpha\n");
    undoKey(mounted, true);
    assert.equal(view.getState().doc, "alphaxyz\n");
    assert.equal(view.getState().cursor, 8);
    assert.equal(view.getState().anchor, 8);
    undoKey(mounted);
    keyDown(mounted, "y", { ctrlKey: true });
    assert.equal(view.getState().doc, "alphaxyz\n");
    assert.equal(view.getState().cursor, 8);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("UR.g.5", () => {
  const mounted = mountEditor();
  globalThis.NodeFilter = globalThis.NodeFilter || { SHOW_TEXT: 4 };
  try {
    const view = createEditor(mounted.root, "alpha\n", 0);
    const node = mounted.findAll((item) => item.nodeType === 3 && item.textContent === "alpha")[0];
    assert.ok(node);
    globalThis.window.getSelection = () => ({
      rangeCount: 1,
      anchorNode: node,
      anchorOffset: 2,
      focusNode: node,
      focusOffset: 4,
      getRangeAt() {
        return {
          startContainer: node,
          startOffset: 2,
          endContainer: node,
          endOffset: 4,
          collapsed: false,
          commonAncestorContainer: node.parentElement,
        };
      },
    });
    input(mounted, "insertText", "x");
    input(mounted, "insertText", "y");
    assert.equal(view.getState().doc, "alxya\n");
    undoKey(mounted);
    assert.equal(view.getState().doc, "alpha\n");
    assert.equal(view.getState().anchor, 2);
    assert.equal(view.getState().cursor, 4);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("UR.g.6", () => {
  const mounted = mountEditor();
  try {
    const view = createEditor(mounted.root, "alpha\n", 5);
    input(mounted, "insertText", "x");
    input(mounted, "insertText", "y");
    keyDown(mounted, "Backspace");
    input(mounted, "deleteContentBackward");
    const after = {
      doc: view.getState().doc,
      cursor: view.getState().cursor,
      anchor: view.getState().anchor,
    };
    input(mounted, "insertText", "z");
    assert.notEqual(view.getState().doc, after.doc);
    undoKey(mounted);
    assert.equal(view.getState().doc, after.doc);
    assert.equal(view.getState().cursor, after.cursor);
    assert.equal(view.getState().anchor, after.anchor);
    assert.equal(after.doc, "alphax\n");
    assert.equal(after.cursor, 6);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("a click, a pause boundary, and Ctrl+Z end a typing run", () => {
  const mounted = mountEditor();
  const now = Date.now;
  let clock = 5_000;
  Date.now = () => clock;
  try {
    const view = createEditor(mounted.root, "alpha\n", 5);
    input(mounted, "insertText", "x");
    mounted.listeners.mousedown({ clientX: 1, clientY: 1, button: 0, detail: 1 });
    input(mounted, "insertText", "y");
    undoKey(mounted);
    assert.equal(view.getState().doc, "alphax\n");
    assert.equal(view.getState().cursor, 6);
    input(mounted, "insertText", "y");
    keyDown(mounted, "Shift");
    input(mounted, "insertText", "z");
    undoKey(mounted);
    assert.equal(view.getState().doc, "alphax\n");
    input(mounted, "insertText", "a");
    input(mounted, "insertText", "b");
    keyDown(mounted, "ArrowLeft");
    input(mounted, "insertText", "x");
    undoKey(mounted);
    assert.equal(view.getState().doc, "alphaxab\n");
    input(mounted, "insertText", "z");
    undoKey(mounted);
    assert.equal(view.getState().doc, "alphaxab\n");
    clock += 1000;
    input(mounted, "insertText", "q");
    clock += 1000;
    input(mounted, "insertText", "r");
    undoKey(mounted);
    assert.equal(view.getState().doc, "alphaxab\n");
    view.destroy();
  } finally {
    Date.now = now;
    mounted.restore();
  }
});

test("a queued character still joins the run the next key ends", () => {
  const mounted = mountEditor();
  const transport = holdingTransport();
  try {
    const view = createEditor(mounted.root, "alpha\n", 5, transport);
    input(mounted, "insertText", "x");
    input(mounted, "insertText", "y");
    keyDown(mounted, "Backspace");
    input(mounted, "deleteContentBackward");
    const edits = transport.sent.filter((message) => message.type === "edit");
    assert.equal(edits.length, 1);
    assert.equal(edits[0].text, "x");
    assert.equal(edits[0].group, undefined);
    assert.equal(edits[0].typing, undefined);
    assert.equal(edits[0].typedAt, undefined);
    transport.deliver(docMessage(1, "alphax\n", 6, "x"));
    const next = transport.sent.filter((message) => message.type === "edit");
    assert.equal(next.length, 2);
    assert.equal(next[1].text, "y");
    assert.equal(next[1].group, true);
    assert.equal(next[1].cursor, 6);
    assert.equal(next[1].typing, undefined);
    assert.equal(transport.sent.some((message) => message.type === "undo" || message.op === "backspace"), false);
    transport.deliver(docMessage(2, "alphaxy\n", 7, "y"));
    const after = transport.sent.filter((message) => message.op === "backspace");
    assert.equal(after.length, 1);
    assert.equal(view.getState().doc, "alphaxy\n");
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("another session's edit in the run's block ends it", () => {
  const mounted = mountEditor();
  const transport = holdingTransport();
  try {
    const view = createEditor(mounted.root, "alpha\n\nbeta\n", 5, transport);
    input(mounted, "insertText", "x");
    transport.deliver({
      type: "doc",
      rev: 1,
      text: "alphax\n\nbeta\n",
      from: 5,
      to: 5,
      inserted: "x",
      actor: "",
      cursor: 6,
      anchor: 6,
    });
    const beta = view.getState().doc.indexOf("beta");
    transport.deliver({
      type: "doc",
      rev: 2,
      text: "alphax\n\nQbeta\n",
      changes: [{ from: beta, to: beta, inserted: "Q" }],
      actor: "other",
      cursor: beta + 1,
      anchor: beta + 1,
    });
    input(mounted, "insertText", "y");
    const joined = transport.sent.filter((message) => message.type === "edit");
    assert.equal(joined.at(-1).text, "y");
    assert.equal(joined.at(-1).group, true);
    transport.deliver({
      type: "doc",
      rev: 3,
      text: "alphaxy\n\nQbeta\n",
      from: 6,
      to: 6,
      inserted: "y",
      actor: "",
      cursor: 7,
      anchor: 7,
    });
    transport.deliver({
      type: "doc",
      rev: 4,
      text: "Qalphaxy\n\nQbeta\n",
      changes: [{ from: 0, to: 0, inserted: "Q" }],
      actor: "other",
      cursor: 1,
      anchor: 1,
    });
    input(mounted, "insertText", "z");
    const split = transport.sent.filter((message) => message.type === "edit");
    assert.equal(split.at(-1).text, "z");
    assert.equal(split.at(-1).group, undefined);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("committed composition joins the typing run", () => {
  const mounted = mountEditor();
  try {
    const view = createEditor(mounted.root, "alpha\n", 5);
    input(mounted, "insertText", "x");
    mounted.listeners.compositionstart();
    mounted.listeners.compositionend({ data: "é" });
    assert.equal(view.getState().doc, "alphaxé\n");
    undoKey(mounted);
    assert.equal(view.getState().doc, "alpha\n");
    assert.equal(view.getState().cursor, 5);
    view.destroy();
  } finally {
    mounted.restore();
  }
});

test("glyph button title is the browser tooltip", () => {
  const mounted = mountTicketPage();
  const page = mounted.root.parentElement;
  const glyph = (button, label) => {
    assert.equal(button.tagName, "BUTTON");
    assert.equal(button.classList.contains("icon-btn"), true);
    assert.equal(button.textContent, "");
    assert.equal(button.getAttribute("aria-label"), label);
    assert.equal(button.getAttribute("title"), label);
  };
  const words = (button) => {
    assert.equal(button.tagName, "BUTTON");
    assert.notEqual(button.textContent, "");
    assert.equal(button.getAttribute("title"), null);
  };
  const labeled = (root, label) => walkNodes(root, (node) => (
    node.tagName === "BUTTON" && typeof node.getAttribute === "function" && node.getAttribute("aria-label") === label
  ));
  try {
    const transport = holdingTransport();
    const doc = "hello {c1}fox{/c1} two deer\n\n```comment c1\n:: 0\nhi\n```\n";
    const view = createEditor(mounted.root, doc, 0, transport);
    glyph(byClass(mounted.nav, "md-new-file")[0], "New file");
    glyph(byClass(mounted.nav, "md-new-ticket")[0], "New ticket");
    glyph(byClass(mounted.nav, "md-ticket-filter")[0], "Filter");
    const trash = byClass(mounted.nav, "md-file-delete")[0];
    glyph(trash, "Delete file");
    trash.disabled = true;
    trash.setAttribute("disabled", "");

    const raw = viewToggleOf(mounted.root);
    glyph(raw, "Raw");
    assert.equal(raw.getAttribute("aria-pressed"), "false");
    assert.equal(slashLine(raw), null);
    raw.disabled = true;
    raw.setAttribute("disabled", "");
    pressViewToggle(mounted.root);
    const eyed = viewToggleOf(mounted.root);
    assert.equal(eyed, raw);
    assert.equal(eyed.getAttribute("aria-pressed"), "true");
    assert.ok(slashLine(eyed));
    assert.equal(eyed.getAttribute("aria-label"), "Raw");
    assert.equal(eyed.getAttribute("title"), "Raw");
    assert.equal(eyed.getAttribute("disabled"), "");
    assert.equal(eyed.disabled, true);
    pressViewToggle(mounted.root);
    assert.equal(viewToggleOf(mounted.root).getAttribute("aria-pressed"), "false");
    assert.equal(viewToggleOf(mounted.root).getAttribute("title"), "Raw");
    assert.equal(viewToggleOf(mounted.root).getAttribute("aria-label"), "Raw");
    assert.equal(slashLine(viewToggleOf(mounted.root)), null);

    const card = byClass(mounted.aside, "md-comment-card")[0];
    const resolve = labeled(card, "Resolve")[0];
    const reply = labeled(card, "Reply")[0];
    const remove = labeled(card, "Delete")[0];
    const link = labeled(card, "Copy link")[0];
    assert.equal(resolve.hidden, true);
    for (const button of [resolve, reply, remove, link]) assert.equal(button.hidden, true);
    glyph(resolve, "Resolve");
    glyph(reply, "Reply");
    glyph(remove, "Delete");
    glyph(link, "Copy link");
    assert.equal(link.classList.contains("md-comment-link"), true);
    reply.listeners.click({ preventDefault() {} });
    const open = byClass(mounted.aside, "md-comment-card")[0];
    glyph(labeled(open, "Resolve")[0], "Resolve");
    glyph(labeled(open, "Reply")[0], "Reply");
    glyph(labeled(open, "Delete")[0], "Delete");
    const links = labeled(open, "Copy link");
    assert.equal(links.length, 2);
    for (const button of links) glyph(button, "Copy link");
    const saves = walkNodes(page, (node) => node.tagName === "BUTTON" && node.textContent === "Save");
    const cancels = walkNodes(page, (node) => node.tagName === "BUTTON" && node.textContent === "Cancel");
    assert.equal(saves.length, 1);
    assert.equal(cancels.length, 1);
    words(saves[0]);
    words(cancels[0]);

    const columns = byClass(mounted.nav, "md-ticket-columns")[0];
    for (const label of ["ID", "Title", "Priority", "Assignee", "State", "Type"]) {
      const button = columns.childNodes.find((node) => node.tagName === "BUTTON" && node.textContent === label);
      words(button);
      assert.equal(button.getAttribute("aria-label"), `Sort by ${label}`);
    }
    words(byClass(mounted.nav, "md-ticket-filter-all")[0]);

    transport.deliver({ type: "docs", files: ["notes/idea.md"] });
    const notes = walkNodes(mounted.nav, (node) => node.tagName === "BUTTON" && node.textContent === "notes")[0];
    words(notes);
    notes.listeners.click({ preventDefault() {} });
    words(walkNodes(mounted.nav, (node) => node.tagName === "BUTTON" && node.textContent === "idea.md")[0]);
    assert.equal(trash.getAttribute("title"), "Delete file");
    assert.equal(trash.getAttribute("disabled"), "");
    assert.equal(viewToggleOf(mounted.root).getAttribute("title"), "Raw");

    const alpha = ticketFixture("aaaaaaaa", "Alpha", "new", T0, "", ["bbbbbbbb"]);
    const bravo = ticketFixture("bbbbbbbb", "Bravo", "new", T1);
    transport.deliver({ type: "tickets", tickets: [alpha, bravo] });
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
    assert.equal(byClass(mounted.aside, "md-comment-card").length, 0);
    const form = byClass(page, "ticket-form")[0];
    const adds = byClass(form, "md-ticket-add");
    const removes = byClass(form, "md-ticket-remove");
    assert.ok(adds.length > 0);
    assert.equal(removes.length, adds.length);
    for (const button of adds) glyph(button, "Add");
    for (const button of removes) glyph(button, "Remove");
    glyph(byClass(form, "md-ticket-pane-menu")[0], "Menu");
    glyph(byClass(form, "md-ticket-copy-id")[0], "Copy ticket id");
    const panel = byClass(form, "md-ticket-pane-panel")[0];
    words(panel.childNodes.find((node) => node.tagName === "BUTTON" && node.textContent === "Copy link"));
    words(panel.childNodes.find((node) => node.tagName === "BUTTON" && node.textContent === "Delete ticket"));
    assert.equal(walkNodes(page, (node) => node.getAttribute && node.getAttribute("role") === "tooltip").length, 0);
    assert.equal(trash.getAttribute("title"), "Delete file");
    assert.equal(trash.disabled, true);
    assert.equal(viewToggleOf(mounted.root).getAttribute("title"), "Raw");
    assert.equal(viewToggleOf(mounted.root).getAttribute("aria-label"), "Raw");
    view.destroy();
  } finally {
    mounted.restore();
  }
});
