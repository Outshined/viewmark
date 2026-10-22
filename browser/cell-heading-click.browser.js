import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "./harness.js";

// Ticket sva8uk2r. A click on a drawn heading letter in a table cell opens the
// table with the caret on that letter, not the first hash. A click on a drawn
// letter of a list word, a quote word, a code word, or a plain word lands on
// that letter. Vim keys are off.

const HEAD = "## Kennel";
const LIST = "- listed";
const QUOTE = "> quoted";
const CODE = "`coded`";
const PLAIN = "plain";
const TEXT = [
  "Lead.",
  "",
  "| head |",
  "| --- |",
  `| ${HEAD} |`,
  "",
  "| list |",
  "| --- |",
  `| ${LIST} |`,
  "",
  "| quote |",
  "| --- |",
  `| ${QUOTE} |`,
  "",
  "| code |",
  "| --- |",
  `| ${CODE} |`,
  "",
  "| word |",
  "| --- |",
  `| ${PLAIN} |`,
  "",
].join("\n");
const VIM = "viewmark.vim";

async function setup(t) {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  const file = await hub.create("cell.md", TEXT);
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.login();
  await page.eval(`localStorage.removeItem(${JSON.stringify(VIM)})`);
  await page.open(file);
  return { page };
}

function wordPoint(page, word, index) {
  return page.eval(`window.__qaWordPoint(${JSON.stringify(word)}, 1, ${index})`);
}

test("sva8uk2r: a click on a heading letter in a table cell opens on that letter", { timeout: 180000 }, async (t) => {
  const { page } = await setup(t);
  const kennel = TEXT.indexOf("Kennel");
  const hash = TEXT.indexOf(HEAD);
  const listed = TEXT.indexOf("listed");
  const quoted = TEXT.indexOf("quoted");
  const coded = TEXT.indexOf("coded");
  const plainAt = TEXT.indexOf(PLAIN);
  assert.equal(TEXT[hash], "#");
  assert.equal(kennel, hash + 3);
  assert.equal(TEXT[kennel + 2], "n");
  assert.equal(TEXT[listed + 2], "s");
  assert.equal(TEXT[quoted + 1], "u");
  assert.equal(TEXT[coded + 2], "d");
  assert.equal(TEXT[plainAt + 3], "i");
  assert.equal(TEXT.slice(plainAt, plainAt + PLAIN.length), PLAIN);
  assert.equal(await page.eval(`document.querySelector("#editor").classList.contains("md-vim-block")`), false);

  const drawn = await page.eval(`(() => {
    const cell = [...document.querySelectorAll("#editor td")].find((el) => el.textContent.includes("Kennel"));
    return cell ? cell.textContent : "";
  })()`);
  assert.equal(drawn.includes("Kennel"), true);
  assert.equal(drawn.includes("#"), false);

  const stay = async (word, index, at, ch) => {
    let point = null;
    await page.until(async () => {
      point = await wordPoint(page, word, index);
      return !!point;
    }, `the ${word} letter`, 15000);
    await page.click(point.x, point.y);
    await page.quiet();
    const caret = await page.caret();
    assert.equal(caret.focus, at, `${word} landed at ${caret.focus}, source ${JSON.stringify(TEXT.slice(at, at + word.length + 2))}`);
    assert.equal(caret.anchor, caret.focus);
    assert.equal(TEXT[caret.focus], ch);
  };

  await stay("listed", 2, listed + 2, "s");
  await stay("quoted", 1, quoted + 1, "u");
  await stay("coded", 2, coded + 2, "d");
  await stay("plain", 3, plainAt + 3, "i");

  let point = null;
  await page.until(async () => {
    point = await wordPoint(page, "Kennel", 2);
    return !!point;
  }, "the heading letter", 15000);
  await page.click(point.x, point.y);
  await page.quiet();
  const caret = await page.caret();
  assert.equal(caret.focus, kennel + 2, `landed at ${caret.focus}, source ${JSON.stringify(TEXT.slice(hash, hash + HEAD.length))}`);
  assert.equal(caret.anchor, caret.focus);
  assert.equal(TEXT[caret.focus], "n");
  assert.notEqual(caret.focus, hash);
  assert.equal(await page.eval(`document.querySelector("#editor").textContent.includes(${JSON.stringify(HEAD)})`), true);
  assert.equal(await page.eval(`!![...document.querySelectorAll("#editor td")].find((el) => el.textContent.includes("Kennel") && !el.textContent.includes("#"))`), false);
});
