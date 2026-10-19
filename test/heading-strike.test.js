import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { plan } from "../src/doc.js";

function shown(line) {
  return line.runs.map((run) => run.text).join("");
}

function struck(line) {
  return line.runs.some((run) => run.classes.includes("md-strike"));
}

// Ticket 3wvczcz4. A closed ~~ pair in a heading hides the tildes and strikes the
// interior. An unclosed pair, a pair inside a code span, and a paragraph keep the tildes.
test("a heading strikes a closed ~~ pair and leaves the other tildes drawn (ticket 3wvczcz4)", () => {
  for (let level = 1; level <= 6; level += 1) {
    const marks = "#".repeat(level);
    const doc = `${marks} ~~retired~~\n`;
    const line = plan(doc, doc.length).lines[0];
    assert.equal(line.raw, false, marks);
    assert.ok(line.classes.includes(`md-h${level}`), marks);
    assert.equal(shown(line), "retired", marks);
    const run = line.runs.find((item) => item.text.includes("retired"));
    assert.ok(run && run.classes.includes("md-strike"), marks);
    assert.equal(doc.slice(run.start, run.end), "retired", marks);
    assert.ok(doc.includes("~~retired~~"), marks);

    const raw = plan(doc, 0).lines[0];
    assert.equal(raw.raw, true, marks);
    assert.equal(raw.text, `${marks} ~~retired~~`, marks);
    assert.equal(shown(raw), raw.text, marks);
    assert.ok(shown(raw).includes("~~retired~~"), marks);
  }

  const open = plan("# ~~retired\n", "# ~~retired\n".length).lines[0];
  assert.equal(open.raw, false);
  assert.equal(shown(open), "~~retired");
  assert.equal(struck(open), false);
  assert.equal(plan("# ~~retired\n", 0).lines[0].text, "# ~~retired");

  const codeDoc = "# `~~retired~~`\n";
  const code = plan(codeDoc, codeDoc.length).lines[0];
  assert.equal(code.raw, false);
  const codeRun = code.runs.find((run) => run.classes.includes("md-code"));
  assert.ok(codeRun, "the code span is not drawn");
  assert.equal(codeRun.text, "~~retired~~");
  assert.equal(codeRun.classes.includes("md-strike"), false);
  assert.equal(struck(code), false);
  assert.equal(plan(codeDoc, 0).lines[0].text.includes("~~retired~~"), true);

  const para = "~~gone~~\n";
  const paragraph = plan(para, para.length).lines[0];
  assert.equal(paragraph.raw, false);
  assert.ok(paragraph.classes.includes("md-p"));
  assert.equal(shown(paragraph), "~~gone~~");
  assert.equal(struck(paragraph), false);
  assert.equal(shown(plan(para, 0).lines[0]), "~~gone~~");

  const css = readFileSync(new URL("../editor.css", import.meta.url), "utf8");
  assert.match(css, /\.md-strike\s*\{[^}]*text-decoration:\s*line-through;/);
});
