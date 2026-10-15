import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "../harness.js";

// The flag is read once, when the editor is created. A later write does not turn keys on.
const VIM = "viewmark.vim";
const FOCUS = "‸";
const ANCHOR = "«";

function stored(marked) {
  const focusMark = marked.indexOf(FOCUS);
  const anchorMark = marked.indexOf(ANCHOR);
  if (focusMark < 0) throw new Error(`no focus in ${JSON.stringify(marked)}`);
  const bytes = marked.split(FOCUS).join("").split(ANCHOR).join("");
  const focus = focusMark - (anchorMark >= 0 && anchorMark < focusMark ? ANCHOR.length : 0);
  const anchor = anchorMark < 0 ? focus : anchorMark - (focusMark < anchorMark ? FOCUS.length : 0);
  return { bytes, focus, anchor };
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

async function press(page, span) {
  for (const ch of span) {
    await page.key(ch);
    await page.quiet();
  }
}

async function run(id, page, hub, file, item) {
  await page.open(file);
  assert.equal(await page.eval(`localStorage.getItem(${JSON.stringify(VIM)})`), "1");
  if (item.raw) await showRaw(page);
  const start = stored(item.start);
  assert.equal(await page.clickOffset(start.focus), true, `${id} no point at ${start.focus}`);
  await page.quiet();
  const placed = await page.caret();
  const placedDoc = await hub.show(file);
  const placedMark = markedFrom(placedDoc.text, placed);
  assert.equal(placedMark, item.start, `${id} place got ${JSON.stringify(placedMark)}`);
  assert.equal(placed.focus, start.focus, `${id} place focus`);
  assert.equal(placed.anchor, start.anchor, `${id} place anchor`);
  // A motion leaves the bytes and the rev where they were.
  const rev = placedDoc.rev;
  for (const step of item.steps) {
    await press(page, step.span);
    const shown = await hub.show(file);
    const caret = await page.caret();
    const got = markedFrom(shown.text, caret);
    const want = stored(step.expect);
    assert.equal(got, step.expect, `${id} got ${JSON.stringify(got)}`);
    assert.equal(shown.text, want.bytes, `${id} bytes ${JSON.stringify(shown.text)}`);
    assert.equal(caret.focus, want.focus, `${id} focus ${caret.focus}`);
    assert.equal(caret.anchor, want.anchor, `${id} anchor ${caret.anchor} got ${JSON.stringify(got)}`);
    assert.equal(shown.rev, rev, `${id} rev ${shown.rev} from ${rev} got ${JSON.stringify(got)}`);
  }
}

function cell(id, cases) {
  test(`${id} (ticket 7vdep2z4)`, async (t) => {
    const files = {};
    for (const [name, item] of Object.entries(cases)) {
      const start = stored(item.start);
      assert.equal(markedFrom(start.bytes, start), item.start);
      for (const step of item.steps) {
        const want = stored(step.expect);
        assert.equal(markedFrom(want.bytes, want), step.expect);
        assert.equal(want.bytes, start.bytes);
      }
      files[name] = start.bytes;
    }
    const { hub, page } = await setup(t, files);
    for (const [name, item] of Object.entries(cases)) await run(id, page, hub, name, item);
  });
}

cell("VW.1", {
  "a.md": {
    start: "al‸pha\n\nbeta\n",
    steps: [
      { span: "j", expect: "alpha\n\nbe‸ta\n" },
      { span: "k", expect: "al‸pha\n\nbeta\n" },
    ],
  },
});

cell("VW.2", {
  "a.md": {
    raw: true,
    start: "al‸pha\n\nbeta\n",
    steps: [
      { span: "j", expect: "alpha\n‸\nbeta\n" },
      { span: "j", expect: "alpha\n\nbe‸ta\n" },
    ],
  },
});

cell("VW.3", {
  "rendered.md": {
    start: "‸one\n\n\n",
    steps: [{ span: "j", expect: "one\n\n‸\n" }],
  },
  "raw.md": {
    raw: true,
    start: "‸one\n\n\n",
    steps: [{ span: "j", expect: "one\n‸\n\n" }],
  },
});

cell("VW.4", {
  "a.md": {
    start: "‸one\n\n\n\ntwo\n",
    steps: [
      { span: "j", expect: "one\n\n‸\n\ntwo\n" },
      { span: "j", expect: "one\n\n\n‸\ntwo\n" },
      { span: "j", expect: "one\n\n\n\n‸two\n" },
    ],
  },
});

cell("VW.5", {
  "a.md": {
    start: "al‸pha\n\n   \n\nbeta\n",
    steps: [{ span: "j", expect: "alpha\n\n‸   \n\nbeta\n" }],
  },
});

cell("VW.6", {
  "a.md": {
    start: "al‸pha\n\n**bold** text\n",
    steps: [{ span: "j", expect: "alpha\n\n**‸bold** text\n" }],
  },
});

cell("VW.7", {
  "joined.md": {
    start: "abcdef‸\nred  \nblue\n",
    steps: [{ span: "j", expect: "abcdef‸\nred  \nblue\n" }],
  },
  "raw.md": {
    raw: true,
    start: "abcdef‸\nred  \nblue\n",
    steps: [{ span: "j", expect: "abcdef\nred‸  \nblue\n" }],
  },
  "apart.md": {
    start: "abcdef‸\n\nred  \n",
    steps: [{ span: "j", expect: "abcdef\n\nred‸  \n" }],
  },
});
