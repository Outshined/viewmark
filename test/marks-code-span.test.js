import test from "node:test";
import assert from "node:assert/strict";
import { plan } from "../src/doc.js";

// Ticket um5jawr3: a strong or emphasis pair with an inline code span between its markers paints
// the words on both sides as bold or italic, keeps the code span as code, and hides the markers
// when the caret is off the line. Each source is drawn with the caret on a line above it.
const TODO = "ticket um5jawr3: at 835db94 the markers stay visible and the words are plain";

function drawn(source) {
  const text = `x\n\n${source}\n`;
  const line = plan(text, 0).lines.find((item) => (item.runs || []).some((run) => run.text.includes("before") || run.text.includes("bar")));
  assert.ok(line, `no line drawn for ${JSON.stringify(source)}`);
  return line.runs;
}

const CASES = [
  ["**`foo` bar**", "md-strong", ["bar"]],
  ["**before `code` after**", "md-strong", ["before", "after"]],
  ["*before `code` after*", "md-em", ["before", "after"]],
  ["__before `code` after__", "md-strong", ["before", "after"]],
];

for (const [source, mark, words] of CASES) {
  test(`${source} paints its words with ${mark} on both sides of the code span, and hides its markers (ticket um5jawr3)`, { todo: TODO }, () => {
    const runs = drawn(source);
    const shown = runs.map((run) => run.text).join("");
    assert.equal(/[*_]/.test(shown.replace(/`[^`]*`/g, "")), false, `the markers are drawn: ${JSON.stringify(shown)}`);
    for (const word of words) {
      const run = runs.find((item) => item.text.includes(word));
      assert.ok(run && run.classes.includes(mark), `${word} is drawn with ${JSON.stringify(run && run.classes)}`);
    }
    const code = runs.find((item) => item.classes.includes("md-code"));
    assert.ok(code, "the code span is not drawn as code");
  });
}

test("**'foo' bar** paints as one strong run with its markers hidden (ticket um5jawr3)", () => {
  const runs = drawn("**'foo' bar**");
  assert.equal(runs.map((run) => run.text).join(""), "'foo' bar");
  for (const run of runs) assert.ok(run.classes.includes("md-strong"), `${JSON.stringify(run.text)} is drawn with ${JSON.stringify(run.classes)}`);
});
