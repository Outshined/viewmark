import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { USER, apiUser, launchBrowser, Page, startHub } from "./harness.js";

// R96, decided by the owner on 2026-10-10 (editing.md, c9): two browser tabs are two sessions,
// even when the same user is in both. A block one tab holds is refused to the other, which
// shows that user's name on it. The page is one tab. The other tab is the same user with its
// own session token, talking to the hub directly.

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
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.login();
  await page.open("a.md");
  const tab = await apiUser(hub.port, USER, { session: "the-other-tab" });
  t.after(() => tab.close());
  await tab.open("a.md");
  assert.equal((await tab.hold("alpha\n\nbe".length)).type, "locks", "the other tab could not put its caret in beta");
  await page.clickOffset(2);
  await page.quiet();
  await sleep(300);
  // A click into the block the other tab holds does not take this tab's caret there.
  await page.clickOffset("alpha\n\nbe".length);
  await page.quiet();
  const caret = await page.caret();
  assert.equal(caret.focus, 2, `this tab's caret went to ${caret.focus}`);
  // Each tab edits its own block.
  await page.key("x");
  await page.quiet();
  const rev = (await hub.show("a.md")).rev;
  await page.until(async () => (await tab.latest()).rev === rev, "the other tab has the page's key", 3000);
  const typed = await tab.insert("alxpha\n\nbe".length, "y");
  assert.equal(typed.type, "doc", `the other tab's key was refused: ${JSON.stringify(typed)}`);
  await sleep(200);
  assert.equal((await hub.show("a.md")).text, "alxpha\n\nbeyta\n");
  // This tab names who holds beta, as it would for another user.
  await page.until(() => labelOn(page, "beyta", USER), `this tab shows ${USER} on beta`, 3000);
});
