// Source string is the document. The view is a projection: the cursor line is raw,
// and atoms stay source ranges even when that line is a single text node.

const SAMPLE = [
  "# Viewmark",
  "",
  "A **bold** claim and the word wrapped on this line. The caret can travel to the end of this raw line while the pane wraps the text. The caret can travel to the end of this raw line while the pane wraps the text. The caret can travel to the end of this raw line while the pane wraps the text.",
  "",
  "> Quoted *emphasis* and `code`.",
  "",
  "- one",
  "- two",
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
  "```mermaid",
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

function classify(text) {
  if (text === "---" || text === "***" || text === "___") {
    return { kind: "hr", marker: 0, plain: "md-hr" };
  }
  const heading = /^(#{1,6}) (.*)$/.exec(text);
  if (heading) {
    const level = heading[1].length;
    return { kind: "h", level, marker: level + 1, plain: `md-h${level}` };
  }
  if (text.startsWith("> ")) return { kind: "quote", marker: 2, plain: "md-quote" };
  const item = /^((?:[-*+]|\d+\.) )(.*)$/.exec(text);
  if (item) return { kind: "li", marker: item[1].length, plain: "md-li" };
  return { kind: "p", marker: 0, plain: "md-p" };
}

function fenceOpen(text) {
  const match = /^```[ \t]*([^`\s]*)(.*)$/.exec(text);
  if (!match) return null;
  const lang = match[1];
  return {
    lang,
    diagram: lang === "mermaid" || lang === "diagram",
  };
}

function isFenceClose(text) {
  return /^```\s*$/.test(text);
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

function splitCells(text) {
  let body = text.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|")) body = body.slice(0, -1);
  return body.split("|").map((cell) => cell.trim());
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
      if (opened.diagram) {
        const bodyLines = lines.slice(index + 1, closed ? last : last + 1);
        const atom = {
          type: "diagram",
          start: lines[index].start,
          end: lines[last].end,
          info: opened.lang,
          body: bodyLines.map((line) => line.text).join("\n"),
        };
        atoms.push(atom);
        slots.push({ kind: "atom", atom });
      } else {
        const mode = { kind: "codeblock", marker: 0, plain: "md-codeblock" };
        for (let line = index; line <= last; line += 1) {
          const parsed = parseSlot(lines[line], mode);
          slots.push({ kind: "line", line: lines[line], mode, parsed });
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
      for (let line = index + 2; line <= last; line += 1) rows.push(splitCells(lines[line].text));
      const atom = {
        type: "table",
        start: lines[index].start,
        end: lines[last].end,
        header: splitCells(lines[index].text),
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
  return { atoms, slots };
}

function rawBlock(line) {
  const empty = line.start === line.end;
  const run = empty
    ? null
    : {
        type: "run",
        text: line.text,
        start: line.start,
        end: line.end,
        classes: ["md-raw"],
      };
  return {
    type: "line",
    raw: true,
    empty,
    start: line.start,
    end: line.end,
    text: line.text,
    classes: ["md-raw"],
    runs: run ? [run] : [],
    parts: run ? [run] : [],
  };
}

function renderedBlock(line, mode, parsed) {
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
    };
  }
  return {
    type: "line",
    raw: false,
    empty: false,
    start: line.start,
    end: line.end,
    text: line.text,
    classes: [mode.plain],
    runs: parsed.runs,
    parts: parsed.parts,
  };
}

export function plan(doc, cursor) {
  const { slots } = structures(doc);
  const blocks = [];
  for (const slot of slots) {
    if (slot.kind === "atom") {
      blocks.push(slot.atom);
      continue;
    }
    const { line, mode, parsed } = slot;
    if (cursor >= line.start && cursor <= line.end) blocks.push(rawBlock(line));
    else blocks.push(renderedBlock(line, mode, parsed));
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
  return { blocks, lines, atoms };
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

// A raw image line is one text node, so only atoms still rendered for that cursor snap.
export function snapMove(doc, cursor, landed, direction) {
  const forward = direction === "forward" || direction === "right";
  const atoms = plan(doc, cursor).atoms;
  if (forward) {
    const atom = atoms.find((item) => landed >= item.start && landed < item.end);
    return atom ? atom.end : landed;
  }
  const atom = atoms.find((item) => landed > item.start && landed <= item.end);
  return atom ? atom.start : landed;
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

export function insert(state, text) {
  const value = typeof text === "string" ? text : "";
  const from = Math.min(state.anchor, state.cursor);
  const to = Math.max(state.anchor, state.cursor);
  if (value === "" && from === to) return state;
  return splice(state, from, to, value, from + value.length);
}

export function backspace(state) {
  if (state.anchor !== state.cursor) {
    const from = Math.min(state.anchor, state.cursor);
    return splice(state, from, Math.max(state.anchor, state.cursor), "", from);
  }
  if (state.cursor <= 0) return state;
  const atom = renderedAtomAt(state.doc, state.cursor, (item) => state.cursor > item.start && state.cursor <= item.end);
  if (atom) return splice(state, atom.start, atom.end, "", atom.start);
  return splice(state, state.cursor - 1, state.cursor, "", state.cursor - 1);
}

export function deleteForward(state) {
  if (state.anchor !== state.cursor) {
    const from = Math.min(state.anchor, state.cursor);
    return splice(state, from, Math.max(state.anchor, state.cursor), "", from);
  }
  if (state.cursor >= state.doc.length) return state;
  const atom = renderedAtomAt(state.doc, state.cursor, (item) => state.cursor >= item.start && state.cursor < item.end);
  if (atom) return splice(state, atom.start, atom.end, "", atom.start);
  return splice(state, state.cursor, state.cursor + 1, "", state.cursor);
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
  if (part.text.length === 0) el.appendChild(document.createElement("br"));
  else el.appendChild(document.createTextNode(part.text));
  return el;
}

function renderImage(image) {
  const el = document.createElement("span");
  el.className = "md-atom md-image";
  el.contentEditable = "false";
  el.dataset.start = String(image.start);
  el.dataset.end = String(image.end);
  const img = document.createElement("img");
  img.src = image.url;
  img.alt = image.alt;
  img.draggable = false;
  el.appendChild(img);
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
  for (const cell of atom.header) {
    const th = document.createElement("th");
    th.textContent = cell;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  const tbody = document.createElement("tbody");
  for (const row of atom.rows) {
    const tr = document.createElement("tr");
    for (const cell of row) {
      const td = document.createElement("td");
      td.textContent = cell;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  el.appendChild(table);
  return el;
}

function renderDiagram(atom) {
  const el = document.createElement("div");
  el.className = "md-atom md-diagram";
  el.contentEditable = "false";
  el.dataset.start = String(atom.start);
  el.dataset.end = String(atom.end);
  const label = document.createElement("div");
  label.className = "md-diagram-label";
  label.textContent = atom.info;
  const pre = document.createElement("pre");
  pre.textContent = atom.body;
  el.append(label, pre);
  return el;
}

function renderBlock(block) {
  if (block.type === "table") return renderTable(block);
  if (block.type === "diagram") return renderDiagram(block);
  const el = document.createElement("div");
  el.className = ["md-line", ...block.classes].join(" ");
  if (block.raw || block.empty || block.hr) {
    el.dataset.start = String(block.start);
    el.dataset.end = String(block.end);
  }
  if (block.raw) {
    if (block.empty) el.appendChild(document.createElement("br"));
    else el.appendChild(document.createTextNode(block.text));
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

export function createEditor(root, doc, cursor = 0) {
  let state = createState(doc, cursor);
  const ac = new AbortController();
  const listen = (type, fn, options = {}) => {
    root.addEventListener(type, fn, { ...options, signal: ac.signal });
  };
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

  function render() {
    const blocks = plan(state.doc, state.cursor).blocks;
    root.replaceChildren(...blocks.map(renderBlock));
    placeCaret();
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
    const next = snapMove(state.doc, beforeCursor, landed, direction);
    const after = lineIndexAt(state.doc, next);
    state = { ...state, cursor: next, anchor: next };
    if (before !== after) render();
    else if (next !== landed) placeCaret();
  }

  listen("beforeinput", (event) => {
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
  });

  listen("click", (event) => {
    const target = event.target.nodeType === 1 ? event.target : event.target.parentElement;
    const link = target?.closest?.("a");
    if (link && root.contains(link)) event.preventDefault();
    if (didDrag) {
      didDrag = false;
      return;
    }
    const atom = target?.closest?.(".md-atom");
    if (atom && root.contains(atom)) {
      event.preventDefault();
      clearAtomMark();
      atom.classList.add("md-atom-selected");
      state = {
        ...state,
        anchor: Number(atom.dataset.start),
        cursor: Number(atom.dataset.end),
      };
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNode(atom);
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
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

  render();

  return {
    getState() {
      return state;
    },
    focus() {
      root.focus();
      placeCaret();
    },
    destroy() {
      ac.abort();
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
