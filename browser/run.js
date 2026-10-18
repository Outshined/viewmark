import { setTimeout as sleep } from "node:timers/promises";
import { FILL, literalIn } from "./cells.js";

// Runs one cell by one route and checks the invariants of qa/editor-matrix-test-plan.md.

const PHANTOM = (bytes, offset) => offset === bytes.length && bytes.endsWith("\n");
const HISTORY = new Set(["Ctrl+Z", "Ctrl+Y", "Ctrl+Shift+Z"]);
const NO_EDIT = new Set(["read", "reconnect", "offline", "online", "walk", "Shift+End", "←", "→", "↑", "↓", "Home", "End", "PageDown", "Escape", "Ctrl+A", "Ctrl+C", "Ctrl+Home", "Ctrl+End", "Ctrl+←", "Ctrl+→", "Ctrl+Shift+←", "Ctrl+Shift+→", "Shift+←", "Shift+→", "Shift+↑", "Shift+↓", "Shift+Home", "Shift+End"]);
const POINTER = /^(Shift\+click|middle-click|click|dblclick|tripleclick|drag) /;

// Seven BG cells also run every other route the plan names.
const WIDE = new Set(["BG.h-p", "BG.tb-p", "BG.p-eof", "BG.fb-fb"]);
const PREFIX = { remote: "zero\n\n", scrolled: FILL };
const SUFFIX = { "remote-below": "\n\nlast\n" };

class NotAutomated extends Error {}
class NotApplicable extends Error {}

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

const quoted = (text) => {
  const found = literalIn(text);
  return found && found.value;
};

// One edit per key that edits, per the plan's I5; a cell whose expectation is `same` edits
// nothing. An undo or redo with nothing to act on edits nothing, so each counts as 0 or 1.
// Page B's keys and the agent's commands count too, because they move the same rev.
function editRange(cell) {
  if (cell.expectKind === "same") return [0, 0];
  let low = 0;
  let high = 0;
  for (const token of cell.keys) {
    let key = token.key;
    if (key && key.startsWith("agent: ")) {
      if (!key.endsWith("(refused)")) low += 1;
      continue;
    }
    if (key && key.startsWith("B: ")) key = key.slice(3);
    if (key && /^pause \d+ ms$/.test(key)) continue;
    if (token.text != null) low += [...token.text].length;
    else if (token.compose) low += 1;
    // A middle-click pastes the primary selection. Dragging that selection moves it.
    // Each of those is one edit (R88).
    else if (token.action && (token.action.startsWith("middle-click") || token.action.startsWith("drag the selection"))) low += 1;
    else if (token.action || POINTER.test(key)) continue;
    else if (HISTORY.has(key)) high += 1;
    else if (!NO_EDIT.has(key)) low += 1;
  }
  return [low, low + high];
}

export function routesFor(cell) {
  const timed = (name) => (cell.id.startsWith("DC.") || cell.id.startsWith("T3.") ? [`${name}@30`, `${name}@250`] : [name]);
  if (cell.routes.length) return cell.routes.map((route) => ({ "↓": "down", "↑": "up" })[route] || route).flatMap(timed);
  if (cell.id.startsWith("BG.")) {
    const { bytes, focus } = cell.source;
    const above = lineStart(bytes, focus) > 0;
    const below = lineEnd(bytes, focus) < bytes.length;
    const routes = ["click"];
    if (above) routes.push("down");
    if (below) routes.push("up");
    routes.push("emptied");
    if (WIDE.has(cell.id)) {
      if (below) routes.push("left");
      if (above) routes.push("right");
      routes.push("cleared", "undone", "margin", "far", "gap", "remote", "remote-below", "reconnect", "resize", "refocus", "scrolled");
    }
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
  // The clicked block can open a moment after the click, so wait for the boundary to be drawn.
  const started = Date.now();
  while (!(found = await page.eval(`window.__qaClickPoint(${offset})`)) && Date.now() - started < 1500) await sleep(50);
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

// The box of the line a caret at this offset sits on: an empty line, or the line of the glyph
// before it.
async function lineBox(page, bytes, offset) {
  if (PHANTOM(bytes, offset)) {
    const below = await page.eval("window.__qaBelow()");
    return { left: below.x - 20, top: below.y - 40, bottom: below.y - 14 };
  }
  const box = await page.eval(`(() => {
    const empty = window.__qaEmptyLine(${offset}) || window.__qaBreak(${offset});
    if (empty) return empty;
    const glyph = window.__qaGlyph(${offset}) || window.__qaGlyph(${offset} - 1);
    return glyph && { left: window.__qaRoot().getBoundingClientRect().left + 22, top: glyph.top, bottom: glyph.bottom };
  })()`);
  if (!box) throw new Error(`no drawn line for offset ${offset}`);
  return box;
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

// The same x, moved to the top of the target's line or the bottom of its glyphs.
async function atEdge(page, at, what, edge, nth) {
  if (!edge) return at;
  const needle = quoted(what).replace("¦", "");
  return { x: at.x, y: await point(page, `window.__qaLineEdge(${JSON.stringify(needle)}, ${nth}, "${edge}")`, what) };
}

async function pointer(page, action, interval) {
  const ordinal = /\((\d+)(?:st|nd|rd|th)\)/.exec(action);
  const nth = ordinal ? Number(ordinal[1]) : 1;
  const band = / at the (top of its line|bottom of its glyphs)$/.exec(action);
  const edge = band && band[1].split(" ")[0];
  if (band) action = action.slice(0, band.index);
  let match = /^(Shift\+click|middle-click|click) (.*)$/.exec(action);
  if (match) {
    const [, verb, what] = match;
    let at;
    if (what.startsWith("`") || what.startsWith('"')) at = await point(page, `window.__qaTextPoint(${JSON.stringify(quoted(what))}, ${nth})`, what);
    else if (what.includes("¦")) at = await point(page, `window.__qaTextPoint(${JSON.stringify(what)}, 1)`, what);
    else if (what.startsWith("cell ")) at = await point(page, `window.__qaTarget("cell", ${JSON.stringify(what.slice(5))})`, what);
    else if (["rule", "image", "diagram", "below", "bullet", "bar", "table edge"].includes(what)) at = await point(page, `window.__qaTarget(${JSON.stringify(what)})`, what);
    else if ((match = /^the (left|right) half of the joining space$/.exec(what))) at = await point(page, `window.__qaTarget("joining space", "${match[1]}")`, what);
    else if ((match = /^the (first|second|third) empty line under (`[^`]+`)$/.exec(what))) at = await point(page, `window.__qaTarget("empty line under", { word: ${JSON.stringify(quoted(match[2]))}, nth: ${["first", "second", "third"].indexOf(match[1]) + 1} })`, what);
    else if ((match = /^the (left|right) half of the tab$/.exec(what))) at = await point(page, `window.__qaTarget("tab", "${match[1]}")`, what);
    else throw new NotAutomated(action);
    at = await atEdge(page, at, what, edge, nth);
    await page.click(at.x, at.y, { modifiers: verb === "Shift+click" ? 8 : 0, button: verb === "middle-click" ? "middle" : "left" });
    return;
  }
  match = /^(dblclick|tripleclick) (.*)$/.exec(action);
  if (match) {
    const [, verb, what] = match;
    let at;
    if (what.startsWith("`")) at = await point(page, `window.__qaWordPoint(${JSON.stringify(quoted(what))}, ${nth})`, what);
    else if (what === "the third of the four spaces") at = await point(page, `window.__qaWordPoint("    ", 1, 2)`, what);
    else if (what === "the empty line") at = await point(page, `window.__qaTarget("empty line under", { word: "one", nth: 1 })`, what);
    else throw new NotAutomated(action);
    at = await atEdge(page, at, what, edge, nth);
    await page.click(at.x, at.y, { clickCount: verb === "dblclick" ? 2 : 3, interval });
    return;
  }
  match = /^drag (`[^`]*`) to (`[^`]*`)$/.exec(action);
  if (match) {
    const from = await point(page, `window.__qaTextPoint(${JSON.stringify(quoted(match[1]))}, 1)`, match[1]);
    const to = await point(page, `window.__qaTextPoint(${JSON.stringify(quoted(match[2]))}, 1)`, match[2]);
    await page.drag(from, to);
    return;
  }
  match = /^drag the selection to (`[^`]*`)$/.exec(action);
  if (match) {
    await dropSelection(page, quoted(match[1]));
    return;
  }
  throw new NotAutomated(action);
}

// One hunk covering the whole file, so its old lines match exactly once.
function wholeDiff(before, after) {
  const lines = (text) => {
    const parts = text.split("\n");
    const last = parts.pop();
    return { parts: text.endsWith("\n") ? parts : [...parts, last], newline: text.endsWith("\n") };
  };
  const a = lines(before);
  const b = lines(after);
  const out = ["--- a", "+++ b", `@@ -1,${a.parts.length} +1,${b.parts.length} @@`];
  for (const line of a.parts) out.push(`-${line}`);
  if (!a.newline) out.push("\\ No newline at end of file");
  for (const line of b.parts) out.push(`+${line}`);
  if (!b.newline) out.push("\\ No newline at end of file");
  return `${out.join("\n")}\n`;
}

function lineColumn(text, offset) {
  const line = text.slice(0, offset).split("\n").length;
  return `${line}:${offset - (text.lastIndexOf("\n", offset - 1) + 1)}`;
}

// The agent reads the file, as an agent does, then makes one change through the CLI.
async function agent(context, text) {
  const refused = text.endsWith(" (refused)");
  const command = refused ? text.slice(0, -" (refused)".length) : text;
  const { hub, file } = context;
  const current = (await hub.show(file, "qa-cli")).text;
  let done;
  let match;
  if ((match = /^prepend (".*")$/.exec(command))) done = await hub.edit(file, wholeDiff(current, quoted(match[1]) + current));
  else if ((match = /^append (".*")$/.exec(command))) done = await hub.edit(file, wholeDiff(current, current + quoted(match[1])));
  else if ((match = /^replace (".*") with (".*")$/.exec(command))) {
    const old = quoted(match[1]);
    const at = current.indexOf(old);
    if (at < 0) throw new Error(`agent: ${JSON.stringify(old)} is not in the file`);
    done = await hub.edit(file, wholeDiff(current, current.slice(0, at) + quoted(match[2]) + current.slice(at + old.length)));
  } else if ((match = /^comment (".*")$/.exec(command))) {
    const target = quoted(match[1]);
    const at = current.indexOf(target);
    if (at < 0) throw new Error(`agent: ${JSON.stringify(target)} is not in the file`);
    done = await hub.comment(file, lineColumn(current, at), lineColumn(current, at + target.length), target, "Why?\n");
  } else throw new NotAutomated(`agent ${command}`);
  if (refused && done.code === 0) throw new Error(`agent ${command}: wanted a refusal, but the hub applied it`);
  if (!refused && done.code !== 0) throw new Error(`agent ${command}: refused: ${(done.stdout + done.stderr).trim()}`);
}

// Drop the page's socket at the proxy, and wait for the page to retry and be sent the file.
async function reconnect(page, context) {
  const since = page.frames.length;
  context.proxy.drop();
  await page.until(() => page.frames.slice(since).some((frame) => frame.dir === "in" && frame.data && frame.data.type === "file"), "the file after a reconnect", 15000);
}

async function act(page, token, interval, context) {
  if (token.key && token.key.startsWith("B: ")) {
    // B is a second user who talks to the hub directly (browser/other.js).
    const inner = token.key.slice(3);
    const other = await context.other();
    const literal = literalIn(inner);
    const typed = !POINTER.test(inner) && literal && literal.end === inner.length;
    const done = await other.act(typed ? literal.value : inner);
    if (done && done.unsupported) throw new NotAutomated(`B: ${done.unsupported}`);
    return;
  }
  if (token.key && token.key.startsWith("agent: ")) return agent(context, token.key.slice(7));
  // A pause between keys, for rules that depend on time, such as an undo run (D33).
  const pause = /^pause (\d+) ms$/.exec(token.key || "");
  if (pause) return sleep(Number(pause[1]));
  if (token.key === "reconnect") return reconnect(page, context);
  if (token.key === "offline") return context.proxy.offline();
  if (token.key === "online") {
    const since = page.frames.length;
    context.proxy.online();
    return page.until(() => page.frames.slice(since).some((frame) => frame.dir === "in" && frame.data && frame.data.type === "file"), "the file after coming back online", 20000);
  }
  if (token.text != null) return page.type(token.text);
  // Another client opens the file, as an agent reading it would.
  if (token.key === "read") return context.hub.show(context.file, "qa-cli");
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

// Scroll with the wheel until a point is in the middle third of the viewport.
async function scrollTo(page, read) {
  for (let i = 0; i < 20; i += 1) {
    const at = await read();
    const height = await page.eval("innerHeight");
    if (at.y > height / 3 && at.y < (height * 2) / 3) return;
    await page.session.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 600, y: height / 2, deltaX: 0, deltaY: at.y - height / 2 });
    await page.quiet();
  }
}

async function place(page, cell, route, interval, context, target) {
  const { bytes, focus, anchor } = target;
  if (route === "click") await clickAt(page, bytes, focus);
  else if (route === "drag") {
    const from = await boundaryPoint(page, bytes, anchor);
    const to = await boundaryPoint(page, bytes, focus);
    await page.drag(from, to);
  } else if (route === "down") {
    await clickAt(page, bytes, lineStart(bytes, focus) - 1);
    await page.quiet();
    await page.key("↓");
  } else if (route === "up" || route === "left") {
    const below = lineEnd(bytes, focus) + 1;
    if (PHANTOM(bytes, below)) await page.clickBelow();
    else {
      const start = await firstDrawn(page, below, lineEnd(bytes, below));
      await clickAt(page, bytes, start == null ? below : start);
    }
    await page.quiet();
    await page.key(route === "up" ? "↑" : "←");
  } else if (route === "right") {
    await clickAt(page, bytes, lineStart(bytes, focus) - 1);
    await page.quiet();
    await page.key("→");
  } else if (route === "emptied") {
    await clickAt(page, cell.routeBytes, focus + 1);
    await page.quiet();
    await page.key("Backspace");
  } else if (route === "cleared") {
    // A double-click selects xyz alone. A triple-click selects the whole block (R85), and xyz
    // often soft-joins the line above or below, so it would take their text too.
    await pointer(page, "dblclick `xyz`", interval);
    await page.quiet();
    await page.key("Backspace");
  } else if (route === "undone") {
    await clickAt(page, bytes, focus);
    await page.quiet();
    await page.type("x");
    await page.quiet();
    await page.key("Z", ["Ctrl"]);
  } else if (route === "margin" || route === "far" || route === "gap") {
    const box = await lineBox(page, bytes, focus);
    const right = await page.eval("window.__qaRoot().getBoundingClientRect().right");
    const y = route === "gap" ? box.top + 1 : (box.top + box.bottom) / 2;
    const x = route === "margin" ? box.left - 8 : route === "far" ? right - 20 : box.left + 10;
    await page.click(x, y);
  } else if (route === "remote" || route === "remote-below") {
    await clickAt(page, bytes, focus);
    await page.quiet();
    try {
      await agent(context, `${route === "remote" ? "prepend" : "append"} ${JSON.stringify(route === "remote" ? PREFIX.remote : SUFFIX["remote-below"])}`);
    } catch (err) {
      // The page's own hold covers the start of the file here, so the hub rightly refuses the
      // agent's insertion there (R97); the route cannot exist for this cell.
      if (route === "remote" && /held by qa-bot/.test(err.message)) throw new NotApplicable("the agent's insertion at the start of the file touches the span this page holds, which the hub rightly refuses");
      throw err;
    }
  } else if (route === "reconnect") {
    await clickAt(page, bytes, focus);
    await page.quiet();
    await reconnect(page, context);
  } else if (route === "resize") {
    await clickAt(page, bytes, focus);
    await page.quiet();
    const height = await page.eval("innerHeight");
    await page.session.send("Emulation.setDeviceMetricsOverride", { width: 700, height, deviceScaleFactor: 1, mobile: false });
    await page.quiet();
    await page.session.send("Emulation.clearDeviceMetricsOverride");
  } else if (route === "refocus") {
    await clickAt(page, bytes, focus);
    await page.quiet();
    const blank = await context.browser.openBlank();
    await context.browser.activate(blank);
    await sleep(200);
    await context.browser.activate(context.browser.targetId);
    await context.browser.closeTarget(blank);
  } else if (route === "scrolled") {
    if (PHANTOM(bytes, focus)) await scrollTo(page, () => page.eval("window.__qaBelow()"));
    else await scrollTo(page, async () => (await page.eval(`window.__qaClickPoint(${focus})`)) || { y: 0 });
    await clickAt(page, bytes, focus);
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

// A position-only cell names where the caret may be without naming the offset, so nothing in
// it depends on glyph widths. When the caret is somewhere allowed, the rest of the checks run
// against that place.
function positionExpect(cell, caret, result, shownText) {
  const { bytes, focus: start } = cell.source;
  const { on, move, at: around } = cell.position;
  if (caret.none || !caret.inside) {
    result.failed.push("I2 caret: no selection in the editor");
    return null;
  }
  const at = caret.focus;
  let wanted;
  if (around != null) {
    const needle = around.replace("‸", "");
    const found = shownText.indexOf(needle);
    if (found < 0 || shownText.indexOf(needle, found + 1) >= 0) wanted = `inside the one ${JSON.stringify(needle)}, which is not there once`;
    else if (at !== found + around.indexOf("‸")) wanted = `${found + around.indexOf("‸")}, at ${JSON.stringify(around)}`;
    if (wanted) result.failed.push(`I2 caret: wanted ${wanted}, got ${range(caret.anchor, caret.focus)}`);
    return { bytes: shownText, focus: at, anchor: at };
  }
  if (on != null) {
    const found = bytes.indexOf(on);
    const from = lineStart(bytes, found);
    const to = lineEnd(bytes, found);
    if (at < from || at > to) wanted = `on ${JSON.stringify(on)} (${from}..${to})`;
  } else if (move === "later in the file") {
    if (at <= start) wanted = `after ${start}`;
  } else if (move === "later in the block") {
    const blank = bytes.indexOf("\n\n", start);
    const end = blank < 0 ? bytes.length : blank;
    if (at <= start || at > end) wanted = `after ${start} and at most ${end}`;
  } else if (move === "earlier in the block") {
    const blank = bytes.lastIndexOf("\n\n", start - 1);
    const from = blank < 0 ? 0 : blank + 2;
    if (at >= start || at <= from) wanted = `before ${start} and after ${from}`;
  }
  // "the end of its visual line" and "the start of its visual line" are read from the drawn
  // page, in visualLineEdge.
  if (wanted) result.failed.push(`I2 caret: wanted ${wanted}, got ${range(caret.anchor, caret.focus)} at ${caret.focusPath || "the editor root"}`);
  return { bytes, focus: at, anchor: at };
}

// End goes after the last character on the visual line it started on, a space included: the
// first offset whose glyph is drawn on a later line (R74, the owner on ticket pg66fa4a). Home
// goes to the first character drawn on that line. Either way the caret is drawn on that line.
async function visualLineEdge(page, source, caret, result, move) {
  const { bytes, focus: start } = source;
  const line = await page.eval(`(() => {
    const text = ${JSON.stringify(bytes)};
    const first = window.__qaGlyph(${start});
    if (!first) return null;
    const middle = (g) => (g.top + g.bottom) / 2;
    let k = ${start};
    if (${JSON.stringify(move)} === "the end of its visual line") {
      for (; k < text.length; k += 1) {
        const g = window.__qaGlyph(k);
        // A soft newline is drawn as a space on the line. A newline drawn as nothing ends it.
        if (g ? middle(g) > first.bottom + 2 : text[k] === "\\n") break;
      }
    } else {
      // A marker drawn as nothing, or a glyph on the line above, is before the line's text.
      for (; k > 0; k -= 1) {
        const g = window.__qaGlyph(k - 1);
        if (!g || middle(g) < first.top - 2) break;
      }
    }
    return { at: k, top: first.top, bottom: first.bottom };
  })()`);
  if (!line) return result.failed.push(`I2 caret: offset ${start} has no glyph to find its visual line by`);
  const which = move === "the end of its visual line" ? "after the last character on" : "at the first character drawn on";
  if (caret.focus !== line.at || caret.anchor !== line.at) result.failed.push(`I2 caret: wanted ${line.at}, ${which} the visual line holding ${start}, got ${range(caret.anchor, caret.focus)}`);
  const middle = caret.rect ? (caret.rect.top + caret.rect.bottom) / 2 : null;
  if (caret.unpainted) result.unchecked.push("I3: where this browser paints the caret is not in its screenshots");
  else if (middle == null || middle < line.top - 2 || middle > line.bottom + 2) result.failed.push(`I3 drawn: the caret is drawn at y ${middle == null ? "nowhere" : middle.toFixed(1)}, not on the visual line it started on, y ${line.top.toFixed(1)}-${line.bottom.toFixed(1)}`);
}

// Where a caret is drawn against where its offset belongs; null when they agree.
async function drawnProblem(page, caret, offset) {
  const boundary = await page.boundary(offset);
  if (!boundary) return `offset ${offset} has no drawn boundary`;
  if (!caret.rect) return "the caret has no rect";
  const middle = (caret.rect.top + caret.rect.bottom) / 2;
  const on = (spot) => Math.abs(caret.rect.x - spot.x) <= 2 && middle >= spot.top && middle <= spot.bottom;
  if (on(boundary) || (boundary.alt && on(boundary.alt))) return null;
  return `caret at x ${caret.rect.x.toFixed(1)} y ${middle.toFixed(1)}${caret.fallback ? " (fallback)" : ""}, boundary at x ${boundary.x.toFixed(1)} y ${boundary.top.toFixed(1)}-${boundary.bottom.toFixed(1)}`;
}

// Offsets strictly inside a hidden marker: hard-break spaces or a backslash after the end of
// a line's text (D17), and the inside of a comment marker (D6).
function hiddenOffsets(bytes) {
  const inside = new Set();
  for (const m of bytes.matchAll(/( {2,}|\\)\n/g)) for (let i = m.index + 1; i <= m.index + m[1].length; i += 1) inside.add(i);
  for (const m of bytes.matchAll(/\{\/?[A-Za-z][\w-]*\}/g)) for (let i = m.index + 1; i < m.index + m[0].length; i += 1) inside.add(i);
  return inside;
}

// Press → until the caret stops, checking each stop.
async function walk(page, bytes, failed) {
  const inside = hiddenOffsets(bytes);
  const problems = [];
  let at = await page.caret();
  for (let step = 0; step <= bytes.length + 2; step += 1) {
    await page.key("→");
    await page.quiet();
    const next = await page.caret();
    if (next.none || !next.inside) {
      problems.push(`after ${at.focus}, no selection in the editor`);
      break;
    }
    if (next.focus === at.focus) return problems.length ? failed.push(`walk: ${problems.length} bad stops: ${problems.slice(0, 6).join("; ")}`) : null;
    if (next.focus < at.focus) problems.push(`from ${at.focus} back to ${next.focus}`);
    if (inside.has(next.focus)) problems.push(`stopped at ${next.focus}, inside a hidden marker`);
    const drawn = await drawnProblem(page, next, next.focus);
    if (drawn) problems.push(`at ${next.focus}: ${drawn}`);
    at = next;
  }
  failed.push(`walk: never stopped${problems.length ? `; ${problems.slice(0, 6).join("; ")}` : ""}`);
}

// R11: a letter typed on an empty line, or at the start of a rule or a fence line, directly
// under a paragraph line, an item, or a quote writes the file's newline first. The harness
// states the rule itself rather than asking src/doc.js.
function probeBreak(bytes, at) {
  if (at === 0 || bytes[at - 1] !== "\n") return "";
  const nl = bytes.includes("\r\n") ? "\r\n" : "\n";
  const lines = bytes.split("\n").map((line) => line.replace(/\r$/, ""));
  const index = bytes.slice(0, at).split("\n").length - 1;
  const fence = (line) => /^(```|~~~)/.test(line);
  let inFence = false;
  for (let i = 0; i < index; i += 1) if (fence(lines[i])) inFence = !inFence;
  if (inFence) return "";
  const line = lines[index] || "";
  if (line !== "" && !/^(---|\*\*\*|___)$/.test(line) && !fence(line)) return "";
  const above = lines[index - 1];
  let aboveInFence = false;
  for (let i = 0; i < index - 1; i += 1) if (fence(lines[i])) aboveInFence = !aboveInFence;
  if (aboveInFence || above.trim() === "" || fence(above)) return "";
  // A line after a hard break belongs to the block above (D28).
  if (/\\$/.test(above) || / {2,}$/.test(above)) return "";
  if (/^#{1,6}(\s|$)/.test(above) || /^(---|\*\*\*|___)$/.test(above) || above.startsWith("|") || /^!\[[^\]]*\]\([^)]*\)$/.test(above)) return "";
  return nl;
}

function withProbe(marked, letter) {
  const { bytes, focus, anchor } = marked;
  const from = Math.min(focus, anchor);
  const to = Math.max(focus, anchor);
  const lead = from === to && letter ? probeBreak(bytes, from) : "";
  return bytes.slice(0, from) + lead + letter + bytes.slice(to);
}

// I13: each comment id opens once and closes once after it, has one fence, and crosses no
// other comment. Markers inside a fence body are text, so only the prose before the first
// comment fence is read.
function brokenComment(text) {
  const at = text.search(/\n*```comment /);
  const prose = at < 0 ? text : text.slice(0, at);
  const plain = prose.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, (m) => " ".repeat(m.length));
  const fences = [...text.matchAll(/^```comment ([A-Za-z][\w-]*)/gm)].map((m) => m[1]);
  const opens = [...plain.matchAll(/\{([A-Za-z][\w-]*)\}/g)];
  const closes = [...plain.matchAll(/\{\/([A-Za-z][\w-]*)\}/g)];
  const ids = new Set([...opens.map((m) => m[1]), ...closes.map((m) => m[1]), ...fences]);
  const spans = [];
  for (const id of ids) {
    const o = opens.filter((m) => m[1] === id);
    const c = closes.filter((m) => m[1] === id);
    const f = fences.filter((x) => x === id).length;
    if (o.length !== 1 || c.length !== 1 || f !== 1) return `${id} opens ${o.length}, closes ${c.length}, and has ${f} fences`;
    if (o[0].index > c[0].index) return `${id} closes before it opens`;
    spans.push([o[0].index, c[0].index, id]);
  }
  for (const a of spans) for (const b of spans) if (a[0] < b[0] && b[0] < a[1] && a[1] < b[1]) return `${a[2]} and ${b[2]} cross`;
  return null;
}

// Backspace removes the probe's Q. When that empties a comment's interior, the same edit
// removes the comment's markers and its thread (R36). The harness states that rule itself
// rather than asking src/doc.js, so the check does not take its answer from the code under test.
function probeAfterBackspace(marked) {
  const at = Math.min(marked.focus, marked.anchor);
  // Backspace takes only the Q. A newline R11 wrote before it stays.
  const lead = marked.focus === marked.anchor ? probeBreak(marked.bytes, at) : "";
  if (lead) return marked.bytes.slice(0, at) + lead + marked.bytes.slice(at);
  const plain = withProbe(marked, "");
  const open = /\{([A-Za-z][\w-]*)\}$/.exec(plain.slice(0, at));
  if (!open || !plain.startsWith(`{/${open[1]}}`, at)) return plain;
  const id = open[1];
  const unmarked = plain.slice(0, at - open[0].length) + plain.slice(at + id.length + 3);
  const fence = new RegExp(`^\`\`\`comment ${id}( resolved)?\\n[\\s\\S]*?^\`\`\`\\n?`, "m");
  return unmarked.replace(fence, "");
}

// The hub's bytes and rev for the open file, as it last sent them to the page. Reading them
// from there adds no client: a second client opening the file makes the page redraw, which
// would disturb the very caret being checked. The hub itself is read once, at the end.
function sent(page, file) {
  for (let i = page.frames.length - 1; i >= 0; i -= 1) {
    const frame = page.frames[i];
    const data = frame.dir === "in" && frame.data;
    if (data && (data.type === "doc" || data.type === "file") && (data.path == null || data.path === file) && typeof data.text === "string") {
      return { text: data.text, rev: data.rev };
    }
  }
  throw new Error(`the page was sent no text for ${file}`);
}

const range = (anchor, focus) => (anchor === focus ? `${focus}` : `${anchor}..${focus}`);
const shift = (marked, before, after) => marked && { bytes: before + marked.bytes + after, focus: marked.focus + before.length, anchor: marked.anchor + before.length };
const usesOther = (cell) => !!cell.other || cell.labels.length > 0 || cell.keys.some((token) => token.key && token.key.startsWith("B: "));

export async function runCell(suite, cell, routeName, serial) {
  const { hub, page } = suite;
  const [route, wait] = routeName.split("@");
  const interval = wait ? Number(wait) : 30;
  const result = { id: cell.id, route: routeName, status: "PASS", failed: [], unchecked: [], observed: {} };
  const requested = `${cell.id}--${routeName}--${serial}.md`.replace(/[^A-Za-z0-9.-]/g, "_");
  const bytes = cell.source.bytes;
  const before = PREFIX[route] || "";
  const after = SUFFIX[route] || "";
  // Where the caret must be once the route is done, and what the keys must then give. A remote
  // route's agent and a scrolled route's filler both add text around the cell's own.
  const start = shift(cell.source, before, after);
  const want = shift(cell.expect, before, after);
  const caretAt = cell.source.focus;
  if (route === "emptied") cell.routeBytes = bytes.slice(0, caretAt) + "x" + bytes.slice(caretAt);
  else if (route === "cleared") cell.routeBytes = bytes.slice(0, caretAt) + "xyz" + bytes.slice(caretAt);
  else if (route === "scrolled") cell.routeBytes = before + bytes;
  else cell.routeBytes = bytes;
  // Create stores the normalized path. The cell opens that path, not the requested spelling.
  const file = await hub.create(requested, cell.routeBytes);
  const context = { ...suite, file };
  page.frames.length = 0;
  await page.open(file);
  const target = route === "scrolled" ? start : cell.source;
  try {
    await place(page, cell, route, interval, context, target);
  } catch (err) {
    if (err instanceof NotAutomated || err?.unsupported) return { ...result, status: "BLOCKED", failed: [`not automated: ${err.message}`] };
    if (err instanceof NotApplicable) return { ...result, status: "BLOCKED", failed: [`not applicable: ${err.message}`] };
    return { ...result, status: "BLOCKED", routeFailed: true, failed: [`placement: ${err.message}`] };
  }
  if (usesOther(cell)) {
    const other = await suite.other();
    await other.open(file);
  }
  const placedCaret = await page.caret();
  const placed = sent(page, file);
  result.observed.placed = { bytes: placed.text, caret: placedCaret };
  if (placed.text !== start.bytes || placedCaret.none || placedCaret.focus !== start.focus || placedCaret.anchor !== start.anchor) {
    // The route failed. Press the keys anyway and record what a person would see.
    let seen = "";
    try {
      for (const key of cell.keys) {
        await act(page, key, interval, context);
        await page.quiet();
      }
      seen = `; the keys then gave ${JSON.stringify(sent(page, file).text)}`;
    } catch (err) {
      seen = `; the keys then failed: ${err.message}`;
    }
    const got = placedCaret.none ? "no selection" : `${range(placedCaret.anchor, placedCaret.focus)} at ${placedCaret.focusPath || "the editor root"}`;
    return { ...result, status: "BLOCKED", routeFailed: true, failed: [`placement: wanted ${range(start.anchor, start.focus)}, got ${got}${placed.text !== start.bytes ? `, bytes ${JSON.stringify(placed.text)}` : ""}${seen}`] };
  }
  const revBefore = placed.rev;
  const walking = cell.keys.length === 1 && cell.keys[0].key === "walk";
  if (walking) await walk(page, cell.source.bytes, result.failed);
  try {
    for (const key of walking ? [] : cell.keys) {
      await act(page, key, interval, context);
      await page.quiet();
      if (suite.hasOther()) await (await suite.other()).settle(sent(page, file).rev);
    }
  } catch (err) {
    if (err instanceof NotAutomated || err?.unsupported) return { ...result, status: "BLOCKED", failed: [`not automated: ${err.message}`] };
    return { ...result, status: "FAIL", failed: [`keys: ${err.message}`] };
  }
  // Firefox brings a tab to the front for its keys and clicks, so after page B acts last, page A
  // is behind it and its document has no focus. Chromium emulates focus in every tab. Page A is
  // brought back to the front before it is read, as a person returns to it.
  if (suite.hasOther() && page.session.bringForward) await page.session.bringForward();
  const caret = await page.caret();
  const shown = sent(page, file);
  result.observed = { ...result.observed, bytes: shown.text, rev: shown.rev - revBefore, caret };
  const expect = cell.expectKind === "position" ? positionExpect(cell, caret, result, shown.text) : cell.expectKind === "same" ? start : want;
  if (expect && /visual line$/.test(cell.position?.move || "") && !caret.none && caret.inside) await visualLineEdge(page, start, caret, result, cell.position.move);
  if (!expect) {
    result.status = "FAIL";
    return result;
  }
  const collapsed = expect.anchor === expect.focus;
  const boundary = collapsed ? await page.boundary(expect.focus) : null;
  result.observed.boundary = boundary;
  if (shown.text !== expect.bytes) result.failed.push(`I1 bytes: wanted ${JSON.stringify(expect.bytes)}, got ${JSON.stringify(shown.text)}`);
  if (caret.none || !caret.inside) result.failed.push("I2 caret: no selection in the editor");
  else if (caret.focus !== expect.focus || caret.anchor !== expect.anchor) result.failed.push(`I2 caret: wanted ${range(expect.anchor, expect.focus)}, got ${range(caret.anchor, caret.focus)} at ${caret.focusPath || "the editor root"}`);
  if (collapsed) {
    if (!boundary) result.failed.push(`I3 drawn: offset ${expect.focus} has no drawn boundary`);
    else if (caret.unpainted) result.unchecked.push("I3: where this browser paints the caret is not in its screenshots");
    else if (caret.rect) {
      const middle = (caret.rect.top + caret.rect.bottom) / 2;
      const on = (spot) => Math.abs(caret.rect.x - spot.x) <= 2 && middle >= spot.top && middle <= spot.bottom;
      if (!on(boundary) && !(boundary.alt && on(boundary.alt))) {
        result.failed.push(`I3 drawn: caret at x ${caret.rect.x.toFixed(1)} y ${middle.toFixed(1)}${caret.fallback ? " (fallback)" : ""}, boundary at x ${boundary.x.toFixed(1)} y ${boundary.top.toFixed(1)}-${boundary.bottom.toFixed(1)}`);
      }
    } else result.failed.push("I3 drawn: the caret has no rect");
  }
  const [low, high] = editRange(cell);
  const moved = shown.rev - revBefore;
  if (moved < low || moved > high) result.failed.push(`I5 rev: wanted +${low === high ? low : `${low} to ${high}`}, got +${moved}`);
  if (!caret.focused) result.failed.push("focus: the editor does not have focus");
  if (route === "scrolled" && caret.rect) {
    const height = await page.eval("innerHeight");
    if (caret.rect.top < 0 || caret.rect.bottom > height) result.failed.push(`I10 view: the caret is drawn at y ${caret.rect.top.toFixed(1)}, outside the viewport`);
  }
  // A cell that wants a holder's label to flash wants the 409 naming that holder (D26).
  const refusedBy = new Set(cell.flashes.map((flash) => flash.name));
  // A cell that takes the page offline makes the page's own reconnect attempts fail while it is
  // off. Firefox logs each of those as an error, and how many fall inside that window depends on
  // timing, so they are not counted. Any other error still is.
  const offline = cell.keys.some((token) => token.key === "offline");
  const expected = (frame) => offline && frame.dir === "exception" && /establish a connection to the server at ws:\/\/127\.0\.0\.1:\d+\/api\/ws/.test(String(frame.data));
  const errors = page.frames.filter((frame) => !expected(frame) && (frame.dir === "exception" || (frame.dir === "in" && frame.data && frame.data.type === "error" && !(frame.data.status === 409 && refusedBy.has(frame.data.heldBy)))));
  if (errors.length) result.failed.push(`I7 quiet: ${errors.map((frame) => JSON.stringify(frame.data)).join(", ")}`);
  for (const flash of cell.flashes) {
    const flashed = await page.eval(`window.__qa.flashes.some((seen) => seen.name.includes(${JSON.stringify(flash.name)}) && seen.block.includes(${JSON.stringify(flash.text)}))`);
    if (!flashed) result.failed.push(`A flash: wanted the name ${flash.name} to flash on ${JSON.stringify(flash.text)}, got none`);
  }
  if (usesOther(cell)) {
    const other = await suite.other();
    if (cell.other) {
      const otherCaret = other.caret();
      const otherSent = { text: other.text() };
      if (otherSent.text !== cell.other.bytes) result.failed.push(`B bytes: wanted ${JSON.stringify(cell.other.bytes)}, got ${JSON.stringify(otherSent.text)}`);
      if (otherCaret.none || !otherCaret.inside) result.failed.push("B caret: no selection in B's editor");
      else if (otherCaret.focus !== cell.other.focus || otherCaret.anchor !== cell.other.anchor) result.failed.push(`B caret: wanted ${range(cell.other.anchor, cell.other.focus)}, got ${range(otherCaret.anchor, otherCaret.focus)} at ${otherCaret.focusPath || "the editor root"}`);
    }
    for (const label of cell.labels) {
      const shownLabel = other.holds(label.name, label.text);
      if (shownLabel !== label.shown) result.failed.push(`B label: wanted ${label.shown ? "" : "no "}${label.name} on ${JSON.stringify(label.text)}, got ${shownLabel ? "it" : "none"}`);
    }
  }
  // I9: where does the next keystroke land?
  const beforeProbe = await page.caret();
  const textBeforeProbe = sent(page, file).text;
  // The glyph before the caret, to tell a word the Q carries onto the next visual line from a
  // caret drawn on the wrong line.
  const leadBefore = beforeProbe.none || !beforeProbe.inside || beforeProbe.focus < 1 ? null : await page.eval(`window.__qaGlyph(${beforeProbe.focus - 1})`);
  // The glyph after the caret, to tell a caret at the end of a line that wraps.
  const followBefore = beforeProbe.none || !beforeProbe.inside ? null : await page.eval(`window.__qaGlyph(${beforeProbe.focus})`);
  await page.key("Q");
  await page.quiet();
  const probed = sent(page, file);
  // I12: the typed character is drawn where the caret was drawn when the key was pressed (R99).
  // On an empty line the caret sits on the line's br, and the line's own box is where it is drawn.
  const drawnCaret = beforeProbe.rect && (!beforeProbe.fallback || beforeProbe.emptyLine || beforeProbe.painted || /> br:\d+$/.test(beforeProbe.focusPath || ""));
  if (beforeProbe.unpainted) result.unchecked.push("I12: where this browser paints the caret is not in its screenshots");
  else if (!beforeProbe.none && beforeProbe.inside && beforeProbe.anchor === beforeProbe.focus && drawnCaret) {
    let at = 0;
    while (at < textBeforeProbe.length && textBeforeProbe[at] === probed.text[at]) at += 1;
    // R11 can write a newline before the Q, so the Q is the first one at or past the change.
    const grown = probed.text.length - textBeforeProbe.length;
    while (grown > 1 && at < probed.text.length && probed.text[at] !== "Q") at += 1;
    if (grown >= 1 && grown <= 3 && probed.text[at] === "Q") {
      const glyph = await page.eval(`window.__qaGlyph(${at})`);
      const caret = beforeProbe.rect;
      // Bidirectional text places a typed letter by its own rules, not at the caret.
      const lineStart = textBeforeProbe.lastIndexOf("\n", at - 1) + 1;
      const lineEnd = textBeforeProbe.indexOf("\n", at) < 0 ? textBeforeProbe.length : textBeforeProbe.indexOf("\n", at);
      const bidi = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/.test(textBeforeProbe.slice(lineStart, lineEnd));
      if (!bidi && !glyph) result.failed.push(`I12 typed: the Q at offset ${at} is not drawn`);
      else if (!bidi) {
        const middle = (glyph.top + glyph.bottom) / 2;
        const sameLine = middle >= caret.top - 2 && middle <= caret.bottom + 2;
        // A Q typed at the end of a word that just fits takes the word to the next visual line.
        // The letter is still right after the glyph the caret followed.
        const lead = at === beforeProbe.focus && at > 0 && /\S/.test(textBeforeProbe[at - 1]) ? await page.eval(`window.__qaGlyph(${at - 1})`) : null;
        const carried = leadBefore && lead && Math.abs((lead.top + lead.bottom) / 2 - (leadBefore.top + leadBefore.bottom) / 2) > 2
          && Math.abs(glyph.left - lead.right) <= 3 && Math.abs(middle - (lead.top + lead.bottom) / 2) <= 2;
        // A caret drawn at the end of a visual line, with the next character starting the line
        // below, is at a wrap. Under the owner's rule on ticket pg66fa4a, a letter typed there goes
        // in at the caret and wraps as normal text does, so the Q may start the line below, right
        // before the glyph that followed the caret.
        const atWrap = at === beforeProbe.focus && at > 0 && textBeforeProbe[at - 1] !== "\n" && /\S/.test(textBeforeProbe[at] || "")
          && followBefore && (followBefore.top + followBefore.bottom) / 2 > caret.bottom + 2;
        const follow = atWrap ? await page.eval(`window.__qaGlyph(${at + 1})`) : null;
        const wrapped = follow && middle > caret.bottom && Math.abs(glyph.right - follow.left) <= 3 && Math.abs(middle - (follow.top + follow.bottom) / 2) <= 2;
        if ((!sameLine || Math.abs(glyph.left - caret.x) > 3) && !carried && !wrapped) result.failed.push(`I12 typed: the Q is drawn at x ${glyph.left.toFixed(1)} y ${middle.toFixed(1)}, but the caret was drawn at x ${caret.x.toFixed(1)} y ${((caret.top + caret.bottom) / 2).toFixed(1)}`);
      }
    }
  }
  const wanted = withProbe(expect, "Q");
  if (probed.text !== wanted) result.failed.push(`I9 probe: Q wanted ${JSON.stringify(wanted)}, got ${JSON.stringify(probed.text)}`);
  else {
    await page.key("Backspace");
    await page.quiet();
    const back = sent(page, file);
    const restored = probeAfterBackspace(expect);
    if (back.text !== restored) result.failed.push(`I9 probe: Backspace after Q wanted ${JSON.stringify(restored)}, got ${JSON.stringify(back.text)}`);
  }
  const held = await hub.show(file);
  const last = sent(page, file);
  if (held.text !== last.text) result.failed.push(`I1 bytes: the hub holds ${JSON.stringify(held.text)}, but last sent the page ${JSON.stringify(last.text)}`);
  const broken = brokenComment(held.text);
  if (broken) result.failed.push(`I13 comments: ${broken} in ${JSON.stringify(held.text)}`);
  result.observed.sent = page.frames.filter((frame) => frame.dir === "out" && frame.data && frame.data.type !== "lock").map((frame) => frame.data);
  if (result.failed.length) {
    result.status = "FAIL";
    result.observed.html = await page.eval("window.__qaRoot().outerHTML");
    // What else happened to the page while the cell ran, so a failure says whether the page's
    // socket dropped or the page started over, not only what came out wrong.
    const hellos = page.frames.filter((frame) => frame.dir === "in" && frame.data && frame.data.type === "hello").length;
    const closes = page.frames.filter((frame) => frame.dir === "exception" && /connection|WebSocket/i.test(String(frame.data))).length;
    // The cell's own open is one hello. Each one after it is the page reconnecting.
    if (hellos > 1 || closes > 0) result.failed.push(`diag: the page reconnected ${Math.max(0, hellos - 1)} time(s) during the cell, and ${closes} connection error(s) were logged`);
    // Which keys reached the page, and how many edits it sent, so a lost key shows whether the
    // browser never delivered it or the page dropped it.
    const seen = await page.eval(`(window.__qa.log || []).filter((e) => e.type === "keydown").map((e) => e.key)`).catch(() => null);
    const edits = page.frames.filter((frame) => frame.dir === "out" && frame.data && frame.data.type === "edit").length;
    result.failed.push(`diag: the page saw keydown for ${JSON.stringify(seen)}, and sent ${edits} edit(s)`);
  }
  return result;
}
