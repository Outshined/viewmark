import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { launchBrowser, Page, startHub } from "./harness.js";

// R94: an edit by someone else moves the caret only when it lands before the caret, and the
// caret keeps its place in the text. Here the CLI adds `zero` and a blank line at the top of the
// file while the page's caret sits further down. The caret the page draws moves with its text,
// and the next key goes in there.

const ADDED = "zero\n\n";
const CASES = [
  { name: "in the first paragraph", text: "alpha beta\n", at: 3 },
  { name: "on the empty line of a fence that is the first block", text: "```\na\n\nb\n```\n", at: 6 },
  { name: "after a in a fence that is the first block", text: "```\na\n\nb\n```\n", at: 5 },
  { name: "in a paragraph after another", text: "one\n\nalpha beta\n", at: 8 },
  { name: "after a in a fence after a paragraph", text: "one\n\n```\na\n\nb\n```\n", at: 10 },
];

// A hunk that adds ADDED before the first line, with the first two lines as context so the
// hunk matches once.
function prepend(text) {
  const context = text.split("\n").slice(0, 2).filter((line, i) => i === 0 || line !== "");
  return ["--- a", "+++ b", "@@", ...ADDED.slice(0, -1).split("\n").map((line) => `+${line}`), ...context.map((line) => ` ${line}`), ""].join("\n");
}

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
  await page.login();
  return { hub, page };
}

for (const { name, text, at } of CASES) {
  test(`R94: with the caret ${name}, a line the CLI adds at the top of the file moves the caret with its text, and the next key goes in there`, async (t) => {
    const { hub, page } = await setup(t);
    const file = await hub.create("a.md", text);
    await page.open(file);
    assert.equal(await page.clickOffset(at), true, `no point at ${at}`);
    await page.quiet();
    assert.equal((await page.caret()).focus, at, "the click did not put the caret there");
    const done = await hub.edit(file, prepend(text));
    assert.equal(done.code, 0, `the CLI's edit was refused: ${done.stdout}${done.stderr}`);
    await page.quiet();
    // A person reads the screen before typing again.
    await sleep(300);
    const caret = await page.caret();
    assert.equal(caret.focus, at + ADDED.length, `the caret is drawn at ${caret.focus}, not at ${at + ADDED.length}, where its text moved`);
    assert.equal(caret.anchor, caret.focus, `the caret is a selection from ${caret.anchor} to ${caret.focus}`);
    await page.type("X");
    const want = ADDED + text.slice(0, at) + "X" + text.slice(at);
    await page.until(async () => (await hub.show(file)).text === want, "X in the file", 3000).catch(async (err) => {
      assert.fail(`${err.message}: wanted ${JSON.stringify(want)}, the file is ${JSON.stringify((await hub.show(file)).text)}`);
    });
  });
}
