import test from "node:test";
import assert from "node:assert/strict";
import {
  TICKET_ALPHABET,
  TICKET_PRIORITIES,
  TICKET_STATES,
  TICKET_TYPES,
  generateId,
  parseTicket,
  composeTicket,
  dropStoredMissing,
  rejectLink,
} from "../src/ticket.js";

const CREATED = "2026-10-04T18:00:00.000Z";
const ID = "23456789";
const A = "aaaaaaaa";
const B = "bbbbbbbb";
const C = "cccccccc";
const D = "dddddddd";
const N = "nnnnnnnn";

const HEADER = [
  "title: Fix the login redirect",
  "state: new",
  "type: task",
  "priority: medium",
  "parent:",
  "depends:",
  "reporter: indexer",
  `created: ${CREATED}`,
].join("\n");

const SIMPLE = `${HEADER}\n\nThe body is the rest of the file.`;

const RICH_BODY = ["First paragraph.", "", "title: x", "", "Second paragraph.", ""].join("\n");
const RICH = `${HEADER}\n\n${RICH_BODY}`;

function entry(id, parent = "", depends = []) {
  return { id, parent, depends };
}

function ticket(overrides = {}) {
  return {
    id: ID,
    title: "Fix the login redirect",
    state: "new",
    type: "task",
    priority: "medium",
    assignee: "",
    parent: "",
    depends: [],
    reporter: "indexer",
    created: CREATED,
    body: "The body is the rest of the file.",
    ...overrides,
  };
}

test("T-ticket-roundtrip", () => {
  const parsed = parseTicket(ID, SIMPLE);
  assert.deepEqual(parsed, ticket());
  assert.deepEqual(Object.keys(parsed), [
    "id",
    "title",
    "state",
    "type",
    "priority",
    "assignee",
    "parent",
    "depends",
    "reporter",
    "created",
    "body",
  ]);
  assert.equal(composeTicket(parsed), SIMPLE);
  assert.equal(SIMPLE.slice(0, SIMPLE.indexOf("\n\n")).includes("id:"), false);
  assert.equal(SIMPLE.includes(ID), false);

  const rich = parseTicket(ID, RICH);
  assert.equal(rich.title, "Fix the login redirect");
  assert.equal(rich.body, RICH_BODY);
  assert.equal(rich.body.includes("\n\n"), true);
  assert.equal(rich.body.split("\n").includes("title: x"), true);
  assert.equal(composeTicket(rich), RICH);

  const leading = `${HEADER}\n\n\nkept\n`;
  assert.equal(parseTicket(ID, leading).body, "\nkept\n");
  assert.equal(composeTicket(parseTicket(ID, leading)), leading);

  const emptyBody = `${HEADER}\n\n`;
  assert.equal(parseTicket(ID, emptyBody).body, "");
  assert.equal(composeTicket(parseTicket(ID, emptyBody)), emptyBody);

  const crBody = `${HEADER}\n\nline\r\n\ntitle: x\r\n`;
  assert.equal(parseTicket(ID, crBody).body, "line\r\n\ntitle: x\r\n");
  assert.equal(composeTicket(parseTicket(ID, crBody)), crBody);

  const colonTitle = ticket({
    id: A,
    title: "Fix: the login redirect",
    state: "triaged",
    parent: B,
    depends: [C, B, C],
    reporter: "Ada Lovelace",
    body: RICH_BODY,
  });
  const colonText = composeTicket(colonTitle);
  assert.equal(
    colonText,
    [
      "title: Fix: the login redirect",
      "state: triaged",
      "type: task",
      "priority: medium",
      `parent: ${B}`,
      `depends: ${B} ${C}`,
      "reporter: Ada Lovelace",
      `created: ${CREATED}`,
      "",
      RICH_BODY,
    ].join("\n"),
  );
  assert.deepEqual(parseTicket(A, colonText), {
    ...colonTitle,
    depends: [B, C],
  });

  const messyDepends = SIMPLE.replace("depends:", `depends: ${B}  ${A}   ${B} ${C}`);
  const normalized = composeTicket(parseTicket(ID, messyDepends));
  assert.equal(normalized, SIMPLE.replace("depends:", `depends: ${A} ${B} ${C}`));
  assert.deepEqual(parseTicket(ID, messyDepends).depends, [A, B, C]);

  const unsorted = [B, A, B, "22222222"];
  const source = ticket({ depends: unsorted });
  const sortedText = composeTicket(source);
  assert.equal(composeTicket(ticket({ depends: ["22222222", A, B] })), sortedText);
  assert.match(sortedText, new RegExp(`depends: 22222222 ${A} ${B}\\n`));
  assert.deepEqual(source.depends, unsorted);

  const padded = SIMPLE
    .replace("title: Fix the login redirect", "title:   Fix the login redirect  ")
    .replace("state: new", "state:   new  ")
    .replace("parent:", "parent:   ")
    .replace("depends:", "depends:   ")
    .replace("reporter: indexer", "reporter:   indexer  ")
    .replace(`created: ${CREATED}`, `created:   ${CREATED}  `);
  assert.equal(composeTicket(parseTicket(ID, padded)), SIMPLE);

  assert.equal(parseTicket(ID, SIMPLE.replace("\n\n", "\n")), null);
  assert.equal(parseTicket(ID, SIMPLE.replace("\n\n", "\nnote: x\n\n")), null);
  assert.equal(
    parseTicket(ID, SIMPLE.replace("title: Fix the login redirect\nstate: new", "state: new\ntitle: Fix the login redirect")),
    null,
  );
  assert.equal(parseTicket(ID, SIMPLE.replace("title:", "name:")), null);
  assert.equal(parseTicket(ID, SIMPLE.replace("title: Fix the login redirect", "title:Fix the login redirect")), null);
  assert.equal(parseTicket(ID, null), null);
  assert.equal(parseTicket(ID, undefined), null);
  assert.equal(composeTicket(null), null);
  assert.equal(composeTicket(ticket({ body: undefined })), null);
  assert.equal(composeTicket(ticket({ reporter: "" })), null);
  assert.equal(composeTicket(ticket({ reporter: "bad\tname" })), null);
  assert.equal(composeTicket(ticket({ reporter: "bad\nname" })), null);
  assert.equal(composeTicket(ticket({ reporter: "   " })), null);
  assert.equal(parseTicket(ID, SIMPLE.replace("reporter: indexer", "reporter:")), null);
  assert.equal(parseTicket(ID, SIMPLE.replace("reporter: indexer", "reporter: bad\tname")), null);
  assert.equal(parseTicket(ID, SIMPLE.replace(`created: ${CREATED}`, "created: 2026-10-04T18:00:00Z")), null);
  assert.equal(parseTicket(ID, SIMPLE.replace(`created: ${CREATED}`, "created: 2026-10-04T18:00:00.00Z")), null);
  assert.equal(parseTicket(ID, SIMPLE.replace(`created: ${CREATED}`, "created: 2026-10-04T18:00:00.0000Z")), null);
  assert.equal(parseTicket(ID, SIMPLE.replace(`created: ${CREATED}`, "created: 2026-10-04t18:00:00.000Z")), null);
  assert.equal(parseTicket(ID, SIMPLE.replace(`created: ${CREATED}`, "created: 2026-10-04T18:00:00.000z")), null);
  assert.equal(composeTicket(ticket({ created: "2026-10-04 18:00:00.000Z" })), null);
  assert.equal(parseTicket(ID, SIMPLE.replace("reporter: indexer", "reporter: indexer:bot")).reporter, "indexer:bot");
});

test("T-ticket-title", () => {
  assert.equal(parseTicket(ID, SIMPLE.replace("title: Fix the login redirect", "title: x")).title, "x");
  const twoHundred = "x".repeat(200);
  const maxText = SIMPLE.replace("title: Fix the login redirect", `title: ${twoHundred}`);
  assert.equal(parseTicket(ID, maxText).title, twoHundred);
  assert.equal(composeTicket(parseTicket(ID, maxText)), maxText);

  assert.equal(parseTicket(ID, SIMPLE.replace("title: Fix the login redirect", "title:")), null);
  assert.equal(parseTicket(ID, SIMPLE.replace("title: Fix the login redirect", "title:    ")), null);
  assert.equal(parseTicket(ID, SIMPLE.replace("title: Fix the login redirect", `title: ${"x".repeat(201)}`)), null);
  assert.equal(parseTicket(ID, SIMPLE.replace("title: Fix the login redirect", "title: bad\ttitle")), null);
  assert.equal(parseTicket(ID, SIMPLE.replace("title: Fix the login redirect", "title: bad\rtitle")), null);

  assert.equal(composeTicket(ticket({ title: "x" })).includes("title: x\n"), true);
  assert.equal(composeTicket(ticket({ title: twoHundred })).includes(`title: ${twoHundred}\n`), true);
  assert.equal(composeTicket(ticket({ title: "" })), null);
  assert.equal(composeTicket(ticket({ title: "   " })), null);
  assert.equal(composeTicket(ticket({ title: "x".repeat(201) })), null);
  assert.equal(composeTicket(ticket({ title: "bad\ttitle" })), null);
  assert.equal(composeTicket(ticket({ title: "bad\rtitle" })), null);
  assert.equal(composeTicket(ticket({ title: "bad\ntitle" })), null);
  assert.equal(composeTicket(ticket({ title: "Fix  the  login" })).includes("title: Fix  the  login\n"), true);

  const spaced = SIMPLE.replace("title: Fix the login redirect", "title:   Fix  the login   ");
  assert.equal(parseTicket(ID, spaced).title, "Fix  the login");
  assert.equal(composeTicket(parseTicket(ID, spaced)).startsWith("title: Fix  the login\n"), true);
});

test("T-ticket-state", () => {
  assert.deepEqual(TICKET_STATES, ["new", "triaged", "in progress", "blocked", "pending review", "closed"]);
  for (const state of TICKET_STATES) {
    const text = SIMPLE.replace("state: new", `state: ${state}`);
    const parsed = parseTicket(ID, text);
    assert.equal(parsed.state, state);
    assert.equal(composeTicket(parsed), text);
    assert.equal(composeTicket(ticket({ state })), text);
  }

  for (const state of ["", "open", "NEW", "In progress", "in-progress", "in  progress", "Blocked", "Pending review", "pending-review"]) {
    assert.equal(parseTicket(ID, SIMPLE.replace("state: new", state === "" ? "state:" : `state: ${state}`)), null);
    assert.equal(composeTicket(ticket({ state })), null);
  }
  assert.equal(parseTicket(ID, SIMPLE.replace("state: new", "state:new")), null);
  assert.equal(parseTicket(ID, SIMPLE.replace("state: new", "state:   in progress  ")).state, "in progress");
  assert.equal(parseTicket(ID, SIMPLE.replace("state: new", "state: closed ")).state, "closed");
  assert.equal(composeTicket(ticket({ state: "  closed  " })).includes("state: closed\n"), true);
});

test("T-ticket-type", () => {
  assert.deepEqual(TICKET_TYPES, ["bug", "enhancement", "task"]);
  assert.equal(Object.isFrozen(TICKET_TYPES), true);
  assert.throws(() => TICKET_TYPES.push("feature"));
  for (const type of TICKET_TYPES) {
    const text = SIMPLE.replace("type: task", `type: ${type}`);
    const parsed = parseTicket(ID, text);
    assert.equal(parsed.type, type);
    assert.equal(composeTicket(parsed), text);
    assert.equal(composeTicket(ticket({ type })), text);
  }

  for (const type of ["", "nope", "Bug", "TASK", "feature"]) {
    assert.equal(parseTicket(ID, SIMPLE.replace("type: task", type === "" ? "type:" : `type: ${type}`)), null);
    assert.equal(composeTicket(ticket({ type })), null);
  }
  assert.equal(parseTicket(ID, SIMPLE.replace("type: task\n", "")), null);
  assert.equal(parseTicket(ID, SIMPLE.replace("type: task", "type:task")), null);
  assert.equal(composeTicket(ticket({ type: undefined })), null);
  assert.equal(parseTicket(ID, SIMPLE.replace("type: task", "type:   bug  ")).type, "bug");
  assert.equal(parseTicket(ID, SIMPLE.replace("type: task", "type: enhancement ")).type, "enhancement");
  assert.equal(composeTicket(ticket({ type: "  task  " })).includes("type: task\n"), true);
});

test("T-ticket-priority", () => {
  assert.deepEqual(TICKET_PRIORITIES, ["low", "medium", "high"]);
  assert.equal(Object.isFrozen(TICKET_PRIORITIES), true);
  assert.throws(() => TICKET_PRIORITIES.push("urgent"));
  for (const priority of TICKET_PRIORITIES) {
    const text = SIMPLE.replace("priority: medium", `priority: ${priority}`);
    const parsed = parseTicket(ID, text);
    assert.equal(parsed.priority, priority);
    assert.equal(Object.keys(parsed).indexOf("priority"), Object.keys(parsed).indexOf("type") + 1);
    assert.equal(composeTicket(parsed), text);
    assert.equal(composeTicket(ticket({ priority })), text);
    const header = text.slice(0, text.indexOf("\n\n")).split("\n");
    assert.equal(header[2], `type: ${parsed.type}`);
    assert.equal(header[3], `priority: ${priority}`);
  }

  const highText = SIMPLE.replace("priority: medium", "priority: high");
  const high = parseTicket(ID, highText);
  assert.equal(high.priority, "high");
  assert.equal(composeTicket(high), highText);
  assert.equal(highText.split("\n")[2], "type: task");
  assert.equal(highText.split("\n")[3], "priority: high");

  assert.equal(parseTicket(ID, SIMPLE.replace("priority: medium", "priority: urgent")), null);
  assert.equal(parseTicket(ID, SIMPLE.replace("priority: medium\n", "")), null);
  assert.equal(composeTicket(ticket({ priority: "urgent" })), null);
  assert.equal(composeTicket(ticket({ priority: undefined })), null);
  for (const priority of ["", "nope", "High", "MEDIUM", "critical"]) {
    assert.equal(parseTicket(ID, SIMPLE.replace("priority: medium", priority === "" ? "priority:" : `priority: ${priority}`)), null);
    assert.equal(composeTicket(ticket({ priority })), null);
  }
  assert.equal(parseTicket(ID, SIMPLE.replace("priority: medium", "priority:high")), null);
  assert.equal(parseTicket(ID, SIMPLE.replace("priority: medium", "priority:   high  ")).priority, "high");
  assert.equal(parseTicket(ID, SIMPLE.replace("priority: medium", "priority: low ")).priority, "low");
  assert.equal(composeTicket(ticket({ priority: "  high  " })).includes("priority: high\n"), true);
});

test("T-ticket-self", () => {
  const tickets = [entry(A, "", []), entry(B, "", [])];
  const before = JSON.stringify(tickets);

  assert.equal(rejectLink(tickets, A, A, []), "self");
  assert.equal(rejectLink(tickets, A, "", [A]), "self");
  assert.equal(rejectLink(tickets, A, A, [A]), "self");
  assert.equal(rejectLink(tickets, A, B, [B, A]), "self");
  assert.equal(rejectLink([], A, A, []), "self", "self does not require the id to already exist");
  assert.equal(rejectLink([entry(B)], A, "", [A]), "self");
  assert.equal(rejectLink([], A, A, [C]), "self", "self wins over a missing depend");
  assert.equal(rejectLink([entry(B, A, [])], A, B, [A]), "self", "self wins over a parent cycle");

  assert.equal(rejectLink([entry(B)], undefined, B, []), null);
  assert.equal(rejectLink([entry(B)], null, "", [B]), null);
  assert.equal(rejectLink([], "", "", []), null);
  assert.equal(rejectLink(tickets, A, "", []), null);
  assert.equal(JSON.stringify(tickets), before);
});

test("T-ticket-cycle", () => {
  assert.equal(rejectLink([entry(A, B), entry(B, A)], A, B, []), "cycle");
  assert.equal(rejectLink([entry(A), entry(B, C), entry(C, A)], A, B, []), "cycle");
  assert.equal(rejectLink([entry(B, C), entry(C, N)], N, B, []), "cycle");

  assert.equal(rejectLink([entry(A, "", [B]), entry(B, "", [A])], A, "", [B]), "cycle");
  assert.equal(
    rejectLink([entry(A), entry(B, "", [C]), entry(C, "", [A])], A, "", [B]),
    "cycle",
  );
  assert.equal(rejectLink([entry(B, "", [C]), entry(C, "", [N])], N, "", [B]), "cycle");
  assert.equal(
    rejectLink([entry(B, "", [D]), entry(C), entry(D, "", [A])], A, "", [C, B]),
    "cycle",
  );

  assert.equal(
    rejectLink([entry(B)], A, B, [B]),
    null,
    "depending on your own parent is allowed",
  );
  assert.equal(rejectLink([entry(B, C), entry(C)], A, B, [C]), null);

  assert.equal(
    rejectLink([entry(B, A)], A, "", [B]),
    null,
    "a parent edge back is not a depends cycle",
  );
  assert.equal(
    rejectLink([entry(B, "", [A])], A, B, []),
    null,
    "a depends edge back is not a parent cycle",
  );

  assert.equal(rejectLink([entry(B, C), entry(C, B)], A, "", []), null);
  assert.equal(rejectLink([entry(B, C), entry(C, B)], A, B, []), null);
  assert.equal(rejectLink([entry(B, B)], A, B, []), null);
  assert.equal(rejectLink([entry(B, "", [C]), entry(C, "", [B])], A, "", [B]), null);
  assert.equal(rejectLink([entry(B, "", [B])], A, "", [B]), null);
  assert.equal(rejectLink([entry(A, B), entry(B, A)], A, "", []), null);
  assert.equal(rejectLink([entry(A, "", [B]), entry(B, "", [A])], A, "", []), null);
  assert.equal(rejectLink([entry(B), entry(C)], A, B, [C, B]), null);
  assert.equal(rejectLink([entry(B, C), entry(C, B), entry(D)], N, D, []), null);

  assert.equal(rejectLink([entry(A), entry(B)], A, "zzzzzzzz", []), "missing");
  assert.equal(rejectLink([entry(B)], A, "", [B, C]), "missing");
  assert.equal(rejectLink([entry(B)], undefined, "zzzzzzzz", []), "missing");
  assert.equal(rejectLink([], N, "", []), null);
  assert.equal(rejectLink([entry(B)], undefined, B, [B]), null);
  assert.equal(
    rejectLink([entry(B, "", [A])], A, "", [B, C]),
    "missing",
    "a dangling depend is missing even when another depend would cycle",
  );

  const stored = [entry(A, B, [C]), entry(B, "", [C]), entry(C)];
  const snapshot = JSON.stringify(stored);
  assert.equal(rejectLink(stored, A, "", [B]), null);
  assert.equal(JSON.stringify(stored), snapshot);
});

test("T-ticket-id", () => {
  assert.equal(TICKET_ALPHABET, "23456789abcdefghjkmnpqrstuvwxyz");
  for (const ch of "01iloILO") assert.equal(TICKET_ALPHABET.includes(ch), false);

  const generated = generateId();
  assert.equal(generated.length, 8);
  for (const ch of generated) assert.equal(TICKET_ALPHABET.includes(ch), true);

  let draws = 0;
  const random = () => {
    draws += 1;
    return 0;
  };
  assert.equal(generateId(random), "22222222");
  assert.equal(generateId(random), "22222222");
  assert.equal(draws, 16);

  const original = Math.random;
  Math.random = () => 0;
  try {
    assert.equal(generateId(), "22222222");
  } finally {
    Math.random = original;
  }

  let index = 0;
  const swept = generateId(() => {
    const sample = (index + 0.5) / TICKET_ALPHABET.length;
    index += 1;
    return sample;
  });
  assert.equal(swept, TICKET_ALPHABET.slice(0, 8));
  const produced = [];
  for (let i = 0; i < TICKET_ALPHABET.length; i += 1) {
    produced.push(generateId(() => (i + 0.5) / TICKET_ALPHABET.length)[0]);
  }
  assert.equal(produced.join(""), TICKET_ALPHABET);
  assert.equal(generateId(() => 0.999999), "zzzzzzzz");
  assert.equal(generateId(() => 1), "zzzzzzzz");
  assert.equal(generateId(() => -1), "22222222");
  assert.equal(generateId(() => Number.NaN), "22222222");

  assert.equal(parseTicket(ID, SIMPLE).id, ID);
  for (const bad of ["", "2345678", "234567890", "2345678I", "23456780", "23456781", "iiiiiiii", "llllllll", "oooooooo", "AAAAAAAA", null, undefined]) {
    assert.equal(parseTicket(bad, SIMPLE), null);
    assert.equal(composeTicket(ticket({ id: bad })), null);
  }

  assert.equal(parseTicket(ID, SIMPLE.replace("parent:", `parent: ${B}`)).parent, B);
  assert.equal(parseTicket(ID, SIMPLE.replace("parent:", "parent:")).parent, "");
  for (const parent of ["aaaaaaa", "aaaaaaaaa", "aaaaaaai", "aaaaaaa0", "aaaaaaa1", `${B} ${C}`]) {
    assert.equal(parseTicket(ID, SIMPLE.replace("parent:", `parent: ${parent}`)), null);
    assert.equal(composeTicket(ticket({ parent })), null);
  }

  const oneDep = SIMPLE.replace("depends:", `depends: ${B}`);
  assert.deepEqual(parseTicket(ID, oneDep).depends, [B]);
  assert.equal(composeTicket(parseTicket(ID, oneDep)), oneDep);
  assert.equal(parseTicket(ID, SIMPLE.replace("depends:", `depends: ${B},${C}`)), null);
  assert.equal(parseTicket(ID, SIMPLE.replace("depends:", `depends: ${B}\t${C}`)), null);
  assert.equal(parseTicket(ID, SIMPLE.replace("depends:", "depends: aaaaaai")), null);
  assert.equal(composeTicket(ticket({ depends: [B, "aaaaaaai"] })), null);
  assert.equal(composeTicket(ticket({ depends: "bbbbbbbb" })), null);

  const reporter = parseTicket(ID, SIMPLE.replace("reporter: indexer", "reporter:   Ada Lovelace  "));
  assert.equal(reporter.reporter, "Ada Lovelace");
  assert.equal(composeTicket(reporter).includes("reporter: Ada Lovelace\n"), true);
});

test("assignee is optional and stays off the file until it is set", () => {
  const absent = parseTicket(ID, SIMPLE);
  assert.equal(absent.assignee, "");
  assert.equal(composeTicket(absent), SIMPLE);
  assert.equal(SIMPLE.includes("assignee:"), false);
  assert.equal(Object.keys(absent).indexOf("assignee"), Object.keys(absent).indexOf("priority") + 1);

  const named = SIMPLE.replace("priority: medium\n", "priority: medium\nassignee: ada\n");
  const parsed = parseTicket(ID, named);
  assert.equal(parsed.assignee, "ada");
  assert.equal(composeTicket(parsed), named);
  assert.equal(composeTicket(ticket({ assignee: "  ada  " })), named);
  assert.equal(composeTicket(ticket({ assignee: "   " })), SIMPLE);
  assert.equal(composeTicket(ticket({ assignee: "" })), SIMPLE);
  assert.equal(composeTicket({ ...ticket(), title: "Renamed", assignee: "" }).includes("assignee:"), false);

  const padded = named.replace("assignee: ada", "assignee:   ada  ");
  assert.equal(parseTicket(ID, padded).assignee, "ada");
  assert.equal(composeTicket(parseTicket(ID, padded)), named);

  assert.equal(parseTicket(ID, SIMPLE.replace("priority: medium\n", "priority: medium\nassignee: ada\nassignee: bea\n")), null);
  assert.equal(parseTicket(ID, SIMPLE.replace("title: Fix the login redirect\n", "assignee: ada\ntitle: Fix the login redirect\n")), null);
  assert.equal(composeTicket(ticket({ assignee: "ada\t" })), null);
  assert.equal(composeTicket(ticket({ assignee: "ada\nbea" })), null);
  assert.equal(composeTicket(ticket({ assignee: "\tada" })), null);
  assert.equal(parseTicket(ID, named.replace("assignee: ada", "assignee: ada\tbea")), null);
});

function scope(home, repos, nodes) {
  return { home, repos, tickets: nodes };
}

function node(repo, id, parent = "", depends = []) {
  return { repo, id, parent, depends };
}

test("T-ticket-cross-repo", () => {
  const K = "k2n4p7qa";
  const repo64 = `r${"a".repeat(63)}`;
  const repo65 = `r${"a".repeat(64)}`;
  assert.equal(repo64.length, 64);
  assert.equal(repo65.length, 65);

  const parent = `other:${B}`;
  const depends = [A, `my_repo-2:${C}`, parent];
  const stored = ticket({ parent, depends: [parent, A, parent, `my_repo-2:${C}`] });
  const text = composeTicket(stored);
  assert.equal(text.includes(`parent: ${parent}\n`), true);
  assert.equal(text.includes(`depends: ${A} my_repo-2:${C} ${parent}\n`), true);
  assert.equal(text.includes(`docs:${A}`), false);
  assert.equal(text.includes(`depends: ${parent}`), false);
  const parsed = parseTicket(ID, text);
  assert.equal(parsed.parent, parent);
  assert.deepEqual(parsed.depends, depends);
  assert.equal(composeTicket(parsed), text);

  const both = composeTicket(ticket({ depends: [A, `docs:${A}`, `docs:${A}`] }));
  assert.equal(both.includes(`depends: ${A} docs:${A}\n`), true);
  assert.deepEqual(parseTicket(ID, both).depends, [A, `docs:${A}`]);

  const spaced = SIMPLE.replace("depends:", `depends: ${parent}  ${A}   my_repo-2:${C}`);
  assert.deepEqual(parseTicket(ID, spaced).depends, depends);
  assert.equal(parseTicket(ID, SIMPLE.replace("parent:", `parent:   ${parent}  `)).parent, parent);
  assert.equal(parseTicket(ID, SIMPLE.replace("parent:", `parent: ${repo64}:${A}`)).parent, `${repo64}:${A}`);
  assert.equal(parseTicket(ID, SIMPLE.replace("parent:", `parent: my_repo-2:${A}`)).parent, `my_repo-2:${A}`);
  assert.equal(composeTicket(ticket({ parent: `my_repo-2:${A}` })).includes(`parent: my_repo-2:${A}\n`), true);

  for (const bad of [
    "other:",
    `:${K}`,
    `other:${K}:x`,
    `other :${K}`,
    "other:k2n4p7q",
    "other:iiiiiiii",
    `_repo:${A}`,
    `${repo65}:${A}`,
    `${B},${C}`,
  ]) {
    assert.equal(parseTicket(ID, SIMPLE.replace("parent:", `parent: ${bad}`)), null, bad);
    assert.equal(composeTicket(ticket({ parent: bad })), null, bad);
    assert.equal(parseTicket(ID, SIMPLE.replace("depends:", `depends: ${bad}`)), null, bad);
    assert.equal(composeTicket(ticket({ depends: [bad] })), null, bad);
  }
  assert.equal(parseTicket(ID, SIMPLE.replace("depends:", `depends: ${B},${C}`)), null);
  assert.equal(composeTicket(ticket({ depends: [A, "aaaaaaai"] })), null);

  const one = [entry(A), entry(B)];
  const oneBefore = JSON.stringify(one);
  assert.equal(rejectLink(one, A, `other:${B}`, []), null);
  assert.equal(rejectLink(one, A, "", [`other:${B}`]), null);
  assert.equal(rejectLink(one, A, `docs:${A}`, []), null);
  assert.equal(rejectLink(one, A, "zzzzzzzz", []), "missing");
  assert.equal(rejectLink(one, A, "", [B, C]), "missing");
  assert.equal(JSON.stringify(one), oneBefore);

  const emptyHome = scope("docs", ["docs"], []);
  assert.equal(rejectLink(emptyHome, A, `docs:${A}`, []), "self");
  assert.equal(rejectLink(emptyHome, A, A, []), "self");
  assert.equal(rejectLink(emptyHome, A, "", [`docs:${A}`]), "self");
  assert.equal(rejectLink(emptyHome, A, `docs:${A}`, ["zzzzzzzz"]), "self");

  const registered = ["docs", "other", "my_repo-2"];
  assert.equal(rejectLink(scope("docs", registered, [node("docs", B)]), A, `other:${C}`, []), "missing");
  assert.equal(rejectLink(scope("docs", registered, [node("other", B)]), A, B, []), "missing");
  assert.equal(rejectLink(scope("docs", registered, []), A, `my_repo-2:${K}`, []), "missing");
  assert.equal(rejectLink(scope("docs", registered, [node("other", B)]), A, `other:${B}`, []), null);
  assert.equal(rejectLink(scope("docs", ["docs"], [node("docs", B)]), A, `docs:${B}`, []), null);
  assert.equal(rejectLink(scope("docs", ["docs"], [node("docs", B)]), A, `ghost:${K}`, []), null);
  assert.equal(rejectLink(scope("docs", ["docs", "other"], [node("other", C, `ghost:${K}`)]), A, `other:${C}`, []), null);

  const cross = scope("docs", ["docs", "other"], [
    node("docs", A, `other:${B}`),
    node("other", B, `docs:${A}`),
  ]);
  const crossBefore = JSON.stringify(cross);
  assert.equal(rejectLink(cross, A, `other:${B}`, []), "cycle");
  assert.equal(JSON.stringify(cross), crossBefore);

  const qualified = scope("docs", ["docs", "other"], [
    node("docs", A, `other:${B}`),
    node("other", B, A),
  ]);
  assert.equal(rejectLink(qualified, A, `other:${B}`, []), null);
  assert.equal(qualified.tickets[1].parent, A);
  assert.equal(rejectLink(scope("docs", ["docs", "other"], [
    node("docs", A, `other:${B}`),
    node("other", B, `docs:${A}`),
  ]), A, `other:${B}`, []), "cycle");

  assert.equal(rejectLink(scope("docs", ["docs", "other"], [
    node("docs", A, `other:${B}`),
    node("other", B, `ghost:${C}`),
    node("ghost", C, `docs:${A}`),
  ]), A, `other:${B}`, []), null);
  assert.equal(rejectLink(scope("docs", ["docs", "other", "ghost"], [
    node("docs", A, `other:${B}`),
    node("other", B, `ghost:${C}`),
    node("ghost", C, `docs:${A}`),
  ]), A, `other:${B}`, []), "cycle");

  assert.equal(rejectLink(scope("docs", ["docs", "other"], [
    node("docs", A),
    node("other", B),
  ]), A, `other:${B}`, [`other:${B}`]), null);
  assert.equal(rejectLink(scope("docs", ["docs", "other"], [
    node("docs", A, "", [`other:${B}`]),
    node("other", B, "", [`docs:${A}`]),
  ]), A, "", [`other:${B}`]), "cycle");
  assert.equal(rejectLink(scope("docs", ["docs", "other"], [
    node("docs", A, "", [`other:${B}`]),
    node("other", B, `docs:${A}`),
  ]), A, "", [`other:${B}`]), null);
  assert.equal(rejectLink(scope("docs", ["docs", "other"], [
    node("other", B, "", [`docs:${A}`]),
  ]), A, "", [`other:${C}`]), "missing");
  assert.equal(rejectLink(scope("docs", ["docs"], [
    node("docs", A, "", [`other:${C}`]),
  ]), A, "", [`other:${C}`]), null);

  const ghostHeld = scope("docs", ["docs"], [node("docs", A, `ghost:${K}`, [`ghost:${K}`])]);
  const ghostSnap = JSON.stringify(ghostHeld);
  assert.deepEqual(
    dropStoredMissing(ghostHeld, `ghost:${K}`, [`ghost:${K}`], `ghost:${K}`, [`ghost:${K}`]),
    { parent: `ghost:${K}`, depends: [`ghost:${K}`] },
  );
  assert.equal(JSON.stringify(ghostHeld), ghostSnap);
  const ghostGone = scope("docs", ["docs", "ghost"], [node("docs", A, `ghost:${K}`)]);
  assert.deepEqual(
    dropStoredMissing(ghostGone, `ghost:${K}`, [], `ghost:${K}`, []),
    { parent: "", depends: [] },
  );
  const mixed = scope("docs", ["docs", "other"], [node("docs", A), node("other", B)]);
  assert.deepEqual(
    dropStoredMissing(mixed, "", [`other:${C}`, `other:${B}`], "", [`other:${B}`, `other:${C}`, `other:${K}`]),
    { parent: "", depends: [`other:${B}`, `other:${K}`] },
  );
  assert.equal(rejectLink(mixed, A, "", [`other:${K}`]), "missing");
  assert.deepEqual(
    dropStoredMissing(mixed, "", [], "", [`other:${K}`]),
    { parent: "", depends: [`other:${K}`] },
  );
  assert.deepEqual(
    dropStoredMissing(scope("docs", ["docs"], [node("docs", A)]), A, [], A, []),
    { parent: A, depends: [] },
  );
  assert.deepEqual(
    dropStoredMissing(scope("docs", ["docs"], []), "other:", [], "other:", []),
    { parent: "other:", depends: [] },
  );
  assert.deepEqual(
    dropStoredMissing([entry(A)], "zzzzzzzz", [C], "zzzzzzzz", [B, C]),
    { parent: "", depends: [B] },
  );
  const throughGhost = scope("docs", ["docs", "other", "ghost"], [
    node("docs", A, `other:${B}`, [`ghost:${K}`]),
    node("other", B, `docs:${A}`),
  ]);
  const droppedCycle = dropStoredMissing(throughGhost, `other:${B}`, [`ghost:${K}`], `other:${B}`, [`ghost:${K}`]);
  assert.deepEqual(droppedCycle, { parent: `other:${B}`, depends: [] });
  assert.equal(rejectLink(throughGhost, A, droppedCycle.parent, droppedCycle.depends), "cycle");
});
