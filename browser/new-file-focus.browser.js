import test from "node:test";
import assert from "node:assert/strict";
import { REPO, USER, launchBrowser, Page, startHub } from "./harness.js";

// Ticket 5febwdbd: New file opened the document with focus still on the page body,
// so the first keys never reached it.

async function setup(t, vim) {
  const hub = await startHub();
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await hub.close();
  });
  await hub.create("start.md", "Start.\n");
  const page = new Page(browser.session, hub.port);
  await page.init();
  if (vim) await page.session.send("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem("viewmark.vim", "1");` });
  await page.login(USER);
  await page.open("start.md");
  return { hub, page };
}

async function newFile(page, name) {
  const at = await page.eval(`(() => { const r = document.querySelector("button.md-new-file").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.click(at.x, at.y);
  await page.until(() => page.eval(`!!document.activeElement && document.activeElement.classList.contains("md-new-name")`), "the name field");
  await page.type(name);
  await page.key("Enter");
  await page.until(() => page.eval(`location.hash.endsWith("/doc/${name}.md")`), `${name}.md open`);
  await page.quiet();
}

function editorFocused(page) {
  return page.eval(`(() => { const root = document.getElementById("editor"); const active = document.activeElement; return active === root || root.contains(active); })()`);
}

test("5febwdbd: after New file, the editor is focused at offset 0 and a typed letter is written", async (t) => {
  const { hub, page } = await setup(t, false);
  await newFile(page, "fresh");
  assert.equal(await editorFocused(page), true);
  const caret = await page.caret();
  assert.equal(caret.focus, 0);
  assert.equal(caret.anchor, 0);
  await page.key("x");
  await page.quiet();
  assert.equal((await hub.show("fresh.md")).text, "x");
});

test("5febwdbd: after New file, with vim keys on, i and a letter are written at offset 0", async (t) => {
  const { hub, page } = await setup(t, true);
  await newFile(page, "fresh");
  assert.equal(await editorFocused(page), true);
  assert.equal(await page.eval(`document.querySelector(".md-vim-status").textContent`), "N");
  const caret = await page.caret();
  assert.equal(caret.focus, 0);
  assert.equal(caret.anchor, 0);
  await page.key("i");
  await page.quiet();
  await page.key("x");
  await page.quiet();
  assert.equal((await hub.show("fresh.md")).text, "x");
});
