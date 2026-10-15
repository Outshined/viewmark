import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "../harness.js";

// The flag is read once, when the editor is created. A later write does not turn keys on.
const VIM = "viewmark.vim";
const FOCUS = "‸";
const ANCHOR = "«";

function marked(text) {
  let doc = "";
  let focus = null;
  let anchor = null;
  for (const ch of text) {
    if (ch === FOCUS) {
      if (focus != null) throw new Error("two carets");
      focus = doc.length;
    } else if (ch === ANCHOR) {
      if (anchor != null) throw new Error("two anchors");
      anchor = doc.length;
    } else doc += ch;
  }
  if (focus == null) throw new Error(`no focus in ${JSON.stringify(text)}`);
  if (anchor == null) anchor = focus;
  return { doc, focus, anchor };
}

function insert(text, points) {
  const ordered = [...points].sort((a, b) => b.at - a.at);
  let out = text;
  for (const point of ordered) {
    const at = point.at < 0 ? 0 : point.at > out.length ? out.length : point.at;
    out = out.slice(0, at) + point.ch + out.slice(at);
  }
  return out;
}

function markedFrom(text, caret) {
  if (!caret || !Number.isInteger(caret.focus)) return `${text} [focus ${JSON.stringify(caret && caret.focus)}]`;
  const points = [{ at: caret.focus, ch: FOCUS }];
  if (!Number.isInteger(caret.anchor)) return `${insert(text, points)} [anchor ${JSON.stringify(caret.anchor)}]`;
  if (caret.anchor !== caret.focus) points.push({ at: caret.anchor, ch: ANCHOR });
  return insert(text, points);
}

function check(text) {
  const parsed = marked(text);
  assert.equal(markedFrom(parsed.doc, parsed), text);
  return parsed;
}

async function setup(t, files) {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  for (const [name, text] of Object.entries(files)) {
    if (text.includes(FOCUS) || text.includes(ANCHOR)) throw new Error(`caret marker in stored bytes of ${name}`);
    await hub.create(name, text);
  }
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  // Runs on the next document, before its scripts, so the editor is created with the flag on.
  await page.session.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `localStorage.setItem(${JSON.stringify(VIM)}, "1");`,
  });
  await page.login();
  return { hub, page };
}

function status(page) {
  return page.eval(`document.querySelector("span.md-vim-status").textContent`);
}

function sent(page, type) {
  return page.frames.filter((frame) => frame.dir === "out" && frame.data && frame.data.type === type).length;
}

async function showRaw(page) {
  await page.until(() => page.eval(`!!document.querySelector("button.md-view-toggle")`), "button.md-view-toggle");
  for (let n = 0; n < 4; n += 1) {
    if (await page.eval(`!!document.querySelector("#editor.md-source")`)) return;
    const point = await page.eval(`(() => {
      const button = document.querySelector("button.md-view-toggle");
      const rect = button.getBoundingClientRect();
      return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
    })()`);
    await page.click(point.x, point.y);
    await page.quiet();
  }
  assert.equal(await page.eval(`!!document.querySelector("#editor.md-source")`), true, "#editor.md-source");
}

async function place(page, offset) {
  assert.equal(await page.clickOffset(offset), true, `no point at ${offset}`);
  await page.quiet();
  const caret = await page.caret();
  assert.equal(caret.focus, offset, `placed focus ${caret.focus} ${caret.focusPath || ""}`);
  assert.equal(caret.anchor, offset, `placed anchor ${caret.anchor}`);
}

// A span is one press per character.
async function press(page, span) {
  for (const key of span) await page.key(key);
}

async function taken(hub, page, file) {
  await page.quiet();
  const shown = await hub.show(file);
  const caret = await page.caret();
  return { text: shown.text, rev: shown.rev, focus: caret.focus, anchor: caret.anchor, caret };
}

function assertTaken(got, text, rev, label) {
  const want = marked(text);
  const shown = markedFrom(got.text, got.caret || got);
  assert.equal(shown, text, `${label} got ${JSON.stringify(shown)}`);
  assert.equal(got.text, want.doc, `${label} got ${JSON.stringify(shown)}`);
  if (rev != null) assert.equal(got.rev, rev, `${label} rev ${got.rev} got ${JSON.stringify(shown)}`);
  assert.equal(got.focus, want.focus, `${label} focus got ${JSON.stringify(shown)}`);
  assert.equal(got.anchor, want.anchor, `${label} anchor got ${JSON.stringify(shown)}`);
}

async function command(page, hub, file, start, span, expect, { raw = false, mode, revDelta = 1 } = {}) {
  const from = check(start);
  check(expect);
  await page.open(file);
  assert.equal(await page.eval(`localStorage.getItem(${JSON.stringify(VIM)})`), "1");
  if (raw) await showRaw(page);
  await place(page, from.focus);
  assert.equal(await status(page), "N", `${file} before ${span}`);
  const before = await hub.show(file);
  assert.equal(before.text, from.doc, file);
  const edits = sent(page, "edit");
  await press(page, span);
  const got = await taken(hub, page, file);
  const label = `${file} ${span}`;
  assertTaken(got, expect, before.rev + revDelta, label);
  assert.equal(sent(page, "edit") - edits, revDelta === 0 ? 0 : 1, `${label} edits got ${JSON.stringify(markedFrom(got.text, got))}`);
  if (mode) assert.equal(await status(page), mode, `${label} status got ${JSON.stringify(markedFrom(got.text, got))}`);
  return got;
}

test("VI.1 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t, {
    "leave.md": check("al‸pha\n").doc,
    "mid.md": check("al‸pha\n").doc,
    "end.md": check("alpha‸\n").doc,
  });
  await command(page, hub, "leave.md", "al‸pha\n", "i", "al‸pha\n", { mode: "I", revDelta: 0 });
  await command(page, hub, "mid.md", "al‸pha\n", "ax", "alpx‸ha\n", { mode: "I" });
  await command(page, hub, "end.md", "alpha‸\n", "ax", "alphax‸\n", { mode: "I" });
});

test("VI.2 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t, {
    "line.md": check("  al‸pha\n").doc,
    "col.md": check("  al‸pha\n").doc,
    "end.md": check("al‸pha beta\n").doc,
  });
  await command(page, hub, "line.md", "  al‸pha\n", "Ix", "  x‸alpha\n", { mode: "I" });
  await command(page, hub, "col.md", "  al‸pha\n", "gIx", "x‸  alpha\n", { mode: "I" });
  await command(page, hub, "end.md", "al‸pha beta\n", "Ax", "alpha betax‸\n", { mode: "I" });
});

test("VI.3 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t, {
    "item.md": check("- al‸pha\n").doc,
    "head.md": check("# Ti‸tle\n").doc,
  });
  await command(page, hub, "item.md", "- al‸pha\n", "Ix", "x‸- alpha\n", { mode: "I" });
  await command(page, hub, "head.md", "# Ti‸tle\n", "Ix", "x‸# Title\n", { mode: "I" });
});

test("VI.4 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t, {
    "break.md": check("r‸ed  \nblue\n").doc,
  });
  await command(page, hub, "break.md", "r‸ed  \nblue\n", "Ax", "redx‸  \nblue\n", { mode: "I" });
});

test("VI.5 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t, {
    "word.md": check("‸alpha beta\n").doc,
  });
  await command(page, hub, "word.md", "‸alpha beta\n", "diw", "‸ beta\n", { mode: "N" });
});

test("VI.6 (ticket 7vdep2z4)", async (t) => {
  const start = "al‸pha\nbeta\n";
  const { hub, page } = await setup(t, {
    "below.md": check(start).doc,
    "above.md": check(start).doc,
    "three.md": check(start).doc,
    "three-above.md": check(start).doc,
  });
  await command(page, hub, "below.md", start, "o", "alpha\n‸\nbeta\n", { raw: true, mode: "I" });
  await command(page, hub, "above.md", start, "O", "‸\nalpha\nbeta\n", { raw: true, mode: "I" });
  await command(page, hub, "three.md", start, "3o", "alpha\n\n\n‸\nbeta\n", { raw: true, mode: "I" });
  await command(page, hub, "three-above.md", start, "3O", "\n\n‸\nalpha\nbeta\n", { raw: true, mode: "I" });
});

test("VI.7 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t, {
    "plain.md": check("al‸pha\n").doc,
    "item.md": check("- al‸pha\n").doc,
    "head.md": check("# Ti‸tle\n").doc,
    "ordered.md": check("1. al‸pha\n2. beta\n").doc,
  });
  await command(page, hub, "plain.md", "al‸pha\n", "o", "alpha\n\n‸\n", { mode: "I" });
  await command(page, hub, "item.md", "- al‸pha\n", "o", "- alpha\n\n‸\n", { mode: "I" });
  await command(page, hub, "head.md", "# Ti‸tle\n", "o", "# Title\n\n‸\n", { mode: "I" });
  // The opened block sits between the item and the next item, with no marker, and 2. stays 2.
  await command(page, hub, "ordered.md", "1. al‸pha\n2. beta\n", "o", "1. alpha\n\n‸\n2. beta\n", { mode: "I" });
});

test("VI.8 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t, {
    "count.md": check("al‸pha\n").doc,
  });
  await command(page, hub, "count.md", "al‸pha\n", "3o", "alpha\n\n\n\n‸\n", { mode: "I" });
  // Escape leaves Insert. One u undoes the whole count.
  const opened = await hub.show("count.md");
  const edits = sent(page, "edit");
  const undos = sent(page, "undo");
  await page.key("Escape");
  await page.quiet();
  assert.equal(await status(page), "N");
  assert.equal((await hub.show("count.md")).text, opened.text);
  assert.equal((await hub.show("count.md")).rev, opened.rev);
  await page.key("u");
  const got = await taken(hub, page, "count.md");
  assertTaken(got, "al‸pha\n", null, "u");
  assert.equal(sent(page, "edit"), edits, "u sent an edit");
  assert.equal(sent(page, "undo") - undos, 1, "u");
  assert.equal(await status(page), "N", `u status got ${JSON.stringify(markedFrom(got.text, got))}`);
});

test("VI.9 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t, {
    "above.md": check("al‸pha\n").doc,
  });
  await command(page, hub, "above.md", "al‸pha\n", "O", "‸\n\nalpha\n", { mode: "I" });
});

test("VI.10 (ticket 7vdep2z4)", async (t) => {
  const start = "al‸pha\nbeta\n";
  const { hub, page } = await setup(t, {
    "below.md": check(start).doc,
    "above.md": check(start).doc,
  });
  await command(page, hub, "below.md", start, "o", "alpha\nbeta\n\n‸\n", { mode: "I" });
  await command(page, hub, "above.md", start, "O", "‸\n\nalpha\nbeta\n", { mode: "I" });
});
