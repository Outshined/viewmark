import test from "node:test";
import assert from "node:assert/strict";
import { REPO, USER, cli, launchBrowser, Page, startHub } from "./harness.js";

const SEARCH_PATHS = ["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16", "M21 21l-4.3-4.3"];

function searchFrames(page, dir, kind, query) {
  return page.frames.filter((frame) => {
    const data = frame.data;
    return frame.dir === dir && data && data.type === "search" && data.kind === kind && (query === undefined || data.query === query);
  });
}

async function clickSelector(page, selector) {
  await page.eval(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: "center" })`);
  await page.frame();
  const point = await page.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  })()`);
  assert.ok(point && point.w > 0 && point.h > 0, selector);
  await page.click(point.x, point.y);
}

async function filePaths(page) {
  return page.eval(`[...document.querySelectorAll(".file-block button.md-file")].map((button) => button.dataset.path)`);
}

async function ticketIds(page) {
  return page.eval(`[...document.querySelectorAll(".ticket-block .md-ticket-node")].map((node) => node.dataset.id)`);
}

async function focusQuery(page, selector) {
  await page.eval(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  })()`);
  await page.until(() => page.eval(`document.activeElement === document.querySelector(${JSON.stringify(selector)})`), selector);
}

async function openListed(page, selector, file) {
  const since = page.frames.length;
  await clickSelector(page, selector);
  await page.until(
    () => page.frames.slice(since).some((frame) => frame.dir === "in" && frame.data && frame.data.type === "file" && frame.data.path === file),
    file,
  );
  await page.quiet();
}

test("search files and tickets", async (t) => {
  const hub = await startHub();
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await hub.close();
  });
  const hit = `${"pad\n".repeat(90)}cat first\n${"pad\n".repeat(4)}cat second\n`;
  await hub.create("hit.md", hit);
  await hub.create("catalog.md", "nope\n");
  await hub.create("labeled.md", "# PaneLabel\n\nnope\n");
  await hub.create("quiet.md", "quiet text\n");
  await hub.create("box/inner.md", "cat nested\n");
  await hub.create("quiet/miss.md", "nothing here\n");
  await hub.create("notes/catalog.md", "# Welcome\n\nnope\n");
  await hub.create("shot.md", "![alt](cat-picture.png)\n\n```mermaid\ncat diagram\n```\n");
  await hub.create("case.md", "alpha\n");
  await hub.create("gap.md", "a   b\n");
  await hub.create("fenced.md", "note {c7} here\n");
  const made = await cli(hub.port, ["--user", USER, "--repo", REPO, "directory", "create", "vacant"]);
  assert.equal(made.code, 0, made.stderr);
  assert.equal(made.stdout.trim(), "vacant");
  const bodyId = (await cli(hub.port, ["--user", USER, "--repo", REPO, "ticket", "create", "--title", "Nothing special"], "cat ticket\n")).stdout.trim();
  const titleId = (await cli(hub.port, ["--user", USER, "--repo", REPO, "ticket", "create", "--title", "cat title"], "nope\n")).stdout.trim();
  const closedId = (await cli(hub.port, ["--user", USER, "--repo", REPO, "ticket", "create", "--title", "cat closed"], "nope\n")).stdout.trim();
  const missId = (await cli(hub.port, ["--user", USER, "--repo", REPO, "ticket", "create", "--title", "Other work"], "nope\n")).stdout.trim();
  const closed = await cli(hub.port, ["--user", USER, "--repo", REPO, "ticket", "set", closedId, "--state", "closed"]);
  assert.equal(closed.code, 0, closed.stderr);

  browser = await launchBrowser();
  const page = new Page(browser.session, hub.port);
  await page.init();
  await page.login();
  await page.open("quiet.md");

  const chrome = await page.eval(`(() => {
    const read = (blockSel, buttonSel, fieldSel) => {
      const block = document.querySelector(blockSel);
      const head = block.querySelector(".md-pane-head");
      const button = head.querySelector(buttonSel);
      const svg = button.querySelector("svg");
      const paths = [...svg.querySelectorAll("path")];
      const box = block.querySelector(fieldSel);
      const input = box.querySelector("input");
      return {
        labels: [...head.children].map((el) => el.getAttribute("aria-label") || el.textContent.trim()),
        text: button.textContent,
        title: button.getAttribute("title"),
        viewBox: svg.getAttribute("viewBox"),
        hiddenSvg: svg.getAttribute("aria-hidden"),
        svgFill: svg.getAttribute("fill"),
        paths: paths.map((path) => path.getAttribute("d")),
        stroke: paths.map((path) => path.getAttribute("stroke")),
        width: paths.map((path) => path.getAttribute("stroke-width")),
        cap: paths.map((path) => path.getAttribute("stroke-linecap")),
        join: paths.map((path) => path.getAttribute("stroke-linejoin")),
        fill: paths.map((path) => path.getAttribute("fill")),
        fieldHidden: box.hidden,
        fieldFirst: block.children[1] === box,
        inputLabel: input.getAttribute("aria-label"),
        error: box.querySelector(".md-search-error").textContent,
        errorHidden: box.querySelector(".md-search-error").hidden,
      };
    };
    return {
      files: read(".file-block", "button.md-file-search", ".md-file-search-field"),
      tickets: read(".ticket-block", "button.md-ticket-search", ".md-ticket-search-field"),
    };
  })()`);
  for (const side of [chrome.files, chrome.tickets]) {
    assert.equal(side.text, "");
    assert.equal(side.viewBox, "0 0 24 24");
    assert.equal(side.hiddenSvg, "true");
    assert.equal(side.svgFill, null);
    assert.deepEqual(side.paths, SEARCH_PATHS);
    assert.deepEqual(side.stroke, ["currentColor", "currentColor"]);
    assert.deepEqual(side.width, ["2", "2"]);
    assert.deepEqual(side.cap, ["round", "round"]);
    assert.deepEqual(side.join, ["round", "round"]);
    assert.deepEqual(side.fill, ["none", "none"]);
    assert.equal(side.fieldHidden, true);
    assert.equal(side.fieldFirst, true);
    assert.equal(side.error, "invalid pattern");
    assert.equal(side.errorHidden, true);
  }
  assert.deepEqual(chrome.files.labels, ["Files", "New file", "Delete file", "Search files"]);
  assert.equal(chrome.files.title, "Search files");
  assert.equal(chrome.files.inputLabel, "Search files");
  assert.deepEqual(chrome.tickets.labels, ["Tickets", "New ticket", "Filter", "Search tickets"]);
  assert.equal(chrome.tickets.title, "Search tickets");
  assert.equal(chrome.tickets.inputLabel, "Search tickets");

  const before = page.frames.length;
  await clickSelector(page, ".file-block button.md-file-search");
  await page.until(
    () => page.eval(`(() => {
      const box = document.querySelector(".file-block .md-file-search-field");
      const input = box.querySelector("input");
      return !box.hidden && document.activeElement === input && input.value === "";
    })()`),
    "file search field",
  );
  assert.equal(searchFrames(page, "out", "docs").length, 0);
  assert.ok((await filePaths(page)).includes("quiet.md"));
  assert.ok((await filePaths(page)).includes("vacant") === false);
  const dirs = await page.eval(`[...document.querySelectorAll(".file-block button.md-dir-toggle")].map((button) => button.dataset.dir)`);
  assert.ok(dirs.includes("vacant"));
  await page.type("x");
  await page.until(() => searchFrames(page, "out", "docs", "x").length > 0, "search x");
  await page.key("Backspace");
  await page.quiet();
  assert.equal(page.frames.slice(before).some((frame) => frame.dir === "out" && frame.data && frame.data.type === "search" && frame.data.query === ""), false);
  const cleared = await page.eval(`(() => {
    const box = document.querySelector(".file-block .md-file-search-field");
    return { hidden: box.hidden, value: box.querySelector("input").value };
  })()`);
  assert.equal(cleared.hidden, false);
  assert.equal(cleared.value, "");
  assert.ok((await filePaths(page)).includes("quiet.md"));
  assert.ok((await page.eval(`[...document.querySelectorAll(".file-block button.md-dir-toggle")].some((button) => button.dataset.dir === "vacant")`)));

  await page.type("cat");
  await page.until(() => searchFrames(page, "in", "docs", "cat").length > 0, "cat answer");
  await page.quiet();
  const catPaths = await filePaths(page);
  for (const file of ["hit.md", "catalog.md", "box/inner.md", "shot.md", "notes/catalog.md"]) assert.ok(catPaths.includes(file), file);
  for (const file of ["quiet.md", "quiet/miss.md", "labeled.md", "case.md", "gap.md", "fenced.md", "notes/welcome.md"]) {
    assert.equal(catPaths.includes(file), false, file);
  }
  assert.equal(catPaths.some((file) => file.startsWith("tickets/")), false);
  const catDirs = await page.eval(`[...document.querySelectorAll(".file-block button.md-dir-toggle")].map((button) => button.dataset.dir)`);
  assert.ok(catDirs.includes("box"));
  assert.equal(catDirs.includes("quiet"), false);
  assert.equal(catDirs.includes("vacant"), false);
  const row = await page.eval(`(() => {
    const button = document.querySelector(".file-block button.md-file[data-path='catalog.md']");
    const dir = document.querySelector(".file-block button.md-dir-toggle[data-dir='box']");
    return {
      hits: [...button.querySelectorAll(".md-search-hit")].map((hit) => hit.textContent),
      path: !!button.querySelector(".md-file-path"),
      rowChildren: button.parentElement.children.length,
      dirHits: dir.querySelectorAll(".md-search-hit").length,
    };
  })()`);
  assert.ok(row.hits.includes("cat"));
  assert.equal(row.path, false);
  assert.equal(row.rowChildren, 1);
  assert.equal(row.dirHits, 0);
  const docsAnswer = searchFrames(page, "in", "docs", "cat").at(-1).data;
  assert.ok(docsAnswer.paths.includes("shot.md"));
  assert.equal(docsAnswer.paths.some((file) => file.startsWith("tickets/")), false);

  await openListed(page, ".file-block button.md-file[data-path='catalog.md']", "catalog.md");
  assert.equal(await page.eval(`document.querySelectorAll("#editor .md-line .md-search-hit").length`), 0);
  await openListed(page, ".file-block button.md-file[data-path='hit.md']", "hit.md");
  await page.until(async () => {
    const box = await page.eval(`(() => {
      const hits = [...document.querySelectorAll("#editor .md-line .md-search-hit")];
      const hit = hits[0];
      if (!hit) return null;
      const r = hit.getBoundingClientRect();
      const style = getComputedStyle(hit);
      return {
        count: hits.length,
        texts: hits.map((item) => item.textContent),
        top: r.top,
        bottom: r.bottom,
        view: window.innerHeight,
        background: style.backgroundColor,
        color: style.color,
      };
    })()`);
    return box && box.count >= 2 && box.texts[0] === "cat" && box.top >= -1 && box.bottom <= box.view + 1;
  }, "first cat in view");
  const paint = await page.eval(`(() => {
    const hit = document.querySelector("#editor .md-line .md-search-hit");
    const style = getComputedStyle(hit);
    return { background: style.backgroundColor, color: style.color };
  })()`);
  assert.equal(paint.background, "rgb(63, 83, 68)");
  assert.equal(paint.color, "rgb(231, 226, 216)");

  await focusQuery(page, ".file-block .md-search-input");
  await page.type("[");
  await page.quiet();
  const invalid = await page.eval(`(() => {
    const input = document.querySelector(".file-block .md-search-input");
    const error = document.querySelector(".file-block .md-search-error");
    return {
      value: input.value,
      invalid: input.getAttribute("aria-invalid"),
      error: error.textContent,
      shown: !error.hidden,
    };
  })()`);
  assert.equal(invalid.value, "cat[");
  assert.equal(invalid.invalid, "true");
  assert.equal(invalid.error, "invalid pattern");
  assert.equal(invalid.shown, true);
  assert.equal(searchFrames(page, "out", "docs", "cat[").length, 0);
  assert.ok((await filePaths(page)).includes("hit.md"));
  assert.equal((await filePaths(page)).includes("quiet.md"), false);
  assert.ok((await page.eval(`document.querySelectorAll("#editor .md-line .md-search-hit").length`)) >= 2);

  await focusQuery(page, ".file-block .md-search-input");
  await page.key("Escape");
  await page.quiet();
  const escaped = await page.eval(`(() => {
    const box = document.querySelector(".file-block .md-file-search-field");
    return { hidden: box.hidden, hits: document.querySelectorAll("#editor .md-search-hit").length };
  })()`);
  assert.equal(escaped.hidden, true);
  assert.equal(escaped.hits, 0);
  assert.ok((await filePaths(page)).includes("quiet.md"));
  assert.ok(await page.eval(`[...document.querySelectorAll(".file-block button.md-dir-toggle")].some((button) => button.dataset.dir === "vacant")`));

  await clickSelector(page, ".file-block button.md-file-search");
  await page.until(() => page.eval(`document.activeElement === document.querySelector(".file-block .md-search-input")`), "file field again");
  await page.type("Alpha");
  await page.until(() => searchFrames(page, "in", "docs", "Alpha").length > 0, "Alpha answer");
  await page.quiet();
  assert.equal((await filePaths(page)).includes("case.md"), false);
  await page.key("Escape");
  await clickSelector(page, ".file-block button.md-file-search");
  await page.until(() => page.eval(`document.activeElement === document.querySelector(".file-block .md-search-input")`), "file field for alpha");
  await page.type("alpha");
  await page.until(() => searchFrames(page, "in", "docs", "alpha").length > 0, "alpha answer");
  await page.quiet();
  assert.ok((await filePaths(page)).includes("case.md"));
  await page.key("Escape");

  await clickSelector(page, ".file-block button.md-file-search");
  await page.until(() => page.eval(`document.activeElement === document.querySelector(".file-block .md-search-input")`), "file field for notes");
  await page.type("notes");
  await page.until(() => searchFrames(page, "in", "docs", "notes").length > 0, "notes answer");
  await page.quiet();
  const notesRow = await page.eval(`(() => {
    const button = document.querySelector(".file-block button.md-file[data-path='notes/catalog.md']");
    const path = button && button.querySelector(".md-file-path");
    const title = button && [...button.childNodes].find((node) => node.nodeType === 3 || (node.classList && !node.classList.contains("md-file-path")));
    return {
      shown: !!button,
      pathHit: path ? [...path.querySelectorAll(".md-search-hit")].map((hit) => hit.textContent) : [],
      label: button ? button.textContent : "",
    };
  })()`);
  assert.equal(notesRow.shown, true);
  assert.ok(notesRow.pathHit.includes("notes"));
  assert.ok(notesRow.label.includes("Welcome"));
  await openListed(page, ".file-block button.md-file[data-path='notes/catalog.md']", "notes/catalog.md");
  assert.equal(await page.eval(`document.querySelectorAll("#editor .md-line .md-search-hit").length`), 0);
  await focusQuery(page, ".file-block .md-search-input");
  await page.key("Escape");

  await clickSelector(page, ".file-block button.md-file-search");
  await page.until(() => page.eval(`document.activeElement === document.querySelector(".file-block .md-search-input")`), "file field for spaces");
  await page.type("   ");
  await page.until(() => searchFrames(page, "in", "docs", "   ").length > 0, "spaces answer");
  await page.quiet();
  assert.deepEqual(await filePaths(page), ["gap.md"]);
  await page.key("Escape");

  await clickSelector(page, ".file-block button.md-file-search");
  await page.until(() => page.eval(`document.activeElement === document.querySelector(".file-block .md-search-input")`), "file field for fence");
  await page.type("c7");
  await page.until(() => searchFrames(page, "in", "docs", "c7").length > 0, "fence answer");
  await page.quiet();
  assert.ok((await filePaths(page)).includes("fenced.md"));
  await page.key("Escape");

  await clickSelector(page, ".file-block button.md-file-search");
  await page.until(() => page.eval(`document.activeElement === document.querySelector(".file-block .md-search-input")`), "file field for picture");
  await page.type("cat");
  await page.until(() => searchFrames(page, "in", "docs", "cat").length > 1, "cat answer again");
  await page.quiet();
  await openListed(page, ".file-block button.md-file[data-path='shot.md']", "shot.md");
  const drawn = await page.eval(`(() => ({
    image: document.querySelectorAll("#editor .md-image .md-search-hit").length,
    diagram: document.querySelectorAll("#editor .md-diagram .md-search-hit").length,
    line: document.querySelectorAll("#editor .md-line .md-search-hit").length,
  }))()`);
  assert.equal(drawn.image, 0);
  assert.equal(drawn.diagram, 0);
  await clickSelector(page, "#editor button.md-view-toggle");
  await page.until(
    () => page.eval(`[...document.querySelectorAll("#editor .md-line")].some((line) => line.textContent.includes("cat-picture") && line.querySelector(".md-search-hit"))`),
    "picture destination hit",
  );
  assert.ok(await page.eval(`[...document.querySelectorAll("#editor .md-line")].some((line) => line.textContent.includes("cat diagram") && line.querySelector(".md-search-hit"))`));
  await focusQuery(page, ".file-block .md-search-input");
  await page.key("Escape");
  await page.quiet();
  assert.equal(await page.eval(`document.querySelectorAll("#editor .md-search-hit").length`), 0);

  await clickSelector(page, ".ticket-block button.md-ticket-search");
  await page.until(
    () => page.eval(`document.activeElement === document.querySelector(".ticket-block .md-search-input")`),
    "ticket search field",
  );
  await page.type("cat");
  await page.until(() => searchFrames(page, "in", "tickets", "cat").length > 0, "ticket cat answer");
  await page.quiet();
  const ticketAnswer = searchFrames(page, "in", "tickets", "cat").at(-1).data;
  assert.ok(ticketAnswer.paths.includes(`tickets/${closedId}.md`));
  assert.equal(ticketAnswer.paths.some((file) => !file.startsWith("tickets/")), false);
  const shown = await ticketIds(page);
  assert.ok(shown.includes(bodyId));
  assert.ok(shown.includes(titleId));
  assert.equal(shown.includes(closedId), false);
  assert.equal(shown.includes(missId), false);
  const titles = await page.eval(`(() => {
    const hit = (id) => {
      const title = document.querySelector(${JSON.stringify(".ticket-block .md-ticket-node") } + "[data-id='" + id + "'] .md-ticket-title");
      const idCell = document.querySelector(".ticket-block .md-ticket-node[data-id='" + id + "'] .md-ticket-id");
      return {
        text: title ? title.textContent : "",
        hits: title ? [...title.querySelectorAll(".md-search-hit")].map((node) => node.textContent) : [],
        idHits: idCell ? idCell.querySelectorAll(".md-search-hit").length : 0,
      };
    };
    return { body: hit(${JSON.stringify(bodyId)}), title: hit(${JSON.stringify(titleId)}) };
  })()`);
  assert.equal(titles.body.text, "Nothing special");
  assert.deepEqual(titles.body.hits, []);
  assert.equal(titles.body.idHits, 0);
  assert.ok(titles.title.hits.includes("cat"));
  assert.equal(titles.title.idHits, 0);
  await page.eval(`(() => {
    const box = document.querySelector(".ticket-block .md-ticket-filter-menu [data-filter='closed']");
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await page.quiet();
  assert.ok((await ticketIds(page)).includes(closedId));
  await openListed(page, `.ticket-block button.md-ticket[data-path='tickets/${bodyId}.md']`, `tickets/${bodyId}.md`);
  const ticketHits = await page.eval(`[...document.querySelectorAll("#editor .md-line .md-search-hit")].map((hit) => hit.textContent)`);
  assert.ok(ticketHits.includes("cat"));
  await openListed(page, `.ticket-block button.md-ticket[data-path='tickets/${titleId}.md']`, `tickets/${titleId}.md`);
  assert.equal(await page.eval(`document.querySelectorAll("#editor .md-line .md-search-hit").length`), 0);
  await focusQuery(page, ".ticket-block .md-search-input");
  await page.key("Escape");
  await page.quiet();
  const restored = await page.eval(`(() => {
    const box = document.querySelector(".ticket-block .md-ticket-search-field");
    return { hidden: box.hidden, hits: document.querySelectorAll("#editor .md-search-hit").length };
  })()`);
  assert.equal(restored.hidden, true);
  assert.equal(restored.hits, 0);
  assert.ok((await ticketIds(page)).includes(missId));
});
