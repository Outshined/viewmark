import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "../harness.js";

// The flag is read once, when the editor is created. A later write does not turn keys on.
const VIM = "viewmark.vim";
const CM = "\n\n```comment c1\n:: 0\n@2026-10-05T16:00:00.000Z Ada\nNote.\n```\n";
const SEE = "See {c1}this{/c1} now.";

async function setup(t, files) {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  for (const [file, text] of Object.entries(files)) await hub.create(file, text);
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.session.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `localStorage.setItem(${JSON.stringify(VIM)}, "1");`,
  });
  await page.login();
  return { hub, page };
}

function editFrames(page, since) {
  return page.frames.slice(since).filter((frame) => frame.dir === "out" && frame.data && frame.data.type === "edit");
}

function errorFrames(page, since) {
  return page.frames.slice(since).filter((frame) => frame.dir === "in" && frame.data && frame.data.type === "error");
}

function vimStatus(page) {
  return page.eval(`document.querySelector(".md-vim-status") && document.querySelector(".md-vim-status").textContent`);
}

// Click the raw toggle until the editor draws source. The caret is placed after that.
async function showRaw(page) {
  for (let i = 0; i < 4; i += 1) {
    if (await page.eval(`document.getElementById("editor").classList.contains("md-source")`)) return;
    const point = await page.eval(`(() => {
      const button = document.querySelector("button.md-view-toggle");
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
    })()`);
    assert.ok(point, "no button.md-view-toggle");
    await page.click(point.x, point.y);
    await page.quiet();
  }
  assert.equal(await page.eval(`document.querySelector("#editor.md-source") != null`), true, "#editor.md-source");
}

async function openPlaced(page, file, offset, raw = false) {
  await page.open(file);
  assert.equal(await page.eval(`localStorage.getItem(${JSON.stringify(VIM)})`), "1");
  if (raw) await showRaw(page);
  else assert.equal(await page.eval(`document.getElementById("editor").classList.contains("md-source")`), false);
  assert.equal(await page.clickOffset(offset), true, `${file}: no point at ${offset}`);
  await page.quiet();
  const caret = await page.caret();
  assert.equal(caret.focus, offset, `${file}: focus ${caret.focus} at ${caret.focusPath}`);
  assert.equal(caret.anchor, offset, `${file}: anchor ${caret.anchor}`);
  assert.equal(await vimStatus(page), "N");
  return caret;
}

async function press(page, keys) {
  for (const key of keys) await page.key(key);
  await page.quiet();
}

function detail(label, after, caret, status, edits, errors) {
  const sent = edits.map((frame) => frame.data);
  const failed = errors.map((frame) => frame.data);
  return `${label}: text ${JSON.stringify(after.text)} caret ${caret && caret.focus}/${caret && caret.anchor} rev ${after.rev} status ${JSON.stringify(status)} edits ${JSON.stringify(sent)} errors ${JSON.stringify(failed)}`;
}

// rev is how many revisions this command adds. same is 0: bytes, caret, and rev stay.
async function command(hub, page, file, keys, expect) {
  const since = page.frames.length;
  const before = await hub.show(file);
  await press(page, keys);
  const after = await hub.show(file);
  const caret = await page.caret();
  const edits = editFrames(page, since);
  const errors = errorFrames(page, since);
  const status = await vimStatus(page);
  const got = detail(expect.label, after, caret, status, edits, errors);
  assert.equal(after.text, expect.text, got);
  assert.equal(after.rev, before.rev + expect.rev, got);
  assert.equal(caret.focus, expect.focus, got);
  assert.equal(caret.anchor, expect.anchor == null ? expect.focus : expect.anchor, got);
  assert.equal(status, expect.status, got);
  if (expect.frames) expect.frames(edits, got);
  return { after, edits, got };
}

function oneOp(op, text) {
  return (edits, got) => {
    assert.equal(edits.length, 1, got);
    assert.equal(edits[0].data.op, op, got);
    if (text !== undefined) assert.equal(edits[0].data.text, text, got);
  };
}

function noFrames(edits, got) {
  assert.equal(edits.length, 0, got);
}

function pairedBreaks(text, got) {
  if (typeof text !== "string") return;
  const rest = text.replaceAll("\r\n", "");
  assert.equal(rest.includes("\r"), false, got);
  assert.equal(rest.includes("\n"), false, got);
}

// A character press stops on a comment marker, so l cannot cross it. The span is the
// same drag the matrix uses, and the mouseup enters Visual from that selection.
async function visualSpan(page, anchor, focus) {
  assert.equal(await page.clickOffset(anchor), true, `no point at ${anchor}`);
  await page.quiet();
  const from = await page.eval(`window.__qaClickPoint(${anchor})`);
  const to = await page.eval(`window.__qaClickPoint(${focus})`);
  assert.ok(from && to, `no span from ${anchor} to ${focus}`);
  await page.drag(from, to);
  await page.quiet();
  const caret = await page.caret();
  assert.equal(caret.anchor, anchor, `visual anchor ${caret.anchor} focus ${caret.focus} at ${caret.focusPath}`);
  assert.equal(caret.focus, focus, `visual focus ${caret.focus} anchor ${caret.anchor} at ${caret.focusPath}`);
  assert.equal(await vimStatus(page), "V");
}

test("VO.13 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t, {
    "mid.md": "alpha\n",
    "end.md": "one\n\ntwo\n",
  });
  await openPlaced(page, "mid.md", "al".length);
  await command(hub, page, "mid.md", ["x"], {
    label: "VO.13",
    text: "alha\n",
    focus: "al".length,
    rev: 1,
    status: "N",
    frames: oneOp("delete"),
  });
  // x stops before the line's newline (R119, qvqa6h7q), so x past one's last character writes
  // nothing.
  await openPlaced(page, "end.md", "one".length);
  await command(hub, page, "end.md", ["x"], {
    label: "VO.13",
    text: "one\n\ntwo\n",
    focus: "one".length,
    rev: 0,
    status: "N",
    frames: noFrames,
  });
});

test("VO.14 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t, {
    "three.md": "alpha\n",
    "five.md": "alpha\n",
    "end.md": "alpha\n",
  });
  await openPlaced(page, "three.md", "al".length);
  await command(hub, page, "three.md", ["3", "x"], {
    label: "VO.14",
    text: "al\n",
    focus: "al".length,
    rev: 1,
    status: "N",
    frames: oneOp("insert", ""),
  });
  await openPlaced(page, "five.md", "al".length);
  await command(hub, page, "five.md", ["5", "x"], {
    label: "VO.14",
    text: "al\n",
    focus: "al".length,
    rev: 1,
    status: "N",
    frames: oneOp("insert", ""),
  });
  await openPlaced(page, "end.md", "alpha".length);
  await command(hub, page, "end.md", ["3", "x"], {
    label: "VO.14",
    text: "alpha\n",
    focus: "alpha".length,
    rev: 0,
    status: "N",
    frames: noFrames,
  });
});

test("VO.15 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t, {
    "mid.md": "alpha\n",
    "gap.md": "one\n\ntwo\n",
    "three.md": "alpha\n",
    "short.md": "alpha\n",
  });
  await openPlaced(page, "mid.md", "al".length);
  await command(hub, page, "mid.md", ["X"], {
    label: "VO.15",
    text: "apha\n",
    focus: "a".length,
    rev: 1,
    status: "N",
    frames: oneOp("backspace"),
  });
  // X never deletes a line break (R119, qvqa6h7q), so X at two's start writes nothing.
  await openPlaced(page, "gap.md", "one\n\n".length);
  await command(hub, page, "gap.md", ["X"], {
    label: "VO.15",
    text: "one\n\ntwo\n",
    focus: "one\n\n".length,
    rev: 0,
    status: "N",
    frames: noFrames,
  });
  await openPlaced(page, "three.md", "alp".length);
  await command(hub, page, "three.md", ["3", "X"], {
    label: "VO.15",
    text: "ha\n",
    focus: 0,
    rev: 1,
    status: "N",
    frames: oneOp("insert", ""),
  });
  await openPlaced(page, "short.md", "al".length);
  await command(hub, page, "short.md", ["3", "X"], {
    label: "VO.15",
    text: "pha\n",
    focus: 0,
    rev: 1,
    status: "N",
    frames: oneOp("insert", ""),
  });
});

test("VO.16 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t, {
    "one.md": "alpha\n",
    "three.md": "alpha\n",
  });
  await openPlaced(page, "one.md", "al".length);
  await command(hub, page, "one.md", ["s"], {
    label: "VO.16",
    text: "alha\n",
    focus: "al".length,
    rev: 1,
    status: "I",
    frames: oneOp("insert", ""),
  });
  await openPlaced(page, "three.md", "al".length);
  await command(hub, page, "three.md", ["3", "s"], {
    label: "VO.16",
    text: "al\n",
    focus: "al".length,
    rev: 1,
    status: "I",
    frames: oneOp("insert", ""),
  });
});

test("VO.17 (ticket 7vdep2z4)", async (t) => {
  const mid = "one\n\ntwo\n\nthree\n";
  const para = "alpha\nbeta\n";
  const raw = "alpha\nbeta\ngamma\n";
  const { hub, page } = await setup(t, {
    "cc.md": mid,
    "s.md": mid,
    "para-cc.md": para,
    "para-s.md": para,
    "raw-cc.md": raw,
    "raw-s.md": raw,
  });
  const emptied = "one\n\n\n\nthree\n";
  const atTwo = "one\n\nt".length;
  const onEmpty = "one\n\n".length;
  await openPlaced(page, "cc.md", atTwo);
  await command(hub, page, "cc.md", ["c", "c"], {
    label: "VO.17",
    text: emptied,
    focus: onEmpty,
    rev: 1,
    status: "I",
    frames: oneOp("insert"),
  });
  await openPlaced(page, "s.md", atTwo);
  await command(hub, page, "s.md", ["S"], {
    label: "VO.17",
    text: emptied,
    focus: onEmpty,
    rev: 1,
    status: "I",
    frames: oneOp("insert"),
  });
  await openPlaced(page, "para-cc.md", "al".length);
  await command(hub, page, "para-cc.md", ["c", "c"], {
    label: "VO.17",
    text: "\n",
    focus: 0,
    rev: 1,
    status: "I",
    frames: oneOp("insert"),
  });
  await openPlaced(page, "para-s.md", "al".length);
  await command(hub, page, "para-s.md", ["S"], {
    label: "VO.17",
    text: "\n",
    focus: 0,
    rev: 1,
    status: "I",
    frames: oneOp("insert"),
  });
  const rawAt = "alpha\nbe".length;
  const rawCaret = "alpha\n".length;
  await openPlaced(page, "raw-cc.md", rawAt, true);
  await command(hub, page, "raw-cc.md", ["c", "c"], {
    label: "VO.17",
    text: "alpha\n\ngamma\n",
    focus: rawCaret,
    rev: 1,
    status: "I",
    frames: oneOp("insert"),
  });
  await openPlaced(page, "raw-s.md", rawAt, true);
  await command(hub, page, "raw-s.md", ["S"], {
    label: "VO.17",
    text: "alpha\n\ngamma\n",
    focus: rawCaret,
    rev: 1,
    status: "I",
    frames: oneOp("insert"),
  });
});

test("VO.18 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t, { "a.md": "ab\n" });
  await openPlaced(page, "a.md", 0);
  await command(hub, page, "a.md", ["x"], {
    label: "VO.18",
    text: "b\n",
    focus: 0,
    rev: 1,
    status: "N",
    frames: oneOp("delete"),
  });
  await command(hub, page, "a.md", ["d", "h"], {
    label: "VO.18",
    text: "b\n",
    focus: 0,
    rev: 0,
    status: "N",
    frames: noFrames,
  });
  await command(hub, page, "a.md", ["P"], {
    label: "VO.18",
    text: "ab\n",
    focus: 0,
    rev: 1,
    status: "N",
    frames: oneOp("insert"),
  });
});

test("VO.19 (ticket 7vdep2z4)", async (t) => {
  const body = SEE + CM;
  const { hub, page } = await setup(t, {
    "x.md": body,
    "back.md": body,
    "visual.md": body,
  });
  await openPlaced(page, "x.md", "See {c1}this".length);
  await command(hub, page, "x.md", ["x"], {
    label: "VO.19a",
    text: "See {c1}this{/c1}now." + CM,
    focus: "See {c1}this".length,
    rev: 1,
    status: "N",
    frames: oneOp("delete"),
  });
  await openPlaced(page, "back.md", "See {c1}".length);
  await command(hub, page, "back.md", ["X"], {
    label: "VO.19b",
    text: "See{c1}this{/c1} now." + CM,
    focus: "See{c1}".length,
    rev: 1,
    status: "N",
    frames: oneOp("backspace"),
  });
  await page.open("visual.md");
  assert.equal(await page.eval(`localStorage.getItem(${JSON.stringify(VIM)})`), "1");
  await visualSpan(page, 0, "See {c1}th".length);
  await command(hub, page, "visual.md", ["d"], {
    label: "VO.19c",
    text: "{c1}is{/c1} now." + CM,
    focus: 0,
    rev: 1,
    status: "N",
    frames: oneOp("insert", "{c1}"),
  });
});

test("VO.20 (ticket 7vdep2z4)", async (t) => {
  const { hub, page } = await setup(t, {
    "x.md": "alpha\n",
    "back.md": "alpha\n",
    "sub.md": "alpha\n",
    "line.md": "alpha\nbeta\ngamma\n",
  });
  const rawEdit = (edits, got) => {
    assert.ok(edits.length >= 1, got);
    for (const frame of edits) assert.equal(frame.data.raw, true, got);
  };
  await openPlaced(page, "x.md", "al".length, true);
  await command(hub, page, "x.md", ["x"], {
    label: "VO.20",
    text: "alha\n",
    focus: "al".length,
    rev: 1,
    status: "N",
    frames: rawEdit,
  });
  await openPlaced(page, "back.md", "al".length, true);
  await command(hub, page, "back.md", ["X"], {
    label: "VO.20",
    text: "apha\n",
    focus: "a".length,
    rev: 1,
    status: "N",
    frames: rawEdit,
  });
  await openPlaced(page, "sub.md", "al".length, true);
  await command(hub, page, "sub.md", ["s"], {
    label: "VO.20",
    text: "alha\n",
    focus: "al".length,
    rev: 1,
    status: "I",
    frames: rawEdit,
  });
  await openPlaced(page, "line.md", "alpha\nbe".length, true);
  await command(hub, page, "line.md", ["c", "c"], {
    label: "VO.20",
    text: "alpha\n\ngamma\n",
    focus: "alpha\n".length,
    rev: 1,
    status: "I",
    frames: rawEdit,
  });
});

test("VO.21 (ticket 7vdep2z4)", async (t) => {
  const lines = "alpha\r\nbeta\r\n";
  const { hub, page } = await setup(t, {
    "dd.md": lines,
    "open.md": lines,
    "replace.md": "alpha\r\n",
  });
  const failures = [];
  const check = async (fn) => {
    try {
      await fn();
    } catch (err) {
      failures.push(err);
    }
  };
  await check(async () => {
    await openPlaced(page, "dd.md", "al".length);
    const deleted = await command(hub, page, "dd.md", ["d", "d"], {
      label: "VO.21 dd",
      text: "",
      focus: 0,
      rev: 1,
      status: "N",
      frames: oneOp("insert"),
    });
    pairedBreaks(deleted.after.text, deleted.got);
    for (const frame of deleted.edits) pairedBreaks(frame.data.text, deleted.got);
  });
  await check(async () => {
    await openPlaced(page, "open.md", "al".length, true);
    const opened = await command(hub, page, "open.md", ["o"], {
      label: "VO.21 o",
      text: "alpha\r\n\r\nbeta\r\n",
      focus: "alpha\r\n".length,
      rev: 1,
      status: "I",
      frames: (edits, got) => {
        oneOp("insert", "\r\n")(edits, got);
        assert.equal(edits[0].data.raw, true, got);
      },
    });
    pairedBreaks(opened.after.text, opened.got);
  });
  await check(async () => {
    await openPlaced(page, "replace.md", "al".length);
    const replaced = await command(hub, page, "replace.md", ["r", "Enter"], {
      label: "VO.21 r",
      text: "al\r\nha\r\n",
      focus: "al\r\n".length,
      rev: 1,
      status: "N",
      frames: oneOp("insert", "\r\n"),
    });
    pairedBreaks(replaced.after.text, replaced.got);
  });
  if (failures.length) throw new Error(failures.map((err) => err.message).join("\n\n"));
});
