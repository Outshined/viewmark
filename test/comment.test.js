import test from "node:test";
import assert from "node:assert/strict";
import {
  addComment,
  appendCommentReply,
  backspace,
  commentNotes,
  createState,
  deleteForward,
  insert,
  formatCommentNotes,
  parseCommentNotes,
  reviseCommentNote,
  splitCommentNote,
} from "../src/doc.js";

const GROK_AT = "@2026-10-05T04:14:24.392Z Grok";
const REPLY_AT = "2026-10-05T13:37:43.066Z";
const EVIDENCE = ["How?", "::", GROK_AT, "Because."].join("\n");
const APPENDED = [
  ":: 0",
  "How?",
  ":: 1",
  GROK_AT,
  "Because.",
  ":: 2",
  `@${REPLY_AT} Grok`,
  "Yes.",
  "",
].join("\n");

test("T-comment-parse", () => {
  const plain = parseCommentNotes("hi\n::\nmore");
  assert.deepEqual(plain.map((note) => note.id), [0, 1]);
  assert.equal(formatCommentNotes(plain), ":: 0\nhi\n:: 1\nmore");

  const only = parseCommentNotes(":: 4\nonly");
  assert.equal(only.length, 1);
  assert.equal(only[0].id, 4);
  assert.equal(only[0].raw, "only");

  const before = parseCommentNotes(EVIDENCE);
  const appended = appendCommentReply(EVIDENCE, "Yes.\n", "Grok", REPLY_AT);
  assert.equal(appended.body, APPENDED);
  const after = parseCommentNotes(appended.body);
  assert.equal(after[0].raw, before[0].raw);
  assert.equal(after[1].raw, before[1].raw);
  assert.equal(before[0].raw, "How?");
  assert.equal(before[1].raw, `${GROK_AT}\nBecause.`);
  assert.deepEqual(appended.note, { id: 2, raw: `@${REPLY_AT} Grok\nYes.\n` });

  const revised = reviseCommentNote(EVIDENCE, 1, "Updated.", "Grok");
  assert.equal(revised.note.raw.split("\n")[0], GROK_AT);
  assert.equal(revised.body, [":: 0", "How?", ":: 1", GROK_AT, "Updated."].join("\n"));
  assert.deepEqual(revised.note, { id: 1, raw: `${GROK_AT}\nUpdated.` });

  const ada = reviseCommentNote(EVIDENCE, 1, "Updated.", "Ada");
  assert.equal(ada.error, 403);
  assert.equal(ada.body, EVIDENCE);

  const note0 = reviseCommentNote(EVIDENCE, 0, "Updated.", "Grok");
  assert.equal(note0.error, 403);
  assert.equal(note0.body, EVIDENCE);

  assert.deepEqual(reviseCommentNote(EVIDENCE, 1, "", "Grok"), { error: 400 });
  assert.deepEqual(reviseCommentNote(EVIDENCE, 1, "::", "Grok"), { error: 400 });
  assert.deepEqual(appendCommentReply(EVIDENCE, "", "Grok", REPLY_AT), { error: 400 });
  assert.deepEqual(appendCommentReply(EVIDENCE, "Yes.\n::\nno", "Grok", REPLY_AT), { error: 400 });

  const duplicate = [":: 1", GROK_AT, "one", ":: 1", GROK_AT, "two"].join("\n");
  assert.deepEqual(reviseCommentNote(duplicate, 1, "Updated.", "Grok"), { error: 400 });

  assert.deepEqual(reviseCommentNote(EVIDENCE, 1, "Because.", "Grok"), { unchanged: true });
});

test("comment note separators keep non-id lines and a leading empty segment", () => {
  assert.deepEqual(commentNotes("hi\n::\nmore"), ["hi", "more"]);
  assert.deepEqual(commentNotes(""), [""]);
  assert.deepEqual(commentNotes("::\nhi"), ["", "hi"]);
  assert.deepEqual(commentNotes(":: 3\nhi"), ["", "hi"]);
  assert.deepEqual(commentNotes(":: 2\nonly\n::"), ["", "only", ""]);
  assert.deepEqual(commentNotes("hi\n:: 8\nmore"), ["hi", "more"]);
  assert.deepEqual(commentNotes("hi\n:: 2\nmore\n::\nend"), ["hi", "more", "end"]);
  assert.deepEqual(commentNotes(":: 0\na\n:: 12\nb"), ["", "a", "b"]);
  assert.deepEqual(commentNotes(":: 01"), [":: 01"]);
  assert.deepEqual(commentNotes(":: 1 "), [":: 1 "]);
  assert.deepEqual(commentNotes(":: 01\n:: 1 \ntext"), [":: 01\n:: 1 \ntext"]);
  assert.deepEqual(commentNotes(":: 1\n:: 01\n:: 1 "), ["", ":: 01\n:: 1 "]);
  assert.deepEqual(commentNotes(":: 00\n::0\n:: \n::  1"), [":: 00\n::0\n:: \n::  1"]);
});

test("parseCommentNotes assigns explicit ids, ordinals, and keeps duplicates", () => {
  assert.deepEqual(parseCommentNotes(""), []);
  assert.deepEqual(parseCommentNotes("plain"), [{ id: 0, raw: "plain" }]);
  assert.deepEqual(parseCommentNotes("\n"), [{ id: 0, raw: "\n" }]);
  assert.deepEqual(parseCommentNotes("::\na\n::\nb"), [
    { id: 0, raw: "a" },
    { id: 1, raw: "b" },
  ]);
  assert.deepEqual(parseCommentNotes("\n::\na"), [
    { id: 0, raw: "" },
    { id: 1, raw: "a" },
  ]);
  assert.deepEqual(parseCommentNotes("a\n::\nb\n::\nc").map((note) => note.id), [0, 1, 2]);
  assert.deepEqual(parseCommentNotes(":: 4"), [{ id: 4, raw: "" }]);
  assert.deepEqual(parseCommentNotes(":: 12\nabc"), [{ id: 12, raw: "abc" }]);
  assert.deepEqual(parseCommentNotes(":: 0\nabc"), [{ id: 0, raw: "abc" }]);
  assert.deepEqual(parseCommentNotes("hello\n:: 0\nthere"), [
    { id: 0, raw: "hello" },
    { id: 0, raw: "there" },
  ]);
  assert.deepEqual(parseCommentNotes("see\n:: 01\n:: 1 \nend"), [
    { id: 0, raw: "see\n:: 01\n:: 1 \nend" },
  ]);
  assert.deepEqual(parseCommentNotes(":: 4\nonly\n::\nnext"), [
    { id: 4, raw: "only" },
    { id: 5, raw: "next" },
  ]);
  assert.deepEqual(parseCommentNotes(":: 4\nonly\n::\nnext\n::\nthird").map((note) => note.id), [4, 5, 5]);
  assert.deepEqual(parseCommentNotes(":: 2\nA\n:: 9\nB\n:: 3\nC\n::\nD").map((note) => note.id), [2, 9, 3, 10]);
  assert.deepEqual(parseCommentNotes(":: 2\nA\n:: 9\nB\n::\nC\n::\nD").map((note) => note.id), [2, 9, 10, 10]);
  assert.deepEqual(parseCommentNotes("a\n::\nb\n:: 1\nc"), [
    { id: 0, raw: "a" },
    { id: 1, raw: "b" },
    { id: 1, raw: "c" },
  ]);
  assert.deepEqual(parseCommentNotes(":: 1\none\n:: 2\nmiddle\n:: 1\ntwo"), [
    { id: 1, raw: "one" },
    { id: 2, raw: "middle" },
    { id: 1, raw: "two" },
  ]);
  assert.deepEqual(parseCommentNotes("::\n::\nhi"), [
    { id: 0, raw: "" },
    { id: 1, raw: "hi" },
  ]);
  assert.deepEqual(parseCommentNotes(":: 2\n::\nhi"), [
    { id: 2, raw: "" },
    { id: 3, raw: "hi" },
  ]);
  assert.equal(typeof parseCommentNotes(":: 4\nonly")[0].id, "number");
});

test("formatCommentNotes joins id blocks without adding a trailing newline", () => {
  assert.equal(formatCommentNotes([]), "");
  assert.equal(formatCommentNotes([{ id: 4, raw: "only" }]), ":: 4\nonly");
  assert.equal(formatCommentNotes([{ id: 0, raw: "hi" }, { id: 1, raw: "more" }]).endsWith("\n"), false);
  assert.equal(formatCommentNotes([{ id: 0, raw: "" }, { id: 1, raw: "a" }]), ":: 0\n\n:: 1\na");
  assert.equal(formatCommentNotes([{ id: 0, raw: "Yes.\n" }]), ":: 0\nYes.\n");

  const samples = [
    "",
    "plain",
    "\n",
    "hi\n::\nmore",
    ":: 4\nonly",
    "a\n\nb\n::\nc",
    "keep  \n:: 01\nstays\n::\nmore  ",
    "::\n::\nhi",
    ":: 4\nonly\n::\nnext\n::\nthird",
    `${GROK_AT}\nBecause.`,
    "alpha  \n:: 01\n::\nbeta \n",
  ];
  for (const body of samples) {
    const parsed = parseCommentNotes(body);
    assert.deepEqual(parseCommentNotes(formatCommentNotes(parsed)), parsed);
  }
});

test("appendCommentReply stamps one past the highest id and keeps raw bytes", () => {
  assert.deepEqual(appendCommentReply("", "", "Grok", REPLY_AT), { error: 400 });
  assert.deepEqual(appendCommentReply("keep", "::", "", REPLY_AT), { error: 400 });
  assert.deepEqual(appendCommentReply("keep", ":: 0", "", REPLY_AT), { error: 400 });
  assert.deepEqual(appendCommentReply("keep", "see\n:: 12\nend", "", REPLY_AT), { error: 400 });
  assert.deepEqual(appendCommentReply("keep", "see\n:: 1\nend", "Grok", REPLY_AT), { error: 400 });

  const blank = appendCommentReply("", "\n", "", REPLY_AT);
  assert.deepEqual(blank, { body: ":: 0\n\n", note: { id: 0, raw: "\n" } });

  const spaced = appendCommentReply("", "  x  ", "Grok", REPLY_AT);
  assert.equal(spaced.note.raw, `@${REPLY_AT} Grok\n  x  `);
  assert.equal(spaced.body, `:: 0\n@${REPLY_AT} Grok\n  x  `);

  const named = appendCommentReply("", "x\n", "Ada Lovelace", REPLY_AT);
  assert.deepEqual(splitCommentNote(named.note.raw), {
    time: REPLY_AT,
    author: "Ada Lovelace",
    text: "x\n",
  });

  const literal = appendCommentReply("", "@not really\n", "", REPLY_AT);
  assert.equal(literal.note.raw, "@not really\n");
  assert.equal(literal.body.includes(REPLY_AT), false);

  const allowed = "see :: 01\n:: 1 \n:: \nend";
  const kept = appendCommentReply("", allowed, "", REPLY_AT);
  assert.equal(kept.note.raw, allowed);
  assert.deepEqual(parseCommentNotes(kept.body), [{ id: 0, raw: allowed }]);

  const high = appendCommentReply(":: 1\nlow\n:: 7\nhigh", "x", "", REPLY_AT);
  assert.equal(high.note.id, 8);
  assert.deepEqual(parseCommentNotes(high.body).map((note) => note.raw), ["low", "high", "x"]);

  const odd = appendCommentReply(":: 4\nonly\n::\nnext\n::\nthird", "more", "", REPLY_AT);
  assert.equal(odd.note.id, 6);

  const body = "alpha  \n:: 01\n::\nbeta \n";
  const prior = parseCommentNotes(body);
  const added = appendCommentReply(body, "\n", "", "ignored");
  const notes = parseCommentNotes(added.body);
  assert.equal(notes[0].raw, prior[0].raw);
  assert.equal(notes[1].raw, prior[1].raw);
  assert.equal(notes[0].raw, "alpha  \n:: 01");
  assert.equal(notes[1].raw, "beta \n");
  assert.deepEqual(notes[2], { id: 2, raw: "\n" });
  assert.equal(added.body.includes("ignored"), false);
  assert.equal(added.body.includes("@"), false);

  const prose = appendCommentReply("\n", "z", "", REPLY_AT);
  assert.equal(prose.note.id, 1);
  assert.equal(parseCommentNotes(prose.body)[0].raw, "\n");
});

test("reviseCommentNote checks the record, the text, then the author", () => {
  assert.deepEqual(reviseCommentNote("", 0, "Updated.", "Grok"), { error: 404 });
  assert.deepEqual(reviseCommentNote(EVIDENCE, 9, "", "Grok"), { error: 404 });
  assert.deepEqual(reviseCommentNote(EVIDENCE, 9, "Updated.", "Grok"), { error: 404 });

  const body = `alpha  \n:: 01\n::\n${GROK_AT}\nbeta \n`;
  assert.deepEqual(reviseCommentNote(body, 1, "", "Ada"), { error: 400 });
  assert.deepEqual(reviseCommentNote(body, 1, "::", "Grok"), { error: 400 });
  assert.deepEqual(reviseCommentNote(body, 1, "no\n::\n", "Grok"), { error: 400 });
  assert.deepEqual(reviseCommentNote(body, 1, ":: 0", "Ada"), { error: 400 });
  assert.deepEqual(reviseCommentNote(body, 1, "line\n:: 3", "Grok"), { error: 400 });
  assert.deepEqual(reviseCommentNote(body, 5, "Updated.", "Grok"), { error: 404 });

  const same = reviseCommentNote(body, 1, "beta \n", "Ada");
  assert.equal(same.error, 403);
  assert.equal(same.body, body);
  assert.deepEqual(reviseCommentNote(body, 1, "beta \n", "Grok"), { unchanged: true });

  const denied = reviseCommentNote(body, 0, "Updated.", "Grok");
  assert.equal(denied.error, 403);
  assert.equal(denied.body, body);

  const tricky = "keep\n:: 01\n:: 1 \n:: \nend";
  const revised = reviseCommentNote(body, 1, tricky, "Grok");
  assert.equal(revised.note.raw, `${GROK_AT}\n${tricky}`);
  const notes = parseCommentNotes(revised.body);
  assert.equal(notes[0].raw, "alpha  \n:: 01");
  assert.equal(notes[1].raw, `${GROK_AT}\n${tricky}`);
  assert.equal(revised.body, formatCommentNotes(notes));
  assert.equal(revised.body.startsWith(":: 0\n"), true);

  const spacedHeader = "@2026-10-05T04:14:24.392Z  Grok\nBecause.";
  const spacedBody = `:: 3\n${spacedHeader}`;
  assert.equal(splitCommentNote(spacedHeader).author, " Grok");
  const spaced = reviseCommentNote(spacedBody, 3, "Updated.", " Grok");
  assert.equal(spaced.note.raw, "@2026-10-05T04:14:24.392Z  Grok\nUpdated.");
  assert.equal(reviseCommentNote(spacedBody, 3, "Updated.", "Grok").error, 403);

  const headerOnly = `:: 0\n${GROK_AT}`;
  assert.deepEqual(reviseCommentNote(headerOnly, 0, "", "Grok"), { error: 400 });
  const filled = reviseCommentNote(headerOnly, 0, "Now.", "Grok");
  assert.equal(filled.note.raw, `${GROK_AT}\nNow.`);

  const lovelace = ":: 0\n@2026-10-05T04:14:24.392Z Ada Lovelace\nHi";
  assert.equal(reviseCommentNote(lovelace, 0, "Yo", "Ada").body, lovelace);
  assert.equal(reviseCommentNote(lovelace, 0, "Yo", "Ada").error, 403);
  assert.equal(
    reviseCommentNote(lovelace, 0, "Yo", "Ada Lovelace").note.raw,
    "@2026-10-05T04:14:24.392Z Ada Lovelace\nYo",
  );

  const embedded = `:: 1\n${GROK_AT}\n@not-a-header\nkeep`;
  const replaced = reviseCommentNote(embedded, 1, "Updated.", "grok");
  assert.equal(replaced.error, 403);
  assert.equal(replaced.body, embedded);
  assert.equal(reviseCommentNote(embedded, 1, "Updated.", "Grok").note.raw, `${GROK_AT}\nUpdated.`);
});

test("a splice that cuts a comment marker returns null and an empty interior still drops", () => {
  const fence = "\n\n```comment c1\n:: 0\nnote\n```\n";
  const doc = `See {c1}this{/c1} now.${fence}`;
  assert.equal(doc[7], "}");
  assert.equal(doc[8], "t");
  assert.equal(doc[12], "{");
  assert.equal(doc[16], "}");
  assert.equal(insert(createState(doc, 6, 5), "X"), null);
  const beside = backspace(createState(doc, 8));
  assert.equal(beside.doc, `See{c1}this{/c1} now.${fence}`);
  assert.equal(beside.cursor, 7);
  assert.equal(backspace(createState(doc, 17)).doc, `See {c1}thi{/c1} now.${fence}`);
  assert.equal(deleteForward(createState(doc, 12)).doc, `See {c1}this{/c1}now.${fence}`);
  assert.equal(backspace(createState(doc, 10, 0)).doc, `{c1}is{/c1} now.${fence}`);

  const emptied = `See {c1}x{/c1} now.${fence}`;
  assert.equal(emptied[8], "x");
  assert.equal(deleteForward(createState(emptied, 8)).doc, "See  now.\n\n");

  const kept = deleteForward(createState(doc, 8));
  assert.equal(kept.doc, `See {c1}his{/c1} now.${fence}`);
  assert.equal(kept.doc.includes("{c1}"), true);
  assert.equal(kept.doc.includes("{/c1}"), true);
  assert.equal(kept.doc.includes("```comment c1"), true);
});

function withThread(body) {
  const marked = body.endsWith("\n") ? body : `${body}\n`;
  return `${marked}\n\`\`\`comment c1\n\n\`\`\`\n`;
}

test("a comment on a whole list item leaves the marker outside the span", () => {
  const doc = "Intro.\n\n- one item here\n- two item here\n- three item here\n";
  const line = "- two item here";
  const at = doc.indexOf(`\n${line}\n`) + 1;
  const words = doc.indexOf("two item here");
  const expect = withThread(
    "Intro.\n\n- one item here\n- {c1}two item here{/c1}\n- three item here\n",
  );
  const whole = addComment(doc, at, at + line.length);
  const text = addComment(doc, words, words + "two item here".length);
  assert.equal(whole.doc, expect);
  assert.equal(text.doc, expect);
  assert.deepEqual(whole, text);
  assert.deepEqual(addComment(doc, at + line.length, at), whole);
  assert.deepEqual(addComment(doc, at + 1, at + line.length), whole);
  assert.equal(whole.cursor, whole.doc.indexOf("two"));
  assert.deepEqual(whole.changes[0], {
    from: words,
    to: words + "two item here".length,
    inserted: "{c1}two item here{/c1}",
    removed: "two item here",
  });
  assert.equal(whole.doc.includes("- one item here\n"), true);
  assert.equal(whole.doc.includes("- three item here\n"), true);
});

test("a comment that meets a block prefix stays outside that prefix", () => {
  const doc = [
    "Intro.",
    "",
    "# Title",
    "> alpha",
    "10. ten",
    "  - nested",
    "> - quoted",
    "+ plus",
    "* star",
  ].join("\n") + "\n";
  const wrapped = {
    "# Title": "# {c1}Title{/c1}",
    "> alpha": "> {c1}alpha{/c1}",
    "10. ten": "10. {c1}ten{/c1}",
    "  - nested": "  - {c1}nested{/c1}",
    "> - quoted": "> - {c1}quoted{/c1}",
    "+ plus": "+ {c1}plus{/c1}",
    "* star": "* {c1}star{/c1}",
  };
  for (const [line, body] of Object.entries(wrapped)) {
    const from = doc.indexOf(`\n${line}\n`) + 1;
    const added = addComment(doc, from, from + line.length);
    const prose = doc.slice(0, from) + body + doc.slice(from + line.length);
    assert.equal(added.doc, withThread(prose), line);
    assert.equal(added.changes[0].to, from + line.length, line);
    assert.equal(added.changes[0].inserted, `{c1}${added.changes[0].removed}{/c1}`, line);
    assert.equal(
      line.slice(0, line.length - added.changes[0].removed.length) + added.changes[0].inserted,
      body,
      line,
    );
    assert.equal(doc.slice(added.changes[0].from, added.changes[0].to), added.changes[0].removed, line);
    assert.ok(added.changes[0].from > from, line);
  }

  const follow = "alpha\n- beta\n";
  const dash = follow.indexOf("- beta");
  assert.equal(follow.slice(dash, dash + 2), "- ");
  const ended = addComment(follow, 0, dash + 2);
  assert.equal(ended.doc, withThread("{c1}alpha\n{/c1}- beta\n"));
  assert.deepEqual(ended.changes[0], {
    from: 0,
    to: dash,
    inserted: "{c1}alpha\n{/c1}",
    removed: "alpha\n",
  });

  const items = "- one\n- two\n";
  const next = items.indexOf("\n- ") + 1;
  const across = addComment(items, 0, next + 2);
  assert.equal(across.doc, withThread("- {c1}one\n{/c1}- two\n"));
  assert.equal(across.changes[0].from, 2);
  assert.equal(across.changes[0].to, next);

  const heading = "# Title\n- next\n";
  const mark = heading.indexOf("- next");
  const both = addComment(heading, 0, mark + 2);
  assert.equal(both.doc, withThread("# {c1}Title\n{/c1}- next\n"));

  const past = addComment(follow, 0, dash + 3);
  assert.equal(past.changes[0].from, 0);
  assert.equal(past.changes[0].to, dash + 3);
  assert.equal(past.doc, withThread("{c1}alpha\n- b{/c1}eta\n"));

  const fox = addComment("hello fox\n", 6, 9);
  assert.equal(fox.changes[0].from, 6);
  assert.equal(fox.changes[0].to, 9);
  assert.equal(fox.changes[0].removed, "fox");
  assert.equal(fox.doc, withThread("hello {c1}fox{/c1}\n"));
});

test("a comment range that is only a list marker returns null", () => {
  assert.equal(addComment("- ", 0, 2), null);
  assert.equal(addComment("- ", 2, 0), null);
  assert.equal(addComment("- \n", 0, 2), null);
  assert.equal(addComment("- two item here\n", 0, 2), null);
  const mid = "Intro.\n- \nkeep\n";
  const at = mid.indexOf("- ");
  assert.equal(addComment(mid, at, at + 2), null);
  assert.equal(addComment("# ", 0, 2), null);
  assert.equal(addComment("> ", 0, 2), null);
  assert.equal(addComment("10. ", 0, 4), null);
  assert.equal(addComment("  - ", 0, 4), null);
  assert.equal(addComment("> - ", 0, 4), null);
  assert.equal(addComment("+ ", 0, 2), null);
  assert.equal(addComment("* ", 0, 2), null);
});
