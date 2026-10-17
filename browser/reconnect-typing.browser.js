import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { launchBrowser, Page, startHub, startProxy } from "./harness.js";

// What a person can rely on when the network drops: every key typed reaches the file, in the
// order typed, once the page has reconnected on its own. The harness proxy drops the page's
// socket at a known moment between keys, so each run is the same. Ticket kmc2taym.

const TEXT = "one\n\n\n\ntwo\n";

async function setup(t) {
  const hub = await startHub();
  const proxy = await startProxy(hub.port);
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await proxy.close();
    await hub.close();
  });
  const file = await hub.create("a.md", TEXT);
  const page = new Page(browser.session, proxy.port);
  await page.init();
  await page.login();
  await page.open(file);
  assert.ok(await page.clickOffset(5));
  await page.quiet();
  return { hub, proxy, page, file };
}

async function expectFile(page, hub, file, want) {
  await page.until(async () => (await hub.show(file)).text === want, "the typed text in the file", 8000).catch(async (err) => {
    assert.fail(`${err.message}: wanted ${JSON.stringify(want)}, the file is ${JSON.stringify((await hub.show(file)).text)}`);
  });
}

for (const wait of [0, 300]) {
  test(`kmc2taym: keys typed ${wait} ms after the connection drops reach the file in order once the page reconnects`, async (t) => {
    const { hub, proxy, page, file } = await setup(t);
    await page.type("ab");
    await expectFile(page, hub, file, "one\n\nab\n\ntwo\n");
    proxy.drop();
    await sleep(wait);
    await page.type("cd");
    await expectFile(page, hub, file, "one\n\nabcd\n\ntwo\n");
  });
}

test("kmc2taym: typing after the page has reconnected goes on where the caret is", async (t) => {
  const { hub, proxy, page, file } = await setup(t);
  await page.type("ab");
  await expectFile(page, hub, file, "one\n\nab\n\ntwo\n");
  const since = page.frames.length;
  proxy.drop();
  await page.until(() => page.frames.slice(since).some((f) => f.dir === "in" && f.data && f.data.type === "hello"), "the page reconnected", 8000);
  await page.quiet();
  await page.type("cd");
  await expectFile(page, hub, file, "one\n\nabcd\n\ntwo\n");
});
