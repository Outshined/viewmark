import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "../harness.js";

// The flag is read once, when the editor is created. A later write does not turn keys on.
const VIM = "viewmark.vim";

function marked(text) {
  const bytes = text.replace(/[‸«]/g, "");
  const focusAt = text.indexOf("‸");
  const anchorAt = text.indexOf("«");
  const position = (at) => at - (anchorAt >= 0 && anchorAt < at ? 1 : 0) - (focusAt >= 0 && focusAt < at ? 1 : 0);
  const focus = focusAt < 0 ? null : position(focusAt);
  const anchor = anchorAt < 0 ? focus : position(anchorAt);
  return { bytes, focus, anchor };
}

function shown(text, focus, anchor) {
  let out = "";
  for (let i = 0; i <= text.length; i += 1) {
    if (anchor !== focus && i === anchor) out += "«";
    if (i === focus) out += "‸";
    if (i < text.length) out += text[i];
  }
  return out;
}

function painted(text, caret) {
  if (!caret || !Number.isInteger(caret.focus)) return `missing caret ${JSON.stringify(text)}`;
  const anchor = Number.isInteger(caret.anchor) ? caret.anchor : caret.focus;
  return shown(text, caret.focus, anchor);
}

// show opens a second client and the page redraws, which moves the caret.
// The rev is the one the hub already sent with the file.
function sent(page, file) {
  for (let i = page.frames.length - 1; i >= 0; i -= 1) {
    const frame = page.frames[i];
    const data = frame.dir === "in" && frame.data;
    if (data && (data.type === "doc" || data.type === "file") && data.path === file && typeof data.text === "string" && Number.isInteger(data.rev)) return data;
  }
  throw new Error(`the page was sent no text for ${file}`);
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

async function status(page) {
  return page.eval(`document.querySelector(".md-vim-status").textContent`);
}

async function run(hub, page, id, file, start, keys, want, revDelta, mode) {
  const { bytes, focus } = marked(start);
  await hub.create(file, bytes);
  await page.open(file);
  assert.equal(await page.eval(`localStorage.getItem(${JSON.stringify(VIM)})`), "1", id);
  assert.ok(await page.clickOffset(focus), `${id}: no point at ${focus}`);
  await page.quiet();
  const placed = await page.caret();
  const opened = sent(page, file);
  assert.equal(opened.text, bytes, `${id}: opened`);
  assert.equal(painted(bytes, placed), start, `${id}: placed`);
  for (const key of keys) {
    await page.key(key);
    await page.quiet();
  }
  const caret = await page.caret();
  const after = await hub.show(file);
  assert.equal(painted(after.text, caret), want, id);
  assert.equal(after.rev, opened.rev + revDelta, `${id}: rev +${after.rev - opened.rev} bytes ${JSON.stringify(after.text)}`);
  assert.equal(await status(page), mode, id);
}

test("VB.1 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t);
  const start = "alpha b‸eta gamma\n";
  await run(hub, page, "VB.1", "vb1-iw.md", start, ["d", "i", "w"], "alpha ‸ gamma\n", 1, "N");
  await run(hub, page, "VB.1", "vb1-aw.md", start, ["d", "a", "w"], "alpha ‸gamma\n", 1, "N");
});

test("VB.2 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t);
  await run(hub, page, "VB.2", "vb2.md", "alpha be‸ta", ["d", "a", "w"], "alpha‸", 1, "N");
});

test("VB.3 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t);
  await run(hub, page, "VB.3", "vb3.md", "alpha ‸ beta\n", ["d", "i", "w"], "alpha  ‸\n", 1, "N");
});

test("VB.4 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t);
  const start = "alpha b‸eta gamma\n";
  await run(hub, page, "VB.4", "vb4-c.md", start, ["c", "i", "w"], "alpha ‸ gamma\n", 1, "I");
  await run(hub, page, "VB.4", "vb4-y.md", start, ["y", "i", "w", "0", "P"], "‸betaalpha beta gamma\n", 1, "N");
});

test("VB.5 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t);
  const start = "say \"he‸llo\" now\n";
  await run(hub, page, "VB.5", "vb5-i.md", start, ["d", "i", "\""], "say \"‸\" now\n", 1, "N");
  await run(hub, page, "VB.5", "vb5-a.md", start, ["d", "a", "\""], "say ‸ now\n", 1, "N");
  const open = "say \"he‸llo now\n";
  await run(hub, page, "VB.5", "vb5-open.md", open, ["d", "i", "\""], open, 0, "N");
  const split = "say \"he‸llo\nnow\" ok\n";
  await run(hub, page, "VB.5", "vb5-split.md", split, ["d", "i", "\""], split, 0, "N");
});

test("VB.6 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t);
  const start = "a `co‸de` b\n";
  await run(hub, page, "VB.6a", "vb6a.md", start, ["d", "i", "`"], "a `‸` b\n", 1, "N");
  await run(hub, page, "VB.6b", "vb6b.md", start, ["d", "a", "`"], "a ‸ b\n", 1, "N");
  const outside = "‸a `code` b\n";
  await run(hub, page, "VB.6c", "vb6c.md", outside, ["d", "i", "`"], outside, 0, "N");
});

test("VB.7 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t);
  const start = "see [te‸xt](https://x.test/p) now\n";
  await run(hub, page, "VB.7", "vb7-i.md", start, ["d", "i", "["], "see [‸](https://x.test/p) now\n", 1, "N");
  await run(hub, page, "VB.7", "vb7-a.md", start, ["d", "a", "["], "see ‸(https://x.test/p) now\n", 1, "N");
  await run(hub, page, "VB.7", "vb7-close.md", start, ["d", "i", "]"], "see [‸](https://x.test/p) now\n", 1, "N");
  const bare = "see [te‸xt] now\n";
  await run(hub, page, "VB.7", "vb7-bare.md", bare, ["d", "i", "["], bare, 0, "N");
});

test("VB.8 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t);
  const start = "one\n\nal‸pha\nbeta\n\ntwo\n";
  await run(hub, page, "VB.8", "vb8-i.md", start, ["d", "i", "p"], "one\n\n‸\n\ntwo\n", 1, "N");
  await run(hub, page, "VB.8", "vb8-a.md", start, ["d", "a", "p"], "one\n\n‸two\n", 1, "N");
});

// A failed object leaves N. Pending input would still be on the status.
test("VB.9 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t);
  const start = "say ‸hello\n";
  await run(hub, page, "VB.9", "vb9.md", start, ["d", "i", "\""], start, 0, "N");
});

test("VB.10 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t);
  const start = "al‸pha\n";
  for (const ch of ["(", "{", "<", "t", "*", "_"]) {
    await run(hub, page, "VB.10", `vb10-${ch}.md`, start, ["d", "i", ch], start, 0, "N");
  }
});

// i enters Insert before the next key, so w is typed at the caret.
test("VB.11 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t);
  await run(hub, page, "VB.11", "vb11.md", "‸alpha\n", ["i", "w"], "w‸alpha\n", 1, "I");
});
