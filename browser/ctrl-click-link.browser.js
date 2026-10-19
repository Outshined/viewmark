import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { BROWSER, REPO, USER, cli, launchBrowser, Page, startHub } from "./harness.js";

// Ticket d6a4htkt. Ctrl-click opens the address in a new tab. A click without
// Ctrl still opens a document, ticket, or comment hash in this page, and does
// not open any other address. The same click is used with vim keys on.

const CTRL = 2;

function sameAddress(got, href) {
  if (got === href) return true;
  try {
    const a = new URL(got);
    const b = new URL(href);
    return a.origin === b.origin && a.pathname === b.pathname && a.search === b.search && a.hash === b.hash;
  } catch {
    return false;
  }
}

async function setup(t, vim) {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  const made = await cli(hub.port, ["--user", USER, "--repo", REPO, "ticket", "create", "--title", "Linked"], "TICKET-BODY\n");
  assert.equal(made.code, 0, made.stderr);
  const id = made.stdout.trim().split("\n")[0];
  const probe = `http://127.0.0.1:${hub.port}/ctrl-click-probe`;
  const plain = `http://127.0.0.1:${hub.port}/plain-address`;
  const docHash = `#${REPO}/doc/other.md`;
  const ticketHash = `#${REPO}/ticket/${id}`;
  const noteHash = `#${REPO}/comment/notes.md/c1`;
  await hub.create("other.md", "OTHER-DOC\n");
  await hub.create("notes.md", "NOTE-BODY {c1}here{/c1}.\n\n```comment c1\nhi\n```\n");
  const links = `Intro.\n\nSee [out](${probe}) [doc](${docHash}) [ticket](${ticketHash}) [note](${noteHash}) [plain](${plain}).\n`;
  await hub.create("links.md", links);
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  if (vim) {
    await page.session.send("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem("viewmark.vim", "1");` });
  }
  await page.login(USER);
  await page.open("links.md");
  if (vim) assert.equal(await page.eval(`document.querySelector(".md-vim-status").textContent`), "N");
  return { hub, browser, page, probe, plain, docHash, ticketHash, noteHash };
}

async function renderedLink(page, label) {
  const link = await page.eval(`(() => {
    const el = [...document.querySelectorAll("#editor a")].find((node) => node.textContent === ${JSON.stringify(label)});
    if (!el || el.closest(".md-raw")) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2, href: el.href };
  })()`);
  assert.ok(link, `no rendered link ${label}`);
  return link;
}

async function waitForTab(browser, before, href) {
  const known = new Set(before.map((tab) => tab.context));
  let seen = before;
  for (let i = 0; i < 50; i += 1) {
    seen = await browser.tabs();
    const opened = seen.find((tab) => !known.has(tab.context) && sameAddress(tab.url, href));
    if (opened) return opened;
    await sleep(100);
  }
  assert.fail(`no tab for ${href}: ${JSON.stringify(seen.map((tab) => tab.url))}`);
}

async function assertNoNewTab(browser, before) {
  await sleep(400);
  const known = new Set(before.map((tab) => tab.context));
  const extra = (await browser.tabs()).filter((tab) => !known.has(tab.context));
  assert.deepEqual(extra.map((tab) => tab.url), []);
}

async function exercise(t, vim) {
  const { browser, page, probe, plain, docHash, ticketHash, noteHash } = await setup(t, vim);
  const hash = () => page.eval("location.hash");
  assert.equal(await hash(), `#${REPO}/doc/links.md`);

  for (const label of ["out", "doc", "ticket", "note", "plain"]) {
    const link = await renderedLink(page, label);
    const before = await browser.tabs();
    const here = await hash();
    await page.click(link.x, link.y, { modifiers: CTRL });
    await page.quiet();
    const opened = await waitForTab(browser, before, link.href);
    assert.equal(await hash(), here);
    assert.equal(await page.eval(`document.getElementById("editor").textContent.includes("See ")`), true);
    await browser.closeTarget(opened.context);
  }
  assert.equal(await hash(), `#${REPO}/doc/links.md`);

  const doc = await renderedLink(page, "doc");
  let tabs = await browser.tabs();
  await page.click(doc.x, doc.y);
  await page.until(() => page.eval(`location.hash === ${JSON.stringify(docHash)}`), "the document hash");
  await page.until(() => page.eval(`document.getElementById("editor").textContent.includes("OTHER-DOC")`), "other.md");
  await assertNoNewTab(browser, tabs);

  await page.open("links.md");
  const ticket = await renderedLink(page, "ticket");
  tabs = await browser.tabs();
  await page.click(ticket.x, ticket.y);
  await page.until(() => page.eval(`location.hash === ${JSON.stringify(ticketHash)}`), "the ticket hash");
  await page.until(() => page.eval(`document.getElementById("editor").textContent.includes("TICKET-BODY")`), "the ticket");
  await assertNoNewTab(browser, tabs);

  await page.open("links.md");
  const note = await renderedLink(page, "note");
  tabs = await browser.tabs();
  await page.click(note.x, note.y);
  await page.until(() => page.eval(`location.hash === ${JSON.stringify(noteHash)}`), "the comment hash");
  await page.until(() => page.eval(`document.getElementById("editor").textContent.includes("NOTE-BODY")`), "the comment document");
  await assertNoNewTab(browser, tabs);

  // A plain click leaves the caret in that paragraph. The next load of this
  // file adopts the caret, so the links would be source. Another file drops it.
  for (const label of ["out", "plain"]) {
    await page.open("other.md");
    await page.open("links.md");
    const stayed = await hash();
    const link = await renderedLink(page, label);
    tabs = await browser.tabs();
    await page.click(link.x, link.y);
    await page.quiet();
    assert.equal(await hash(), stayed);
    assert.equal(link.href, label === "out" ? probe : plain);
    await assertNoNewTab(browser, tabs);
  }
}

test("d6a4htkt: Ctrl-click opens a rendered link in a new tab, vim keys off", { skip: BROWSER !== "firefox" }, async (t) => {
  await exercise(t, false);
});

test("d6a4htkt: Ctrl-click opens a rendered link in a new tab, vim keys on", { skip: BROWSER !== "firefox" }, async (t) => {
  await exercise(t, true);
});
