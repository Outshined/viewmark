import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { REPO, USER, cli, launchBrowser, Page, startHub } from "./harness.js";

// Ticket xhx944ku: while typing, two spaces after a period make the caret jump. A line that ends
// in two spaces, with the caret just before them, takes a typed space and then draws the caret at
// the top left of the edit area. Firefox screenshots do not show the caret, so these tests check
// the caret's offset and the box it is drawn in after every key.

const show = async (hub, file) => (await cli(hub.port, ["--user", USER, "--repo", REPO, "show", file])).stdout;

async function setup(t, where, text, vim) {
  const hub = await startHub();
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await hub.close();
  });
  const page = new Page(browser.session, hub.port);
  await page.init();
  if (vim) await page.session.send("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem("viewmark.vim", "1");` });
  await page.login();
  let file;
  if (where === "document") {
    file = await hub.create("a.md", text);
    await page.open(file);
  } else {
    const out = await cli(hub.port, ["--user", USER, "--repo", REPO, "ticket", "create", "--title", "Typing"], text);
    assert.equal(out.code, 0, out.stderr);
    const id = out.stdout.trim().split("\n")[0];
    file = `tickets/${id}.md`;
    const since = page.frames.length;
    await page.session.send("Page.navigate", { url: `http://127.0.0.1:${page.port}/?load=9#${REPO}/ticket/${id}` });
    await page.until(() => page.frames.slice(since).some((f) => f.dir === "in" && f.data && f.data.type === "file" && f.data.path === file), "the ticket open");
    await page.quiet();
  }
  return { hub, page, file };
}

// Insert at a text offset: a click, and with vim keys on, Escape, the click again, and i.
async function insertAt(page, offset, vim) {
  assert.ok(await page.clickOffset(offset), `no point at ${offset}`);
  await page.quiet();
  if (vim) {
    await page.key("Escape");
    await page.quiet();
    assert.ok(await page.clickOffset(offset));
    await page.quiet();
    await page.key("i");
    await page.quiet();
  }
  assert.equal((await page.caret()).focus, offset);
}

const editorCorner = (page) => page.eval(`(() => { const r = document.getElementById("editor").getBoundingClientRect(); return { left: r.left, top: r.top }; })()`);

// ---- The smallest case ---------------------------------------------------------------------------

const SMALL = "# Notes\n\nalpha beta  \n";
const BEFORE_TRAILING = SMALL.indexOf("beta") + 4;

for (const where of ["document", "ticket"]) {
  for (const vim of [true, false]) {
    test(`xhx944ku: in a ${where}, vim keys ${vim ? "on" : "off"}, a space typed before a line's two trailing spaces leaves the caret after it`, async (t) => {
      const { hub, page, file } = await setup(t, where, SMALL, vim);
      await insertAt(page, BEFORE_TRAILING, vim);
      await page.key(" ");
      await sleep(300);
      assert.equal(await show(hub, file), "# Notes\n\nalpha beta   \n");
      const caret = await page.caret();
      assert.equal(caret.focus, BEFORE_TRAILING + 1, `the caret is at ${caret.focus}`);
      const glyph = await page.eval(`window.__qaGlyph(${BEFORE_TRAILING})`);
      assert.ok(caret.rect && glyph && Math.abs(caret.rect.top - glyph.top) < 6 && Math.abs(caret.rect.x - glyph.right) < 3,
        `the caret is drawn at ${JSON.stringify(caret.rect)}, the typed space at ${JSON.stringify(glyph)}`);
    });
  }
}

// About eight keys a second, a fast typist's pace.
const PACE = 120;

// ---- A lot of typing -------------------------------------------------------------------------------

// A seeded walk: sentences with two spaces after each period, Enter between lines, and arrow keys
// that move back into what was typed, at a fast typist's pace. The seeds are ones that reached
// the failure at 33b7c6f.
function walk(seed) {
  let x = seed;
  const r = () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
  const words = "the caret hops back when two spaces follow a period and then it jumps to the top left of the edit area sometimes".split(" ");
  const out = [];
  for (let line = 0; line < 6; line += 1) {
    const sentences = 2 + Math.floor(r() * 3);
    for (let s = 0; s < sentences; s += 1) {
      const n = 3 + Math.floor(r() * 8);
      const sentence = Array.from({ length: n }, () => words[Math.floor(r() * words.length)]).join(" ");
      out.push(...sentence, ".", " ", " ");
      if (r() < 0.35) {
        const arrow = ["←", "←", "→", "↑", "↓"][Math.floor(r() * 5)];
        const times = 1 + Math.floor(r() * 4);
        for (let i = 0; i < times; i += 1) out.push(arrow);
      }
    }
    out.push("Enter");
  }
  return out;
}

for (const [where, seed] of [["document", 3], ["ticket", 2]]) {
  for (const vim of [true, false]) {
    test(`xhx944ku: in a ${where}, vim keys ${vim ? "on" : "off"}, a lot of typing with two spaces after each period and arrow keys keeps each letter at the caret and the caret beside it`, { timeout: 300000 }, async (t) => {
      const { hub, page, file } = await setup(t, where, "# Notes\n", vim);
      await insertAt(page, "# Notes".length, vim);
      await page.key("Enter");
      await page.quiet();
      const corner = await editorCorner(page);
      let doc = await show(hub, file);
      let caret = await page.caret();
      let n = 0;
      for (const key of walk(seed)) {
        n += 1;
        const before = { doc, focus: caret.focus };
        await page.key(key);
        await sleep(PACE);
        caret = await page.caret();
        const where = `key ${n}, ${JSON.stringify(key)}, from offset ${before.focus}`;
        const r = caret.rect;
        assert.ok(r, `${where}: no caret is drawn`);
        assert.ok(!(r.x < corner.left + 30 && r.top < corner.top + 30) || caret.focus === 0, `${where}: the caret is drawn at the top left of the edit area, offset ${caret.focus}`);
        if (key.length === 1 && !"←→↑↓".includes(key)) {
          doc = await show(hub, file);
          assert.equal(doc, before.doc.slice(0, before.focus) + key + before.doc.slice(before.focus), `${where}: the letter is not where the caret was`);
          assert.equal(caret.focus, before.focus + 1, `${where}: the caret is at ${caret.focus}, not after the letter`);
        } else if (key === "Enter") {
          doc = await show(hub, file);
        }
      }
    });
  }
}
