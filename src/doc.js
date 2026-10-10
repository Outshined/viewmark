const SAMPLE = [
  "# Viewmark",
  "",
  "A **bold** claim and the word wrapped on this line. The caret can travel to the end of this raw line while the pane wraps the text. The caret can travel to the end of this raw line while the pane wraps the text. The caret can travel to the end of this raw line while the pane wraps the text.",
  "",
  "> Quoted *emphasis* and `code`.",
  "",
  "- one",
  "- two",
  "  - sub",
  "\t- tabbed",
  "",
  "1. first",
  "   1. nested",
  "2. second",
  "",
  "Read the [notes](https://example.com) before editing.",
  "",
  "---",
  "",
  "| a | b |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
  "![alt](sample.svg)",
  "",
  "```python",
  "x = 1",
  "```",
  "",
  "```mermaid",
  "graph TD",
  "A-->B",
  "```",
  "",
].join("\n");

export function sampleDocument() {
  return SAMPLE;
}

export function initialCursor(doc) {
  const at = doc.indexOf("wrapped");
  return at < 0 ? 0 : at;
}

export function createState(doc, cursor = 0, anchor = undefined) {
  const text = typeof doc === "string" ? doc : "";
  const clamp = (n) => {
    const value = Number.isFinite(n) ? Math.trunc(n) : 0;
    return Math.max(0, Math.min(text.length, value));
  };
  const nextCursor = clamp(cursor);
  const nextAnchor = anchor === undefined ? nextCursor : clamp(anchor);
  return {
    doc: text,
    cursor: nextCursor,
    anchor: nextAnchor,
    undo: [],
    redo: [],
  };
}

function lineSpans(doc) {
  const lines = [];
  let start = 0;
  for (let i = 0; i <= doc.length; i += 1) {
    if (i === doc.length || doc[i] === "\n") {
      lines.push({ start, end: i, text: doc.slice(start, i) });
      start = i + 1;
      if (i === doc.length) break;
    }
  }
  return lines;
}

export function lineIndexAt(doc, cursor) {
  const lines = lineSpans(doc);
  for (let i = 0; i < lines.length; i += 1) {
    if (cursor >= lines[i].start && cursor <= lines[i].end) return i;
  }
  return Math.max(0, lines.length - 1);
}

// One to four spaces, or a single tab, belong to the marker. A fifth space stays text.
function listSeparator(text, index) {
  if (text[index] === "\t") return 1;
  let count = 0;
  while (count < 4 && text[index + count] === " ") count += 1;
  return count;
}

// "> - " is one quoted item. Indent after "> " is a nested item inside that quote.
function quotedList(text) {
  if (!text.startsWith("> ")) return null;
  const list = classifyList(text.slice(2));
  if (!list) return null;
  return {
    kind: list.kind,
    marker: 2 + list.marker,
    quote: 2,
    indent: list.indent,
    plain: list.plain,
    quoted: true,
  };
}

// A space is one column. A tab advances to the next multiple of 4, even from a stop.
function classifyList(text) {
  let column = 0;
  let index = 0;
  while (index < text.length && (text[index] === " " || text[index] === "\t")) {
    if (text[index] === " ") column += 1;
    else column += 4 - (column % 4);
    index += 1;
  }
  const bullet = text[index];
  if (bullet === "-" || bullet === "+" || bullet === "*") {
    const separator = listSeparator(text, index + 1);
    if (separator === 0) return null;
    return { kind: "li", marker: index + 1 + separator, indent: column, plain: "md-li" };
  }
  const ordered = /^(\d{1,9})[.)]/.exec(text.slice(index));
  if (!ordered) return null;
  const separator = listSeparator(text, index + ordered[0].length);
  if (separator === 0) return null;
  return {
    kind: "ol",
    marker: index + ordered[0].length + separator,
    indent: column,
    plain: "md-ol",
  };
}

// A caret in a fence body gets one newline. The opener and the closer are not body.
function fenceBody(doc, offset) {
  const lines = lineSpans(doc);
  let open = false;
  for (const line of lines) {
    if (line.start > offset) break;
    if (!open) {
      const opened = fenceOpen(line.text);
      if (opened && opened.lang !== "comment" && offset > line.end) open = true;
      continue;
    }
    if (isFenceClose(line.text)) {
      if (offset <= line.end) return false;
      open = false;
    }
  }
  return open;
}

// Enter at the end of a paragraph that would swallow the new line writes the
// blank line that keeps the caret's line its own block. A newline already
// under the caret is that blank line.
function paragraphBlank(doc, line, cursor) {
  if (cursor !== line.end || line.text === "") return false;
  if (cursor < doc.length && doc[cursor] === "\n") return false;
  if (imageLine(line.text) || line.text.startsWith("|")) return false;
  return classify(line.text).kind === "p";
}

// Text Enter inserts, and where it replaces when an empty item leaves the list.
// anchor and cursor are the splice; omitted, the caret's own range is the splice.
export function enterInsert(doc, cursor) {
  const text = typeof doc === "string" ? doc : "";
  const at = Math.max(0, Math.min(text.length, Number.isFinite(cursor) ? cursor : 0));
  const line = sourceLine(text, at);
  const opened = fenceOpen(line.text);
  if ((opened && opened.lang !== "comment") || fenceBody(text, at) || line.text.startsWith("|")) return { text: "\n" };
  const mode = classify(line.text);
  if ((mode.kind === "li" || mode.kind === "ol") && at === line.end) {
    const head = line.text.slice(0, mode.marker || 0);
    // A nested or quoted empty item is not this exit. A top-level one becomes the blank line.
    if (head !== "" && line.text === head && !/^[ \t>]/.test(head)) {
      return { text: "\n", anchor: line.start, cursor: line.end };
    }
  }
  if (at === line.start && (mode.kind === "li" || mode.kind === "ol")) return { text: "\n" };
  const marker = continuedMarker(text, at);
  if (marker) return { text: `\n${marker}` };
  if (paragraphBlank(text, line, at)) return { text: "\n\n" };
  return { text: "\n" };
}

// The marker of the next item of the same kind, or null when the caret's line is not an item.
export function continuedMarker(doc, cursor) {
  const text = typeof doc === "string" ? doc : "";
  const at = Math.max(0, Math.min(text.length, Number.isFinite(cursor) ? cursor : 0));
  let start = at;
  let end = at;
  while (start > 0 && text[start - 1] !== "\n") start -= 1;
  while (end < text.length && text[end] !== "\n") end += 1;
  const line = text.slice(start, end);
  const mode = classify(line);
  if (mode.kind !== "li" && mode.kind !== "ol") return null;
  const head = line.slice(0, mode.marker || 0);
  if (mode.kind === "li") return head;
  const quote = mode.quoted ? line.slice(0, mode.quote || 0) : "";
  const body = head.slice(quote.length);
  const match = /^([ \t]*)(\d+)([.)])([ \t]+)$/.exec(body);
  if (!match) return head;
  return quote + match[1] + String(Number(match[2]) + 1) + match[3] + match[4];
}

function classify(text) {
  if (text === "---" || text === "***" || text === "___") {
    return { kind: "hr", marker: 0, indent: 0, plain: "md-hr" };
  }
  const heading = /^(#{1,6}) (.*)$/.exec(text);
  if (heading) {
    const level = heading[1].length;
    return { kind: "h", level, marker: level + 1, indent: 0, plain: `md-h${level}` };
  }
  if (text.startsWith("> ")) {
    const item = quotedList(text);
    if (item) return item;
    return { kind: "quote", marker: 2, indent: 0, plain: "md-quote" };
  }
  const list = classifyList(text);
  if (list) return list;
  return { kind: "p", marker: 0, indent: 0, plain: "md-p" };
}

function fenceOpen(text) {
  const match = /^```[ \t]*([^`\s]*)(.*)$/.exec(text);
  if (!match) return null;
  const lang = match[1];
  let commentId = null;
  let resolved = false;
  if (lang === "comment") {
    const id = /^[ \t]*([A-Za-z][A-Za-z0-9_-]*)(.*)$/.exec(match[2]);
    if (id) {
      commentId = id[1];
      resolved = /^[ \t]*resolved[ \t]*$/.test(id[2]);
    }
  }
  return {
    lang,
    diagram: lang === "mermaid",
    commentId,
    resolved,
  };
}

function isFenceClose(text) {
  return /^```\s*$/.test(text);
}

// contentEnd stops at the closing fence line. end includes that line's newline so
// deleting a comment thread does not leave the fence row behind.
function fenceContentRanges(doc) {
  const lines = lineSpans(doc);
  const ranges = [];
  let index = 0;
  while (index < lines.length) {
    const opened = fenceOpen(lines[index].text);
    if (!opened) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < lines.length && !isFenceClose(lines[end].text)) end += 1;
    const closed = end < lines.length;
    const last = closed ? end : lines.length - 1;
    const start = lines[index].start;
    const contentEnd = closed ? lines[last].end : doc.length;
    let rangeEnd = contentEnd;
    if (closed && contentEnd < doc.length && doc[contentEnd] === "\n") rangeEnd = contentEnd + 1;
    ranges.push({
      start,
      contentEnd,
      end: rangeEnd,
      lang: opened.lang,
      diagram: opened.diagram === true,
      commentId: opened.commentId,
      resolved: opened.resolved === true,
      closed,
      openIndex: index,
      lastIndex: last,
    });
    index = last + 1;
  }
  return ranges;
}

export function commentThreads(doc) {
  const lines = lineSpans(doc);
  const threads = [];
  for (const fence of fenceContentRanges(doc)) {
    if (fence.lang !== "comment" || !fence.commentId) continue;
    const open = lines[fence.openIndex];
    if (!open) continue;
    const from = open.end < doc.length && doc[open.end] === "\n" ? open.end + 1 : open.end;
    const to = fence.closed ? lines[fence.lastIndex].start : doc.length;
    let body = doc.slice(from, to);
    if (body.endsWith("\n")) body = body.slice(0, -1);
    threads.push({
      id: fence.commentId,
      body,
      start: fence.start,
      end: fence.end,
      resolved: fence.resolved === true,
    });
  }
  return threads;
}

// A boundary is a whole line "::", or "::" plus an id. ":: 01" and ":: 1 " stay
// text, so a marker inside a note does not split it.
const NOTE_SEPARATOR = /^::(?: (0|[1-9]\d*))?$/;

// undefined: not a boundary. null: a bare "::". number: the id on the line.
function separatorId(line) {
  const match = NOTE_SEPARATOR.exec(line);
  if (!match) return undefined;
  if (match[1] === undefined) return null;
  return Number(match[1]);
}

// explicit is undefined for prose before any boundary, null for a bare "::",
// or the id written on that boundary. The leading "" is kept.
function splitNoteSegments(body) {
  const segments = [];
  let lines = [];
  let explicit = undefined;
  for (const line of body.split("\n")) {
    const id = separatorId(line);
    if (id === undefined) {
      lines.push(line);
      continue;
    }
    segments.push({ explicit, raw: lines.join("\n") });
    lines = [];
    explicit = id;
  }
  segments.push({ explicit, raw: lines.join("\n") });
  return segments;
}

export function commentNotes(body) {
  return splitNoteSegments(body).map((segment) => segment.raw);
}

const NOTE_HEADER = /^@(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) (.+)$/;

// A poster line is only the first line. A later @ line is note text.
export function splitCommentNote(note) {
  const raw = typeof note === "string" ? note : "";
  const breakAt = raw.indexOf("\n");
  const first = breakAt === -1 ? raw : raw.slice(0, breakAt);
  const match = NOTE_HEADER.exec(first);
  if (!match) return { time: "", author: "", text: raw };
  return {
    time: match[1],
    author: match[2],
    text: breakAt === -1 ? "" : raw.slice(breakAt + 1),
  };
}

function startsWithSeparator(body) {
  const end = body.indexOf("\n");
  const first = end === -1 ? body : body.slice(0, end);
  return separatorId(first) !== undefined;
}

// A bare "::" is max(explicit ids seen so far) + 1, so later bares repeat that
// address. With no explicit id yet, it takes the next ordinal. Prose before
// the first boundary is ordinal 0 and is not an explicit id.
function assignNoteIds(segments) {
  const notes = [];
  let highestExplicit = null;
  let nextOrdinal = 0;
  for (const segment of segments) {
    let id;
    if (typeof segment.explicit === "number") {
      id = segment.explicit;
      if (highestExplicit === null || id > highestExplicit) highestExplicit = id;
    } else if (segment.explicit === undefined) {
      id = 0;
      nextOrdinal = 1;
    } else if (highestExplicit !== null) {
      id = highestExplicit + 1;
    } else {
      id = nextOrdinal;
      nextOrdinal += 1;
    }
    notes.push({ id, raw: segment.raw });
  }
  return notes;
}

export function parseCommentNotes(body) {
  if (body === "") return [];
  const segments = splitNoteSegments(body);
  if (startsWithSeparator(body)) segments.shift();
  return assignNoteIds(segments);
}

export function formatCommentNotes(records) {
  return records.map((record) => `:: ${record.id}\n${record.raw}`).join("\n");
}

function hasSeparatorLine(text) {
  for (const line of text.split("\n")) {
    if (separatorId(line) !== undefined) return true;
  }
  return false;
}

function highestNoteId(notes) {
  let highest = notes[0].id;
  for (let i = 1; i < notes.length; i++) {
    if (notes[i].id > highest) highest = notes[i].id;
  }
  return highest;
}

export function appendCommentReply(body, text, author, time) {
  if (text === "" || hasSeparatorLine(text)) return { error: 400 };
  const notes = parseCommentNotes(body);
  const id = notes.length === 0 ? 0 : highestNoteId(notes) + 1;
  const raw = author === undefined || author === null || author === "" ? text : `@${time} ${author}\n${text}`;
  const note = { id, raw };
  notes.push(note);
  return { body: formatCommentNotes(notes), note };
}

// The stored poster line is a prefix, not a value to rebuild.
function replaceNoteText(raw, text) {
  const breakAt = raw.indexOf("\n");
  const header = breakAt === -1 ? raw : raw.slice(0, breakAt);
  return `${header}\n${text}`;
}

export function reviseCommentNote(body, noteId, text, author) {
  const notes = parseCommentNotes(body);
  const indexes = [];
  for (let i = 0; i < notes.length; i++) {
    if (notes[i].id === noteId) indexes.push(i);
  }
  if (indexes.length === 0) return { error: 404 };
  if (indexes.length > 1) return { error: 400 };
  if (text === "" || hasSeparatorLine(text)) return { error: 400 };
  const index = indexes[0];
  const current = notes[index];
  const parts = splitCommentNote(current.raw);
  if (!parts.author || parts.author !== author) return { error: 403, body };
  const raw = replaceNoteText(current.raw, text);
  if (raw === current.raw) return { unchanged: true };
  const next = notes.slice();
  next[index] = { id: current.id, raw };
  return { body: formatCommentNotes(next), note: next[index] };
}

function hiddenFenceRanges(doc) {
  return fenceContentRanges(doc).map((fence) => ({ start: fence.start, end: fence.contentEnd }));
}

function offsetHidden(pos, ranges) {
  return ranges.some((range) => pos >= range.start && pos < range.end);
}

// An opener pairs with the next closer of that same id. Braces inside a fence are
// literal, so they never open or close a span.
function commentTokens(doc) {
  const hidden = hiddenFenceRanges(doc);
  const tokens = [];
  const re = /\{(\/?)([A-Za-z][A-Za-z0-9_-]*)\}/g;
  let match = re.exec(doc);
  while (match) {
    const start = match.index;
    if (!offsetHidden(start, hidden)) {
      tokens.push({
        id: match[2],
        closing: match[1] === "/",
        start,
        end: start + match[0].length,
      });
    }
    match = re.exec(doc);
  }
  return tokens;
}

export function findSpans(doc) {
  const openers = new Map();
  const spans = [];
  for (const token of commentTokens(doc)) {
    if (!token.closing) {
      if (!openers.has(token.id)) openers.set(token.id, []);
      openers.get(token.id).push(token);
      continue;
    }
    const queue = openers.get(token.id);
    if (!queue || queue.length === 0) continue;
    const open = queue.shift();
    spans.push({
      id: token.id,
      openStart: open.start,
      openEnd: open.end,
      closeStart: token.start,
      closeEnd: token.end,
      interiorStart: open.end,
      interiorEnd: token.start,
    });
  }
  return spans;
}

// A span earlier in the prose is listed first. Threads with no span stay behind, in their previous order.
export function orderVisibleComments(comments, doc) {
  const earliest = new Map();
  for (const span of findSpans(doc)) {
    const prev = earliest.get(span.id);
    if (prev == null || span.interiorStart < prev) earliest.set(span.id, span.interiorStart);
  }
  const ranked = comments.map((comment, index) => ({
    comment,
    index,
    at: earliest.has(comment.id) ? earliest.get(comment.id) : null,
  }));
  ranked.sort((a, b) => {
    if (a.at != null && b.at != null && a.at !== b.at) return a.at - b.at;
    if (a.at != null && b.at == null) return -1;
    if (a.at == null && b.at != null) return 1;
    return a.index - b.index;
  });
  return ranked.map((item) => item.comment);
}

function nextCommentId(doc) {
  const used = new Set();
  for (const token of commentTokens(doc)) used.add(token.id);
  for (const fence of fenceContentRanges(doc)) {
    if (fence.lang === "comment" && fence.commentId) used.add(fence.commentId);
  }
  let n = 1;
  while (used.has(`c${n}`)) n += 1;
  return `c${n}`;
}

function rangesOverlap(from, to, start, end) {
  return from < end && to > start;
}

function mergeRanges(ranges) {
  const sorted = ranges
    .filter((range) => range[1] > range[0])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const range of sorted) {
    const prev = out[out.length - 1];
    if (prev && range[0] <= prev[1]) prev[1] = Math.max(prev[1], range[1]);
    else out.push([range[0], range[1]]);
  }
  return out;
}

function shiftDelete(index, from, to) {
  if (index <= from) return index;
  if (index >= to) return index - (to - from);
  return from;
}

function shiftReplace(index, from, to, inserted) {
  if (index <= from) return index;
  if (index >= to) return index + inserted - (to - from);
  return from + inserted;
}

// An intact empty interior is removed in this edit, so one undo restores the
// string from before the keystroke. A thread that is not that span is left
// in place; the caller refuses the splice instead of keeping half a mark.
function cleanupComments(doc, cursor) {
  const spans = findSpans(doc);
  const fences = commentThreads(doc);
  const live = new Set();
  const empty = new Set();
  for (const span of spans) {
    if (span.interiorStart < span.interiorEnd) live.add(span.id);
    else if (span.interiorStart === span.interiorEnd) empty.add(span.id);
  }
  const ranges = [];
  const dropped = new Set();
  for (const span of spans) {
    if (span.interiorStart < span.interiorEnd) continue;
    if (live.has(span.id)) {
      ranges.push([span.openStart, span.openEnd], [span.closeStart, span.closeEnd]);
    } else {
      dropped.add(span.id);
    }
  }
  let broken = false;
  for (const fence of fences) {
    if (live.has(fence.id)) continue;
    dropped.add(fence.id);
    if (!empty.has(fence.id)) broken = true;
  }
  if (dropped.size > 0) {
    const hidden = hiddenFenceRanges(doc);
    for (const token of commentTokens(doc)) {
      if (!dropped.has(token.id) || offsetHidden(token.start, hidden)) continue;
      ranges.push([token.start, token.end]);
    }
    for (const fence of fences) {
      if (dropped.has(fence.id)) ranges.push([fence.start, fence.end]);
    }
  }
  const merged = mergeRanges(ranges);
  if (merged.length === 0) return { doc, cursor, changes: [], broken: false };
  if (broken) return { doc, cursor, changes: [], broken: true };
  let next = doc;
  let nextCursor = cursor;
  const changes = [];
  // High to low, so each later offset is still the index in the doc after the
  // earlier deletions.
  for (let i = merged.length - 1; i >= 0; i -= 1) {
    const [from, to] = merged[i];
    changes.push({ from, to, inserted: "", removed: next.slice(from, to) });
    next = next.slice(0, from) + next.slice(to);
    nextCursor = shiftDelete(nextCursor, from, to);
  }
  return { doc: next, cursor: nextCursor, changes, broken: false };
}

function commentBodyRange(doc, fence) {
  const lines = lineSpans(doc);
  const open = lines[fence.openIndex];
  if (!open) return null;
  const from = open.end < doc.length && doc[open.end] === "\n" ? open.end + 1 : open.end;
  const to = fence.closed ? lines[fence.lastIndex].start : doc.length;
  return { from, to };
}

export function replaceCommentBody(state, id, body) {
  const fence = fenceContentRanges(state.doc).find((item) => item.lang === "comment" && item.commentId === id);
  if (!fence) return state;
  const range = commentBodyRange(state.doc, fence);
  if (!range) return state;
  const text = `${body}\n`;
  const removed = state.doc.slice(range.from, range.to);
  if (removed === text) return state;
  const doc = state.doc.slice(0, range.from) + text + state.doc.slice(range.to);
  return {
    doc,
    cursor: shiftReplace(state.cursor, range.from, range.to, text.length),
    anchor: shiftReplace(state.anchor, range.from, range.to, text.length),
    undo: state.undo.concat([{ doc: state.doc, cursor: state.cursor, anchor: state.anchor }]),
    redo: [],
    changes: [{ from: range.from, to: range.to, inserted: text, removed }],
  };
}

export function removeCommentThread(state, id) {
  const doc = state.doc;
  const ranges = [];
  const fence = fenceContentRanges(doc).find((item) => item.lang === "comment" && item.commentId === id);
  if (fence) {
    let from = fence.start;
    const to = fence.end;
    // addComment separates the fence with a blank line. Dropping that line puts
    // the prose back the way it was before the thread existed.
    if (from >= 2 && doc[from - 1] === "\n" && doc[from - 2] === "\n") from -= 1;
    ranges.push([from, to]);
  }
  const hidden = hiddenFenceRanges(doc);
  for (const token of commentTokens(doc)) {
    if (token.id !== id || offsetHidden(token.start, hidden)) continue;
    ranges.push([token.start, token.end]);
  }
  const merged = mergeRanges(ranges);
  if (merged.length === 0) return state;
  let next = doc;
  let cursor = state.cursor;
  let anchor = state.anchor;
  const changes = [];
  for (let i = merged.length - 1; i >= 0; i -= 1) {
    const [from, to] = merged[i];
    changes.push({ from, to, inserted: "", removed: next.slice(from, to) });
    next = next.slice(0, from) + next.slice(to);
    cursor = shiftDelete(cursor, from, to);
    anchor = shiftDelete(anchor, from, to);
  }
  return {
    doc: next,
    cursor,
    anchor,
    undo: state.undo.concat([{ doc: state.doc, cursor: state.cursor, anchor: state.anchor }]),
    redo: [],
    changes,
  };
}

export function setCommentResolved(state, id, resolved) {
  const lines = lineSpans(state.doc);
  const fence = fenceContentRanges(state.doc).find((item) => item.lang === "comment" && item.commentId === id);
  if (!fence) return state;
  const open = lines[fence.openIndex];
  if (!open) return state;
  const nextHead = resolved ? `\`\`\`comment ${id} resolved` : `\`\`\`comment ${id}`;
  if (open.text === nextHead) return state;
  const doc = state.doc.slice(0, open.start) + nextHead + state.doc.slice(open.end);
  return {
    doc,
    cursor: shiftReplace(state.cursor, open.start, open.end, nextHead.length),
    anchor: shiftReplace(state.anchor, open.start, open.end, nextHead.length),
    undo: state.undo.concat([{ doc: state.doc, cursor: state.cursor, anchor: state.anchor }]),
    redo: [],
    changes: [{ from: open.start, to: open.end, inserted: nextHead, removed: open.text }],
  };
}

function clampRange(text, anchor, cursor) {
  const left = Number.isFinite(anchor) ? anchor : 0;
  const right = Number.isFinite(cursor) ? cursor : 0;
  const from = Math.max(0, Math.min(left, right, text.length));
  const to = Math.max(0, Math.min(text.length, Math.max(left, right)));
  return { from, to };
}

// An empty range is a bare refusal. These three are the named ones.
export function commentRangeReason(doc, anchor, cursor) {
  const text = typeof doc === "string" ? doc : "";
  const { from, to } = clampRange(text, anchor, cursor);
  if (!(from < to)) return null;
  for (const fence of fenceContentRanges(text)) {
    if (rangesOverlap(from, to, fence.start, fence.contentEnd)) return "overlaps a fence";
  }
  for (const atom of structures(text).atoms) {
    if (atom.type === "table" && rangesOverlap(from, to, atom.start, atom.end)) {
      const cells = [...atom.header, ...atom.rows.flat()];
      const inside = cells.some((cell) => from >= cell.start && to <= cell.end && cell.start < cell.end);
      if (!inside) return "overlaps a table";
    }
  }
  for (const span of findSpans(text)) {
    const inside = from >= span.interiorStart && to <= span.interiorEnd;
    const outside = to <= span.openStart || from >= span.closeEnd;
    if (!inside && !outside) return "splits a comment";
  }
  return null;
}

export function addComment(doc, anchor, cursor) {
  const text = typeof doc === "string" ? doc : "";
  const { from, to } = clampRange(text, anchor, cursor);
  if (!(from < to)) return null;
  if (commentRangeReason(text, anchor, cursor)) return null;
  const id = nextCommentId(text);
  const open = `{${id}}`;
  const close = `{/${id}}`;
  const removed = text.slice(from, to);
  const inserted = open + removed + close;
  const marked = text.slice(0, from) + inserted + text.slice(to);
  // The fence is its own site. Bytes between the marks and the fence are not a change.
  let fence = "";
  if (!marked.endsWith("\n")) fence += "\n";
  fence += `\n\`\`\`comment ${id}\n\n\`\`\`\n`;
  const changes = [
    { from, to, inserted, removed },
    { from: marked.length, to: marked.length, inserted: fence, removed: "" },
  ];
  return { doc: marked + fence, id, cursor: from + open.length, changes };
}

function isDelimiterRow(text) {
  let body = text.trim();
  if (!body.includes("-")) return false;
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|")) body = body.slice(0, -1);
  const cells = body.split("|");
  return cells.length > 0 && cells.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell));
}

function isTableStart(lines, index) {
  if (index + 1 >= lines.length) return false;
  const header = lines[index].text;
  if (!header.includes("|") || isDelimiterRow(header)) return false;
  return isDelimiterRow(lines[index + 1].text);
}

function isTableBody(text) {
  return text.trim() !== "" && text.includes("|");
}

function cellRanges(line) {
  const text = line.text;
  const leading = text.length - text.trimStart().length;
  let start = leading;
  let end = text.length - (text.length - text.trimEnd().length);
  if (start < end && text[start] === "|") start += 1;
  if (end > start && text[end - 1] === "|") end -= 1;
  const cells = [];
  let index = start;
  while (index <= end) {
    const pipe = text.indexOf("|", index);
    const cellEnd = pipe < 0 || pipe > end ? end : pipe;
    const raw = text.slice(index, cellEnd);
    const lead = raw.length - raw.trimStart().length;
    const core = raw.trim();
    const at = line.start + index + lead;
    cells.push({ text: core, start: at, end: at + core.length });
    if (cellEnd >= end) break;
    const next = cellEnd + 1;
    if (next <= index) break;
    index = next;
  }
  return cells;
}

const CODE_ALIAS = {
  js: "javascript",
  ts: "typescript",
  py: "python",
  sh: "bash",
  shell: "bash",
  yml: "yaml",
  html: "markup",
  xml: "markup",
};

function codeGrammar(lang) {
  const prism = globalThis.Prism;
  if (!prism || typeof prism.tokenize !== "function" || !prism.languages || !lang) return null;
  const name = Object.prototype.hasOwnProperty.call(CODE_ALIAS, lang) ? CODE_ALIAS[lang] : lang;
  const grammar = prism.languages[name];
  if (!grammar || typeof grammar !== "object") return null;
  return grammar;
}

function flattenTokens(tokens, parentType) {
  const out = [];
  const list = Array.isArray(tokens) ? tokens : [tokens];
  for (const token of list) {
    if (token == null) continue;
    if (typeof token === "string") {
      if (token) out.push({ type: parentType, text: token });
      continue;
    }
    const content = token.content;
    if (typeof content === "string") {
      if (content) out.push({ type: token.type || parentType, text: content });
    } else if (content != null) {
      out.push(...flattenTokens(content, token.type || parentType));
    }
  }
  return out;
}

function codeTokens(line, lang) {
  if (line.start === line.end) return { runs: [], parts: [], images: [] };
  const grammar = codeGrammar(lang);
  const prism = globalThis.Prism;
  if (!grammar || !prism) {
    return parseSlot(line, { kind: "codeblock", marker: 0, indent: 0, plain: "md-codeblock" });
  }
  let tokens;
  try {
    tokens = prism.tokenize(line.text, grammar);
  } catch {
    return parseSlot(line, { kind: "codeblock", marker: 0, indent: 0, plain: "md-codeblock" });
  }
  const pieces = flattenTokens(tokens, null);
  if (pieces.map((piece) => piece.text).join("") !== line.text) {
    return parseSlot(line, { kind: "codeblock", marker: 0, indent: 0, plain: "md-codeblock" });
  }
  const runs = [];
  let at = 0;
  for (const piece of pieces) {
    if (!piece.text) continue;
    const classes = piece.type ? ["md-codeblock", "token", piece.type] : ["md-codeblock"];
    const start = line.start + at;
    const prev = runs[runs.length - 1];
    const same = prev && prev.end === start && prev.classes.length === classes.length
      && prev.classes.every((name, index) => name === classes[index]);
    if (same) {
      prev.text += piece.text;
      prev.end += piece.text.length;
    } else {
      runs.push({
        type: "run",
        text: piece.text,
        start,
        end: start + piece.text.length,
        classes,
      });
    }
    at += piece.text.length;
  }
  if (runs.length === 0) return parseSlot(line, { kind: "codeblock", marker: 0, indent: 0, plain: "md-codeblock" });
  return { runs, parts: runs, images: [] };
}

function matchLinkOrImage(text, index, image) {
  let cursor = index;
  if (image) {
    if (text[cursor] !== "!") return null;
    cursor += 1;
  }
  if (text[cursor] !== "[") return null;
  const labelStart = cursor + 1;
  const labelEnd = text.indexOf("]", labelStart);
  if (labelEnd < 0 || text[labelEnd + 1] !== "(") return null;
  const urlEnd = text.indexOf(")", labelEnd + 2);
  if (urlEnd < 0) return null;
  return {
    start: index,
    end: urlEnd + 1,
    labelStart,
    labelEnd,
    alt: text.slice(labelStart, labelEnd),
    url: text.slice(labelEnd + 2, urlEnd),
  };
}

function parseMarks(text, base, plainClass) {
  const root = { delim: null, marks: [], runs: [], openAt: 0 };
  const stack = [root];
  let index = 0;
  let buf = 0;

  function flush(upto) {
    if (upto <= buf) return;
    const marks = stack[stack.length - 1].marks;
    stack[stack.length - 1].runs.push({
      type: "run",
      text: text.slice(buf, upto),
      start: base + buf,
      end: base + upto,
      classes: marks.length > 0 ? marks.slice() : [plainClass],
    });
    buf = upto;
  }

  while (index < text.length) {
    const top = stack[stack.length - 1];
    if (top.delim && text.startsWith(top.delim, index)) {
      flush(index);
      const frame = stack.pop();
      const parent = stack[stack.length - 1];
      for (const run of frame.runs) parent.runs.push(run);
      index += top.delim.length;
      buf = index;
      continue;
    }
    let opener = null;
    if (text.startsWith("**", index) || text.startsWith("__", index)) opener = text.slice(index, index + 2);
    else if (text[index] === "*" || text[index] === "_") opener = text[index];
    if (opener) {
      flush(index);
      const kind = opener.length === 2 ? "md-strong" : "md-em";
      stack.push({
        delim: opener,
        marks: stack[stack.length - 1].marks.concat(kind),
        runs: [],
        openAt: index,
      });
      index += opener.length;
      buf = index;
      continue;
    }
    index += 1;
  }
  flush(text.length);
  while (stack.length > 1) {
    const frame = stack.pop();
    const parent = stack[stack.length - 1];
    const kind = frame.delim.length === 2 ? "md-strong" : "md-em";
    const parentClasses = parent.marks.length > 0 ? parent.marks.slice() : [plainClass];
    parent.runs.push({
      type: "run",
      text: frame.delim,
      start: base + frame.openAt,
      end: base + frame.openAt + frame.delim.length,
      classes: parentClasses.slice(),
    });
    for (const run of frame.runs) {
      run.classes = run.classes.filter((name) => name !== kind);
      if (run.classes.length === 0) run.classes = parentClasses.slice();
      parent.runs.push(run);
    }
  }
  root.runs.sort((a, b) => a.start - b.start || a.end - b.end);
  return root.runs.filter((run) => run.text.length > 0);
}

function parseInlines(text, base, plainClass) {
  const parts = [];
  let index = 0;
  let textStart = 0;

  function flushText(upto) {
    if (upto <= textStart) return;
    const runs = parseMarks(text.slice(textStart, upto), base + textStart, plainClass);
    for (const run of runs) parts.push(run);
    textStart = upto;
  }

  while (index < text.length) {
    if (text.startsWith("![", index)) {
      const image = matchLinkOrImage(text, index, true);
      if (image) {
        flushText(index);
        parts.push({
          type: "image",
          start: base + image.start,
          end: base + image.end,
          alt: image.alt,
          url: image.url,
        });
        index = image.end;
        textStart = index;
        continue;
      }
    }
    if (text[index] === "[") {
      const link = matchLinkOrImage(text, index, false);
      if (link) {
        flushText(index);
        const labelRuns = parseMarks(link.alt, base + link.labelStart, "md-link");
        for (const run of labelRuns) {
          if (!run.classes.includes("md-link")) run.classes = run.classes.concat("md-link");
          run.href = link.url;
          parts.push(run);
        }
        index = link.end;
        textStart = index;
        continue;
      }
    }
    if (text[index] === "`") {
      const close = text.indexOf("`", index + 1);
      if (close > index + 1) {
        flushText(index);
        parts.push({
          type: "run",
          text: text.slice(index + 1, close),
          start: base + index + 1,
          end: base + close,
          classes: ["md-code"],
        });
        index = close + 1;
        textStart = index;
        continue;
      }
    }
    index += 1;
  }
  flushText(text.length);
  return {
    parts,
    runs: parts.filter((part) => part.type === "run"),
    images: parts.filter((part) => part.type === "image"),
  };
}

function parseSlot(line, mode) {
  if (mode.kind === "codeblock") {
    if (line.start === line.end) return { runs: [], parts: [], images: [] };
    const run = {
      type: "run",
      text: line.text,
      start: line.start,
      end: line.end,
      classes: ["md-codeblock"],
    };
    return { runs: [run], parts: [run], images: [] };
  }
  if (mode.kind === "hr" || line.start === line.end) return { runs: [], parts: [], images: [] };
  return parseInlines(line.text.slice(mode.marker), line.start + mode.marker, mode.plain);
}

function lineBlank(text) {
  return text === "";
}

// A line that is only an image is one paragraph, so it does not join its neighbors.
function imageLine(text) {
  const core = text.trim();
  if (!core.startsWith("!")) return false;
  const image = matchLinkOrImage(core, 0, true);
  return image !== null && image.end === core.length;
}

function pushLines(spans, lines, from, to) {
  spans.push({ start: lines[from].start, end: lines[to].end });
}

// lineSpans adds an empty line at length when the text ends in a newline.
function lockLines(doc) {
  const lines = lineSpans(doc);
  const last = lines[lines.length - 1];
  if (lines.length > 1 && last.start === doc.length) lines.pop();
  return lines;
}

// Quote markers are written once. The next block, including a child item, is its own span.
function plainJoin(lines, index) {
  let last = index;
  for (let next = index + 1; next < lines.length; next += 1) {
    const text = lines[next].text;
    if (lineBlank(text) || imageLine(text) || fenceOpen(text) || isTableStart(lines, next)) break;
    if (classify(text).kind !== "p") break;
    last = next;
  }
  return last;
}

// Continuation is a non-item line. Any item starts the next span.
function listJoin(lines, index) {
  let last = index;
  for (let next = index + 1; next < lines.length; next += 1) {
    const text = lines[next].text;
    if (lineBlank(text) || imageLine(text) || fenceOpen(text) || isTableStart(lines, next)) break;
    const mode = classify(text);
    if (mode.kind === "h" || mode.kind === "hr" || mode.kind === "quote") break;
    if (mode.kind === "li" || mode.kind === "ol") break;
    last = next;
  }
  return last;
}

function fenceEnd(lines, index) {
  let end = index + 1;
  while (end < lines.length && !isFenceClose(lines[end].text)) end += 1;
  const closed = end < lines.length;
  return { closed, last: closed ? end : lines.length - 1 };
}

export function lockSpans(doc) {
  const text = typeof doc === "string" ? doc : "";
  const lines = lockLines(text);
  const spans = [];
  let index = 0;
  while (index < lines.length) {
    const textLine = lines[index].text;
    const opened = fenceOpen(textLine);
    if (opened) {
      const fence = fenceEnd(lines, index);
      if (opened.lang === "comment") {
        pushLines(spans, lines, index, index);
        const stop = fence.closed ? fence.last : lines.length;
        let note = index + 1;
        while (note < stop) {
          let next = note + 1;
          while (next < stop && separatorId(lines[next].text) === undefined) next += 1;
          pushLines(spans, lines, note, next - 1);
          note = next;
        }
        if (fence.closed) pushLines(spans, lines, fence.last, fence.last);
      } else {
        pushLines(spans, lines, index, fence.last);
      }
      index = fence.last + 1;
      continue;
    }
    if (isTableStart(lines, index)) {
      pushLines(spans, lines, index, index + 1);
      let row = index + 2;
      while (row < lines.length && isTableBody(lines[row].text)) {
        pushLines(spans, lines, row, row);
        row += 1;
      }
      index = row;
      continue;
    }
    if (lineBlank(textLine) || imageLine(textLine)) {
      pushLines(spans, lines, index, index);
      index += 1;
      continue;
    }
    const mode = classify(textLine);
    if (mode.kind === "h" || mode.kind === "hr") {
      pushLines(spans, lines, index, index);
      index += 1;
      continue;
    }
    const last = mode.kind === "li" || mode.kind === "ol" ? listJoin(lines, index) : plainJoin(lines, index);
    pushLines(spans, lines, index, last);
    index = last + 1;
  }
  return spans;
}

export function lockIndexAt(doc, cursor) {
  const spans = lockSpans(doc);
  for (let index = 0; index < spans.length; index += 1) {
    if (cursor >= spans[index].start && cursor <= spans[index].end) return index;
  }
  return Math.max(0, spans.length - 1);
}

function paintCell(cell, doc) {
  const parsed = parseInlines(cell.text, cell.start, "md-p");
  return { ...cell, parts: paintParts(parsed.parts, findSpans(doc)) };
}

function structures(doc) {
  // lineSpans adds an empty row at length. It is not a block, same as lockLines.
  const lines = lockLines(doc);
  const atoms = [];
  const slots = [];
  let index = 0;
  while (index < lines.length) {
    const opened = fenceOpen(lines[index].text);
    if (opened) {
      let end = index + 1;
      while (end < lines.length && !isFenceClose(lines[end].text)) end += 1;
      const closed = end < lines.length;
      const last = closed ? end : lines.length - 1;
      if (opened.lang === "comment") {
        index = last + 1;
        continue;
      }
      if (opened.diagram) {
        const bodyLines = lines.slice(index + 1, closed ? last : last + 1);
        const atom = {
          type: "diagram",
          start: lines[index].start,
          end: lines[last].end,
          info: opened.lang,
          body: bodyLines.map((line) => line.text).join("\n"),
          bodyStart: index + 1 < lines.length ? lines[index + 1].start : lines[index].end,
        };
        atoms.push(atom);
        slots.push({ kind: "atom", atom });
      } else {
        const fenceLines = [];
        for (let line = index; line <= last; line += 1) {
          fenceLines.push(lines[line]);
        }
        slots.push({
          kind: "fence",
          lang: opened.lang,
          closed,
          lines: fenceLines,
        });
      }
      index = last + 1;
      continue;
    }
    if (isTableStart(lines, index)) {
      let end = index + 2;
      while (end < lines.length && isTableBody(lines[end].text)) end += 1;
      const last = end - 1;
      const rows = [];
      for (let line = index + 2; line <= last; line += 1) rows.push(cellRanges(lines[line]));
      const atom = {
        type: "table",
        start: lines[index].start,
        end: lines[last].end,
        header: cellRanges(lines[index]).map((cell) => paintCell(cell, doc)),
        rows: rows.map((row) => row.map((cell) => paintCell(cell, doc))),
      };
      atoms.push(atom);
      slots.push({ kind: "atom", atom });
      index = last + 1;
      continue;
    }
    const mode = classify(lines[index].text);
    const parsed = parseSlot(lines[index], mode);
    for (const image of parsed.images) atoms.push(image);
    slots.push({ kind: "line", line: lines[index], mode, parsed });
    index += 1;
  }
  return { atoms, slots, comments: commentThreads(doc) };
}

function gapRun(line, start, end) {
  return {
    type: "run",
    text: line.text.slice(start - line.start, end - line.start),
    start,
    end,
    classes: ["md-syntax"],
  };
}

function cloneRun(run) {
  const copy = {
    type: "run",
    text: run.text,
    start: run.start,
    end: run.end,
    classes: run.classes.slice(),
  };
  if (run.href !== undefined) copy.href = run.href;
  return copy;
}

function isSyntax(run) {
  return run.classes.length === 1 && run.classes[0] === "md-syntax";
}

function styleOf(run) {
  return run.classes.filter((name) => name !== "md-syntax");
}

function sameRunStyle(a, b) {
  if (a.href !== b.href) return false;
  if (a.classes.length !== b.classes.length) return false;
  for (let i = 0; i < a.classes.length; i += 1) {
    if (a.classes[i] !== b.classes[i]) return false;
  }
  return true;
}

function mergeRuns(runs) {
  const out = [];
  for (const run of runs) {
    const prev = out[out.length - 1];
    if (prev && prev.end === run.start && sameRunStyle(prev, run)) {
      prev.end = run.end;
      prev.text += run.text;
      continue;
    }
    out.push(cloneRun(run));
  }
  return out;
}

// Inner mark first: classes list the outer mark first.
function innerMarks(classes) {
  const marks = [];
  for (let i = classes.length - 1; i >= 0; i -= 1) {
    const name = classes[i];
    if (name === "md-strong" || name === "md-em" || name === "md-code") marks.push(name);
  }
  return marks;
}

function prefixSize(text, index, mark) {
  if (mark === "md-code") return text[index] === "`" ? 1 : 0;
  if (mark === "md-em") {
    const ch = text[index];
    return ch === "*" || ch === "_" ? 1 : 0;
  }
  if (mark === "md-strong") {
    const two = text.slice(index, index + 2);
    return two === "**" || two === "__" ? 2 : 0;
  }
  return 0;
}

function suffixSize(text, end, mark) {
  if (end <= 0) return 0;
  if (mark === "md-code") return text[end - 1] === "`" ? 1 : 0;
  if (mark === "md-em") {
    const ch = text[end - 1];
    return ch === "*" || ch === "_" ? 1 : 0;
  }
  if (mark === "md-strong") {
    const two = text.slice(end - 2, end);
    return two === "**" || two === "__" ? 2 : 0;
  }
  return 0;
}

function attracts(classes) {
  return classes.includes("md-strong")
    || classes.includes("md-em")
    || classes.includes("md-code")
    || classes.includes("md-link");
}

function takePrefix(text, run) {
  const classes = styleOf(run);
  if (!attracts(classes)) return 0;
  let index = 0;
  for (const mark of innerMarks(classes)) {
    const size = prefixSize(text, index, mark);
    if (size === 0) return index;
    index += size;
  }
  if (classes.includes("md-link")) {
    const closer = `](${run.href ?? ""})`;
    if (text.startsWith(closer, index)) index += closer.length;
  }
  return index;
}

function takeSuffix(text, run) {
  const classes = styleOf(run);
  if (!attracts(classes)) return 0;
  let end = text.length;
  for (const mark of innerMarks(classes)) {
    const size = suffixSize(text, end, mark);
    if (size === 0) return text.length - end;
    end -= size;
  }
  if (classes.includes("md-link") && end > 0 && text[end - 1] === "[") end -= 1;
  return text.length - end;
}

function styledPiece(line, start, end, run) {
  const piece = {
    type: "run",
    text: line.text.slice(start - line.start, end - line.start),
    start,
    end,
    classes: styleOf(run),
  };
  if (run.href !== undefined) piece.href = run.href;
  return piece;
}

// A delimiter takes the classes of the run it belongs to. md-syntax stays only on
// text that has no style, such as an image token.
function restyleMarkers(line, mode, runs) {
  const items = runs.map(cloneRun);
  const markerEnd = Math.min(line.end, line.start + (mode.marker || 0));
  if (
    mode.plain !== "md-p"
    && markerEnd > line.start
    && items.length > 0
    && items[0].start === line.start
    && items[0].end === markerEnd
    && isSyntax(items[0])
  ) {
    items[0].classes = [mode.plain];
  }
  const peeled = [];
  for (let i = 0; i < items.length; i += 1) {
    const run = items[i];
    if (!isSyntax(run)) {
      const style = styleOf(run);
      if (style.length > 0 && style.length !== run.classes.length) run.classes = style;
      peeled.push(run);
      continue;
    }
    const left = i > 0 ? items[i - 1] : null;
    const right = i + 1 < items.length ? items[i + 1] : null;
    let text = run.text;
    let start = run.start;
    if (left && !isSyntax(left)) {
      const size = takePrefix(text, left);
      if (size > 0) {
        peeled.push(styledPiece(line, start, start + size, left));
        start += size;
        text = text.slice(size);
      }
    }
    let suffix = 0;
    if (right && !isSyntax(right) && text.length > 0) suffix = takeSuffix(text, right);
    const mid = text.length - suffix;
    if (mid > 0) {
      peeled.push({
        type: "run",
        text: text.slice(0, mid),
        start,
        end: start + mid,
        classes: ["md-syntax"],
      });
    }
    if (suffix > 0) {
      const suf = start + mid;
      peeled.push(styledPiece(line, suf, suf + suffix, right));
    }
  }
  return peeled;
}

// The block marker is its own run so it does not merge with a following inline gap.
function fillGaps(line, mode, parsed) {
  const runs = [];
  let at = line.start;
  const markerEnd = Math.min(line.end, line.start + (mode.marker || 0));
  if (markerEnd > at) {
    runs.push(gapRun(line, at, markerEnd));
    at = markerEnd;
  }
  const content = parsed.runs
    .filter((run) => run.start >= at && run.end <= line.end && run.end > run.start)
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end);
  for (const run of content) {
    if (run.start > at) runs.push(gapRun(line, at, run.start));
    runs.push(run);
    at = run.end;
  }
  if (at < line.end) runs.push(gapRun(line, at, line.end));
  return mergeRuns(restyleMarkers(line, mode, runs));
}

function spansTouching(spans, start, end) {
  return spans.filter((span) => start < span.closeEnd && end > span.openStart);
}

// Comment markers stay md-syntax on the cursor line and disappear off it, so they
// never merge into the interior they wrap.
function splitPainted(run, spans, keepMarkers) {
  if (!run || run.type !== "run") return [run];
  const relevant = spansTouching(spans, run.start, run.end);
  if (relevant.length === 0) return [run];
  const cuts = new Set([run.start, run.end]);
  for (const span of relevant) {
    for (const point of [span.openStart, span.openEnd, span.closeStart, span.closeEnd]) {
      if (point > run.start && point < run.end) cuts.add(point);
    }
  }
  const points = Array.from(cuts).sort((a, b) => a - b);
  const pieces = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const piece = paintSlice(run, spans, points[i], points[i + 1], keepMarkers);
    if (piece) pieces.push(piece);
  }
  return pieces;
}

function paintSlice(run, spans, start, end, keepMarkers) {
  const text = run.text.slice(start - run.start, end - run.start);
  if (!text) return null;
  const marker = spans.find((span) =>
    (start >= span.openStart && start < span.openEnd) || (start >= span.closeStart && start < span.closeEnd));
  if (marker) {
    if (!keepMarkers) return null;
    return { type: "run", text, start, end, classes: ["md-syntax"] };
  }
  const containers = spans.filter((span) => start >= span.interiorStart && start < span.interiorEnd);
  if (containers.length === 0) {
    if (start === run.start && end === run.end) return run;
    const copy = cloneRun(run);
    copy.text = text;
    copy.start = start;
    copy.end = end;
    return copy;
  }
  containers.sort((a, b) =>
    (a.interiorEnd - a.interiorStart) - (b.interiorEnd - b.interiorStart) || a.interiorStart - b.interiorStart);
  const copy = cloneRun(run);
  copy.text = text;
  copy.start = start;
  copy.end = end;
  if (!copy.classes.includes("md-comment")) copy.classes = copy.classes.concat("md-comment");
  copy.comment = containers[0].id;
  return copy;
}

function paintRuns(runs, spans, keepMarkers) {
  if (!spans || spans.length === 0) return runs;
  const out = [];
  let changed = false;
  for (const run of runs) {
    const pieces = splitPainted(run, spans, keepMarkers);
    if (pieces.length !== 1 || pieces[0] !== run) changed = true;
    for (const piece of pieces) out.push(piece);
  }
  return changed ? out : runs;
}

function paintImage(image, spans) {
  const containers = spans.filter((span) => image.start >= span.interiorStart && image.end <= span.interiorEnd);
  if (containers.length === 0) return image;
  containers.sort((a, b) =>
    (a.interiorEnd - a.interiorStart) - (b.interiorEnd - b.interiorStart) || a.interiorStart - b.interiorStart);
  return { ...image, comment: containers[0].id };
}

function paintParts(parts, spans) {
  if (!spans || spans.length === 0) return parts;
  const out = [];
  let changed = false;
  for (const part of parts) {
    if (part.type === "image") {
      const painted = paintImage(part, spans);
      if (painted !== part) changed = true;
      out.push(painted);
      continue;
    }
    const pieces = splitPainted(part, spans, false);
    if (pieces.length !== 1 || pieces[0] !== part) changed = true;
    for (const piece of pieces) out.push(piece);
  }
  return changed ? out : parts;
}

function blockClasses(mode, raw) {
  const names = [];
  if (raw) names.push("md-raw");
  if (mode.quoted) names.push("md-quote");
  names.push(mode.plain);
  return names;
}

function orderedMarker(line, mode) {
  let text = line.text.slice(0, mode.marker || 0);
  if (mode.quoted) text = text.slice(mode.quote || 0);
  return text.replace(/^[ \t]+/, "");
}

function rawBlock(line, mode, parsed, spans) {
  const empty = line.start === line.end;
  let runs = empty ? [] : paintRuns(fillGaps(line, mode, parsed), spans, true);
  // The quote mark is the bar. A one-line quoted item still does not show ">".
  if (!empty && mode.quoted && mode.quote) runs = dropPrefix(runs, line.start + mode.quote);
  return {
    type: "line",
    raw: true,
    empty,
    start: line.start,
    end: line.end,
    text: line.text,
    classes: blockClasses(mode, true),
    runs,
    parts: runs,
    indent: mode.indent ?? 0,
  };
}

function renderedBlock(line, mode, parsed, spans) {
  if (line.start === line.end) {
    return {
      type: "line",
      raw: false,
      empty: true,
      start: line.start,
      end: line.end,
      text: "",
      classes: blockClasses(mode, false),
      runs: [],
      parts: [],
      indent: mode.indent ?? 0,
    };
  }
  if (mode.kind === "hr") {
    return {
      type: "line",
      raw: false,
      hr: true,
      empty: false,
      start: line.start,
      end: line.end,
      text: line.text,
      classes: ["md-hr"],
      runs: [],
      parts: [],
      indent: mode.indent ?? 0,
    };
  }
  const parts = paintParts(parsed.parts, spans);
  const block = {
    type: "line",
    raw: false,
    empty: false,
    start: line.start,
    end: line.end,
    text: line.text,
    classes: blockClasses(mode, false),
    runs: parts === parsed.parts ? parsed.runs : parts.filter((part) => part.type === "run"),
    parts,
    indent: mode.indent ?? 0,
  };
  if (mode.kind === "ol") block.marker = orderedMarker(line, mode);
  return block;
}

function linesBetween(doc, start, end) {
  const found = [];
  for (const line of lineSpans(doc)) {
    if (line.start < start) continue;
    if (line.start > end || line.end > end) break;
    found.push(line);
  }
  return found;
}

// Two trailing spaces, or a trailing backslash, mark a hard break.
function hardHideCount(text) {
  if (text.endsWith("\\")) return 1;
  let count = 0;
  for (let i = text.length - 1; i >= 0 && text[i] === " "; i -= 1) count += 1;
  return count >= 2 ? count : 0;
}

function clonePart(part) {
  if (!part || part.type !== "run") return { ...part };
  const copy = cloneRun(part);
  if (part.comment !== undefined) copy.comment = part.comment;
  return copy;
}

function trimTail(parts, hide) {
  let left = hide;
  const out = parts.slice();
  while (left > 0 && out.length > 0) {
    const last = out[out.length - 1];
    if (!last || last.type !== "run" || last.text.length === 0) break;
    const n = Math.min(left, last.text.length);
    last.end -= n;
    last.text = last.text.slice(0, last.text.length - n);
    left -= n;
    if (last.text.length === 0) out.pop();
  }
  return out;
}

function breakPart(offset) {
  return {
    type: "break",
    text: "",
    start: offset,
    end: offset + 1,
    classes: ["md-break"],
  };
}

function joinParts(offset, spans, raw, plain) {
  const run = {
    type: "run",
    text: " ",
    start: offset,
    end: offset + 1,
    classes: [plain || "md-p"],
  };
  const painted = raw ? paintRuns([run], spans, true) : paintParts([run], spans);
  if (!painted || painted.length === 0) return [run];
  return painted.map(clonePart);
}

function proseSlot(slot) {
  if (!slot || slot.kind !== "line") return false;
  const { line, mode } = slot;
  if (!line || !mode || mode.kind !== "p") return false;
  if (line.text === "") return false;
  if (imageLine(line.text)) return false;
  return true;
}

function openingLock(locks, slot) {
  const start = slot.line.start;
  for (let i = 0; i < locks.length; i += 1) {
    const lock = locks[i];
    if (start < lock.start || start > lock.end) continue;
    if (lock.start === start && lock.end > slot.line.end) return lock;
    return null;
  }
  return null;
}

function paragraphLock(locks, slot) {
  if (!proseSlot(slot)) return null;
  return openingLock(locks, slot);
}

// A quoted paragraph is the lock that opens with "> " and runs through plain lines.
function quoteSlot(slot) {
  if (!slot || slot.kind !== "line") return false;
  const { line, mode } = slot;
  if (!line || !mode || mode.kind !== "quote") return false;
  if (line.text === "") return false;
  return true;
}

function quotedLock(locks, slot) {
  if (!quoteSlot(slot)) return null;
  return openingLock(locks, slot);
}

// A child item is the next lock, so only the opener of this item starts the block.
function listSlot(slot) {
  if (!slot || slot.kind !== "line") return false;
  const { line, mode } = slot;
  if (!line || !mode) return false;
  if (mode.kind !== "li" && mode.kind !== "ol") return false;
  if (line.text === "") return false;
  return true;
}

function listLock(locks, slot) {
  if (!listSlot(slot)) return null;
  return openingLock(locks, slot);
}

// The quote marker is syntax. The left bar is the quote mark, so it is not shown.
function dropPrefix(parts, cut) {
  const out = [];
  for (const part of parts) {
    if (!part || part.end <= cut) continue;
    if (part.start >= cut || part.type !== "run") {
      out.push(part);
      continue;
    }
    const copy = clonePart(part);
    copy.text = copy.text.slice(cut - copy.start);
    copy.start = cut;
    if (copy.text.length > 0 && copy.end > copy.start) out.push(copy);
  }
  return out;
}

function openerMarker(slot, index) {
  if (index !== 0 || !slot || !slot.mode) return 0;
  const kind = slot.mode.kind;
  if (kind !== "quote" && kind !== "li" && kind !== "ol") return 0;
  return slot.mode.marker || 0;
}

function linePieces(slot, spans, raw) {
  const { line, mode, parsed } = slot;
  const source = raw
    ? paintRuns(fillGaps(line, mode, parsed), spans, true)
    : paintParts(parsed.parts, spans);
  return source.map(clonePart);
}

function hardenBreak(block, line, doc) {
  if (!block || block.type !== "line" || block.hr || block.empty || block.collapsed) return;
  if (!line || line.end >= doc.length || doc[line.end] !== "\n") return;
  let hide = hardHideCount(line.text);
  if (/^[ \t]+$/.test(line.text) && hide !== line.text.length) hide = line.text.length;
  if (hide === 0) return;
  const parts = trimTail((block.parts || []).map(clonePart), hide);
  parts.push(breakPart(line.end));
  block.parts = parts;
  block.runs = parts.filter((part) => part.type === "run");
  block.text = block.runs.map((run) => run.text).join("");
  // The line is only the marker, so the one caret on it is the line start.
  // The break still owns the newline, which a click on that br has to reach.
  if (hide === line.text.length) block.slot = line.start;
}

function bareBreakLine(line, doc) {
  if (!line || line.end >= doc.length || doc[line.end] !== "\n") return false;
  const hide = hardHideCount(line.text);
  return hide > 0 && hide === line.text.length;
}

// A line move on a spaces-only hard break rests on the newline that break draws.
// The line start stays the character stop.
export function lineCaret(doc, offset) {
  const text = typeof doc === "string" ? doc : "";
  const at = Math.max(0, Math.min(text.length, Number.isFinite(offset) ? offset : 0));
  const line = sourceLine(text, at);
  if (bareBreakLine(line, text)) return line.end;
  return at;
}

// A tab advances to the next multiple of 4, the same stop classifyList uses.
function contentColumn(text, marker) {
  const count = Math.min(Math.max(0, marker || 0), text.length);
  let column = 0;
  for (let i = 0; i < count; i += 1) {
    column += text[i] === "\t" ? 4 - (column % 4) : 1;
  }
  return column;
}

// Character count of the leading spaces and tabs that sit inside `columns`.
function continuationIndent(text, columns) {
  let column = 0;
  let index = 0;
  while (index < text.length && column < columns) {
    const ch = text[index];
    if (ch !== " " && ch !== "\t") break;
    column += ch === "\t" ? 4 - (column % 4) : 1;
    index += 1;
  }
  return index;
}

// Indent columns are not words. Zero-width spaces keep a caret on each one.
function foldOlIndent(pieces, lineStart, leading) {
  const cut = lineStart + leading;
  const indent = {
    type: "indent",
    text: "\u200b".repeat(leading),
    start: lineStart,
    end: cut,
    classes: ["md-ol-indent"],
  };
  const out = [];
  let placed = false;
  for (const part of pieces) {
    if (!part || part.end <= part.start || part.type !== "run" || part.end <= lineStart || part.start >= cut) {
      out.push(part);
      continue;
    }
    if (part.start < lineStart) {
      const head = clonePart(part);
      head.end = lineStart;
      head.text = head.text.slice(0, lineStart - part.start);
      if (head.text.length > 0 && head.end > head.start) out.push(head);
    }
    if (!placed) {
      out.push(indent);
      placed = true;
    }
    if (part.end > cut) {
      const tail = clonePart(part);
      tail.text = tail.text.slice(cut - part.start);
      tail.start = cut;
      if (tail.text.length > 0 && tail.end > tail.start) out.push(tail);
    }
  }
  return placed ? out : pieces;
}

function wrappedBlock(group, doc, cursor, spans) {
  const start = group[0].line.start;
  const end = group[group.length - 1].line.end;
  const raw = cursor >= start && cursor <= end;
  const plain = group[0].mode.plain;
  const parts = [];
  for (let i = 0; i < group.length; i += 1) {
    const slot = group[i];
    const newline = slot.line.end < doc.length && doc[slot.line.end] === "\n";
    // The separator belongs to the marker, so it is not a hard break.
    const marker = openerMarker(slot, i);
    const source = marker > 0 ? slot.line.text.slice(Math.min(marker, slot.line.text.length)) : slot.line.text;
    const hide = newline ? hardHideCount(source) : 0;
    let pieces = linePieces(slot, spans, raw);
    if (hide > 0) pieces = trimTail(pieces, hide);
    // A raw list keeps its marker in the text. A rendered list hides it and draws one bullet.
    // The quote mark is never text. A quoted item still shows its list marker when raw.
    if (marker > 0 && (slot.mode.kind === "quote" || !raw)) {
      pieces = dropPrefix(pieces, slot.line.start + marker);
    } else if (raw && slot.mode.quoted && slot.mode.quote) {
      pieces = dropPrefix(pieces, slot.line.start + slot.mode.quote);
    }
    // A hard break stays a break, so the next line keeps the spaces it wrote.
    if (i > 0 && group[0].mode.kind === "ol") {
      const prev = group[i - 1];
      const prevNewline = prev.line.end < doc.length && doc[prev.line.end] === "\n";
      const prevMarker = openerMarker(prev, i - 1);
      const prevSource = prevMarker > 0
        ? prev.line.text.slice(Math.min(prevMarker, prev.line.text.length))
        : prev.line.text;
      if (prevNewline && hardHideCount(prevSource) === 0) {
        const columns = contentColumn(group[0].line.text, group[0].mode.marker || 0);
        const leading = continuationIndent(slot.line.text, columns);
        if (leading > 0) pieces = foldOlIndent(pieces, slot.line.start, leading);
      }
    }
    for (const piece of pieces) parts.push(piece);
    if (!newline) continue;
    if (hide > 0) parts.push(breakPart(slot.line.end));
    else if (i < group.length - 1) {
      for (const piece of joinParts(slot.line.end, spans, raw, plain)) parts.push(piece);
    }
  }
  const runs = parts.filter((part) => part.type === "run");
  const block = {
    type: "line",
    raw,
    empty: false,
    start,
    end,
    text: runs.map((run) => run.text).join(""),
    classes: blockClasses(group[0].mode, raw),
    runs,
    parts,
    // Continuation lines are plain, so the indent is the opener's.
    indent: group[0].mode.indent ?? 0,
  };
  if (!raw && group[0].mode.kind === "ol") block.marker = orderedMarker(group[0].line, group[0].mode);
  return block;
}

// Rendered fences hide the marker lines. The caret still owns the whole lock, including end,
// because an empty fence's br maps there and must open the source.
function fenceShown(lines, closed, raw) {
  if (raw) return lines;
  const to = closed ? lines.length - 1 : lines.length;
  if (to <= 1) return [];
  return lines.slice(1, to);
}

function fencePieces(line, lang, raw, spans) {
  if (line.start === line.end) return [];
  if (raw) {
    const mode = { kind: "codeblock", marker: 0, indent: 0, plain: "md-codeblock" };
    return paintRuns(fillGaps(line, mode, parseSlot(line, mode)), spans, true).map(clonePart);
  }
  return paintParts(codeTokens(line, lang).parts, spans).map(clonePart);
}

function fenceBlock(slot, cursor, spans) {
  const lines = slot.lines;
  const start = lines[0].start;
  const end = lines[lines.length - 1].end;
  const raw = cursor >= start && cursor <= end;
  const shown = fenceShown(lines, slot.closed, raw);
  const parts = [];
  for (let i = 0; i < shown.length; i += 1) {
    for (const piece of fencePieces(shown[i], slot.lang, raw, spans)) parts.push(piece);
    if (i < shown.length - 1) parts.push(breakPart(shown[i].end));
  }
  const runs = parts.filter((part) => part.type === "run");
  return {
    type: "line",
    raw,
    empty: false,
    start,
    end,
    text: runs.map((run) => run.text).join(""),
    classes: blockClasses({ kind: "codeblock", marker: 0, indent: 0, plain: "md-codeblock" }, raw),
    runs,
    parts,
    indent: 0,
  };
}

// end is the newline after the last line. A caret there is inside, so the atom opens.
function expandAtom(blocks, doc, atom, cursor, spans) {
  const lines = linesBetween(doc, atom.start, atom.end);
  const code = atom.type === "diagram";
  const mode = code
    ? { kind: "codeblock", marker: 0, indent: 0, plain: "md-codeblock" }
    : { kind: "p", marker: 0, indent: 0, plain: "md-p" };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const edge = code && (i === 0 || (i === lines.length - 1 && isFenceClose(line.text)));
    const parsed = code
      ? (edge ? parseSlot(line, mode) : codeTokens(line, atom.info))
      : parseSlot(line, mode);
    const onLine = cursor >= line.start && cursor <= line.end;
    blocks.push(onLine ? rawBlock(line, mode, parsed, spans) : renderedBlock(line, mode, parsed, spans));
  }
}

function quotedBlock(block) {
  return Boolean(block && block.type === "line" && !block.empty && block.classes && block.classes.includes("md-quote"));
}

function blankBlock(block) {
  return Boolean(block && block.type === "line" && block.empty);
}

function addQuoteBar(block) {
  if (block.classes.includes("md-quote")) return;
  const names = [];
  if (block.classes[0] === "md-raw") names.push("md-raw");
  names.push("md-quote");
  for (const name of block.classes) {
    if (name !== "md-raw") names.push(name);
  }
  block.classes = names;
}

function pushLine(blocks, slot, text, cursor, spans) {
  const { line, mode, parsed } = slot;
  const onLine = cursor >= line.start && cursor <= line.end;
  const block = onLine ? rawBlock(line, mode, parsed, spans) : renderedBlock(line, mode, parsed, spans);
  if (mode.kind === "p" && !imageLine(line.text)) hardenBreak(block, line, text);
  blocks.push(block);
}

// A line that is only a hard-break marker is its own caret slot. Leaving it inside
// the wrap gives that offset no element the caret can sit on.
function pushGroup(blocks, group, text, cursor, spans) {
  let chunk = [];
  const flush = () => {
    if (chunk.length === 0) return;
    if (chunk.length > 1) blocks.push(wrappedBlock(chunk, text, cursor, spans));
    else pushLine(blocks, chunk[0], text, cursor, spans);
    chunk = [];
  };
  for (const item of group) {
    if (bareBreakLine(item.line, text)) {
      flush();
      pushLine(blocks, item, text, cursor, spans);
    } else {
      chunk.push(item);
    }
  }
  flush();
}

function continueQuoteBars(blocks) {
  let index = 0;
  while (index < blocks.length) {
    if (!blankBlock(blocks[index])) {
      index += 1;
      continue;
    }
    const from = index;
    while (index < blocks.length && blankBlock(blocks[index])) index += 1;
    if (!quotedBlock(blocks[from - 1]) || !quotedBlock(blocks[index])) continue;
    for (let i = from; i < index; i += 1) addQuoteBar(blocks[i]);
  }
}

export function plan(doc, cursor) {
  const text = typeof doc === "string" ? doc : "";
  const built = structures(text);
  const { slots } = built;
  const comments = built.comments || [];
  const spans = findSpans(text);
  const locks = lockSpans(text);
  const blocks = [];
  let index = 0;
  while (index < slots.length) {
    const slot = slots[index];
    if (slot.kind === "atom") {
      const atom = slot.atom;
      if ((atom.type === "table" || atom.type === "diagram") && cursor >= atom.start && cursor <= atom.end) {
        expandAtom(blocks, doc, atom, cursor, spans);
      } else {
        blocks.push(atom);
      }
      index += 1;
      continue;
    }
    if (slot.kind === "fence") {
      blocks.push(fenceBlock(slot, cursor, spans));
      index += 1;
      continue;
    }
    const lock = paragraphLock(locks, slot) || quotedLock(locks, slot) || listLock(locks, slot);
    if (lock) {
      const group = [slot];
      let next = index + 1;
      while (next < slots.length && proseSlot(slots[next]) && slots[next].line.start <= lock.end) {
        group.push(slots[next]);
        next += 1;
      }
      if (group.length > 1) {
        pushGroup(blocks, group, text, cursor, spans);
        index = next;
        continue;
      }
    }
    pushLine(blocks, slot, text, cursor, spans);
    index += 1;
  }
  // A blank run between two quoted blocks keeps the bar. The blanks stay blocks.
  continueQuoteBars(blocks);
  const lines = blocks.filter((block) => block.type === "line");
  const atoms = [];
  for (const block of blocks) {
    if (block.type === "table" || block.type === "diagram") atoms.push(block);
    else if (block.type === "line" && !block.raw) {
      for (const part of block.parts) {
        if (part.type === "image") atoms.push(part);
      }
    }
  }
  return { blocks, lines, atoms, comments: comments || [] };
}

function sourceAtoms(doc) {
  return structures(doc).atoms;
}

export function stepOver(doc, cursor, direction) {
  const forward = direction === "forward" || direction === "right";
  const atoms = sourceAtoms(doc);
  if (forward) {
    const atom = atoms.find((item) => cursor >= item.start && cursor < item.end);
    return atom ? atom.end : cursor;
  }
  const atom = atoms.find((item) => cursor > item.start && cursor <= item.end);
  return atom ? atom.start : cursor;
}

function movementAtom(doc, cursor, landed, forward) {
  const atoms = plan(doc, cursor).atoms;
  if (forward) return atoms.find((item) => landed >= item.start && landed < item.end) || null;
  return atoms.find((item) => landed > item.start && landed <= item.end) || null;
}

// A raw line renders no atoms, so only atoms still rendered for that cursor snap.
export function snapMove(doc, cursor, landed, direction) {
  const forward = direction === "forward" || direction === "right";
  const atom = movementAtom(doc, cursor, landed, forward);
  if (!atom) return landed;
  return forward ? atom.end : atom.start;
}

// A collapsed line has no height, so the caret would skip it. Stop on that line.
function skippedFence(doc, from, landed, forward) {
  if (from === landed) return null;
  const fromLine = lineIndexAt(doc, from);
  const toLine = lineIndexAt(doc, landed);
  if (fromLine === toLine) return null;
  let nearest = null;
  for (const block of plan(doc, from).blocks) {
    if (block.type !== "line" || !block.collapsed) continue;
    const index = lineIndexAt(doc, block.start);
    const between = forward ? index > fromLine && index < toLine : index < fromLine && index > toLine;
    if (!between) continue;
    if (!nearest || (forward ? block.start < nearest.start : block.end > nearest.end)) nearest = block;
  }
  return nearest;
}

// A closed table is not editable, so the caret can land past it. Line granularity
// still steps over a diagram. Backward entry lands on end, which opens the atom.
function opensInward(atom, granularity) {
  return atom.type === "table" || (atom.type === "diagram" && granularity === "character");
}

function inwardOffset(atom, forward) {
  return forward ? atom.start : atom.end;
}

function crossedAtom(doc, cursor, landed, forward, granularity) {
  const lesser = Math.min(cursor, landed);
  const greater = Math.max(cursor, landed);
  let nearest = null;
  for (const atom of plan(doc, cursor).atoms) {
    if (!opensInward(atom, granularity) || atom.start < lesser || atom.end > greater) continue;
    if (!nearest || (forward ? atom.start < nearest.start : atom.end > nearest.end)) nearest = atom;
  }
  return nearest;
}

export function placeMove(doc, cursor, landed, direction, granularity) {
  const forward = direction === "forward" || direction === "right";
  const snapped = movementAtom(doc, cursor, landed, forward);
  let next = snapMove(doc, cursor, landed, direction);
  if (snapped && opensInward(snapped, granularity)) next = inwardOffset(snapped, forward);
  const crossed = crossedAtom(doc, cursor, landed, forward, granularity);
  if (crossed) next = inwardOffset(crossed, forward);
  const fence = skippedFence(doc, cursor, landed, forward);
  if (fence) next = forward ? fence.start : fence.end;
  return next;
}

function renderedAtomAt(doc, cursor, hit) {
  return plan(doc, cursor).atoms.find(hit) || null;
}

function sourceLine(doc, offset) {
  let start = offset;
  while (start > 0 && doc[start - 1] !== "\n") start -= 1;
  let end = offset;
  while (end < doc.length && doc[end] !== "\n") end += 1;
  return { start, end, text: doc.slice(start, end), newline: end < doc.length && doc[end] === "\n" };
}

// The caret rests on the first offset of a hard-break marker. Offsets after that,
// including the newline, are the hidden tail.
function hardBreakEdge(doc, offset) {
  const re = /( {2,}|\\)\n/g;
  let match = re.exec(doc);
  while (match) {
    const last = match.index + match[1].length;
    if (offset > match.index && offset <= last) return match.index;
    match = re.exec(doc);
  }
  return null;
}

function visualEnd(doc, newlineIndex) {
  if (newlineIndex < 0) return 0;
  const line = sourceLine(doc, newlineIndex);
  return line.end - hardHideCount(line.text);
}

function markerAt(doc, index) {
  if (index < 0 || index >= doc.length) return null;
  for (const token of commentTokens(doc)) {
    if (index >= token.start && index < token.end) return token;
  }
  return null;
}

// A selection that covers one marker of a span and not the other keeps that marker.
// The caret stays outside the comment: before an opener, after a closer.
function markerSplice(doc, from, to) {
  for (const span of findSpans(doc)) {
    const openHit = from < span.openEnd && to > span.openStart;
    const closeHit = from < span.closeEnd && to > span.closeStart;
    if (openHit === closeHit) continue;
    if (openHit && span.openStart >= from && span.openEnd <= to) {
      return { from, to, text: doc.slice(span.openStart, span.openEnd), caret: from };
    }
    if (closeHit && span.closeStart >= from && span.closeEnd <= to) {
      const text = doc.slice(span.closeStart, span.closeEnd);
      return { from, to, text, caret: from + text.length };
    }
  }
  return null;
}

function snapBreak(next) {
  if (!next) return next;
  // A caret left on a hidden space, a backslash, or the newline of a visible
  // line moves to the marker's first offset. The newline of a spaces-only
  // break is itself a caret, so it stays.
  const text = next.doc;
  const at = next.cursor;
  const re = /( {2,}|\\)\n/g;
  let match = re.exec(text);
  while (match) {
    const last = match.index + match[1].length;
    if (at > match.index && at <= last) {
      const line = sourceLine(text, match.index);
      if (bareBreakLine(line, text) && at === last) return next;
      return { ...next, cursor: match.index, anchor: match.index };
    }
    match = re.exec(text);
  }
  return next;
}

// A drawn comment marker, or the hidden tail of a hard break. direction "nearer"
// is a click. The break's br is the newline and stays; a hidden space takes the line start.
export function skipHidden(doc, offset, direction) {
  const text = typeof doc === "string" ? doc : "";
  const at = Math.max(0, Math.min(text.length, Number.isFinite(offset) ? Math.trunc(offset) : 0));
  for (const token of commentTokens(text)) {
    if (at > token.start && at < token.end) {
      if (direction === "nearer") return at - token.start <= token.end - at ? token.start : token.end;
      return direction === "backward" || direction === "left" ? token.start : token.end;
    }
  }
  if (direction === "nearer") {
    const re = /( {2,}|\\)\n/g;
    let match = re.exec(text);
    while (match) {
      const last = match.index + match[1].length;
      if (at > match.index && at < last) return match.index;
      match = re.exec(text);
    }
    return at;
  }
  const edge = hardBreakEdge(text, at);
  if (edge == null) return at;
  if (direction === "backward" || direction === "left") return edge;
  const re = /( {2,}|\\)\n/g;
  let match = re.exec(text);
  while (match) {
    const last = match.index + match[1].length;
    if (at > match.index && at <= last) return last + 1;
    match = re.exec(text);
  }
  return at;
}

function splice(state, from, to, text, cursor) {
  const doc = state.doc.slice(0, from) + text + state.doc.slice(to);
  if (doc === state.doc && cursor === state.cursor && state.anchor === cursor) return state;
  return {
    doc,
    cursor,
    anchor: cursor,
    undo: state.undo.concat([{ doc: state.doc, cursor: state.cursor, anchor: state.anchor }]),
    redo: [],
  };
}

function applySplice(state, from, to, text, cursor) {
  const next = splice(state, from, to, text, cursor);
  if (next === state) return state;
  const cleaned = cleanupComments(next.doc, next.cursor);
  // Only an intact empty span may lose its thread. Breaking a mark, or
  // selecting through one, is not that span, so the caller keeps the old text.
  if (cleaned.broken) return null;
  const changes = [{ from, to, inserted: text, removed: state.doc.slice(from, to) }];
  if (cleaned.changes.length > 0) changes.push(...cleaned.changes);
  if (cleaned.doc === next.doc && cleaned.cursor === next.cursor) return { ...next, changes };
  return { ...next, doc: cleaned.doc, cursor: cleaned.cursor, anchor: cleaned.cursor, changes };
}

export function replaceDocument(state, doc, cursor) {
  if (doc === state.doc && cursor === state.cursor && state.anchor === cursor) return state;
  return {
    doc,
    cursor,
    anchor: cursor,
    undo: state.undo.concat([{ doc: state.doc, cursor: state.cursor, anchor: state.anchor }]),
    redo: [],
  };
}

export function insert(state, text) {
  const value = typeof text === "string" ? text : "";
  const from = Math.min(state.anchor, state.cursor);
  const to = Math.max(state.anchor, state.cursor);
  if (value === "" && from === to) return state;
  return applySplice(state, from, to, value, from + value.length);
}

function deleteSelection(state) {
  const from = Math.min(state.anchor, state.cursor);
  const to = Math.max(state.anchor, state.cursor);
  const kept = markerSplice(state.doc, from, to);
  if (kept) return snapBreak(applySplice(state, kept.from, kept.to, kept.text, kept.caret));
  return snapBreak(applySplice(state, from, to, "", from));
}

function deleteBareLine(state, line) {
  const caret = line.start === 0 ? 0 : visualEnd(state.doc, line.start - 1);
  return snapBreak(applySplice(state, line.start, line.end + 1, "", caret));
}

export function backspace(state) {
  if (state.anchor !== state.cursor) return deleteSelection(state);
  if (state.cursor <= 0) return state;
  const doc = state.doc;
  const cutting = markerAt(doc, state.cursor - 1);
  if (cutting) {
    if (cutting.start === 0) return state;
    return snapBreak(applySplice(state, cutting.start - 1, cutting.start, "", cutting.end - 1));
  }
  const line = sourceLine(doc, state.cursor);
  if (bareBreakLine(line, doc)) return deleteBareLine(state, line);
  if (/^[ \t]+$/.test(line.text)) return deleteBareLine(state, line);
  const atom = renderedAtomAt(doc, state.cursor, (item) => state.cursor > item.start && state.cursor <= item.end);
  if (atom) return applySplice(state, atom.start, atom.end, "", atom.start);
  return snapBreak(applySplice(state, state.cursor - 1, state.cursor, "", state.cursor - 1));
}

export function deleteForward(state) {
  if (state.anchor !== state.cursor) return deleteSelection(state);
  if (state.cursor >= state.doc.length) return state;
  const doc = state.doc;
  const cutting = markerAt(doc, state.cursor);
  if (cutting) {
    if (cutting.end >= doc.length) return state;
    return snapBreak(applySplice(state, cutting.end, cutting.end + 1, "", cutting.start));
  }
  const line = sourceLine(doc, state.cursor);
  if (bareBreakLine(line, doc)) return deleteBareLine(state, line);
  if (/^[ \t]+$/.test(line.text)) return deleteBareLine(state, line);
  // Only the hard-break tail sits between the caret and the newline, so the
  // newline goes and the marker characters stay where they are.
  const hide = line.newline ? hardHideCount(line.text) : 0;
  if (hide > 0 && state.cursor >= line.end - hide && state.cursor < line.end) {
    return snapBreak(applySplice(state, line.end, line.end + 1, "", state.cursor));
  }
  const atom = renderedAtomAt(doc, state.cursor, (item) => state.cursor >= item.start && state.cursor < item.end);
  if (atom) return applySplice(state, atom.start, atom.end, "", atom.start);
  const at = state.cursor;
  // The last byte of a trailing empty line is a newline. Leaving the caret at
  // the new length sits past that remaining newline, where no block is drawn.
  let cursor = at;
  if (at === state.doc.length - 1 && doc[at] === "\n" && at > 0 && doc[at - 1] === "\n") {
    cursor = at - 1;
  }
  return snapBreak(applySplice(state, at, at + 1, "", cursor));
}

export function undo(state) {
  if (state.undo.length === 0) return state;
  const prev = state.undo[state.undo.length - 1];
  return {
    doc: prev.doc,
    cursor: prev.cursor,
    anchor: prev.anchor ?? prev.cursor,
    undo: state.undo.slice(0, -1),
    redo: state.redo.concat([{ doc: state.doc, cursor: state.cursor, anchor: state.anchor }]),
  };
}

export function redo(state) {
  if (state.redo.length === 0) return state;
  const next = state.redo[state.redo.length - 1];
  return {
    doc: next.doc,
    cursor: next.cursor,
    anchor: next.anchor ?? next.cursor,
    undo: state.undo.concat([{ doc: state.doc, cursor: state.cursor, anchor: state.anchor }]),
    redo: state.redo.slice(0, -1),
  };
}

export function selectedSlice(state) {
  const from = Math.min(state.anchor, state.cursor);
  const to = Math.max(state.anchor, state.cursor);
  return state.doc.slice(from, to);
}

export function cut(state) {
  const text = selectedSlice(state);
  if (state.anchor === state.cursor) return { state, text };
  return { state: deleteForward(state), text };
}

// Same rows the CLI used, including the empty row after a final newline.
export function lineRows(text) {
  const lines = [];
  let start = 0;
  for (let i = 0; i <= text.length; i += 1) {
    if (i === text.length || text[i] === "\n") {
      lines.push({ start, text: text.slice(start, i) });
      start = i + 1;
      if (i === text.length) break;
    }
  }
  return lines;
}

// The end offset is exclusive. An offset equal to the line length is the
// position after the last character, which is still on this line.
export function offsetAt(text, line, column) {
  if (line < 1 || column < 0) return { error: 400 };
  const row = lineRows(text)[line - 1];
  if (!row || column > row.text.length) return { error: 400 };
  return { offset: row.start + column };
}

const DIFF_HEADER = /^(?:diff |index |--- |\+\+\+ )/;
const DIFF_NO_NEWLINE = "\\ No newline at end of file";

// @@ numbers are not a location. Old lines are the ' ' and '-' texts.
export function parseUnifiedDiff(text) {
  if (typeof text !== "string") return { error: "invalid" };
  const rows = text.split("\n");
  if (text.endsWith("\n")) rows.pop();
  const hunks = [];
  let current = null;
  const finish = () => {
    if (!current) return null;
    const hunk = current;
    current = null;
    if (hunk.old.length === 0) return { error: "no-context" };
    hunks.push(hunk);
    return null;
  };
  for (const line of rows) {
    if (line === DIFF_NO_NEWLINE) continue;
    // A leading "--- " or "+++ " is a file header only before the first hunk.
    // Inside a hunk those bytes are a removed or added line.
    if (!current && DIFF_HEADER.test(line)) continue;
    if (line.startsWith("@@")) {
      const bad = finish();
      if (bad) return bad;
      current = { old: [], new: [] };
      continue;
    }
    if (!current) {
      if (line === "") continue;
      return { error: "invalid" };
    }
    if (line === "") return { error: "invalid" };
    const tag = line[0];
    const body = line.slice(1);
    if (tag === " ") {
      current.old.push(body);
      current.new.push(body);
    } else if (tag === "-") {
      current.old.push(body);
    } else if (tag === "+") {
      current.new.push(body);
    } else {
      return { error: "invalid" };
    }
  }
  const bad = finish();
  if (bad) return bad;
  return { hunks };
}

function sliceLines(slice) {
  if (slice === "") return { lines: [], trailing: false };
  const trailing = slice.endsWith("\n");
  const lines = slice.split("\n");
  if (trailing) lines.pop();
  return { lines, trailing };
}

function textAt(lines, trailing) {
  const body = lines.join("\n");
  return trailing ? `${body}\n` : body;
}

function findRuns(lines, oldLines) {
  const runs = [];
  const width = oldLines.length;
  if (width === 0) return runs;
  for (let i = 0; i + width <= lines.length; i += 1) {
    let same = true;
    for (let j = 0; j < width; j += 1) {
      if (lines[i + j] !== oldLines[j]) {
        same = false;
        break;
      }
    }
    if (same) runs.push(i);
  }
  return runs;
}

function spansOverlap(ranges) {
  const ordered = ranges.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i].start < ordered[i - 1].end) return true;
  }
  return false;
}

function tightSplice(before, after) {
  if (before === after) return null;
  let prefix = 0;
  const shared = Math.min(before.length, after.length);
  while (prefix < shared && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  return {
    from: prefix,
    to: before.length - suffix,
    inserted: after.slice(prefix, after.length - suffix),
  };
}

// Each hunk is diffed against the original slice, so unchanged text between
// hunks is not part of either splice.
export function planDiff(text, hunks, startOff, endOff) {
  const base = startOff == null ? 0 : startOff;
  const end = endOff == null ? text.length : endOff;
  const { lines, trailing } = sliceLines(text.slice(base, end));
  const located = [];
  for (const hunk of hunks) {
    const runs = findRuns(lines, hunk.old);
    if (runs.length === 0) return { error: "context" };
    if (runs.length !== 1) return { error: "matches", matches: runs.length };
    located.push({ hunk, at: runs[0] });
  }
  const spans = located.map(({ hunk, at }) => ({ start: at, end: at + hunk.old.length }));
  if (spansOverlap(spans)) return { error: "overlap" };
  const before = textAt(lines, trailing);
  const splices = [];
  for (const { hunk, at } of located) {
    const nextLines = lines.slice(0, at).concat(hunk.new, lines.slice(at + hunk.old.length));
    const local = tightSplice(before, textAt(nextLines, trailing));
    if (!local) continue;
    splices.push({ from: base + local.from, to: base + local.to, inserted: local.inserted });
  }
  const bytes = splices.map((splice) => ({ start: splice.from, end: splice.to }));
  if (spansOverlap(bytes)) return { error: "overlap" };
  return { splices };
}
