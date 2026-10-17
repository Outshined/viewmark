import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { launchBrowser, Page, startHub } from "../harness.js";

// The flag is read once, when the editor is created. A later write does not turn keys on.
const VIM = "viewmark.vim";
const FILE = "a.md";
const MOVE = "alpha beta\n\ngamma delta\n\nepsilon\n";
const AT = "alpha beta\n\nga".length;

// The cells each start a browser. One at a time keeps them from opening every browser at once.
let tail = Promise.resolve();

function cell(id, fn, timeout = 120000) {
  test(`${id} (ticket 7vdep2z4)`, { timeout }, async (t) => {
    const gate = tail;
    let release;
    tail = new Promise((resolve) => {
      release = resolve;
    });
    await gate;
    try {
      await fn(t);
    } finally {
      release();
    }
  });
}

function shown(text, focus, anchor = focus) {
  let out = "";
  const markAnchor = Number.isInteger(anchor) && anchor !== focus;
  for (let i = 0; i <= text.length; i += 1) {
    if (markAnchor && i === anchor) out += "«";
    if (i === focus) out += "‸";
    if (i < text.length) out += text[i];
  }
  return out;
}

async function setup(t, body, file = FILE) {
  const hub = await startHub();
  const browsers = [];
  t.after(async () => {
    for (const browser of browsers.splice(0)) await browser.close();
    await hub.close();
  });
  await hub.create(file, body);
  return {
    hub,
    async open(vim, next = file) {
      const browser = await launchBrowser();
      browsers.push(browser);
      const page = new Page(browser.session, hub.port);
      await page.init();
      if (vim) {
        // Runs on the next document, before its scripts, so the editor is created with the flag on.
        await page.session.send("Page.addScriptToEvaluateOnNewDocument", {
          source: `localStorage.setItem(${JSON.stringify(VIM)}, "1");`,
        });
      }
      await page.login();
      await page.open(next);
      assert.equal(await page.eval(`localStorage.getItem(${JSON.stringify(VIM)})`), vim ? "1" : null);
      return { browser, page };
    },
  };
}

async function closeBrowser(browsers, browser) {
  const index = browsers.indexOf(browser);
  if (index >= 0) browsers.splice(index, 1);
  await browser.close();
}

function status(page) {
  return page.eval(`document.querySelector(".md-vim-status").textContent`);
}

async function place(page, offset) {
  assert.ok(await page.clickOffset(offset), `no point at ${offset}`);
  await page.quiet();
  const caret = await page.caret();
  assert.equal(caret.focus, offset, `click landed at ${caret.focus}, not ${offset}`);
  assert.equal(caret.anchor, caret.focus);
}

async function view(hub, page, file = FILE) {
  await page.quiet();
  const got = await hub.show(file);
  const caret = await page.caret();
  return { text: got.text, rev: got.rev, caret, show: shown(got.text, caret.focus, caret.anchor) };
}

async function keys(page, text) {
  for (const ch of text) await page.key(ch);
}

async function enterInsert(page) {
  await page.key("i");
  await page.quiet();
  assert.equal(await status(page), "I");
}

cell("VT.1", async (t) => {
  const hub = await startHub();
  const browsers = [];
  t.after(async () => {
    for (const browser of browsers.splice(0)) await browser.close();
    await hub.close();
  });
  await hub.create(FILE, MOVE);
  const plain = await (async () => {
    const browser = await launchBrowser();
    browsers.push(browser);
    const page = new Page(browser.session, hub.port);
    await page.init();
    await page.login();
    await page.open(FILE);
    assert.equal(await page.eval(`localStorage.getItem(${JSON.stringify(VIM)})`), null);
    return { browser, page };
  })();

  async function ends(page) {
    await place(page, AT);
    await page.key("Home");
    await page.quiet();
    const home = await page.caret();
    await place(page, AT);
    await page.key("End");
    await page.quiet();
    const end = await page.caret();
    assert.equal((await hub.show(FILE)).text, MOVE);
    return { home: home.focus, end: end.focus };
  }

  const off = await ends(plain.page);
  assert.notEqual(off.home, off.end, `flag-off Home and End both left the caret at ${off.home}`);
  await closeBrowser(browsers, plain.browser);

  const browser = await launchBrowser();
  browsers.push(browser);
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.session.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `localStorage.setItem(${JSON.stringify(VIM)}, "1");`,
  });
  await page.login();
  await page.open(FILE);
  assert.equal(await page.eval(`localStorage.getItem(${JSON.stringify(VIM)})`), "1");

  async function motion(key, insert) {
    await place(page, AT);
    if (insert) {
      if ((await status(page)) !== "I") await enterInsert(page);
    } else if ((await status(page)) !== "N") {
      await page.key("Escape");
      await page.quiet();
      assert.equal(await status(page), "N");
    }
    await page.key(key);
    await page.quiet();
    assert.equal(await status(page), insert ? "I" : "N");
    const caret = await page.caret();
    assert.equal(caret.anchor, caret.focus, `${key} selected a range`);
    assert.equal((await hub.show(FILE)).text, MOVE);
    return caret.focus;
  }

  const left = await motion("h", false);
  const right = await motion("l", false);
  const up = await motion("k", false);
  const down = await motion("j", false);
  assert.notEqual(left, AT, "h did not move");
  assert.notEqual(right, AT, "l did not move");
  assert.notEqual(up, AT, "k did not move");
  assert.notEqual(down, AT, "j did not move");
  assert.equal(await motion("←", true), left, "Insert left did not move as h");
  assert.equal(await motion("→", true), right, "Insert right did not move as l");
  assert.equal(await motion("↑", true), up, "Insert up did not move as k");
  assert.equal(await motion("↓", true), down, "Insert down did not move as j");

  await place(page, AT);
  if ((await status(page)) !== "I") await enterInsert(page);
  await page.key("Home");
  await page.quiet();
  assert.equal(await status(page), "I");
  const home = (await page.caret()).focus;
  await place(page, AT);
  await page.key("End");
  await page.quiet();
  assert.equal(await status(page), "I");
  const end = (await page.caret()).focus;
  assert.equal(home, off.home, `Insert Home went to ${home}, flag-off Home went to ${off.home}`);
  assert.equal(end, off.end, `Insert End went to ${end}, flag-off End went to ${off.end}`);
  assert.equal((await hub.show(FILE)).text, MOVE);
}, 180000);

cell("VT.2", async (t) => {
  const ctx = await setup(t, "alpha beta\n", "ctrl.md");
  await ctx.hub.create("meta.md", "alpha beta\n");
  const { page } = await ctx.open(true, "ctrl.md");
  async function word(file, mod) {
    await page.open(file);
    await place(page, "alpha beta".length);
    await enterInsert(page);
    await page.key("w", [mod]);
    const got = await view(ctx.hub, page, file);
    assert.equal(got.show, "alpha ‸\n", `${mod}+W`);
    assert.equal(await status(page), "I");
  }
  await word("ctrl.md", "Ctrl");
  await word("meta.md", "Meta");
});

cell("VT.3", async (t) => {
  const ctx = await setup(t, "alpha\nbeta\n");
  const { page } = await ctx.open(true);
  await place(page, "alpha\nbe".length);
  await enterInsert(page);
  const before = await ctx.hub.show(FILE);
  const since = page.frames.length;
  await page.key("u", ["Ctrl"]);
  const got = await view(ctx.hub, page);
  const edits = page.frames.slice(since).filter((frame) => frame.dir === "out" && frame.data && frame.data.type === "edit").length;
  assert.equal(got.show, "alpha\n‸ta\n");
  assert.equal(edits, 1, `Ctrl+U sent ${edits} edits, text ${JSON.stringify(got.text)}`);
  assert.equal(got.rev, before.rev + 1);
  assert.equal(await status(page), "I");
});

cell("VT.4", async (t) => {
  const ctx = await setup(t, "alpha\n");
  const { page } = await ctx.open(true);
  await place(page, "al".length);
  await enterInsert(page);
  const before = await ctx.hub.show(FILE);
  await page.eval(`(() => {
    document.addEventListener("keydown", (event) => {
      if (!event.ctrlKey || String(event.key).toLowerCase() !== "r") return;
      sessionStorage.setItem("vt.ctrlr", JSON.stringify({ key: event.key, prevented: event.defaultPrevented }));
    }, false);
  })()`);
  await page.key("r", ["Ctrl"]);
  let recorded = null;
  try {
    recorded = JSON.parse(await page.eval(`sessionStorage.getItem("vt.ctrlr")`));
  } catch {
    recorded = null;
  }
  try {
    await page.quiet();
  } catch {
    // An unprevented Ctrl+R may reload the page. The hub bytes are the check.
  }
  const after = await ctx.hub.show(FILE);
  assert.equal(recorded && recorded.prevented, false, `Ctrl+R keydown ${JSON.stringify(recorded)}`);
  assert.equal(after.text, before.text);
  assert.equal(after.rev, before.rev);
});

cell("VT.5", async (t) => {
  const ctx = await setup(t, "alpha\n");
  const { page } = await ctx.open(true);
  await place(page, "al".length);
  const before = await view(ctx.hub, page);
  await enterInsert(page);
  await page.key("Escape");
  const got = await view(ctx.hub, page);
  assert.equal(got.show, "a‸lpha\n");
  assert.equal(got.rev, before.rev);
  assert.equal(got.caret.focused, true);
  assert.equal(await status(page), "N");
});

cell("VT.6", async (t) => {
  const ctx = await setup(t, "alpha\n");
  const { page } = await ctx.open(true);
  await place(page, "alpha".length);
  await enterInsert(page);
  await keys(page, "xy");
  await page.quiet();
  await sleep(2000);
  await page.key("z");
  const mid = await view(ctx.hub, page);
  assert.equal(mid.show, "alphaxyz‸\n");
  assert.equal(await status(page), "I");
  await page.key("Escape");
  await page.quiet();
  assert.equal(await status(page), "N");
  await page.key("u");
  const got = await view(ctx.hub, page);
  assert.equal(got.show, "alpha‸\n", `before undo ${mid.show}`);
});

cell("VT.7", async (t) => {
  const ctx = await setup(t, "alpha\n");
  const { page } = await ctx.open(true);
  await place(page, "alpha".length);
  await enterInsert(page);
  await keys(page, "xy");
  await page.quiet();
  await page.key("←");
  await page.quiet();
  assert.equal(await status(page), "I");
  await page.key("z");
  const mid = await view(ctx.hub, page);
  await page.key("Escape");
  await page.quiet();
  assert.equal(await status(page), "N");
  await page.key("u");
  const got = await view(ctx.hub, page);
  assert.equal(got.show, "alpha‸\n", `before undo ${mid.show}`);
  assert.equal(mid.show, "alphaxz‸y\n");
});

cell("VT.8", async (t) => {
  const ctx = await setup(t, "alpha\n");
  const { page } = await ctx.open(true);
  await place(page, "alpha".length);
  await enterInsert(page);
  await page.key("x");
  await page.quiet();
  await page.key("Enter");
  await page.quiet();
  await page.key("y");
  const mid = await view(ctx.hub, page);
  assert.equal(await status(page), "I");
  assert.notEqual(mid.text, "alpha\n");
  assert.match(mid.text, /x/);
  assert.match(mid.text, /y/);
  await page.key("Escape");
  await page.quiet();
  assert.equal(await status(page), "N");
  await page.key("u");
  const got = await view(ctx.hub, page);
  assert.equal(got.show, "alpha‸\n", `before undo ${mid.show}`);
});

// Flag off. A pause over one second still ends the typing run.
cell("VT.9", async (t) => {
  const ctx = await setup(t, "alpha\n");
  const { page } = await ctx.open(false);
  await place(page, "alpha".length);
  await page.key("x");
  await page.quiet();
  await sleep(1500);
  await page.key("y");
  const mid = await view(ctx.hub, page);
  assert.equal(mid.show, "alphaxy‸\n");
  await page.key("z", ["Ctrl"]);
  const got = await view(ctx.hub, page);
  assert.equal(got.show, "alphax‸\n", `before undo ${mid.show}`);
});
