import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { AGENT, REPO, cli, launchBrowser, Page, startHub } from "./harness.js";

// Acceptance for tickets dnvagjc6 (the open files drawer fits what it shows) and xvh6fh34 (the
// add and delete buttons stay put). The pointer reaches the drawer by real mouse events, and
// none moves between a change and its measurement.

const DEEP = "a-file-name-long-enough-to-need-a-wider-drawer-than-the-column.md";
const HUGE = `${"an-extremely-long-file-name-".repeat(6)}end.md`;
const LATE = "a-later-file-whose-name-is-wider-than-everything-else-in-the-list.md";

const MEASURE = `(() => {
  const block = document.querySelector(".file-block");
  const panel = document.querySelector(".md-file-drawer");
  const head = block.querySelector(".md-pane-head");
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  };
  const rows = [...panel.querySelectorAll("button.md-file, button.md-dir-toggle")]
    .filter((button) => button.getClientRects().length > 0)
    .map((button) => ({ text: button.textContent, scroll: button.scrollWidth, client: button.clientWidth }));
  return {
    panel: box(panel),
    wide: panel.classList.contains("md-file-wide"),
    head: [...head.querySelectorAll("button")].map(box),
    rows,
    cap: window.innerWidth * 0.8,
  };
})()`;

function near(actual, expected, label, slack = 1) {
  assert.ok(Math.abs(actual - expected) <= slack, `${label}: ${actual} vs ${expected}`);
}

function sameHead(now, before, label) {
  assert.equal(now.head.length, before.head.length, `${label}: head buttons`);
  for (let i = 0; i < before.head.length; i += 1) {
    near(now.head[i].left, before.head[i].left, `${label}: head button ${i} left`);
    near(now.head[i].top, before.head[i].top, `${label}: head button ${i} top`);
  }
}

function whole(state, label, except = "") {
  for (const row of state.rows) {
    if (except && row.text.includes(except)) continue;
    assert.ok(row.scroll <= row.client, `${label}: ${JSON.stringify(row.text)} is cut, scrollWidth ${row.scroll} > clientWidth ${row.client}`);
  }
}

async function moveTo(page, point) {
  await page.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
}

// A press and release where the pointer already is. No mouseMoved is sent.
async function clickHere(page, point) {
  await page.session.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await page.session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
}

function toggleAt(page, dir) {
  return page.eval(`(() => {
    const button = document.querySelector('.md-file-drawer button.md-dir-toggle[data-dir="${dir}"]');
    if (!button) return null;
    const r = button.getBoundingClientRect();
    return { x: r.left + Math.min(20, r.width / 2), y: r.top + r.height / 2 };
  })()`);
}

// Polls until the panel's width holds still for 150 ms. Returns the state, and the ms after
// `from` at which the width first moved more than 8 px from `start`.
async function settle(page, from, start, limit = 2500) {
  let last = null;
  let still = 0;
  let moved = null;
  for (;;) {
    const state = await page.eval(MEASURE);
    if (moved == null && start != null && Math.abs(state.panel.width - start) > 8) moved = Date.now() - from;
    if (last && Math.abs(state.panel.width - last.panel.width) < 0.5) still += 1;
    else still = 0;
    if (still >= 3) return { state, moved };
    if (Date.now() - from > limit) return { state, moved };
    last = state;
    await sleep(50);
  }
}

async function setup(t) {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  await hub.create("short.md", "short\n");
  await hub.create("notes.md", "notes\n");
  await hub.create(`deep/${DEEP}`, "deep\n");
  await hub.create(`huge/${HUGE}`, "huge\n");
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.login();
  await page.open("short.md");
  await page.until(
    () => page.eval(`!!document.querySelector('.md-file-drawer button.md-dir-toggle[data-dir="deep"]') && !!document.querySelector('.md-file-drawer button.md-dir-toggle[data-dir="huge"]')`),
    "folder rows",
  );
  const away = await page.eval(`(() => {
    const r = document.getElementById("editor").getBoundingClientRect();
    return { x: r.left + 40, y: r.top + 40 };
  })()`);
  await moveTo(page, away);
  await page.until(() => page.eval(`!document.querySelector(".md-file-drawer").classList.contains("md-file-wide")`), "closed drawer");
  const closed = (await settle(page, Date.now(), null)).state;
  return { hub, page, closed };
}

test("opening a folder widens the open drawer with no pointer movement", async (t) => {
  const { page, closed } = await setup(t);
  const deep = await toggleAt(page, "deep");
  await moveTo(page, deep);
  await page.until(() => page.eval(`document.querySelector(".md-file-drawer").classList.contains("md-file-wide")`), "open drawer");
  const open = (await settle(page, Date.now(), null)).state;
  sameHead(open, closed, "opened by hover");

  const from = Date.now();
  await clickHere(page, deep);
  const { state: grown, moved } = await settle(page, from, open.panel.width);
  assert.ok(grown.rows.some((row) => row.text.includes(DEEP)), "the folder's file is listed");
  assert.ok(moved != null && moved <= 600, `the drawer did not start widening within 600 ms (moved at ${moved} ms)`);
  assert.ok(grown.panel.width > open.panel.width + 8, `the drawer stayed ${grown.panel.width} px after the folder opened`);
  assert.equal(grown.wide, true, "the drawer closed");
  assert.ok(grown.panel.width <= grown.cap + 1, `the drawer is ${grown.panel.width} px, past the cap ${grown.cap}`);
  whole(grown, "after opening deep");
  near(grown.panel.left, open.panel.left, "drawer left");
  near(grown.panel.top, open.panel.top, "drawer top");
  sameHead(grown, closed, "after opening deep");
});

test("the open drawer is never narrower than the closed one", async (t) => {
  const { page, closed } = await setup(t);
  const deep = await toggleAt(page, "deep");
  await moveTo(page, deep);
  await page.until(() => page.eval(`document.querySelector(".md-file-drawer").classList.contains("md-file-wide")`), "open drawer");
  const open = (await settle(page, Date.now(), null)).state;
  assert.ok(open.panel.width >= closed.panel.width - 1, `with only short names, the open drawer is ${open.panel.width} px, narrower than its closed ${closed.panel.width} px`);
  sameHead(open, closed, "opened by hover");
});

test("a name past the cap is cut at 80 percent of the window", async (t) => {
  const { page, closed } = await setup(t);
  const huge = await toggleAt(page, "huge");
  await moveTo(page, huge);
  await page.until(() => page.eval(`document.querySelector(".md-file-drawer").classList.contains("md-file-wide")`), "open drawer");
  await settle(page, Date.now(), null);
  await clickHere(page, huge);
  const { state } = await settle(page, Date.now(), null);
  near(state.panel.width, state.cap, "drawer width at the cap", 2);
  const row = state.rows.find((r) => r.text.includes(HUGE));
  assert.ok(row && row.scroll > row.client, "the long name is cut at the cap");
  whole(state, "with huge open", HUGE);
  sameHead(state, closed, "with huge open");
});

test("closing folders narrows the drawer, not below its closed width, and it stays open", async (t) => {
  const { page, closed } = await setup(t);
  const deep = await toggleAt(page, "deep");
  await moveTo(page, deep);
  await page.until(() => page.eval(`document.querySelector(".md-file-drawer").classList.contains("md-file-wide")`), "open drawer");
  const open = (await settle(page, Date.now(), null)).state;
  await clickHere(page, deep);
  const grown = (await settle(page, Date.now(), null)).state;
  await clickHere(page, deep);
  const { state: shrunk } = await settle(page, Date.now(), null);
  assert.ok(!shrunk.rows.some((row) => row.text.includes(DEEP)), "the folder closed");
  assert.equal(shrunk.wide, true, "the drawer closed while the pointer is over it");
  assert.ok(shrunk.panel.width < grown.panel.width - 8, `the drawer stayed ${shrunk.panel.width} px after the folder closed`);
  near(shrunk.panel.width, Math.max(open.panel.width, closed.panel.width), "back to the width before the folder opened");
  whole(shrunk, "after closing deep");
  sameHead(shrunk, closed, "after closing deep");
});

test("a file added, moved, or deleted by the CLI refits the open drawer", async (t) => {
  const { hub, page, closed } = await setup(t);
  const deep = await toggleAt(page, "deep");
  await moveTo(page, deep);
  await page.until(() => page.eval(`document.querySelector(".md-file-drawer").classList.contains("md-file-wide")`), "open drawer");
  const open = (await settle(page, Date.now(), null)).state;

  await hub.create(LATE, "late\n");
  await page.until(() => page.eval(`[...document.querySelectorAll(".md-file-drawer button.md-file")].some((b) => b.textContent.includes(${JSON.stringify(LATE)}))`), "the new file's row");
  const { state: added } = await settle(page, Date.now(), open.panel.width);
  assert.ok(added.panel.width > open.panel.width + 8, `the drawer stayed ${added.panel.width} px after a wider file was added`);
  assert.equal(added.wide, true, "the drawer closed");
  whole(added, "after the CLI added a file");
  sameHead(added, closed, "after the CLI added a file");

  const moved = await cli(hub.port, ["--user", AGENT, "--repo", REPO, "move", LATE, "--dir", "huge"]);
  assert.equal(moved.code, 0, moved.stderr);
  await page.until(() => page.eval(`![...document.querySelectorAll(".md-file-drawer button.md-file")].some((b) => b.getClientRects().length > 0 && b.textContent.includes(${JSON.stringify(LATE)}))`), "the moved file leaves the top level");
  const { state: after } = await settle(page, Date.now(), null);
  near(after.panel.width, open.panel.width, "back to the width before the file was added");
  sameHead(after, closed, "after the CLI moved the file");

  await hub.create("other-late-file-with-a-name-wider-than-the-open-drawer-today.md", "x\n");
  await page.until(() => page.eval(`[...document.querySelectorAll(".md-file-drawer button.md-file")].some((b) => b.textContent.startsWith("other-late"))`), "the second file's row");
  await settle(page, Date.now(), null);
  const deleted = await cli(hub.port, ["--user", AGENT, "--repo", REPO, "delete", "other-late-file-with-a-name-wider-than-the-open-drawer-today.md"]);
  assert.equal(deleted.code, 0, deleted.stderr);
  await page.until(() => page.eval(`![...document.querySelectorAll(".md-file-drawer button.md-file")].some((b) => b.textContent.startsWith("other-late"))`), "the deleted file's row goes");
  const { state: gone } = await settle(page, Date.now(), null);
  near(gone.panel.width, open.panel.width, "back to the width before the file was added");
  assert.equal(gone.wide, true, "the drawer closed");
  sameHead(gone, closed, "after the CLI deleted the file");
});
