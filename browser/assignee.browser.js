import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { REPO, USER, cli, launchBrowser, Page, startHub } from "./harness.js";

// Acceptance for ticket bakzq8fb, the optional assignee, from the Acceptance section of the
// ticket's body, part by part. The stored bytes are read from the hub's /raw route. A title
// that says "default" tests what the criteria name as the default.

const FIELD = ".ticket-form input.md-ticket-assignee";
const SHOWN = (selector) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return !!el && !el.hidden && el.getClientRects().length > 0; })()`;

async function hubOnly(t) {
  const hub = await startHub();
  t.after(() => hub.close());
  return hub;
}

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
  return { hub, browser, page };
}

const run = (hub, args, input = "") => cli(hub.port, ["--user", USER, "--repo", REPO, ...args], input);

async function makeTicket(hub, title, ...fields) {
  const out = await run(hub, ["ticket", "create", "--title", title, ...fields], `${title} body.\n`);
  assert.equal(out.code, 0, out.stderr);
  return out.stdout.trim().split("\n")[0];
}

async function setTicket(hub, id, ...fields) {
  const out = await run(hub, ["ticket", "set", id, ...fields]);
  assert.equal(out.code, 0, out.stderr);
  return out;
}

async function raw(hub, id) {
  return (await fetch(`http://127.0.0.1:${hub.port}/raw/${REPO}/tickets/${id}.md`)).text();
}

async function shown(hub, id) {
  const out = await cli(hub.port, ["--user", USER, "--json", "--repo", REPO, "ticket", "show", id], "");
  assert.equal(out.code, 0, out.stderr);
  return JSON.parse(out.stdout);
}

async function openTicket(page, id) {
  const since = page.frames.length;
  page.loads = (page.loads || 0) + 1;
  await page.session.send("Page.navigate", { url: `http://127.0.0.1:${page.port}/?load=${page.loads}#${REPO}/ticket/${encodeURIComponent(id)}` });
  await page.until(() => page.frames.slice(since).some((frame) => frame.dir === "in" && frame.data && frame.data.type === "file" && frame.data.path === `tickets/${id}.md`), `ticket ${id}`);
  await page.until(() => page.eval(SHOWN(FIELD)), `the assignee field on ${id}`);
  await page.quiet();
}

async function press(page, selector) {
  const point = await page.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el || el.getClientRects().length === 0) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + Math.min(r.width / 2, 30), y: r.top + r.height / 2 };
  })()`);
  assert.ok(point, `nothing drawn for ${selector}`);
  await page.click(point.x, point.y);
  await page.quiet();
}

// Puts text in the field with real keys: a click, select all, then typing.
async function typeInto(page, text) {
  await press(page, FIELD);
  await page.key("a", ["Ctrl"]);
  await page.key("Backspace");
  if (text) await page.type(text);
}

const fieldValue = (page) => page.eval(`document.querySelector(${JSON.stringify(FIELD)}).value`);
const rowCell = (page, id) => page.eval(`(() => { const c = document.querySelector('.ticket-block .md-ticket-node[data-id="${id}"] .md-ticket-assignee'); return c ? c.textContent : null; })()`);

test("stored: a ticket without an assignee opens, lists, and shows, with the assignee blank", async (t) => {
  const { hub, page } = await setup(t);
  const id = await makeTicket(hub, "Alpha");
  assert.doesNotMatch(await raw(hub, id), /^assignee:/m);
  const show = await run(hub, ["ticket", "show", id]);
  assert.equal(show.code, 0, show.stderr);
  assert.doesNotMatch(show.stderr, /^assignee \S/m);
  const list = JSON.parse((await cli(hub.port, ["--user", USER, "--json", "--repo", REPO, "ticket", "list"], "")).stdout).tickets;
  assert.equal(list.find((x) => x.id === id).assignee, "");
  await openTicket(page, id);
  assert.equal(await fieldValue(page), "");
  await page.until(async () => (await rowCell(page, id)) === "", "the list row with an empty assignee");
});

test("stored (default, a question for the owner): a write to another field adds no assignee line, and the bytes stay as they were until one is set", async (t) => {
  const hub = await hubOnly(t);
  const id = await makeTicket(hub, "Alpha");
  const before = await raw(hub, id);
  await setTicket(hub, id, "--priority", "high");
  const after = await raw(hub, id);
  assert.equal(after, before.replace("priority: medium", "priority: high"), "a priority write changed more than the priority line");
  assert.doesNotMatch(after, /^assignee:/m);
});

test("stored: setting an assignee writes it through the hub and raises the rev; clearing it leaves no assignee line", async (t) => {
  const hub = await hubOnly(t);
  const id = await makeTicket(hub, "Alpha");
  const before = await raw(hub, id);
  const rev0 = (await shown(hub, id)).rev;
  await setTicket(hub, id, "--assignee", "ada");
  assert.match(await raw(hub, id), /^assignee: ada$/m);
  const rev1 = (await shown(hub, id)).rev;
  assert.ok(rev1 > rev0, `rev ${rev0} -> ${rev1}`);
  await setTicket(hub, id, "--assignee", "");
  assert.equal(await raw(hub, id), before, "clearing the assignee did not give back the unassigned bytes");
  assert.equal((await shown(hub, id)).assignee, "");
});

test("stored (default): an assignee with a newline or a tab is refused with 400 and nothing is written, and spaces at either end are trimmed", async (t) => {
  const hub = await hubOnly(t);
  const id = await makeTicket(hub, "Alpha");
  const before = await raw(hub, id);
  for (const bad of ["a\tb", "a\nb"]) {
    const out = await run(hub, ["ticket", "set", id, "--assignee", bad]);
    assert.notEqual(out.code, 0, `${JSON.stringify(bad)} was taken`);
    assert.match(out.stderr, /400/, out.stderr);
    assert.equal(await raw(hub, id), before, `${JSON.stringify(bad)} changed the file`);
  }
  await setTicket(hub, id, "--assignee", "  ada  ");
  assert.equal((await shown(hub, id)).assignee, "ada");
  assert.match(await raw(hub, id), /^assignee: ada$/m);
});

test("page: the Assignee field sits directly below Priority and above Parent, in the DOM and on screen, with a label like Priority's", async (t) => {
  const { hub, page } = await setup(t);
  const parent = await makeTicket(hub, "Parent ticket");
  const id = await makeTicket(hub, "Alpha");
  await setTicket(hub, id, "--parent", parent);
  await openTicket(page, id);
  const layout = await page.eval(`(() => {
    const priority = document.querySelector(".ticket-form select.md-ticket-priority").closest(".md-ticket-field");
    const assignee = document.querySelector(${JSON.stringify(FIELD)}).closest(".md-ticket-field");
    const parent = document.querySelector(".ticket-form .md-ticket-parent");
    const label = (field) => { const l = field.querySelector(".md-ticket-label"); const s = getComputedStyle(l); return { cls: l.className, font: s.font, color: s.color, text: l.textContent }; };
    const rect = (el) => el.getBoundingClientRect();
    return {
      next: priority.nextElementSibling === assignee, before: assignee.nextElementSibling === parent,
      priorityBottom: rect(priority).bottom, assigneeTop: rect(assignee).top, assigneeBottom: rect(assignee).bottom, parentTop: rect(parent).top,
      priorityLabel: label(priority), assigneeLabel: label(assignee),
    };
  })()`);
  assert.equal(layout.next, true, "Assignee is not the next element after Priority");
  assert.equal(layout.before, true, "Parent is not the next element after Assignee");
  assert.ok(layout.assigneeTop >= layout.priorityBottom - 1, "Assignee is not drawn below Priority");
  assert.ok(layout.parentTop >= layout.assigneeBottom - 1, "Parent is not drawn below Assignee");
  assert.equal(layout.assigneeLabel.text, "Assignee");
  assert.equal(layout.assigneeLabel.cls, layout.priorityLabel.cls);
  assert.equal(layout.assigneeLabel.font, layout.priorityLabel.font);
  assert.equal(layout.assigneeLabel.color, layout.priorityLabel.color);
});

test("page (default): Enter or leaving the field saves, and Escape puts back the stored value and saves nothing", async (t) => {
  const { hub, page } = await setup(t);
  const id = await makeTicket(hub, "Alpha");
  await openTicket(page, id);
  await typeInto(page, "ada");
  await page.key("Enter");
  await page.until(async () => (await shown(hub, id)).assignee === "ada", "Enter saved ada", 3000);
  await typeInto(page, "bob");
  await press(page, "#editor");
  await page.until(async () => (await shown(hub, id)).assignee === "bob", "leaving the field saved bob", 3000);
  const rev = (await shown(hub, id)).rev;
  await typeInto(page, "carl");
  await page.key("Escape");
  await page.quiet();
  assert.equal(await fieldValue(page), "bob", "Escape did not put back the stored value");
  await press(page, "#editor");
  await sleep(300);
  assert.equal((await shown(hub, id)).assignee, "bob", "Escape saved");
  assert.equal((await shown(hub, id)).rev, rev, "Escape wrote to the ticket");
});

test("page: a value set by the CLI or another tab shows without a reload, except in a focused field with unsaved text", async (t) => {
  const { hub, browser, page } = await setup(t);
  const id = await makeTicket(hub, "Alpha");
  await openTicket(page, id);
  await setTicket(hub, id, "--assignee", "ada");
  await page.until(async () => (await fieldValue(page)) === "ada", "the CLI's value in the field", 3000);
  const other = await browser.newSession();
  const tab = new Page(other.session, hub.port);
  await tab.init();
  await tab.login("qa-two");
  await openTicket(tab, id);
  await typeInto(tab, "bob");
  await tab.key("Enter");
  await page.until(async () => (await fieldValue(page)) === "bob", "the other tab's value in the field", 3000);
  await typeInto(page, "unsaved");
  await setTicket(hub, id, "--assignee", "carl");
  await sleep(600);
  assert.equal(await fieldValue(page), "unsaved", "a remote value replaced unsaved text in the focused field");
});

test("page: an empty field means unassigned", async (t) => {
  const { hub, page } = await setup(t);
  const id = await makeTicket(hub, "Alpha", "--assignee", "ada");
  const unassigned = (await raw(hub, id)).replace("assignee: ada\n", "");
  await openTicket(page, id);
  assert.equal(await fieldValue(page), "ada");
  await typeInto(page, "");
  await page.key("Enter");
  await page.until(async () => (await shown(hub, id)).assignee === "", "the empty field saved as unassigned", 3000);
  assert.equal(await raw(hub, id), unassigned, "an empty field left an assignee line");
});

test("page: the field takes any text, opens no picker, and stores a name that matches no session as typed", async (t) => {
  const { hub, page } = await setup(t);
  const id = await makeTicket(hub, "Alpha");
  await openTicket(page, id);
  const name = "Nobody Here 42 (an agent)";
  await typeInto(page, name);
  const popup = await page.eval(`(() => {
    const input = document.querySelector(${JSON.stringify(FIELD)});
    const open = [...document.querySelectorAll("[role=listbox], [role=menu], .md-ticket-menu, datalist")].filter((el) => !el.hidden && el.getClientRects().length > 0);
    return { list: input.getAttribute("list"), auto: input.getAttribute("aria-autocomplete"), open: open.map((el) => el.className || el.tagName) };
  })()`);
  assert.equal(popup.list, null, "the field has a datalist");
  assert.equal(popup.auto, null, "the field completes");
  assert.deepEqual(popup.open, [], "a picker opened");
  await page.key("Enter");
  await page.until(async () => (await shown(hub, id)).assignee === name, "the name stored as typed", 3000);
});

test("CLI (default): ticket set and ticket create take --assignee, and --assignee \"\" clears it", async (t) => {
  const hub = await hubOnly(t);
  const id = await makeTicket(hub, "Alpha", "--assignee", "ada");
  assert.equal((await shown(hub, id)).assignee, "ada");
  await setTicket(hub, id, "--assignee", "bob");
  assert.equal((await shown(hub, id)).assignee, "bob");
  await setTicket(hub, id, "--assignee", "");
  assert.equal((await shown(hub, id)).assignee, "");
});

test("CLI (default): ticket show prints the assignee on stderr, ticket list --json includes it, and help names the flag", async (t) => {
  const hub = await hubOnly(t);
  const id = await makeTicket(hub, "Alpha", "--assignee", "ada");
  const show = await run(hub, ["ticket", "show", id]);
  assert.match(show.stderr, /^assignee ada$/m, show.stderr);
  assert.match(show.stderr, /^priority /m, "the assignee is not with the other fields");
  const list = JSON.parse((await cli(hub.port, ["--user", USER, "--json", "--repo", REPO, "ticket", "list"], "")).stdout).tickets;
  assert.equal(list.find((x) => x.id === id).assignee, "ada");
  const help = await cli(hub.port, ["help"], "");
  assert.match(help.stdout + help.stderr, /--assignee/);
});

async function revealTickets(page) {
  const point = await page.eval(`(() => { const b = document.querySelector(".ticket-block"); const r = b.getBoundingClientRect(); return { x: r.left + 20, y: r.top + 20 }; })()`);
  await page.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await sleep(700);
}

test("list: an Assignee column comes right after Priority (default), with each row's assignee and an empty cell when unassigned", async (t) => {
  const { hub, page } = await setup(t);
  const a = await makeTicket(hub, "Alpha", "--assignee", "ada");
  const b = await makeTicket(hub, "Beta");
  await openTicket(page, a);
  const columns = await page.eval(`[...document.querySelectorAll(".ticket-block .md-ticket-columns button")].map((x) => x.dataset.sort)`);
  const at = columns.indexOf("priority");
  assert.equal(columns[at + 1], "assignee", `columns: ${columns}`);
  const header = await page.eval(`document.querySelector('.ticket-block .md-ticket-columns button[data-sort="assignee"]').textContent.trim()`);
  assert.equal(header, "Assignee");
  assert.equal(await rowCell(page, a), "ada");
  assert.equal(await rowCell(page, b), "");
  const order = await page.eval(`[...document.querySelector('.ticket-block .md-ticket-node[data-id="${a}"] button.md-ticket').children].map((c) => c.className)`);
  assert.equal(order[order.indexOf("md-ticket-priority") + 1], "md-ticket-assignee", `cells: ${order}`);
});

test("list: the Assignee header sorts like the other headers", async (t) => {
  const { hub, page } = await setup(t);
  const ids = [];
  for (const [title, who] of [["One", "carl"], ["Two", "ada"], ["Three", "bob"]]) ids.push(await makeTicket(hub, title, "--assignee", who));
  await openTicket(page, ids[0]);
  await revealTickets(page);
  const rows = () => page.eval(`[...document.querySelectorAll(".ticket-block .md-ticket-node")].map((n) => n.querySelector(".md-ticket-assignee").textContent)`);
  const sortBy = async (key) => {
    const point = await page.eval(`(() => { const b = document.querySelector('.ticket-block .md-ticket-columns button[data-sort="${key}"]'); if (!b || b.getClientRects().length === 0) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    assert.ok(point, `the ${key} header is not drawn`);
    await page.click(point.x, point.y);
    await page.quiet();
  };
  await sortBy("assignee");
  assert.deepEqual(await rows(), ["ada", "bob", "carl"], "the first click does not sort ascending");
  await sortBy("assignee");
  assert.deepEqual(await rows(), ["carl", "bob", "ada"], "the second click does not sort descending");
  await sortBy("assignee");
  assert.deepEqual(await rows(), ["carl", "ada", "bob"], "the third click does not go back to the created order");
  await sortBy("title");
  assert.deepEqual(await rows(), ["carl", "bob", "ada"], "Title sorts differently");
});

test("list: the filter menu has no assignee entry, and its boxes filter as before", async (t) => {
  const { hub, page } = await setup(t);
  const low = await makeTicket(hub, "Low one", "--priority", "low", "--assignee", "ada");
  const high = await makeTicket(hub, "High one", "--priority", "high");
  await openTicket(page, high);
  await revealTickets(page);
  await press(page, ".ticket-block .md-ticket-filter");
  await page.until(() => page.eval(SHOWN(".ticket-block .md-ticket-filter-menu")), "the filter menu open");
  const entries = await page.eval(`[...document.querySelectorAll(".ticket-block .md-ticket-filter-menu [data-filter]")].map((b) => b.dataset.filter + "|" + (b.closest("label") ? b.closest("label").textContent.trim() : ""))`);
  assert.ok(entries.length > 0, "no filter entries");
  assert.ok(!entries.some((e) => /assignee|ada/i.test(e)), `the filter menu has an assignee entry: ${entries}`);
  const box = await page.eval(`(() => { const b = document.querySelector('.ticket-block .md-ticket-filter-menu [data-filter="low"]'); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.click(box.x, box.y);
  await page.quiet();
  const present = (id) => page.eval(`!!document.querySelector('.ticket-block .md-ticket-node[data-id="${id}"]')`);
  assert.equal(await present(low), false, "unchecking low left the low ticket listed");
  assert.equal(await present(high), true);
  await page.click(box.x, box.y);
  await page.quiet();
  assert.equal(await present(low), true, "checking low did not bring the low ticket back");
});

test("list: setting an assignee from the page or the CLI updates the row without a reload", async (t) => {
  const { hub, page } = await setup(t);
  const id = await makeTicket(hub, "Alpha");
  await openTicket(page, id);
  await typeInto(page, "ada");
  await page.key("Enter");
  await page.until(async () => (await rowCell(page, id)) === "ada", "the row after a page edit", 3000);
  await setTicket(hub, id, "--assignee", "bob");
  await page.until(async () => (await rowCell(page, id)) === "bob", "the row after a CLI edit", 3000);
});
