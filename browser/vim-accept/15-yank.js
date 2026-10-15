import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "../harness.js";

// The flag is read once, when the editor is created. A later write does not turn keys on.
const VIM = "viewmark.vim";
const CLIP = "PASTE";

function marked(text) {
  let doc = "";
  let focus = null;
  let anchor = null;
  for (const ch of text) {
    if (ch === "‸") {
      if (focus != null) throw new Error("two carets");
      focus = doc.length;
    } else if (ch === "«") {
      if (anchor != null) throw new Error("two anchors");
      anchor = doc.length;
    } else doc += ch;
  }
  if (focus == null) throw new Error(`missing caret in ${JSON.stringify(text)}`);
  return { doc, focus, anchor };
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

async function showRaw(page) {
  for (let n = 0; n < 4; n += 1) {
    if (await page.eval(`document.querySelector("#editor.md-source") !== null`)) return;
    const point = await page.eval(`(() => {
      const button = document.querySelector("button.md-view-toggle");
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
    })()`);
    assert.ok(point, "no view toggle");
    await page.click(point.x, point.y);
    await page.quiet();
  }
  assert.ok(await page.eval(`document.querySelector("#editor.md-source") !== null`), "the raw view");
}

async function keys(page, ...names) {
  for (const name of names) await page.key(name);
  await page.quiet();
}

async function openMarked(hub, page, file, text, raw) {
  const start = marked(text);
  await hub.create(file, start.doc);
  await page.open(file);
  assert.equal(await page.eval(`localStorage.getItem(${JSON.stringify(VIM)})`), "1");
  if (raw) await showRaw(page);
  assert.equal(await page.clickOffset(start.focus), true, `${file} has no point at ${start.focus}`);
  await page.quiet();
  const caret = await page.caret();
  assert.equal(caret.focus, start.focus, `${file} focus`);
  assert.equal(await page.eval(`document.querySelector(".md-vim-status").textContent`), "N");
  const shown = await hub.show(file);
  assert.equal(shown.text, start.doc, file);
  return { doc: start.doc, focus: start.focus, rev: shown.rev };
}

async function unchanged(hub, file, snap) {
  const shown = await hub.show(file);
  assert.equal(shown.text, snap.doc, file);
  assert.equal(shown.rev, snap.rev, `${file} rev`);
  return shown;
}

async function expectMarked(hub, page, file, text, rev) {
  const want = marked(text);
  const shown = await hub.show(file);
  assert.equal(shown.text, want.doc, file);
  assert.equal(shown.rev, rev, `${file} rev`);
  const caret = await page.caret();
  assert.equal(caret.focus, want.focus, `${file} focus`);
  if (want.anchor != null) assert.equal(caret.anchor, want.anchor, `${file} anchor`);
  return shown;
}

async function expectBytes(hub, file, text, rev) {
  const shown = await hub.show(file);
  assert.equal(shown.text, text, file);
  assert.equal(shown.rev, rev, `${file} rev`);
  return shown;
}

test("VY.1 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t);
  const errors = [];
  async function part(label, fn) {
    try {
      await fn();
    } catch (err) {
      errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await part("yy", async () => {
    const yy = await openMarked(hub, page, "vy1-yy.md", "‸alpha\n\nbeta\n", false);
    await keys(page, "y", "y");
    await unchanged(hub, "vy1-yy.md", yy);
    await keys(page, "p");
    await expectMarked(hub, page, "vy1-yy.md", "alpha\n\n‸alpha\n\nbeta\n", yy.rev + 1);
  });

  await part("Y", async () => {
    const upper = await openMarked(hub, page, "vy1-Y.md", "‸alpha\n\nbeta\n", false);
    await keys(page, "Y");
    await unchanged(hub, "vy1-Y.md", upper);
    await keys(page, "p");
    await expectMarked(hub, page, "vy1-Y.md", "alpha\n\n‸alpha\n\nbeta\n", upper.rev + 1);
  });

  await part("P", async () => {
    const before = await openMarked(hub, page, "vy1-P.md", "‸alpha\n\nbeta\n", false);
    await keys(page, "y", "y");
    await unchanged(hub, "vy1-P.md", before);
    await keys(page, "P");
    await expectMarked(hub, page, "vy1-P.md", "‸alpha\nalpha\n\nbeta\n", before.rev + 1);
  });

  await part("raw", async () => {
    const raw = await openMarked(hub, page, "vy1-raw.md", "‸alpha\nbeta\n", true);
    await keys(page, "y", "y");
    await unchanged(hub, "vy1-raw.md", raw);
    await keys(page, "p");
    await expectMarked(hub, page, "vy1-raw.md", "alpha\n‸alpha\nbeta\n", raw.rev + 1);
  });

  assert.deepEqual(errors, []);
});

test("VY.2 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t);
  const file = "vy2.md";
  const snap = await openMarked(hub, page, file, "‸one\ntwo\n", false);
  await keys(page, "d", "d");
  await expectBytes(hub, file, "", snap.rev + 1);
  await keys(page, "p");
  await expectMarked(hub, page, file, "‸one\ntwo\n", snap.rev + 2);
});

test("VY.3 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t);
  const file = "vy3.md";
  const snap = await openMarked(hub, page, file, "alpha\n‸beta", false);
  await keys(page, "y", "y");
  await unchanged(hub, file, snap);
  await keys(page, "k");
  await unchanged(hub, file, snap);
  await keys(page, "p");
  await expectMarked(hub, page, file, "alpha\nbeta\n‸alpha\nbeta\n", snap.rev + 1);
});

test("VY.4 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t);
  const file = "vy4.md";
  const snap = await openMarked(hub, page, file, "‸  alpha\n", false);
  await keys(page, "y", "y");
  await unchanged(hub, file, snap);
  await keys(page, "p");
  await expectMarked(hub, page, file, "  alpha\n  ‸alpha\n", snap.rev + 1);
});

test("VY.5 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t);

  const word = await openMarked(hub, page, "vy5-P.md", "‸alpha beta\n", false);
  await keys(page, "y", "w");
  await unchanged(hub, "vy5-P.md", word);
  await keys(page, "w");
  await unchanged(hub, "vy5-P.md", word);
  await keys(page, "P");
  await expectMarked(hub, page, "vy5-P.md", "alpha ‸alpha beta\n", word.rev + 1);

  const cut = await openMarked(hub, page, "vy5-p.md", "‸ab\n", false);
  await keys(page, "x");
  await expectBytes(hub, "vy5-p.md", "b\n", cut.rev + 1);
  await keys(page, "p");
  await expectMarked(hub, page, "vy5-p.md", "b‸a\n", cut.rev + 2);
});

test("VY.6 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t);
  const file = "vy6.md";
  const snap = await openMarked(hub, page, file, "‸alpha\n", false);
  await page.session.send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"], origin: `http://127.0.0.1:${hub.port}` });
  const wrote = await page.session.send("Runtime.evaluate", { expression: `navigator.clipboard.writeText(${JSON.stringify(CLIP)})`, awaitPromise: true, userGesture: true, returnByValue: true });
  if (wrote.exceptionDetails) throw new Error(wrote.exceptionDetails.text);
  await keys(page, "y", "y");
  await unchanged(hub, file, snap);
  const held = await page.session.send("Runtime.evaluate", { expression: "navigator.clipboard.readText()", awaitPromise: true, userGesture: true, returnByValue: true });
  if (held.exceptionDetails) throw new Error(held.exceptionDetails.text);
  assert.equal(held.result.value, CLIP);
  await page.key("v", ["Ctrl"]);
  await page.quiet();
  await expectBytes(hub, file, `${CLIP}alpha\n`, snap.rev + 1);
});

test("VY.7 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t);
  const file = "vy7.md";
  const snap = await openMarked(hub, page, file, "‸alpha\n\nbeta\n", false);
  await keys(page, "y", "y");
  await unchanged(hub, file, snap);
  await keys(page, "p");
  const filled = await expectMarked(hub, page, file, "alpha\n\n‸alpha\n\nbeta\n", snap.rev + 1);
  const reloaded = page.frames.length;
  await page.session.send("Page.reload");
  await page.until(() => page.frames.slice(reloaded).some((frame) => frame.dir === "in" && frame.data && frame.data.type === "file"), "reload");
  await page.quiet();
  assert.equal(await page.eval(`localStorage.getItem(${JSON.stringify(VIM)})`), "1");
  assert.equal(await page.clickOffset(0), true, "no point after reload");
  await page.quiet();
  assert.equal(await page.eval(`document.querySelector(".md-vim-status").textContent`), "N");
  const again = await hub.show(file);
  assert.equal(again.text, filled.text);
  assert.equal(again.rev, filled.rev);
  await keys(page, "p");
  await expectBytes(hub, file, again.text, again.rev);
  await keys(page, "P");
  await expectBytes(hub, file, again.text, again.rev);
});

test("VY.8 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t);

  const forward = await openMarked(hub, page, "vy8-w.md", "al‸pha beta\n", false);
  await keys(page, "y", "w");
  await unchanged(hub, "vy8-w.md", forward);
  assert.equal((await page.caret()).focus, forward.focus);

  const back = await openMarked(hub, page, "vy8-b.md", "alpha be‸ta\n", false);
  await keys(page, "y", "b");
  await expectMarked(hub, page, "vy8-b.md", "alpha ‸beta\n", back.rev);
});

test("VJ.1 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t);
  const file = "vj1.md";
  const snap = await openMarked(hub, page, file, "al‸pha\nbeta\n", true);
  await keys(page, "J");
  await expectMarked(hub, page, file, "alpha‸ beta\n", snap.rev + 1);
});

test("VJ.2 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t);
  const file = "vj2.md";
  const snap = await openMarked(hub, page, file, "al‸pha \nbeta\n", false);
  await keys(page, "J");
  await expectBytes(hub, file, "alpha beta\n", snap.rev + 1);
});

test("VJ.3 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t);
  const file = "vj3.md";
  const snap = await openMarked(hub, page, file, "on‸e\n\ntwo\n", false);
  await keys(page, "J");
  await expectMarked(hub, page, file, "one‸two\n", snap.rev + 1);
});

test("VJ.4 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t);
  const file = "vj4.md";
  const snap = await openMarked(hub, page, file, "al‸pha\nbeta\n", true);
  await keys(page, "g", "J");
  await expectMarked(hub, page, file, "alpha‸beta\n", snap.rev + 1);
});

test("VJ.5 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t);

  const raw = await openMarked(hub, page, "vj5-raw.md", "‸a\nb\nc\nd\n", true);
  await keys(page, "3", "J");
  await expectMarked(hub, page, "vj5-raw.md", "a b‸ c\nd\n", raw.rev + 1);

  const rendered = await openMarked(hub, page, "vj5.md", "‸a\n\nb\n\nc\n\nd\n", false);
  await keys(page, "3", "J");
  await expectMarked(hub, page, "vj5.md", "ab‸c\n\nd\n", rendered.rev + 1);
});
