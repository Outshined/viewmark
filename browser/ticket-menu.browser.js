import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { REPO, USER, cli, launchBrowser, Page, startHub } from "./harness.js";

// Acceptance for ticket xj3zqv5t, the ticket pane menu, from the Acceptance section of the
// ticket's body, part by part. A title that says "default" tests what the criteria name as the
// default where the request leaves a choice open.

const BUTTON = ".ticket-form button.md-ticket-pane-menu";
const PANEL = ".ticket-form .md-ticket-pane-panel";
const RELATIONS = ["parent", "depends", "children", "blocks"];
const FIELD = { parent: ".md-ticket-parent", depends: ".md-ticket-depends", children: ".md-ticket-children", blocks: ".md-ticket-blocks" };
const SHOWN = (selector) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return !!el && !el.hidden && el.getClientRects().length > 0; })()`;

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
  await page.session.send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"], origin: `http://127.0.0.1:${hub.port}` });
  return { hub, browser, page };
}

async function run(hub, ...args) {
  const out = await cli(hub.port, ["--user", USER, "--repo", REPO, ...args], "");
  return out;
}

async function makeTicket(hub, title, ...fields) {
  const out = await cli(hub.port, ["--user", USER, "--repo", REPO, "ticket", "create", "--title", title, ...fields], `${title} body.\n`);
  assert.equal(out.code, 0, out.stderr);
  return out.stdout.trim().split("\n")[0];
}

async function setTicket(hub, id, ...fields) {
  const out = await run(hub, "ticket", "set", id, ...fields);
  assert.equal(out.code, 0, out.stderr);
}

async function ticketJson(hub, id) {
  const out = await cli(hub.port, ["--user", USER, "--json", "--repo", REPO, "ticket", "show", id], "");
  assert.equal(out.code, 0, out.stderr);
  return JSON.parse(out.stdout);
}

async function fileBytes(hub, id) {
  return (await hub.show(`tickets/${id}.md`)).text;
}

async function openTicket(page, id) {
  const since = page.frames.length;
  page.loads = (page.loads || 0) + 1;
  await page.session.send("Page.navigate", { url: `http://127.0.0.1:${page.port}/?load=${page.loads}#${REPO}/ticket/${encodeURIComponent(id)}` });
  await page.until(() => page.frames.slice(since).some((frame) => frame.dir === "in" && frame.data && frame.data.type === "file" && frame.data.path === `tickets/${id}.md`), `ticket ${id}`);
  await page.until(() => page.eval(SHOWN(BUTTON)), `the menu button on ${id}`);
  await page.quiet();
}

async function center(page, selector) {
  const point = await page.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el || el.getClientRects().length === 0) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  assert.ok(point, `nothing drawn for ${selector}`);
  return point;
}

async function press(page, selector) {
  const point = await center(page, selector);
  await page.click(point.x, point.y);
  await page.quiet();
}

async function openMenu(page) {
  if (!(await page.eval(SHOWN(PANEL)))) await press(page, BUTTON);
  await page.until(() => page.eval(SHOWN(PANEL)), "the menu open");
}

async function menuItem(page, text) {
  const point = await page.eval(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(PANEL + " button, " + PANEL + " label")})].find((e) => e.textContent.trim() === ${JSON.stringify(text)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + Math.min(20, r.width / 2), y: r.top + r.height / 2 };
  })()`);
  assert.ok(point, `no menu entry ${text}`);
  return point;
}

async function readClipboard(page) {
  const out = await page.session.send("Runtime.evaluate", { expression: "navigator.clipboard.readText()", awaitPromise: true, userGesture: true, returnByValue: true });
  return out.result.value;
}

async function writeClipboard(page, text) {
  await page.session.send("Runtime.evaluate", { expression: `navigator.clipboard.writeText(${JSON.stringify(text)})`, awaitPromise: true, userGesture: true });
}

// The AGENTS.md glyph rule, read from what the browser computes for each drawn element.
function glyph(page, selector) {
  return page.eval(`(() => {
    const svg = document.querySelector(${JSON.stringify(selector)});
    if (!svg) return null;
    const color = getComputedStyle(svg).color;
    const parts = [...svg.querySelectorAll("path, line, rect, circle, polyline, ellipse")].map((el) => {
      const s = getComputedStyle(el);
      return { tag: el.tagName, d: el.getAttribute("d"), x: el.getAttribute("x"), y: el.getAttribute("y"), width: el.getAttribute("width"), height: el.getAttribute("height"), rx: el.getAttribute("rx"),
        fill: s.fill, stroke: s.stroke, width2: s.strokeWidth, cap: s.strokeLinecap, join: s.strokeLinejoin };
    });
    return { viewBox: svg.getAttribute("viewBox"), hidden: svg.getAttribute("aria-hidden"), color, parts };
  })()`);
}

function followsGlyphRule(g, label) {
  assert.ok(g, `${label}: no svg`);
  assert.equal(g.viewBox, "0 0 24 24", `${label}: viewBox`);
  assert.equal(g.hidden, "true", `${label}: aria-hidden`);
  assert.ok(g.parts.length > 0, `${label}: nothing drawn`);
  for (const p of g.parts) {
    assert.equal(p.fill, "none", `${label}: ${p.tag} fill`);
    assert.equal(p.stroke, g.color, `${label}: ${p.tag} stroke is not currentColor`);
    assert.equal(p.width2, "2px", `${label}: ${p.tag} stroke width`);
    assert.equal(p.cap, "round", `${label}: ${p.tag} caps`);
    assert.equal(p.join, "round", `${label}: ${p.tag} joins`);
  }
}

function box(page, selector) {
  return page.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el || el.getClientRects().length === 0) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  })()`);
}

const checked = (page) => page.eval(`Object.fromEntries([...document.querySelectorAll(${JSON.stringify(PANEL + " input[type=checkbox]")})].map((b) => [b.dataset.relation, b.checked]))`);
const shownFields = (page) => page.eval(`Object.fromEntries(${JSON.stringify(Object.entries(FIELD))}.map(([k, s]) => { const el = document.querySelector(".ticket-form " + s); return [k, !!el && !el.hidden && el.getClientRects().length > 0]; }))`);

test("menu button: one sits within 16 px of the top right corner of the center pane", async (t) => {
  const { hub, page } = await setup(t);
  const id = await makeTicket(hub, "Alpha");
  await openTicket(page, id);
  assert.equal(await page.eval(`document.querySelectorAll(${JSON.stringify(BUTTON)}).length`), 1);
  const b = await box(page, BUTTON);
  const pane = await box(page, ".ticket-form");
  assert.ok(b.top >= pane.top && b.top - pane.top <= 16, `the button's top is ${b.top - pane.top} px below the pane's`);
  assert.ok(b.right <= pane.right && pane.right - b.right <= 16, `the button's right edge is ${pane.right - b.right} px from the pane's`);
});

test("menu button: the size of the add-file button, within 1 px", async (t) => {
  const { hub, page } = await setup(t);
  const id = await makeTicket(hub, "Alpha");
  await openTicket(page, id);
  const add = await page.eval(`(() => {
    const el = [...document.querySelectorAll(".file-block .md-pane-head button")].find((b) => b.getClientRects().length > 0);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { width: r.width, height: r.height, label: el.getAttribute("aria-label") || el.textContent };
  })()`);
  assert.ok(add, "no add-file button");
  const b = await box(page, BUTTON);
  assert.ok(Math.abs(b.width - add.width) <= 1 && Math.abs(b.height - add.height) <= 1, `menu button ${b.width}x${b.height}, add-file button (${add.label}) ${add.width}x${add.height}`);
});

test("menu button: its glyph follows the glyph rule, and by default it is the page's three-line menu icon", async (t) => {
  const { hub, page } = await setup(t);
  const id = await makeTicket(hub, "Alpha");
  await openTicket(page, id);
  const g = await glyph(page, `${BUTTON} svg`);
  followsGlyphRule(g, "menu glyph");
  const d = g.parts.map((p) => p.d || "").join(" ");
  const lines = [...d.matchAll(/M\s*([\d.]+)[ ,]+([\d.]+)\s*h\s*([\d.]+)/gi)];
  assert.equal(lines.length, 3, `the menu glyph is not three horizontal lines: ${d}`);
});

test("menu button: aria-label Menu, aria-haspopup menu, and aria-expanded true only while open", async (t) => {
  const { hub, page } = await setup(t);
  const id = await makeTicket(hub, "Alpha");
  await openTicket(page, id);
  const attrs = () => page.eval(`(() => { const b = document.querySelector(${JSON.stringify(BUTTON)}); return { label: b.getAttribute("aria-label"), popup: b.getAttribute("aria-haspopup"), expanded: b.getAttribute("aria-expanded") }; })()`);
  assert.deepEqual(await attrs(), { label: "Menu", popup: "menu", expanded: "false" });
  await openMenu(page);
  assert.equal((await attrs()).expanded, "true");
  await press(page, BUTTON);
  assert.equal((await attrs()).expanded, "false");
});

test("menu button: a click opens the menu under it, a second click closes it, and a click elsewhere closes it", async (t) => {
  const { hub, page } = await setup(t);
  const id = await makeTicket(hub, "Alpha");
  await openTicket(page, id);
  await press(page, BUTTON);
  assert.equal(await page.eval(SHOWN(PANEL)), true, "the first click did not open the menu");
  const b = await box(page, BUTTON);
  const p = await box(page, PANEL);
  assert.ok(p.top >= b.bottom - 1, `the menu's top ${p.top} is above the button's bottom ${b.bottom}`);
  assert.ok(p.left < b.right && p.right > b.left, "the menu is not under the button");
  await press(page, BUTTON);
  assert.equal(await page.eval(SHOWN(PANEL)), false, "the second click did not close the menu");
  for (const elsewhere of ["#editor", ".file-block .md-pane-head", "aside.comments"]) {
    await openMenu(page);
    const point = await page.eval(`(() => { const r = document.querySelector(${JSON.stringify(elsewhere)}).getBoundingClientRect(); return { x: r.left + 20, y: r.top + 12 }; })()`);
    await page.click(point.x, point.y);
    await page.quiet();
    assert.equal(await page.eval(SHOWN(PANEL)), false, `a click on ${elsewhere} did not close the menu`);
  }
});

test("menu button (default): Escape closes the menu", async (t) => {
  const { hub, page } = await setup(t);
  const id = await makeTicket(hub, "Alpha");
  await openTicket(page, id);
  await openMenu(page);
  await page.key("Escape");
  await page.quiet();
  assert.equal(await page.eval(SHOWN(PANEL)), false, "Escape left the menu open");
});

test("menu button: it does not overlap the raw view toggle", async (t) => {
  const { hub, page } = await setup(t);
  const id = await makeTicket(hub, "Alpha");
  await openTicket(page, id);
  const b = await box(page, BUTTON);
  const toggle = await box(page, "#editor button.md-view-toggle");
  assert.ok(toggle, "no raw view toggle on the ticket");
  const meets = b.right > toggle.left && b.left < toggle.right && b.bottom > toggle.top && b.top < toggle.bottom;
  assert.equal(meets, false, `the menu button ${JSON.stringify(b)} overlaps the toggle ${JSON.stringify(toggle)}`);
});

test("menu button (default, a question for the owner): a plain document has no menu button in that corner", async (t) => {
  const { hub, page } = await setup(t);
  await hub.create("a.md", "alpha\n");
  await page.open("a.md");
  assert.equal(await page.eval(SHOWN(BUTTON)), false, "a document shows the ticket menu button");
  assert.equal(await page.eval(SHOWN(".md-ticket-pane-menu")), false, "a document shows a ticket menu button");
});

test("Copy link puts exactly the ticket's URL on the clipboard, closes the menu, and the URL opens the ticket", async (t) => {
  const { hub, browser, page } = await setup(t);
  const id = await makeTicket(hub, "Alpha");
  await openTicket(page, id);
  await writeClipboard(page, "before");
  await openMenu(page);
  const item = await menuItem(page, "Copy link");
  await page.click(item.x, item.y);
  await page.quiet();
  await sleep(200);
  const want = await page.eval(`location.origin + location.pathname + "#${REPO}/ticket/${id}"`);
  assert.equal(await readClipboard(page), want);
  assert.equal(await page.eval(SHOWN(PANEL)), false, "the menu stayed open");
  const other = await browser.newSession();
  const tab = new Page(other.session, hub.port);
  await tab.init();
  await tab.login("qa-two");
  const since = tab.frames.length;
  await tab.session.send("Page.navigate", { url: want });
  await tab.until(() => tab.frames.slice(since).some((f) => f.dir === "in" && f.data && f.data.type === "file" && f.data.path === `tickets/${id}.md`), "the URL opens the ticket");
});

test("Delete ticket asks first; Cancel changes nothing; Delete removes the ticket through the hub, and other tickets drop it", async (t) => {
  const { hub, page } = await setup(t);
  const gone = await makeTicket(hub, "Gone");
  const child = await makeTicket(hub, "Child");
  const waiter = await makeTicket(hub, "Waiter");
  await setTicket(hub, child, "--parent", gone);
  await setTicket(hub, waiter, "--depends", gone);
  await openTicket(page, gone);
  await openMenu(page);
  let item = await menuItem(page, "Delete ticket");
  await page.click(item.x, item.y);
  await page.quiet();
  assert.equal(await page.eval(SHOWN(".md-confirm")), true, "no confirmation was asked");
  assert.match(await page.eval(`document.querySelector(".md-confirm-text").textContent`), new RegExp(gone));
  const cancel = await page.eval(`(() => { const b = [...document.querySelectorAll(".md-confirm button")].find((x) => x.textContent.trim() === "Cancel"); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.click(cancel.x, cancel.y);
  await page.quiet();
  assert.equal((await ticketJson(hub, gone)).id, gone, "Cancel deleted the ticket");
  await openMenu(page);
  item = await menuItem(page, "Delete ticket");
  await page.click(item.x, item.y);
  await page.quiet();
  const yes = await page.eval(`(() => { const b = [...document.querySelectorAll(".md-confirm button")].find((x) => x.textContent.trim() === "Delete"); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.click(yes.x, yes.y);
  await page.quiet();
  await sleep(300);
  const list = JSON.parse((await cli(hub.port, ["--user", USER, "--json", "--repo", REPO, "ticket", "list", "--closed"], "")).stdout).tickets;
  assert.ok(!list.some((x) => x.id === gone), "the ticket is still listed");
  assert.equal((await ticketJson(hub, child)).parent, "", "the child still names the deleted parent");
  assert.deepEqual((await ticketJson(hub, waiter)).depends, [], "the waiter still depends on the deleted ticket");
  await page.until(() => page.eval(`!document.querySelector('.ticket-block .md-ticket-node[data-id="${gone}"]')`), "the ticket leaves the list");
});

test("the menu has one Delete ticket entry, outside Show fields (an open question: item 2 or the end)", async (t) => {
  const { hub, page } = await setup(t);
  const id = await makeTicket(hub, "Alpha");
  await openTicket(page, id);
  await openMenu(page);
  const where = await page.eval(`(() => {
    const items = [...document.querySelector(${JSON.stringify(PANEL)}).children];
    const sep = items.findIndex((el) => el.classList.contains("md-ticket-pane-sep"));
    return items.map((el, i) => ({ text: el.textContent.trim(), afterSep: sep >= 0 && i > sep })).filter((x) => x.text === "Delete ticket");
  })()`);
  assert.equal(where.length, 1, `Delete ticket appears ${where.length} times`);
  assert.equal(where[0].afterSep, false, "Delete ticket sits under Show fields");
});

test("Show fields: a separator, then Parent, Depends, Children, and Blocks in that order, each with a checkbox", async (t) => {
  const { hub, page } = await setup(t);
  const id = await makeTicket(hub, "Alpha");
  await openTicket(page, id);
  await openMenu(page);
  const after = await page.eval(`(() => {
    const items = [...document.querySelector(${JSON.stringify(PANEL)}).children];
    const sep = items.findIndex((el) => el.classList.contains("md-ticket-pane-sep") || el.getAttribute("role") === "separator");
    if (sep < 0) return null;
    const line = items[sep];
    const s = getComputedStyle(line);
    return { drawn: line.getClientRects().length > 0 && (parseFloat(s.borderTopWidth) > 0 || parseFloat(s.height) > 0),
      rows: items.slice(sep + 1).filter((el) => el.querySelector("input[type=checkbox]")).map((el) => el.textContent.trim()) };
  })()`);
  assert.ok(after, "no separator in the menu");
  assert.equal(after.drawn, true, "the separator is not drawn");
  assert.deepEqual(after.rows, ["Parent", "Depends", "Children", "Blocks"]);
});

test("Show fields: the menu names the Show fields group under the separator", async (t) => {
  const { hub, page } = await setup(t);
  const id = await makeTicket(hub, "Alpha");
  await openTicket(page, id);
  await openMenu(page);
  const text = await page.eval(`document.querySelector(${JSON.stringify(PANEL)}).innerText`);
  assert.match(text, /Show fields/, `the menu reads: ${JSON.stringify(text)}`);
});

test("Show fields: a checked entry shows its field, an unchecked one hides it, and hiding writes nothing", async (t) => {
  const { hub, page } = await setup(t);
  const other = await makeTicket(hub, "Other");
  const id = await makeTicket(hub, "Alpha");
  await setTicket(hub, id, "--depends", other);
  await openTicket(page, id);
  assert.equal((await shownFields(page)).depends, true, "Depends with a value is hidden at open");
  const before = await fileBytes(hub, id);
  const sentBefore = page.frames.filter((f) => f.dir === "out").length;
  await openMenu(page);
  let item = await menuItem(page, "Depends");
  await page.click(item.x, item.y);
  await page.quiet();
  assert.equal((await shownFields(page)).depends, false, "unchecking Depends left the field shown");
  const sent = page.frames.slice(0).filter((f) => f.dir === "out").slice(sentBefore).filter((f) => f.data && f.data.type !== "lock" && f.data.type !== "pong");
  assert.deepEqual(sent.map((f) => f.data.type), [], "hiding a field sent a write");
  assert.equal(await fileBytes(hub, id), before, "hiding a field changed the file");
  await openMenu(page);
  item = await menuItem(page, "Parent");
  await page.click(item.x, item.y);
  await page.quiet();
  assert.equal((await shownFields(page)).parent, true, "checking Parent did not show the field");
  assert.equal(await fileBytes(hub, id), before, "showing a field changed the file");
});

test("Show fields (default): clicking an entry toggles its box and keeps the menu open", async (t) => {
  const { hub, page } = await setup(t);
  const id = await makeTicket(hub, "Alpha");
  await openTicket(page, id);
  await openMenu(page);
  for (const name of ["Parent", "Depends", "Children"]) {
    const item = await menuItem(page, name);
    await page.click(item.x, item.y);
    await page.quiet();
    assert.equal(await page.eval(SHOWN(PANEL)), true, `the menu closed after ${name}`);
  }
  assert.deepEqual(await checked(page), { parent: true, depends: true, children: true, blocks: false });
});

test("defaults: each entry is checked, and its field shown, only when the ticket has that relation", async (t) => {
  const { hub, page } = await setup(t);
  const parent = await makeTicket(hub, "Parent ticket");
  const dep = await makeTicket(hub, "Dependency");
  const id = await makeTicket(hub, "Middle");
  const child = await makeTicket(hub, "Child ticket");
  const blocked = await makeTicket(hub, "Blocked ticket");
  const cases = [
    [parent, { parent: false, depends: false, children: true, blocks: false }],
    [dep, { parent: false, depends: false, children: false, blocks: true }],
  ];
  await setTicket(hub, id, "--parent", parent, "--depends", dep);
  await setTicket(hub, child, "--parent", id);
  await setTicket(hub, blocked, "--depends", id);
  cases.push([id, { parent: true, depends: true, children: true, blocks: true }]);
  cases.push([child, { parent: true, depends: false, children: false, blocks: false }]);
  cases.push([blocked, { parent: false, depends: true, children: false, blocks: false }]);
  for (const [ticket, want] of cases) {
    await openTicket(page, ticket);
    assert.deepEqual(await shownFields(page), want, `fields shown on ${ticket}`);
    await openMenu(page);
    assert.deepEqual(await checked(page), want, `entries checked on ${ticket}`);
  }
});

test("defaults: a ticket with none of the four shows none of the fields", async (t) => {
  const { hub, page } = await setup(t);
  const id = await makeTicket(hub, "Alone");
  await openTicket(page, id);
  assert.deepEqual(await shownFields(page), { parent: false, depends: false, children: false, blocks: false });
});

test("defaults (default): a hidden field that gets its first value from the CLI is shown and checked", async (t) => {
  const { hub, page } = await setup(t);
  const other = await makeTicket(hub, "Other");
  const id = await makeTicket(hub, "Alpha");
  await openTicket(page, id);
  assert.equal((await shownFields(page)).depends, false);
  await setTicket(hub, id, "--depends", other);
  await page.until(async () => (await shownFields(page)).depends, "Depends shown after the CLI set it", 3000);
  await openMenu(page);
  assert.equal((await checked(page)).depends, true, "Depends is not checked");
});

test("defaults (default, a question for the owner): a choice holds while the ticket stays open, and reopening starts from the defaults", async (t) => {
  const { hub, page } = await setup(t);
  const id = await makeTicket(hub, "Alpha");
  const other = await makeTicket(hub, "Other");
  await openTicket(page, id);
  await openMenu(page);
  const item = await menuItem(page, "Children");
  await page.click(item.x, item.y);
  await page.quiet();
  await press(page, "#editor");
  await page.type("x");
  await page.quiet();
  assert.equal((await shownFields(page)).children, true, "the choice did not hold while the ticket stayed open");
  await openTicket(page, other);
  await openTicket(page, id);
  assert.equal((await shownFields(page)).children, false, "reopening kept the choice");
});

test("Blocks has the same picker, link list, and remove control as Depends, in the same layout", async (t) => {
  const { hub, page } = await setup(t);
  const a = await makeTicket(hub, "Ticket A");
  const b = await makeTicket(hub, "Ticket B");
  const c = await makeTicket(hub, "Ticket C");
  await setTicket(hub, a, "--depends", c);
  await setTicket(hub, b, "--depends", a);
  await openTicket(page, a);
  const shape = (selector) => page.eval(`(() => {
    const field = document.querySelector(".ticket-form " + ${JSON.stringify(selector)});
    if (!field) return null;
    const walk = (el) => [el.tagName + "." + [...el.classList].filter((c) => c !== "md-ticket-depends" && c !== "md-ticket-blocks").sort().join("."), [...el.children].filter((k) => !k.classList.contains("md-ticket-link")).map(walk)];
    const links = field.querySelectorAll(".md-ticket-link").length;
    const r = field.getBoundingClientRect();
    const parts = ["md-ticket-match", "md-ticket-add", "md-ticket-remove", "md-ticket-links"].map((c) => { const el = field.querySelector("." + c); if (!el) return null; const q = el.getBoundingClientRect(); return [c, Math.round(q.left - r.left), Math.round(q.width), Math.round(q.height)]; });
    return { tree: JSON.stringify(walk(field)), links, parts };
  })()`);
  const depends = await shape(".md-ticket-depends");
  const blocks = await shape(".md-ticket-blocks");
  assert.ok(depends && blocks, "Depends or Blocks is not drawn");
  assert.equal(blocks.tree, depends.tree, "Blocks is built differently from Depends");
  assert.equal(blocks.links, 1);
  assert.deepEqual(blocks.parts, depends.parts, "Blocks is laid out differently from Depends");
});

async function pickInto(page, field, title) {
  const input = `.ticket-form ${field} .md-ticket-match`;
  await press(page, input);
  await page.type(title);
  await page.quiet();
  await page.until(() => page.eval(SHOWN(`.ticket-form ${field} .md-ticket-menu`)), `matches for ${title}`);
  await press(page, `.ticket-form ${field} .md-ticket-add`);
  await page.quiet();
  await sleep(200);
}

async function ensureField(page, name) {
  const key = name.toLowerCase();
  if ((await shownFields(page))[key]) return;
  await openMenu(page);
  const item = await menuItem(page, name);
  await page.click(item.x, item.y);
  await page.quiet();
  await press(page, BUTTON);
}

test("Blocks: adding B on A writes A into B's depends and leaves A's file as it was; removing takes it out", async (t) => {
  const { hub, page } = await setup(t);
  const a = await makeTicket(hub, "Ticket A");
  const b = await makeTicket(hub, "Banana B");
  await openTicket(page, a);
  await ensureField(page, "Blocks");
  const before = await fileBytes(hub, a);
  await pickInto(page, ".md-ticket-blocks", "Banana");
  await page.until(async () => (await ticketJson(hub, b)).depends.includes(a), "B depends on A", 3000);
  assert.equal(await fileBytes(hub, a), before, "A's own file changed");
  const shown = await cli(hub.port, ["--user", USER, "--repo", REPO, "ticket", "show", b], "");
  assert.match(shown.stderr, new RegExp(`depends.*${a}`), `ticket show B: ${shown.stderr}`);
  await page.until(() => page.eval(`!!document.querySelector('.ticket-form .md-ticket-blocks .md-ticket-link[data-id="${b}"]')`), "B listed under Blocks", 3000);
  await press(page, `.ticket-form .md-ticket-blocks .md-ticket-link[data-id="${b}"]`);
  await press(page, ".ticket-form .md-ticket-blocks .md-ticket-remove");
  await page.until(async () => !(await ticketJson(hub, b)).depends.includes(a), "B no longer depends on A", 3000);
  assert.equal(await fileBytes(hub, a), before, "A's own file changed on remove");
});

test("Blocks: without a reload, B's page shows A under Depends, and A's page shows B under Blocks, in another tab too", async (t) => {
  const { hub, browser, page } = await setup(t);
  const a = await makeTicket(hub, "Ticket A");
  const b = await makeTicket(hub, "Banana B");
  const other = await browser.newSession();
  const tab = new Page(other.session, hub.port);
  await tab.init();
  await tab.login("qa-two");
  await openTicket(tab, b);
  await openTicket(page, a);
  await ensureField(page, "Blocks");
  await pickInto(page, ".md-ticket-blocks", "Banana");
  await page.until(() => page.eval(`!!document.querySelector('.ticket-form .md-ticket-blocks .md-ticket-link[data-id="${b}"]')`), "A's page shows B under Blocks", 3000);
  await tab.until(() => tab.eval(`!!document.querySelector('.ticket-form .md-ticket-depends .md-ticket-link[data-id="${a}"]')`), "B's page in the other tab shows A under Depends", 3000);
});

// One attempt to link a ticket through a picker: whether the picker offers it, and what the hub
// answers when it is added.
async function attempt(page, field, title) {
  const input = `.ticket-form ${field} .md-ticket-match`;
  await press(page, input);
  await page.eval(`(() => { const i = document.querySelector(${JSON.stringify(input)}); i.select(); return true; })()`);
  await page.key("Backspace");
  await page.type(title);
  await page.quiet();
  await sleep(150);
  const offered = await page.eval(`(() => { const m = document.querySelector(".ticket-form ${field} .md-ticket-menu"); return !!m && !m.hidden && m.children.length > 0; })()`);
  if (!offered) {
    await page.key("Escape");
    return { offered: false, errors: [] };
  }
  const since = page.frames.length;
  await press(page, `.ticket-form ${field} .md-ticket-add`);
  await sleep(400);
  const errors = page.frames.slice(since).filter((f) => f.dir === "in" && f.data && f.data.type === "error").map((f) => f.data.status);
  return { offered: true, errors };
}

test("Blocks: a cycle or the ticket itself is refused as it is from Depends, and no file changes", async (t) => {
  const { hub, page } = await setup(t);
  const a = await makeTicket(hub, "Ticket A");
  const b = await makeTicket(hub, "Banana B");
  await setTicket(hub, a, "--depends", b);
  const bytes = async () => [await fileBytes(hub, a), await fileBytes(hub, b)].join("\n---\n");
  const before = await bytes();
  // The cycle: A depends on B, so B may not depend on A, from B's Depends or from A's Blocks.
  await openTicket(page, b);
  await ensureField(page, "Depends");
  const cycleDepends = await attempt(page, ".md-ticket-depends", "Ticket A");
  assert.equal(await bytes(), before, "the cycle from Depends changed a file");
  await openTicket(page, a);
  await ensureField(page, "Blocks");
  const cycleBlocks = await attempt(page, ".md-ticket-blocks", "Banana");
  assert.equal(await bytes(), before, "the cycle from Blocks changed a file");
  // The ticket itself, from its own Depends and its own Blocks.
  await ensureField(page, "Depends");
  const selfDepends = await attempt(page, ".md-ticket-depends", "Ticket A");
  const selfBlocks = await attempt(page, ".md-ticket-blocks", "Ticket A");
  assert.equal(await bytes(), before, "linking the ticket to itself changed a file");
  t.diagnostic(JSON.stringify({ cycleDepends, cycleBlocks, selfDepends, selfBlocks }));
  assert.ok(!cycleDepends.offered || cycleDepends.errors.length > 0, `Depends took the cycle: ${JSON.stringify(cycleDepends)}`);
  assert.deepEqual(cycleBlocks, cycleDepends, "Blocks answered the cycle differently from Depends");
  assert.deepEqual(selfBlocks, selfDepends, "Blocks answered the ticket itself differently from Depends");
});

test("Id row: the id and one copy button, no delete button, and no .md-ticket-delete on the page", async (t) => {
  const { hub, page } = await setup(t);
  const id = await makeTicket(hub, "Alpha");
  await openTicket(page, id);
  const row = await page.eval(`(() => {
    const value = document.querySelector(".ticket-form .md-ticket-fact-id");
    if (!value) return null;
    const row = value.closest(".md-ticket-fact");
    return { text: value.textContent.trim(), buttons: [...row.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") || b.textContent.trim()) };
  })()`);
  assert.ok(row, "no Id row");
  assert.equal(row.text, id);
  assert.equal(row.buttons.length, 1, `the Id row has ${row.buttons.length} buttons: ${row.buttons}`);
  assert.equal(await page.eval(`document.querySelectorAll(".md-ticket-delete").length`), 0);
});

test("Id row: the copy glyph is two overlapping rounded rectangles under the glyph rule, labeled Copy ticket id (default)", async (t) => {
  const { hub, page } = await setup(t);
  const id = await makeTicket(hub, "Alpha");
  await openTicket(page, id);
  const sel = ".ticket-form .md-ticket-fact-id button";
  assert.equal(await page.eval(`document.querySelector(${JSON.stringify(sel)}).getAttribute("aria-label")`), "Copy ticket id");
  const g = await glyph(page, `${sel} svg`);
  followsGlyphRule(g, "copy glyph");
  const rects = g.parts.filter((p) => p.tag === "rect");
  assert.equal(rects.length, 2, "not two rectangles");
  for (const r of rects) assert.ok(Number(r.rx) > 0, "a rectangle is not rounded");
  const [p, q] = rects.map((r) => ({ x: +r.x, y: +r.y, w: +r.width, h: +r.height }));
  const overlap = p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h && (p.x !== q.x || p.y !== q.y);
  assert.ok(overlap, "the rectangles do not overlap");
});

test("Id row: a click puts exactly the 8-character id on the clipboard, and the ticket does not change", async (t) => {
  const { hub, page } = await setup(t);
  const id = await makeTicket(hub, "Alpha");
  await openTicket(page, id);
  const before = await fileBytes(hub, id);
  await writeClipboard(page, "before");
  await press(page, ".ticket-form .md-ticket-fact-id button");
  await sleep(200);
  const got = await readClipboard(page);
  assert.equal(got, id);
  assert.equal(got.length, 8);
  assert.equal(await fileBytes(hub, id), before);
});

test("the document menu lists Attach image and Delete file, and Commit repo is absent", async (t) => {
  const { hub, page } = await setup(t);
  await hub.create("a.md", "alpha\n");
  const id = await makeTicket(hub, "Alpha");
  const read = () => page.eval(`(() => {
    const button = document.querySelector("button.md-doc-menu");
    const panel = document.querySelector(".md-doc-menu-panel");
    const toggle = document.querySelector("#editor button.md-view-toggle");
    const commit = [...document.querySelectorAll("button, [role=menuitem]")].some((el) => /commit repo/i.test((el.textContent || "") + " " + (el.getAttribute("aria-label") || "")));
    const menu = button && button.getBoundingClientRect();
    const raw = toggle && toggle.getBoundingClientRect();
    return {
      label: button && button.getAttribute("aria-label"),
      role: panel && panel.getAttribute("role"),
      items: panel ? [...panel.querySelectorAll("button")].map((el) => el.textContent.trim()) : null,
      commit,
      attach: document.querySelectorAll("button.md-attach").length,
      menu: menu && { left: menu.left, right: menu.right, top: menu.top, bottom: menu.bottom },
      raw: raw && { left: raw.left, right: raw.right, top: raw.top, bottom: raw.bottom },
    };
  })()`);
  await page.open("a.md");
  const doc = await read();
  assert.equal(doc.label, "Menu");
  assert.equal(doc.role, "menu");
  assert.deepEqual(doc.items, ["Attach image", "Delete file"]);
  assert.equal(doc.commit, false);
  assert.equal(doc.attach, 0);
  assert.ok(doc.menu.right <= doc.raw.left + 1, "the menu covers the raw toggle");
  assert.ok(doc.menu.top < doc.raw.bottom && doc.raw.top < doc.menu.bottom, "the menu is not beside the raw toggle");
  await openTicket(page, id);
  const ticket = await read();
  assert.deepEqual(ticket.items, ["Attach image", "Delete file"]);
  assert.equal(ticket.commit, false);
  assert.equal(ticket.label, "Menu");
  assert.ok(ticket.menu.right <= ticket.raw.left + 1, "the menu covers the raw toggle on a ticket");
});
