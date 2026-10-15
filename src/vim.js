// Pure key match. The page applies the effect. This module does not touch the editor.
import { codeSpanAt, createState, deleteForward, endBeforeTail, lineCaret, linkSpanAt, lockSpans, markerSplice, plan, skipHidden, sourceLine, wordStop } from "./doc.js";

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
    search: src.search && typeof src.search.pattern === "string"
      ? { pattern: src.search.pattern, forward: src.search.forward !== false, whole: src.search.whole === true }
      : null,
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

// The opener's first code unit is not hidden. The rest of the token is, so a
// probe one unit in still names the whole marker. A hard-break tail is hidden
// too, and it does not match this shape.
function commentMarkerSpan(doc, index) {
  if (index < 0 || index >= doc.length) return null;
  const probes = index + 1 < doc.length ? [index, index + 1] : [index];
  for (const probe of probes) {
    const fwd = skipHidden(doc, probe, "forward", { gap: false });
    const back = skipHidden(doc, probe, "backward", { gap: false });
    if (fwd === probe && back === probe) continue;
    const start = back < probe ? back : probe;
    const end = fwd > probe ? fwd : probe;
    if (index < start || index >= end) continue;
    if (/^\{\/?[A-Za-z][A-Za-z0-9_-]*\}$/.test(doc.slice(start, end))) return { start, end };
  }
  return null;
}

function breaksLine(doc, index) {
  if (doc[index] === "\n") return true;
  return doc[index] === "\r" && index + 1 < doc.length && doc[index + 1] === "\n";
}

// r and ~ take ordinary text on the vim line. A count that would include a
// break or a comment marker takes nothing, rather than stopping short.
function ordinarySpan(doc, cursor, count, raw) {
  const line = lineBounds(doc, cursor, raw);
  const steps = count < 1 ? 1 : count;
  let at = cursor;
  for (let n = 0; n < steps; n += 1) {
    if (at < line.start || at >= line.end || at >= doc.length) return null;
    if (breaksLine(doc, at) || commentMarkerSpan(doc, at)) return null;
    const next = at + unitLen(doc, at);
    if (next > line.end) return null;
    at = next;
  }
  if (at === cursor) return null;
  return { from: cursor, to: at };
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
    return { kind: "caret", cursor: at, column: null, linewise: false, inclusive: !find.till, past: false, word: false, find, till: find.till === true };
  }
  if (id === "f" || id === "F" || id === "t" || id === "T") {
    const forward = id === "f" || id === "t";
    const till = id === "t" || id === "T";
    const at = findChar(doc, cursor, spec.ch, forward, till, count, false);
    const found = { ch: spec.ch, forward, till };
    if (at == null) return { kind: "stay", find: found };
    return { kind: "caret", cursor: at, column: null, linewise: false, inclusive: !till, past: false, word: false, find: found, till };
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

// dw and cw stay on the vim line. w itself may leave. A rendered line is one
// block, so one newline inside it is still this line. The gap is not. Raw is
// one source line.
function limitWord(doc, origin, motion, raw) {
  if (!motion.word || motion.inclusive || motion.linewise || motion.cursor <= origin) return motion;
  const limit = lineDollar(doc, lineBounds(doc, origin, raw));
  if (motion.cursor <= limit) return motion;
  return { ...motion, cursor: limit };
}

// A forward inclusive motion takes the character the caret lands before.
// t and T do not. Backward, that character is the low end.
function charRange(doc, origin, motion) {
  const forward = motion.cursor >= origin;
  let from = forward ? origin : motion.cursor;
  let to = forward ? motion.cursor : origin;
  if (forward && motion.inclusive && !motion.past && motion.cursor > origin && to < doc.length) {
    to += unitLen(doc, to);
  }
  if (!forward && motion.till) {
    const next = from + unitLen(doc, from);
    if (next >= to) return { from: origin, to: origin };
    from = next;
  }
  return { from, to };
}

// One marker in the splice stays on the text that remains. Both markers leave
// with the text they wrap.
function keptMarker(doc, from, to) {
  const kept = markerSplice(doc, from, to);
  if (!kept || kept.whole) return null;
  return kept;
}

function indentOp(operator) {
  return operator === ">" || operator === "<" || operator === "=";
}

function separatorWidth(text, index) {
  if (text[index] === "\t") return 1;
  let count = 0;
  while (count < 4 && text[index + count] === " ") count += 1;
  return count;
}

function listMarkerLength(text) {
  let index = 0;
  while (index < text.length && (text[index] === " " || text[index] === "\t")) index += 1;
  const bullet = text[index];
  if (bullet === "-" || bullet === "+" || bullet === "*") {
    const separator = separatorWidth(text, index + 1);
    return separator === 0 ? 0 : index + 1 + separator;
  }
  const ordered = /^(\d{1,9})[.)]/.exec(text.slice(index));
  if (!ordered) return 0;
  const separator = separatorWidth(text, index + ordered[0].length);
  return separator === 0 ? 0 : index + ordered[0].length + separator;
}

function leadingTabs(text) {
  let count = 0;
  while (text[count] === "\t") count += 1;
  return count;
}

// A tab, or else as many as four leading spaces. A top-level item has none.
function outdentWidth(text) {
  if (text.startsWith("\t")) return 1;
  let count = 0;
  while (count < 4 && text[count] === " ") count += 1;
  return count;
}

function indentColumns(text) {
  let column = 0;
  let index = 0;
  while (index < text.length && (text[index] === " " || text[index] === "\t")) {
    column += text[index] === " " ? 1 : 4 - (column % 4);
    index += 1;
  }
  return { column, index };
}

function orderedMark(text) {
  const { column, index } = indentColumns(text);
  const ordered = /^(\d{1,9})([.)])/.exec(text.slice(index));
  if (!ordered) return null;
  if (separatorWidth(text, index + ordered[0].length) === 0) return null;
  return {
    indent: column,
    num: ordered[1],
    numStart: index,
    numEnd: index + ordered[1].length,
  };
}

function bulletMark(text) {
  const { column, index } = indentColumns(text);
  const bullet = text[index];
  if (bullet !== "-" && bullet !== "+" && bullet !== "*") return null;
  if (separatorWidth(text, index + 1) === 0) return null;
  return { indent: column };
}

function blocksOutdentScan(text) {
  if (text === "") return true;
  if (text.startsWith("|") || text.startsWith("```")) return true;
  const core = text.trim();
  if (!core.startsWith("![")) return false;
  const labelEnd = core.indexOf("](");
  if (labelEnd < 2) return false;
  return core.indexOf(")", labelEnd + 2) === core.length - 1;
}

function sourceRecords(doc) {
  return rawLines(doc).map((line) => {
    const cr = line.end > line.start
      && doc[line.end - 1] === "\r"
      && (line.end === doc.length || doc[line.end] === "\n");
    const textEnd = cr ? line.end - 1 : line.end;
    return { start: line.start, end: line.end, text: doc.slice(line.start, textEnd), cr };
  });
}

function inFence(all, offset) {
  let open = false;
  for (const line of all) {
    if (line.text.startsWith("```")) open = !open;
    else if (open && offset >= line.start && offset <= line.end) return true;
  }
  return false;
}

function plainListLine(all, offset, text) {
  if (text.startsWith("> ")) return false;
  if (inFence(all, offset)) return false;
  return listMarkerLength(text) > 0;
}

// The row rawLines adds after a final newline is not a line to shift.
function sourceLinesCovering(all, doc, from, to) {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const out = [];
  for (const line of all) {
    if (line.start === doc.length && doc.endsWith("\n") && !(lo === hi && lo === doc.length)) continue;
    const past = line.end < doc.length && doc[line.end] === "\n" ? line.end + 1 : line.end;
    if (lo === hi) {
      if (lo >= line.start && lo <= line.end) out.push(line);
    } else if (line.start < hi && past > lo) out.push(line);
  }
  if (out.length === 0 && all.length) out.push(all[Math.max(0, all.length - 1)]);
  return out;
}

function previousRecord(all, lineStart) {
  for (let i = all.length - 1; i >= 0; i -= 1) {
    if (all[i].end < lineStart) return all[i];
  }
  return null;
}

// One leading tab. An ordered item whose new tab depth passes the previous
// line starts at 1. A line in the same shift already counts the tab it gains.
function indentListItem(all, line, text, chosen) {
  const previous = previousRecord(all, line.start);
  let prevTabs = 0;
  if (previous) {
    prevTabs = leadingTabs(previous.text);
    if (chosen.some((item) => item.start === previous.start)) prevTabs += 1;
  }
  let body = "\t" + text;
  if (leadingTabs(body) > prevTabs) {
    let index = 0;
    while (index < text.length && (text[index] === " " || text[index] === "\t")) index += 1;
    const ordered = /^(\d{1,9})([.)])/.exec(text.slice(index));
    if (ordered && ordered[1] !== "1") {
      body = "\t" + text.slice(0, index) + "1" + ordered[2] + text.slice(index + ordered[0].length);
    }
  }
  return body;
}

function nextOutdentNumber(all, lineStart, indent, rewritten) {
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const line = all[i];
    if (line.start >= lineStart) continue;
    const text = rewritten.has(line.start) ? rewritten.get(line.start) : line.text;
    if (blocksOutdentScan(text)) return "1";
    const ordered = orderedMark(text);
    if (ordered) {
      if (ordered.indent > indent) continue;
      if (ordered.indent < indent) return "1";
      return String(Number(ordered.num) + 1);
    }
    const bullet = bulletMark(text);
    if (bullet) {
      if (bullet.indent > indent) continue;
      return "1";
    }
    if (text.startsWith("> ") || text === "---" || text === "***" || text === "___" || /^(#{1,6}) /.test(text)) return "1";
  }
  return "1";
}

function outdentListItem(all, line, text, rewritten) {
  const width = outdentWidth(text);
  if (width === 0) return text;
  let body = text.slice(width);
  const mark = orderedMark(body);
  if (mark) {
    const next = nextOutdentNumber(all, line.start, mark.indent, rewritten);
    if (next !== mark.num) body = body.slice(0, mark.numStart) + next + body.slice(mark.numEnd);
  }
  return body;
}

function previousListTabs(all, lineStart, rewritten) {
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const line = all[i];
    if (line.start >= lineStart) continue;
    const text = rewritten.has(line.start) ? rewritten.get(line.start) : line.text;
    if (!plainListLine(all, line.start, text)) continue;
    return leadingTabs(text);
  }
  return null;
}

function resetDeeperNumber(rest) {
  const ordered = /^(\d{1,9})([.)])/.exec(rest);
  if (!ordered || ordered[1] === "1") return rest;
  if (separatorWidth(rest, ordered[0].length) === 0) return rest;
  return "1" + ordered[2] + rest.slice(ordered[0].length);
}

// One tab deeper than the previous list item. No previous item is the top level.
function equalListItem(all, line, text, rewritten) {
  const prevTabs = previousListTabs(all, line.start, rewritten);
  const target = prevTabs == null ? 0 : prevTabs + 1;
  let index = 0;
  while (index < text.length && (text[index] === " " || text[index] === "\t")) index += 1;
  let rest = text.slice(index);
  if (prevTabs != null && target > prevTabs) rest = resetDeeperNumber(rest);
  return "\t".repeat(target) + rest;
}

function shiftText(all, line, text, operator, chosen, rewritten) {
  const list = plainListLine(all, line.start, text);
  if (operator === ">") return list ? indentListItem(all, line, text, chosen) : "\t" + text;
  if (operator === "<") {
    if (list) return outdentListItem(all, line, text, rewritten);
    return text.startsWith("\t") ? text.slice(1) : text;
  }
  if (!list) return text;
  return equalListItem(all, line, text, rewritten);
}

// << on an item lands on the item text. The marker is not that stop.
function indentCaret(line, operator, list) {
  if (operator === "<" && list) {
    const marker = listMarkerLength(line);
    if (marker > 0) {
      let at = marker;
      while (at < line.length && (line[at] === " " || line[at] === "\t")) at += 1;
      return at < line.length ? at : marker;
    }
  }
  let at = 0;
  while (at < line.length && (line[at] === " " || line[at] === "\t")) at += 1;
  return at < line.length ? at : 0;
}

function applyIndent(vim, doc, from, to, operator) {
  const all = sourceRecords(doc);
  const lines = sourceLinesCovering(all, doc, from, to);
  const rewritten = new Map();
  for (const line of lines) {
    rewritten.set(line.start, shiftText(all, line, line.text, operator, lines, rewritten));
  }
  const sliceFrom = lines[0].start;
  const sliceTo = lines[lines.length - 1].end;
  let text = "";
  let prev = sliceFrom;
  for (const line of lines) {
    text += doc.slice(prev, line.start) + rewritten.get(line.start) + (line.cr ? "\r" : "");
    prev = line.end;
  }
  text += doc.slice(prev, sliceTo);
  const next = clearInput(vim);
  if (text === doc.slice(sliceFrom, sliceTo)) return pack("full", true, next, null);
  // The caret is now the first non-blank, so a remembered column would miss it.
  next.column = null;
  if (vim.once) {
    next.once = false;
    next.mode = "insert";
  }
  const first = rewritten.get(lines[0].start);
  const list = plainListLine(all, lines[0].start, first);
  return pack("full", true, next, {
    type: "splice",
    from: sliceFrom,
    to: sliceTo,
    text,
    caret: sliceFrom + indentCaret(first, operator, list),
    yank: null,
  });
}

function applyRange(op, doc, range, motion, vim) {
  let { from, to } = range;
  // cw drops one trailing run of spaces when the cut is not only whitespace.
  // A newline stays: inside a rendered line it separates words.
  if (op === "c" && motion && motion.word && motion.cursor > range.from) {
    const chunk = doc.slice(from, to);
    if (/\S/.test(chunk)) {
      const spaces = /[ \t]+$/.exec(chunk);
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
  const kept = keptMarker(doc, from, to);
  const text = kept ? kept.text : "";
  const caret = kept ? kept.caret : legal(doc, from, 1, false);
  if (op === "d") {
    return {
      effect: { type: "splice", from, to, text, caret, yank: { text: removed, linewise } },
      register: { text: removed, linewise },
      mode: vim.once ? "insert" : "normal",
    };
  }
  if (op === "c") {
    let changeText = text;
    let changeCaret = caret;
    // cc and S leave one empty line. The caret rests on it.
    if (linewise && !kept) {
      changeText = removed.includes("\r\n") ? "\r\n" : "\n";
      changeCaret = from;
    }
    return {
      effect: { type: "splice", from, to, text: changeText, caret: changeCaret, yank: { text: removed, linewise } },
      register: { text: removed, linewise },
      mode: "insert",
    };
  }
  return null;
}

// endPast stops on the paragraph's own newline. The blank under it is not a
// vim line, so a rendered linewise delete has to take that gap too.
function throughGap(doc, to) {
  if (to < 0 || to >= doc.length || doc[to] !== "\n") return to;
  const blocks = plan(doc, to).blocks;
  let end = to;
  while (end < doc.length && doc[end] === "\n") {
    let gap = false;
    for (let i = 0; i < blocks.length; i += 1) {
      const block = blocks[i];
      if (block && block.start === end && block.classes && block.classes.includes("md-paragraph-gap")) {
        gap = true;
        break;
      }
    }
    if (!gap) break;
    end += 1;
  }
  return end;
}

// The gap block starts on its break, which is a LF or a CRLF.
function breakEnd(doc, index) {
  if (index < doc.length && doc[index] === "\n") return index + 1;
  if (index + 1 < doc.length && doc[index] === "\r" && doc[index + 1] === "\n") return index + 2;
  return null;
}

// A rendered vim line is the block and the gap under it. endPast stops on the
// block's own newline, which is still inside that line.
function pastVimLine(doc, at) {
  const blocks = plan(doc, at).blocks;
  let end = at;
  while (end < doc.length) {
    let gap = false;
    for (let i = 0; i < blocks.length; i += 1) {
      const block = blocks[i];
      if (block && block.start === end && block.classes && block.classes.includes("md-paragraph-gap")) {
        gap = true;
        break;
      }
    }
    if (!gap) break;
    const next = breakEnd(doc, end);
    if (next == null) break;
    end = next;
  }
  return end;
}

function putAt(doc, cursor, raw, after) {
  const line = lineBounds(doc, cursor, raw);
  if (!after) return line.start;
  const at = endPast(doc, line);
  if (raw) return at;
  return pastVimLine(doc, at);
}

// Inserting on the far side of the gap still joins a following paragraph
// unless the splice carries a gap of its own.
function putJoinsForward(doc, at, text) {
  const merged = doc.slice(0, at) + text + doc.slice(at);
  const end = at + text.length;
  const blocks = plan(merged, at).blocks;
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (!block || typeof block.start !== "number" || typeof block.end !== "number") continue;
    if (block.classes && block.classes.includes("md-paragraph-gap")) continue;
    if (block.start >= at && block.start < end && block.end > end) return true;
  }
  return false;
}

function linewisePutText(doc, at, text, raw, after) {
  const body = text.endsWith("\n") ? text : text + "\n";
  if (raw || !after || body.endsWith("\n\n") || !putJoinsForward(doc, at, body)) return body;
  return body + (body.endsWith("\r\n") ? "\r\n" : "\n");
}

// ]p and [p are the linewise put, then =, as the bytes of one splice.
function shiftInserted(doc, at, text) {
  const merged = doc.slice(0, at) + text + doc.slice(at);
  const end = at + text.length;
  const all = sourceRecords(merged);
  const lines = [];
  for (const line of all) {
    if (line.start >= end) break;
    if (line.start < at || line.end > end) continue;
    lines.push(line);
  }
  if (lines.length === 0) return text;
  const rewritten = new Map();
  let out = "";
  let prev = at;
  for (const line of lines) {
    const shifted = shiftText(all, line, line.text, "=", lines, rewritten);
    rewritten.set(line.start, shifted);
    out += merged.slice(prev, line.start) + shifted + (line.cr ? "\r" : "");
    prev = line.end;
  }
  out += merged.slice(prev, end);
  return out;
}

function putCaret(at, text) {
  let skip = 0;
  while (skip < text.length && (text[skip] === " " || text[skip] === "\t")) skip += 1;
  return at + skip;
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
  if (indentOp(operator) && motion.kind === "caret") {
    // A tab is a source prefix. A rendered block joins source lines, and the
    // motion still names each of those lines.
    const range = linewiseRange(doc, cursor, motion.cursor, true);
    const result = applyIndent(vim, doc, range.from, range.to, operator);
    if (motion.find) result.vim.find = motion.find;
    return result;
  }
  const at = motion.cursor;
  if (operator === "d" || operator === "c" || operator === "y") {
    const origin = cursor;
    const used = operator === "y" ? motion : limitWord(doc, origin, motion, raw);
    let range;
    if (used.linewise) range = linewiseRange(doc, origin, used.cursor, raw);
    else range = charRange(doc, origin, used);
    if (operator === "d" && used.linewise && !raw) range.to = throughGap(doc, range.to);
    range.originCaret = origin;
    const applied = applyRange(operator, doc, range, { ...used, origin }, vim);
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
    let landed = at;
    // e and w stop on the character the selection includes. The caret is the
    // exclusive end, so it sits one unit later. $ is already past that character.
    if (motion.word && at > cursor && at < doc.length && doc[at] !== "\n" && doc[at] !== "\r") {
      landed = at + unitLen(doc, at);
    }
    return pack("full", true, leavingOnce(next, vim), { type: "caret", anchor, cursor: landed });
  }
  return pack("full", true, leavingOnce(next, vim), { type: "caret", anchor: at, cursor: at });
}

// A motion that stays in Visual has not used the one Normal command.
function leavingOnce(vim, prior) {
  if (!prior.once) return vim;
  if (vim.mode === "visual" || vim.mode === "visual-line") {
    return vim.once ? vim : { ...vim, once: true };
  }
  const next = { ...vim, once: false };
  if (next.mode === "normal") next.mode = "insert";
  return next;
}

// Simple case mapping keeps the code unit. A mapping that grows, such as ß to SS, is not simple, so the unit stays.
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
  if (operator === "gu") return id === "u" || id === "gu";
  if (operator === "gU") return id === "U" || id === "gU";
  if (operator === "g~") return id === "~" || id === "g~";
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
  else if (vim.mode === "visual" || vim.mode === "visual-line") next.mode = "normal";
  return pack("full", true, next, {
    type: "splice",
    from,
    to,
    text,
    caret: from,
    yank: null,
  });
}

function selectionSpan(doc, anchor, cursor, raw, linewise) {
  const lo = Math.min(anchor, cursor);
  const hi = Math.max(anchor, cursor);
  if (!linewise) return { from: lo, to: hi, linewise: false };
  const range = linewiseRange(doc, lo, hi, raw);
  return { from: range.from, to: range.to, linewise: true };
}

// The selection is the range. A rendered linewise delete also takes the blank
// under the paragraph. A change leaves that blank and opens one empty line.
function operateVisual(vim, doc, anchor, cursor, raw, op) {
  const linewise = vim.mode === "visual-line";
  let span = selectionSpan(doc, anchor, cursor, raw, linewise);
  if (op === "d" && linewise && !raw) span = { ...span, to: throughGap(doc, span.to) };
  const next = clearInput(vim);
  next.once = false;
  next.mode = op === "c" || vim.once ? "insert" : "normal";
  if (caseOp(op)) {
    if (span.from === span.to) return pack("full", true, next, null);
    const cased = spliceCase(vim, doc, span.from, span.to, op);
    cased.vim.mode = next.mode;
    cased.vim.once = false;
    return cased;
  }
  if (indentOp(op)) {
    const result = applyIndent(vim, doc, span.from, span.to, op);
    result.vim.mode = next.mode;
    result.vim.once = false;
    return result;
  }
  if (span.from === span.to) return pack("full", true, next, null);
  const removed = doc.slice(span.from, span.to);
  if (op === "y") {
    next.register = { text: removed, linewise: span.linewise };
    return pack("full", true, next, {
      type: "splice",
      from: span.from,
      to: span.to,
      text: removed,
      caret: span.linewise ? span.from : anchor,
      yank: { text: removed, linewise: span.linewise },
    });
  }
  if (op !== "d" && op !== "c") return pack("none", true, clearInput(vim), null);
  const kept = keptMarker(doc, span.from, span.to);
  let text = kept ? kept.text : "";
  let caret = kept ? kept.caret : legal(doc, span.from, 1, raw);
  if (op === "c" && span.linewise && !kept) {
    text = removed.includes("\r\n") ? "\r\n" : "\n";
    caret = span.from;
  }
  next.register = { text: removed, linewise: span.linewise };
  return pack("full", true, next, {
    type: "splice",
    from: span.from,
    to: span.to,
    text,
    caret,
    yank: { text: removed, linewise: span.linewise },
  });
}

function dispatchResolved(vim, doc, anchor, cursor, raw, layout, id, extra) {
  const operator = vim.input.operator;
  const visual = vim.mode === "visual" || vim.mode === "visual-line";
  if (operator && doubled(operator, id)) return repeatedLine(vim, doc, cursor, raw, operator);
  if (operator && operatorOf(id) && !doubled(operator, id)) return pack("none", true, clearInput(vim), null);
  if (!operator && visual && operatorOf(id)) return operateVisual(vim, doc, anchor, cursor, raw, operatorOf(id));
  if (!operator && operatorOf(id)) {
    const next = commitDigits(vim);
    next.input = { ...next.input, operator: operatorOf(id), keyBuffer: "", motion: null };
    return pack("full", true, next, null);
  }
  if ((id === "i" || id === "a") && (operator || vim.mode === "visual" || vim.mode === "visual-line")) {
    return startPrefix(vim, id);
  }
  if (MOTIONS.has(id) || id === "f" || id === "F" || id === "t" || id === "T") {
    const motion = runMotion(id, {
      doc,
      cursor,
      anchor,
      raw: indentOp(operator) ? true : raw,
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

function repeatedLine(vim, doc, cursor, raw, operator) {
  const range = countedLines(doc, cursor, repeatOf(vim), indentOp(operator) ? true : raw);
  if (caseOp(operator)) return spliceCase(vim, doc, range.from, range.to, operator);
  if (indentOp(operator)) return applyIndent(vim, doc, range.from, range.to, operator);
  const motion = { cursor: range.to, linewise: true, inclusive: false, past: false, word: false, origin: cursor };
  const applied = applyRange(operator, doc, { ...range, originCaret: cursor }, motion, vim);
  const next = clearInput(vim);
  if (!applied) return pack("full", true, next, null);
  next.mode = applied.mode;
  if (vim.once) {
    next.once = false;
    next.mode = "insert";
  }
  if (applied.register) next.register = applied.register;
  return pack("full", true, next, applied.effect);
}

function stepBack(doc, index) {
  if (index <= 1) return Math.max(0, index - 1);
  const lead = doc.charCodeAt(index - 2);
  const low = doc.charCodeAt(index - 1);
  if (lead >= 0xD800 && lead <= 0xDBFF && low >= 0xDC00 && low <= 0xDFFF) return index - 2;
  return index - 1;
}

// Counted x, X, and s stay on the source line and stop before its newline.
function sourceSpan(doc, cursor, count, backward) {
  const line = sourceLine(doc, cursor);
  const steps = count < 1 ? 1 : count;
  if (backward) {
    let from = cursor;
    for (let n = 0; n < steps && from > line.start; n += 1) {
      const prev = stepBack(doc, from);
      if (prev < line.start) break;
      from = prev;
    }
    return { from, to: cursor };
  }
  let to = cursor;
  for (let n = 0; n < steps && to < line.end; n += 1) to += unitLen(doc, to);
  return { from: cursor, to };
}

function forwardCut(doc, cursor) {
  const after = deleteForward(createState(doc, cursor, cursor));
  if (after.doc === doc) return "";
  const at = Math.min(after.cursor, after.doc.length);
  const lost = doc.length - after.doc.length;
  if (lost > 0 && doc.slice(0, at) + doc.slice(at + lost) === after.doc) return doc.slice(at, at + lost);
  let head = 0;
  const limit = Math.min(doc.length, after.doc.length);
  while (head < limit && doc[head] === after.doc[head]) head += 1;
  let tail = 0;
  while (
    tail < doc.length - head &&
    tail < after.doc.length - head &&
    doc[doc.length - 1 - tail] === after.doc[after.doc.length - 1 - tail]
  ) tail += 1;
  return doc.slice(head, doc.length - tail);
}

function isActionId(id) {
  return id === "x" || id === "X" || id === "v" || id === "V" || id === "u" || id === "U" || id === "ctrl-r"
    || id === "i" || id === "a" || id === "I" || id === "A" || id === "o" || id === "O"
    || id === "ctrl-w" || id === "." || id === "p" || id === "P" || id === "r" || id === "R" || id === "~"
    || id === "J" || id === "gJ" || id === "s" || id === "S" || id === "/" || id === "?" || id === "n" || id === "N"
    || id === "*" || id === "#" || id === ":" || id === "D" || id === "C" || id === "Y";
}

// v selects the character after the caret. A line break is not that character.
function charAfter(doc, cursor, raw) {
  if (cursor < 0 || cursor >= doc.length) return cursor;
  if (doc[cursor] === "\n" || doc[cursor] === "\r") return cursor;
  const line = lineBounds(doc, cursor, raw);
  if (cursor < line.start || cursor >= line.end) return cursor;
  const next = cursor + unitLen(doc, cursor);
  if (next > line.end || next > doc.length) return cursor;
  return next;
}

// A rendered block joins the next source line, and a list copies its marker,
// unless a blank line stands between them. That blank is not one of the new lines.
function fileBreak(doc) {
  return doc.includes("\r\n") ? "\r\n" : "\n";
}

// An empty rendered line ends on the CR of a CRLF pair.
function pastBreak(doc, end) {
  if (end < doc.length && doc[end] === "\n") return end + 1;
  if (end + 1 < doc.length && doc[end] === "\r" && doc[end + 1] === "\n") return end + 2;
  return null;
}

function openSplice(vim, at, text, caret) {
  const next = clearInput(vim);
  next.mode = "insert";
  next.once = false;
  next.column = null;
  return pack("full", true, next, { type: "splice", from: at, to: at, text, caret, yank: null });
}

function openLine(vim, doc, cursor, raw, below) {
  const count = repeatOf(vim);
  const nl = fileBreak(doc);
  const line = lineBounds(doc, cursor, raw);
  const brk = pastBreak(doc, line.end);
  if (raw) {
    const at = below ? (brk == null ? line.end : brk) : line.start;
    // A line with no break takes the first one. The new line starts after that break.
    const caret = below && brk == null ? at + count * nl.length : at + (count - 1) * nl.length;
    return openSplice(vim, at, nl.repeat(count), caret);
  }
  const lines = nl.repeat(count);
  if (!below) {
    const at = line.start;
    return openSplice(vim, at, lines + nl, at + (count - 1) * nl.length);
  }
  // The row after a final newline is already past the break, so it needs no lead.
  const trailing = line.start === doc.length && doc.endsWith("\n");
  const at = brk == null ? line.end : brk;
  const lead = brk == null && !trailing ? nl : "";
  return openSplice(vim, at, lead + nl + lines, at + lead.length + nl.length + (count - 1) * nl.length);
}

function putRegister(vim, doc, cursor, raw, after, adjust) {
  const next = clearInput(vim);
  const reg = vim.register || { text: "", linewise: false };
  if (!reg.text) return pack("full", true, next, null);
  if (reg.linewise || adjust) {
    const at = putAt(doc, cursor, raw, after);
    let text = linewisePutText(doc, at, reg.text, raw, after);
    if (adjust) text = shiftInserted(doc, at, text);
    const caret = putCaret(at, text);
    const kept = vim.mode === "visual" || vim.mode === "visual-line" ? "normal" : vim.mode;
    next.mode = kept;
    return pack("full", true, next, { type: "splice", from: at, to: at, text, caret, yank: null });
  }
  let at = cursor;
  if (after && at < doc.length) at += unitLen(doc, at);
  const caret = after ? at + Math.max(0, reg.text.length - unitLen(reg.text, Math.max(0, reg.text.length - 1))) : at;
  return pack("full", true, next, { type: "splice", from: at, to: at, text: reg.text, caret, yank: null });
}

// A trailing CR belongs to the break, not to the line's text.
function joinContentEnd(doc, line) {
  let end = line.end;
  if (end > line.start && end <= doc.length && doc[end - 1] === "\r" && (end === doc.length || doc[end] === "\n")) end -= 1;
  return end;
}

function joinSpaceAt(doc, index) {
  return index >= 0 && index < doc.length && (doc[index] === " " || doc[index] === "\t");
}

// Two breaks mean a blank line sits between the units. That pad is not a line.
function joinPad(doc, from, to) {
  let breaks = 0;
  for (let i = from; i < to && breaks < 2; i += 1) {
    if (doc[i] === "\n") breaks += 1;
  }
  return breaks >= 2;
}

function dropPhantom(doc, lines) {
  const out = [];
  for (const line of lines) {
    if (doc.length > 0 && line.start >= doc.length) continue;
    out.push(line);
  }
  return out;
}

function sourceLinesInside(doc, block) {
  const from = block.start;
  const to = block.end;
  const found = [];
  for (const line of dropPhantom(doc, rawLines(doc))) {
    if (line.start < from) continue;
    if (line.start > to) break;
    if (line.start === to && !(from === to && line.end === to)) break;
    found.push(line);
  }
  return found;
}

// A fence or an atom is one line. A prose block still has a source break inside it.
function splitsForJoin(block) {
  if (!block || block.fence) return false;
  if (block.type && block.type !== "line") return false;
  return true;
}

function unitIndex(lines, doc, cursor, raw) {
  if (lines.length === 0) return -1;
  const index = lineIndex(lines, doc, cursor, raw);
  if (index >= lines.length) return -1;
  const line = lines[index];
  if (cursor >= line.start && cursor <= line.end) return index;
  let found = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].start <= cursor) found = i;
  }
  return found;
}

// Raw units are source lines. Rendered, the caret's block contributes each source
// line from the caret down, and every later block is one unit. A gap is neither.
function joinUnits(doc, cursor, raw) {
  if (raw) {
    const lines = dropPhantom(doc, rawLines(doc));
    const index = unitIndex(lines, doc, cursor, true);
    if (index < 0) return [];
    return lines.slice(index);
  }
  const blocks = [];
  for (const block of plan(doc, cursor).blocks) {
    if (block.classes && block.classes.includes("md-paragraph-gap")) continue;
    if (typeof block.start !== "number" || typeof block.end !== "number") continue;
    blocks.push(block);
  }
  const index = unitIndex(blocks, doc, cursor, false);
  if (index < 0) return [];
  const block = blocks[index];
  let head = splitsForJoin(block) ? sourceLinesInside(doc, block) : [block];
  if (head.length === 0) head = [block];
  // A caret on the pad under the block still joins that block, from its last source line.
  let at = head.length - 1;
  for (let i = 0; i < head.length; i += 1) {
    if (cursor >= head[i].start && cursor <= head[i].end) at = i;
  }
  const units = head.slice(at);
  for (let i = index + 1; i < blocks.length; i += 1) units.push(blocks[i]);
  return units;
}

// The caret marks the last join: before the space J wrote, or on the first
// character of that line when the join wrote none.
function buildJoin(doc, lines, glue) {
  const from = joinContentEnd(doc, lines[0]);
  const to = lines[lines.length - 1].start;
  if (from > to) return null;
  let text = "";
  let caretAt = 0;
  for (let i = 1; i < lines.length; i += 1) {
    const prev = lines[i - 1];
    const cur = lines[i];
    const prevEnd = joinContentEnd(doc, prev);
    const curEnd = joinContentEnd(doc, cur);
    const pad = joinPad(doc, prevEnd, cur.start);
    const left = prevEnd > prev.start && joinSpaceAt(doc, prevEnd - 1);
    const right = cur.start < curEnd && joinSpaceAt(doc, cur.start);
    const space = glue && !pad && !left && !right;
    if (i === lines.length - 1) {
      caretAt = text.length;
      if (space) text += " ";
      continue;
    }
    if (space) text += " ";
    text += doc.slice(cur.start, curEnd);
  }
  if (from === to && text === "") return null;
  return { from, to, text, caret: from + caretAt };
}

function joinLines(vim, doc, cursor, raw, glue) {
  const count = Math.max(repeatOf(vim), 2);
  const units = joinUnits(doc, cursor, raw);
  const lines = units.length < 2 ? [] : units.slice(0, count);
  const built = lines.length < 2 ? null : buildJoin(doc, lines, glue);
  if (!built) return pack("full", true, leavingOnce(clearInput(vim), vim), null);
  let next = clearInput(vim);
  if (next.mode === "visual" || next.mode === "visual-line") next.mode = "normal";
  next = leavingOnce(next, vim);
  next.column = null;
  return pack("full", true, next, {
    type: "splice",
    from: built.from,
    to: built.to,
    text: built.text,
    caret: built.caret,
    yank: null,
  });
}

const SEARCH_LIMIT = 1000;

// Spaces separate the run, the same way wordStop does, so a comma stays on it.
function runUnder(doc, cursor) {
  if (cursor < 0 || cursor >= doc.length) return null;
  if (/\s/.test(doc[cursor])) return null;
  let start = cursor;
  while (start > 0 && !/\s/.test(doc[start - 1])) start -= 1;
  let end = cursor + 1;
  while (end < doc.length && !/\s/.test(doc[end])) end += 1;
  if (start >= end) return null;
  return { start, end, text: doc.slice(start, end) };
}

function wholeRun(doc, at, length) {
  if (at > 0 && !/\s/.test(doc[at - 1])) return false;
  const after = at + length;
  if (after < doc.length && !/\s/.test(doc[after])) return false;
  return true;
}

function matchesOf(doc, pattern, whole) {
  const hits = [];
  if (!pattern) return hits;
  let index = 0;
  while (index <= doc.length - pattern.length) {
    const at = doc.indexOf(pattern, index);
    if (at < 0) break;
    if (!whole || wholeRun(doc, at, pattern.length)) hits.push(at);
    index = at + 1;
  }
  return hits;
}

// Forward starts at origin, or just after it when the caret is already on a hit.
// Backward takes the nearest start before origin. Either side wraps once.
function nextHit(hits, origin, forward, skipStart) {
  if (hits.length === 0) return null;
  if (forward) {
    const min = skipStart ? origin + 1 : origin;
    for (let i = 0; i < hits.length; i += 1) {
      if (hits[i] >= min) return hits[i];
    }
    for (let i = 0; i < hits.length; i += 1) {
      if (hits[i] < min) return hits[i];
    }
    return null;
  }
  let best = null;
  for (let i = 0; i < hits.length; i += 1) {
    if (hits[i] < origin) best = hits[i];
  }
  if (best != null) return best;
  return hits[hits.length - 1];
}

function nthHit(hits, origin, forward, skipStart, count) {
  let at = origin;
  let skip = skipStart;
  const steps = count < 1 ? 1 : count;
  for (let n = 0; n < steps; n += 1) {
    const hit = nextHit(hits, at, forward, skip);
    if (hit == null) return null;
    at = hit;
    skip = true;
  }
  return at;
}

function placeSearch(vim, doc, origin, scanForward, stored, count, skipStart) {
  const pattern = stored.pattern;
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > SEARCH_LIMIT) {
    return pack("full", true, clearInput(vim), null);
  }
  const whole = stored.whole === true;
  const hits = matchesOf(doc, pattern, whole);
  const at = nthHit(hits, origin, scanForward, skipStart, count);
  const next = clearInput(vim);
  next.search = { pattern, forward: stored.forward !== false, whole };
  if (at == null) return pack("full", true, next, null);
  next.column = null;
  return pack("full", true, leavingOnce(next, vim), { type: "caret", anchor: at, cursor: at });
}

function repeatSearch(vim, doc, cursor, flip) {
  const stored = vim.search;
  if (!stored || typeof stored.pattern !== "string" || stored.pattern.length === 0) {
    return pack("full", true, clearInput(vim), null);
  }
  const scanForward = flip ? stored.forward === false : stored.forward !== false;
  return placeSearch(vim, doc, cursor, scanForward, stored, repeatOf(vim), scanForward);
}

function starSearch(vim, doc, cursor, forward, whole) {
  const word = runUnder(doc, cursor);
  if (!word || word.text.length > SEARCH_LIMIT) return pack("full", true, clearInput(vim), null);
  const origin = forward ? word.end : word.start;
  const stored = { pattern: word.text, forward, whole };
  return placeSearch(vim, doc, origin, forward, stored, repeatOf(vim), false);
}

// gn puts the caret at the match's end. gN puts it at the start, so the selection runs backward.
function selectSearch(vim, doc, cursor, backward) {
  const stored = vim.search;
  if (!stored || typeof stored.pattern !== "string" || stored.pattern.length === 0 || stored.pattern.length > SEARCH_LIMIT) {
    return pack("full", true, clearInput(vim), null);
  }
  const scanForward = !backward;
  const hits = matchesOf(doc, stored.pattern, stored.whole === true);
  const at = nthHit(hits, cursor, scanForward, scanForward, repeatOf(vim));
  if (at == null) return pack("full", true, clearInput(vim), null);
  const end = at + stored.pattern.length;
  const next = clearInput(vim);
  next.mode = "visual";
  next.column = null;
  next.search = { pattern: stored.pattern, forward: stored.forward !== false, whole: stored.whole === true };
  const anchor = backward ? end : at;
  const caret = backward ? at : end;
  return pack("full", true, leavingOnce(next, vim), { type: "caret", anchor, cursor: caret });
}

function submitSearch(vim, doc, cursor, pattern, forward) {
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > SEARCH_LIMIT) {
    return pack("full", true, clearInput(vim), null);
  }
  const stored = { pattern, forward: forward !== false, whole: false };
  return placeSearch(vim, doc, cursor, stored.forward, stored, 1, false);
}

function exIdle(vim) {
  const next = clearInput(vim);
  if (vim.once) {
    next.once = false;
    next.mode = "insert";
  } else next.mode = "normal";
  return pack("full", true, next, null);
}

function exHistory(vim, direction) {
  const next = clearInput(vim);
  if (vim.once) {
    next.once = false;
    next.mode = "insert";
  } else next.mode = "normal";
  return pack("full", true, next, { type: "history", direction });
}

function deleteAll(vim, doc) {
  const next = clearInput(vim);
  next.column = null;
  if (vim.once) {
    next.once = false;
    next.mode = "insert";
  } else next.mode = "normal";
  if (doc.length === 0) return pack("full", true, next, null);
  next.register = { text: doc, linewise: true };
  return pack("full", true, next, {
    type: "splice",
    from: 0,
    to: doc.length,
    text: "",
    caret: 0,
    yank: { text: doc, linewise: true },
  });
}

function sourceTextRange(doc, cursor) {
  const line = sourceLine(doc, cursor);
  return { from: line.start, to: line.start + line.text.length };
}

// The first non-blank of the line that holds offset. A blank line stays at its start.
function lineNonBlank(text, offset) {
  const from = Math.max(0, Math.min(text.length, offset));
  let start = 0;
  for (let i = from; i > 0; i -= 1) {
    if (text[i - 1] === "\n") {
      start = i;
      break;
    }
  }
  let limit = text.length;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === "\n") {
      limit = i;
      break;
    }
  }
  let index = start;
  while (index < limit && (text[index] === " " || text[index] === "\t")) index += 1;
  if (index >= limit) return start;
  return index;
}

// A slash in the field is written \/. Any other backslash stays in the text.
function readDelimited(text, start) {
  let out = "";
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === "\\" && i + 1 < text.length && text[i + 1] === "/") {
      out += "/";
      i += 1;
      continue;
    }
    if (text[i] === "/") return { text: out, next: i + 1 };
    out += text[i];
  }
  return null;
}

function parseSubstitute(rest) {
  let i = 0;
  while (i < rest.length && (rest[i] === " " || rest[i] === "\t")) i += 1;
  if (rest[i] !== "/") return null;
  const pattern = readDelimited(rest, i + 1);
  if (!pattern || pattern.text.length === 0) return null;
  const replacement = readDelimited(rest, pattern.next);
  if (!replacement) return null;
  const flags = rest.slice(replacement.next);
  if (flags !== "" && flags !== "g") return null;
  return { pattern: pattern.text, replacement: replacement.text, all: flags === "g" };
}

function applySubstitute(doc, from, to, pattern, replacement, all) {
  const slice = doc.slice(from, to);
  let built = "";
  let index = 0;
  let touch = -1;
  let count = 0;
  while (index <= slice.length - pattern.length) {
    const at = slice.indexOf(pattern, index);
    if (at < 0) break;
    built += slice.slice(index, at);
    const start = built.length;
    built += replacement;
    touch = replacement.length === 0 ? start : built.length - 1;
    count += 1;
    index = at + pattern.length;
    if (!all) break;
  }
  if (count === 0) return null;
  built += slice.slice(index);
  if (built === slice) return null;
  return { from, to, text: built, caret: from + lineNonBlank(built, touch < 0 ? 0 : touch) };
}

function submitEx(vim, doc, cursor, raw, line) {
  const text = String(line || "").replace(/^\s+/, "").replace(/\s+$/, "");
  if (text === "") return exIdle(vim);
  let i = 0;
  let range = "";
  if (text[0] === "%") {
    range = "%";
    i = 1;
    while (i < text.length && (text[i] === " " || text[i] === "\t")) i += 1;
  } else if (/[0-9.$',+\-]/.test(text[0])) return exIdle(vim);
  let j = i;
  while (j < text.length && /[A-Za-z]/.test(text[j])) j += 1;
  const name = text.slice(i, j);
  const rest = text.slice(j);
  if (!name) return exIdle(vim);
  if (name === "d" && rest === "") {
    if (range === "%") return deleteAll(vim, doc);
    if (range) return exIdle(vim);
    return repeatedLine(clearInput(vim), doc, cursor, raw, "d");
  }
  if ((name === "j" || name === "y") && rest === "" && range === "") {
    const blank = clearInput(vim);
    if (name === "j") return joinLines(blank, doc, cursor, raw, true);
    return repeatedLine(blank, doc, cursor, raw, "y");
  }
  if ((name === "u" || name === "undo") && rest === "" && range === "") return exHistory(vim, "undo");
  if ((name === "red" || name === "redo") && rest === "" && range === "") return exHistory(vim, "redo");
  if ("substitute".startsWith(name)) {
    const parsed = parseSubstitute(rest);
    if (!parsed) return exIdle(vim);
    const span = range === "%" ? { from: 0, to: doc.length } : sourceTextRange(doc, cursor);
    const applied = applySubstitute(doc, span.from, span.to, parsed.pattern, parsed.replacement, parsed.all);
    if (!applied) return exIdle(vim);
    const next = clearInput(vim);
    next.column = null;
    if (vim.once) {
      next.once = false;
      next.mode = "insert";
    } else next.mode = "normal";
    return pack("full", true, next, {
      type: "splice",
      from: applied.from,
      to: applied.to,
      text: applied.text,
      caret: applied.caret,
      yank: null,
    });
  }
  return exIdle(vim);
}

function runAction(vim, doc, anchor, cursor, raw, layout, id) {
  if (id === "D" || id === "C") {
    const motion = runMotion("$", {
      doc,
      cursor,
      anchor,
      raw,
      layout,
      count: 1,
      column: null,
      find: null,
      vim,
    });
    return finishMotion(vim, doc, anchor, cursor, raw, motion, id === "C" ? "c" : "d");
  }
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
      if (id === "x") {
        const text = forwardCut(doc, cursor);
        if (text) next.register = { text, linewise: false };
      }
      return pack("full", true, leavingOnce(next, vim), { type: id === "x" ? "forward-delete" : "backspace" });
    }
    const span = sourceSpan(doc, cursor, n, id === "X");
    if (span.from === span.to) return pack("full", true, leavingOnce(next, vim), null);
    const removed = doc.slice(span.from, span.to);
    next.register = { text: removed, linewise: false };
    return pack("full", true, leavingOnce(next, vim), {
      type: "splice",
      from: span.from,
      to: span.to,
      text: "",
      caret: span.from,
      yank: { text: removed, linewise: false },
    });
  }
  if (id === "s") {
    if (vim.mode === "visual" || vim.mode === "visual-line") return operateVisual(vim, doc, anchor, cursor, raw, "c");
    const span = sourceSpan(doc, cursor, repeatOf(vim), false);
    next.mode = "insert";
    next.once = false;
    if (span.from === span.to) return pack("full", true, next, null);
    const removed = doc.slice(span.from, span.to);
    return pack("full", true, next, {
      type: "splice",
      from: span.from,
      to: span.to,
      text: "",
      caret: span.from,
      yank: { text: removed, linewise: false },
    });
  }
  if (id === "S" || id === "R") {
    if (vim.mode === "visual-line") return operateVisual(vim, doc, anchor, cursor, raw, "c");
    if (id === "R" || vim.mode === "visual") return pack("none", true, clearInput(vim), null);
    return repeatedLine(vim, doc, cursor, raw, "c");
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
    else if (line) {
      const bounds = lineBounds(doc, cursor, raw);
      nextAnchor = bounds.start;
      nextCursor = bounds.end;
    } else {
      nextAnchor = cursor;
      nextCursor = charAfter(doc, cursor, raw);
    }
    next.mode = mode;
    if (mode === "visual" || mode === "visual-line") next.once = vim.once;
    else if (vim.once) {
      next.once = false;
      next.mode = "insert";
    }
    return pack("full", true, next, { type: "caret", anchor: nextAnchor, cursor: nextCursor });
  }
  if (id === "u") {
    if (vim.mode === "visual" || vim.mode === "visual-line") return operateVisual(vim, doc, anchor, cursor, raw, "gu");
    return pack("full", true, leavingOnce(next, vim), { type: "history", direction: "undo" });
  }
  if (id === "U") {
    if (vim.mode === "visual" || vim.mode === "visual-line") return operateVisual(vim, doc, anchor, cursor, raw, "gU");
    return pack("none", true, clearInput(vim), null);
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
    // Visual has no ex line. The command returns to Normal and writes nothing.
    if (vim.mode === "visual" || vim.mode === "visual-line") {
      next.mode = "normal";
      next.once = false;
      return pack("full", true, next, { type: "caret", anchor: cursor, cursor });
    }
    return pack("full", true, next, { type: "prompt", kind: "ex" });
  }
  if (id === "n" || id === "N") return repeatSearch(vim, doc, cursor, id === "N");
  if (id === "*" || id === "#") return starSearch(vim, doc, cursor, id === "*", true);
  if ((vim.mode === "visual" || vim.mode === "visual-line") && (id === "o" || id === "O")) {
    return pack("full", true, vim.mode === "visual" || vim.mode === "visual-line" ? { ...next, mode: vim.mode, once: vim.once } : next, {
      type: "caret",
      anchor: cursor,
      cursor: anchor,
    });
  }
  if (id === "o" || id === "O") return openLine(vim, doc, cursor, raw, id === "o");
  if (id === "J" || id === "gJ") return joinLines(vim, doc, cursor, raw, id === "J");
  if (id === "r") {
    if (vim.mode === "visual" || vim.mode === "visual-line") return pack("none", true, clearInput(vim), null);
    // The count stays in prefixRepeat until the replacement key arrives.
    return pack("partial", true, { ...vim, input: { ...vim.input, keyBuffer: "r" } }, null);
  }
  if (id === "~") return applyToggle(vim, doc, cursor, raw);
  if (id === "Y") {
    if (vim.mode === "visual" || vim.mode === "visual-line") return operateVisual(vim, doc, anchor, cursor, raw, "y");
    return repeatedLine(vim, doc, cursor, raw, "y");
  }
  return pack("none", true, leavingOnce(clearInput(vim), vim), null);
}

function replacementChar(key) {
  if (key.ctrl || key.meta || key.alt) return null;
  if (key.key === "Enter") return "\n";
  if (typeof key.key !== "string" || key.key.length < 1 || key.key.length > 2) return null;
  if (key.key.length === 2) {
    const hi = key.key.charCodeAt(0);
    const lo = key.key.charCodeAt(1);
    if (!(hi >= 0xD800 && hi <= 0xDBFF && lo >= 0xDC00 && lo <= 0xDFFF)) return null;
  }
  return key.key;
}

function finishReplace(vim, doc, cursor, raw, key) {
  const count = repeatOf(vim);
  const ch = replacementChar(key);
  const done = leavingOnce(clearInput(vim), vim);
  if (ch == null) return pack("none", true, done, null);
  const span = ordinarySpan(doc, cursor, count, raw);
  if (!span) return pack("full", true, done, null);
  done.column = null;
  // Enter writes one file break for the whole count. The caret is on that new line.
  // Any other character is repeated, and a count above 1 leaves the caret on the last.
  const enter = ch === "\n";
  const text = enter ? fileBreak(doc) : ch.repeat(count);
  let caret = span.from;
  if (enter) caret = span.from + text.length;
  else if (count > 1) caret = span.from + (count - 1) * ch.length;
  return pack("full", true, done, {
    type: "splice",
    from: span.from,
    to: span.to,
    text,
    caret,
    yank: null,
  });
}

function applyToggle(vim, doc, cursor, raw) {
  if (vim.mode === "visual" || vim.mode === "visual-line") return pack("none", true, clearInput(vim), null);
  const count = repeatOf(vim);
  const span = ordinarySpan(doc, cursor, count, raw);
  const done = leavingOnce(clearInput(vim), vim);
  if (!span) return pack("full", true, done, null);
  done.column = null;
  return pack("full", true, done, {
    type: "splice",
    from: span.from,
    to: span.to,
    text: mapCase(doc.slice(span.from, span.to), "toggle"),
    caret: span.to,
    yank: null,
  });
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
  if (k === "g" || k === "z" || k === "f" || k === "F" || k === "t" || k === "T" || k === '"' || k === "]" || k === "[") {
    return { kind: "prefix", id: k };
  }
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
  if (!key.ctrl && !key.meta && !key.alt && (key.key === "n" || key.key === "N" || key.key === "*" || key.key === "#")) {
    // An operator is not a search motion. dgn writes nothing.
    if (vim.input.operator) return pack("none", true, clearInput(vim), null);
    const ready = { ...vim, input: { ...vim.input, keyBuffer: "" } };
    if (key.key === "n" || key.key === "N") return selectSearch(ready, doc, cursor, key.key === "N");
    return starSearch(ready, doc, cursor, key.key === "*", false);
  }
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
                          : key.key === "J" ? "gJ"
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

// ]p is linewise p and [p is linewise P. The indent shift is the same splice.
function finishBracket(vim, doc, anchor, cursor, raw, key) {
  if (isEscape(key)) return doEscape(vim, anchor, cursor);
  const which = vim.input.keyBuffer;
  if (key.ctrl || key.meta || key.alt || key.key !== "p" || vim.input.operator) {
    return pack("none", true, clearInput(vim), null);
  }
  return putRegister(vim, doc, cursor, raw, which === "]", true);
}

// aw takes the spaces after the word. A word with none, as at the end of a line,
// takes the spaces before it instead. The range starts at the word, not the caret.
function wordObject(doc, cursor, around) {
  const runs = words(doc);
  let word = null;
  for (const item of runs) {
    if (cursor >= item.start && cursor < item.end) {
      word = item;
      break;
    }
  }
  if (!word) {
    for (const item of runs) {
      if (item.start > cursor) {
        word = item;
        break;
      }
    }
  }
  if (!word) {
    for (let i = runs.length - 1; i >= 0; i -= 1) {
      if (runs[i].end <= cursor) {
        word = runs[i];
        break;
      }
    }
  }
  if (!word) return null;
  const from = word.start;
  const to = word.end;
  if (!around) return { from, to };
  let trail = to;
  while (trail < doc.length && (doc[trail] === " " || doc[trail] === "\t")) trail += 1;
  if (trail > to) return { from, to: trail };
  let lead = from;
  while (lead > 0 && (doc[lead - 1] === " " || doc[lead - 1] === "\t")) lead -= 1;
  return { from: lead, to };
}

// A quote that does not close on this source line is not the object.
function quoteObject(doc, cursor, quote, around) {
  const line = sourceLine(doc, cursor);
  let open = -1;
  for (let i = line.start; i < line.end; i += 1) {
    if (doc[i] !== quote) continue;
    if (open < 0) {
      open = i;
      continue;
    }
    if (cursor >= open && cursor <= i) {
      return around ? { from: open, to: i + 1 } : { from: open + 1, to: i };
    }
    open = -1;
  }
  return null;
}

function codeObject(doc, cursor, around) {
  const line = sourceLine(doc, cursor);
  const span = codeSpanAt(line.text, cursor - line.start);
  if (!span) return null;
  const base = line.start;
  if (around) return { from: base + span.open, to: base + span.close + 1 };
  return { from: base + span.start, to: base + span.end };
}

function linkObject(doc, cursor, around) {
  const line = sourceLine(doc, cursor);
  const span = linkSpanAt(line.text, cursor - line.start);
  if (!span) return null;
  const base = line.start;
  if (around) return { from: base + span.labelStart - 1, to: base + span.labelEnd + 1 };
  return { from: base + span.labelStart, to: base + span.labelEnd };
}

function blankLock(span) {
  return span.start === span.end;
}

// ip stops before the block's own newline. ap also takes the blank lines after
// it, and the blank lines before it when nothing follows.
function paragraphObject(doc, cursor, around) {
  const spans = lockSpans(doc);
  let index = -1;
  for (let i = 0; i < spans.length; i += 1) {
    if (cursor >= spans[i].start && cursor <= spans[i].end) {
      index = i;
      break;
    }
  }
  if (index < 0) return null;
  const span = spans[index];
  if (!around) {
    if (span.start >= span.end) return null;
    return { from: span.start, to: span.end };
  }
  let next = index + 1;
  while (next < spans.length && blankLock(spans[next])) next += 1;
  if (next > index + 1) {
    const to = next < spans.length ? spans[next].start : doc.length;
    if (span.start >= to) return null;
    return { from: span.start, to };
  }
  let prev = index;
  while (prev > 0 && blankLock(spans[prev - 1])) prev -= 1;
  const from = spans[prev].start;
  let to = span.end;
  if (to < doc.length && doc[to] === "\n") to += 1;
  if (from >= to) return null;
  return { from, to };
}

function objectSpan(doc, cursor, ch, around) {
  if (ch === "w" || ch === "W") return wordObject(doc, cursor, around);
  if (ch === "`") return codeObject(doc, cursor, around);
  if (ch === '"' || ch === "'") return quoteObject(doc, cursor, ch, around);
  if (ch === "[" || ch === "]") return linkObject(doc, cursor, around);
  if (ch === "p") return paragraphObject(doc, cursor, around);
  return null;
}

function finishObject(vim, doc, anchor, cursor, key) {
  if (isEscape(key)) return doEscape(vim, anchor, cursor);
  const ch = key.key;
  if (key.ctrl || key.meta || key.alt || ch.length !== 1) return pack("none", true, clearInput(vim), null);
  const span = objectSpan(doc, cursor, ch, vim.input.keyBuffer === "a");
  if (!span || !(span.from < span.to)) return pack("none", true, clearInput(vim), null);
  const { from, to } = span;
  const operator = vim.input.operator;
  if (!operator && (vim.mode === "visual" || vim.mode === "visual-line")) {
    const next = clearInput(vim);
    next.mode = "visual";
    return pack("full", true, next, { type: "caret", anchor: from, cursor: to });
  }
  if (indentOp(operator)) return applyIndent(vim, doc, from, to, operator);
  if (operator !== "d" && operator !== "c" && operator !== "y") return pack("none", true, clearInput(vim), null);
  const motion = { cursor, origin: cursor, linewise: false, inclusive: false, past: false, word: false };
  const applied = applyRange(operator, doc, { from, to, originCaret: cursor }, motion, vim);
  const next = clearInput(vim);
  if (!applied) return pack("none", true, next, null);
  next.mode = applied.mode;
  if (applied.register) next.register = applied.register;
  else next.register = { text: doc.slice(from, to), linewise: false };
  if (operator === "c" || vim.once) {
    next.once = false;
    next.mode = "insert";
  }
  return pack("full", true, next, applied.effect);
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

// The caret was on a character. A tab added or removed at the source start
// moves that character, and the caret moves with it.
function insertTab(vim, doc, cursor, add) {
  const line = sourceLine(doc, cursor);
  const next = clearInput(vim);
  next.mode = "insert";
  if (add) {
    return pack("full", true, next, {
      type: "splice",
      from: line.start,
      to: line.start,
      text: "\t",
      caret: cursor + 1,
      yank: null,
    });
  }
  if (line.start >= doc.length || doc[line.start] !== "\t") return pack("full", true, next, null);
  return pack("full", true, next, {
    type: "splice",
    from: line.start,
    to: line.start + 1,
    text: "",
    caret: cursor > line.start ? cursor - 1 : cursor,
    yank: null,
  });
}

function insertKey(vim, doc, cursor, key) {
  if (isEscape(key)) return doEscape(vim, cursor, cursor);
  const id = key.key.length === 1 ? key.key.toLowerCase() : key.key;
  if ((key.ctrl || key.meta) && id === "w") return pack("full", true, clearInput(vim), { type: "word-delete" });
  if (key.ctrl && id === "t") return insertTab(vim, doc, cursor, true);
  if (key.ctrl && id === "d") return insertTab(vim, doc, cursor, false);
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
  if (vim.input.keyBuffer === "r") return finishReplace(vim, doc, cursor, raw, key);
  if (vim.input.keyBuffer === '"') return finishQuote(vim, anchor, cursor, key);
  if (vim.input.keyBuffer === "g") return finishG(vim, doc, anchor, cursor, raw, layout, key);
  if (vim.input.keyBuffer === "z") return finishZ(vim, doc, anchor, cursor, raw, layout, key);
  if (vim.input.keyBuffer === "]" || vim.input.keyBuffer === "[") return finishBracket(vim, doc, anchor, cursor, raw, key);
  if (vim.input.keyBuffer === "i" || vim.input.keyBuffer === "a") return finishObject(vim, doc, anchor, cursor, key);

  const ready = commitDigits(vim);
  const cmd = commandFromKey(key);
  if (cmd.kind === "prefix") return startPrefix(ready, cmd.id);
  if (cmd.kind === "operator") return dispatchResolved(ready, doc, anchor, cursor, raw, layout, cmd.id, null);
  if (cmd.kind === "motion") return dispatchResolved(ready, doc, anchor, cursor, raw, layout, cmd.id, null);
  if (cmd.kind === "action") return dispatchResolved(ready, doc, anchor, cursor, raw, layout, cmd.id, null);
  return pack("none", true, leavingOnce(clearInput(ready), ready), null);
}

export function vimSubmit(input) {
  const src = input || {};
  if (src.flag === false) return pack("none", false, cloneVim(src.vim), null);
  const vim = cloneVim(src.vim);
  const doc = typeof src.doc === "string" ? src.doc : "";
  const cursor = clamp(src.cursor, doc.length);
  const raw = src.raw === true;
  const line = typeof src.line === "string" ? src.line : "";
  if (src.kind === "search") return submitSearch(vim, doc, cursor, line, src.forward !== false);
  if (src.kind === "ex") return submitEx(vim, doc, cursor, raw, line);
  return pack("none", true, vim, null);
}
