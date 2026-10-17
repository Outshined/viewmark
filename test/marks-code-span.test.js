import test from "node:test";
import assert from "node:assert/strict";
import { plan } from "../src/doc.js";

// Ticket um5jawr3: a strong or emphasis pair with an inline code span between its markers paints
// the words on both sides as bold or italic, keeps the code span as code, and hides the markers
// when the caret is off the line. Each source is drawn with the caret on a line above it.

function drawn(source) {
  const text = `x\n\n${source}\n`;
  const line = plan(text, 0).lines.find((item) => (item.runs || []).some((run) => run.text.includes("before") || run.text.includes("bar") || run.text.includes("returns")));
  assert.ok(line, `no line drawn for ${JSON.stringify(source)}`);
  return line.runs;
}

const CASES = [
  ["**`foo` bar**", "md-strong", ["bar"]],
  ["**before `code` after**", "md-strong", ["before", "after"]],
  ["*before `code` after*", "md-em", ["before", "after"]],
  ["__before `code` after__", "md-strong", ["before", "after"]],
  ["_before `code` after_", "md-em", ["before", "after"]],
];

for (const [source, mark, words] of CASES) {
  test(`${source} paints its words with ${mark} on both sides of the code span, and hides its markers (ticket um5jawr3)`, () => {
    const runs = drawn(source);
    const shown = runs.map((run) => run.text).join("");
    assert.equal(/[*_]/.test(shown.replace(/`[^`]*`/g, "")), false, `the markers are drawn: ${JSON.stringify(shown)}`);
    assert.equal(shown.includes("`"), false, `the code markers are drawn: ${JSON.stringify(shown)}`);
    for (const word of words) {
      const run = runs.find((item) => item.text.includes(word));
      assert.ok(run && run.classes.includes(mark), `${word} is drawn with ${JSON.stringify(run && run.classes)}`);
    }
    const code = runs.find((item) => item.classes.includes("md-code"));
    assert.ok(code, "the code span is not drawn as code");
    assert.equal(code.classes.includes(mark), false, "the code span takes the mark");
  });
}

test("**'foo' bar** paints as one strong run with its markers hidden (ticket um5jawr3)", () => {
  const runs = drawn("**'foo' bar**");
  assert.equal(runs.map((run) => run.text).join(""), "'foo' bar");
  for (const run of runs) assert.ok(run.classes.includes("md-strong"), `${JSON.stringify(run.text)} is drawn with ${JSON.stringify(run.classes)}`);
});

test("14. **`vim.js` returns an offset only for a motion the string can answer.** paints the sentence bold and the code span as code (ticket um5jawr3)", () => {
  const source = "14. **`vim.js` returns an offset only for a motion the string can answer.**";
  const runs = drawn(source);
  const shown = runs.map((run) => run.text).join("");
  assert.equal(shown.includes("*"), false, `the markers are drawn: ${JSON.stringify(shown)}`);
  assert.equal(shown.includes("`"), false, `the code markers are drawn: ${JSON.stringify(shown)}`);
  assert.equal(shown, "vim.js returns an offset only for a motion the string can answer.");
  const code = runs.find((run) => run.classes.includes("md-code"));
  assert.equal(code && code.text, "vim.js");
  assert.deepEqual(code.classes, ["md-code"]);
  const sentence = runs.find((run) => run.text.includes("returns"));
  assert.ok(sentence && sentence.classes.includes("md-strong"), JSON.stringify(sentence && sentence.classes));
});

test("the caret line shows the markers and keeps the mark on both sides of the code span (ticket um5jawr3)", () => {
  const cases = [
    ["**`foo` bar**", "md-strong", "bar"],
    ["**before `code` after**", "md-strong", "before"],
    ["*before `code` after*", "md-em", "after"],
    ["__before `code` after__", "md-strong", "before"],
    ["_before `code` after_", "md-em", "after"],
    ["14. **`vim.js` returns an offset only for a motion the string can answer.**", "md-strong", "returns"],
  ];
  for (const [source, mark, word] of cases) {
    const line = plan(`${source}\n`, 0).lines[0];
    assert.equal(line.raw, true, source);
    assert.equal(line.runs.map((run) => run.text).join(""), source);
    const run = line.runs.find((item) => item.text.includes(word));
    assert.ok(run && run.classes.includes(mark), `${source} ${word} ${JSON.stringify(run && run.classes)}`);
    const code = line.runs.find((item) => item.classes.includes("md-code"));
    assert.ok(code && code.text.includes("`"), `${source} does not show the code span`);
    assert.equal(code.classes.includes(mark), false, source);
  }
});

test("a marker inside the code span does not close the pair (ticket um5jawr3)", () => {
  const runs = drawn("**see `**` before**");
  const shown = runs.map((run) => run.text).join("");
  assert.equal(shown, "see ** before");
  assert.ok(runs.find((run) => run.text.includes("see")).classes.includes("md-strong"));
  assert.ok(runs.find((run) => run.text.includes("before")).classes.includes("md-strong"));
  assert.deepEqual(runs.find((run) => run.classes.includes("md-code")).classes, ["md-code"]);
  assert.equal(runs.find((run) => run.classes.includes("md-code")).text, "**");
});

test("two code spans stay code inside one strong pair (ticket um5jawr3)", () => {
  const runs = drawn("**before `one` and `two` bar**");
  const shown = runs.map((run) => run.text).join("");
  assert.equal(shown, "before one and two bar");
  assert.equal(shown.includes("*"), false);
  const codes = runs.filter((run) => run.classes.includes("md-code"));
  assert.deepEqual(codes.map((run) => run.text), ["one", "two"]);
  for (const word of ["before", "and", "bar"]) {
    const run = runs.find((item) => item.text.includes(word));
    assert.ok(run && run.classes.includes("md-strong") && !run.classes.includes("md-code"), word);
  }
});
