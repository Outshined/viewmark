import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commentThreads, plan } from "../src/doc.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The sentences a reader needs for the parts that are not stock vim.
const VIM_FACTS = [
  "The document menu item Vim keys is off until it is checked.",
  "stores it as `viewmark.vim`",
  "A vim line in the formatted view is a rendered block.",
  "`gc` comments the highlight.",
  "Ctrl-Enter or Command-Enter saves the note and returns to normal.",
  "`y` and `p` use one unnamed register, which is not the clipboard.",
  "Ctrl-V pastes the clipboard.",
  "Search text is literal, and the hits are not drawn.",
  "There is no visual-block mode.",
  "`.` does not repeat a change.",
  "In normal, `U` changes nothing.",
];

function fenceCount(text) {
  return text.split("\n").filter((line) => line.startsWith("```")).length;
}

async function read(rel) {
  return fs.readFile(path.join(root, rel), "utf8");
}

function assertFacts(rel, text) {
  for (const fact of VIM_FACTS) {
    assert.ok(text.includes(fact), `${rel} is missing ${JSON.stringify(fact)}`);
  }
}

function assertHeadingTight(rel, text, heading) {
  const lines = text.split("\n");
  const at = lines.indexOf(heading);
  assert.ok(at >= 0, `${rel} has no ${heading}`);
  assert.notEqual(lines[at + 1], "", `${rel} puts a blank line under ${heading}`);
}

test("starter docs, project docs, and the README cover vim keys", async () => {
  const readme = await read("README.md");
  const welcome = await read("samples/welcome.md");
  const seed = await read("samples/tickets/seedmark.md");
  const editing = await read("samples/editing.md");
  const architecture = await read("samples/ARCHITECTURE.md");
  const agents = await read("AGENTS.md");

  for (const [rel, text] of [
    ["README.md", readme],
    ["samples/welcome.md", welcome],
    ["samples/tickets/seedmark.md", seed],
    ["samples/editing.md", editing],
  ]) {
    assertFacts(rel, text);
    assert.equal(fenceCount(text) % 2, 0, `${rel} has an open fence`);
    assert.ok(plan(text).blocks.length > 0, `${rel} does not plan`);
  }

  assert.ok(readme.includes("## Vim keys"), "README heading");
  assert.equal(readme.split("\n")[readme.split("\n").indexOf("## Vim keys") + 1], "");
  assertHeadingTight("samples/welcome.md", welcome, "## Vim keys");
  assertHeadingTight("samples/tickets/seedmark.md", seed, "## Vim keys");
  assertHeadingTight("samples/editing.md", editing, "### Vim keys");
  assert.ok(seed.includes("A ticket body uses these same keys."), "seedmark ticket sentence");

  assert.equal(commentThreads(welcome).map((item) => item.id).join(","), "c1");
  assert.equal(commentThreads(seed).length, 0);
  assert.equal(
    commentThreads(editing).map((item) => item.id).join(","),
    "c1,c2,c3,c4,c5,c6,c7,c8,c9,c10,c11,c12,c13,c14",
  );

  assertHeadingTight("samples/ARCHITECTURE.md", architecture, "### Vim keys");
  for (const fact of [
    "The document menu item Vim keys is off until it is checked.",
    "`viewmark.vim`",
    "`src/vim.js`",
    "`gc` comments the highlight.",
    "A vim line in the formatted view is a rendered block.",
    "`y` and `p` use one unnamed register, which is not the clipboard.",
    "Ctrl-V pastes the clipboard.",
    "Search text is literal, and the hits are not drawn.",
    "editing.md",
  ]) {
    assert.ok(architecture.includes(fact), `ARCHITECTURE.md is missing ${JSON.stringify(fact)}`);
  }
  assert.equal(commentThreads(architecture).map((item) => item.id).join(","), "c1");
  assert.equal(fenceCount(architecture) % 2, 0);
  assert.ok(plan(architecture).blocks.length > 0);

  assert.ok(agents.includes("`src/vim.js`"), "AGENTS.md does not name vim.js");
  assert.ok(agents.includes("`gc` comments the highlight."), "AGENTS.md does not cover gc");
});
