import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { USER, launchBrowser, Page, startHub } from "./harness.js";

// Ticket ehfygfdk. With vim keys on, Insert is one undo through a pause, Enter,
// and Backspace, and an arrow ends that step. With vim keys off, those still end
// the typing run (R92, R109).

const LINES = "alpha\n\nbeta";
const PARA = "alpha\n";

async function setup(t, text, vim) {
  const hub = await startHub();
  const browser = await launchBrowser();
  t.after(async () => {
    await browser.close();
    await hub.close();
  });
  const file = await hub.create("a.md", text);
  const page = new Page(browser.session, hub.port);
  await page.init();
  if (vim) await page.session.send("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem("viewmark.vim", "1");` });
  await page.login(USER);
  await page.open(file);
  return { hub, page, file };
}

async function at(page, offset, vim) {
  assert.ok(await page.clickOffset(offset), `no point at ${offset}`);
  await page.quiet();
  if (vim) {
    await page.key("Escape");
    await page.quiet();
  }
  const caret = await page.caret();
  assert.equal(caret.focus, offset, `the click did not put the caret at ${offset}`);
  assert.equal(caret.anchor, caret.focus);
}

function status(page) {
  return page.eval(`document.querySelector(".md-vim-status").textContent`);
}

async function doc(hub, file) {
  return (await hub.show(file)).text;
}

async function press(page, name, modifiers = []) {
  await page.key(name, modifiers);
  await page.quiet();
}

async function type(page, text) {
  await page.type(text);
  await page.quiet();
}

async function enterInsert(page) {
  await press(page, "i");
  assert.equal(await status(page), "I");
}

test("ehfygfdk: with vim keys on, an arrow in Insert ends the undo step, so one u takes back yy, the next takes back xx, and Ctrl-R puts xx back, then yy", async (t) => {
  const { hub, page, file } = await setup(t, LINES, true);
  await at(page, 0, true);
  assert.equal(await status(page), "N");
  await enterInsert(page);
  await type(page, "xx");
  assert.equal(await doc(hub, file), "xxalpha\n\nbeta");
  assert.equal((await page.caret()).focus, 2);
  await press(page, "↓");
  assert.equal(await status(page), "I", "an arrow left Insert");
  assert.notEqual((await page.caret()).focus, 2, "ArrowDown left the caret where xx ended");
  assert.equal(await doc(hub, file), "xxalpha\n\nbeta", "ArrowDown wrote text");
  await type(page, "yy");
  await press(page, "Escape");
  assert.equal(await status(page), "N");
  const edited = await doc(hub, file);
  assert.notEqual(edited, "xxalpha\n\nbeta");
  assert.equal(edited.includes("xx"), true, edited);
  assert.equal(edited.includes("yy"), true, edited);
  await press(page, "u");
  assert.equal(await doc(hub, file), "xxalpha\n\nbeta");
  await press(page, "u");
  assert.equal(await doc(hub, file), LINES);
  await press(page, "r", ["Ctrl"]);
  assert.equal(await doc(hub, file), "xxalpha\n\nbeta");
  await press(page, "r", ["Ctrl"]);
  assert.equal(await doc(hub, file), edited);
});

test("ehfygfdk: with vim keys on, a pause stays in the one Insert undo", async (t) => {
  const { hub, page, file } = await setup(t, PARA, true);
  await at(page, PARA.length - 1, true);
  await enterInsert(page);
  await type(page, "xy");
  await sleep(1500);
  await press(page, "z");
  assert.equal(await status(page), "I");
  assert.equal(await doc(hub, file), "alphaxyz\n");
  await press(page, "Escape");
  assert.equal(await status(page), "N");
  await press(page, "u");
  assert.equal(await doc(hub, file), PARA);
});

test("ehfygfdk: with vim keys on, Enter stays in the one Insert undo", async (t) => {
  const { hub, page, file } = await setup(t, PARA, true);
  await at(page, PARA.length - 1, true);
  await enterInsert(page);
  await press(page, "x");
  await press(page, "Enter");
  await press(page, "y");
  const edited = await doc(hub, file);
  assert.notEqual(edited, PARA);
  assert.equal(edited.includes("x"), true, edited);
  assert.equal(edited.includes("y"), true, edited);
  await press(page, "Escape");
  assert.equal(await status(page), "N");
  await press(page, "u");
  assert.equal(await doc(hub, file), PARA);
});

test("ehfygfdk: with vim keys on, Backspace stays in the one Insert undo", async (t) => {
  const { hub, page, file } = await setup(t, PARA, true);
  await at(page, PARA.length - 1, true);
  await enterInsert(page);
  await press(page, "x");
  await press(page, "Backspace");
  await press(page, "y");
  assert.equal(await doc(hub, file), "alphay\n");
  await press(page, "Escape");
  assert.equal(await status(page), "N");
  await press(page, "u");
  assert.equal(await doc(hub, file), PARA);
  await press(page, "u");
  assert.equal(await doc(hub, file), PARA);
});

test("ehfygfdk: with vim keys off, a pause over one second, an arrow, Enter, and Backspace still end the typing run", async (t) => {
  const { hub, page, file } = await setup(t, PARA, false);
  assert.equal(await page.eval(`localStorage.getItem("viewmark.vim")`), null);
  await at(page, PARA.length - 1, false);
  await press(page, "x");
  await sleep(1500);
  await press(page, "y");
  assert.equal(await doc(hub, file), "alphaxy\n");
  await press(page, "z", ["Ctrl"]);
  assert.equal(await doc(hub, file), "alphax\n");
  await press(page, "z", ["Ctrl"]);
  assert.equal(await doc(hub, file), PARA);

  const arrow = await hub.create("arrow.md", PARA);
  await page.open(arrow);
  await at(page, 2, false);
  await type(page, "xy");
  assert.equal(await doc(hub, arrow), "alxypha\n");
  await press(page, "←");
  await press(page, "z");
  assert.equal(await doc(hub, arrow), "alxzypha\n");
  await press(page, "z", ["Ctrl"]);
  assert.equal(await doc(hub, arrow), "alxypha\n");

  const entered = await hub.create("enter.md", PARA);
  await page.open(entered);
  await at(page, PARA.length - 1, false);
  await press(page, "x");
  assert.equal(await doc(hub, entered), "alphax\n");
  await press(page, "Enter");
  const afterEnter = await doc(hub, entered);
  assert.notEqual(afterEnter, "alphax\n");
  assert.equal(afterEnter.includes("x"), true, afterEnter);
  await press(page, "y");
  const afterY = await doc(hub, entered);
  assert.notEqual(afterY, afterEnter);
  assert.equal(afterY.includes("y"), true, afterY);
  await press(page, "z", ["Ctrl"]);
  assert.equal(await doc(hub, entered), afterEnter);

  const back = await hub.create("back.md", PARA);
  await page.open(back);
  await at(page, PARA.length - 1, false);
  await type(page, "xy");
  await press(page, "Backspace");
  await press(page, "z");
  assert.equal(await doc(hub, back), "alphaxz\n");
  await press(page, "z", ["Ctrl"]);
  assert.equal(await doc(hub, back), "alphax\n");
});
