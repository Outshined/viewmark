import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { launchBrowser, Page, startHub } from "./harness.js";

// R96, decided by the owner on 2026-10-10 (editing.md, c9): two browser tabs are two sessions,
// even when the same user is in both. A block one tab holds is refused to the other, which
// shows that user's name on it. The matrix's second session is always another user, so this
// case lives here.

const labelOn = (page, text, name) => page.eval(`[...window.__qaRoot().querySelectorAll(".md-line, .md-atom")].some((block) => block.textContent.includes(${JSON.stringify(text)}) && [...block.querySelectorAll(".md-lock")].some((label) => label.textContent.includes(${JSON.stringify(name)})))`);

test("two tabs of one user are two sessions", async (t) => {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  await hub.create("a.md", "alpha\n\nbeta\n");
  browser = await launchBrowser();
  const A = new Page(browser.session, hub.port);
  const { session } = await browser.newSession();
  const B = new Page(session, hub.port);
  await A.init();
  await A.login();
  await B.init();
  await B.login();
  await A.open("a.md");
  await B.open("a.md");
  await A.clickOffset(2);
  await A.quiet();
  await B.clickOffset("alpha\n\nbe".length);
  await B.quiet();
  await sleep(300);
  // A click into the block the first tab holds does not take the second tab's caret there.
  await B.clickOffset(3);
  await B.quiet();
  const caret = await B.caret();
  assert.equal(caret.focus, "alpha\n\nbe".length, `the second tab's caret went to ${caret.focus}`);
  // Each tab edits its own block.
  await A.key("x");
  await A.quiet();
  await B.key("y");
  await B.quiet();
  await sleep(200);
  assert.equal((await hub.show("a.md")).text, "alxpha\n\nbeyta\n");
  // The second tab names who holds alpha, as it would for another user.
  // The block's text is alxpha after the edit, so the search is that text.
  await B.until(() => labelOn(B, "alxpha", "qa-bot"), "the second tab shows qa-bot on alpha", 3000);
});
