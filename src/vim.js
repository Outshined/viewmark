// Pure key match. The page applies the effect. This module does not touch the editor.
import { endBeforeTail, lineCaret, lockSpans, plan, skipHidden, sourceLine, wordStop } from "./doc.js";

const REPEAT_CAP = 10000;
const PAGE = 20;
const HALF = 10;

const MOTIONS = new Set([
  "h", "l", "j", "k", "w", "W", "b", "B", "e", "E", "0", "^", "$", "+", "-", "_", "|",
  "%", "{", "}", "G", "H", "M", "L", ";", ",", "enter", "gg", "gj", "gk", "g0", "g^", "g$",
  "ge", "gE", "ctrl-f", "ctrl-b", "ctrl-d", "ctrl-u",
]);

const OPERATORS = new Set(["d", "c", "y", ">", "<", "=", "gu", "gU", "g~"]);

function emptyInput() {
  return { prefixRepeat: "", operator: null, motionRepeat: "", motion: null, keyBuffer: "" };
}

function cloneVim(vim) {
  const src = vim || {};
  const input = src.input || {};
  return {
    mode: src.mode || "normal",
    input: {
      prefixRepeat: input.prefixRepeat || "",
      operator: input.operator || null,
      motionRepeat: input.motionRepeat || "",
      motion: null,
      keyBuffer: input.keyBuffer || "",
    },
    register: {
      text: src.register && typeof src.register.text === "string" ? src.register.text : "",
      linewise: !!(src.register && src.register.linewise),
    },
    search: src.search ? { pattern: src.search.pattern, forward: src.search.forward !== false } : null,
    find: src.find ? { ch: src.find.ch, forward: src.find.forward !== false, till: src.find.till === true } : null,
    column: Number.isInteger(src.column) ? src.column : null,
    once: src.once === true,
  };
}

function pack(match, consumed, vim, effect) {
  return { match, consumed, vim, effect: effect || null };
}

function normKey(key) {
  if (typeof key === "string") return { key, ctrl: false, meta: false, alt: false, shift: false };
  const src = key || {};
  return {
    key: typeof src.key === "string" ? src.key : "",
    ctrl: src.ctrl === true,
    meta: src.meta === true,
    alt: src.alt === true,
    shift: src.shift === true,
  };
}

function clamp(offset, length) {
  const n = Number.isFinite(offset) ? Math.trunc(offset) : 0;
  if (n < 0) return 0;
  if (n > length) return length;
  return n;
}

function clearInput(vim) {
  return { ...vim, input: emptyInput() };
}

function repeatOf(vim) {
  const prefix = vim.input.prefixRepeat;
  const motion = vim.input.motionRepeat;
  let n = 1;
  if (prefix !== "" && motion !== "") n = Number(prefix) * Number(motion);
  else if (prefix !== "") n = Number(prefix);
  else if (motion !== "") n = Number(motion);
  if (!Number.isFinite(n) || n < 1) n = 1;
  if (n > REPEAT_CAP) n = REPEAT_CAP;
  return n;
}

function typedCount(vim) {
  if (vim.input.prefixRepeat === "" && vim.input.motionRepeat === "") return null;
  return repeatOf(vim);
}

function commitDigits(vim) {
  if (!/^\d+$/.test(vim.input.keyBuffer)) return vim;
  const input = { ...vim.input, keyBuffer: "" };
  if (input.operator) input.motionRepeat = vim.input.keyBuffer;
  else input.prefixRepeat = vim.input.keyBuffer;
  return { ...vim, input };
}

function isEscape(key) {
  if (key.key === "Escape" && !key.ctrl && !key.meta) return true;
  if (key.ctrl && (key.key === "[" || key.key === "Escape")) return true;
  return false;
}

function pageChord(key) {
  if (!key.ctrl && !key.meta) return false;
  const id = key.key.length === 1 ? key.key.toLowerCase() : key.key;
  if (id === "w") return false;
  return id === "a" || id === "c" || id === "v" || id === "x" || id === "y" || id === "z";
}

function countDigit(key, vim) {
  if (key.ctrl || key.meta || key.alt) return false;
  if (!/^[0-9]$/.test(key.key)) return false;
  const buffer = vim.input.keyBuffer;
  if (buffer !== "" && !/^\d+$/.test(buffer)) return false;
  if (key.key === "0" && !/^[1-9]\d*$/.test(buffer)) return false;
  return true;
}

function unitLen(doc, index) {
  if (index < 0 || index >= doc.length) return 1;
  const cu = doc.charCodeAt(index);
  if (cu >= 0xD800 && cu <= 0xDBFF && index + 1 < doc.length) {
    const low = doc.charCodeAt(index + 1);
    if (low >= 0xDC00 && low <= 0xDFFF) return 2;
  }
  return 1;
}

function rawLines(doc) {
  const lines = [];
  let start = 0;
  for (let i = 0; i <= doc.length; i += 1) {
    if (i === doc.length || doc[i] === "\n") {
      lines.push({ start, end: i });
      start = i + 1;
      if (i === doc.length) break;
    }
  }
  if (lines.length === 0) lines.push({ start: 0, end: 0 });
  return lines;
}

function renderedLines(doc, cursor) {
  const blocks = plan(doc, cursor).blocks;
  const lines = [];
  for (const block of blocks) {
    if (block.classes && block.classes.includes("md-paragraph-gap")) continue;
    if (typeof block.start !== "number" || typeof block.end !== "number") continue;
    lines.push({ start: block.start, end: block.end });
  }
  if (lines.length === 0) lines.push({ start: 0, end: Math.min(doc.length, 0) });
  return lines;
}

function vimLines(doc, cursor, raw) {
  return raw ? rawLines(doc) : renderedLines(doc, cursor);
}

// A rendered caret past the last block is the empty row after a final newline.
// j does not step onto that row. k from it returns to the last block.
function lineIndex(lines, doc, cursor, raw) {
  for (let i = 0; i < lines.length; i += 1) {
    if (cursor >= lines[i].start && cursor <= lines[i].end) return i;
  }
  if (!raw && doc.endsWith("\n") && cursor >= doc.length) return lines.length;
  return lines.length ? lines.length - 1 : 0;
}

function stepLine(index, delta, count, length) {
  let at = index;
  const steps = count < 1 ? 1 : count;
  for (let n = 0; n < steps; n += 1) {
    if (at >= length) {
      if (delta < 0 && length > 0) at = length - 1;
      else break;
      continue;
    }
    const next = at + delta;
    if (next < 0 || next >= length) break;
    at = next;
  }
  return at;
}

function lineDollar(doc, line) {
  let end = line.end;
  if (end > line.start && doc[end - 1] === "\r" && end < doc.length && doc[end] === "\n") end -= 1;
  return endBeforeTail(doc, end);
}

// $ is the vim line's end. A hard break inside that line stops on the tail's edge.
function dollarOffset(doc, cursor, raw) {
  const line = lineBounds(doc, cursor, raw);
  const src = sourceLine(doc, cursor);
  const tail = endBeforeTail(doc, src.end);
  if (tail < src.end && tail >= line.start && tail <= line.end) return legal(doc, tail, 1, raw);
  return legal(doc, lineDollar(doc, line), 1, raw);
}

function hiddenEdge(doc, offset, direction, raw) {
  const dir = direction < 0 ? "backward" : "forward";
  let at = clamp(offset, doc.length);
  for (let i = 0; i < 6; i += 1) {
    const next = skipHidden(doc, at, dir, { gap: !raw });
    if (next === at) break;
    at = next;
  }
  return at;
}

function placeColumn(doc, line, column, raw, direction) {
  const limit = lineDollar(doc, line);
  let offset = line.start + (column < 0 ? 0 : column);
  if (offset > limit) offset = limit;
  if (offset < line.start) offset = line.start;
  offset = lineCaret(doc, offset);
  offset = endBeforeTail(doc, offset);
  const edged = hiddenEdge(doc, offset, direction, raw);
  if (edged >= line.start && edged <= limit) return edged;
  const back = hiddenEdge(doc, offset, -1, raw);
  if (back >= line.start && back <= limit) return back;
  const fwd = hiddenEdge(doc, offset, 1, raw);
  if (fwd >= line.start && fwd <= limit) return fwd;
  if (offset < line.start) return line.start;
  if (offset > limit) return limit;
  return offset;
}

function legal(doc, offset, direction, raw) {
  let at = endBeforeTail(doc, clamp(offset, doc.length));
  at = hiddenEdge(doc, at, direction, raw);
  return at;
}

function firstNonBlank(doc, line, raw) {
  let index = line.start;
  while (index < line.end && (doc[index] === " " || doc[index] === "\t")) index += 1;
  if (index >= line.end) return legal(doc, line.start, 1, raw);
  return legal(doc, index, 1, raw);
}

function columnOf(doc, cursor, raw) {
  const lines = vimLines(doc, cursor, raw);
  const index = lineIndex(lines, doc, cursor, raw);
  if (index >= lines.length) return 0;
  return cursor - lines[index].start;
}

function moveVertical(doc, cursor, delta, count, raw, column) {
  const lines = vimLines(doc, cursor, raw);
  const index = lineIndex(lines, doc, cursor, raw);
  const col = column == null ? columnOf(doc, cursor, raw) : column;
  const next = stepLine(index, delta, count, lines.length);
  if (next === index || next >= lines.length) return { cursor, column: col, linewise: true };
  const landed = placeColumn(doc, lines[next], col, raw, delta);
  return { cursor: landed, column: col, linewise: true };
}

function words(doc) {
  const found = [];
  let index = 0;
  while (index < doc.length) {
    if (/\s/.test(doc[index])) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < doc.length && !/\s/.test(doc[index])) index += 1;
    found.push({ start, end: index });
  }
  return found;
}

function moveEnd(doc, cursor, count, forward) {
  const list = words(doc);
  let at = cursor;
  for (let n = 0; n < count; n += 1) {
    let land = null;
    if (forward) {
      for (const word of list) {
        if (word.end - 1 > at) {
          land = word.end - 1;
          break;
        }
      }
    } else {
      for (let i = list.length - 1; i >= 0; i -= 1) {
        if (list[i].end - 1 < at) {
          land = list[i].end - 1;
          break;
        }
      }
    }
    if (land == null) break;
    at = land;
  }
  return at;
}

function moveWord(doc, cursor, count, forward) {
  let at = cursor;
  const dir = forward ? 1 : -1;
  for (let n = 0; n < count; n += 1) {
    const next = wordStop(doc, at, dir);
    if (next === at) break;
    at = next;
  }
  return at;
}

function screenColumn(doc, line, column) {
  const target = Math.max(0, column - 1);
  let col = 0;
  let index = line.start;
  const limit = lineDollar(doc, line);
  while (index < line.end && index < doc.length && index < limit) {
    if (col >= target) return index;
    const width = doc[index] === "\t" ? 4 - (col % 4) : 1;
    if (col + width > target) return index;
    col += width;
    index += 1;
  }
  return limit;
}

function markerChar(doc, index) {
  if (index < 0 || index >= doc.length) return false;
  const forward = skipHidden(doc, index, "forward", { gap: false });
  const back = skipHidden(doc, index, "backward", { gap: false });
  return forward !== index || back !== index;
}

function findHit(doc, line, from, ch, forward) {
  if (forward) {
    for (let i = from; i + ch.length <= line.end; i += 1) {
      if (doc.startsWith(ch, i) && !markerChar(doc, i)) return i;
    }
    return null;
  }
  for (let i = from; i >= line.start; i -= 1) {
    if (doc.startsWith(ch, i) && !markerChar(doc, i)) return i;
  }
  return null;
}

function nextUnit(doc, index, bound) {
  const at = index + unitLen(doc, index);
  return at > bound ? bound : at;
}

function prevUnit(doc, index, bound) {
  if (index <= bound) return bound;
  let at = index - 1;
  if (at > bound) {
    const low = doc.charCodeAt(at);
    const high = doc.charCodeAt(at - 1);
    if (low >= 0xDC00 && low <= 0xDFFF && high >= 0xD800 && high <= 0xDBFF) at -= 1;
  }
  if (doc[at] === "\n" && at > bound && doc[at - 1] === "\r") at -= 1;
  return at;
}

// f starts on the next unit. A repeat of t skips the target already in front of the caret.
function searchFrom(doc, line, cursor, ch, forward, till, repeat) {
  if (forward) {
    if (repeat && till) {
      const skip = findHit(doc, line, cursor, ch, true);
      return skip == null ? line.end : skip + ch.length;
    }
    if (repeat && doc.startsWith(ch, cursor)) return cursor + ch.length;
    return cursor >= line.end ? line.end : nextUnit(doc, cursor, line.end);
  }
  if (repeat && till) {
    const skip = findHit(doc, line, cursor - 1, ch, false);
    return skip == null ? line.start - 1 : skip - 1;
  }
  if (repeat && cursor > line.start && doc.startsWith(ch, cursor - ch.length)) return cursor - ch.length - 1;
  return cursor - 1;
}

function findChar(doc, cursor, ch, forward, till, count, repeat) {
  const line = sourceLine(doc, cursor);
  let from = searchFrom(doc, line, cursor, ch, forward, till, repeat);
  let hit = null;
  for (let n = 0; n < count; n += 1) {
    hit = findHit(doc, line, from, ch, forward);
    if (hit == null) return null;
    from = forward ? hit + ch.length : hit - 1;
  }
  let land = hit;
  if (till) land = forward ? prevUnit(doc, hit, line.start) : Math.min(line.end, hit + ch.length);
  land = legal(doc, land, forward ? 1 : -1, false);
  if (land < line.start) land = line.start;
  if (land > line.end) land = line.end;
  return land;
}

function matchBracket(doc, cursor) {
  const open = { "(": ")", "[": "]", "{": "}" };
  const close = { ")": "(", "]": "[", "}": "{" };
  let pos = null;
  if (cursor > 0 && (open[doc[cursor - 1]] || close[doc[cursor - 1]])) pos = cursor - 1;
  else if (cursor < doc.length && (open[doc[cursor]] || close[doc[cursor]])) pos = cursor;
  else {
    for (let i = cursor; i < doc.length; i += 1) {
      if (open[doc[i]] || close[doc[i]]) {
        pos = i;
        break;
      }
    }
  }
  if (pos == null) return null;
  const ch = doc[pos];
  const forward = !!open[ch];
  const other = forward ? open[ch] : close[ch];
  let depth = 0;
  if (forward) {
    for (let i = pos; i < doc.length; i += 1) {
      if (doc[i] === ch) depth += 1;
      else if (doc[i] === other) {
        depth -= 1;
        if (depth === 0) return { offset: i, forward: true };
      }
    }
  } else {
    for (let i = pos; i >= 0; i -= 1) {
      if (doc[i] === ch) depth += 1;
      else if (doc[i] === other) {
        depth -= 1;
        if (depth === 0) return { offset: i, forward: false };
      }
    }
  }
  return null;
}

function gapSpan(doc, cursor, span) {
  const blocks = plan(doc, cursor).blocks;
  for (const block of blocks) {
    if (!block.classes || !block.classes.includes("md-paragraph-gap")) continue;
    if (span.start >= block.start && span.start <= block.end) return true;
  }
  return false;
}

function moveSection(doc, cursor, delta, count, raw) {
  const spans = lockSpans(doc).filter((span) => raw || !gapSpan(doc, cursor, span));
  let index = -1;
  for (let i = 0; i < spans.length; i += 1) {
    if (cursor >= spans[i].start && cursor <= spans[i].end) index = i;
  }
  if (index < 0) return cursor;
  let at = index;
  for (let n = 0; n < count; n += 1) {
    const next = at + delta;
    if (next < 0 || next >= spans.length) break;
    at = next;
  }
  if (at === index) return cursor;
  return legal(doc, spans[at].start, delta, raw);
}

function lineBounds(doc, offset, raw) {
  const lines = vimLines(doc, offset, raw);
  const index = lineIndex(lines, doc, offset, raw);
  if (index >= lines.length) return { start: doc.length, end: doc.length };
  return lines[index];
}

function endPast(doc, line) {
  if (line.end < doc.length && doc[line.end] === "\n") return line.end + 1;
  return line.end;
}

function runMotion(id, spec) {
  const { doc, cursor, raw, layout, count, column, find, anchor } = spec;
  const keep = column;
  if (id === "h" || id === "l") {
    return { kind: "view", command: id, repeat: count, column: null };
  }
  if (id === "gj" || id === "gk" || id === "g0" || id === "g^" || id === "g$") {
    if (layout) return { kind: "view", command: id, repeat: count, column: id === "gj" || id === "gk" ? keep : null };
    const plain = { gj: "j", gk: "k", g0: "0", "g^": "^", "g$": "$" }[id];
    return runMotion(plain, spec);
  }
  if (id === "H" || id === "M" || id === "L") {
    if (layout) return { kind: "view", command: id, repeat: count, column: null };
    return { kind: "stay" };
  }
  if (id === "ctrl-f" || id === "ctrl-b" || id === "ctrl-d" || id === "ctrl-u") {
    if (layout) return { kind: "view", command: id, repeat: count, column: keep };
    const size = id === "ctrl-f" || id === "ctrl-b" ? PAGE : HALF;
    const delta = id === "ctrl-f" || id === "ctrl-d" ? 1 : -1;
    const moved = moveVertical(doc, cursor, delta, size * count, raw, keep);
    return { kind: "caret", ...moved, inclusive: false, past: false, word: false };
  }
  if (id === "j" || id === "k") {
    const moved = moveVertical(doc, cursor, id === "j" ? 1 : -1, count, raw, keep);
    return { kind: "caret", ...moved, inclusive: false, past: false, word: false };
  }
  if (id === "+" || id === "-" || id === "enter") {
    const delta = id === "-" ? -1 : 1;
    const moved = moveVertical(doc, cursor, delta, count, raw, keep);
    const line = lineBounds(doc, moved.cursor, raw);
    const at = moved.cursor >= doc.length && line.start === doc.length
      ? doc.length
      : firstNonBlank(doc, line, raw);
    return { kind: "caret", cursor: at, column: null, linewise: true, inclusive: false, past: false, word: false };
  }
  if (id === "_") {
    const down = count - 1;
    const moved = down === 0
      ? { cursor }
      : moveVertical(doc, cursor, 1, down, raw, 0);
    const line = lineBounds(doc, moved.cursor, raw);
    const at = firstNonBlank(doc, line, raw);
    return { kind: "caret", cursor: at, column: null, linewise: true, inclusive: false, past: false, word: false };
  }
  if (id === "gg" || id === "G") {
    const lines = vimLines(doc, cursor, raw);
    const numbered = typedCount(spec.vim);
    if (numbered == null) {
      if (id === "gg") {
        const at = legal(doc, lines[0] ? lines[0].start : 0, 1, raw);
        return { kind: "caret", cursor: at, column: null, linewise: true, inclusive: false, past: false, word: false };
      }
      const at = doc.endsWith("\n") ? doc.length : lineDollar(doc, lines[lines.length - 1]);
      return { kind: "caret", cursor: legal(doc, at, -1, raw), column: null, linewise: true, inclusive: false, past: false, word: false };
    }
    const index = Math.max(0, Math.min(lines.length - 1, numbered - 1));
    const moved = placeColumn(doc, lines[index], keep == null ? columnOf(doc, cursor, raw) : keep, raw, 1);
    return { kind: "caret", cursor: moved, column: keep == null ? columnOf(doc, cursor, raw) : keep, linewise: true, inclusive: false, past: false, word: false };
  }
  if (id === "0") {
    const line = lineBounds(doc, cursor, raw);
    return { kind: "caret", cursor: legal(doc, line.start, 1, raw), column: null, linewise: false, inclusive: false, past: false, word: false };
  }
  if (id === "^") {
    const line = lineBounds(doc, cursor, raw);
    return { kind: "caret", cursor: firstNonBlank(doc, line, raw), column: null, linewise: false, inclusive: false, past: false, word: false };
  }
  if (id === "$") {
    return { kind: "caret", cursor: dollarOffset(doc, cursor, raw), column: null, linewise: false, inclusive: true, past: true, word: false };
  }
  if (id === "|") {
    const line = lineBounds(doc, cursor, raw);
    return { kind: "caret", cursor: screenColumn(doc, line, count), column: null, linewise: false, inclusive: false, past: false, word: false };
  }
  if (id === "w" || id === "W" || id === "b" || id === "B") {
    const forward = id === "w" || id === "W";
    const at = legal(doc, moveWord(doc, cursor, count, forward), forward ? 1 : -1, raw);
    return { kind: "caret", cursor: at, column: null, linewise: false, inclusive: false, past: false, word: true };
  }
  if (id === "e" || id === "E" || id === "ge" || id === "gE") {
    const forward = id === "e" || id === "E";
    const at = legal(doc, moveEnd(doc, cursor, count, forward), forward ? 1 : -1, raw);
    return { kind: "caret", cursor: at, column: null, linewise: false, inclusive: true, past: false, word: true };
  }
  if (id === "%" ) {
    const found = matchBracket(doc, cursor);
    if (!found) return { kind: "caret", cursor, column: null, linewise: false, inclusive: true, past: false, word: false, moved: false };
    let at = found.offset;
    if (markerChar(doc, at)) at = hiddenEdge(doc, at, found.forward ? 1 : -1, raw);
    else at = legal(doc, at, found.forward ? 1 : -1, raw);
    return { kind: "caret", cursor: at, column: null, linewise: false, inclusive: true, past: false, word: false };
  }
  if (id === "{" || id === "}") {
    const at = moveSection(doc, cursor, id === "}" ? 1 : -1, count, raw);
    return { kind: "caret", cursor: at, column: null, linewise: true, inclusive: false, past: false, word: false };
  }
  if (id === ";" || id === ",") {
    if (!find) return { kind: "stay" };
    const forward = id === ";" ? find.forward : !find.forward;
    const at = findChar(doc, cursor, find.ch, forward, find.till, count, true);
    if (at == null) return { kind: "stay" };
    return { kind: "caret", cursor: at, column: null, linewise: false, inclusive: !find.till, past: false, word: false, find };
  }
  if (id === "f" || id === "F" || id === "t" || id === "T") {
    const forward = id === "f" || id === "t";
    const till = id === "t" || id === "T";
    const at = findChar(doc, cursor, spec.ch, forward, till, count, false);
    const found = { ch: spec.ch, forward, till };
    if (at == null) return { kind: "stay", find: found };
    return { kind: "caret", cursor: at, column: null, linewise: false, inclusive: !till, past: false, word: false, find: found };
  }
  return { kind: "stay", anchor };
}

function linewiseRange(doc, fromOff, toOff, raw) {
  const origin = vimLines(doc, Math.min(fromOff, toOff), raw);
  const a = lineIndex(origin, doc, fromOff, raw);
  const b = lineIndex(origin, doc, toOff, raw);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const start = origin[Math.min(lo, origin.length - 1)].start;
  const last = hi >= origin.length ? origin[origin.length - 1] : origin[hi];
  return { from: start, to: endPast(doc, last) };
}

function countedLines(doc, origin, count, raw) {
  const lines = vimLines(doc, origin, raw);
  const index = Math.min(lineIndex(lines, doc, origin, raw), lines.length - 1);
  const last = Math.min(lines.length - 1, index + count - 1);
  return { from: lines[index].start, to: endPast(doc, lines[last]) };
}

function charRange(doc, origin, motion) {
  let from = origin;
  let to = motion.cursor;
  if (to < from) {
    const swap = from;
    from = to;
    to = swap;
  }
  if (motion.inclusive && !motion.past && motion.cursor > origin && to < doc.length) {
    to += unitLen(doc, to);
  }
  return { from, to };
}

function applyRange(op, doc, range, motion, vim) {
  let { from, to } = range;
  if (op === "c" && motion && motion.word && motion.cursor > range.from) {
    const chunk = doc.slice(from, to);
    if (/\S/.test(chunk)) {
      const spaces = /\s+$/.exec(chunk);
      if (spaces) to -= spaces[0].length;
    }
  }
  if (from === to) return null;
  const removed = doc.slice(from, to);
  const linewise = !!(motion && motion.linewise);
  if (op === "y") {
    const caret = motion && motion.cursor < (motion.origin == null ? from : motion.origin) ? from : motion && motion.cursor < from ? from : null;
    return {
      effect: {
        type: "splice",
        from,
        to,
        text: removed,
        caret: caret == null ? (motion && motion.cursor >= (range.originCaret || from) ? range.originCaret : from) : caret,
        yank: { text: removed, linewise },
      },
      register: { text: removed, linewise },
      mode: vim.mode,
    };
  }
  const caret = legal(doc, from, 1, false);
  if (op === "d") {
    return {
      effect: { type: "splice", from, to, text: "", caret, yank: { text: removed, linewise } },
      mode: vim.once ? "insert" : "normal",
    };
  }
  if (op === "c") {
    return {
      effect: { type: "splice", from, to, text: "", caret, yank: { text: removed, linewise } },
      mode: "insert",
    };
  }
  return null;
}

function finishMotion(vim, doc, anchor, cursor, raw, motion, operator) {
  const next = clearInput(vim);
  if (motion.find) next.find = motion.find;
  if (motion.column === null) next.column = null;
  else if (Number.isInteger(motion.column)) next.column = motion.column;
  if (motion.kind === "stay") {
    if (operator) next.input = emptyInput();
    return pack("full", true, next, null);
  }
  if (motion.kind === "view") {
    const effect = { type: "view-motion", command: motion.command, repeat: motion.repeat };
    if (operator) effect.operator = operator;
    return pack("full", true, operator ? clearInput(next) : next, effect);
  }
  if (motion.kind === "scroll") {
    return pack("full", true, next, motion.effect);
  }
  const at = motion.cursor;
  if (operator === "d" || operator === "c" || operator === "y") {
    const origin = cursor;
    let range;
    if (motion.linewise) range = linewiseRange(doc, origin, at, raw);
    else range = charRange(doc, origin, motion);
    range.originCaret = origin;
    const applied = applyRange(operator, doc, range, { ...motion, origin }, vim);
    if (!applied) return pack("full", true, next, null);
    next.mode = applied.mode;
    if (applied.register) next.register = applied.register;
    if (vim.once && operator !== "c") next.once = false;
    if (operator === "c") next.once = false;
    else if (vim.once) next.once = false;
    if (vim.once) next.mode = operator === "c" ? "insert" : "insert";
    return pack("full", true, next, applied.effect);
  }
  if (operator) return pack("full", true, next, null);
  if (vim.mode === "visual" || vim.mode === "visual-line") {
    return pack("full", true, leavingOnce(next, vim), { type: "caret", anchor, cursor: at });
  }
  return pack("full", true, leavingOnce(next, vim), { type: "caret", anchor: at, cursor: at });
}

function leavingOnce(vim, prior) {
  if (!prior.once) return vim;
  const next = { ...vim, once: false };
  if (next.mode === "normal") next.mode = "insert";
  return next;
}

function mapCase(text, mode) {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const unit = text[i];
    let mapped = unit;
    if (mode === "upper") mapped = unit.toUpperCase();
    else if (mode === "lower") mapped = unit.toLowerCase();
    else mapped = unit.toLowerCase() === unit ? unit.toUpperCase() : unit.toLowerCase();
    out += mapped.length === unit.length ? mapped : unit;
  }
  return out;
}

function operatorOf(id) {
  if (id === "gu" || id === "gU" || id === "g~") return id;
  if (OPERATORS.has(id)) return id;
  return null;
}

function doubled(operator, id) {
  if (!operator) return false;
  if (operator === "gu") return id === "u";
  if (operator === "gU") return id === "U";
  if (operator === "g~") return id === "~";
  return operator === id;
}

function caseOp(operator) {
  if (operator === "gu" || operator === "g~" || operator === "gU") return operator;
  return null;
}

function spliceCase(vim, doc, from, to, mode) {
  const removed = doc.slice(from, to);
  const text = mapCase(removed, mode === "gU" ? "upper" : mode === "gu" ? "lower" : "toggle");
  const next = clearInput(vim);
  next.once = false;
  if (vim.once) next.mode = "insert";
  return pack("full", true, next, {
    type: "splice",
    from,
    to,
    text,
    caret: from,
    yank: null,
  });
}

function dispatchResolved(vim, doc, anchor, cursor, raw, layout, id, extra) {
  const operator = vim.input.operator;
  if (operator && doubled(operator, id)) {
    const range = countedLines(doc, cursor, repeatOf(vim), raw);
    if (caseOp(operator)) return spliceCase(vim, doc, range.from, range.to, operator);
    const motion = { cursor: range.to, linewise: true, inclusive: false, past: false, word: false, origin: cursor };
    const applied = applyRange(operator, doc, { ...range, originCaret: cursor }, motion, vim);
    const next = clearInput(vim);
    if (!applied) return pack("full", true, next, null);
    next.mode = applied.mode;
    if (vim.once) {
      next.once = false;
      next.mode = operator === "c" ? "insert" : "insert";
    }
    if (applied.register) next.register = applied.register;
    return pack("full", true, next, applied.effect);
  }
  if (operator && operatorOf(id) && !doubled(operator, id)) return pack("none", true, clearInput(vim), null);
  if (!operator && operatorOf(id)) {
    const next = commitDigits(vim);
    next.input = { ...next.input, operator: operatorOf(id), keyBuffer: "", motion: null };
    return pack("full", true, next, null);
  }
  if (MOTIONS.has(id) || id === "f" || id === "F" || id === "t" || id === "T") {
    const motion = runMotion(id, {
      doc,
      cursor,
      anchor,
      raw,
      layout,
      count: repeatOf(vim),
      column: vim.column,
      find: vim.find,
      vim,
      ch: extra && extra.ch,
    });
    if (operator && (operator === "gu" || operator === "gU" || operator === "g~") && motion.kind === "caret") {
      const range = motion.linewise ? linewiseRange(doc, cursor, motion.cursor, raw) : charRange(doc, cursor, motion);
      if (range.from === range.to) return pack("full", true, clearInput(vim), null);
      return spliceCase(vim, doc, range.from, range.to, operator);
    }
    if (operator && !MOTIONS.has(id) && id !== "f" && id !== "F" && id !== "t" && id !== "T") {
      return pack("none", true, clearInput(vim), null);
    }
    if (operator && isActionId(id)) return pack("none", true, clearInput(vim), null);
    return finishMotion(vim, doc, anchor, cursor, raw, motion, operator);
  }
  if (operator && isActionId(id)) return pack("none", true, clearInput(vim), null);
  return runAction(vim, doc, anchor, cursor, raw, layout, id);
}

function isActionId(id) {
  return id === "x" || id === "X" || id === "v" || id === "V" || id === "u" || id === "ctrl-r"
    || id === "i" || id === "a" || id === "I" || id === "A" || id === "o" || id === "O"
    || id === "ctrl-w" || id === "." || id === "p" || id === "P" || id === "r" || id === "~"
    || id === "J" || id === "s" || id === "S" || id === "/" || id === "?" || id === "n" || id === "N"
    || id === "*" || id === "#" || id === ":";
}

function putRegister(vim, doc, cursor, raw, after) {
  const next = clearInput(vim);
  const reg = vim.register || { text: "", linewise: false };
  if (!reg.text) return pack("full", true, next, null);
  if (reg.linewise) {
    const line = lineBounds(doc, cursor, raw);
    const at = after ? endPast(doc, line) : line.start;
    let text = reg.text;
    if (!text.endsWith("\n")) text += "\n";
    let skip = 0;
    while (skip < text.length && (text[skip] === " " || text[skip] === "\t")) skip += 1;
    const caret = at + Math.min(skip, text.length);
    const kept = vim.mode === "visual" || vim.mode === "visual-line" ? "normal" : vim.mode;
    next.mode = kept;
    return pack("full", true, next, { type: "splice", from: at, to: at, text, caret, yank: null });
  }
  let at = cursor;
  if (after && at < doc.length) at += unitLen(doc, at);
  const caret = after ? at + Math.max(0, reg.text.length - unitLen(reg.text, Math.max(0, reg.text.length - 1))) : at;
  return pack("full", true, next, { type: "splice", from: at, to: at, text: reg.text, caret, yank: null });
}

function runAction(vim, doc, anchor, cursor, raw, layout, id) {
  const next = clearInput(vim);
  if (id === "x" || id === "X") {
    const n = repeatOf(vim);
    if (vim.mode === "visual" || vim.mode === "visual-line") {
      let from = Math.min(anchor, cursor);
      let to = Math.max(anchor, cursor);
      if (vim.mode === "visual-line") {
        const range = linewiseRange(doc, from, to, raw);
        from = range.from;
        to = range.to;
      }
      next.mode = vim.once ? "insert" : "normal";
      next.once = false;
      if (from === to) return pack("full", true, next, null);
      const removed = doc.slice(from, to);
      return pack("full", true, next, {
        type: "splice",
        from,
        to,
        text: "",
        caret: legal(doc, from, 1, raw),
        yank: { text: removed, linewise: vim.mode === "visual-line" },
      });
    }
    if (n <= 1) {
      return pack("full", true, leavingOnce(next, vim), { type: id === "x" ? "forward-delete" : "backspace" });
    }
    return pack("full", true, leavingOnce(next, vim), { type: "view-edit", command: id, repeat: n });
  }
  if (id === "v" || id === "V") {
    const line = id === "V";
    let mode = line ? "visual-line" : "visual";
    let nextAnchor = anchor;
    let nextCursor = cursor;
    if (vim.mode === "visual" && !line) {
      mode = "normal";
      nextAnchor = cursor;
    } else if (vim.mode === "visual-line" && line) {
      mode = "normal";
      nextAnchor = cursor;
    } else if (vim.mode === "visual" && line) mode = "visual-line";
    else if (vim.mode === "visual-line" && !line) mode = "visual";
    else nextAnchor = cursor;
    next.mode = mode;
    if (mode === "visual" || mode === "visual-line") next.once = vim.once;
    else if (vim.once) {
      next.once = false;
      next.mode = "insert";
    }
    return pack("full", true, next, { type: "caret", anchor: nextAnchor, cursor: nextCursor });
  }
  if (id === "u") {
    if (vim.mode === "visual" || vim.mode === "visual-line") {
      const from = Math.min(anchor, cursor);
      const to = Math.max(anchor, cursor);
      if (from === to) return pack("full", true, next, null);
      return spliceCase({ ...vim, once: false }, doc, from, to, "gu");
    }
    return pack("full", true, leavingOnce(next, vim), { type: "history", direction: "undo" });
  }
  if (id === "ctrl-r") {
    if (vim.mode === "visual" || vim.mode === "visual-line") return pack("none", true, clearInput(vim), null);
    return pack("full", true, leavingOnce(next, vim), { type: "history", direction: "redo" });
  }
  if (id === "ctrl-w") return pack("full", true, next, null);
  if (id === "p" || id === "P") return putRegister(vim, doc, cursor, raw, id === "p");
  if (id === ".") return pack("none", true, clearInput(vim), null);
  if (id === "i" || id === "a" || id === "I" || id === "A") {
    next.mode = "insert";
    next.once = false;
    if (id === "i") return pack("full", true, next, { type: "caret", anchor: cursor, cursor });
    if (id === "I" || id === "A") {
      const motion = runMotion(id === "I" ? "^" : "$", { doc, cursor, raw, layout, count: 1, column: null, find: null, vim: next });
      const at = motion.cursor;
      return pack("full", true, next, { type: "caret", anchor: at, cursor: at });
    }
    return pack("full", true, next, { type: "view-motion", command: "l", repeat: 1 });
  }
  if (id === "/" || id === "?") {
    return pack("full", true, next, { type: "prompt", kind: "search", forward: id === "/" });
  }
  if (id === ":") {
    if (vim.mode === "visual" || vim.mode === "visual-line") return pack("full", true, next, null);
    return pack("full", true, next, { type: "prompt", kind: "ex" });
  }
  if (id === "n" || id === "N" || id === "*" || id === "#") return pack("full", true, next, null);
  if ((vim.mode === "visual" || vim.mode === "visual-line") && (id === "o" || id === "O")) {
    return pack("full", true, vim.mode === "visual" || vim.mode === "visual-line" ? { ...next, mode: vim.mode, once: vim.once } : next, {
      type: "caret",
      anchor: cursor,
      cursor: anchor,
    });
  }
  return pack("none", true, clearInput(vim), null);
}

function commandFromKey(key) {
  if (key.ctrl || key.meta) {
    const id = key.key.length === 1 ? key.key.toLowerCase() : key.key;
    if (key.ctrl && id === "n") return { kind: "motion", id: "j" };
    if (key.ctrl && id === "p") return { kind: "motion", id: "k" };
    if (key.ctrl && id === "f") return { kind: "motion", id: "ctrl-f" };
    if (key.ctrl && id === "b") return { kind: "motion", id: "ctrl-b" };
    if (key.ctrl && id === "d") return { kind: "motion", id: "ctrl-d" };
    if (key.ctrl && id === "u") return { kind: "motion", id: "ctrl-u" };
    if (id === "w") return { kind: "action", id: "ctrl-w" };
    if (key.ctrl && key.key === "ArrowLeft") return { kind: "motion", id: "b" };
    if (key.ctrl && key.key === "ArrowRight") return { kind: "motion", id: "w" };
    if (key.ctrl && key.key === " ") return { kind: "motion", id: "W" };
    if (key.ctrl && key.key === "Backspace") return { kind: "motion", id: "B" };
    if (key.ctrl && id === "r") return { kind: "action", id: "ctrl-r" };
    if (key.ctrl && (id === "e" || id === "o" || id === "q" || id === "k")) return { kind: "none" };
    return { kind: "none" };
  }
  if (key.key === "ArrowLeft") return { kind: "motion", id: "h" };
  if (key.key === "ArrowRight") return { kind: "motion", id: "l" };
  if (key.key === "ArrowUp") return { kind: "motion", id: "k" };
  if (key.key === "ArrowDown") return { kind: "motion", id: "j" };
  if (key.key === "Home") return { kind: "motion", id: "0" };
  if (key.key === "End") return { kind: "motion", id: "$" };
  if (key.key === "PageUp") return { kind: "motion", id: "ctrl-b" };
  if (key.key === "PageDown") return { kind: "motion", id: "ctrl-f" };
  if (key.key === "Enter") return { kind: "motion", id: "enter" };
  if (key.key === " ") return { kind: "motion", id: key.shift ? "w" : "l" };
  if (key.key === "Backspace") return { kind: "motion", id: key.shift ? "b" : "h" };
  if (key.key === "Delete") return { kind: "action", id: "x" };
  if (key.key === "Insert") return { kind: "none" };
  const k = key.key;
  if (k.length !== 1) return { kind: "none" };
  if (MOTIONS.has(k)) return { kind: "motion", id: k };
  if (OPERATORS.has(k)) return { kind: "operator", id: k };
  if (isActionId(k)) return { kind: "action", id: k };
  if (k === "g" || k === "z" || k === "f" || k === "F" || k === "t" || k === "T" || k === '"') return { kind: "prefix", id: k };
  return { kind: "none" };
}

function finishFind(vim, doc, anchor, cursor, raw, layout, key) {
  if (isEscape(key)) return doEscape(vim, anchor, cursor);
  if (key.ctrl || key.meta || key.key.length < 1 || key.key.length > 2) return pack("none", true, clearInput(vim), null);
  const which = vim.input.keyBuffer;
  const ready = { ...vim, input: { ...vim.input, keyBuffer: "" } };
  return dispatchResolved(ready, doc, anchor, cursor, raw, layout, which, { ch: key.key });
}

function finishQuote(vim, anchor, cursor, key) {
  if (isEscape(key)) return doEscape(vim, anchor, cursor);
  if (key.key === '"' && !key.ctrl && !key.meta) {
    const next = clearInput(vim);
    next.input = emptyInput();
    return pack("full", true, next, null);
  }
  return pack("none", true, clearInput(vim), null);
}

function finishG(vim, doc, anchor, cursor, raw, layout, key) {
  if (isEscape(key)) return doEscape(vim, anchor, cursor);
  const id = key.key === "ArrowDown" || key.key === "j" ? "gj"
    : key.key === "ArrowUp" || key.key === "k" ? "gk"
      : key.key === "g" ? "gg"
        : key.key === "0" ? "g0"
          : key.key === "^" ? "g^"
            : key.key === "$" ? "g$"
              : key.key === "e" ? "ge"
                : key.key === "E" ? "gE"
                  : key.key === "u" ? "gu"
                    : key.key === "U" ? "gU"
                      : key.key === "~" ? "g~"
                        : key.key === "I" ? "gI"
                          : null;
  const ready = { ...vim, input: { ...vim.input, keyBuffer: "" } };
  if (id === "gu" || id === "gU" || id === "g~") {
    if (ready.input.operator && !doubled(ready.input.operator, id === "gu" ? "u" : id === "gU" ? "U" : "~")) {
      return pack("none", true, clearInput(vim), null);
    }
    return dispatchResolved(ready, doc, anchor, cursor, raw, layout, id, null);
  }
  if (id === "gI") {
    if (ready.input.operator) return pack("none", true, clearInput(vim), null);
    const motion = runMotion("0", { doc, cursor, raw, layout, count: 1, column: null, find: null, vim: ready });
    const next = clearInput(ready);
    next.mode = "insert";
    next.once = false;
    const at = motion.cursor;
    return pack("full", true, next, { type: "caret", anchor: at, cursor: at });
  }
  if (!id) return pack("none", true, clearInput(vim), null);
  return dispatchResolved(ready, doc, anchor, cursor, raw, layout, id, null);
}

function finishZ(vim, doc, anchor, cursor, raw, layout, key) {
  if (isEscape(key)) return doEscape(vim, anchor, cursor);
  let id = null;
  let also = false;
  if (key.key === "z") id = "zz";
  else if (key.key === "t") id = "zt";
  else if (key.key === "b") id = "zb";
  else if (key.key === "." ) { id = "zz"; also = true; }
  else if (key.key === "-") { id = "zb"; also = true; }
  else if (key.key === "Enter") { id = "zt"; also = true; }
  if (!id) return pack("none", true, clearInput(vim), null);
  if (vim.input.operator) return pack("none", true, clearInput(vim), null);
  const next = clearInput(vim);
  const edge = id === "zt" ? "top" : id === "zb" ? "bottom" : "center";
  const effect = { type: "scroll", edge, alsoFirstNonBlank: also };
  if (also) {
    const line = lineBounds(doc, cursor, raw);
    const at = firstNonBlank(doc, line, raw);
    effect.cursor = at;
    effect.anchor = vim.mode === "visual" || vim.mode === "visual-line" ? anchor : at;
    next.column = null;
  }
  return pack("full", true, leavingOnce(next, vim), effect);
}

function finishObject(vim) {
  return pack("none", true, clearInput(vim), null);
}

function doEscape(vim, anchor, cursor) {
  const next = clearInput(vim);
  next.find = vim.find;
  next.search = vim.search;
  next.register = vim.register;
  next.column = vim.column;
  if (vim.once) {
    next.once = false;
    next.mode = "insert";
    return pack("full", true, next, { type: "caret", anchor: cursor, cursor });
  }
  if (vim.mode === "visual" || vim.mode === "visual-line") {
    next.mode = "normal";
    return pack("full", true, next, { type: "caret", anchor: cursor, cursor });
  }
  if (vim.mode === "insert") next.mode = "normal";
  return pack("full", true, next, { type: "caret", anchor: cursor, cursor });
}

function insertKey(vim, doc, cursor, key) {
  if (isEscape(key)) return doEscape(vim, cursor, cursor);
  const id = key.key.length === 1 ? key.key.toLowerCase() : key.key;
  if ((key.ctrl || key.meta) && id === "w") return pack("full", true, clearInput(vim), { type: "word-delete" });
  if (key.ctrl && id === "u") {
    const line = sourceLine(doc, cursor);
    return pack("full", true, clearInput(vim), {
      type: "splice",
      from: line.start,
      to: cursor,
      text: "",
      caret: line.start,
      yank: null,
    });
  }
  if (key.ctrl && id === "o") {
    const next = clearInput(vim);
    next.mode = "insert";
    next.once = true;
    return pack("full", true, next, null);
  }
  return pack("none", false, clearInput(vim), null);
}

function startPrefix(vim, key) {
  if (key === '"' && vim.input.operator) return pack("none", true, clearInput(vim), null);
  if (key === "i" || key === "a") {
    if (vim.input.operator || vim.mode === "visual" || vim.mode === "visual-line") {
      const next = { ...vim, input: { ...vim.input, keyBuffer: key } };
      return pack("partial", true, next, null);
    }
  }
  const next = { ...vim, input: { ...vim.input, keyBuffer: key } };
  return pack("partial", true, next, null);
}

export function vimKey(input) {
  const src = input || {};
  if (src.flag === false) return pack("none", false, cloneVim(src.vim), null);
  const vim = cloneVim(src.vim);
  const key = normKey(src.key);
  const doc = typeof src.doc === "string" ? src.doc : "";
  const cursor = clamp(src.cursor, doc.length);
  const anchor = src.anchor == null ? cursor : clamp(src.anchor, doc.length);
  const raw = src.raw === true;
  const layout = src.layout === true;

  if (key.key === "Tab") return pack("none", false, vim, null);
  if (vim.mode === "insert" && !vim.once) return insertKey(vim, doc, cursor, key);
  if (pageChord(key)) return pack("none", false, vim, null);
  if (isEscape(key)) return doEscape(vim, anchor, cursor);
  if (countDigit(key, vim)) {
    const next = { ...vim, input: { ...vim.input, keyBuffer: vim.input.keyBuffer + key.key } };
    return pack("partial", true, next, null);
  }
  if (vim.input.keyBuffer === "f" || vim.input.keyBuffer === "F" || vim.input.keyBuffer === "t" || vim.input.keyBuffer === "T") {
    return finishFind(vim, doc, anchor, cursor, raw, layout, key);
  }
  if (vim.input.keyBuffer === '"') return finishQuote(vim, anchor, cursor, key);
  if (vim.input.keyBuffer === "g") return finishG(vim, doc, anchor, cursor, raw, layout, key);
  if (vim.input.keyBuffer === "z") return finishZ(vim, doc, anchor, cursor, raw, layout, key);
  if (vim.input.keyBuffer === "i" || vim.input.keyBuffer === "a") return finishObject(vim);

  const ready = commitDigits(vim);
  const cmd = commandFromKey(key);
  if (cmd.kind === "prefix") return startPrefix(ready, cmd.id);
  if (cmd.kind === "operator") return dispatchResolved(ready, doc, anchor, cursor, raw, layout, cmd.id, null);
  if (cmd.kind === "motion") return dispatchResolved(ready, doc, anchor, cursor, raw, layout, cmd.id, null);
  if (cmd.kind === "action") return dispatchResolved(ready, doc, anchor, cursor, raw, layout, cmd.id, null);
  return pack("none", true, clearInput(ready), null);
}
