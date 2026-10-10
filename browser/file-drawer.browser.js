import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "./harness.js";

const LONG = "this-filename-is-intentionally-long-enough-to-widen-the-files-pane.md";

const MEASURE = `(() => {
  const files = document.querySelector(".file-block");
  const panel = document.querySelector(".md-file-drawer");
  const tickets = document.querySelector(".ticket-block");
  const head = files.querySelector(".md-pane-head");
  const buttons = [...files.querySelectorAll("button.md-file")];
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  };
  return {
    files: box(files),
    panel: box(panel),
    tickets: box(tickets),
    headButtons: [...head.querySelectorAll("button")].map(box),
    texts: buttons.map((button) => button.textContent),
    clients: buttons.map((button) => button.clientWidth),
    position: getComputedStyle(panel).position,
    inlineTop: panel.style.top,
    inlineHeight: panel.style.height,
    inlineLeft: panel.style.left,
    wide: panel.classList.contains("md-file-wide"),
    blockWide: files.classList.contains("md-file-wide"),
    blockWidth: files.style.width,
    headInBlock: head.parentElement === files,
    headInPanel: panel.contains(head),
    foreign: !!files.querySelector(".ticket-tree, .md-ticket"),
  };
})()`;

function near(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 1, `${label}: ${actual} vs ${expected}`);
}

test("hovered files pane stays in the column", async (t) => {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  await hub.create("short.md", "short\n");
  await hub.create(LONG, "long\n");
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.login();
  await page.open("short.md");
  await page.until(
    () => page.eval(`document.querySelectorAll(".file-block button.md-file").length >= 2 && !!document.querySelector(".ticket-block")`),
    "file buttons",
  );
  // A cursor left on the pane would open it before the compact rects are recorded.
  const away = await page.eval(`(() => {
    const editor = document.getElementById("editor");
    const r = editor.getBoundingClientRect();
    return { x: r.left + 40, y: r.top + 40 };
  })()`);
  await page.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: away.x, y: away.y });
  await page.until(
    () => page.eval(`!document.querySelector(".md-file-drawer").classList.contains("md-file-wide")`),
    "compact files pane",
  );
  await page.frame();
  const before = await page.eval(MEASURE);
  assert.ok(before.tickets.top > before.files.top + before.files.height - 1);
  assert.ok(before.texts.includes("short.md"));
  assert.ok(before.texts.includes(LONG));
  const longAt = before.texts.indexOf(LONG);
  await page.eval(`document.querySelector(".file-block").dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }))`);
  await page.until(async () => {
    const state = await page.eval(`(() => {
      const el = document.querySelector(".md-file-drawer");
      return {
        width: el.getBoundingClientRect().width,
        target: Number.parseFloat(el.style.width),
        wide: el.classList.contains("md-file-wide"),
      };
    })()`);
    return state.wide && Number.isFinite(state.target) && state.width > before.panel.width + 8 && Math.abs(state.width - state.target) < 1;
  }, "file pane width");
  const after = await page.eval(MEASURE);
  assert.deepEqual(after.texts, before.texts);
  assert.ok(after.clients[longAt] > before.clients[longAt]);
  near(after.files.top, before.files.top, "files top");
  near(after.files.height, before.files.height, "files height");
  near(after.files.left, before.files.left, "files left");
  near(after.files.width, before.files.width, "files width");
  near(after.panel.top, before.panel.top, "panel top");
  near(after.panel.left, before.panel.left, "panel left");
  near(after.panel.height, before.panel.height, "panel height");
  assert.ok(after.panel.width > before.panel.width + 8);
  assert.ok(before.headButtons.length >= 2);
  assert.equal(after.headButtons.length, before.headButtons.length);
  for (let i = 0; i < before.headButtons.length; i += 1) {
    near(after.headButtons[i].top, before.headButtons[i].top, `head ${i} top`);
    near(after.headButtons[i].left, before.headButtons[i].left, `head ${i} left`);
    near(after.headButtons[i].width, before.headButtons[i].width, `head ${i} width`);
    near(after.headButtons[i].height, before.headButtons[i].height, `head ${i} height`);
  }
  near(after.tickets.top, before.tickets.top, "tickets top");
  near(after.tickets.height, before.tickets.height, "tickets height");
  assert.equal(after.position, "relative");
  assert.equal(after.inlineTop, "");
  assert.equal(after.inlineHeight, "");
  assert.equal(after.inlineLeft, "");
  assert.equal(after.wide, true);
  assert.equal(after.blockWide, false);
  assert.equal(after.blockWidth, "");
  assert.equal(after.headInBlock, true);
  assert.equal(after.headInPanel, false);
  assert.equal(after.foreign, false);
  const x = before.panel.left + before.panel.width + (after.panel.width - before.panel.width) / 2;
  const y = after.panel.top + after.panel.height / 2;
  const hit = await page.eval(`(() => {
    const panel = document.querySelector(".md-file-drawer");
    const node = document.elementFromPoint(${x}, ${y});
    const chain = [];
    for (let at = node; at && chain.length < 6; at = at.parentElement) {
      chain.push(at.tagName + (at.className ? "." + String(at.className).trim().split(/\\s+/).join(".") : ""));
    }
    return { inside: !!(node && panel.contains(node)), chain: chain.join(" > ") };
  })()`);
  assert.equal(hit.inside, true, hit.chain);
});
