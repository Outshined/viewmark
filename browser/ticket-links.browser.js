import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { REPO, USER, cli, launchBrowser, Page, startHub } from "./harness.js";

// Acceptance for ticket dfpje5ux, cross-repo ticket links, from the page part of the Acceptance
// section of the ticket's body. REPO is the repo that holds A, OTHER_REPO a second registered repo,
// and ghost a name no repo has. The live update of an inbound link is a QA proposal the owner has
// not answered, so it has no test here.

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

test("Blocks and Children: a ticket in another repo that names this:A is listed on A, with its title", async (t) => {
  const { hub, page } = await setup(t);
  const a = await makeTicket(hub, REPO, "Ticket A");
  const blocker = await makeTicket(hub, OTHER_REPO, "Blocker over there");
  const child = await makeTicket(hub, OTHER_REPO, "Child over there");
  await setTicket(hub, OTHER_REPO, blocker, "--depends", `${REPO}:${a}`);
  await setTicket(hub, OTHER_REPO, child, "--parent", `${REPO}:${a}`);
  await openTicket(page, a);
  await page.until(() => page.eval(SHOWN(`.ticket-form ${FIELD.blocks}`)), "the Blocks row", 3000);
  await page.until(() => page.eval(SHOWN(`.ticket-form ${FIELD.children}`)), "the Children row", 3000);
  const blocks = await links(page, FIELD.blocks);
  const children = await links(page, FIELD.children);
  assert.ok(blocks.some((l) => l.id === blocker && l.repo === OTHER_REPO && l.text === "Blocker over there"), `Blocks draws ${JSON.stringify(blocks)}`);
  assert.ok(children.some((l) => l.id === child && l.repo === OTHER_REPO && l.text === "Child over there"), `Children draws ${JSON.stringify(children)}`);
});

test("Depends: an unresolved token is drawn as the token, with no title", async (t) => {
  const { hub, page } = await setup(t);
  const a = await makeTicket(hub, REPO, "Ticket A");
  await setTicket(hub, REPO, a, "--depends", GHOST);
  await openTicket(page, a);
  await page.until(() => page.eval(SHOWN(`.ticket-form ${FIELD.depends}`)), "the Depends row", 3000);
  assert.deepEqual((await links(page, FIELD.depends)).map((l) => l.text), [GHOST]);
});

test("Depends: a typed token that is not in the suggestion list is sent and stored, with Enter and with Add", async (t) => {
  const { hub, page } = await setup(t);
  const a = await makeTicket(hub, REPO, "Ticket A");
  const b = await makeTicket(hub, OTHER_REPO, "Ticket B");
  await openTicket(page, a);
  await ensureField(page, "Depends");
  await typeInto(page, FIELD.depends, GHOST);
  await page.key("Enter");
  await page.until(async () => (await ticketJson(hub, REPO, a)).depends.includes(GHOST), `A depends on ${GHOST}, after Enter`, 3000);
  await typeInto(page, FIELD.depends, `${OTHER_REPO}:${b}`);
  await press(page, `.ticket-form ${FIELD.depends} .md-ticket-add`);
  await page.until(async () => (await ticketJson(hub, REPO, a)).depends.includes(`${OTHER_REPO}:${b}`), `A depends on ${OTHER_REPO}:B, after Add`, 3000);
  assert.deepEqual([...(await ticketJson(hub, REPO, a)).depends].sort(), [GHOST, `${OTHER_REPO}:${b}`].sort());
});

test("Parent: a typed token that is not in the suggestion list is sent and stored", async (t) => {
  const { hub, page } = await setup(t);
  const a = await makeTicket(hub, REPO, "Ticket A");
  const b = await makeTicket(hub, OTHER_REPO, "Ticket B");
  await openTicket(page, a);
  await ensureField(page, "Parent");
  await typeInto(page, FIELD.parent, `${OTHER_REPO}:${b}`);
  await page.key("Enter");
  await page.until(async () => (await ticketJson(hub, REPO, a)).parent === `${OTHER_REPO}:${b}`, `A's parent is ${OTHER_REPO}:B`, 3000);
});

test("Depends: a pick from the suggestion list stores a bare id", async (t) => {
  const { hub, page } = await setup(t);
  const a = await makeTicket(hub, REPO, "Ticket A");
  const c = await makeTicket(hub, REPO, "Cherry C");
  await openTicket(page, a);
  await ensureField(page, "Depends");
  await typeInto(page, FIELD.depends, "Cherry");
  await page.until(() => page.eval(SHOWN(`.ticket-form ${FIELD.depends} .md-ticket-menu`)), "matches for Cherry");
  await press(page, `.ticket-form ${FIELD.depends} .md-ticket-add`);
  await page.until(async () => (await ticketJson(hub, REPO, a)).depends.length > 0, "A depends on something", 3000);
  assert.deepEqual((await ticketJson(hub, REPO, a)).depends, [c]);
});

test("Depends: removing other:B stores the list without that token, and the other tokens stay as stored", async (t) => {
  const { hub, page } = await setup(t);
  const a = await makeTicket(hub, REPO, "Ticket A");
  const c = await makeTicket(hub, REPO, "Cherry C");
  const b = await makeTicket(hub, OTHER_REPO, "Ticket B");
  await setTicket(hub, REPO, a, "--depends", `${c},${OTHER_REPO}:${b},${GHOST}`);
  await openTicket(page, a);
  await page.until(() => page.eval(SHOWN(`.ticket-form ${FIELD.depends}`)), "the Depends row", 3000);
  const token = `${OTHER_REPO}:${b}`;
  await press(page, `.ticket-form ${FIELD.depends} .md-ticket-link[data-id="${token}"]`);
  await press(page, `.ticket-form ${FIELD.depends} .md-ticket-remove`);
  await page.until(async () => !(await ticketJson(hub, REPO, a)).depends.includes(token), `${token} gone from A's depends`, 3000);
  assert.deepEqual([...(await ticketJson(hub, REPO, a)).depends].sort(), [c, GHOST].sort());
});

test("Blocks and Children: an inbound ticket offers no remove, and pressing remove writes nothing in either repo", async (t) => {
  const { hub, page } = await setup(t);
  const a = await makeTicket(hub, REPO, "Ticket A");
  const blocker = await makeTicket(hub, OTHER_REPO, "Blocker over there");
  const child = await makeTicket(hub, OTHER_REPO, "Child over there");
  await setTicket(hub, OTHER_REPO, blocker, "--depends", `${REPO}:${a}`);
  await setTicket(hub, OTHER_REPO, child, "--parent", `${REPO}:${a}`);
  const snapshot = async () => JSON.stringify([
    await ticketJson(hub, REPO, a),
    await ticketJson(hub, OTHER_REPO, blocker),
    await ticketJson(hub, OTHER_REPO, child),
  ]);
  const before = await snapshot();
  await openTicket(page, a);
  await page.until(() => page.eval(SHOWN(`.ticket-form ${FIELD.blocks}`)), "the Blocks row", 3000);
  const since = page.frames.length;
  for (const [field, id] of [[FIELD.blocks, blocker], [FIELD.children, child]]) {
    await press(page, `.ticket-form ${field} .md-ticket-link[data-id="${id}"]`);
    await press(page, `.ticket-form ${field} .md-ticket-remove`);
  }
  await sleep(400);
  const sent = page.frames.slice(since).filter((f) => f.dir === "out" && f.data && /^ticket\./.test(f.data.type || "")).map((f) => f.data);
  assert.deepEqual(sent, [], "the page sent a ticket write");
  assert.equal(await snapshot(), before, "a ticket changed");
});

// The owner's answer of 2026-10-13: a link to a ticket that has gone missing is removed or ignored.
// The hub removes it on the next write to the ticket that holds it. Until then the page does not
// draw it. A token whose repo is not registered has not gone missing, and is still drawn.
test("Parent and Depends: a link to a ticket deleted from another repo is not drawn, and an unregistered token still is (ticket dfpje5ux)", async (t) => {
  const { hub, page } = await setup(t);
  const a = await makeTicket(hub, REPO, "Ticket A");
  const p = await makeTicket(hub, REPO, "Parent P");
  const b = await makeTicket(hub, OTHER_REPO, "Ticket B");
  await setTicket(hub, OTHER_REPO, b, "--depends", `${REPO}:${a},${GHOST}`, "--parent", `${REPO}:${p}`);
  for (const id of [a, p]) {
    const out = await cli(hub.port, ["--user", USER, "--repo", REPO, "ticket", "delete", id], "");
    assert.equal(out.code, 0, out.stderr);
  }
  const stored = await ticketJson(hub, OTHER_REPO, b);
  assert.deepEqual([...stored.depends].sort(), [`${REPO}:${a}`, GHOST].sort(), "B's file still holds both depends tokens before any write");
  assert.equal(stored.parent, `${REPO}:${p}`, "B's file still holds its parent before any write");
  await openTicket(page, b, OTHER_REPO);
  await page.until(() => page.eval(SHOWN(`.ticket-form ${FIELD.depends}`)), "the Depends row", 3000);
  assert.deepEqual((await links(page, FIELD.depends)).map((l) => l.text), [GHOST]);
  assert.equal((await shownFields(page)).parent, false, `the Parent row is drawn for ${REPO}:${p}, which is gone`);
});
