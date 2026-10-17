import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "../harness.js";

// The flag is read once, when the editor is created. A later write does not turn keys on.
const VIM = "viewmark.vim";
const LONG = `${"alpha beta gamma delta ".repeat(15)}end`;
const FILL = Array.from({ length: 60 }, (_, i) => `filler ${i + 1}\n\n`).join("");

let chain = Promise.resolve();

// One browser at a time. node --test would otherwise start every cell together.
function exclusive() {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const prev = chain;
  chain = prev.then(() => gate);
  return prev.then(() => release);
}

function mark(bytes, focus, anchor = focus) {
  const points = [];
  if (Number.isInteger(anchor) && anchor !== focus) points.push([anchor, "«"]);
  if (Number.isInteger(focus)) points.push([focus, "‸"]);
  points.sort((a, b) => a[0] - b[0] || (a[1] === "«" ? -1 : 1));
  let out = "";
  let at = 0;
  for (const [i, ch] of points) {
    out += bytes.slice(at, i) + ch;
    at = i;
  }
  return out + bytes.slice(at);
}

function firstNonBlank(bytes, at, end = bytes.length) {
  let i = at;
  while (i < end && (bytes[i] === " " || bytes[i] === "\t")) i += 1;
  return i < end ? i : at;
}

function rawLineStarts(text) {
  const starts = [];
  let start = 0;
  for (let i = 0; i <= text.length; i += 1) {
    if (i === text.length || text[i] === "\n") {
      starts.push(start);
      start = i + 1;
      if (i === text.length) break;
    }
  }
  if (starts.length === 0) starts.push(0);
  return starts;
}

async function setup(t, bodies, { vim = true } = {}) {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  for (const [file, body] of Object.entries(bodies)) await hub.create(file, body);
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  if (vim) {
    await page.session.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `localStorage.setItem(${JSON.stringify(VIM)}, "1");`,
    });
  }
  await page.login();
  return { hub, page };
}

async function showRaw(page) {
  for (let i = 0; i < 3; i += 1) {
    if (await page.eval(`document.getElementById("editor").classList.contains("md-source")`)) return;
    const point = await page.eval(`(() => {
      const button = document.querySelector("button.md-view-toggle");
      const rect = button.getBoundingClientRect();
      return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
    })()`);
    await page.click(point.x, point.y);
    await page.quiet();
  }
  assert.equal(await page.eval(`document.getElementById("editor").classList.contains("md-source")`), true);
}

async function openFile(page, file, { raw = false, vim = true } = {}) {
  await page.open(file);
  if (vim) {
    assert.equal(await page.eval(`document.querySelector(".md-vim-status") && document.querySelector(".md-vim-status").textContent`), "N");
  }
  if (raw) await showRaw(page);
}

const LINE_SPAN = `
  const lineSpan = (line) => {
    let start = null;
    let end = null;
    const take = (el) => {
      if (!el || !el.dataset || el.dataset.start == null || el.dataset.start === "") return;
      const s = Number(el.dataset.start);
      const e = el.dataset.end == null || el.dataset.end === "" ? s : Number(el.dataset.end);
      if (!Number.isFinite(s)) return;
      if (start == null || s < start) start = s;
      if (Number.isFinite(e) && (end == null || e > end)) end = e;
    };
    take(line);
    for (const el of line.querySelectorAll("[data-start]")) take(el);
    if (start == null) return null;
    return { start, end: end == null ? start : end };
  };
`;

async function reveal(page, offset) {
  await page.eval(`(() => {
    ${LINE_SPAN}
    const root = document.getElementById("editor");
    for (const line of root.querySelectorAll(".md-line")) {
      const span = lineSpan(line);
      if (!span || ${offset} < span.start || ${offset} > span.end) continue;
      const rect = line.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > innerHeight) line.scrollIntoView({ block: "center" });
      return;
    }
  })()`);
  await page.frame();
}

async function place(page, offset) {
  await reveal(page, offset);
  assert.equal(await page.clickOffset(offset), true, `no point at ${offset}`);
  await page.quiet();
  const caret = await page.caret();
  assert.equal(caret.focus, offset, `click left the caret at ${caret.focus}, anchor ${caret.anchor}`);
  assert.equal(caret.anchor, offset, `click left an anchor at ${caret.anchor}`);
}

async function press(page, keys) {
  for (const key of keys) {
    if (Array.isArray(key)) await page.key(key[0], key.slice(1));
    else await page.key(key);
  }
  await page.quiet();
}

async function expectAt(page, hub, file, rev, expected, label) {
  const shown = await hub.show(file);
  const caret = await page.caret();
  const got = mark(shown.text, caret.focus, caret.anchor);
  assert.equal(got, expected, label);
  assert.equal(shown.rev, rev, `${label} rev`);
  return got;
}

async function runMoves(page, hub, file, cases) {
  const failures = [];
  for (const item of cases) {
    try {
      await openFile(page, file, { raw: item.raw === true, vim: item.vim !== false });
      await place(page, item.focus);
      const rev = (await hub.show(file)).rev;
      await press(page, item.keys);
      await expectAt(page, hub, file, rev, item.expect, item.label);
      if (item.then) {
        await press(page, item.then.keys);
        await expectAt(page, hub, file, rev, item.then.expect, item.then.label);
      }
    } catch (err) {
      failures.push(`${item.label}: ${err.message}`);
    }
  }
  assert.equal(failures.length, 0, failures.join("\n"));
}

function cell(id, fn) {
  test(`${id} (ticket 7vdep2z4)`, async (t) => {
    const release = await exclusive();
    t.after(release);
    await fn(t);
  });
}

async function visualEdge(page, offset, bytes) {
  const edge = await page.eval(`(() => {
    const text = ${JSON.stringify(bytes)};
    const startAt = ${offset};
    const first = window.__qaGlyph(startAt);
    if (!first) return null;
    const mid = (g) => (g.top + g.bottom) / 2;
    let from = startAt;
    for (; from > 0; from -= 1) {
      const g = window.__qaGlyph(from - 1);
      if (!g || mid(g) < first.top - 2) break;
    }
    let to = startAt;
    for (; to < text.length; to += 1) {
      const g = window.__qaGlyph(to);
      if (g ? mid(g) > first.bottom + 2 : text[to] === "\\n") break;
    }
    let nonBlank = from;
    while (nonBlank < to && (text[nonBlank] === " " || text[nonBlank] === "\\t")) nonBlank += 1;
    return { from, to, nonBlank };
  })()`);
  assert.ok(edge, `offset ${offset} has no glyph to find its visual line by`);
  return edge;
}

async function paneRows(page) {
  return page.eval(`(() => {
    ${LINE_SPAN}
    const editor = document.getElementById("editor");
    const box = editor.getBoundingClientRect();
    const paneTop = Math.max(box.top, 0);
    const paneBottom = Math.min(box.bottom, innerHeight);
    const rows = [];
    for (const line of editor.querySelectorAll(".md-line")) {
      if (line.classList.contains("md-paragraph-gap")) continue;
      const span = lineSpan(line);
      if (!span) continue;
      const seen = new Map();
      for (let i = span.start; i < span.end; i += 1) {
        const g = window.__qaGlyph(i);
        if (!g || g.bottom <= g.top) continue;
        const gmid = (g.top + g.bottom) / 2;
        if (gmid < paneTop || gmid >= paneBottom) continue;
        const key = Math.round(g.top);
        if (!seen.has(key)) seen.set(key, i);
      }
      if (seen.size === 0) {
        const rect = line.getBoundingClientRect();
        if (rect.height < 1) continue;
        const mid = (rect.top + rect.bottom) / 2;
        if (mid < paneTop || mid >= paneBottom) continue;
        rows.push({ at: span.start, top: rect.top, bottom: rect.bottom, end: span.end });
        continue;
      }
      for (const at of seen.values()) {
        const g = window.__qaGlyph(at);
        rows.push({ at, top: g.top, bottom: g.bottom, end: span.end });
      }
    }
    rows.sort((a, b) => a.top - b.top || a.at - b.at);
    return { rows, paneTop, paneBottom };
  })()`);
}

async function renderedBlocks(page) {
  return page.eval(`(() => {
    ${LINE_SPAN}
    return [...document.querySelectorAll("#editor .md-line")].flatMap((line) => {
      if (line.classList.contains("md-paragraph-gap")) return [];
      const span = lineSpan(line);
      return span ? [span] : [];
    });
  })()`);
}

function blockIndex(blocks, offset) {
  let found = 0;
  for (let i = 0; i < blocks.length; i += 1) {
    if (blocks[i].start <= offset) found = i;
    else break;
  }
  return found;
}

async function lineSample(page) {
  const sample = await page.eval(`(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.focusNode) return null;
    const node = sel.focusNode.nodeType === 1 ? sel.focusNode : sel.focusNode.parentElement;
    const line = node && node.closest(".md-line");
    if (!line) return null;
    const rect = line.getBoundingClientRect();
    const editor = document.getElementById("editor").getBoundingClientRect();
    return {
      top: rect.top,
      bottom: rect.bottom,
      mid: (rect.top + rect.bottom) / 2,
      paneTop: Math.max(editor.top, 0),
      paneBottom: Math.min(editor.bottom, innerHeight),
    };
  })()`);
  assert.ok(sample, "the caret has no line box");
  return sample;
}

// Nearer the named edge than the center or the other edge. Not a one-line distance.
function nearer(sample, edge) {
  const height = sample.paneBottom - sample.paneTop;
  const topGap = sample.top - sample.paneTop;
  const bottomGap = sample.paneBottom - sample.bottom;
  const centerGap = Math.abs(sample.mid - (sample.paneTop + sample.paneBottom) / 2);
  const ok = edge === "top"
    ? topGap < centerGap && topGap < bottomGap
    : edge === "bottom"
      ? bottomGap < centerGap && bottomGap < topGap
      : centerGap < topGap && centerGap < bottomGap;
  return { ok, height, topGap, bottomGap, centerGap };
}

async function park(page, where) {
  await page.eval(`(() => {
    const sel = window.getSelection();
    const node = sel.focusNode.nodeType === 1 ? sel.focusNode : sel.focusNode.parentElement;
    const line = node.closest(".md-line");
    line.scrollIntoView({ block: ${JSON.stringify(where)}, inline: "nearest" });
  })()`);
  await page.frame();
  await page.quiet();
}

function scrollDoc() {
  let text = "";
  let focus = 0;
  let nonBlank = 0;
  for (let i = 1; i <= 80; i += 1) {
    const line = `  row ${String(i).padStart(2, "0")} xxxx`;
    if (i === 40) {
      focus = text.length + line.indexOf("x");
      nonBlank = text.length + 2;
    }
    text += `${line}\n\n`;
  }
  return { text, focus, nonBlank };
}

cell("VN.15", async (t) => {
  const { hub, page } = await setup(t, {
    "col.md": "alpha beta\n",
    "tab.md": "\tabc\n",
    "end.md": "alpha\n",
  });
  await runMoves(page, hub, "col.md", [
    { label: "7|", focus: 0, keys: ["7", "|"], expect: "alpha ‸beta\n", file: "col.md" },
  ].map((item) => ({ ...item, file: item.file })));
  await runMoves(page, hub, "tab.md", [
    { label: "5|", focus: "\tab".length, keys: ["5", "|"], expect: "\t‸abc\n" },
  ]);
  await runMoves(page, hub, "end.md", [
    { label: "20|", focus: 0, keys: ["2", "0", "|"], expect: "alpha‸\n" },
  ]);
});

cell("VN.16", async (t) => {
  const body = "alpha\nbeta\n";
  const { hub, page } = await setup(t, { "a.md": body });
  const focus = "alpha\nbe".length;
  await runMoves(page, hub, "a.md", [
    { label: "gg", focus, keys: ["g", "g"], expect: "‸alpha\nbeta\n" },
    { label: "G", focus, keys: ["G"], expect: "alpha\nbeta‸\n" },
    { label: "raw G", focus, raw: true, keys: ["G"], expect: "alpha\nbeta‸\n" },
  ]);
});

cell("VN.17", async (t) => {
  const { hub, page } = await setup(t, {
    "gaps.md": "one\n\ntwo\n\nthree\n",
    "raw.md": "alpha\nbeta\ngamma\n",
    "short.md": "one\n\ntwo\n",
  });
  await runMoves(page, hub, "gaps.md", [
    { label: "2G", focus: 0, keys: ["2", "G"], expect: "one\n\n‸two\n\nthree\n" },
  ]);
  await runMoves(page, hub, "raw.md", [
    { label: "raw 2G", focus: 0, raw: true, keys: ["2", "G"], expect: "alpha\n‸beta\ngamma\n" },
  ]);
  await runMoves(page, hub, "short.md", [
    { label: "2G short", focus: 0, keys: ["2", "G"], expect: "one\n\n‸two\n" },
    { label: "raw 2G short", focus: 0, raw: true, keys: ["2", "G"], expect: "one\n‸\ntwo\n" },
  ]);
});

cell("VN.18", async (t) => {
  const { hub, page } = await setup(t, { "a.md": LONG });
  const failures = [];
  const steps = [
    { label: "g0", focus: 200, keys: ["g", "0"], field: "from" },
    { label: "g^", focus: 200, keys: ["g", "^"], field: "nonBlank" },
    { label: "g$", focus: 5, keys: ["g", "$"], field: "to" },
  ];
  for (const step of steps) {
    try {
      await openFile(page, "a.md");
      await place(page, step.focus);
      const edge = await visualEdge(page, step.focus, LONG);
      if (step.field === "from") assert.ok(edge.from > 0 && edge.from <= 200, `visual start ${edge.from} is not on the wrapped line`);
      if (step.field === "to") assert.ok(edge.to > 5 && edge.to < LONG.length, `visual end ${edge.to} is the source end`);
      const rev = (await hub.show("a.md")).rev;
      await press(page, step.keys);
      await expectAt(page, hub, "a.md", rev, mark(LONG, edge[step.field]), step.label);
    } catch (err) {
      failures.push(`${step.label}: ${err.message}`);
    }
  }
  assert.equal(failures.length, 0, failures.join("\n"));
});

cell("VN.19", async (t) => {
  const { hub, page } = await setup(t, {
    "word.md": "alpha beta\n",
    "miss.md": "alpha\nbeta\n",
    "dash.md": "a-b-c\n",
  });
  await runMoves(page, hub, "word.md", [
    { label: "fb", focus: 0, keys: ["f", "b"], expect: "alpha ‸beta\n" },
    { label: "Fa", focus: "alpha be".length, keys: ["F", "a"], expect: "alph‸a beta\n" },
  ]);
  await runMoves(page, hub, "miss.md", [
    { label: "fb misses", focus: 0, keys: ["f", "b"], expect: "‸alpha\nbeta\n" },
  ]);
  await runMoves(page, hub, "dash.md", [
    {
      label: "f-;",
      focus: 0,
      keys: ["f", "-", ";"],
      expect: "a-b‸-c\n",
      then: { label: "f-,", keys: [","], expect: "a‸-b-c\n" },
    },
  ]);
});

cell("VN.20", async (t) => {
  const body = "a-b-c\n";
  const { hub, page } = await setup(t, {
    "word.md": "alpha beta\n",
    "dash.md": body,
  });
  await runMoves(page, hub, "word.md", [
    { label: "tb", focus: 0, keys: ["t", "b"], expect: "alpha‸ beta\n" },
    { label: "Ta", focus: "alpha be".length, keys: ["T", "a"], expect: "alpha‸ beta\n" },
  ]);
  await openFile(page, "dash.md");
  await place(page, 0);
  const rev = (await hub.show("dash.md")).rev;
  await press(page, ["t", "-", ";"]);
  await expectAt(page, hub, "dash.md", rev, "a-‸b-c\n", "t-;");
  await press(page, [","]);
  const shown = await hub.show("dash.md");
  const caret = await page.caret();
  const got = mark(shown.text, caret.focus, caret.anchor);
  assert.equal(shown.text, body, `t-, bytes, got ${got}`);
  assert.equal(shown.rev, rev, "t-, rev");
  assert.ok(caret.focus < "a-b".length && caret.anchor === caret.focus, `t-, reverses, got ${got}`);
});

cell("VN.21", async (t) => {
  const { hub, page } = await setup(t, {
    "nest.md": "((a) b)\n",
    "back.md": "(a)",
    "mid.md": "x (a) y\n",
    "in.md": "(a) b\n",
    "word.md": "alpha\n",
    "open.md": "(a\n",
  });
  await runMoves(page, hub, "nest.md", [
    { label: "% nest", focus: 0, keys: ["%"], expect: "((a) b‸)\n" },
  ]);
  await runMoves(page, hub, "back.md", [
    { label: "% back", focus: "(a)".length, keys: ["%"], expect: "‸(a)" },
  ]);
  await runMoves(page, hub, "mid.md", [
    { label: "% mid", focus: 0, keys: ["%"], expect: "x (a‸) y\n" },
  ]);
  await runMoves(page, hub, "in.md", [
    { label: "% in", focus: 1, keys: ["%"], expect: "(a‸) b\n" },
  ]);
  await runMoves(page, hub, "word.md", [
    { label: "% word", focus: 0, keys: ["%"], expect: "‸alpha\n" },
  ]);
  await runMoves(page, hub, "open.md", [
    { label: "% open", focus: 0, keys: ["%"], expect: "‸(a\n" },
  ]);
});

cell("VN.22", async (t) => {
  const body = "one\n\ntwo\n\nthree\n";
  const { hub, page } = await setup(t, { "a.md": body });
  await runMoves(page, hub, "a.md", [
    { label: "}", focus: 0, keys: ["}"], expect: "one\n\n‸two\n\nthree\n" },
    { label: "2}", focus: 0, keys: ["2", "}"], expect: "one\n\ntwo\n\n‸three\n" },
    { label: "{", focus: body.indexOf("ee"), keys: ["{"], expect: "one\n\n‸two\n\nthree\n" },
  ]);
});

cell("VN.23", async (t) => {
  const { hub, page } = await setup(t, { "a.md": FILL });
  await openFile(page, "a.md");
  const rev = (await hub.show("a.md")).rev;
  const failures = [];
  for (const which of ["H", "M", "L"]) {
    try {
      await page.eval(`(() => {
        const lines = [...document.querySelectorAll("#editor .md-line")].filter((line) => line.textContent.startsWith("filler"));
        lines[Math.floor(lines.length / 2)].scrollIntoView({ block: "center" });
      })()`);
      await page.frame();
      const seen = await paneRows(page);
      assert.ok(seen.rows.length >= 3, `the pane shows ${seen.rows.length} visual lines`);
      assert.ok(seen.rows[0].at > 0, "the scroll left the first filler line in the pane");
      const paneMid = (seen.paneTop + seen.paneBottom) / 2;
      let target = seen.rows[0];
      if (which === "L") target = seen.rows[seen.rows.length - 1];
      else if (which === "M") {
        let best = Infinity;
        for (const row of seen.rows) {
          const dist = Math.abs((row.top + row.bottom) / 2 - paneMid);
          if (dist < best) {
            best = dist;
            target = row;
          }
        }
      }
      const at = firstNonBlank(FILL, target.at, target.end);
      assert.equal(FILL.slice(at, at + 6), "filler", `${which} target is not a filler line`);
      const clickAt = target === seen.rows[Math.floor(seen.rows.length / 2)] ? at + 2 : seen.rows[Math.floor(seen.rows.length / 2)].at + 2;
      await place(page, clickAt);
      await press(page, [which]);
      await expectAt(page, hub, "a.md", rev, mark(FILL, at), which);
    } catch (err) {
      failures.push(`${which}: ${err.message}`);
    }
  }
  assert.equal(failures.length, 0, failures.join("\n"));
});

cell("VN.24", async (t) => {
  const { hub, page } = await setup(t, { "a.md": FILL });
  await openFile(page, "a.md");
  const rev = (await hub.show("a.md")).rev;

  async function landing(offset, steps, mode) {
    if (mode === "raw") {
      const starts = rawLineStarts(FILL);
      let index = 0;
      for (let i = 0; i < starts.length; i += 1) {
        if (offset >= starts[i]) index = i;
      }
      const next = Math.max(0, Math.min(starts.length - 1, index + steps));
      return starts[next];
    }
    const blocks = await renderedBlocks(page);
    assert.ok(blocks.length > 2, "no rendered blocks");
    const index = blockIndex(blocks, offset);
    const next = Math.max(0, Math.min(blocks.length - 1, index + steps));
    return blocks[next].start;
  }

  async function pageCount() {
    const seen = await paneRows(page);
    assert.ok(seen.rows.length >= 2, `the pane has ${seen.rows.length} visual lines`);
    return seen.rows.length;
  }

  await place(page, 0);
  const count = await pageCount();
  const forward = await landing(0, count, "rendered");
  await press(page, [["f", "Ctrl"]]);
  await expectAt(page, hub, "a.md", rev, mark(FILL, forward), "Ctrl+F");

  await place(page, 0);
  await press(page, ["PageDown"]);
  await expectAt(page, hub, "a.md", rev, mark(FILL, forward), "PageDown");

  const half = Math.max(1, Math.floor(count / 2));
  await place(page, 0);
  const halfAt = await landing(0, half, "rendered");
  await press(page, [["d", "Ctrl"]]);
  await expectAt(page, hub, "a.md", rev, mark(FILL, halfAt), "Ctrl+D");

  const blocks = await renderedBlocks(page);
  const mid = blocks[Math.min(30, blocks.length - 1)].start;
  await place(page, mid);
  const backCount = (await pageCount());
  const back = await landing(mid, -backCount, "rendered");
  await press(page, [["b", "Ctrl"]]);
  await expectAt(page, hub, "a.md", rev, mark(FILL, back), "Ctrl+B");

  await place(page, mid);
  await press(page, ["PageUp"]);
  await expectAt(page, hub, "a.md", rev, mark(FILL, back), "PageUp");

  await place(page, halfAt);
  const upCount = Math.max(1, Math.floor((await pageCount()) / 2));
  const up = await landing(halfAt, -upCount, "rendered");
  await press(page, [["u", "Ctrl"]]);
  await expectAt(page, hub, "a.md", rev, mark(FILL, up), "Ctrl+U");

  await openFile(page, "a.md", { raw: true });
  const rawRev = (await hub.show("a.md")).rev;
  await place(page, 0);
  const rawCount = await pageCount();
  const rawForward = await landing(0, rawCount, "raw");
  await press(page, [["f", "Ctrl"]]);
  await expectAt(page, hub, "a.md", rawRev, mark(FILL, rawForward), "raw Ctrl+F");
  await place(page, 0);
  await press(page, ["PageDown"]);
  await expectAt(page, hub, "a.md", rawRev, mark(FILL, rawForward), "raw PageDown");
  await place(page, 0);
  const rawHalf = Math.max(1, Math.floor(rawCount / 2));
  const rawHalfAt = await landing(0, rawHalf, "raw");
  await press(page, [["d", "Ctrl"]]);
  await expectAt(page, hub, "a.md", rawRev, mark(FILL, rawHalfAt), "raw Ctrl+D");

  const off = await setup(t, { "a.md": FILL }, { vim: false });
  await openFile(off.page, "a.md", { vim: false });
  assert.equal(await off.page.eval(`localStorage.getItem(${JSON.stringify(VIM)})`), null);
  await place(off.page, 0);
  const offRev = (await off.hub.show("a.md")).rev;
  for (const key of ["f", "b", "d", "u"]) {
    await press(off.page, [[key, "Ctrl"]]);
    await expectAt(off.page, off.hub, "a.md", offRev, mark(FILL, 0), `vim off Ctrl+${key.toUpperCase()}`);
    await off.page.key("Escape");
    await off.page.quiet();
  }
  const before = await off.page.eval("scrollY");
  await press(off.page, ["PageDown"]);
  const down = await off.page.caret();
  const afterDown = await off.page.eval("scrollY");
  const downShown = await off.hub.show("a.md");
  assert.equal(downShown.text, FILL, `vim off PageDown bytes, got ${mark(downShown.text, down.focus, down.anchor)}`);
  assert.equal(downShown.rev, offRev, "vim off PageDown rev");
  assert.ok(down.focus > 0 || afterDown > before, "vim off PageDown did not move");
  await press(off.page, ["PageUp"]);
  const upCaret = await off.page.caret();
  const afterUp = await off.page.eval("scrollY");
  const upShown = await off.hub.show("a.md");
  assert.equal(upShown.text, FILL, `vim off PageUp bytes, got ${mark(upShown.text, upCaret.focus, upCaret.anchor)}`);
  assert.equal(upShown.rev, offRev, "vim off PageUp rev");
  assert.ok(upCaret.focus <= down.focus && afterUp <= afterDown, "vim off PageUp did not move back");
});

cell("VN.25", async (t) => {
  const { hub, page } = await setup(t, { "a.md": "alpha\n  beta\n" });
  await runMoves(page, hub, "a.md", [
    { label: "Enter", focus: 2, keys: ["Enter"], expect: "‸alpha\n  beta\n" },
  ]);
});

cell("VN.26", async (t) => {
  const doc = scrollDoc();
  const { hub, page } = await setup(t, { "a.md": doc.text });
  await openFile(page, "a.md");
  const rev = (await hub.show("a.md")).rev;
  const cases = [
    { label: "zt", keys: ["z", "t"], park: "center", edge: "top", caret: doc.focus },
    { label: "zz", keys: ["z", "z"], park: "start", edge: "center", caret: doc.focus },
    { label: "zb", keys: ["z", "b"], park: "center", edge: "bottom", caret: doc.focus },
    { label: "z Enter", keys: ["z", "Enter"], park: "center", edge: "top", caret: doc.nonBlank },
    { label: "z.", keys: ["z", "."], park: "start", edge: "center", caret: doc.nonBlank },
    { label: "z-", keys: ["z", "-"], park: "center", edge: "bottom", caret: doc.nonBlank },
  ];
  const failures = [];
  for (const item of cases) {
    try {
      await place(page, doc.focus);
      await park(page, item.park);
      const parked = nearer(await lineSample(page), item.park === "start" ? "top" : item.park === "end" ? "bottom" : "center");
      assert.equal(parked.ok, true, `park ${item.park} left top ${parked.topGap} center ${parked.centerGap} bottom ${parked.bottomGap}`);
      assert.equal((await page.caret()).focus, doc.focus, "park moved the caret");
      await press(page, item.keys);
      await expectAt(page, hub, "a.md", rev, mark(doc.text, item.caret), item.label);
      const moved = nearer(await lineSample(page), item.edge);
      assert.equal(moved.ok, true, `${item.label} scroll top ${moved.topGap} center ${moved.centerGap} bottom ${moved.bottomGap}`);
    } catch (err) {
      failures.push(`${item.label}: ${err.message}`);
    }
  }
  assert.equal(failures.length, 0, failures.join("\n"));
});

cell("VN.27", async (t) => {
  const { hub, page } = await setup(t, {
    "word.md": "a b c d\n",
    "lines.md": "one\ntwo\nthree\n",
  });
  await runMoves(page, hub, "word.md", [
    { label: "3w", focus: 0, keys: ["3", "w"], expect: "a b c ‸d\n" },
  ]);
  await runMoves(page, hub, "lines.md", [
    { label: "2j", focus: 0, keys: ["2", "j"], expect: "‸one\ntwo\nthree\n" },
  ]);
});
