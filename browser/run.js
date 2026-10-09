// Runs one cell by one route and checks the invariants of qa/editor-matrix-test-plan.md.

const PHANTOM = (bytes, offset) => offset === bytes.length && bytes.endsWith("\n");

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

export function routesFor(cell) {
  if (cell.routes.length) return cell.routes.map((route) => ({ "↓": "down", "↑": "up" })[route] || route);
  if (!cell.id.startsWith("BG.")) return ["click"];
  const { bytes, focus } = cell.source;
  const routes = ["click"];
  if (lineStart(bytes, focus) > 0) routes.push("down");
  if (lineEnd(bytes, focus) < bytes.length) routes.push("up");
  routes.push("emptied");
  return routes;
}

async function clickAt(page, bytes, offset) {
  if (PHANTOM(bytes, offset)) {
    await page.clickBelow();
    return;
  }
  if (await page.clickOffset(offset)) return;
  // The boundary is hidden while its block is rendered: click the block so its source is drawn.
  // A rendered block may tag only part of its source (a fence tags its body, not its fence
  // lines), so take the first block whose tagged range reaches the offset.
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
  if (block) {
    await page.click(block.x, block.y);
    await page.quiet();
  }
  if (!(await page.clickOffset(offset))) throw new Error(`no drawn boundary for offset ${offset}`);
}

async function firstDrawn(page, from, to) {
  return page.eval(`(() => {
    for (let at = ${from}; at <= ${to}; at += 1) if (window.__qaGlyph(at) || window.__qaEmptyLine(at)) return at;
    return null;
  })()`);
}

async function place(page, cell, route) {
  const { bytes, focus } = cell.source;
  if (route === "click") {
    await clickAt(page, bytes, focus);
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
  } else {
    throw new Error(`route ${route} is not automated yet`);
  }
  await page.quiet();
}

function withProbe(marked, letter) {
  const { bytes, focus, anchor } = marked;
  const from = Math.min(focus, anchor);
  const to = Math.max(focus, anchor);
  return bytes.slice(0, from) + letter + bytes.slice(to);
}

export async function runCell({ hub, page }, cell, route, serial) {
  const result = { id: cell.id, route, status: "PASS", failed: [], observed: {} };
  const file = `${cell.id}--${route}--${serial}.md`.replace(/[^A-Za-z0-9.-]/g, "_");
  const bytes = cell.source.bytes;
  cell.routeBytes = route === "emptied" ? bytes.slice(0, cell.source.focus) + "x" + bytes.slice(cell.source.focus) : bytes;
  await hub.create(file, cell.routeBytes);
  page.frames.length = 0;
  await page.open(file);
  try {
    await place(page, cell, route);
  } catch (err) {
    return { ...result, status: "BLOCKED", routeFailed: true, failed: [`placement: ${err.message}`] };
  }
  const placed = await hub.show(file);
  const at = await page.caret();
  result.observed.placed = { bytes: placed.text, caret: at };
  if (placed.text !== bytes || at.none || at.focus !== cell.source.focus || at.anchor !== cell.source.anchor) {
    // The route failed. Press the keys anyway and record what a person would see.
    for (const key of cell.keys) {
      if (key.text != null) await page.type(key.text);
      else await page.key(parseKey(key.key).name, parseKey(key.key).modifiers);
      await page.quiet();
    }
    const seen = await hub.show(file);
    result.observed.afterKeys = { bytes: seen.text, caret: await page.caret() };
    return { ...result, status: "BLOCKED", routeFailed: true, failed: [`placement: wanted ${cell.source.focus}, got ${at.none ? "no selection" : `${at.anchor}..${at.focus} at ${at.focusPath || "the editor root"}`}${placed.text !== bytes ? `, bytes ${JSON.stringify(placed.text)}` : ""}; the keys then gave ${JSON.stringify(seen.text)}`] };
  }
  const before = placed.rev;
  for (const key of cell.keys) {
    if (key.text != null) await page.type(key.text);
    else {
      const { name, modifiers } = parseKey(key.key);
      await page.key(name, modifiers);
    }
    await page.quiet();
  }
  const shown = await hub.show(file);
  const caret = await page.caret();
  const expect = cell.expect;
  const boundary = expect ? await page.boundary(expect.focus) : null;
  result.observed = { ...result.observed, bytes: shown.text, rev: shown.rev - before, caret, boundary };
  if (expect) {
    if (shown.text !== expect.bytes) result.failed.push(`I1 bytes: wanted ${JSON.stringify(expect.bytes)}, got ${JSON.stringify(shown.text)}`);
    if (caret.none || !caret.inside) result.failed.push("I2 caret: no selection in the editor");
    else if (caret.focus !== expect.focus || caret.anchor !== expect.anchor) result.failed.push(`I2 caret: wanted ${expect.anchor === expect.focus ? expect.focus : `${expect.anchor}..${expect.focus}`}, got ${caret.anchor === caret.focus ? caret.focus : `${caret.anchor}..${caret.focus}`} at ${caret.focusPath}`);
    if (!boundary) result.failed.push(`I3 drawn: offset ${expect.focus} has no drawn boundary`);
    else if (caret.rect) {
      const middle = (caret.rect.top + caret.rect.bottom) / 2;
      if (Math.abs(caret.rect.x - boundary.x) > 2 || middle < boundary.top || middle > boundary.bottom) {
        result.failed.push(`I3 drawn: caret at x ${caret.rect.x.toFixed(1)} y ${middle.toFixed(1)}${caret.fallback ? " (fallback)" : ""}, boundary at x ${boundary.x.toFixed(1)} y ${boundary.top.toFixed(1)}-${boundary.bottom.toFixed(1)}`);
      }
    } else result.failed.push("I3 drawn: the caret has no rect");
    const edits = cell.expectKind === "same" ? 0 : cell.keys.length;
    if (shown.rev - before !== edits) result.failed.push(`I5 rev: wanted +${edits}, got +${shown.rev - before}`);
    if (!caret.focused) result.failed.push("focus: the editor does not have focus");
  }
  const errors = page.frames.filter((frame) => frame.dir === "exception" || (frame.dir === "in" && frame.data && frame.data.type === "error"));
  if (errors.length) result.failed.push(`I7 quiet: ${errors.map((frame) => JSON.stringify(frame.data)).join(", ")}`);
  // I9: where does the next keystroke land?
  if (expect && expect.focus != null) {
    await page.key("Q");
    await page.quiet();
    const probed = await hub.show(file);
    const wanted = withProbe(expect, "Q");
    if (probed.text !== wanted) result.failed.push(`I9 probe: Q wanted ${JSON.stringify(wanted)}, got ${JSON.stringify(probed.text)}`);
    await page.key("Backspace");
    await page.quiet();
    const back = await hub.show(file);
    const restored = withProbe(expect, "");
    if (back.text !== restored) result.failed.push(`I9 probe: Backspace after Q wanted ${JSON.stringify(restored)}, got ${JSON.stringify(back.text)}`);
  }
  result.observed.sent = page.frames.filter((frame) => frame.dir === "out" && frame.data && frame.data.type !== "lock").map((frame) => frame.data);
  if (result.failed.length) result.status = "FAIL";
  return result;
}
