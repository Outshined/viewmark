import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "./harness.js";

// The blank under Alpha is a gap line. Heading and Beta share no blank, so the
// gap is only the heading's trail. The list's blank lines are gap lines too.
const DOC = "Alpha\n\n# Heading\nBeta\n\n- one\n- two\n\nGamma\n";

function near(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) <= 1, `${label}: ${actual} vs ${expected} (limit 1px)`);
}

test("rendered block gaps are one measure", async (t) => {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  await hub.create("gaps.md", DOC);
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.login();
  await page.open("gaps.md");
  assert.ok(await page.clickOffset(DOC.indexOf("Gamma") + 1), "no point in Gamma");
  await page.quiet();
  const measured = await page.eval(`(() => {
    const lines = [...document.querySelectorAll("#editor .md-line")];
    const find = (text) => lines.find((el) => el.textContent.trim() === text);
    // Glyph rects stop at the em box, inside the half-leading, so they count
    // that leading as gap. The content box is the line box for one line.
    const lineBox = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return {
        top: r.top + parseFloat(s.borderTopWidth) + parseFloat(s.paddingTop),
        bottom: r.bottom - parseFloat(s.borderBottomWidth) - parseFloat(s.paddingBottom),
      };
    };
    const gap = (a, b) => lineBox(find(b)).top - lineBox(find(a)).bottom;
    const one = find("one");
    const alpha = find("Alpha");
    const font = parseFloat(getComputedStyle(alpha).fontSize);
    const lengths = ["Alpha", "Heading", "Beta", "one", "two", "Gamma"].map((text) => {
      const style = find(text).style;
      return [text, style.margin || "", style.padding || "", style.height || "", style.gap || ""];
    });
    return {
      p: parseFloat(getComputedStyle(alpha).paddingBottom),
      halfLine: 1.55 * font / 2,
      paraToH1: gap("Alpha", "Heading"),
      h1ToPara: gap("Heading", "Beta"),
      paraToBullet: gap("Beta", "one"),
      bulletsTop: lineBox(find("two")).top - lineBox(one).top,
      bulletsGap: lineBox(find("two")).top - lineBox(one).bottom,
      line: lineBox(one).bottom - lineBox(one).top,
      afterList: gap("two", "Gamma"),
      lengths,
    };
  })()`);
  near(measured.p, measured.halfLine, "P");
  near(measured.paraToH1, measured.p * 2, "paragraph to h1");
  near(measured.h1ToPara, measured.p, "h1 to the next paragraph");
  near(measured.paraToBullet, measured.p, "paragraph to the first bullet");
  near(measured.bulletsGap, 0, "gap between bullets");
  near(measured.bulletsTop, measured.line, "two bullets are one line box apart");
  near(measured.afterList, measured.p, "after the list");
  for (const [text, margin, padding, height, gap] of measured.lengths) {
    assert.equal(margin, "", `${text} sets an inline margin`);
    assert.equal(padding, "", `${text} sets an inline padding`);
    assert.equal(height, "", `${text} sets an inline height`);
    assert.equal(gap, "", `${text} sets an inline gap`);
  }
});
