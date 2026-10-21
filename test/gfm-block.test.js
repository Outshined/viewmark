import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { plan } from "../src/doc.js";

function shown(block) {
  return (block.runs || []).map((run) => run.text).join("");
}

function line(doc) {
  const drawn = plan(doc, -1);
  assert.equal(drawn.lines.length, 1);
  return drawn.lines[0];
}

test("a rule is one hr", () => {
  const drawn = plan("---\n", -1);
  assert.equal(drawn.blocks.length, 1);
  assert.equal(drawn.blocks[0].hr, true);
  assert.ok(drawn.blocks[0].classes.includes("md-hr"));
  for (const marker of ["- - -", "* * *", "----", " ---", "--- ", "***", "___"]) {
    const rule = line(`${marker}\n`);
    assert.equal(rule.hr, true, marker);
    assert.ok(rule.classes.includes("md-hr"), marker);
    assert.equal(rule.classes.includes("md-li"), false, marker);
  }
});

test("a tight quote is the quoted text", () => {
  const quote = line(">quoted\n");
  assert.ok(quote.classes.includes("md-quote"));
  assert.equal(shown(quote), "quoted");
  const nested = line(">> inner\n");
  assert.equal(shown(nested), "inner");
  assert.equal(nested.quoteDepth, 2);
  const spaced = line("> > inner\n");
  assert.equal(shown(spaced), "inner");
  assert.equal(spaced.quoteDepth, 2);
  const headed = line("> # Title\n");
  assert.ok(headed.classes.includes("md-quote"));
  assert.ok(headed.classes.includes("md-h1"));
  assert.equal(shown(headed), "Title");
});

test("a longer fence keeps the inner fence", () => {
  const doc = "````\n```\ninner\n```\n````\n";
  const blocks = plan(doc, -1).blocks.filter((block) => block.classes && block.classes.includes("md-codeblock"));
  assert.equal(blocks.length, 1);
  assert.ok(blocks[0].text.includes("inner"));
  assert.ok(blocks[0].text.includes("```"));
  const tilde = plan("~~~\nlet x\n~~~\n", -1).blocks.filter((block) => block.classes && block.classes.includes("md-codeblock"));
  assert.equal(tilde.length, 1);
  assert.equal(tilde[0].text, "let x");
  const indented = plan(" ```\nlet x\n ```\n", -1).blocks.filter((block) => block.classes && block.classes.includes("md-codeblock"));
  assert.equal(indented.length, 1);
  assert.equal(indented[0].text, "let x");
});

test("atx headings strip the marker and a closing run", () => {
  const closed = line("## foo ##\n");
  assert.ok(closed.classes.includes("md-h2"));
  assert.equal(shown(closed), "foo");
  for (const source of ["##\n", "## \n"]) {
    const empty = line(source);
    assert.ok(empty.classes.includes("md-h2"), source);
    assert.equal(shown(empty), "");
  }
  const spaced = line(" # Title\n");
  assert.ok(spaced.classes.includes("md-h1"));
  assert.equal(shown(spaced), "Title");
  const tight = line("#foo\n");
  assert.ok(tight.classes.includes("md-p"));
  assert.equal(shown(tight), "#foo");
});

test("a setext underline is a heading and a lone rule stays a rule", () => {
  const second = plan("Foo\n---\n", -1);
  assert.equal(second.blocks.length, 1);
  assert.ok(second.blocks[0].classes.includes("md-h2"));
  assert.equal(shown(second.blocks[0]), "Foo");
  const first = plan("Foo\n====\n", -1);
  assert.equal(first.blocks.length, 1);
  assert.ok(first.blocks[0].classes.includes("md-h1"));
  assert.equal(shown(first.blocks[0]), "Foo");
  const ruled = plan("Foo\n\n---\n", -1);
  assert.equal(ruled.blocks.length, 3);
  assert.equal(shown(ruled.blocks[0]), "Foo");
  assert.equal(ruled.blocks[1].empty, true);
  assert.equal(ruled.blocks[2].hr, true);
  const item = line("-\n");
  assert.ok(item.classes.includes("md-li"));
  assert.equal(item.hr, undefined);
});

test("four spaces open a code block and a list marker stays a list", () => {
  const code = line("    code\n");
  assert.ok(code.classes.includes("md-codeblock"));
  assert.equal(shown(code), "code");
  const joined = plan("Foo\n    code\n", -1);
  assert.equal(joined.blocks.length, 1);
  assert.ok(joined.blocks[0].classes.includes("md-p"));
  assert.ok(shown(joined.blocks[0]).includes("code"));
  const bullet = plan("    - x\n", 20).lines[0];
  assert.equal(bullet.indent, 4);
  assert.equal(bullet.runs[0].text, "x");
  assert.ok(bullet.classes.includes("md-li"));
});

test("a task is a box and a bare marker is an empty item", () => {
  const checked = line("- [x] done\n");
  assert.ok(checked.classes.includes("md-li"));
  assert.equal(shown(checked), "done");
  assert.equal(checked.task.checked, true);
  const open = line("- [ ] done\n");
  assert.equal(shown(open), "done");
  assert.equal(open.task.checked, false);
  for (const marker of ["-\n", "+\n", "*\n"]) {
    const empty = line(marker);
    assert.ok(empty.classes.includes("md-li"), marker);
    assert.equal(shown(empty), "");
  }
});

test("a blank and an indented block stay inside the item", () => {
  const continued = plan("- item\n\n  more\n", -1);
  const items = continued.blocks.filter((block) => !block.empty);
  assert.equal(items.length, 2);
  assert.ok(items[0].classes.includes("md-li"));
  assert.equal(shown(items[0]), "item");
  assert.ok(items[1].classes.includes("md-in-item"));
  assert.equal(shown(items[1]), "more");
  assert.equal(items[1].classes.includes("md-li"), false);
  const quoted = plan("- item\n  > quoted\n", -1);
  assert.equal(quoted.blocks.length, 2);
  assert.ok(quoted.blocks[1].classes.includes("md-quote"));
  assert.ok(quoted.blocks[1].classes.includes("md-in-item"));
  assert.equal(shown(quoted.blocks[1]), "quoted");
  const fenced = plan("- item\n  ```\n  code\n  ```\n", -1);
  const fence = fenced.blocks.find((block) => block.classes && block.classes.includes("md-codeblock"));
  assert.ok(fence.classes.includes("md-in-item"));
  assert.equal(fence.text, "code");
  const apart = plan("- Alpha\n---\nBeta\n", -1);
  assert.equal(apart.blocks.length, 3);
  assert.equal(apart.blocks[1].hr, true);
  assert.equal(apart.blocks[1].classes.includes("md-in-item"), false);
  const ended = plan("- item\n\n\n  more\n", -1);
  const tail = ended.blocks.filter((block) => shown(block).includes("more"))[0];
  assert.equal(tail.classes.includes("md-in-item"), false);
  assert.ok(tail.classes.includes("md-p"));
});

test("an alert is a box and a footnote is listed", () => {
  const note = plan("> [!NOTE]\n> Look here.\n", -1);
  assert.ok(note.blocks[0].classes.includes("md-alert"));
  assert.ok(note.blocks[0].classes.includes("md-alert-note"));
  assert.equal(note.blocks[0].alertMarker, true);
  assert.equal(shown(note.blocks[0]), "");
  assert.equal(shown(note.blocks[1]), "Look here.");
  assert.ok(note.blocks[1].classes.includes("md-alert-note"));
  const warning = plan("> [!WARNING]\n> Careful.\n", -1);
  assert.ok(warning.blocks[0].classes.includes("md-alert-warning"));
  const extra = line("> [!NOTE] extra\n");
  assert.equal(extra.alertMarker, undefined);
  assert.ok(shown(extra).includes("[!NOTE]"));
  const stopped = plan("> [!NOTE]\n> One.\n\n> [!TIP]\n> Two.\n", -1);
  const tips = stopped.blocks.filter((block) => block.classes && block.classes.includes("md-alert-tip"));
  assert.ok(tips.length >= 1);
  assert.equal(tips[0].classes.includes("md-alert-note"), false);
  const noted = plan("A word.\n\n[^1]: The note.\n", -1);
  assert.deepEqual(noted.footnotes, [{ id: "1", text: "The note." }]);
  assert.equal(noted.blocks.some((block) => shown(block).includes("[^1]:")), false);
  const kept = plan("Foo\n[^1]: The note.\n", -1);
  assert.equal(kept.blocks.length, 1);
  assert.deepEqual(kept.footnotes, []);
  assert.ok(shown(kept.blocks[0]).includes("[^1]:"));
});

test("a link reference is only a ref", () => {
  const defined = plan("[Foo Bar]: </url> \"title\"\n", -1);
  assert.deepEqual(defined.refs, [{ label: "foo bar", url: "/url", title: "title" }]);
  assert.equal(defined.blocks.filter((block) => !block.empty).length, 0);
  const titled = plan("[bar]: /url\n\"next\"\nSee.\n", -1);
  assert.deepEqual(titled.refs, [{ label: "bar", url: "/url", title: "next" }]);
  assert.equal(shown(titled.blocks.find((block) => !block.empty)), "See.");
  const inside = plan("Foo\n[bar]: /url\n", -1);
  assert.equal(inside.blocks.length, 1);
  assert.deepEqual(inside.refs, []);
  assert.ok(shown(inside.blocks[0]).includes("[bar]:"));
});

test("note and warning are styled boxes", () => {
  const css = readFileSync(new URL("../editor.css", import.meta.url), "utf8");
  assert.match(css, /\.md-line\.md-alert-note\s*\{[^}]*border-left-color:/);
  assert.match(css, /\.md-line\.md-alert-warning\s*\{[^}]*border-left-color:/);
  assert.match(css, /\.md-task\s*\{[^}]*width:\s*1em;/);
  assert.match(css, /\.md-footnotes\s*\{/);
});
