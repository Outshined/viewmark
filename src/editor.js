// Source string is the document. The view is a projection: the cursor line keeps
// the parsed runs and fills marker gaps so those characters stay editable text.
// The markdown this editor supports is GitHub, GitLab, and Obsidian markdown.
// A mermaid fence is a diagram.

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

function lineIndexAt(doc, cursor) {
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

function classify(text) {
  if (text === "---" || text === "***" || text === "___") {
    return { kind: "hr", marker: 0, indent: 0, plain: "md-hr" };
  }
  const heading = /^(#{1,6}) (.*)$/.exec(text);
  if (heading) {
    const level = heading[1].length;
    return { kind: "h", level, marker: level + 1, indent: 0, plain: `md-h${level}` };
  }
  if (text.startsWith("> ")) return { kind: "quote", marker: 2, indent: 0, plain: "md-quote" };
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

function commentThreads(doc) {
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

// A note boundary is a line whose whole text is "::". A body with no such line
// is one note, so markers inside the note stay text.
function commentNotes(body) {
  const notes = [];
  let current = [];
  for (const line of body.split("\n")) {
    if (line === "::") {
      notes.push(current.join("\n"));
      current = [];
    } else {
      current.push(line);
    }
  }
  notes.push(current.join("\n"));
  return notes;
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

function findSpans(doc) {
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
function orderVisibleComments(comments, doc) {
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

// Empty interiors and threads whose span is gone leave in the same edit, so one
// undo restores the string from before the keystroke.
function cleanupComments(doc, cursor) {
  const spans = findSpans(doc);
  const fences = commentThreads(doc);
  const live = new Set();
  for (const span of spans) {
    if (span.interiorStart < span.interiorEnd) live.add(span.id);
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
  for (const fence of fences) {
    if (!live.has(fence.id)) dropped.add(fence.id);
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
  if (merged.length === 0) return { doc, cursor };
  let next = doc;
  let nextCursor = cursor;
  for (let i = merged.length - 1; i >= 0; i -= 1) {
    const [from, to] = merged[i];
    next = next.slice(0, from) + next.slice(to);
    nextCursor = shiftDelete(nextCursor, from, to);
  }
  return { doc: next, cursor: nextCursor };
}

function commentBodyRange(doc, fence) {
  const lines = lineSpans(doc);
  const open = lines[fence.openIndex];
  if (!open) return null;
  const from = open.end < doc.length && doc[open.end] === "\n" ? open.end + 1 : open.end;
  const to = fence.closed ? lines[fence.lastIndex].start : doc.length;
  return { from, to };
}

function replaceCommentBody(state, id, body) {
  const fence = fenceContentRanges(state.doc).find((item) => item.lang === "comment" && item.commentId === id);
  if (!fence) return state;
  const range = commentBodyRange(state.doc, fence);
  if (!range) return state;
  const text = `${body}\n`;
  if (state.doc.slice(range.from, range.to) === text) return state;
  const doc = state.doc.slice(0, range.from) + text + state.doc.slice(range.to);
  return {
    doc,
    cursor: shiftReplace(state.cursor, range.from, range.to, text.length),
    anchor: shiftReplace(state.anchor, range.from, range.to, text.length),
    undo: state.undo.concat([{ doc: state.doc, cursor: state.cursor, anchor: state.anchor }]),
    redo: [],
  };
}

function removeCommentThread(state, id) {
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
  for (let i = merged.length - 1; i >= 0; i -= 1) {
    const [from, to] = merged[i];
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
  };
}

function setCommentResolved(state, id, resolved) {
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
  };
}

export function addComment(doc, anchor, cursor) {
  const text = typeof doc === "string" ? doc : "";
  const left = Number.isFinite(anchor) ? anchor : 0;
  const right = Number.isFinite(cursor) ? cursor : 0;
  const from = Math.max(0, Math.min(left, right, text.length));
  const to = Math.max(0, Math.min(text.length, Math.max(left, right)));
  if (!(from < to)) return null;
  for (const fence of fenceContentRanges(text)) {
    if (rangesOverlap(from, to, fence.start, fence.contentEnd)) return null;
  }
  for (const atom of structures(text).atoms) {
    if (atom.type === "table" && rangesOverlap(from, to, atom.start, atom.end)) return null;
  }
  for (const span of findSpans(text)) {
    const inside = from >= span.interiorStart && to <= span.interiorEnd;
    const outside = to <= span.openStart || from >= span.closeEnd;
    if (!inside && !outside) return null;
  }
  const id = nextCommentId(text);
  const open = `{${id}}`;
  const close = `{/${id}}`;
  let next = text.slice(0, from) + open + text.slice(from, to) + close + text.slice(to);
  if (!next.endsWith("\n")) next += "\n";
  next += `\n\`\`\`comment ${id}\n\n\`\`\`\n`;
  return { doc: next, id, cursor: from + open.length };
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

function structures(doc) {
  const lines = lineSpans(doc);
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
        const mode = { kind: "codeblock", marker: 0, indent: 0, plain: "md-codeblock" };
        for (let line = index; line <= last; line += 1) {
          const edge = line === index || (closed && line === last);
          const parsed = edge ? parseSlot(lines[line], mode) : codeTokens(lines[line], opened.lang);
          slots.push({ kind: "line", line: lines[line], mode, parsed, fenceEdge: edge });
        }
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
        header: cellRanges(lines[index]),
        rows,
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

function rawBlock(line, mode, parsed, spans) {
  const empty = line.start === line.end;
  const runs = empty ? [] : paintRuns(fillGaps(line, mode, parsed), spans, true);
  return {
    type: "line",
    raw: true,
    empty,
    start: line.start,
    end: line.end,
    text: line.text,
    classes: ["md-raw", mode.plain],
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
      classes: [mode.plain],
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
    classes: [mode.plain],
    runs: parts === parsed.parts ? parsed.runs : parts.filter((part) => part.type === "run"),
    parts,
    indent: mode.indent ?? 0,
  };
  if (mode.kind === "ol") block.marker = line.text.slice(0, mode.marker).replace(/^[ \t]+/, "");
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

// cursor === end stays closed so backspace still deletes the whole atom.
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

export function plan(doc, cursor) {
  const text = typeof doc === "string" ? doc : "";
  const built = structures(text);
  const { slots } = built;
  const comments = built.comments || [];
  const spans = findSpans(text);
  const blocks = [];
  for (const slot of slots) {
    if (slot.kind === "atom") {
      const atom = slot.atom;
      if ((atom.type === "table" || atom.type === "diagram") && cursor >= atom.start && cursor < atom.end) {
        expandAtom(blocks, doc, atom, cursor, spans);
      } else {
        blocks.push(atom);
      }
      continue;
    }
    const { line, mode, parsed } = slot;
    const onLine = cursor >= line.start && cursor <= line.end;
    const block = onLine ? rawBlock(line, mode, parsed, spans) : renderedBlock(line, mode, parsed, spans);
    if (slot.fenceEdge) block.collapsed = !onLine;
    blocks.push(block);
  }
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

// A zero-height fence line is skipped by the caret; stop there so it can open.
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
// still steps over a diagram. end - 1 opens the atom; cursor === end stays closed.
function opensInward(atom, granularity) {
  return atom.type === "table" || (atom.type === "diagram" && granularity === "character");
}

function inwardOffset(atom, forward) {
  return forward ? atom.start : atom.end - 1;
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
  if (cleaned.doc === next.doc && cleaned.cursor === next.cursor) return next;
  return { ...next, doc: cleaned.doc, cursor: cleaned.cursor, anchor: cleaned.cursor };
}

function replaceDocument(state, doc, cursor) {
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

export function backspace(state) {
  if (state.anchor !== state.cursor) {
    const from = Math.min(state.anchor, state.cursor);
    return applySplice(state, from, Math.max(state.anchor, state.cursor), "", from);
  }
  if (state.cursor <= 0) return state;
  const atom = renderedAtomAt(state.doc, state.cursor, (item) => state.cursor > item.start && state.cursor <= item.end);
  if (atom) return applySplice(state, atom.start, atom.end, "", atom.start);
  return applySplice(state, state.cursor - 1, state.cursor, "", state.cursor - 1);
}

export function deleteForward(state) {
  if (state.anchor !== state.cursor) {
    const from = Math.min(state.anchor, state.cursor);
    return applySplice(state, from, Math.max(state.anchor, state.cursor), "", from);
  }
  if (state.cursor >= state.doc.length) return state;
  const atom = renderedAtomAt(state.doc, state.cursor, (item) => state.cursor >= item.start && state.cursor < item.end);
  if (atom) return applySplice(state, atom.start, atom.end, "", atom.start);
  return applySplice(state, state.cursor, state.cursor + 1, "", state.cursor);
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

function hasClass(el, name) {
  if (!el || el.nodeType !== 1 || !el.classList || typeof el.classList.contains !== "function") return false;
  return el.classList.contains(name);
}

function atomClickOffset(atom, target) {
  if (hasClass(atom, "md-image")) return Number(atom.dataset.start);
  if (hasClass(atom, "md-table")) {
    const cell = target?.closest?.("td, th");
    if (cell && cell.dataset && cell.dataset.start != null && cell.dataset.start !== "") {
      return Number(cell.dataset.start);
    }
    return Number(atom.dataset.start);
  }
  if (hasClass(atom, "md-diagram")) return Number(atom.dataset.bodyStart);
  return Number(atom.dataset.start);
}

function nearestTagged(node) {
  let el = node && node.nodeType === 3 ? node.parentElement : node;
  while (el) {
    if (el.dataset && el.dataset.start != null && el.dataset.start !== "") return el;
    el = el.parentElement;
  }
  return null;
}

function isBreak(node) {
  return !!node && String(node.nodeName || "").toUpperCase() === "BR";
}

// selectNode reports the atom as a child index on its parent, not a text offset.
export function mapOffset(startOrNode, offset) {
  if (typeof startOrNode === "number") return startOrNode + offset;
  const node = startOrNode;
  const index = offset || 0;
  if (!node) return index;
  if (node.nodeType === 3) {
    const tagged = nearestTagged(node);
    if (!tagged) return index;
    const start = Number(tagged.dataset.start);
    const end = Number(tagged.dataset.end);
    if (start === end) return start;
    return start + index;
  }
  if (node.nodeType === 1) {
    const children = node.childNodes || [];
    if (index < children.length) {
      const child = children[index];
      if (hasClass(child, "md-atom")) return Number(child.dataset.start);
      if (child.nodeType === 3) return mapOffset(child, 0);
      if (isBreak(child)) {
        const tagged = nearestTagged(child);
        return tagged ? Number(tagged.dataset.start) : 0;
      }
      if (child.dataset && child.dataset.start != null && child.dataset.start !== "") {
        return Number(child.dataset.start);
      }
    } else if (children.length > 0) {
      const last = children[children.length - 1];
      if (hasClass(last, "md-atom")) return Number(last.dataset.end);
      if (last.nodeType === 3) return mapOffset(last, last.length || 0);
      if (isBreak(last)) {
        const tagged = nearestTagged(last);
        return tagged ? Number(tagged.dataset.start) : 0;
      }
      if (last.dataset && last.dataset.end != null && last.dataset.end !== "") return Number(last.dataset.end);
    }
    const tagged = nearestTagged(node);
    if (tagged) {
      const start = Number(tagged.dataset.start);
      const end = Number(tagged.dataset.end);
      if (start === end) return start;
      if (!node.childNodes || node.childNodes.length === 0) return start;
      return start + index;
    }
  }
  return index;
}

function mapRange(range) {
  if (range.startContainer === range.endContainer && range.startContainer.nodeType === 1) {
    const child = range.startContainer.childNodes[range.startOffset];
    if (hasClass(child, "md-atom") && range.endOffset === range.startOffset + 1) {
      return { anchor: Number(child.dataset.start), cursor: Number(child.dataset.end) };
    }
  }
  return {
    anchor: mapOffset(range.startContainer, range.startOffset),
    cursor: mapOffset(range.endContainer, range.endOffset),
  };
}

function renderRun(part) {
  const el = part.href ? document.createElement("a") : document.createElement("span");
  el.className = part.classes.join(" ");
  el.dataset.start = String(part.start);
  el.dataset.end = String(part.end);
  if (part.href) {
    el.href = part.href;
    el.rel = "noreferrer noopener";
    el.draggable = false;
  }
  if (part.comment) el.dataset.comment = part.comment;
  if (part.text.length === 0) el.appendChild(document.createElement("br"));
  else el.appendChild(document.createTextNode(part.text));
  return el;
}

function renderImage(image) {
  const el = document.createElement("span");
  el.className = image.comment ? "md-atom md-image md-comment" : "md-atom md-image";
  el.contentEditable = "false";
  el.dataset.start = String(image.start);
  el.dataset.end = String(image.end);
  if (image.comment) el.dataset.comment = image.comment;
  const img = document.createElement("img");
  img.src = image.url;
  img.alt = image.alt;
  img.draggable = false;
  el.appendChild(img);
  return el;
}

function renderCell(tag, cell) {
  const el = document.createElement(tag);
  el.textContent = cell.text;
  el.dataset.start = String(cell.start);
  el.dataset.end = String(cell.end);
  return el;
}

function renderTable(atom) {
  const el = document.createElement("div");
  el.className = "md-atom md-table";
  el.contentEditable = "false";
  el.dataset.start = String(atom.start);
  el.dataset.end = String(atom.end);
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const cell of atom.header) headRow.appendChild(renderCell("th", cell));
  thead.appendChild(headRow);
  const tbody = document.createElement("tbody");
  for (const row of atom.rows) {
    const tr = document.createElement("tr");
    for (const cell of row) tr.appendChild(renderCell("td", cell));
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  el.appendChild(table);
  return el;
}

let mermaidReady = false;
let diagramSerial = 0;

function mermaidApi() {
  const api = globalThis.mermaid;
  if (!api || typeof api.initialize !== "function" || typeof api.render !== "function") return null;
  if (!mermaidReady) {
    api.initialize({ startOnLoad: false, securityLevel: "strict", flowchart: { htmlLabels: false }, suppressErrorRendering: true });
    mermaidReady = true;
  }
  return api;
}

function diagramMessage(err) {
  if (err && err.message) return String(err.message);
  return String(err);
}

function showDiagramSource(el, source, err) {
  if (el.isConnected !== true) return;
  const pre = document.createElement("pre");
  pre.textContent = source;
  el.replaceChildren(pre, document.createTextNode(diagramMessage(err)));
}

function showDiagramSvg(el, source, svg) {
  if (el.isConnected !== true) return;
  let parsed;
  try {
    parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  } catch (err) {
    showDiagramSource(el, source, err);
    return;
  }
  const node = parsed && parsed.documentElement;
  const name = node && String(node.localName || node.nodeName || "").toLowerCase();
  if (!node || name !== "svg" || el.isConnected !== true) {
    if (el.isConnected === true) showDiagramSource(el, source, new Error("diagram did not return svg"));
    return;
  }
  el.replaceChildren(node);
}

function renderDiagram(atom) {
  const el = document.createElement("div");
  el.className = "md-atom md-diagram";
  el.contentEditable = "false";
  el.dataset.start = String(atom.start);
  el.dataset.end = String(atom.end);
  el.dataset.bodyStart = String(atom.bodyStart);
  const pre = document.createElement("pre");
  pre.textContent = atom.body;
  el.appendChild(pre);
  const api = mermaidApi();
  if (!api) return el;
  const source = atom.body;
  const id = `vm${diagramSerial}`;
  diagramSerial += 1;
  Promise.resolve()
    .then(() => api.render(id, source))
    .then((result) => {
      if (el.isConnected !== true) return;
      const svg = typeof result === "string" ? result : result && result.svg;
      if (typeof svg !== "string") {
        showDiagramSource(el, source, new Error("diagram did not return svg"));
        return;
      }
      showDiagramSvg(el, source, svg);
    })
    .catch((err) => {
      showDiagramSource(el, source, err);
    });
  return el;
}

function renderCollapsed(block) {
  const line = document.createElement("div");
  line.className = "md-line md-fence-collapsed";
  line.dataset.start = String(block.start);
  line.dataset.end = String(block.end);
  const br = document.createElement("br");
  br.className = "md-fence-collapsed";
  br.dataset.start = String(block.start);
  br.dataset.end = String(block.end);
  line.appendChild(br);
  return line;
}

function renderBlock(block) {
  if (block.type === "table") return renderTable(block);
  if (block.type === "diagram") return renderDiagram(block);
  if (block.collapsed) return renderCollapsed(block);
  const el = document.createElement("div");
  el.className = ["md-line", ...block.classes].join(" ");
  if (typeof block.indent === "number") el.style.setProperty("--indent", String(block.indent));
  if (block.marker) el.dataset.marker = block.marker;
  if (block.raw || block.empty || block.hr) {
    el.dataset.start = String(block.start);
    el.dataset.end = String(block.end);
  }
  if (block.raw) {
    if (block.empty) el.appendChild(document.createElement("br"));
    else for (const run of block.runs) el.appendChild(renderRun(run));
    return el;
  }
  if (block.empty || block.hr) {
    if (block.empty) el.appendChild(document.createElement("br"));
    return el;
  }
  for (const part of block.parts) {
    el.appendChild(part.type === "image" ? renderImage(part) : renderRun(part));
  }
  if (!el.firstChild) {
    el.dataset.start = String(block.end);
    el.dataset.end = String(block.end);
    el.appendChild(document.createElement("br"));
  }
  return el;
}

function expandAtoms(doc, from, to, cursor) {
  let start = Math.min(from, to);
  let end = Math.max(from, to);
  let grew = true;
  const atoms = plan(doc, cursor).atoms;
  while (grew) {
    grew = false;
    for (const atom of atoms) {
      if (atom.end <= start || atom.start >= end) continue;
      if (atom.start < start || atom.end > end) {
        start = Math.min(start, atom.start);
        end = Math.max(end, atom.end);
        grew = true;
      }
    }
  }
  return [start, end];
}

function wordEdges(doc, cursor, direction) {
  if (direction < 0) {
    let index = cursor;
    while (index > 0 && /\s/.test(doc[index - 1])) index -= 1;
    while (index > 0 && !/\s/.test(doc[index - 1])) index -= 1;
    return [index, cursor];
  }
  let index = cursor;
  while (index < doc.length && /\s/.test(doc[index])) index += 1;
  while (index < doc.length && !/\s/.test(doc[index])) index += 1;
  return [cursor, index];
}

function setStyle(el, name, value) {
  if (!el || !el.style) return;
  if (typeof el.style.setProperty === "function") el.style.setProperty(name, value);
  else el.style[name] = value;
}

function commentsAsideOf(root) {
  const parent = root && root.parentElement;
  if (!parent || !parent.childNodes) return null;
  for (const child of parent.childNodes) {
    if (child !== root && child.classList && child.classList.contains("comments")) return child;
  }
  return null;
}

function buttonHost() {
  if (typeof document === "undefined" || !document.body) return null;
  if (typeof document.body.appendChild !== "function") return null;
  return document.body;
}

const COMMENT_CARD_GAP = 12;

export function createEditor(root, doc, cursor = 0) {
  let state = createState(doc, cursor);
  const ac = new AbortController();
  const listen = (type, fn, options = {}) => {
    root.addEventListener(type, fn, { ...options, signal: ac.signal });
  };
  const commentsAside = commentsAsideOf(root);
  let addCommentButton = null;
  let commentFocus = null;
  let currentCommentId = null;
  let showResolved = false;
  const unsavedThreads = new Set();
  const replyDrafts = new Map();
  const noteDrafts = new Map();
  const authorDrafts = new Map();
  const editingNotes = new Set();
  root.contentEditable = "true";
  root.spellcheck = false;
  root.autocapitalize = "off";
  root.setAttribute("autocorrect", "off");
  root.classList.add("editor");
  root.setAttribute("role", "textbox");
  root.setAttribute("aria-multiline", "true");

  let pointer = null;
  let didDrag = false;
  let pasteSeen = false;
  let composing = false;
  let composed = "";

  function clearAtomMark() {
    for (const el of root.querySelectorAll(".md-atom-selected")) el.classList.remove("md-atom-selected");
  }

  // Empty lines have no text node; the caret stays on the br.
  function pointFor(offset) {
    let atEnd = null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.closest(".md-atom")) continue;
      const tagged = nearestTagged(node);
      if (!tagged) continue;
      const start = Number(tagged.dataset.start);
      const end = Number(tagged.dataset.end);
      if (node.length !== end - start || offset < start || offset > end) continue;
      if (offset < end) return { node, offset: offset - start };
      atEnd = { node, offset: offset - start };
    }
    for (const br of root.querySelectorAll("br")) {
      const tagged = nearestTagged(br);
      if (!tagged) continue;
      const start = Number(tagged.dataset.start);
      if (start === Number(tagged.dataset.end) && start === offset) return { node: br, offset: 0 };
    }
    return atEnd;
  }

  function placePoint(range, point) {
    range.setStart(point.node, point.offset);
    range.collapse(true);
  }

  function placeCaret() {
    const sel = window.getSelection();
    if (!sel) return;
    clearAtomMark();
    const { anchor, cursor: caret } = state;
    if (anchor !== caret) {
      const lo = Math.min(anchor, caret);
      const hi = Math.max(anchor, caret);
      for (const el of root.querySelectorAll(".md-atom")) {
        if (Number(el.dataset.start) === lo && Number(el.dataset.end) === hi) {
          el.classList.add("md-atom-selected");
          const range = document.createRange();
          range.selectNode(el);
          sel.removeAllRanges();
          sel.addRange(range);
          return;
        }
      }
      const from = pointFor(anchor);
      const to = pointFor(caret);
      if (from && to) {
        sel.setBaseAndExtent(from.node, from.offset, to.node, to.offset);
        const host = to.node.parentElement || root;
        host.scrollIntoView({ block: "nearest", inline: "nearest" });
        return;
      }
    }
    const point = pointFor(caret);
    if (point) {
      const range = document.createRange();
      placePoint(range, point);
      sel.removeAllRanges();
      sel.addRange(range);
      const host = point.node.parentElement || root;
      host.scrollIntoView({ block: "nearest", inline: "nearest" });
      return;
    }
    const range = document.createRange();
    for (const el of root.querySelectorAll(".md-atom")) {
      const start = Number(el.dataset.start);
      const end = Number(el.dataset.end);
      if (caret > start && caret < end) {
        // A caret cannot sit inside an atom, so the highlight is the whole range.
        state = { ...state, anchor: start, cursor: end };
        el.classList.add("md-atom-selected");
        range.selectNode(el);
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      if (caret === end) {
        range.setStartAfter(el);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      if (caret === start) {
        range.setStartBefore(el);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
    }
  }

  function selectionFromDom(sel) {
    if (!sel) return null;
    if (sel.anchorNode && sel.focusNode && nearestTagged(sel.anchorNode) && nearestTagged(sel.focusNode)) {
      return {
        anchor: mapOffset(sel.anchorNode, sel.anchorOffset),
        cursor: mapOffset(sel.focusNode, sel.focusOffset),
      };
    }
    if (sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (range.startContainer === range.endContainer && range.startContainer.nodeType === 1) {
      const child = range.startContainer.childNodes[range.startOffset];
      if (hasClass(child, "md-atom") && range.endOffset === range.startOffset + 1) {
        return { anchor: Number(child.dataset.start), cursor: Number(child.dataset.end) };
      }
    }
    if (!nearestTagged(range.startContainer) || !nearestTagged(range.endContainer)) return null;
    return {
      anchor: mapOffset(range.startContainer, range.startOffset),
      cursor: mapOffset(range.endContainer, range.endOffset),
    };
  }

  function adoptDomSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const holder = sel.anchorNode || sel.getRangeAt(0).commonAncestorContainer;
    if (!holder || !root.contains(holder)) return;
    const mapped = selectionFromDom(sel);
    if (!mapped) return;
    state = { ...state, anchor: mapped.anchor, cursor: mapped.cursor };
  }

  function findCommentBox(id, note) {
    if (!commentsAside) return null;
    const walk = (node) => {
      if (!node) return null;
      if (node.classList && node.classList.contains("md-comment-body") && node.dataset && node.dataset.comment === id) {
        if (note == null || String(node.dataset.note) === String(note)) return node;
      }
      for (const child of node.childNodes || []) {
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    return walk(commentsAside);
  }

  function focusComment(id, start, end, note) {
    const box = findCommentBox(id, note);
    if (!box) {
      commentFocus = null;
      return;
    }
    const limit = typeof box.value === "string" ? box.value.length : 0;
    const from = Math.max(0, Math.min(Number.isFinite(start) ? start : 0, limit));
    const to = Math.max(0, Math.min(Number.isFinite(end) ? end : from, limit));
    commentFocus = { id, start: from, end: to };
    if (typeof box.focus === "function") box.focus();
    box.selectionStart = from;
    box.selectionEnd = to;
  }

  function draftKey(id, index) {
    return `${id}\t${index}`;
  }

  function pruneCommentDrafts(comments) {
    const live = new Set(comments.map((comment) => comment.id));
    for (const id of [...unsavedThreads]) {
      if (!live.has(id)) unsavedThreads.delete(id);
    }
    for (const id of [...replyDrafts.keys()]) {
      if (!live.has(id)) replyDrafts.delete(id);
    }
    for (const key of [...noteDrafts.keys()]) {
      if (!live.has(key.slice(0, key.indexOf("\t")))) noteDrafts.delete(key);
    }
    for (const key of [...authorDrafts.keys()]) {
      if (!live.has(key.slice(0, key.indexOf("\t")))) authorDrafts.delete(key);
    }
    for (const key of [...editingNotes]) {
      if (!live.has(key.slice(0, key.indexOf("\t")))) editingNotes.delete(key);
    }
  }

  function ancestorWithClass(node, className) {
    let current = node;
    while (current) {
      if (current.classList && current.classList.contains(className)) return current;
      current = current.parentElement;
    }
    return null;
  }

  function commentTextFromTarget(node) {
    let current = node && node.nodeType === 1 ? node : node && node.parentElement;
    return ancestorWithClass(current, "md-comment-text");
  }

  function openSavedNote(text) {
    const id = text.dataset && text.dataset.comment;
    if (!id) return;
    const index = Number(text.dataset.note || 0);
    const thread = threadById(id);
    const stored = thread ? (commentNotes(thread.body)[index] || "") : "";
    noteDrafts.delete(draftKey(id, index));
    editingNotes.add(draftKey(id, index));
    currentCommentId = id;
    commentFocus = { id, note: index, start: stored.length, end: stored.length };
    render();
  }

  function buttonLabeled(parent, label) {
    if (!parent) return null;
    for (const child of parent.childNodes || []) {
      if (child.tagName === "BUTTON" && child.textContent === label) return child;
    }
    return null;
  }

  function makeCommentButton(label, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", (event) => {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      onClick();
    });
    return button;
  }

  function threadById(id) {
    return commentThreads(state.doc).find((item) => item.id === id) || null;
  }

  function onSave(box) {
    const id = box.dataset.comment;
    const index = Number(box.dataset.note);
    const thread = threadById(id);
    if (!thread) return;
    const notes = commentNotes(thread.body);
    if (box.dataset.reply === "true") notes.push(box.value);
    else notes[index] = box.value;
    const parent = box.parentElement;
    if (parent) {
      for (const child of parent.childNodes || []) {
        if (child.classList && child.classList.contains("md-comment-author")) {
          authorDrafts.set(draftKey(id, index), child.value || "");
          break;
        }
      }
    }
    const body = notes.join("\n::\n");
    if (box.dataset.reply === "true") replyDrafts.delete(id);
    unsavedThreads.delete(id);
    noteDrafts.delete(draftKey(id, index));
    editingNotes.delete(draftKey(id, index));
    currentCommentId = id;
    commentFocus = null;
    const next = replaceCommentBody(state, id, body);
    if (next === state) render();
    else apply(next);
  }

  function onCancel(box) {
    const id = box.dataset.comment;
    const index = Number(box.dataset.note);
    if (box.dataset.fresh === "true") {
      unsavedThreads.delete(id);
      replyDrafts.delete(id);
      noteDrafts.delete(draftKey(id, index));
      authorDrafts.delete(draftKey(id, index));
      if (currentCommentId === id) currentCommentId = null;
      commentFocus = null;
      apply(removeCommentThread(state, id));
      return;
    }
    if (box.dataset.reply === "true") {
      replyDrafts.delete(id);
      authorDrafts.delete(draftKey(id, index));
      currentCommentId = id;
      commentFocus = null;
      render();
      return;
    }
    noteDrafts.delete(draftKey(id, index));
    editingNotes.delete(draftKey(id, index));
    currentCommentId = id;
    commentFocus = null;
    render();
  }

  function onReply(id) {
    if (!replyDrafts.has(id)) replyDrafts.set(id, "");
    const thread = threadById(id);
    const index = thread ? commentNotes(thread.body).length : 0;
    currentCommentId = id;
    commentFocus = { id, note: index, start: 0, end: 0 };
    render();
  }

  function onDelete(id) {
    unsavedThreads.delete(id);
    replyDrafts.delete(id);
    if (currentCommentId === id) currentCommentId = null;
    commentFocus = null;
    apply(removeCommentThread(state, id));
  }

  function onResolve(id) {
    const thread = threadById(id);
    if (!thread) return;
    currentCommentId = id;
    commentFocus = null;
    apply(setCommentResolved(state, id, !thread.resolved));
  }

  function syncNoteButtons(box) {
    const parent = box.parentElement;
    if (!parent) return;
    const keep = box.dataset.fresh === "true"
      || box.dataset.reply === "true"
      || box.dataset.editing === "true"
      || box.value !== box.storedText;
    const save = buttonLabeled(parent, "Save");
    const cancel = buttonLabeled(parent, "Cancel");
    if (keep) {
      if (!save) parent.appendChild(makeCommentButton("Save", () => onSave(box)));
      if (!cancel) parent.appendChild(makeCommentButton("Cancel", () => onCancel(box)));
      return;
    }
    if (save) parent.removeChild(save);
    if (cancel) parent.removeChild(cancel);
  }

  function appendAuthor(parent, id, index) {
    const author = document.createElement("input");
    author.type = "text";
    author.className = "md-comment-author";
    author.placeholder = "Author";
    author.value = authorDrafts.get(draftKey(id, index)) || "";
    parent.appendChild(author);
  }

  function appendStaticNote(parent, id, index, stored) {
    const text = document.createElement("div");
    text.className = "md-comment-text";
    text.dataset.comment = id;
    text.dataset.note = String(index);
    // Markers in a saved note are characters, not formatting.
    text.textContent = stored;
    parent.appendChild(text);
  }

  function appendBody(parent, id, index, stored, mode) {
    if (mode === "saved") {
      appendStaticNote(parent, id, index, stored);
      return;
    }
    const box = document.createElement("textarea");
    box.className = "md-comment-body";
    box.dataset.comment = id;
    box.dataset.note = String(index);
    box.spellcheck = false;
    box.storedText = stored;
    if (mode === "fresh") box.dataset.fresh = "true";
    if (mode === "reply") box.dataset.reply = "true";
    if (mode === "edit") box.dataset.editing = "true";
    let value = stored;
    if (mode === "reply") value = replyDrafts.get(id) || "";
    else if (noteDrafts.has(draftKey(id, index))) value = noteDrafts.get(draftKey(id, index));
    box.value = value;
    parent.appendChild(box);
    parent.appendChild(makeCommentButton("Save", () => onSave(box)));
    parent.appendChild(makeCommentButton("Cancel", () => onCancel(box)));
  }

  function buildCommentCard(comment) {
    const card = document.createElement("div");
    card.className = "md-comment-card";
    card.dataset.comment = comment.id;
    if (comment.id === currentCommentId) card.classList.add("md-comment-current");
    if (comment.resolved) card.dataset.resolved = "true";
    if (unsavedThreads.has(comment.id)) {
      appendAuthor(card, comment.id, 0);
      appendBody(card, comment.id, 0, commentNotes(comment.body)[0] || "", "fresh");
      return card;
    }
    card.appendChild(makeCommentButton("Resolve", () => onResolve(comment.id)));
    const notes = commentNotes(comment.body);
    notes.forEach((text, index) => {
      const note = document.createElement("div");
      note.className = "md-comment-note";
      appendAuthor(note, comment.id, index);
      const mode = editingNotes.has(draftKey(comment.id, index)) ? "edit" : "saved";
      appendBody(note, comment.id, index, text, mode);
      card.appendChild(note);
    });
    if (replyDrafts.has(comment.id)) {
      const note = document.createElement("div");
      note.className = "md-comment-note";
      const index = notes.length;
      appendAuthor(note, comment.id, index);
      appendBody(note, comment.id, index, "", "reply");
      card.appendChild(note);
    }
    card.appendChild(makeCommentButton("Reply", () => onReply(comment.id)));
    card.appendChild(makeCommentButton("Delete", () => onDelete(comment.id)));
    return card;
  }

  function renderCommentAside(comments) {
    if (!commentsAside || typeof commentsAside.replaceChildren !== "function") return;
    const list = comments || [];
    pruneCommentDrafts(list);
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = showResolved;
    checkbox.disabled = false;
    checkbox.id = "show-resolved";
    const label = document.createElement("label");
    label.htmlFor = "show-resolved";
    label.textContent = "show resolved";
    checkbox.addEventListener("change", () => {
      showResolved = checkbox.checked === true;
      render();
    });
    const visible = [];
    for (const comment of list) {
      if (comment.resolved && !showResolved) continue;
      visible.push(comment);
    }
    const cards = orderVisibleComments(visible, state.doc).map((comment) => buildCommentCard(comment));
    commentsAside.replaceChildren(checkbox, label, ...cards);
  }

  function elementRect(el) {
    if (!el || typeof el.getBoundingClientRect !== "function") return null;
    return el.getBoundingClientRect();
  }

  function highlightRects(id) {
    const found = [];
    const walk = (node) => {
      if (!node || node.nodeType !== 1) {
        if (node && node.childNodes) {
          for (const child of node.childNodes) walk(child);
        }
        return;
      }
      if (node.classList && node.classList.contains("md-comment") && node.dataset && node.dataset.comment === id) {
        const rect = elementRect(node);
        if (rect) found.push(rect);
      }
      for (const child of node.childNodes || []) walk(child);
    };
    walk(root);
    return found;
  }

  function layoutComments() {
    if (!commentsAside) return;
    const cards = [];
    for (const child of commentsAside.childNodes || []) {
      if (child.classList && child.classList.contains("md-comment-card")) cards.push(child);
    }
    const narrow = typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(max-width: 800px)").matches;
    const placeShowResolved = (inFlow, floor) => {
      const toggle = commentsAside.childNodes && commentsAside.childNodes[0];
      const label = commentsAside.childNodes && commentsAside.childNodes[1];
      if (!toggle || toggle.type !== "checkbox") return floor;
      if (inFlow) {
        setStyle(toggle, "position", "static");
        setStyle(toggle, "top", "auto");
        setStyle(toggle, "left", "auto");
        if (label) {
          setStyle(label, "position", "static");
          setStyle(label, "top", "auto");
          setStyle(label, "left", "auto");
        }
        return floor;
      }
      const top = `${floor}px`;
      setStyle(toggle, "position", "absolute");
      setStyle(toggle, "top", top);
      setStyle(toggle, "left", "0px");
      if (label) {
        setStyle(label, "position", "absolute");
        setStyle(label, "top", top);
        setStyle(label, "left", "1.5rem");
      }
      const height = typeof toggle.offsetHeight === "number" ? toggle.offsetHeight : 0;
      return floor + height + COMMENT_CARD_GAP;
    };
    if (narrow || cards.length === 0) {
      for (const card of cards) {
        setStyle(card, "position", "static");
        setStyle(card, "top", "auto");
        setStyle(card, "left", "auto");
        setStyle(card, "width", "100%");
        setStyle(card, "margin", "");
      }
      placeShowResolved(true, 0);
      setStyle(commentsAside, "height", "");
      return;
    }
    const asideRect = elementRect(commentsAside);
    if (!asideRect || typeof cards[0].getBoundingClientRect !== "function") return;
    const spans = findSpans(state.doc);
    let floor = placeShowResolved(false, 0);
    for (const card of cards) {
      const id = card.dataset.comment;
      let rects = highlightRects(id);
      if (rects.length === 0) {
        const span = spans.find((item) => item.id === id);
        if (span) {
          const walk = (node) => {
            if (!node || node.nodeType !== 1) return;
            if (node.classList && node.classList.contains("md-comment") && node.dataset && node.dataset.start != null) {
              const start = Number(node.dataset.start);
              const end = Number(node.dataset.end);
              if (start >= span.interiorStart && end <= span.interiorEnd) {
                const rect = elementRect(node);
                if (rect) rects.push(rect);
              }
            }
            for (const child of node.childNodes || []) walk(child);
          };
          walk(root);
        }
      }
      let top = floor;
      if (rects.length > 0) {
        let markTop = rects[0].top;
        for (const rect of rects) if (rect.top < markTop) markTop = rect.top;
        top = Math.max(floor, markTop - asideRect.top);
      }
      setStyle(card, "position", "absolute");
      setStyle(card, "top", `${top}px`);
      setStyle(card, "left", "0px");
      setStyle(card, "width", "100%");
      setStyle(card, "margin", "0px");
      const height = typeof card.offsetHeight === "number" ? card.offsetHeight : (elementRect(card)?.height || 0);
      floor = top + height + COMMENT_CARD_GAP;
    }
    setStyle(commentsAside, "height", `${floor}px`);
  }

  function hideCommentButton() {
    if (addCommentButton) addCommentButton.hidden = true;
  }

  function updateCommentButton() {
    if (state.anchor === state.cursor) {
      hideCommentButton();
      return;
    }
    const accepted = addComment(state.doc, state.anchor, state.cursor);
    if (!accepted) {
      hideCommentButton();
      return;
    }
    const host = buttonHost();
    if (!host) return;
    if (!addCommentButton) {
      addCommentButton = document.createElement("button");
      addCommentButton.type = "button";
      addCommentButton.className = "md-add-comment";
      addCommentButton.textContent = "Add comment";
      addCommentButton.hidden = true;
      host.appendChild(addCommentButton);
      addCommentButton.addEventListener("mousedown", (event) => {
        event.preventDefault();
        const result = addComment(state.doc, state.anchor, state.cursor);
        if (!result) return;
        unsavedThreads.add(result.id);
        replyDrafts.delete(result.id);
        noteDrafts.delete(draftKey(result.id, 0));
        authorDrafts.delete(draftKey(result.id, 0));
        currentCommentId = result.id;
        commentFocus = { id: result.id, note: 0, start: 0, end: 0 };
        apply(replaceDocument(state, result.doc, result.cursor));
      }, { signal: ac.signal });
    }
    const sel = typeof window !== "undefined" && window.getSelection ? window.getSelection() : null;
    let rect = null;
    if (sel && sel.rangeCount > 0 && typeof sel.getRangeAt === "function") {
      const range = sel.getRangeAt(0);
      const rects = typeof range.getClientRects === "function" ? range.getClientRects() : [];
      if (rects && rects.length > 0) rect = rects[rects.length - 1];
      else if (typeof range.getBoundingClientRect === "function") rect = range.getBoundingClientRect();
    }
    addCommentButton.hidden = false;
    setStyle(addCommentButton, "position", "fixed");
    if (rect) {
      setStyle(addCommentButton, "left", `${rect.right}px`);
      setStyle(addCommentButton, "top", `${rect.top}px`);
    }
  }

  function editingCommentIds() {
    const ids = new Set(unsavedThreads);
    for (const id of replyDrafts.keys()) ids.add(id);
    for (const key of editingNotes) {
      const tab = key.indexOf("\t");
      if (tab >= 0) ids.add(key.slice(0, tab));
    }
    return ids;
  }

  function markEditingHighlights() {
    const ids = editingCommentIds();
    if (ids.size === 0) return;
    const walk = (node) => {
      if (!node) return;
      if (node.nodeType === 1 && node.classList && node.classList.contains("md-comment") && node.dataset && ids.has(node.dataset.comment)) {
        node.classList.add("md-comment-editing");
      }
      for (const child of node.childNodes || []) walk(child);
    };
    walk(root);
  }

  function findCommentCard(id) {
    let found = null;
    const walk = (node) => {
      if (!node || found) return;
      if (node.classList && node.classList.contains("md-comment-card") && node.dataset && node.dataset.comment === id) {
        found = node;
        return;
      }
      for (const child of node.childNodes || []) walk(child);
    };
    if (commentsAside) walk(commentsAside);
    return found;
  }

  // The author field has to stay the node that was clicked, so the class moves on the live cards.
  function showCurrentCard(card) {
    if (!card || !card.dataset) return;
    currentCommentId = card.dataset.comment;
    if (!commentsAside) return;
    const walk = (node) => {
      if (!node) return;
      if (node.classList && node.classList.contains("md-comment-card")) {
        if (node === card) node.classList.add("md-comment-current");
        else node.classList.remove("md-comment-current");
      }
      for (const child of node.childNodes || []) walk(child);
    };
    walk(commentsAside);
  }

  function clearCurrentComment() {
    currentCommentId = null;
    if (!commentsAside) return;
    const walk = (node) => {
      if (!node) return;
      if (node.classList && node.classList.contains("md-comment-current")) node.classList.remove("md-comment-current");
      for (const child of node.childNodes || []) walk(child);
    };
    walk(commentsAside);
  }

  function render() {
    const planned = plan(state.doc, state.cursor);
    root.replaceChildren(...planned.blocks.map(renderBlock));
    markEditingHighlights();
    renderCommentAside(planned.comments);
    layoutComments();
    if (commentFocus) focusComment(commentFocus.id, commentFocus.start, commentFocus.end, commentFocus.note);
    else placeCaret();
    updateCommentButton();
  }

  function apply(next) {
    if (next === state) return;
    state = next;
    render();
  }

  function consumePaste(text) {
    if (pasteSeen) return;
    pasteSeen = true;
    adoptDomSelection();
    if (text) apply(insert(state, text));
    queueMicrotask(() => {
      pasteSeen = false;
    });
  }

  function moveCaret(direction, granularity) {
    const sel = window.getSelection();
    if (!sel) return;
    if (sel.rangeCount === 0) placeCaret();
    const beforeCursor = state.cursor;
    const before = lineIndexAt(state.doc, beforeCursor);
    sel.modify("move", direction, granularity);
    if (sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const landed = mapOffset(range.startContainer, range.startOffset);
    const next = placeMove(state.doc, beforeCursor, landed, direction, granularity);
    const after = lineIndexAt(state.doc, next);
    state = { ...state, cursor: next, anchor: next };
    if (before !== after) render();
    else if (next !== landed) placeCaret();
  }

  listen("beforeinput", (event) => {
    commentFocus = null;
    event.preventDefault();
    if (composing) return;
    const type = event.inputType;
    const edits = type === "insertText"
      || type === "insertParagraph"
      || type === "insertLineBreak"
      || type === "deleteContentBackward"
      || type === "deleteContentForward"
      || type === "deleteWordBackward"
      || type === "deleteWordForward"
      || type === "insertFromPaste"
      || type === "insertFromDrop";
    if (edits) adoptDomSelection();
    if (type === "insertText") {
      if (event.data === "\t") return;
      if (event.data && event.data !== composed) apply(insert(state, event.data));
      return;
    }
    if (type === "insertCompositionText" || type === "insertFromComposition") return;
    if (type === "insertParagraph" || type === "insertLineBreak") {
      apply(insert(state, "\n"));
      return;
    }
    if (type === "deleteContentBackward") {
      apply(backspace(state));
      return;
    }
    if (type === "deleteContentForward") {
      apply(deleteForward(state));
      return;
    }
    if (type === "deleteWordBackward" || type === "deleteWordForward") {
      if (state.anchor !== state.cursor) {
        apply(deleteForward(state));
        return;
      }
      const edges = wordEdges(state.doc, state.cursor, type === "deleteWordBackward" ? -1 : 1);
      const [from, to] = expandAtoms(state.doc, edges[0], edges[1], state.cursor);
      if (from !== to) apply(deleteForward({ ...state, anchor: from, cursor: to }));
      return;
    }
    if (type === "insertFromPaste" || type === "insertFromDrop") {
      const text = event.dataTransfer?.getData("text/plain") ?? event.data ?? "";
      consumePaste(text);
    }
  });

  listen("paste", (event) => {
    event.preventDefault();
    consumePaste(event.clipboardData?.getData("text/plain") ?? "");
  });

  listen("copy", (event) => {
    event.preventDefault();
    event.clipboardData.setData("text/plain", selectedSlice(state));
  });

  listen("cut", (event) => {
    event.preventDefault();
    adoptDomSelection();
    const result = cut(state);
    event.clipboardData.setData("text/plain", result.text);
    apply(result.state);
  });

  listen("compositionstart", () => {
    composing = true;
  });

  listen("compositionend", (event) => {
    composing = false;
    composed = event.data || "";
    adoptDomSelection();
    if (composed) apply(insert(state, composed));
    queueMicrotask(() => {
      composed = "";
    });
  });

  listen("keydown", (event) => {
    commentFocus = null;
    if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      adoptDomSelection();
      apply(insert(state, "\t"));
      return;
    }
    const mod = event.ctrlKey || event.metaKey;
    if (mod && !event.altKey && (event.key === "z" || event.key === "Z")) {
      event.preventDefault();
      apply(event.shiftKey ? redo(state) : undo(state));
      return;
    }
    if (mod && !event.altKey && (event.key === "y" || event.key === "Y")) {
      event.preventDefault();
      apply(redo(state));
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      moveCaret(event.key === "ArrowRight" ? "forward" : "backward", "character");
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      moveCaret(event.key === "ArrowDown" ? "forward" : "backward", "line");
    }
  });

  listen("mousedown", (event) => {
    commentFocus = null;
    pointer = { x: event.clientX, y: event.clientY };
    didDrag = false;
  });

  listen("mouseup", (event) => {
    if (!pointer) return;
    const moved = Math.abs(event.clientX - pointer.x) > 3 || Math.abs(event.clientY - pointer.y) > 3;
    pointer = null;
    const sel = window.getSelection();
    if (!moved || !sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (range.collapsed) return;
    if (!root.contains(range.commonAncestorContainer)) return;
    const mapped = selectionFromDom(sel);
    if (!mapped) return;
    didDrag = true;
    const before = lineIndexAt(state.doc, state.cursor);
    const after = lineIndexAt(state.doc, mapped.cursor);
    state = { ...state, anchor: mapped.anchor, cursor: mapped.cursor };
    if (before !== after) render();
    else updateCommentButton();
  });

  listen("click", (event) => {
    const target = event.target.nodeType === 1 ? event.target : event.target.parentElement;
    const link = target?.closest?.("a");
    if (link && root.contains(link)) event.preventDefault();
    if (didDrag) {
      didDrag = false;
      return;
    }
    const highlighted = target?.closest?.(".md-comment");
    let keepCurrent = false;
    if (highlighted && highlighted.dataset && highlighted.dataset.comment) {
      const id = highlighted.dataset.comment;
      const inside = root.contains(highlighted);
      const connected = highlighted.isConnected === true;
      const box = findCommentBox(id);
      if (box && (inside || !connected)) {
        event.preventDefault();
        currentCommentId = id;
        const caret = typeof box.value === "string" ? box.value.length : 0;
        commentFocus = { id, start: caret, end: caret };
        render();
        return;
      }
      if (inside) {
        const card = findCommentCard(id);
        if (card) showCurrentCard(card);
        else currentCommentId = id;
        keepCurrent = true;
      }
    }
    const atom = target?.closest?.(".md-atom");
    if (atom && root.contains(atom)) {
      event.preventDefault();
      if (!keepCurrent) currentCommentId = null;
      const next = atomClickOffset(atom, target);
      state = { ...state, anchor: next, cursor: next };
      render();
      return;
    }
    if (!keepCurrent) clearCurrentComment();
    if (typeof document.caretPositionFromPoint !== "function") return;
    const pos = document.caretPositionFromPoint(event.clientX, event.clientY);
    if (!pos) return;
    const offset = mapOffset(pos.offsetNode, pos.offset);
    state = { ...state, cursor: offset, anchor: offset };
    render();
  });

  listen("auxclick", (event) => {
    const target = event.target.nodeType === 1 ? event.target : event.target.parentElement;
    if (target?.closest?.("a")) event.preventDefault();
  });

  if (commentsAside && typeof commentsAside.addEventListener === "function") {
    commentsAside.addEventListener("click", (event) => {
      const target = event && event.target;
      const text = commentTextFromTarget(target);
      if (text) {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        openSavedNote(text);
        return;
      }
      let button = target && target.nodeType === 1 ? target : target && target.parentElement;
      while (button) {
        if (button.tagName === "BUTTON") return;
        button = button.parentElement;
      }
      const card = ancestorWithClass(target && target.nodeType === 1 ? target : target && target.parentElement, "md-comment-card");
      if (!card || !card.dataset || !card.dataset.comment) return;
      if (!threadById(card.dataset.comment)) return;
      showCurrentCard(card);
    }, { signal: ac.signal });
    commentsAside.addEventListener("input", (event) => {
      const box = event.target;
      if (!box || !box.classList) return;
      if (box.classList.contains("md-comment-author")) {
        const card = ancestorWithClass(box, "md-comment-card");
        if (!card) return;
        const note = ancestorWithClass(box, "md-comment-note");
        const host = note || card;
        let index = 0;
        for (const child of host.childNodes || []) {
          if (!child.classList || !child.dataset) continue;
          if (child.classList.contains("md-comment-body") || child.classList.contains("md-comment-text")) {
            index = Number(child.dataset.note);
          }
        }
        authorDrafts.set(draftKey(card.dataset.comment, index), box.value);
        return;
      }
      if (!box.classList.contains("md-comment-body")) return;
      const id = box.dataset && box.dataset.comment;
      if (!id) return;
      const index = Number(box.dataset.note || 0);
      const start = Number.isFinite(box.selectionStart) ? box.selectionStart : String(box.value || "").length;
      const end = Number.isFinite(box.selectionEnd) ? box.selectionEnd : start;
      if (box.dataset.reply === "true") replyDrafts.set(id, box.value);
      else noteDrafts.set(draftKey(id, index), box.value);
      commentFocus = { id, note: index, start, end };
      syncNoteButtons(box);
    }, { signal: ac.signal });
    commentsAside.addEventListener("keydown", (event) => {
      const box = event.target;
      if (!box || !box.classList || !box.classList.contains("md-comment-body")) return;
      const mod = event.ctrlKey || event.metaKey;
      if (!mod || event.altKey) return;
      const key = event.key;
      if (key !== "z" && key !== "Z" && key !== "y" && key !== "Y") return;
      event.preventDefault();
      const id = box.dataset && box.dataset.comment;
      const note = Number(box.dataset && box.dataset.note || 0);
      const redoKey = key === "y" || key === "Y" || event.shiftKey;
      commentFocus = { id, note, start: Number.MAX_SAFE_INTEGER, end: Number.MAX_SAFE_INTEGER };
      apply(redoKey ? redo(state) : undo(state));
    }, { signal: ac.signal });
  }

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("resize", () => layoutComments(), { signal: ac.signal });
  }

  render();

  return {
    getState() {
      return state;
    },
    focus() {
      commentFocus = null;
      root.focus();
      placeCaret();
    },
    destroy() {
      ac.abort();
      if (addCommentButton && addCommentButton.parentElement && typeof addCommentButton.parentElement.removeChild === "function") {
        addCommentButton.parentElement.removeChild(addCommentButton);
      }
    },
  };
}

function boot() {
  const root = document.getElementById("editor");
  if (!root) return;
  const doc = sampleDocument();
  const editor = createEditor(root, doc, initialCursor(doc));
  editor.focus();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
}
