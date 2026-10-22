// Pure key match. The page applies the effect. This module does not touch the editor.
import { backspace, codeFenceBodies, codeSpanAt, commentStorageReason, commentThreads, createState, deleteForward, endBeforeTail, findSpans, imageLine, insert, lineCaret, linkSpanAt, lockSpans, markerSplice, plan, skipHidden, snapSourceFenceLines, sourceLine, sourceLineComment, wordStop } from "./doc.js";

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

function copyKey(key) {
  const src = key || {};
  return {
    key: typeof src.key === "string" ? src.key : "",
    ctrl: src.ctrl === true,
    meta: src.meta === true,
    alt: src.alt === true,
    shift: src.shift === true,
  };
}

function copyChange(change) {
  if (!change || typeof change !== "object") return null;
  const visual = change.visual && typeof change.visual === "object"
    ? {
      mode: change.visual.mode === "visual-line" ? "visual-line" : "visual",
      lines: Number.isInteger(change.visual.lines) ? change.visual.lines : 0,
      chars: Number.isInteger(change.visual.chars) ? change.visual.chars : 0,
      lastChars: Number.isInteger(change.visual.lastChars) ? change.visual.lastChars : 0,
    }
    : null;
  return {
    count: Number.isInteger(change.count) ? change.count : null,
    keys: Array.isArray(change.keys) ? change.keys.map(copyKey) : [],
    insert: change.insert === "repeat" || change.insert === "interlace" || change.insert === "once" ? change.insert : null,
    enter: typeof change.enter === "string" ? change.enter : null,
    log: Array.isArray(change.log) ? change.log.map(copyEntry) : null,
    visual,
    nested: change.nested === true,
  };
}

function copyEntry(entry) {
  if (!entry || typeof entry !== "object") return { t: "text", text: "" };
  if (entry.t === "text") return { t: "text", text: typeof entry.text === "string" ? entry.text : "" };
  if (entry.t === "edit") return { t: "edit", change: copyChange(entry.change) };
  return { t: typeof entry.t === "string" ? entry.t : "text" };
}

function copyRecording(recording) {
  if (!recording || typeof recording !== "object") return null;
  const visual = recording.visual && typeof recording.visual === "object"
    ? {
      mode: recording.visual.mode === "visual-line" ? "visual-line" : "visual",
      lines: Number.isInteger(recording.visual.lines) ? recording.visual.lines : 0,
      chars: Number.isInteger(recording.visual.chars) ? recording.visual.chars : 0,
      lastChars: Number.isInteger(recording.visual.lastChars) ? recording.visual.lastChars : 0,
    }
    : null;
  return {
    count: Number.isInteger(recording.count) ? recording.count : null,
    keys: Array.isArray(recording.keys) ? recording.keys.map(copyKey) : [],
    insert: recording.insert || null,
    enter: typeof recording.enter === "string" ? recording.enter : null,
    log: Array.isArray(recording.log) ? recording.log.map(copyEntry) : [],
    visual,
    baseDoc: typeof recording.baseDoc === "string" ? recording.baseDoc : null,
    baseCursor: Number.isInteger(recording.baseCursor) ? recording.baseCursor : 0,
    baseAnchor: Number.isInteger(recording.baseAnchor) ? recording.baseAnchor : 0,
    raw: recording.raw === true,
  };
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
    strokes: Array.isArray(src.strokes) ? src.strokes.map(copyKey) : [],
    change: copyChange(src.change),
    recording: copyRecording(src.recording),
    replaying: src.replaying === true,
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

function unitsUntil(doc, from, to) {
  let n = 0;
  let at = from;
  while (at < to && n < REPEAT_CAP) {
    at += unitLen(doc, at);
    n += 1;
  }
  return n;
}

function visualMode(vim) {
  return !!vim && (vim.mode === "visual" || vim.mode === "visual-line");
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

// The source lines of a closed table. end is the line's newline, or the
// block's end when the last row has none.
function sourceRows(doc, start, end) {
  const rows = [];
  let at = start;
  while (at <= end && at <= doc.length) {
    let stop = at;
    while (stop < end && stop < doc.length && doc[stop] !== "\n") stop += 1;
    rows.push({ start: at, end: stop });
    if (stop >= end || stop >= doc.length || doc[stop] !== "\n") break;
    at = stop + 1;
  }
  return rows;
}

function fenceCloseText(text) {
  if (typeof text !== "string") return false;
  let index = 0;
  while (index < text.length && text[index] === " ") index += 1;
  if (index > 3) return false;
  const ch = text[index];
  if (ch !== "`" && ch !== "~") return false;
  let size = 0;
  while (index < text.length && text[index] === ch) {
    size += 1;
    index += 1;
  }
  if (size < 3) return false;
  while (index < text.length && (text[index] === " " || text[index] === "\t")) index += 1;
  return index === text.length;
}

function headingBlock(block) {
  const classes = block && block.classes;
  if (!classes) return false;
  for (let level = 1; level <= 6; level += 1) {
    if (classes.includes(`md-h${level}`)) return true;
  }
  return false;
}

function diagramEnds(doc) {
  const ends = [];
  for (const block of plan(doc, -1).blocks) {
    if (block && block.type === "diagram" && typeof block.end === "number") ends.push(block.end);
  }
  return ends;
}

function renderedLines(doc, cursor, expandFences) {
  const blocks = plan(doc, cursor).blocks;
  const bodies = expandFences ? codeFenceBodies(doc) : null;
  let ends = null;
  const lines = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (block.classes && block.classes.includes("md-paragraph-gap")) continue;
    if (typeof block.start !== "number" || typeof block.end !== "number") continue;
    // j and k step a line of code. The fence stays one block for a linewise delete.
    if (bodies && block.fence) {
      const fence = bodies.find((item) => item.start === block.start);
      if (fence) {
        for (const line of fence.lines) lines.push({ start: line.start, end: line.end });
        continue;
      }
    }
    // A gap is already skipped. The first of two blanks after a fence is drawn
    // while the caret stands on it, and that row is still not a vim line. A
    // further blank stays a line, and so does the row when nothing follows.
    // The blank under a heading is the same kind of stop: nothing is drawn
    // there, unless the caret is already standing on it. An opened diagram
    // draws its closer as a source line, so the pad under it is not a gap yet.
    // A step onto it closes the diagram and this list then drops the row, so k
    // steps back from the last line.
    const prev = blocks[i - 1];
    if (block.empty && prev && i + 1 < blocks.length) {
      if (prev.fence) continue;
      if (!block.raw && headingBlock(prev) && !blocks[i + 1].empty) continue;
      if (prev.type === "line" && !prev.empty && fenceCloseText(prev.text)) {
        if (!ends) ends = diagramEnds(doc);
        if (ends.includes(prev.end)) continue;
      }
    }
    const line = { start: block.start, end: block.end };
    // k lands on the last row. The block stays one vim line for a linewise delete.
    if (block.type === "table") line.table = true;
    lines.push(line);
  }
  if (lines.length === 0) lines.push({ start: 0, end: Math.min(doc.length, 0) });
  return lines;
}

// The caret is on a line of code. Opener and closer are not.
function fenceBodyAt(doc, offset) {
  for (const fence of codeFenceBodies(doc)) {
    for (const line of fence.lines) {
      if (offset >= line.start && offset <= line.end) return line;
    }
  }
  return null;
}

// Both ends sit on lines of one code fence. A motion that starts outside does not.
function fenceBodyLines(doc, fromOff, toOff) {
  const lo = Math.min(fromOff, toOff);
  const hi = Math.max(fromOff, toOff);
  for (const fence of codeFenceBodies(doc)) {
    const lines = fence.lines;
    if (lo >= lines[0].start && hi <= lines[lines.length - 1].end) return lines;
  }
  return null;
}

// The caret is on the opener or the closer, which j and k do not land on.
function fenceMarkerGap(doc, lines, cursor) {
  for (const fence of codeFenceBodies(doc)) {
    if (cursor < fence.start || cursor > fence.end) continue;
    for (const line of fence.lines) {
      if (cursor >= line.start && cursor <= line.end) return null;
    }
    let prev = -1;
    let next = lines.length;
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].end < cursor) prev = i;
      else if (lines[i].start > cursor && next === lines.length) next = i;
    }
    return { prev, next };
  }
  return null;
}

function vimLines(doc, cursor, raw) {
  return raw ? rawLines(doc) : renderedLines(doc, cursor);
}

// A final newline ends the last line. The empty row at length is not one.
function gLines(doc, cursor, raw) {
  const lines = vimLines(doc, cursor, raw);
  const last = lines[lines.length - 1];
  if (lines.length > 1 && last.start === doc.length && doc.endsWith("\n")) return lines.slice(0, -1);
  return lines;
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

// The Normal block caret covers one glyph. A break is not a glyph, so a column
// past the line stops on the last character. An empty line has only the break.
function glyphOnLine(doc, at, line) {
  if (at > line.start && (at >= doc.length || breaksLine(doc, at))) return stepBack(doc, at);
  return at;
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

function columnInLine(line, limit, offset) {
  return offset >= line.start && offset <= limit;
}

// A list item inside a quote drops "> " even on the cursor line. A column in
// that prefix has no glyph, so the page has nowhere to draw the caret.
function restOnDrawn(doc, line, offset, direction, limit) {
  const blocks = plan(doc, offset).blocks;
  let block = null;
  for (const item of blocks) {
    if (!item || typeof item.start !== "number" || typeof item.end !== "number") continue;
    if (item.classes && item.classes.includes("md-paragraph-gap")) continue;
    if (offset < item.start || offset > item.end) continue;
    block = item;
  }
  if (!block || block.type !== "line") return offset;
  // A spaces-only line draws no glyphs. Its caret is the slot, not the break after it.
  if (typeof block.slot === "number" && offset === block.slot && columnInLine(line, limit, block.slot)) return offset;
  const parts = [];
  for (const part of block.parts || []) {
    if (!part || typeof part.start !== "number" || typeof part.end !== "number") continue;
    if (part.end < part.start) continue;
    parts.push(part);
  }
  if (parts.length === 0) return offset;
  for (const part of parts) {
    if (offset >= part.start && offset <= part.end) return offset;
  }
  const forward = () => {
    let next = null;
    for (const part of parts) {
      if (part.start < offset || !columnInLine(line, limit, part.start)) continue;
      if (next == null || part.start < next) next = part.start;
    }
    return next;
  };
  const backward = () => {
    let prev = null;
    for (const part of parts) {
      if (part.end > offset || !columnInLine(line, limit, part.end)) continue;
      if (prev == null || part.end > prev) prev = part.end;
    }
    return prev;
  };
  const toward = direction < 0 ? backward() : forward();
  const other = direction < 0 ? forward() : backward();
  const snapped = toward == null ? other : toward;
  return snapped == null ? offset : snapped;
}

function drawnColumn(doc, line, offset, direction, raw, limit) {
  if (raw || !columnInLine(line, limit, offset)) return offset;
  const snapped = restOnDrawn(doc, line, offset, direction, limit);
  if (snapped === offset || !columnInLine(line, limit, snapped)) return offset;
  const edged = hiddenEdge(doc, snapped, direction, raw);
  if (columnInLine(line, limit, edged)) return edged;
  return snapped;
}

// lineDollar is the break after the last glyph. A column on a code line stops
// on that glyph, the same as any other Normal line.
function codeColumnLimit(doc, line, limit) {
  if (!fenceBodyAt(doc, line.start)) return limit;
  let end = limit;
  if (end > line.start && end < doc.length && (doc[end] === "\n" || doc[end] === "\r")) end -= 1;
  else if (end > line.start && end === doc.length) end -= 1;
  if (end > line.start && doc[end] === "\r") end -= 1;
  return end;
}

function placeColumn(doc, line, column, raw, direction, exclusive) {
  let limit = lineDollar(doc, line);
  if (!raw) limit = codeColumnLimit(doc, line, limit);
  const stop = exclusive ? limit : glyphOnLine(doc, limit, line);
  let offset = line.start + (column < 0 ? 0 : column);
  if (offset > stop) offset = stop;
  if (offset < line.start) offset = line.start;
  offset = lineCaret(doc, offset);
  offset = endBeforeTail(doc, offset);
  // A bare break's caret is its newline. That choice stays. A snap past the
  // last glyph of a line that has one does not.
  const holdBreak = exclusive || offset > stop;
  const finish = (at) => (!holdBreak && at > stop ? stop : at);
  const edged = hiddenEdge(doc, offset, direction, raw);
  if (columnInLine(line, limit, edged)) return finish(drawnColumn(doc, line, edged, direction, raw, limit));
  const back = hiddenEdge(doc, offset, -1, raw);
  if (columnInLine(line, limit, back)) return finish(drawnColumn(doc, line, back, -1, raw, limit));
  const fwd = hiddenEdge(doc, offset, 1, raw);
  if (columnInLine(line, limit, fwd)) return finish(drawnColumn(doc, line, fwd, 1, raw, limit));
  if (offset < line.start) return line.start;
  if (!holdBreak && offset > stop) return stop;
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

// A closed table is one block, so the line above starts at the header.
// k rests on the last row, and the open table then walks one row at a time.
function backwardTableRow(doc, line) {
  if (!line || !line.table) return line;
  const rows = sourceRows(doc, line.start, line.end);
  return rows.length > 0 ? rows[rows.length - 1] : line;
}

// One step from a fence marker lands on the code line beside it. A count keeps going.
function stepMarkerGap(gap, delta, count, length) {
  const steps = count < 1 ? 1 : count;
  if (delta > 0) {
    if (gap.next >= length) return -1;
    if (steps === 1) return gap.next;
    return stepLine(gap.next, 1, steps - 1, length);
  }
  if (gap.prev < 0) return -1;
  if (steps === 1) return gap.prev;
  return stepLine(gap.prev, -1, steps - 1, length);
}

function paragraphGapAt(doc, cursor) {
  for (const block of plan(doc, cursor).blocks) {
    if (!block || !block.classes || !block.classes.includes("md-paragraph-gap")) continue;
    if (typeof block.start !== "number" || typeof block.end !== "number") continue;
    if (cursor >= block.start && cursor <= block.end) return true;
  }
  return false;
}

// The caret sits on a pad this list does not draw. prev is the line above it.
function gapHole(lines, cursor) {
  let prev = -1;
  let next = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].end < cursor) prev = i;
    else if (lines[i].start > cursor && next === lines.length) next = i;
  }
  return { prev, next };
}

// The newline after a standalone picture is a paragraph gap, so it is not a
// vim line. lineIndex calls that caret the last line, and Home leaves the
// picture. The picture is the vim line this gap follows.
function pictureBeforeGap(doc, cursor, raw) {
  if (raw || cursor <= 0 || cursor > doc.length) return null;
  if (!paragraphGapAt(doc, cursor)) return null;
  const lines = vimLines(doc, cursor, false);
  const prev = gapHole(lines, cursor).prev;
  if (prev < 0) return null;
  const line = lines[prev];
  if (line.end >= doc.length || doc[line.end] !== "\n" || cursor !== line.end + 1) return null;
  if (!imageLine(doc.slice(line.start, line.end))) return null;
  return line;
}

function moveVertical(doc, cursor, delta, count, raw, column, exclusive) {
  const lines = raw ? rawLines(doc) : renderedLines(doc, cursor, true);
  let index = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (cursor >= lines[i].start && cursor <= lines[i].end) {
      index = i;
      break;
    }
  }
  // A pad is not the last line. lineIndex would say it was, and k would step
  // back from the end.
  let marker = null;
  let hole = null;
  if (index < 0 && !raw) {
    marker = fenceMarkerGap(doc, lines, cursor);
    if (!marker && paragraphGapAt(doc, cursor)) hole = gapHole(lines, cursor);
  }
  let col = column;
  if (col == null) {
    if (index >= 0) col = cursor - lines[index].start;
    else if (marker || hole) col = cursor - sourceLine(doc, cursor).start;
    else col = columnOf(doc, cursor, raw);
  }
  let next;
  if (index >= 0) next = stepLine(index, delta, count, lines.length);
  else if (!raw && doc.endsWith("\n") && cursor >= doc.length) {
    index = lines.length;
    next = stepLine(index, delta, count, lines.length);
  } else if (marker || hole) {
    index = -2;
    next = stepMarkerGap(marker || hole, delta, count, lines.length);
  } else if (!raw) {
    index = lineIndex(lines, doc, cursor, false);
    next = stepLine(index, delta, count, lines.length);
  } else {
    index = lineIndex(lines, doc, cursor, true);
    next = stepLine(index, delta, count, lines.length);
  }
  if (next === index || next < 0 || next >= lines.length) return { cursor, column: col, linewise: true };
  let line = lines[next];
  if (!raw && delta < 0) line = backwardTableRow(doc, line);
  const landed = placeColumn(doc, line, col, raw, delta, exclusive);
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
  if (!raw) {
    const body = fenceBodyAt(doc, offset);
    if (body) return body;
  }
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
    // l is a page step. Past the last glyph that step lands on the break, and
    // the block caret covers nothing. Stop on the glyph instead.
    if (id === "l" && !visualMode(spec.vim) && !(spec.vim && spec.vim.input && spec.vim.input.operator)) {
      const line = lineBounds(doc, cursor, raw);
      const end = dollarOffset(doc, cursor, raw);
      const glyph = glyphOnLine(doc, end, line);
      if (glyph < end) {
        if (cursor >= glyph) return { kind: "stay", column: null };
        if (unitsUntil(doc, cursor, glyph) < count) {
          return { kind: "caret", cursor: glyph, column: null, linewise: false, inclusive: false, past: false, word: false };
        }
      }
    }
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
    const moved = moveVertical(doc, cursor, delta, size * count, raw, keep, visualMode(spec.vim));
    return { kind: "caret", ...moved, inclusive: false, past: false, word: false };
  }
  if (id === "j" || id === "k") {
    const moved = moveVertical(doc, cursor, id === "j" ? 1 : -1, count, raw, keep, visualMode(spec.vim));
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
    const lines = gLines(doc, cursor, raw);
    const numbered = typedCount(spec.vim);
    if (numbered == null) {
      if (id === "gg") {
        const at = legal(doc, lines[0] ? lines[0].start : 0, 1, raw);
        return { kind: "caret", cursor: at, column: null, linewise: true, inclusive: false, past: false, word: false };
      }
      // G is the first non-blank, the same stop as + and ^. The end is $.
      const line = lines[lines.length - 1];
      const at = line ? firstNonBlank(doc, line, raw) : 0;
      return { kind: "caret", cursor: at, column: null, linewise: true, inclusive: false, past: false, word: false };
    }
    const index = Math.max(0, Math.min(lines.length - 1, numbered - 1));
    const moved = placeColumn(doc, lines[index], keep == null ? columnOf(doc, cursor, raw) : keep, raw, 1, visualMode(spec.vim));
    return { kind: "caret", cursor: moved, column: keep == null ? columnOf(doc, cursor, raw) : keep, linewise: true, inclusive: false, past: false, word: false };
  }
  if (id === "0") {
    const line = pictureBeforeGap(doc, cursor, raw) || lineBounds(doc, cursor, raw);
    return { kind: "caret", cursor: legal(doc, line.start, 1, raw), column: null, linewise: false, inclusive: false, past: false, word: false };
  }
  if (id === "^") {
    const line = lineBounds(doc, cursor, raw);
    return { kind: "caret", cursor: firstNonBlank(doc, line, raw), column: null, linewise: false, inclusive: false, past: false, word: false };
  }
  if (id === "$") {
    const end = dollarOffset(doc, cursor, raw);
    const line = lineBounds(doc, cursor, raw);
    const glyph = glyphOnLine(doc, end, line);
    const parked = glyph !== end;
    return {
      kind: "caret",
      cursor: parked ? glyph : end,
      end,
      column: null,
      linewise: false,
      inclusive: true,
      past: !parked,
      cover: parked,
      word: false,
    };
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

// True when this offset sits in a table the closed plan still draws as one block.
function opensTable(doc, offset) {
  for (const block of plan(doc, -1).blocks) {
    if (block.type === "table" && offset >= block.start && offset <= block.end) return true;
  }
  return false;
}

function linewiseRange(doc, fromOff, toOff, raw) {
  // Planning at the caret inside the table opens it and drops the blank under
  // that one line, so a delete started below the table runs through the line after.
  // A visual line that stays inside one code fence covers those code lines.
  // A motion from outside still names the fence as one block.
  const bodies = !raw ? fenceBodyLines(doc, fromOff, toOff) : null;
  const planAt = !raw && opensTable(doc, toOff) && !opensTable(doc, fromOff) ? fromOff : Math.min(fromOff, toOff);
  const origin = bodies || vimLines(doc, planAt, raw);
  const a = lineIndex(origin, doc, fromOff, raw);
  const b = lineIndex(origin, doc, toOff, raw);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const start = origin[Math.min(lo, origin.length - 1)].start;
  const last = hi >= origin.length ? origin[origin.length - 1] : origin[hi];
  return { from: start, to: endPast(doc, last) };
}

function pastLastCommentFence(doc, cursor) {
  const threads = commentThreads(typeof doc === "string" ? doc : "");
  let end = -1;
  for (const thread of threads) {
    if (typeof thread.end === "number" && thread.end > end) end = thread.end;
  }
  return end >= 0 && cursor >= end;
}

// A caret past the last fence is not on a row inside the stored comments.
// The last drawn row there is the blank between fences, and deleting it
// would leave the caret with no line.
function countedLines(doc, origin, count, raw) {
  const lines = vimLines(doc, origin, raw);
  let index = lineIndex(lines, doc, origin, raw);
  if (index >= lines.length) {
    if (!raw && pastLastCommentFence(doc, origin)) return { from: origin, to: origin };
    index = lines.length - 1;
  }
  if (index < 0 || lines.length === 0) return { from: origin, to: origin };
  const last = Math.min(lines.length - 1, index + count - 1);
  const from = lines[index].start;
  const to = endPast(doc, lines[last]);
  if (!raw && from < to && commentStorageReason(doc, [{ from, to, inserted: "" }])) return { from: origin, to: origin };
  return { from, to };
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
  if (forward && motion.inclusive && !motion.past && to < doc.length) {
    if (motion.cursor > origin || motion.cover) to += unitLen(doc, to);
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

// plan does not draw a comment fence. A caret left on one has no line, so the
// page paints it at the start of the editor. The empty row after a final newline
// is the bottom when nothing drawn follows the fence.
function offsetOnDrawn(doc, offset) {
  const at = Math.max(0, Math.min(doc.length, Number.isFinite(offset) ? Math.trunc(offset) : 0));
  const blocks = plan(doc, at).blocks;
  const drawn = [];
  for (const block of blocks) {
    if (!block || typeof block.start !== "number" || typeof block.end !== "number") continue;
    if (block.classes && block.classes.includes("md-paragraph-gap")) continue;
    drawn.push(block);
    if (at >= block.start && at <= block.end) return at;
  }
  if (doc.endsWith("\n") && at >= doc.length) return doc.length;
  let prev = null;
  let next = null;
  for (const block of drawn) {
    if (block.end < at) prev = block.end;
    else if (block.start > at && next == null) next = block.start;
  }
  if (next == null && doc.endsWith("\n")) return doc.length;
  if (prev == null) return next == null ? at : next;
  if (next == null) return prev;
  return at - prev <= next - at ? prev : next;
}

function drawnDeleteCaret(doc, from, to, inserted, wanted) {
  const nextDoc = doc.slice(0, from) + inserted + doc.slice(to);
  let at = wanted;
  if (at >= to) at += inserted.length - (to - from);
  else if (at > from) at = from + inserted.length;
  if (at < 0) at = 0;
  if (at > nextDoc.length) at = nextDoc.length;
  return offsetOnDrawn(nextDoc, at);
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
  const stored = linewiseText(doc, removed, linewise);
  if (op === "y") {
    const caret = motion && motion.cursor < (motion.origin == null ? from : motion.origin) ? from : motion && motion.cursor < from ? from : null;
    return {
      effect: {
        type: "splice",
        from,
        to,
        text: removed,
        caret: caret == null ? (motion && motion.cursor >= (range.originCaret || from) ? range.originCaret : from) : caret,
        yank: { text: stored, linewise },
      },
      register: { text: stored, linewise },
      mode: vim.mode,
    };
  }
  const kept = keptMarker(doc, from, to);
  const text = kept ? kept.text : "";
  let caret = kept ? kept.caret : legal(doc, from, 1, false);
  if (op === "d" && !kept) caret = drawnDeleteCaret(doc, from, to, text, caret);
  if (op === "d") {
    return {
      effect: { type: "splice", from, to, text, caret, yank: { text: stored, linewise } },
      register: { text: stored, linewise },
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
      effect: { type: "splice", from, to, text: changeText, caret: changeCaret, yank: { text: stored, linewise } },
      register: { text: stored, linewise },
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

// A vim line can end on the last byte. The put still opens a line there, and a
// register that is already a newline is not dropped.
function putLead(doc, at) {
  if (at > 0 && doc[at - 1] !== "\n") return fileBreak(doc);
  return "";
}

function linewisePutText(doc, at, text, raw, after) {
  const headed = putLead(doc, at) + text;
  const body = headed.endsWith("\n") ? headed : headed + "\n";
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
  // The motion lands on a column. A visual line is the whole line, so a shorter
  // line is not cut off at that column. The stored column is the one j and k keep.
  if (vim.mode === "visual-line") {
    const origin = lineBounds(doc, anchor, raw);
    const dest = lineBounds(doc, at, raw);
    const forward = dest.start >= origin.start;
    return pack("full", true, leavingOnce(next, vim), {
      type: "caret",
      anchor: forward ? origin.start : origin.end,
      cursor: forward ? dest.end : dest.start,
    });
  }
  if (vim.mode === "visual") {
    let landed = at;
    // The glyph a motion stops on is part of the selection. The stored caret is
    // the exclusive end, one unit later, and the block is drawn on that glyph.
    // $ already names the exclusive end. A forward word keeps that end even
    // while the landing is still the low end.
    const glyph = at < doc.length && doc[at] !== "\n" && doc[at] !== "\r";
    if (motion.cover && Number.isInteger(motion.end)) {
      landed = motion.end;
    } else if (glyph && motion.word && at > cursor) {
      landed = at + unitLen(doc, at);
    } else if (glyph && !motion.word && at !== cursor && at > anchor) {
      landed = at + unitLen(doc, at);
      // j and k keep this column. The exclusive end is one unit later, and that
      // unit is not the column the motion stopped on.
      if (next.column == null) next.column = columnOf(doc, at, raw);
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
  const stored = linewiseText(doc, removed, span.linewise);
  if (op === "y") {
    next.register = { text: stored, linewise: span.linewise };
    return pack("full", true, next, {
      type: "splice",
      from: span.from,
      to: span.to,
      text: removed,
      caret: span.linewise ? span.from : anchor,
      yank: { text: stored, linewise: span.linewise },
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
  next.register = { text: stored, linewise: span.linewise };
  return pack("full", true, next, {
    type: "splice",
    from: span.from,
    to: span.to,
    text,
    caret,
    yank: { text: stored, linewise: span.linewise },
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

// Character visual stores the high end one past the last glyph. The block
// covers that glyph, so the character under the caret is inside the selection.
export function visualBlockOffset(doc, anchor, cursor, mode) {
  const text = typeof doc === "string" ? doc : "";
  if (mode !== "visual" || !(cursor > anchor)) return cursor;
  const at = cursor > text.length ? text.length : cursor;
  if (at <= 0) return cursor;
  return stepBack(text, at);
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
  if (!after || after.refused || typeof after.doc !== "string" || after.doc === doc) return "";
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

// The splice keeps the bytes on the line. A linewise register still ends on a
// break, and a register that is already a newline stays that newline.
function linewiseText(doc, text, linewise) {
  if (!linewise || text.endsWith("\n")) return text;
  return text + fileBreak(doc);
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
    const lead = putLead(doc, at);
    let text = linewisePutText(doc, at, reg.text, raw, after);
    if (adjust) text = shiftInserted(doc, at, text);
    const caret = putCaret(at + lead.length, text.slice(lead.length));
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
export const VIM_SEARCH_LIMIT = SEARCH_LIMIT;

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

// Literal offsets, the same matches / and ? use. The page paints these.
export function vimMatchStarts(doc, pattern, whole) {
  const text = typeof doc === "string" ? doc : "";
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > SEARCH_LIMIT) return [];
  return matchesOf(text, pattern, whole === true);
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

function matchesEx(name, full, short) {
  return full.startsWith(name) && name.length >= short.length;
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
  const stored = linewiseText(doc, doc, true);
  next.register = { text: stored, linewise: true };
  return pack("full", true, next, {
    type: "splice",
    from: 0,
    to: doc.length,
    text: "",
    caret: 0,
    yank: { text: stored, linewise: true },
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
  if (matchesEx(name, "delete", "d") && rest === "") {
    if (range === "%") return deleteAll(vim, doc);
    if (range) return exIdle(vim);
    return repeatedLine(clearInput(vim), doc, cursor, raw, "d");
  }
  if (matchesEx(name, "join", "j") && rest === "" && range === "") {
    return joinLines(clearInput(vim), doc, cursor, raw, true);
  }
  if (matchesEx(name, "yank", "y") && rest === "" && range === "") {
    return repeatedLine(clearInput(vim), doc, cursor, raw, "y");
  }
  if (matchesEx(name, "undo", "u") && rest === "" && range === "") return exHistory(vim, "undo");
  if (matchesEx(name, "redo", "red") && rest === "" && range === "") return exHistory(vim, "redo");
  // Paint is page state. The pattern stays, so n still repeats.
  if (matchesEx(name, "nohlsearch", "noh") && rest === "" && range === "") {
    const next = clearInput(vim);
    if (vim.once) {
      next.once = false;
      next.mode = "insert";
    } else next.mode = "normal";
    return pack("full", true, next, { type: "nohlsearch" });
  }
  if (matchesEx(name, "substitute", "s")) {
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

// x and X stay on the line. A break is not a character, and an empty line has none.
function refusesLineBreak(doc, cursor, backward) {
  if (backward) {
    if (cursor <= 0) return true;
    if (doc[cursor - 1] === "\n") return true;
    if (doc[cursor - 1] === "\r" && cursor < doc.length && doc[cursor] === "\n") return true;
    return false;
  }
  if (cursor >= doc.length) return true;
  return breaksLine(doc, cursor);
}

// The last glyph of the line. Cutting it with the page delete would leave the
// caret on the break. The splice parks on the glyph that remains.
function takesPlainGlyph(doc, cursor) {
  if (cursor < 0 || cursor >= doc.length || breaksLine(doc, cursor)) return false;
  if (markerChar(doc, cursor) || commentMarkerSpan(doc, cursor)) return false;
  const atoms = plan(doc, cursor).atoms;
  if (atoms && atoms.some((atom) => cursor >= atom.start && cursor < atom.end)) return false;
  const next = cursor + unitLen(doc, cursor);
  return next >= doc.length || breaksLine(doc, next);
}

function cutPlainGlyph(vim, prior, doc, cursor) {
  const len = unitLen(doc, cursor);
  const text = doc.slice(cursor, cursor + len);
  const line = sourceLine(doc, cursor);
  const caret = cursor > line.start ? stepBack(doc, cursor) : cursor;
  const next = vim;
  next.register = { text, linewise: false };
  return pack("full", true, leavingOnce(next, prior), {
    type: "splice",
    from: cursor,
    to: cursor + len,
    text: "",
    caret,
    yank: { text, linewise: false },
  });
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
      const linewise = vim.mode === "visual-line";
      const stored = linewiseText(doc, removed, linewise);
      return pack("full", true, next, {
        type: "splice",
        from,
        to,
        text: "",
        caret: legal(doc, from, 1, raw),
        yank: { text: stored, linewise },
      });
    }
    if (n <= 1) {
      if (refusesLineBreak(doc, cursor, id === "X")) return pack("full", true, leavingOnce(next, vim), null);
      if (id === "x" && takesPlainGlyph(doc, cursor)) return cutPlainGlyph(next, vim, doc, cursor);
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
  if (id === ".") return repeatDot(vim);
  if (id === "i" || id === "a" || id === "I" || id === "A") {
    next.mode = "insert";
    next.once = false;
    if (id === "i") return pack("full", true, next, { type: "caret", anchor: cursor, cursor });
    if (id === "I" || id === "A") {
      const motion = runMotion(id === "I" ? "^" : "$", { doc, cursor, raw, layout, count: 1, column: null, find: null, vim: next });
      // $ parks on the last glyph. Append still inserts after it.
      const at = id === "A" && Number.isInteger(motion.end) ? motion.end : motion.cursor;
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
  // Alt+Shift stays one step. Shift is a word horizontally and a page vertically (R109).
  if (key.key === "ArrowLeft") return { kind: "motion", id: key.shift && !key.alt ? "b" : "h" };
  if (key.key === "ArrowRight") return { kind: "motion", id: key.shift && !key.alt ? "w" : "l" };
  if (key.key === "ArrowUp") return { kind: "motion", id: key.shift && !key.alt ? "ctrl-b" : "k" };
  if (key.key === "ArrowDown") return { kind: "motion", id: key.shift && !key.alt ? "ctrl-f" : "j" };
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
  if (isEscape(key)) return doEscape(vim, doc, anchor, cursor);
  if (key.ctrl || key.meta || key.key.length < 1 || key.key.length > 2) return pack("none", true, clearInput(vim), null);
  const which = vim.input.keyBuffer;
  const ready = { ...vim, input: { ...vim.input, keyBuffer: "" } };
  return dispatchResolved(ready, doc, anchor, cursor, raw, layout, which, { ch: key.key });
}

function finishQuote(vim, doc, anchor, cursor, key) {
  if (isEscape(key)) return doEscape(vim, doc, anchor, cursor);
  if (key.key === '"' && !key.ctrl && !key.meta) {
    const next = clearInput(vim);
    next.input = emptyInput();
    return pack("full", true, next, null);
  }
  return pack("none", true, clearInput(vim), null);
}

// The smallest interior is the thread under the caret. A tie keeps the earlier one.
function innermostComment(spans) {
  if (spans.length === 0) return null;
  spans.sort((a, b) =>
    (a.interiorEnd - a.interiorStart) - (b.interiorEnd - b.interiorStart) || a.interiorStart - b.interiorStart);
  return spans[0].id;
}

// A caret on a comment is the glyph inside that interior. The braces are the
// markers, and the interior's end is the closer.
function commentUnderCaret(doc, cursor) {
  if (cursor < 0 || cursor >= doc.length) return null;
  const hits = findSpans(doc).filter((span) => cursor >= span.interiorStart && cursor < span.interiorEnd);
  return innermostComment(hits);
}

// The highlight is already that comment when the whole selection sits in its interior.
function commentHoldingRange(doc, anchor, cursor) {
  const from = Math.min(anchor, cursor);
  const to = Math.max(anchor, cursor);
  if (!(from < to)) return null;
  const hits = findSpans(doc).filter((span) => from >= span.interiorStart && to <= span.interiorEnd);
  return innermostComment(hits);
}

function finishG(vim, doc, anchor, cursor, raw, layout, key) {
  if (isEscape(key)) return doEscape(vim, doc, anchor, cursor);
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
  // c stays the change operator. Visual gc on a highlight that is not already
  // a comment adds one and keeps the mode. A caret on an existing comment, or
  // a highlight already inside one, makes that thread current instead.
  if (!key.ctrl && !key.meta && !key.alt && key.key === "c" && !vim.input.operator) {
    const visual = (vim.mode === "visual" || vim.mode === "visual-line") && anchor !== cursor;
    if (visual) {
      const snap = snapSourceFenceLines(doc, anchor, cursor);
      if (snap) {
        if (snap.held) {
          return pack("full", true, clearInput(vim), {
            type: "comment-current",
            id: snap.held,
            anchor: snap.anchor,
            cursor: snap.cursor,
          });
        }
        return pack("full", true, clearInput(vim), {
          type: "comment-add",
          anchor: snap.anchor,
          cursor: snap.cursor,
        });
      }
      const held = commentHoldingRange(doc, anchor, cursor);
      if (!held) return pack("full", true, clearInput(vim), { type: "comment-add" });
      return pack("full", true, clearInput(vim), { type: "comment-current", id: held });
    }
    const id = commentUnderCaret(doc, cursor);
    if (id) return pack("full", true, clearInput(vim), { type: "comment-current", id });
    const lineId = sourceLineComment(doc, cursor);
    if (lineId) return pack("full", true, clearInput(vim), { type: "comment-current", id: lineId });
    return pack("none", true, clearInput(vim), null);
  }
  if (!id) return pack("none", true, clearInput(vim), null);
  return dispatchResolved(ready, doc, anchor, cursor, raw, layout, id, null);
}

function finishZ(vim, doc, anchor, cursor, raw, layout, key) {
  if (isEscape(key)) return doEscape(vim, doc, anchor, cursor);
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
  if (isEscape(key)) return doEscape(vim, doc, anchor, cursor);
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
  if (isEscape(key)) return doEscape(vim, doc, anchor, cursor);
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

// Insert leaves the caret after the character just typed. Vim puts the cursor
// on that character, and a caret already at column 0 stays there.
function insertStop(doc, cursor) {
  if (cursor <= 0 || doc[cursor - 1] === "\n") return cursor;
  const prev = stepBack(doc, cursor);
  // The CR of a CRLF is the break, not a character to land on.
  if (doc[prev] === "\r" && doc[prev + 1] === "\n") {
    if (prev === 0 || doc[prev - 1] === "\n") return cursor;
    return stepBack(doc, prev);
  }
  return prev;
}

function doEscape(vim, doc, anchor, cursor) {
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
  let at = cursor;
  if (vim.mode === "insert") {
    next.mode = "normal";
    at = insertStop(typeof doc === "string" ? doc : "", cursor);
    if (at !== cursor) next.column = null;
  }
  return pack("full", true, next, { type: "caret", anchor: at, cursor: at });
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
  if (isEscape(key)) return doEscape(vim, doc, cursor, cursor);
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

function vimKeyBody(input) {
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
  if (isEscape(key)) return doEscape(vim, doc, anchor, cursor);
  // Firefox sends this keydown before the key it changes. It is not a command.
  if (key.key === "Shift" || key.key === "Control" || key.key === "Alt" || key.key === "Meta") {
    return pack("none", false, vim, null);
  }
  if (countDigit(key, vim)) {
    const next = { ...vim, input: { ...vim.input, keyBuffer: vim.input.keyBuffer + key.key } };
    return pack("partial", true, next, null);
  }
  if (vim.input.keyBuffer === "f" || vim.input.keyBuffer === "F" || vim.input.keyBuffer === "t" || vim.input.keyBuffer === "T") {
    return finishFind(vim, doc, anchor, cursor, raw, layout, key);
  }
  if (vim.input.keyBuffer === "r") return finishReplace(vim, doc, cursor, raw, key);
  if (vim.input.keyBuffer === '"') return finishQuote(vim, doc, anchor, cursor, key);
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

// A repeat plays the stored command through these same keys. The play is not a new change.
function repeatDot(vim) {
  if (vim.mode === "visual" || vim.mode === "visual-line") {
    const next = clearInput(vim);
    next.mode = vim.mode;
    next.once = vim.once === true;
    return pack("full", true, next, null);
  }
  if (vim.replaying) return pack("full", true, clearInput(vim), null);
  const count = typedCount(vim);
  const next = clearInput(vim);
  if (!next.change) return pack("full", true, next, null);
  return pack("full", true, next, { type: "repeat", count });
}

function strokeKey(key) {
  if (!key || typeof key.key !== "string" || key.key === "") return false;
  if (key.key === "Shift" || key.key === "Control" || key.key === "Alt" || key.key === "Meta") return false;
  return true;
}

function pendingInput(vim) {
  const input = vim && vim.input;
  if (!input) return false;
  return !!input.operator || !!input.keyBuffer;
}

function pushStroke(vim, key) {
  const strokes = Array.isArray(vim.strokes) ? vim.strokes.slice() : [];
  strokes.push(copyKey(key));
  return { ...vim, strokes };
}

function bareDot(before, key) {
  if (!key || key.ctrl || key.meta || key.alt || key.shift) return false;
  if (key.key !== ".") return false;
  const input = before.input || emptyInput();
  return !input.operator && !input.keyBuffer;
}

function explicitCount(vim) {
  const input = (vim && vim.input) || emptyInput();
  let prefix = input.prefixRepeat || "";
  let motion = input.motionRepeat || "";
  if (/^\d+$/.test(input.keyBuffer || "")) {
    if (input.operator) motion = input.keyBuffer;
    else prefix = input.keyBuffer;
  }
  if (prefix === "" && motion === "") return null;
  return repeatOf({ input: { prefixRepeat: prefix, motionRepeat: motion } });
}

function stripCounts(keys) {
  const out = [];
  let open = false;
  for (const key of keys || []) {
    const digit = !key.ctrl && !key.meta && !key.alt && /^[0-9]$/.test(key.key);
    if (digit && !(key.key === "0" && !open)) {
      open = true;
      continue;
    }
    open = false;
    out.push(copyKey(key));
  }
  return out;
}

function enterOf(keys) {
  if (!keys || keys.length === 0) return null;
  if (keys.length === 1) {
    const id = keys[0].key;
    if (id === "i" || id === "a" || id === "A" || id === "I" || id === "o" || id === "O") return id;
  }
  if (keys.length === 2 && keys[0].key === "g" && keys[1].key === "I") return "gI";
  return null;
}

function excludedChange(change, result) {
  const keys = change && change.keys;
  if (!keys || keys.length === 0) return true;
  const first = keys[0];
  const id = first.key;
  if (first.ctrl && id.toLowerCase() === "r") return true;
  if (id === "y" || id === "Y" || id === "=" || id === "u" || id === "U") return true;
  if (id === "/" || id === "?" || id === "n" || id === "N" || id === "*" || id === "#" || id === ":" || id === "z") return true;
  if (id === "g" && keys[1]) {
    const second = keys[1].key;
    if (second === "n" || second === "N" || second === "*" || second === "#" || second === "c") return true;
  }
  const effect = result && result.effect;
  if (!effect) return false;
  return effect.type === "history" || effect.type === "prompt" || effect.type === "scroll"
    || effect.type === "comment-add" || effect.type === "comment-current" || effect.type === "nohlsearch";
}

function textChanged(src, result) {
  const effect = result && result.effect;
  if (!effect) return false;
  if (effect.type === "forward-delete" || effect.type === "backspace") return true;
  if (effect.type !== "splice") return false;
  const doc = typeof src.doc === "string" ? src.doc : "";
  const text = typeof effect.text === "string" ? effect.text : "";
  if (!Number.isInteger(effect.from) || !Number.isInteger(effect.to)) return false;
  return text !== doc.slice(effect.from, effect.to);
}

function measureVisual(doc, anchor, cursor, mode, raw) {
  const lo = Math.min(anchor, cursor);
  const hi = Math.max(anchor, cursor);
  const lines = vimLines(doc, lo, raw);
  const a = lineIndex(lines, doc, lo, raw);
  if (mode === "visual-line") {
    const b = lineIndex(lines, doc, hi, raw);
    return { mode: "visual-line", lines: Math.max(1, Math.abs(b - a) + 1), chars: 0, lastChars: 0 };
  }
  const lastAt = hi > lo ? stepBack(doc, hi) : lo;
  const b = lineIndex(lines, doc, Math.max(0, Math.min(doc.length, lastAt)), raw);
  if (a === b) {
    const n = unitsUntil(doc, lo, hi);
    return { mode: "visual", lines: 1, chars: n, lastChars: n };
  }
  const lastLine = lines[Math.max(a, b)] || lines[lines.length - 1];
  const lastEnd = Math.min(hi, lastLine.end);
  const lastChars = unitsUntil(doc, lastLine.start, Math.max(lastLine.start, lastEnd));
  return { mode: "visual", lines: Math.abs(b - a) + 1, chars: unitsUntil(doc, lo, Math.min(hi, lines[a].end)), lastChars };
}

function buildChange(before, src, vim) {
  const doc = typeof src.doc === "string" ? src.doc : "";
  const cursor = clamp(src.cursor, doc.length);
  const anchor = src.anchor == null ? cursor : clamp(src.anchor, doc.length);
  const raw = src.raw === true;
  let visual = null;
  if (before.mode === "visual" || before.mode === "visual-line") {
    visual = measureVisual(doc, anchor, cursor, before.mode, raw);
  }
  const keys = stripCounts(vim.strokes);
  const enter = enterOf(keys);
  let insert = null;
  if (vim.mode === "insert") {
    if (!visual && (enter === "o" || enter === "O")) insert = "interlace";
    else if (!visual && (enter === "i" || enter === "a" || enter === "A" || enter === "I" || enter === "gI")) insert = "repeat";
    else insert = "once";
  }
  return {
    count: explicitCount(before),
    keys,
    insert,
    enter: insert ? enter : null,
    log: insert ? [] : null,
    visual,
    nested: false,
  };
}

function recordingFrom(change, src) {
  const doc = typeof src.doc === "string" ? src.doc : "";
  return {
    count: change.count,
    keys: change.keys.map(copyKey),
    insert: change.insert,
    enter: change.enter,
    log: [],
    visual: change.visual,
    baseDoc: change.insert === "interlace" ? doc : null,
    baseCursor: clamp(src.cursor, doc.length),
    baseAnchor: clamp(src.anchor == null ? src.cursor : src.anchor, doc.length),
    raw: src.raw === true,
  };
}

function finishCommand(before, src, result) {
  const vim = result.vim;
  const entered = vim.mode === "insert" && !vim.once && before.mode !== "insert";
  if (entered) {
    const change = buildChange(before, src, vim);
    if (excludedChange(change, result)) {
      return { ...result, vim: { ...vim, strokes: [], recording: null } };
    }
    return {
      ...result,
      vim: { ...vim, strokes: [], recording: recordingFrom(change, src), change: copyChange(before.change) },
    };
  }
  if (textChanged(src, result)) {
    const change = buildChange(before, src, vim);
    if (!excludedChange(change, result)) {
      return { ...result, vim: { ...vim, strokes: [], recording: null, change } };
    }
  }
  return { ...result, vim: { ...vim, strokes: [] } };
}

function surrogateKey(text) {
  if (typeof text !== "string" || text.length !== 2) return false;
  const hi = text.charCodeAt(0);
  const lo = text.charCodeAt(1);
  return hi >= 0xD800 && hi <= 0xDBFF && lo >= 0xDC00 && lo <= 0xDFFF;
}

function insertLogEntry(key) {
  if (key.ctrl || key.meta || key.alt) {
    const id = key.key.length === 1 ? key.key.toLowerCase() : key.key;
    if ((key.ctrl || key.meta) && id === "w") return { t: "cw" };
    if (key.ctrl && !key.meta && id === "u") return { t: "cu" };
    return null;
  }
  if (key.key === "Backspace") return { t: "bs" };
  if (key.key === "Delete") return { t: "del" };
  if (key.key === "ArrowLeft") return { t: "left" };
  if (key.key === "ArrowRight") return { t: "right" };
  if (key.key === "ArrowUp") return { t: "up" };
  if (key.key === "ArrowDown") return { t: "down" };
  if (key.key === "Enter") return { t: "text", text: "\n" };
  if (typeof key.key === "string" && (key.key.length === 1 || surrogateKey(key.key))) return { t: "text", text: key.key };
  return null;
}

function changeFromRecording(rec) {
  return {
    count: Number.isInteger(rec.count) ? rec.count : null,
    keys: rec.keys.map(copyKey),
    insert: rec.insert === "repeat" || rec.insert === "interlace" || rec.insert === "once" ? rec.insert : null,
    enter: typeof rec.enter === "string" ? rec.enter : null,
    log: rec.log.map(copyEntry),
    visual: rec.visual,
    nested: false,
  };
}

function freshState(doc, cursor, anchor, raw, vim) {
  const text = typeof doc === "string" ? doc : "";
  const next = cloneVim(vim);
  next.replaying = true;
  next.recording = null;
  next.strokes = [];
  next.input = emptyInput();
  next.once = false;
  next.mode = "normal";
  return {
    doc: text,
    cursor: clamp(cursor, text.length),
    anchor: clamp(anchor == null ? cursor : anchor, text.length),
    raw: raw === true,
    layout: false,
    move: null,
    vim: next,
  };
}

function applyBackspace(state) {
  const next = backspace(createState(state.doc, state.cursor, state.cursor));
  if (!next || next.refused || typeof next.doc !== "string") return;
  state.doc = next.doc;
  state.cursor = next.cursor;
  state.anchor = next.cursor;
}

function applyDeleteForward(state) {
  const next = deleteForward(createState(state.doc, state.cursor, state.cursor));
  if (!next || next.refused || typeof next.doc !== "string") return;
  state.doc = next.doc;
  state.cursor = next.cursor;
  state.anchor = next.cursor;
}

function applyInsertText(state, text) {
  const value = typeof text === "string" ? text : "";
  if (!value) return;
  const exact = !/[\n\r]/.test(value);
  const next = insert(createState(state.doc, state.cursor, state.cursor), value, false, state.raw, exact);
  if (!next || next.refused || typeof next.doc !== "string") return;
  state.doc = next.doc;
  state.cursor = next.cursor;
  state.anchor = next.cursor;
}

function repeatWordChar(ch) {
  return /[A-Za-z0-9_]/.test(ch);
}

function wordDeleteSpan(doc, cursor) {
  const space = (ch) => /\s/.test(ch);
  let index = cursor;
  while (index > 0 && space(doc[index - 1])) index -= 1;
  if (index > 0) {
    const word = repeatWordChar(doc[index - 1]);
    while (index > 0 && !space(doc[index - 1]) && repeatWordChar(doc[index - 1]) === word) index -= 1;
  }
  let start = index;
  let end = cursor;
  const atoms = plan(doc, cursor).atoms || [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const atom of atoms) {
      if (!atom || atom.end <= start || atom.start >= end) continue;
      if (atom.start < start || atom.end > end) {
        start = Math.min(start, atom.start);
        end = Math.max(end, atom.end);
        grew = true;
      }
    }
  }
  return { from: start, to: end };
}

function applyWordDelete(state) {
  if (state.cursor <= 0) return;
  const span = wordDeleteSpan(state.doc, state.cursor);
  if (!span || span.from === span.to) {
    applyBackspace(state);
    return;
  }
  state.doc = state.doc.slice(0, span.from) + state.doc.slice(span.to);
  state.cursor = span.from;
  state.anchor = span.from;
}

function moveArrow(state, dir) {
  if (typeof state.move === "function") {
    const at = state.move(state.doc, state.cursor, dir);
    if (Number.isInteger(at)) {
      state.cursor = clamp(at, state.doc.length);
      state.anchor = state.cursor;
      return;
    }
  }
  const doc = state.doc;
  if (dir === "left") state.cursor = stepBack(doc, state.cursor);
  else if (dir === "right") {
    if (state.cursor < doc.length && !breaksLine(doc, state.cursor)) state.cursor += unitLen(doc, state.cursor);
  } else if (dir === "up" || dir === "down") {
    const moved = moveVertical(doc, state.cursor, dir === "down" ? 1 : -1, 1, state.raw, null, false);
    if (moved && Number.isInteger(moved.cursor)) state.cursor = moved.cursor;
  }
  state.cursor = clamp(state.cursor, state.doc.length);
  state.anchor = state.cursor;
}

function applyLocal(state, effect) {
  if (!effect) return;
  if (effect.type === "splice") {
    const text = typeof effect.text === "string" ? effect.text : "";
    const from = Number.isInteger(effect.from) ? effect.from : state.cursor;
    const to = Number.isInteger(effect.to) ? effect.to : from;
    state.doc = state.doc.slice(0, from) + text + state.doc.slice(to);
    const caret = Number.isInteger(effect.caret) ? effect.caret : from + text.length;
    state.cursor = clamp(caret, state.doc.length);
    state.anchor = state.cursor;
    return;
  }
  if (effect.type === "caret") {
    const cursor = Number.isInteger(effect.cursor) ? effect.cursor : state.cursor;
    const anchor = Number.isInteger(effect.anchor) ? effect.anchor : cursor;
    state.cursor = clamp(cursor, state.doc.length);
    state.anchor = clamp(anchor, state.doc.length);
    return;
  }
  if (effect.type === "forward-delete") {
    applyDeleteForward(state);
    return;
  }
  if (effect.type === "backspace") {
    applyBackspace(state);
    return;
  }
  if (effect.type === "word-delete") {
    applyWordDelete(state);
    return;
  }
  if (effect.type === "view-motion") {
    const command = effect.command;
    const repeat = Number.isInteger(effect.repeat) && effect.repeat > 0 ? effect.repeat : 1;
    const dir = command === "h" ? "left" : command === "l" ? "right" : command === "k" || command === "gk" ? "up" : command === "j" || command === "gj" ? "down" : "";
    for (let n = 0; n < repeat && dir; n += 1) moveArrow(state, dir);
  }
}

function feed(state, key) {
  const result = vimKeyBody({
    vim: state.vim,
    key,
    doc: state.doc,
    cursor: state.cursor,
    anchor: state.anchor,
    raw: state.raw,
    layout: state.layout === true,
    flag: true,
  });
  state.vim = result.vim || state.vim;
  state.vim.replaying = true;
  applyLocal(state, result.effect);
}

function feedKeys(state, keys) {
  for (const key of keys || []) feed(state, copyKey(key));
}

function playLog(state, log) {
  for (const entry of log || []) {
    if (!entry) continue;
    if (entry.t === "text") applyInsertText(state, entry.text);
    else if (entry.t === "bs") applyBackspace(state);
    else if (entry.t === "del") applyDeleteForward(state);
    else if (entry.t === "cw") applyWordDelete(state);
    else if (entry.t === "cu") feed(state, { key: "u", ctrl: true, meta: false, alt: false, shift: false });
    else if (entry.t === "left" || entry.t === "right" || entry.t === "up" || entry.t === "down") moveArrow(state, entry.t);
    else if (entry.t === "edit" && entry.change) playNested(state, entry.change);
  }
}

function playNested(state, change) {
  const savedChange = state.vim.change;
  const savedRecording = state.vim.recording;
  const nested = copyChange(change) || {
    count: null, keys: [], insert: null, enter: null, log: null, visual: null, nested: true,
  };
  nested.nested = true;
  nested.insert = null;
  // Ctrl-O runs one Normal command and returns to Insert. The key is not insert text.
  state.vim = { ...state.vim, mode: "insert", once: true, replaying: true, input: emptyInput() };
  runChange(state, nested, false);
  state.vim.change = savedChange;
  state.vim.recording = savedRecording;
  state.vim.replaying = true;
}

function presetCount(state, count) {
  const n = Math.max(1, Math.min(REPEAT_CAP, count));
  state.vim = {
    ...state.vim,
    replaying: true,
    input: { prefixRepeat: String(n), operator: null, motionRepeat: "", motion: null, keyBuffer: "" },
  };
}

function selectVisual(doc, cursor, visual, raw) {
  const lines = vimLines(doc, cursor, raw);
  let index = lineIndex(lines, doc, cursor, raw);
  if (index >= lines.length) index = Math.max(0, lines.length - 1);
  const count = Math.max(1, visual.lines || 1);
  const last = Math.min(lines.length - 1, index + count - 1);
  if (visual.mode === "visual-line") {
    return { anchor: lines[index].start, cursor: lines[last].end };
  }
  if (count <= 1) {
    const line = lines[index];
    let to = cursor;
    const chars = Math.max(0, visual.chars || 0);
    for (let n = 0; n < chars && to < line.end && to < doc.length; n += 1) to += unitLen(doc, to);
    return { anchor: cursor, cursor: to };
  }
  const lastLine = lines[last];
  let to = lastLine.start;
  const chars = Math.max(0, visual.lastChars || 0);
  for (let n = 0; n < chars && to < lastLine.end && to < doc.length; n += 1) to += unitLen(doc, to);
  return { anchor: cursor, cursor: to };
}

function runChange(state, change, escape) {
  const stop = escape !== false && !change.nested;
  if (change.visual) {
    const sel = selectVisual(state.doc, state.cursor, change.visual, state.raw);
    state.anchor = sel.anchor;
    state.cursor = sel.cursor;
    state.vim = { ...state.vim, mode: change.visual.mode, replaying: true, input: emptyInput(), once: false };
    feedKeys(state, change.keys);
    if (change.insert) {
      playLog(state, change.log);
      if (stop) feed(state, { key: "Escape", ctrl: false, meta: false, alt: false, shift: false });
    }
    return;
  }
  if (change.insert === "interlace") {
    const n = change.count == null ? 1 : change.count;
    const enter = change.enter === "O" ? "O" : "o";
    for (let i = 0; i < n; i += 1) {
      state.vim = { ...state.vim, mode: "normal", once: false, replaying: true, input: emptyInput() };
      feed(state, { key: enter, ctrl: false, meta: false, alt: false, shift: false });
      playLog(state, change.log);
      feed(state, { key: "Escape", ctrl: false, meta: false, alt: false, shift: false });
    }
    return;
  }
  if (change.insert === "repeat") {
    state.vim = { ...state.vim, mode: "normal", once: false, replaying: true, input: emptyInput() };
    const keys = change.keys && change.keys.length ? change.keys : [{ key: change.enter || "i", ctrl: false, meta: false, alt: false, shift: false }];
    feedKeys(state, keys);
    const n = change.count == null ? 1 : change.count;
    const log = change.log || [];
    // Escape leaves the caret on the last glyph i inserted. The next play appends after it.
    if (change.enter === "i" && log.length > 0) moveArrow(state, "right");
    for (let i = 0; i < n; i += 1) playLog(state, log);
    // An empty i inserts nothing. A second Escape would step back one glyph.
    if (stop && change.enter === "i" && log.length === 0) {
      state.vim = { ...state.vim, mode: "normal", once: false, replaying: true, input: emptyInput() };
    } else if (stop) {
      feed(state, { key: "Escape", ctrl: false, meta: false, alt: false, shift: false });
    }
    return;
  }
  if (change.insert === "once") {
    if (change.count != null) presetCount(state, change.count);
    else state.vim = { ...state.vim, replaying: true, input: emptyInput() };
    feedKeys(state, change.keys);
    playLog(state, change.log);
    if (stop) feed(state, { key: "Escape", ctrl: false, meta: false, alt: false, shift: false });
    return;
  }
  if (change.count != null) presetCount(state, change.count);
  else state.vim = { ...state.vim, replaying: true, input: emptyInput() };
  feedKeys(state, change.keys);
}

function diffSplice(before, after, caret, group) {
  let head = 0;
  const limit = Math.min(before.length, after.length);
  while (head < limit && before[head] === after[head]) head += 1;
  let tail = 0;
  while (
    tail < before.length - head
    && tail < after.length - head
    && before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) tail += 1;
  const effect = {
    type: "splice",
    from: head,
    to: before.length - tail,
    text: after.slice(head, after.length - tail),
    caret,
    yank: null,
  };
  if (group) effect.group = true;
  return effect;
}

function effectBetween(beforeDoc, state, group, fallback) {
  if (state.doc !== beforeDoc) return diffSplice(beforeDoc, state.doc, state.cursor, group);
  if (!fallback || fallback.type !== "caret" || fallback.cursor !== state.cursor) {
    return { type: "caret", anchor: state.cursor, cursor: state.cursor };
  }
  return fallback;
}

function finishRecording(before, src, result) {
  const rec = copyRecording(before.recording || (result.vim && result.vim.recording));
  const vim = {
    ...result.vim,
    recording: null,
    strokes: [],
    replaying: false,
    change: rec ? changeFromRecording(rec) : copyChange(before.change),
  };
  if (!rec) return { ...result, vim };
  const count = rec.count == null ? 1 : rec.count;
  const doc = typeof src.doc === "string" ? src.doc : "";
  const cursor = clamp(src.cursor, doc.length);
  if (rec.insert === "repeat" && count > 1) {
    const state = freshState(doc, cursor, cursor, rec.raw, result.vim);
    for (let i = 1; i < count; i += 1) playLog(state, rec.log);
    const at = insertStop(state.doc, state.cursor);
    state.cursor = at;
    state.anchor = at;
    return { ...result, vim, effect: effectBetween(doc, state, true, result.effect) };
  }
  if (rec.insert === "interlace" && count > 1 && typeof rec.baseDoc === "string") {
    const state = freshState(rec.baseDoc, rec.baseCursor, rec.baseAnchor, rec.raw, result.vim);
    const enter = rec.enter === "O" ? "O" : "o";
    for (let i = 0; i < count; i += 1) {
      state.vim = { ...state.vim, mode: "normal", once: false, replaying: true, input: emptyInput() };
      feed(state, { key: enter, ctrl: false, meta: false, alt: false, shift: false });
      playLog(state, rec.log);
      feed(state, { key: "Escape", ctrl: false, meta: false, alt: false, shift: false });
    }
    return { ...result, vim, effect: effectBetween(doc, state, true, result.effect) };
  }
  return { ...result, vim };
}

function settleInsert(before, src, result, key) {
  if (!before.recording) return result;
  if (isEscape(key)) return finishRecording(before, src, result);
  const recording = copyRecording(result.vim.recording || before.recording);
  if (!recording) return result;
  const entry = insertLogEntry(key);
  if (entry) recording.log = recording.log.concat([entry]);
  const armed = key.ctrl && !key.meta && !key.alt && String(key.key).toLowerCase() === "o" && result.vim.once;
  return { ...result, vim: { ...result.vim, recording, strokes: armed ? [] : result.vim.strokes } };
}

function settleOnce(before, src, result, key) {
  let vim = { ...result.vim, recording: copyRecording(before.recording) };
  if (result.consumed && strokeKey(key) && !isEscape(key)) vim = pushStroke(vim, key);
  if (result.match === "partial" || pendingInput(vim) || vim.once) return { ...result, vim };
  const keys = stripCounts(vim.strokes);
  const nested = {
    count: explicitCount(before),
    keys,
    insert: null,
    enter: null,
    log: null,
    visual: null,
    nested: true,
  };
  const recording = copyRecording(vim.recording);
  if (recording && (textChanged(src, result) || enterOf(keys)) && !excludedChange(nested, result)) {
    recording.log = recording.log.concat([{ t: "edit", change: nested }]);
  }
  return { ...result, vim: { ...vim, strokes: [], recording, change: copyChange(before.change) } };
}

function settleRepeat(before, src, result) {
  if (!result || before.replaying) return result;
  const key = normKey(src.key);
  if (before.mode === "insert" && !before.once) return settleInsert(before, src, result, key);
  if (before.once && before.recording) return settleOnce(before, src, result, key);
  if (!result.consumed) return result;
  if (bareDot(before, key)) return { ...result, vim: { ...result.vim, strokes: [] } };
  let vim = result.vim;
  if (strokeKey(key) && !isEscape(key)) vim = pushStroke(vim, key);
  if (result.match === "partial" || pendingInput(vim)) return { ...result, vim };
  return finishCommand(before, src, { ...result, vim });
}

export function vimKey(input) {
  const src = input || {};
  const before = cloneVim(src.vim);
  const result = vimKeyBody(input);
  if (before.replaying || src.flag === false) return result;
  return settleRepeat(before, src, result);
}

export function playVimChange(input) {
  const src = input || {};
  const vim = cloneVim(src.vim);
  const original = copyChange(vim.change);
  if (!original || (original.keys.length === 0 && !original.insert)) {
    vim.replaying = false;
    return { vim, effect: null, missed: true };
  }
  const doc = typeof src.doc === "string" ? src.doc : "";
  const cursor = clamp(src.cursor, doc.length);
  const anchor = src.anchor == null ? cursor : clamp(src.anchor, doc.length);
  const override = Number.isInteger(src.count) ? Math.max(1, Math.min(REPEAT_CAP, src.count)) : null;
  const change = copyChange(original);
  if (!change.visual && override != null) change.count = override;
  const state = freshState(doc, cursor, anchor, src.raw === true, vim);
  state.layout = src.layout === true;
  state.move = typeof src.move === "function" ? src.move : null;
  runChange(state, change, !change.nested);
  const changedDoc = state.doc !== doc;
  const changedCaret = state.cursor !== cursor || state.anchor !== anchor;
  const emptyInsert = !!change.insert && (!change.log || change.log.length === 0);
  if (!changedDoc && !changedCaret && !emptyInsert) {
    const keep = cloneVim(vim);
    keep.replaying = false;
    return { vim: keep, effect: null, missed: true };
  }
  const done = cloneVim(state.vim);
  done.replaying = false;
  done.recording = null;
  done.strokes = [];
  done.once = false;
  done.input = emptyInput();
  if (!change.visual && override != null) {
    const updated = copyChange(original);
    updated.count = override;
    done.change = updated;
  } else done.change = original;
  done.register = {
    text: state.vim.register && typeof state.vim.register.text === "string" ? state.vim.register.text : "",
    linewise: !!(state.vim.register && state.vim.register.linewise),
  };
  let effect = null;
  if (changedDoc) effect = diffSplice(doc, state.doc, state.cursor, false);
  else if (state.cursor !== cursor || state.anchor !== anchor) effect = { type: "caret", anchor: state.anchor, cursor: state.cursor };
  return { vim: done, effect, missed: false };
}

export function vimNoteArrow(vim, dir) {
  const next = cloneVim(vim);
  if (next.replaying || next.mode !== "insert" || next.once || !next.recording) return next;
  const names = {
    ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
    left: "left", right: "right", up: "up", down: "down",
  };
  const t = names[dir];
  if (!t) return next;
  next.recording.log = next.recording.log.concat([{ t }]);
  return next;
}
