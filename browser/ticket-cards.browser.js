import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { REPO, USER, cli, launchBrowser, Page, startHub } from "./harness.js";

// Ticket cpe85tzs. A comment card's top is level with its anchor's top, within 1 px, on a
// ticket as on a document: for a comment on the first line, and for one far down a long body
// with the page scrolled to it.

const note = (text) => `\`\`\`comment c1\n:: 0\n@2026-10-17T22:00:00.000Z qa\n${text}\n\`\`\`\n`;
const SHORT = `{c1}First{/c1} paragraph.\n\nSecond paragraph.\n\n${note("On the first.")}`;
const LONG = `${Array.from({ length: 60 }, (_, i) => (i === 55 ? `{c1}Paragraph{/c1} ${i + 1} of the body.` : `Paragraph ${i + 1} of the body.`)).join("\n\n")}\n\n${note("Far down.")}`;

async function setup(t) {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.login();
  return { hub, page };
}

async function makeTicket(hub, title, text) {
  const out = await cli(hub.port, ["--user", USER, "--repo", REPO, "ticket", "create", "--title", title], text);
  assert.equal(out.code, 0, out.stderr);
  return out.stdout.trim().split("\n")[0];
}

async function openHash(page, hash, needle) {
  const since = page.frames.length;
  page.loads = (page.loads || 0) + 1;
  await page.session.send("Page.navigate", { url: `http://127.0.0.1:${page.port}/?load=${page.loads}#${hash}` });
  await page.until(() => page.frames.slice(since).some((frame) => frame.dir === "in" && frame.data && frame.data.type === "file"), `file for ${hash}`);
  await page.until(() => page.eval(`[...document.querySelectorAll("#editor .md-line")].some((line) => line.textContent.includes(${JSON.stringify(needle)}))`), needle);
  await page.until(() => page.eval(`!!document.querySelector('.md-comment-card[data-comment="c1"]')`), "the card");
  await page.quiet();
  await sleep(300);
}

// The card's top minus its anchor's top, in px, and where the anchor is in the window.
const offset = (page) => page.eval(`(() => {
  const card = document.querySelector('.md-comment-card[data-comment="c1"]');
  const anchor = document.querySelector('#editor .md-comment[data-comment="c1"]');
  if (!card || !anchor) return null;
  const a = anchor.getClientRects()[0] || anchor.getBoundingClientRect();
  return { delta: card.getBoundingClientRect().top - a.top, anchorTop: a.top, innerHeight };
})()`);

async function scrollToMiddle(page) {
  await page.eval(`(() => {
    const anchor = document.querySelector('#editor .md-comment[data-comment="c1"]');
    window.scrollBy(0, anchor.getBoundingClientRect().top - innerHeight / 2);
    return true;
  })()`);
  await page.quiet();
  await sleep(300);
}

function level(seen, label) {
  assert.ok(seen, `${label}: no card or no anchor`);
  assert.ok(Math.abs(seen.delta) <= 1, `${label}: the card's top is ${seen.delta.toFixed(1)} px from its anchor's top`);
}

test("cpe85tzs: on a ticket, a comment card on the first paragraph is level with its anchor", async (t) => {
  const { hub, page } = await setup(t);
  const id = await makeTicket(hub, "Short", SHORT);
  await openHash(page, `${REPO}/ticket/${id}`, "Second paragraph");
  level(await offset(page), "ticket, first paragraph");
});

test("cpe85tzs: on a ticket, a comment card far down a long body is level with its anchor, with the page scrolled to it", async (t) => {
  const { hub, page } = await setup(t);
  const id = await makeTicket(hub, "Long", LONG);
  await openHash(page, `${REPO}/ticket/${id}`, "Paragraph 1 of");
  await scrollToMiddle(page);
  const seen = await offset(page);
  assert.ok(seen && seen.anchorTop > 0 && seen.anchorTop < seen.innerHeight, `the anchor is not in the window: ${JSON.stringify(seen)}`);
  level(seen, "ticket, paragraph 56, scrolled");
});

test("cpe85tzs: on a document that is not a ticket, comment cards keep their places level with their anchors", async (t) => {
  const { hub, page } = await setup(t);
  const short = await hub.create("short.md", SHORT);
  const long = await hub.create("long.md", LONG);
  await openHash(page, `${REPO}/doc/${short}`, "Second paragraph");
  level(await offset(page), "document, first paragraph");
  await openHash(page, `${REPO}/doc/${long}`, "Paragraph 1 of");
  await scrollToMiddle(page);
  level(await offset(page), "document, paragraph 56, scrolled");
});
