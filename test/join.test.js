import test from "node:test";
import assert from "node:assert/strict";
import { createState, insert, plan } from "../src/doc.js";

test("typing on the line under a paragraph stays on that line", () => {
  const next = insert(createState("hello\n\n", 6), "world");
  assert.equal(next.doc, "hello\n\nworld\n");
  const drawn = plan(next.doc, next.cursor);
  const hello = drawn.blocks.find((block) => block.text.includes("hello"));
  const world = drawn.blocks.find((block) => block.text.includes("world"));
  assert.notEqual(hello, world);
});

test("typing inside a paragraph does not split it", () => {
  const next = insert(createState("hello\n\n", 2), "X");
  assert.equal(next.doc, "heXllo\n\n");
});

test("typing at the start of a rule stays off the paragraph above", () => {
  const next = insert(createState("hello\n---\n", 6), "x");
  assert.equal(next.doc, "hello\n\nx---\n");
});

test("typing before a heading marker stays on that line", () => {
  const next = insert(createState("- a\n# Next\n", 4), "Q");
  assert.equal(next.doc, "- a\nQ# Next\n");
  assert.equal(next.cursor, 5);
  const drawn = plan(next.doc, next.cursor);
  const prose = drawn.blocks.filter((block) => !block.empty);
  assert.equal(prose.length, 2);
  assert.equal(prose[0].text.includes("Q"), false);
  assert.equal(prose[1].text.startsWith("Q# Next"), true);

  const word = plan("- a\nHello# Next\n", 0);
  const wordBlocks = word.blocks.filter((block) => !block.empty);
  assert.equal(wordBlocks.length, 2);
  assert.equal(wordBlocks[0].text.includes("Hello"), false);
  assert.equal(wordBlocks[1].text.includes("Hello# Next"), true);

  const under = plan("one\nQ# Next\n", 0);
  const underBlocks = under.blocks.filter((block) => !block.empty);
  assert.equal(underBlocks.length, 2);
  assert.equal(underBlocks[0].text.includes("Q"), false);
});

test("typing at the start of a continuation stays in that block", () => {
  const next = insert(createState("alpha\nbeta\n", 6), "x");
  assert.equal(next.doc, "alpha\nxbeta\n");
  const drawn = plan(next.doc, next.cursor);
  const prose = drawn.blocks.filter((block) => !block.empty);
  assert.equal(prose.length, 1);
  assert.equal(prose[0].text, "alpha xbeta");
});

test("typing on a list continuation stays in that block", () => {
  const bullet = insert(createState("- item\nmore\n", 7), "X");
  assert.equal(bullet.doc, "- item\nXmore\n");
  const ordered = insert(createState("1. item\nmore\n", 8), "X");
  assert.equal(ordered.doc, "1. item\nXmore\n");
  const drawn = plan(bullet.doc, bullet.cursor);
  const prose = drawn.blocks.filter((block) => !block.empty);
  assert.equal(prose.length, 1);
  assert.equal(prose[0].text.includes("item"), true);
  assert.equal(prose[0].text.includes("Xmore"), true);
});

test("typing on a quote continuation stays in that block", () => {
  const next = insert(createState("> said\nmore\n", 7), "X");
  assert.equal(next.doc, "> said\nXmore\n");
  const drawn = plan(next.doc, next.cursor);
  const prose = drawn.blocks.filter((block) => !block.empty);
  assert.equal(prose.length, 1);
  assert.equal(prose[0].text.includes("said"), true);
  assert.equal(prose[0].text.includes("Xmore"), true);
});

test("a paste on the line under a paragraph stays on that line", () => {
  const next = insert(createState("hello\n\n", 6), "a\nb");
  assert.equal(next.doc, "hello\n\na\nb\n");
  const drawn = plan(next.doc, next.cursor);
  const hello = drawn.blocks.find((block) => block.text.includes("hello"));
  const pasted = drawn.blocks.find((block) => block.start === next.doc.indexOf("a"));
  assert.notEqual(hello, pasted);

  const paired = insert(createState("hello\r\n\r\n", 7), "a\r\nb");
  assert.equal(paired.doc, "hello\r\n\r\na\r\nb\r\n");
  const pairedPlan = plan(paired.doc, paired.cursor);
  const pairedHello = pairedPlan.blocks.find((block) => block.text.includes("hello"));
  const pairedA = pairedPlan.blocks.find((block) => block.start === paired.doc.indexOf("a"));
  assert.notEqual(pairedHello, pairedA);

  const kept = insert(createState("hello\n\n", 6), "\nZ");
  assert.equal(kept.doc, "hello\n\nZ\n");
});

test("a paste on a quote continuation stays in that block", () => {
  const next = insert(createState("> said\nmore\n", 7), "a\nb");
  assert.equal(next.doc, "> said\na\nbmore\n");
  const drawn = plan(next.doc, next.cursor);
  const prose = drawn.blocks.filter((block) => !block.empty);
  assert.equal(prose.length, 1);
  assert.equal(prose[0].text.includes("said"), true);
  assert.equal(prose[0].text.includes("a"), true);
});

test("a paste on a gap line stays off the paragraph above", () => {
  const next = insert(createState("one\n\ntwo\n", 4), "a\nb");
  assert.equal(next.doc, "one\n\na\nb\ntwo\n");
  const drawn = plan(next.doc, next.cursor);
  const one = drawn.blocks.find((block) => block.text.includes("one"));
  const pasted = drawn.blocks.find((block) => block.start === next.doc.indexOf("a"));
  assert.notEqual(one, pasted);
  assert.equal(one.text.includes("a"), false);
});

test("a paste on a list continuation stays in that block", () => {
  const next = insert(createState("- item\nmore\n", 7), "a\nb");
  assert.equal(next.doc, "- item\na\nbmore\n");
  const drawn = plan(next.doc, next.cursor);
  const prose = drawn.blocks.filter((block) => !block.empty);
  assert.equal(prose.length, 1);
  assert.equal(prose[0].text.includes("item"), true);
  assert.equal(prose[0].text.includes("a"), true);
});

test("CB.5 pasting list items on the empty line under a list stays one list", () => {
  const doc = "- a\n- b\n\n";
  const caret = doc.length - 1;
  const pasted = insert(createState(doc, caret), "- a\n- b", true);
  assert.equal(pasted.doc, "- a\n- b\n- a\n- b\n");
  assert.equal(pasted.cursor, "- a\n- b\n- a\n- b".length);

  const crlf = "- a\r\n- b\r\n\r\n";
  const paired = insert(createState(crlf, crlf.length - 2), "- a\r\n- b", true);
  assert.equal(paired.doc, "- a\r\n- b\r\n- a\r\n- b\r\n");

  const typed = insert(createState(doc, caret), "x");
  assert.equal(typed.doc, "- a\n- b\n\nx\n");

  const notPaste = insert(createState(doc, caret), "- a\n- b");
  assert.equal(notPaste.doc, "- a\n- b\n\n- a\n- b\n");

  const prose = insert(createState(doc, caret), "a\nb", true);
  assert.equal(prose.doc, "- a\n- b\n\na\nb\n");

  const under = insert(createState("hello\n\n", 6), "- a", true);
  assert.equal(under.doc, "hello\n- a\n");
});

test("typing on the line after a hard break stays in that block", () => {
  const paragraph = insert(createState("hello\\\n\n", 7), "x");
  assert.equal(paragraph.doc, "hello\\\nx\n");
  const drawn = plan(paragraph.doc, paragraph.cursor);
  const prose = drawn.blocks.filter((block) => !block.empty);
  assert.equal(prose.length, 1);
  assert.equal(prose[0].text.includes("hello"), true);
  assert.equal(prose[0].text.includes("x"), true);

  const item = insert(createState("- alpha\\\n\n", 9), "x");
  assert.equal(item.doc, "- alpha\\\nx\n");
  const itemDrawn = plan(item.doc, item.cursor).blocks.filter((block) => !block.empty);
  assert.equal(itemDrawn.length, 1);
  assert.equal(itemDrawn[0].text.includes("alpha"), true);
  assert.equal(itemDrawn[0].text.includes("x"), true);

  const spaces = insert(createState("red  \n\n", 6), "x");
  assert.equal(spaces.doc, "red  \nx\n");

  const paired = insert(createState("hello\\\r\n\r\n", 8), "x");
  assert.equal(paired.doc, "hello\\\r\nx\r\n");
});
