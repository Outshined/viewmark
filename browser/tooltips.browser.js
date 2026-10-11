import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { REPO, USER, cli, launchBrowser, Page, startHub } from "./harness.js";

// Ticket p4sbujyz: every glyph button has a tooltip. The owner narrowed the request to glyph
// buttons ("All *glyph* buttons"), asked for the browser's own mechanism ("Use whatever browser
// mechanisms are available"), and for a hint on each one ("Write hints for each one, no more than
// several words"). QA reads "several" as six words or fewer. A glyph button is a button drawn with
// no letters or digits in its text.

const CM = (id, note) => `\n\`\`\`comment ${id}\n:: 0\n@2026-10-11T00:00:00.000Z ${USER}\n${note}\n\`\`\`\n`;

// Every glyph button in the page, drawn or not, with what a tooltip needs.
const GLYPHS = `[...document.querySelectorAll("button, [role=button]")]
  .filter((el) => !/[\\p{L}\\p{N}]/u.test(el.textContent || ""))
  .map((el) => {
    const r = el.getBoundingClientRect();
    return {
      name: el.getAttribute("aria-label") || el.className,
      className: String(el.className),
      title: el.getAttribute("title"),
      disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
      drawn: el.getClientRects().length > 0 && r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden",
      rect: { left: r.left, top: r.top, width: r.width, height: r.height },
    };
  })`;

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

async function makeTicket(hub, title, ...fields) {
  const out = await cli(hub.port, ["--user", USER, "--repo", REPO, "ticket", "create", "--title", title, ...fields], `${title} body.\n`);
  assert.equal(out.code, 0, out.stderr);
  return out.stdout.trim().split("\n")[0];
}

async function openTicket(page, id) {
  page.loads = (page.loads || 0) + 1;
  await page.session.send("Page.navigate", { url: `http://127.0.0.1:${page.port}/?load=${page.loads}#${REPO}/ticket/${encodeURIComponent(id)}` });
  await page.until(() => page.eval(`!!document.querySelector(".ticket-form button.md-ticket-pane-menu")`), `ticket ${id}`);
  await page.quiet();
}

// A document with a comment whose card is current, so its controls are drawn, then a ticket that
// depends on another, so its relation buttons are drawn. Returns the glyph buttons drawn in each.
async function scenes(t) {
  const { hub, page } = await setup(t);
  await hub.create("a.md", `See {c1}this{/c1} now.\n${CM("c1", "Why?")}`);
  await page.open("a.md");
  await page.clickOffset("See {c1}th".length);
  await page.quiet();
  await page.until(() => page.eval(`!!document.querySelector(".md-comment-card.md-comment-current")`), "the current comment card");
  const doc = await page.eval(GLYPHS);
  const other = await makeTicket(hub, "Other");
  const id = await makeTicket(hub, "Ticket");
  const set = await cli(hub.port, ["--user", USER, "--repo", REPO, "ticket", "set", id, "--depends", other], "");
  assert.equal(set.code, 0, set.stderr);
  await openTicket(page, id);
  await page.until(() => page.eval(`!!document.querySelector(".ticket-form .md-ticket-depends .md-ticket-add")`), "the Depends field");
  const ticket = await page.eval(GLYPHS);
  return { page, doc, ticket };
}

const words = (title) => title.trim().split(/\s+/).filter(Boolean).length;

function drawnTitles(buttons, token) {
  return buttons
    .filter((button) => button.drawn && button.className.split(/\s+/).includes(token))
    .map((button) => button.title);
}

test("every glyph button drawn on a document, a comment card, and a ticket has a title of one to six words", async (t) => {
  const { page, doc, ticket } = await scenes(t);
  const drawn = [...doc, ...ticket].filter((button) => button.drawn);
  const wrong = drawn.filter((button) => !button.title || !button.title.trim() || words(button.title) > 6);
  assert.deepEqual(wrong.map((button) => `${button.name}: ${JSON.stringify(button.title)}`), [], "glyph buttons with no title, an empty one, or more than six words");
  // The glyph buttons the acceptance names, by their accessible names, so one that vanishes is
  // noticed. The document menu's button, from a41e268, is a glyph button too.
  const names = new Set(drawn.map((button) => button.name));
  for (const name of ["New file", "Delete file", "New ticket", "Filter", "Raw", "Menu", "Resolve", "Copy link", "Reply", "Delete", "Copy ticket id", "Add", "Remove"]) {
    assert.ok(names.has(name), `no drawn glyph button named ${name}; drawn: ${[...names].join(", ")}`);
  }
  const same = ["New file", "Delete file", "New ticket", "Filter", "Resolve", "Copy link", "Reply", "Copy ticket id"];
  const drifted = drawn.filter((button) => same.includes(button.name) && button.title !== button.name);
  assert.deepEqual(drifted.map((button) => `${button.name}: ${JSON.stringify(button.title)}`), []);
  assert.deepEqual(drawnTitles(doc, "md-view-toggle"), ["Show raw markdown"]);
  assert.deepEqual(drawnTitles(doc, "md-doc-menu"), ["Open the document menu"]);
  assert.deepEqual(doc.filter((button) => button.drawn && button.name === "Delete").map((button) => button.title), ["Delete this comment"]);
  assert.deepEqual(drawnTitles(ticket, "md-ticket-pane-menu"), ["Open the ticket menu"]);
  assert.deepEqual(drawnTitles(ticket, "md-ticket-add"), ["Add a dependency"]);
  assert.deepEqual(drawnTitles(ticket, "md-ticket-remove"), ["Remove a dependency"]);
  const eye = await page.eval(`(() => {
    const button = document.querySelector("button.md-view-toggle");
    if (!button) return null;
    const formatted = button.getAttribute("title");
    const before = button.getAttribute("aria-pressed");
    button.click();
    const raw = button.getAttribute("title");
    const pressed = button.getAttribute("aria-pressed");
    button.click();
    return { formatted, before, raw, pressed, restored: button.getAttribute("title"), after: button.getAttribute("aria-pressed") };
  })()`);
  assert.deepEqual(eye, {
    formatted: "Show raw markdown",
    before: "false",
    raw: "Show raw markdown",
    pressed: "true",
    restored: "Show raw markdown",
    after: "false",
  });
  t.diagnostic(drawn.map((button) => `${button.name} → ${JSON.stringify(button.title)}`).join("; "));
});

test("a disabled glyph button keeps its title", async (t) => {
  const { doc, ticket } = await scenes(t);
  const disabled = [...doc, ...ticket].filter((button) => button.disabled);
  if (disabled.length === 0) t.diagnostic("no glyph button is disabled on these pages, so nothing is checked");
  assert.deepEqual(disabled.filter((button) => !button.title || !button.title.trim()).map((button) => button.name), []);
});

test("resting the pointer on a glyph button draws no tooltip of the page's own, and moves no button", async (t) => {
  const { page, ticket } = await scenes(t);
  const tips = `[...document.querySelectorAll("[role=tooltip], [class*=tooltip], [class*=Tooltip]")].length`;
  const before = await page.eval(tips);
  for (const button of ticket.filter((b) => b.drawn)) {
    const x = button.rect.left + button.rect.width / 2;
    const y = button.rect.top + button.rect.height / 2;
    await page.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await sleep(700);
    assert.equal(await page.eval(tips), before, `a tooltip element appeared over ${button.name}`);
  }
  await page.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
  await sleep(200);
  const after = await page.eval(GLYPHS);
  const rect = (list) => Object.fromEntries(list.filter((b) => b.drawn).map((b) => [`${b.name}|${b.className}`, b.rect]));
  assert.deepEqual(rect(after), rect(ticket), "a glyph button moved or changed size");
});
