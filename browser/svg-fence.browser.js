import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, onPath, Page, startHub } from "./harness.js";

// An svg fence draws as an img while the caret is outside it. The caret inside
// shows the fence source. A javascript fence that contains an svg tag stays code.
// The picture is an img, so a script in the file has no element to run in.

const SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"40\" height=\"20\"><rect width=\"40\" height=\"20\"/></svg>";
const DOC = `Above\n\n\`\`\`svg\n${SVG}\n\`\`\`\n`;
const JS = "Above\n\n```js\n<svg width=\"40\" height=\"20\"></svg>\n```\n";

test("an svg fence draws an img outside the caret and source inside", { timeout: 120000 }, async (t) => {
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
  const picture = await hub.create("picture.md", DOC);
  const code = await hub.create("code.md", JS);
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.login();
  await page.open(picture);
  const drawn = await page.eval(`(() => {
    const editor = document.querySelector("#editor");
    const img = editor && editor.querySelector("img");
    if (!img) return null;
    return {
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      svg: editor.querySelectorAll("svg").length,
      script: editor.querySelectorAll("script").length,
    };
  })()`);
  assert.ok(drawn, "the fence did not draw an img");
  assert.ok(drawn.naturalWidth > 0, `natural width ${drawn.naturalWidth}`);
  assert.equal(drawn.naturalWidth, 40);
  assert.equal(drawn.naturalHeight, 20);
  assert.equal(drawn.svg, 0);
  assert.equal(drawn.script, 0);
  const box = await page.eval(`(() => {
    const img = document.querySelector("#editor img");
    const rect = img.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await page.click(box.x, box.y);
  await page.quiet();
  const opened = await page.eval(`(() => {
    const editor = document.querySelector("#editor");
    return {
      img: editor.querySelectorAll("img").length,
      svg: editor.querySelectorAll("svg").length,
      text: editor.textContent,
    };
  })()`);
  assert.equal(opened.img, 0);
  assert.equal(opened.svg, 0);
  assert.ok(opened.text.includes("<svg"));
  assert.ok(opened.text.includes("rect"));
  assert.ok(opened.text.includes("```svg"));
  const caret = await page.caret();
  assert.equal(caret.focus, DOC.indexOf("<svg"));

  await page.open(code);
  const js = await page.eval(`(() => {
    const editor = document.querySelector("#editor");
    return {
      img: editor.querySelectorAll("img").length,
      svg: editor.querySelectorAll(".md-svg").length,
      text: editor.textContent,
    };
  })()`);
  assert.equal(js.img, 0);
  assert.equal(js.svg, 0);
  assert.ok(js.text.includes("<svg"));
  assert.equal(js.text.includes("```svg"), false);
});
