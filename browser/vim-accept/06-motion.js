import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "../harness.js";

// The flag is read once, when the editor is created. A later write does not turn keys on.
const FILE = "a.md";
const VIM = "viewmark.vim";
const TICKET = "7vdep2z4";
const LONG = ("alpha beta gamma delta ".repeat(15)) + "end";
const FOCUS = "‸";
const ANCHOR = "«";

const CTRL_N = { key: "n", mods: ["Ctrl"] };
const CTRL_P = { key: "p", mods: ["Ctrl"] };
const CTRL_SPACE = { key: " ", mods: ["Ctrl"] };
const CTRL_BACKSPACE = { key: "Backspace", mods: ["Ctrl"] };
const SHIFT_SPACE = { key: " ", mods: ["Shift"] };
const SHIFT_BACKSPACE = { key: "Backspace", mods: ["Shift"] };

function marked(text) {
  let doc = "";
  let focus = null;
  let anchor = null;
  for (const ch of text) {
    if (ch === FOCUS) focus = doc.length;
    else if (ch === ANCHOR) anchor = doc.length;
    else doc += ch;
  }
  if (focus == null) throw new Error(`missing caret in ${JSON.stringify(text)}`);
  if (anchor == null) anchor = focus;
  return { doc, focus, anchor };
}

function shown(doc, focus, anchor = focus) {
  const text = typeof doc === "string" ? doc : "";
  if (!Number.isInteger(focus)) return `focus ${focus} anchor ${anchor} text ${JSON.stringify(text)}`;
  const mark = Number.isInteger(anchor) ? anchor : focus;
  let out = "";
  for (let i = 0; i <= text.length; i += 1) {
    if (mark !== focus && i === mark) out += ANCHOR;
    if (i === focus) out += FOCUS;
    if (i < text.length) out += text[i];
  }
  return out;
}

function vimStatus(page) {
  return page.eval(`document.querySelector(".md-vim-status").textContent`);
}

async function connect(hub, browsers, vim) {
  const browser = await launchBrowser();
  browsers.push(browser);
  const page = new Page(browser.session, hub.port);
  await page.init();
  if (vim) {
    await page.session.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `localStorage.setItem(${JSON.stringify(VIM)}, "1");`,
    });
  }
  await page.login();
  return page;
}

async function setup(t, docs) {
  const files = typeof docs === "string" ? { [FILE]: docs } : docs;
  const hub = await startHub();
  const browsers = [];
  t.after(async () => {
    for (const browser of browsers) await browser.close();
    await hub.close();
  });
  for (const [name, text] of Object.entries(files)) await hub.create(name, text);
  const page = await connect(hub, browsers, true);
  await page.open(FILE);
  assert.equal(await page.eval(`localStorage.getItem(${JSON.stringify(VIM)})`), "1");
  assert.equal(await vimStatus(page), "N");
  return { hub, page, connect: (vim) => connect(hub, browsers, vim) };
}

async function place(page, offset) {
  assert.equal(await page.clickOffset(offset), true, `no glyph at ${offset}`);
  await page.quiet();
  const caret = await page.caret();
  assert.equal(caret.focus, offset, `click ${offset} landed at ${caret.focus}`);
  assert.equal(caret.anchor, offset, `click ${offset} anchor ${caret.anchor}`);
}

async function press(page, keys) {
  for (const key of keys) {
    if (typeof key === "string") await page.key(key);
    else await page.key(key.key, key.mods);
  }
  await page.quiet();
}

async function showRaw(page) {
  for (let n = 0; n < 3; n += 1) {
    if (await page.eval(`document.getElementById("editor").classList.contains("md-source")`)) return;
    const point = await page.eval(`(() => {
      const rect = document.querySelector("button.md-view-toggle").getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await page.click(point.x, point.y);
    await page.quiet();
  }
  assert.equal(await page.eval(`document.getElementById("editor").classList.contains("md-source")`), true);
}

async function expectMove(page, hub, file, expect, rev, status = "N") {
  const caret = await page.caret();
  const got = await hub.show(file);
  const mark = shown(got.text, caret.focus, caret.anchor);
  assert.equal(mark, expect, mark);
  assert.equal(got.rev, rev, mark);
  if (status) assert.equal(await vimStatus(page), status, mark);
  return mark;
}

async function runMove(page, hub, file, start, keys, expect, rev, status = "N") {
  const from = marked(start);
  assert.equal((await hub.show(file)).text, from.doc);
  await place(page, from.focus);
  await press(page, keys);
  return expectMove(page, hub, file, expect, rev, status);
}

async function follow(page, hub, file, keys, expect, rev, status = "N") {
  await press(page, keys);
  return expectMove(page, hub, file, expect, rev, status);
}

function cell(id) {
  return `${id} (ticket ${TICKET})`;
}

test(cell("VN.1"), async (t) => {
  const { hub, page } = await setup(t, "alpha\n");
  const rev = (await hub.show(FILE)).rev;
  for (const raw of [false, true]) {
    if (raw) await showRaw(page);
    await runMove(page, hub, FILE, "al‸pha\n", ["l"], "alp‸ha\n", rev);
    await runMove(page, hub, FILE, "al‸pha\n", ["→"], "alp‸ha\n", rev);
    await runMove(page, hub, FILE, "al‸pha\n", ["h"], "a‸lpha\n", rev);
    await runMove(page, hub, FILE, "al‸pha\n", ["←"], "a‸lpha\n", rev);
    await runMove(page, hub, FILE, "al‸pha\n", ["3", "l"], "alpha‸\n", rev);
    await runMove(page, hub, FILE, "al‸pha\n", ["→", "→", "→"], "alpha‸\n", rev);
  }
});

test(cell("VN.2"), async (t) => {
  const { hub, page } = await setup(t, "alpha\n");
  const rev = (await hub.show(FILE)).rev;
  await runMove(page, hub, FILE, "al‸pha\n", ["Backspace"], "a‸lpha\n", rev);
  await runMove(page, hub, FILE, "al‸pha\n", [" "], "alp‸ha\n", rev);
  await runMove(page, hub, FILE, "al‸pha\n", ["Delete"], "al‸ha\n", rev + 1);
});

test(cell("VN.3"), async (t) => {
  const joined = "alpha\nbeta\n";
  const apart = "alpha\n\nbeta\n";
  const { hub, page } = await setup(t, { [FILE]: joined, "b.md": apart });
  const revA = (await hub.show(FILE)).rev;
  await runMove(page, hub, FILE, "al‸pha\nbeta\n", ["j"], "al‸pha\nbeta\n", revA);
  await runMove(page, hub, FILE, "al‸pha\nbeta\n", ["k"], "al‸pha\nbeta\n", revA);
  await page.open("b.md");
  const revB = (await hub.show("b.md")).rev;
  await runMove(page, hub, "b.md", "al‸pha\n\nbeta\n", ["j"], "alpha\n\nbe‸ta\n", revB);
  await follow(page, hub, "b.md", ["k"], "al‸pha\n\nbeta\n", revB);
  await page.open(FILE);
  await showRaw(page);
  await runMove(page, hub, FILE, "al‸pha\nbeta\n", ["j"], "alpha\nbe‸ta\n", revA);
});

test(cell("VN.4"), async (t) => {
  const body = `${LONG}\n\nnext\n`;
  const nextEnd = body.indexOf("next") + "next".length;
  const start = shown(body, 5);
  const down = shown(body, nextEnd);
  const { hub, page, connect } = await setup(t, body);
  const rev = (await hub.show(FILE)).rev;
  await runMove(page, hub, FILE, start, ["↓"], down, rev);
  await follow(page, hub, FILE, ["↑"], start, rev);
  await runMove(page, hub, FILE, start, ["j"], down, rev);
  await follow(page, hub, FILE, ["k"], start, rev);
  await runMove(page, hub, FILE, start, [CTRL_N], down, rev);
  await follow(page, hub, FILE, [CTRL_P], start, rev);

  const off = await connect(false);
  await off.open(FILE);
  assert.equal(await off.eval(`localStorage.getItem(${JSON.stringify(VIM)})`), null);
  await place(off, 5);
  await press(off, ["↓"]);
  const lowered = await off.caret();
  const loweredDoc = await hub.show(FILE);
  const loweredMark = shown(loweredDoc.text, lowered.focus, lowered.anchor);
  assert.equal(loweredDoc.text, body, loweredMark);
  assert.equal(loweredDoc.rev, rev, loweredMark);
  assert.equal(lowered.anchor, lowered.focus, loweredMark);
  assert.ok(lowered.focus > 5 && lowered.focus < LONG.length, loweredMark);
  await place(off, 5);
  await press(off, ["↑"]);
  await expectMove(off, hub, FILE, shown(body, 0), rev, false);
  await place(off, 5);
  await press(off, [CTRL_N]);
  await expectMove(off, hub, FILE, start, rev, false);
  await place(off, 5);
  await press(off, [CTRL_P]);
  await expectMove(off, hub, FILE, start, rev, false);

  await page.open(FILE);
  await runMove(page, hub, FILE, start, ["v"], shown(body, 6, 5), rev, "V");
  await follow(page, hub, FILE, ["j"], shown(body, nextEnd, 5), rev, "V");
  await follow(page, hub, FILE, ["k"], shown(body, 6, 5), rev, "V");
  await page.open(FILE);
  await runMove(page, hub, FILE, start, ["v"], shown(body, 6, 5), rev, "V");
  await follow(page, hub, FILE, ["↓"], shown(body, nextEnd, 5), rev, "V");
  await follow(page, hub, FILE, ["↑"], shown(body, 6, 5), rev, "V");
  await page.open(FILE);
  await runMove(page, hub, FILE, start, ["v"], shown(body, 6, 5), rev, "V");
  await follow(page, hub, FILE, [CTRL_N], shown(body, nextEnd, 5), rev, "V");
  await follow(page, hub, FILE, [CTRL_P], shown(body, 6, 5), rev, "V");
});

test(cell("VN.5"), async (t) => {
  const { hub, page } = await setup(t, "alpha\nab\nalpha\n");
  const rev = (await hub.show(FILE)).rev;
  await runMove(page, hub, FILE, "alpha‸\nab\nalpha\n", ["j"], "alpha\nab‸\nalpha\n", rev);
  await follow(page, hub, FILE, ["j"], "alpha\nab\nalpha‸\n", rev);
  await follow(page, hub, FILE, ["k"], "alpha\nab‸\nalpha\n", rev);
  await follow(page, hub, FILE, ["k"], "alpha‸\nab\nalpha\n", rev);
  await page.open(FILE);
  await runMove(page, hub, FILE, "alpha‸\nab\nalpha\n", ["j", "h", "j"], "alpha\nab\na‸lpha\n", rev);
});

test(cell("VN.6"), async (t) => {
  const body = `${LONG}\nnext\n`;
  const { hub, page, connect } = await setup(t, body);
  const rev = (await hub.show(FILE)).rev;
  const off = await connect(false);
  await off.open(FILE);
  assert.equal(await off.eval(`localStorage.getItem(${JSON.stringify(VIM)})`), null);
  await place(off, 5);
  await press(off, ["↓"]);
  const downCaret = await off.caret();
  const downDoc = await hub.show(FILE);
  const downMark = shown(downDoc.text, downCaret.focus, downCaret.anchor);
  assert.equal(downDoc.text, body, downMark);
  assert.equal(downDoc.rev, rev, downMark);
  assert.equal(downCaret.anchor, downCaret.focus, downMark);
  assert.ok(downCaret.focus > 5 && downCaret.focus < LONG.length, downMark);
  await place(off, downCaret.focus);
  await press(off, ["↑"]);
  const upCaret = await off.caret();
  const upDoc = await hub.show(FILE);
  const upMark = shown(upDoc.text, upCaret.focus, upCaret.anchor);
  assert.equal(upDoc.text, body, upMark);
  assert.equal(upDoc.rev, rev, upMark);
  assert.equal(upCaret.anchor, upCaret.focus, upMark);

  async function display(keys, offset) {
    await page.open(FILE);
    await place(page, offset);
    await press(page, keys);
    const caret = await page.caret();
    const got = await hub.show(FILE);
    const mark = shown(got.text, caret.focus, caret.anchor);
    assert.equal(got.text, body, mark);
    assert.equal(got.rev, rev, mark);
    assert.equal(caret.anchor, caret.focus, mark);
    assert.equal(await vimStatus(page), "N", mark);
    return mark;
  }

  assert.equal(await display(["g", "j"], 5), downMark);
  assert.equal(await display(["g", "↓"], 5), downMark);
  assert.equal(await display(["g", "k"], downCaret.focus), upMark);
  assert.equal(await display(["g", "↑"], downCaret.focus), upMark);
});

test(cell("VN.7"), async (t) => {
  const { hub, page } = await setup(t, "alpha, beta\n");
  const rev = (await hub.show(FILE)).rev;
  await runMove(page, hub, FILE, "‸alpha, beta\n", ["w"], "alpha, ‸beta\n", rev);
  await runMove(page, hub, FILE, "‸alpha, beta\n", ["e"], "alpha‸, beta\n", rev);
  await runMove(page, hub, FILE, "alpha, be‸ta\n", ["b"], "alpha, ‸beta\n", rev);
  await runMove(page, hub, FILE, "alpha, be‸ta\n", ["g", "e"], "alpha‸, beta\n", rev);
});

test(cell("VN.8"), async (t) => {
  const { hub, page } = await setup(t, "alpha,beta gamma\n");
  const rev = (await hub.show(FILE)).rev;
  await runMove(page, hub, FILE, "‸alpha,beta gamma\n", ["W"], "alpha,beta ‸gamma\n", rev);
  await runMove(page, hub, FILE, "‸alpha,beta gamma\n", ["w"], "alpha,beta ‸gamma\n", rev);
  await runMove(page, hub, FILE, "alpha,beta gam‸ma\n", ["b"], "alpha,beta ‸gamma\n", rev);
  await runMove(page, hub, FILE, "alpha,beta gam‸ma\n", ["B"], "alpha,beta ‸gamma\n", rev);
  await runMove(page, hub, FILE, "alpha,beta gam‸ma\n", ["e"], "alpha,beta gamm‸a\n", rev);
  await runMove(page, hub, FILE, "alpha,beta gam‸ma\n", ["E"], "alpha,beta gamm‸a\n", rev);
  await runMove(page, hub, FILE, "alpha,beta gam‸ma\n", ["g", "e"], "alpha,bet‸a gamma\n", rev);
  await runMove(page, hub, FILE, "alpha,beta gam‸ma\n", ["g", "E"], "alpha,bet‸a gamma\n", rev);
});

test(cell("VN.9"), async (t) => {
  const { hub, page } = await setup(t, {
    [FILE]: "alpha\nbeta\n",
    "b.md": "alpha beta\n\ngamma\n",
    "c.md": "alpha beta\n",
  });
  const revA = (await hub.show(FILE)).rev;
  await runMove(page, hub, FILE, "al‸pha\nbeta\n", ["w"], "alpha\n‸beta\n", revA);
  await page.open("b.md");
  const revB = (await hub.show("b.md")).rev;
  await runMove(page, hub, "b.md", "alpha be‸ta\n\ngamma\n", ["w"], "alpha beta\n\n‸gamma\n", revB);
  await page.open("c.md");
  const revC = (await hub.show("c.md")).rev;
  await runMove(page, hub, "c.md", "alpha be‸ta\n", ["w"], "alpha beta‸\n", revC);
});

test(cell("VN.10"), async (t) => {
  const { hub, page } = await setup(t, "alpha beta\n");
  const rev = (await hub.show(FILE)).rev;
  await runMove(page, hub, FILE, "alpha be‸ta\n", [CTRL_BACKSPACE], "alpha ‸beta\n", rev);
  await runMove(page, hub, FILE, "alpha be‸ta\n", ["B"], "alpha ‸beta\n", rev);
  await runMove(page, hub, FILE, "alpha be‸ta\n", [SHIFT_BACKSPACE], "alpha ‸beta\n", rev);
  await runMove(page, hub, FILE, "alpha be‸ta\n", ["b"], "alpha ‸beta\n", rev);
  await runMove(page, hub, FILE, "alpha be‸ta\n", [CTRL_SPACE], "alpha beta‸\n", rev);
  await runMove(page, hub, FILE, "alpha be‸ta\n", ["W"], "alpha beta‸\n", rev);
  await runMove(page, hub, FILE, "alpha be‸ta\n", [SHIFT_SPACE], "alpha beta‸\n", rev);
  await runMove(page, hub, FILE, "alpha be‸ta\n", ["w"], "alpha beta‸\n", rev);
  await page.open(FILE);
  await runMove(page, hub, FILE, "alpha be‸ta\n", ["v", CTRL_BACKSPACE], "alpha ‸be«ta\n", rev, "V");
  await page.open(FILE);
  await runMove(page, hub, FILE, "alpha be‸ta\n", ["v", "B"], "alpha ‸be«ta\n", rev, "V");
  await page.open(FILE);
  await runMove(page, hub, FILE, "alpha be‸ta\n", ["v", SHIFT_BACKSPACE], "alpha ‸be«ta\n", rev, "V");
  await page.open(FILE);
  await runMove(page, hub, FILE, "alpha be‸ta\n", ["v", "b"], "alpha ‸be«ta\n", rev, "V");
  await page.open(FILE);
  await runMove(page, hub, FILE, "alpha be‸ta\n", ["v", CTRL_SPACE], "alpha be«ta‸\n", rev, "V");
  await page.open(FILE);
  await runMove(page, hub, FILE, "alpha be‸ta\n", ["v", "W"], "alpha be«ta‸\n", rev, "V");
  await page.open(FILE);
  await runMove(page, hub, FILE, "alpha be‸ta\n", ["v", SHIFT_SPACE], "alpha be«ta‸\n", rev, "V");
  await page.open(FILE);
  await runMove(page, hub, FILE, "alpha be‸ta\n", ["v", "w"], "alpha be«ta‸\n", rev, "V");
});

test(cell("VN.11"), async (t) => {
  const { hub, page } = await setup(t, {
    [FILE]: "  alpha\n",
    "b.md": "- alpha\n",
    "c.md": "# Title\n",
  });
  const revA = (await hub.show(FILE)).rev;
  await runMove(page, hub, FILE, "  al‸pha\n", ["0"], "‸  alpha\n", revA);
  await runMove(page, hub, FILE, "  al‸pha\n", ["^"], "  ‸alpha\n", revA);
  await page.open("b.md");
  const revB = (await hub.show("b.md")).rev;
  await runMove(page, hub, "b.md", "- al‸pha\n", ["^"], "‸- alpha\n", revB);
  await page.open("c.md");
  const revC = (await hub.show("c.md")).rev;
  await runMove(page, hub, "c.md", "# Ti‸tle\n", ["^"], "‸# Title\n", revC);
});

test(cell("VN.12"), async (t) => {
  const { hub, page } = await setup(t, { [FILE]: "alpha \n", "b.md": "red  \nblue\n" });
  const revA = (await hub.show(FILE)).rev;
  await runMove(page, hub, FILE, "‸alpha \n", ["$"], "alpha ‸\n", revA);
  await page.open("b.md");
  const revB = (await hub.show("b.md")).rev;
  await runMove(page, hub, "b.md", "r‸ed  \nblue\n", ["$"], "red‸  \nblue\n", revB);
});

test(cell("VN.13"), async (t) => {
  const { hub, page, connect } = await setup(t, { [FILE]: "- alpha\n", "b.md": LONG });
  const revA = (await hub.show(FILE)).rev;
  const revB = (await hub.show("b.md")).rev;
  await runMove(page, hub, FILE, "- al‸pha\n", ["Home"], "‸- alpha\n", revA);
  await page.open("b.md");
  await runMove(page, hub, "b.md", shown(LONG, 5), ["End"], shown(LONG, LONG.length), revB);
  await page.open(FILE);
  await runMove(page, hub, FILE, "- al‸pha\n", ["v", "Home"], "‸- al«pha\n", revA, "V");
  await page.open("b.md");
  await runMove(page, hub, "b.md", shown(LONG, 5), ["v", "End"], shown(LONG, LONG.length, 5), revB, "V");

  const off = await connect(false);
  await off.open(FILE);
  assert.equal(await off.eval(`localStorage.getItem(${JSON.stringify(VIM)})`), null);
  await place(off, marked("- al‸pha\n").focus);
  await press(off, ["Home"]);
  await expectMove(off, hub, FILE, "- ‸alpha\n", revA, false);
  await off.open("b.md");
  await place(off, 5);
  await press(off, ["End"]);
  const caret = await off.caret();
  const got = await hub.show("b.md");
  const mark = shown(got.text, caret.focus, caret.anchor);
  assert.equal(got.text, LONG, mark);
  assert.equal(got.rev, revB, mark);
  assert.equal(caret.anchor, caret.focus, mark);
  assert.ok(caret.focus > 5 && caret.focus < LONG.length, mark);
});

test(cell("VN.14"), async (t) => {
  const { hub, page } = await setup(t, {
    [FILE]: "alpha\n\n  beta\n",
    "b.md": "  alpha\n",
    "c.md": "  alpha\n\n  beta\n",
    "d.md": "  alpha\n  beta\n",
  });
  const revA = (await hub.show(FILE)).rev;
  await runMove(page, hub, FILE, "al‸pha\n\n  beta\n", ["+"], "alpha\n\n  ‸beta\n", revA);
  await follow(page, hub, FILE, ["-"], "‸alpha\n\n  beta\n", revA);
  await page.open("b.md");
  const revB = (await hub.show("b.md")).rev;
  await runMove(page, hub, "b.md", "  al‸pha\n", ["_"], "  ‸alpha\n", revB);
  await page.open("c.md");
  const revC = (await hub.show("c.md")).rev;
  await runMove(page, hub, "c.md", "  al‸pha\n\n  beta\n", ["2", "_"], "  alpha\n\n  ‸beta\n", revC);
  await page.open("d.md");
  await showRaw(page);
  const revD = (await hub.show("d.md")).rev;
  await runMove(page, hub, "d.md", "  al‸pha\n  beta\n", ["2", "_"], "  alpha\n  ‸beta\n", revD);
});
