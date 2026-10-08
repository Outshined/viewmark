import test from "node:test";
import assert from "node:assert/strict";
import { offsetAt, parseUnifiedDiff, planDiff } from "../src/doc.js";

function hunk(rows) {
  return { old: rows.filter((row) => row.tag !== "+").map((row) => row.text), new: rows.filter((row) => row.tag !== "-").map((row) => row.text) };
}

test("parseUnifiedDiff keeps old and new lines and ignores placement headers", () => {
  const parsed = parseUnifiedDiff([
    "diff --git a/hello.md b/hello.md",
    "index 111..222 100644",
    "--- a/hello.md",
    "+++ b/hello.md",
    "@@ -99,2 +3,2 @@",
    " Alpha",
    "-Beta",
    "-Gamma",
    "+Beta",
    "+Delta",
    "\\ No newline at end of file",
    "",
  ].join("\n"));
  assert.deepEqual(parsed.hunks, [hunk([
    { tag: " ", text: "Alpha" },
    { tag: "-", text: "Beta" },
    { tag: "-", text: "Gamma" },
    { tag: "+", text: "Beta" },
    { tag: "+", text: "Delta" },
  ])]);

  const dashed = parseUnifiedDiff([
    "diff --git a/hello.md b/hello.md",
    "index 111..222 100644",
    "--- a/hello.md",
    "+++ b/hello.md",
    "@@",
    " keep",
    "--- note",
    "+++ new",
  ].join("\n"));
  assert.equal(dashed.hunks.length, 1);
  assert.deepEqual(dashed.hunks[0].old, ["keep", "-- note"]);
  assert.deepEqual(dashed.hunks[0].new, ["keep", "++ new"]);
});

test("parseUnifiedDiff rejects a hunk with no old lines and a malformed body", () => {
  assert.deepEqual(parseUnifiedDiff("@@\n+only\n"), { error: "no-context" });
  assert.deepEqual(parseUnifiedDiff("not a diff\n"), { error: "invalid" });
  assert.deepEqual(parseUnifiedDiff("@@\n-kept\n\n+nope\n"), { error: "invalid" });
  assert.deepEqual(parseUnifiedDiff("@@\n"), { error: "no-context" });
  assert.deepEqual(parseUnifiedDiff(""), { hunks: [] });
  assert.deepEqual(parseUnifiedDiff("diff --git a b\n--- a\n+++ b\n"), { hunks: [] });
});

function applySplices(text, splices) {
  const ordered = splices.slice().sort((a, b) => b.from - a.from);
  let next = text;
  for (const splice of ordered) {
    next = next.slice(0, splice.from) + splice.inserted + next.slice(splice.to);
  }
  return next;
}

test("planDiff splices each hunk against the original slice", () => {
  const text = "Alpha\nBeta\nGamma\n";
  const parsed = parseUnifiedDiff("@@\n-Beta\n-Gamma\n+Beta\n+Delta\n");
  const plan = planDiff(text, parsed.hunks, null, null);
  assert.equal(plan.splices.length, 1);
  assert.equal(applySplices(text, plan.splices), "Alpha\nBeta\nDelta\n");
  assert.ok(plan.splices[0].from >= "Alpha\n".length);

  const body = "Alpha\n\nBeta\n\nGamma\n";
  const two = parseUnifiedDiff("@@\n-Alpha\n+A\n@@\n-Gamma\n+G\n");
  const apart = planDiff(body, two.hunks, null, null);
  assert.equal(apart.splices.length, 2);
  assert.equal(applySplices(body, apart.splices), "A\n\nBeta\n\nG\n");
  const beta = body.indexOf("Beta");
  for (const splice of apart.splices) {
    assert.ok(splice.to <= beta || splice.from >= beta + "Beta".length);
  }
});

test("planDiff reports context, matches, overlap, and a ranged slice", () => {
  const repeated = "one\ntwo\none\n";
  const change = parseUnifiedDiff("@@\n-one\n+ONE\n").hunks;
  assert.deepEqual(planDiff(repeated, change, null, null), { error: "matches", matches: 2 });
  const third = offsetAt(repeated, 3, 0);
  const thirdEnd = offsetAt(repeated, 3, 3);
  const ranged = planDiff(repeated, change, third.offset, thirdEnd.offset);
  assert.equal(ranged.splices.length, 1);
  const next = repeated.slice(0, ranged.splices[0].from) + ranged.splices[0].inserted + repeated.slice(ranged.splices[0].to);
  assert.equal(next, "one\ntwo\nONE\n");

  assert.deepEqual(planDiff("Alpha\nBeta\nGamma\n", parseUnifiedDiff("@@\n-Gone\n+X\n").hunks, null, null), { error: "context" });
  assert.deepEqual(planDiff("a\na\na\n", parseUnifiedDiff("@@\n-a\n-a\n+b\n").hunks, null, null), { error: "matches", matches: 2 });
  assert.deepEqual(
    planDiff("Alpha\nBeta\n", parseUnifiedDiff("@@\n-Alpha\n-Beta\n@@\n-Beta\n").hunks, null, null),
    { error: "overlap" },
  );
  assert.deepEqual(planDiff("Alpha\nBeta\n", parseUnifiedDiff("@@\n Alpha\n").hunks, null, null), { splices: [] });

  const outside = "Alpha\nBee\nGone\n";
  const beta = offsetAt(outside, 2, 0);
  const betaEnd = offsetAt(outside, 2, 3);
  const kept = planDiff(outside, parseUnifiedDiff("@@\n-Bee\n+Beta\n").hunks, beta.offset, betaEnd.offset);
  const restored = outside.slice(0, kept.splices[0].from) + kept.splices[0].inserted + outside.slice(kept.splices[0].to);
  assert.equal(restored, "Alpha\nBeta\nGone\n");
});

test("offsetAt accepts the line length and rejects a column past it", () => {
  const text = "one\ntwo\none\n";
  assert.deepEqual(offsetAt(text, 3, 3), { offset: 11 });
  assert.deepEqual(offsetAt(text, 3, 4), { error: 400 });
  assert.deepEqual(offsetAt(text, 0, 0), { error: 400 });
  assert.deepEqual(offsetAt(text, 5, 0), { error: 400 });
});

test("deleting every line keeps a trailing newline", () => {
  const text = "Alpha\n";
  const plan = planDiff(text, parseUnifiedDiff("@@\n-Alpha\n").hunks, null, null);
  const next = text.slice(0, plan.splices[0].from) + plan.splices[0].inserted + text.slice(plan.splices[0].to);
  assert.equal(next, "\n");
});
