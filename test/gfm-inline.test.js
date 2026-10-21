import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { codeSpanAt, parseInlines, plan } from "../src/doc.js";

function textOf(line) {
  return (line.runs || []).map((run) => run.text).join("");
}

function off(source) {
  const doc = source.endsWith("\n") ? source : `${source}\n`;
  const lines = plan(doc, doc.length).lines.filter((line) => !line.empty);
  assert.equal(lines.length, 1, source);
  assert.equal(lines[0].raw, false, source);
  return lines[0];
}

function has(line, name) {
  return (line.runs || []).some((run) => run.classes.includes(name));
}

test("_foo_ underlines and *foo* is emphasis", () => {
  const under = off("_foo_");
  assert.equal(textOf(under), "foo");
  assert.ok(under.runs[0].classes.includes("md-u"));
  assert.equal(under.runs[0].classes.includes("md-em"), false);

  const em = off("*foo*");
  assert.equal(textOf(em), "foo");
  assert.ok(em.runs[0].classes.includes("md-em"));
  assert.equal(em.runs[0].classes.includes("md-u"), false);

  assert.deepEqual(off("__foo__").runs[0].classes, ["md-strong"]);
  const underStrong = off("___foo___");
  assert.equal(textOf(underStrong), "foo");
  assert.ok(underStrong.runs[0].classes.includes("md-strong"));
  assert.ok(underStrong.runs[0].classes.includes("md-u"));
  assert.equal(underStrong.runs[0].classes.includes("md-em"), false);
  assert.deepEqual(off("***foo***").runs[0].classes, ["md-strong", "md-em"]);
});

test("intraword underscores and spaced asterisks stay literal", () => {
  for (const source of ["foo_bar_baz", "use_a_name"]) {
    const line = off(source);
    assert.equal(textOf(line), source);
    assert.equal(has(line, "md-em"), false);
    assert.equal(has(line, "md-u"), false);
  }
  const stars = off("see * foo * now");
  assert.equal(textOf(stars), "see * foo * now");
  assert.equal(has(stars, "md-em"), false);
  const direct = parseInlines("* foo *", 0, "md-p", true);
  assert.equal(direct.runs.map((run) => run.text).join(""), "* foo *");
  assert.equal(direct.runs.some((run) => run.classes.includes("md-em")), false);
});

test("a backslash escapes ASCII punctuation only", () => {
  const escaped = off("\\*not em\\*");
  assert.equal(textOf(escaped), "*not em*");
  assert.equal(has(escaped, "md-em"), false);
  assert.equal(has(escaped, "md-u"), false);
  assert.equal(textOf(off("\\a")), "\\a");
  assert.equal(textOf(off("a\\\\b")), "a\\b");
});

test("strikethrough is one or two tildes and can cross a soft break", () => {
  const gone = off("~~gone~~");
  assert.equal(textOf(gone), "gone");
  assert.ok(gone.runs[0].classes.includes("md-strike"));

  const there = off("~there~");
  assert.equal(textOf(there), "there");
  assert.ok(there.runs[0].classes.includes("md-strike"));

  const not = off("~~~not~~~");
  assert.equal(textOf(not), "~~~not~~~");
  assert.equal(has(not, "md-strike"), false);

  const doc = "~~one\ntwo~~\n";
  const joined = plan(doc, doc.length).lines.filter((line) => !line.empty);
  assert.equal(joined.length, 1);
  assert.equal(textOf(joined[0]), "one two");
  assert.ok(joined[0].runs.filter((run) => run.text.trim()).every((run) => run.classes.includes("md-strike")));

  const blank = "~~one\n\ntwo~~\n";
  const lines = plan(blank, blank.length).lines.filter((line) => !line.empty);
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.equal(has(line, "md-strike"), false);
    assert.ok(textOf(line).includes("~"));
  }
});

test("code spans match backtick length and turn a newline into a space", () => {
  const one = off("`ab`");
  assert.equal(textOf(one), "ab");
  assert.deepEqual(one.runs.find((run) => run.classes.includes("md-code")).classes, ["md-code"]);

  const inner = off("`` a ` b ``");
  assert.equal(textOf(inner), "a ` b");
  assert.ok(inner.runs.every((run) => run.classes.includes("md-code")));

  const doc = "`foo\nbar`\n";
  const joined = plan(doc, doc.length).lines.filter((line) => !line.empty);
  assert.equal(joined.length, 1);
  assert.equal(textOf(joined[0]), "foo bar");
  assert.ok(joined[0].runs.every((run) => run.classes.includes("md-code")));
  assert.equal(joined[0].runs.some((run) => run.classes.includes("md-em")), false);

  const kept = off("`&amp;`");
  assert.equal(textOf(kept), "&amp;");
  assert.ok(kept.runs[0].classes.includes("md-code"));
});

test("a link title stays off the href and an image title stays off the url", () => {
  const link = off('[foo](http://x.com "title")');
  const run = link.runs.find((item) => item.href);
  assert.equal(run.text, "foo");
  assert.equal(run.href, "http://x.com");
  const raw = plan('[foo](http://x.com "title")\n', 0).lines[0];
  assert.equal(textOf(raw), '[foo](http://x.com "title")');
  assert.equal(raw.runs.find((item) => item.href).href, "http://x.com");

  const doc = '![alt](pic.png "title")\n';
  const image = plan(doc, doc.length).atoms.find((atom) => atom.type === "image");
  assert.equal(image.url, "pic.png");
  assert.equal(image.alt, "alt");
});

test("autolinks, extended autolinks, and entities", () => {
  const uri = off("<http://example.com>");
  assert.equal(textOf(uri), "http://example.com");
  assert.equal(uri.runs.find((run) => run.href).href, "http://example.com");

  const mail = off("<ada@example.com>");
  assert.equal(textOf(mail), "ada@example.com");
  assert.equal(mail.runs.find((run) => run.href).href, "mailto:ada@example.com");

  const www = off("www.example.com");
  assert.equal(www.runs.find((run) => run.href).href, "http://www.example.com");
  assert.equal(www.runs.find((run) => run.href).text, "www.example.com");

  const https = off("https://example.com");
  assert.equal(https.runs.find((run) => run.href).href, "https://example.com");

  const bare = off("ada@example.com");
  assert.equal(bare.runs.find((run) => run.href).href, "mailto:ada@example.com");

  const trimmed = off("https://example.com.");
  assert.equal(trimmed.runs.find((run) => run.href).href, "https://example.com");
  assert.ok(textOf(trimmed).endsWith("."));

  assert.equal(textOf(off("a&amp;b")), "a&b");
  assert.equal(textOf(off("&#35;")), "#");
  assert.equal(textOf(off("&#x23;")), "#");
  assert.equal(textOf(off("<em>hi</em>")), "<em>hi</em>");
  assert.equal(has(off("<em>hi</em>"), "md-em"), false);
});

test("reference links resolve only when refs are passed, and a footnote is stored", () => {
  const refs = [
    { label: "foo", url: "http://x.com", title: "t" },
    { label: "pic", url: "pic.png", title: "" },
  ];
  const link = parseInlines("[foo]", 0, "md-p", true, refs);
  assert.equal(link.runs[0].text, "foo");
  assert.equal(link.runs[0].href, "http://x.com");
  const image = parseInlines("![alt][pic]", 0, "md-p", true, refs);
  assert.equal(image.images[0].url, "pic.png");
  assert.equal(image.images[0].alt, "alt");

  const plain = parseInlines("[foo]", 0, "md-p", true);
  assert.equal(plain.runs.map((run) => run.text).join(""), "[foo]");
  assert.equal(plain.runs.some((run) => run.href), false);
  assert.equal(plain.images.length, 0);

  const doc = "[foo]: http://x.com\n\nsee [foo]\n";
  const seen = plan(doc, doc.length).lines.filter((line) => !line.empty);
  const hit = seen.find((line) => line.runs.some((run) => run.href === "http://x.com" && run.text === "foo"));
  assert.ok(hit);

  const pictured = "[pic]: pic.png\n\n![alt][pic]\n";
  const drawn = plan(pictured, pictured.length).atoms.find((atom) => atom.type === "image");
  assert.equal(drawn.url, "pic.png");

  const note = parseInlines("see [^id] now", 0, "md-p", true);
  const foot = note.parts.find((part) => part.type === "footnote");
  assert.deepEqual({ id: foot.id, start: foot.start, end: foot.end }, { id: "id", start: 4, end: 9 });
  assert.equal(note.runs.map((run) => run.text).join(""), "see  now");
  const hidden = off("see [^id] now");
  assert.equal(textOf(hidden).includes("[^id]"), false);
  assert.equal(textOf(hidden).includes("see"), true);
  assert.equal(textOf(hidden).includes("now"), true);
});

test("codeSpanAt uses the matching backtick run", () => {
  assert.deepEqual(codeSpanAt("a `code` b", 4), { open: 2, close: 7, start: 3, end: 7 });
  assert.deepEqual(codeSpanAt("``a`b``", 6), { open: 0, close: 5, start: 2, end: 5 });
  assert.equal(codeSpanAt("``a`b``", 7), null);
  assert.equal(codeSpanAt("``", 0), null);
});

test("underline is its own rule", () => {
  const css = readFileSync(new URL("../editor.css", import.meta.url), "utf8");
  assert.match(css, /\.md-em\s*\{[^}]*font-style:\s*italic;/);
  assert.match(css, /\.md-u\s*\{[^}]*text-decoration:\s*underline;/);
});
