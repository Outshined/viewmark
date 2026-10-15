import test from "node:test";
import assert from "node:assert/strict";
import { REPO, USER, cli, launchBrowser, Page, startHub } from "./harness.js";

// A ticket body starts at the wide sheet's leftover row. That size does not cap the text:
// a longer body grows #editor, and the window scrolls. The body is not an inner scrollport.

const SHORT = "Shown.";
const SENTENCE = "The ticket body grows with its text. ";
const LONG = SENTENCE.repeat(400);

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

function measure(page) {
  return page.eval(`(() => {
    const editor = document.getElementById("editor");
    const sheet = document.querySelector(".sheet");
    const form = document.querySelector(".ticket-form");
    const nav = document.querySelector("nav.files");
    const scroller = document.scrollingElement;
    const lines = [...editor.querySelectorAll(".md-line")].filter((line) => line.textContent.trim() !== "");
    const first = lines[0];
    const last = lines[lines.length - 1];
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top + window.scrollY, bottom: r.bottom + window.scrollY, height: r.height, width: r.width };
    };
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const editorStyle = getComputedStyle(editor);
    const sheetStyle = getComputedStyle(sheet);
    let port = null;
    for (let node = last; node && node !== editor.parentElement; node = node.parentElement) {
      if (Math.abs(node.scrollHeight - node.clientHeight) > 1) {
        port = node.id || String(node.className || node.tagName);
        break;
      }
    }
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollHeight: scroller.scrollHeight,
      rem,
      editor: box(editor),
      editorClient: editor.clientHeight,
      editorScroll: editor.scrollHeight,
      sheet: box(sheet),
      form: box(form),
      nav: box(nav),
      first: box(first),
      last: box(last),
      firstText: first.textContent,
      lastText: last.textContent,
      lineCount: lines.length,
      editorMax: editorStyle.maxHeight,
      sheetMax: sheetStyle.maxHeight,
      overflowY: editorStyle.overflowY,
      port,
    };
  })()`);
}

test("a short ticket body stays in the starting box and is shown", async (t) => {
  const { hub, page } = await setup(t);
  const id = await makeTicket(hub, "Short body", SHORT);
  await openTicket(page, id, SHORT);
  const m = await measure(page);
  assert.ok(m.innerWidth > 800, `viewport is ${m.innerWidth}px wide`);
  assert.equal(m.firstText, SHORT);
  assert.equal(m.lineCount, 1);
  assert.ok(m.first.height > 0 && m.first.width > 0, "the line is not drawn");
  assert.ok(m.first.top >= m.editor.top - 1 && m.first.bottom <= m.editor.bottom + 1, "the line is outside the body box");
  assert.ok(m.first.top >= -1 && m.first.bottom <= m.innerHeight + 1, "the line is outside the window");
  const starting = m.innerHeight - 2 * m.rem;
  assert.ok(Math.abs(m.sheet.height - starting) <= 1, `the sheet is ${m.sheet.height}px, not the starting ${starting}px`);
  assert.ok(Math.abs(m.editor.bottom - m.sheet.bottom) <= 1, `the body ends at ${m.editor.bottom}px, the sheet at ${m.sheet.bottom}px`);
  assert.ok(m.editor.top >= m.form.bottom - 1, "the body overlaps the fields");
  assert.ok(m.editor.height > m.first.height + m.rem, "the body shrank to the text");
  assert.ok(Math.abs(m.editorScroll - m.editorClient) <= 1, `the body scrolls inside itself (${m.editorScroll} vs ${m.editorClient})`);
  assert.equal(m.port, null, `an inner scroller holds the text: ${m.port}`);
  assert.equal(m.editorMax, "none");
  assert.equal(m.sheetMax, "none");
  assert.equal(m.overflowY, "visible");
});

test("a long ticket body grows the editor and the window scrolls", async (t) => {
  const { hub, page } = await setup(t);
  const id = await makeTicket(hub, "Long body", LONG);
  await openTicket(page, id, "grows with its text");
  const m = await measure(page);
  assert.ok(m.innerWidth > 800, `viewport is ${m.innerWidth}px wide`);
  assert.ok(m.firstText.includes("grows with its text"), "the body text is not shown");
  assert.ok(m.last.bottom > m.innerHeight, `the text ends at ${m.last.bottom}px, inside the window (${m.innerHeight}px)`);
  assert.ok(m.editor.bottom > m.innerHeight, `the body ends at ${m.editor.bottom}px, held to the window (${m.innerHeight}px)`);
  assert.ok(m.editor.bottom > m.nav.bottom, `the body ends at ${m.editor.bottom}px, held to the left panel (${m.nav.bottom}px)`);
  assert.ok(m.last.bottom <= m.editor.bottom + 1, `the text ends at ${m.last.bottom}px, past the body box ${m.editor.bottom}px`);
  assert.ok(m.scrollHeight > m.innerHeight, `the window does not scroll (${m.scrollHeight} vs ${m.innerHeight})`);
  assert.ok(Math.abs(m.editorScroll - m.editorClient) <= 1, `#editor is a scrollport (${m.editorScroll} vs ${m.editorClient})`);
  assert.equal(m.port, null, `an inner scroller holds the text: ${m.port}`);
  assert.equal(m.editorMax, "none");
  assert.equal(m.sheetMax, "none");
  assert.equal(m.overflowY, "visible");
  assert.ok(m.editor.top >= m.form.bottom - 1, "the body overlaps the fields");
});
