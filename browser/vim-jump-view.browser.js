import test from "node:test";
import assert from "node:assert/strict";
import { REPO, USER, cli, launchBrowser, Page, startHub } from "./harness.js";

// Ticket 7j8phzux. With vim keys on, gg, G, and a count on G bring the caret's line into the
// window as part of that command, in a document and in a ticket, rendered and raw. A landing line
// that is already in the window does not scroll. Where the browser has no caret-shape, the block
// drawn over the caret moves with that scroll.

const VIM = "viewmark.vim";
const BODY = Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1} of the page.`).join("\n\n") + "\n";

async function setup(t) {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  const made = await cli(hub.port, ["--user", USER, "--repo", REPO, "create", "long.md"], BODY);
  assert.equal(made.code, 0, made.stderr);
  const ticket = await cli(hub.port, ["--user", USER, "--repo", REPO, "ticket", "create", "--title", "Long"], BODY);
  assert.equal(ticket.code, 0, ticket.stderr);
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.session.send("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem(${JSON.stringify(VIM)}, "1");` });
  await page.login();
  return { hub, page, ticketId: ticket.stdout.trim().split("\n")[0] };
}

async function openAt(page, hash, raw) {
  page.loads = (page.loads || 0) + 1;
  await page.session.send("Page.navigate", { url: `http://127.0.0.1:${page.port}/?load=${page.loads}#${hash}` });
  await page.until(() => page.eval(`[...document.querySelectorAll("#editor .md-line")].some((l) => l.textContent.includes("Paragraph 80"))`), `the body of ${hash}`, 8000);
  await page.quiet();
  if (raw) {
    await page.eval(`document.querySelector("#editor button.md-view-toggle").click(); true`);
    await page.quiet();
  }
  await page.eval(`window.scrollTo(0, 0); document.getElementById("editor").scrollTop = 0; true`);
  await page.frame();
  assert.ok(await page.clickOffset(3), "no point to click in the first paragraph");
  await page.quiet();
  assert.equal(await page.eval(`document.querySelector(".md-vim-status").textContent`), "N");
}

// The caret's box in the window, the scroll, and the drawn block where there is one.
function view(page) {
  return page.eval(`(() => {
    const sel = getSelection();
    let r = null;
    if (sel.rangeCount) {
      r = sel.getRangeAt(0).getClientRects()[0] || null;
      if (!r) r = (sel.focusNode.nodeType === 1 ? sel.focusNode : sel.focusNode.parentElement).getBoundingClientRect();
    }
    const mark = document.querySelector(".md-vim-block-mark");
    const m = mark && mark.getBoundingClientRect();
    return {
      top: r ? r.top : null,
      bottom: r ? r.bottom : null,
      innerHeight,
      scroll: Math.round(scrollY) + document.getElementById("editor").scrollTop,
      mark: m && m.width > 1 ? { top: m.top, bottom: m.bottom } : null,
    };
  })()`);
}

async function keys(page, list) {
  for (const key of list) await page.key(key);
  await page.quiet();
}

function assertShown(v, what) {
  assert.ok(v.top !== null, `${what}: no caret`);
  assert.ok(v.top >= -1 && v.bottom <= v.innerHeight + 1, `${what}: the caret is at y ${Math.round(v.top)} to ${Math.round(v.bottom)}, outside the ${v.innerHeight} px window`);
  if (v.mark) assert.ok(Math.abs(v.mark.top - v.top) <= 3, `${what}: the drawn block is at y ${Math.round(v.mark.top)}, the caret at y ${Math.round(v.top)}`);
}

for (const where of ["document", "ticket"]) {
  for (const raw of [false, true]) {
    const label = `${where}, ${raw ? "raw" : "rendered"}`;
    test(`G, gg, and 60G bring the caret's line into the window on the command itself: ${label} (ticket 7j8phzux)`, async (t) => {
      const { page, ticketId } = await setup(t);
      await openAt(page, where === "document" ? `${REPO}/doc/long.md` : `${REPO}/ticket/${ticketId}`, raw);
      await keys(page, ["G"]);
      const g = await view(page);
      assertShown(g, "after G");
      assert.ok(g.scroll > 0, "G did not scroll");
      await keys(page, ["g", "g"]);
      const top = await view(page);
      assertShown(top, "after gg");
      await keys(page, ["6", "0", "G"]);
      const sixty = await view(page);
      assertShown(sixty, "after 60G");
      assert.ok(sixty.scroll > top.scroll, "60G did not scroll");
    });
  }
}

test("a landing line already in the window does not scroll: 3G from the top (ticket 7j8phzux)", async (t) => {
  const { page } = await setup(t);
  await openAt(page, `${REPO}/doc/long.md`, false);
  const before = await view(page);
  await keys(page, ["3", "G"]);
  const after = await view(page);
  assertShown(after, "after 3G");
  assert.equal(after.scroll, before.scroll, "3G scrolled");
  assert.ok(after.top > before.top, "3G did not move the caret down");
});
