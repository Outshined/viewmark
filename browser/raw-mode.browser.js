import test from "node:test";
import assert from "node:assert/strict";
import { REPO, USER, cli, launchBrowser, Page, startHub } from "./harness.js";

function rgb(stroke) {
  const match = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(stroke || "");
  if (!match) return null;
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
}

async function pressed(page) {
  return page.eval(`document.querySelector("#editor button.md-view-toggle").getAttribute("aria-pressed")`);
}

async function clickRaw(page) {
  const point = await page.eval(`(() => {
    const button = document.querySelector("#editor button.md-view-toggle");
    const rect = button.getBoundingClientRect();
    return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
  })()`);
  await page.click(point.x, point.y);
  await page.quiet();
}

async function setRaw(page, on) {
  const now = await pressed(page);
  if ((now === "true") !== on) await clickRaw(page);
  assert.equal(await pressed(page), on ? "true" : "false");
}

function editsSince(page, since) {
  return page.frames.slice(since).filter((frame) => frame.dir === "out" && frame.data && (frame.data.type === "edit" || frame.data.type === "undo" || frame.data.type === "redo"));
}

async function openTicket(page, id) {
  const since = page.frames.length;
  page.loads = (page.loads || 0) + 1;
  await page.session.send("Page.navigate", { url: `http://127.0.0.1:${page.port}/?load=${page.loads}#${REPO}/ticket/${encodeURIComponent(id)}` });
  await page.until(() => page.frames.slice(since).some((frame) => frame.dir === "in" && frame.data && frame.data.type === "file" && frame.data.path === `tickets/${id}.md`), `ticket ${id}`);
  await page.quiet();
}

test("raw mode draws every byte and edits as plain text", async (t) => {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  const long = Array.from({ length: 80 }, (_, index) => `line ${index} iiiiiiiiii`).join("\n");
  await hub.create("a.md", "hello\n");
  await hub.create("b.md", "beta\n");
  await hub.create("mono.md", "iiiiiiiiii\nMMMMMMMMMM\n..........\n");
  await hub.create("wide.md", `${"M".repeat(500)}\n`);
  await hub.create("long.md", `${long}\n`);
  await hub.create("item.md", "- one");
  await hub.create("undo.md", "Z");
  const ticket = await cli(hub.port, ["--user", USER, "--repo", REPO, "ticket", "create", "--title", "Raw pane"], `${long}\n`);
  assert.equal(ticket.code, 0, ticket.stderr);
  const ticketId = ticket.stdout.trim();

  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.login();
  await page.open("a.md");

  // Open leaves the DOM selection empty. A click puts the caret on a byte, and the toggle keeps it.
  assert.equal(await page.clickOffset(2), true);
  await page.quiet();
  const beforeRev = (await hub.show("a.md")).rev;
  const placed = await page.caret();
  assert.equal(placed.focus, 2);
  assert.equal(placed.anchor, 2);
  const since = page.frames.length;
  assert.equal(await pressed(page), "false");
  await clickRaw(page);
  assert.equal(await pressed(page), "true");
  assert.equal(editsSince(page, since).length, 0);
  assert.equal((await hub.show("a.md")).rev, beforeRev);
  assert.equal((await hub.show("a.md")).text, "hello\n");
  const caret = await page.caret();
  assert.equal(caret.focus, placed.focus);
  assert.equal(caret.anchor, placed.anchor);
  assert.equal(await page.eval("document.activeElement === document.getElementById('editor')"), true);
  assert.equal(await page.eval("sessionStorage.getItem('viewmark.raw')"), "1");

  const rawSlash = await page.eval(`(() => {
    const button = document.querySelector("#editor button.md-view-toggle");
    const svg = button.querySelector("svg");
    const line = svg.querySelector("line");
    const strokes = [...svg.querySelectorAll("[stroke]")].map((node) => node.getAttribute("stroke"));
    return {
      viewBox: svg.getAttribute("viewBox"),
      hidden: svg.getAttribute("aria-hidden"),
      fill: svg.getAttribute("fill"),
      width: svg.getAttribute("stroke-width"),
      cap: svg.getAttribute("stroke-linecap"),
      join: svg.getAttribute("stroke-linejoin"),
      x1: line && line.getAttribute("x1"),
      y1: line && line.getAttribute("y1"),
      x2: line && line.getAttribute("x2"),
      y2: line && line.getAttribute("y2"),
      stroke: line ? getComputedStyle(line).stroke : "",
      strokes,
    };
  })()`);
  assert.equal(rawSlash.viewBox, "0 0 24 24");
  assert.equal(rawSlash.hidden, "true");
  assert.equal(rawSlash.fill, "none");
  assert.equal(rawSlash.width, "2");
  assert.equal(rawSlash.cap, "round");
  assert.equal(rawSlash.join, "round");
  assert.equal(rawSlash.x1, "3");
  assert.equal(rawSlash.y1, "21");
  assert.equal(rawSlash.x2, "21");
  assert.equal(rawSlash.y2, "3");
  const red = rgb(rawSlash.stroke);
  assert.ok(red && red.r >= 150 && red.g <= 100 && red.b <= 100, rawSlash.stroke);
  assert.deepEqual(rawSlash.strokes.filter((stroke) => stroke !== "currentColor"), ["rgb(220, 38, 38)"]);

  const gap = await page.eval(`(() => {
    const editor = document.getElementById("editor").getBoundingClientRect();
    const button = document.querySelector("#editor button.md-view-toggle").getBoundingClientRect();
    return { top: button.top - editor.top, right: editor.right - button.right };
  })()`);
  assert.ok(gap.top >= -1 && gap.top <= 16, `top ${gap.top}`);
  assert.ok(gap.right >= -1 && gap.right <= 16, `right ${gap.right}`);
  assert.equal(await page.eval(`(() => {
    const button = document.querySelector("#editor button.md-view-toggle").getBoundingClientRect();
    const root = document.getElementById("editor");
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement && node.parentElement.closest("button")) continue;
      for (let index = 0; index < node.length; index += 1) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        const rect = range.getClientRects()[0];
        if (!rect || rect.width < 0.5 || rect.height < 0.5) continue;
        if (rect.left < button.right - 0.5 && rect.right > button.left + 0.5 && rect.top < button.bottom - 0.5 && rect.bottom > button.top + 0.5) return node.data[index];
      }
    }
    return "";
  })()`), "");

  const at = caret.focus;
  const spot = caret.rect;
  await page.key("Q");
  await page.quiet();
  assert.equal((await hub.show("a.md")).text, "hello\n".slice(0, at) + "Q" + "hello\n".slice(at));
  const drawn = await page.eval(`window.__qaGlyph(${at})`);
  assert.ok(spot && drawn, "caret and glyph");
  assert.ok(Math.abs(drawn.left - spot.x) < 4, `glyph ${drawn.left} caret ${spot.x}`);
  assert.ok(Math.abs(drawn.top - spot.top) < 4, `glyph ${drawn.top} caret ${spot.top}`);

  await page.open("mono.md");
  await setRaw(page, true);
  const widths = await page.eval(`(() => {
    const width = (text) => {
      const node = [...document.querySelectorAll("#editor .md-source-line")].map((line) => [...line.childNodes].find((child) => child.nodeType === 3 && child.data === text)).find(Boolean);
      const range = document.createRange();
      range.selectNodeContents(node);
      return range.getBoundingClientRect().width;
    };
    const family = getComputedStyle(document.getElementById("editor")).fontFamily;
    return { i: width("iiiiiiiiii"), m: width("MMMMMMMMMM"), dot: width(".........."), family };
  })()`);
  assert.ok(Math.abs(widths.i - widths.m) < 0.5, `i ${widths.i} M ${widths.m}`);
  assert.ok(Math.abs(widths.i - widths.dot) < 0.5, `i ${widths.i} dot ${widths.dot}`);
  assert.match(widths.family, /monospace/);
  await setRaw(page, false);
  const proportional = await page.eval(`(() => {
    const width = (text) => {
      const node = [...document.querySelectorAll("#editor .md-line")].map((line) => {
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        for (let current = walker.nextNode(); current; current = walker.nextNode()) {
          if (current.data === text) return current;
        }
        return null;
      }).find(Boolean);
      const range = document.createRange();
      range.selectNodeContents(node);
      return range.getBoundingClientRect().width;
    };
    return { i: width("iiiiiiiiii"), m: width("MMMMMMMMMM"), family: getComputedStyle(document.getElementById("editor")).fontFamily };
  })()`);
  assert.ok(proportional.m - proportional.i > 1, `rendered i ${proportional.i} M ${proportional.m} ${proportional.family}`);
  assert.equal(/ui-monospace|SFMono-Regular/.test(proportional.family), false);

  await page.open("wide.md");
  await setRaw(page, true);
  const wrap = await page.eval(`(() => {
    const line = document.querySelector("#editor .md-source-line");
    const style = getComputedStyle(line);
    return {
      scrollX: window.scrollX,
      scrollLeft: document.getElementById("editor").scrollLeft,
      height: line.getBoundingClientRect().height,
      lineHeight: parseFloat(style.lineHeight),
    };
  })()`);
  assert.equal(wrap.scrollX, 0);
  assert.equal(wrap.scrollLeft, 0);
  assert.ok(wrap.height > wrap.lineHeight * 1.5, `height ${wrap.height} line ${wrap.lineHeight}`);

  await page.open("long.md");
  await setRaw(page, true);
  const corner = await page.eval(`(() => {
    const button = document.querySelector("#editor button.md-view-toggle").getBoundingClientRect();
    return { top: button.top, right: button.right };
  })()`);
  await page.eval("window.scrollTo(0, 600)");
  await page.frame();
  const stayed = await page.eval(`(() => {
    const editor = document.getElementById("editor").getBoundingClientRect();
    const button = document.querySelector("#editor button.md-view-toggle").getBoundingClientRect();
    return { top: button.top, right: button.right, editorTop: editor.top, editorRight: editor.right };
  })()`);
  assert.ok(Math.abs(stayed.top - corner.top) < 2, `button moved from ${corner.top} to ${stayed.top}`);
  assert.ok(Math.abs(stayed.right - corner.right) < 2, `button moved from ${corner.right} to ${stayed.right}`);
  assert.ok(stayed.top - Math.max(stayed.editorTop, 0) <= 16);
  assert.ok(stayed.editorRight - stayed.right <= 16);
  const target = await page.eval(`(() => {
    const lines = [...document.querySelectorAll("#editor .md-source-line")];
    const line = lines.find((el) => {
      const rect = el.getBoundingClientRect();
      return rect.top > 40 && rect.bottom < 860 && Number(el.dataset.end) > Number(el.dataset.start);
    });
    return line ? Number(line.dataset.start) + 1 : null;
  })()`);
  assert.equal(typeof target, "number");
  assert.equal(await page.clickOffset(target), true);
  await page.quiet();
  const low = await page.caret();
  assert.equal(low.focus, target);
  await clickRaw(page);
  await clickRaw(page);
  const back = await page.caret();
  assert.equal(back.focus, low.focus);
  assert.equal(back.anchor, low.anchor);
  assert.ok(back.rect && back.rect.top >= 0 && back.rect.bottom <= 900, `caret top ${back.rect && back.rect.top}`);

  await page.open("item.md");
  await setRaw(page, true);
  assert.equal(await page.clickOffset(5), true);
  await page.quiet();
  assert.equal((await page.caret()).focus, 5);
  await page.key("Enter");
  await page.quiet();
  assert.equal((await hub.show("item.md")).text, "- one\n");

  await page.open("undo.md");
  await setRaw(page, false);
  assert.equal(await page.clickOffset(1), true);
  await page.quiet();
  await page.key("a");
  await page.quiet();
  assert.equal((await hub.show("undo.md")).text, "Za");
  await setRaw(page, true);
  await page.key("b");
  await page.quiet();
  assert.equal((await hub.show("undo.md")).text, "Zab");
  await page.key("z", ["Ctrl"]);
  await page.quiet();
  await page.key("z", ["Ctrl"]);
  await page.quiet();
  assert.equal((await hub.show("undo.md")).text, "Z");

  await page.open("b.md");
  assert.equal(await pressed(page), "true");
  assert.equal(await page.eval("document.getElementById('editor').classList.contains('md-source')"), true);
  assert.equal(await page.eval("window.__qaDrawn().text.includes('beta')"), true);
  const reloaded = page.frames.length;
  await page.session.send("Page.reload");
  await page.until(() => page.frames.slice(reloaded).some((frame) => frame.dir === "in" && frame.data && frame.data.type === "file"), "reload");
  await page.quiet();
  assert.equal(await pressed(page), "true");
  assert.equal(await page.eval("sessionStorage.getItem('viewmark.raw')"), "1");

  await openTicket(page, ticketId);
  assert.equal(await page.eval("document.querySelector('.ticket-form:not([hidden])') != null"), true);
  const ticketGap = await page.eval(`(() => {
    const editor = document.getElementById("editor").getBoundingClientRect();
    const button = document.querySelector("#editor button.md-view-toggle").getBoundingClientRect();
    return { top: button.top - editor.top, right: editor.right - button.right, count: document.querySelectorAll("#editor button.md-view-toggle").length };
  })()`);
  assert.equal(ticketGap.count, 1);
  assert.ok(ticketGap.top >= -1 && ticketGap.top <= 16, `ticket top ${ticketGap.top}`);
  assert.ok(ticketGap.right >= -1 && ticketGap.right <= 16, `ticket right ${ticketGap.right}`);
  await page.eval("document.getElementById('editor').scrollTop = 240");
  await page.frame();
  const ticketStayed = await page.eval(`(() => {
    const editor = document.getElementById("editor").getBoundingClientRect();
    const button = document.querySelector("#editor button.md-view-toggle").getBoundingClientRect();
    return { top: button.top - editor.top, right: editor.right - button.right, scroll: document.getElementById("editor").scrollTop };
  })()`);
  assert.ok(ticketStayed.scroll > 0, "ticket text did not scroll");
  assert.ok(ticketStayed.top >= -1 && ticketStayed.top <= 16, `scrolled top ${ticketStayed.top}`);
  assert.ok(ticketStayed.right >= -1 && ticketStayed.right <= 16, `scrolled right ${ticketStayed.right}`);

  await setRaw(page, false);
  const renderedSlash = await page.eval(`document.querySelector("#editor button.md-view-toggle line")`);
  assert.equal(renderedSlash, null);

  const { session } = await browser.newSession();
  const other = new Page(session, hub.port);
  await other.init();
  await other.login();
  await other.open("b.md");
  assert.equal(await pressed(other), "false");
  assert.equal(await pressed(page), "false");
  await setRaw(other, true);
  assert.equal(await pressed(other), "true");
  assert.equal(await pressed(page), "false");
});
