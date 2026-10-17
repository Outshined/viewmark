import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { REPO, USER, cli, launchBrowser, Page, startHub } from "./harness.js";

// Ticket 4rvskcb7. With vim keys on, after G in a document or a ticket taller than
// the window, i, a, o, and A each take every typed letter, and the page stays with
// the caret. The same holds after G and dd.

const VIM = "viewmark.vim";

function paragraphs(n) {
  const lines = [];
  for (let i = 0; i < n; i += 1) lines.push(`Paragraph ${String(i).padStart(2, "0")} stays on its own row.`);
  return `${lines.join("\n\n")}\n`;
}

function fenced(n) {
  const note = "```comment c9 resolved\n:: 0\n@2026-10-05T16:00:00.000Z qa\nNote.\n```\n";
  return `${paragraphs(n)}\`\`\`\ncode\n\`\`\`\n\n${note}`;
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

async function openHash(page, hash, needle) {
  const since = page.frames.length;
  page.loads = (page.loads || 0) + 1;
  await page.session.send("Page.navigate", { url: `http://127.0.0.1:${page.port}/?load=${page.loads}#${hash}` });
  await page.until(
    () => page.frames.slice(since).some((frame) => frame.dir === "in" && frame.data && frame.data.type === "file"),
    `file for ${hash}`,
  );
  await page.until(() => page.eval(`[...document.querySelectorAll("#editor .md-line")].some((line) => line.textContent.includes(${JSON.stringify(needle)}))`), needle);
  await page.quiet();
}

async function armScroll(page) {
  await page.eval(`(() => {
    window.__scrollMin = window.scrollY;
    window.__scrollMax = window.scrollY;
    if (!window.__scrollWatch) {
      window.__scrollWatch = true;
      addEventListener("scroll", () => {
        window.__scrollMin = Math.min(window.__scrollMin, window.scrollY);
        window.__scrollMax = Math.max(window.__scrollMax, window.scrollY);
      }, true);
    }
    return true;
  })()`);
}

function view(page) {
  return page.eval(`(() => {
    const editor = document.getElementById("editor");
    const sel = getSelection();
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
    // A br has no client rect. The caret is the line that holds the selection.
    let line = null;
    if (!rect && sel && sel.focusNode) {
      const node = sel.focusNode.nodeType === 1 ? sel.focusNode : sel.focusNode.parentElement;
      line = node && node.closest ? node.closest(".md-line") : null;
    }
    const lineBox = line ? line.getBoundingClientRect() : null;
    const active = document.activeElement;
    return {
      scrollY: window.scrollY,
      scrollMin: window.__scrollMin,
      innerHeight: window.innerHeight,
      top: rect ? rect.top : (lineBox && lineBox.height > 0 ? lineBox.top : null),
      bottom: rect ? rect.bottom : (lineBox && lineBox.height > 0 ? lineBox.bottom : null),
      focused: !!(editor && (active === editor || editor.contains(active))),
      visible: editor ? editor.innerText : "",
    };
  })()`);
}

async function keys(page, list) {
  for (const key of list) {
    await page.key(key);
    await sleep(150);
  }
  await page.quiet();
}

function caretInView(seen, label) {
  assert.equal(seen.focused, true, `${label} editor lost focus`);
  assert.ok(seen.top != null && seen.bottom != null, `${label} caret has no line`);
  assert.ok(seen.top >= -1, `${label} caret top ${seen.top}`);
  assert.ok(seen.bottom <= seen.innerHeight + 1, `${label} caret bottom ${seen.bottom} window ${seen.innerHeight}`);
}

function wroteHello(text, label, word) {
  const body = String(text);
  assert.ok(body.includes(word), `${label} missing ${word} head ${JSON.stringify(body.slice(0, 100))} tail ${JSON.stringify(body.slice(-160))}`);
  assert.ok(body.slice(-500).includes(word), `${label} tail ${JSON.stringify(body.slice(-160))}`);
}

// The last letter can land after quiet returns.
async function waitStored(hub, file, label, word) {
  let stored = await hub.show(file);
  const started = Date.now();
  while (!String(stored.text).slice(-500).includes(word) && Date.now() - started < 2000) {
    await sleep(50);
    stored = await hub.show(file);
  }
  wroteHello(stored.text, label, word);
}

async function waitHello(page, label, word) {
  let seen = await view(page);
  const started = Date.now();
  while (!seen.visible.slice(-500).includes(word) && Date.now() - started < 1500) {
    await sleep(50);
    seen = await view(page);
  }
  wroteHello(seen.visible, label, word);
  assert.ok(seen.scrollMin > 100, `${label} scrolled to ${seen.scrollMin}`);
  return seen;
}

test("4rvskcb7 G then type keeps every letter beside the caret", { timeout: 180000 }, async (t) => {
  const { hub, page } = await setup(t);
  const long = paragraphs(50);
  const docPath = await hub.create("long.md", long);
  const ticket = await makeTicket(hub, "Long", long);
  const fenceDoc = await hub.create("fenced.md", fenced(40));
  const fenceTicket = await makeTicket(hub, "Fenced", fenced(40));
  const targets = [
    { hash: `${REPO}/doc/${docPath}`, file: docPath, needle: "Paragraph 00", label: "document" },
    { hash: `${REPO}/ticket/${ticket}`, file: `tickets/${ticket}.md`, needle: "Paragraph 00", label: "ticket" },
  ];
  const words = { i: "oneii", a: "oneaa", o: "oneoo", A: "onebb" };
  for (const target of targets) {
    for (const entry of ["i", "a", "o", "A"]) {
      const word = words[entry];
      const label = `${target.label} ${entry}`;
      await openHash(page, target.hash, target.needle);
      assert.equal(await page.clickOffset(0), true, label);
      await page.quiet();
      await page.key("G");
      await page.quiet();
      const landed = await view(page);
      const at = await page.caret();
      assert.ok(landed.scrollY > 200, `${label} G scroll ${landed.scrollY}`);
      assert.ok(at.focus > 200, `${label} G caret ${at.focus}`);
      caretInView(landed, `${label} after G`);
      assert.ok(landed.top > landed.innerHeight * 0.4, `${label} G caret top ${landed.top}`);
      await armScroll(page);
      await keys(page, [entry, ...word]);
      const after = await view(page);
      const typed = await page.caret();
      caretInView(after, label);
      assert.ok(typed.focus > 200, `${label} caret ${typed.focus}`);
      assert.ok(after.scrollMin > 100, `${label} scrolled to ${after.scrollMin}`);
      await waitStored(hub, target.file, `${label} stored`, word);
      const painted = await waitHello(page, `${label} visible`, word);
      caretInView(painted, `${label} painted`);
    }
  }
  const fencedTargets = [
    { hash: `${REPO}/doc/${fenceDoc}`, file: fenceDoc, label: "document dd" },
    { hash: `${REPO}/ticket/${fenceTicket}`, file: `tickets/${fenceTicket}.md`, label: "ticket dd" },
  ];
  for (const target of fencedTargets) {
    await openHash(page, target.hash, "Paragraph 00");
    assert.equal(await page.clickOffset(0), true, target.label);
    await page.quiet();
    await page.key("G");
    await page.quiet();
    await page.key("d");
    await page.key("d");
    await page.quiet();
    const cut = await page.caret();
    const seen = await view(page);
    assert.notEqual(cut.focus, 0, `${target.label} caret ${cut.focus}`);
    caretInView(seen, target.label);
    await armScroll(page);
    await keys(page, ["i", "h", "e", "l", "l", "o"]);
    const after = await view(page);
    const typed = await page.caret();
    caretInView(after, `${target.label} typed`);
    assert.ok(typed.focus > 200, `${target.label} caret ${typed.focus}`);
    assert.ok(after.scrollMin > 100, `${target.label} scrolled to ${after.scrollMin}`);
    await waitStored(hub, target.file, `${target.label} stored`, "hello");
    const painted = await waitHello(page, `${target.label} visible`, "hello");
    caretInView(painted, `${target.label} painted`);
  }
});
