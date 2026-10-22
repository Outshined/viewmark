import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "./harness.js";

const VIM = "viewmark.vim";

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

async function openAt(page, hub, file, body) {
  await hub.create(file, body);
  await page.open(file);
  assert.equal(await page.eval(`localStorage.getItem(${JSON.stringify(VIM)})`), "1");
  assert.ok(await page.clickOffset(0), "no point on the first character");
  await page.quiet();
  assert.equal((await page.caret()).focus, 0);
}

test("dot repeats x, an insert, and dd on a rendered paragraph (ticket py7xfb9e)", async (t) => {
  const { hub, page } = await setup(t);

  await openAt(page, hub, "chars.md", "abcd\n");
  await page.key("x");
  await page.quiet();
  assert.equal((await hub.show("chars.md")).text, "bcd\n");
  await page.key(".");
  await page.quiet();
  assert.equal((await hub.show("chars.md")).text, "cd\n");

  await openAt(page, hub, "insert.md", "x\n");
  await page.key("i");
  await page.key("a");
  await page.key("b");
  await page.key("Escape");
  await page.quiet();
  assert.equal((await hub.show("insert.md")).text, "abx\n");
  await page.key(".");
  await page.quiet();
  assert.equal((await hub.show("insert.md")).text, "ababx\n");

  await openAt(page, hub, "lines.md", "alpha\n\nbeta\n\ngamma\n");
  await page.key("d");
  await page.key("d");
  await page.quiet();
  // A rendered line delete stops on the paragraph newline and leaves the gap.
  assert.equal((await hub.show("lines.md")).text, "\nbeta\n\ngamma\n");
  await page.key(".");
  await page.quiet();
  assert.equal((await hub.show("lines.md")).text, "beta\n\ngamma\n");
});
