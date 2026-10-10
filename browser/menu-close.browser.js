import test from "node:test";
import assert from "node:assert/strict";
import { REPO, USER, cli, launchBrowser, Page, startHub } from "./harness.js";

// Ticket cxmnzjzj: clicking anywhere else on the page closes any open menu, the ticket filter
// menu included. Every press here is a real mouse event at a point on the page.

const OPEN = (selector) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return !!el && !el.hidden && el.getClientRects().length > 0; })()`;
const FILTER_MENU = ".ticket-block .md-ticket-filter-menu";
const DOC_MENU = ".md-doc-menu-panel";

function centerOf(page, selector) {
  return page.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
}

async function press(page, point) {
  assert.ok(point, "nothing to press");
  await page.click(point.x, point.y);
  await page.frame();
}

async function setup(t) {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  await hub.create("note.md", "alpha beta\n\ngamma\n");
  await hub.create("other.md", "other\n");
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.login();
  await page.open("note.md");
  await page.until(() => page.eval(`!!document.querySelector(".ticket-block .md-ticket-filter")`), "filter button");
  return page;
}

async function openFilter(page) {
  await press(page, await centerOf(page, ".ticket-block .md-ticket-filter"));
  await page.until(() => page.eval(OPEN(FILTER_MENU)), "filter menu open");
}

test("a press anywhere else closes the ticket filter menu", async (t) => {
  const page = await setup(t);
  const places = {
    "the editor text": async () => page.eval(`window.__qaClickPoint(2)`),
    "the files pane": async () => centerOf(page, ".file-block .md-pane-head"),
    "a file name": async () => page.eval(`(() => { const b = [...document.querySelectorAll(".file-block button.md-file")].find((x) => x.textContent.includes("other")); const r = b.getBoundingClientRect(); return { x: r.left + 10, y: r.top + r.height / 2 }; })()`),
    "the comments column": async () => page.eval(`(() => { const a = document.querySelector("aside.comments") || document.querySelector(".comments"); const r = a.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.bottom - 20 }; })()`),
  };
  for (const [name, where] of Object.entries(places)) {
    await page.open("note.md");
    await openFilter(page);
    await press(page, await where());
    await page.until(async () => !(await page.eval(OPEN(FILTER_MENU))), `filter menu closed by a press on ${name}`, 1000);
  }
});

test("a press inside the filter menu keeps it open, and its button toggles it", async (t) => {
  const page = await setup(t);
  await openFilter(page);
  const box = await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(FILTER_MENU)} + " input"); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await press(page, box);
  assert.equal(await page.eval(OPEN(FILTER_MENU)), true, "a press on a filter box closed the menu");
  await press(page, await centerOf(page, ".ticket-block .md-ticket-filter"));
  await page.until(async () => !(await page.eval(OPEN(FILTER_MENU))), "the filter button closes its menu", 1000);
});

// The global document menu is gone (ticket xj3zqv5t). On a ticket, the pane menu and the
// filter menu are the two menus, and opening one closes the other.
const PANE_BUTTON = ".ticket-form button.md-ticket-pane-menu";
const PANE_MENU = ".ticket-form .md-ticket-pane-panel";

test("opening one menu closes the other", async (t) => {
  const page = await setup(t);
  const made = await cli(page.port, ["--user", USER, "--repo", REPO, "ticket", "create", "--title", "Menus"], "Body.\n");
  assert.equal(made.code, 0, made.stderr);
  const id = made.stdout.trim().split("\n")[0];
  await page.session.send("Page.navigate", { url: `http://127.0.0.1:${page.port}/?load=2#${REPO}/ticket/${encodeURIComponent(id)}` });
  await page.until(() => page.eval(OPEN(PANE_BUTTON)), "the ticket pane menu button");
  await press(page, await centerOf(page, PANE_BUTTON));
  await page.until(() => page.eval(OPEN(PANE_MENU)), "the ticket pane menu open");
  await openFilter(page);
  assert.equal(await page.eval(OPEN(PANE_MENU)), false, "the ticket pane menu stayed open when the filter menu opened");
  await press(page, await centerOf(page, PANE_BUTTON));
  await page.until(() => page.eval(OPEN(PANE_MENU)), "the ticket pane menu open again");
  assert.equal(await page.eval(OPEN(FILTER_MENU)), false, "the filter menu stayed open when the ticket pane menu opened");
});
