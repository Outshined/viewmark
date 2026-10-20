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

function classesOf(line) {
  return line.runs.map((run) => ({ t: run.text, c: run.classes }));
}

// A closed ~~ pair hides its tildes off the cursor line. The cursor line, an
// unclosed pair, a code span, and a fence keep the tildes, and a pair stays on
// one source line.
test("a closed ~~ pair strikes off the cursor line and the cursor line keeps the tildes", () => {
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
    assert.equal(struck(raw), false, marks);
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
  assert.equal(shown(paragraph), "gone");
  const gone = paragraph.runs.find((run) => run.text === "gone");
  assert.ok(gone && gone.classes.includes("md-strike"));
  assert.equal(para.slice(gone.start, gone.end), "gone");
  assert.ok(para.includes("~~gone~~"));
  const onPara = plan(para, 0).lines[0];
  assert.equal(onPara.raw, true);
  assert.equal(shown(onPara), "~~gone~~");
  assert.equal(struck(onPara), false);

  const openPara = plan("~~gone\n", "~~gone\n".length).lines[0];
  assert.equal(shown(openPara), "~~gone");
  assert.equal(struck(openPara), false);

  const codePara = "`~~gone~~`\n";
  const codeLine = plan(codePara, codePara.length).lines[0];
  assert.equal(shown(codeLine), "~~gone~~");
  assert.equal(struck(codeLine), false);
  const paraCode = codeLine.runs.find((run) => run.classes.includes("md-code"));
  assert.equal(paraCode.text, "~~gone~~");
  assert.equal(paraCode.classes.includes("md-strike"), false);

  const bullet = "- ~~**G8. Landing.** see `master` now.~~\n";
  const item = plan(bullet, bullet.length).lines[0];
  assert.equal(item.raw, false);
  assert.ok(item.classes.includes("md-li"));
  assert.deepEqual(classesOf(item), [
    { t: "G8. Landing.", c: ["md-strike", "md-strong"] },
    { t: " see ", c: ["md-strike"] },
    { t: "master", c: ["md-strike", "md-code"] },
    { t: " now.", c: ["md-strike"] },
  ]);
  assert.equal(bullet.slice(item.runs[2].start, item.runs[2].end), "master");
  assert.ok(bullet.includes("~~"));
  const onBullet = plan(bullet, 0).lines[0];
  assert.equal(onBullet.raw, true);
  assert.ok(shown(onBullet).includes("~~**G8. Landing.** see `master` now.~~"));
  assert.equal(struck(onBullet), false);

  const ordered = "1. ~~one~~\n";
  const ol = plan(ordered, ordered.length).lines[0];
  assert.equal(ol.raw, false);
  assert.ok(ol.classes.includes("md-ol"));
  assert.equal(shown(ol), "one");
  assert.ok(ol.runs[0].classes.includes("md-strike"));
  assert.equal(ordered.slice(ol.runs[0].start, ol.runs[0].end), "one");
  const onOl = plan(ordered, 0).lines[0];
  assert.equal(onOl.raw, true);
  assert.ok(shown(onOl).includes("~~one~~"));
  assert.equal(struck(onOl), false);

  const quoteDoc = "> ~~one~~\n";
  const quote = plan(quoteDoc, quoteDoc.length).lines[0];
  assert.equal(quote.raw, false);
  assert.ok(quote.classes.includes("md-quote"));
  assert.equal(shown(quote), "one");
  assert.ok(quote.runs[0].classes.includes("md-strike"));
  const onQuote = plan(quoteDoc, 0).lines[0];
  assert.equal(onQuote.raw, true);
  assert.ok(shown(onQuote).includes("~~one~~"));
  assert.equal(struck(onQuote), false);

  const task = "- [ ] ~~gone~~\n";
  const box = plan(task, task.length).lines[0];
  assert.equal(box.raw, false);
  assert.deepEqual(classesOf(box), [
    { t: "[ ] ", c: ["md-li"] },
    { t: "gone", c: ["md-strike"] },
  ]);
  assert.equal(task.slice(box.runs[1].start, box.runs[1].end), "gone");

  const emDoc = "~~*one*~~\n";
  const em = plan(emDoc, emDoc.length).lines[0];
  assert.equal(shown(em), "one");
  assert.ok(em.runs[0].classes.includes("md-em"));
  assert.ok(em.runs[0].classes.includes("md-strike"));

  const table = "| h |\n| --- |\n| ~~gone~~ |\n";
  const atom = plan(table, table.length).atoms.find((block) => block.type === "table");
  assert.ok(atom, "the table is not drawn");
  const cell = atom.rows[0][0];
  assert.equal(cell.parts.map((part) => part.text).join(""), "gone");
  assert.ok(cell.parts[0].classes.includes("md-strike"));
  assert.equal(table.slice(cell.parts[0].start, cell.parts[0].end), "gone");
  assert.equal(table.slice(cell.parts[0].start - 2, cell.parts[0].end + 2), "~~gone~~");
  const inside = plan(table, table.indexOf("~~")).lines.find((line) => line.raw);
  assert.ok(inside);
  assert.ok(shown(inside).includes("~~gone~~"));
  assert.equal(struck(inside), false);

  const fence = "```\n~~gone~~\n```\n";
  const body = plan(fence, fence.length).lines[0];
  assert.equal(shown(body), "~~gone~~");
  assert.equal(struck(body), false);
  assert.ok(body.classes.includes("md-codeblock"));

  const split = "~~one\nstill~~\n";
  const joined = plan(split, split.length).lines;
  assert.equal(joined.length, 1);
  assert.equal(struck(joined[0]), false);
  assert.ok(shown(joined[0]).includes("~~one"));
  assert.ok(shown(joined[0]).includes("still~~"));

  const css = readFileSync(new URL("../editor.css", import.meta.url), "utf8");
  assert.match(css, /\.md-strike\s*\{[^}]*text-decoration:\s*line-through;/);
});
