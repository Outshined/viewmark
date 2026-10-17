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
  return { hub, proxy, page, file, browser };
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

// R97 and D26: a key on a part another session holds is refused, the text stays, and that
// session's name flashes on the part. A key held while the page was away is no different.
test("kmc2taym: keys typed while the page is away, on a line another session takes meanwhile, are refused once the page reconnects, the holder's name flashes, and nothing is written", async (t) => {
  const { hub, proxy, page, file, browser } = await setup(t);
  await page.type("ab");
  await expectFile(page, hub, file, "one\n\nab\n\ntwo\n");
  const { session } = await browser.newSession();
  const other = new Page(session, hub.port);
  await other.init();
  await other.login("bea");
  await other.open(file);
  proxy.offline();
  // The hub lets go of the page's line when its socket closes. Then the other session can take it.
  // The hub's locks message says who holds it: line 2 is ab.
  const holds = () => other.frames.some((f) => f.dir === "in" && f.data && f.data.type === "locks" && (f.data.lines || []).some((line) => line.index === 2 && line.username === "bea"));
  await other.until(async () => {
    if (!holds()) {
      await other.clickOffset("one\n\na".length);
      await other.quiet();
    }
    return holds();
  }, "the hub says bea holds the line", 8000);
  await page.type("cd");
  const since = page.frames.length;
  proxy.online();
  await page.until(() => page.frames.slice(since).some((f) => f.dir === "in" && f.data && f.data.type === "hello"), "the page reconnected", 8000);
  await page.until(() => page.eval(`window.__qa.flashes.some((seen) => seen.name.includes("bea") && seen.block.includes("ab"))`), "bea flashes on the line", 8000).catch(async (err) => {
    const sent = page.frames.slice(since).filter((f) => f.dir === "out" && f.data && ["edit", "lock", "open"].includes(f.data.type)).map((f) => ({ type: f.data.type, op: f.data.op, text: f.data.text, cursor: f.data.cursor }));
    const errors = page.frames.slice(since).filter((f) => f.dir === "in" && f.data && f.data.type === "error").map((f) => f.data);
    const got = page.frames.slice(since).filter((f) => f.dir === "in" && f.data).map((f) => (f.data.type === "locks" ? `locks ${JSON.stringify(f.data.lines)}` : f.data.type));
    const locks = await page.eval(`[...document.querySelectorAll("#editor .md-lock")].map((l) => l.textContent + " on " + (l.closest(".md-line, .md-atom") || {}).textContent)`);
    assert.fail(`${err.message}: the file is ${JSON.stringify((await hub.show(file)).text)}; after reconnecting the page sent ${JSON.stringify(sent)}, got errors ${JSON.stringify(errors)}, received ${JSON.stringify(got)}, and draws the names ${JSON.stringify(locks)}`);
  });
  await page.quiet();
  await sleep(1000);
  assert.equal((await hub.show(file)).text, "one\n\nab\n\ntwo\n", "a refused key was written");
  assert.equal(await page.eval(`document.getElementById("editor").textContent.includes("abc")`), false, "the page still draws a refused key");
});
