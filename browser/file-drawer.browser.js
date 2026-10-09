import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "./harness.js";

const LONG = "this-filename-is-intentionally-long-enough-to-widen-the-files-pane.md";

const MEASURE = `(() => {
  const files = document.querySelector(".file-block");
  const tickets = document.querySelector(".ticket-block");
  const buttons = [...files.querySelectorAll("button.md-file")];
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  };
  return {
    files: box(files),
    tickets: box(tickets),
    texts: buttons.map((button) => button.textContent),
    clients: buttons.map((button) => button.clientWidth),
    position: getComputedStyle(files).position,
    inlineTop: files.style.top,
    inlineHeight: files.style.height,
    inlineLeft: files.style.left,
    wide: files.classList.contains("md-file-wide"),
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
    () => page.eval(`!document.querySelector(".file-block").classList.contains("md-file-wide")`),
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
      const el = document.querySelector(".file-block");
      return {
        width: el.getBoundingClientRect().width,
        target: Number.parseFloat(el.style.width),
        wide: el.classList.contains("md-file-wide"),
      };
    })()`);
    return state.wide && Number.isFinite(state.target) && state.width > before.files.width + 8 && Math.abs(state.width - state.target) < 1;
  }, "file pane width");
  const after = await page.eval(MEASURE);
  assert.deepEqual(after.texts, before.texts);
  assert.ok(after.clients[longAt] > before.clients[longAt]);
  near(after.files.top, before.files.top, "files top");
  near(after.files.height, before.files.height, "files height");
  near(after.files.left, before.files.left, "files left");
  assert.ok(after.files.width > before.files.width + 8);
  near(after.tickets.top, before.tickets.top, "tickets top");
  near(after.tickets.height, before.tickets.height, "tickets height");
  assert.equal(after.position, "relative");
  assert.equal(after.inlineTop, "");
  assert.equal(after.inlineHeight, "");
  assert.equal(after.inlineLeft, "");
  assert.equal(after.foreign, false);
  const x = before.files.left + before.files.width + (after.files.width - before.files.width) / 2;
  const y = after.files.top + after.files.height / 2;
  const hit = await page.eval(`(() => {
    const files = document.querySelector(".file-block");
    const node = document.elementFromPoint(${x}, ${y});
    const chain = [];
    for (let at = node; at && chain.length < 6; at = at.parentElement) {
      chain.push(at.tagName + (at.className ? "." + String(at.className).trim().split(/\\s+/).join(".") : ""));
    }
    return { inside: !!(node && files.contains(node)), chain: chain.join(" > ") };
  })()`);
  assert.equal(hit.inside, true, hit.chain);
});
