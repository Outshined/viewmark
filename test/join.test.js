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

test("typing on the line under a list item stays on that line", () => {
  const bullet = insert(createState("- item\nmore\n", 7), "X");
  assert.equal(bullet.doc, "- item\n\nXmore\n");
  const ordered = insert(createState("1. item\nmore\n", 8), "X");
  assert.equal(ordered.doc, "1. item\n\nXmore\n");
  const drawn = plan(bullet.doc, bullet.cursor);
  const item = drawn.blocks.find((block) => block.text.includes("item"));
  const typed = drawn.blocks.find((block) => block.text.includes("Xmore"));
  assert.notEqual(item, typed);
});

test("typing on the line under a quote stays on that line", () => {
  const next = insert(createState("> said\nmore\n", 7), "X");
  assert.equal(next.doc, "> said\n\nXmore\n");
  const drawn = plan(next.doc, next.cursor);
  const quote = drawn.blocks.find((block) => block.text.includes("said"));
  const typed = drawn.blocks.find((block) => block.text.includes("Xmore"));
  assert.notEqual(quote, typed);
});
