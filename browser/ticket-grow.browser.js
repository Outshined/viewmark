import test from "node:test";
import assert from "node:assert/strict";
import { REPO, USER, cli, launchBrowser, Page, startHub } from "./harness.js";

// Ticket sufe23sj. A ticket body starts at the box it has today, from under the ticket form to
// the bottom of the window, and grows to hold its text. The box does not scroll; the page does.
// Typing past the bottom of the window keeps the caret in view. Two points are QA's proposals,
// not approved: a body that loses text shrinks back, but not below the starting size, and the
// ticket form scrolls up with the page. A document that is not a ticket keeps today's layout.

const para = (n) => `Paragraph ${n} of the body.`;
const paras = (count) => Array.from({ length: count }, (_, i) => para(i + 1)).join("\n\n");

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

async function makeTicket(hub, title, body) {
  const out = await cli(hub.port, ["--user", USER, "--repo", REPO, "ticket", "create", "--title", title], body);
  assert.equal(out.code, 0, out.stderr);
  return out.stdout.trim().split("\n")[0];
}

async function ticketBody(hub, id) {
  const out = await cli(hub.port, ["--user", USER, "--repo", REPO, "ticket", "show", id]);
  assert.equal(out.code, 0, out.stderr);
  return out.stdout;
}

async function openTicket(page, id, needle) {
  const since = page.frames.length;
  page.loads = (page.loads || 0) + 1;
  await page.session.send("Page.navigate", { url: `http://127.0.0.1:${page.port}/?load=${page.loads}#${REPO}/ticket/${encodeURIComponent(id)}` });
  await page.until(
    () => page.frames.slice(since).some((frame) => frame.dir === "in" && frame.data && frame.data.type === "file" && frame.data.path === `tickets/${id}.md`),
    `ticket ${id}`,
  );
  await page.until(() => page.eval(`(() => {
    const form = document.querySelector(".ticket-form");
    const hit = [...document.querySelectorAll("#editor .md-line")].some((line) => line.textContent.includes(${JSON.stringify(needle)}));
    return !!form && !form.hidden && hit;
  })()`), `the body of ${id}`);
  await page.quiet();
}

// Boxes are in page coordinates, so they do not move when the window scrolls.
function measure(page) {
  return page.eval(`(() => {
    const editor = document.getElementById("editor");
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top + scrollY, bottom: r.bottom + scrollY, height: r.height };
    };
    const lines = [...editor.querySelectorAll(".md-line")].filter((line) => line.textContent.trim() !== "");
    const form = document.querySelector(".ticket-form");
    const style = getComputedStyle(editor);
    return {
      innerHeight,
      scrollY,
      scrollHeight: document.scrollingElement.scrollHeight,
      rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
      editor: box(editor),
      editorClient: editor.clientHeight,
      editorScroll: editor.scrollHeight,
      editorScrollTop: editor.scrollTop,
      overflowY: style.overflowY,
      border: style.borderTopStyle + " " + style.borderTopWidth,
      sheet: box(document.querySelector(".sheet")),
      form: form && !form.hidden ? { ...box(form), position: getComputedStyle(form).position, view: form.getBoundingClientRect().bottom } : null,
      lineCount: lines.length,
      last: lines.length ? box(lines[lines.length - 1]) : null,
      lastText: lines.length ? lines[lines.length - 1].textContent : "",
    };
  })()`);
}

// The box a ticket body starts at: from under the form to the bottom of the sheet, which ends
// 2rem above the bottom of the window.
function starting(m) {
  return m.innerHeight - 2 * m.rem - m.editor.top;
}

async function caretBox(page) {
  return page.eval(`(() => {
    const sel = getSelection();
    if (!sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    let r = range.getClientRects()[0];
    if (!r) {
      const node = sel.focusNode.nodeType === 1 ? sel.focusNode : sel.focusNode.parentElement;
      r = node.getBoundingClientRect();
    }
    return { top: r.top, bottom: r.bottom, innerHeight, collapsed: range.collapsed };
  })()`);
}

function assertInView(caret, what) {
  assert.ok(caret, `${what}: no caret`);
  assert.ok(caret.collapsed, `${what}: the selection is not collapsed`);
  assert.ok(caret.top >= -1 && caret.bottom <= caret.innerHeight + 1, `${what}: the caret is at y ${Math.round(caret.top)} to ${Math.round(caret.bottom)}, outside the ${caret.innerHeight} px window`);
}

function assertNoInnerScroll(m, what) {
  assert.ok(Math.abs(m.editorScroll - m.editorClient) <= 1, `${what}: the body box scrolls inside itself (scroll height ${m.editorScroll}, client height ${m.editorClient})`);
  assert.equal(m.editorScrollTop, 0, `${what}: the body box is scrolled by ${m.editorScrollTop} px`);
}

// Removes the paragraphs after the one numbered keep, through the one numbered last.
async function cutAfter(hub, id, keep, last) {
  const lines = [` ${para(keep)}`];
  for (let n = keep + 1; n <= last; n += 1) lines.push("-", `-${para(n)}`);
  const out = await cli(hub.port, ["--user", USER, "--repo", REPO, "edit", `tickets/${id}.md`], `@@\n${lines.join("\n")}\n`);
  assert.equal(out.code, 0, out.stderr);
}

test("typing past the bottom of the window keeps the caret in view, the box grows to hold the text, and the page scrolls (ticket sufe23sj)", async (t) => {
  const { hub, page } = await setup(t);
  const body = paras(10);
  const id = await makeTicket(hub, "Typed body", body);
  await openTicket(page, id, para(10));
  const before = await measure(page);
  assert.ok(before.editor.top >= before.form.bottom - 1, "the body overlaps the fields");
  assert.ok(Math.abs(before.editor.height - starting(before)) <= 1, `the box starts at ${before.editor.height} px, not the ${starting(before)} px from under the form to the bottom of the window`);
  assert.ok(before.last.bottom < before.innerHeight, "the starting text already reaches the bottom of the window");
  assert.ok(await page.clickOffset(body.length), "no point to click at the end of the body");
  await page.quiet();
  const typed = [];
  for (let n = 1; n <= 40; n += 1) {
    await page.key("Enter");
    await page.type(`Line ${n}`);
    typed.push(`Line ${n}`);
    await page.quiet();
    assertInView(await caretBox(page), `after typing Line ${n}`);
  }
  const after = await measure(page);
  assert.equal(after.lastText, "Line 40", "the last line drawn is not the last line typed");
  assert.ok(after.scrollY > 0, "the page did not scroll");
  assert.ok(after.editor.height > before.editor.height + 1, `the box stayed at ${after.editor.height} px`);
  assert.ok(after.last.bottom <= after.editor.bottom + 1, `the text ends at ${after.last.bottom} px, past the box at ${after.editor.bottom} px`);
  assertNoInnerScroll(after, "after typing");
  assert.equal(after.overflowY, "visible");
  const stored = await ticketBody(hub, id);
  for (const line of typed) assert.ok(stored.includes(line), `the hub has no ${line}`);
});

test("↓ from the top of a long ticket body keeps the caret in view while the page scrolls (ticket sufe23sj)", async (t) => {
  const { hub, page } = await setup(t);
  const id = await makeTicket(hub, "Walked body", paras(60));
  await openTicket(page, id, para(1));
  assert.ok(await page.clickOffset(0), "no point to click at the start of the body");
  await page.quiet();
  for (let n = 1; n < 60; n += 1) {
    await page.key("↓");
    await page.quiet();
    assertInView(await caretBox(page), `after ↓ ${n}`);
  }
  const caret = await page.eval("window.__qaCaret()");
  const text = await ticketBody(hub, id);
  assert.equal(caret.focus, text.indexOf(para(60)), "↓ did not walk to the last paragraph");
  const m = await measure(page);
  assert.ok(m.scrollY > 0, "the page did not scroll");
  assertNoInnerScroll(m, "after ↓");
});

test("a body that loses text shrinks the box with it, but not below the starting size (ticket sufe23sj; QA's proposal, not approved)", async (t) => {
  const { hub, page } = await setup(t);
  const id = await makeTicket(hub, "Shrinking body", paras(60));
  await openTicket(page, id, para(60));
  const full = await measure(page);
  const room = full.editor.bottom - full.last.bottom;
  assert.ok(full.editor.height > starting(full) + 1, "60 paragraphs did not grow the box");

  await cutAfter(hub, id, 30, 60);
  await page.until(() => page.eval(`![...document.querySelectorAll("#editor .md-line")].some((line) => line.textContent.includes(${JSON.stringify(para(31))}))`), "the cut paragraphs to go");
  await page.quiet();
  const half = await measure(page);
  assert.equal(half.lastText, para(30));
  assert.ok(half.editor.height < full.editor.height - 1, `the box stayed at ${half.editor.height} px after half the text went`);
  assert.ok(half.editor.height > starting(half) + 1, "30 paragraphs no longer grow the box");
  assert.ok(Math.abs(half.editor.bottom - half.last.bottom - room) <= 1, `the box ends ${half.editor.bottom - half.last.bottom} px below the text, not ${room} px as with the full body`);
  assertNoInnerScroll(half, "after the first cut");

  await cutAfter(hub, id, 3, 30);
  await page.until(() => page.eval(`![...document.querySelectorAll("#editor .md-line")].some((line) => line.textContent.includes(${JSON.stringify(para(4))}))`), "the cut paragraphs to go");
  await page.quiet();
  const short = await measure(page);
  assert.equal(short.lastText, para(3));
  assert.ok(Math.abs(short.editor.height - starting(short)) <= 1, `the box is ${short.editor.height} px, not its starting ${starting(short)} px`);
  assert.ok(short.scrollHeight <= short.innerHeight + 1, `the page still scrolls (${short.scrollHeight} px in a ${short.innerHeight} px window)`);
  assert.equal(short.scrollY, 0, "the page is still scrolled");
  assertNoInnerScroll(short, "after the second cut");
});

test("the ticket form scrolls up with the page and does not stay above the box (ticket sufe23sj; QA's proposal, not approved)", async (t) => {
  const { hub, page } = await setup(t);
  const id = await makeTicket(hub, "Scrolled body", paras(60));
  await openTicket(page, id, para(60));
  await page.eval("window.scrollTo(0, document.scrollingElement.scrollHeight); true");
  await page.frame();
  const m = await measure(page);
  assert.ok(m.scrollY > m.form.bottom, `the page scrolled ${m.scrollY} px, not past the form`);
  assert.ok(m.form.view <= 0, `the form's bottom is at y ${Math.round(m.form.view)} in the window after the page scrolled`);
  assert.ok(!["fixed", "sticky"].includes(m.form.position), `the form is ${m.form.position}`);
  assert.ok(m.last.bottom - m.scrollY <= m.innerHeight + 1, "the last paragraph is below the window at the end of the page");
});

test("a document that is not a ticket keeps today's layout: no ticket border, and the sheet grows with the text (ticket sufe23sj)", async (t) => {
  const { hub, page } = await setup(t);
  for (const [file, count] of [["short.md", 3], ["long.md", 60]]) {
    const out = await cli(hub.port, ["--user", USER, "--repo", REPO, "create", file], paras(count));
    assert.equal(out.code, 0, out.stderr);
    await page.open(file);
    const m = await measure(page);
    assert.equal(m.form, null, `${file}: a ticket form is shown`);
    assert.ok(m.border.startsWith("none"), `${file}: the editor has the ticket body's border, ${m.border}`);
    assert.equal(m.overflowY, "visible", `${file}: the editor's overflow is ${m.overflowY}`);
    assertNoInnerScroll(m, file);
    assert.equal(m.lastText, para(count), `${file}: the last paragraph is not drawn`);
    assert.ok(m.last.bottom <= m.editor.bottom + 1, `${file}: the text ends at ${m.last.bottom} px, past the editor at ${m.editor.bottom} px`);
    assert.ok(m.sheet.bottom >= m.editor.bottom - 1, `${file}: the editor ends at ${m.editor.bottom} px, past the sheet at ${m.sheet.bottom} px`);
    if (count === 60) assert.ok(m.scrollHeight > m.innerHeight, `${file}: the page does not scroll`);
  }
});
