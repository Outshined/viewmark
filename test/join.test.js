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
