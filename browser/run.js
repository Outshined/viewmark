import { literalIn } from "./cells.js";

// Runs one cell by one route and checks the invariants of qa/editor-matrix-test-plan.md.

const PHANTOM = (bytes, offset) => offset === bytes.length && bytes.endsWith("\n");
const HISTORY = new Set(["Ctrl+Z", "Ctrl+Y", "Ctrl+Shift+Z"]);
const NO_EDIT = new Set(["←", "→", "↑", "↓", "Home", "End", "PageDown", "Escape", "Ctrl+A", "Ctrl+C", "Ctrl+Home", "Ctrl+End", "Ctrl+→", "Shift+←", "Shift+→", "Shift+↑", "Shift+↓", "Shift+Home", "Shift+End"]);

class NotAutomated extends Error {}

function lineStart(bytes, offset) {
  let at = offset;
  while (at > 0 && bytes[at - 1] !== "\n") at -= 1;
  return at;
}

function lineEnd(bytes, offset) {
  let at = offset;
  while (at < bytes.length && bytes[at] !== "\n") at += 1;
  return at;
}

function parseKey(token) {
  const parts = token.split("+");
  const name = parts.pop();
  return { name, modifiers: parts };
}

// One edit per key that edits, per the plan's I5; a cell whose expectation is `same` edits
// nothing. An undo or redo with nothing to act on edits nothing, so each counts as 0 or 1.
function editRange(cell) {
  if (cell.expectKind === "same") return [0, 0];
  let low = 0;
  let high = 0;
  for (const key of cell.keys) {
    if (key.text != null) low += [...key.text].length;
    else if (key.compose) low += 1;
    else if (key.action) continue;
    else if (HISTORY.has(key.key)) high += 1;
    else if (!NO_EDIT.has(key.key)) low += 1;
  }
  return [low, low + high];
}

export function routesFor(cell) {
  const timed = (name) => (cell.id.startsWith("DC.") || cell.id.startsWith("T3.") ? [`${name}@30`, `${name}@250`] : [name]);
  if (cell.routes.length) return cell.routes.map((route) => ({ "↓": "down", "↑": "up" })[route] || route).flatMap(timed);
  if (cell.id.startsWith("BG.")) {
    const { bytes, focus } = cell.source;
    const routes = ["click"];
    if (lineStart(bytes, focus) > 0) routes.push("down");
    if (lineEnd(bytes, focus) < bytes.length) routes.push("up");
    routes.push("emptied");
    return routes;
  }
  return timed(cell.source.anchor !== cell.source.focus ? "drag" : "click");
}

async function point(page, expression, what) {
  const found = await page.eval(expression);
  if (!found) throw new Error(`no drawn target for ${what}`);
  return found;
}

// A rendered block may tag only part of its source (a fence tags its body, not its fence
// lines), so take the first block whose tagged range reaches the offset, and click it so its
// source is drawn.
async function openBlock(page, offset) {
  const block = await page.eval(`(() => {
    for (const el of window.__qaRoot().children) {
      const tagged = [el, ...el.querySelectorAll("[data-start]")].filter((node) => node.dataset && node.dataset.start != null);
      if (!tagged.length) continue;
      const end = Math.max(...tagged.map((node) => Number(node.dataset.end)));
      if (end < ${offset}) continue;
      const r = el.getBoundingClientRect();
      return { x: r.left + 2, y: r.top + Math.min(10, r.height / 2) };
    }
    return null;
  })()`);
  if (!block) return;
  await page.click(block.x, block.y);
  await page.quiet();
}

async function boundaryPoint(page, bytes, offset) {
  let found = await page.eval(`window.__qaClickPoint(${offset})`);
  if (found) return found;
  await openBlock(page, offset);
  found = await page.eval(`window.__qaClickPoint(${offset})`);
  if (!found) throw new Error(`no drawn boundary for offset ${offset}`);
  return found;
}

async function clickAt(page, bytes, offset) {
  if (PHANTOM(bytes, offset)) {
    await page.clickBelow();
    return;
  }
  const at = await boundaryPoint(page, bytes, offset);
  await page.click(at.x, at.y);
}

async function firstDrawn(page, from, to) {
  return page.eval(`(() => {
    for (let at = ${from}; at <= ${to}; at += 1) if (window.__qaGlyph(at) || window.__qaEmptyLine(at)) return at;
    return null;
  })()`);
}

async function dropSelection(page, needle) {
  const target = await point(page, `window.__qaTextPoint(${JSON.stringify(needle)}, 1)`, needle);
  const source = await page.eval("(() => { const r = getSelection().getRangeAt(0).getClientRects()[0]; return r && { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 }; })()");
  if (!source) throw new Error("no drawn selection to drag");
  let data = null;
  const off = page.session.on("Input.dragIntercepted", (params) => {
    data = params.data;
  });
  await page.session.send("Input.setInterceptDrags", { enabled: true });
  try {
    await page.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: source.x, y: source.y });
    await page.session.send("Input.dispatchMouseEvent", { type: "mousePressed", x: source.x, y: source.y, button: "left", clickCount: 1, buttons: 1 });
    for (let step = 1; step <= 10; step += 1) {
      const x = source.x + ((target.x - source.x) * step) / 10;
      const y = source.y + ((target.y - source.y) * step) / 10;
      await page.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
    }
    if (!data) throw new NotAutomated("the browser started no drag");
    for (const type of ["dragEnter", "dragOver", "drop"]) {
      await page.session.send("Input.dispatchDragEvent", { type, x: target.x, y: target.y, data });
    }
  } finally {
    await page.session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: target.x, y: target.y, button: "left", clickCount: 1, buttons: 0 });
    await page.session.send("Input.setInterceptDrags", { enabled: false });
    off();
  }
}

async function pointer(page, action, interval) {
  const literal = (text) => {
    const found = literalIn(text);
    return found && found.value;
  };
  const nth = /\(2nd\)/.test(action) ? 2 : 1;
  let match = /^(Shift\+click|middle-click|click) (.*)$/.exec(action);
  if (match) {
    const [, verb, what] = match;
    let at;
    if (what.startsWith("`") || what.startsWith('"')) at = await point(page, `window.__qaTextPoint(${JSON.stringify(literal(what))}, ${nth})`, what);
    else if (what.includes("¦")) at = await point(page, `window.__qaTextPoint(${JSON.stringify(what)}, 1)`, what);
    else if (what.startsWith("cell ")) at = await point(page, `window.__qaTarget("cell", ${JSON.stringify(what.slice(5))})`, what);
    else if (["rule", "image", "diagram", "below", "bullet", "bar", "table edge"].includes(what)) at = await point(page, `window.__qaTarget(${JSON.stringify(what)})`, what);
    else if ((match = /^the (left|right) half of the joining space$/.exec(what))) at = await point(page, `window.__qaTarget("joining space", "${match[1]}")`, what);
    else if ((match = /^the (first|second) empty line under (`[^`]+`)$/.exec(what))) at = await point(page, `window.__qaTarget("empty line under", { word: ${JSON.stringify(literal(match[2]))}, nth: ${match[1] === "first" ? 1 : 2} })`, what);
    else if (what === "the right half of the tab") at = await point(page, `window.__qaTarget("tab")`, what);
    else throw new NotAutomated(action);
    await page.click(at.x, at.y, { modifiers: verb === "Shift+click" ? 8 : 0, button: verb === "middle-click" ? "middle" : "left" });
    return;
  }
  match = /^(dblclick|tripleclick) (.*)$/.exec(action);
  if (match) {
    const [, verb, what] = match;
    let at;
    if (what.startsWith("`")) at = await point(page, `window.__qaWordPoint(${JSON.stringify(literal(what))}, ${nth})`, what);
    else if (what === "the third of the four spaces") at = await point(page, `window.__qaWordPoint("    ", 1, 2)`, what);
    else if (what === "the empty line") at = await point(page, `window.__qaTarget("empty line under", { word: "one", nth: 1 })`, what);
    else throw new NotAutomated(action);
    await page.click(at.x, at.y, { clickCount: verb === "dblclick" ? 2 : 3, interval });
    return;
  }
  match = /^drag (`[^`]*`) to (`[^`]*`)$/.exec(action);
  if (match) {
    const from = await point(page, `window.__qaTextPoint(${JSON.stringify(literal(match[1]))}, 1)`, match[1]);
    const to = await point(page, `window.__qaTextPoint(${JSON.stringify(literal(match[2]))}, 1)`, match[2]);
    await page.drag(from, to);
    return;
  }
  match = /^drag the selection to (`[^`]*`)$/.exec(action);
  if (match) {
    await dropSelection(page, literal(match[1]));
    return;
  }
  throw new NotAutomated(action);
}

async function act(page, token, interval) {
  if (token.text != null) return page.type(token.text);
  if (token.compose) {
    for (const step of token.compose) {
      await page.session.send("Input.imeSetComposition", { text: step, selectionStart: step.length, selectionEnd: step.length });
    }
    await page.session.send("Input.insertText", { text: token.commit });
    return;
  }
  if (token.action) return pointer(page, token.action, interval);
  if ([...token.key].length === 1 && !"←↑→↓".includes(token.key)) return page.type(token.key);
  const { name, modifiers } = parseKey(token.key);
  try {
    await page.key(name, modifiers);
  } catch {
    throw new NotAutomated(`key ${token.key}`);
  }
}

async function place(page, cell, route, interval) {
  const { bytes, focus, anchor } = cell.source;
  if (route === "click") await clickAt(page, bytes, focus);
  else if (route === "drag") {
    const from = await boundaryPoint(page, bytes, anchor);
    const to = await boundaryPoint(page, bytes, focus);
    await page.drag(from, to);
  } else if (route === "down") {
    await clickAt(page, bytes, lineStart(bytes, focus) - 1);
    await page.quiet();
    await page.key("↓");
  } else if (route === "up") {
    const below = lineEnd(bytes, focus) + 1;
    if (PHANTOM(bytes, below)) await page.clickBelow();
    else {
      const target = await firstDrawn(page, below, lineEnd(bytes, below));
      await clickAt(page, bytes, target == null ? below : target);
    }
    await page.quiet();
    await page.key("↑");
  } else if (route === "emptied") {
    await clickAt(page, cell.routeBytes, focus + 1);
    await page.quiet();
    await page.key("Backspace");
  } else if (/^(click|Shift\+click|middle-click) /.test(route)) {
    await pointer(page, route, interval);
    if (cell.thenBoundary) {
      await page.quiet();
      await clickAt(page, bytes, focus);
    }
  } else {
    throw new NotAutomated(`route ${route}`);
  }
  await page.quiet();
}

function withProbe(marked, letter) {
  const { bytes, focus, anchor } = marked;
  const from = Math.min(focus, anchor);
  const to = Math.max(focus, anchor);
  return bytes.slice(0, from) + letter + bytes.slice(to);
}

const range = (anchor, focus) => (anchor === focus ? `${focus}` : `${anchor}..${focus}`);

export async function runCell({ hub, page }, cell, routeName, serial) {
  const [route, wait] = routeName.split("@");
  const interval = wait ? Number(wait) : 30;
  const result = { id: cell.id, route: routeName, status: "PASS", failed: [], observed: {} };
  const file = `${cell.id}--${routeName}--${serial}.md`.replace(/[^A-Za-z0-9.-]/g, "_");
  const bytes = cell.source.bytes;
  cell.routeBytes = route === "emptied" ? bytes.slice(0, cell.source.focus) + "x" + bytes.slice(cell.source.focus) : bytes;
  await hub.create(file, cell.routeBytes);
  page.frames.length = 0;
  await page.open(file);
  try {
    await place(page, cell, route, interval);
  } catch (err) {
    if (err instanceof NotAutomated) return { ...result, status: "BLOCKED", failed: [`not automated: ${err.message}`] };
    return { ...result, status: "BLOCKED", routeFailed: true, failed: [`placement: ${err.message}`] };
  }
  const placed = await hub.show(file);
  const at = await page.caret();
  result.observed.placed = { bytes: placed.text, caret: at };
  if (placed.text !== bytes || at.none || at.focus !== cell.source.focus || at.anchor !== cell.source.anchor) {
    // The route failed. Press the keys anyway and record what a person would see.
    let seen = "";
    try {
      for (const key of cell.keys) {
        await act(page, key, interval);
        await page.quiet();
      }
      seen = `; the keys then gave ${JSON.stringify((await hub.show(file)).text)}`;
    } catch (err) {
      seen = `; the keys then failed: ${err.message}`;
    }
    const got = at.none ? "no selection" : `${range(at.anchor, at.focus)} at ${at.focusPath || "the editor root"}`;
    return { ...result, status: "BLOCKED", routeFailed: true, failed: [`placement: wanted ${range(cell.source.anchor, cell.source.focus)}, got ${got}${placed.text !== bytes ? `, bytes ${JSON.stringify(placed.text)}` : ""}${seen}`] };
  }
  const before = placed.rev;
  try {
    for (const key of cell.keys) {
      await act(page, key, interval);
      await page.quiet();
    }
  } catch (err) {
    if (err instanceof NotAutomated) return { ...result, status: "BLOCKED", failed: [`not automated: ${err.message}`] };
    return { ...result, status: "FAIL", failed: [`keys: ${err.message}`] };
  }
  const shown = await hub.show(file);
  const caret = await page.caret();
  result.observed = { ...result.observed, bytes: shown.text, rev: shown.rev - before, caret };
  if (cell.expectKind === "prose") {
    if (shown.text !== bytes) result.failed.push(`I1 bytes: a move changed them to ${JSON.stringify(shown.text)}`);
    if (result.failed.length) return { ...result, status: "FAIL" };
    return { ...result, status: "BLOCKED", failed: [`geo oracle not automated; the caret is at ${caret.none ? "no selection" : range(caret.anchor, caret.focus)}`] };
  }
  const expect = cell.expect;
  const collapsed = expect.anchor === expect.focus;
  const boundary = collapsed ? await page.boundary(expect.focus) : null;
  result.observed.boundary = boundary;
  if (shown.text !== expect.bytes) result.failed.push(`I1 bytes: wanted ${JSON.stringify(expect.bytes)}, got ${JSON.stringify(shown.text)}`);
  if (caret.none || !caret.inside) result.failed.push("I2 caret: no selection in the editor");
  else if (caret.focus !== expect.focus || caret.anchor !== expect.anchor) result.failed.push(`I2 caret: wanted ${range(expect.anchor, expect.focus)}, got ${range(caret.anchor, caret.focus)} at ${caret.focusPath || "the editor root"}`);
  if (collapsed) {
    if (!boundary) result.failed.push(`I3 drawn: offset ${expect.focus} has no drawn boundary`);
    else if (caret.rect) {
      const middle = (caret.rect.top + caret.rect.bottom) / 2;
      if (Math.abs(caret.rect.x - boundary.x) > 2 || middle < boundary.top || middle > boundary.bottom) {
        result.failed.push(`I3 drawn: caret at x ${caret.rect.x.toFixed(1)} y ${middle.toFixed(1)}${caret.fallback ? " (fallback)" : ""}, boundary at x ${boundary.x.toFixed(1)} y ${boundary.top.toFixed(1)}-${boundary.bottom.toFixed(1)}`);
      }
    } else result.failed.push("I3 drawn: the caret has no rect");
  }
  const [low, high] = editRange(cell);
  const moved = shown.rev - before;
  if (moved < low || moved > high) result.failed.push(`I5 rev: wanted +${low === high ? low : `${low} to ${high}`}, got +${moved}`);
  if (!caret.focused) result.failed.push("focus: the editor does not have focus");
  const errors = page.frames.filter((frame) => frame.dir === "exception" || (frame.dir === "in" && frame.data && frame.data.type === "error"));
  if (errors.length) result.failed.push(`I7 quiet: ${errors.map((frame) => JSON.stringify(frame.data)).join(", ")}`);
  // I9: where does the next keystroke land?
  await page.key("Q");
  await page.quiet();
  const probed = await hub.show(file);
  const wanted = withProbe(expect, "Q");
  if (probed.text !== wanted) result.failed.push(`I9 probe: Q wanted ${JSON.stringify(wanted)}, got ${JSON.stringify(probed.text)}`);
  else {
    await page.key("Backspace");
    await page.quiet();
    const back = await hub.show(file);
    const restored = withProbe(expect, "");
    if (back.text !== restored) result.failed.push(`I9 probe: Backspace after Q wanted ${JSON.stringify(restored)}, got ${JSON.stringify(back.text)}`);
  }
  result.observed.sent = page.frames.filter((frame) => frame.dir === "out" && frame.data && frame.data.type !== "lock").map((frame) => frame.data);
  if (result.failed.length) {
    result.status = "FAIL";
    result.observed.html = await page.eval("window.__qaRoot().outerHTML");
  }
  return result;
}
