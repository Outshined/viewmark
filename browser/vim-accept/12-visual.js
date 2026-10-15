import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "../harness.js";

// ‸ is the focus and « is the anchor. Neither character is stored.
const VIM = "viewmark.vim";

function parse(text) {
  let bytes = "";
  let anchor = null;
  let focus = null;
  for (const ch of text) {
    if (ch === "«") {
      if (anchor != null) throw new Error(`two anchors in ${JSON.stringify(text)}`);
      anchor = bytes.length;
    } else if (ch === "‸") {
      if (focus != null) throw new Error(`two carets in ${JSON.stringify(text)}`);
      focus = bytes.length;
    } else bytes += ch;
  }
  if (focus == null) throw new Error(`no caret in ${JSON.stringify(text)}`);
  if (anchor == null) anchor = focus;
  return { bytes, anchor, focus };
}

function show(doc, focus, anchor) {
  if (!Number.isInteger(focus)) return `(no caret ${focus}/${anchor})`;
  const markAnchor = anchor === focus ? null : anchor;
  let out = "";
  for (let i = 0; i <= doc.length; i += 1) {
    if (markAnchor === i) out += "«";
    if (focus === i) out += "‸";
    if (i < doc.length) out += doc[i];
  }
  return out;
}

async function setup(t, files) {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  const docs = typeof files === "string" ? { "a.md": files } : files;
  for (const [name, text] of Object.entries(docs)) await hub.create(name, text);
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  // The flag is read when the editor is created. Set it before the first navigation.
  await page.session.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `localStorage.setItem(${JSON.stringify(VIM)}, "1");`,
  });
  await page.login();
  assert.equal(await page.eval(`localStorage.getItem(${JSON.stringify(VIM)})`), "1");
  return { hub, page };
}

function outbound(page, type) {
  return page.frames.filter((frame) => frame.dir === "out" && frame.data && frame.data.type === type).length;
}

async function snap(page, hub, file) {
  const shown = await hub.show(file);
  const caret = await page.caret();
  const focus = caret && Number.isInteger(caret.focus) ? caret.focus : null;
  const anchor = caret && Number.isInteger(caret.anchor) ? caret.anchor : null;
  const status = await page.eval(`document.querySelector("span.md-vim-status") && document.querySelector("span.md-vim-status").textContent`);
  const block = await page.eval(`document.getElementById("editor").classList.contains("md-vim-block")`);
  return { ...shown, focus, anchor, status, block, picture: show(shown.text, focus, anchor == null ? focus : anchor) };
}

function detail(got) {
  return `got ${JSON.stringify(got.picture)} status ${got.status} block ${got.block} rev ${got.rev}`;
}

async function expectMark(page, hub, file, markedText, status, rev) {
  const want = parse(markedText);
  const got = await snap(page, hub, file);
  assert.equal(got.picture, markedText, detail(got));
  assert.equal(got.text, want.bytes, detail(got));
  assert.equal(got.focus, want.focus, detail(got));
  assert.equal(got.anchor, want.anchor, detail(got));
  assert.equal(got.status, status, detail(got));
  assert.equal(got.block, status !== "I", detail(got));
  if (rev !== undefined) assert.equal(got.rev, rev, detail(got));
  return got;
}

async function place(page, offset) {
  assert.equal(await page.clickOffset(offset), true, `no point at ${offset}`);
  await page.quiet();
  const caret = await page.caret();
  assert.equal(caret.focus, offset, `caret ${caret && caret.focus} after click at ${offset}`);
  assert.equal(caret.anchor, offset, `anchor ${caret && caret.anchor} after click at ${offset}`);
}

async function showRaw(page) {
  for (let i = 0; i < 4; i += 1) {
    if (await page.eval(`document.getElementById("editor").classList.contains("md-source")`)) return;
    const pt = await page.eval(`(() => { const b = document.querySelector("button.md-view-toggle"); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    assert.ok(pt, "no raw toggle");
    await page.click(pt.x, pt.y);
    await page.quiet();
  }
  assert.equal(await page.eval(`document.getElementById("editor").classList.contains("md-source")`), true);
}

async function begin(page, hub, file, start, { raw = false } = {}) {
  await page.open(file);
  await page.until(() => page.eval(`!!document.querySelector("span.md-vim-status")`), "vim status");
  if (raw) await showRaw(page);
  const want = parse(start);
  const shown = await hub.show(file);
  assert.equal(shown.text, want.bytes, `${file} bytes`);
  await place(page, want.focus);
  const status = await page.eval(`document.querySelector("span.md-vim-status").textContent`);
  assert.equal(status, "N", `status ${status} after placing ${start}`);
  return shown.rev;
}

// A span is one press per character. A comma separates presses.
async function keys(page, script) {
  for (const part of script.split(",")) {
    const token = part.trim();
    const names = token === "Backspace" || token === "Delete" ? [token] : [...token];
    for (const name of names) {
      await page.key(name);
      await page.quiet();
    }
  }
}

async function point(page, offset) {
  const at = await page.eval(`window.__qaClickPoint(${offset})`);
  assert.ok(at, `no click point at ${offset}`);
  return at;
}

test("VV.1 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t, "alpha\n");
  let rev = await begin(page, hub, "a.md", "al‸pha\n");
  await keys(page, "v");
  await expectMark(page, hub, "a.md", "al«p‸ha\n", "V", rev);

  rev = await begin(page, hub, "a.md", "al‸pha\n");
  await keys(page, "v, d");
  await expectMark(page, hub, "a.md", "al‸ha\n", "N", rev + 1);
});

test("VV.2 (ticket 7vdep2z4)", async (t) => {
  const start = "‸alpha beta gamma\n";
  const { hub, page } = await setup(t, "alpha beta gamma\n");
  let rev = await begin(page, hub, "a.md", start);
  await keys(page, "v, e");
  await expectMark(page, hub, "a.md", "«alpha‸ beta gamma\n", "V", rev);

  rev = await begin(page, hub, "a.md", start);
  await keys(page, "v, w");
  await expectMark(page, hub, "a.md", "«alpha b‸eta gamma\n", "V", rev);

  rev = await begin(page, hub, "a.md", start);
  await keys(page, "v, $");
  await expectMark(page, hub, "a.md", "«alpha beta gamma‸\n", "V", rev);
});

test("VV.3 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t, "alpha beta\n");
  const rev = await begin(page, hub, "a.md", "‸alpha beta\n");
  await keys(page, "v, e, d");
  await expectMark(page, hub, "a.md", "‸ beta\n", "N", rev + 1);
});

test("VV.4 (ticket 7vdep2z4)", async (t) => {
  const doc = "alpha beta\n";
  const { hub, page } = await setup(t, { "c.md": doc, "s.md": doc });
  let rev = await begin(page, hub, "c.md", "‸alpha beta\n");
  await keys(page, "v, e, c");
  await expectMark(page, hub, "c.md", "‸ beta\n", "I", rev + 1);

  rev = await begin(page, hub, "s.md", "‸alpha beta\n");
  await keys(page, "v, e, s");
  await expectMark(page, hub, "s.md", "‸ beta\n", "I", rev + 1);
});

test("VV.5 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t, "alpha beta\n");
  const rev = await begin(page, hub, "a.md", "‸alpha beta\n");
  await keys(page, "v, e, y");
  await expectMark(page, hub, "a.md", "‸alpha beta\n", "N", rev);
  await keys(page, "w, P");
  await expectMark(page, hub, "a.md", "alpha ‸alphabeta\n", "N", rev + 1);
});

test("VV.6 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t, "alpha beta\n");
  const start = "‸alpha beta\n";
  let rev = await begin(page, hub, "a.md", start);
  await keys(page, "v, e, o");
  await expectMark(page, hub, "a.md", "‸alpha« beta\n", "V", rev);

  rev = await begin(page, hub, "a.md", start);
  await keys(page, "v, e, O");
  const got = await expectMark(page, hub, "a.md", "‸alpha« beta\n", "V", rev);
  assert.ok(got.focus <= got.text.indexOf("\n"), detail(got));
});

test("VV.7 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t, { "up.md": "alpha beta\n", "low.md": "ALPHA beta\n" });
  let rev = await begin(page, hub, "up.md", "‸alpha beta\n");
  let undo = outbound(page, "undo");
  let redo = outbound(page, "redo");
  await keys(page, "v, e, U");
  await expectMark(page, hub, "up.md", "‸ALPHA beta\n", "N", rev + 1);
  assert.equal(outbound(page, "undo"), undo, "U sent an undo frame");
  assert.equal(outbound(page, "redo"), redo, "U sent a redo frame");

  rev = await begin(page, hub, "low.md", "‸ALPHA beta\n");
  undo = outbound(page, "undo");
  redo = outbound(page, "redo");
  await keys(page, "v, e, u");
  await expectMark(page, hub, "low.md", "‸alpha beta\n", "N", rev + 1);
  assert.equal(outbound(page, "undo"), undo, "u sent an undo frame");
  assert.equal(outbound(page, "redo"), redo, "u sent a redo frame");
});

test("VV.8 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t, "alpha beta\n");
  const rev = await begin(page, hub, "a.md", "‸alpha beta\n");
  await keys(page, "x");
  await expectMark(page, hub, "a.md", "‸lpha beta\n", "N", rev + 1);
  await keys(page, "x");
  await expectMark(page, hub, "a.md", "‸pha beta\n", "N", rev + 2);
  const undos = outbound(page, "undo");
  await page.key("z", ["Ctrl"]);
  await page.quiet();
  await expectMark(page, hub, "a.md", "‸lpha beta\n", "N", rev + 3);
  assert.equal(outbound(page, "undo"), undos + 1);

  await keys(page, "v");
  const before = await expectMark(page, hub, "a.md", "«l‸pha beta\n", "V", rev + 3);
  const redos = outbound(page, "redo");
  const edits = outbound(page, "edit");
  await page.key("r", ["Ctrl"]);
  await page.quiet();
  const held = await snap(page, hub, "a.md");
  assert.equal(held.picture, before.picture, detail(held));
  assert.equal(held.text, before.text, detail(held));
  assert.equal(held.rev, before.rev, detail(held));
  assert.equal(held.status, "V", detail(held));
  assert.equal(outbound(page, "redo"), redos, "Ctrl+R sent a redo frame");
  assert.equal(outbound(page, "edit"), edits, "Ctrl+R spliced");

  const undos2 = outbound(page, "undo");
  await page.key("z", ["Ctrl"]);
  await page.quiet();
  const undone = await snap(page, hub, "a.md");
  assert.equal(undone.text, "alpha beta\n", detail(undone));
  assert.equal(outbound(page, "undo"), undos2 + 1, "Ctrl+Z did not undo");

  const redos2 = outbound(page, "redo");
  await page.key("y", ["Ctrl"]);
  await page.quiet();
  const redone = await snap(page, hub, "a.md");
  assert.equal(redone.text, "lpha beta\n", detail(redone));
  assert.equal(outbound(page, "redo"), redos2 + 1, "Ctrl+Y did not redo");
});

test("VV.9 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t, {
    "rendered.md": "alpha\n\nbeta\n\ngamma\n",
    "raw.md": "alpha\nbeta\ngamma\n",
  });
  let rev = await begin(page, hub, "rendered.md", "alpha\n\nbe‸ta\n\ngamma\n");
  await keys(page, "V, d");
  await expectMark(page, hub, "rendered.md", "alpha\n\n‸gamma\n", "N", rev + 1);

  rev = await begin(page, hub, "raw.md", "alpha\nbe‸ta\ngamma\n", { raw: true });
  await keys(page, "V, d");
  await expectMark(page, hub, "raw.md", "alpha\n‸gamma\n", "N", rev + 1);
});

test("VV.10 (ticket 7vdep2z4)", async (t) => {
  const rendered = "alpha\n\nbeta\n\ngamma\n";
  const raw = "alpha\nbeta\ngamma\n";
  const { hub, page } = await setup(t, {
    "s.md": rendered,
    "r.md": rendered,
    "s-raw.md": raw,
    "r-raw.md": raw,
  });
  let rev = await begin(page, hub, "s.md", "alpha\n\nbe‸ta\n\ngamma\n");
  await keys(page, "V, S");
  await expectMark(page, hub, "s.md", "alpha\n\n‸\n\ngamma\n", "I", rev + 1);

  rev = await begin(page, hub, "r.md", "alpha\n\nbe‸ta\n\ngamma\n");
  await keys(page, "V, R");
  await expectMark(page, hub, "r.md", "alpha\n\n‸\n\ngamma\n", "I", rev + 1);

  rev = await begin(page, hub, "s-raw.md", "alpha\nbe‸ta\ngamma\n", { raw: true });
  await keys(page, "V, S");
  await expectMark(page, hub, "s-raw.md", "alpha\n‸\ngamma\n", "I", rev + 1);

  rev = await begin(page, hub, "r-raw.md", "alpha\nbe‸ta\ngamma\n", { raw: true });
  await keys(page, "V, R");
  await expectMark(page, hub, "r-raw.md", "alpha\n‸\ngamma\n", "I", rev + 1);
});

test("VV.11 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t, "alpha beta gamma\n");
  const rev = await begin(page, hub, "a.md", "alpha b‸eta gamma\n");
  await keys(page, "v, iw");
  await expectMark(page, hub, "a.md", "alpha «beta‸ gamma\n", "V", rev);
});

test("VV.12 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t, {
    "char.md": "alpha\n",
    "line.md": "alpha\n\nbeta\n",
    "to-char.md": "alpha\n\nbeta\n",
    "to-line.md": "alpha\n",
  });
  let rev = await begin(page, hub, "char.md", "al‸pha\n");
  await keys(page, "v, e, v");
  let got = await snap(page, hub, "char.md");
  assert.equal(got.text, "alpha\n", detail(got));
  assert.equal(got.anchor, got.focus, `not collapsed ${detail(got)}`);
  assert.equal(got.status, "N", detail(got));
  assert.equal(got.block, true, detail(got));
  assert.equal(got.rev, rev, detail(got));

  rev = await begin(page, hub, "line.md", "alpha\n\nbe‸ta\n");
  await keys(page, "V, V");
  got = await snap(page, hub, "line.md");
  assert.equal(got.text, "alpha\n\nbeta\n", detail(got));
  assert.equal(got.anchor, got.focus, `not collapsed ${detail(got)}`);
  assert.equal(got.status, "N", detail(got));
  assert.equal(got.block, true, detail(got));
  assert.equal(got.rev, rev, detail(got));

  rev = await begin(page, hub, "to-char.md", "alpha\n\nbe‸ta\n");
  await keys(page, "V, v");
  got = await snap(page, hub, "to-char.md");
  assert.equal(got.text, "alpha\n\nbeta\n", detail(got));
  assert.equal(got.status, "V", detail(got));
  assert.equal(got.block, true, detail(got));
  assert.notEqual(got.anchor, got.focus, `collapsed ${detail(got)}`);
  assert.equal(got.rev, rev, detail(got));

  rev = await begin(page, hub, "to-line.md", "al‸pha\n");
  await keys(page, "v, V");
  got = await snap(page, hub, "to-line.md");
  assert.equal(got.text, "alpha\n", detail(got));
  assert.equal(got.status, "VL", detail(got));
  assert.equal(got.block, true, detail(got));
  assert.notEqual(got.anchor, got.focus, `collapsed ${detail(got)}`);
  assert.equal(got.rev, rev, detail(got));
});

test("VV.13 (ticket 7vdep2z4)", async (t) => {
  const doc = "alpha beta\n";
  const { hub, page } = await setup(t, { "bs.md": doc, "del.md": doc, "x.md": doc });
  let rev = await begin(page, hub, "bs.md", "‸alpha beta\n");
  await keys(page, "v, e");
  const before = await expectMark(page, hub, "bs.md", "«alpha‸ beta\n", "V", rev);
  await page.key("Backspace");
  await page.quiet();
  const after = await snap(page, hub, "bs.md");
  assert.equal(after.text, before.text, detail(after));
  assert.equal(after.rev, rev, detail(after));
  assert.equal(after.status, "V", detail(after));
  assert.equal(after.block, true, detail(after));
  assert.notEqual(after.anchor, after.focus, `collapsed ${detail(after)}`);
  const beforeLo = Math.min(before.anchor, before.focus);
  const beforeHi = Math.max(before.anchor, before.focus);
  const afterLo = Math.min(after.anchor, after.focus);
  const afterHi = Math.max(after.anchor, after.focus);
  assert.ok(afterLo <= beforeLo && afterHi <= beforeHi && (afterLo < beforeLo || afterHi < beforeHi), `selection did not move left: ${before.picture} -> ${detail(after)}`);

  rev = await begin(page, hub, "del.md", "‸alpha beta\n");
  await keys(page, "v, e, Delete");
  await expectMark(page, hub, "del.md", "‸ beta\n", "N", rev + 1);

  rev = await begin(page, hub, "x.md", "‸alpha beta\n");
  await keys(page, "v, e, x");
  await expectMark(page, hub, "x.md", "‸ beta\n", "N", rev + 1);
});

test("VV.14 (ticket 7vdep2z4)", async (t) => {
  const line = "alpha beta gamma\n";
  const blocks = "alpha\n\nbeta\n\ngamma\n";
  const { hub, page } = await setup(t, {
    "drag.md": line,
    "word.md": line,
    "yank.md": "alpha beta\n",
    "line.md": blocks,
    "shift.md": line,
    "all.md": "alpha beta\n",
  });

  let rev = await begin(page, hub, "drag.md", "‸alpha beta gamma\n");
  const from = await point(page, 0);
  const to = await point(page, 8);
  await page.drag(from, to);
  await page.quiet();
  const dragged = await snap(page, hub, "drag.md");
  assert.equal(dragged.status, "V", detail(dragged));
  assert.equal(dragged.block, true, detail(dragged));
  assert.equal(dragged.text, line, detail(dragged));
  assert.equal(dragged.rev, rev, detail(dragged));
  assert.notEqual(dragged.anchor, dragged.focus, `collapsed ${detail(dragged)}`);
  const dragLo = Math.min(dragged.anchor, dragged.focus);
  const dragHi = Math.max(dragged.anchor, dragged.focus);
  assert.ok(dragLo < 8 && dragHi > 0, `drag selection missed the drag ${detail(dragged)}`);
  await page.key("d");
  await page.quiet();
  await expectMark(page, hub, "drag.md", show(line.slice(0, dragLo) + line.slice(dragHi), dragLo, dragLo), "N", rev + 1);

  rev = await begin(page, hub, "word.md", "alpha b‸eta gamma\n");
  const word = await point(page, 8);
  await page.click(word.x, word.y, { clickCount: 2 });
  await page.quiet();
  await expectMark(page, hub, "word.md", "alpha «beta‸ gamma\n", "V", rev);
  await page.key("c");
  await page.quiet();
  await expectMark(page, hub, "word.md", "alpha ‸ gamma\n", "I", rev + 1);

  rev = await begin(page, hub, "yank.md", "alpha ‸beta\n");
  const yanked = await point(page, 8);
  await page.click(yanked.x, yanked.y, { clickCount: 2 });
  await page.quiet();
  await expectMark(page, hub, "yank.md", "alpha «beta‸\n", "V", rev);
  await page.key("y");
  await page.quiet();
  await expectMark(page, hub, "yank.md", "alpha ‸beta\n", "N", rev);
  await page.key("P");
  await page.quiet();
  await expectMark(page, hub, "yank.md", "alpha ‸betabeta\n", "N", rev + 1);

  rev = await begin(page, hub, "line.md", "alpha\n\nbe‸ta\n\ngamma\n");
  const beta = await point(page, "alpha\n\nbe".length);
  await page.click(beta.x, beta.y, { clickCount: 3 });
  await page.quiet();
  await expectMark(page, hub, "line.md", "alpha\n\n«beta‸\n\ngamma\n", "VL", rev);
  await page.key("d");
  await page.quiet();
  await expectMark(page, hub, "line.md", "alpha\n\n‸gamma\n", "N", rev + 1);

  rev = await begin(page, hub, "shift.md", "‸alpha beta gamma\n");
  await keys(page, "v, e");
  await expectMark(page, hub, "shift.md", "«alpha‸ beta gamma\n", "V", rev);
  const at = "alpha beta ".length;
  const further = await point(page, at);
  await page.click(further.x, further.y, { modifiers: 8 });
  await page.quiet();
  const extended = await snap(page, hub, "shift.md");
  assert.equal(extended.status, "V", detail(extended));
  assert.equal(extended.block, true, detail(extended));
  assert.equal(extended.text, line, detail(extended));
  assert.equal(extended.rev, rev, detail(extended));
  const extLo = Math.min(extended.anchor, extended.focus);
  const extHi = Math.max(extended.anchor, extended.focus);
  assert.ok(extLo <= 0 && extHi >= at, `shift-click did not extend ${detail(extended)}`);
  await page.key("d");
  await page.quiet();
  await expectMark(page, hub, "shift.md", show(line.slice(0, extLo) + line.slice(extHi), extLo, extLo), "N", rev + 1);

  rev = await begin(page, hub, "all.md", "al‸pha beta\n");
  await page.key("a", ["Ctrl"]);
  await page.quiet();
  await expectMark(page, hub, "all.md", "«alpha beta\n‸", "VL", rev);
  await page.key("y");
  await page.quiet();
  await expectMark(page, hub, "all.md", "‸alpha beta\n", "N", rev);
  await page.key("P");
  await page.quiet();
  await expectMark(page, hub, "all.md", "‸alpha beta\nalpha beta\n", "N", rev + 1);
});
