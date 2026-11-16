import test from "node:test";
import assert from "node:assert/strict";
import { REPO, USER, cli, launchBrowser, Page, startHub } from "./harness.js";

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
      paints: svg ? [...svg.querySelectorAll("path,rect,circle,stop")].flatMap((node) => [node.getAttribute("stroke"), node.getAttribute("fill"), node.getAttribute("stop-color")].filter(Boolean)) : [],
      appItems: [...app.querySelectorAll("button")].map((el) => el.textContent.trim()),
      radios,
      body: body.backgroundColor,
      bodyImage: body.backgroundImage,
      strip: strip.backgroundColor,
      heading: getComputedStyle(document.querySelector(".md-h1")).color,
      editor: getComputedStyle(document.querySelector("#editor")).backgroundColor,
      editorImage: getComputedStyle(document.querySelector("#editor")).backgroundImage,
      frame: getComputedStyle(document.querySelector("#editor"), "::after").borderImageSource,
      corner: (() => {
        const toggle = document.querySelector("button.md-view-toggle");
        const rect = toggle.getBoundingClientRect();
        const hit = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
        const button = hit && hit.closest ? hit.closest("button") : null;
        return button ? button.className : "";
      })(),
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
  assert.ok(wood.paints.includes("#1f1a15"));
  assert.ok(wood.paints.includes("#f4ead2"));
  assert.equal(wood.body, rgb("#e8dbbd"));
  assert.equal(wood.bodyImage, "none");
  assert.equal(wood.strip, rgb("#f4ead2"));
  assert.equal(wood.editor, rgb("#fbf6ea"));
  assert.ok(wood.editorImage.includes("clouds.svg"), wood.editorImage);
  assert.ok(wood.editorImage.includes("edges.svg"), wood.editorImage);
  assert.ok(wood.frame.includes("woodcut/pane.svg"), wood.frame);
  assert.ok(wood.corner.includes("md-view-toggle"), wood.corner);
  assert.equal(wood.radios.find((item) => item.text === "Wood cut").checked, "true");
  assert.equal(wood.radios.find((item) => item.text === "Original").checked, "false");

  await openPageMenu(page);
  await clickText(page, "Stained glass");
  const glass = await readPage(page);
  assert.equal(glass.theme, "glass");
  assert.equal(glass.stored, "glass");
  assert.equal(glass.glyphTheme, "glass");
  assert.ok(glass.paints.includes("#15100c"));
  assert.ok(glass.paints.includes("#ffe46a"));
  assert.ok(glass.paints.includes("#c08a00"));
  assert.equal(glass.body, rgb("#0f0b09"));
  assert.equal(glass.strip, rgb("#231b15"));
  assert.ok(glass.frame.includes("glass/pane.svg"), glass.frame);
  assert.ok(glass.corner.includes("md-view-toggle"), glass.corner);
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

async function pointOf(page, selector) {
  const point = await page.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    return { x: r.left + Math.min(16, r.width / 2), y: r.top + r.height / 2 };
  })()`);
  assert.ok(point, selector);
  return point;
}

async function moveTo(page, selector) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const point = await pointOf(page, selector);
    await page.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    await page.frame();
    const hovered = await page.eval(`document.querySelector(${JSON.stringify(selector)}).matches(":hover")`);
    if (hovered) return;
  }
  assert.fail(`${selector} is not under the pointer`);
}

async function restPointer(page) {
  const away = await page.eval(`(() => {
    const r = document.getElementById("editor").getBoundingClientRect();
    return { x: Math.min(r.right - 24, r.left + r.width * 0.75), y: r.top + 80 };
  })()`);
  await page.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: away.x, y: away.y });
  await page.until(
    () => page.eval(`!document.querySelector(".md-file-drawer").classList.contains("md-file-wide") && !document.querySelector(".md-ticket-drawer").classList.contains("md-ticket-wide")`),
    "the panes at rest",
  );
  await page.frame();
}

function paintOf(page, selector) {
  return page.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    const style = getComputedStyle(el);
    return { background: style.backgroundColor, color: style.color };
  })()`);
}

test("Wood cut table headings and list rows stay readable, and Files highlights like Tickets", async (t) => {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  await hub.create("a.md", "A line.\n\n| Name | Note |\n| --- | --- |\n| One | Two |\n");
  await hub.create("b.md", "Second.\n");
  await hub.create("notes/c.md", "Inside.\n");
  const made = await cli(hub.port, ["--user", USER, "--repo", REPO, "ticket", "create", "--title", "Drawer row"], "Body.\n");
  assert.equal(made.code, 0, made.stderr);
  const id = made.stdout.trim().split("\n")[0];
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.login();
  await page.open("a.md");
  const file = `.file-tree button.md-file[data-path="b.md"]`;
  const dir = `.file-tree button.md-dir-toggle[data-dir="notes"]`;
  const current = `.file-tree button.md-file.md-file-current`;
  const row = ".ticket-tree .md-ticket-row";
  await page.until(() => page.eval(`!!document.querySelector(".md-table th")`), "the table heading");
  await page.until(() => page.eval(`!!document.querySelector(${JSON.stringify(file)})`), "the other file");
  await page.until(() => page.eval(`!!document.querySelector(${JSON.stringify(dir)})`), "the directory");
  await page.until(() => page.eval(`!!document.querySelector(${JSON.stringify(row)})`), "the ticket row");
  await restPointer(page);
  const openFile = await paintOf(page, current);
  assert.equal(openFile.background, rgb("#3d5a80"));
  await moveTo(page, file);
  const fileHover = await paintOf(page, file);
  assert.equal(fileHover.background, rgb("#2c3440"));
  await moveTo(page, dir);
  const dirHover = await paintOf(page, dir);
  assert.equal(dirHover.background, rgb("#2c3440"));
  await restPointer(page);
  await moveTo(page, row);
  const ticketHover = await paintOf(page, row);
  assert.equal(ticketHover.background, rgb("#2c3440"));

  await openPageMenu(page);
  await clickText(page, "Wood cut");
  await restPointer(page);
  const head = await paintOf(page, ".md-table th");
  assert.equal(head.background, rgb("#e7d3a8"));
  assert.equal(head.color, rgb("#1f1a15"));
  const woodOpen = await paintOf(page, current);
  assert.equal(woodOpen.background, rgb("#c4a574"));
  assert.equal(woodOpen.color, rgb("#1f1a15"));
  await moveTo(page, file);
  const woodFile = await paintOf(page, file);
  assert.equal(woodFile.background, rgb("#ece0c2"));
  assert.equal(woodFile.color, rgb("#1f1a15"));
  await moveTo(page, dir);
  const woodDir = await paintOf(page, dir);
  assert.equal(woodDir.background, rgb("#ece0c2"));
  assert.equal(woodDir.color, rgb("#1f1a15"));
  await restPointer(page);
  await moveTo(page, row);
  const woodTicket = await paintOf(page, row);
  assert.equal(woodTicket.background, rgb("#ece0c2"));
  assert.equal(woodTicket.color, rgb("#1f1a15"));
  const ticketButton = await paintOf(page, `${row} button.md-ticket`);
  assert.equal(ticketButton.background, "rgba(0, 0, 0, 0)");
  assert.equal(ticketButton.color, rgb("#1f1a15"));

  const since = page.frames.length;
  page.loads = (page.loads || 0) + 1;
  await page.session.send("Page.navigate", { url: `http://127.0.0.1:${page.port}/?load=${page.loads}#${REPO}/ticket/${encodeURIComponent(id)}` });
  await page.until(() => page.frames.slice(since).some((frame) => frame.dir === "in" && frame.data && frame.data.type === "file" && frame.data.path === `tickets/${id}.md`), "open ticket");
  await page.until(() => page.eval(`!!document.querySelector(".md-ticket-current")`), "current ticket row");
  await restPointer(page);
  const woodCurrent = await paintOf(page, ".ticket-tree .md-ticket-row.md-ticket-current");
  assert.equal(woodCurrent.background, rgb("#c4a574"));
  assert.equal(woodCurrent.color, rgb("#1f1a15"));
});
