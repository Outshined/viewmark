import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "./harness.js";

const OPEN = `(() => { const el = document.querySelector(".md-app-menu-panel"); return !!el && !el.hidden && el.getClientRects().length > 0; })()`;

function rgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`;
}

async function setup(t) {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  await hub.create("a.md", "A paragraph.\n\n# Heading\n\nA [link](https://example.com) and `code`.\n");
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.login();
  await page.open("a.md");
  await page.until(() => page.eval(`(() => { const name = document.querySelector(".md-path-name"); return !!name && name.textContent === "a.md"; })()`), "document open");
  return { hub, page };
}

async function clickText(page, text) {
  const point = await page.eval(`(() => {
    const el = [...document.querySelectorAll(".md-app-menu-panel button")].find((node) => (node.textContent || "").trim() === ${JSON.stringify(text)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
  })()`);
  assert.ok(point, text);
  await page.click(point.x, point.y);
  await page.quiet();
}

async function openPageMenu(page) {
  if (await page.eval(OPEN)) return;
  const point = await page.eval(`(() => {
    const el = document.querySelector("button.md-app-menu");
    const r = el.getBoundingClientRect();
    return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
  })()`);
  await page.click(point.x, point.y);
  await page.until(() => page.eval(OPEN), "page menu open");
}

function readPage(page) {
  return page.eval(`(() => {
    const button = document.querySelector("button.md-app-menu");
    const svg = button && button.querySelector("svg");
    const app = document.querySelector(".md-app-menu-panel");
    const box = button.getBoundingClientRect();
    const strip = getComputedStyle(document.querySelector(".md-path-strip"));
    const body = getComputedStyle(document.body);
    const radios = [...app.querySelectorAll("[role='menuitemradio']")].map((el) => ({
      text: el.textContent.trim(),
      checked: el.getAttribute("aria-checked"),
    }));
    return {
      label: button.getAttribute("aria-label"),
      title: button.getAttribute("title"),
      position: getComputedStyle(button).position,
      top: box.top,
      rightGap: innerWidth - box.right,
      theme: document.documentElement.getAttribute("data-theme"),
      stored: localStorage.getItem("viewmark.theme"),
      themed: svg && svg.getAttribute("data-themed"),
      glyphTheme: svg && svg.getAttribute("data-theme"),
      strokes: svg ? [...svg.querySelectorAll("path")].map((path) => path.getAttribute("stroke")) : [],
      appItems: [...app.querySelectorAll("button")].map((el) => el.textContent.trim()),
      radios,
      body: body.backgroundColor,
      strip: strip.backgroundColor,
      heading: getComputedStyle(document.querySelector(".md-h1")).color,
    };
  })()`);
}

test("the page menu switches Original, Wood cut, and Stained glass", async (t) => {
  const { page } = await setup(t);
  const place = await readPage(page);
  assert.equal(place.label, "Page menu");
  assert.equal(place.title, "Open the page menu");
  assert.equal(place.position, "fixed");
  assert.ok(place.top < 20, `page menu top ${place.top}`);
  assert.ok(place.rightGap < 20, `page menu right gap ${place.rightGap}`);
  assert.equal(place.theme, null);
  assert.equal(place.stored, null);
  assert.equal(place.themed, null);
  assert.deepEqual(place.appItems, ["Vim keys", "Original", "Wood cut", "Stained glass"]);
  assert.equal(place.body, rgb("#1c1b19"));

  await openPageMenu(page);
  await clickText(page, "Wood cut");
  const wood = await readPage(page);
  assert.equal(wood.theme, "woodcut");
  assert.equal(wood.stored, "woodcut");
  assert.equal(wood.themed, "1");
  assert.equal(wood.glyphTheme, "woodcut");
  assert.ok(wood.strokes.includes("#1f1a15"));
  assert.ok(wood.strokes.includes("#fbf6ea"));
  assert.equal(wood.body, rgb("#e8dbbd"));
  assert.equal(wood.strip, rgb("#f4ead2"));
  assert.equal(wood.radios.find((item) => item.text === "Wood cut").checked, "true");
  assert.equal(wood.radios.find((item) => item.text === "Original").checked, "false");

  await openPageMenu(page);
  await clickText(page, "Stained glass");
  const glass = await readPage(page);
  assert.equal(glass.theme, "glass");
  assert.equal(glass.stored, "glass");
  assert.equal(glass.glyphTheme, "glass");
  assert.ok(glass.strokes.includes("#f0c860"));
  assert.ok(glass.strokes.includes("#15100c"));
  assert.equal(glass.body, rgb("#0f0b09"));
  assert.equal(glass.strip, rgb("#231b15"));
  assert.equal(glass.heading, rgb("#f0c860"));
  assert.equal(glass.radios.find((item) => item.text === "Stained glass").checked, "true");

  await openPageMenu(page);
  await clickText(page, "Original");
  const back = await readPage(page);
  assert.equal(back.theme, null);
  assert.equal(back.stored, null);
  assert.equal(back.themed, null);
  assert.equal(back.body, rgb("#1c1b19"));
  assert.equal(back.strip, rgb("#1c1b19"));
  assert.equal(back.radios.find((item) => item.text === "Original").checked, "true");
});
