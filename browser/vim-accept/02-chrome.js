import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "../harness.js";

// The flag is read once, when the editor is created. A later write does not turn keys on.
const FILE = "a.md";
const BODY = "alpha\n\nbeta\n";
const VIM = "viewmark.vim";
const FILL = Array.from({ length: 60 }, (_, i) => `filler ${i + 1}\n\n`).join("");

// ‸ is the focus and « is the anchor. Neither mark is a stored byte.
function stored(text) {
  return text.replaceAll("‸", "").replaceAll("«", "");
}

function armVim(page) {
  return page.session.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `localStorage.setItem(${JSON.stringify(VIM)}, "1");`,
  });
}

async function setup(t, { vim = true, body = BODY } = {}) {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  await hub.create(FILE, stored(body));
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  if (vim) await armVim(page);
  await page.login();
  await page.open(FILE);
  return { hub, page };
}

async function place(page, offset) {
  assert.ok(await page.clickOffset(offset), `no point at offset ${offset}`);
  await page.quiet();
}

async function press(page, key, modifiers = []) {
  await page.key(key, modifiers);
  await page.quiet();
}

async function clickSelector(page, selector) {
  const point = await page.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0) || !(r.height > 0)) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  assert.ok(point, `no box for ${selector}`);
  await page.click(point.x, point.y);
  await page.quiet();
}

const STATUS = `(() => {
  const nodes = [...document.querySelectorAll("span.md-vim-status")];
  const node = nodes[0] || null;
  return {
    count: nodes.length,
    text: node ? node.textContent : "",
    contenteditable: node ? node.getAttribute("contenteditable") : null,
    role: node ? node.getAttribute("role") : null,
    live: node ? node.getAttribute("aria-live") : null,
    svgs: node ? node.querySelectorAll("svg").length : 0,
  };
})()`;

function assertStatus(probe, text) {
  assert.equal(probe.count, 1, JSON.stringify(probe));
  assert.equal(probe.text, text, JSON.stringify(probe));
  assert.equal(probe.contenteditable, "false");
  assert.equal(probe.role, "status");
  assert.equal(probe.live, "polite");
  assert.equal(probe.svgs, 0);
}

const MENU_OPEN = `(() => {
  const el = document.querySelector(".md-doc-menu-panel");
  return !!el && !el.hidden && el.getClientRects().length > 0;
})()`;

async function openMenu(page) {
  if (await page.eval(MENU_OPEN)) return;
  await clickSelector(page, "button.md-doc-menu");
  await page.until(() => page.eval(MENU_OPEN), "document menu");
}

function wholeDiff(before, after) {
  const lines = (text) => {
    const parts = text.split("\n");
    const last = parts.pop();
    return { parts: text.endsWith("\n") ? parts : [...parts, last], newline: text.endsWith("\n") };
  };
  const a = lines(before);
  const b = lines(after);
  const out = ["--- a", "+++ b", `@@ -1,${a.parts.length} +1,${b.parts.length} @@`];
  for (const line of a.parts) out.push(`-${line}`);
  if (!a.newline) out.push("\\ No newline at end of file");
  for (const line of b.parts) out.push(`+${line}`);
  if (!b.newline) out.push("\\ No newline at end of file");
  return `${out.join("\n")}\n`;
}

const CORNER = `(() => {
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      left: r.left,
      width: r.width,
      height: r.height,
      position: getComputedStyle(el).position,
    };
  };
  const editor = document.getElementById("editor").getBoundingClientRect();
  return {
    count: document.querySelectorAll("span.md-vim-status").length,
    status: box("span.md-vim-status"),
    eye: box("#editor button.md-view-toggle"),
    menu: box("button.md-doc-menu"),
    width: innerWidth,
    height: innerHeight,
    paneTop: Math.max(0, editor.top),
    paneRight: Math.min(innerWidth, editor.right),
  };
})()`;

function assertCorner(label, row) {
  assert.equal(row.count, 1, label);
  for (const name of ["status", "eye", "menu"]) {
    const box = row[name];
    assert.ok(box, `${label}: no ${name}`);
    assert.equal(box.position, "fixed", `${label}: ${name} is ${box.position}`);
    assert.ok(box.width > 0 && box.height > 0, `${label}: ${name} has no box`);
    assert.ok(box.top >= -1 && box.left >= -1, `${label}: ${name} starts outside the viewport ${JSON.stringify(box)}`);
    assert.ok(box.bottom <= row.height + 1 && box.right <= row.width + 1, `${label}: ${name} ends outside the viewport ${JSON.stringify(box)}`);
  }
  assert.ok(Math.abs(row.status.top - row.eye.top) <= 2, `${label}: status top ${row.status.top} eye top ${row.eye.top}`);
  assert.ok(Math.abs(row.status.top - row.menu.top) <= 2, `${label}: status top ${row.status.top} menu top ${row.menu.top}`);
  assert.ok(row.eye.top - row.paneTop <= 16 && row.eye.top >= row.paneTop - 1, `${label}: eye is not in the corner row`);
  assert.ok(row.paneRight - row.eye.right <= 16 && row.eye.right <= row.paneRight + 1, `${label}: eye is not at the pane's right`);
  assert.ok(row.status.right <= row.menu.left + 2, `${label}: status is not in the row with the menu`);
  assert.ok(row.menu.right <= row.eye.left + 2, `${label}: menu is not in the row with the eye`);
}

test("VC.1 (ticket 7vdep2z4)", async (t) => {
  const { page } = await setup(t, { vim: false });
  const read = () => page.eval(`(() => {
    const panel = document.querySelector(".md-doc-menu-panel");
    const boxes = panel ? [...panel.querySelectorAll("[role='menuitemcheckbox']")] : [];
    const named = panel ? [...panel.querySelectorAll("button")].filter((button) => button.textContent === "Vim keys") : [];
    const item = named[0] || null;
    return {
      open: !!panel && !panel.hidden && panel.getClientRects().length > 0,
      boxes: boxes.length,
      named: named.length,
      text: item ? item.textContent : null,
      role: item ? item.getAttribute("role") : null,
      checked: item ? item.getAttribute("aria-checked") : null,
      svgs: item ? item.querySelectorAll("svg").length : null,
      flag: localStorage.getItem(${JSON.stringify(VIM)}),
    };
  })()`);
  await openMenu(page);
  const off = await read();
  assert.equal(off.open, true);
  assert.equal(off.flag, null);
  assert.equal(off.named, 1, JSON.stringify(off));
  assert.equal(off.boxes, 1, JSON.stringify(off));
  assert.equal(off.text, "Vim keys");
  assert.equal(off.role, "menuitemcheckbox");
  assert.equal(off.checked, "false");
  assert.equal(off.svgs, 0);

  await armVim(page);
  await page.open(FILE);
  await openMenu(page);
  const on = await read();
  assert.equal(on.open, true);
  assert.equal(on.flag, "1");
  assert.equal(on.named, 1, JSON.stringify(on));
  assert.equal(on.boxes, 1, JSON.stringify(on));
  assert.equal(on.text, "Vim keys");
  assert.equal(on.role, "menuitemcheckbox");
  assert.equal(on.checked, "true");
  assert.equal(on.svgs, 0);
});

test("VC.2 (ticket 7vdep2z4)", async (t) => {
  const { page } = await setup(t);
  const laid = await page.eval(`(() => {
    const root = document.getElementById("editor");
    const statuses = [...root.querySelectorAll("span.md-vim-status")];
    const status = statuses[0] || null;
    const kids = [...root.childNodes];
    const lines = [...root.querySelectorAll(":scope > .md-line")];
    return {
      count: statuses.length,
      pageCount: document.querySelectorAll("span.md-vim-status").length,
      text: status ? status.textContent : null,
      contenteditable: status ? status.getAttribute("contenteditable") : null,
      role: status ? status.getAttribute("role") : null,
      live: status ? status.getAttribute("aria-live") : null,
      svgs: status ? status.querySelectorAll("svg").length : null,
      nodeTypes: status ? [...status.childNodes].map((node) => node.nodeType) : [],
      statusIndex: status ? kids.indexOf(status) : -1,
      lineIndices: lines.map((line) => kids.indexOf(line)),
      classes: kids.map((node) => (node.nodeType === 1 ? node.className : "#" + node.nodeType)),
    };
  })()`);
  assert.equal(laid.count, 1, JSON.stringify(laid));
  assert.equal(laid.pageCount, 1);
  assert.equal(laid.text, "N");
  assert.deepEqual(laid.nodeTypes, [3], JSON.stringify(laid));
  assert.equal(laid.contenteditable, "false");
  assert.equal(laid.role, "status");
  assert.equal(laid.live, "polite");
  assert.equal(laid.svgs, 0);
  assert.ok(laid.lineIndices.length > 0, JSON.stringify(laid.classes));
  assert.deepEqual(laid.lineIndices, laid.lineIndices.map((_, index) => index), laid.classes.join(" | "));
  assert.ok(laid.statusIndex > laid.lineIndices[laid.lineIndices.length - 1], laid.classes.join(" | "));
});

test("VC.3 (ticket 7vdep2z4)", async (t) => {
  const { page } = await setup(t);
  await place(page, 0);
  assertStatus(await page.eval(STATUS), "N");
  await press(page, "i");
  assertStatus(await page.eval(STATUS), "I");
  await press(page, "Escape");
  assertStatus(await page.eval(STATUS), "N");
  await press(page, "v");
  assertStatus(await page.eval(STATUS), "V");
  await press(page, "Escape");
  assertStatus(await page.eval(STATUS), "N");
  await press(page, "V");
  assertStatus(await page.eval(STATUS), "VL");
});

test("VC.4 (ticket 7vdep2z4)", async (t) => {
  const { page } = await setup(t);
  await place(page, 0);
  await press(page, "3");
  assert.equal((await page.eval(STATUS)).text, "3");
  await press(page, "d");
  assert.equal((await page.eval(STATUS)).text, "3d");
  await press(page, "2");
  assert.equal((await page.eval(STATUS)).text, "3d2");
  await press(page, "Escape");
  assert.equal((await page.eval(STATUS)).text, "N");

  await press(page, "f");
  assert.equal((await page.eval(STATUS)).text, "f");
  await press(page, "Escape");
  assert.equal((await page.eval(STATUS)).text, "N");

  await press(page, "g");
  assert.equal((await page.eval(STATUS)).text, "g");
  await press(page, "Escape");
  assert.equal((await page.eval(STATUS)).text, "N");

  await press(page, "d");
  assert.equal((await page.eval(STATUS)).text, "d");
  await press(page, "i");
  assert.equal((await page.eval(STATUS)).text, "di");
});

test("VC.5 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t);
  const opened = await hub.show(FILE);
  const beta = opened.text.indexOf("beta");
  // The caret starts on beta. Appending T joins that paragraph, so the later click
  // has to be the other block or the agent's edit is held.
  await place(page, beta);
  assertStatus(await page.eval(STATUS), "N");
  await press(page, "Escape");
  assertStatus(await page.eval(STATUS), "N");

  assert.equal(await page.eval(`document.getElementById("editor").classList.contains("md-source")`), false);
  await clickSelector(page, "#editor button.md-view-toggle");
  assert.equal(await page.eval(`document.getElementById("editor").classList.contains("md-source")`), true);
  assertStatus(await page.eval(STATUS), "N");
  await clickSelector(page, "#editor button.md-view-toggle");
  assert.equal(await page.eval(`document.getElementById("editor").classList.contains("md-source")`), false);
  assertStatus(await page.eval(STATUS), "N");

  await place(page, 0);
  const caret = await page.caret();
  assert.equal(caret.focus, 0, `caret ${caret.focus} is not on the other block`);
  assertStatus(await page.eval(STATUS), "N");

  const before = await hub.show(FILE);
  const since = page.frames.length;
  const edited = await hub.edit(FILE, wholeDiff(before.text, before.text + "T"));
  assert.equal(edited.code, 0, `${edited.stderr}${edited.stdout}`);
  await page.until(
    () => page.frames.slice(since).some((frame) => frame.dir === "in" && frame.data && frame.data.type === "doc" && typeof frame.data.text === "string" && frame.data.text.includes("T")),
    "agent append",
  );
  await page.quiet();
  const after = await hub.show(FILE);
  assert.notEqual(after.text, before.text);
  assert.equal(after.text.includes("T"), true, after.text);
  assertStatus(await page.eval(STATUS), "N");
});

test("VC.6 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t);
  await place(page, 0);
  const before = await hub.show(FILE);
  const caret = await page.caret();
  const point = await page.eval(`(() => {
    const el = document.querySelector("span.md-vim-status");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, onStatus: !!hit && (hit === el || el.contains(hit)) };
  })()`);
  assert.ok(point && point.onStatus, "the press misses the status");
  await page.click(point.x, point.y);
  await page.quiet();
  const after = await hub.show(FILE);
  const next = await page.caret();
  const focus = await page.eval(`(() => {
    const editor = document.getElementById("editor");
    const active = document.activeElement;
    return { inEditor: active === editor || editor.contains(active), active: active ? (active.id || active.className || active.tagName) : null };
  })()`);
  assert.equal(after.text, before.text);
  assert.equal(after.rev, before.rev);
  assert.equal(next.focus, caret.focus, JSON.stringify(next));
  assert.equal(next.anchor, caret.anchor, JSON.stringify(next));
  assert.equal(focus.inEditor, true, focus.active);
});

test("VC.7 (ticket 7vdep2z4)", async (t) => {
  const { page } = await setup(t, { body: FILL });
  await page.until(
    () => page.eval(`[...document.querySelectorAll("#editor .md-line")].some((line) => line.textContent.trim() === "filler 60")`),
    "FILL drawn",
  );
  assertCorner("at rest", await page.eval(CORNER));
  await page.eval(`(() => {
    const line = [...document.querySelectorAll("#editor .md-line")].find((el) => el.textContent.trim() === "filler 60");
    line.scrollIntoView({ block: "end" });
    scrollTo(0, document.scrollingElement.scrollHeight);
    return true;
  })()`);
  await page.frame();
  const placed = await page.eval(`(() => {
    const box = (text) => {
      const line = [...document.querySelectorAll("#editor .md-line")].find((el) => el.textContent.trim() === text);
      if (!line) return null;
      const r = line.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    };
    return { first: box("filler 1"), last: box("filler 60"), height: innerHeight, scrollY };
  })()`);
  assert.ok(placed.first && placed.first.bottom < 0, `filler 1 did not scroll off: ${JSON.stringify(placed)}`);
  assert.ok(placed.last && placed.last.top < placed.height && placed.last.bottom > 0, `filler 60 is not in view: ${JSON.stringify(placed)}`);
  assertCorner("while FILL is scrolled", await page.eval(CORNER));
});

test("VC.8 (ticket 7vdep2z4)", async (t) => {
  const { page } = await setup(t, { vim: false });
  assert.equal(await page.eval(`localStorage.getItem(${JSON.stringify(VIM)})`), null);
  assert.equal(await page.eval(`document.querySelectorAll("span.md-vim-status").length`), 0);
});

const PROMPT = `(() => {
  const inputs = [...document.querySelectorAll("input.md-vim-line")];
  const input = inputs[0] || null;
  const editor = document.getElementById("editor");
  const status = document.querySelector("span.md-vim-status");
  const rect = input ? input.getBoundingClientRect() : null;
  const statusRect = status ? status.getBoundingClientRect() : null;
  const active = document.activeElement;
  return {
    count: inputs.length,
    parent: input && input.parentElement ? input.parentElement.tagName : null,
    inEditor: input ? editor.contains(input) : null,
    focused: input ? active === input : false,
    value: input ? input.value : null,
    rects: input ? input.getClientRects().length : 0,
    top: rect && rect.top,
    height: rect && rect.height,
    statusBottom: statusRect && statusRect.bottom,
    statusHeight: statusRect && statusRect.height,
    active: active ? (active.id || active.className || active.tagName) : null,
  };
})()`;

function assertPrompt(info, mark) {
  assert.equal(info.count, 1, JSON.stringify(info));
  assert.equal(info.parent, "BODY");
  assert.equal(info.inEditor, false);
  assert.equal(info.focused, true, info.active);
  assert.equal(info.value, mark);
  assert.equal(info.rects, 1, JSON.stringify(info));
  assert.ok(info.height > 0 && Math.abs(info.height - info.statusHeight) <= 8, `row ${info.height} status ${info.statusHeight}`);
  assert.ok(info.top + 2 >= info.statusBottom, `input top ${info.top} is not under the status ending at ${info.statusBottom}`);
  assert.ok(info.top - info.statusBottom <= 8, `input top ${info.top} status bottom ${info.statusBottom}`);
}

async function assertEditorFocus(page) {
  const left = await page.eval(`(() => {
    const editor = document.getElementById("editor");
    const active = document.activeElement;
    return {
      count: document.querySelectorAll("input.md-vim-line").length,
      focus: active === editor,
      active: active ? (active.id || active.className || active.tagName) : null,
    };
  })()`);
  assert.equal(left.count, 0, JSON.stringify(left));
  assert.equal(left.focus, true, left.active);
}

test("VC.9 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t);
  await place(page, 0);
  const before = await hub.show(FILE);

  await press(page, "/");
  assertPrompt(await page.eval(PROMPT), "/");
  await press(page, "z");
  const slash = await page.eval(PROMPT);
  assert.equal(slash.value, "/z");
  let shown = await hub.show(FILE);
  assert.equal(shown.text, before.text);
  assert.equal(shown.rev, before.rev);
  await press(page, "Escape");
  await assertEditorFocus(page);
  shown = await hub.show(FILE);
  assert.equal(shown.text, before.text);
  assert.equal(shown.rev, before.rev);

  await press(page, ":");
  assertPrompt(await page.eval(PROMPT), ":");
  await press(page, "z");
  const colon = await page.eval(PROMPT);
  assert.equal(colon.value, ":z");
  shown = await hub.show(FILE);
  assert.equal(shown.text, before.text);
  assert.equal(shown.rev, before.rev);
  await press(page, "Backspace");
  shown = await hub.show(FILE);
  assert.equal(shown.text, before.text);
  assert.equal(shown.rev, before.rev);
  await press(page, "Enter");
  await assertEditorFocus(page);
  shown = await hub.show(FILE);
  assert.equal(shown.text, before.text);
  assert.equal(shown.rev, before.rev);
});

test("VC.10 (ticket 7vdep2z4)", async (t) => {
  const { page } = await setup(t);
  await place(page, 0);
  const block = () => page.eval(`document.getElementById("editor").classList.contains("md-vim-block")`);
  assert.equal(await block(), true);
  await press(page, "i");
  assert.equal(await block(), false);
  await press(page, "Escape");
  assert.equal(await block(), true);
});
