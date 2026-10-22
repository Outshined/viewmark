import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { launchBrowser, onPath, Page, REPO, startHub } from "./harness.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function getRaw(port, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: requestPath, method: "GET", headers: { Connection: "close" } },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode, type: res.headers["content-type"] ?? "", body: Buffer.concat(chunks) });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function pasteFile(page, bytes, name, type) {
  const b64 = Buffer.from(bytes).toString("base64");
  return page.eval(`(() => {
    const bin = atob(${JSON.stringify(b64)});
    const raw = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) raw[i] = bin.charCodeAt(i);
    const file = new File([raw], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} });
    const data = new DataTransfer();
    data.items.add(file);
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: data });
    document.getElementById("editor").dispatchEvent(event);
    return true;
  })()`);
}

test("picture: a paste inside alpha beta leaves that paragraph and draws the image after it", async (t) => {
  if (!onPath(process.env.VIEWMARK_FIREFOX || "firefox")) {
    t.skip("firefox is not installed");
    return;
  }
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  await hub.create("shot.md", "alpha beta\n");
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.login();
  await page.open("shot.md");
  assert.equal(await page.clickOffset("alpha be".length), true);
  await page.quiet();
  await pasteFile(page, PNG, "shot.png", "image/png");
  const imageLine = /^alpha beta\n\n!\[([23456789abcdefghjkmnpqrstuvwxyz]{8}\.png)\]\(shot\/\1\)\n$/;
  let shown;
  await page.until(async () => {
    shown = await hub.show("shot.md");
    return imageLine.test(shown.text);
  }, "the image line follows alpha beta");
  const match = /^alpha beta\n\n!\[([23456789abcdefghjkmnpqrstuvwxyz]{8}\.png)\]\(shot\/\1\)\n$/.exec(shown.text);
  assert.ok(match, shown.text);
  const name = match[1];
  assert.equal(shown.text.includes("alpha be\n"), false);
  await page.quiet();
  const caret = await page.caret();
  assert.equal(caret.focus, shown.text.length);
  const drawn = await page.eval(`(() => {
    const img = document.querySelector("#editor .md-image img");
    if (!img) return null;
    return { alt: img.alt, src: img.getAttribute("src") };
  })()`);
  assert.equal(drawn.alt, name);
  assert.ok(drawn.src.includes(`/raw/${REPO}/shot/${name}`));
  const raw = await getRaw(hub.port, `/raw/${REPO}/shot/${name}`);
  assert.equal(raw.status, 200);
  assert.equal(raw.type, "image/png");
  assert.ok(raw.body.equals(PNG));

  // A click on the picture, as a person makes it. A focus() and a synthetic click with the key
  // right after let the focus's own selection change land after the click and collapse it.
  const at = await page.eval(`window.__qaTarget("image")`);
  await page.click(at.x, at.y);
  await page.quiet();
  const selected = await page.eval(`!!document.querySelector("#editor .md-image.md-atom-selected")`);
  assert.equal(selected, true);
  await page.key("Backspace");
  await page.quiet();
  const removed = await hub.show("shot.md");
  assert.equal(removed.text.includes(`![${name}]`), false);
  assert.equal(removed.text.startsWith("alpha beta\n"), true);
  const still = await getRaw(hub.port, `/raw/${REPO}/shot/${name}`);
  assert.equal(still.status, 200);
  assert.ok(still.body.equals(PNG));

  await page.key("z", ["Ctrl"]);
  await page.quiet();
  const restored = await hub.show("shot.md");
  assert.equal(restored.text, shown.text);
  await page.until(
    () => page.eval(`!!document.querySelector("#editor .md-image img")`),
    "the picture is drawn again",
  );
  const back = await getRaw(hub.port, `/raw/${REPO}/shot/${name}`);
  assert.equal(back.status, 200);
  assert.ok(back.body.equals(PNG));

  await pasteFile(page, Buffer.from("not an image"), "note.txt", "text/plain");
  await page.until(
    () => page.eval(`(document.querySelector(".md-notice") || {}).textContent === "not an image"`),
    "a short notice",
  );
  assert.equal((await hub.show("shot.md")).text, shown.text);
});
