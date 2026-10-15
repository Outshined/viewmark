import test from "node:test";
import assert from "node:assert/strict";
import { BROWSER, launchBrowser, Page, startHub } from "../harness.js";

// Chord cells. A caret mark or an anchor mark is not part of the stored bytes.
const FILE = "a.md";
const VIM = "viewmark.vim";

async function setup(t, body, { vim = true, clipboard = false } = {}) {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  await hub.create(FILE, body);
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  if (vim) {
    // The flag is read when the editor is created. The next documents see it.
    await page.session.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `localStorage.setItem(${JSON.stringify(VIM)}, "1");`,
    });
  }
  await page.login();
  if (clipboard) {
    await page.session.send("Browser.grantPermissions", {
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
      origin: `http://127.0.0.1:${hub.port}`,
    });
  }
  await page.open(FILE);
  return { hub, page };
}

async function place(page, offset) {
  assert.equal(await page.clickOffset(offset), true, `no glyph at ${offset}`);
  await page.quiet();
  const caret = await page.caret();
  assert.equal(caret.focus, offset, `click ${offset} landed at ${caret.focus}`);
  assert.equal(caret.anchor, offset, `click ${offset} anchor ${caret.anchor}`);
  return caret;
}

function status(page) {
  return page.eval(`(() => {
    const el = document.querySelector("span.md-vim-status");
    return el ? el.textContent : "";
  })()`);
}

async function snap(hub, page) {
  await page.quiet();
  const shown = await hub.show(FILE);
  const caret = await page.caret();
  return {
    text: shown.text,
    rev: shown.rev,
    focus: caret.focus,
    anchor: caret.anchor,
    status: await status(page),
  };
}

function ends(shot) {
  return [shot.anchor, shot.focus].sort((a, b) => a - b);
}

async function expectShot(shot, label, { text, focus, anchor, rev, status: mode, collapsed }) {
  if (text != null) assert.equal(shot.text, text, `${label} got ${JSON.stringify(shot.text)}`);
  if (rev != null) assert.equal(shot.rev, rev, `${label} rev ${shot.rev} got ${JSON.stringify(shot.text)}`);
  if (focus != null) assert.equal(shot.focus, focus, `${label} focus ${shot.focus} anchor ${shot.anchor} got ${JSON.stringify(shot.text)}`);
  if (anchor != null) assert.equal(shot.anchor, anchor, `${label} anchor ${shot.anchor} focus ${shot.focus} got ${JSON.stringify(shot.text)}`);
  if (collapsed) assert.equal(shot.anchor, shot.focus, `${label} selection ${shot.anchor}:${shot.focus} got ${JSON.stringify(shot.text)}`);
  if (mode != null) assert.equal(shot.status, mode, `${label} status ${JSON.stringify(shot.status)} got ${JSON.stringify(shot.text)}`);
}

async function armKeys(page) {
  await page.eval(`(() => {
    if (window.__vkArm) return true;
    window.__vkArm = true;
    window.__vkKeys = [];
    document.addEventListener("keydown", (event) => {
      window.__vkKeys.push({
        key: event.key,
        ctrl: event.ctrlKey === true,
        meta: event.metaKey === true,
        shift: event.shiftKey === true,
        prevented: event.defaultPrevented === true,
      });
    });
    return true;
  })()`);
}

function takeKeys(page) {
  return page.eval(`(() => { const keys = window.__vkKeys || []; window.__vkKeys = []; return keys; })()`);
}

async function readClipboard(page) {
  const out = await page.session.send("Runtime.evaluate", {
    expression: "navigator.clipboard.readText()",
    awaitPromise: true,
    userGesture: true,
    returnByValue: true,
  });
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.text || "clipboard read failed");
  return out.result.value;
}

async function writeClipboard(page, text) {
  const out = await page.session.send("Runtime.evaluate", {
    expression: `navigator.clipboard.writeText(${JSON.stringify(text)})`,
    awaitPromise: true,
    userGesture: true,
    returnByValue: true,
  });
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.text || "clipboard write failed");
}

function sliceOf(text, shot) {
  const [from, to] = ends(shot);
  return text.slice(from, to);
}

async function normal(page) {
  await page.key("Escape");
  await page.quiet();
}

test("VK.9 (ticket 7vdep2z4)", { timeout: 180000 }, async (t) => {
  const body = "alpha beta\n";
  const { hub, page } = await setup(t, body);
  await place(page, 2);
  let before = await snap(hub, page);
  assert.equal(before.status, "N");

  await page.key("→", ["Ctrl"]);
  let shot = await snap(hub, page);
  expectShot(shot, "VK.9 Ctrl+Right", { text: body, focus: 6, anchor: 6, rev: before.rev, status: "N", collapsed: true });

  await place(page, 2);
  await page.key("w");
  shot = await snap(hub, page);
  expectShot(shot, "VK.9 w", { text: body, focus: 6, anchor: 6, rev: before.rev, status: "N", collapsed: true });

  await place(page, 2);
  await page.key("←", ["Ctrl"]);
  shot = await snap(hub, page);
  expectShot(shot, "VK.9 Ctrl+Left", { text: body, focus: 0, anchor: 0, rev: before.rev, status: "N", collapsed: true });

  await place(page, 2);
  await page.key("b");
  shot = await snap(hub, page);
  expectShot(shot, "VK.9 b", { text: body, focus: 0, anchor: 0, rev: before.rev, status: "N", collapsed: true });

  await place(page, 6);
  await page.key("←", ["Ctrl"]);
  shot = await snap(hub, page);
  expectShot(shot, "VK.9 Ctrl+Left from beta", { text: body, focus: 0, anchor: 0, rev: before.rev, status: "N" });

  await place(page, 2);
  await page.key("v");
  await page.quiet();
  await page.key("→", ["Ctrl"]);
  const visualCtrl = await snap(hub, page);
  expectShot(visualCtrl, "VK.9 visual Ctrl+Right", { text: body, rev: before.rev, status: "V" });
  assert.notEqual(visualCtrl.focus, visualCtrl.anchor, "VK.9 visual Ctrl+Right stayed collapsed");

  await normal(page);
  await place(page, 2);
  await page.key("v");
  await page.quiet();
  await page.key("w");
  const visualW = await snap(hub, page);
  expectShot(visualW, "VK.9 visual w", { text: body, rev: before.rev, status: "V" });
  assert.deepEqual(ends(visualW), ends(visualCtrl), `VK.9 visual w got ${JSON.stringify(visualW.text)} anchors ${visualW.anchor}:${visualW.focus}`);
  assert.equal(visualW.focus, visualCtrl.focus);
  assert.equal(visualW.anchor, visualCtrl.anchor);

  await normal(page);
  await place(page, 2);
  await page.key("v");
  await page.quiet();
  await page.key("←", ["Ctrl"]);
  const visualBack = await snap(hub, page);
  expectShot(visualBack, "VK.9 visual Ctrl+Left", { text: body, rev: before.rev, status: "V" });

  await normal(page);
  await place(page, 2);
  await page.key("v");
  await page.quiet();
  await page.key("b");
  const visualB = await snap(hub, page);
  expectShot(visualB, "VK.9 visual b", { text: body, rev: before.rev, status: "V" });
  assert.equal(visualB.focus, visualBack.focus, `VK.9 visual b focus ${visualB.focus}`);
  assert.equal(visualB.anchor, visualBack.anchor, `VK.9 visual b anchor ${visualB.anchor}`);

  await normal(page);
  await place(page, 2);
  before = await snap(hub, page);
  await page.key("d");
  shot = await snap(hub, page);
  expectShot(shot, "VK.9 operator", { text: body, focus: 2, anchor: 2, rev: before.rev, status: "d" });
  await page.key("→", ["Ctrl"]);
  shot = await snap(hub, page);
  expectShot(shot, "VK.9 d Ctrl+Right", { text: "albeta\n", focus: 2, anchor: 2, rev: before.rev + 1, status: "N", collapsed: true });

  await page.key("z", ["Ctrl"]);
  await page.quiet();
  await place(page, 2);
  before = await snap(hub, page);
  assert.equal(before.text, body, `VK.9 undo got ${JSON.stringify(before.text)}`);
  await page.key("d");
  await page.quiet();
  await page.key("←", ["Ctrl"]);
  shot = await snap(hub, page);
  expectShot(shot, "VK.9 d Ctrl+Left", { text: "pha beta\n", focus: 0, anchor: 0, rev: before.rev + 1, status: "N", collapsed: true });
});

test("VK.10 (ticket 7vdep2z4)", { timeout: 180000 }, async (t) => {
  const body = "alpha\n\nbeta\n";
  const { hub, page } = await setup(t, body);
  await place(page, 2);
  const before = await snap(hub, page);
  await page.key("→", ["Shift"]);
  let shot = await snap(hub, page);
  expectShot(shot, "VK.10 Shift+Right", { text: body, focus: 3, anchor: 3, rev: before.rev, status: "N", collapsed: true });

  await page.key("←", ["Shift"]);
  shot = await snap(hub, page);
  expectShot(shot, "VK.10 Shift+Left", { text: body, focus: 2, anchor: 2, rev: before.rev, status: "N", collapsed: true });

  await page.key("↓", ["Shift"]);
  shot = await snap(hub, page);
  expectShot(shot, "VK.10 Shift+Down", { text: body, focus: 9, anchor: 9, rev: before.rev, status: "N", collapsed: true });

  await page.key("↑", ["Shift"]);
  shot = await snap(hub, page);
  expectShot(shot, "VK.10 Shift+Up", { text: body, focus: 2, anchor: 2, rev: before.rev, status: "N", collapsed: true });

  const off = await setup(t, body, { vim: false });
  await place(off.page, 2);
  const plain = await snap(off.hub, off.page);
  assert.equal(plain.status, "");
  await off.page.key("→", ["Shift"]);
  shot = await snap(off.hub, off.page);
  expectShot(shot, "VK.10 flag off Shift+Right", { text: body, rev: plain.rev });
  assert.deepEqual(ends(shot), [2, 3], `VK.10 flag off Shift+Right selection ${shot.anchor}:${shot.focus}`);
  assert.equal(shot.status, "");
  await place(off.page, 2);
  await off.page.key("↓", ["Shift"]);
  shot = await snap(off.hub, off.page);
  expectShot(shot, "VK.10 flag off Shift+Down", { text: body, rev: plain.rev });
  assert.notEqual(shot.anchor, shot.focus, "VK.10 flag off Shift+Down collapsed");
  assert.equal(shot.status, "");
});

test("VK.11 (ticket 7vdep2z4)", { timeout: 180000 }, async (t) => {
  const body = "alpha\n";
  const { hub, page } = await setup(t, body);
  await place(page, 0);
  let before = await snap(hub, page);
  await page.session.send("Input.insertText", { text: "é" });
  let shot = await snap(hub, page);
  expectShot(shot, "VK.11 normal insertText", {
    text: body,
    focus: before.focus,
    anchor: before.anchor,
    rev: before.rev,
    status: "N",
  });

  await page.key("v");
  before = await snap(hub, page);
  assert.equal(before.status, "V");
  await page.session.send("Input.insertText", { text: "é" });
  shot = await snap(hub, page);
  expectShot(shot, "VK.11 visual insertText", {
    text: body,
    focus: before.focus,
    anchor: before.anchor,
    rev: before.rev,
    status: "V",
  });

  await t.test("composition", async (inner) => {
    if (BROWSER === "firefox") {
      inner.skip("firefox has no input method composition");
      return;
    }
    await normal(page);
    await place(page, 0);
    const start = await snap(hub, page);
    await page.session.send("Input.imeSetComposition", {
      text: "é",
      selectionStart: 1,
      selectionEnd: 1,
    });
    await page.quiet();
    await page.eval(`(() => {
      const root = document.getElementById("editor");
      root.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      root.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "é" }));
      root.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "é" }));
      return true;
    })()`);
    const after = await snap(hub, page);
    expectShot(after, "VK.11 composition", {
      text: body,
      focus: start.focus,
      anchor: start.anchor,
      rev: start.rev,
      status: "N",
    });
  });
});

test("VK.12 (ticket 7vdep2z4)", { timeout: 240000 }, async (t) => {
  const body = "alpha\n";
  const { hub, page } = await setup(t, body);
  await place(page, 0);
  assert.equal((await snap(hub, page)).text, body);

  for (const mode of ["N", "V", "VL", "I"]) {
    for (const mod of ["Ctrl", "Meta"]) {
      const label = `VK.12 ${mode} ${mod}`;
      await normal(page);
      await place(page, 0);
      const opened = await snap(hub, page);
      assert.equal(opened.text, body, `${label} reset got ${JSON.stringify(opened.text)}`);
      assert.equal(opened.status, "N");
      await page.key("x");
      let shot = await snap(hub, page);
      expectShot(shot, `${label} x`, { text: "lpha\n", rev: opened.rev + 1, status: "N" });
      if (mode === "V") await page.key("v");
      else if (mode === "VL") await page.key("V");
      else if (mode === "I") await page.key("i");
      if (mode !== "N") await page.quiet();

      await page.key("z", [mod]);
      shot = await snap(hub, page);
      expectShot(shot, `${label}+Z`, { text: body, rev: opened.rev + 2 });

      await page.key("y", [mod]);
      shot = await snap(hub, page);
      expectShot(shot, `${label}+Y`, { text: "lpha\n", rev: opened.rev + 3 });

      await page.key("z", [mod]);
      shot = await snap(hub, page);
      expectShot(shot, `${label}+Z again`, { text: body, rev: opened.rev + 4 });

      await page.key("z", [mod, "Shift"]);
      shot = await snap(hub, page);
      expectShot(shot, `${label}+Shift+Z`, { text: "lpha\n", rev: opened.rev + 5 });

      const rev = shot.rev;
      await page.key("a", [mod]);
      shot = await snap(hub, page);
      expectShot(shot, `${label}+A`, { text: "lpha\n", rev, status: "VL" });
      assert.deepEqual(ends(shot), [0, "lpha\n".length], `${label}+A selection ${shot.anchor}:${shot.focus}`);

      await normal(page);
      await page.key("z", ["Ctrl"]);
      shot = await snap(hub, page);
      expectShot(shot, `${label} reset undo`, { text: body });
    }
  }
});

test("VK.13 (ticket 7vdep2z4)", { timeout: 240000 }, async (t) => {
  const cut = await setup(t, "alpha beta\n", { clipboard: true });
  await place(cut.page, 0);
  await cut.page.key("v");
  await cut.page.quiet();
  await cut.page.key("e");
  let shot = await snap(cut.hub, cut.page);
  expectShot(shot, "VK.13 visual selection", { text: "alpha beta\n", focus: 5, anchor: 0, status: "V" });
  const rev = shot.rev;
  await cut.page.key("c", ["Ctrl"]);
  shot = await snap(cut.hub, cut.page);
  expectShot(shot, "VK.13 visual Ctrl+C", { text: "alpha beta\n", focus: 5, anchor: 0, rev, status: "V" });
  assert.equal(await readClipboard(cut.page), "alpha");

  await cut.page.key("x", ["Ctrl"]);
  shot = await snap(cut.hub, cut.page);
  expectShot(shot, "VK.13 visual Ctrl+X", { text: " beta\n", focus: 0, anchor: 0, rev: rev + 1, status: "N", collapsed: true });
  assert.equal(await readClipboard(cut.page), "alpha", `VK.13 cut clipboard got ${JSON.stringify(shot.text)}`);

  const paste = await setup(t, "alpha\n", { clipboard: true });
  await place(paste.page, 5);
  await writeClipboard(paste.page, "x");
  const pasted = await snap(paste.hub, paste.page);
  await paste.page.key("v", ["Ctrl"]);
  shot = await snap(paste.hub, paste.page);
  expectShot(shot, "VK.13 normal Ctrl+V", { text: "alphax\n", focus: 6, anchor: 6, rev: pasted.rev + 1, status: "N", collapsed: true });

  await normal(paste.page);
  await place(paste.page, 0);
  await paste.page.key("v");
  await paste.page.quiet();
  await paste.page.key("e");
  shot = await snap(paste.hub, paste.page);
  assert.equal(shot.status, "V");
  const wordFrom = Math.min(shot.anchor, shot.focus);
  const wordTo = Math.max(shot.anchor, shot.focus);
  await writeClipboard(paste.page, "Z");
  await paste.page.key("v", ["Ctrl"]);
  shot = await snap(paste.hub, paste.page);
  expectShot(shot, "VK.13 visual Ctrl+V", {
    text: "alphax\n".slice(0, wordFrom) + "Z" + "alphax\n".slice(wordTo),
    focus: wordFrom + 1,
    anchor: wordFrom + 1,
    rev: shot.rev,
    status: "V",
  });

  let doc = "alphax\n".slice(0, wordFrom) + "Z" + "alphax\n".slice(wordTo);
  await normal(paste.page);
  await paste.page.key("V");
  shot = await snap(paste.hub, paste.page);
  expectShot(shot, "VK.13 visual line", { text: doc, status: "VL" });
  const line = sliceOf(shot.text, shot);
  assert.notEqual(line, "");
  await paste.page.key("c", ["Ctrl"]);
  const copied = await snap(paste.hub, paste.page);
  expectShot(copied, "VK.13 visual line Ctrl+C", { text: doc, focus: shot.focus, anchor: shot.anchor, rev: shot.rev, status: "VL" });
  assert.equal(await readClipboard(paste.page), line);
  const lineFrom = Math.min(copied.anchor, copied.focus);
  const lineTo = Math.max(copied.anchor, copied.focus);
  await writeClipboard(paste.page, "QQ");
  await paste.page.key("v", ["Ctrl"]);
  doc = doc.slice(0, lineFrom) + "QQ" + doc.slice(lineTo);
  shot = await snap(paste.hub, paste.page);
  expectShot(shot, "VK.13 visual line Ctrl+V", { text: doc, rev: copied.rev + 1, status: "VL" });

  await normal(paste.page);
  await place(paste.page, 0);
  await paste.page.key("i");
  shot = await snap(paste.hub, paste.page);
  assert.equal(shot.status, "I");
  assert.equal(shot.text, doc);
  await writeClipboard(paste.page, "M");
  await paste.page.key("v", ["Ctrl"]);
  doc = `M${doc}`;
  shot = await snap(paste.hub, paste.page);
  expectShot(shot, "VK.13 insert Ctrl+V", { text: doc, focus: 1, anchor: 1, rev: shot.rev, status: "I" });

  await normal(paste.page);
  await place(paste.page, 1);
  const still = await snap(paste.hub, paste.page);
  await paste.page.key("x", ["Ctrl"]);
  shot = await snap(paste.hub, paste.page);
  expectShot(shot, "VK.13 normal Ctrl+X", { text: still.text, focus: 1, anchor: 1, rev: still.rev, status: "N" });
  await paste.page.key("c", ["Ctrl"]);
  shot = await snap(paste.hub, paste.page);
  expectShot(shot, "VK.13 normal Ctrl+C", { text: still.text, focus: 1, anchor: 1, rev: still.rev, status: "N" });
  assert.equal(await readClipboard(paste.page), "");

  await paste.page.key("i");
  await paste.page.quiet();
  await paste.page.key("x", ["Ctrl"]);
  shot = await snap(paste.hub, paste.page);
  expectShot(shot, "VK.13 insert Ctrl+X", { text: still.text, rev: still.rev, status: "I", collapsed: true });
  await paste.page.key("c", ["Ctrl"]);
  shot = await snap(paste.hub, paste.page);
  expectShot(shot, "VK.13 insert Ctrl+C", { text: still.text, rev: still.rev, status: "I" });

  await normal(paste.page);
  await paste.page.key("V");
  const marked = await snap(paste.hub, paste.page);
  const whole = sliceOf(marked.text, marked);
  assert.notEqual(whole, "");
  const from = Math.min(marked.anchor, marked.focus);
  const to = Math.max(marked.anchor, marked.focus);
  await paste.page.key("x", ["Ctrl"]);
  shot = await snap(paste.hub, paste.page);
  expectShot(shot, "VK.13 visual line Ctrl+X", {
    text: marked.text.slice(0, from) + marked.text.slice(to),
    rev: marked.rev + 1,
    status: "N",
  });
  assert.equal(await readClipboard(paste.page), whole);
});

test("VK.14 (ticket 7vdep2z4)", { timeout: 180000 }, async (t) => {
  const body = "alpha beta\ngamma delta\n";
  const { hub, page } = await setup(t, body);
  await armKeys(page);
  await place(page, 2);
  let before = await snap(hub, page);

  await takeKeys(page);
  await page.key("w", ["Ctrl"]);
  let shot = await snap(hub, page);
  expectShot(shot, "VK.14 normal Ctrl+W", { text: before.text, focus: before.focus, anchor: before.anchor, rev: before.rev, status: "N" });
  let keys = await takeKeys(page);
  assert.equal(keys.some((item) => item.key.toLowerCase() === "w" && item.ctrl && item.prevented), true, "VK.14 normal Ctrl+W default");

  await takeKeys(page);
  await page.key("w", ["Meta"]);
  shot = await snap(hub, page);
  expectShot(shot, "VK.14 normal Meta+W", { text: before.text, focus: before.focus, anchor: before.anchor, rev: before.rev, status: "N" });
  keys = await takeKeys(page);
  assert.equal(keys.some((item) => item.key.toLowerCase() === "w" && item.meta && item.prevented), true, "VK.14 normal Meta+W default");

  await page.key("v");
  before = await snap(hub, page);
  assert.equal(before.status, "V");
  assert.notEqual(before.anchor, before.focus);
  for (const mod of ["Ctrl", "Meta"]) {
    await takeKeys(page);
    await page.key("w", [mod]);
    shot = await snap(hub, page);
    expectShot(shot, `VK.14 visual ${mod}+W`, {
      text: before.text,
      focus: before.focus,
      anchor: before.anchor,
      rev: before.rev,
      status: "V",
    });
    keys = await takeKeys(page);
    const flag = mod === "Ctrl" ? "ctrl" : "meta";
    assert.equal(keys.some((item) => item.key.toLowerCase() === "w" && item[flag] && item.prevented), true, `VK.14 visual ${mod}+W default`);
  }

  await normal(page);
  await place(page, 2);
  await page.key("V");
  before = await snap(hub, page);
  assert.equal(before.status, "VL");
  for (const mod of ["Ctrl", "Meta"]) {
    await takeKeys(page);
    await page.key("w", [mod]);
    shot = await snap(hub, page);
    expectShot(shot, `VK.14 visual line ${mod}+W`, {
      text: before.text,
      focus: before.focus,
      anchor: before.anchor,
      rev: before.rev,
      status: "VL",
    });
    keys = await takeKeys(page);
    const flag = mod === "Ctrl" ? "ctrl" : "meta";
    assert.equal(keys.some((item) => item.key.toLowerCase() === "w" && item[flag] && item.prevented), true, `VK.14 visual line ${mod}+W default`);
  }

  await normal(page);
  await place(page, 9);
  await page.key("l");
  await page.quiet();
  await page.key("i");
  before = await snap(hub, page);
  assert.equal(before.focus, 10, `VK.14 insert caret ${before.focus}`);
  assert.equal(before.status, "I");
  await takeKeys(page);
  await page.key("w", ["Ctrl"]);
  shot = await snap(hub, page);
  expectShot(shot, "VK.14 insert Ctrl+W", { text: "alpha \ngamma delta\n", focus: 6, anchor: 6, rev: before.rev + 1, status: "I" });
  keys = await takeKeys(page);
  assert.equal(keys.some((item) => item.key.toLowerCase() === "w" && item.ctrl && item.prevented), true, "VK.14 insert Ctrl+W default");

  await normal(page);
  const delta = shot.text.indexOf("delta");
  await place(page, delta + 4);
  await page.key("l");
  await page.quiet();
  await page.key("i");
  before = await snap(hub, page);
  assert.equal(before.focus, delta + 5, `VK.14 insert Meta caret ${before.focus}`);
  assert.equal(before.status, "I");
  await page.key("w", ["Meta"]);
  shot = await snap(hub, page);
  expectShot(shot, "VK.14 insert Meta+W", { text: "alpha \ngamma \n", focus: delta, anchor: delta, rev: before.rev + 1, status: "I" });

  const off = await setup(t, "alpha\n", { vim: false });
  await armKeys(off.page);
  await place(off.page, 2);
  before = await snap(off.hub, off.page);
  await takeKeys(off.page);
  await off.page.key("w", ["Meta"]);
  shot = await snap(off.hub, off.page);
  expectShot(shot, "VK.14 flag off Meta+W", { text: before.text, focus: before.focus, anchor: before.anchor, rev: before.rev });
  assert.equal(shot.status, "");
  keys = await takeKeys(off.page);
  assert.equal(keys.some((item) => item.key.toLowerCase() === "w" && item.meta && item.prevented), false, "VK.14 flag off Meta+W was taken");
});

test("VK.15 (ticket 7vdep2z4)", { timeout: 240000 }, async (t) => {
  let text = "alpha\n- a\n- b\n\talpha\n- a\n\t- b\nxy\nuv\n- e\n- f\n\tcd\nlone\nzz\n- g\n- h\n";
  const { hub, page } = await setup(t, text);
  await place(page, 0);
  assert.equal(await page.eval(`document.querySelector("input.md-vim-line") === null`), true);

  const word = text.indexOf("\talpha");
  await place(page, word + 3);
  let before = await snap(hub, page);
  await page.key("Tab", ["Shift"]);
  text = text.slice(0, word) + text.slice(word + 1);
  let shot = await snap(hub, page);
  expectShot(shot, "VK.15 Shift+Tab plain", { text, focus: word, anchor: word, rev: before.rev + 1, status: "N", collapsed: true });
  assert.equal(text.slice(word, word + 6), "alpha\n");

  await place(page, 2);
  before = await snap(hub, page);
  await page.key("Tab");
  text = `\t${text}`;
  shot = await snap(hub, page);
  expectShot(shot, "VK.15 Tab plain", { text, focus: 1, anchor: 1, rev: before.rev + 1, status: "N", collapsed: true });
  assert.equal(text.startsWith("\talpha\n"), true);

  const item = text.indexOf("\n- b\n");
  const itemCaret = item + 3;
  await place(page, itemCaret);
  before = await snap(hub, page);
  await page.key("Tab");
  const itemLine = item + 1;
  text = text.slice(0, itemLine) + "\t" + text.slice(itemLine);
  shot = await snap(hub, page);
  expectShot(shot, "VK.15 Tab list", { text, focus: itemLine + 1, anchor: itemLine + 1, rev: before.rev + 1, status: "N", collapsed: true });
  assert.equal(text.slice(itemLine - 4, itemLine + 5), "- a\n\t- b\n");

  const out = text.lastIndexOf("\t- b\n");
  await place(page, out + 3);
  before = await snap(hub, page);
  await page.key("Tab", ["Shift"]);
  text = text.slice(0, out) + text.slice(out + 1);
  shot = await snap(hub, page);
  expectShot(shot, "VK.15 Shift+Tab list", { text, focus: out + 2, anchor: out + 2, rev: before.rev + 1, status: "N", collapsed: true });
  assert.equal(text.slice(out - 4, out + 4), "- a\n- b\n");
  assert.equal(await page.eval(`document.querySelector("input.md-vim-line") === null`), true);

  async function insertAt(offset) {
    await normal(page);
    await place(page, offset);
    await page.key("i");
    const entered = await snap(hub, page);
    assert.equal(entered.status, "I", `VK.15 insert status at ${offset}`);
    assert.equal(entered.focus, offset);
    return entered;
  }

  let at = text.indexOf("\nxy\n") + 2;
  before = await insertAt(at);
  await page.key("Tab");
  text = text.slice(0, at) + "\t" + text.slice(at);
  shot = await snap(hub, page);
  expectShot(shot, "VK.15 insert Tab", { text, focus: at + 1, anchor: at + 1, rev: before.rev + 1, status: "I" });

  at = text.indexOf("\nuv\n") + 2;
  before = await insertAt(at);
  await page.key("Tab", ["Shift"]);
  text = text.slice(0, at) + "\t" + text.slice(at);
  shot = await snap(hub, page);
  expectShot(shot, "VK.15 insert Shift+Tab", { text, focus: at + 1, anchor: at + 1, rev: before.rev + 1, status: "I" });

  at = text.indexOf("\n- e\n") + 3;
  before = await insertAt(at);
  await page.key("Tab");
  const eLine = text.lastIndexOf("\n- e\n", at) + 1;
  text = text.slice(0, eLine) + "\t" + text.slice(eLine);
  shot = await snap(hub, page);
  expectShot(shot, "VK.15 insert Tab list", { text, focus: at + 1, anchor: at + 1, rev: before.rev + 1, status: "I" });

  at = text.indexOf("\n- f\n") + 3;
  before = await insertAt(at);
  await page.key("Tab", ["Shift"]);
  const fLine = text.lastIndexOf("\n- f\n", at) + 1;
  text = text.slice(0, fLine) + "\t" + text.slice(fLine);
  shot = await snap(hub, page);
  expectShot(shot, "VK.15 insert Shift+Tab list", { text, focus: at + 1, anchor: at + 1, rev: before.rev + 1, status: "I" });

  at = text.indexOf("\n\tcd\n") + 3;
  before = await insertAt(at);
  await page.key("Tab", ["Shift"]);
  text = text.slice(0, at) + "\t" + text.slice(at);
  shot = await snap(hub, page);
  expectShot(shot, "VK.15 insert Shift+Tab keeps the indent", { text, focus: at + 1, anchor: at + 1, rev: before.rev + 1, status: "I" });
  assert.equal(text.includes("\n\tc\td\n"), true, `VK.15 insert Shift+Tab outdented ${JSON.stringify(text)}`);

  await normal(page);
  at = text.indexOf("\nlone\n") + 1;
  await place(page, at);
  before = await snap(hub, page);
  await page.key("v");
  await page.quiet();
  await page.key("Tab");
  text = text.slice(0, at) + "\t" + text.slice(at);
  shot = await snap(hub, page);
  expectShot(shot, "VK.15 visual Tab", { text, focus: at + 1, anchor: at + 1, rev: before.rev + 1, collapsed: true });
  assert.equal(text.slice(at, at + 5), "\tlone");

  await normal(page);
  at = text.indexOf("\nzz\n") + 1;
  await place(page, at);
  before = await snap(hub, page);
  await page.key("V");
  await page.quiet();
  await page.key("Tab");
  const blockAt = text.indexOf("\t- f\n\tc\td\n\tlone\nzz\n");
  text = text.slice(0, blockAt) + "\t\t- f\n\t\tc\td\n\t\tlone\n\tzz\n" + text.slice(blockAt + "\t- f\n\tc\td\n\tlone\nzz\n".length);
  shot = await snap(hub, page);
  expectShot(shot, "VK.15 visual line Tab", { text, focus: blockAt + 2, anchor: blockAt + 2, rev: before.rev + 1, collapsed: true });
  assert.equal(text.slice(blockAt, blockAt + 6), "\t\t- f\n");
  await normal(page);
  await place(page, text.indexOf("zz"));
  before = await snap(hub, page);
  await page.key("V");
  await page.quiet();
  await page.key("Tab", ["Shift"]);
  const indentedAt = text.indexOf("\t\t- f\n\t\tc\td\n\t\tlone\n\tzz\n");
  text = text.slice(0, indentedAt) + "\t- f\n\tc\td\n\tlone\nzz\n" + text.slice(indentedAt + "\t\t- f\n\t\tc\td\n\t\tlone\n\tzz\n".length);
  shot = await snap(hub, page);
  expectShot(shot, "VK.15 visual line Shift+Tab", { text, focus: indentedAt + 3, anchor: indentedAt + 3, rev: before.rev + 1, collapsed: true });

  await normal(page);
  at = text.indexOf("\n- g\n") + 3;
  await place(page, at);
  before = await snap(hub, page);
  await page.key("v");
  await page.quiet();
  await page.key("j");
  await page.quiet();
  await page.key("Tab");
  const pair = text.indexOf("\n- g\n- h\n");
  text = text.slice(0, pair) + "\n\t- g\n\t- h\n" + text.slice(pair + "\n- g\n- h\n".length);
  shot = await snap(hub, page);
  expectShot(shot, "VK.15 visual Tab lines", { text, focus: pair + 2, anchor: pair + 2, rev: before.rev + 1, collapsed: true });

  await normal(page);
  at = text.indexOf("\n\t- g\n") + 1;
  await place(page, at);
  before = await snap(hub, page);
  await page.key("V");
  await page.quiet();
  await page.key("j");
  await page.quiet();
  await page.key("Tab", ["Shift"]);
  const marked = text.indexOf("\n\t- g\n\t- h\n");
  text = text.slice(0, marked) + "\n\t- g\n- h\n" + text.slice(marked + "\n\t- g\n\t- h\n".length);
  shot = await snap(hub, page);
  expectShot(shot, "VK.15 visual line Shift+Tab lines", { text, focus: marked + 8, anchor: marked + 8, rev: before.rev + 1, collapsed: true });
  assert.equal(await page.eval(`document.querySelector("input.md-vim-line") === null`), true);
});

test("VK.16 (ticket 7vdep2z4)", { timeout: 180000 }, async (t) => {
  const body = "alpha\nbeta\n";
  const { hub, page } = await setup(t, body);
  await place(page, 0);
  const before = await snap(hub, page);
  await page.key('"');
  let shot = await snap(hub, page);
  expectShot(shot, "VK.16 quote", { text: body, focus: 0, anchor: 0, rev: before.rev, status: '"', collapsed: true });

  await page.key('"');
  shot = await snap(hub, page);
  expectShot(shot, "VK.16 quotes", { text: body, focus: 0, anchor: 0, rev: before.rev, status: "N", collapsed: true });

  await page.key("y");
  await page.key("y");
  shot = await snap(hub, page);
  expectShot(shot, "VK.16 yy", { text: body, focus: 0, anchor: 0, rev: before.rev, status: "N", collapsed: true });

  await page.key("p");
  shot = await snap(hub, page);
  expectShot(shot, "VK.16 p", { text: "alpha\nbeta\nalpha\nbeta\n", focus: 11, anchor: 11, rev: before.rev + 1, status: "N", collapsed: true });
});
