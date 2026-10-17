import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { launchBrowser, Page, startHub, startProxy } from "./harness.js";

// Keys typed while the page's socket is down and reconnecting were thrown away without a word:
// the page sends nothing on a dropped socket and queues nothing. Under the load of a full run this
// is what made TC.fc.1 write one backtick of three. The proxy drops the socket at a known moment,
// so this is the same every run.

const TEXT = "one\n\n\n\ntwo\n";

for (const wait of [0, 300]) {
  test(`keys typed ${wait} ms after the page's socket drops are in the file once the page has reconnected`, async (t) => {
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
    await page.key("`");
    await page.until(async () => (await hub.show(file)).text === "one\n\n`\n\ntwo\n", "the first backtick stored");
    proxy.drop();
    await sleep(wait);
    await page.key("`");
    await page.key("`");
    // The page reconnects on its own; give it time to, then the file must hold all three.
    await page.until(async () => (await hub.show(file)).text === "one\n\n```\n\ntwo\n", "all three backticks in the file", 8000).catch(async (err) => {
      assert.fail(`${err.message}: the file is ${JSON.stringify((await hub.show(file)).text)}`);
    });
  });
}
