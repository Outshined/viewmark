import test from "node:test";
import assert from "node:assert/strict";
import {
  appendCommentReply,
  backspace,
  commentNotes,
  createState,
  deleteForward,
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

test("a splice that breaks a comment marker returns null and an empty interior still drops", () => {
  const fence = "\n\n```comment c1\n:: 0\nnote\n```\n";
  const doc = `See {c1}this{/c1} now.${fence}`;
  assert.equal(doc[7], "}");
  assert.equal(doc[8], "t");
  assert.equal(doc[12], "{");
  assert.equal(doc[16], "}");
  assert.equal(backspace(createState(doc, 8)), null);
  assert.equal(backspace(createState(doc, 17)), null);
  assert.equal(deleteForward(createState(doc, 12)), null);
  assert.equal(backspace(createState(doc, 10, 0)), null);

  const emptied = `See {c1}x{/c1} now.${fence}`;
  assert.equal(emptied[8], "x");
  assert.equal(deleteForward(createState(emptied, 8)).doc, "See  now.\n\n");

  const kept = deleteForward(createState(doc, 8));
  assert.equal(kept.doc, `See {c1}his{/c1} now.${fence}`);
  assert.equal(kept.doc.includes("{c1}"), true);
  assert.equal(kept.doc.includes("{/c1}"), true);
  assert.equal(kept.doc.includes("```comment c1"), true);
});
