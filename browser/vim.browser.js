import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "./harness.js";

// The flag is read once, when the editor is created. A later write does not turn keys on.
const FILE = "a.md";
const BODY = "alpha\n\nbeta\n";
const VIM = "viewmark.vim";

async function setup(t) {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  await hub.create(FILE, BODY);
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  return { hub, page };
}

function bytes(hub) {
  return hub.show(FILE).then((shown) => shown.text);
}

// The caret starts on the first byte. x then removes that byte, or inserts, depending on the flag.
async function placeStart(page) {
  assert.ok(await page.clickOffset(0), "no point on the first character");
  await page.quiet();
  assert.equal((await page.caret()).focus, 0);
}

test("vim flag unset: x is inserted", async (t) => {
  const { hub, page } = await setup(t);
  await page.login();
  await page.open(FILE);
  assert.equal(await page.eval(`localStorage.getItem(${JSON.stringify(VIM)})`), null);
  await placeStart(page);
  await page.key("x");
  await page.quiet();
  assert.match(await bytes(hub), /x/);
});

test("vim flag set before the editor exists: x deletes, j skips the blank line, and Escape returns to normal", async (t) => {
  const { hub, page } = await setup(t);
  // Runs on the next document, before its scripts, so the editor is created with the flag on.
  await page.session.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `localStorage.setItem(${JSON.stringify(VIM)}, "1");`,
  });
  await page.login();
  await page.open(FILE);
  assert.equal(await page.eval(`localStorage.getItem(${JSON.stringify(VIM)})`), "1");
  await placeStart(page);

  await page.key("x");
  await page.quiet();
  let doc = await bytes(hub);
  assert.equal(doc, "lpha\n\nbeta\n");
  assert.equal(doc.includes("x"), false);

  await page.key("q");
  await page.quiet();
  doc = await bytes(hub);
  assert.equal(doc.includes("q"), false);

  await page.key("j");
  await page.quiet();
  const caret = await page.caret();
  const beta = doc.indexOf("beta");
  assert.ok(beta > doc.indexOf("\n\n"));
  assert.ok(
    Number.isInteger(caret.focus) && caret.focus >= beta && caret.focus < beta + 4,
    `caret ${caret.focus} is not on beta, past the blank line`,
  );

  await page.key("i");
  await page.quiet();
  await page.key("Escape");
  await page.quiet();
  assert.equal(await page.eval(`document.querySelector(".md-vim-status").textContent`), "N");
  await page.key("q");
  await page.quiet();
  assert.equal((await bytes(hub)).includes("q"), false);
});
