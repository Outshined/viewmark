import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { AGENT, OTHER, REPO, cli, launchBrowser, Page, startHub } from "./harness.js";

// R106, decided by the owner on 2026-10-10 (editing.md, c10): a file a session has open cannot
// be deleted, and a rename or a move updates every session that has it open. D36 (a closed
// session lets go within 30 seconds) and D37 (a move keeps the caret's place) are QA proposals.

const run = (hub, ...args) => cli(hub.port, ["--user", AGENT, "--repo", REPO, ...args]);

async function setup(t, docs) {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  for (const [name, text] of Object.entries(docs)) await hub.create(name, text);
  browser = await launchBrowser();
  const A = new Page(browser.session, hub.port);
  await A.init();
  await A.login();
  return { hub, browser, A };
}

async function second(browser, hub, user = OTHER) {
  const { session, targetId } = await browser.newSession();
  const B = new Page(session, hub.port);
  await B.init();
  await B.login(user);
  return { B, targetId };
}

async function clickFile(page, label) {
  const point = await page.eval(`(() => { const b = [...document.querySelectorAll(".file-block button.md-file")].find((x) => x.textContent === ${JSON.stringify(label)}); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + 8, y: r.top + r.height / 2 }; })()`);
  assert.ok(point, `no file row ${label}`);
  await page.click(point.x, point.y);
  await page.until(() => page.eval(`location.hash.endsWith(${JSON.stringify(encodeURIComponent(label))})`), `the page opened ${label}`);
  await page.quiet();
}

const files = (page) => page.eval(`[...document.querySelectorAll(".file-block button.md-file")].map((b) => b.dataset.path + "=" + b.textContent)`);

// Polls the CLI delete until it goes through or the time runs out.
async function deleteWithin(hub, file, ms) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < ms) {
    last = await run(hub, "delete", file);
    if (last.code === 0) return { ok: true, after: Date.now() - started };
    await sleep(2000);
  }
  return { ok: false, last };
}

test("a file a session has open cannot be deleted by the CLI", async (t) => {
  const { hub, A } = await setup(t, { "d.md": "# Dee\n\ndelete me\n" });
  await A.open("d.md");
  await A.clickOffset(9);
  await A.quiet();
  const out = await run(hub, "delete", "d.md");
  assert.notEqual(out.code, 0, "the delete went through");
  assert.match(out.stderr, /409/);
  assert.match(out.stderr, /qa-bot/, out.stderr);
  assert.equal((await hub.show("d.md")).text, "# Dee\n\ndelete me\n");
});

test("the page's Delete is refused while another session has the file open", async (t) => {
  const { hub, browser, A } = await setup(t, { "z.md": "zed\n" });
  await A.open("z.md");
  const { B } = await second(browser, hub);
  await B.open("z.md");
  await B.clickOffset(1);
  await B.quiet();
  const del = await A.eval(`(() => { const b = document.querySelector('.file-block .md-pane-head button[aria-label="Delete file"]'); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await A.click(del.x, del.y);
  await A.frame();
  const yes = await A.eval(`(() => { const b = [...document.querySelectorAll(".md-confirm-actions button")].find((x) => x.textContent === "Delete"); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  assert.ok(yes, "no Delete button in the confirm dialog");
  const since = A.frames.length;
  await A.click(yes.x, yes.y);
  await A.until(() => A.frames.slice(since).some((f) => f.dir === "in" && f.data && (f.data.type === "error" || f.data.type === "deleted")), "the hub's answer");
  const answer = A.frames.slice(since).find((f) => f.dir === "in" && f.data && (f.data.type === "error" || f.data.type === "deleted")).data;
  assert.equal(answer.type, "error", `the delete went through: ${JSON.stringify(answer)}`);
  assert.equal(answer.status, 409);
  assert.equal(answer.heldBy, "qa-two", `the refusal names ${answer.heldBy}, not the session that has the file open`);
  assert.equal((await hub.show("z.md")).text, "zed\n");
});

test("a file the session left by the files list can be deleted", async (t) => {
  const { hub, A } = await setup(t, { "a.md": "a\n", "b.md": "b\n" });
  await A.open("a.md");
  await A.clickOffset(1);
  await A.quiet();
  await clickFile(A, "b.md");
  const out = await run(hub, "delete", "a.md");
  assert.equal(out.code, 0, out.stderr);
  await A.until(async () => !(await files(A)).some((f) => f.startsWith("a.md=")), "a.md leaves the files list");
});

test("a closed tab lets go of its file within 30 seconds", async (t) => {
  const { hub, browser } = await setup(t, { "z.md": "zed line\n\nsecond\n" });
  const { B, targetId } = await second(browser, hub);
  await B.open("z.md");
  await B.clickOffset(2);
  await B.quiet();
  await browser.closeTarget(targetId);
  const result = await deleteWithin(hub, "z.md", 35000);
  assert.ok(result.ok, `z.md is still held 35 s after its tab closed: ${result.last && result.last.stderr.trim()}`);
});

test("a reload lets go of the file it left within 30 seconds", async (t) => {
  const { hub, A } = await setup(t, { "a.md": "a\n", "c.md": "c\n" });
  await A.open("a.md");
  await A.clickOffset(1);
  await A.quiet();
  await A.open("c.md");
  const result = await deleteWithin(hub, "a.md", 35000);
  assert.ok(result.ok, `a.md is still held 35 s after the page reloaded to c.md: ${result.last && result.last.stderr.trim()}`);
});

test("a move updates every session that has the file open", async (t) => {
  const { hub, browser, A } = await setup(t, { "m.md": "# Em\n\nmove me\n", "keep/k.md": "k\n" });
  await A.open("m.md");
  await A.clickOffset(8);
  await A.quiet();
  const { B } = await second(browser, hub);
  await B.open("m.md");
  await B.quiet();
  const out = await run(hub, "move", "m.md", "--dir", "keep");
  assert.equal(out.code, 0, out.stderr);
  for (const [name, page] of [["A", A], ["B", B]]) {
    await page.until(() => page.eval(`location.hash.endsWith("keep%2Fm.md")`), `${name}'s address names keep/m.md`);
    await page.until(async () => (await files(page)).includes("keep/m.md=Em"), `${name}'s files list shows keep/m.md`);
    assert.ok(!(await files(page)).some((f) => f.startsWith("m.md=")), `${name}'s files list still shows m.md`);
  }
  // A key after a click lands in the moved file.
  await A.clickOffset(10);
  await A.quiet();
  await A.key("y");
  await A.quiet();
  await sleep(200);
  assert.equal((await hub.show("keep/m.md")).text, "# Em\n\nmovey me\n");
});

test("a move keeps the caret's place in the text", async (t) => {
  const { hub, A } = await setup(t, { "m.md": "# Em\n\nmove me\n", "keep/k.md": "k\n" });
  await A.open("m.md");
  await A.clickOffset(8);
  await A.quiet();
  const out = await run(hub, "move", "m.md", "--dir", "keep");
  assert.equal(out.code, 0, out.stderr);
  await A.until(() => A.eval(`location.hash.endsWith("keep%2Fm.md")`), "the address names keep/m.md");
  await A.quiet();
  assert.equal((await A.caret()).focus, 8, "the caret moved");
  await A.key("x");
  await A.quiet();
  await sleep(200);
  assert.equal((await hub.show("keep/m.md")).text, "# Em\n\nmoxve me\n");
});

test("a title change shows in every session's files list", async (t) => {
  const { hub, browser, A } = await setup(t, { "t.md": "# Old title\n\nbody\n", "o.md": "other\n" });
  await A.open("t.md");
  await A.clickOffset(15);
  await A.quiet();
  const { B } = await second(browser, hub);
  await B.open("o.md");
  const out = await cli(hub.port, ["--user", AGENT, "--repo", REPO, "edit", "t.md"], "@@\n-# Old title\n+# New title\n");
  assert.equal(out.code, 0, out.stderr);
  for (const [name, page] of [["A", A], ["B", B]]) {
    await page.until(async () => (await files(page)).includes("t.md=New title"), `${name}'s files list shows New title`);
  }
});
