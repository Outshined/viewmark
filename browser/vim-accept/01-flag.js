import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "../harness.js";

// The flag is read when the editor is created, so a key is planted before login.
const FILE = "a.md";
const VIM = "viewmark.vim";
const ALPHA = "alpha\n";
const MENU_OPEN = `(() => { const el = document.querySelector(".md-doc-menu-panel"); return !!el && !el.hidden && el.getClientRects().length > 0; })()`;

// sessionStorage holds the login. Only localStorage throws, so a reload cannot see the flag.
const DENY_STORAGE = `(() => {
  const deny = () => { throw new Error("denied"); };
  const storage = window.localStorage;
  const proto = Storage.prototype;
  for (const name of ["getItem", "setItem", "removeItem"]) {
    const raw = proto[name];
    try {
      Object.defineProperty(storage, name, { configurable: true, writable: true, value: deny });
    } catch (error) {
      // The instance method is fixed. The prototype patch below still rejects this store.
    }
    proto[name] = function (...args) {
      if (this === storage) throw new Error("denied");
      return raw.apply(this, args);
    };
  }
})();`;

async function boot(t, { vim = "1", body = ALPHA, denyStorage = false } = {}) {
  const hub = await startHub();
  let browser;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (browser) await browser.close();
    await hub.close();
  };
  t.after(close);
  await hub.create(FILE, body);
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  if (denyStorage) {
    await page.session.send("Page.addScriptToEvaluateOnNewDocument", { source: DENY_STORAGE });
  } else if (typeof vim === "string") {
    await page.session.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `localStorage.setItem(${JSON.stringify(VIM)}, ${JSON.stringify(vim)});`,
    });
  }
  return { hub, page, close };
}

async function statusText(page) {
  return page.eval(`(() => {
    const el = document.querySelector("span.md-vim-status");
    return el ? el.textContent : null;
  })()`);
}

async function place(page, offset) {
  assert.ok(await page.clickOffset(offset), `no point at ${offset}`);
  await page.quiet();
  const caret = await page.caret();
  assert.equal(caret.focus, offset);
  assert.equal(caret.anchor, offset);
  return caret;
}

async function openDocMenu(page) {
  if (!(await page.eval(MENU_OPEN))) {
    const point = await page.eval(`(() => {
      const el = document.querySelector("button.md-doc-menu");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
    })()`);
    assert.ok(point, "document menu button");
    await page.click(point.x, point.y);
    await page.until(() => page.eval(MENU_OPEN), "document menu open");
  }
}

async function vimItemPoint(page) {
  return page.eval(`(() => {
    const el = [...document.querySelectorAll('[role="menuitemcheckbox"]')].find((node) => (node.textContent || "").trim() === "Vim keys");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
  })()`);
}

async function clickVimKeys(page) {
  await openDocMenu(page);
  const point = await vimItemPoint(page);
  assert.ok(point, "Vim keys item");
  await page.click(point.x, point.y);
  await page.quiet();
}

function wire(page, since) {
  return page.frames.slice(since).filter((frame) => frame.dir === "in" || frame.dir === "out");
}

function showCaret(text, anchor, focus) {
  let out = "";
  for (let i = 0; i <= text.length; i += 1) {
    if (anchor !== focus && i === anchor) out += "«";
    if (i === focus) out += "‸";
    if (i < text.length) out += text[i];
  }
  return out;
}

async function sessionBag(page) {
  return page.eval(`(() => ({
    username: sessionStorage.getItem("viewmark.username"),
    repo: sessionStorage.getItem("viewmark.repo"),
    session: sessionStorage.getItem("viewmark.session"),
    vim: sessionStorage.getItem(${JSON.stringify(VIM)}),
  }))()`);
}

test("VF.1 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await boot(t, { vim: null });
  await page.login();
  await page.open(FILE);
  assert.equal(await page.eval(`localStorage.getItem(${JSON.stringify(VIM)})`), null);
  assert.equal(await statusText(page), null);
  await place(page, 0);
  const before = await hub.show(FILE);
  await page.key("x");
  await page.quiet();
  const after = await hub.show(FILE);
  assert.equal(after.text, "xalpha\n");
  assert.equal(after.rev, before.rev + 1);
  const caret = await page.caret();
  assert.equal(caret.focus, 1);
  assert.equal(caret.anchor, 1);
  assert.equal(await statusText(page), null);
});

test("VF.2 (ticket 7vdep2z4)", async (t) => {
  const { page } = await boot(t, { vim: null });
  await page.login();
  await page.open(FILE);
  const before = await sessionBag(page);
  assert.equal(before.vim, null);
  assert.ok(before.username);
  assert.ok(before.repo);
  assert.ok(before.session);
  assert.equal(await statusText(page), null);
  await clickVimKeys(page);
  assert.equal(await page.eval(`localStorage.getItem(${JSON.stringify(VIM)})`), "1");
  assert.equal(await statusText(page), "N");
  const after = await sessionBag(page);
  assert.equal(after.vim, null);
  assert.equal(after.username, before.username);
  assert.equal(after.repo, before.repo);
  assert.equal(after.session, before.session);
});

test("VF.3 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await boot(t);
  await page.login();
  await page.open(FILE);
  await page.open(FILE);
  assert.equal(await page.eval(`localStorage.getItem(${JSON.stringify(VIM)})`), "1");
  assert.equal(await statusText(page), "N");
  assert.equal(await page.eval(`!!document.querySelector("button.md-view-toggle") && !document.querySelector("#editor").classList.contains("md-source")`), true);
  await place(page, 0);
  const before = await hub.show(FILE);
  await page.key("x");
  await page.quiet();
  const after = await hub.show(FILE);
  assert.equal(after.text, "lpha\n");
  assert.equal(after.rev, before.rev + 1);
  const caret = await page.caret();
  assert.equal(showCaret(after.text, caret.anchor, caret.focus), "‸lpha\n");
});

test("VF.4 (ticket 7vdep2z4)", async (t) => {
  for (const value of ["0", "true", " 1"]) {
    const { hub, page, close } = await boot(t, { vim: value });
    try {
      await page.login();
      await page.open(FILE);
      assert.equal(await page.eval(`localStorage.getItem(${JSON.stringify(VIM)})`), value);
      assert.equal(await statusText(page), null);
      await place(page, 0);
      const before = await hub.show(FILE);
      assert.equal(before.text, ALPHA);
      await page.key("x");
      await page.quiet();
      const after = await hub.show(FILE);
      assert.equal(after.text, "xalpha\n", value);
      assert.equal(after.rev, before.rev + 1, value);
      const caret = await page.caret();
      assert.equal(showCaret(after.text, caret.anchor, caret.focus), "x‸alpha\n", value);
      assert.equal(await statusText(page), null, value);
    } finally {
      await close();
    }
  }
});

test("VF.5 (ticket 7vdep2z4)", async (t) => {
  const body = "alpha beta\n";
  const { hub, page } = await boot(t, { body });
  await page.login();
  await page.open(FILE);
  assert.equal(await statusText(page), "N");
  // v selects the next character. Two l motions extend the focus through "pha".
  await place(page, 2);
  await page.key("v");
  await page.key("l");
  await page.key("l");
  await page.quiet();
  const selected = await page.caret();
  const opened = await hub.show(FILE);
  assert.equal(opened.text, body);
  assert.equal(showCaret(opened.text, selected.anchor, selected.focus), "al«pha‸ beta\n");
  assert.equal(await statusText(page), "V");
  const since = page.frames.length;
  const rev = opened.rev;
  await clickVimKeys(page);
  const edits = page.frames.slice(since).filter((frame) => frame.dir === "out" && frame.data && frame.data.type === "edit");
  assert.equal(edits.length, 0);
  assert.equal(await page.eval(`localStorage.getItem(${JSON.stringify(VIM)})`), null);
  assert.equal(await statusText(page), null);
  const collapsed = await hub.show(FILE);
  assert.equal(collapsed.text, body);
  assert.equal(collapsed.rev, rev);
  const caret = await page.caret();
  assert.equal(showCaret(collapsed.text, caret.anchor, caret.focus), "alpha‸ beta\n");
  await page.key("x");
  await page.quiet();
  const after = await hub.show(FILE);
  assert.equal(after.text, "alphax beta\n");
  assert.equal(after.rev, rev + 1);
  const typed = await page.caret();
  assert.equal(showCaret(after.text, typed.anchor, typed.focus), "alphax‸ beta\n");
});

test("VF.6 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await boot(t);
  await page.login();
  await page.open(FILE);
  await place(page, 0);
  await page.key("3");
  await page.quiet();
  assert.equal(await statusText(page), "3");
  await page.key("d");
  await page.quiet();
  assert.equal(await statusText(page), "3d");
  const pending = await hub.show(FILE);
  assert.equal(pending.text, ALPHA);
  const caret = await page.caret();
  assert.equal(caret.focus, 0);
  assert.equal(caret.anchor, 0);
  await clickVimKeys(page);
  assert.equal(await page.eval(`localStorage.getItem(${JSON.stringify(VIM)})`), null);
  assert.equal(await statusText(page), null);
  const cleared = await hub.show(FILE);
  assert.equal(cleared.text, ALPHA);
  assert.equal(cleared.rev, pending.rev);
  const stayed = await page.caret();
  assert.equal(stayed.focus, 0);
  assert.equal(stayed.anchor, 0);
  await page.key("x");
  await page.quiet();
  const after = await hub.show(FILE);
  assert.equal(after.text, "xalpha\n");
  assert.equal(after.rev, pending.rev + 1);
  const typed = await page.caret();
  assert.equal(showCaret(after.text, typed.anchor, typed.focus), "x‸alpha\n");
});

test("VF.7 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await boot(t, { vim: null, denyStorage: true });
  await page.login();
  await page.open(FILE);
  const throws = await page.eval(`(() => {
    const out = { get: false, set: false };
    try { localStorage.getItem(${JSON.stringify(VIM)}); } catch (e) { out.get = true; }
    try { localStorage.setItem("viewmark.vim.probe", "1"); } catch (e) { out.set = true; }
    return out;
  })()`);
  assert.deepEqual(throws, { get: true, set: true });
  assert.equal(await statusText(page), null);
  await clickVimKeys(page);
  assert.equal(await statusText(page), "N");
  assert.equal((await sessionBag(page)).vim, null);
  await place(page, 0);
  const before = await hub.show(FILE);
  await page.key("x");
  await page.quiet();
  const deleted = await hub.show(FILE);
  assert.equal(deleted.text, "lpha\n");
  assert.equal(deleted.rev, before.rev + 1);
  const cut = await page.caret();
  assert.equal(showCaret(deleted.text, cut.anchor, cut.focus), "‸lpha\n");
  await page.open(FILE);
  assert.equal(await statusText(page), null);
  const still = await page.eval(`(() => {
    try { localStorage.getItem(${JSON.stringify(VIM)}); return false; } catch (e) { return true; }
  })()`);
  assert.equal(still, true);
  await place(page, 0);
  const reloaded = await hub.show(FILE);
  assert.equal(reloaded.text, "lpha\n");
  await page.key("x");
  await page.quiet();
  const after = await hub.show(FILE);
  assert.equal(after.text, "xlpha\n");
  assert.equal(after.rev, reloaded.rev + 1);
  const typed = await page.caret();
  assert.equal(showCaret(after.text, typed.anchor, typed.focus), "x‸lpha\n");
  assert.equal(await statusText(page), null);
});

test("VF.8 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await boot(t, { vim: null });
  await page.login();
  await page.open(FILE);
  await page.quiet();
  const before = await hub.show(FILE);
  await openDocMenu(page);
  await page.quiet();
  const checking = page.frames.length;
  const point = await vimItemPoint(page);
  assert.ok(point, "Vim keys item");
  await page.click(point.x, point.y);
  await page.quiet();
  assert.deepEqual(wire(page, checking).map((frame) => frame.data && frame.data.type), []);
  assert.equal(await page.eval(`localStorage.getItem(${JSON.stringify(VIM)})`), "1");
  assert.equal(await statusText(page), "N");
  await openDocMenu(page);
  await page.quiet();
  const unchecking = page.frames.length;
  const again = await vimItemPoint(page);
  assert.ok(again, "Vim keys item");
  await page.click(again.x, again.y);
  await page.quiet();
  assert.deepEqual(wire(page, unchecking).map((frame) => frame.data && frame.data.type), []);
  assert.equal(await page.eval(`localStorage.getItem(${JSON.stringify(VIM)})`), null);
  assert.equal(await statusText(page), null);
  const after = await hub.show(FILE);
  assert.equal(after.text, before.text);
  assert.equal(after.rev, before.rev);
  assert.equal(page.frames.some((frame) => JSON.stringify(frame.data || "").includes(VIM)), false);
});
