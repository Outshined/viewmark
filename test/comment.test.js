import test from "node:test";
import assert from "node:assert/strict";
import {
  addComment,
  addPinComment,
  movePinComment,
  undo,
  commentRangeReason,
  plan,
  appendCommentReply,
  backspace,
  commentAnchorReason,
  commentNotes,
  commentThreads,
  createState,
  deleteForward,
  insert,
  formatCommentNotes,
  parseCommentNotes,
  reviseCommentNote,
  setCommentResolved,
  settleSplice,
  splitCommentNote,
  commentDragPreview,
  commentStorageReason,
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

function markCount(doc, mark) {
  return doc.split(mark).length - 1;
}

test("a paste keeps a brace ident that is not already a comment", () => {
  assert.equal(insert(createState("hello", 5), "{note}").doc, "hello{note}");
  assert.equal(insert(createState("hello", 5), "{/note}").doc, "hello{/note}");

  const fence = "\n\n```comment c1\n:: 0\nnote\n```\n";
  const doc = `See {c1}this{/c1} now.${fence}`;
  const pasted = insert(createState(doc, doc.length), "{c1}x{/c1}");
  assert.equal(pasted.doc, `${doc}x`);
  assert.equal(markCount(pasted.doc, "{c1}"), 1);
  assert.equal(markCount(pasted.doc, "{/c1}"), 1);

  const fenced = "hello\n\n```comment c1\n:: 0\nnote\n```\n";
  const stripped = insert(createState(fenced, 5), "{c1}x{/c1}");
  assert.equal(markCount(stripped.doc, "{c1}"), 0);
  assert.equal(markCount(stripped.doc, "{/c1}"), 0);
  assert.ok(stripped.doc.includes("hellox"));
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

function visibleHighlight(doc, shift) {
  let text = "";
  const mark = /\{(\/?)[A-Za-z][A-Za-z0-9_-]*\}/y;
  for (let i = 0; i < doc.length; i += 1) {
    mark.lastIndex = i;
    const hit = mark.exec(doc);
    if (hit && hit.index === i) {
      i += hit[0].length - 1;
      continue;
    }
    const at = shift.storedToPreview(i);
    if (at >= shift.span.interiorStart && at < shift.span.interiorEnd) text += doc[i];
  }
  return text;
}

test("a comment drag preview is the release range and maps every byte back", () => {
  const fence = "\n\n```comment c1\n:: 0\n@2026-10-05T16:00:00.000Z Grok\nNote.\n```\n";
  const prose = "See {c1}this{/c1} now.";
  const doc = prose + fence;
  const end = commentDragPreview(doc, "c1", "end", prose.indexOf("."));
  assert.equal(end.preview, "See {c1}this now{/c1}." + fence);
  assert.equal(visibleHighlight(doc, end), "this now");
  const start = commentDragPreview(doc, "c1", "start", 0);
  assert.equal(start.preview, "{c1}See this{/c1} now." + fence);
  assert.equal(visibleHighlight(doc, start), "See this");
  for (const shift of [end, start]) {
    for (let i = 0; i < doc.length; i += 1) {
      assert.equal(shift.previewToStored(shift.storedToPreview(i)), i, `byte ${i}`);
    }
  }
  assert.equal(commentDragPreview(doc, "c1", "end", prose.indexOf("t")), null);
  assert.equal(commentDragPreview(doc, "c1", "end", prose.indexOf("{/")), null);
  const crossedProse = "See {c1}this{/c1} and {c2}that{/c2}.";
  const crossed = crossedProse + fence + "```comment c2\n:: 0\n@2026-10-05T16:00:00.000Z Grok\nNote.\n```\n";
  assert.equal(commentDragPreview(crossed, "c1", "end", crossedProse.indexOf("that") + 1), null);
  const widened = commentDragPreview(crossed, "c1", "end", crossedProse.indexOf("and"));
  assert.equal(visibleHighlight(crossed, widened), "this ");
});

const SOURCE = "```js\none\ntwo\nthree\nfour\n```\n";
const RANGED = `${SOURCE}\`\`\`comment c1 2-3\n\n\`\`\`\n`;

function editBytes(doc, from, to, text) {
  return insert(createState(doc, to, from), text, false, false, true);
}

function replayChanges(doc, changes) {
  let text = doc;
  for (const change of changes) {
    assert.equal(text.slice(change.from, change.to), change.removed);
    text = text.slice(0, change.from) + change.inserted + text.slice(change.to);
  }
  return text;
}

function undoChanges(doc, changes) {
  let text = doc;
  for (let i = changes.length - 1; i >= 0; i -= 1) {
    const change = changes[i];
    const end = change.from + change.inserted.length;
    assert.equal(text.slice(change.from, end), change.inserted);
    text = text.slice(0, change.from) + change.removed + text.slice(end);
  }
  return text;
}

function assertRoundTrip(before, after) {
  assert.equal(after.refused, undefined);
  assert.equal(replayChanges(before, after.changes), after.doc);
  assert.equal(undoChanges(after.doc, after.changes), before);
}

test("a source fence stores a following line-range comment and leaves the code bytes", () => {
  const code = "```python\nalpha\nbeta\n```\n";
  const alpha = code.indexOf("alpha");
  const beta = code.indexOf("beta");
  const partial = addComment(code, alpha, alpha + 2);
  assert.equal(partial.doc, `${code}\`\`\`comment c1 1\n\n\`\`\`\n`);
  assert.equal(partial.anchor, alpha);
  assert.equal(partial.cursor, beta);
  const tail = addComment(code, alpha + 1, alpha + "alpha".length);
  assert.equal(tail.doc, partial.doc);
  assert.equal(tail.anchor, alpha);
  assert.equal(tail.cursor, beta);
  assert.equal(addComment(code, code.indexOf("```", 3), code.indexOf("```", 3) + 1), null);

  const one = addComment(code, alpha, alpha + "alpha".length);
  assert.equal(one.id, "c1");
  assert.equal(one.anchor, alpha);
  assert.equal(one.cursor, alpha + "alpha".length);
  assert.equal(one.doc, `${code}\`\`\`comment c1 1\n\n\`\`\`\n`);
  assert.equal(one.doc.startsWith(code), true);
  const throughNewline = addComment(code, alpha, beta);
  assert.equal(throughNewline.doc, one.doc);

  const span = addComment(code, alpha, beta + "beta".length);
  assert.equal(span.id, "c1");
  assert.equal(span.doc, `${code}\`\`\`comment c1 1-2\n\n\`\`\`\n`);
  assert.equal(span.anchor, alpha);
  assert.equal(span.cursor, beta + "beta".length);
  const spanThread = commentThreads(span.doc)[0];
  assert.deepEqual(spanThread.lines, { start: 1, end: 2 });
  assert.equal(spanThread.pin, null);
  assert.equal(spanThread.hostKind, "fence");
  assert.equal(spanThread.bodyCount, 2);
  assert.equal(spanThread.anchorAt, 0);
  assert.equal(commentAnchorReason(span.doc), null);

  const second = addComment(one.doc, beta, beta + "beta".length);
  assert.equal(second.id, "c2");
  assert.equal(second.doc, `${code}\`\`\`comment c1 1\n\n\`\`\`\n\`\`\`comment c2 2\n\n\`\`\`\n`);
  assert.equal(second.doc.startsWith(code), true);

  const same = addComment(code, beta, beta + "beta".length);
  assert.equal(same.doc, `${code}\`\`\`comment c1 2\n\n\`\`\`\n`);

  const inside = "```js\none\ntwo\nthree\n```\n";
  const twoAt = inside.indexOf("two");
  const threeAt = inside.indexOf("three");
  const closerAt = inside.indexOf("```", 3);
  const crossed = addComment(inside, twoAt + 1, threeAt + 2);
  assert.equal(crossed.doc, `${inside}\`\`\`comment c1 2-3\n\n\`\`\`\n`);
  assert.equal(crossed.anchor, twoAt);
  assert.equal(crossed.cursor, closerAt);
  const before = `see\n${inside}`;
  assert.equal(addComment(before, 0, before.indexOf("two") + 1), null);
  assert.equal(commentRangeReason(before, 0, before.indexOf("two") + 1), "overlaps a fence");
  const afterFence = `${inside}tail\n`;
  assert.equal(addComment(afterFence, afterFence.indexOf("two"), afterFence.indexOf("tail") + 1), null);
  assert.equal(commentRangeReason(afterFence, afterFence.indexOf("two"), afterFence.indexOf("tail") + 1), "overlaps a fence");
  const reversed = `${SOURCE}\`\`\`comment c1 3-2\n\n\`\`\`\n`;
  assert.deepEqual(commentThreads(reversed)[0].lines, { start: 2, end: 3 });
  assert.equal(commentAnchorReason(reversed), null);
  const spaced = `${SOURCE}\`\`\`comment c1  2-3   resolved\n\n\`\`\`\n`;
  assert.equal(commentThreads(spaced)[0].resolved, true);
  assert.deepEqual(commentThreads(spaced)[0].lines, { start: 2, end: 3 });
  const garbage = `${SOURCE}\`\`\`comment c1 hello\n\n\`\`\`\n`;
  assert.equal(commentThreads(garbage)[0].lines, null);
  assert.equal(commentThreads(garbage)[0].pin, null);
  assert.equal(commentAnchorReason(garbage), null);
});

test("a pin is the following fence on an image or a diagram", () => {
  const image = "![alt](sample.svg)\n";
  const pin = addPinComment(image, 0, 0.62, 0.18);
  assert.equal(pin.id, "c1");
  assert.equal(pin.cursor, pin.doc.length);
  assert.equal(pin.anchor, pin.doc.length);
  assert.equal(pin.doc, `${image}\`\`\`comment c1 0.62,0.18\n\n\`\`\`\n`);
  assert.equal(pin.doc.startsWith(image), true);
  const thread = commentThreads(pin.doc)[0];
  assert.equal(thread.lines, null);
  assert.deepEqual(thread.pin, { x: 0.62, y: 0.18 });
  assert.equal(thread.hostKind, "image");
  assert.equal(commentAnchorReason(pin.doc), null);

  const edges = addPinComment(image, image.length - 1, 0, 1);
  assert.equal(edges.doc, `${image}\`\`\`comment c1 0,1\n\n\`\`\`\n`);
  const rounded = addPinComment(image, 0, 0.123456, 1);
  assert.equal(rounded.doc.includes("```comment c1 0.1235,1\n"), true);

  const diagram = "```mermaid\nA-->B\n```\n";
  const marked = addPinComment(diagram, 4, 0.62, 0.18);
  assert.equal(marked.doc, `${diagram}\`\`\`comment c1 0.62,0.18\n\n\`\`\`\n`);
  assert.equal(commentThreads(marked.doc)[0].hostKind, "diagram");
  assert.equal(marked.doc.startsWith(diagram), true);

  const again = addPinComment(pin.doc, 1, 0.25, 0.5);
  assert.equal(again.id, "c2");
  assert.equal(again.doc.startsWith(pin.doc), true);
  assert.equal(again.doc, `${pin.doc}\`\`\`comment c2 0.25,0.5\n\n\`\`\`\n`);
});

test("moving a pin rewrites its fractions and keeps the thread", () => {
  const image = "![alt](sample.svg)\n";
  const note = "```comment c1 0.25,0.5\n:: 0\n@2026-10-16T15:00:00.000Z qa\nA pin.\n:: 1\n@2026-10-16T15:01:00.000Z qa\nStill here.\n```\n";
  const other = "```comment c2 0.8,0.2\n:: 0\n@2026-10-16T15:02:00.000Z qa\nOther.\n```\n";
  const doc = `${image}${note}${other}End.\n`;
  const end = doc.indexOf("End");
  const state = createState(doc, end, end);
  const moved = movePinComment(state, "c1", 0.3, 0.7);
  assert.equal(moved.refused, undefined);
  assert.equal(moved.doc.includes("```comment c1 0.3,0.7\n"), true);
  assert.equal(moved.doc.includes("A pin.\n"), true);
  assert.equal(moved.doc.includes("Still here.\n"), true);
  assert.equal(moved.doc.includes("```comment c2 0.8,0.2\n"), true);
  assert.equal(moved.doc.includes("Other.\n"), true);
  assert.equal(moved.doc[moved.cursor], "E");
  assert.equal(moved.anchor, moved.cursor);
  assert.equal(moved.changes.length, 1);
  assert.equal(moved.changes[0].removed.includes("0.25,0.5"), true);
  assert.equal(moved.changes[0].inserted.includes("0.3,0.7"), true);
  const back = undo(moved);
  assert.equal(back.doc, doc);
  assert.equal(back.cursor, end);

  const resolved = setCommentResolved(createState(`${image}\`\`\`comment c1 0.25,0.5\n\n\`\`\`\n`, 0), "c1", true);
  const still = movePinComment(resolved, "c1", 1, 0);
  assert.equal(still.doc.includes("```comment c1 1,0 resolved\n"), true);
  const edges = movePinComment(state, "c1", 0, 1);
  assert.equal(edges.doc.includes("```comment c1 0,1\n"), true);
  const rounded = movePinComment(state, "c1", 0.123456, 0.2);
  assert.equal(rounded.doc.includes("```comment c1 0.1235,0.2\n"), true);
  const same = movePinComment(moved, "c1", 0.3, 0.7);
  assert.equal(same, moved);

  assert.deepEqual(movePinComment(state, "c1", 1.01, 0.2), { refused: 400, reason: "pin is out of range" });
  assert.deepEqual(movePinComment(state, "c1", -0.01, 0.2), { refused: 400, reason: "pin is out of range" });
  assert.deepEqual(movePinComment(state, "c1", Number.NaN, 0.2), { refused: 400, reason: "pin is out of range" });
  assert.deepEqual(movePinComment(state, "c9", 0.2, 0.2), { refused: 400, reason: "not in the run" });
  const prose = "hello {c3}fox{/c3}\n\n```comment c3\n\n```\n";
  assert.deepEqual(movePinComment(createState(prose, 0), "c3", 0.2, 0.2), { refused: 400, reason: "not in the run" });
  const ranged = "```js\none\n```\n```comment c1 1\n\n```\n";
  assert.deepEqual(movePinComment(createState(ranged, 0), "c1", 0.2, 0.2), { refused: 400, reason: "not in the run" });

  const diagram = "```mermaid\nA-->B\n```\n```comment c1 0.4,0.7\n\n```\n";
  const diagramMoved = movePinComment(createState(diagram, 0), "c1", 0.2, 0.3);
  assert.equal(diagramMoved.doc.includes("```comment c1 0.2,0.3\n"), true);
  assert.equal(diagramMoved.doc.startsWith("```mermaid\nA-->B\n```\n"), true);
});

test("a pin leaves the caret off the image line so the picture stays drawn", () => {
  const only = "![alt](sample.svg)\n";
  const first = addPinComment(only, 0, 0.25, 0.5);
  const onlyEnd = only.indexOf("\n");
  assert.equal(first.cursor, first.doc.length);
  assert.ok(first.cursor > onlyEnd);
  assert.equal(first.anchor, first.cursor);
  assert.equal(plan(first.doc, first.cursor).blocks.some((block) => block.raw && block.start === 0), false);
  assert.ok(plan(first.doc, first.cursor).atoms.some((atom) => atom.type === "image"));

  const above = "para\n![alt](sample.svg)\nnext\n";
  const at = above.indexOf("![");
  const pinned = addPinComment(above, at + 1, 0.3, 0.2);
  const imageEnd = above.indexOf("\n", at);
  assert.equal(pinned.cursor, at - 1);
  assert.equal(pinned.anchor, pinned.cursor);
  assert.ok(pinned.cursor < at || pinned.cursor > imageEnd);
  const drawn = plan(pinned.doc, pinned.cursor);
  const imageLine = drawn.blocks.find((block) => block.type === "line" && block.start === at);
  assert.equal(imageLine.raw, false);
  assert.ok(drawn.atoms.some((atom) => atom.type === "image" && atom.start === at));

  const diagram = "See\n```mermaid\nA-->B\n```\n";
  const marked = addPinComment(diagram, diagram.indexOf("A"), 0.4, 0.7);
  assert.ok(marked.cursor < diagram.indexOf("```"));
  assert.ok(plan(marked.doc, marked.cursor).atoms.some((atom) => atom.type === "diagram"));
});

test("a range or pin that does not follow its block is 400 and writes nothing", () => {
  assert.deepEqual(addPinComment("hello\n", 0, 0.2, 0.3), { refused: 400, reason: "not in the run" });
  assert.deepEqual(addPinComment("![a](b.png)\n", 0, 1.01, 0.2), { refused: 400, reason: "pin is out of range" });
  assert.deepEqual(addPinComment("hello\n", 0, -0.1, 0.2), { refused: 400, reason: "pin is out of range" });
  assert.deepEqual(addPinComment("![a](b.png)\n", 0, Number.NaN, 0.2), { refused: 400, reason: "pin is out of range" });

  const image = "![a](b.png)\n";
  assert.equal(commentAnchorReason(`${image}\`\`\`comment c1 1.5,0.2\n\n\`\`\`\n`), "pin is out of range");
  assert.equal(commentAnchorReason(`${image}\`\`\`comment c1 0,1.0001\n\n\`\`\`\n`), "pin is out of range");
  assert.equal(commentAnchorReason(`${image}\`\`\`comment c1 0,1\n\n\`\`\`\n`), null);
  assert.equal(commentAnchorReason(`${image}\`\`\`comment c1 1\n\n\`\`\`\n`), "not in the run");
  assert.equal(commentAnchorReason(`${SOURCE}\`\`\`comment c1 0.5,0.5\n\n\`\`\`\n`), "not in the run");
  assert.equal(commentAnchorReason("```mermaid\nA-->B\n```\n```comment c1 1\n\n```\n"), "not in the run");
  assert.equal(commentAnchorReason(`${SOURCE}\n\`\`\`comment c1 2-3\n\n\`\`\`\n`), "not in the run");
  assert.equal(commentAnchorReason(`${SOURCE}later\n\`\`\`comment c1 2-3\n\n\`\`\`\n`), "not in the run");
  assert.equal(commentAnchorReason("```comment c1 2-3\n\n```\n"), "not in the run");
  assert.equal(commentAnchorReason(`${SOURCE}\`\`\`comment c1 0\n\n\`\`\`\n`), "range is outside the body");
  assert.equal(commentAnchorReason(`${SOURCE}\`\`\`comment c1 5\n\n\`\`\`\n`), "range is outside the body");
  assert.equal(commentAnchorReason(`${SOURCE}\`\`\`comment c1 2-9\n\n\`\`\`\n`), "range is outside the body");
  const between = `${SOURCE}\`\`\`comment c9\n\n\`\`\`\n\`\`\`comment c1 2-3\n\n\`\`\`\n`;
  assert.equal(commentAnchorReason(between), null);
  assert.equal(commentThreads(between).find((item) => item.id === "c1").hostKind, "fence");

  const widened = settleSplice(RANGED, RANGED.indexOf("2-3"), RANGED.indexOf("2-3") + 3, "2-9");
  assert.deepEqual(widened, { refused: 400, reason: "range is outside the body" });
  assert.equal(widened.doc, undefined);
  const gapAt = RANGED.indexOf("```comment");
  const gapped = settleSplice(RANGED, gapAt, gapAt, "\n");
  assert.deepEqual(gapped, { refused: 400, reason: "not in the run" });
  const broken = editBytes(RANGED, gapAt, gapAt, "\n");
  assert.deepEqual(
    { refused: broken.refused, reason: broken.reason },
    { refused: 400, reason: "not in the run" },
  );
  assert.equal(broken.doc, undefined);

  const pinned = `${image}\`\`\`comment c1 0.5,0.25\n\n\`\`\`\n`;
  const dropped = editBytes(pinned, 0, image.length, "");
  assert.equal(dropped.refused, 400);
  assert.equal(dropped.reason, "not in the run");
  assert.equal(dropped.doc, undefined);
  const moved = editBytes(pinned, pinned.indexOf("```comment"), pinned.indexOf("```comment"), "\n");
  assert.equal(moved.reason, "not in the run");
  const badCoord = settleSplice(pinned, pinned.indexOf("0.5,0.25"), pinned.indexOf("0.5,0.25") + "0.5,0.25".length, "1.5,0.25");
  assert.deepEqual(badCoord, { refused: 400, reason: "pin is out of range" });
});

test("a line edit rebases the following range and leaves a pin and a prose brace", () => {
  const two = RANGED.indexOf("two");
  const three = RANGED.indexOf("three");
  const four = RANGED.indexOf("four");
  const one = RANGED.indexOf("one");

  const above = editBytes(RANGED, two, two, "X\n");
  assertRoundTrip(RANGED, above);
  assert.equal(above.doc.includes("```comment c1 3-4\n"), true);
  assert.equal(above.doc.includes("X\ntwo\n"), true);

  const inside = editBytes(RANGED, three, three, "X\n");
  assertRoundTrip(RANGED, inside);
  assert.equal(inside.doc.includes("```comment c1 2-4\n"), true);

  const shrunk = editBytes(RANGED, three, three + "three\n".length, "");
  assertRoundTrip(RANGED, shrunk);
  assert.equal(shrunk.doc.includes("```comment c1 2\n"), true);
  assert.equal(shrunk.doc.includes("three"), false);

  const gone = editBytes(RANGED, two, three + "three\n".length, "");
  assertRoundTrip(RANGED, gone);
  assert.equal(gone.doc.includes("```comment"), false);
  assert.equal(gone.doc, "```js\none\nfour\n```\n");

  const renamed = editBytes(RANGED, two, two + "two".length, "TWO");
  assertRoundTrip(RANGED, renamed);
  assert.equal(renamed.changes.length, 1);
  assert.equal(renamed.doc.includes("```comment c1 2-3\n"), true);
  assert.equal(renamed.doc.includes("TWO\n"), true);

  const before = editBytes(RANGED, one, one, "X\n");
  assertRoundTrip(RANGED, before);
  assert.equal(before.doc.includes("```comment c1 3-4\n"), true);

  const after = editBytes(RANGED, four, four, "X\n");
  assertRoundTrip(RANGED, after);
  assert.equal(after.doc.includes("```comment c1 2-3\n"), true);
  assert.equal(after.doc.includes("X\nfour\n"), true);

  const droppedFirst = editBytes(RANGED, one, one + "one\n".length, "");
  assertRoundTrip(RANGED, droppedFirst);
  assert.equal(droppedFirst.doc.includes("```comment c1 1-2\n"), true);

  const literal = `${SOURCE}\`\`\`comment c1 2-2\n\n\`\`\`\n`;
  const still = editBytes(literal, literal.indexOf("two"), literal.indexOf("two") + 3, "TWO");
  assert.equal(still.doc.includes("```comment c1 2-2\n"), true);
  const shiftedLiteral = editBytes(literal, literal.indexOf("two"), literal.indexOf("two"), "X\n");
  assert.equal(shiftedLiteral.doc.includes("```comment c1 3\n"), true);
  assert.equal(shiftedLiteral.doc.includes("2-2"), false);

  const resolved = setCommentResolved(createState(RANGED, 0), "c1", true);
  assert.equal(resolved.doc.includes("```comment c1 2-3 resolved\n"), true);
  const kept = editBytes(resolved.doc, resolved.doc.indexOf("two"), resolved.doc.indexOf("two"), "X\n");
  assert.equal(kept.doc.includes("```comment c1 3-4 resolved\n"), true);

  const pair = `${SOURCE}\`\`\`comment c1 2-3\n\n\`\`\`\n\`\`\`comment c2 4\n\n\`\`\`\n`;
  const both = editBytes(pair, pair.indexOf("three"), pair.indexOf("three"), "X\n");
  assertRoundTrip(pair, both);
  assert.equal(both.doc.includes("```comment c1 2-4\n"), true);
  assert.equal(both.doc.includes("```comment c2 5\n"), true);
  const fourAt = pair.indexOf("four");
  const emptied = editBytes(pair, fourAt, fourAt + "four\n".length, "");
  assertRoundTrip(pair, emptied);
  assert.equal(emptied.doc.includes("```comment c2"), false);
  assert.equal(emptied.doc.includes("```comment c1 2-3\n"), true);
  assert.equal(emptied.doc.includes("four"), false);

  const image = "para\n![a](b.png)\n";
  const pinned = `${image}\`\`\`comment c1 0.5,0.25\n\n\`\`\`\n`;
  const typed = editBytes(pinned, 0, 0, "X\n");
  assertRoundTrip(pinned, typed);
  assert.equal(typed.doc.includes("```comment c1 0.5,0.25\n"), true);
  const alt = editBytes(pinned, pinned.indexOf("a"), pinned.indexOf("a"), "alt");
  assert.equal(alt.doc.includes("```comment c1 0.5,0.25\n"), true);
  assert.equal(commentAnchorReason(alt.doc), null);

  const prose = addComment("hello fox\n", 6, 9);
  assert.equal("anchor" in prose, false);
  assert.equal(prose.doc, "hello {c1}fox{/c1}\n\n```comment c1\n\n```\n");
  const proseThread = commentThreads(prose.doc)[0];
  assert.equal(proseThread.lines, null);
  assert.equal(proseThread.pin, null);
  assert.equal(proseThread.anchorAt, null);
  const proseResolved = setCommentResolved(createState(prose.doc, 0), "c1", true);
  assert.equal(proseResolved.doc.includes("```comment c1 resolved\n"), true);
  const pinResolved = setCommentResolved(createState(`${image}\`\`\`comment c1 0.62,0.18\n\n\`\`\`\n`, 0), "c1", true);
  assert.equal(pinResolved.doc.includes("```comment c1 0.62,0.18 resolved\n"), true);
  assert.equal(addComment("```python\nx\n```\n", 12, 13), null);
});

test("a page edit does not change a comment fence or the blank between fences", () => {
  const fence = (id) => `\`\`\`comment ${id} resolved\n:: 0\n@2026-10-05T16:00:00.000Z qa\nNote.\n\`\`\`\n`;
  const doc = `See {c7}this{/c7} and {c8}that{/c8}.\n\n${fence("c7")}\n${fence("c8")}`;
  const c8 = doc.indexOf("```comment c8");
  const blank = c8 - 1;
  assert.equal(doc[blank], "\n");
  assert.equal(commentStorageReason(doc, [{ from: c8, to: c8, inserted: "x" }]), "changes a comment fence");
  assert.equal(commentStorageReason(doc, [{ from: blank, to: blank + 1, inserted: "" }]), "changes a comment fence");
  assert.equal(commentStorageReason(doc, [{ from: blank, to: blank, inserted: "x" }]), "changes a comment fence");
  assert.equal(commentStorageReason(doc, [{ from: doc.length, to: doc.length, inserted: "Hello" }]), null);
  assert.equal(commentStorageReason(doc, [{ from: 0, to: 0, inserted: "X" }]), null);

  const typed = editBytes(doc, doc.length, doc.length, "Hello");
  assert.equal(typed.refused, undefined);
  assert.equal(commentStorageReason(doc, typed.changes), null);
  assert.equal(typed.doc.endsWith("```\nHello"), true);
  assert.equal(typed.doc.includes("```comment c7 resolved"), true);
  assert.equal(typed.doc.includes("```comment c8 resolved"), true);

  const above = editBytes(RANGED, RANGED.indexOf("two"), RANGED.indexOf("two"), "X\n");
  assert.equal(commentStorageReason(RANGED, above.changes), null);
  const gone = editBytes(RANGED, RANGED.indexOf("two"), RANGED.indexOf("three") + "three\n".length, "");
  assert.equal(commentStorageReason(RANGED, gone.changes), null);
  assert.equal(gone.doc.includes("```comment"), false);

  const marked = "A {c1}x{/c1} B\n\n```comment c1\nhi\n```\n";
  const emptied = backspace(createState(marked, 7));
  assert.equal(emptied.doc, "A  B\n\n");
  assert.equal(commentStorageReason(marked, emptied.changes), null);

  const opener = doc.indexOf("```comment c7");
  const broken = editBytes(doc, opener, opener, "x");
  assert.equal(commentStorageReason(doc, broken.changes), "changes a comment fence");
});
