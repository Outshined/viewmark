import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, Page, startHub } from "./harness.js";

// Ticket 696d8kue, the Acceptance section of its body. Rendered blocks share one vertical measure
// P, the used value of half of 1.55em on a body paragraph. block-gap.browser.js measures a
// paragraph to an h1, an h1 to the next paragraph, a paragraph to the first bullet, two bullets,
// and the space after a bullet list. This file measures the rest, within 1 px, in the rendered
// document. The caret stands on a line that no measure uses, so every measured block is drawn
// rendered, not raw.

// Page-side helpers. A block is a child of the editor that draws part of the document: a line,
// or a table or diagram atom. A rendered line carries its offsets on the runs it draws, so a block
// is found by an offset of text it draws. Its line box is its content box. Glyph rects stop at
// the em box, inside the half-leading, so they would count that leading as gap.
const HELPERS = String.raw`
const editor = document.getElementById("editor");
const px = (value) => parseFloat(value) || 0;
const blocks = [...editor.children].filter((el) => el.matches(".md-line, .md-atom"));
const covers = (el, offset) => el.dataset.start != null && Number(el.dataset.start) <= offset && offset < Number(el.dataset.end);
const at = (offset) => {
  const el = blocks.find((b) => covers(b, offset) || [...b.querySelectorAll("[data-start]")].some((c) => covers(c, offset)));
  if (!el) throw new Error("no block draws offset " + offset);
  return el;
};
const blankAt = (offset) => {
  const el = blocks.find((b) => Number(b.dataset.start) === offset && Number(b.dataset.end) === offset);
  if (!el) throw new Error("no blank line at offset " + offset);
  return el;
};
const lineBox = (el) => {
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  return { top: r.top + px(s.borderTopWidth) + px(s.paddingTop), bottom: r.bottom - px(s.borderBottomWidth) - px(s.paddingBottom) };
};
// What a block with a background, a border, or cell borders draws: its border box.
const borderBox = (el) => {
  const r = el.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom };
};
const glyphTop = (offset) => {
  const glyph = window.__qaGlyph(offset);
  if (!glyph) throw new Error("no glyph at offset " + offset);
  return glyph.top;
};
const lineHeight = (el) => px(getComputedStyle(el).lineHeight);
// P from a body paragraph, and the --p the stylesheet holds there.
const unit = (el) => ({ p: (1.55 * px(getComputedStyle(el).fontSize)) / 2, custom: px(getComputedStyle(el).getPropertyValue("--p")) });
// The vertical lengths an inline style sets on an element, by longhand name.
const lengths = (el) => {
  const names = [];
  for (let i = 0; i < el.style.length; i += 1) names.push(el.style.item(i));
  return names.filter((name) => /^(margin|padding)(-|$)|^(min-|max-)?(height|block-size)$|^(row-|column-)?gap$/.test(name));
};
const report = (named) => {
  const inline = {};
  const raw = [];
  for (const [label, el] of Object.entries(named)) {
    inline[label] = lengths(el);
    if (el.classList.contains("md-raw")) raw.push(label);
  }
  return { inline, raw };
};
`;

function near(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) <= 1, `${label}: ${actual} vs ${expected} (limit 1px)`);
}

// --p matches the definition, every measured block is rendered, and none carries an inline length.
function checkPage(m) {
  near(m.custom, m.p, "--p against half of 1.55em on a body paragraph");
  assert.deepEqual(m.raw, [], `drawn raw: ${m.raw.join(", ")}`);
  for (const [label, names] of Object.entries(m.inline)) {
    assert.deepEqual(names, [], `${label} carries an inline ${names.join(", ")}`);
  }
}

function measure(page, body) {
  return page.eval(`(() => {\n${HELPERS}\n${body}\n})()`);
}

async function setup(t, docs) {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  for (const [name, text] of Object.entries(docs)) await hub.create(name, text);
  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.login();
  return page;
}

// Opens a file with the caret at an offset, then waits until every picture is loaded and every
// diagram is drawn as its SVG.
async function open(page, file, offset) {
  await page.open(file);
  assert.ok(await page.clickOffset(offset), `no point at offset ${offset} in ${file}`);
  await page.quiet();
  await page.until(
    () => page.eval(`[...document.querySelectorAll("#editor .md-diagram")].every((el) => el.querySelector("svg")) && [...document.querySelectorAll("#editor img")].every((img) => img.complete && img.naturalWidth > 0)`),
    "pictures and diagrams drawn",
    10000,
  );
  await page.quiet();
}

test("two paragraphs are P apart, and the blank between them adds nothing (ticket 696d8kue)", async (t) => {
  const DOC = "Lead\n\nAlpha\n\nBeta\n\nGamma\n";
  const page = await setup(t, { "two.md": DOC });
  await open(page, "two.md", 0);
  const m = await measure(page, `
    const alpha = at(${DOC.indexOf("Alpha")});
    const beta = at(${DOC.indexOf("Beta")});
    const blank = blankAt(${DOC.indexOf("\nBeta")});
    return {
      ...unit(alpha),
      gap: lineBox(beta).top - lineBox(alpha).bottom,
      blank: blank.getBoundingClientRect().height,
      ...report({ Alpha: alpha, Beta: beta, "the blank": blank }),
    };
  `);
  checkPage(m);
  near(m.gap, m.p, "Alpha to Beta");
  near(m.blank, 0, "the blank between Alpha and Beta");
});

// The paragraph before the list has a hard break, so it draws two lines: "two lines of one
// paragraph". The second item has a hard break too, so its continuation draws a line of its own;
// a plain continuation joins the item's first line.
const LISTS = {
  "an ordered list": "Lead\n\nFirst line  \nsecond line\n\n1. one\n2. two  \n   cont\n3. three\n\nBeta\n",
  "bullets with a task item": "Lead\n\nFirst line  \nsecond line\n\n- one\n- [ ] two  \n  cont\n- three\n\nBeta\n",
};

test("a paragraph, then a list: P to the first item, items and a continuation one line box apart, P after the last item (ticket 696d8kue)", async (t) => {
  const lists = Object.entries(LISTS).map(([name, doc], i) => ({ name, doc, file: `list${i}.md` }));
  const page = await setup(t, Object.fromEntries(lists.map(({ file, doc }) => [file, doc])));
  for (const { name, doc: DOC, file } of lists) {
    await t.test(name, async () => {
      await open(page, file, 0);
      const m = await measure(page, `
        const para = at(${DOC.indexOf("First")});
        const one = at(${DOC.indexOf("one")});
        const two = at(${DOC.indexOf("two")});
        const three = at(${DOC.indexOf("three")});
        const beta = at(${DOC.indexOf("Beta")});
        const pitch = glyphTop(${DOC.indexOf("second")}) - glyphTop(${DOC.indexOf("First")});
        return {
          ...unit(para),
          pitch,
          paraLine: lineHeight(para),
          toFirst: lineBox(one).top - lineBox(para).bottom,
          oneToTwo: glyphTop(${DOC.indexOf("two")}) - glyphTop(${DOC.indexOf("one")}),
          twoToCont: glyphTop(${DOC.indexOf("cont")}) - glyphTop(${DOC.indexOf("two")}),
          contToThree: glyphTop(${DOC.indexOf("three")}) - glyphTop(${DOC.indexOf("cont")}),
          oneGap: lineBox(two).top - lineBox(one).bottom,
          twoGap: lineBox(three).top - lineBox(two).bottom,
          afterList: lineBox(beta).top - lineBox(three).bottom,
          sameBlock: two === at(${DOC.indexOf("cont")}),
          ...report({ "the paragraph": para, "the first item": one, "the second item": two, "the third item": three, Beta: beta }),
        };
      `);
      checkPage(m);
      near(m.pitch, m.paraLine, "two lines of one paragraph are one line box apart");
      assert.ok(m.sameBlock, "the continuation is drawn in its item");
      near(m.toFirst, m.p, "paragraph to the first item");
      near(m.oneToTwo, m.pitch, "first item to second item, against two lines of one paragraph");
      near(m.twoToCont, m.pitch, "second item to its continuation, against two lines of one paragraph");
      near(m.contToThree, m.pitch, "continuation to the third item, against two lines of one paragraph");
      near(m.oneGap, 0, "space between the first and second items");
      near(m.twoGap, 0, "space between the second and third items");
      near(m.afterList, m.p, "last item to the next paragraph");
    });
  }
});

const WORDS = ["One", "Two", "Three", "Four", "Five", "Six"];
const heading = (level) => `${"#".repeat(level)} ${WORDS[level - 1]}`;
const after = (level) => `After ${WORDS[level - 1].toLowerCase()}`;

// Each heading level, the paragraph before it, and the paragraph under it, with `sep` between
// the paragraph and the heading. The paragraph under a heading sits on the next line.
function headingDoc(sep) {
  let doc = "Lead\n\nAlpha";
  for (let level = 1; level <= 6; level += 1) doc += `${sep}${heading(level)}\n${after(level)}`;
  return `${doc}\n\nOmega\n`;
}

function headingGaps(page, DOC) {
  const spots = [];
  for (let level = 1; level <= 6; level += 1) {
    spots.push({
      before: DOC.indexOf(level === 1 ? "Alpha" : after(level - 1)),
      heading: DOC.indexOf(heading(level)) + level + 1,
      after: DOC.indexOf(after(level)),
    });
  }
  return measure(page, `
    const spots = ${JSON.stringify(spots)};
    const named = {};
    const rows = spots.map((spot, i) => {
      const before = at(spot.before);
      const head = at(spot.heading);
      const next = at(spot.after);
      named["h" + (i + 1)] = head;
      named["the paragraph before h" + (i + 1)] = before;
      named["the paragraph under h" + (i + 1)] = next;
      return {
        tag: [...head.classList].find((name) => /^md-h[1-6]$/.test(name)),
        before: lineBox(head).top - lineBox(before).bottom,
        after: lineBox(next).top - lineBox(head).bottom,
      };
    });
    return { ...unit(at(${DOC.indexOf("Alpha")})), rows, ...report(named) };
  `);
}

const ABOVE = [2, 1.5, 1, 1, 1, 1];
const BELOW = [1, 1, 0.5, 0.5, 0.5, 0.5];

test("a paragraph, then a heading: 2P before an h1, 1.5P before an h2, P before an h3 to h6, not that plus another P (ticket 696d8kue)", async (t) => {
  const forms = { "with a blank line between": headingDoc("\n\n"), "with no blank line between": headingDoc("\n") };
  const page = await setup(t, { "blank.md": forms["with a blank line between"], "tight.md": forms["with no blank line between"] });
  for (const [name, DOC] of Object.entries(forms)) {
    await t.test(name, async () => {
      await open(page, name.startsWith("with a blank") ? "blank.md" : "tight.md", 0);
      const m = await headingGaps(page, DOC);
      checkPage(m);
      m.rows.forEach((row, i) => {
        assert.equal(row.tag, `md-h${i + 1}`);
        near(row.before, ABOVE[i] * m.p, `paragraph to h${i + 1}, ${ABOVE[i]}P`);
      });
    });
  }
});

test("a heading, then a paragraph: P after an h1 or h2, P/2 after an h3 to h6 (ticket 696d8kue)", async (t) => {
  const DOC = headingDoc("\n\n");
  const page = await setup(t, { "under.md": DOC });
  await open(page, "under.md", 0);
  const m = await headingGaps(page, DOC);
  checkPage(m);
  m.rows.forEach((row, i) => {
    assert.equal(row.tag, `md-h${i + 1}`);
    near(row.after, BELOW[i] * m.p, `h${i + 1} to the paragraph under it, ${BELOW[i]}P`);
  });
});

test("a heading, then a list: the heading's space below, once (ticket 696d8kue)", async (t) => {
  // Each list, and the text its first item draws.
  const items = [["- one a\n- one b", "one a"], ["1. two a\n2. two b", "two a"], ["- [ ] three a\n- three b", "three a"], ["1. four a", "four a"], ["- five a", "five a"], ["1. six a", "six a"]];
  let DOC = "Lead\n\nAlpha";
  items.forEach(([list], i) => {
    DOC += `\n\n${heading(i + 1)}\n${list}`;
  });
  DOC += "\n\nOmega\n";
  const page = await setup(t, { "lists.md": DOC });
  await open(page, "lists.md", 0);
  const spots = items.map(([, text], i) => ({ heading: DOC.indexOf(heading(i + 1)) + i + 2, item: DOC.indexOf(text) }));
  const m = await measure(page, `
    const named = {};
    const rows = ${JSON.stringify(spots)}.map((spot, i) => {
      const head = at(spot.heading);
      const item = at(spot.item);
      named["h" + (i + 1)] = head;
      named["the first item under h" + (i + 1)] = item;
      return { gap: lineBox(item).top - lineBox(head).bottom, list: item.classList.contains("md-block-list") };
    });
    return { ...unit(at(${DOC.indexOf("Alpha")})), rows, ...report(named) };
  `);
  checkPage(m);
  m.rows.forEach((row, i) => {
    assert.ok(row.list, `the item under h${i + 1} is drawn as a list`);
    near(row.gap, BELOW[i] * m.p, `h${i + 1} to the first item, ${BELOW[i]}P`);
  });
});

// The editor's box is held at least as tall as the window (min-height: 100vh), so its content box
// does not end where the blocks end. The part of it the blocks fill runs from the top of the
// content box, under the editor's top padding, to the bottom margin edge of the lowest block. That
// edge is where the content box would end at its auto height, since the editor's bottom padding
// keeps that margin inside it. The space above the first block is from the top of the content
// box to the block's line box; the space below the last block is from its line box to that edge.
function edges(page, last) {
  return measure(page, `
    const s = getComputedStyle(editor);
    const top = editor.getBoundingClientRect().top + px(s.borderTopWidth) + px(s.paddingTop);
    const end = Math.max(...blocks.map((b) => b.getBoundingClientRect().bottom + px(getComputedStyle(b).marginBottom)));
    const first = blocks[0];
    const final = blocks[blocks.length - 1];
    return {
      ...unit(blocks.find((b) => b.classList.contains("md-paragraph"))),
      above: lineBox(first).top - top,
      below: end - lineBox(final).bottom,
      first: first.className,
      lastIsExpected: final === at(${last}),
      ...report({ "the first block": first, "the last block": final }),
    };
  `);
}

test("an h1 first has the space above a first paragraph has, and a last paragraph or heading has no space below (ticket 696d8kue)", async (t) => {
  const FIRST_H1 = "# Top\nAlpha\n\nBeta\n\nLast words\n";
  const FIRST_P = "Top words\n\nAlpha\n\nBeta\n\nLast words\n";
  const lastHeading = (level) => `Top words\n\nAlpha\n\nBeta\n\n${"#".repeat(level)} End\n`;
  // Each subtest opens a file of its own. A page that opens the file the page before it had open
  // can find the line it clicks still locked by that page's socket, and keep the caret at 0.
  const docs = { "first-h1.md": FIRST_H1, "first-p.md": FIRST_P, "last-p.md": FIRST_P };
  for (let level = 1; level <= 6; level += 1) docs[`last-h${level}.md`] = lastHeading(level);
  const page = await setup(t, docs);

  await t.test("an h1 first and a paragraph first", async () => {
    await open(page, "first-h1.md", FIRST_H1.indexOf("Beta"));
    const h1 = await edges(page, FIRST_H1.indexOf("Last words"));
    checkPage(h1);
    assert.match(h1.first, /\bmd-h1\b/);
    await open(page, "first-p.md", FIRST_P.indexOf("Beta"));
    const para = await edges(page, FIRST_P.indexOf("Last words"));
    checkPage(para);
    assert.match(para.first, /\bmd-paragraph\b/);
    near(h1.above, para.above, "space above a first h1 against a first paragraph");
  });

  await t.test("a paragraph last", async () => {
    await open(page, "last-p.md", FIRST_P.indexOf("Alpha"));
    const m = await edges(page, FIRST_P.indexOf("Last words"));
    checkPage(m);
    assert.ok(m.lastIsExpected, "the last paragraph is the last block");
    near(m.below, 0, "space below a last paragraph");
  });

  for (let level = 1; level <= 6; level += 1) {
    await t.test(`an h${level} last`, async () => {
      const DOC = lastHeading(level);
      await open(page, `last-h${level}.md`, DOC.indexOf("Alpha"));
      const m = await edges(page, DOC.indexOf("End"));
      checkPage(m);
      assert.ok(m.lastIsExpected, `the h${level} is the last block`);
      near(m.below, 0, `space below a last h${level}`);
    });
  }
});

// Each construct sits between two paragraphs. The paragraph after a quote needs a blank line, or
// it would continue the quote; that blank, like the one after a paragraph, is height 0. A blank
// line under a fence, a table, a diagram, an image, or a rule is a line of its own that the caret
// can take, not a gap, so there the next paragraph follows the block directly.
const CONSTRUCTS = {
  "a quote": { doc: "Lead\n\nAlpha\n\n> one\n> two\n> three\n\nBeta\n", at: "one" },
  "a fence": { doc: "Lead\n\nAlpha\n\n```js\nlet a = 1;\nlet b = 2;\nlet c = 3;\n```\nBeta\n", at: "let a" },
  "a table": { doc: "Lead\n\nAlpha\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\nBeta\n", at: "| a" },
  "a diagram": { doc: "Lead\n\nAlpha\n\n```mermaid\ngraph TD\nA-->B\n```\nBeta\n", at: "```mermaid" },
  "an image": { doc: "Lead\n\nAlpha\n\n![box](box.svg)\nBeta\n", at: "![box]" },
  "a rule": { doc: "Lead\n\nAlpha\n\n---\nBeta\n", at: "---" },
};

test("a quote, a fence, a table, a diagram, an image, and a rule between paragraphs: P before and P after, inner lines one line box apart (ticket 696d8kue)", async (t) => {
  const constructs = Object.entries(CONSTRUCTS).map(([name, spec]) => ({ name, ...spec, kind: name.split(" ")[1] }));
  const page = await setup(t, Object.fromEntries(constructs.map(({ kind, doc }) => [`${kind}.md`, doc])));
  for (const { name, doc: DOC, at: start, kind } of constructs) {
    await t.test(name, async () => {
      await open(page, `${kind}.md`, 0);
      const m = await measure(page, `
        const alpha = at(${DOC.indexOf("Alpha")});
        const beta = at(${DOC.indexOf("Beta")});
        const block = at(${DOC.indexOf(start)});
        const named = { Alpha: alpha, Beta: beta };
        const kind = ${JSON.stringify(kind)};
        let box;
        const inner = {};
        if (kind === "quote") {
          const lines = [${DOC.indexOf("one")}, ${DOC.indexOf("two")}, ${DOC.indexOf("three")}].map(at);
          lines.forEach((line, i) => { named["quote line " + (i + 1)] = line; });
          box = { top: borderBox(lines[0]).top, bottom: borderBox(lines[2]).bottom };
          inner.pitch = lineHeight(lines[0]);
          inner.steps = [lineBox(lines[1]).top - lineBox(lines[0]).top, lineBox(lines[2]).top - lineBox(lines[1]).top];
          inner.gaps = [lineBox(lines[1]).top - lineBox(lines[0]).bottom, lineBox(lines[2]).top - lineBox(lines[1]).bottom];
        } else if (kind === "fence") {
          named.fence = block;
          box = borderBox(block);
          inner.pitch = lineHeight(block);
          const tops = [${DOC.indexOf("let a")}, ${DOC.indexOf("let b")}, ${DOC.indexOf("let c")}].map(glyphTop);
          inner.steps = [tops[1] - tops[0], tops[2] - tops[1]];
          inner.gaps = [];
        } else if (kind === "table") {
          const table = block.querySelector("table");
          named.table = block;
          named["table element"] = table;
          box = borderBox(table);
        } else if (kind === "diagram") {
          named.diagram = block;
          named["diagram SVG"] = block.querySelector("svg");
          box = borderBox(block);
        } else if (kind === "image") {
          // The picture's line is measured by its line box, as any line is. The picture sits on
          // the text bottom inside it.
          named["image line"] = block;
          named.img = block.querySelector("img");
          box = lineBox(block);
        } else {
          named.rule = block;
          box = borderBox(block);
        }
        return {
          ...unit(alpha),
          before: box.top - lineBox(alpha).bottom,
          after: lineBox(beta).top - box.bottom,
          font: px(getComputedStyle(alpha).fontSize),
          inner,
          ...report(named),
        };
      `);
      checkPage(m);
      const old = kind === "rule" ? 0.9 : 0.45;
      const note = kind === "rule" || kind === "table" || kind === "diagram" ? `, not spaced at ${old}em (${old * m.font}px)` : "";
      near(m.before, m.p, `Alpha to ${name}${note}`);
      near(m.after, m.p, `${name} to Beta${note}`);
      if (m.inner.steps) {
        m.inner.steps.forEach((step, i) => near(step, m.inner.pitch, `${name}: line ${i + 1} to line ${i + 2} is one line box`));
        m.inner.gaps.forEach((gap, i) => near(gap, 0, `${name}: space between line ${i + 1} and line ${i + 2}`));
      }
    });
  }
});

test("each construct carries its layout class, and no block carries an inline margin, padding, height, or gap (ticket 696d8kue)", async (t) => {
  const DOC = [
    "Lead",
    "",
    "Alpha",
    "",
    "- b one\n- b two\n- b three",
    "",
    "Beta",
    "",
    "1. o one\n2. o two\n3. o three",
    "",
    "Gamma",
    "",
    "> q one\n> q two\n> q three",
    "",
    "Delta",
    "",
    "```js\nlet a = 1;\nlet b = 2;\n```\nEpsilon",
    "",
    "| a | b |\n| --- | --- |\n| 1 | 2 |\nZeta",
    "",
    "```mermaid\ngraph TD\nA-->B\n```\nEta",
    "",
    "![box](box.svg)\nTheta",
    "",
    "---\nOmega",
    "",
  ].join("\n");
  const page = await setup(t, { "all.md": DOC });
  await open(page, "all.md", 0);
  // The text each line draws, or where an atom, a picture, or a rule starts.
  const runs = {
    "the bullet list": ["b one", "b two", "b three"],
    "the ordered list": ["o one", "o two", "o three"],
    "the quote": ["q one", "q two", "q three"],
  };
  const solo = { "the fence": "let a", "the table": "| a", "the diagram": "```mermaid", "the image": "![box]", "the rule": "\n---\n" };
  const m = await measure(page, `
    const runs = ${JSON.stringify(Object.fromEntries(Object.entries(runs).map(([name, lines]) => [name, lines.map((line) => DOC.indexOf(line))])))};
    const solo = ${JSON.stringify(Object.fromEntries(Object.entries(solo).map(([name, text]) => [name, DOC.indexOf(text) + (text.startsWith("\n") ? 1 : 0)])))};
    const classes = {};
    for (const [name, offsets] of Object.entries(runs)) classes[name] = offsets.map((offset) => [...at(offset).classList]);
    for (const [name, offset] of Object.entries(solo)) classes[name] = [...at(offset).classList];
    // Every block but the caret's line, and the table, picture, and diagram inside them.
    const named = {};
    const caret = at(0);
    blocks.filter((b) => b !== caret).forEach((b, i) => { named["block " + (i + 2) + " " + JSON.stringify(b.textContent.slice(0, 12)) + " (" + b.className + ")"] = b; });
    for (const el of editor.querySelectorAll(".md-table table, .md-diagram svg, .md-image img")) named[el.tagName.toLowerCase() + " in " + el.closest(".md-line, .md-atom").className] = el;
    return { ...unit(at(${DOC.indexOf("Alpha")})), classes, ...report(named) };
  `);
  checkPage(m);
  const has = (list, name) => list.includes(name);
  for (const [name, layout] of [["the bullet list", "md-block-list"], ["the ordered list", "md-block-list"], ["the quote", "md-block-quote"]]) {
    const lines = m.classes[name];
    lines.forEach((list, i) => {
      assert.ok(has(list, layout), `${name}, line ${i + 1}: ${layout} in ${list.join(" ")}`);
      assert.equal(has(list, "md-run-start"), i === 0, `${name}, line ${i + 1}: md-run-start only on the first line, in ${list.join(" ")}`);
      assert.equal(has(list, "md-run-end"), i === lines.length - 1, `${name}, line ${i + 1}: md-run-end only on the last line, in ${list.join(" ")}`);
    });
  }
  const fence = m.classes["the fence"];
  for (const name of ["md-block-fence", "md-run-start", "md-run-end"]) assert.ok(has(fence, name), `the fence: ${name} in ${fence.join(" ")}`);
  for (const [name, layout] of [["the table", "md-block-table"], ["the diagram", "md-block-diagram"], ["the image", "md-block-image"], ["the rule", "md-block-rule"]]) {
    assert.ok(has(m.classes[name], layout), `${name}: ${layout} in ${m.classes[name].join(" ")}`);
  }
});
