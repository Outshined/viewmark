import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { REPO, USER, cli, launchBrowser, Page, startHub } from "./harness.js";

// Ticket dfpje5ux, the owner's decision of 2026-10-15 recorded on c1, note 3: a ticket in another
// registered repo behaves like a ticket in this repo. A link out to it shows its title, the pickers
// offer it, a pick stores repo:id, choosing it as a child or a block writes it in its own repo, and
// a change in either repo redraws a page open in the other without a reload. REPO holds A and
// OTHER_REPO is a second registered repo. ticket-links.browser.js covers the rest of the page part.

const OTHER_REPO = "other";
const GHOST = "ghost:k2n4p7qa";
const BUTTON = ".ticket-form button.md-ticket-pane-menu";
const PANEL = ".ticket-form .md-ticket-pane-panel";
const FIELD = { parent: ".md-ticket-parent", depends: ".md-ticket-depends", children: ".md-ticket-children", blocks: ".md-ticket-blocks" };
const SHOWN = (selector) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return !!el && !el.hidden && el.getClientRects().length > 0; })()`;

async function setup(t) {
  const hub = await startHub();
  const otherDir = mkdtempSync(path.join(tmpdir(), "viewmark-qa-other-"));
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
    rmSync(otherDir, { recursive: true, force: true });
  });
  const registered = await cli(hub.port, ["--user", USER, "repo", "register", "--name", OTHER_REPO, "--description", "other", "--path", otherDir]);
  assert.equal(registered.code, 0, registered.stderr);
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.login();
  return { hub, browser, page };
}

async function makeTicket(hub, repo, title) {
  const out = await cli(hub.port, ["--user", USER, "--repo", repo, "ticket", "create", "--title", title], `${title} body.\n`);
  assert.equal(out.code, 0, out.stderr);
  return out.stdout.trim().split("\n")[0];
}

async function setTicket(hub, repo, id, ...fields) {
  const out = await cli(hub.port, ["--user", USER, "--repo", repo, "ticket", "set", id, ...fields], "");
  assert.equal(out.code, 0, out.stderr);
}

async function ticketJson(hub, repo, id) {
  const out = await cli(hub.port, ["--user", USER, "--json", "--repo", repo, "ticket", "show", id], "");
  assert.equal(out.code, 0, out.stderr);
  return JSON.parse(out.stdout);
}

async function openTicket(page, id, repo = REPO) {
  const since = page.frames.length;
  page.loads = (page.loads || 0) + 1;
  await page.session.send("Page.navigate", { url: `http://127.0.0.1:${page.port}/?load=${page.loads}#${repo}/ticket/${encodeURIComponent(id)}` });
  await page.until(() => page.frames.slice(since).some((frame) => frame.dir === "in" && frame.data && frame.data.type === "file" && frame.data.path === `tickets/${id}.md`), `ticket ${id}`);
  await page.until(() => page.eval(SHOWN(BUTTON)), `the menu button on ${id}`);
  await page.quiet();
}

async function press(page, selector) {
  const point = await page.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el || el.getClientRects().length === 0) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  assert.ok(point, `nothing drawn for ${selector}`);
  await page.click(point.x, point.y);
  await page.quiet();
}

const shownFields = (page) => page.eval(`Object.fromEntries(${JSON.stringify(Object.entries(FIELD))}.map(([k, s]) => { const el = document.querySelector(".ticket-form " + s); return [k, !!el && !el.hidden && el.getClientRects().length > 0]; }))`);

async function ensureField(page, name) {
  const key = name.toLowerCase();
  if ((await shownFields(page))[key]) return;
  if (!(await page.eval(SHOWN(PANEL)))) await press(page, BUTTON);
  await page.until(() => page.eval(SHOWN(PANEL)), "the menu open");
  const item = await page.eval(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(PANEL + " button, " + PANEL + " label")})].find((e) => e.textContent.trim() === ${JSON.stringify(name)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + Math.min(20, r.width / 2), y: r.top + r.height / 2 };
  })()`);
  assert.ok(item, `no menu entry ${name}`);
  await page.click(item.x, item.y);
  await page.quiet();
  await press(page, BUTTON);
}

// What a relation row draws, link by link: the text, and the stored token or id it stands for.
function links(page, field) {
  return page.eval(`[...document.querySelectorAll(".ticket-form ${field} .md-ticket-link")].map((el) => ({ text: el.textContent.trim(), id: el.dataset.id, repo: el.dataset.repo || "" }))`);
}

async function typeInto(page, field, text) {
  await press(page, `.ticket-form ${field} .md-ticket-match`);
  await page.type(text);
  await page.quiet();
  await sleep(150);
}

async function ticketMissing(hub, repo, id) {
  const out = await cli(hub.port, ["--user", USER, "--json", "--repo", repo, "ticket", "show", id], "");
  return out.code !== 0;
}

// A page that reloads loses this mark, so a check that finds it still set saw no reload.
async function markStay(page) {
  await page.eval(`document.documentElement.dataset.stay = "1"`);
}

async function stayed(page) {
  assert.equal(await page.eval(`document.documentElement.dataset.stay || ""`), "1", "the page reloaded");
}

function menuOptions(page, field) {
  return page.eval(`[...document.querySelectorAll(".ticket-form ${field} .md-ticket-menu > *")].map((el) => ({ text: el.textContent.trim(), repo: el.dataset.repo || "" }))`);
}

async function pickFrom(page, field, text, title) {
  await ensureField(page, { [FIELD.parent]: "Parent", [FIELD.depends]: "Depends", [FIELD.children]: "Children", [FIELD.blocks]: "Blocks" }[field]);
  await typeInto(page, field, text);
  await page.until(async () => (await menuOptions(page, field)).some((o) => o.text.includes(title)), `${title} offered on ${field}`, 3000);
  const offered = await menuOptions(page, field);
  assert.ok(offered.some((o) => o.text.includes(title) && o.repo === OTHER_REPO), `${field} offers ${JSON.stringify(offered)}`);
  // Parent commits on a pick and has no Add button; the list fields add the match with Add.
  if (field === FIELD.parent) await pressOption(page, field, title);
  else await press(page, `.ticket-form ${field} .md-ticket-add`);
}

async function pressOption(page, field, title) {
  const point = await page.eval(`(() => {
    const el = [...document.querySelectorAll(".ticket-form ${field} .md-ticket-menu > *")].find((o) => o.textContent.includes(${JSON.stringify(title)}));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + Math.min(20, r.width / 2), y: r.top + r.height / 2 };
  })()`);
  assert.ok(point, `no option ${title} on ${field}`);
  await page.click(point.x, point.y);
  await page.quiet();
}

// The Parent field is one input that shows the parent's title, or the stored token.
function parentShown(page) {
  return page.eval(`(document.querySelector(".ticket-form ${FIELD.parent} .md-ticket-match") || {}).value || ""`);
}

test("Depends and Parent: a link out to a ticket in another repo shows that ticket's title (ticket dfpje5ux)", async (t) => {
  const { hub, page } = await setup(t);
  const a = await makeTicket(hub, REPO, "Ticket A");
  const b = await makeTicket(hub, OTHER_REPO, "Banana B");
  const p = await makeTicket(hub, OTHER_REPO, "Plum P");
  await setTicket(hub, REPO, a, "--depends", `${OTHER_REPO}:${b}`, "--parent", `${OTHER_REPO}:${p}`);
  await openTicket(page, a);
  await page.until(() => page.eval(SHOWN(`.ticket-form ${FIELD.depends}`)), "the Depends row", 3000);
  await page.until(() => page.eval(SHOWN(`.ticket-form ${FIELD.parent}`)), "the Parent row", 3000);
  const depends = await links(page, FIELD.depends);
  assert.deepEqual(depends.map((l) => l.text), ["Banana B"], `Depends draws ${JSON.stringify(depends)}`);
  assert.equal(await parentShown(page), "Plum P");
});

test("Depends and Parent: the pickers offer a ticket in another repo, and a pick stores repo:id (ticket dfpje5ux)", async (t) => {
  const { hub, page } = await setup(t);
  const a = await makeTicket(hub, REPO, "Ticket A");
  const b = await makeTicket(hub, OTHER_REPO, "Banana B");
  const p = await makeTicket(hub, OTHER_REPO, "Plum P");
  await openTicket(page, a);
  await pickFrom(page, FIELD.depends, "Banana", "Banana B");
  await page.until(async () => (await ticketJson(hub, REPO, a)).depends.length > 0, "A depends on something", 3000);
  assert.deepEqual((await ticketJson(hub, REPO, a)).depends, [`${OTHER_REPO}:${b}`]);
  await pickFrom(page, FIELD.parent, "Plum", "Plum P");
  await page.until(async () => (await ticketJson(hub, REPO, a)).parent !== "", "A has a parent", 3000);
  assert.equal((await ticketJson(hub, REPO, a)).parent, `${OTHER_REPO}:${p}`);
  assert.equal((await ticketJson(hub, OTHER_REPO, b)).depends.length, 0, "the pick wrote B");
});

test("Children and Blocks: choosing a ticket in another repo writes that ticket in its repo, and nothing in this one (ticket dfpje5ux)", async (t) => {
  const { hub, page } = await setup(t);
  const a = await makeTicket(hub, REPO, "Ticket A");
  const c = await makeTicket(hub, OTHER_REPO, "Cherry C");
  const k = await makeTicket(hub, OTHER_REPO, "Kiwi K");
  const before = JSON.stringify(await ticketJson(hub, REPO, a));
  await openTicket(page, a);
  await pickFrom(page, FIELD.children, "Cherry", "Cherry C");
  await page.until(async () => (await ticketJson(hub, OTHER_REPO, c)).parent !== "", "C has a parent", 3000);
  assert.equal((await ticketJson(hub, OTHER_REPO, c)).parent, `${REPO}:${a}`);
  await pickFrom(page, FIELD.blocks, "Kiwi", "Kiwi K");
  await page.until(async () => (await ticketJson(hub, OTHER_REPO, k)).depends.length > 0, "K depends on something", 3000);
  assert.deepEqual((await ticketJson(hub, OTHER_REPO, k)).depends, [`${REPO}:${a}`]);
  assert.equal(JSON.stringify(await ticketJson(hub, REPO, a)), before, "A changed");
  assert.ok(await ticketMissing(hub, REPO, c), `tickets/${c}.md was written in ${REPO}`);
  assert.ok(await ticketMissing(hub, REPO, k), `tickets/${k}.md was written in ${REPO}`);
  await page.until(async () => (await links(page, FIELD.children)).some((l) => l.id === c && l.text === "Cherry C"), "C on A's Children", 3000);
  await page.until(async () => (await links(page, FIELD.blocks)).some((l) => l.id === k && l.text === "Kiwi K"), "K on A's Blocks", 3000);
});

test("Live: a create, a delete, and a purge in another repo redraw a page open on A, with no reload (ticket dfpje5ux)", async (t) => {
  const { hub, page } = await setup(t);
  const a = await makeTicket(hub, REPO, "Ticket A");
  const c = await makeTicket(hub, OTHER_REPO, "Cherry C");
  const d = await makeTicket(hub, OTHER_REPO, "Damson D");
  await setTicket(hub, OTHER_REPO, c, "--parent", `${REPO}:${a}`);
  await setTicket(hub, OTHER_REPO, d, "--parent", `${REPO}:${a}`, "--state", "closed");
  await openTicket(page, a);
  await markStay(page);
  await page.until(async () => {
    const shown = (await links(page, FIELD.children)).map((l) => l.id);
    return shown.includes(c) && shown.includes(d);
  }, "C and D on A's Children", 3000);

  const f = await makeTicket(hub, OTHER_REPO, "Fresh F");
  await ensureField(page, "Depends");
  await typeInto(page, FIELD.depends, "Fresh");
  await page.until(async () => (await menuOptions(page, FIELD.depends)).some((o) => o.text.includes("Fresh F") && o.repo === OTHER_REPO), `the new ticket ${f} offered on Depends`, 3000);
  await page.key("Escape");
  await page.quiet();

  const deleted = await cli(hub.port, ["--user", USER, "--repo", OTHER_REPO, "ticket", "delete", c], "");
  assert.equal(deleted.code, 0, deleted.stderr);
  await page.until(async () => !(await links(page, FIELD.children)).some((l) => l.id === c), "C gone from A's Children after its delete", 3000);

  const purged = await cli(hub.port, ["--user", USER, "--repo", OTHER_REPO, "ticket", "purge"], "");
  assert.equal(purged.code, 0, purged.stderr);
  await page.until(async () => !(await links(page, FIELD.children)).some((l) => l.id === d), "D gone from A's Children after the purge", 3000);
  await stayed(page);
});

test("Live: a change in this repo redraws a page open on a ticket in another repo, with no reload (ticket dfpje5ux)", async (t) => {
  const { hub, page } = await setup(t);
  const a = await makeTicket(hub, REPO, "Ticket A");
  const b = await makeTicket(hub, OTHER_REPO, "Banana B");
  await setTicket(hub, OTHER_REPO, b, "--depends", `${REPO}:${a}`);
  await openTicket(page, b, OTHER_REPO);
  await markStay(page);
  await page.until(async () => (await links(page, FIELD.depends)).some((l) => l.text === "Ticket A"), "A's title on B's Depends", 3000);
  await setTicket(hub, REPO, a, "--title", "Ticket A renamed");
  await page.until(async () => (await links(page, FIELD.depends)).some((l) => l.text === "Ticket A renamed"), "the new title on B's Depends", 3000);
  const child = await makeTicket(hub, REPO, "Child in this repo");
  await setTicket(hub, REPO, child, "--parent", `${OTHER_REPO}:${b}`);
  await page.until(async () => (await links(page, FIELD.children)).some((l) => l.id === child && l.text === "Child in this repo"), "the new child on B's Children", 3000);
  await stayed(page);
});
