import test from "node:test";
import assert from "node:assert/strict";
import { REPO, USER, cli, launchBrowser, Page, startHub } from "./harness.js";

// Ticket 3549946q. G on a ticket taller than the window lands on the last line,
// in view, and the next motion moves from there without a click.

const VIM = "viewmark.vim";
const LINES = 80;

function body() {
  const lines = [];
  for (let i = 0; i < LINES; i += 1) lines.push(`row ${String(i).padStart(2, "0")} stays`);
  return `${lines.join("\n\n")}\n`;
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
  await page.session.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `localStorage.setItem(${JSON.stringify(VIM)}, "1");`,
  });
  await page.login();
  return { hub, page };
}

async function makeTicket(hub, title, text) {
  const out = await cli(hub.port, ["--user", USER, "--repo", REPO, "ticket", "create", "--title", title], text);
  assert.equal(out.code, 0, out.stderr);
  return out.stdout.trim().split("\n")[0];
}

async function openTicket(page, id) {
  const since = page.frames.length;
  page.loads = (page.loads || 0) + 1;
  await page.session.send("Page.navigate", { url: `http://127.0.0.1:${page.port}/?load=${page.loads}#${REPO}/ticket/${encodeURIComponent(id)}` });
  await page.until(
    () => page.frames.slice(since).some((frame) => frame.dir === "in" && frame.data && frame.data.type === "file" && frame.data.path === `tickets/${id}.md`),
    `ticket ${id}`,
  );
  await page.until(() => page.eval(`(() => {
    const form = document.querySelector(".ticket-form");
    const hit = [...document.querySelectorAll("#editor .md-line")].some((line) => line.textContent.includes("row 00"));
    return !!form && !form.hidden && hit;
  })()`), "the ticket body");
  await page.quiet();
}

function place(page) {
  return page.eval(`(() => {
    const editor = document.getElementById("editor");
    const sel = window.getSelection();
    const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    let rect = null;
    if (range && range.getClientRects) {
      const rects = [...range.getClientRects()];
      rect = rects.find((item) => item.height > 0 || item.width > 0) || null;
    }
    if (!rect && range && range.getBoundingClientRect) {
      const box = range.getBoundingClientRect();
      if (box && (box.height > 0 || box.width > 0)) rect = box;
    }
    const mark = document.querySelector(".md-vim-block-mark");
    const markBox = mark ? mark.getBoundingClientRect() : null;
    let visual = markBox && markBox.height > 0
      ? { top: markBox.top, bottom: markBox.bottom, left: markBox.left, height: markBox.height, kind: "mark" }
      : (rect ? { top: rect.top, bottom: rect.bottom, left: rect.left, height: rect.height, kind: "caret" } : null);
    // A br has no client rect. The caret is the line that holds the selection.
    if (!visual && sel && sel.focusNode) {
      const node = sel.focusNode.nodeType === 1 ? sel.focusNode : sel.focusNode.parentElement;
      const line = node && node.closest ? node.closest(".md-line") : null;
      if (line) {
        const r = line.getBoundingClientRect();
        if (r.height > 0) visual = { top: r.top, bottom: r.bottom, left: r.left, height: r.height, kind: "line" };
      }
    }
    const lines = [...editor.querySelectorAll(".md-line")];
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
        height: r.height,
        start: Number(el.dataset.start),
        end: Number(el.dataset.end),
        text: el.textContent,
        gap: el.classList.contains("md-paragraph-gap"),
      };
    };
    const active = document.activeElement;
    return {
      visual,
      lines: lines.map(box),
      innerHeight: window.innerHeight,
      scrollY: window.scrollY,
      focused: active === editor || editor.contains(active),
      status: document.querySelector(".md-vim-status") ? document.querySelector(".md-vim-status").textContent : "",
    };
  })()`);
}

function lineAt(seen, offset) {
  return seen.lines.find((line) => !line.gap && offset >= line.start && offset <= line.end) || null;
}

function onLine(visual, line, label) {
  assert.ok(visual, `${label}: the caret is not drawn`);
  assert.ok(line, `${label}: the line is not drawn`);
  const mid = (visual.top + visual.bottom) / 2;
  assert.ok(
    mid >= line.top - 1 && mid <= line.bottom + 1,
    `${label}: caret at ${mid.toFixed(1)} is not on the line ${line.top.toFixed(1)}–${line.bottom.toFixed(1)} (${visual.kind})`,
  );
  assert.ok(
    visual.left >= line.left - 4 && visual.left <= line.right + 4,
    `${label}: caret x ${visual.left.toFixed(1)} is outside the line ${line.left.toFixed(1)}–${line.right.toFixed(1)}`,
  );
  assert.ok(
    visual.top >= -1 && visual.bottom <= line.innerHeight + 1,
    `${label}: caret is outside the window (caret ${visual.top.toFixed(1)}–${visual.bottom.toFixed(1)}, line ${line.top.toFixed(1)}–${line.bottom.toFixed(1)}, window ${line.innerHeight})`,
  );
}

test("G on a long ticket (ticket 3549946q)", async (t) => {
  const { hub, page } = await setup(t);
  const text = body();
  const id = await makeTicket(hub, "Long G", text);
  await openTicket(page, id);
  assert.equal(await page.eval(`localStorage.getItem(${JSON.stringify(VIM)})`), "1");
  assert.equal(await page.eval(`document.querySelector(".md-vim-status").textContent`), "N");
  const tall = await page.eval(`(() => {
    const line = [...document.querySelectorAll("#editor .md-line")].find((el) => el.textContent.includes("row 79"));
    const rect = line.getBoundingClientRect();
    return { bottom: rect.bottom, inner: window.innerHeight };
  })()`);
  assert.ok(tall.bottom > tall.inner, `the ticket fits in the window (${tall.bottom} <= ${tall.inner})`);

  assert.equal(await page.clickOffset(0), true, "no point on the first character");
  await page.quiet();
  assert.equal((await page.caret()).focus, 0);
  const rev = (await hub.show(`tickets/${id}.md`)).rev;

  await page.key("G");
  await page.quiet();
  const caret = await page.caret();
  const seen = await place(page);
  const last = [...seen.lines].reverse().find((line) => !line.gap && line.text.includes("row 79"));
  assert.ok(last, "row 79 is not drawn");
  last.innerHeight = seen.innerHeight;
  assert.equal(seen.status, "N");
  assert.equal(seen.focused, true, "the editor lost focus");
  assert.ok(caret.focus >= last.start && caret.focus <= last.end, `caret ${caret.focus} is not on the last line ${last.start}–${last.end}`);
  assert.equal(caret.anchor, caret.focus);
  onLine(seen.visual, last, "G");
  assert.equal((await hub.show(`tickets/${id}.md`)).rev, rev);

  await page.key("k");
  await page.quiet();
  const next = await page.caret();
  const after = await place(page);
  const landed = lineAt(after, next.focus);
  assert.ok(landed, `k landed at ${next.focus}, on no line`);
  landed.innerHeight = after.innerHeight;
  assert.equal(after.status, "N");
  assert.equal(after.focused, true, "the editor lost focus");
  assert.notEqual(next.focus, caret.focus, "k did not move");
  assert.equal(landed.text.includes("row 78"), true, `k landed on ${JSON.stringify(landed.text)}`);
  onLine(after.visual, landed, "k");
  assert.equal((await hub.show(`tickets/${id}.md`)).rev, rev);
});
