// Source string is the document. The view is a projection: the cursor line keeps
// the parsed runs and fills marker gaps so those characters stay editable text.
// The markdown this editor supports is GitHub, GitLab, and Obsidian markdown.
// A mermaid fence is a diagram.

import {
  sampleDocument,
  initialCursor,
  createState,
  addComment,
  plan as documentPlan,
  stepOver,
  snapMove,
  placeMove,
  insert,
  backspace,
  deleteForward,
  undo,
  redo,
  selectedSlice,
  cut,
  findSpans,
  commentThreads,
  commentNotes,
  orderVisibleComments,
  lineIndexAt,
  replaceCommentBody,
  removeCommentThread,
  setCommentResolved,
  replaceDocument,
} from "./doc.js";

export {
  sampleDocument,
  initialCursor,
  createState,
  addComment,
  stepOver,
  snapMove,
  placeMove,
  insert,
  backspace,
  deleteForward,
  undo,
  redo,
  selectedSlice,
  cut,
};

// A declaration, not `export { plan }`: the served file is checked for this text.
export function plan(doc, cursor) {
  return documentPlan(doc, cursor);
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
