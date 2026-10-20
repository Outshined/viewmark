// Source string is the document. The view is a projection: the cursor line keeps
// the parsed runs and fills marker gaps so those characters stay editable text.
// The markdown this editor supports is GitHub, GitLab, and Obsidian markdown.
// A mermaid fence is a diagram. A comment marker is not one of those characters:
// it has no text node, so the caret cannot sit inside it.

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
  commentDragPreview,
  commentThreads,
  parseCommentNotes,
  splitCommentNote,
  orderVisibleComments,
  lineIndexAt,
  lockIndexAt,
  lockSpans,
  blockSpan,
  skipHidden,
  enterInsert,
  enterBreak,
  shiftBreak,
  lineCaret,
  wordStop,
  endBeforeTail,
  endBeforeTrailingCommentFence,
  ruleLineStop,
  gapCaretStops,
  imageLine,
  sourceLine,
} from "./doc.js";
import { createMemoryTransport, createSocketTransport } from "./session.js";
import { vimKey, vimMatchStarts, vimSubmit, VIM_SEARCH_LIMIT } from "./vim.js";
import { TICKET_PRIORITIES, TICKET_STATES, TICKET_TYPES, isTicketToken, parseTicketToken } from "./ticket.js";
import { MAX_PAYLOAD } from "./ws.js";

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
export function plan(doc, cursor, revealTail) {
  return documentPlan(doc, cursor, revealTail);
}

function sameLines(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function isMarkdownPath(file) {
  const lower = file.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

function createPath(raw) {
  const trimmed = String(raw ?? "").trim().replace(/^\/+/, "");
  if (!trimmed) return "";
  if (trimmed.endsWith(".md") || trimmed.endsWith(".markdown")) return trimmed;
  return `${trimmed}.md`;
}

function insertAfter(parent, after, node) {
  // A NodeList has no indexOf. appendChild would put this node after later siblings.
  const follower = after ? after.nextSibling : undefined;
  if (after && typeof parent.insertBefore === "function" && (follower === null || (follower && typeof follower === "object"))) {
    parent.insertBefore(node, follower);
    return;
  }
  const children = parent.childNodes || [];
  const index = typeof children.indexOf === "function" ? children.indexOf(after) : -1;
  const next = index >= 0 ? children[index + 1] : null;
  if (next && typeof parent.insertBefore === "function") {
    parent.insertBefore(node, next);
    return;
  }
  if (next && typeof children.splice === "function") {
    node.parentElement = parent;
    children.splice(index + 1, 0, node);
    return;
  }
  parent.appendChild(node);
}

function placeNodeBefore(parent, node, before) {
  if (!parent || !node) return;
  if (!before) {
    parent.appendChild(node);
    return;
  }
  if (typeof parent.insertBefore === "function") {
    parent.insertBefore(node, before);
    return;
  }
  const children = parent.childNodes || [];
  const index = typeof children.indexOf === "function" ? children.indexOf(before) : -1;
  if (index >= 0 && typeof children.splice === "function") {
    node.parentElement = parent;
    children.splice(index, 0, node);
    return;
  }
  parent.appendChild(node);
}

function detachNode(node) {
  const parent = node && node.parentElement;
  if (!parent) return;
  if (typeof parent.removeChild === "function") {
    parent.removeChild(node);
    return;
  }
  const children = parent.childNodes;
  if (children && typeof children.indexOf === "function" && typeof children.splice === "function") {
    const index = children.indexOf(node);
    if (index >= 0) children.splice(index, 1);
  }
  node.parentElement = null;
}

function findClassChild(parent, className) {
  if (!parent || !parent.childNodes) return null;
  for (const child of parent.childNodes) {
    if (child && child.classList && child.classList.contains(className)) return child;
  }
  return null;
}

function findTicketTree(nav) {
  const block = findClassChild(nav, "ticket-block");
  if (!block) return null;
  const drawer = findClassChild(block, "md-ticket-drawer");
  const nested = findClassChild(drawer, "ticket-tree");
  if (nested) return nested;
  return findClassChild(block, "ticket-tree");
}

function findDeep(root, className) {
  return findElement(root, (el) => el.classList && el.classList.contains(className));
}

function childArray(parent) {
  const kids = parent && parent.childNodes ? parent.childNodes : [];
  return typeof kids.indexOf === "function" ? kids : [...kids];
}

function isImmediatelyAfter(parent, after, node) {
  if (!parent || !after || !node || node.parentElement !== parent || after.parentElement !== parent) return false;
  const kids = childArray(parent);
  const index = kids.indexOf(after);
  return index >= 0 && kids[index + 1] === node;
}

function placeFirst(parent, node) {
  if (!parent || !node) return;
  if (childArray(parent)[0] === node) return;
  detachNode(node);
  placeNodeBefore(parent, node, parent.childNodes && parent.childNodes[0]);
}

function placeAfter(parent, after, node) {
  if (!parent || !node) return;
  if (!after) {
    if (node.parentElement !== parent) {
      detachNode(node);
      parent.appendChild(node);
    }
    return;
  }
  if (isImmediatelyAfter(parent, after, node)) return;
  detachNode(node);
  insertAfter(parent, after, node);
}

function detachClass(root, className) {
  const doomed = [];
  const walk = (node) => {
    for (const child of [...((node && node.childNodes) || [])]) {
      if (!child || child.nodeType !== 1) continue;
      if (child.classList && child.classList.contains(className)) doomed.push(child);
      else walk(child);
    }
  };
  walk(root);
  for (const node of doomed) detachNode(node);
}

function ensureFileBlock(nav) {
  let block = findClassChild(nav, "file-block");
  if (!block) {
    block = document.createElement("div");
    block.className = "file-block";
    placeNodeBefore(nav, block, findClassChild(nav, "ticket-block"));
  }
  return block;
}

// The head stays on the block. Only this panel widens, so the buttons do not move.
function ensureFileDrawer(block) {
  if (!block || typeof document === "undefined" || typeof document.createElement !== "function") return null;
  let drawer = findClassChild(block, "md-file-drawer");
  if (!drawer) {
    drawer = document.createElement("div");
    drawer.className = "md-file-drawer";
  }
  const field = findClassChild(block, "md-new-name");
  const head = findClassChild(block, "md-pane-head");
  if (field) placeAfter(block, field, drawer);
  else if (head) placeAfter(block, head, drawer);
  else if (drawer.parentElement !== block) block.appendChild(drawer);
  return drawer;
}

function ensurePaneHead(block, title) {
  let head = findClassChild(block, "md-pane-head");
  if (!head) {
    head = document.createElement("div");
    head.className = "md-pane-head";
  }
  placeFirst(block, head);
  let heading = findClassChild(head, "md-pane-heading");
  if (!heading) {
    heading = document.createElement("h2");
    heading.className = "md-pane-heading";
    head.appendChild(heading);
  }
  if (heading.textContent !== title) heading.textContent = title;
  placeFirst(head, heading);
  return { head, heading };
}

function ensureNavButton(nav, className, text) {
  let button = findDeep(nav, className);
  const icon = className === "md-new-file" || className === "md-new-ticket";
  if (!button) {
    button = icon ? iconButton("plus", className) : document.createElement("button");
    if (!icon) button.className = className;
  }
  button.type = "button";
  if (typeof button.setAttribute === "function") button.setAttribute("type", "button");
  if (icon) {
    button.className = `icon-btn ${className}`;
    if (typeof button.setAttribute === "function") {
      const label = className === "md-new-file" ? "New file" : "New ticket";
      button.setAttribute("aria-label", label);
      button.setAttribute("title", label);
    }
    // textContent replaces the svg, and "+" is not the button label.
    if (button.textContent !== "" || !iconMatches(button, "plus")) {
      for (const child of childArray(button).slice()) detachNode(child);
      const svg = iconSvg("plus");
      if (svg) button.appendChild(svg);
    }
    return button;
  }
  button.className = className;
  if (button.textContent !== text) button.textContent = text;
  return button;
}

// ensureNavButton assigns textContent, which replaces the svg.
function ensureFilterButton(nav) {
  let button = findDeep(nav, "md-ticket-filter");
  if (!button) button = document.createElement("button");
  button.type = "button";
  button.className = "icon-btn md-ticket-filter";
  if (typeof button.setAttribute === "function") {
    button.setAttribute("type", "button");
    button.setAttribute("aria-label", "Filter");
    button.setAttribute("title", "Filter");
  }
  if (button.textContent !== "" || !iconMatches(button, "filter")) {
    for (const child of childArray(button).slice()) detachNode(child);
    const svg = iconSvg("filter");
    if (svg) button.appendChild(svg);
  }
  return button;
}

// Defect is the label for ticket type bug. The form select still uses TICKET_TYPES.
const TICKET_FILTERS = [
  { label: "closed", filter: "closed", checked: false },
  { label: "low", filter: "low", checked: true },
  { label: "medium", filter: "medium", checked: true },
  { label: "high", filter: "high", checked: true },
  { label: "task", filter: "task", checked: true },
  { label: "enhancement", filter: "enhancement", checked: true },
  { label: "defect", filter: "bug", checked: true },
];

const TICKET_COLUMNS = [
  { key: "id", label: "ID", className: "md-ticket-id" },
  { key: "title", label: "Title", className: "md-ticket-title" },
  { key: "priority", label: "Priority", className: "md-ticket-priority" },
  { key: "assignee", label: "Assignee", className: "md-ticket-assignee" },
  { key: "state", label: "State", className: "md-ticket-state" },
  { key: "type", label: "Type", className: "md-ticket-type" },
];

function filterBoxes(menu) {
  const found = [];
  const walk = (node) => {
    for (const child of [...((node && node.childNodes) || [])]) {
      if (!child || child.nodeType !== 1) continue;
      if (child.dataset && child.dataset.filter) found.push(child);
      walk(child);
    }
  };
  walk(menu);
  return found;
}

function enabledFilters(nav) {
  const menu = findClassChild(findClassChild(nav, "ticket-block"), "md-ticket-filter-menu");
  const on = new Set();
  if (!menu) {
    for (const row of TICKET_FILTERS) if (row.checked) on.add(row.filter);
    return on;
  }
  for (const box of filterBoxes(menu)) if (box.checked === true) on.add(box.dataset.filter);
  return on;
}

function applyFilterDefaults(menu) {
  const byName = new Map();
  for (const box of filterBoxes(menu)) byName.set(box.dataset.filter, box);
  for (const row of TICKET_FILTERS) {
    const box = byName.get(row.filter);
    if (box) box.checked = row.checked;
  }
}

function buildFilterMenu(menu) {
  if (filterBoxes(menu).length > 0) return;
  for (const row of TICKET_FILTERS) {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.dataset.filter = row.filter;
    box.checked = row.checked;
    if (typeof box.setAttribute === "function") {
      box.setAttribute("type", "checkbox");
      box.setAttribute("data-filter", row.filter);
    }
    label.appendChild(box);
    label.appendChild(document.createTextNode(row.label));
    menu.appendChild(label);
  }
  const all = document.createElement("button");
  all.type = "button";
  all.className = "md-ticket-filter-all";
  all.textContent = "show all";
  if (typeof all.setAttribute === "function") all.setAttribute("type", "button");
  menu.appendChild(all);
}

function ticketSortGlyph(dir) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  path.setAttribute("d", dir === "desc" ? "M12 5v14M19 12l-7 7-7-7" : "M12 19V5M5 12l7-7 7 7");
  svg.appendChild(path);
  return svg;
}

function ensureTicketColumns(tree) {
  if (!tree || typeof document === "undefined" || typeof document.createElement !== "function") return null;
  let columns = findClassChild(tree, "md-ticket-columns");
  if (columns) return columns;
  columns = document.createElement("div");
  columns.className = "md-ticket-columns";
  // The leading track matches the row gutter, so the labels share the field tracks.
  columns.appendChild(document.createElement("span"));
  for (const column of TICKET_COLUMNS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = column.className;
    button.dataset.sort = column.key;
    button.textContent = column.label;
    if (typeof button.setAttribute === "function") {
      button.setAttribute("type", "button");
      button.setAttribute("aria-label", `Sort by ${column.label}`);
      button.setAttribute("data-sort", column.key);
    }
    columns.appendChild(button);
  }
  return columns;
}

function hideElement(el) {
  if (!el) return;
  el.hidden = true;
  if (typeof el.setAttribute === "function") el.setAttribute("hidden", "");
}

function showElement(el) {
  if (!el) return;
  el.hidden = false;
  if (typeof el.removeAttribute === "function") el.removeAttribute("hidden");
}

function validTicketTitle(value) {
  if (typeof value !== "string") return null;
  const title = value.trim();
  if (title.length < 1 || title.length > 200) return null;
  if (title.includes("\r") || title.includes("\n") || title.includes("\t")) return null;
  return title;
}

function normalizeTicket(ticket) {
  if (!ticket || typeof ticket !== "object") return null;
  const id = typeof ticket.id === "string" ? ticket.id : "";
  if (!id) return null;
  const depends = [];
  if (Array.isArray(ticket.depends)) {
    for (const item of ticket.depends) if (typeof item === "string") depends.push(item);
  }
  const rev = typeof ticket.rev === "number" && Number.isFinite(ticket.rev) ? ticket.rev : 0;
  return {
    id,
    title: typeof ticket.title === "string" ? ticket.title : "",
    state: typeof ticket.state === "string" ? ticket.state : "",
    type: TICKET_TYPES.includes(ticket.type) ? ticket.type : "task",
    priority: TICKET_PRIORITIES.includes(ticket.priority) ? ticket.priority : "medium",
    assignee: typeof ticket.assignee === "string" ? ticket.assignee : "",
    parent: typeof ticket.parent === "string" ? ticket.parent : "",
    depends,
    reporter: typeof ticket.reporter === "string" ? ticket.reporter : "",
    created: typeof ticket.created === "string" ? ticket.created : "",
    rev,
  };
}

function normalizeInbound(item) {
  if (!item || typeof item !== "object") return null;
  const repo = typeof item.repo === "string" ? item.repo : "";
  const id = typeof item.id === "string" ? item.id : "";
  if (!repo || !id) return null;
  const depends = [];
  if (Array.isArray(item.depends)) {
    for (const dep of item.depends) if (typeof dep === "string") depends.push(dep);
  }
  return {
    repo,
    id,
    title: typeof item.title === "string" ? item.title : "",
    parent: typeof item.parent === "string" ? item.parent : "",
    depends,
  };
}

function normalizeForeign(item) {
  if (!item || typeof item !== "object") return null;
  const repo = typeof item.repo === "string" ? item.repo : "";
  const id = typeof item.id === "string" ? item.id : "";
  if (!repo || !id) return null;
  const depends = [];
  if (Array.isArray(item.depends)) {
    for (const dep of item.depends) if (typeof dep === "string") depends.push(dep);
  }
  const rev = typeof item.rev === "number" && Number.isFinite(item.rev) ? item.rev : 0;
  return {
    repo,
    id,
    title: typeof item.title === "string" ? item.title : "",
    parent: typeof item.parent === "string" ? item.parent : "",
    depends,
    rev,
  };
}

function compareTickets(a, b) {
  if (a.created < b.created) return -1;
  if (a.created > b.created) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function columnText(ticket, key) {
  const value = ticket && ticket[key];
  return typeof value === "string" ? value : "";
}

function orderSiblings(list, order) {
  const key = order && TICKET_COLUMNS.some((column) => column.key === order.key) ? order.key : "";
  if (!key || (order.dir !== "asc" && order.dir !== "desc")) {
    list.sort(compareTickets);
    return;
  }
  list.sort((a, b) => columnText(a, key).localeCompare(columnText(b, key)));
  if (order.dir === "desc") list.reverse();
}

function sameSet(a, b) {
  const left = [...(a || [])].sort();
  const right = [...(b || [])].sort();
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return false;
  return true;
}

// A parent cycle would recurse forever, so a node already on the chain is not a child.
function chainReaches(start, id, byId) {
  const seen = new Set();
  let current = start;
  while (current && !seen.has(current.id)) {
    if (current.id === id) return true;
    seen.add(current.id);
    current = current.parent ? byId.get(current.parent) : null;
  }
  return false;
}

function forestFrom(list, order) {
  const byId = new Map();
  for (const ticket of list) byId.set(ticket.id, ticket);
  const children = new Map();
  const roots = [];
  for (const ticket of list) {
    const parent = ticket.parent && ticket.parent !== ticket.id ? byId.get(ticket.parent) : null;
    // A parent left out of the list is not an anchor. The child is a root.
    if (parent && !chainReaches(parent, ticket.id, byId)) {
      let kids = children.get(parent.id);
      if (!kids) {
        kids = [];
        children.set(parent.id, kids);
      }
      kids.push(ticket);
    } else {
      roots.push(ticket);
    }
  }
  orderSiblings(roots, order);
  for (const kids of children.values()) orderSiblings(kids, order);
  return { roots, children };
}

function optionWords(selects) {
  const words = [];
  for (const select of selects) {
    for (const option of (select && select.childNodes) || []) {
      const label = option && typeof option.textContent === "string" ? option.textContent : "";
      for (const word of label.split(/\s+/)) if (word) words.push(word);
    }
  }
  return words;
}

function measureWord(word) {
  if (typeof document === "undefined" || typeof document.createElement !== "function") return 0;
  const host = document.body;
  if (!host || typeof host.appendChild !== "function") return 0;
  const probe = document.createElement("span");
  probe.textContent = word;
  if (probe.style && typeof probe.style.setProperty === "function") {
    probe.style.setProperty("position", "absolute");
    probe.style.setProperty("visibility", "hidden");
    probe.style.setProperty("white-space", "nowrap");
  }
  host.appendChild(probe);
  let width = 0;
  if (typeof probe.offsetWidth === "number" && Number.isFinite(probe.offsetWidth) && probe.offsetWidth > 0) {
    width = probe.offsetWidth;
  } else if (typeof probe.getBoundingClientRect === "function") {
    const rect = probe.getBoundingClientRect();
    if (rect && typeof rect.width === "number" && Number.isFinite(rect.width)) width = rect.width;
  }
  if (typeof host.removeChild === "function") host.removeChild(probe);
  return width;
}

function sharedSelectWidth(selects) {
  let best = 0;
  for (const word of optionWords(selects)) {
    const width = measureWord(word);
    if (width > best) best = width;
  }
  return best;
}

function paintSelectWidth(selects, width) {
  const px = `${width}px`;
  for (const select of selects) {
    if (!select || !select.style || typeof select.style.setProperty !== "function") continue;
    select.style.setProperty("width", px);
    select.style.setProperty("max-width", px);
    select.style.setProperty("flex", "none");
  }
}

// The measured word is the text. A border-box select is shorter inside the border, so the closed control clips it.
function selectChromeGap(selects) {
  let extra = 0;
  for (const select of selects) {
    if (!select) continue;
    const scroll = select.scrollWidth;
    const client = select.clientWidth;
    if (typeof scroll !== "number" || typeof client !== "number") continue;
    if (!Number.isFinite(scroll) || !Number.isFinite(client) || scroll <= client) continue;
    const gap = scroll - client;
    if (gap > extra) extra = gap;
  }
  return extra;
}

const SVG_NS = "http://www.w3.org/2000/svg";

const ICON_PATHS = {
  plus: ["M12 5v14M5 12h14"],
  minus: ["M5 12h14"],
  menu: ["M4 6h16M4 12h16M4 18h16"],
  expand: ["M9 6l6 6-6 6"],
  collapse: ["M6 9l6 6 6-6"],
  link: [
    "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",
    "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
  ],
  file: [
    "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z",
    "M14 2v4a2 2 0 0 0 2 2h4",
  ],
  folder: [
    "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
  ],
  delete: ["M18 6 6 18M6 6l12 12"],
  filter: ["M22 3H2l8 9.46V19l4 2v-6.54L22 3z"],
  check: ["M20 6 9 17l-5-5"],
};

function strokePath(d) {
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  path.setAttribute("d", d);
  return path;
}

function iconSvg(action) {
  if (typeof document === "undefined" || typeof document.createElementNS !== "function") return null;
  const paths = ICON_PATHS[action];
  if (!paths) return null;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) svg.appendChild(strokePath(d));
  return svg;
}

function checkGlyph() {
  const svg = iconSvg("check");
  if (!svg || typeof svg.setAttribute !== "function") return svg;
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  return svg;
}

function iconMatches(button, action) {
  const expected = ICON_PATHS[action];
  if (!expected || !button) return false;
  const kids = childArray(button);
  if (kids.length !== 1 || !kids[0] || kids[0].localName !== "svg") return false;
  const paths = childArray(kids[0]).filter((node) => node && node.localName === "path");
  if (paths.length !== expected.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (typeof paths[i].getAttribute !== "function" || paths[i].getAttribute("d") !== expected[i]) return false;
  }
  return true;
}

function linkIcon() {
  return iconSvg("link");
}

function copyGlyph() {
  if (typeof document === "undefined" || typeof document.createElementNS !== "function") return null;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const box of [
    { x: "4", y: "4" },
    { x: "8", y: "8" },
  ]) {
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", box.x);
    rect.setAttribute("y", box.y);
    rect.setAttribute("width", "12");
    rect.setAttribute("height", "12");
    rect.setAttribute("rx", "2");
    rect.setAttribute("ry", "2");
    rect.setAttribute("fill", "none");
    rect.setAttribute("stroke", "currentColor");
    rect.setAttribute("stroke-width", "2");
    rect.setAttribute("stroke-linecap", "round");
    rect.setAttribute("stroke-linejoin", "round");
    svg.appendChild(rect);
  }
  return svg;
}

function iconButton(action, className) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className ? `icon-btn ${className}` : "icon-btn";
  if (typeof button.setAttribute === "function") {
    button.setAttribute("type", "button");
    button.setAttribute("aria-label", action);
    button.setAttribute("title", action);
  }
  const svg = iconSvg(action);
  if (svg) button.appendChild(svg);
  return button;
}

const newFileBindings = new WeakMap();
const ticketBindings = new WeakMap();
const repoBindings = new WeakMap();
const docLinkBindings = new WeakMap();
const REPO_KEY = "viewmark.repo";
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const EYE_OUTLINE = "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z";
const EYE_PUPIL = "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z";

// A lone LF wins. A file whose breaks are all CRLF pairs stays CRLF.
function fileBreak(doc) {
  const text = typeof doc === "string" ? doc : "";
  let paired = false;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "\n") continue;
    if (i === 0 || text[i - 1] !== "\r") return "\n";
    paired = true;
  }
  return paired ? "\r\n" : "\n";
}

function viewIcon(raw) {
  if (typeof document === "undefined" || typeof document.createElementNS !== "function") return null;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.appendChild(strokePath(EYE_OUTLINE));
  svg.appendChild(strokePath(EYE_PUPIL));
  if (!raw) return svg;
  const line = document.createElementNS(SVG_NS, "line");
  line.setAttribute("x1", "3");
  line.setAttribute("y1", "21");
  line.setAttribute("x2", "21");
  line.setAttribute("y2", "3");
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", "rgb(220, 38, 38)");
  line.setAttribute("stroke-width", "2");
  line.setAttribute("stroke-linecap", "round");
  line.setAttribute("stroke-linejoin", "round");
  svg.appendChild(line);
  return svg;
}

function decodeHashSegment(segment) {
  if (typeof segment !== "string" || segment === "") return null;
  let value = "";
  try {
    value = decodeURIComponent(segment);
  } catch {
    return null;
  }
  if (value === "") return null;
  return value;
}

// The path is one segment so a slash inside it survives the hash.
export function formatHash(target) {
  if (!target || typeof target !== "object") return "";
  const repo = target.repo;
  if (typeof repo !== "string" || !REPO_NAME.test(repo)) return "";
  if (target.kind === "doc") {
    if (typeof target.path !== "string" || target.path === "") return "";
    return `#${repo}/doc/${encodeURIComponent(target.path)}`;
  }
  if (target.kind === "ticket") {
    if (typeof target.id !== "string" || target.id === "" || target.id.includes("/") || target.id.includes("\\")) return "";
    return `#${repo}/ticket/${encodeURIComponent(target.id)}`;
  }
  if (target.kind === "comment") {
    if (typeof target.path !== "string" || target.path === "") return "";
    if (typeof target.id !== "string" || target.id === "") return "";
    return `#${repo}/comment/${encodeURIComponent(target.path)}/${encodeURIComponent(target.id)}`;
  }
  return "";
}

export function parseHash(raw) {
  if (typeof raw !== "string" || raw.length < 2) return null;
  const body = raw.charAt(0) === "#" ? raw.slice(1) : raw;
  if (!body || body.includes("#")) return null;
  const parts = body.split("/");
  if (parts.length < 3) return null;
  const repo = parts[0];
  const kind = parts[1];
  if (!REPO_NAME.test(repo)) return null;
  if (kind === "doc" || kind === "ticket") {
    if (parts.length !== 3) return null;
    const value = decodeHashSegment(parts[2]);
    if (value == null) return null;
    if (kind === "ticket") {
      if (value.includes("/") || value.includes("\\")) return null;
      return { repo, kind, id: value };
    }
    return { repo, kind, path: value };
  }
  if (kind === "comment") {
    if (parts.length !== 4) return null;
    const path = decodeHashSegment(parts[2]);
    const id = decodeHashSegment(parts[3]);
    if (path == null || id == null) return null;
    return { repo, kind, path, id };
  }
  return null;
}

function ticketIdFromPath(path) {
  const prefix = "tickets/";
  const suffix = ".md";
  if (typeof path !== "string" || !path.startsWith(prefix) || !path.endsWith(suffix)) return "";
  const id = path.slice(prefix.length, -suffix.length);
  if (!id || id.includes("/") || id.includes("\\")) return "";
  return id;
}

function hashFromHref(href) {
  if (typeof href !== "string" || href === "") return "";
  const index = href.indexOf("#");
  if (index < 0) return "";
  return href.slice(index);
}

// A bare Ctrl-click is a new tab. Shift, Alt, or Meta keeps the page's own click.
function ctrlOpensTab(event) {
  return !!event && event.ctrlKey === true && event.shiftKey !== true && event.altKey !== true && event.metaKey !== true;
}

// The editor cancels a click on an anchor, including inside the editable text,
// so the browser does not open the address. Ctrl-click has to open it itself.
function openLinkTab(link) {
  const href = link && typeof link.href === "string" ? link.href : "";
  if (!href) return false;
  const view = typeof globalThis.window === "object" && globalThis.window ? globalThis.window : null;
  if (!view || typeof view.open !== "function") return false;
  view.open(href, "_blank", "noopener,noreferrer");
  return true;
}

function readLocation() {
  if (typeof globalThis.location === "object" && globalThis.location) return globalThis.location;
  const win = typeof globalThis.window === "object" ? globalThis.window : null;
  if (win && typeof win.location === "object" && win.location) return win.location;
  return null;
}

function readHash() {
  const loc = readLocation();
  if (!loc || typeof loc.hash !== "string") return "";
  return loc.hash;
}

function absoluteHash(hash) {
  const loc = readLocation() || {};
  const origin = typeof loc.origin === "string" ? loc.origin : "";
  const pathname = typeof loc.pathname === "string" ? loc.pathname : "";
  return `${origin}${pathname}${hash}`;
}

function writeClipboard(text) {
  const nav = globalThis.navigator;
  const clipboard = nav && nav.clipboard;
  if (!text || !clipboard || typeof clipboard.writeText !== "function") return;
  try {
    const result = clipboard.writeText(text);
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch {
    // Clipboard permission is optional.
  }
}

// A directory exists only when some markdown file is stored under it.
function buildFileTree(files) {
  const root = { dirs: new Map(), files: [] };
  const list = Array.isArray(files) ? files : [];
  for (const file of list) {
    if (typeof file !== "string" || !isMarkdownPath(file)) continue;
    const parts = file.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    let node = root;
    let acc = "";
    for (let i = 0; i < parts.length - 1; i += 1) {
      const name = parts[i];
      acc = acc ? `${acc}/${name}` : name;
      let child = node.dirs.get(name);
      if (!child) {
        child = { name, path: acc, dirs: new Map(), files: [] };
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.push({ name: parts[parts.length - 1], path: file });
  }
  return root;
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

function nodeElement(node) {
  return node && node.nodeType === 3 ? node.parentElement : node;
}

function insideRawMarker(node) {
  const el = nodeElement(node);
  if (!el || typeof el.closest !== "function") return false;
  return !!(el.closest(".md-raw-hang") || el.closest(".md-raw-gap"));
}

function inRawGap(node) {
  const el = nodeElement(node);
  if (!el || typeof el.closest !== "function") return false;
  return !!el.closest(".md-raw-gap");
}

// sel.modify from the item text stops in the hanging marker at the same source offset.
function crossedIntoRawMarker(origin, landed) {
  if (!origin || !landed || origin === landed) return false;
  if (insideRawMarker(origin) || !insideRawMarker(landed)) return false;
  const el = nodeElement(origin);
  const line = el && typeof el.closest === "function" ? el.closest(".md-line") : null;
  return !!(line && typeof line.querySelector === "function" && line.querySelector(".md-raw-hang"));
}

// A line of only spaces or tabs rests on its start, and the next offset snaps
// there too. A hard break that still shows text rests on its newline. A visible
// line's break does not: up and down there rest on the marker's first offset.
function bareBreakNewline(doc, offset) {
  if (offset > 0 && lineCaret(doc, offset) === offset && lineCaret(doc, offset - 1) === offset) return true;
  return lineCaret(doc, offset) === offset && offset < doc.length && lineCaret(doc, offset + 1) === offset;
}

// The nearest line above the caret that is not blank. A line of only spaces
// or tabs is the up-stop. A blank is not a stop.
function whitespaceLineAbove(doc, offset) {
  const text = typeof doc === "string" ? doc : "";
  if (!Number.isFinite(offset)) return null;
  const [start] = lineSpan(text, Math.min(Math.max(offset, 0), text.length));
  let at = start - 1;
  while (at >= 0) {
    const [lineStart, lineEnd] = lineSpan(text, at);
    const body = text.slice(lineStart, lineEnd);
    if (body.length > 0) return /^[ \t]+$/.test(body) ? lineStart : null;
    if (lineStart <= 0) break;
    at = lineStart - 1;
  }
  return null;
}

// Firefox's line step skips a line of only spaces or a tab and reports the
// paragraph above it. That line is drawn empty, so the step stops on its start.
function whitespaceLineStop(doc, from, to) {
  const text = typeof doc === "string" ? doc : "";
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return null;
  const origin = lineSpan(text, from);
  const dest = lineSpan(text, to);
  if (origin[0] === dest[0]) return null;
  const earlier = origin[0] < dest[0] ? origin : dest;
  const later = origin[0] < dest[0] ? dest : origin;
  let best = null;
  let at = earlier[1] + 1;
  while (at < later[0] && at <= text.length) {
    const [start, end] = lineSpan(text, at);
    if (start >= later[0]) break;
    if (/^[ \t]+$/.test(text.slice(start, end))) {
      if (best == null || Math.abs(start - from) < Math.abs(best - from)) best = start;
    }
    const nextAt = end + 1;
    if (nextAt <= at) break;
    at = nextAt;
  }
  return best;
}

// selectNode reports the atom as a child index on its parent, not a text offset.
export function mapOffset(startOrNode, offset) {
  if (typeof startOrNode === "number") return startOrNode + offset;
  const node = startOrNode;
  const index = offset || 0;
  if (!node) return index;
  if (node.nodeType === 3) {
    const parent = node.parentElement;
    if (parent && parent.classList && parent.classList.contains("md-lock")) {
      const tagged = nearestTagged(parent);
      return tagged ? Number(tagged.dataset.start) : 0;
    }
    const tagged = nearestTagged(node);
    if (!tagged) return index;
    const start = Number(tagged.dataset.start);
    const end = Number(tagged.dataset.end);
    if (start === end) return start;
    // The start mark stands in for the line start. Its far edge is still that
    // offset, not the first character of the picture. The end mark's text is
    // longer than the newline it covers, so a glyph there would not exist; any
    // index past its start is the offset after that newline.
    if (hasClass(tagged, "md-image-caret") && tagged.dataset.edge === "start") return start;
    if (hasClass(tagged, "md-image-caret") && tagged.dataset.edge === "end") return index > 0 ? end : start;
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

// A marker has no glyphs, so the caret on its edge is also the next letter.
// One character press stops at the marker's far edge.
function markerEdgeStop(doc, before, landed, forward) {
  if (!Number.isFinite(before) || !Number.isFinite(landed) || before === landed) return landed;
  for (const span of findSpans(doc)) {
    const edges = forward
      ? [[span.openStart, span.openEnd], [span.closeStart, span.closeEnd]]
      : [[span.openEnd, span.openStart], [span.closeEnd, span.closeStart]];
    for (const [at, far] of edges) {
      if (before === at && (forward ? landed > far : landed < far)) return far;
    }
  }
  return landed;
}

function atMarkerEdge(doc, offset) {
  if (!Number.isFinite(offset)) return false;
  for (const span of findSpans(doc)) {
    if (offset === span.openStart || offset === span.openEnd || offset === span.closeStart || offset === span.closeEnd) return true;
  }
  return false;
}

// Chromium's collapsed range on a zero-width marker is an element boundary and
// has no client rect. The text at that edge is the caret's box.
function markerCaretUnboxed(doc, offset) {
  if (!atMarkerEdge(doc, offset)) return false;
  const view = typeof window !== "undefined" ? window : null;
  const sel = view && typeof view.getSelection === "function" ? view.getSelection() : null;
  if (!sel || !sel.rangeCount || typeof sel.getRangeAt !== "function") return false;
  let range = null;
  try {
    range = sel.getRangeAt(0);
  } catch {
    return false;
  }
  if (!range || range.collapsed !== true || typeof range.getClientRects !== "function") return false;
  let rects = null;
  try {
    rects = range.getClientRects();
  } catch {
    return false;
  }
  if (!rects || rects.length === 0) return true;
  for (let i = 0; i < rects.length; i += 1) {
    const rect = rects[i];
    const height = rect && Number.isFinite(rect.height) ? rect.height : 0;
    const width = rect && Number.isFinite(rect.width) ? rect.width : 0;
    if (height > 0 || width > 0) return false;
  }
  return true;
}

// The drawn selection uses the visible text. Endpoints that only cover a
// glyph-less marker still belong to the source selection.
function visibleSelectionOffset(doc, offset, other) {
  for (const span of findSpans(doc)) {
    const through = (edge, far) => offset === edge && (other - edge) * (far - edge) > 0;
    if (through(span.openStart, span.openEnd)) return span.openEnd;
    if (through(span.closeEnd, span.closeStart)) return span.closeStart;
    if (through(span.closeStart, span.closeEnd)) return span.closeEnd;
    if (through(span.openEnd, span.openStart)) return span.openStart;
  }
  return offset;
}

function hidesOnlyMarkers(doc, outerLo, outerHi, innerLo, innerHi) {
  if (innerLo < outerLo || innerHi > outerHi) return false;
  let lo = outerLo;
  let hi = outerHi;
  const spans = findSpans(doc);
  for (let guard = 0; guard < 8 && (lo !== innerLo || hi !== innerHi); guard += 1) {
    let step = false;
    for (const span of spans) {
      if (lo < innerLo && lo === span.openStart && span.openEnd <= innerLo && span.openEnd <= hi) {
        lo = span.openEnd;
        step = true;
      }
      if (hi > innerHi && hi === span.closeEnd && span.closeStart >= innerHi && span.closeStart >= lo) {
        hi = span.closeStart;
        step = true;
      }
    }
    if (!step) return false;
  }
  return lo === innerLo && hi === innerHi;
}

function withMarkerEdges(doc, prev, mapped) {
  if (!mapped || mapped.anchor === mapped.cursor || !prev || prev.anchor === prev.cursor) return mapped;
  const prevLo = Math.min(prev.anchor, prev.cursor);
  const prevHi = Math.max(prev.anchor, prev.cursor);
  const lo = Math.min(mapped.anchor, mapped.cursor);
  const hi = Math.max(mapped.anchor, mapped.cursor);
  if (!hidesOnlyMarkers(doc, prevLo, prevHi, lo, hi)) return mapped;
  return prev.anchor <= prev.cursor
    ? { anchor: prevLo, cursor: prevHi }
    : { anchor: prevHi, cursor: prevLo };
}

// The range is nothing but comment markers. Their boxes are the selection the
// browser can drag; the source offsets stay the markers.
function coveredOnlyByMarkers(doc, lo, hi) {
  if (!(hi > lo)) return false;
  const pieces = [];
  for (const span of findSpans(doc)) {
    if (span.openEnd > lo && span.openStart < hi) {
      if (span.openStart < lo || span.openEnd > hi) return false;
      pieces.push([span.openStart, span.openEnd]);
    }
    if (span.closeEnd > lo && span.closeStart < hi) {
      if (span.closeStart < lo || span.closeEnd > hi) return false;
      pieces.push([span.closeStart, span.closeEnd]);
    }
  }
  if (pieces.length === 0) return false;
  pieces.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let at = lo;
  for (const [start, end] of pieces) {
    if (start !== at) return false;
    at = end;
  }
  return at === hi;
}

function selectMarkerElements(sel, elements) {
  const first = elements[0];
  const last = elements[elements.length - 1];
  const parent = first && first.parentNode;
  if (!parent || !last || last.parentNode !== parent || typeof document.createRange !== "function") return false;
  const children = parent.childNodes || [];
  let start = -1;
  let end = -1;
  for (let i = 0; i < children.length; i += 1) {
    if (children[i] === first) start = i;
    if (children[i] === last) end = i + 1;
  }
  if (start < 0 || end <= start) return false;
  const range = document.createRange();
  if (typeof range.setStart !== "function" || typeof range.setEnd !== "function") return false;
  range.setStart(parent, start);
  range.setEnd(parent, end);
  if (typeof sel.removeAllRanges === "function") sel.removeAllRanges();
  if (typeof sel.addRange !== "function") return false;
  sel.addRange(range);
  return true;
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

function renderCommentMarker(part) {
  if (!part || part.commentMarker == null || (part.markerEdge !== "start" && part.markerEdge !== "end")) return null;
  if (typeof part.text !== "string") return null;
  const match = /^\{(\/?)([A-Za-z][A-Za-z0-9_-]*)\}$/.exec(part.text);
  if (!match || match[2] !== part.commentMarker) return null;
  if ((match[1] === "/") !== (part.markerEdge === "end")) return null;
  const el = document.createElement("span");
  el.className = "md-comment-marker";
  el.contentEditable = "false";
  el.setAttribute("aria-hidden", "true");
  el.dataset.start = String(part.start);
  el.dataset.end = String(part.end);
  el.dataset.comment = part.commentMarker;
  el.dataset.edge = part.markerEdge;
  return el;
}

function renderRun(part, tag) {
  const marker = renderCommentMarker(part);
  if (marker) return marker;
  const el = part.href ? document.createElement("a") : document.createElement(tag || "span");
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

// https stays an address. A data URL is not a file, so it is not requested.
function imageSrc(url, repo) {
  if (typeof url !== "string" || url.length === 0) return "";
  if (url.startsWith("https://") || url.startsWith("http://")) return url;
  if (url.startsWith("data:")) return "";
  if (!repo) return url;
  const parts = url.split("/").filter((part) => part.length > 0).map((part) => encodeURIComponent(part));
  return `/raw/${encodeURIComponent(repo)}/${parts.join("/")}`;
}

function pinFrameElement() {
  const frame = document.createElement("span");
  frame.className = "md-pin-frame";
  return frame;
}

function directChildTag(parent, tag) {
  const want = tag.toUpperCase();
  for (const child of childArray(parent)) {
    if (child && child.nodeType === 1 && String(child.tagName || "").toUpperCase() === want) return child;
  }
  return null;
}

function pictureFrame(host) {
  if (!host) return null;
  return findClassChild(host, "md-pin-frame");
}

// The drawn picture, not the line box or the diagram's padding.
function drawnPicture(host) {
  const frame = pictureFrame(host);
  if (!frame) return null;
  if (hasClass(host, "md-diagram")) return directChildTag(frame, "svg");
  if (hasClass(host, "md-image")) return directChildTag(frame, "img");
  return null;
}

function frameUnderPointer(node) {
  if (!node || node.nodeType !== 1 || typeof node.closest !== "function") return null;
  if (node.closest(".md-raw")) return null;
  const corner = node.closest(".md-pin-corner");
  if (corner && hasClass(corner.parentElement, "md-pin-frame")) return corner.parentElement;
  const frame = node.closest(".md-pin-frame");
  if (!frame) return null;
  const host = frame.parentElement;
  if (!host || hasClass(host, "md-raw")) return null;
  if (hasClass(host, "md-image")) {
    const img = directChildTag(frame, "img");
    if (img && (node === img || node.closest("img") === img)) return frame;
    return null;
  }
  if (hasClass(host, "md-diagram")) {
    const svg = directChildTag(frame, "svg");
    if (svg && (node === svg || node.closest("svg") === svg)) return frame;
    return null;
  }
  return null;
}

function renderImage(image, repo, onSized) {
  const el = document.createElement("span");
  el.className = image.comment ? "md-atom md-image md-comment" : "md-atom md-image";
  el.contentEditable = "false";
  el.dataset.start = String(image.start);
  el.dataset.end = String(image.end);
  if (image.comment) el.dataset.comment = image.comment;
  const frame = pinFrameElement();
  const img = document.createElement("img");
  img.alt = image.alt;
  img.draggable = false;
  // A pin fraction is of the picture's box. That box has no height until load,
  // so the cards from the first layout sit on the frame's top.
  if (typeof onSized === "function" && typeof img.addEventListener === "function") {
    img.addEventListener("load", () => onSized());
  }
  img.src = imageSrc(image.url, repo);
  if (typeof onSized === "function" && img.complete === true && img.naturalWidth > 0) onSized();
  frame.appendChild(img);
  el.appendChild(frame);
  return el;
}

// A picture atom has no text, so the line start and the newline after it have
// no glyph a caret or a hit test can use. The start mark is that one offset.
// The newline is a break: a glyph of the same length would be the boundary of
// the blank line after the picture. The extra character keeps the lengths apart.
function imageCaret(offset, edge) {
  const el = document.createElement("span");
  el.className = edge === "end" ? "md-image-caret md-break" : "md-image-caret";
  el.dataset.start = String(offset);
  el.dataset.end = String(offset + 1);
  el.dataset.edge = edge;
  if (typeof el.setAttribute === "function") el.setAttribute("aria-hidden", "true");
  setStyle(el, "color", "transparent");
  // The mark is only a caret slot. A hit belongs to the picture underneath it.
  setStyle(el, "pointer-events", "none");
  el.appendChild(document.createTextNode(edge === "end" ? "\u00b7\u200b" : "\u00b7"));
  return el;
}

function adornImageLine(el, block, doc) {
  if (!el || !block || block.type !== "line" || block.raw || block.empty || block.hr) return;
  if (typeof doc !== "string") return;
  const image = findClassChild(el, "md-image");
  if (!image) return;
  const kids = childArray(el);
  if (kids.length !== 1 || kids[0] !== image) return;
  const start = Number(image.dataset.start);
  const end = Number(image.dataset.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start !== block.start || end !== block.end) return;
  if (!imageLine(doc.slice(start, end))) return;
  placeNodeBefore(el, imageCaret(start, "start"), image);
  if (end < doc.length && doc[end] === "\n") insertAfter(el, image, imageCaret(end, "end"));
}

function caretText(el) {
  for (const child of childArray(el)) if (child && child.nodeType === 3) return child;
  return null;
}

// Select through the newline mark so the mapped end is past the picture, not
// the atom's own dataset.end. A test range that cannot name both marks stays
// on the picture.
function placeImageSelection(range, image) {
  if (!range || typeof range.setStart !== "function" || typeof range.setEnd !== "function") return false;
  const kids = childArray(image && image.parentElement);
  const at = kids.indexOf(image);
  if (at < 0) return false;
  const lead = at > 0 && hasClass(kids[at - 1], "md-image-caret") ? caretText(kids[at - 1]) : null;
  const tail = at + 1 < kids.length && hasClass(kids[at + 1], "md-image-caret") ? caretText(kids[at + 1]) : null;
  if (!lead || !tail) return false;
  const len = typeof tail.length === "number" ? tail.length : String(tail.textContent || "").length;
  if (!(len > 0)) return false;
  range.setStart(lead, 0);
  range.setEnd(tail, len);
  return true;
}

function renderCell(tag, cell) {
  const el = document.createElement(tag);
  if (cell.parts) {
    for (const part of cell.parts) {
      const code = part.classes && part.classes.includes("md-code");
      el.append(renderRun(part, code ? "code" : undefined));
    }
  } else {
    el.textContent = cell.text;
  }
  el.dataset.start = String(cell.start);
  el.dataset.end = String(cell.end);
  return el;
}

function atomClassName(base, atom) {
  const names = base.slice();
  for (const name of (atom && atom.classes) || []) {
    if (name && !names.includes(name)) names.push(name);
  }
  return names.join(" ");
}

function renderTable(atom) {
  const el = document.createElement("div");
  el.className = atomClassName(["md-atom", "md-table"], atom);
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
    api.initialize({ startOnLoad: false, securityLevel: "strict", theme: "dark", flowchart: { htmlLabels: false }, suppressErrorRendering: true });
    mermaidReady = true;
  }
  return api;
}

function diagramMessage(err) {
  if (err && err.message) return String(err.message);
  return String(err);
}

function keptClass(el, className) {
  const found = [];
  const walk = (node) => {
    for (const child of childArray(node)) {
      if (!child || child.nodeType !== 1) continue;
      if (hasClass(child, className)) found.push(child);
      else walk(child);
    }
  };
  walk(el);
  return found;
}

function keptPins(el) {
  return keptClass(el, "md-comment-pin");
}

// useMaxWidth draws the svg at width 100% and caps it with max-width. The frame
// takes that cap, so a pin fraction is of the drawing and not the diagram block.
function fitDrawnSvg(frame, node) {
  if (!node || typeof node.getAttribute !== "function") return;
  const style = String(node.getAttribute("style") || "");
  const max = /(?:^|;)\s*max-width:\s*([0-9.]+)px/.exec(style);
  let width = max ? max[1] : "";
  if (!width) {
    const attr = String(node.getAttribute("width") || "");
    if (/^[0-9.]+(?:px)?$/.test(attr)) width = attr.replace(/px$/, "");
  }
  if (!width) return;
  setStyle(frame, "width", `${width}px`);
}

function showDiagramSource(el, source, err) {
  if (el.isConnected !== true) return;
  const pins = keptPins(el);
  const pre = document.createElement("pre");
  pre.textContent = source;
  el.replaceChildren(pre, document.createTextNode(diagramMessage(err)));
  for (const pin of pins) el.appendChild(pin);
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
  const pins = keptPins(el);
  const corners = keptClass(el, "md-pin-corner");
  const frame = pictureFrame(el) || pinFrameElement();
  frame.replaceChildren(node);
  fitDrawnSvg(frame, node);
  for (const pin of pins) frame.appendChild(pin);
  for (const corner of corners) frame.appendChild(corner);
  if (frame.parentElement !== el) el.replaceChildren(frame);
}

function renderDiagram(atom, onFitted) {
  const el = document.createElement("div");
  el.className = atomClassName(["md-atom", "md-diagram"], atom);
  el.contentEditable = "false";
  el.dataset.start = String(atom.start);
  el.dataset.end = String(atom.end);
  el.dataset.bodyStart = String(atom.bodyStart);
  const frame = pinFrameElement();
  const pre = document.createElement("pre");
  pre.textContent = atom.body;
  frame.appendChild(pre);
  el.appendChild(frame);
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
      if (el.isConnected === true && typeof onFitted === "function") onFitted();
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

// The br keeps the line box. An empty text node does not survive here, and
// Firefox keeps the selection where modify left it when the target is a br,
// so one zero-width character in front of the br is the caret. The span covers
// that character: index 0 is this offset, and the following break still owns
// the newline. Up and down stop on this line start. The break after it is
// pulled onto this line; in flow its br would be the next one.
function renderCaretSlot(offset) {
  const el = document.createElement("span");
  el.dataset.start = String(offset);
  el.dataset.end = String(offset + 1);
  el.appendChild(document.createTextNode("\u200b"));
  el.appendChild(document.createElement("br"));
  return el;
}

function markerOnly(block) {
  if (block.slot == null) return false;
  const parts = block.parts || [];
  return parts.length > 0 && parts.every((part) => part.type === "break" || (part.type === "run" && part.text === ""));
}

// The slot br already is the line. Pull the break's br up by one line box so
// both carets share it. 1lh is that box, whatever the paragraph line-height is.
// The block then starts at the line's left edge; the hidden tab or spaces still
// own the column a letter typed at the newline is drawn on.
function pullBreakOntoSlot(node) {
  setStyle(node, "display", "block");
  setStyle(node, "margin-top", "-1lh");
}

function appendParts(el, block, repo, onSized) {
  const share = markerOnly(block);
  if (block.slot != null) el.appendChild(renderCaretSlot(block.slot));
  for (const part of block.parts) {
    const node = part.type === "image" ? renderImage(part, repo, onSized) : renderRun(part);
    if (share && part.type === "break") pullBreakOntoSlot(node);
    el.appendChild(node);
  }
}

function rawListMarker(block) {
  if (!block || !block.raw || block.empty) return "";
  const classes = block.classes || [];
  if (classes.includes("md-quote")) return "";
  if (!classes.includes("md-li") && !classes.includes("md-ol")) return "";
  // The indent characters stay in the raw text. Hanging them with the marker
  // puts the item text on the closed line's column; the margin already holds that indent.
  const match = /^[ \t]*(?:[-+*](?:[ ]{1,4}|\t)|\d{1,9}[.)](?:[ ]{1,4}|\t))/.exec(block.text || "");
  return match ? match[0] : "";
}

function setNodeText(node, value) {
  node.textContent = value;
  const desc = Object.getOwnPropertyDescriptor(node, "length");
  if (desc && desc.writable) node.length = value.length;
}

// A text node's length is live in the browser and a plain field in tests.
function splitMarkerRun(el, count) {
  const textNode = childArray(el)[0];
  const text = String(textNode.textContent || "");
  const head = document.createElement(String(el.localName || "span").toLowerCase());
  head.className = el.className || "";
  if (el.dataset && el.dataset.comment) head.dataset.comment = el.dataset.comment;
  if (typeof el.href === "string" && el.href !== "") {
    head.href = el.href;
    if (el.rel) head.rel = el.rel;
    head.draggable = false;
  }
  const start = el.dataset && el.dataset.start != null && el.dataset.start !== "" ? Number(el.dataset.start) : NaN;
  if (Number.isFinite(start)) {
    head.dataset.start = String(start);
    head.dataset.end = String(start + count);
    el.dataset.start = String(start + count);
  }
  head.appendChild(document.createTextNode(text.slice(0, count)));
  setNodeText(textNode, text.slice(count));
  return head;
}

// The marker is its own inline box so the slack after it can be a sibling.
// The line's text-indent moves that box, and Chromium's caret, into the gutter.
function takeRawMarker(el, marker) {
  const plan = [];
  let left = marker;
  for (const child of childArray(el)) {
    if (left === "") break;
    if (!child || child.nodeType !== 1) return null;
    const text = String(child.textContent || "");
    if (text.length === 0) return null;
    if (text.length <= left.length) {
      if (!left.startsWith(text)) return null;
      plan.push({ node: child, take: text.length });
      left = left.slice(text.length);
      continue;
    }
    if (!text.startsWith(left)) return null;
    const inner = childArray(child);
    if (inner.length !== 1 || !inner[0] || inner[0].nodeType !== 3 || inner[0].textContent !== text) return null;
    plan.push({ node: child, take: left.length });
    left = "";
  }
  if (left !== "") return null;
  const hang = document.createElement("span");
  hang.className = "md-raw-hang";
  for (const step of plan) {
    if (step.take === String(step.node.textContent || "").length) {
      detachNode(step.node);
      hang.appendChild(step.node);
    } else hang.appendChild(splitMarkerRun(step.node, step.take));
  }
  placeNodeBefore(el, hang, childArray(el)[0]);
  return hang;
}

function renderBlock(block, repo, onSized, onDiagramFitted) {
  if (block.type === "table") return renderTable(block);
  if (block.type === "diagram") return renderDiagram(block, onDiagramFitted);
  if (block.collapsed) return renderCollapsed(block);
  const el = document.createElement("div");
  el.className = ["md-line", ...block.classes].join(" ");
  if (block.fence) {
    el.dataset.fenceStart = String(block.start);
    if (!block.raw) el.dataset.bodyLines = String(block.bodyLines || 0);
  }
  if (typeof block.indent === "number") el.style.setProperty("--indent", String(block.indent));
  if (block.marker) el.dataset.marker = block.marker;
  if (block.raw || block.empty || block.hr) {
    el.dataset.start = String(block.start);
    el.dataset.end = String(block.end);
  }
  // The slot is the line's only caret. Tagging the line with it lets a click
  // and the empty-line boundary find the start, while the break still maps the newline.
  if (block.slot != null) {
    el.dataset.start = String(block.slot);
    el.dataset.end = String(block.slot);
  }
  if (block.raw) {
    if (block.empty) el.appendChild(document.createElement("br"));
    else appendParts(el, block, repo, onSized);
    return el;
  }
  if (block.empty || block.hr) {
    if (block.empty) el.appendChild(document.createElement("br"));
    return el;
  }
  appendParts(el, block, repo, onSized);
  if (!el.childNodes || el.childNodes.length === 0) {
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

function wordChar(ch) {
  return /[A-Za-z0-9_]/.test(ch);
}

// Spaces, then one run. A run is word characters or other non-space characters.
function wordEdges(doc, cursor, direction) {
  const space = (ch) => /\s/.test(ch);
  if (direction < 0) {
    let index = cursor;
    while (index > 0 && space(doc[index - 1])) index -= 1;
    if (index > 0) {
      const word = wordChar(doc[index - 1]);
      while (index > 0 && !space(doc[index - 1]) && wordChar(doc[index - 1]) === word) index -= 1;
    }
    return [index, cursor];
  }
  let index = cursor;
  while (index < doc.length && space(doc[index])) index += 1;
  if (index < doc.length) {
    const word = wordChar(doc[index]);
    while (index < doc.length && !space(doc[index]) && wordChar(doc[index]) === word) index += 1;
  }
  return [cursor, index];
}

// Trim marker characters the segmenter attaches to either end of a word.
const WORD_MARK = new Set(["*", "_", "~", "`"]);

// The word-like segment touching this boundary, on this line. A run of spaces
// has none, so the caret stays where the press landed.
export function wordSpan(doc, offset) {
  const text = typeof doc === "string" ? doc : "";
  const at = Math.max(0, Math.min(text.length, Number.isFinite(offset) ? offset : 0));
  let lineStart = at;
  while (lineStart > 0 && text[lineStart - 1] !== "\n") lineStart -= 1;
  let lineEnd = at;
  while (lineEnd < text.length && text[lineEnd] !== "\n") lineEnd += 1;
  const line = text.slice(lineStart, lineEnd);
  const local = at - lineStart;
  const segments = [...new Intl.Segmenter(undefined, { granularity: "word" }).segment(line)];
  const covering = (index) => segments.find((part) => index >= part.index && index < part.index + part.segment.length);
  let part = null;
  if (local > 0) {
    const left = covering(local - 1);
    if (left && left.isWordLike) part = left;
  }
  if (!part && local < line.length) {
    const right = covering(local);
    if (right && right.isWordLike) part = right;
  }
  if (!part) return [at, at];
  let start = part.index;
  let end = part.index + part.segment.length;
  // Chromium splits a host label at each dot. Node keeps `x.test` as one word.
  const wordAt = (index) => segments.find((item) => item.isWordLike && index >= item.index && index < item.index + item.segment.length);
  while (start > 0 && line[start - 1] === ".") {
    const prev = wordAt(start - 2);
    if (!prev || prev.index + prev.segment.length !== start - 1) break;
    start = prev.index;
  }
  while (end < line.length && line[end] === ".") {
    const next = wordAt(end + 1);
    if (!next || next.index !== end + 1) break;
    end = next.index + next.segment.length;
  }
  while (start < end && WORD_MARK.has(line[start])) start += 1;
  while (end > start && WORD_MARK.has(line[end - 1])) end -= 1;
  if (start >= end) return [at, at];
  return [lineStart + start, lineStart + end];
}

// The source line, not the visual wrap. The newline stays outside the range,
// so an empty line is a caret at its start.
function lineSpan(doc, offset) {
  const at = Math.max(0, Math.min(doc.length, offset));
  let start = at;
  let end = at;
  while (start > 0 && doc[start - 1] !== "\n") start -= 1;
  while (end < doc.length && doc[end] !== "\n") end += 1;
  return [start, end];
}

// A click takes the whole image line, including the newline after it. The caret
// then sits past that line, so the picture stays drawn and Backspace removes the line.
function wholeImageLine(doc, offset) {
  if (typeof doc !== "string") return null;
  const [start, end] = lineSpan(doc, offset);
  if (!imageLine(doc.slice(start, end))) return null;
  const cursor = end < doc.length && doc[end] === "\n" ? end + 1 : end;
  return { anchor: start, cursor };
}

function fileListOf(data) {
  const files = data && data.files;
  if (!files || typeof files.length !== "number" || files.length === 0) return [];
  const list = [];
  for (let i = 0; i < files.length; i += 1) {
    if (files[i]) list.push(files[i]);
  }
  return list;
}

function isImageFile(file) {
  const type = String(file && file.type ? file.type : "").toLowerCase();
  if (type === "image/png" || type === "image/jpeg" || type === "image/gif" || type === "image/webp") return true;
  const name = String(file && file.name ? file.name : "").toLowerCase();
  return /\.(png|jpe?g|gif|webp)$/.test(name);
}

function bytesFromBase64(value) {
  const clean = String(value).replace(/\s/g, "");
  if (clean.length === 0 || /[^A-Za-z0-9+/=]/.test(clean)) return null;
  if (typeof Buffer !== "undefined") {
    const buf = Buffer.from(clean, "base64");
    if (buf.length === 0) return null;
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  try {
    const binary = atob(clean);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out.length === 0 ? null : out;
  } catch {
    return null;
  }
}

// One decodable data URL becomes the picture bytes. Any other data:image paste is refused.
function decodeDataImage(text) {
  const raw = String(text).trim();
  const match = /^data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(raw);
  if (match) {
    const bytes = bytesFromBase64(match[2]);
    if (!bytes || bytes.byteLength === 0) return false;
    return bytes;
  }
  if (String(text).includes("data:image/")) return false;
  return null;
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

// Source characters of the marker drawn at the start of this line, or hidden there.
function markerLength(line) {
  if (line === "---" || line === "***" || line === "___") return 0;
  const heading = /^(#{1,6}) /.exec(line);
  if (heading) return heading[1].length + 1;
  if (line.startsWith("> ")) {
    const nested = listMarkerLength(line.slice(2));
    return nested > 0 ? 2 + nested : 2;
  }
  return listMarkerLength(line);
}

function plainListItem(line) {
  if (line.startsWith("> ")) return false;
  return listMarkerLength(line) > 0;
}

// Fence body is code. A line there that looks like an item is not one.
function offsetInFence(doc, offset) {
  let open = false;
  let start = 0;
  for (let i = 0; i <= doc.length; i += 1) {
    if (i !== doc.length && doc[i] !== "\n") continue;
    const line = doc.slice(start, i);
    if (line.startsWith("```")) open = !open;
    else if (open && offset >= start && offset <= i) return true;
    start = i + 1;
    if (i === doc.length) break;
  }
  return false;
}

// A heading, a rule, a fence, and a table cannot hold the Shift+Enter break.
function hardBreakHost(text) {
  if (text === "" || imageLine(text)) return false;
  if (text.startsWith("|") || text.startsWith("```")) return false;
  if (text === "---" || text === "***" || text === "___") return false;
  if (/^#{1,6} /.test(text)) return false;
  return true;
}

// An even run is escaped. Shift+Enter writes one backslash.
function unescapedTrailingSlash(text) {
  let count = 0;
  for (let i = text.length - 1; i >= 0 && text[i] === "\\"; i -= 1) count += 1;
  return count % 2 === 1;
}

// The line Shift+Enter opened. A quote keeps its "> " marker and nothing else.
function breakLineEmpty(text) {
  let rest = text;
  if (rest.endsWith("\r")) rest = rest.slice(0, -1);
  while (rest.startsWith("> ")) rest = rest.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] !== " " && rest[i] !== "\t") return false;
  }
  return true;
}

function sameSourceLine(doc, a, b) {
  if (typeof doc !== "string" || !Number.isFinite(a) || !Number.isFinite(b)) return false;
  const left = Math.max(0, Math.min(doc.length, Math.trunc(a)));
  const right = Math.max(0, Math.min(doc.length, Math.trunc(b)));
  return sourceLine(doc, left).start === sourceLine(doc, right).start;
}

// CommonMark shows a trailing backslash when no text of the block follows.
// The splice puts the previous line's break back and drops the empty line.
function emptyBreakCut(doc, caret) {
  if (typeof doc !== "string" || !Number.isFinite(caret)) return null;
  const at = Math.max(0, Math.min(doc.length, Math.trunc(caret)));
  const line = sourceLine(doc, at);
  if (!breakLineEmpty(line.text) || line.start === 0 || doc[line.start - 1] !== "\n") return null;
  const prev = sourceLine(doc, line.start - 1);
  if (!prev.newline || !hardBreakHost(prev.text) || !unescapedTrailingSlash(prev.text)) return null;
  if (offsetInFence(doc, prev.start) || offsetInFence(doc, line.start)) return null;
  const slash = prev.start + prev.text.length - 1;
  if (doc[slash] !== "\\") return null;
  if (line.start === doc.length) return { from: slash, to: slash + 1, inserted: "" };
  if (!line.newline) return null;
  const inserted = doc.slice(slash + 1, prev.end + 1);
  const to = line.end + 1;
  if (to <= prev.end + 1) return null;
  return { from: slash, to, inserted };
}

function mapBreakCaret(pos, cut) {
  const at = Number.isFinite(pos) ? Math.trunc(pos) : cut.from;
  if (at <= cut.from) return at;
  if (at >= cut.to) return at - (cut.to - cut.from) + cut.inserted.length;
  return cut.from;
}

function sourceLines(doc) {
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

function selectedSourceLines(doc, anchor, cursor) {
  const from = Math.min(anchor, cursor);
  const to = Math.max(anchor, cursor);
  if (from === to) {
    const [start, end] = lineSpan(doc, from);
    return [{ start, end, text: doc.slice(start, end) }];
  }
  return sourceLines(doc).filter((line) => line.start < to && line.end > from);
}

function leadingTabCount(text) {
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

function listEdit(doc, lines, insert, shift, anchor, cursor) {
  const spliceFrom = lines[0].start;
  const spliceTo = lines[lines.length - 1].end;
  return {
    insert,
    spliceFrom,
    spliceTo,
    text: doc.slice(0, spliceFrom) + insert + doc.slice(spliceTo),
    anchor: shift(anchor),
    cursor: shift(cursor),
  };
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

// Next number at the indent the item is landing on. Nested items between
// this line and that sibling are not siblings, so they do not increment it.
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

// Shift+Tab. One leading tab, else up to four spaces. No indent means no edit.
// An ordered item takes the next number at the level it lands on. Only that line's number changes.
function listOutdent(doc, anchor, cursor) {
  const lines = selectedSourceLines(doc, anchor, cursor);
  if (lines.length === 0) return null;
  if (lines.some((line) => !plainListItem(line.text) || offsetInFence(doc, line.start))) return null;
  if (lines.every((line) => outdentWidth(line.text) === 0)) return null;
  const all = sourceLines(doc);
  const rewritten = new Map();
  const numberShifts = [];
  for (const line of lines) {
    const width = outdentWidth(line.text);
    if (width === 0) {
      rewritten.set(line.start, line.text);
      continue;
    }
    let body = line.text.slice(width);
    const mark = orderedMark(body);
    if (mark) {
      const next = nextOutdentNumber(all, line.start, mark.indent, rewritten);
      if (next !== mark.num) {
        numberShifts.push({ at: line.start + width + mark.numEnd, delta: next.length - mark.num.length });
        body = body.slice(0, mark.numStart) + next + body.slice(mark.numEnd);
      }
    }
    rewritten.set(line.start, body);
  }
  let insert = "";
  let prev = lines[0].start;
  for (const line of lines) {
    insert += doc.slice(prev, line.start) + rewritten.get(line.start);
    prev = line.end;
  }
  insert += doc.slice(prev, lines[lines.length - 1].end);
  const shift = (offset) => {
    let next = offset;
    for (const line of lines) {
      const width = outdentWidth(line.text);
      if (width === 0 || offset <= line.start) continue;
      next -= Math.min(width, offset - line.start);
    }
    for (const change of numberShifts) if (offset >= change.at) next += change.delta;
    return next;
  };
  return listEdit(doc, lines, insert, shift, anchor, cursor);
}

function quotedListSelection(doc, anchor, cursor) {
  const lines = selectedSourceLines(doc, anchor, cursor);
  if (lines.length === 0) return false;
  return lines.every((line) => {
    if (offsetInFence(doc, line.start)) return false;
    if (!line.text.startsWith("> ")) return false;
    return listMarkerLength(line.text.slice(2)) > 0;
  });
}

// One tab at the start of each selected item. An ordered item that opens a
// deeper level starts at 1. The caret stays on the same item character.
function listIndent(doc, anchor, cursor) {
  const lines = selectedSourceLines(doc, anchor, cursor);
  if (lines.length === 0) return null;
  if (lines.some((line) => !plainListItem(line.text) || offsetInFence(doc, line.start))) return null;
  const all = sourceLines(doc);
  let insert = "";
  let prev = lines[0].start;
  const shrinks = [];
  for (const line of lines) {
    insert += doc.slice(prev, line.start);
    let body = "\t" + line.text;
    const previous = all.filter((item) => item.end < line.start).pop();
    let prevTabs = 0;
    if (previous) {
      prevTabs = leadingTabCount(previous.text);
      if (lines.some((item) => item.start === previous.start)) prevTabs += 1;
    }
    if (leadingTabCount(body) > prevTabs) {
      let index = 0;
      while (index < line.text.length && (line.text[index] === " " || line.text[index] === "\t")) index += 1;
      const ordered = /^(\d{1,9})([.)])/.exec(line.text.slice(index));
      if (ordered && ordered[1] !== "1") {
        shrinks.push({ at: line.start + index + ordered[1].length, delta: 1 - ordered[1].length });
        body = "\t" + line.text.slice(0, index) + "1" + ordered[2] + line.text.slice(index + ordered[0].length);
      }
    }
    insert += body;
    prev = line.end;
  }
  insert += doc.slice(prev, lines[lines.length - 1].end);
  const shift = (offset) => {
    let next = offset;
    for (const line of lines) if (line.start <= offset) next += 1;
    for (const shrink of shrinks) if (offset >= shrink.at) next += shrink.delta;
    return next;
  };
  return listEdit(doc, lines, insert, shift, anchor, cursor);
}

function setStyle(el, name, value) {
  if (!el || !el.style) return;
  if (typeof el.style.setProperty === "function") el.style.setProperty(name, value);
  else el.style[name] = value;
}

function cssPx(value) {
  const n = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function fileTreeOf(block) {
  if (!block) return null;
  const direct = findClassChild(block, "file-tree");
  if (direct) return direct;
  return findClassChild(findClassChild(block, "md-file-drawer"), "file-tree");
}

function fileTreeButtons(block) {
  const tree = fileTreeOf(block);
  const buttons = [];
  const walk = (node) => {
    for (const child of childArray(node)) {
      if (!child || child.nodeType !== 1) continue;
      if (String(child.tagName || "").toUpperCase() === "BUTTON") buttons.push(child);
      walk(child);
    }
  };
  if (tree) walk(tree);
  return buttons;
}

function inlineStyle(el, name) {
  if (!el || !el.style) return { had: false, value: "" };
  if (typeof el.style.getPropertyValue === "function") {
    const value = el.style.getPropertyValue(name) || "";
    return { had: value !== "", value };
  }
  if (el.styleProps && Object.prototype.hasOwnProperty.call(el.styleProps, name)) {
    return { had: true, value: el.styleProps[name] };
  }
  return { had: false, value: "" };
}

function restoreInline(el, name, saved) {
  if (!el || !el.style) return;
  if (saved.had) {
    setStyle(el, name, saved.value);
    return;
  }
  if (typeof el.style.removeProperty === "function") el.style.removeProperty(name);
  if (el.styleProps) delete el.styleProps[name];
}

// A stretched row reports its box. Max-content is the title, which is what sizes the pane.
function contentScrollWidth(button) {
  const read = () => {
    const value = button && button.scrollWidth;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  };
  if (!button || !button.style || typeof button.style.setProperty !== "function") return read();
  const names = ["width", "flex", "min-width"];
  const saved = names.map((name) => [name, inlineStyle(button, name)]);
  try {
    setStyle(button, "width", "max-content");
    setStyle(button, "flex", "0 0 auto");
    setStyle(button, "min-width", "max-content");
    return read();
  } finally {
    for (const [name, previous] of saved) restoreInline(button, name, previous);
  }
}

// A nested row's offset sits outside the button's scrollWidth.
function buttonIndent(button, tree) {
  if (!button || !tree || typeof button.getBoundingClientRect !== "function" || typeof tree.getBoundingClientRect !== "function") return 0;
  let buttonRect = null;
  let treeRect = null;
  try {
    buttonRect = button.getBoundingClientRect();
    treeRect = tree.getBoundingClientRect();
  } catch {
    return 0;
  }
  if (!buttonRect || !treeRect) return 0;
  const delta = buttonRect.left - treeRect.left;
  return typeof delta === "number" && Number.isFinite(delta) && delta > 0 ? delta : 0;
}

// The title's scrollWidth is the button. A zero or missing one cannot size the pane.
function widestFileButton(block) {
  const tree = fileTreeOf(block);
  let best = 0;
  for (const button of fileTreeButtons(block)) {
    const extra = buttonIndent(button, tree);
    const scroll = contentScrollWidth(button);
    if (!(scroll > 0)) continue;
    const width = scroll + extra;
    if (width > best) best = width;
  }
  return best;
}

function readComputedStyle(el) {
  const view = globalThis.window;
  const read = view && typeof view.getComputedStyle === "function"
    ? view.getComputedStyle.bind(view)
    : (typeof globalThis.getComputedStyle === "function" ? globalThis.getComputedStyle : null);
  if (!read || !el) return null;
  try {
    return read(el) || null;
  } catch {
    return null;
  }
}

// Border-box width eats the pane padding, which would clip the title we just measured.
function horizontalPadding(el) {
  const style = readComputedStyle(el);
  if (!style) return 0;
  return cssPx(style.paddingLeft) + cssPx(style.paddingRight);
}

// The sized pane's border sits outside the button's scrollWidth.
function horizontalBorder(el) {
  const style = readComputedStyle(el);
  if (!style) return 0;
  return cssPx(style.borderLeft) + cssPx(style.borderRight);
}

function capPaneWidth(width) {
  const inner = globalThis.window ? globalThis.window.innerWidth : undefined;
  if (typeof inner !== "number" || !Number.isFinite(inner) || inner <= 0) return width;
  const cap = inner * 0.8;
  return width > cap ? cap : width;
}

// A short title must not pull the open drawer under the closed column.
function filePaneWidth(block, rect) {
  const compact = rect && typeof rect.width === "number" && Number.isFinite(rect.width) ? rect.width : 0;
  const scroll = widestFileButton(block);
  if (!(scroll > 0)) return compact;
  const fitted = capPaneWidth(scroll + horizontalPadding(block) + horizontalBorder(block));
  return fitted > compact ? fitted : compact;
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

function metaBuild(node) {
  if (!node || node.nodeType !== 1) return null;
  if (String(node.tagName || "").toUpperCase() === "META") {
    const name = typeof node.getAttribute === "function" ? node.getAttribute("name") : "";
    if (name === "viewmark-build") {
      const content = node.getAttribute("content");
      return typeof content === "string" ? content : "";
    }
  }
  for (const child of node.childNodes || []) {
    const found = metaBuild(child);
    if (found != null) return found;
  }
  return null;
}

const VIM_KEY = "viewmark.vim";

function vimField(value) {
  return typeof value === "string" ? value : "";
}

function emptyVimInput() {
  return { prefixRepeat: "", operator: null, motionRepeat: "", keyBuffer: "" };
}

// Normal, Visual, and Visual Line share the block. Insert keeps the thin caret.
export function vimDrawsBlockCaret(mode) {
  return mode === "normal" || mode === "visual" || mode === "visual-line";
}

// Idle is the mode letter. Anything pending is the prefix, the operator, the
// motion count, and the key buffer, in that order. The operator is its own
// field, so it stays after its key has left the buffer.
export function vimStatusText(mode, input) {
  const record = input && typeof input === "object" ? input : {};
  const prefix = vimField(record.prefixRepeat);
  const operator = vimField(record.operator);
  const motion = vimField(record.motionRepeat);
  let buffer = vimField(record.keyBuffer);
  const head = prefix + operator + motion;
  if (head && buffer.startsWith(head)) buffer = buffer.slice(head.length);
  const pending = head + buffer;
  if (pending) return pending;
  if (mode === "insert") return "I";
  if (mode === "visual") return "V";
  if (mode === "visual-line") return "VL";
  return "N";
}

function readPageBuild() {
  const doc = globalThis.document;
  if (!doc) return "";
  if (typeof doc.querySelector === "function") {
    const meta = doc.querySelector('meta[name="viewmark-build"]');
    if (!meta) return "";
    const content = typeof meta.getAttribute === "function" ? meta.getAttribute("content") : meta.content;
    return typeof content === "string" ? content : "";
  }
  const found = metaBuild(doc.head) ?? metaBuild(doc.documentElement) ?? metaBuild(doc.body);
  return found == null ? "" : found;
}

export function createEditor(root, doc, cursor = 0, transport, storage = null) {
  const external = arguments.length >= 4 && transport != null;
  const active = external ? transport : createMemoryTransport(doc, cursor);
  // Read once. An empty meta adopts the first hello; later hellos compare to that.
  let seenBuild = readPageBuild();
  let state = createState(doc, cursor);
  let rev = 0;
  // A supplied document is already the mirror. The page starts empty and waits for file.
  let live = !external || active.memory === true || (typeof doc === "string" && doc.length > 0);
  let granted = { anchor: state.anchor, cursor: state.cursor };
  // claimLines re-enters while the empty-break splice is still in send.
  let droppingBreak = false;
  // The text that splice was cut from. mouseup and click both leave before a
  // socket applies it, and the second cut still has the pre-drop offsets.
  let droppedBreakDoc = null;
  // A Shift+Enter that wrote only a backslash left the next line where it was.
  // A CRLF blank is that line. Removing it would join the blocks.
  let bareBreakAt = null;
  let outstandingLock = null;
  let lockRejected = false;
  let waitingForFile = false;
  let openPath = "";
  let fileList = [];
  let fileTitles = null;
  let draggedMove = null;
  let treeDrop = null;
  const openDirs = new Set();
  let ticketList = [];
  let inboundList = [];
  // Tickets in every other registered repo: title, links, and the file rev.
  let foreignList = [];
  // repo:id the last tickets message said exist. Null until that list arrives.
  let linkPresent = null;
  let openTicket = null;
  let relationTicketId = "";
  let relationShown = { parent: false, depends: false, children: false, blocks: false };
  let relationHad = { parent: false, depends: false, children: false, blocks: false };
  let ticketMenuOpen = false;
  const expandedTickets = new Set();
  let ticketForm = null;
  let ticketFocusBound = false;
  let ticketFormKey = "";
  let rebuildingTicketForm = false;
  // Server value last written into a field. A focused field whose text differs is unsaved.
  const paintedField = new WeakMap();
  const linkFill = new WeakMap();
  const ticketPickers = [];
  let ticketPointerBound = false;
  let ticketChrome = null;
  let ticketBlockEl = null;
  let ticketDrawerEnter = null;
  let ticketDrawerLeave = null;
  let ticketDrawerTimer = null;
  // "" while resting or wide, "wait" during the 200ms grace, "narrow" while the width eases home.
  let ticketDrawerPhase = "";
  let ticketDrawerCompact = "";
  let fileBlockEl = null;
  let fileDrawerEnter = null;
  let fileDrawerLeave = null;
  let fileDrawerTimer = null;
  let fileDrawerCompact = "";
  let fileDrawerWide = "";
  let ticketSort = null;
  const wiredSortButtons = new WeakSet();
  let activeRepo = "";
  let repoSelect = null;
  let repoOnChange = null;
  let docMenuButton = null;
  let docMenuPanel = null;
  let docMenuDelete = null;
  let docMenuVim = null;
  let docLinkButton = null;
  let docAttachInput = null;
  let docLinkOnClick = null;
  let docAttachOnChange = null;
  let docMenuBound = false;
  let repoNames = new Set();
  let sawRepos = false;
  let suppressHash = null;
  let appliedHash = null;
  let pendingHash = null;
  let hashComment = null;
  let pinnedComment = null;
  let scrollCommentId = null;
  let writingHash = false;
  let closed = false;
  let pictureLayoutFrame = 0;
  let pictureObserver = null;
  const repoStorage = storage || null;
  // Raw is not stored. It applies only to the document that was open when it was turned on.
  let sourceMode = false;
  let rawPath = "";
  let viewToggle = null;
  let pathStrip = null;
  let pathStripLine = null;
  let fileMenu = null;
  let fileMenuPath = "";
  let fileMenuPathEl = null;
  let vimStatus = null;
  let vimLine = null;
  let vimPrompt = null;
  let vimBlockMark = null;
  let vimBlockCaretHidden = false;
  let vimBlockSyncing = false;
  let vimMode = "normal";
  let vimInput = emptyVimInput();
  let vimRegister = { text: "", linewise: false };
  // The register from before a vim splice that has been sent and not answered.
  // A 409 on that edit puts it back. The doc that accepts the edit drops it.
  let vimEditRegister = null;
  // The register from before the vim command now inside applyVimEffect.
  let vimSplicePrior = null;
  let vimSearch = null;
  // Patterns typed at / and ?. This editor is the page session: not the document, not the hub.
  let vimSearchPast = [];
  let vimRecall = null;
  let vimRecallLock = false;
  let vimPaintHold = null;
  let vimMatchRoot = null;
  let vimFind = null;
  let vimColumn = null;
  let vimOnce = false;
  // The flag is this page's memory. Storage is read once here and written on toggle.
  let vimOn = readVimOn();
  // A screen page is the rows already drawn. Pulling the caret into view would
  // add the next row to that count.
  let vimKeepScroll = false;
  // Create is answered by its own error or by the file from onOpen.
  // A 409 for that create is not a rejected caret grant.
  const conflictWaiters = [];
  const fileWaiters = [];
  // The hub rejects an edit that repeats the mirror rev. Remember the op and
  // send it after this actor's doc advances rev and the caret. A noop keeps
  // the rev, so the next op goes at once. Silence, or a dropped socket, reopens;
  // the file brings the caret and only then does the queue move.
  const pendingEdits = [];
  // This page's typing run. The hub still publishes each key; only undo groups.
  let typingRun = null;
  // The caret after spaces just typed. Their hard-break tail stays drawn until
  // the caret leaves, so the next paint has a glyph to put it on.
  let typedTail = null;
  // Insert, from the command that entered it until Escape, is one undo,
  // including a pause, Backspace, and Enter. An arrow ends that step.
  // The first splice of a step opens the entry.
  let vimInsertOpen = false;
  // A vim splice records anchor and cursor as the range, so undo restores a selection.
  // These stacks put back the caret from before that command, collapsed.
  const vimUndoCarets = [];
  const vimRedoCarets = [];
  let vimUndoArmed = false;
  let vimUndoMark = null;
  let vimGroupCont = false;
  let vimHistoryPending = null;
  let vimPlace = null;
  let vimForceClaim = false;
  let editTimer = null;
  let refusalTimer = null;
  // The refused edit stays marked for one second. render builds new nodes, so the mark is applied there.
  let refusal = null;
  let resumeAfterFile = false;
  // True from the reconnect frame until its file. Keys in that gap stay queued.
  let reconnecting = false;
  // An unsent key opens the file again. This stops that open from looping.
  let reopening = false;
  // The edit handed to the socket and not yet answered. A drop can lose it
  // after send returns, so the next file says whether it has to be sent again.
  let inflightEdit = null;
  let lockTable = [];
  let expectNewComment = false;
  let unsubscribe = () => {};
  let sentLines = [];
  // Focus moved from the body to a ticket field. Snapshots must not lock those lines again.
  let bodyCaretReleased = false;
  const ac = new AbortController();
  const listen = (type, fn, options = {}) => {
    root.addEventListener(type, fn, { ...options, signal: ac.signal });
  };
  listen("scroll", () => {
    syncVimMatchPaint();
    syncVimBlockMark();
  });
  if (typeof window !== "undefined" && window && typeof window.addEventListener === "function") {
    window.addEventListener("scroll", () => {
      syncVimMatchPaint();
      syncVimBlockMark();
    }, { capture: true, signal: ac.signal });
  }
  const commentsAside = commentsAsideOf(root);
  let addCommentButton = null;
  let commentFocus = null;
  let currentCommentId = null;
  // Delete takes the card button. The caret is put back in the editor after the thread is gone.
  let restoreEditorFocus = false;
  let hoverCommentId = null;
  let handleDrag = null;
  let showResolved = false;
  const unsavedThreads = new Set();
  const replyDrafts = new Map();
  const noteDrafts = new Map();
  const editingNotes = new Set();
  // Chromium focuses the editing host during this assignment.
  const activeElement = typeof document !== "undefined" && document ? document.activeElement : null;
  root.contentEditable = "true";
  if (activeElement && activeElement !== root && typeof activeElement.focus === "function") activeElement.focus();
  root.spellcheck = false;
  root.autocapitalize = "off";
  root.setAttribute("autocorrect", "off");
  root.classList.add("editor");
  root.setAttribute("role", "textbox");
  root.setAttribute("aria-multiline", "true");

  let pointer = null;
  let didDrag = false;
  // Set once the Ctrl-click has asked for its tab, so click and auxclick do not each open one.
  let linkTabOpened = false;
  // The press is a bare Ctrl-click on a link. selectionchange must not take the caret into that link.
  let linkTabHold = false;
  // The caret from before that click. The browser names the link again after the tab opens.
  let linkTabCaret = null;
  let linkTabRestores = 0;
  // mouseup detail 1. A double-click's mouseup is not a drag release.
  let plainDrag = false;
  // The selection under the press, kept so a drop can move it after the caret has moved.
  let dragRange = null;
  let dragSource = null;
  let pinDrag = false;
  let pinMove = null;
  // A pin move repaints while the caret is still up the page. This is the scroll
  // from before that repaint, so scrollIntoView cannot jump the window to the caret.
  let pinScrollHold = null;
  let cornerFrame = null;
  // Client point of the last move, so a repaint can put the corner back without another move.
  let pointerAt = null;
  // The first press of a multi-click. Later presses reuse it after a render
  // would have moved the text under the pointer.
  let gestureOffset = null;
  let gestureArmed = false;
  let gestureTimer = null;
  // True from the click's state write through placeCaret. selectionchange in
  // that window still describes the DOM replaceChildren just tore down.
  let gestureHold = false;
  // Chromium moves the selection back a frame after a click replaces the lines.
  // generation lets the 200 ms window follow a caret a later edit has moved.
  let retainedCaret = null;
  let retainGeneration = 0;
  // A remote insert above the first block. Firefox puts the collapsed caret back
  // at its old offset, and addRange does not move a caret that is already there.
  // The lock uses the shifted offset. This keeps the drawn caret on that offset
  // until the browser's restore has been replaced.
  let remoteCaret = null;
  // ArrowUp onto a line of spaces or a tab. Firefox puts the selection back on
  // the paragraph above after the turn, and again after a timer has corrected
  // it. The next key or pointer clears the hold. A timer must not.
  let whitespaceCaret = null;
  let pasteSeen = false;
  let pendingAttach = false;
  let noticeTimer = null;
  let noticeEl = null;
  let composing = false;
  let composed = "";
  // placeCaret and moveCaret write the selection from state. The selectionchange
  // those writes fire must not copy that selection back over state.
  let placingCaret = false;
  // An arrow decides the offset, then render replaces the lines. selectionchange
  // from that replace still names the browser landing. Up from the paragraph
  // under a line of spaces or a tab lands on the paragraph above; adopting that
  // landing puts the caret back there. Firefox also restores that landing after
  // this flag is cleared. whitespaceCaret keeps the stop until the next key or pointer.
  let movingCaret = false;
  let strayRestores = 0;
  let goalX = null;
  // The column ArrowUp and ArrowDown keep after a shorter line clamps the caret.
  let rawColumn = null;

  function pointBox(point) {
    if (!point || !point.node || typeof document === "undefined" || typeof document.createRange !== "function") return null;
    try {
      const range = document.createRange();
      range.setStart(point.node, point.offset || 0);
      range.collapse(true);
      const rects = typeof range.getClientRects === "function" ? range.getClientRects() : null;
      const rect = rects && rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
      if (!rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.top)) return null;
      return rect;
    } catch {
      return null;
    }
  }

  function goalOffset(doc, next, x) {
    const origin = pointBox(pointFor(next));
    if (!origin) return next;
    const [start, end] = lineSpan(doc, next);
    let best = next;
    let bestDist = Math.abs(origin.left - x);
    for (let offset = start; offset <= end && offset <= doc.length; offset += 1) {
      const box = pointBox(pointFor(offset));
      if (!box || Math.abs(box.top - origin.top) > 1) continue;
      const dist = Math.abs(box.left - x);
      if (dist < bestDist) { best = offset; bestDist = dist; }
    }
    return best;
  }

  let compositionOrigin = null;
  // insert collapses at the end of its replacement. This is the selection that
  // still covers the same characters after a list indent.
  let keptCaret = null;
  // A rename's offset. hold means the reopen's file must not replace it.
  let followCaret = null;
  let followPath = false;
  // The anchor can sit on a marker the cursor line does not open.
  let rawSelectionLines = false;

  function lineSet(anchor, cursor) {
    const from = Math.min(anchor, cursor);
    const to = Math.max(anchor, cursor);
    const start = lockIndexAt(state.doc, from);
    const end = lockIndexAt(state.doc, to);
    const lines = [];
    for (let index = Math.min(start, end); index <= Math.max(start, end); index += 1) lines.push(index);
    return lines;
  }
  sentLines = lineSet(state.anchor, state.cursor);

  function selfName() {
    return typeof active.username === "string" ? active.username : "";
  }

  function selfToken() {
    return typeof active.token === "string" ? active.token : "";
  }

  // This tab is its hello token. Another tab of the same user, and a CLI edit
  // under that username, are someone else. A mirror with no token has only the username.
  function ownActor(message) {
    const mine = selfToken();
    if (mine) return !!message && message.token === mine;
    return !!message && message.actor === selfName();
  }

  function ownLock(line) {
    if (!line || typeof line.username !== "string" || line.username === "") return false;
    const mine = selfToken();
    if (mine) return line.token === mine;
    return line.username === selfName();
  }

  // False only when this transport can say the socket is not taking frames.
  // A holding transport has no socket, so it is up.
  function socketDown() {
    return active.memory !== true && typeof active.ready === "function" && active.ready() !== true;
  }

  function offline() {
    return reconnecting || socketDown();
  }

  function emit(message, track = true) {
    const framed = { ...message, username: selfName() };
    const type = framed.type;
    const needsReply = type === "edit" || type === "undo" || type === "redo";
    // sendEdit queues these. A frame that cannot leave has no reply to wait on.
    if (needsReply && offline()) return false;
    if (type === "lock" || needsReply || type === "open") {
      if (framed.path == null) framed.path = openPath;
      framed.rev = rev;
    }
    if (type === "create") {
      conflictWaiters.push("create");
      fileWaiters.push("create");
    }
    // A snapshot restates a caret it already stored. Waiting on that lock
    // would stand in front of a later ticket.set and turn its 409 into a caret restore.
    if (type === "lock" && track) conflictWaiters.push("lock");
    if (needsReply) {
      conflictWaiters.push("edit");
      // The memory transport answers in send. A socket that stays quiet is reopened.
      if (active.memory !== true) armEditTimer();
    }
    if (type === "open") fileWaiters.push("open");
    // The caller puts rev on ticket.set. A later 400 or 409 is a rejected field, not a lost caret.
    if (type === "ticket.set") conflictWaiters.push("ticket");
    if (type === "delete" || type === "ticket.delete") conflictWaiters.push("delete");
    let delivered = true;
    try {
      if (active.send(framed) === false) delivered = false;
    } catch {
      delivered = false;
    }
    if (delivered) return true;
    if (needsReply) {
      const index = conflictWaiters.lastIndexOf("edit");
      if (index >= 0) conflictWaiters.splice(index, 1);
      clearEditTimer();
      return false;
    }
    if (type === "open") {
      const at = fileWaiters.lastIndexOf("open");
      if (at >= 0) fileWaiters.splice(at, 1);
    }
    return false;
  }

  // Comment edits rewrite the trailing fence, so the lock runs through the
  // end of the mirror. The local caret stays where the user left it.
  function lockThroughEnd() {
    emit({
      type: "lock",
      anchor: Math.min(state.anchor, state.cursor),
      cursor: state.doc.length,
    });
  }

  // The fence follows the picture, which may sit above the caret. The lock
  // starts at the earlier of the two and still runs through the end.
  function lockMovedPin(id) {
    const thread = commentThreads(state.doc).find((item) => item && item.id === id && item.pin);
    const from = thread
      ? Math.min(state.anchor, state.cursor, thread.start)
      : Math.min(state.anchor, state.cursor);
    emit({ type: "lock", anchor: from, cursor: state.doc.length });
  }

  function editHeld() {
    return resumeAfterFile || conflictWaiters.includes("edit");
  }

  function clearVimHistoryFlight() {
    vimUndoArmed = false;
    vimUndoMark = null;
    vimGroupCont = false;
    vimHistoryPending = null;
    vimPlace = null;
    vimForceClaim = false;
  }

  function resetVimHistory() {
    vimUndoCarets.length = 0;
    vimRedoCarets.length = 0;
    clearVimHistoryFlight();
  }

  function dropPendingEdits() {
    pendingEdits.length = 0;
    resumeAfterFile = false;
    reconnecting = false;
    reopening = false;
    inflightEdit = null;
    // The splice will not be stored. The same text can send the leave again.
    droppedBreakDoc = null;
    clearEditTimer();
    typingRun = null;
    vimInsertOpen = false;
    clearVimHistoryFlight();
    vimEditRegister = null;
  }

  function pendingSplicePrior() {
    for (let i = 0; i < pendingEdits.length; i += 1) {
      const prior = pendingEdits[i] && pendingEdits[i].splicePrior;
      if (prior) return prior;
    }
    return null;
  }

  function copyVimRegister(reg) {
    return {
      text: reg && typeof reg.text === "string" ? reg.text : "",
      linewise: !!(reg && reg.linewise),
    };
  }

  function clearEditTimer() {
    if (editTimer == null) return;
    clearTimeout(editTimer);
    editTimer = null;
  }

  // Two seconds of silence means the reply was lost. Keep the queue, drop the
  // one in-flight waiter, and wait for this file before sending anything else.
  function armEditTimer() {
    clearEditTimer();
    editTimer = setTimeout(() => {
      editTimer = null;
      if (closed) return;
      const index = conflictWaiters.indexOf("edit");
      if (index < 0) return;
      conflictWaiters.splice(index, 1);
      vimEditRegister = null;
      resumeAfterFile = true;
      waitingForFile = true;
      followCaret = null;
      followPath = false;
      emit({ type: "open", path: openPath });
    }, 2000);
  }

  function boundaryNoop(partial) {
    const anchor = typeof partial.anchor === "number" ? partial.anchor : state.anchor;
    const cursor = typeof partial.cursor === "number" ? partial.cursor : state.cursor;
    if (anchor !== cursor) return false;
    if (partial.op === "backspace" && cursor === 0) return true;
    if (partial.op === "delete" && cursor === state.doc.length) return true;
    return false;
  }

  function dropEditWaiters() {
    for (let i = conflictWaiters.length - 1; i >= 0; i -= 1) {
      if (conflictWaiters[i] === "edit") conflictWaiters.splice(i, 1);
    }
    vimEditRegister = null;
  }

  // An end marker stays behind keys already queued, so those keys still join the run.
  function endTypingRunLater() {
    if (editHeld() || pendingEdits.length > 0) pendingEdits.push({ endRun: true });
    else typingRun = null;
  }

  function drainEndRuns() {
    while (!editHeld() && pendingEdits.length > 0 && pendingEdits[0].endRun) {
      pendingEdits.shift();
      typingRun = null;
    }
  }

  function typedText(data) {
    return typeof data === "string" && data.length > 0 && !/[\n\r\t]/.test(data);
  }

  function emitTyping(partial) {
    emitEdit({ ...partial, typing: true, typedAt: Date.now() });
  }

  // Shift alone is not the end of a run. A letter typed with Shift still belongs to it.
  function keyEndsRun(event) {
    if (!event || composing || event.isComposing) return false;
    const key = event.key;
    if (typeof key !== "string") return false;
    if (key === "Dead" || key === "Process" || key === "Unidentified") return false;
    if (key === "Control" || key === "Meta" || key === "Alt" || key === "Shift") return false;
    if (event.ctrlKey || event.metaKey || event.altKey) return true;
    if (key.length === 1) return false;
    return true;
  }

  // Another session's edit in one of these blocks ends the run. Own docs do not.
  function changeHits(doc, message, blocks) {
    const set = new Set(blocks);
    const list = Array.isArray(message.changes) && message.changes.length > 0
      ? message.changes
      : (Number.isFinite(message.from) && Number.isFinite(message.to)
        ? [{ from: message.from, to: message.to, inserted: message.inserted }]
        : null);
    if (!list) return true;
    let text = typeof doc === "string" ? doc : "";
    for (const change of list) {
      const from = Number(change.from);
      const to = Number(change.to);
      if (!Number.isFinite(from) || !Number.isFinite(to)) return true;
      const lo = Math.max(0, Math.min(from, to, text.length));
      const hi = Math.max(0, Math.min(Math.max(from, to), text.length));
      const start = lockIndexAt(text, lo);
      const end = lockIndexAt(text, hi);
      for (let i = Math.min(start, end); i <= Math.max(start, end); i += 1) {
        if (set.has(i)) return true;
      }
      const inserted = typeof change.inserted === "string" ? change.inserted : "";
      if (from >= 0 && to >= from && to <= text.length) text = text.slice(0, from) + inserted + text.slice(to);
    }
    return false;
  }

  function editRecordsUndo(body) {
    const op = body && body.op;
    return op === "insert" || op === "backspace" || op === "delete" || op === "move"
      || op === "comment.add" || op === "comment.pin" || op === "comment.pin.move" || op === "comment.save" || op === "comment.delete" || op === "comment.resolve";
  }

  function queuePartial(partial, splicePrior, holdForFile) {
    const queued = { edit: partial };
    if (splicePrior) queued.splicePrior = splicePrior;
    pendingEdits.push(queued);
    if (holdForFile) resumeAfterFile = true;
  }

  // The socket took nothing, so the caret has to come from a file before the key is tried again.
  function reopenForHeldKeys() {
    if (socketDown() || reopening || !openPath) return;
    reopening = true;
    waitingForFile = true;
    followCaret = null;
    followPath = false;
    emit({ type: "open", path: openPath });
    reopening = false;
  }

  function putBackEdit(partial, splicePrior) {
    // This op was taken off the front to send. The socket did not take it,
    // so it has to lead the queue or the keys behind it would go first.
    const queued = { edit: partial };
    if (splicePrior) queued.splicePrior = splicePrior;
    pendingEdits.unshift(queued);
    resumeAfterFile = true;
    reopenForHeldKeys();
  }

  function sendEdit(partial, splicePrior) {
    if (offline()) {
      putBackEdit(partial, splicePrior);
      return;
    }
    // Set before emit. The memory transport answers inside send.
    if (splicePrior) vimEditRegister = splicePrior;
    const body = { ...partial };
    const vimMark = body.vimMark && Number.isFinite(body.vimMark.before) && Number.isFinite(body.vimMark.after)
      ? { before: body.vimMark.before, after: body.vimMark.after }
      : null;
    delete body.vimMark;
    const typing = body.typing === true;
    const typedAt = body.typedAt;
    delete body.typing;
    delete body.typedAt;
    if (typing) {
      const join = !!(typingRun && Number.isFinite(typedAt) && typedAt - typingRun.at <= 1000);
      if (join) body.group = true;
      typingRun = {
        at: Number.isFinite(typedAt) ? typedAt : Date.now(),
        blocks: lineSet(state.anchor, state.cursor),
      };
    }
    // Group folds into the open entry. Anything else is a new undo the reply will commit.
    if (vimOn && editRecordsUndo(body)) {
      if (body.group === true) vimGroupCont = true;
      else {
        vimUndoArmed = true;
        vimUndoMark = vimMark;
        vimGroupCont = false;
      }
    }
    if (body.op === "comment.add" || body.op === "comment.pin" || body.op === "comment.pin.move" || body.op === "comment.delete" || body.op === "comment.resolve") {
      if (body.op === "comment.pin.move") lockMovedPin(body.id);
      else lockThroughEnd();
    }
    const message = {
      type: "edit",
      anchor: state.anchor,
      cursor: state.cursor,
      ...body,
    };
    // The hub's insert refuses a splice that cuts a comment mark. Raw mode
    // draws that mark, so the key is stored as typed.
    if (sourceMode && message.op === "insert") message.raw = true;
    const sent = {
      edit: { ...partial, anchor: message.anchor, cursor: message.cursor },
      splicePrior,
      baseText: state.doc,
    };
    inflightEdit = sent;
    if (emit(message) === false) {
      if (inflightEdit === sent) inflightEdit = null;
      putBackEdit(partial, splicePrior);
      return;
    }
    // A memory transport answers inside send and may already have cleared this.
    if (inflightEdit !== sent) return;
  }

  // The bytes the hub would have stored, or null when this op cannot be previewed.
  function previewEdit(item) {
    const partial = item && item.edit;
    if (!partial || typeof item.baseText !== "string") return null;
    const cursor = Number.isFinite(partial.cursor) ? partial.cursor : null;
    const anchor = Number.isFinite(partial.anchor) ? partial.anchor : cursor;
    if (cursor == null || anchor == null) return null;
    const base = { ...createState(item.baseText, cursor), anchor, cursor };
    if (partial.op === "insert") {
      const text = typeof partial.text === "string" ? partial.text : "";
      return insert(base, text, partial.paste === true, partial.raw === true);
    }
    if (partial.op === "backspace") return backspace(base);
    if (partial.op === "delete") return deleteForward(base);
    return null;
  }

  function emitEdit(partial, splicePrior) {
    if (!partial || partial.typing !== true) endTypingRunLater();
    if (boundaryNoop(partial)) return;
    goalX = null;
    rawColumn = null;
    const away = offline();
    if (!live && !away) {
      pinScrollHold = null;
      return;
    }
    // Stamp group before the queue. Escape can leave Insert while a splice is still waiting.
    const vimSplice = partial.op === "insert" || partial.op === "backspace" || partial.op === "delete";
    if (vimOn && vimMode === "insert" && vimSplice) {
      if (vimInsertOpen) partial = { ...partial, group: true };
      vimInsertOpen = true;
    }
    if (!away && !editHeld()) drainEndRuns();
    if (away || editHeld()) {
      queuePartial(partial, splicePrior, away);
      return;
    }
    sendEdit(partial, splicePrior);
  }

  function emitHistory(type) {
    endTypingRunLater();
    const away = offline();
    if (!live && !away) return;
    if (!away && !editHeld()) drainEndRuns();
    if (away || editHeld() || pendingEdits.length > 0) {
      pendingEdits.push({ history: type });
      if (away) resumeAfterFile = true;
      return;
    }
    if (vimOn) vimHistoryPending = type;
    if (emit({ type }) === false) {
      vimHistoryPending = null;
      pendingEdits.push({ history: type });
      resumeAfterFile = true;
    }
  }

  function flushPendingEdit() {
    if (editHeld()) return;
    drainEndRuns();
    if (editHeld() || pendingEdits.length === 0) return;
    const next = pendingEdits.shift();
    if (next.edit && typeof next.baseText === "string") {
      const preview = previewEdit(next);
      // The file already contains this edit. Sending it again would duplicate the key.
      if (preview && preview.refused == null && preview.doc === state.doc) {
        flushPendingEdit();
        return;
      }
    }
    if (next.history) {
      if (vimOn) vimHistoryPending = next.history;
      if (emit({ type: next.history }) === false) {
        vimHistoryPending = null;
        pendingEdits.unshift(next);
        resumeAfterFile = true;
        reopenForHeldKeys();
      }
    } else if (next.edit) sendEdit(next.edit, next.splicePrior);
  }

  function restoreGrantedCaret() {
    lockRejected = true;
    const restore = outstandingLock ? outstandingLock.restore : granted;
    outstandingLock = null;
    granted = { anchor: restore.anchor, cursor: restore.cursor };
    state = { ...state, anchor: restore.anchor, cursor: restore.cursor };
    sentLines = lineSet(restore.anchor, restore.cursor);
    render();
  }

  function dropRefusalClass(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.classList && node.classList.contains("md-flash")) node.classList.remove("md-flash");
    for (const child of node.childNodes || []) dropRefusalClass(child);
  }

  function clearRefusal() {
    refusal = null;
    if (refusalTimer == null) return;
    clearTimeout(refusalTimer);
    refusalTimer = null;
  }

  // outstandingLock is cleared by the restore that follows, so the caret offset is taken now.
  function armRefusal(message) {
    const named = typeof message.heldBy === "string" ? message.heldBy : "";
    const restore = outstandingLock ? outstandingLock.restore : granted;
    refusal = named ? { name: named } : { offset: restore.cursor };
    if (refusalTimer != null) clearTimeout(refusalTimer);
    refusalTimer = setTimeout(() => {
      refusalTimer = null;
      refusal = null;
      if (!closed) dropRefusalClass(root);
    }, 1000);
  }

  function blockContainsOffset(block, offset) {
    const start = Number(block.start);
    const end = Number(block.end);
    return Number.isFinite(start) && Number.isFinite(end) && offset >= start && offset <= end;
  }

  function tightestBlock(blocks, offset) {
    let best = null;
    let bestSpan = Infinity;
    for (const block of blocks) {
      if (!blockContainsOffset(block, offset)) continue;
      const span = Number(block.end) - Number(block.start);
      if (span < bestSpan) {
        best = block;
        bestSpan = span;
      }
    }
    return best;
  }

  function bodySelection() {
    const view = typeof window !== "undefined" ? window : null;
    const sel = view && typeof view.getSelection === "function" ? view.getSelection() : null;
    if (!sel || !root || typeof root.contains !== "function") return null;
    const nodes = [];
    if (sel.anchorNode) nodes.push(sel.anchorNode);
    if (sel.focusNode) nodes.push(sel.focusNode);
    if (sel.rangeCount && typeof sel.getRangeAt === "function") {
      let range = null;
      try {
        range = sel.getRangeAt(0);
      } catch {
        range = null;
      }
      if (range) {
        if (range.startContainer) nodes.push(range.startContainer);
        if (range.endContainer) nodes.push(range.endContainer);
        if (range.commonAncestorContainer) nodes.push(range.commonAncestorContainer);
      }
    }
    for (const node of nodes) {
      if (node && root.contains(node)) return sel;
    }
    return null;
  }

  // The caret left the body for a ticket field, so the lines it held are free.
  function dismissBodyCaret() {
    bodyCaretReleased = true;
    const sel = bodySelection();
    if (sel && typeof sel.removeAllRanges === "function") sel.removeAllRanges();
    if (sentLines.length === 0 && !outstandingLock) return;
    outstandingLock = null;
    sentLines = [];
    if (!live || !openPath) return;
    emit({ type: "lock", release: true }, false);
  }

  // The caret left the empty line a Shift+Enter break opened. The slash would
  // end the block, so another viewer draws it. The line and the slash go.
  function dropEmptyBreak(anchor, cursor) {
    if (droppingBreak || anchor !== cursor || granted.anchor !== granted.cursor) return false;
    if (droppedBreakDoc === state.doc) return false;
    const origin = granted.cursor;
    if (!Number.isFinite(origin) || sameSourceLine(state.doc, origin, cursor)) return false;
    let cut = emptyBreakCut(state.doc, origin);
    if (!cut) return false;
    // The backslash was written in front of a line that was already there.
    if (bareBreakAt !== null && state.doc[bareBreakAt] !== "\\") bareBreakAt = null;
    const slashOnly = bareBreakAt !== null && bareBreakAt === cut.from;
    if (slashOnly) cut = { from: cut.from, to: cut.from + 1, inserted: "" };
    const expect = state.doc.slice(0, cut.from) + cut.inserted + state.doc.slice(cut.to);
    const caret = Math.max(0, Math.min(expect.length, mapBreakCaret(cursor, cut)));
    const token = { text: expect, anchor: caret, cursor: caret };
    const before = state.doc;
    const queued = pendingEdits.length;
    const heldEdit = conflictWaiters.includes("edit");
    keptCaret = token;
    droppingBreak = true;
    droppedBreakDoc = before;
    try {
      emitEdit({ op: "insert", text: cut.inserted, anchor: cut.from, cursor: cut.to, caret });
    } finally {
      droppingBreak = false;
    }
    const sentOrQueued = state.doc !== before
      || pendingEdits.length > queued
      || (!heldEdit && conflictWaiters.includes("edit"));
    // The memory transport has already replaced this text. A missed send must not stick.
    if (!sentOrQueued || state.doc !== before) droppedBreakDoc = null;
    if (keptCaret === token) keptCaret = null;
    if (state.doc !== before && slashOnly) bareBreakAt = null;
    return state.doc !== before;
  }

  // The line set is granted when this user already holds it, or when the memory
  // transport accepts the lock before send returns. A 409 puts the caret back.
  function claimLines(anchor, cursor) {
    bodyCaretReleased = false;
    if (dropEmptyBreak(anchor, cursor)) return true;
    const lines = lineSet(anchor, cursor);
    if (!live) {
      sentLines = lines;
      granted = { anchor, cursor };
      outstandingLock = null;
      return true;
    }
    if (sameLines(lines, sentLines) && !outstandingLock) {
      granted = { anchor, cursor };
      return true;
    }
    if (sameLines(lines, sentLines)) return true;
    outstandingLock = { restore: { anchor: granted.anchor, cursor: granted.cursor }, lines };
    lockRejected = false;
    emit({ type: "lock", anchor, cursor });
    if (lockRejected) {
      lockRejected = false;
      return false;
    }
    if (active.memory === true) {
      outstandingLock = null;
      sentLines = lines;
      granted = { anchor, cursor };
      return true;
    }
    sentLines = lines;
    return true;
  }

  function clearAtomMark() {
    for (const el of root.querySelectorAll(".md-atom-selected")) el.classList.remove("md-atom-selected");
  }

  // Empty lines have no text node; the caret stays on the br.
  // The slack after a short marker is a space whose source span is empty, so
  // the length check skips it. That space's end is the item column; the hang's
  // end is only the marker's right edge.
  function pointFor(offset) {
    let atEnd = null;
    let rawGap = null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.closest(".md-atom") || node.parentElement?.closest(".md-lock")) continue;
      const tagged = nearestTagged(node);
      if (!tagged) continue;
      const start = Number(tagged.dataset.start);
      const end = Number(tagged.dataset.end);
      if (start === end && offset === start && inRawGap(node)) {
        const length = typeof node.length === "number" ? node.length : 0;
        rawGap = { node, offset: length };
        continue;
      }
      if (node.length !== end - start || offset < start || offset > end) continue;
      if (offset < end) return { node, offset: offset - start };
      atEnd = { node, offset: offset - start };
    }
    if (rawGap) return rawGap;
    for (const br of root.querySelectorAll("br")) {
      const tagged = nearestTagged(br);
      if (!tagged) continue;
      const start = Number(tagged.dataset.start);
      const end = Number(tagged.dataset.end);
      if (start === end && start === offset) return { node: br, offset: 0 };
      // A hard break stands for one source newline, not an empty line.
      if (end === start + 1 && offset === start) return { node: br, offset: 0 };
    }
    return atEnd;
  }

  // A collapsed range on a br is a 0×0 box at the origin, and Firefox scrolls that
  // box to the top of the page. The caret before the br is the same offset.
  function placePoint(range, point) {
    const node = point.node;
    if (isBreak(node) && node.parentNode && node.parentNode.childNodes) {
      const children = node.parentNode.childNodes;
      let index = 0;
      for (; index < children.length; index += 1) if (children[index] === node) break;
      if (index < children.length) {
        range.setStart(node.parentNode, index);
        range.collapse(true);
        return;
      }
    }
    range.setStart(node, point.offset);
    range.collapse(true);
  }

  function caretRect() {
    const view = typeof window !== "undefined" ? window : null;
    const sel = view && typeof view.getSelection === "function" ? view.getSelection() : null;
    if (!sel || !sel.rangeCount || typeof sel.getRangeAt !== "function") return null;
    let range = null;
    try {
      range = sel.getRangeAt(0);
    } catch {
      return null;
    }
    if (!range) return null;
    let rect = null;
    if (typeof range.getClientRects === "function") {
      const rects = range.getClientRects();
      if (rects && rects.length > 0) rect = rects[rects.length - 1];
    }
    if ((!rect || !Number.isFinite(rect.top)) && typeof range.getBoundingClientRect === "function") {
      rect = range.getBoundingClientRect();
    }
    if (!rect || !Number.isFinite(rect.top)) return null;
    // A br's collapsed range is a 0×0 box at the origin. That is not the caret.
    const height = Number.isFinite(rect.height) ? rect.height : (Number.isFinite(rect.bottom) ? rect.bottom - rect.top : 0);
    const width = Number.isFinite(rect.width) ? rect.width : 0;
    if (!(height > 0) && !(width > 0)) return null;
    return rect;
  }

  function caretTop() {
    const rect = caretRect();
    return rect ? rect.top : null;
  }

  function caretInView(rect) {
    const view = typeof window !== "undefined" ? window : null;
    if (!rect || !view) return false;
    const height = view.innerHeight;
    const width = view.innerWidth;
    if (!Number.isFinite(height) || height <= 0 || !Number.isFinite(width) || width <= 0) return false;
    const bottom = Number.isFinite(rect.bottom) ? rect.bottom : rect.top;
    const right = Number.isFinite(rect.right) ? rect.right : rect.left;
    const left = Number.isFinite(rect.left) ? rect.left : 0;
    return rect.top >= 0 && bottom <= height && left >= 0 && right <= width;
  }

  function domSelectionMatches() {
    const view = typeof window !== "undefined" ? window : null;
    const sel = view && typeof view.getSelection === "function" ? view.getSelection() : null;
    if (!sel || !sel.rangeCount) return false;
    const mapped = selectionFromDom(sel);
    return !!mapped && mapped.anchor === state.anchor && mapped.cursor === state.cursor;
  }

  function visualLineHost(el) {
    return hasClass(el, "md-line") || hasClass(el, "md-table") || hasClass(el, "md-diagram");
  }

  function firstTaggedDescendant(el) {
    for (const child of childArray(el)) {
      if (!child || child.nodeType !== 1) continue;
      if (child.dataset && child.dataset.start != null && child.dataset.start !== "") return child;
      const nested = firstTaggedDescendant(child);
      if (nested) return nested;
    }
    return null;
  }

  // A rendered heading has no offsets of its own. The title's line is the source line.
  function visualSourceLine(el) {
    const data = el && el.dataset;
    if (data && data.start != null && data.start !== "" && data.end != null && data.end !== "") {
      const start = Number(data.start);
      const end = Number(data.end);
      if (Number.isFinite(start) && Number.isFinite(end)) return [start, end];
    }
    const tagged = firstTaggedDescendant(el);
    if (!tagged) return null;
    const at = Number(tagged.dataset.start);
    if (!Number.isFinite(at)) return null;
    return lineSpan(state.doc, at);
  }

  // end is the newline, so a span that stops there still meets the line. An empty
  // line is that one offset, included when it lies on the inclusive ends.
  function sourceLineSelected(start, end, lo, hi) {
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    if (start === end) return start >= lo && start <= hi;
    if (end < start) return false;
    return start <= hi && end >= lo;
  }

  // The caret range stops on the glyphs. Visual line paints the line box.
  function markVisualLines() {
    const hosts = [];
    const walk = (node) => {
      if (!node || node.nodeType !== 1) return;
      if (visualLineHost(node)) hosts.push(node);
      for (const child of childArray(node)) walk(child);
    };
    for (const child of childArray(root)) walk(child);
    const on = vimOn && vimMode === "visual-line";
    const lo = on ? Math.min(state.anchor, state.cursor) : 0;
    const hi = on ? Math.max(state.anchor, state.cursor) : 0;
    for (const el of hosts) {
      if (!el.classList) continue;
      let selected = false;
      if (on && !hasClass(el, "md-paragraph-gap")) {
        const span = visualSourceLine(el);
        selected = !!span && sourceLineSelected(span[0], span[1], lo, hi);
      }
      if (selected) el.classList.add("md-line-selected");
      else el.classList.remove("md-line-selected");
    }
  }

  // priorTop is the caret before this render replaced the line. A rebuild that
  // keeps the same visual line, or a caret already in view, stays put.
  function placeCaret(priorTop) {
    placingCaret = true;
    let node = null;
    try {
      node = placeCaretFromState();
      // The range can scroll the caret into view before scrollCaret runs.
      if (pinScrollHold) restoreScroll(pinScrollHold);
      if (!node || vimKeepScroll || pinScrollHold) return;
      // An in-view rect can be the caret Firefox refused to move. Scrolling that
      // is not a reason to keep it.
      if (priorTop !== undefined && domSelectionMatches()) {
        const after = caretRect();
        if (after && caretInView(after)) return;
        if (priorTop != null && after && Number.isFinite(after.top) && Math.abs(after.top - priorTop) <= 3) return;
      }
      scrollCaret(node);
      // Firefox can drop the range while the line scrolls. Put it back before
      // selectionchange is allowed to adopt that drop.
      if (!domSelectionMatches()) placeCaretFromState();
      // The br's box is the origin. The browser scrolls to it on the next frame.
      if (!caretRect()) keepLineInView(node);
    } finally {
      placingCaret = false;
      // selectionchange does not run while the caret is placed. An arrow-key
      // selection still has to move the button under the highlight it just drew.
      updateCommentButton();
      syncVimBlockMark();
      markVisualLines();
    }
  }

  function bringRectIntoView(rect) {
    const view = typeof window !== "undefined" ? window : null;
    if (!rect || !view || typeof view.scrollBy !== "function") return;
    const height = view.innerHeight;
    const width = view.innerWidth;
    if (!(height > 0) || !(width > 0) || !(rect.height > 0) || rect.height > height) return;
    const bottom = rect.top + rect.height;
    const right = rect.left + (rect.width > 0 ? rect.width : 0);
    let dy = 0;
    let dx = 0;
    if (rect.top < 0) dy = rect.top;
    else if (bottom > height) dy = bottom - height;
    if (rect.left < 0) dx = rect.left;
    else if (right > width) dx = right - width;
    if (dx !== 0 || dy !== 0) view.scrollBy(dx, dy);
  }

  function scrollCaret(node) {
    const host = (node && node.parentElement) || root;
    if (host && typeof host.scrollIntoView === "function") {
      host.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    // scrollIntoView leaves a line that overflows a fixed grid row where it was.
    bringRectIntoView(elementBox(host));
  }

  // Firefox scrolls a caret it cannot measure to the origin after placeCaret returns.
  function keepLineInView(node) {
    const line = lineBox(node) || (node && node.parentElement) || node;
    const view = typeof window !== "undefined" ? window : null;
    if (!line || !view || typeof view.requestAnimationFrame !== "function") return;
    if (typeof line.getBoundingClientRect !== "function") return;
    const y = typeof view.scrollY === "number" ? view.scrollY : 0;
    const correct = () => {
      if (closed || line.isConnected === false) return;
      let rect = null;
      try {
        rect = line.getBoundingClientRect();
      } catch {
        return;
      }
      if (!rect || !(rect.height > 0)) return;
      const height = view.innerHeight;
      if (!(height > 0)) return;
      if (rect.bottom > 0 && rect.top < height) return;
      if (!(typeof view.scrollY === "number") || !(view.scrollY + 1 < y)) return;
      bringRectIntoView(elementBox(line));
    };
    view.requestAnimationFrame(() => {
      correct();
      if (typeof view.requestAnimationFrame === "function") view.requestAnimationFrame(correct);
    });
  }

  function focusEditor() {
    if (root && typeof root.focus === "function") root.focus();
  }

  // Hiding the new-file name field leaves focus on the page body, so keys
  // never reach the document that create just opened.
  function focusCreatedFile() {
    const view = typeof window !== "undefined" ? window : null;
    const sel = view && typeof view.getSelection === "function" ? view.getSelection() : null;
    // No selection object means this host cannot place a range. Leave the flag
    // unset so a later render does not treat that miss as a focus to restore.
    if (sel) restoreEditorFocus = true;
    focusEditor();
    placeCaret();
    retainCaret();
  }

  // pointFor skips text inside an atom. A selection end on that element is the
  // edge before or after it. The source offsets stay where they were.
  function atomCovering(offset) {
    let found = null;
    for (const el of root.querySelectorAll(".md-image, .md-atom")) {
      const start = Number(el.dataset && el.dataset.start);
      const end = Number(el.dataset && el.dataset.end);
      if (!(start <= offset && offset <= end)) continue;
      if (!found || end - start < found.end - found.start) found = { el, start, end };
    }
    return found;
  }

  function placeAtomSelection(sel, anchorOff, caretOff, from, to) {
    const range = document.createRange();
    const apply = (which, offset, point) => {
      if (point) {
        if (which === "start") {
          range.setStart(point.node, point.offset);
          return true;
        }
        if (typeof range.setEnd !== "function") return false;
        range.setEnd(point.node, point.offset);
        return true;
      }
      const atom = atomCovering(offset);
      if (!atom || (offset !== atom.start && offset !== atom.end)) return false;
      const before = offset === atom.start;
      if (which === "start") {
        if (before) range.setStartBefore(atom.el);
        else range.setStartAfter(atom.el);
        return true;
      }
      if (before) {
        if (typeof range.setEndBefore !== "function") return false;
        range.setEndBefore(atom.el);
        return true;
      }
      if (typeof range.setEndAfter !== "function") return false;
      range.setEndAfter(atom.el);
      return true;
    };
    const loOff = Math.min(anchorOff, caretOff);
    const hiOff = Math.max(anchorOff, caretOff);
    const pointAt = (offset) => (offset === anchorOff ? from : to);
    if (!apply("start", loOff, pointAt(loOff)) || !apply("end", hiOff, pointAt(hiOff))) return false;
    if (typeof sel.removeAllRanges === "function") sel.removeAllRanges();
    if (typeof sel.addRange !== "function") return false;
    sel.addRange(range);
    return true;
  }

  // A rendered heading's marker is not a text node. The line's first or last
  // drawn glyph is that endpoint, so the visual line is not dropped.
  function drawnLinePoint(offset) {
    const [lineStart, lineEnd] = lineSpan(state.doc, offset);
    const marks = [];
    let walker = null;
    try {
      const show = typeof NodeFilter === "undefined" ? 4 : NodeFilter.SHOW_TEXT;
      walker = document.createTreeWalker(root, show);
    } catch {
      walker = null;
    }
    if (walker) {
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (parent && typeof parent.closest === "function" && (parent.closest(".md-atom") || parent.closest(".md-lock"))) continue;
        const tagged = nearestTagged(node);
        if (!tagged) continue;
        const start = Number(tagged.dataset.start);
        const end = Number(tagged.dataset.end);
        const len = typeof node.length === "number" ? node.length : 0;
        if (!Number.isFinite(start) || !Number.isFinite(end) || len !== end - start) continue;
        if (end <= lineStart || start >= lineEnd) continue;
        const sourceStart = Math.max(start, lineStart);
        const sourceEnd = Math.min(end, lineEnd);
        if (sourceEnd <= sourceStart) continue;
        marks.push({
          node,
          sourceStart,
          sourceEnd,
          atStart: sourceStart - start,
          atEnd: sourceEnd - start,
        });
      }
    }
    const breaks = typeof root.querySelectorAll === "function" ? root.querySelectorAll("br") : [];
    for (const br of breaks) {
      const tagged = nearestTagged(br);
      if (!tagged) continue;
      const start = Number(tagged.dataset.start);
      const end = Number(tagged.dataset.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const empty = start === end && start >= lineStart && start <= lineEnd;
      const hard = end === start + 1 && start >= lineStart && start < lineEnd;
      if (!empty && !hard) continue;
      marks.push({ node: br, sourceStart: start, sourceEnd: start, atStart: 0, atEnd: 0 });
    }
    if (marks.length === 0) return null;
    marks.sort((a, b) => a.sourceStart - b.sourceStart || a.sourceEnd - b.sourceEnd);
    const first = marks[0];
    const last = marks[marks.length - 1];
    // The hidden marker is before the title, so that endpoint is the first glyph.
    const useFirst = offset <= first.sourceStart
      || (offset < last.sourceEnd && offset - first.sourceStart <= last.sourceEnd - offset);
    const mark = useFirst ? first : last;
    return { node: mark.node, offset: useFirst ? mark.atStart : mark.atEnd };
  }

  // A range sitting on a br is a 0×0 box at the origin, and Firefox scrolls to it.
  // The boundary before the br is the same source offset.
  function placeOpenEnd(range, which, point) {
    if (!range || !point || !point.node) return false;
    if (isBreak(point.node)) {
      const name = which === "start" ? "setStartBefore" : "setEndBefore";
      if (typeof range[name] !== "function") return false;
      range[name](point.node);
      return true;
    }
    const name = which === "start" ? "setStart" : "setEnd";
    if (typeof range[name] !== "function") return false;
    range[name](point.node, point.offset || 0);
    return true;
  }

  function placeOpenEnds(sel, anchorOff, caretOff, anchorPoint, caretPoint) {
    if (typeof document.createRange !== "function") return false;
    const range = document.createRange();
    const forward = anchorOff <= caretOff;
    try {
      if (!placeOpenEnd(range, "start", forward ? anchorPoint : caretPoint)) return false;
      if (!placeOpenEnd(range, "end", forward ? caretPoint : anchorPoint)) return false;
    } catch {
      return false;
    }
    if (typeof sel.removeAllRanges === "function") sel.removeAllRanges();
    if (typeof sel.addRange !== "function") return false;
    sel.addRange(range);
    return true;
  }

  function placeCaretFromState() {
    const sel = window.getSelection();
    if (!sel) return;
    // Chromium focuses the editing host when a range is added.
    // A comment card's button is not that host. Leave it focused, unless this
    // delete removed the button and the caret has to land back in the prose.
    const active = typeof document !== "undefined" && document ? document.activeElement : null;
    const outside = active && active.nodeType === 1 && active !== root && !root.contains(active);
    if (outside && !restoreEditorFocus) return;
    if (restoreEditorFocus) {
      restoreEditorFocus = false;
      if (outside) focusEditor();
    }
    clearAtomMark();
    const { anchor, cursor: caret } = state;
    if (anchor !== caret) {
      const lo = Math.min(anchor, caret);
      const hi = Math.max(anchor, caret);
      const imageLine = wholeImageLine(state.doc, lo);
      if (imageLine && imageLine.anchor === lo && imageLine.cursor === hi) {
        for (const el of root.querySelectorAll(".md-image")) {
          const start = Number(el.dataset.start);
          if (start >= lo && start < hi) {
            el.classList.add("md-atom-selected");
            const range = document.createRange();
            if (!placeImageSelection(range, el)) range.selectNode(el);
            sel.removeAllRanges();
            sel.addRange(range);
            return null;
          }
        }
      }
      for (const el of root.querySelectorAll(".md-atom")) {
        if (Number(el.dataset.start) === lo && Number(el.dataset.end) === hi) {
          el.classList.add("md-atom-selected");
          const range = document.createRange();
          range.selectNode(el);
          sel.removeAllRanges();
          sel.addRange(range);
          return null;
        }
      }
      // A picture between the ends stays an atom. The highlight is the element,
      // not a caret that pointFor cannot place inside it.
      for (const el of root.querySelectorAll(".md-image, .md-atom")) {
        const start = Number(el.dataset && el.dataset.start);
        const end = Number(el.dataset && el.dataset.end);
        if (start >= lo && end <= hi && start < hi) el.classList.add("md-atom-selected");
      }
      if (coveredOnlyByMarkers(state.doc, lo, hi)) {
        const markers = [];
        for (const el of root.querySelectorAll(".md-comment-marker")) {
          const start = Number(el.dataset && el.dataset.start);
          const end = Number(el.dataset && el.dataset.end);
          if (start >= lo && end <= hi) markers.push(el);
        }
        markers.sort((a, b) => Number(a.dataset.start) - Number(b.dataset.start));
        if (markers.length > 0 && selectMarkerElements(sel, markers)) return markers[markers.length - 1];
      }
      const anchorOff = visibleSelectionOffset(state.doc, anchor, caret);
      const caretOff = visibleSelectionOffset(state.doc, caret, anchor);
      const from = pointFor(anchorOff);
      const to = pointFor(caretOff);
      if (from && to) {
        sel.setBaseAndExtent(from.node, from.offset, to.node, to.offset);
        return to.node;
      }
      const missed = (!from && atomCovering(anchorOff)) || (!to && atomCovering(caretOff));
      if (missed && placeAtomSelection(sel, anchorOff, caretOff, from, to)) {
        return (to && to.node) || (from && from.node) || missed.el;
      }
      if (missed) return null;
      if (!from || !to) {
        const anchorPoint = from || drawnLinePoint(anchorOff);
        const caretPoint = to || drawnLinePoint(caretOff);
        // The source range stays. A collapsed caret here would replace the visual line.
        if (anchorPoint && caretPoint) {
          placeOpenEnds(sel, anchorOff, caretOff, anchorPoint, caretPoint);
          return caretPoint.node || anchorPoint.node;
        }
      }
    }
    const point = pointFor(caret);
    if (point) return selectCollapsed(sel, point);
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
        return null;
      }
      if (caret === end) {
        range.setStartAfter(el);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        return null;
      }
      if (caret === start) {
        range.setStartBefore(el);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        return null;
      }
    }
    // No block covers this offset. A comment fence is the usual gap. The nearest
    // drawn line is where the caret is painted, and where the next letter goes.
    const snapped = nearestDrawnCaret(caret);
    if (snapped == null) return null;
    const again = pointFor(snapped);
    if (!again) return null;
    state = { ...state, anchor: snapped, cursor: snapped };
    return selectCollapsed(sel, again);
  }

  // placePoint's br sits on its parent. The same point is what collapse takes.
  function collapsedTarget(point) {
    const node = point && point.node;
    if (!node) return null;
    if (isBreak(node) && node.parentNode && node.parentNode.childNodes) {
      const children = node.parentNode.childNodes;
      let index = 0;
      for (; index < children.length; index += 1) if (children[index] === node) break;
      if (index < children.length) return { node: node.parentNode, offset: index };
    }
    return { node, offset: point.offset || 0 };
  }

  // addRange leaves a collapsed caret where it was. Firefox does that after a
  // remote insert when the caret was in the first block, so the next key lands
  // in the other session's text. collapse and setBaseAndExtent replace it.
  function selectCollapsed(sel, point) {
    const at = collapsedTarget(point);
    if (!at || !at.node) return null;
    if (typeof sel.setBaseAndExtent === "function") {
      try { sel.setBaseAndExtent(at.node, at.offset, at.node, at.offset); } catch { /* a range still might take it */ }
      if (domSelectionMatches()) return point.node;
    }
    if (typeof sel.collapse === "function") {
      try { sel.collapse(at.node, at.offset); } catch { /* a range still might take it */ }
      if (domSelectionMatches()) return point.node;
    }
    const range = document.createRange();
    placePoint(range, point);
    if (typeof sel.removeAllRanges === "function") sel.removeAllRanges();
    if (typeof sel.addRange === "function") sel.addRange(range);
    return point.node;
  }

  function nearestDrawnCaret(offset) {
    let best = null;
    let bestDist = Infinity;
    const nodes = root.querySelectorAll(".md-line, .md-atom");
    for (const el of nodes) {
      if (!el.dataset || el.dataset.start == null || el.dataset.start === "") continue;
      const start = Number(el.dataset.start);
      const end = el.dataset.end == null || el.dataset.end === "" ? start : Number(el.dataset.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const at = offset <= start ? start : offset >= end ? end : (offset - start <= end - offset ? start : end);
      const dist = Math.abs(at - offset);
      if (dist < bestDist) {
        bestDist = dist;
        best = at;
      }
    }
    return best;
  }

  function selectedImageLine(sel) {
    if (!sel || sel.rangeCount === 0 || typeof sel.getRangeAt !== "function") return null;
    const range = sel.getRangeAt(0);
    const box = range && range.startContainer;
    if (!box || box !== range.endContainer || box.nodeType !== 1 || !box.childNodes) return null;
    if (range.endOffset !== range.startOffset + 1) return null;
    const child = box.childNodes[range.startOffset];
    if (!hasClass(child, "md-image")) return null;
    return wholeImageLine(state.doc, Number(child.dataset.start));
  }

  function selectionFromDom(sel) {
    if (!sel) return null;
    const imageLine = selectedImageLine(sel);
    if (imageLine) return imageLine;
    if (sel.anchorNode && sel.focusNode && nearestTagged(sel.anchorNode) && nearestTagged(sel.focusNode)) {
      return {
        anchor: mapOffset(sel.anchorNode, sel.anchorOffset),
        cursor: mapOffset(sel.focusNode, sel.focusOffset),
      };
    }
    if (sel.rangeCount === 0 || typeof sel.getRangeAt !== "function") return null;
    const range = sel.getRangeAt(0);
    const box = range && range.startContainer;
    if (box && box === range.endContainer && box.nodeType === 1 && box.childNodes) {
      const child = box.childNodes[range.startOffset];
      if (hasClass(child, "md-atom") && range.endOffset === range.startOffset + 1) {
        const imageLine = hasClass(child, "md-image") ? wholeImageLine(state.doc, Number(child.dataset.start)) : null;
        if (imageLine) return imageLine;
        return { anchor: Number(child.dataset.start), cursor: Number(child.dataset.end) };
      }
    }
    if (!range || !nearestTagged(range.startContainer) || !nearestTagged(range.endContainer)) return null;
    return {
      anchor: mapOffset(range.startContainer, range.startOffset),
      cursor: mapOffset(range.endContainer, range.endOffset),
    };
  }

  // Insert typing reads the DOM selection. A dropped range at the top of a long
  // file would store the rest of the word there. A click sets pointer, so it still lands.
  function strayCaret(mapped) {
    if (pointer || !vimInsertKeys() || !mapped) return false;
    if (mapped.anchor !== mapped.cursor) return false;
    return mapped.cursor < state.cursor - 200;
  }

  function restoreStrayCaret() {
    if (strayRestores > 2) return;
    strayRestores += 1;
    placeCaret();
  }

  function adoptDomSelection() {
    if (gestureHold) return true;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return true;
    const holder = sel.anchorNode || sel.getRangeAt(0).commonAncestorContainer;
    if (!holder || !root.contains(holder)) return true;
    const mapped = selectionFromDom(sel);
    if (!mapped) return true;
    if (strayCaret(mapped)) {
      restoreStrayCaret();
      return true;
    }
    // The drawn range omits glyph-less markers. A cut or paste keeps the
    // source selection, which still owns those markers.
    const next = sourceMode ? mapped : withMarkerEdges(state.doc, state, mapped);
    if (remoteCaret && (next.anchor !== remoteCaret.anchor || next.cursor !== remoteCaret.cursor)) {
      state = { ...state, anchor: remoteCaret.anchor, cursor: remoteCaret.cursor };
      placeCaret();
      return true;
    }
    if (whitespaceCaret && (next.anchor !== whitespaceCaret.anchor || next.cursor !== whitespaceCaret.cursor)) {
      state = { ...state, anchor: whitespaceCaret.anchor, cursor: whitespaceCaret.cursor };
      placeCaret();
      return true;
    }
    state = { ...state, anchor: next.anchor, cursor: next.cursor };
    return claimLines(next.anchor, next.cursor);
  }

  // Home lands on the source start of the line, before a drawn marker. The first
  // press stops after that marker; a later one, already there, keeps the line start.
  function homeSnap(mapped) {
    if (!mapped || mapped.anchor !== mapped.cursor) return mapped;
    const landed = mapped.cursor;
    const [start, end] = lineSpan(state.doc, landed);
    if (landed !== start) return mapped;
    const textAt = start + markerLength(state.doc.slice(start, end));
    if (textAt <= start) return mapped;
    if (state.anchor !== state.cursor) return mapped;
    const [prevStart] = lineSpan(state.doc, state.cursor);
    if (prevStart !== start || state.cursor <= textAt) return mapped;
    return { anchor: textAt, cursor: textAt };
  }

  function selectionCollapsed(sel) {
    if (!sel) return false;
    if (sel.isCollapsed === true) return true;
    if (sel.rangeCount > 0 && typeof sel.getRangeAt === "function") {
      try {
        const range = sel.getRangeAt(0);
        if (range && range.collapsed === true) return true;
      } catch {
        // A selection with no range is not a collapsed caret.
      }
    }
    return sel.anchorNode != null && sel.anchorNode === sel.focusNode && sel.anchorOffset === sel.focusOffset;
  }

  function onSelectionChange() {
    if (closed || placingCaret || movingCaret || composing || gestureHold || handleDrag || pinMove || pinScrollHold) return;
    // Chrome reports the selectionchange from placeCaret after placingCaret is
    // already false. That echo still names state, so it must not drop the column.
    const keptX = goalX;
    // Raw up and down keep the column across the selectionchange placeCaret echoes.
    if (!sourceMode) goalX = null;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const holder = sel.anchorNode || sel.getRangeAt(0).commonAncestorContainer;
    if (!holder || !root.contains(holder)) return;
    const mapped = selectionFromDom(sel);
    if (!mapped) return;
    // A Ctrl-click opens a tab and leaves the caret where it was. Firefox still
    // reports the link after the caret is put back, which would make that paragraph source.
    if (linkTabCaret && (mapped.anchor !== linkTabCaret.anchor || mapped.cursor !== linkTabCaret.cursor)) {
      state = { ...state, anchor: linkTabCaret.anchor, cursor: linkTabCaret.cursor };
      if (linkTabRestores < 4) {
        linkTabRestores += 1;
        placeCaret();
      }
      return;
    }
    if (strayCaret(mapped)) {
      restoreStrayCaret();
      return;
    }
    const snapped = sourceMode || pointer ? mapped : homeSnap(mapped);
    const next = sourceMode ? snapped : withMarkerEdges(state.doc, state, snapped);
    if (sourceMode || (next.anchor === state.anchor && next.cursor === state.cursor)) goalX = keptX;
    if (remoteCaret && (next.anchor !== remoteCaret.anchor || next.cursor !== remoteCaret.cursor)) {
      state = { ...state, anchor: remoteCaret.anchor, cursor: remoteCaret.cursor };
      placeCaret();
      return;
    }
    // The line step's restore still names the paragraph above. The stop stays.
    if (whitespaceCaret && (next.anchor !== whitespaceCaret.anchor || next.cursor !== whitespaceCaret.cursor)) {
      goalX = keptX;
      state = { ...state, anchor: whitespaceCaret.anchor, cursor: whitespaceCaret.cursor };
      placeCaret();
      return;
    }
    // The click's offsets are stale once a delete, a paste, a composition, a
    // remote edit, or a refused claim has moved the caret. Chromium's restore
    // must not put that move back.
    if (retainedCaret && (state.anchor !== retainedCaret.anchor || state.cursor !== retainedCaret.cursor)) {
      retainedCaret = { anchor: state.anchor, cursor: state.cursor, generation: retainedCaret.generation };
    }
    if (retainedCaret && (next.cursor !== retainedCaret.cursor || next.anchor !== retainedCaret.anchor)) {
      state = { ...state, anchor: retainedCaret.anchor, cursor: retainedCaret.cursor };
      placeCaret();
      return;
    }
    // The marker has no caret box, so the browser reports a collapsed caret.
    // That caret is not the visual line.
    if (vimOn && vimMode === "visual-line" && state.anchor !== state.cursor && selectionCollapsed(sel)) {
      goalX = keptX;
      placeCaret();
      return;
    }
    state = { ...state, anchor: next.anchor, cursor: next.cursor };
    if (snapped.anchor !== mapped.anchor || snapped.cursor !== mapped.cursor) placeCaret();
    // A shift-click changes the selection with no drag mouseup. Arrow keys place
    // the caret while this listener is ignored, so they place the button there.
    updateCommentButton();
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
    const noteId = Number(text.dataset.note || 0);
    const thread = threadById(id);
    const record = thread ? parseCommentNotes(thread.body).find((item) => item.id === noteId) : null;
    const parts = record ? splitCommentNote(record.raw) : null;
    // reviseCommentNote rejects a missing poster and a poster who is not this session.
    if (!parts || !parts.author || parts.author !== selfName()) return;
    const stored = parts.text;
    noteDrafts.delete(draftKey(id, noteId));
    editingNotes.add(draftKey(id, noteId));
    currentCommentId = id;
    commentFocus = { id, note: noteId, start: stored.length, end: stored.length };
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

  function strokeIcon(d) {
    if (typeof document === "undefined" || typeof document.createElementNS !== "function") return null;
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("d", d);
    svg.appendChild(path);
    return svg;
  }

  function makeIconButton(label, d, className, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    if (typeof button.setAttribute === "function") {
      button.setAttribute("type", "button");
      button.setAttribute("aria-label", label);
      button.setAttribute("title", label);
    }
    const icon = strokeIcon(d);
    if (icon) button.appendChild(icon);
    // Delete sits outside the editor. Taking focus there drops the caret, and
    // the key that follows (undo) never reaches the document.
    if (label === "Delete") {
      button.addEventListener("mousedown", (event) => {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
      });
    }
    button.addEventListener("click", (event) => {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      onClick();
    });
    return button;
  }

  function threadById(id) {
    return commentThreads(state.doc).find((item) => item.id === id) || null;
  }

  // The card shows the minute. Seconds stay on the datetime attribute.
  function formatCommentTime(iso) {
    return String(iso).replace("T", " ").slice(0, 16);
  }

  // One past the highest record id. A bare separator can repeat an id, so the count is not the next id.
  function nextNoteId(records) {
    if (records.length === 0) return 0;
    let highest = records[0].id;
    for (let i = 1; i < records.length; i += 1) {
      if (records[i].id > highest) highest = records[i].id;
    }
    return highest + 1;
  }

  function onSave(box) {
    endTypingRunLater();
    const id = box.dataset.comment;
    const thread = threadById(id);
    if (!thread) return;
    const text = typeof box.value === "string" ? box.value : "";
    const noteId = Number(box.dataset.note);
    const records = parseCommentNotes(thread.body);
    // An empty thread has no record for comment.edit to revise.
    const reply = box.dataset.fresh === "true" || box.dataset.reply === "true" || records.length === 0;
    if (box.dataset.reply === "true") replyDrafts.delete(id);
    unsavedThreads.delete(id);
    noteDrafts.delete(draftKey(id, noteId));
    editingNotes.delete(draftKey(id, noteId));
    currentCommentId = id;
    commentFocus = null;
    resumeAfterNote();
    const before = state.doc;
    if (reply) emit({ type: "comment.reply", id, text, path: openPath });
    else emit({ type: "comment.edit", id, note: noteId, rev, text, path: openPath });
    if (state.doc === before) render();
  }

  // gc stays Visual until the note is saved. Ctrl-Enter and Meta-Enter are what leave it.
  function returnFromCommentSave() {
    clearCurrentComment();
    restoreEditorFocus = true;
    focusEditor();
    if (vimOn && (vimMode === "visual" || vimMode === "visual-line")) {
      state = { ...state, anchor: state.cursor };
      useVimSelection("normal");
    }
  }

  function onCancel(box) {
    endTypingRunLater();
    const id = box.dataset.comment;
    const index = Number(box.dataset.note);
    if (box.dataset.fresh === "true") {
      unsavedThreads.delete(id);
      replyDrafts.delete(id);
      noteDrafts.delete(draftKey(id, index));
      if (currentCommentId === id) currentCommentId = null;
      commentFocus = null;
      emitEdit({ op: "comment.delete", id });
      return;
    }
    if (box.dataset.reply === "true") {
      replyDrafts.delete(id);
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
    endTypingRunLater();
    if (!replyDrafts.has(id)) replyDrafts.set(id, "");
    const thread = threadById(id);
    const noteId = thread ? nextNoteId(parseCommentNotes(thread.body)) : 0;
    currentCommentId = id;
    commentFocus = { id, note: noteId, start: 0, end: 0 };
    render();
  }

  function onDelete(id) {
    endTypingRunLater();
    unsavedThreads.delete(id);
    replyDrafts.delete(id);
    if (currentCommentId === id) currentCommentId = null;
    commentFocus = null;
    restoreEditorFocus = true;
    emitEdit({ op: "comment.delete", id });
    focusEditor();
  }

  function onResolve(id) {
    endTypingRunLater();
    const thread = threadById(id);
    if (!thread) return;
    currentCommentId = id;
    commentFocus = null;
    emitEdit({ op: "comment.resolve", id, resolved: !thread.resolved });
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

  const COMMENT_BALLOON = "M12 19l-2-3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3h-3l-2 3z";

  function appendAuthor(parent, id, index, withResolve, name, time, pinned) {
    const row = document.createElement("div");
    row.className = "md-comment-author-row";
    const by = document.createElement("div");
    by.className = "md-comment-by";
    const author = document.createElement("span");
    author.className = "md-comment-author";
    author.textContent = name || "";
    if (index === 0 && time) {
      const threadId = document.createElement("span");
      threadId.className = "md-comment-time";
      threadId.textContent = `(${id})`;
      by.appendChild(threadId);
    }
    if (pinned) {
      const line = document.createElement("span");
      line.className = "md-comment-pin-line";
      const mark = strokeIcon(COMMENT_BALLOON);
      if (mark && mark.classList) mark.classList.add("md-comment-pin-mark");
      if (mark) line.appendChild(mark);
      line.appendChild(author);
      by.appendChild(line);
    } else {
      by.appendChild(author);
    }
    if (time) {
      const clock = document.createElement("time");
      clock.className = "md-comment-time";
      if (typeof clock.setAttribute === "function") clock.setAttribute("datetime", time);
      clock.textContent = formatCommentTime(time);
      by.appendChild(clock);
    }
    row.appendChild(by);
    if (withResolve) {
      row.appendChild(makeIconButton("Resolve", "M20 6 9 17l-5-5", "icon-btn resolve", () => onResolve(id)));
    }
    const link = document.createElement("button");
    link.type = "button";
    link.className = "md-comment-link icon-btn";
    const icon = linkIcon();
    if (icon) link.appendChild(icon);
    if (typeof link.setAttribute === "function") {
      link.setAttribute("type", "button");
      link.setAttribute("aria-label", "Copy link");
      link.setAttribute("title", "Copy link");
    }
    link.addEventListener("click", (event) => {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      if (event && typeof event.stopPropagation === "function") event.stopPropagation();
      copyCommentLink(id);
    });
    row.appendChild(link);
    parent.appendChild(row);
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
    const records = parseCommentNotes(comment.body);
    if (unsavedThreads.has(comment.id)) {
      const noteId = records[0] ? records[0].id : 0;
      const stored = records[0] ? splitCommentNote(records[0].raw).text : "";
      appendAuthor(card, comment.id, noteId, false, selfName(), "", !!comment.pin);
      appendBody(card, comment.id, noteId, stored, "fresh");
      if (comment.id !== currentCommentId) setCommentActions(card, false);
      return card;
    }
    if (records.length === 0 && !replyDrafts.has(comment.id)) {
      const note = document.createElement("div");
      note.className = "md-comment-note";
      appendAuthor(note, comment.id, 0, true, "", "", !!comment.pin);
      const mode = editingNotes.has(draftKey(comment.id, 0)) ? "edit" : "saved";
      appendBody(note, comment.id, 0, "", mode);
      card.appendChild(note);
    }
    records.forEach((record, index) => {
      const parts = splitCommentNote(record.raw);
      const note = document.createElement("div");
      note.className = "md-comment-note";
      appendAuthor(note, comment.id, record.id, index === 0, parts.author, parts.time, !!comment.pin && index === 0);
      const mode = editingNotes.has(draftKey(comment.id, record.id)) ? "edit" : "saved";
      appendBody(note, comment.id, record.id, parts.text, mode);
      card.appendChild(note);
    });
    if (replyDrafts.has(comment.id)) {
      const note = document.createElement("div");
      note.className = "md-comment-note";
      const noteId = nextNoteId(records);
      appendAuthor(note, comment.id, noteId, false, selfName(), "");
      appendBody(note, comment.id, noteId, "", "reply");
      card.appendChild(note);
    }
    card.appendChild(makeIconButton(
      "Reply",
      "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
      "icon-btn",
      () => onReply(comment.id),
    ));
    const remove = makeIconButton(
      "Delete",
      ICON_PATHS.delete[0],
      "icon-btn danger",
      () => onDelete(comment.id),
    );
    if (typeof remove.setAttribute === "function") remove.setAttribute("title", "Delete this comment");
    card.appendChild(remove);
    if (comment.id !== currentCommentId) setCommentActions(card, false);
    return card;
  }

  function anchorMarkButton(thread, className) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    if (typeof button.setAttribute === "function") {
      button.setAttribute("type", "button");
      button.setAttribute("aria-label", `Comment ${thread.id}`);
    }
    button.dataset.comment = thread.id;
    if (currentCommentId === thread.id) button.classList.add("md-comment-current");
    if (editingCommentIds().has(thread.id)) button.classList.add("md-comment-editing");
    button.addEventListener("mousedown", (event) => {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
    });
    return button;
  }

  function paintLineBar(thread) {
    const count = thread.bodyCount;
    const lines = thread.lines;
    if (!Number.isInteger(count) || count < 1 || !lines) return;
    if (!(lines.start >= 1 && lines.end >= lines.start && lines.end <= count)) return;
    let host = null;
    for (const el of elementsWithClass("md-block-fence")) {
      if (hasClass(el, "md-raw")) continue;
      if (!el.dataset || el.dataset.bodyLines == null || el.dataset.bodyLines === "") continue;
      if (Number(el.dataset.fenceStart) === thread.anchorAt) {
        host = el;
        break;
      }
    }
    if (!host) return;
    const button = anchorMarkButton(thread, "md-comment-bar md-comment");
    setStyle(button, "top", `${((lines.start - 1) / count) * 100}%`);
    setStyle(button, "height", `${((lines.end - lines.start + 1) / count) * 100}%`);
    host.appendChild(button);
  }

  function paintPinMark(thread) {
    const pin = thread.pin;
    if (!pin) return;
    let host = null;
    if (thread.hostKind === "diagram") {
      for (const el of elementsWithClass("md-diagram")) {
        if (Number(el.dataset && el.dataset.start) === thread.anchorAt) {
          host = el;
          break;
        }
      }
    } else if (thread.hostKind === "image") {
      for (const el of elementsWithClass("md-image")) {
        const start = Number(el.dataset && el.dataset.start);
        if (start >= thread.anchorAt && (thread.hostEnd == null || start < thread.hostEnd)) {
          host = el;
          break;
        }
      }
    }
    if (!host) return;
    const frame = pictureFrame(host) || host;
    const button = anchorMarkButton(thread, "md-comment-pin md-comment");
    setStyle(button, "left", `${pin.x * 100}%`);
    setStyle(button, "top", `${pin.y * 100}%`);
    const icon = strokeIcon(COMMENT_BALLOON);
    if (icon) button.appendChild(icon);
    frame.appendChild(button);
  }

  // Bars and pins are their own elements. The code runs stay unmarked, so the
  // comment color does not cover the tokens.
  function paintAnchorMarks() {
    for (const thread of commentThreads(state.doc)) {
      if (!thread || (thread.resolved && !showResolved)) continue;
      if (thread.lines) paintLineBar(thread);
      else if (thread.pin) paintPinMark(thread);
    }
  }

  function renderCommentAside(comments) {
    if (!commentsAside || typeof commentsAside.replaceChildren !== "function") return;
    ensureDocMenu();
    const list = comments || [];
    pruneCommentDrafts(list);
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = showResolved;
    checkbox.disabled = false;
    checkbox.id = "show-resolved";
    if (typeof checkbox.setAttribute === "function") {
      checkbox.setAttribute("type", "checkbox");
      checkbox.setAttribute("id", "show-resolved");
    }
    const label = document.createElement("label");
    label.htmlFor = "show-resolved";
    if (typeof label.setAttribute === "function") label.setAttribute("for", "show-resolved");
    label.textContent = "show resolved";
    checkbox.addEventListener("change", () => {
      showResolved = checkbox.checked === true;
      render();
    });
    const row = document.createElement("div");
    row.className = "md-show-resolved";
    row.appendChild(checkbox);
    row.appendChild(label);
    let anyResolved = false;
    for (const comment of list) {
      if (comment && comment.resolved === true) anyResolved = true;
    }
    if (anyResolved) showElement(row);
    else hideElement(row);
    const visible = [];
    for (const comment of list) {
      if (comment.resolved && !showResolved) continue;
      visible.push(comment);
    }
    const cards = orderVisibleComments(visible, state.doc).map((comment) => buildCommentCard(comment));
    const stale = [];
    for (const child of commentsAside.childNodes || []) stale.push(child);
    for (const child of stale) {
      if (child === docAttachInput) continue;
      detachNode(child);
    }
    commentsAside.appendChild(row);
    for (const card of cards) commentsAside.appendChild(card);
    syncEntryLink();
  }

  function elementRect(el) {
    if (!el || typeof el.getBoundingClientRect !== "function") return null;
    return el.getBoundingClientRect();
  }

  function highlightMarks(id) {
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
        if (rect) found.push({ rect, pin: node.classList.contains("md-comment-pin") });
      }
      for (const child of node.childNodes || []) walk(child);
    };
    walk(root);
    return found;
  }

  // A measurement in the load handler can still see the empty frame. The next
  // frame has the picture's height, and so does a later change of that box.
  function layoutAfterPicture() {
    if (closed) return;
    layoutComments();
    restoreCornerPin();
    const view = typeof window !== "undefined" ? window : null;
    if (!view || typeof view.requestAnimationFrame !== "function" || pictureLayoutFrame) return;
    pictureLayoutFrame = view.requestAnimationFrame(() => {
      pictureLayoutFrame = 0;
      if (closed) return;
      layoutComments();
      restoreCornerPin();
    });
  }

  // The picture's box changes when its file arrives, and again if the column
  // then narrows it. Pins are a fraction of that box, so the cards follow it.
  function watchPictures() {
    if (typeof ResizeObserver !== "function" || typeof Element !== "function") return;
    if (!pictureObserver) pictureObserver = new ResizeObserver(() => layoutAfterPicture());
    pictureObserver.disconnect();
    for (const host of elementsWithClass("md-image")) {
      const img = directChildTag(pictureFrame(host) || host, "img");
      if (!img || !(img instanceof Element)) continue;
      try {
        pictureObserver.observe(img);
      } catch {
        pictureObserver.disconnect();
        pictureObserver = null;
        return;
      }
    }
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
    if (narrow || cards.length === 0) {
      for (const card of cards) {
        setStyle(card, "position", "static");
        setStyle(card, "top", "auto");
        setStyle(card, "left", "auto");
        setStyle(card, "width", "100%");
        setStyle(card, "margin", "");
        setStyle(card, "max-height", "");
        setStyle(card, "overflow", "");
      }
      setStyle(commentsAside, "height", "");
      return;
    }
    const asideRect = elementRect(commentsAside);
    if (!asideRect || typeof cards[0].getBoundingClientRect !== "function") return;
    const spans = findSpans(state.doc);
    // A hidden row still reports offsetHeight, so it must not raise the floor.
    // The box is what matters once in-flow controls sit above that row.
    let floor = COMMENT_CARD_GAP;
    const shownBottom = (el) => {
      if (!el || el.hidden || el.parentElement !== commentsAside) return 0;
      const rect = elementRect(el);
      if (!rect || !(rect.height > 0) || !Number.isFinite(rect.bottom) || !Number.isFinite(asideRect.top)) return 0;
      const bottom = rect.bottom - asideRect.top;
      return Number.isFinite(bottom) ? bottom : 0;
    };
    const resolvedRow = findClassChild(commentsAside, "md-show-resolved");
    if (resolvedRow && !resolvedRow.hidden) {
      const rowHeight = typeof resolvedRow.offsetHeight === "number" ? resolvedRow.offsetHeight : 0;
      floor = rowHeight + COMMENT_CARD_GAP;
      const rowBottom = shownBottom(resolvedRow);
      if (rowBottom > 0) floor = Math.max(floor, rowBottom + COMMENT_CARD_GAP);
    }
    // Absolute cards paint over a shown control. A hidden one still reports a box, so it does not count.
    for (const control of [docAttachInput]) {
      const bottom = shownBottom(control);
      if (bottom > floor) floor = bottom;
    }
    // A card sits on its anchor: a pin's tip, or the top of a highlight. A later
    // card stays there when that does not cover an earlier card, and moves down
    // only to clear one it would cover. A tall closed card shortens so a later
    // anchor below it keeps that place. The open card stays full height.
    const menuFloor = floor;
    const SHORT = 10 * COMMENT_CARD_GAP;
    const GAP = COMMENT_CARD_GAP;
    const anchorOf = (card) => {
      const id = card.dataset.comment;
      let marks = highlightMarks(id);
      if (marks.length === 0) {
        const span = spans.find((item) => item.id === id);
        if (span) {
          const walk = (node) => {
            if (!node || node.nodeType !== 1) return;
            if (node.classList && node.classList.contains("md-comment") && node.dataset && node.dataset.start != null) {
              const start = Number(node.dataset.start);
              const end = Number(node.dataset.end);
              if (start >= span.interiorStart && end <= span.interiorEnd) {
                const rect = elementRect(node);
                if (rect) marks.push({ rect, pin: false });
              }
            }
            for (const child of node.childNodes || []) walk(child);
          };
          walk(root);
        }
      }
      if (marks.length === 0) return null;
      const pins = marks.filter((mark) => mark.pin);
      const use = pins.length > 0 ? pins : marks;
      let edge = null;
      for (const mark of use) {
        // The balloon's tip is the bottom of the pin. A highlight's anchor is its top.
        const at = mark.pin ? mark.rect.bottom : mark.rect.top;
        if (!Number.isFinite(at)) continue;
        if (edge == null || at < edge) edge = at;
      }
      if (edge == null || !Number.isFinite(asideRect.top)) return null;
      return edge - asideRect.top;
    };
    const anchors = cards.map((card) => anchorOf(card));
    const placed = [];
    const clearOf = (top, height) => {
      let next = top;
      for (let guard = placed.length + 1; guard > 0; guard -= 1) {
        let hit = null;
        for (const box of placed) {
          const limit = box.top + box.used + GAP;
          if (next < limit && next + height > box.top) {
            if (hit == null || limit > hit) hit = limit;
          }
        }
        if (hit == null) break;
        next = hit;
      }
      return next;
    };
    for (let i = 0; i < cards.length; i += 1) {
      const card = cards[i];
      const anchor = anchors[i];
      const home = anchor == null ? null : Math.max(menuFloor, anchor);
      let top = home == null ? floor : home;
      setStyle(card, "position", "absolute");
      setStyle(card, "left", "0px");
      setStyle(card, "width", "100%");
      setStyle(card, "margin", "0px");
      // offsetHeight reports the clamped box. Clear the clamp before measuring the card's own height.
      setStyle(card, "max-height", "");
      setStyle(card, "overflow", "");
      const natural = typeof card.offsetHeight === "number" ? card.offsetHeight : (elementRect(card)?.height || 0);
      top = clearOf(top, natural);
      let nextAnchor = null;
      for (let j = i + 1; j < anchors.length; j += 1) {
        if (anchors[j] != null) {
          nextAnchor = anchors[j];
          break;
        }
      }
      const current = card.classList && card.classList.contains("md-comment-current");
      let used = natural;
      if (!current && natural > SHORT && nextAnchor != null && (home == null || nextAnchor > home)) {
        const nextHome = Math.max(nextAnchor, menuFloor);
        const room = nextHome - top - GAP;
        if (natural + GAP > nextHome - top) used = Math.min(natural, SHORT, Math.max(GAP, room));
      }
      if (used < natural) {
        setStyle(card, "max-height", `${used}px`);
        setStyle(card, "overflow", "hidden");
      }
      setStyle(card, "top", `${top}px`);
      placed.push({ top, used });
      floor = Math.max(floor, top + used + GAP);
    }
    setStyle(commentsAside, "height", `${floor}px`);
  }

  function hideCommentButton() {
    if (addCommentButton) addCommentButton.hidden = true;
  }

  function listedRects(raw, wideOnly) {
    const rects = [];
    const count = raw && typeof raw.length === "number" ? raw.length : 0;
    for (let i = 0; i < count; i += 1) {
      const item = raw[i];
      if (!item || !(item.width > 0)) continue;
      if (!wideOnly && !(item.height > 0)) continue;
      rects.push(item);
    }
    return rects;
  }

  // The same measurement the placement test reads: the last line of the highlight,
  // the middle of its last character in text order, and that line's height.
  function highlightPlace(range) {
    if (!range || typeof range.getClientRects !== "function") return null;
    const rects = listedRects(range.getClientRects(), false);
    if (rects.length === 0) return null;
    let bottom = rects[0].bottom;
    for (const item of rects) if (item.bottom > bottom) bottom = item.bottom;
    let lastRect = null;
    for (const item of rects) {
      if (Math.abs(item.bottom - bottom) < 1) lastRect = item;
    }
    if (!lastRect || !Number.isFinite(lastRect.right) || !Number.isFinite(bottom)) return null;
    let glyph = null;
    const node = range.endContainer;
    const offset = range.endOffset;
    if (node && node.nodeType === 3 && offset > 0 && typeof document !== "undefined" && typeof document.createRange === "function") {
      try {
        const one = document.createRange();
        if (one && typeof one.setStart === "function" && typeof one.setEnd === "function" && typeof one.getClientRects === "function") {
          one.setStart(node, offset - 1);
          one.setEnd(node, offset);
          const found = listedRects(one.getClientRects(), true);
          if (found.length > 0) glyph = found[0];
        }
      } catch {
        glyph = null;
      }
    }
    const sample = glyph || lastRect;
    const middle = glyph && Number.isFinite(glyph.left) && Number.isFinite(glyph.right)
      ? (glyph.left + glyph.right) / 2
      : lastRect.right - 1;
    if (!Number.isFinite(middle)) return null;
    const holder = node && node.nodeType === 3 ? node.parentElement : node;
    const view = typeof window !== "undefined" ? window : null;
    let pitch = NaN;
    if (holder && view && typeof view.getComputedStyle === "function") {
      try {
        const style = view.getComputedStyle(holder);
        if (style) pitch = Number.parseFloat(style.lineHeight);
      } catch {
        pitch = NaN;
      }
    }
    if (!Number.isFinite(pitch) || pitch <= 0) {
      const h = sample && sample.height;
      pitch = Number.isFinite(h) ? h * 1.2 : 0;
    }
    return { bottom, middle, pitch };
  }

  function commentCardRects() {
    if (!commentsAside) return [];
    const cards = [];
    for (const child of commentsAside.childNodes || []) {
      if (!child || child.hidden || !child.classList || !child.classList.contains("md-comment-card")) continue;
      const rect = elementRect(child);
      if (!rect || !(rect.right > rect.left) || !(rect.bottom > rect.top)) continue;
      if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top)) continue;
      cards.push(rect);
    }
    return cards;
  }

  function boxesOverlap(left, top, width, height, rect) {
    return left < rect.right && left + width > rect.left && top < rect.bottom && top + height > rect.top;
  }

  // Keep the last character inside the button. Slide into the window when that
  // character is on screen and the button can fit, then sideways off any card.
  function buttonLeft(middle, width, top, height) {
    const view = typeof window !== "undefined" ? window : null;
    const viewW = view && Number.isFinite(view.innerWidth) && view.innerWidth > 0 ? view.innerWidth : null;
    let left = middle - (width > 0 ? width / 2 : 0);
    if (width > 0 && viewW != null) {
      const minLeft = Math.max(0, middle - width);
      const maxLeft = Math.min(middle, viewW - width);
      if (minLeft <= maxLeft) left = Math.min(maxLeft, Math.max(minLeft, left));
    }
    if (!(width > 0) || !(height > 0)) return left;
    const cards = commentCardRects();
    const seen = new Set();
    for (let guard = cards.length + 1; guard > 0; guard -= 1) {
      if (seen.has(left)) return left;
      seen.add(left);
      const hit = cards.filter((card) => boxesOverlap(left, top, width, height, card));
      if (hit.length === 0) return left;
      let best = null;
      let bestDist = Infinity;
      for (const card of hit) {
        for (const candidate of [card.left - width, card.right]) {
          if (!(candidate <= middle && middle <= candidate + width)) continue;
          if (viewW != null && !(candidate >= 0 && candidate + width <= viewW)) continue;
          const dist = Math.abs(candidate - left);
          if (dist < bestDist) {
            best = candidate;
            bestDist = dist;
          }
        }
      }
      if (best == null) return left;
      left = best;
    }
    return left;
  }

  function addSelectionComment() {
    const result = addComment(state.doc, state.anchor, state.cursor);
    if (!result) return;
    expectNewComment = true;
    const before = state.doc;
    emitEdit({ op: "comment.add", anchor: state.anchor, cursor: state.cursor });
    // A socket holds the edit until its doc message. Memory applies first,
    // so an unchanged mirror there means the add never happened.
    if (state.doc === before && (active.memory === true || !live)) expectNewComment = false;
  }

  function updateCommentButton() {
    if (closed || state.anchor === state.cursor) {
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
      addCommentButton.className = "md-add-comment icon-btn";
      if (typeof addCommentButton.setAttribute === "function") {
        addCommentButton.setAttribute("type", "button");
        addCommentButton.setAttribute("aria-label", "Add comment");
        addCommentButton.setAttribute("title", "Add comment");
      }
      const icon = strokeIcon(COMMENT_BALLOON);
      if (icon) addCommentButton.appendChild(icon);
      addCommentButton.hidden = true;
      host.appendChild(addCommentButton);
      addCommentButton.addEventListener("mousedown", (event) => {
        // A middle button pastes the primary selection. Cancelling that press
        // drops the paste, and only the primary button adds a comment.
        if (!event || event.button !== 0) return;
        event.preventDefault();
        addSelectionComment();
      }, { signal: ac.signal });
    }
    const sel = typeof window !== "undefined" && window.getSelection ? window.getSelection() : null;
    const range = sel && sel.rangeCount > 0 && typeof sel.getRangeAt === "function" ? sel.getRangeAt(0) : null;
    const place = highlightPlace(range);
    if (!place) {
      hideCommentButton();
      return;
    }
    addCommentButton.hidden = false;
    setStyle(addCommentButton, "position", "fixed");
    const width = Number(addCommentButton.offsetWidth);
    const height = Number(addCommentButton.offsetHeight);
    const boxW = Number.isFinite(width) && width > 0 ? width : 0;
    const boxH = Number.isFinite(height) && height > 0 ? height : 0;
    // Half a line under the highlight, so the selection line and the line above
    // still take a press. The text under the last character is the button's.
    const top = place.bottom + place.pitch / 2;
    const left = buttonLeft(place.middle, boxW, top, boxH);
    setStyle(addCommentButton, "left", `${left}px`);
    setStyle(addCommentButton, "top", `${top}px`);
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

  function isCommentAction(node) {
    if (!node || node.tagName !== "BUTTON" || typeof node.getAttribute !== "function") return false;
    const label = node.getAttribute("aria-label");
    return label === "Resolve" || label === "Reply" || label === "Delete" || label === "Copy link";
  }

  function setCommentActions(card, shown) {
    const walk = (node) => {
      if (!node) return;
      if (isCommentAction(node)) {
        if (shown) showElement(node);
        else hideElement(node);
      }
      for (const child of node.childNodes || []) walk(child);
    };
    walk(card);
  }

  // The clicked author node has to stay put, so the class and action buttons move on the live cards.
  function showCurrentCard(card) {
    if (!card || !card.dataset) return;
    currentCommentId = card.dataset.comment;
    markCurrentHighlights();
    if (!commentsAside) return;
    const walk = (node) => {
      if (!node) return;
      if (node.classList && node.classList.contains("md-comment-card")) {
        if (node === card) {
          node.classList.add("md-comment-current");
          setCommentActions(node, true);
        } else {
          node.classList.remove("md-comment-current");
          setCommentActions(node, false);
        }
      }
      for (const child of node.childNodes || []) walk(child);
    };
    walk(commentsAside);
    layoutComments();
  }

  function clearCurrentComment() {
    currentCommentId = null;
    if (commentsAside) {
      const walk = (node) => {
        if (!node) return;
        if (node.classList && node.classList.contains("md-comment-card")) setCommentActions(node, false);
        if (node.classList && node.classList.contains("md-comment-current")) node.classList.remove("md-comment-current");
        for (const child of node.childNodes || []) walk(child);
      };
      walk(commentsAside);
      layoutComments();
    }
    markCurrentHighlights();
  }

  function showCommentCurrent(id) {
    if (!id || !threadById(id)) return;
    const card = findCommentCard(id);
    if (card) {
      showCurrentCard(card);
      return;
    }
    // A resolved thread has no card while those stay hidden. The id still has to
    // stick so the next resolve can reopen it, and the previous card must not stay marked.
    currentCommentId = id;
    if (commentsAside) {
      const walk = (node) => {
        if (!node) return;
        if (node.classList && node.classList.contains("md-comment-card")) {
          node.classList.remove("md-comment-current");
          setCommentActions(node, false);
        }
        for (const child of node.childNodes || []) walk(child);
      };
      walk(commentsAside);
    }
    markCurrentHighlights();
  }

  // Resolve and delete belong to note id 0, the same note the hub checks.
  function firstNoteAuthor(id) {
    const thread = threadById(id);
    if (!thread) return "";
    const notes = parseCommentNotes(thread.body).filter((note) => note.id === 0);
    if (notes.length !== 1) return "";
    return splitCommentNote(notes[0].raw).author || "";
  }

  function sessionOwnsThread(id) {
    const author = firstNoteAuthor(id);
    return author !== "" && author === selfName();
  }

  function findCommentText(id, note) {
    if (!commentsAside) return null;
    const walk = (node) => {
      if (!node) return null;
      if (node.classList && node.classList.contains("md-comment-text") && node.dataset && node.dataset.comment === id) {
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

  // A reply or revision is typed in the note, so the document selection collapses.
  function parkForNote() {
    if (!vimOn) return;
    const at = state.cursor;
    if (state.anchor !== at) {
      state = { ...state, anchor: at, cursor: at };
      claimLines(at, at);
    }
    rememberVim({ ...vimSnapshot(), mode: "normal", input: emptyVimInput(), once: false });
  }

  // Ctrl-Enter leaves the note and returns to Normal in the document. The card stays current.
  function resumeAfterNote() {
    if (!vimOn) return;
    const at = state.cursor;
    if (state.anchor !== at) state = { ...state, anchor: at, cursor: at };
    rememberVim({ ...vimSnapshot(), mode: "normal", input: emptyVimInput(), once: false });
    restoreEditorFocus = true;
  }

  // The earliest note this session wrote. Note 0 is the resolve owner, which can be someone else.
  function reviseOwnNote(id) {
    const thread = threadById(id);
    if (!thread) return false;
    const me = selfName();
    if (!me) return false;
    const record = parseCommentNotes(thread.body).find((item) => splitCommentNote(item.raw).author === me);
    if (!record) return false;
    const text = findCommentText(id, record.id);
    if (!text) return false;
    parkForNote();
    openSavedNote(text);
    return true;
  }

  function typingCommentNote() {
    const active = typeof document !== "undefined" && document ? document.activeElement : null;
    return !!(active && active.classList && active.classList.contains("md-comment-body"));
  }

  // Letters stay document commands until a thread is current. While it is, and
  // the caret is not in a note, they are that card's actions.
  function takeThreadCommand(event) {
    if (!event || event.ctrlKey || event.metaKey || event.altKey) return false;
    if (typingCommentNote()) return false;
    const id = currentCommentId;
    if (!id || !threadById(id)) return false;
    const key = event.key;
    if (key === "r") { parkForNote(); onReply(id); return true; }
    if (key === "R") { clearVimPending(); if (sessionOwnsThread(id)) onResolve(id); return true; }
    if (key === "X") {
      if (!sessionOwnsThread(id)) { clearVimPending(); return true; }
      parkForNote();
      onDelete(id);
      return true;
    }
    if (key === "Y") { clearVimPending(); copyCommentLink(id); return true; }
    if (key === "i") { if (!reviseOwnNote(id)) clearVimPending(); return true; }
    return false;
  }

  function leaveCurrentComment() {
    clearCurrentComment();
    dispatchVimKey({ key: "Escape", ctrl: false, meta: false, alt: false, shift: false });
    focusEditor();
  }

  // Escape drops the unsaved reply or revision. Cancel on a fresh note deletes the thread, so this is not that path.
  function discardTypedNote(box) {
    endTypingRunLater();
    const id = box.dataset.comment;
    const index = Number(box.dataset.note);
    if (box.dataset.reply === "true") replyDrafts.delete(id);
    else {
      noteDrafts.delete(draftKey(id, index));
      editingNotes.delete(draftKey(id, index));
    }
    commentFocus = null;
    currentCommentId = null;
    const at = state.cursor;
    state = { ...state, anchor: at, cursor: at };
    if (vimOn) rememberVim({ ...vimSnapshot(), mode: "normal", input: emptyVimInput(), once: false });
    restoreEditorFocus = true;
    render();
    focusEditor();
  }

  function lockNames(block) {
    const start = Number(block.start);
    const end = Number(block.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
    const spans = lockSpans(state.doc);
    const names = [];
    for (const line of lockTable) {
      if (!line || typeof line.username !== "string" || line.username === "" || ownLock(line)) continue;
      const span = spans[line.index];
      if (!span) continue;
      const at = span.start;
      if (at >= start && at <= end) names.push(line.username);
    }
    return names;
  }

  // plan paints every comment span. The checkbox decides whether a resolved thread keeps that paint.
  function hideResolvedHighlights() {
    if (showResolved) return;
    const hidden = new Set();
    for (const comment of commentThreads(state.doc)) {
      if (comment && comment.resolved) hidden.add(comment.id);
    }
    if (hidden.size === 0) return;
    const walk = (node) => {
      if (!node) return;
      if (node.nodeType === 1 && node.classList && node.classList.contains("md-comment") && node.dataset && hidden.has(node.dataset.comment)) {
        node.classList.remove("md-comment");
      }
      for (const child of node.childNodes || []) walk(child);
    };
    walk(root);
  }

  function markCurrentHighlights() {
    const walk = (node) => {
      if (!node) return;
      if (node.nodeType === 1 && node.classList && node.classList.contains("md-comment")) {
        const id = node.dataset && node.dataset.comment;
        if (currentCommentId && id === currentCommentId) node.classList.add("md-comment-current");
        else node.classList.remove("md-comment-current");
      }
      for (const child of node.childNodes || []) walk(child);
    };
    walk(root);
  }

  function clearCommentHandles() {
    for (const child of childArray(root)) {
      if (child && child.classList && child.classList.contains("md-comment-handle")) detachNode(child);
    }
  }

  function commentHandleRects(id) {
    const rects = [];
    const walk = (node) => {
      if (!node) return;
      if (
        node.nodeType === 1
        && node.classList
        && node.classList.contains("md-comment")
        && node.dataset
        && node.dataset.comment === id
        && typeof node.getClientRects === "function"
      ) {
        let list = [];
        try {
          list = node.getClientRects() || [];
        } catch {
          list = [];
        }
        for (let i = 0; i < list.length; i += 1) {
          const rect = list[i];
          if (!rect || !(rect.width > 0) || !(rect.height > 0)) continue;
          if (!Number.isFinite(rect.left) || !Number.isFinite(rect.right) || !Number.isFinite(rect.top) || !Number.isFinite(rect.bottom)) continue;
          rects.push(rect);
        }
      }
      for (const child of node.childNodes || []) walk(child);
    };
    walk(root);
    return rects;
  }

  function edgePoints(rects) {
    let start = null;
    let end = null;
    for (const rect of rects) {
      const y = (rect.top + rect.bottom) / 2;
      if (!start || rect.top < start.top - 0.5 || (Math.abs(rect.top - start.top) <= 0.5 && rect.left < start.left)) {
        start = { x: rect.left, y, top: rect.top, left: rect.left };
      }
      if (!end || rect.bottom > end.bottom + 0.5 || (Math.abs(rect.bottom - end.bottom) <= 0.5 && rect.right > end.right)) {
        end = { x: rect.right, y, bottom: rect.bottom, right: rect.right };
      }
    }
    return { start, end };
  }

  function placeHandle(id, edge, boundary, x, y) {
    const el = document.createElement("span");
    el.className = "md-comment-handle";
    el.contentEditable = "false";
    el.draggable = false;
    el.setAttribute("aria-hidden", "true");
    el.dataset.comment = id;
    el.dataset.edge = edge;
    el.dataset.start = String(boundary);
    el.dataset.end = String(boundary);
    setStyle(el, "left", `${x}px`);
    setStyle(el, "top", `${y}px`);
    root.appendChild(el);
    return el;
  }

  function showCommentHandles(id) {
    if (handleDrag) return;
    clearCommentHandles();
    if (!id) return;
    const spans = findSpans(state.doc).filter((span) => span.id === id);
    if (spans.length !== 1) return;
    const rects = commentHandleRects(id);
    if (rects.length === 0) return;
    const points = edgePoints(rects);
    if (!points.start || !points.end) return;
    placeHandle(id, "start", spans[0].interiorStart, points.start.x, points.start.y);
    placeHandle(id, "end", spans[0].interiorEnd, points.end.x, points.end.y);
  }

  function commentUnderPointer(event) {
    const node = event && event.target;
    const el = node && node.nodeType === 1 ? node : node && node.parentElement;
    if (!el || typeof el.closest !== "function") return null;
    const handle = el.closest(".md-comment-handle");
    if (handle && root.contains(handle)) return (handle.dataset && handle.dataset.comment) || null;
    const highlighted = el.closest(".md-comment");
    if (!highlighted || !root.contains(highlighted) || !highlighted.dataset) return null;
    return highlighted.dataset.comment || null;
  }

  function moveDraggedHandle(event) {
    if (!handleDrag || !handleDrag.handle) return;
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    handleDrag.handle.classList.add("md-comment-handle-dragging");
    setStyle(handleDrag.handle, "left", `${event.clientX}px`);
    setStyle(handleDrag.handle, "top", `${event.clientY}px`);
  }

  // The drawn comment is the one a release at this offset would store. The bytes
  // stay until mouseup, so a refused release can put the stored range back.
  function commentCoveringRange(spans, start, end) {
    let best = null;
    let bestSize = Infinity;
    let bestAt = Infinity;
    for (const span of spans) {
      if (!(start >= span.interiorStart && end <= span.interiorEnd)) continue;
      if (!(span.interiorStart < span.interiorEnd)) continue;
      const size = span.interiorEnd - span.interiorStart;
      if (size < bestSize || (size === bestSize && span.interiorStart < bestAt)) {
        best = span;
        bestSize = size;
        bestAt = span.interiorStart;
      }
    }
    return best ? best.id : null;
  }

  function setRunComment(el, id) {
    if (!el || !el.classList) return;
    el.classList.remove("md-comment-current");
    el.classList.remove("md-comment-editing");
    if (id) {
      el.classList.add("md-comment");
      if (el.dataset) el.dataset.comment = id;
      return;
    }
    el.classList.remove("md-comment");
    if (el.dataset && el.dataset.comment) delete el.dataset.comment;
  }

  function dragLeaves() {
    const out = [];
    const skip = (node) => hasClass(node, "md-comment-handle")
      || hasClass(node, "md-comment-marker")
      || hasClass(node, "md-view-toggle")
      || hasClass(node, "md-doc-menu")
      || hasClass(node, "md-doc-menu-panel")
      || hasClass(node, "md-lock");
    const walk = (node) => {
      if (!node || node.nodeType !== 1 || skip(node)) return;
      if (hasClass(node, "md-atom")) {
        out.push(node);
        return;
      }
      const children = childArray(node);
      const start = node.dataset && node.dataset.start != null && node.dataset.start !== "" ? Number(node.dataset.start) : NaN;
      const end = node.dataset && node.dataset.end != null && node.dataset.end !== "" ? Number(node.dataset.end) : NaN;
      if (Number.isFinite(start) && end > start && children.length === 1 && children[0].nodeType === 3) {
        const text = String(children[0].textContent || "");
        if (text.length === end - start) {
          out.push(node);
          return;
        }
      }
      for (const child of children) walk(child);
    };
    for (const child of childArray(root)) walk(child);
    return out;
  }

  function retintLeaf(el, spans, mapOffset) {
    if (hasClass(el, "md-atom")) {
      const start = Number(el.dataset.start);
      const end = Number(el.dataset.end);
      if (!(end > start)) return;
      const from = mapOffset(start);
      const to = mapOffset(end);
      if (to - from !== end - start) return;
      setRunComment(el, commentCoveringRange(spans, from, to));
      return;
    }
    const start = Number(el.dataset.start);
    const end = Number(el.dataset.end);
    if (!(end > start)) return;
    const parts = [];
    let at = start;
    while (at < end) {
      const id = commentCoveringRange(spans, mapOffset(at), mapOffset(at) + 1);
      let next = at + 1;
      while (next < end && commentCoveringRange(spans, mapOffset(next), mapOffset(next) + 1) === id) next += 1;
      parts.push({ at, next, id });
      at = next;
    }
    if (parts.length === 1) {
      setRunComment(el, parts[0].id);
      return;
    }
    let node = el;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (i === parts.length - 1) {
        setRunComment(node, part.id);
        break;
      }
      const head = splitMarkerRun(node, part.next - part.at);
      placeNodeBefore(node.parentElement, head, node);
      setRunComment(head, part.id);
    }
  }

  function paintCommentDrag(drag, shift) {
    if (!drag) return;
    const doc = shift ? shift.preview : state.doc;
    const mapOffset = shift ? (offset) => shift.storedToPreview(offset) : (offset) => offset;
    const spans = findSpans(doc);
    // The marker stays where it was drawn. It has no width, and moving that
    // element shifts the caret hit onto the previous character.
    for (const leaf of dragLeaves()) retintLeaf(leaf, spans, mapOffset);
    markEditingHighlights();
    markCurrentHighlights();
  }

  function refreshDragHighlight(event) {
    if (!handleDrag) return;
    if (!handleDragMoved(handleDrag, event)) {
      if (handleDrag.paintKey) {
        handleDrag.paintKey = "";
        paintCommentDrag(handleDrag, null);
      }
      return;
    }
    const glyph = offsetAtDragGlyph(event);
    const dest = glyph != null ? glyph : pointOffset(event);
    const shift = dest == null ? null : commentDragPreview(state.doc, handleDrag.id, handleDrag.edge, dest);
    const key = shift ? `${shift.move.from}\0${shift.move.to}\0${shift.move.text}` : "";
    handleDrag.paintX = event.clientX;
    handleDrag.paintY = event.clientY;
    handleDrag.paintShift = shift;
    if (key === handleDrag.paintKey) return;
    handleDrag.paintKey = key;
    paintCommentDrag(handleDrag, shift);
  }

  // Splitting a run for the preview moves the caret hit onto the previous
  // character. The boxes are the glyphs from when the drag began. The left half
  // of a glyph is the boundary before it, and the right half is the boundary
  // after it, where a click there puts the caret.
  function offsetAtDragGlyph(event) {
    const slots = handleDrag && handleDrag.slots;
    if (!slots || !event || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return null;
    let best = null;
    let bestDy = Infinity;
    for (const slot of slots) {
      if (!slot || slot.bare) continue;
      if (event.clientX < slot.left || event.clientX >= slot.right) continue;
      const dy = Math.abs(event.clientY - slot.mid);
      if (dy >= bestDy) continue;
      best = slot;
      bestDy = dy;
    }
    if (!best || bestDy > 12) return null;
    const mid = (best.left + best.right) / 2;
    return event.clientX < mid ? best.offset : best.offset + 1;
  }

  // The preview split can put the release on the previous character. The edit is
  // the range already drawn at this pointer.
  function drawnDragShift(drag, event) {
    if (!drag || !event || !Number.isFinite(drag.paintX) || !Number.isFinite(drag.paintY)) return undefined;
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return undefined;
    if (Math.abs(event.clientX - drag.paintX) >= 1 || Math.abs(event.clientY - drag.paintY) >= 1) return undefined;
    return drag.paintShift || null;
  }

  function handleDragMoved(drag, event) {
    if (!drag || !event || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return true;
    if (!Number.isFinite(drag.x) || !Number.isFinite(drag.y)) return true;
    return Math.abs(event.clientX - drag.x) > 3 || Math.abs(event.clientY - drag.y) > 3;
  }

  function finishHandleDrag(event) {
    const drag = handleDrag;
    handleDrag = null;
    if (event && typeof event.preventDefault === "function") event.preventDefault();
    // The dragged handle sits under the pointer. Hide it before the hit test so
    // the boundary comes from the text, or from the handle that stayed put.
    if (drag && drag.handle) setStyle(drag.handle, "display", "none");
    const dest = pointOffset(event);
    // preventDefault on the press stops the click, so a press that stays put
    // places the caret here. The handle covers the boundary the click aimed at.
    if (!handleDragMoved(drag, event)) {
      if (drag && drag.paintKey) paintCommentDrag(drag, null);
      if (typeof root.focus === "function") root.focus();
      didDrag = true;
      gestureArmed = false;
      gestureOffset = null;
      if (dest != null) {
        gestureHold = true;
        state = { ...state, anchor: dest, cursor: dest };
        if (claimLines(dest, dest)) {
          render();
          return;
        }
        gestureHold = false;
      }
      if (hoverCommentId) showCommentHandles(hoverCommentId);
      return;
    }
    didDrag = true;
    const drawn = drawnDragShift(drag, event);
    const shift = drawn !== undefined ? drawn : (drag && dest != null ? commentDragPreview(state.doc, drag.id, drag.edge, dest) : null);
    if (drag && drawn === undefined) paintCommentDrag(drag, shift);
    if (!shift) {
      if (hoverCommentId) showCommentHandles(hoverCommentId);
      return;
    }
    emitEdit({ op: "insert", text: shift.move.text, anchor: shift.move.from, cursor: shift.move.to });
  }

  function pressedCommentMarker(event) {
    const node = event && event.target;
    const el = node && node.nodeType === 1 ? node : node && node.parentElement;
    if (!el || typeof el.closest !== "function") return null;
    const marker = el.closest(".md-comment-marker");
    if (!marker || !root.contains(marker)) return null;
    const start = Number(marker.dataset && marker.dataset.start);
    const end = Number(marker.dataset && marker.dataset.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    return { start, end };
  }

  function beginHandleDrag(event) {
    if (!event || (typeof event.button === "number" && event.button !== 0)) return false;
    const node = event.target;
    const el = node && node.nodeType === 1 ? node : node && node.parentElement;
    if (!el || typeof el.closest !== "function") return false;
    const handle = el.closest(".md-comment-handle");
    if (!handle || !root.contains(handle)) return false;
    const id = handle.dataset && handle.dataset.comment;
    const edge = handle.dataset && handle.dataset.edge;
    if (!id || (edge !== "start" && edge !== "end")) return false;
    // The second press of a double-click can land on a handle the first press
    // just showed. That press selects the word under the first press.
    if (event.detail === 2) {
      if (typeof root.focus === "function") root.focus();
      return false;
    }
    if (typeof event.preventDefault === "function") event.preventDefault();
    if (typeof root.focus === "function") root.focus();
    commentFocus = null;
    goalX = null;
    pointer = null;
    didDrag = false;
    dragRange = null;
    dragSource = null;
    cancelGestureRender();
    gestureArmed = false;
    gestureOffset = null;
    const slots = rawLayoutSlots();
    handleDrag = { id, edge, handle, x: event.clientX, y: event.clientY, paintKey: "", slots: slots.length ? slots : null };
    handle.classList.add("md-comment-handle-dragging");
    setStyle(handle, "pointer-events", "none");
    return true;
  }

  // The tip is this fraction of the picture. Past the picture, the tip stays on the edge.
  function pictureFraction(host, clientX, clientY) {
    const picture = drawnPicture(host);
    if (!picture || typeof picture.getBoundingClientRect !== "function") return null;
    const rect = picture.getBoundingClientRect();
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    return {
      x: Math.min(1, Math.max(0, x)),
      y: Math.min(1, Math.max(0, y)),
    };
  }

  function pinDragMoved(move, event) {
    if (!move || !event || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return false;
    if (!Number.isFinite(move.x) || !Number.isFinite(move.y)) return true;
    return Math.abs(event.clientX - move.x) > 3 || Math.abs(event.clientY - move.y) > 3;
  }

  function placeDraggedPin(pin, point) {
    if (!pin || !point) return;
    // left and top percentages belong to the dragged marker, not the corner control.
    if (hasClass(pin, "md-pin-corner")) return;
    if (pin.classList) pin.classList.add("md-comment-pin-dragging");
    setStyle(pin, "left", `${point.x * 100}%`);
    setStyle(pin, "top", `${point.y * 100}%`);
  }

  function movePinDrag(event) {
    if (!pinMove || !pinDragMoved(pinMove, event)) return;
    const point = pictureFraction(pinMove.host, event.clientX, event.clientY);
    if (!point) return;
    placeDraggedPin(pinMove.pin, point);
    pinMove.point = point;
  }

  // One host for a picture and a diagram. The fraction is of the drawn box.
  function pinPictureHost(pin) {
    if (!pin || typeof pin.closest !== "function") return null;
    const image = pin.closest(".md-image");
    if (image) return image;
    return pin.closest(".md-diagram");
  }

  function beginPinDrag(event) {
    if (!event || (typeof event.button === "number" && event.button !== 0)) return false;
    const node = event.target;
    const el = node && node.nodeType === 1 ? node : node && node.parentElement;
    if (!el || typeof el.closest !== "function") return false;
    const pin = el.closest(".md-comment-pin");
    if (!pin || !root.contains(pin)) return false;
    const host = pinPictureHost(pin);
    if (!host || hasClass(host, "md-raw") || (typeof host.closest === "function" && host.closest(".md-raw"))) return false;
    if (!pictureFraction(host, event.clientX, event.clientY)) return false;
    if (typeof event.preventDefault === "function") event.preventDefault();
    commentFocus = null;
    goalX = null;
    pointer = null;
    didDrag = false;
    plainDrag = false;
    dragRange = null;
    dragSource = null;
    cancelGestureRender();
    gestureArmed = false;
    gestureOffset = null;
    pinMove = {
      id: pin.dataset && pin.dataset.comment,
      pin,
      host,
      x: event.clientX,
      y: event.clientY,
    };
    return true;
  }

  function finishPinDrag(event) {
    const move = pinMove;
    pinMove = null;
    if (!move) return;
    rememberPointer(event);
    if (event && typeof event.preventDefault === "function") event.preventDefault();
    if (move.pin && move.pin.classList) move.pin.classList.remove("md-comment-pin-dragging");
    if (!pinDragMoved(move, event)) return;
    const node = event && event.target;
    if (node && root.contains(node)) {
      didDrag = true;
      plainDrag = false;
      gestureArmed = false;
      gestureOffset = null;
    }
    const point = pictureFraction(move.host, event.clientX, event.clientY) || move.point;
    if (!point || !move.id) return;
    pinScrollHold = captureScroll();
    emitEdit({ op: "comment.pin.move", id: move.id, x: point.x, y: point.y });
  }

  function removeCornerPin() {
    if (cornerFrame) {
      const pin = findClassChild(cornerFrame, "md-pin-corner");
      if (pin) detachNode(pin);
    }
    for (const el of elementsWithClass("md-pin-corner")) detachNode(el);
    cornerFrame = null;
  }

  function showCornerPin(frame) {
    removeCornerPin();
    if (!frame) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "md-pin-corner icon-btn";
    button.draggable = true;
    button.tabIndex = -1;
    if (typeof button.setAttribute === "function") {
      button.setAttribute("type", "button");
      button.setAttribute("aria-label", "Comment pin");
      button.setAttribute("draggable", "true");
      button.setAttribute("tabindex", "-1");
    }
    const icon = strokeIcon(COMMENT_BALLOON);
    if (icon) button.appendChild(icon);
    // A press here is a drag, not a caret move. preventDefault would cancel the drag.
    button.addEventListener("mousedown", (event) => {
      if (event && typeof event.stopPropagation === "function") event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      if (event && typeof event.stopPropagation === "function") event.stopPropagation();
    });
    button.addEventListener("keydown", (event) => {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
    });
    button.addEventListener("dragstart", (event) => {
      pinDrag = true;
      dragSource = null;
      dragRange = null;
      if (event && typeof event.stopPropagation === "function") event.stopPropagation();
      const data = event && event.dataTransfer;
      if (!data || typeof data.setData !== "function") return;
      try {
        data.setData("text/viewmark-pin", "pin");
        data.effectAllowed = "copy";
      } catch {
        // A drag double may reject writes.
      }
    });
    button.addEventListener("dragend", () => {
      pinDrag = false;
      removeCornerPin();
    });
    frame.appendChild(button);
    cornerFrame = frame;
    placeCornerOnPicture(frame);
  }

  function rememberPointer(event) {
    if (!event || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    pointerAt = { x: event.clientX, y: event.clientY };
  }

  // Same box pictureFraction uses. Outside that box is not a hit: a fraction clamps, this does not.
  function pointerOnDrawn(host, clientX, clientY) {
    const picture = drawnPicture(host);
    if (!picture || typeof picture.getBoundingClientRect !== "function") return false;
    const rect = picture.getBoundingClientRect();
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) return false;
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return false;
    return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  }

  function hostForPointer(clientX, clientY) {
    let found = null;
    for (const host of [...elementsWithClass("md-image"), ...elementsWithClass("md-diagram")]) {
      if (hasClass(host, "md-raw") || (typeof host.closest === "function" && host.closest(".md-raw"))) continue;
      if (pointerOnDrawn(host, clientX, clientY)) found = host;
    }
    return found;
  }

  // The frame is the diagram block, or the source pre, when that is wider than the drawing.
  // The corner sits on the drawn picture, not on the frame's right edge.
  function placeCornerOnPicture(frame) {
    const button = findClassChild(frame, "md-pin-corner");
    const picture = drawnPicture(frame && frame.parentElement);
    if (!button || !picture) return;
    if (typeof picture.getBoundingClientRect !== "function" || typeof frame.getBoundingClientRect !== "function") return;
    const pic = picture.getBoundingClientRect();
    const box = frame.getBoundingClientRect();
    if (!pic || !box || !(pic.width > 0) || !(pic.height > 0) || !(box.width > 0) || !(box.height > 0)) return;
    setStyle(button, "top", `${pic.top - box.top}px`);
    setStyle(button, "right", `${box.right - pic.right}px`);
    setStyle(button, "left", "auto");
  }

  function restoreCornerPin() {
    if (closed || pinDrag || pinMove || !pointerAt) return;
    const host = hostForPointer(pointerAt.x, pointerAt.y);
    const frame = host ? pictureFrame(host) : null;
    if (!frame) {
      removeCornerPin();
      return;
    }
    if (frame === cornerFrame && findClassChild(frame, "md-pin-corner")) {
      placeCornerOnPicture(frame);
      return;
    }
    showCornerPin(frame);
  }

  function restoreCornerAfterDiagram() {
    restoreCornerPin();
    const view = typeof window !== "undefined" ? window : null;
    if (!view || typeof view.requestAnimationFrame !== "function") return;
    view.requestAnimationFrame(() => {
      if (!closed) restoreCornerPin();
    });
  }

  function syncCornerPin(event) {
    if (pinDrag) return;
    const target = event && event.target;
    const node = target && target.nodeType === 1 ? target : target && target.parentElement;
    const frame = frameUnderPointer(node);
    if (frame && frame === cornerFrame && findClassChild(frame, "md-pin-corner")) {
      placeCornerOnPicture(frame);
      return;
    }
    if (!frame) {
      removeCornerPin();
      return;
    }
    showCornerPin(frame);
  }

  function onRootMouseMove(event) {
    rememberPointer(event);
    if (pinMove) {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      movePinDrag(event);
      return;
    }
    if (!pinDrag) syncCornerPin(event);
    if (handleDrag) {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      moveDraggedHandle(event);
      refreshDragHighlight(event);
      return;
    }
    if (pointer) return;
    // A marker-only selection is dragged from the marker box. The handle sits
    // on that same edge, so it would take the press and the browser would not drag.
    const markerLo = Math.min(state.anchor, state.cursor);
    const markerHi = Math.max(state.anchor, state.cursor);
    if (coveredOnlyByMarkers(state.doc, markerLo, markerHi)) {
      if (hoverCommentId) {
        hoverCommentId = null;
        clearCommentHandles();
      }
      return;
    }
    const id = commentUnderPointer(event);
    if (id === hoverCommentId) return;
    hoverCommentId = id;
    if (id) showCommentHandles(id);
    else clearCommentHandles();
  }

  function onDocumentMouseMove(event) {
    rememberPointer(event);
    const node = event && event.target;
    const inside = node && root.contains(node);
    if (pinMove) {
      if (inside) return;
      movePinDrag(event);
      return;
    }
    if (!inside && !pinDrag) removeCornerPin();
    if (handleDrag) {
      if (inside) return;
      moveDraggedHandle(event);
      refreshDragHighlight(event);
      return;
    }
    if (pointer) return;
    if (inside) return;
    if (!hoverCommentId) return;
    hoverCommentId = null;
    clearCommentHandles();
  }

  function onDocumentMouseUp(event) {
    if (pinMove) {
      const node = event && event.target;
      if (node && root.contains(node)) return;
      finishPinDrag(event);
      return;
    }
    if (handleDrag) {
      const node = event && event.target;
      if (node && root.contains(node)) return;
      finishHandleDrag(event);
      return;
    }
    // The add-comment button sits on the text under the selection. A release
    // there is not an editor event, and the click is not one either.
    if (!pointer) return;
    const node = event && event.target;
    if (node && root.contains(node)) return;
    finishTextDrag(event, true);
    scheduleLinkTabSettle();
  }

  function appendLockMarks(el, block) {
    for (const name of lockNames(block)) {
      const mark = document.createElement("span");
      mark.className = "md-lock";
      if (refusal && refusal.name === name) mark.classList.add("md-flash");
      mark.contentEditable = "false";
      mark.textContent = name;
      el.appendChild(mark);
    }
  }

  function stripLockMarks(el) {
    const doomed = [];
    for (const child of el.childNodes || []) {
      if (child.classList && child.classList.contains("md-lock")) doomed.push(child);
    }
    for (const mark of doomed) detachNode(mark);
  }

  // A locks message names holders. The bytes did not change, so the nodes stay.
  function refreshLockMarks() {
    const blocks = sourceMode ? sourceLines(state.doc) : plan(state.doc, state.cursor).blocks;
    const children = [];
    for (const child of root.childNodes || []) {
      if (hasClass(child, "md-line") || hasClass(child, "md-atom")) children.push(child);
    }
    const count = Math.min(blocks.length, children.length);
    for (let i = 0; i < count; i += 1) {
      stripLockMarks(children[i]);
      appendLockMarks(children[i], blocks[i]);
    }
  }

  // A non-collapsed selection can begin on a marker the cursor line does not open.
  function blocksWithSelectionSource(blocks) {
    const from = Math.min(state.anchor, state.cursor);
    const to = Math.max(state.anchor, state.cursor);
    if (from === to) return blocks;
    return blocks.map((block) => {
      if (!block || block.type !== "line" || block.raw || block.empty) return block;
      if (!(block.start < to && block.end > from)) return block;
      const opened = plan(state.doc, block.start).blocks.find((item) => item && item.type === "line" && item.start === block.start);
      return opened && opened.raw ? opened : block;
    });
  }

  // The empty line after a final newline exists only while the caret is on it.
  // A fence's trail would leave this row a half line below the letter that lands here.
  function blocksForCaret(blocks) {
    const doc = state.doc;
    if (state.cursor !== doc.length || !doc.endsWith("\n")) return blocks;
    return blocks.concat([{
      type: "line",
      raw: true,
      empty: true,
      start: doc.length,
      end: doc.length,
      text: "",
      classes: ["md-raw", "md-p", "md-caret-row"],
      runs: [],
      parts: [],
      indent: 0,
    }]);
  }

  // Canvas measureText ignores tab-size, so a nested marker would hang short of the gutter.
  function markerWidth(ctx, marker, stop) {
    if (!Number.isFinite(stop) || stop <= 0 || !marker.includes("\t")) return ctx.measureText(marker).width;
    let x = 0;
    let chunk = "";
    const flush = () => {
      if (!chunk) return;
      x += ctx.measureText(chunk).width;
      chunk = "";
    };
    for (const ch of marker) {
      if (ch !== "\t") {
        chunk += ch;
        continue;
      }
      flush();
      x = (Math.floor(x / stop) + 1) * stop;
    }
    flush();
    return x;
  }

  // Same gutter as `.md-li` / `.md-ol`: 1.3em plus one ch per indent column.
  function listGutter(fontSize, indent, ch) {
    const columns = Number.isFinite(indent) ? indent : 0;
    const step = Number.isFinite(ch) && ch > 0 ? ch : 0;
    return 1.3 * fontSize + columns * step;
  }

  function hangRawMarker(el, marker, indent) {
    if (!marker) return;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext && canvas.getContext("2d");
    if (!ctx || typeof ctx.measureText !== "function") return;
    const style = readComputedStyle(root);
    if (!style || !style.font) return;
    ctx.font = style.font;
    const fontSize = cssPx(style.fontSize || style.font);
    if (!(fontSize > 0)) return;
    const tabRaw = style.tabSize != null && style.tabSize !== "" ? String(style.tabSize).trim() : "4";
    const tabN = Number.parseFloat(tabRaw);
    const space = ctx.measureText(" ").width;
    const stop = tabRaw.endsWith("px") ? tabN : space * (Number.isFinite(tabN) && tabN > 0 && !/[a-z%]/i.test(tabRaw) ? tabN : 4);
    const width = markerWidth(ctx, marker, stop);
    if (!Number.isFinite(width) || width <= 0) return;
    const hang = takeRawMarker(el, marker);
    if (!hang) return;
    const gutter = listGutter(fontSize, indent, ctx.measureText("0").width);
    if (!(gutter > 0)) return;
    placeHang(el, hang, gutter, width, space);
  }

  // A marker that fits the gutter starts on the paragraph column, so a letter
  // typed into it stays on the caret when the line stops being a list. A wider
  // marker hangs further left until its right edge meets the item text. The
  // line's text-indent moves the glyphs and Chromium's caret together; a
  // negative margin would leave the caret on the content edge. Slack after a
  // short marker is a sibling space, so the item text stays on the closed
  // column and the marker box ends before that text.
  function placeHang(el, hang, gutter, width, space) {
    const shift = Math.max(gutter, width);
    const slack = shift - width;
    el.style.marginLeft = `${gutter - shift}px`;
    el.style.paddingLeft = `${shift}px`;
    el.style.textIndent = `-${shift}px`;
    // The painted caret is the left edge of the device pixel that contains it.
    // One pixel of tracking keeps a letter typed into a short marker on that pixel.
    const markerText = String(hang.textContent || "");
    // A tab stop does not grow by letter-spacing, so tracking stays off those markers.
    const chars = markerText.includes("\t") ? 0 : markerText.length;
    const tracking = chars > 0 && slack - chars > 1.25 && space > 0 ? 1 : 0;
    hang.style.letterSpacing = tracking ? "1px" : "";
    const gapSlack = slack - tracking * chars;
    if (gapSlack > 0.25 && space > 0) {
      const gap = ensureRawGap(el, hang);
      gap.style.whiteSpace = "pre";
      gap.style.letterSpacing = `${gapSlack - space}px`;
      tagRawGap(gap, markerEndOf(hang));
    } else removeRawGap(el);
  }

  function markerEndOf(hang) {
    let end = NaN;
    const walk = (node) => {
      if (!node || node.nodeType !== 1) return;
      const raw = node.dataset && node.dataset.end;
      const value = raw != null && raw !== "" ? Number(raw) : NaN;
      if (Number.isFinite(value) && !(end > value)) end = value;
      for (const child of childArray(node)) walk(child);
    };
    walk(hang);
    return end;
  }

  function tagRawGap(gap, end) {
    if (!gap || !Number.isFinite(end)) return;
    gap.dataset.start = String(end);
    gap.dataset.end = String(end);
  }

  function ensureRawGap(el, hang) {
    const kids = childArray(el);
    const index = kids.indexOf(hang);
    const next = index >= 0 ? kids[index + 1] : null;
    if (next && hasClass(next, "md-raw-gap")) return next;
    const gap = document.createElement("span");
    gap.className = "md-raw-gap";
    gap.appendChild(document.createTextNode(" "));
    placeAfter(el, hang, gap);
    return gap;
  }

  function removeRawGap(el) {
    const gap = findClassChild(el, "md-raw-gap");
    if (gap) detachNode(gap);
  }

  // Canvas space is not the used space. Letter-spacing has to match the laid-out one.
  function usedSpaceWidth(line) {
    const probe = document.createElement("span");
    probe.style.whiteSpace = "pre";
    probe.appendChild(document.createTextNode(" "));
    line.appendChild(probe);
    const width = typeof probe.getBoundingClientRect === "function" ? probe.getBoundingClientRect().width : 0;
    detachNode(probe);
    return width;
  }

  // Canvas ch is not the used ch. Once the line is in the document, size the
  // gutter from the used font and a 1ch probe, and the slack from the marker's laid-out width.
  function settleRawMarkers() {
    for (const line of childArray(root)) {
      if (!line || !line.classList || !line.classList.contains("md-raw") || line.classList.contains("md-quote")) continue;
      if (!line.classList.contains("md-li") && !line.classList.contains("md-ol")) continue;
      const hang = findClassChild(line, "md-raw-hang");
      if (!hang || typeof hang.getBoundingClientRect !== "function") continue;
      const computed = readComputedStyle(line);
      if (!computed || typeof computed.getPropertyValue !== "function") continue;
      const fontSize = cssPx(computed.fontSize);
      if (!(fontSize > 0)) continue;
      const indent = cssPx(computed.getPropertyValue("--indent"));
      let ch = 0;
      if (indent > 0) {
        const probe = document.createElement("span");
        probe.style.display = "inline-block";
        probe.style.width = "1ch";
        probe.style.padding = "0";
        probe.style.border = "0";
        line.appendChild(probe);
        ch = probe.getBoundingClientRect().width;
        detachNode(probe);
      }
      const gutter = listGutter(fontSize, indent, ch);
      if (!(gutter > 0)) continue;
      const space = usedSpaceWidth(line);
      // Letter-spacing is tracking, not part of the marker's own width.
      hang.style.letterSpacing = "0px";
      const width = hang.getBoundingClientRect().width;
      if (!(width > 0)) continue;
      placeHang(line, hang, gutter, width, space);
      const applied = hang.style.letterSpacing;
      hang.style.letterSpacing = "0px";
      const shifted = hang.getBoundingClientRect().width;
      if (shifted > 0 && Math.abs(shifted - width) >= 0.25) placeHang(line, hang, gutter, shifted, space);
      else hang.style.letterSpacing = applied;
    }
  }

  // The row after a list hard break is not itself a list line, so it has no
  // gutter. The next letter joins the item and is drawn on the item text. The
  // line box has to move with the caret: padding would leave this box on the
  // content edge, and the caret would no longer sit on the box the offset owns.
  function listBreakIndent(blocks, index) {
    const block = blocks[index];
    if (!block || block.type !== "line" || !block.empty) return null;
    const prev = blocks[index - 1];
    if (!prev || prev.type !== "line") return null;
    const classes = prev.classes || [];
    if (classes.includes("md-quote")) return null;
    if (!classes.includes("md-li") && !classes.includes("md-ol")) return null;
    const parts = prev.parts || [];
    const last = parts[parts.length - 1];
    if (!last || last.type !== "break" || block.start !== last.end) return null;
    return Number.isFinite(prev.indent) ? prev.indent : 0;
  }

  function settleListContinuations(blocks) {
    const indentAt = new Map();
    for (let i = 0; i < blocks.length; i += 1) {
      const indent = listBreakIndent(blocks, i);
      if (indent == null) continue;
      indentAt.set(blocks[i].start, indent);
    }
    if (indentAt.size === 0) return;
    for (const line of childArray(root)) {
      if (!line || !line.classList || !line.classList.contains("md-line") || !line.style) continue;
      const start = Number(line.dataset && line.dataset.start);
      if (!indentAt.has(start)) continue;
      // A gap keeps the item's trail. This row is the caret, and the next letter
      // is drawn on the item, so the trail must not sit between them.
      if (line.classList.contains("md-raw") && !line.classList.contains("md-paragraph-gap")) {
        line.classList.add("md-list-cont");
      }
      const indent = indentAt.get(start);
      const computed = readComputedStyle(line);
      if (!computed) continue;
      const fontSize = cssPx(computed.fontSize);
      if (!(fontSize > 0)) continue;
      let ch = 0;
      if (indent > 0) {
        const probe = document.createElement("span");
        probe.style.display = "inline-block";
        probe.style.width = "1ch";
        probe.style.padding = "0";
        probe.style.border = "0";
        line.appendChild(probe);
        if (typeof probe.getBoundingClientRect === "function") {
          const width = probe.getBoundingClientRect().width;
          if (width > 0) ch = width;
        }
        detachNode(probe);
      }
      const gutter = listGutter(fontSize, indent, ch);
      if (!(gutter > 0)) continue;
      line.style.marginLeft = `${gutter}px`;
    }
  }

  function syncSourceClass() {
    if (!root.classList) return;
    if (sourceMode) root.classList.add("md-source");
    else root.classList.remove("md-source");
  }

  function syncVimCaret() {
    if (!root || !root.classList) return;
    if (vimOn && vimDrawsBlockCaret(vimMode)) root.classList.add("md-vim-block");
    else root.classList.remove("md-vim-block");
    syncVimBlockMark();
  }

  // Firefox does not implement caret-shape, so the native caret stays a bar.
  function caretShapeBlockSupported() {
    try {
      const css = globalThis.CSS;
      return !!(css && typeof css.supports === "function" && css.supports("caret-shape", "block") === true);
    } catch {
      return false;
    }
  }

  function editorHasFocus() {
    if (vimPrompt != null) return false;
    try {
      if (typeof document === "undefined" || !document || !root) return false;
      const active = document.activeElement;
      if (!active) return false;
      if (active === root) return true;
      return typeof root.contains === "function" && root.contains(active) === true;
    } catch {
      return false;
    }
  }

  function vimBlockFallback() {
    if (closed || !root || !root.classList || !root.classList.contains("md-vim-block")) return false;
    if (caretShapeBlockSupported()) return false;
    return editorHasFocus();
  }

  function clearVimBlockCaret() {
    if (!vimBlockCaretHidden) return;
    vimBlockCaretHidden = false;
    if (!root || !root.style) return;
    if (typeof root.style.removeProperty === "function") {
      try {
        root.style.removeProperty("caret-color");
      } catch {
        // The inline color is already gone. The stylesheet caret shows.
      }
    }
    if (root.styleProps) delete root.styleProps["caret-color"];
  }

  function hideVimBlockMark() {
    clearVimBlockCaret();
    if (vimBlockMark) detachNode(vimBlockMark);
  }

  // replaceChildren drops anything parked in the editor, so the mark lives on the body.
  function ensureVimBlockMark() {
    const body = typeof document !== "undefined" && document ? document.body : null;
    if (!body || typeof body.appendChild !== "function" || typeof document.createElement !== "function") return null;
    if (!vimBlockMark) {
      const mark = document.createElement("div");
      if (!mark) return null;
      mark.className = "md-vim-block-mark";
      if (typeof mark.setAttribute === "function") mark.setAttribute("aria-hidden", "true");
      vimBlockMark = mark;
    }
    if (vimBlockMark.parentElement !== body) {
      try {
        body.appendChild(vimBlockMark);
      } catch {
        return null;
      }
    }
    return vimBlockMark;
  }

  function measureCh(node) {
    const host = (node && node.parentElement) || root;
    if (!host || typeof host.appendChild !== "function" || typeof document === "undefined" || typeof document.createElement !== "function") return 0;
    let probe = null;
    try {
      probe = document.createElement("span");
      if (!probe) return 0;
      setStyle(probe, "display", "inline-block");
      setStyle(probe, "width", "1ch");
      setStyle(probe, "padding", "0");
      setStyle(probe, "border", "0");
      setStyle(probe, "margin", "0");
      host.appendChild(probe);
      if (typeof probe.getBoundingClientRect !== "function") return 0;
      const rect = probe.getBoundingClientRect();
      const width = rect && rect.width;
      return typeof width === "number" && Number.isFinite(width) && width > 0 ? width : 0;
    } catch {
      return 0;
    } finally {
      if (probe) detachNode(probe);
    }
  }

  function lineBox(node) {
    let el = node && node.nodeType === 1 ? node : node && node.parentElement;
    while (el && el !== root) {
      if (el.classList && el.classList.contains("md-line")) return el;
      el = el.parentElement;
    }
    return null;
  }

  function lineBoxHeight(node) {
    const line = lineBox(node) || (node && node.parentElement) || root;
    if (!line || typeof line.getBoundingClientRect !== "function") return 0;
    try {
      const rect = line.getBoundingClientRect();
      const height = rect && rect.height;
      return typeof height === "number" && Number.isFinite(height) && height > 0 ? height : 0;
    } catch {
      return 0;
    }
  }

  function rangeBox(range) {
    if (!range) return null;
    let rect = null;
    try {
      if (typeof range.getClientRects === "function") {
        const rects = range.getClientRects();
        if (rects && rects.length > 0) rect = rects[0];
      }
      if ((!rect || !Number.isFinite(rect.top) || !Number.isFinite(rect.left)) && typeof range.getBoundingClientRect === "function") {
        rect = range.getBoundingClientRect();
      }
    } catch {
      return null;
    }
    if (!rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.top)) return null;
    const width = Number.isFinite(rect.width) ? rect.width : 0;
    const height = Number.isFinite(rect.height) ? rect.height : 0;
    if (!(height > 0) && !(width > 0)) return null;
    return { left: rect.left, top: rect.top, width, height };
  }

  function elementBox(node) {
    const el = node && node.nodeType === 1 ? node : node && node.parentElement;
    if (!el || typeof el.getBoundingClientRect !== "function") return null;
    try {
      return rangeBox({ getBoundingClientRect: () => el.getBoundingClientRect() });
    } catch {
      return null;
    }
  }

  // Firefox reports no client rect for a caret on a br. The empty line's box is that caret.
  // A wrapped block is many rows; its top is not the caret, so a tall box is not used.
  function hostBox(node) {
    if (!node) return null;
    const boxed = isBreak(node)
      ? elementBox(lineBox(node) || node.parentElement)
      : elementBox(node.parentElement);
    if (!boxed || !(boxed.height > 0) || boxed.height > 80) return null;
    return boxed;
  }

  // The drawn selection is the Visual span. The block covers the cursor's next glyph.
  function vimBlockBox() {
    if (typeof document === "undefined" || typeof document.createRange !== "function") return null;
    const point = pointFor(state.cursor);
    if (!point || !point.node) return null;
    const node = point.node;
    const offset = point.offset || 0;
    const text = node.nodeType === 3;
    const len = text && typeof node.length === "number" ? node.length : 0;
    const cover = text && offset >= 0 && offset < len;
    let range = null;
    try {
      range = document.createRange();
      if (!range || typeof range.setStart !== "function") return null;
      if (cover && typeof range.setEnd === "function") {
        range.setStart(node, offset);
        range.setEnd(node, offset + 1);
      } else {
        const at = text ? Math.max(0, Math.min(len, offset)) : offset;
        range.setStart(node, at);
        if (typeof range.collapse === "function") range.collapse(true);
      }
    } catch {
      return null;
    }
    const box = rangeBox(range) || hostBox(node);
    if (!box) return null;
    let width = box.width;
    let height = box.height;
    if (!cover || !(width > 0)) {
      const ch = measureCh(node);
      if (ch > 0) width = ch;
    }
    if (!(height > 0)) height = lineBoxHeight(node);
    if (!(width > 0) || !(height > 0)) return null;
    return { left: box.left, top: box.top, width, height };
  }

  function syncVimBlockMark() {
    if (vimBlockSyncing) return;
    vimBlockSyncing = true;
    try {
      if (!vimBlockFallback()) {
        hideVimBlockMark();
        return;
      }
      const box = vimBlockBox();
      if (!box) {
        hideVimBlockMark();
        return;
      }
      const mark = ensureVimBlockMark();
      if (!mark) {
        hideVimBlockMark();
        return;
      }
      setStyle(mark, "position", "fixed");
      setStyle(mark, "left", `${box.left}px`);
      setStyle(mark, "top", `${box.top}px`);
      setStyle(mark, "width", `${box.width}px`);
      setStyle(mark, "height", `${box.height}px`);
      if (root && root.style) {
        setStyle(root, "caret-color", "transparent");
        vimBlockCaretHidden = true;
      }
    } catch {
      hideVimBlockMark();
    } finally {
      vimBlockSyncing = false;
    }
  }

  // localStorage wins when it exists. The session object is not that store.
  // When it is missing, the object passed to createEditor is the stand-in.
  function vimStore() {
    let local = null;
    try {
      if (globalThis.localStorage) local = globalThis.localStorage;
    } catch {
      local = null;
    }
    if (local && typeof local.getItem === "function") return local;
    if (repoStorage && typeof repoStorage.getItem === "function") return repoStorage;
    return null;
  }

  function readVimOn() {
    const store = vimStore();
    if (!store) return false;
    try {
      return store.getItem(VIM_KEY) === "1";
    } catch {
      return false;
    }
  }

  function writeVimOn(on) {
    const store = vimStore();
    if (!store) return;
    try {
      if (on) {
        if (typeof store.setItem === "function") store.setItem(VIM_KEY, "1");
      } else if (typeof store.removeItem === "function") {
        store.removeItem(VIM_KEY);
      }
    } catch {
      // The memory flag already holds the toggle. The next load starts off.
    }
  }

  function setVimOn(next) {
    closeVimLine();
    const on = next === true;
    vimOn = on;
    vimMode = "normal";
    vimInput = emptyVimInput();
    vimRegister = { text: "", linewise: false };
    vimEditRegister = null;
    vimSearch = null;
    vimFind = null;
    vimColumn = null;
    vimOnce = false;
    vimInsertOpen = false;
    typingRun = null;
    resetVimHistory();
    if (!on && state.anchor !== state.cursor) state = { ...state, anchor: state.cursor };
    writeVimOn(on);
    syncVimItem();
    render();
  }

  // The CR of a CRLF is the caret after the last drawn character, not a glyph.
  // A following LF is the line itself, so it is not a stop between those two.
  function renderSourceLine(doc, line) {
    const el = document.createElement("div");
    el.className = "md-line md-source-line";
    const cr = line.end < doc.length && doc[line.end] === "\n" && line.text.endsWith("\r");
    const shown = cr ? line.text.slice(0, -1) : line.text;
    const end = cr ? line.end - 1 : line.end;
    el.dataset.start = String(line.start);
    el.dataset.end = String(end);
    if (shown === "") el.appendChild(document.createElement("br"));
    else el.appendChild(document.createTextNode(shown));
    return el;
  }

  function renderSourceView(priorTop) {
    const lines = sourceLines(state.doc);
    const flashLine = refusal && !refusal.name ? tightestBlock(lines, refusal.offset) : null;
    const nodes = lines.map((line) => {
      const el = renderSourceLine(state.doc, line);
      appendLockMarks(el, line);
      if (line === flashLine) el.classList.add("md-flash");
      return el;
    });
    root.replaceChildren(...nodes);
    if (typeof root.scrollLeft === "number") root.scrollLeft = 0;
    layoutComments();
    hideCommentButton();
    placeCaret(priorTop);
  }

  function stopViewEvent(event) {
    if (event && typeof event.preventDefault === "function") event.preventDefault();
    if (event && typeof event.stopPropagation === "function") event.stopPropagation();
  }

  function ensureViewToggle() {
    if (viewToggle) return viewToggle;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "md-view-toggle icon-btn";
    button.contentEditable = "false";
    if (typeof button.setAttribute === "function") {
      button.setAttribute("type", "button");
      button.setAttribute("aria-label", "Raw");
      button.setAttribute("title", "Show raw markdown");
      button.setAttribute("contenteditable", "false");
    }
    if (typeof button.addEventListener === "function") {
      button.addEventListener("mousedown", stopViewEvent, { signal: ac.signal });
      button.addEventListener("pointerdown", stopViewEvent, { signal: ac.signal });
      button.addEventListener("click", (event) => {
        stopViewEvent(event);
        toggleSourceMode();
      }, { signal: ac.signal });
    }
    viewToggle = button;
    return button;
  }

  function replaceButtonIcon(button) {
    const icon = viewIcon(sourceMode);
    if (!icon) return;
    if (typeof button.replaceChildren === "function") {
      button.replaceChildren(icon);
      return;
    }
    const children = button.childNodes;
    if (children && typeof children.splice === "function") children.splice(0, children.length);
    if (typeof button.appendChild === "function") button.appendChild(icon);
  }

  function appendEditorChrome(node) {
    if (!node || !root || typeof root.appendChild !== "function") return;
    const children = root.childNodes || [];
    if (typeof children.indexOf === "function" && children.indexOf(node) >= 0) return;
    root.appendChild(node);
  }

  // Beside the raw toggle, after the lines, so a line's child index stays the block it paints.
  function mountDocMenu() {
    if (typeof document === "undefined" || typeof document.createElement !== "function") return;
    if (!docMenuButton) {
      const button = iconButton("menu", "md-doc-menu");
      button.contentEditable = "false";
      if (typeof button.setAttribute === "function") {
        button.setAttribute("aria-label", "Menu");
        button.setAttribute("title", "Open the document menu");
        button.setAttribute("aria-haspopup", "menu");
        button.setAttribute("aria-expanded", "false");
        button.setAttribute("contenteditable", "false");
      }
      if (typeof button.addEventListener === "function") {
        button.addEventListener("mousedown", stopViewEvent, { signal: ac.signal });
        button.addEventListener("pointerdown", stopViewEvent, { signal: ac.signal });
        button.addEventListener("click", (event) => {
          stopViewEvent(event);
          if (docMenuPanel && !docMenuPanel.hidden) closeDocMenu();
          else openDocMenu();
        }, { signal: ac.signal });
      }
      docMenuButton = button;
    }
    if (!docMenuPanel) {
      const panel = document.createElement("div");
      panel.className = "md-doc-menu-panel";
      panel.contentEditable = "false";
      if (typeof panel.setAttribute === "function") {
        panel.setAttribute("role", "menu");
        panel.setAttribute("contenteditable", "false");
      }
      hideElement(panel);
      if (typeof panel.addEventListener === "function") {
        panel.addEventListener("mousedown", stopViewEvent, { signal: ac.signal });
        panel.addEventListener("pointerdown", stopViewEvent, { signal: ac.signal });
      }
      const attach = plainButton("md-doc-menu-item", "Attach image");
      const remove = plainButton("md-doc-menu-item", "Delete file");
      docMenuDelete = remove;
      // A host with no listeners still has to build the items. The click is the only binding.
      const onItem = (button, run) => {
        if (typeof button.addEventListener !== "function") return;
        button.addEventListener("click", (event) => {
          stopViewEvent(event);
          closeDocMenu();
          run();
        }, { signal: ac.signal });
      };
      onItem(attach, () => {
        if (docAttachInput && typeof docAttachInput.click === "function") docAttachInput.click();
      });
      onItem(remove, () => {
        if (!openPath || openPath.startsWith("tickets/")) return;
        const path = openPath;
        showConfirm(pathBase(path), () => emit({ type: "delete", path }));
      });
      const vimItem = plainButton("md-doc-menu-item md-vim-keys", "Vim keys");
      docMenuVim = vimItem;
      if (typeof vimItem.setAttribute === "function") vimItem.setAttribute("role", "menuitemcheckbox");
      const vimLabel = document.createElement("span");
      vimLabel.className = "md-vim-label";
      vimLabel.textContent = "Vim keys";
      const vimCheck = document.createElement("span");
      vimCheck.className = "md-vim-check";
      // The slot keeps its box while the mark is absent, so the label does not move.
      if (typeof vimItem.replaceChildren === "function") vimItem.replaceChildren(vimLabel, vimCheck);
      onItem(vimItem, () => {
        setVimOn(!vimOn);
      });
      if (typeof panel.appendChild === "function") {
        panel.appendChild(attach);
        panel.appendChild(remove);
        panel.appendChild(vimItem);
      }
      syncDocMenuDelete();
      docMenuPanel = panel;
    }
    syncVimItem();
    appendEditorChrome(docMenuButton);
    appendEditorChrome(docMenuPanel);
  }

  // The item is built once. The next open follows the file that is open now.
  function syncDocMenuDelete() {
    if (!docMenuDelete) return;
    if (openPath && !openPath.startsWith("tickets/")) showElement(docMenuDelete);
    else hideElement(docMenuDelete);
  }

  function syncVimItem() {
    if (!docMenuVim || typeof docMenuVim.setAttribute !== "function") return;
    docMenuVim.setAttribute("aria-checked", vimOn ? "true" : "false");
    const slot = findClassChild(docMenuVim, "md-vim-check");
    if (!slot || typeof slot.appendChild !== "function") return;
    const mark = childArray(slot).find((node) => node && node.localName === "svg");
    if (vimOn) {
      if (mark) return;
      const svg = checkGlyph();
      if (svg) slot.appendChild(svg);
      return;
    }
    if (mark) detachNode(mark);
  }

  function openDocMenu() {
    if (!docMenuPanel) return;
    syncDocMenuDelete();
    showElement(docMenuPanel);
    if (docMenuButton && typeof docMenuButton.setAttribute === "function") docMenuButton.setAttribute("aria-expanded", "true");
    pinViewToggle();
  }

  function closeDocMenu() {
    if (docMenuPanel) hideElement(docMenuPanel);
    if (docMenuButton && typeof docMenuButton.setAttribute === "function") docMenuButton.setAttribute("aria-expanded", "false");
  }

  // The toggle owns the visible corner. The menu is one button-width to its left, same top.
  function pinDocMenu(top, edge) {
    const menu = docMenuButton;
    if (!menu) return;
    setStyle(menu, "position", "fixed");
    setStyle(menu, "top", `${top}px`);
    setStyle(menu, "right", `calc(${edge}px + 1.75rem + 4px)`);
    setStyle(menu, "left", "auto");
    const panel = docMenuPanel;
    if (!panel || panel.hidden) return;
    setStyle(panel, "position", "fixed");
    setStyle(panel, "top", `calc(${top}px + 1.75rem + 4px)`);
    setStyle(panel, "right", `calc(${edge}px + 1.75rem + 4px)`);
    setStyle(panel, "left", "auto");
  }

  function appendPathSpan(parent, className, text) {
    const span = document.createElement("span");
    span.className = className;
    span.textContent = text;
    parent.appendChild(span);
  }

  // Chrome, after the lines, so a line's child index stays the block it paints.
  function syncPathStrip() {
    if (!pathStripLine || typeof pathStripLine.replaceChildren !== "function") return;
    pathStripLine.replaceChildren();
    const parts = pathParts(openPath);
    if (!parts) return;
    for (let i = 0; i < parts.dirs.length; i += 1) {
      if (i > 0) appendPathSpan(pathStripLine, "md-path-sep", " / ");
      appendPathSpan(pathStripLine, "md-path-dir", parts.dirs[i]);
    }
    if (parts.dirs.length > 0) appendPathSpan(pathStripLine, "md-path-sep", " / ");
    appendPathSpan(pathStripLine, "md-path-name", parts.name);
  }

  function mountPathStrip() {
    if (typeof document === "undefined" || typeof document.createElement !== "function") return;
    if (!pathStrip) {
      const strip = document.createElement("div");
      strip.className = "md-path-strip";
      strip.contentEditable = "false";
      if (typeof strip.setAttribute === "function") strip.setAttribute("contenteditable", "false");
      const line = document.createElement("div");
      line.className = "md-path-line";
      strip.appendChild(line);
      // A press here selects the path. It must not place the document caret.
      if (typeof strip.addEventListener === "function") {
        const keep = (event) => {
          if (event && typeof event.stopPropagation === "function") event.stopPropagation();
        };
        strip.addEventListener("mousedown", keep, { signal: ac.signal });
        strip.addEventListener("pointerdown", keep, { signal: ac.signal });
        strip.addEventListener("click", keep, { signal: ac.signal });
      }
      pathStrip = strip;
      pathStripLine = line;
    }
    syncPathStrip();
    appendEditorChrome(pathStrip);
  }

  // Last, so a line's child index stays the block it paints. Fixed, once the
  // pane has a box, so the control stays in the visible corner while text scrolls.
  function mountViewToggle() {
    mountPathStrip();
    mountDocMenu();
    const button = ensureViewToggle();
    if (typeof button.setAttribute === "function") button.setAttribute("aria-pressed", sourceMode ? "true" : "false");
    replaceButtonIcon(button);
    const children = root.childNodes || [];
    const index = typeof children.indexOf === "function" ? children.indexOf(button) : -1;
    if (index < 0 || index !== children.length - 1) {
      if (index >= 0 && typeof children.splice === "function") children.splice(index, 1);
      root.appendChild(button);
    }
    mountVimStatus();
    pinViewToggle();
    const view = typeof window !== "undefined" ? window : null;
    if (view && typeof view.requestAnimationFrame === "function") {
      view.requestAnimationFrame(() => {
        if (!closed) pinViewToggle();
      });
    }
  }

  function pinViewToggle() {
    const button = viewToggle;
    if (!button || typeof root.getBoundingClientRect !== "function") return;
    const view = typeof window !== "undefined" ? window : null;
    const viewWidth = view && Number.isFinite(view.innerWidth) ? view.innerWidth : null;
    if (viewWidth == null) return;
    let rect = null;
    try {
      rect = root.getBoundingClientRect();
    } catch {
      return;
    }
    if (!rect) return;
    const width = Number(rect.width);
    const height = Number(rect.height);
    const top = Number(rect.top);
    const left = Number(rect.left);
    const right = Number(rect.right);
    if (!(width > 0) || !(height > 0) || !Number.isFinite(top) || !Number.isFinite(right)) return;
    const inset = 6;
    const visibleTop = top < 0 ? 0 : top;
    const visibleRight = right > viewWidth ? viewWidth : right;
    const edge = viewWidth - visibleRight + inset;
    setStyle(button, "position", "fixed");
    setStyle(button, "top", `${visibleTop + inset}px`);
    setStyle(button, "right", `${edge}px`);
    setStyle(button, "left", "auto");
    pinDocMenu(visibleTop + inset, edge);
    pinVimStatus(visibleTop + inset, edge);
    if (pathStrip && Number.isFinite(left)) {
      const visibleLeft = left < 0 ? 0 : left;
      const span = visibleRight - visibleLeft;
      if (span > 0) {
        setStyle(pathStrip, "position", "fixed");
        setStyle(pathStrip, "top", `${visibleTop}px`);
        setStyle(pathStrip, "left", `${visibleLeft}px`);
        setStyle(pathStrip, "width", `${span}px`);
        setStyle(pathStrip, "right", "auto");
      }
    }
  }

  // After the lines, so a line's child index stays the block it paints.
  // replaceChildren drops it, so each paint appends it again with the eye button.
  function mountVimStatus() {
    if (!vimOn) {
      if (vimStatus) detachNode(vimStatus);
      return;
    }
    if (!vimStatus && typeof document !== "undefined" && typeof document.createElement === "function") {
      const span = document.createElement("span");
      span.className = "md-vim-status";
      span.contentEditable = "false";
      if (typeof span.setAttribute === "function") {
        span.setAttribute("role", "status");
        span.setAttribute("aria-live", "polite");
        span.setAttribute("contenteditable", "false");
      }
      if (typeof span.addEventListener === "function") {
        span.addEventListener("mousedown", stopViewEvent, { signal: ac.signal });
        span.addEventListener("pointerdown", stopViewEvent, { signal: ac.signal });
      }
      vimStatus = span;
    }
    const span = vimStatus;
    if (!span || !root || typeof root.appendChild !== "function") return;
    span.textContent = vimStatusText(vimMode, vimInput);
    const children = root.childNodes || [];
    const index = typeof children.indexOf === "function" ? children.indexOf(span) : -1;
    if (index < 0 || index !== children.length - 1) {
      if (index >= 0) detachNode(span);
      root.appendChild(span);
    }
  }

  function pinVimStatus(top, edge) {
    if (!vimOn || !vimStatus) return;
    setStyle(vimStatus, "position", "fixed");
    setStyle(vimStatus, "top", `${top}px`);
    setStyle(vimStatus, "right", `calc(${edge}px + (1.75rem + 4px) * 2)`);
    setStyle(vimStatus, "left", "auto");
  }

  function dropRaw() {
    sourceMode = false;
    rawColumn = null;
    goalX = null;
    rawPath = "";
  }

  // A different path is a different document. Raw does not follow it.
  function releaseRaw(path) {
    if (!sourceMode || typeof path !== "string" || path === "" || path === rawPath) return;
    sourceMode = false;
    rawColumn = null;
    goalX = null;
  }

  function toggleSourceMode() {
    endTypingRunLater();
    sourceMode = !sourceMode;
    rawColumn = null;
    goalX = null;
    if (sourceMode) rawPath = openPath;
    const anchor = state.anchor;
    const cursor = state.cursor;
    render();
    state = { ...state, anchor, cursor };
    placingCaret = true;
    try {
      if (typeof root.focus === "function") root.focus();
    } finally {
      placingCaret = false;
    }
    state = { ...state, anchor, cursor };
    placeCaret();
  }

  // A tab stop is the font's space, not 1ch. Measure the hidden run in this editor.
  function whitespaceAdvance(text) {
    const probe = document.createElement("span");
    setStyle(probe, "white-space", "pre");
    probe.appendChild(document.createTextNode(text));
    root.appendChild(probe);
    let width = 0;
    if (typeof probe.getBoundingClientRect === "function") {
      const rect = probe.getBoundingClientRect();
      if (rect && Number.isFinite(rect.width)) width = rect.width;
    }
    detachNode(probe);
    return width;
  }

  // display:block shares the slot's line and paints the newline caret on the
  // line's left edge. margin-left is the hidden whitespace, so that caret is
  // the column the next letter uses.
  function settleBlankBreaks() {
    const doc = state.doc;
    for (const line of childArray(root)) {
      if (!hasClass(line, "md-line")) continue;
      const brk = findClassChild(line, "md-break");
      if (!brk || inlineStyle(brk, "margin-top").value !== "-1lh") continue;
      const slot = Number(line.dataset && line.dataset.start);
      const at = Number(brk.dataset && brk.dataset.start);
      if (!Number.isFinite(slot) || !Number.isFinite(at) || at < slot) continue;
      const hidden = doc.slice(slot, at);
      if (!/^[\t ]+$/.test(hidden)) continue;
      const width = whitespaceAdvance(hidden);
      if (!(width > 0)) continue;
      setStyle(brk, "margin-left", `${width}px`);
    }
  }

  function render() {
    if (gestureTimer != null) {
      clearTimeout(gestureTimer);
      gestureTimer = null;
    }
    const gestureHeld = gestureHold;
    try {
      syncSourceClass();
      syncVimCaret();
      if (sourceMode) {
        if (pictureObserver) pictureObserver.disconnect();
        renderSourceView(caretTop());
        mountViewToggle();
        restoreCornerPin();
        return;
      }
      if (typedTail != null && typedTail !== state.cursor) typedTail = null;
      const planned = plan(state.doc, state.cursor, typedTail != null);
      let blocks = planned.blocks;
      if (rawSelectionLines) {
        rawSelectionLines = false;
        blocks = blocksWithSelectionSource(blocks);
      }
      blocks = blocksForCaret(blocks);
      const flashBlock = refusal && !refusal.name ? tightestBlock(blocks, refusal.offset) : null;
      const nodes = blocks.map((block) => {
        const el = renderBlock(block, activeRepo, layoutAfterPicture, restoreCornerAfterDiagram);
        adornImageLine(el, block, state.doc);
        hangRawMarker(el, rawListMarker(block), block && block.indent);
        appendLockMarks(el, block);
        if (block === flashBlock) el.classList.add("md-flash");
        return el;
      });
      const priorTop = caretTop();
      root.replaceChildren(...nodes);
      settleBlankBreaks();
      settleRawMarkers();
      settleListContinuations(blocks);
      markEditingHighlights();
      hideResolvedHighlights();
      markCurrentHighlights();
      paintAnchorMarks();
      renderCommentAside(planned.comments);
      layoutComments();
      watchPictures();
      if (commentFocus) {
        restoreEditorFocus = false;
        focusComment(commentFocus.id, commentFocus.start, commentFocus.end, commentFocus.note);
      } else placeCaret(priorTop);
      updateCommentButton();
      if (scrollCommentId) {
        const card = findCommentCard(scrollCommentId);
        scrollCommentId = null;
        if (card && typeof card.scrollIntoView === "function") card.scrollIntoView();
      }
      mountViewToggle();
      if (hoverCommentId && !handleDrag) showCommentHandles(hoverCommentId);
      restoreCornerPin();
    } finally {
      if (gestureHeld) gestureHold = false;
      syncVimMatchPaint();
    }
  }

  function filesNav() {
    const parent = root && root.parentElement;
    if (!parent || !parent.childNodes) return null;
    for (const child of parent.childNodes) {
      if (child !== root && child.classList && child.classList.contains("files")) return child;
    }
    return null;
  }

  function seedOpen(path) {
    if (!path) return;
    const parts = String(path).split("/").filter(Boolean);
    let acc = "";
    for (let i = 0; i < parts.length - 1; i += 1) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i];
      openDirs.add(acc);
    }
  }

  function renderEntries(node) {
    const entries = [
      ...[...node.dirs.values()].map((dir) => ({ kind: "dir", name: dir.name, dir })),
      ...node.files.map((file) => ({ kind: "file", name: file.name, file })),
    ];
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries.map((entry) => (entry.kind === "dir" ? renderDirRow(entry.dir) : renderFileRow(entry.file)));
  }

  function fileLabel(file) {
    if (!fileTitles || typeof fileTitles !== "object") return file.name;
    const title = fileTitles[file.path];
    if (typeof title !== "string" || title.length === 0) return file.name;
    return title;
  }

  function stopEvent(event) {
    if (event && typeof event.stopPropagation === "function") event.stopPropagation();
  }

  function acceptDrop(event) {
    if (event && typeof event.preventDefault === "function") event.preventDefault();
    stopEvent(event);
  }

  function rememberDrag(event, path, directory) {
    draggedMove = { path, directory };
    const data = event && event.dataTransfer;
    if (!data || typeof data.setData !== "function") return;
    try {
      data.setData("text/plain", path);
      data.effectAllowed = "move";
    } catch {
      // A drag double may reject writes.
    }
  }

  function parentDir(path) {
    const value = typeof path === "string" ? path : "";
    const slash = value.lastIndexOf("/");
    return slash < 0 ? "" : value.slice(0, slash);
  }

  function pathBase(path) {
    const value = typeof path === "string" ? path : "";
    const slash = value.lastIndexOf("/");
    return slash < 0 ? value : value.slice(slash + 1);
  }

  // The filename is the last segment. Earlier segments are directories.
  function pathParts(path) {
    if (typeof path !== "string" || path === "") return null;
    const parts = path.split("/").filter((part) => part !== "");
    if (parts.length === 0) return null;
    return { dirs: parts.slice(0, -1), name: parts[parts.length - 1] };
  }

  function moveBlocked(dir) {
    if (!draggedMove || typeof draggedMove.path !== "string" || draggedMove.path === "") return true;
    if (draggedMove.directory && dir !== "" && (dir === draggedMove.path || dir.startsWith(`${draggedMove.path}/`))) return true;
    return false;
  }

  function sendMove(dir) {
    if (moveBlocked(dir)) return;
    emit({ type: "move", path: draggedMove.path, dir });
  }

  function fileTreeNode() {
    const nav = filesNav();
    const block = findClassChild(nav, "file-block");
    return fileTreeOf(block) || findClassChild(nav, "file-tree");
  }

  function clearDropMark() {
    const tree = fileTreeNode();
    if (!tree) return;
    const walk = (node) => {
      if (!node) return;
      if (node.classList && node.classList.contains("md-drop-target")) node.classList.remove("md-drop-target");
      const children = [...(node.childNodes || [])];
      for (const child of children) {
        if (child && child.classList && child.classList.contains("md-drop-line")) detachNode(child);
        else walk(child);
      }
    };
    walk(tree);
  }

  function fileRowPath(row) {
    if (!row || !row.classList) return null;
    if (row.classList.contains("md-file")) {
      const path = row.dataset && row.dataset.path;
      return typeof path === "string" ? path : null;
    }
    if (!row.classList.contains("md-file-row")) return null;
    for (const child of row.childNodes || []) {
      if (!child || !child.classList || !child.classList.contains("md-file") || !child.dataset) continue;
      if (typeof child.dataset.path === "string") return child.dataset.path;
    }
    return null;
  }

  // The sort key is the path segment renderEntries uses, not the visible title.
  function rowSortName(row) {
    if (!row || !row.classList) return null;
    const filePath = fileRowPath(row);
    if (filePath != null) return pathBase(filePath);
    if (!row.classList.contains("md-dir")) return null;
    for (const child of row.childNodes || []) {
      if (child && child.classList && child.classList.contains("md-dir-toggle") && child.dataset && typeof child.dataset.dir === "string") {
        return pathBase(child.dataset.dir);
      }
    }
    return null;
  }

  function isDraggedRow(row) {
    if (!draggedMove || !row || !row.classList) return false;
    if (draggedMove.directory) {
      if (!row.classList.contains("md-dir")) return false;
      for (const child of row.childNodes || []) {
        if (child && child.dataset && child.dataset.dir === draggedMove.path) return true;
      }
      return false;
    }
    const filePath = fileRowPath(row);
    return filePath != null && filePath === draggedMove.path;
  }

  function placeDropLine(container) {
    if (!container || typeof document === "undefined" || typeof document.createElement !== "function") return;
    const line = document.createElement("div");
    line.className = "md-drop-line";
    const basename = pathBase(draggedMove.path);
    let before = null;
    for (const row of container.childNodes || []) {
      if (isDraggedRow(row)) continue;
      const name = rowSortName(row);
      if (name == null) continue;
      if (basename.localeCompare(name) < 0) {
        before = row;
        break;
      }
    }
    placeNodeBefore(container, line, before);
  }

  function findDirWrap(path) {
    const tree = fileTreeNode();
    if (!tree) return null;
    let found = null;
    const walk = (node) => {
      if (!node || found) return;
      if (node.classList && node.classList.contains("md-dir")) {
        for (const child of node.childNodes || []) {
          if (child && child.classList && child.classList.contains("md-dir-toggle") && child.dataset && child.dataset.dir === path) {
            found = node;
            return;
          }
        }
      }
      for (const child of node.childNodes || []) walk(child);
    };
    walk(tree);
    return found;
  }

  function showDropMark(dir) {
    clearDropMark();
    if (moveBlocked(dir)) return;
    if (dir === "") {
      placeDropLine(fileTreeNode());
      return;
    }
    const wrap = findDirWrap(dir);
    if (!wrap) return;
    if (wrap.classList.contains("md-dir-collapsed")) {
      wrap.classList.add("md-drop-target");
      return;
    }
    placeDropLine(findClassChild(wrap, "md-dir-children"));
  }

  function bindDragSource(target, path, directory) {
    target.draggable = true;
    if (typeof target.setAttribute === "function") target.setAttribute("draggable", "true");
    target.addEventListener("dragstart", (event) => {
      // preventDefault here cancels the drag before a drop can land.
      stopEvent(event);
      rememberDrag(event, path, directory);
    });
    target.addEventListener("dragend", () => {
      clearDropMark();
    });
  }

  function bindFileDrop(target, path) {
    const dir = parentDir(path);
    target.addEventListener("dragover", (event) => {
      acceptDrop(event);
      showDropMark(dir);
    });
    target.addEventListener("drop", (event) => {
      acceptDrop(event);
      showDropMark(dir);
      sendMove(dir);
    });
  }

  function bindDirDrop(target, dirPath) {
    target.addEventListener("dragover", (event) => {
      acceptDrop(event);
      showDropMark(dirPath);
    });
    target.addEventListener("drop", (event) => {
      acceptDrop(event);
      showDropMark(dirPath);
      sendMove(dirPath);
    });
  }

  function appendIconLabel(button, action, label) {
    const svg = iconSvg(action);
    if (svg) button.appendChild(svg);
    // textContent replaces every child, so the label stays a text node after the svg.
    button.appendChild(document.createTextNode(label));
  }

  let confirmDialog = null;
  let confirmText = null;
  let confirmSend = null;

  function confirmParent() {
    const body = typeof document !== "undefined" ? document.body : null;
    if (body && typeof body.appendChild === "function") return body;
    return root && root.parentElement;
  }

  function closeConfirm() {
    if (!confirmDialog) return;
    // close() leaves the top layer only while the dialog is still open.
    // Clearing open first makes Firefox keep ::backdrop, which then eats clicks.
    if (typeof confirmDialog.close === "function") confirmDialog.close();
    else {
      confirmDialog.open = false;
      if (typeof confirmDialog.removeAttribute === "function") confirmDialog.removeAttribute("open");
    }
  }

  function openConfirm() {
    if (!confirmDialog) return;
    const dialog = confirmDialog;
    dialog.open = true;
    if (typeof dialog.showModal === "function") {
      try {
        dialog.showModal();
      } catch {
        // The open property is non-modal, and showModal throws while the dialog is open.
        // Only a modal dialog paints ::backdrop.
        if (typeof dialog.close === "function") dialog.close();
        try {
          dialog.showModal();
        } catch {
          dialog.open = true;
        }
      }
    } else if (typeof dialog.setAttribute === "function") {
      dialog.setAttribute("open", "");
    }
  }

  function ensureConfirm() {
    if (confirmDialog) return confirmDialog;
    if (typeof document === "undefined" || typeof document.createElement !== "function") return null;
    const parent = confirmParent();
    if (!parent) return null;
    const dialog = document.createElement("dialog");
    dialog.className = "md-confirm";
    const text = document.createElement("p");
    text.className = "md-confirm-text";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    if (typeof cancel.setAttribute === "function") cancel.setAttribute("type", "button");
    const yes = document.createElement("button");
    yes.type = "button";
    yes.textContent = "Delete";
    if (typeof yes.setAttribute === "function") yes.setAttribute("type", "button");
    const actions = document.createElement("div");
    actions.className = "md-confirm-actions";
    actions.append(cancel, yes);
    cancel.addEventListener("click", (event) => {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      confirmSend = null;
      closeConfirm();
    });
    yes.addEventListener("click", (event) => {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      const send = confirmSend;
      confirmSend = null;
      closeConfirm();
      if (send) send();
    });
    const dismiss = (event) => {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      confirmSend = null;
      closeConfirm();
    };
    dialog.addEventListener("cancel", dismiss);
    dialog.addEventListener("keydown", (event) => {
      if (!event || event.key !== "Escape") return;
      dismiss(event);
    });
    dialog.append(text, actions);
    parent.appendChild(dialog);
    confirmDialog = dialog;
    confirmText = text;
    return dialog;
  }

  function showConfirm(name, send) {
    const dialog = ensureConfirm();
    if (!dialog || !confirmText) return;
    confirmText.textContent = `Delete ${name}?`;
    confirmSend = send;
    openConfirm();
  }

  function closeFileMenu() {
    fileMenuPath = "";
    if (!fileMenu) return;
    hideElement(fileMenu);
  }

  function closeFileMenuIfStale() {
    if (!fileMenu || fileMenu.hidden || fileMenuPath === "") return;
    if (!fileList.includes(fileMenuPath)) closeFileMenu();
  }

  function ensureFileMenu() {
    if (fileMenu) return fileMenu;
    if (typeof document === "undefined" || typeof document.createElement !== "function") return null;
    const parent = confirmParent();
    if (!parent) return null;
    const menu = document.createElement("div");
    menu.className = "md-file-menu";
    if (typeof menu.setAttribute === "function") menu.setAttribute("role", "menu");
    hideElement(menu);
    const head = document.createElement("div");
    head.className = "md-file-menu-head";
    const pathEl = document.createElement("div");
    pathEl.className = "md-file-menu-path";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "icon-btn md-path-copy";
    if (typeof copy.setAttribute === "function") {
      copy.setAttribute("type", "button");
      copy.setAttribute("aria-label", "Copy path");
    }
    const glyph = copyGlyph();
    if (glyph) {
      if (typeof glyph.setAttribute === "function") {
        glyph.setAttribute("fill", "none");
        glyph.setAttribute("stroke", "currentColor");
        glyph.setAttribute("stroke-width", "2");
        glyph.setAttribute("stroke-linecap", "round");
        glyph.setAttribute("stroke-linejoin", "round");
      }
      copy.appendChild(glyph);
    }
    if (typeof copy.addEventListener === "function") {
      copy.addEventListener("click", (event) => {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        stopEvent(event);
        if (fileMenuPath) writeClipboard(fileMenuPath);
      });
    }
    head.append(pathEl, copy);
    menu.appendChild(head);
    if (typeof menu.addEventListener === "function") {
      const keep = (event) => {
        if (event && typeof event.stopPropagation === "function") event.stopPropagation();
      };
      menu.addEventListener("mousedown", keep);
      menu.addEventListener("contextmenu", (event) => {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        keep(event);
      });
    }
    parent.appendChild(menu);
    fileMenu = menu;
    fileMenuPathEl = pathEl;
    bindTicketPointer();
    return menu;
  }

  function openFileMenu(path, x, y) {
    if (typeof path !== "string" || path === "") return;
    const menu = ensureFileMenu();
    if (!menu) return;
    fileMenuPath = path;
    if (fileMenuPathEl) fileMenuPathEl.textContent = path;
    const left = Number.isFinite(x) ? x : 0;
    const top = Number.isFinite(y) ? y : 0;
    setStyle(menu, "position", "fixed");
    setStyle(menu, "left", `${left}px`);
    setStyle(menu, "top", `${top}px`);
    showElement(menu);
  }

  function renderFileRow(file) {
    const row = document.createElement("div");
    row.className = "md-file-row";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "md-file icon-btn";
    if (file.path === openPath) button.classList.add("md-file-current");
    button.dataset.path = file.path;
    appendIconLabel(button, "file", fileLabel(file));
    bindDragSource(button, file.path, false);
    bindFileDrop(button, file.path);
    button.addEventListener("click", (event) => {
      if (event && typeof event.button === "number" && event.button !== 0) return;
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      hashComment = null;
      pinnedComment = null;
      openPath = file.path;
      seedOpen(openPath);
      waitingForFile = true;
      emit({ type: "open", path: file.path });
      publishHash();
      syncEntryLink();
      closeFileMenu();
      syncPathStrip();
      renderFileTree(fileList, false);
    });
    row.addEventListener("contextmenu", (event) => {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      stopEvent(event);
      const point = event || {};
      openFileMenu(file.path, point.clientX, point.clientY);
    });
    row.append(button);
    return row;
  }

  function renderDirRow(dir) {
    const wrap = document.createElement("div");
    wrap.className = "md-dir";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "md-dir-toggle icon-btn";
    button.dataset.dir = dir.path;
    appendIconLabel(button, "folder", dir.name);
    const open = openDirs.has(dir.path);
    if (!open) wrap.classList.add("md-dir-collapsed");
    bindDragSource(wrap, dir.path, true);
    bindDragSource(button, dir.path, true);
    bindDirDrop(wrap, dir.path);
    bindDirDrop(button, dir.path);
    button.addEventListener("click", (event) => {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      if (openDirs.has(dir.path)) openDirs.delete(dir.path);
      else openDirs.add(dir.path);
      renderFileTree(fileList, false);
    });
    wrap.appendChild(button);
    if (open) {
      const kids = document.createElement("div");
      kids.className = "md-dir-children";
      for (const child of renderEntries(dir)) kids.appendChild(child);
      wrap.appendChild(kids);
    }
    return wrap;
  }

  function bindTreeDrop(tree) {
    if (!tree || (treeDrop && treeDrop.tree === tree)) return;
    if (treeDrop) unbindTreeDrop();
    const onOver = (event) => {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      const target = event && event.target;
      if (target && target !== tree) return;
      showDropMark("");
    };
    const onDrop = (event) => {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      const target = event && event.target;
      if (target && target !== tree) return;
      showDropMark("");
      sendMove("");
    };
    tree.addEventListener("dragover", onOver);
    tree.addEventListener("drop", onDrop);
    treeDrop = { tree, onOver, onDrop };
  }

  function unbindTreeDrop() {
    if (!treeDrop) return;
    const { tree, onOver, onDrop } = treeDrop;
    if (typeof tree.removeEventListener === "function") {
      tree.removeEventListener("dragover", onOver);
      tree.removeEventListener("drop", onDrop);
    }
    treeDrop = null;
  }

  function syncWideFileDrawer(panel) {
    if (!panel || !panel.classList || !panel.classList.contains("md-file-wide")) return;
    const compact = Number.parseFloat(fileDrawerCompact);
    const rect = Number.isFinite(compact) ? { width: compact } : null;
    const width = `${filePaneWidth(panel, rect)}px`;
    fileDrawerWide = width;
    setStyle(panel, "width", width);
  }

  function renderFileTree(files, seed) {
    fileList = Array.isArray(files) ? files : [];
    const nav = filesNav();
    if (!nav || typeof document === "undefined" || typeof document.createElement !== "function") return;
    const block = ensureFileBlock(nav);
    const drawer = ensureFileDrawer(block);
    if (!drawer) return;
    let tree = findClassChild(drawer, "file-tree") || findClassChild(block, "file-tree") || findClassChild(nav, "file-tree");
    if (!tree) {
      tree = document.createElement("div");
      tree.className = "file-tree";
    }
    if (tree.parentElement !== drawer) {
      detachNode(tree);
      drawer.appendChild(tree);
    }
    bindTreeDrop(tree);
    if (typeof tree.replaceChildren !== "function") return;
    if (seed) seedOpen(openPath);
    tree.replaceChildren(...renderEntries(buildFileTree(fileList)));
    closeFileMenuIfStale();
    // The open panel tracks the new rows. Another hover is not required.
    syncWideFileDrawer(drawer);
  }

  function clampCaret(pos, length) {
    const value = Number.isFinite(pos) ? Math.trunc(pos) : 0;
    return Math.max(0, Math.min(length, value));
  }

  function shiftPos(pos, message) {
    const list = Array.isArray(message.changes) && message.changes.length > 0
      ? message.changes
      : [{ from: message.from, to: message.to, inserted: message.inserted }];
    let next = pos;
    for (const change of list) {
      const from = Number(change.from);
      const to = Number(change.to);
      const inserted = typeof change.inserted === "string" ? change.inserted : "";
      if (!Number.isFinite(from) || !Number.isFinite(to)) return pos;
      // A caret on the insertion point stays in front of a remote insert.
      // The hub shifts the same way; following the insert would leave the line.
      if (next <= from) continue;
      if (next >= to) next += inserted.length - (to - from);
      else next = from + inserted.length;
    }
    return next;
  }

  function noteFreshComment(previousDoc, message) {
    if (!expectNewComment) return;
    expectNewComment = false;
    if (!ownActor(message)) return;
    const before = new Set(commentThreads(previousDoc).map((item) => item.id));
    const novel = commentThreads(state.doc).filter((item) => !before.has(item.id));
    if (novel.length === 0) return;
    const id = novel[0].id;
    unsavedThreads.add(id);
    replyDrafts.delete(id);
    noteDrafts.delete(draftKey(id, 0));
    currentCommentId = id;
    commentFocus = { id, note: 0, start: 0, end: 0 };
  }

  function caretFor(message) {
    const length = typeof message.text === "string" ? message.text.length : 0;
    if (message.type === "doc" && vimPlace) {
      const placed = vimPlace;
      vimPlace = null;
      keptCaret = null;
      return { cursor: clampCaret(placed.cursor, length), anchor: clampCaret(placed.anchor, length) };
    }
    const kept = keptCaret;
    if (message.type === "doc" && kept && ownActor(message) && message.text === kept.text) {
      keptCaret = null;
      followCaret = null;
      followPath = false;
      if (kept.anchor !== kept.cursor) rawSelectionLines = true;
      return { cursor: clampCaret(kept.cursor, length), anchor: clampCaret(kept.anchor, length) };
    }
    if (message.type === "file" && followCaret) {
      const saved = followCaret;
      const sameText = typeof message.text === "string" && message.text === saved.text;
      followCaret = null;
      // The rename frame has no caret. The reopen after it carries one, and that
      // one is not a place in the text either when the bytes are unchanged.
      if (!Number.isFinite(message.cursor) || (saved.hold && sameText)) {
        followPath = !Number.isFinite(message.cursor);
        keptCaret = null;
        return { cursor: clampCaret(saved.cursor, length), anchor: clampCaret(saved.anchor, length) };
      }
    }
    if (message.type === "file") followPath = false;
    if (message.type === "doc" || message.type === "file") keptCaret = null;
    if (message.type === "file" || ownActor(message)) {
      const cursor = Number.isFinite(message.cursor) ? message.cursor : (message.type === "file" ? 0 : state.cursor);
      const anchor = Number.isFinite(message.anchor) ? message.anchor : cursor;
      return { cursor: clampCaret(cursor, length), anchor: clampCaret(anchor, length) };
    }
    return {
      cursor: clampCaret(shiftPos(state.cursor, message), length),
      anchor: clampCaret(shiftPos(state.anchor, message), length),
    };
  }

  // A typed run of spaces leaves the caret in a hard-break tail. Drawing that
  // tail is what gives the caret a place. Any other edit, or someone else's, hides it again.
  function noteTypedTail(message) {
    if (message.type !== "doc" || !ownActor(message)) {
      if (message.type === "doc" || message.type === "file") typedTail = null;
      return;
    }
    const inserted = typeof message.inserted === "string" ? message.inserted : "";
    typedTail = /^ +$/.test(inserted) ? state.cursor : null;
  }

  // file and doc replace the mirror. The view does not paint a local edit.
  function applySnapshot(message) {
    linkTabCaret = null;
    const previousDoc = state.doc;
    const previousLines = sentLines;
    const text = typeof message.text === "string" ? message.text : "";
    const caret = caretFor(message);
    state = {
      doc: text,
      cursor: caret.cursor,
      anchor: caret.anchor,
      undo: Array.isArray(message.undo) ? message.undo : [],
      redo: Array.isArray(message.redo) ? message.redo : [],
    };
    // A different document is not the text that leave was cut from.
    if (droppedBreakDoc != null && text !== droppedBreakDoc) droppedBreakDoc = null;
    if (message.type === "file") {
      bodyCaretReleased = false;
      releaseRaw(message.path);
      const nextRev = Number(message.rev);
      rev = Number.isFinite(nextRev) ? nextRev : 0;
      waitingForFile = false;
      live = true;
      if (typeof message.path === "string") openPath = message.path;
      expectNewComment = false;
      lockTable = Array.isArray(message.locks) ? message.locks : [];
    } else {
      rev = Number(message.rev);
    }
    outstandingLock = null;
    granted = { anchor: state.anchor, cursor: state.cursor };
    noteTypedTail(message);
    const lines = lineSet(state.anchor, state.cursor);
    sentLines = bodyCaretReleased ? [] : lines;
    noteFreshComment(previousDoc, message);
    if (message.type === "file") focusHashedComment(message.path, text);
    const ownDoc = message.type === "doc" && ownActor(message);
    if (message.type === "doc" && !ownDoc) holdRemoteCaret();
    else remoteCaret = null;
    const pinScroll = ownDoc ? pinScrollHold : null;
    if (message.type === "file") pinScrollHold = null;
    render();
    if (pinScroll) releasePinScroll(pinScroll);
    if (message.type === "file") publishHash();
    const claim = vimForceClaim;
    vimForceClaim = false;
    if (!live || bodyCaretReleased) return;
    if (message.type === "file" || claim || !sameLines(lines, previousLines)) {
      emit({ type: "lock", anchor: state.anchor, cursor: state.cursor }, false);
    }
  }

  // Firefox restores the old offset after this turn, once the lines have been
  // replaced. Correct again on the timers it uses, then drop the hold.
  function holdRemoteCaret() {
    const held = { anchor: state.anchor, cursor: state.cursor };
    remoteCaret = held;
    const view = typeof window !== "undefined" ? window : null;
    if (!view || typeof view.setTimeout !== "function") return;
    const correct = () => {
      if (closed || remoteCaret !== held) return;
      if (state.anchor !== held.anchor || state.cursor !== held.cursor) {
        state = { ...state, anchor: held.anchor, cursor: held.cursor };
      }
      if (!domSelectionMatches()) placeCaret();
    };
    view.setTimeout(() => {
      correct();
      view.setTimeout(() => {
        correct();
        if (remoteCaret === held && domSelectionMatches()) remoteCaret = null;
      }, 0);
    }, 0);
  }

  // Firefox puts the pre-render selection back after this turn, and again after
  // the correction. Place the stop on both timers. The hold stays until the
  // next key or pointer; dropping it here lets that later restore win.
  function holdWhitespaceCaret() {
    const held = { anchor: state.anchor, cursor: state.cursor };
    whitespaceCaret = held;
    const view = typeof window !== "undefined" ? window : null;
    if (!view || typeof view.setTimeout !== "function") return;
    const correct = () => {
      if (closed || whitespaceCaret !== held) return;
      if (state.anchor !== held.anchor || state.cursor !== held.cursor) {
        state = { ...state, anchor: held.anchor, cursor: held.cursor };
      }
      if (!domSelectionMatches()) placeCaret();
    };
    view.setTimeout(() => {
      correct();
      view.setTimeout(correct, 0);
    }, 0);
  }

  // The history reply carries the splice range. Place the caret saved with that entry.
  function stageVimHistory(message) {
    if (vimHistoryPending) {
      const dir = vimHistoryPending;
      vimHistoryPending = null;
      vimUndoArmed = false;
      vimUndoMark = null;
      vimGroupCont = false;
      const from = dir === "redo" ? vimRedoCarets : vimUndoCarets;
      const to = dir === "redo" ? vimUndoCarets : vimRedoCarets;
      const item = from.pop();
      if (item === undefined) return;
      to.push(item);
      if (!vimOn || !item) return;
      const offset = dir === "redo" ? item.after : item.before;
      const length = typeof message.text === "string" ? message.text.length : 0;
      const at = clampCaret(offset, length);
      vimPlace = { cursor: at, anchor: at };
      vimForceClaim = true;
      return;
    }
    if (vimUndoArmed) {
      vimUndoCarets.push(vimUndoMark);
      vimRedoCarets.length = 0;
      vimUndoArmed = false;
      vimUndoMark = null;
      vimGroupCont = false;
      return;
    }
    if (!vimGroupCont) return;
    vimGroupCont = false;
    vimRedoCarets.length = 0;
    const top = vimUndoCarets.length > 0 ? vimUndoCarets[vimUndoCarets.length - 1] : null;
    if (!top || !Number.isFinite(message.cursor)) return;
    const length = typeof message.text === "string" ? message.text.length : 0;
    top.after = clampCaret(message.cursor, length);
  }

  function isConflict(message) {
    return message.status === 409 || message.code === 409 || message.error === 409;
  }

  function onMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "hello") {
      const build = typeof message.build === "string" ? message.build : "";
      if (!build || !seenBuild) {
        if (build) seenBuild = build;
        return;
      }
      if (build === seenBuild) return;
      if (typeof active.close === "function") active.close();
      const loc = globalThis.location;
      if (loc && typeof loc.reload === "function") loc.reload();
      return;
    }
    if (message.type === "reconnect") {
      // The mirror stays up. Blanking would wipe the open document before its file frame.
      // Keys typed on the dead socket stay queued. This open's file places the caret,
      // and those keys are sent against that caret, in order.
      reconnecting = true;
      // send can return while the socket is already dead. Keep that edit in front
      // of keys typed after it. The file drops it when the bytes are already there.
      if (inflightEdit) {
        pendingEdits.unshift(inflightEdit);
        inflightEdit = null;
        resumeAfterFile = true;
      }
      clearEditTimer();
      clearVimHistoryFlight();
      conflictWaiters.length = 0;
      fileWaiters.length = 0;
      outstandingLock = null;
      vimEditRegister = null;
      live = false;
      if (pendingEdits.length > 0) resumeAfterFile = true;
      if (activeRepo) sendRepoFrames(activeRepo);
      if (openPath) {
        waitingForFile = true;
        followCaret = null;
        followPath = false;
        emit({ type: "open", path: openPath });
      }
      return;
    }
    if (message.type === "ping") {
      emit({ type: "pong" });
      return;
    }
    if (message.type === "repos") {
      applyRepos(message);
      return;
    }
    if (message.type === "docs") {
      const incoming = message.titles;
      fileTitles = incoming && typeof incoming === "object" && !Array.isArray(incoming) ? incoming : null;
      renderFileTree(message.files, true);
      return;
    }
    if (message.type === "tickets") {
      applyTicketList(message);
      return;
    }
    if (message.type === "deleted") {
      const at = conflictWaiters.indexOf("delete");
      if (at >= 0) conflictWaiters.splice(at, 1);
      if (typeof message.path !== "string" || message.path !== openPath) return;
      // The open file is gone. Empty this mirror only; the ticket list stays until tickets.
      dropPendingEdits();
      live = false;
      waitingForFile = true;
      openPath = "";
      dropRaw();
      state = createState("");
      bodyCaretReleased = false;
      sentLines = lineSet(state.anchor, state.cursor);
      outstandingLock = null;
      granted = { anchor: state.anchor, cursor: state.cursor };
      render();
      renderFileTree(fileList, false);
      return;
    }
    if (message.type === "ticket") {
      applyTicketNotice(message);
      return;
    }
    if (message.type === "locks") {
      lockTable = Array.isArray(message.lines) ? message.lines : [];
      if (outstandingLock && active.memory !== true) {
        const held = new Set();
        for (const line of lockTable) {
          if (line && ownLock(line) && Number.isFinite(line.index)) held.add(line.index);
        }
        let ok = outstandingLock.lines.length > 0;
        for (const index of outstandingLock.lines) if (!held.has(index)) ok = false;
        if (ok) {
          granted = { anchor: state.anchor, cursor: state.cursor };
          sentLines = outstandingLock.lines.slice();
          outstandingLock = null;
          const index = conflictWaiters.indexOf("lock");
          if (index >= 0) conflictWaiters.splice(index, 1);
        }
      } else if (bodyCaretReleased) {
        // The claim was dropped when the caret left. Its reply must not stay in front of a field write.
        const index = conflictWaiters.indexOf("lock");
        if (index >= 0) conflictWaiters.splice(index, 1);
      }
      refreshLockMarks();
      return;
    }
    if (message.type === "noop") {
      // A doc or noop while the file is still out must not release the queue.
      if (waitingForFile || resumeAfterFile) return;
      if (typeof message.path !== "string" || message.path !== openPath) return;
      if (Number(message.rev) !== rev) return;
      clearVimHistoryFlight();
      clearEditTimer();
      const index = conflictWaiters.indexOf("edit");
      if (index >= 0) {
        conflictWaiters.splice(index, 1);
        vimEditRegister = null;
        inflightEdit = null;
        pinScrollHold = null;
        // The bytes stayed, so the leave did not land.
        droppedBreakDoc = null;
      }
      flushPendingEdit();
      return;
    }
    if (message.type === "error") {
      if (pendingAttach) {
        pendingAttach = false;
        const named = typeof message.heldBy === "string" && message.heldBy ? `held by ${message.heldBy}` : "";
        const reason = typeof message.reason === "string" && message.reason ? message.reason : "";
        showNotice(named || reason || `error ${message.status}`);
        return;
      }
      clearEditTimer();
      keptCaret = null;
      followCaret = null;
      followPath = false;
      rawSelectionLines = false;
      // A rejected delete left the file in place. It is not a lost caret grant.
      if (conflictWaiters[0] === "delete") {
        conflictWaiters.shift();
        return;
      }
      if (conflictWaiters[0] === "ticket") {
        conflictWaiters.shift();
        revertTicketForm();
        return;
      }
      // 400 does not answer a lock or an edit. A ticket.set behind them still reverts.
      if (message.status === 400) {
        const ticketAt = conflictWaiters.indexOf("ticket");
        if (ticketAt > 0 && conflictWaiters.slice(0, ticketAt).every((waiter) => waiter === "lock" || waiter === "edit")) {
          conflictWaiters.splice(ticketAt, 1);
          revertTicketForm();
          return;
        }
      }
      const answersCreate = conflictWaiters[0] === "create" && (message.status === 400 || message.status === 404 || isConflict(message));
      if (answersCreate) {
        conflictWaiters.shift();
        const at = fileWaiters.indexOf("create");
        if (at >= 0) fileWaiters.splice(at, 1);
        if (isConflict(message)) expectNewComment = false;
        // No repo is the one create refusal the page can name. A collision is another file, not a message.
        if (message.status === 400 && !activeRepo) showNotice("a repo has to be chosen first");
        return;
      }
      if (isConflict(message)) {
        const waiter = conflictWaiters.shift();
        if (waiter === "edit") {
          pinScrollHold = null;
          const prior = vimEditRegister || pendingSplicePrior();
          dropPendingEdits();
          if (prior) vimRegister = { text: prior.text, linewise: prior.linewise === true };
          armRefusal(message);
        }
        expectNewComment = false;
        // The caret has already left the body, so this refused claim must not put it back.
        if (waiter === "lock" && bodyCaretReleased) return;
        restoreGrantedCaret();
      }
      return;
    }
    let createdFile = false;
    if (message.type === "file") {
      if (fileWaiters.length > 0) {
        const waiter = fileWaiters.shift();
        if (waiter === "create") {
          const index = conflictWaiters.indexOf("create");
          if (index >= 0) conflictWaiters.splice(index, 1);
          createdFile = true;
        }
      }
      // Both lists mark openPath. Assign it before this render, or the previous
      // document stays marked beside the ticket this file message just opened.
      if (typeof message.path === "string" && message.path) {
        // A new name is not a place in the text. The offset stays.
        if (openPath && message.path !== openPath && live && !waitingForFile && !Number.isFinite(message.cursor)) {
          followCaret = { anchor: state.anchor, cursor: state.cursor, text: state.doc, hold: false };
          followPath = true;
        }
        openPath = message.path;
        seedOpen(message.path);
        renderFileTree(fileList, false);
      }
    }
    let ownEdit = false;
    if (message.type === "doc") {
      clearEditTimer();
      // A remote splice invalidates a half-typed count or operator. This socket's
      // own doc is the echo of a command that may already have typed the next one.
      if (vimOn && !ownActor(message)) clearVimPending();
      if (waitingForFile) {
        keptCaret = null;
        typingRun = null;
        clearVimHistoryFlight();
        return;
      }
      const nextRev = Number(message.rev);
      if (!Number.isFinite(nextRev) || nextRev !== rev + 1) {
        // The rename's doc is not this session's next edit. Same bytes reopen
        // at the offset the path change kept, not at 0.
        if (followPath && typeof message.text === "string" && message.text === state.doc) {
          followCaret = { anchor: state.anchor, cursor: state.cursor, text: state.doc, hold: true };
        } else {
          followCaret = null;
        }
        followPath = false;
        keptCaret = null;
        rawSelectionLines = false;
        waitingForFile = true;
        expectNewComment = false;
        dropPendingEdits();
        dropEditWaiters();
        emit({ type: "open", path: openPath });
        return;
      }
      followCaret = null;
      followPath = false;
      if (ownActor(message)) {
        pendingAttach = false;
        const index = conflictWaiters.indexOf("edit");
        if (index >= 0) {
          conflictWaiters.splice(index, 1);
          ownEdit = true;
          vimEditRegister = null;
          inflightEdit = null;
        }
      }
    }
    if (message.type === "file") typingRun = null;
    else if (message.type === "doc" && typingRun && !ownActor(message) && changeHits(state.doc, message, typingRun.blocks)) {
      typingRun = null;
    }
    if (message.type === "doc" && ownActor(message)) stageVimHistory(message);
    if (message.type === "doc" || message.type === "file") applySnapshot(message);
    if (message.type === "doc" && typingRun) typingRun.blocks = lineSet(state.anchor, state.cursor);
    if (message.type === "file") {
      syncFileTicket(message);
      reconnecting = false;
      if (resumeAfterFile) {
        resumeAfterFile = false;
        flushPendingEdit();
      }
    }
    if (ownEdit) flushPendingEdit();
    if (createdFile) focusCreatedFile();
  }

  function showNotice(text) {
    const parent = root.parentElement;
    if (!parent || typeof document === "undefined" || typeof document.createElement !== "function") return;
    if (!noticeEl || noticeEl.parentElement !== parent) {
      noticeEl = document.createElement("div");
      noticeEl.className = "md-notice";
      if (typeof noticeEl.setAttribute === "function") noticeEl.setAttribute("role", "status");
      parent.appendChild(noticeEl);
    }
    noticeEl.textContent = text;
    if (noticeTimer != null) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      noticeTimer = null;
      if (noticeEl) noticeEl.textContent = "";
    }, 4000);
  }

  function sendImage(bytes) {
    const payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (!openPath) {
      showNotice("missing document");
      return;
    }
    if (payload.byteLength === 0) {
      showNotice("empty image");
      return;
    }
    if (payload.byteLength > MAX_PAYLOAD) {
      showNotice("image is too large");
      return;
    }
    pendingAttach = true;
    emit({ type: "attach", path: openPath, cursor: state.cursor }, false);
    if (typeof active.sendBinary === "function") active.sendBinary(payload);
  }

  function consumePaste(text, data) {
    endTypingRunLater();
    if (pasteSeen) return;
    const files = fileListOf(data);
    if (files.length > 0) {
      pasteSeen = true;
      queueMicrotask(() => {
        pasteSeen = false;
      });
      const file = files.find((item) => isImageFile(item));
      if (!file) {
        showNotice("not an image");
        return;
      }
      if (!adoptDomSelection()) return;
      const read = typeof file.arrayBuffer === "function" ? file.arrayBuffer() : Promise.reject(new Error("empty"));
      Promise.resolve(read).then((buf) => {
        if (closed) return;
        sendImage(new Uint8Array(buf));
      }).catch(() => {
        if (!closed) showNotice("not an image");
      });
      return;
    }
    const raw = typeof text === "string" ? text : "";
    if (raw === "") return;
    pasteSeen = true;
    queueMicrotask(() => {
      pasteSeen = false;
    });
    if (!adoptDomSelection()) return;
    const decoded = decodeDataImage(raw);
    if (decoded === false) {
      showNotice("not an image");
      return;
    }
    if (decoded) {
      sendImage(decoded);
      return;
    }
    emitEdit({ op: "insert", text: raw, paste: true });
  }

  function moveCaret(direction, granularity, extend) {
    const sel = window.getSelection();
    if (!sel) return;
    if (sel.rangeCount === 0) placeCaret();
    const beforeCursor = state.cursor;
    const beforeAnchor = state.anchor;
    const before = lineIndexAt(state.doc, beforeCursor);
    // modify("move") on an extended range collapses to the focus and does not advance.
    if (granularity !== "line") goalX = null;
    else if (goalX == null) {
      const rect = caretRect();
      const left = rect && rect.left;
      // A caret on a break reports a 0×0 box at the origin. That is not a column.
      if (rect && rect.height > 0 && Number.isFinite(left)) goalX = left;
    }
    const caretPoint = pointFor(state.cursor);
    const forward = direction === "forward" || direction === "right";
    // A line modify lands on the editor root and Firefox keeps that selection.
    // Character steps reach the zero-width caret on the spaces or tab line.
    // Replacing the line after that step puts the caret on the paragraph.
    const above = !extend && granularity === "line" && direction === "backward"
      ? whitespaceLineAbove(state.doc, beforeCursor)
      : null;
    movingCaret = true;
    placingCaret = true;
    let landed = null;
    let hangAffinity = false;
    let stepped = false;
    try {
      try {
        if (above != null) {
          if (caretPoint) sel.collapse(caretPoint.node, caretPoint.offset);
          for (let hop = 0; hop < 8; hop += 1) {
            sel.modify("move", "backward", "character");
            const mapped = selectionFromDom(sel);
            if (mapped && mapped.anchor === above && mapped.cursor === above) {
              stepped = true;
              break;
            }
          }
          if (!stepped) landed = above;
        } else {
          if (caretPoint) sel.collapse(caretPoint.node, caretPoint.offset);
          sel.modify("move", direction, granularity);
          if (sel.rangeCount !== 0) {
            const range = sel.getRangeAt(0);
            landed = mapOffset(range.startContainer, range.startOffset);
            // A left press from the slack gap stays on the item offset. The glyph
            // before that offset is the last marker character.
            if (granularity === "character" && !forward && landed === beforeCursor && caretPoint && (crossedIntoRawMarker(caretPoint.node, range.startContainer) || inRawGap(caretPoint.node))) {
              hangAffinity = true;
            }
          }
        }
      } finally {
        placingCaret = false;
      }
      if (stepped) {
        state = { ...state, cursor: above, anchor: above };
        if (!claimLines(above, above)) return;
        whitespaceCaret = { anchor: above, cursor: above };
        return;
      }
      if (landed == null) return;
      let next = placeMove(state.doc, beforeCursor, landed, direction, granularity);
      // Up and down on a line drawn empty rest on its start.
      let heldWhitespace = false;
      if (granularity === "line") {
        next = lineCaret(state.doc, next);
        if (above != null) {
          next = above;
          heldWhitespace = true;
        } else {
          const held = whitespaceLineStop(state.doc, beforeCursor, next);
          if (held != null) {
            next = held;
            heldWhitespace = true;
          }
        }
      }
      // Firefox's lineboundary stops on the br, which is the hidden tail.
      if (!sourceMode && granularity === "lineboundary" && forward) next = endBeforeTail(state.doc, next);
      // Rendered markers have no glyphs, so one press crosses the whole marker.
      // Source mode draws those bytes, and a caret inside one stays there.
      if (!sourceMode) {
        // The browser stops inside a drawn marker, and on the br of a hard break.
        // A press that did not move still crosses a marker that has no text node
        // of its own. The start of a spaces-only or tab-only line is where up and
        // down stop, so that press does not cross it.
        for (let hop = 0; hop < 4; hop += 1) {
          if (granularity === "line" && bareBreakNewline(state.doc, next)) break;
          const skipped = skipHidden(state.doc, next, forward ? "forward" : "backward");
          if (skipped === next) break;
          next = skipped;
        }
        if (granularity === "character") next = markerEdgeStop(state.doc, beforeCursor, next, forward);
      }
      if (next === beforeCursor) {
        const neighbor = beforeCursor + (forward ? 1 : -1);
        if (neighbor >= 0 && neighbor <= state.doc.length) {
          if (granularity === "character" && !sourceMode) {
            const skipped = skipHidden(state.doc, neighbor, forward ? "forward" : "backward");
            if (skipped !== neighbor && skipped !== beforeCursor) next = skipped;
          }
          // A closed atom has no caret, so modify stays put. The neighbor is the entry.
          if (next === beforeCursor) {
            const atoms = plan(state.doc, beforeCursor).atoms;
            const into = atoms.some((atom) => (forward
              ? neighbor >= atom.start && neighbor < atom.end
              : neighbor > atom.start && neighbor <= atom.end));
            if (into) next = placeMove(state.doc, beforeCursor, neighbor, direction, granularity);
          }
        }
      }
      // The DOM step stayed on the marker's end, which is also the item's start.
      // The caret belongs on the last marker glyph.
      if (hangAffinity && next === beforeCursor && beforeCursor > 0) next = beforeCursor - 1;
      // No line is drawn after the final newline until the caret is on it, so the
      // browser cannot move there. The step is that offset. End stays on the line.
      if (granularity !== "lineboundary" && forward && next === beforeCursor && state.doc.endsWith("\n")) {
        const end = lineSpan(state.doc, beforeCursor)[1];
        if (end === state.doc.length - 1) next = state.doc.length;
      }
      // Up on the first line and down on the last land on that line's edge.
      // goalOffset would pull them back to the column they were already on.
      const [lineStart, lineEnd] = lineSpan(state.doc, next);
      const sameLine = lineStart === lineSpan(state.doc, beforeCursor)[0];
      const lineEdge = sameLine && (forward ? next === lineEnd : next === lineStart);
      if (granularity === "line" && typeof goalX === "number" && !bareBreakNewline(state.doc, next) && !lineEdge) {
        next = goalOffset(state.doc, next, goalX);
      }
      // Firefox's character step from the line above a rule lands on the line
      // after it. The rule has no glyphs, so the stop is the rule's start.
      if (!sourceMode && granularity === "character" && forward) {
        const rule = ruleLineStop(state.doc, beforeCursor);
        if (rule != null) next = rule;
      }
      if (!sourceMode && granularity === "lineboundary" && forward) next = endBeforeTail(state.doc, next);
      const anchor = extend ? beforeAnchor : next;
      state = { ...state, cursor: next, anchor };
      if (!claimLines(anchor, next)) return;
      const after = lineIndexAt(state.doc, state.cursor);
      const drawn = pointFor(next);
      // modify stops on the marker edge, which is this same offset. The gap's end
      // is where the next letter is drawn, so the caret has to be placed there.
      // A zero-width marker's own stop has no box, so the caret is placed on the text.
      if (before !== after) render();
      else if (anchor !== next || next !== landed || inRawGap(drawn && drawn.node) || markerCaretUnboxed(state.doc, next)) placeCaret();
      // The selection is already on this stop, so the caret is not placed again.
      // Firefox's block is a separate mark and would stay where it was.
      else syncVimBlockMark();
      if (heldWhitespace) holdWhitespaceCaret();
    } finally {
      movingCaret = false;
    }
  }

  // The newline of this line sits in a hidden hard-break tail.
  function hiddenTailLine(doc, offset) {
    const end = lineSpan(doc, offset)[1];
    if (end >= doc.length || doc[end] !== "\n") return false;
    return endBeforeTail(doc, end) < end;
  }

  function lineElementOf(node) {
    let el = node && node.nodeType === 3 ? node.parentElement : node;
    while (el && el !== root) {
      if (hasClass(el, "md-line")) return el;
      el = el.parentElement;
    }
    return null;
  }

  function textLength(node) {
    if (!node || node.nodeType !== 3) return 0;
    if (typeof node.length === "number") return node.length;
    return typeof node.textContent === "string" ? node.textContent.length : 0;
  }

  function hasEarlierContent(line, target) {
    let earlier = false;
    const visit = (node) => {
      if (node === target) return true;
      if (node.nodeType === 3) {
        if (textLength(node) > 0) earlier = true;
        return false;
      }
      if (hasClass(node, "md-atom")) {
        earlier = true;
        return false;
      }
      for (const child of node.childNodes || []) {
        if (visit(child)) return true;
      }
      return false;
    };
    visit(line);
    return earlier;
  }

  function atVisualLineStart(node, offset) {
    const line = lineElementOf(node);
    if (!line || hasEarlierContent(line, node)) return false;
    if (isBreak(node)) return true;
    return offset === 0;
  }

  function collapsedCaret() {
    const sel = typeof window !== "undefined" && window.getSelection ? window.getSelection() : null;
    if (!sel || sel.rangeCount === 0) return null;
    let node = sel.focusNode || null;
    let offset = node ? sel.focusOffset : 0;
    if (!node && typeof sel.getRangeAt === "function") {
      const range = sel.getRangeAt(0);
      if (!range || range.collapsed === false) return null;
      if (range.startContainer !== range.endContainer || range.startOffset !== range.endOffset) return null;
      node = range.startContainer;
      offset = range.startOffset;
    }
    if (!node || !root.contains(node)) return null;
    if (sel.anchorNode && (sel.anchorNode !== node || sel.anchorOffset !== offset)) return null;
    return { node, offset: offset || 0 };
  }

  // A rendered line hides its marker, so the caret at the visual start is not
  // the source line start. Snap there so backspace deletes the preceding newline.
  function prepareBackwardDelete() {
    const caret = collapsedCaret();
    if (caret && atVisualLineStart(caret.node, caret.offset)) {
      const mapped = mapOffset(caret.node, caret.offset);
      if (Number.isFinite(mapped)) {
        const start = lineSpan(state.doc, mapped)[0];
        if (start !== state.cursor || start !== state.anchor) {
          state = { ...state, anchor: start, cursor: start };
        }
      }
    }
    return true;
  }

  // One code unit. The hub's backspace and delete treat markers, atoms, and CRLF specially.
  function rawErase(direction) {
    let from = Math.min(state.anchor, state.cursor);
    let to = Math.max(state.anchor, state.cursor);
    if (from === to) {
      if (direction < 0) {
        if (from <= 0) return;
        from -= 1;
      } else {
        if (to >= state.doc.length) return;
        to += 1;
      }
    }
    emitEdit({ op: "insert", text: "", anchor: from, cursor: to });
  }

  function rawEraseWord(direction) {
    if (state.anchor !== state.cursor) {
      rawErase(direction);
      return;
    }
    const edges = wordEdges(state.doc, state.cursor, direction);
    if (edges[0] === edges[1]) return;
    emitEdit({ op: "insert", text: "", anchor: edges[0], cursor: edges[1] });
  }

  // Enter is one file newline. enterBreak would insert a marker and renumber.
  function rawBeforeInput(type, event) {
    if (type === "insertText") {
      if (event.data === "\t") return true;
      if (event.data === "\n" || event.data === "\r" || event.data === "\r\n") {
        if (event.data === composed) return true;
        emitEdit({ op: "insert", text: fileBreak(state.doc) });
        return true;
      }
      if (event.data && event.data !== composed) {
        if (typedText(event.data)) emitTyping({ op: "insert", text: event.data });
        else emitEdit({ op: "insert", text: event.data });
      }
      return true;
    }
    if (type === "insertParagraph" || type === "insertLineBreak") {
      emitEdit({ op: "insert", text: fileBreak(state.doc) });
      return true;
    }
    if (type === "deleteContentBackward") {
      rawErase(-1);
      return true;
    }
    if (type === "deleteContentForward") {
      rawErase(1);
      return true;
    }
    if (type === "deleteWordBackward" || type === "deleteWordForward") {
      rawEraseWord(type === "deleteWordBackward" ? -1 : 1);
      return true;
    }
    return false;
  }

  function rawMoveKey(key) {
    return key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown" || key === "Home" || key === "End";
  }

  function rawVerticalOffset(forward) {
    const doc = state.doc;
    const cursor = state.cursor;
    const [start, end] = lineSpan(doc, cursor);
    if (!forward && start === 0) return 0;
    if (forward && end === doc.length) return doc.length;
    const column = rawColumn == null ? cursor - start : rawColumn;
    const neighbor = forward ? end + 1 : start - 1;
    const [nStart, nEnd] = lineSpan(doc, neighbor);
    const next = Math.min(nStart + column, nEnd);
    if (typeof goalX === "number") {
      const aimed = goalOffset(doc, next, goalX);
      if (Number.isFinite(aimed)) return aimed;
    }
    return next;
  }

  // The LF of a CRLF is not a stop. Right from the CR lands after the pair.
  // Left from the next line lands on the CR.
  function rawSibling(doc, offset, direction) {
    const at = Math.max(0, Math.min(doc.length, offset));
    if (direction > 0) {
      if (at < doc.length && doc[at] === "\r" && doc[at + 1] === "\n") return Math.min(doc.length, at + 2);
      return Math.min(doc.length, at + 1);
    }
    if (at > 1 && doc[at - 1] === "\n" && doc[at - 2] === "\r") return at - 2;
    return Math.max(0, at - 1);
  }

  function rawCharRect(node, index) {
    if (typeof document === "undefined" || typeof document.createRange !== "function") return null;
    try {
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + 1);
      let rect = null;
      if (typeof range.getClientRects === "function") {
        const rects = range.getClientRects();
        if (rects && rects.length) rect = rects[0];
      }
      if ((!rect || !Number.isFinite(rect.top)) && typeof range.getBoundingClientRect === "function") rect = range.getBoundingClientRect();
      if (!rect || !Number.isFinite(rect.top) || !Number.isFinite(rect.left) || !Number.isFinite(rect.bottom)) return null;
      if (!(rect.height > 0) && !(rect.width > 0)) return null;
      return rect;
    } catch {
      return null;
    }
  }

  // Glyphs of the drawn source, plus the br an empty line uses as its caret.
  // No layout (the unit host) yields nothing, and movement stays on source lines.
  function rawLayoutSlots() {
    if (typeof document === "undefined" || typeof document.createRange !== "function" || typeof document.createTreeWalker !== "function") return [];
    let probe = null;
    try {
      probe = document.createRange();
    } catch {
      return [];
    }
    if (!probe || (typeof probe.getClientRects !== "function" && typeof probe.getBoundingClientRect !== "function")) return [];
    const slots = [];
    let walker = null;
    try {
      const show = typeof NodeFilter === "undefined" ? 4 : NodeFilter.SHOW_TEXT;
      walker = document.createTreeWalker(root, show);
    } catch {
      return [];
    }
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.closest?.(".md-atom") || node.parentElement?.closest?.(".md-lock")) continue;
      const tagged = nearestTagged(node);
      if (!tagged) continue;
      const start = Number(tagged.dataset.start);
      const end = Number(tagged.dataset.end);
      const len = textLength(node);
      if (!Number.isFinite(start) || len !== end - start || len <= 0) continue;
      for (let i = 0; i < len; i += 1) {
        const rect = rawCharRect(node, i);
        if (!rect) continue;
        slots.push({
          offset: start + i,
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          mid: (rect.top + rect.bottom) / 2,
          bare: false,
        });
      }
    }
    if (typeof root.querySelectorAll !== "function") return slots;
    for (const br of root.querySelectorAll("br")) {
      const line = br.parentElement && typeof br.parentElement.closest === "function" ? br.parentElement.closest(".md-source-line") : null;
      if (!line) continue;
      const start = Number(line.dataset && line.dataset.start);
      const end = Number(line.dataset && line.dataset.end);
      if (start !== end) continue;
      if (typeof br.getBoundingClientRect !== "function") continue;
      const rect = br.getBoundingClientRect();
      if (!rect || !Number.isFinite(rect.top) || !Number.isFinite(rect.bottom) || !(rect.height > 0)) continue;
      slots.push({
        offset: start,
        left: rect.left,
        right: rect.left,
        mid: (rect.top + rect.bottom) / 2,
        bare: true,
      });
    }
    return slots;
  }

  function rawSlotAt(slots, offset) {
    let at = null;
    let before = null;
    for (const slot of slots) {
      if (slot.offset === offset) at = slot;
      else if (slot.offset === offset - 1 && !slot.bare) before = slot;
    }
    return at || before;
  }

  // Home and End use the browser's wrapped line. Up and Down step to the next
  // wrapped line and keep the caret's x. Null means the host has no layout.
  function rawVisualOffset(key) {
    const slots = rawLayoutSlots();
    if (slots.length === 0) return null;
    const origin = rawSlotAt(slots, state.cursor);
    if (!origin) return null;
    const same = [];
    for (const slot of slots) if (Math.abs(slot.mid - origin.mid) <= 3) same.push(slot);
    if (same.length === 0) return null;
    if (key === "Home") {
      let best = same[0].offset;
      for (const slot of same) if (slot.offset < best) best = slot.offset;
      return best;
    }
    if (key === "End") {
      let last = null;
      for (const slot of same) {
        if (slot.bare) continue;
        if (last == null || slot.offset > last) last = slot.offset;
      }
      if (last == null) return origin.offset;
      return Math.min(state.doc.length, last + 1);
    }
    const below = key === "ArrowDown";
    const x = typeof goalX === "number" ? goalX : origin.left;
    let band = null;
    for (const slot of slots) {
      if (below ? slot.mid <= origin.mid + 3 : slot.mid >= origin.mid - 3) continue;
      if (band == null || (below ? slot.mid < band - 3 : slot.mid > band + 3)) band = slot.mid;
    }
    if (band == null) return state.cursor;
    let best = null;
    let bestDist = Infinity;
    for (const slot of slots) {
      if (Math.abs(slot.mid - band) > 3) continue;
      const dist = Math.abs(slot.left - x);
      if (!best || dist < bestDist || (dist === bestDist && slot.offset < best.offset)) {
        best = slot;
        bestDist = dist;
      }
    }
    return best ? best.offset : state.cursor;
  }

  // Ctrl+arrow. Alt stays one character, and Meta is not this chord.
  function wordArrow(event) {
    if (!event || event.altKey === true || event.metaKey === true || event.ctrlKey !== true) return false;
    return event.key === "ArrowLeft" || event.key === "ArrowRight";
  }

  function moveByWord(forward, extend) {
    goalX = null;
    rawColumn = null;
    const beforeCursor = state.cursor;
    const beforeAnchor = state.anchor;
    const before = lineIndexAt(state.doc, beforeCursor);
    const next = wordStop(state.doc, beforeCursor, forward ? 1 : -1);
    const anchor = extend ? beforeAnchor : next;
    state = { ...state, cursor: next, anchor };
    if (!claimLines(anchor, next)) return;
    if (before !== lineIndexAt(state.doc, state.cursor)) render();
    else placeCaret();
  }

  // Chromium paints a collapsed caret after a soft wrap on the next line.
  // End belongs at the end of the line it landed on. One character back is
  // still on that line, and the line boundary returns to this offset painted there.
  function hangRawLineEnd() {
    if (state.anchor !== state.cursor || state.cursor <= 0) return;
    const prev = state.cursor - 1;
    if (state.doc[prev] === "\n" || state.doc[prev] === "\r") return;
    const point = pointFor(prev);
    const glyph = point && point.node && point.node.nodeType === 3 ? rawCharRect(point.node, point.offset) : null;
    const caret = caretRect();
    if (!glyph || !caret || !(glyph.height > 0) || !(caret.height > 0)) return;
    const glyphMid = (glyph.top + glyph.bottom) / 2;
    const caretMid = (caret.top + caret.bottom) / 2;
    if (!(caretMid > glyphMid + 3)) return;
    const sel = window.getSelection();
    if (!sel || typeof sel.modify !== "function" || sel.rangeCount === 0) return;
    const want = state.cursor;
    placingCaret = true;
    try {
      sel.modify("move", "backward", "character");
      sel.modify("move", "forward", "lineboundary");
    } finally {
      placingCaret = false;
    }
    const mapped = selectionFromDom(sel);
    if (!mapped || mapped.anchor !== want || mapped.cursor !== want) placeCaret();
  }

  function moveRawCaret(key, extend, jump) {
    const vertical = key === "ArrowUp" || key === "ArrowDown";
    if (!vertical) {
      goalX = null;
      rawColumn = null;
    } else {
      if (goalX == null) {
        const rect = caretRect();
        const left = rect && rect.left;
        if (rect && rect.height > 0 && Number.isFinite(left)) goalX = left;
      }
      if (rawColumn == null) rawColumn = state.cursor - lineSpan(state.doc, state.cursor)[0];
    }
    const beforeCursor = state.cursor;
    const beforeAnchor = state.anchor;
    const before = lineIndexAt(state.doc, beforeCursor);
    let next = beforeCursor;
    if (jump && (key === "Home" || key === "End")) next = key === "Home" ? 0 : state.doc.length;
    else if (key === "ArrowLeft") next = rawSibling(state.doc, beforeCursor, -1);
    else if (key === "ArrowRight") next = rawSibling(state.doc, beforeCursor, 1);
    else if (key === "Home" || key === "End" || vertical) {
      const visual = rawVisualOffset(key);
      if (visual == null) {
        if (key === "Home") next = lineSpan(state.doc, beforeCursor)[0];
        else if (key === "End") next = lineSpan(state.doc, beforeCursor)[1];
        else next = rawVerticalOffset(key === "ArrowDown");
      } else next = visual;
    }
    const anchor = extend ? beforeAnchor : next;
    state = { ...state, cursor: next, anchor };
    if (!claimLines(anchor, next)) return;
    const after = lineIndexAt(state.doc, state.cursor);
    if (before !== after) render();
    else placeCaret();
    if (key === "End" && !extend && !jump) hangRawLineEnd();
  }

  // Enter on an item inserts the same kind of marker. A paragraph whose next
  // line would join it inserts the blank line that keeps them apart.
  function emitBreakResult(brk) {
    const partial = { op: "insert", text: brk.text };
    if (typeof brk.anchor === "number") {
      partial.anchor = brk.anchor;
      partial.cursor = brk.cursor;
    }
    if (typeof brk.caret === "number") partial.caret = brk.caret;
    emitEdit(partial);
  }

  function emitBreak() {
    emitBreakResult(enterBreak(state.doc, state.anchor, state.cursor));
  }

  // Shift+Enter is a hard break. Enter stays emitBreak.
  function emitLineBreak() {
    const brk = shiftBreak(state.doc, state.anchor, state.cursor);
    const inserted = typeof brk.text === "string" ? brk.text : "";
    const from = typeof brk.anchor === "number" ? Math.min(brk.anchor, brk.cursor) : Math.min(state.anchor, state.cursor);
    bareBreakAt = inserted === "\\" ? from : null;
    emitBreakResult(brk);
  }

  listen("beforeinput", (event) => {
    commentFocus = null;
    event.preventDefault();
    if (composing) return;
    const type = event.inputType;
    // Normal and Visual are keys. A browser that still delivers the character
    // after a consumed keydown must not insert it. Paste, cut, and copy stay.
    // The status pins on a paint; dropping the character still places it once
    // the pane has a box.
    if (vimOn && !vimInsertKeys() && (type === "insertText" || type === "insertParagraph" || type === "insertLineBreak")) {
      pinViewToggle();
      return;
    }
    const edits = type === "insertText"
      || type === "insertParagraph"
      || type === "insertLineBreak"
      || type === "deleteContentBackward"
      || type === "deleteContentForward"
      || type === "deleteWordBackward"
      || type === "deleteWordForward"
      || type === "insertFromPaste"
      || type === "insertFromDrop";
    if (edits && !adoptDomSelection()) return;
    if (sourceMode && rawBeforeInput(type, event)) return;
    if (type === "insertText") {
      if (event.data === "\t") return;
      if (event.data === "\n") {
        if (event.data === composed) return;
        emitBreak();
        return;
      }
      if (event.data && event.data !== composed) {
        if (typedText(event.data)) emitTyping({ op: "insert", text: event.data });
        else emitEdit({ op: "insert", text: event.data });
      }
      return;
    }
    if (type === "insertCompositionText" || type === "insertFromComposition") return;
    if (type === "insertParagraph") {
      emitBreak();
      return;
    }
    if (type === "insertLineBreak") {
      emitLineBreak();
      return;
    }
    if (type === "deleteContentBackward") {
      if (!prepareBackwardDelete()) return;
      emitEdit({ op: "backspace" });
      return;
    }
    if (type === "deleteContentForward") {
      // An empty line is a forward delete. Backspace would leave the caret
      // on the line above; the next line moves up instead, marker and all.
      emitEdit({ op: "delete" });
      return;
    }
    if (type === "deleteWordBackward" || type === "deleteWordForward") {
      if (state.anchor !== state.cursor) {
        emitEdit({ op: "delete" });
        return;
      }
      const [start, end] = lineSpan(state.doc, state.cursor);
      if (start === end) {
        // An empty line has no word, so this is Backspace or Delete. Taking the
        // neighboring word would delete different bytes.
        if (type === "deleteWordForward" && state.cursor === 0) emitEdit({ op: "delete" });
        else emitEdit({ op: "backspace" });
        return;
      }
      const edges = wordEdges(state.doc, state.cursor, type === "deleteWordBackward" ? -1 : 1);
      const [from, to] = expandAtoms(state.doc, edges[0], edges[1], state.cursor);
      if (from !== to) emitEdit({ op: "delete", anchor: from, cursor: to });
      return;
    }
    if (type === "insertFromPaste" || type === "insertFromDrop") {
      if (type === "insertFromDrop" && dragSource) {
        const source = dragSource;
        dragSource = null;
        dragRange = null;
        let dest = state.cursor;
        const ranges = typeof event.getTargetRanges === "function" ? event.getTargetRanges() : null;
        if (ranges && ranges.length > 0) {
          const range = ranges[0];
          const mapped = mapOffset(range.startContainer, range.startOffset);
          if (Number.isFinite(mapped)) dest = mapped;
        }
        emitEdit({ op: "move", anchor: source.anchor, cursor: source.cursor, dest });
        return;
      }
      const transfer = event.dataTransfer;
      const text = transfer?.getData?.("text/plain") ?? event.data ?? "";
      consumePaste(text, transfer);
    }
  });

  listen("paste", (event) => {
    event.preventDefault();
    consumePaste(event.clipboardData?.getData("text/plain") ?? "", event.clipboardData);
  });

  function transferHas(data, type) {
    const types = data && data.types;
    if (!types) return false;
    if (typeof types.includes === "function" && types.includes(type)) return true;
    const count = typeof types.length === "number" ? types.length : 0;
    for (let i = 0; i < count; i += 1) if (types[i] === type) return true;
    return false;
  }

  function dropPin(event) {
    const node = event.target && event.target.nodeType === 1 ? event.target : event.target && event.target.parentElement;
    if (!node || typeof node.closest !== "function") return;
    const image = node.closest(".md-image");
    const diagram = image ? null : node.closest(".md-diagram");
    const host = image || diagram;
    if (!host) return;
    if (hasClass(host, "md-raw") || (typeof host.closest === "function" && host.closest(".md-raw"))) return;
    const picture = drawnPicture(host);
    if (!picture || typeof picture.getBoundingClientRect !== "function") return;
    const rect = picture.getBoundingClientRect();
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) return;
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return;
    const offset = Number(host.dataset && host.dataset.start);
    if (!Number.isFinite(offset)) return;
    expectNewComment = true;
    const before = state.doc;
    emitEdit({ op: "comment.pin", offset, x, y });
    if (state.doc === before && (active.memory === true || !live)) expectNewComment = false;
  }

  listen("dragover", (event) => {
    const data = event.dataTransfer;
    if (fileListOf(data).length === 0 && !transferHas(data, "text/viewmark-pin")) return;
    if (typeof event.preventDefault === "function") event.preventDefault();
  });

  listen("drop", (event) => {
    if (dragSource) return;
    if (transferHas(event.dataTransfer, "text/viewmark-pin")) {
      if (typeof event.preventDefault === "function") event.preventDefault();
      dropPin(event);
      return;
    }
    if (fileListOf(event.dataTransfer).length === 0) return;
    if (typeof event.preventDefault === "function") event.preventDefault();
    consumePaste("", event.dataTransfer);
  });

  listen("copy", (event) => {
    event.preventDefault();
    event.clipboardData.setData("text/plain", selectedSlice(state));
  });

  listen("cut", (event) => {
    endTypingRunLater();
    event.preventDefault();
    // A block caret collapses the DOM range. Visual already stores its span.
    const visualCut = vimOn && (vimMode === "visual" || vimMode === "visual-line");
    if (!visualCut && !adoptDomSelection()) return;
    const text = selectedSlice(state);
    event.clipboardData.setData("text/plain", text);
    if (state.anchor === state.cursor) return;
    if (sourceMode) rawErase(1);
    else emitEdit({ op: "delete" });
    useVimSelection("normal");
  });

  listen("compositionstart", () => {
    if (!composing) compositionOrigin = { anchor: state.anchor, cursor: state.cursor };
    composing = true;
  });

  // The browser has already put the composed characters in the DOM, one caret
  // past where composition started. Insert at that saved caret, not the DOM one.
  listen("compositionend", (event) => {
    const origin = compositionOrigin;
    compositionOrigin = null;
    composing = false;
    composed = event.data || "";
    if (origin) state = { ...state, anchor: origin.anchor, cursor: origin.cursor };
    if (vimOn && !vimInsertKeys()) {
      composed = "";
      render();
      return;
    }
    if (composed && claimLines(state.anchor, state.cursor)) {
      if (typedText(composed)) emitTyping({ op: "insert", text: composed });
      else emitEdit({ op: "insert", text: composed });
    }
    queueMicrotask(() => {
      composed = "";
    });
  });

  function vimSnapshot() {
    return {
      mode: vimMode,
      input: {
        prefixRepeat: vimInput.prefixRepeat || "",
        operator: vimInput.operator || null,
        motionRepeat: vimInput.motionRepeat || "",
        motion: null,
        keyBuffer: vimInput.keyBuffer || "",
      },
      register: {
        text: vimRegister && typeof vimRegister.text === "string" ? vimRegister.text : "",
        linewise: !!(vimRegister && vimRegister.linewise),
      },
      search: vimSearch,
      find: vimFind,
      column: vimColumn,
      once: vimOnce === true,
    };
  }

  function rememberVim(vim) {
    const next = vim || {};
    const wasInsert = vimMode === "insert";
    vimMode = typeof next.mode === "string" && next.mode ? next.mode : "normal";
    // The one-second window must not attach a new Insert session to the previous run.
    // The splice that entered, such as cw's delete, is the first and stays ungrouped.
    if (vimMode === "insert" && !wasInsert) {
      vimInsertOpen = false;
      typingRun = null;
    } else if (vimMode !== "insert") {
      vimInsertOpen = false;
    }
    const input = next.input || {};
    vimInput = {
      prefixRepeat: typeof input.prefixRepeat === "string" ? input.prefixRepeat : "",
      operator: input.operator || null,
      motionRepeat: typeof input.motionRepeat === "string" ? input.motionRepeat : "",
      keyBuffer: typeof input.keyBuffer === "string" ? input.keyBuffer : "",
    };
    const register = next.register || {};
    vimRegister = {
      text: typeof register.text === "string" ? register.text : "",
      linewise: register.linewise === true,
    };
    vimSearch = next.search || null;
    // A star or hash search replaces the pattern. The prompt paint would be the old one.
    if (!vimPrompt && vimPaintHold && (!vimSearch || vimSearch.pattern !== vimPaintHold.pattern)) {
      vimPaintHold = null;
      syncVimMatchPaint();
    }
    vimFind = next.find || null;
    vimColumn = Number.isInteger(next.column) ? next.column : null;
    vimOnce = next.once === true;
    syncVimCaret();
    if (vimStatus) vimStatus.textContent = vimStatusText(vimMode, vimInput);
  }

  // The gesture already stored the selection. The snapshot keeps the register,
  // and the block caret follows the mode. Nothing here splices.
  function useVimSelection(mode) {
    if (!vimOn) return;
    rememberVim({ ...vimSnapshot(), mode });
  }

  // v from Visual Line keeps the current span. A click has already collapsed it,
  // so the mode has to leave or that v would select nothing.
  function caretClickLeavesVisual() {
    if (vimMode !== "visual" && vimMode !== "visual-line") return;
    useVimSelection("normal");
  }

  function vimInsertKeys() {
    return vimMode === "insert" && vimOnce !== true;
  }

  // No bytes changed, so the destination is claimed the way an arrow claims its line.
  function moveVimCaret(nextAnchor, nextCursor) {
    const length = state.doc.length;
    const anchor = Math.max(0, Math.min(length, Number.isFinite(nextAnchor) ? Math.trunc(nextAnchor) : 0));
    const cursor = Math.max(0, Math.min(length, Number.isFinite(nextCursor) ? Math.trunc(nextCursor) : anchor));
    const before = lineIndexAt(state.doc, state.cursor);
    state = { ...state, anchor, cursor };
    if (!claimLines(anchor, cursor)) return;
    if (before !== lineIndexAt(state.doc, state.cursor)) render();
    else placeCaret();
  }

  function applyVimWordDelete() {
    if (state.anchor !== state.cursor) {
      if (sourceMode) rawErase(-1);
      else emitEdit({ op: "delete" });
      return;
    }
    if (sourceMode) {
      rawEraseWord(-1);
      return;
    }
    const [start, end] = lineSpan(state.doc, state.cursor);
    if (start === end) {
      emitEdit({ op: "backspace" });
      return;
    }
    const edges = wordEdges(state.doc, state.cursor, -1);
    const [from, to] = expandAtoms(state.doc, edges[0], edges[1], state.cursor);
    if (from !== to) emitEdit({ op: "delete", anchor: from, cursor: to });
  }

  function clearVimPending() {
    vimInput = emptyVimInput();
    if (vimStatus) vimStatus.textContent = vimStatusText(vimMode, vimInput);
  }

  function elementsWithClass(className) {
    const found = [];
    const walk = (node) => {
      if (!node || node.nodeType !== 1) return;
      if (hasClass(node, className)) found.push(node);
      for (const child of node.childNodes || []) walk(child);
    };
    for (const child of root.childNodes || []) walk(child);
    return found;
  }

  function lineSourceSpan(line) {
    let start = null;
    let end = null;
    const take = (el) => {
      if (!el || el.nodeType !== 1 || !el.dataset) return;
      if (el.dataset.start == null || el.dataset.start === "") return;
      const s = Number(el.dataset.start);
      const e = el.dataset.end == null || el.dataset.end === "" ? s : Number(el.dataset.end);
      if (!Number.isFinite(s)) return;
      if (start == null || s < start) start = s;
      if (Number.isFinite(e) && (end == null || e > end)) end = e;
    };
    const walk = (el) => {
      take(el);
      for (const child of el.childNodes || []) {
        if (child && child.nodeType === 1) walk(child);
      }
    };
    walk(line);
    if (start == null) return null;
    return { start, end: end == null ? start : end };
  }

  function glyphLive(box) {
    return !!box && Number.isFinite(box.top) && Number.isFinite(box.bottom) && box.bottom > box.top;
  }

  // One pass. Screen motions ask for every drawn glyph, and a walk per offset
  // would reread the tree for each of them.
  function vimGlyphs() {
    const glyphs = new Map();
    if (typeof document === "undefined" || typeof document.createTreeWalker !== "function" || typeof document.createRange !== "function") return glyphs;
    let walker = null;
    try {
      const show = typeof NodeFilter === "undefined" ? 4 : NodeFilter.SHOW_TEXT;
      walker = document.createTreeWalker(root, show);
    } catch {
      return glyphs;
    }
    if (!walker) return glyphs;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (parent && typeof parent.closest === "function" && (parent.closest(".md-atom") || parent.closest(".md-lock"))) continue;
      const tagged = nearestTagged(node);
      if (!tagged || (typeof tagged.closest === "function" && tagged.closest(".md-lock"))) continue;
      const start = Number(tagged.dataset.start);
      const end = Number(tagged.dataset.end);
      const len = textLength(node);
      if (!Number.isFinite(start) || len !== end - start || len <= 0) continue;
      for (let i = 0; i < len; i += 1) {
        const rect = rawCharRect(node, i);
        if (!glyphLive(rect)) continue;
        glyphs.set(start + i, rect);
      }
    }
    return glyphs;
  }

  // The caret sits on the glyph after it. At a newline that glyph is missing,
  // and the row is the one that ends there.
  function vimCaretGlyph(glyphs, cursor) {
    const here = glyphs.get(cursor);
    if (glyphLive(here)) return here;
    if (cursor > 0) {
      const prev = glyphs.get(cursor - 1);
      if (glyphLive(prev)) return prev;
    }
    return null;
  }

  // Subpixel rounding puts one glyph a pixel off its row. Two pixels is a new row.
  function vimDisplayRow(glyphs, doc, cursor) {
    const glyph = vimCaretGlyph(glyphs, cursor);
    if (!glyph) return null;
    const mid = (box) => (box.top + box.bottom) / 2;
    const slack = 2;
    let from = cursor;
    for (; from > 0; from -= 1) {
      const prev = glyphs.get(from - 1);
      if (!glyphLive(prev) || mid(prev) < glyph.top - slack) break;
    }
    let to = cursor;
    for (; to < doc.length; to += 1) {
      const next = glyphs.get(to);
      if (glyphLive(next)) {
        if (mid(next) > glyph.bottom + slack) break;
      } else if (doc[to] === "\n") break;
    }
    return { from, to };
  }

  function vimPane() {
    const view = typeof window !== "undefined" ? window : null;
    if (!view || !root) return null;
    const box = elementRect(root);
    if (!box) return null;
    const height = view.innerHeight;
    if (!Number.isFinite(height) || !(height > 0)) return null;
    const top = Number(box.top);
    const bottom = Number(box.bottom);
    if (!Number.isFinite(top) || !Number.isFinite(bottom)) return null;
    const paneTop = Math.max(top, 0);
    const paneBottom = Math.min(bottom, height);
    if (!(paneBottom > paneTop)) return null;
    return { paneTop, paneBottom };
  }

  function vimPaneRows(glyphs) {
    const pane = vimPane();
    if (!pane) return null;
    const rows = [];
    for (const line of elementsWithClass("md-line")) {
      if (hasClass(line, "md-paragraph-gap")) continue;
      const span = lineSourceSpan(line);
      if (!span) continue;
      const seen = new Map();
      for (let i = span.start; i < span.end; i += 1) {
        const g = glyphs.get(i);
        if (!glyphLive(g)) continue;
        const gmid = (g.top + g.bottom) / 2;
        if (gmid < pane.paneTop || gmid >= pane.paneBottom) continue;
        const key = Math.round(g.top);
        if (!seen.has(key)) seen.set(key, { at: i, top: g.top, bottom: g.bottom, end: span.end });
      }
      if (seen.size === 0) {
        const rect = elementRect(line);
        if (!rect || !(rect.height > 0)) continue;
        const mid = (rect.top + rect.bottom) / 2;
        if (!Number.isFinite(mid) || mid < pane.paneTop || mid >= pane.paneBottom) continue;
        rows.push({ at: span.start, top: rect.top, bottom: rect.bottom, end: span.end });
        continue;
      }
      for (const row of seen.values()) rows.push(row);
    }
    rows.sort((a, b) => a.top - b.top || a.at - b.at);
    return { rows, paneTop: pane.paneTop, paneBottom: pane.paneBottom };
  }

  function vimFirstNonBlank(doc, at, end) {
    let i = at;
    const limit = Math.min(doc.length, end);
    while (i < limit && (doc[i] === " " || doc[i] === "\t")) i += 1;
    return i < limit ? i : at;
  }

  function vimRenderedStarts() {
    const starts = [];
    for (const line of elementsWithClass("md-line")) {
      if (hasClass(line, "md-paragraph-gap")) continue;
      const span = lineSourceSpan(line);
      if (span) starts.push(span.start);
    }
    return starts;
  }

  function vimSourceStarts(doc) {
    const starts = [];
    let start = 0;
    for (let i = 0; i <= doc.length; i += 1) {
      if (i === doc.length || doc[i] === "\n") {
        starts.push(start);
        start = i + 1;
        if (i === doc.length) break;
      }
    }
    if (starts.length === 0) starts.push(0);
    return starts;
  }

  function vimStepTo(starts, offset, delta) {
    if (starts.length === 0) return offset;
    let index = 0;
    for (let i = 0; i < starts.length; i += 1) {
      if (starts[i] <= offset) index = i;
      else break;
    }
    const next = Math.max(0, Math.min(starts.length - 1, index + delta));
    return starts[next];
  }

  function landVim(at) {
    const extend = vimMode === "visual" || vimMode === "visual-line";
    const pos = Math.max(0, Math.min(state.doc.length, at));
    moveVimCaret(extend ? state.anchor : pos, pos);
  }

  function vimCaretLine() {
    const view = typeof window !== "undefined" ? window : null;
    const sel = view && typeof view.getSelection === "function" ? view.getSelection() : null;
    const painted = lineElementOf(sel && sel.focusNode);
    if (painted) return painted;
    let best = null;
    let bestStart = -1;
    for (const line of elementsWithClass("md-line")) {
      const span = lineSourceSpan(line);
      if (!span) continue;
      if (state.cursor < span.start || state.cursor > span.end) continue;
      if (!best || span.start >= bestStart) {
        best = line;
        bestStart = span.start;
      }
    }
    return best;
  }

  function scrollVimCaretLine(edge) {
    const block = edge === "top" ? "start" : edge === "bottom" ? "end" : "center";
    const line = vimCaretLine();
    if (!line || typeof line.scrollIntoView !== "function") return;
    line.scrollIntoView({ block });
  }

  function captureScroll() {
    const saved = [];
    const remember = (el) => {
      if (!el) return;
      for (const item of saved) if (item.el === el) return;
      try {
        const top = el.scrollTop;
        const left = el.scrollLeft;
        if (typeof top !== "number" || typeof left !== "number") return;
        saved.push({ el, top, left });
      } catch {
        // A node without a scroll box has nothing to put back.
      }
    };
    if (typeof document !== "undefined" && document) {
      remember(document.scrollingElement);
      remember(document.documentElement);
      remember(document.body);
    }
    let node = root;
    while (node) {
      remember(node);
      node = node.parentElement;
    }
    const view = typeof window !== "undefined" ? window : null;
    const x = view && typeof view.scrollX === "number" ? view.scrollX : null;
    const y = view && typeof view.scrollY === "number" ? view.scrollY : null;
    return { saved, view, x, y };
  }

  function restoreScroll(shot) {
    if (!shot) return;
    for (const item of shot.saved) {
      try {
        item.el.scrollTop = item.top;
        item.el.scrollLeft = item.left;
      } catch {
        // The node was replaced with the paint. The window scroll is the other copy.
      }
    }
    const view = shot.view;
    if (view && shot.x != null && shot.y != null && typeof view.scrollTo === "function") view.scrollTo(shot.x, shot.y);
  }

  // The repaint's caret is still up the page. Put the release scroll back, including
  // the correction the browser applies on the frames after the range is placed.
  function releasePinScroll(shot) {
    if (!shot || pinScrollHold !== shot) return;
    restoreScroll(shot);
    const view = shot.view;
    const owned = () => !closed && pinScrollHold === shot;
    const restore = () => {
      if (!owned()) return;
      restoreScroll(shot);
    };
    const clear = () => {
      if (pinScrollHold === shot) pinScrollHold = null;
    };
    if (!view || typeof view.requestAnimationFrame !== "function") {
      clear();
      return;
    }
    view.requestAnimationFrame(() => {
      restore();
      if (!owned()) return;
      view.requestAnimationFrame(() => {
        restore();
        if (!owned()) return;
        if (typeof view.setTimeout !== "function") {
          clear();
          return;
        }
        view.setTimeout(() => {
          restore();
          clear();
        }, 0);
      });
    });
  }

  // The selection paints the caret and the host scrolls it into view. The page
  // command already chose its rows, so that scroll is put back, including the
  // one the browser applies on the next frame.
  function landVimKeepingScroll(at) {
    const shot = captureScroll();
    vimKeepScroll = true;
    try {
      landVim(at);
    } finally {
      vimKeepScroll = false;
      restoreScroll(shot);
    }
    const view = shot.view;
    if (view && typeof view.requestAnimationFrame === "function") {
      view.requestAnimationFrame(() => {
        if (!closed) restoreScroll(shot);
      });
    }
  }

  function applyVimView(effect) {
    const command = typeof effect.command === "string" ? effect.command : "";
    const repeat = Number.isInteger(effect.repeat) && effect.repeat > 0 ? effect.repeat : 1;
    const extend = vimMode === "visual" || vimMode === "visual-line";
    if (command === "h" || command === "l") {
      const forward = command === "l";
      for (let n = 0; n < repeat; n += 1) {
        if (sourceMode) moveRawCaret(forward ? "ArrowRight" : "ArrowLeft", extend, false);
        else {
          // Leaving the block puts the next letter on the line under it.
          const before = state.cursor;
          moveCaret(forward ? "forward" : "backward", "character", extend);
          const [start, end] = blockSpan(state.doc, before);
          if (state.cursor < start || state.cursor > end) {
            const at = forward ? end : start;
            moveVimCaret(extend ? state.anchor : at, at);
          }
        }
      }
      return;
    }
    if (command === "gj" || command === "gk") {
      const forward = command === "gj";
      for (let n = 0; n < repeat; n += 1) moveCaret(forward ? "forward" : "backward", "line", extend);
      return;
    }
    if (command === "g0" || command === "g^" || command === "g$") {
      const row = vimDisplayRow(vimGlyphs(), state.doc, state.cursor);
      if (!row) return;
      if (command === "g0") {
        landVim(row.from);
        return;
      }
      if (command === "g$") {
        landVim(row.to);
        return;
      }
      let at = row.from;
      const limit = Math.min(state.doc.length, row.to);
      while (at < limit && (state.doc[at] === " " || state.doc[at] === "\t")) at += 1;
      landVim(at < limit ? at : row.from);
      return;
    }
    if (command === "H" || command === "M" || command === "L") {
      const seen = vimPaneRows(vimGlyphs());
      if (!seen || seen.rows.length === 0) return;
      const rows = seen.rows;
      let target = rows[0];
      if (command === "M") {
        const paneMid = (seen.paneTop + seen.paneBottom) / 2;
        let best = Infinity;
        for (const row of rows) {
          const dist = Math.abs((row.top + row.bottom) / 2 - paneMid);
          if (dist < best) {
            best = dist;
            target = row;
          }
        }
      } else {
        const index = command === "H"
          ? Math.min(rows.length - 1, repeat - 1)
          : Math.max(0, rows.length - repeat);
        target = rows[index];
      }
      landVim(vimFirstNonBlank(state.doc, target.at, target.end));
      return;
    }
    if (command === "ctrl-f" || command === "ctrl-b" || command === "ctrl-d" || command === "ctrl-u") {
      const seen = vimPaneRows(vimGlyphs());
      if (!seen || seen.rows.length === 0) return;
      const span = command === "ctrl-d" || command === "ctrl-u"
        ? Math.max(1, Math.floor(seen.rows.length / 2))
        : seen.rows.length;
      const steps = span * repeat;
      const delta = command === "ctrl-f" || command === "ctrl-d" ? steps : -steps;
      const starts = sourceMode ? vimSourceStarts(state.doc) : vimRenderedStarts();
      landVimKeepingScroll(vimStepTo(starts, state.cursor, delta));
    }
  }

  function applyVimEffect(effect) {
    if (!effect || typeof effect.type !== "string") return;
    if (effect.type === "comment-current") {
      if (Number.isInteger(effect.anchor) && Number.isInteger(effect.cursor)) moveVimCaret(effect.anchor, effect.cursor);
      showCommentCurrent(effect.id);
      return;
    }
    if (effect.type === "comment-add") {
      if (Number.isInteger(effect.anchor) && Number.isInteger(effect.cursor)) {
        state = { ...state, anchor: effect.anchor, cursor: effect.cursor };
      }
      addSelectionComment();
      return;
    }
    if (effect.type === "prompt") {
      openVimLine(effect);
      return;
    }
    if (effect.type === "nohlsearch") {
      vimPaintHold = null;
      syncVimMatchPaint();
      return;
    }
    if (effect.type === "caret") {
      moveVimCaret(effect.anchor, effect.cursor);
      return;
    }
    if (effect.type === "scroll") {
      if (Number.isInteger(effect.cursor)) {
        const anchor = Number.isInteger(effect.anchor) ? effect.anchor : effect.cursor;
        moveVimCaret(anchor, effect.cursor);
      }
      scrollVimCaretLine(effect.edge);
      return;
    }
    if (effect.type === "splice") {
      const text = typeof effect.text === "string" ? effect.text : "";
      // A yank writes the same bytes back. The register is already stored, so
      // publishing it would move rev without changing the document.
      if (text === state.doc.slice(effect.from, effect.to)) {
        const at = Number.isInteger(effect.caret) ? effect.caret : state.cursor;
        moveVimCaret(at, at);
        return;
      }
      const partial = {
        op: "insert",
        text,
        anchor: effect.from,
        cursor: effect.to,
        exact: true,
      };
      if (Number.isInteger(effect.caret)) partial.caret = effect.caret;
      // The range is the splice. u restores the caret from before the command.
      if (vimOn) {
        const before = state.cursor;
        partial.vimMark = {
          before,
          after: Number.isInteger(effect.caret) ? effect.caret : before,
        };
      }
      const prior = vimSplicePrior;
      vimSplicePrior = null;
      emitEdit(partial, prior);
      return;
    }
    if (effect.type === "forward-delete") {
      if (sourceMode) rawErase(1);
      else emitEdit({ op: "delete" });
      return;
    }
    if (effect.type === "backspace") {
      if (sourceMode) rawErase(-1);
      else if (prepareBackwardDelete()) emitEdit({ op: "backspace" });
      return;
    }
    if (effect.type === "word-delete") {
      applyVimWordDelete();
      return;
    }
    if (effect.type === "history") {
      emitHistory(effect.direction === "redo" ? "redo" : "undo");
      return;
    }
    if (effect.type === "view-motion") applyVimView(effect);
  }

  // Drawn beside the editor. A span inside a line would split the text node pointFor measures.
  function clearVimMatches() {
    if (!vimMatchRoot) return;
    detachNode(vimMatchRoot);
    vimMatchRoot = null;
  }

  function rectBox(rect) {
    if (!rect) return null;
    const top = rect.top;
    const left = rect.left;
    const width = rect.width;
    const height = rect.height;
    if (!Number.isFinite(top) || !Number.isFinite(left) || !Number.isFinite(width) || !Number.isFinite(height)) return null;
    if (!(width > 0) && !(height > 0)) return null;
    return { top, left, width, height };
  }

  function matchRects(start, end) {
    const rects = [];
    if (typeof document === "undefined" || typeof document.createTreeWalker !== "function" || typeof document.createRange !== "function") return rects;
    let walker = null;
    try {
      const show = typeof NodeFilter === "undefined" ? 4 : NodeFilter.SHOW_TEXT;
      walker = document.createTreeWalker(root, show);
    } catch {
      return rects;
    }
    if (!walker || typeof walker.nextNode !== "function") return rects;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.closest?.(".md-atom") || node.parentElement?.closest?.(".md-lock")) continue;
      const tagged = nearestTagged(node);
      if (!tagged || !tagged.dataset) continue;
      const nodeStart = Number(tagged.dataset.start);
      const nodeEnd = Number(tagged.dataset.end);
      const len = textLength(node);
      if (!Number.isFinite(nodeStart) || !Number.isFinite(nodeEnd) || len !== nodeEnd - nodeStart || len <= 0) continue;
      const lo = Math.max(start, nodeStart);
      const hi = Math.min(end, nodeEnd);
      if (lo >= hi) continue;
      let range = null;
      try {
        range = document.createRange();
        range.setStart(node, lo - nodeStart);
        range.setEnd(node, hi - nodeStart);
      } catch {
        continue;
      }
      let list = null;
      try {
        if (range && typeof range.getClientRects === "function") list = range.getClientRects();
      } catch {
        list = null;
      }
      const count = list && typeof list.length === "number" ? list.length : 0;
      for (let i = 0; i < count; i += 1) {
        const box = rectBox(list[i]);
        if (box) rects.push(box);
      }
    }
    return rects;
  }

  function matchNode(start, end, rect) {
    const el = document.createElement("span");
    el.className = "md-vim-match";
    el.dataset.start = String(start);
    el.dataset.end = String(end);
    if (typeof el.setAttribute === "function") el.setAttribute("aria-hidden", "true");
    if (rect) {
      setStyle(el, "left", `${rect.left}px`);
      setStyle(el, "top", `${rect.top}px`);
      setStyle(el, "width", `${rect.width}px`);
      setStyle(el, "height", `${rect.height}px`);
    }
    return el;
  }

  function paintPattern() {
    if (closed || !vimOn) return null;
    if (vimPrompt && vimPrompt.kind === "search" && vimLine) {
      const pattern = stripVimPrompt(vimLine.value);
      if (pattern.length > VIM_SEARCH_LIMIT) return null;
      if (pattern.length > 0) return pattern;
    }
    if (vimPaintHold && (!vimSearch || vimSearch.pattern !== vimPaintHold.pattern)) vimPaintHold = null;
    return vimPaintHold ? vimPaintHold.pattern : null;
  }

  function syncVimMatchPaint() {
    if (closed) {
      clearVimMatches();
      return;
    }
    const pattern = paintPattern();
    if (!pattern) {
      clearVimMatches();
      return;
    }
    const hits = vimMatchStarts(state.doc, pattern, false);
    const nodes = [];
    for (const at of hits) {
      const rects = matchRects(at, at + pattern.length);
      if (rects.length === 0) nodes.push(matchNode(at, at + pattern.length, null));
      else for (const rect of rects) nodes.push(matchNode(at, at + pattern.length, rect));
    }
    if (nodes.length === 0) {
      clearVimMatches();
      return;
    }
    const body = typeof document !== "undefined" ? document.body : null;
    if (!body || typeof body.appendChild !== "function") return;
    if (!vimMatchRoot || vimMatchRoot.parentElement !== body) {
      clearVimMatches();
      const host = document.createElement("div");
      host.className = "md-vim-matches";
      if (typeof host.setAttribute === "function") host.setAttribute("aria-hidden", "true");
      body.appendChild(host);
      vimMatchRoot = host;
    }
    if (typeof vimMatchRoot.replaceChildren === "function") vimMatchRoot.replaceChildren(...nodes);
    else {
      while (vimMatchRoot.childNodes && vimMatchRoot.childNodes.length) detachNode(vimMatchRoot.childNodes[0]);
      for (const node of nodes) vimMatchRoot.appendChild(node);
    }
  }

  function noteSearchEdit() {
    if (vimRecallLock || !vimRecall || !vimPrompt || vimPrompt.kind !== "search" || !vimLine) return;
    vimRecall.at = vimSearchPast.length;
    vimRecall.draft = stripVimPrompt(vimLine.value);
  }

  function recallSearch(delta) {
    if (!vimPrompt || vimPrompt.kind !== "search" || !vimLine || !vimRecall) return;
    if (vimSearchPast.length === 0) return;
    const mark = vimPromptMark(vimPrompt);
    vimRecallLock = true;
    try {
      if (delta < 0) {
        if (vimRecall.at === vimSearchPast.length) vimRecall.draft = stripVimPrompt(vimLine.value);
        if (vimRecall.at === 0) return;
        vimRecall.at -= 1;
        vimLine.value = mark + vimSearchPast[vimRecall.at];
      } else {
        if (vimRecall.at >= vimSearchPast.length) return;
        vimRecall.at += 1;
        const text = vimRecall.at === vimSearchPast.length ? vimRecall.draft : vimSearchPast[vimRecall.at];
        vimLine.value = mark + text;
      }
      placeVimLineCaret(vimLine);
      syncVimMatchPaint();
    } finally {
      vimRecallLock = false;
    }
  }

  function rememberSearchPattern(pattern) {
    if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > VIM_SEARCH_LIMIT) return;
    const at = vimSearchPast.lastIndexOf(pattern);
    if (at >= 0) vimSearchPast.splice(at, 1);
    vimSearchPast.push(pattern);
    vimPaintHold = { pattern };
  }

  // The mark drawn in the line is the prompt. The command is the text after it.
  function stripVimPrompt(text) {
    const value = typeof text === "string" ? text : "";
    if (value.startsWith("/") || value.startsWith("?") || value.startsWith(":")) return value.slice(1);
    return value;
  }

  function vimPromptMark(effect) {
    if (effect && effect.kind === "search") return effect.forward === false ? "?" : "/";
    return ":";
  }

  function vimLineOpen() {
    return vimPrompt != null;
  }

  function placeVimLineCaret(input) {
    const end = String(input.value || "").length;
    try {
      input.selectionStart = end;
      input.selectionEnd = end;
      if (typeof input.setSelectionRange === "function") input.setSelectionRange(end, end);
    } catch {
      // A field that is not yet focused refuses the range. The next key still lands after the mark.
    }
  }

  function parentVimLine(input) {
    const body = typeof document !== "undefined" ? document.body : null;
    if (!body || typeof body.appendChild !== "function" || input.parentElement === body) return;
    body.appendChild(input);
  }

  function ensureVimLine() {
    if (vimLine) return vimLine;
    if (typeof document === "undefined" || typeof document.createElement !== "function") return null;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "md-vim-line";
    input.spellcheck = false;
    input.autocapitalize = "off";
    if (typeof input.setAttribute === "function") {
      input.setAttribute("type", "text");
      input.setAttribute("spellcheck", "false");
      input.setAttribute("autocapitalize", "off");
      input.setAttribute("autocomplete", "off");
      input.setAttribute("autocorrect", "off");
    }
    input.addEventListener("keydown", onVimLineKey, { signal: ac.signal });
    input.addEventListener("input", onVimLineInput, { signal: ac.signal });
    vimLine = input;
    return input;
  }

  // Flag off never reaches here. The status keeps the pending keys it already shows.
  function openVimLine(effect) {
    if (!vimOn || !effect) return;
    const input = ensureVimLine();
    if (!input) return;
    vimPrompt = { kind: effect.kind, forward: effect.forward };
    vimRecall = effect.kind === "search" ? { at: vimSearchPast.length, draft: "" } : null;
    input.value = vimPromptMark(effect);
    parentVimLine(input);
    placeVimLineCaret(input);
    if (typeof input.focus === "function") input.focus();
    placeVimLineCaret(input);
    syncVimBlockMark();
    syncVimMatchPaint();
  }

  function closeVimLine() {
    const wasOpen = vimPrompt != null;
    vimPrompt = null;
    vimRecall = null;
    if (vimLine && wasOpen) {
      vimLine.value = "";
      detachNode(vimLine);
    }
    if (!wasOpen || closed || !root || typeof root.focus !== "function") return;
    // Focus clears the DOM selection. A command that does not move the caret,
    // such as :noh, would otherwise leave it at the start of the document.
    placingCaret = true;
    try {
      root.focus();
    } finally {
      placingCaret = false;
    }
    placeCaret();
  }

  function submitVimLine() {
    const prompt = vimPrompt;
    const field = vimLine;
    if (!prompt || !field) return;
    const line = stripVimPrompt(typeof field.value === "string" ? field.value : "");
    const kind = prompt.kind;
    const forward = prompt.forward;
    closeVimLine();
    const result = vimSubmit({
      line,
      kind,
      forward,
      vim: vimSnapshot(),
      doc: state.doc,
      anchor: state.anchor,
      cursor: state.cursor,
      raw: sourceMode === true,
      flag: true,
    });
    if (!result || result.consumed !== true) {
      syncVimMatchPaint();
      return;
    }
    if (kind === "search" && result.vim && result.vim.search && result.vim.search.pattern === line) {
      rememberSearchPattern(line);
    }
    applyRememberedVim(result.vim, result.effect);
    syncVimMatchPaint();
  }

  function onVimLineInput() {
    if (!vimPrompt || vimPrompt.kind !== "search" || vimRecallLock) return;
    noteSearchEdit();
    syncVimMatchPaint();
  }

  // Ctrl-W and Meta-W close the browser tab. The line keeps the chord.
  function onVimLineKey(event) {
    if (!event) return;
    const key = typeof event.key === "string" ? event.key : "";
    const stop = () => {
      if (typeof event.preventDefault === "function") event.preventDefault();
    };
    if ((event.ctrlKey === true || event.metaKey === true) && (key === "w" || key === "W")) {
      stop();
      return;
    }
    if ((key === "ArrowUp" || key === "ArrowDown") && vimPrompt && vimPrompt.kind === "search" && event.shiftKey !== true && event.altKey !== true && event.ctrlKey !== true && event.metaKey !== true) {
      stop();
      recallSearch(key === "ArrowUp" ? -1 : 1);
      return;
    }
    if (key === "Enter") {
      stop();
      submitVimLine();
      return;
    }
    if (key === "Escape") {
      stop();
      closeVimLine();
      syncVimMatchPaint();
    }
  }

  // A key that still reaches the editor is typed into the line, not into vimKey.
  function takeVimLineKey(event) {
    if (!event) return;
    const key = typeof event.key === "string" ? event.key : "";
    if (key === "Enter") {
      submitVimLine();
      return;
    }
    if (key === "Escape") {
      closeVimLine();
      syncVimMatchPaint();
      return;
    }
    if (event.ctrlKey === true || event.metaKey === true || event.altKey === true) return;
    if ((key === "ArrowUp" || key === "ArrowDown") && event.shiftKey !== true) {
      if (vimPrompt && vimPrompt.kind === "search") recallSearch(key === "ArrowUp" ? -1 : 1);
      return;
    }
    const field = vimLine;
    if (!field) return;
    if (key === "Backspace") {
      field.value = String(field.value || "").slice(0, -1);
      noteSearchEdit();
      syncVimMatchPaint();
      return;
    }
    if (key.length === 1) {
      field.value = String(field.value || "") + key;
      noteSearchEdit();
      syncVimMatchPaint();
    }
  }

  // keydown is the only caller. A consumed key never reaches beforeinput.
  function dispatchVimKey(key) {
    const result = vimKey({
      key,
      vim: vimSnapshot(),
      doc: state.doc,
      cursor: state.cursor,
      anchor: state.anchor,
      raw: sourceMode === true,
      flag: true,
      layout: true,
    });
    if (!result || result.consumed !== true) return false;
    applyRememberedVim(result.vim, result.effect);
    return true;
  }

  // rememberVim stores the yank before the hub answers. The prior is kept only
  // when that command's splice is actually sent.
  function applyRememberedVim(vim, effect) {
    vimSplicePrior = copyVimRegister(vimRegister);
    rememberVim(vim);
    try {
      applyVimEffect(effect);
    } finally {
      vimSplicePrior = null;
    }
  }

  function vimLineShift(operator) {
    const key = { key: operator, ctrl: false, meta: false, alt: false, shift: false };
    if (!dispatchVimKey(key)) return;
    dispatchVimKey(key);
  }

  // j and k step a block. A wrapped paragraph's other rows are drawn lines,
  // so Insert ↑ and ↓ take the same step as with vim keys off. ← and → are h
  // and l. Each of them stays in Insert. With the flag off, arrows keep the
  // selection path below.
  function vimInsertArrow(event) {
    if (!event || event.ctrlKey || event.metaKey || event.altKey) return false;
    const vertical = event.key === "ArrowUp" || event.key === "ArrowDown";
    const command = event.key === "ArrowLeft" ? "h"
      : event.key === "ArrowRight" ? "l"
        : "";
    if (!vertical && !command) return false;
    // An arrow ends the open Insert undo step. The next splice is its own undo.
    vimInsertOpen = false;
    if (vertical) {
      if (sourceMode) moveRawCaret(event.key, false, false);
      else moveCaret(event.key === "ArrowDown" ? "forward" : "backward", "line", false);
      return true;
    }
    const snap = vimSnapshot();
    snap.mode = "normal";
    snap.once = false;
    const result = vimKey({
      key: { key: command, ctrl: false, meta: false, alt: false, shift: false },
      vim: snap,
      doc: state.doc,
      cursor: state.cursor,
      anchor: state.cursor,
      raw: sourceMode === true,
      flag: true,
      layout: true,
    });
    if (result && result.consumed === true) {
      rememberVim({ ...(result.vim || {}), mode: "insert", once: false });
      applyVimEffect(result.effect);
    }
    return true;
  }

  function insertTabChar() {
    if (sourceMode) {
      if (!adoptDomSelection()) return;
      emitEdit({ op: "insert", text: "\t" });
      return;
    }
    if (!adoptDomSelection()) return;
    const indent = listIndent(state.doc, state.anchor, state.cursor);
    if (indent && live) keptCaret = { text: indent.text, anchor: indent.anchor, cursor: indent.cursor };
    if (indent) emitEdit({ op: "insert", text: indent.insert, anchor: indent.spliceFrom, cursor: indent.spliceTo });
    else if (!quotedListSelection(state.doc, state.anchor, state.cursor)) emitEdit({ op: "insert", text: "\t" });
  }

  function settleRemoteCaret() {
    if (!remoteCaret) return;
    const held = remoteCaret;
    if (state.anchor !== held.anchor || state.cursor !== held.cursor) {
      state = { ...state, anchor: held.anchor, cursor: held.cursor };
    }
    if (!domSelectionMatches()) placeCaret();
    if (domSelectionMatches()) remoteCaret = null;
  }

  listen("keydown", (event) => {
    strayRestores = 0;
    settleRemoteCaret();
    retainedCaret = null;
    linkTabCaret = null;
    whitespaceCaret = null;
    if (keyEndsRun(event)) endTypingRunLater();
    gestureHold = false;
    commentFocus = null;
    if (vimLineOpen()) {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      takeVimLineKey(event);
      return;
    }
    // Tab is not passed to vimKey. Normal, Visual, and Visual Line shift the line.
    if (vimOn && event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey) {
      if (!vimInsertKeys()) {
        event.preventDefault();
        vimLineShift(event.shiftKey ? "<" : ">");
        return;
      }
      // Insert Shift+Tab is that same insert, not the outdent chord.
      if (event.shiftKey) {
        event.preventDefault();
        insertTabChar();
        return;
      }
    }
    if (sourceMode && event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      if (event.shiftKey) return;
      if (!adoptDomSelection()) return;
      emitEdit({ op: "insert", text: "\t" });
      return;
    }
    if (event.key === "Escape" && ticketMenuOpen) {
      closeTicketMenu();
      return;
    }
    if (event.key === "Tab" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      if (!adoptDomSelection()) return;
      const outdent = listOutdent(state.doc, state.anchor, state.cursor);
      if (outdent && live) keptCaret = { text: outdent.text, anchor: outdent.anchor, cursor: outdent.cursor };
      if (outdent) emitEdit({ op: "insert", text: outdent.insert, anchor: outdent.spliceFrom, cursor: outdent.spliceTo });
      return;
    }
    if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      if (!adoptDomSelection()) return;
      const indent = listIndent(state.doc, state.anchor, state.cursor);
      if (indent && live) keptCaret = { text: indent.text, anchor: indent.anchor, cursor: indent.cursor };
      if (indent) emitEdit({ op: "insert", text: indent.insert, anchor: indent.spliceFrom, cursor: indent.spliceTo });
      else if (!quotedListSelection(state.doc, state.anchor, state.cursor)) emitEdit({ op: "insert", text: "\t" });
      return;
    }
    const mod = event.ctrlKey || event.metaKey;
    if (mod && !event.altKey && (event.key === "z" || event.key === "Z")) {
      event.preventDefault();
      emitHistory(event.shiftKey ? "redo" : "undo");
      return;
    }
    if (mod && !event.altKey && (event.key === "y" || event.key === "Y")) {
      event.preventDefault();
      emitHistory("redo");
      return;
    }
    // Escape deselects the thread and leaves Visual or Insert. A note's own Escape is the aside's.
    if (vimOn && event.key === "Escape" && !event.ctrlKey && !event.metaKey && !event.altKey && currentCommentId && !typingCommentNote()) {
      event.preventDefault();
      leaveCurrentComment();
      return;
    }
    if (vimOn && !vimInsertKeys() && currentCommentId && !typingCommentNote() && takeThreadCommand(event)) {
      event.preventDefault();
      return;
    }
    if (vimOn && vimInsertKeys() && vimInsertArrow(event)) {
      event.preventDefault();
      return;
    }
    if (vimOn && event.key !== "Tab") {
      if (dispatchVimKey({
        key: typeof event.key === "string" ? event.key : "",
        ctrl: event.ctrlKey === true,
        meta: event.metaKey === true,
        alt: event.altKey === true,
        shift: event.shiftKey === true,
      })) {
        event.preventDefault();
        return;
      }
    }
    if (mod && !event.shiftKey && !event.altKey && (event.key === "a" || event.key === "A")) {
      event.preventDefault();
      state = { ...state, anchor: 0, cursor: state.doc.length };
      if (!claimLines(0, state.doc.length)) return;
      useVimSelection("visual-line");
      render();
      return;
    }
    if (sourceMode && rawMoveKey(event.key)) {
      event.preventDefault();
      if (wordArrow(event)) {
        moveByWord(event.key === "ArrowRight", event.shiftKey === true);
        return;
      }
      const extend = event.shiftKey === true && !event.ctrlKey && !event.altKey && !event.metaKey;
      moveRawCaret(event.key, extend, event.ctrlKey === true || event.metaKey === true);
      return;
    }
    // A comment fence at the end of the file is not drawn. The blank before it
    // is a paragraph gap with no box, so the browser's Ctrl+End paints a caret
    // of 0 px. The last line drawn is the one above that blank.
    if (!sourceMode && event.altKey !== true && (event.ctrlKey === true || event.metaKey === true) && event.key === "End") {
      const end = endBeforeTrailingCommentFence(state.doc, state.cursor);
      if (end != null) {
        event.preventDefault();
        goalX = null;
        const extend = event.shiftKey === true;
        const beforeCursor = state.cursor;
        const anchor = extend ? state.anchor : end;
        state = { ...state, cursor: end, anchor };
        if (!claimLines(anchor, end)) return;
        const lineMoved = lineIndexAt(state.doc, beforeCursor) !== lineIndexAt(state.doc, end)
          || lineIndexAt(state.doc, anchor) !== lineIndexAt(state.doc, end);
        if (lineMoved) render();
        else placeCaret();
        return;
      }
    }
    // A hard-break line's End. Firefox's lineboundary stops after the hidden
    // tail. Other lines keep the browser's own End, which is the visual line.
    if (event.key === "End" && !event.ctrlKey && !event.altKey && !event.metaKey && hiddenTailLine(state.doc, state.cursor)) {
      event.preventDefault();
      moveCaret("forward", "lineboundary", event.shiftKey === true);
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      if (wordArrow(event)) {
        moveByWord(event.key === "ArrowRight", event.shiftKey === true);
        return;
      }
      const extend = event.shiftKey === true && !event.ctrlKey && !event.altKey && !event.metaKey;
      const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
      const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
      moveCaret(forward ? "forward" : "backward", horizontal ? "character" : "line", extend);
    }
  });

  listen("keyup", () => {
    if (closed || composing || pointer || bodyCaretReleased) return;
    claimLines(state.anchor, state.cursor);
  });

  function cancelGestureRender() {
    gestureHold = false;
    if (gestureTimer == null) return;
    clearTimeout(gestureTimer);
    gestureTimer = null;
  }

  function pointMapped(event) {
    if (!event || typeof document.caretPositionFromPoint !== "function") return null;
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return null;
    const pos = document.caretPositionFromPoint(event.clientX, event.clientY);
    if (!pos) return null;
    const mapped = mapOffset(pos.offsetNode, pos.offset);
    if (!Number.isFinite(mapped)) return null;
    return mapped;
  }

  function whitespaceLineStart(doc, offset) {
    const text = typeof doc === "string" ? doc : "";
    if (!Number.isFinite(offset)) return null;
    const at = Math.max(0, Math.min(text.length, offset));
    let start = at;
    while (start > 0 && text[start - 1] !== "\n") start -= 1;
    let end = at;
    while (end < text.length && text[end] !== "\n") end += 1;
    if (!/^[\t ]+$/.test(text.slice(start, end))) return null;
    return start;
  }

  function breakCaretLeft(offset) {
    for (const line of childArray(root)) {
      if (!hasClass(line, "md-line")) continue;
      const brk = findClassChild(line, "md-break");
      if (!brk || Number(brk.dataset && brk.dataset.start) !== offset) continue;
      const br = childArray(brk).find((node) => isBreak(node)) || brk;
      if (typeof br.getBoundingClientRect !== "function") return null;
      const rect = br.getBoundingClientRect();
      return rect && Number.isFinite(rect.left) ? rect.left : null;
    }
    return null;
  }

  // The pulled break is a block, so a press on the open part of the line hits
  // the newline. A spaces-or-tab line's click belongs at its start. The newline
  // stays only for a press on the break's caret, the column a letter uses.
  // That press is the one placed a pixel into the break.
  function blankLinePress(event, offset) {
    const start = whitespaceLineStart(state.doc, offset);
    if (start == null || start === offset) return offset;
    const left = breakCaretLeft(offset);
    if (left == null || !event || !Number.isFinite(event.clientX)) return offset;
    const dx = event.clientX - left;
    if (dx >= 0 && dx <= 2) return offset;
    return start;
  }

  // A rendered rule is the border on the blank's edge, so the blank's hit box
  // would take the press. The rule's own element is the rule's start.
  function rulePress(event) {
    if (sourceMode || !event) return null;
    const node = event.target;
    const el = node && node.nodeType === 1 ? node : node && node.parentElement;
    if (!el || typeof el.closest !== "function") return null;
    const rule = el.closest(".md-hr");
    if (!rule || !root.contains(rule) || hasClass(rule, "md-raw")) return null;
    const start = Number(rule.dataset && rule.dataset.start);
    return Number.isFinite(start) ? start : null;
  }

  // The blank has no box, so a press on its edge hits the block under it.
  // The stop is that blank. A press on the block's text is not the edge.
  function gapUnderPoint(event) {
    if (sourceMode || !event || !Number.isFinite(event.clientY)) return null;
    if (!root || typeof root.querySelectorAll !== "function") return null;
    const stops = gapCaretStops(state.doc, state.cursor);
    if (stops.length === 0) return null;
    for (const el of root.querySelectorAll(".md-paragraph-gap")) {
      const start = Number(el.dataset && el.dataset.start);
      if (!stops.includes(start)) continue;
      if (typeof el.getBoundingClientRect !== "function") continue;
      const rect = el.getBoundingClientRect();
      if (!rect || !Number.isFinite(rect.top)) continue;
      const mid = (rect.top + rect.bottom) / 2;
      if (Math.abs(event.clientY - mid) > 2) continue;
      const right = rect.right > rect.left ? rect.right : rect.left;
      if (Number.isFinite(event.clientX) && (event.clientX < rect.left - 4 || event.clientX > right + 4)) continue;
      return start;
    }
    return null;
  }

  // Firefox's caretPositionFromPoint reports the offset after a tab for a press
  // on any part of it. The left half of that tab's box is the offset before it.
  // Chromium already reports the left half as before, so this does not move it.
  function tabHalf(event, offset) {
    if (!event || !Number.isFinite(event.clientX) || !(offset > 0) || state.doc[offset - 1] !== "\t") return offset;
    if (typeof NodeFilter === "undefined" || !NodeFilter) return offset;
    const point = pointFor(offset - 1);
    if (!point || !point.node || point.node.nodeType !== 3) return offset;
    const index = point.offset;
    if (String(point.node.textContent || "")[index] !== "\t") return offset;
    const box = rawCharRect(point.node, index);
    if (!box || !(box.right > box.left)) return offset;
    const mid = (box.left + box.right) / 2;
    if (event.clientX < box.left || event.clientX >= mid) return offset;
    return offset - 1;
  }

  // Firefox's caretPositionFromPoint on the blank above the final newline reports
  // the line drawn for the offset after that newline. The blank's own box is the
  // blank. A zero-height blank is handled with the gap stops; this is a blank
  // that has a box, with that other line drawn under it.
  function trailingBlankPress(event, offset) {
    if (sourceMode || offset !== state.doc.length || !state.doc.endsWith("\n")) return offset;
    if (!event || !Number.isFinite(event.clientY)) return offset;
    const blankAt = state.doc.length - 1;
    for (const el of childArray(root)) {
      if (!hasClass(el, "md-line") || hasClass(el, "md-caret-row")) continue;
      const start = Number(el.dataset && el.dataset.start);
      const end = Number(el.dataset && el.dataset.end);
      if (start !== blankAt || end !== blankAt) continue;
      if (typeof el.getBoundingClientRect !== "function") continue;
      const rect = el.getBoundingClientRect();
      if (!rect || !(rect.bottom > rect.top)) continue;
      if (event.clientY < rect.top || event.clientY > rect.bottom) continue;
      if (Number.isFinite(event.clientX)) {
        const right = rect.right > rect.left ? rect.right : rect.left;
        if (event.clientX < rect.left - 4 || event.clientX > right + 4) continue;
      }
      return blankAt;
    }
    return offset;
  }

  function placedOffset(event, offset) {
    const placed = tabHalf(event, offset);
    if (sourceMode) return placed;
    return trailingBlankPress(event, blankLinePress(event, skipHidden(state.doc, placed, "nearer")));
  }

  function pressOffset(event) {
    const rule = rulePress(event);
    if (rule != null) return rule;
    const gap = gapUnderPoint(event);
    if (gap != null) return gap;
    const mapped = pointMapped(event);
    if (mapped == null) return null;
    return placedOffset(event, mapped);
  }

  function pointOffset(event) {
    return pressOffset(event);
  }

  function anchorInEditor(event) {
    const node = event && event.target;
    const target = node && node.nodeType === 1 ? node : node && node.parentElement;
    const link = target && typeof target.closest === "function" ? target.closest("a") : null;
    if (!link || !root.contains(link)) return null;
    return link;
  }

  // The editor cancels the click, so the browser's caret still lands on the link.
  // Holding selectionchange keeps the paragraph rendered. The click puts the caret back.
  function armLinkTabHold(event) {
    linkTabHold = false;
    if (!ctrlOpensTab(event) || !anchorInEditor(event)) return;
    linkTabHold = true;
    gestureHold = true;
    linkTabRestores = 0;
  }

  function dropLinkTabHold() {
    linkTabHold = false;
    gestureHold = false;
  }

  function releaseLinkTabHold() {
    if (!linkTabHold) return;
    linkTabHold = false;
    gestureHold = false;
    linkTabCaret = { anchor: state.anchor, cursor: state.cursor };
    linkTabRestores = 0;
    placeCaret();
  }

  // mouseup runs before click. A press that never becomes a click still has to let go.
  function scheduleLinkTabSettle() {
    if (!linkTabHold) return;
    const view = typeof window !== "undefined" ? window : null;
    if (!view || typeof view.setTimeout !== "function") {
      if (didDrag) dropLinkTabHold();
      else releaseLinkTabHold();
      return;
    }
    view.setTimeout(() => {
      if (!linkTabHold) return;
      if (didDrag) dropLinkTabHold();
      else releaseLinkTabHold();
    }, 0);
  }

  function eventElement(event) {
    const node = event && event.target;
    if (!node) return null;
    if (node.nodeType === 1) return node;
    return node.parentElement || null;
  }

  // Selecting the path is not a caret press and not a navigation.
  function inPathStrip(event) {
    const el = eventElement(event);
    if (!el || typeof el.closest !== "function") return false;
    return !!el.closest(".md-path-strip");
  }

  listen("mousedown", (event) => {
    if (inPathStrip(event)) {
      endTypingRunLater();
      gestureArmed = false;
      return;
    }
    linkTabOpened = false;
    linkTabCaret = null;
    endTypingRunLater();
    // A new press is a new gesture. The previous click's retained caret would collapse it.
    remoteCaret = null;
    retainedCaret = null;
    whitespaceCaret = null;
    if (beginHandleDrag(event)) return;
    if (beginPinDrag(event)) return;
    didDrag = false;
    goalX = null;
    commentFocus = null;
    cancelGestureRender();
    pointer = { x: event.clientX, y: event.clientY };
    if (event && typeof event.button === "number" && event.button !== 0) return;
    const detail = event && event.detail ? event.detail : 1;
    if (detail >= 2) {
      gestureArmed = true;
      return;
    }
    armLinkTabHold(event);
    // skipHidden snaps a press inside a comment mark to the mark's edge. That
    // edge is the selection boundary when the selection covers the mark, so the
    // unsnapped offset is what says this press is a drag of the selection.
    // Source mode draws the marker, so the caret stays on the byte that was hit.
    const raw = pointMapped(event);
    gestureOffset = pressOffset(event);
    gestureArmed = true;
    const from = Math.min(state.anchor, state.cursor);
    const to = Math.max(state.anchor, state.cursor);
    const marker = pressedCommentMarker(event);
    const onMarker = marker != null && marker.start >= from && marker.end <= to && marker.end > marker.start;
    dragRange = from !== to && ((raw != null && raw > from && raw < to) || onMarker)
      ? { anchor: state.anchor, cursor: state.cursor }
      : null;
  });

  listen("dragstart", (event) => {
    const node = event.target && event.target.nodeType === 1 ? event.target : event.target && event.target.parentElement;
    if (node && node.closest && node.closest(".file-tree")) return;
    if (!dragRange) return;
    dragSource = dragRange;
  });

  listen("dragend", () => {
    dragSource = null;
    dragRange = null;
  });

  // Firefox's caretPositionFromPoint stays on the drag focus, or lands off the
  // glyph when the release hits the add-comment button. A drag across elements
  // does not dispatch a click. The miss is the right half of a line's last
  // glyph, and a zero-height gap can leave the selection on the block above
  // while the pointer is on a later glyph. The glyph is the offset a click
  // there maps.
  function glyphPointerOffset(event) {
    if (!event || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return null;
    const x = event.clientX;
    const y = event.clientY;
    let best = null;
    let bestDy = Infinity;
    for (const slot of rawLayoutSlots()) {
      if (!slot || slot.bare) continue;
      if (!(slot.right > slot.left) || !(slot.bottom > slot.top)) continue;
      if (x < slot.left || x >= slot.right || y < slot.top || y >= slot.bottom) continue;
      const dy = Math.abs(y - (slot.top + slot.bottom) / 2);
      if (dy >= bestDy) continue;
      best = slot;
      bestDy = dy;
    }
    if (!best) return null;
    const mid = (best.left + best.right) / 2;
    const offset = x < mid ? best.offset : best.offset + 1;
    return placedOffset(event, offset);
  }

  // The farther of the caret hit and the glyph under the pointer, in the
  // drag's direction. A nearer caret hit must not hide the glyph. A range
  // that already reaches it stays.
  function dragRelease(mapped, event) {
    if (!mapped) return mapped;
    const detail = event && event.detail ? event.detail : 1;
    if (detail >= 2) return mapped;
    if (gestureOffset != null && gestureOffset !== mapped.anchor) return mapped;
    const span = mapped.cursor - mapped.anchor;
    if (span === 0) return mapped;
    const farther = (candidate, current) => {
      if (candidate == null) return current;
      const next = candidate - mapped.anchor;
      if (next === 0 || Math.sign(next) !== Math.sign(span)) return current;
      if (Math.abs(next) <= Math.abs(current - mapped.anchor)) return current;
      return candidate;
    };
    let release = farther(pressOffset(event), mapped.cursor);
    release = farther(glyphPointerOffset(event), release);
    if (release === mapped.cursor) return mapped;
    return { anchor: mapped.anchor, cursor: release };
  }

  // Same-line release does not render, so the browser selection stays short
  // until the caret is placed on the click's offset.
  function placeDragCaret() {
    const anchor = state.anchor;
    const cursor = state.cursor;
    const from = pointFor(visibleSelectionOffset(state.doc, anchor, cursor));
    const to = pointFor(visibleSelectionOffset(state.doc, cursor, anchor));
    if (!from || !to) return;
    placeCaret();
  }

  // A line change has to render. selectionchange during that replace still
  // names the old nodes. The short range can also come back after mouseup,
  // and the retained caret puts the release back.
  function commitDrag(chosen, previous) {
    const extended = chosen.anchor !== previous.anchor || chosen.cursor !== previous.cursor;
    const before = lineIndexAt(state.doc, state.cursor);
    state = { ...state, anchor: chosen.anchor, cursor: chosen.cursor };
    if (!claimLines(chosen.anchor, chosen.cursor)) return false;
    if (state.anchor !== state.cursor) useVimSelection("visual");
    const after = lineIndexAt(state.doc, state.cursor);
    if (before !== after) {
      gestureHold = true;
      render();
    } else if (extended) placeDragCaret();
    else updateCommentButton();
    if (extended) retainCaret();
    return true;
  }

  // outside: the release target is not the editor, so the click will not be
  // either. didDrag would treat the next editor click as this drag.
  function finishTextDrag(event, outside) {
    if (!pointer) return;
    const moved = Math.abs(event.clientX - pointer.x) > 3 || Math.abs(event.clientY - pointer.y) > 3;
    pointer = null;
    const sel = window.getSelection();
    if (moved && sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      if (!range.collapsed && root.contains(range.commonAncestorContainer)) {
        const mapped = selectionFromDom(sel);
        if (mapped) {
          didDrag = true;
          gestureArmed = false;
          // The click reads gestureOffset. A selection whose anchor is not
          // this press must not be lengthened.
          plainDrag = !(event && event.detail >= 2);
          commitDrag(dragRelease(mapped, event), mapped);
          if (outside) {
            didDrag = false;
            gestureOffset = null;
          }
          return;
        }
      }
    }
    if (!composing) claimLines(state.anchor, state.cursor);
  }

  listen("mouseup", (event) => {
    if (pinMove) {
      finishPinDrag(event);
      return;
    }
    if (handleDrag) {
      finishHandleDrag(event);
      return;
    }
    finishTextDrag(event, false);
    scheduleLinkTabSettle();
  });

  // The collapsed blank under the last block has no box, so a press on it lands
  // below every line. Firefox's hit is past the blank's 2px edge and short of
  // the padding click, 40px under the last line. That press is the blank. A
  // blank that already has a box, or the line drawn for the offset after the
  // final newline, keeps a press below it at the end of the file.
  function collapsedEndBlank(event) {
    const doc = state.doc;
    if (sourceMode || !event || !Number.isFinite(event.clientY)) return null;
    if (typeof doc !== "string" || doc.length < 2 || !doc.endsWith("\n\n")) return null;
    const blankAt = doc.length - 1;
    let blank = null;
    let contentBottom = null;
    for (const el of childArray(root)) {
      if (!hasClass(el, "md-line") && !hasClass(el, "md-atom")) continue;
      if (hasClass(el, "md-caret-row")) return null;
      if (typeof el.getBoundingClientRect !== "function") return null;
      const rect = el.getBoundingClientRect();
      if (!rect || !Number.isFinite(rect.bottom) || !Number.isFinite(rect.top)) return null;
      const start = Number(el.dataset && el.dataset.start);
      const end = Number(el.dataset && el.dataset.end);
      if (start === blankAt && end === blankAt) blank = rect;
      else if (rect.bottom > rect.top && (contentBottom == null || rect.bottom > contentBottom)) contentBottom = rect.bottom;
    }
    if (!blank || blank.bottom > blank.top) return null;
    const floor = contentBottom != null ? contentBottom : blank.bottom;
    if (event.clientY <= floor || event.clientY >= floor + 40) return null;
    return blankAt;
  }

  // A click in the padding under the last block is the end of the file, including
  // the empty line after a final newline, which is not drawn until the caret arrives.
  function belowLastBlock(event) {
    if (!event || !Number.isFinite(event.clientY)) return false;
    let bottom = null;
    for (const el of root.childNodes || []) {
      if (!hasClass(el, "md-line") && !hasClass(el, "md-atom")) continue;
      if (typeof el.getBoundingClientRect !== "function") return false;
      const rect = el.getBoundingClientRect();
      if (!rect || !Number.isFinite(rect.bottom)) return false;
      if (bottom == null || rect.bottom > bottom) bottom = rect.bottom;
    }
    if (bottom == null) return false;
    // One pixel under the last line is the undrawn line after a final newline.
    // The gap route clicks there, short of the padding below the line.
    return event.clientY > bottom;
  }

  // Chromium writes the selection clipboard only while it handles an input
  // event, and only when the range is not empty. A range left on the focused
  // editor is written again after navigation, so the next drag cannot replace
  // it. Collapse before this click returns, then put the highlight back on a
  // timer. The timer is not an input event, so the browser keeps the caret.
  function releaseBrowserSelection(event) {
    if (event && typeof event.button === "number" && event.button !== 0) return;
    const view = typeof window !== "undefined" ? window : null;
    const sel = view && typeof view.getSelection === "function" ? view.getSelection() : null;
    if (!sel || typeof sel.collapse !== "function" || typeof sel.setBaseAndExtent !== "function") return;
    if (!sel.rangeCount || sel.isCollapsed) return;
    const anchorNode = sel.anchorNode;
    const anchorOffset = sel.anchorOffset;
    const focusNode = sel.focusNode;
    const focusOffset = sel.focusOffset;
    if (!anchorNode || !focusNode) return;
    sel.collapse(focusNode, focusOffset);
    if (typeof view.setTimeout !== "function") return;
    view.setTimeout(() => {
      if (anchorNode.isConnected === false || focusNode.isConnected === false) return;
      const live = typeof view.getSelection === "function" ? view.getSelection() : null;
      if (!live || typeof live.setBaseAndExtent !== "function") return;
      live.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
    }, 0);
  }

  listen("mousemove", onRootMouseMove);

  listen("click", (event) => {
    if (inPathStrip(event)) return;
    try {
      onEditorClick(event);
    } finally {
      releaseBrowserSelection(event);
    }
  });

  function followLinkTab(event, link) {
    if (!linkTabOpened) linkTabOpened = openLinkTab(link);
    if (linkTabOpened && event && typeof event.preventDefault === "function") event.preventDefault();
  }

  function onEditorClick(event) {
    const armed = gestureArmed;
    gestureArmed = false;
    const stored = armed ? gestureOffset : null;
    const target = event.target.nodeType === 1 ? event.target : event.target.parentElement;
    const link = anchorInEditor(event);
    const inDoc = !!link;
    const tabClick = inDoc && ctrlOpensTab(event);
    // A drag is not a click on the address. Cancelling it keeps the tab from opening.
    if (inDoc && (!tabClick || didDrag)) event.preventDefault();
    if (didDrag) {
      dropLinkTabHold();
      didDrag = false;
      const clickDetail = event && event.detail ? event.detail : 1;
      // Firefox's mouseup does not yield the click offset, and the short DOM
      // range can be back by the time this click runs. Map the release here.
      if (plainDrag && clickDetail < 2) {
        const previous = { anchor: state.anchor, cursor: state.cursor };
        const chosen = dragRelease(previous, event);
        if (chosen && (chosen.anchor !== previous.anchor || chosen.cursor !== previous.cursor)) {
          if (!commitDrag(chosen, previous)) {
            gestureOffset = null;
            return;
          }
        } else if (!domSelectionMatches()) {
          placeDragCaret();
          retainCaret();
        }
      }
      gestureOffset = null;
      return;
    }
    if (tabClick) {
      followLinkTab(event, link);
      releaseLinkTabHold();
      return;
    }
    dropLinkTabHold();
    if (inDoc) {
      const parsed = parseHash(hashFromHref(link.href));
      if (parsed) {
        activateHash(parsed);
        return;
      }
    }
    const highlighted = target?.closest?.(".md-comment");
    let keepCurrent = false;
    if (highlighted && highlighted.dataset && highlighted.dataset.comment) {
      const id = highlighted.dataset.comment;
      // A pin click only opens that thread. Selecting the picture would put the
      // caret on its markdown and the host would scroll back to the top.
      if (hasClass(highlighted, "md-comment-pin")) {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        const shot = captureScroll();
        const card = findCommentCard(id);
        if (card) showCurrentCard(card);
        else {
          currentCommentId = id;
          markCurrentHighlights();
        }
        restoreScroll(shot);
        const view = typeof window !== "undefined" ? window : null;
        if (view && typeof view.requestAnimationFrame === "function") {
          view.requestAnimationFrame(() => {
            if (!closed) restoreScroll(shot);
          });
        }
        return;
      }
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
    const detail = event.detail;
    if (event.shiftKey && detail === 1) {
      gestureHold = false;
      const claimed = adoptDomSelection();
      if (claimed && state.anchor !== state.cursor) useVimSelection("visual");
      // gestureHold kept selectionchange from placing the button for this click.
      updateCommentButton();
      return;
    }
    if (belowLastBlock(event)) {
      // The blank under the last paragraph has no height, so its edge is a pixel
      // under every box. Firefox reports that press as below the last line, past
      // that edge. The press is the blank. Padding farther under it is the line
      // after the final newline.
      const onEdge = gapUnderPoint(event);
      const onBlank = onEdge != null ? onEdge : collapsedEndBlank(event);
      const end = onBlank != null ? onBlank : state.doc.length;
      if (!keepCurrent) clearCurrentComment();
      if (event.detail === 1) gestureHold = true;
      state = { ...state, anchor: end, cursor: end };
      if (!claimLines(end, end)) {
        if (event.detail === 1) gestureHold = false;
        return;
      }
      caretClickLeavesVisual();
      render();
      return;
    }
    if (detail === 2 || detail === 3) {
      // The first click retained its collapsed caret. This click's span replaces it.
      retainedCaret = null;
      const atom = target?.closest?.(".md-atom");
      if (atom && root.contains(atom)) event.preventDefault();
      const offset = stored != null ? stored : pointOffset(event);
      if (offset == null) return;
      if (detail === 3) gestureOffset = null;
      if (!keepCurrent) clearCurrentComment();
      const span = detail === 2 ? wordSpan(state.doc, offset) : blockSpan(state.doc, offset);
      state = { ...state, anchor: span[0], cursor: span[1] };
      if (!claimLines(span[0], span[1])) return;
      if (span[0] !== span[1]) useVimSelection(detail === 3 ? "visual-line" : "visual");
      render();
      return;
    }
    const atom = target?.closest?.(".md-atom");
    if (atom && root.contains(atom)) {
      event.preventDefault();
      if (!keepCurrent) currentCommentId = null;
      // A press on the collapsed blank's edge hits the picture drawn under it.
      // The stored offset is that blank.
      if (stored != null && gapCaretStops(state.doc, state.cursor).includes(stored)) {
        if (detail === 1) gestureHold = true;
        state = { ...state, anchor: stored, cursor: stored };
        if (!claimLines(stored, stored)) {
          if (detail === 1) gestureHold = false;
          return;
        }
        caretClickLeavesVisual();
        render();
        return;
      }
      if (hasClass(atom, "md-image")) {
        const line = wholeImageLine(state.doc, Number(atom.dataset.start));
        if (line) {
          if (detail === 1) gestureHold = true;
          state = { ...state, anchor: line.anchor, cursor: line.cursor };
          if (!claimLines(line.anchor, line.cursor)) {
            if (detail === 1) gestureHold = false;
            return;
          }
          render();
          return;
        }
      }
      if (detail === 1) gestureHold = true;
      const next = atomClickOffset(atom, target);
      state = { ...state, anchor: next, cursor: next };
      if (!claimLines(next, next)) {
        if (detail === 1) gestureHold = false;
        return;
      }
      caretClickLeavesVisual();
      render();
      return;
    }
    if (!keepCurrent) clearCurrentComment();
    const offset = stored != null ? stored : pointOffset(event);
    if (offset == null) return;
    if (detail === 1) gestureHold = true;
    state = { ...state, anchor: offset, cursor: offset };
    if (!claimLines(offset, offset)) {
      if (detail === 1) gestureHold = false;
      return;
    }
    caretClickLeavesVisual();
    render();
    // Replacing the lines drops the node the caret was on. Chromium then
    // puts the selection back on the next frame, so place it again.
    retainCaret();
  }

  function retainCaret() {
    retainGeneration += 1;
    const generation = retainGeneration;
    const anchor = state.anchor;
    const cursor = state.cursor;
    retainedCaret = { anchor, cursor, generation };
    const view = typeof window !== "undefined" ? window : null;
    if (!view || typeof view.setTimeout !== "function") return;
    view.setTimeout(() => {
      if (closed) return;
      if (retainedCaret && retainedCaret.generation === generation) retainedCaret = null;
    }, 200);
  }

  listen("auxclick", (event) => {
    const link = anchorInEditor(event);
    if (!link) return;
    // Firefox may report Ctrl-click here as well as on click. One of the two opens the tab.
    if (ctrlOpensTab(event)) {
      followLinkTab(event, link);
      releaseLinkTabHold();
      return;
    }
    dropLinkTabHold();
    event.preventDefault();
  });

  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("selectionchange", onSelectionChange, { signal: ac.signal });
    document.addEventListener("focusin", syncVimBlockMark, { signal: ac.signal });
  }
  // The sheet tests store root and document listeners in one map. Window keeps
  // a release outside the editor from replacing the root mouseup handler.
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("mousemove", onDocumentMouseMove, { signal: ac.signal });
    window.addEventListener("mouseup", onDocumentMouseUp, { signal: ac.signal });
    window.addEventListener("scroll", syncVimBlockMark, { capture: true, signal: ac.signal });
  }
  listen("scroll", syncVimBlockMark);

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
      if (!box || !box.classList || !box.classList.contains("md-comment-body")) return;
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
      if (vimOn && event.key === "Escape" && !event.ctrlKey && !event.metaKey && !event.altKey
        && (box.dataset.reply === "true" || box.dataset.editing === "true")) {
        event.preventDefault();
        discardTypedNote(box);
        return;
      }
      const mod = event.ctrlKey || event.metaKey;
      if (mod && !event.altKey && event.key === "Enter") {
        event.preventDefault();
        onSave(box);
        returnFromCommentSave();
        return;
      }
      if (!mod || event.altKey) return;
      const key = event.key;
      if (key !== "z" && key !== "Z" && key !== "y" && key !== "Y") return;
      event.preventDefault();
      const id = box.dataset && box.dataset.comment;
      const note = Number(box.dataset && box.dataset.note || 0);
      const redoKey = key === "y" || key === "Y" || event.shiftKey;
      commentFocus = { id, note, start: Number.MAX_SAFE_INTEGER, end: Number.MAX_SAFE_INTEGER };
      emitHistory(redoKey ? "redo" : "undo");
    }, { signal: ac.signal });
  }

  // A fixed button keeps its window coordinates while the highlight moves with the text.
  const onScroll = () => {
    pinViewToggle();
    updateCommentButton();
  };
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("resize", () => {
      layoutComments();
      pinViewToggle();
    }, { signal: ac.signal });
    window.addEventListener("scroll", onScroll, { capture: true, signal: ac.signal });
    window.addEventListener("hashchange", () => onHashChange(), { signal: ac.signal });
  }
  listen("scroll", onScroll);

  function visibleTicketList() {
    const on = enabledFilters(filesNav());
    return ticketList.filter((ticket) => {
      if (ticket.state === "closed" && !on.has("closed")) return false;
      if (!on.has(ticket.priority)) return false;
      if (!on.has(ticket.type)) return false;
      return true;
    });
  }

  function seedTicketAncestors(id) {
    const byId = new Map();
    for (const ticket of ticketList) byId.set(ticket.id, ticket);
    const seen = new Set();
    let current = byId.get(id);
    while (current && current.parent && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = byId.get(current.parent);
      if (!parent || parent.id === current.id) break;
      expandedTickets.add(parent.id);
      current = parent;
    }
  }

  function renderTicketNode(ticket) {
    const node = document.createElement("div");
    node.className = "md-ticket-node";
    node.dataset.id = ticket.id;
    const row = document.createElement("div");
    row.className = "md-ticket-row";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "md-ticket";
    if (typeof open.setAttribute === "function") open.setAttribute("type", "button");
    const path = `tickets/${ticket.id}.md`;
    open.dataset.path = path;
    const fields = [
      ["md-ticket-id", ticket.id],
      ["md-ticket-title", ticket.title],
      ["md-ticket-priority", ticket.priority],
      ["md-ticket-assignee", ticket.assignee || ""],
      ["md-ticket-state", ticket.state],
      ["md-ticket-type", ticket.type],
    ];
    for (const [className, text] of fields) {
      const span = document.createElement("span");
      span.className = className;
      span.textContent = text;
      open.appendChild(span);
    }
    if (openPath === path) row.classList.add("md-ticket-current");
    open.addEventListener("click", (event) => {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      hashComment = null;
      pinnedComment = null;
      openPath = path;
      seedTicketAncestors(ticket.id);
      waitingForFile = true;
      emit({ type: "open", path });
      // The open frame can rebuild the list. Mark whatever row is on screen now.
      markOpenTicket();
      showTicketDrawer();
      publishHash();
      syncEntryLink();
    });
    row.appendChild(open);
    node.appendChild(row);
    return node;
  }

  function wireTicketSort(columns) {
    if (!columns) return;
    for (const child of columns.childNodes || []) {
      if (!child || child.tagName !== "BUTTON" || wiredSortButtons.has(child)) continue;
      wiredSortButtons.add(child);
      const key = child.dataset && child.dataset.sort;
      child.addEventListener("click", (event) => {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        if (!key) return;
        if (!ticketSort || ticketSort.key !== key) ticketSort = { key, dir: "asc" };
        else if (ticketSort.dir === "asc") ticketSort = { key, dir: "desc" };
        else ticketSort = null;
        renderTicketTree();
      });
    }
  }

  function paintTicketSort(columns) {
    if (!columns) return;
    for (const child of columns.childNodes || []) {
      if (!child || child.tagName !== "BUTTON") continue;
      const key = child.dataset && child.dataset.sort;
      for (const kid of [...(child.childNodes || [])]) {
        if (kid && String(kid.tagName || "").toLowerCase() === "svg") detachNode(kid);
      }
      if (ticketSort && ticketSort.key === key) child.appendChild(ticketSortGlyph(ticketSort.dir));
    }
  }

  function syncTicketColumns(tree) {
    const columns = ensureTicketColumns(tree);
    wireTicketSort(columns);
    paintTicketSort(columns);
    return columns;
  }

  function renderTicketTree() {
    const tree = findTicketTree(filesNav());
    if (!tree || typeof tree.replaceChildren !== "function") return;
    const columns = syncTicketColumns(tree);
    const visible = visibleTicketList();
    orderSiblings(visible, ticketSort);
    const nodes = [];
    for (const ticket of visible) nodes.push(renderTicketNode(ticket));
    if (columns) tree.replaceChildren(columns, ...nodes);
    else tree.replaceChildren(...nodes);
  }

  function ticketDrawerEl() {
    return findClassChild(findClassChild(filesNav(), "ticket-block"), "md-ticket-drawer");
  }

  function clearTicketDrawerTimer() {
    if (ticketDrawerTimer != null) {
      clearTimeout(ticketDrawerTimer);
      ticketDrawerTimer = null;
    }
  }

  function finishTicketDrawer(drawer) {
    ticketDrawerPhase = "";
    if (drawer && drawer.classList) drawer.classList.remove("md-ticket-wide");
    setStyle(drawer, "top", "");
    setStyle(drawer, "height", "");
    setStyle(drawer, "width", "");
    setStyle(drawer, "transition", "");
  }

  function showTicketDrawer() {
    // A click during the grace keeps the wide list. Once the width is easing
    // back, that close runs out; a pointer over the block is what widens it.
    if (ticketDrawerPhase === "wait") {
      clearTicketDrawerTimer();
      ticketDrawerPhase = "";
    }
    const drawer = ticketDrawerEl();
    if (drawer) showElement(drawer);
  }

  // A pointer that slips off and comes back inside 200ms keeps the wide list.
  // The wide class stays until the width has eased back. It holds position and
  // z-index, so the document does not paint over the drawer while it is still wide.
  function scheduleHideTicketDrawer() {
    clearTicketDrawerTimer();
    if (ticketDrawerPhase === "narrow") {
      const drawer = ticketDrawerEl();
      if (drawer && ticketDrawerCompact) setStyle(drawer, "width", ticketDrawerCompact);
      ticketDrawerTimer = setTimeout(() => {
        ticketDrawerTimer = null;
        finishTicketDrawer(drawer);
      }, 500);
      return;
    }
    ticketDrawerPhase = "wait";
    ticketDrawerTimer = setTimeout(() => {
      ticketDrawerTimer = null;
      const drawer = ticketDrawerEl();
      if (!drawer || !ticketDrawerCompact) {
        finishTicketDrawer(drawer);
        return;
      }
      ticketDrawerPhase = "narrow";
      setStyle(drawer, "width", ticketDrawerCompact);
      ticketDrawerTimer = setTimeout(() => {
        ticketDrawerTimer = null;
        finishTicketDrawer(drawer);
      }, 500);
    }, 200);
  }

  function markOpenTicket() {
    const tree = findTicketTree(filesNav());
    if (!tree) return;
    const walk = (node) => {
      for (const child of [...((node && node.childNodes) || [])]) {
        if (!child || child.nodeType !== 1) continue;
        if (child.classList && child.classList.contains("md-ticket-row")) {
          const button = findClassChild(child, "md-ticket");
          const path = button && button.dataset ? button.dataset.path : "";
          if (path && path === openPath) child.classList.add("md-ticket-current");
          else child.classList.remove("md-ticket-current");
        }
        walk(child);
      }
    };
    walk(tree);
  }

  function releaseTicketDrawer() {
    clearTicketDrawerTimer();
    ticketDrawerPhase = "";
    if (ticketBlockEl && typeof ticketBlockEl.removeEventListener === "function") {
      if (ticketDrawerEnter) ticketBlockEl.removeEventListener("pointerenter", ticketDrawerEnter);
      if (ticketDrawerLeave) ticketBlockEl.removeEventListener("pointerleave", ticketDrawerLeave);
    }
    ticketBlockEl = null;
    ticketDrawerEnter = null;
    ticketDrawerLeave = null;
  }

  function bindTicketDrawer(block) {
    if (!block) return;
    if (ticketBlockEl === block && ticketDrawerEnter) return;
    releaseTicketDrawer();
    ticketDrawerEnter = () => {
      const drawer = ticketDrawerEl();
      if (ticketDrawerPhase === "narrow") {
        clearTicketDrawerTimer();
        ticketDrawerPhase = "";
        if (drawer) setStyle(drawer, "width", "80vw");
      }
      showTicketDrawer();
      if (!drawer) return;
      const alreadyWide = Boolean(drawer.classList && drawer.classList.contains("md-ticket-wide"));
      // Fixed positioning replaces the pane box, so read that box before the wide class.
      // An inline width while transition is on starts from 100%. Once fixed, that
      // 100% is the viewport, so commit the measured width with the transition off.
      const rect = typeof drawer.getBoundingClientRect === "function" ? drawer.getBoundingClientRect() : null;
      if (rect) {
        setStyle(drawer, "top", `${rect.top}px`);
        setStyle(drawer, "height", `${rect.height}px`);
      }
      if (alreadyWide) return;
      if (rect && typeof rect.width === "number" && Number.isFinite(rect.width)) {
        ticketDrawerCompact = `${rect.width}px`;
      }
      setStyle(drawer, "transition", "none");
      if (rect) setStyle(drawer, "width", `${rect.width}px`);
      if (drawer.classList) drawer.classList.add("md-ticket-wide");
      void drawer.offsetWidth;
      setStyle(drawer, "transition", "");
      setStyle(drawer, "width", "80vw");
    };
    ticketDrawerLeave = () => {
      scheduleHideTicketDrawer();
    };
    ticketBlockEl = block;
    if (typeof block.addEventListener === "function") {
      block.addEventListener("pointerenter", ticketDrawerEnter);
      block.addEventListener("pointerleave", ticketDrawerLeave);
    }
  }

  function sendTicketSet(fields) {
    if (!openTicket || !openPath) return;
    const path = typeof fields.path === "string" && fields.path ? fields.path : openPath;
    const foreignRepo = typeof fields.repo === "string" && fields.repo && fields.repo !== activeRepo ? fields.repo : "";
    let target = openTicket;
    if (path !== openPath) {
      if (foreignRepo) {
        target = foreignList.find((item) => item.repo === foreignRepo && `tickets/${item.id}.md` === path)
          || inboundList.find((item) => item.repo === foreignRepo && `tickets/${item.id}.md` === path)
          || null;
      } else {
        target = ticketList.find((item) => `tickets/${item.id}.md` === path) || null;
      }
      if (!target) return;
    }
    // A child update names that file's rev. The open document rev belongs only to this path.
    const nextRev = typeof fields.rev === "number" ? fields.rev : (path === openPath ? rev : target.rev);
    if (Object.prototype.hasOwnProperty.call(fields, "title")) {
      if (fields.title === target.title) return;
    } else if (Object.prototype.hasOwnProperty.call(fields, "state")) {
      if (fields.state === target.state) return;
    } else if (Object.prototype.hasOwnProperty.call(fields, "parent")) {
      if ((fields.parent || "") === (target.parent || "")) return;
    } else if (Object.prototype.hasOwnProperty.call(fields, "depends")) {
      if (sameSet(fields.depends, target.depends)) return;
    } else if (Object.prototype.hasOwnProperty.call(fields, "type")) {
      if (fields.type === target.type) return;
    } else if (Object.prototype.hasOwnProperty.call(fields, "priority")) {
      if (fields.priority === target.priority) return;
    } else if (Object.prototype.hasOwnProperty.call(fields, "assignee")) {
      if ((fields.assignee || "") === (target.assignee || "")) return;
    } else {
      return;
    }
    // Frame `type` is the command, so the ticket type travels as ticketType.
    const payload = { type: "ticket.set", path, rev: nextRev };
    if (foreignRepo) payload.repo = foreignRepo;
    if (Object.prototype.hasOwnProperty.call(fields, "type")) {
      payload.ticketType = fields.type;
      emit(payload);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(fields, "title")) payload.title = fields.title;
    else if (Object.prototype.hasOwnProperty.call(fields, "state")) payload.state = fields.state;
    else if (Object.prototype.hasOwnProperty.call(fields, "parent")) payload.parent = fields.parent || "";
    else if (Object.prototype.hasOwnProperty.call(fields, "depends")) payload.depends = fields.depends;
    else if (Object.prototype.hasOwnProperty.call(fields, "priority")) payload.priority = fields.priority;
    else if (Object.prototype.hasOwnProperty.call(fields, "assignee")) payload.assignee = fields.assignee || "";
    else return;
    emit(payload);
  }

  function typedQuery(input) {
    const value = String(input.value || "");
    const start = Number(input.selectionStart);
    const end = Number(input.selectionEnd);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && start >= 0 && start <= value.length) {
      return value.slice(0, start);
    }
    return value;
  }

  function selectInput(input, start, end) {
    input.selectionStart = start;
    input.selectionEnd = end;
    if (typeof input.setSelectionRange === "function") input.setSelectionRange(start, end);
  }

  function matchTicketText(ticket, needle) {
    const title = typeof ticket.title === "string" ? ticket.title : "";
    const id = typeof ticket.id === "string" ? ticket.id : "";
    if (title.toLowerCase().startsWith(needle)) return title;
    if (id.toLowerCase().startsWith(needle)) return id;
    return null;
  }

  function matchingTickets(query) {
    const typed = String(query || "");
    if (!typed || !openTicket) return [];
    const needle = typed.toLowerCase();
    const matches = [];
    for (const ticket of ticketList) {
      if (!ticket || ticket.id === openTicket.id) continue;
      const text = matchTicketText(ticket, needle);
      if (text != null) matches.push({ ticket, text });
    }
    for (const item of foreignList) {
      if (!item || !item.id) continue;
      const ticket = {
        id: item.id,
        repo: item.repo,
        title: item.title,
        parent: item.parent,
        depends: item.depends,
        rev: item.rev,
      };
      const text = matchTicketText(ticket, needle);
      if (text != null) matches.push({ ticket, text });
    }
    matches.sort((a, b) => compareTickets(a.ticket, b.ticket));
    return matches.slice(0, 5);
  }

  function plainButton(className, text) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = text;
    if (typeof button.setAttribute === "function") button.setAttribute("type", "button");
    return button;
  }

  function strokeButton(className, label, d, title) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `icon-btn ${className}`;
    if (typeof button.setAttribute === "function") {
      button.setAttribute("type", "button");
      button.setAttribute("aria-label", label);
      button.setAttribute("title", title || label);
    }
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = typeof document.createElementNS === "function"
      ? document.createElementNS(svgNS, "svg")
      : document.createElement("svg");
    const path = typeof document.createElementNS === "function"
      ? document.createElementNS(svgNS, "path")
      : document.createElement("path");
    if (typeof svg.setAttribute === "function") {
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("aria-hidden", "true");
    }
    if (typeof path.setAttribute === "function") {
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "currentColor");
      path.setAttribute("stroke-width", "2");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      path.setAttribute("d", d);
    }
    svg.appendChild(path);
    button.appendChild(svg);
    return button;
  }

  function nodeWithin(ancestor, node) {
    let current = node;
    while (current) {
      if (current === ancestor) return true;
      current = current.parentElement;
    }
    return false;
  }

  // Pointerdown on the button or inside the panel belongs to the click handler.
  function closePopupOutside(panel, button, target) {
    if (!panel || panel.hidden) return;
    if (nodeWithin(panel, target) || nodeWithin(button, target)) return;
    hideElement(panel);
  }

  function closeTicketMenu() {
    ticketMenuOpen = false;
    const panel = ticketForm && findClassChild(ticketForm, "md-ticket-pane-panel");
    const button = ticketForm && findClassChild(ticketForm, "md-ticket-pane-menu");
    hideElement(panel);
    if (button && typeof button.setAttribute === "function") button.setAttribute("aria-expanded", "false");
  }

  // The menu button and panel sit outside #editor, so Escape there never reaches the editor listener.
  function onTicketMenuEscape(event) {
    if (!event || event.key !== "Escape" || !ticketMenuOpen) return;
    closeTicketMenu();
  }

  // The file can still hold a token whose ticket is gone. It is not drawn as a
  // parent, a dependency, a block, or a child. An unregistered name is not gone.
  function tokenAbsent(token) {
    if (typeof token !== "string" || token === "") return false;
    const parsed = parseTicketToken(token);
    if (!parsed) return false;
    const repo = parsed.repo || activeRepo;
    if (!repo || repo === activeRepo) return !ticketList.some((ticket) => ticket.id === parsed.id);
    if (!repoNames.has(repo) || !linkPresent) return false;
    return !linkPresent.has(`${repo}:${parsed.id}`);
  }

  function shownParent(ticket) {
    if (!ticket || typeof ticket.parent !== "string" || ticket.parent === "" || tokenAbsent(ticket.parent)) return "";
    return ticket.parent;
  }

  function shownDepends(ticket) {
    const deps = Array.isArray(ticket && ticket.depends) ? ticket.depends : [];
    return deps.filter((dep) => !tokenAbsent(dep));
  }

  function relationPresence(ticket) {
    return {
      parent: shownParent(ticket) !== "",
      depends: shownDepends(ticket).length > 0,
      children: childTicketsOf(ticket).length > 0,
      blocks: blockersOf(ticket).length > 0,
    };
  }

  function syncRelationShown(ticket) {
    const presence = relationPresence(ticket);
    if (ticket.id !== relationTicketId) {
      relationTicketId = ticket.id;
      relationShown = { ...presence };
      relationHad = { ...presence };
      ticketMenuOpen = false;
      return;
    }
    const shown = { ...relationShown };
    for (const key of ["parent", "depends", "children", "blocks"]) {
      if (presence[key] && !relationHad[key]) shown[key] = true;
    }
    relationShown = shown;
    relationHad = { ...presence };
  }

  function onTicketPointerDown(event) {
    const target = event && event.target;
    for (const picker of ticketPickers) picker.dismissOutside(target);
    const chrome = ticketChrome;
    closePopupOutside(chrome && chrome.filterMenu, chrome && chrome.filterButton, target);
    const panel = ticketForm && findClassChild(ticketForm, "md-ticket-pane-panel");
    const button = ticketForm && findClassChild(ticketForm, "md-ticket-pane-menu");
    if (panel && !panel.hidden && !nodeWithin(panel, target) && !nodeWithin(button, target)) closeTicketMenu();
    if (docMenuPanel && !docMenuPanel.hidden && !nodeWithin(docMenuPanel, target) && !nodeWithin(docMenuButton, target)) closeDocMenu();
    closePopupOutside(fileMenu, null, target);
  }

  function bindTicketPointer() {
    if (ticketPointerBound) return;
    if (typeof document === "undefined" || typeof document.addEventListener !== "function") return;
    document.addEventListener("pointerdown", onTicketPointerDown);
    ticketPointerBound = true;
  }

  function buildTicketPicker(options) {
    const onAdd = options.onAdd;
    const onRemove = options.onRemove;
    const onClear = options.onClear;
    const commitOnPick = options.commitOnPick === true;
    const buttons = options.buttons !== false;
    // A typed token that is not a suggestion is stored as typed. A suggestion
    // from another repo is that repo's ticket, not text.
    const acceptTyped = options.acceptTyped === true;
    const picker = document.createElement("div");
    picker.className = "md-ticket-picker";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "md-ticket-match";
    input.value = typeof options.value === "string" ? options.value : "";
    markField(input, input.value);
    if (typeof input.setAttribute === "function") input.setAttribute("type", "text");
    const menu = document.createElement("div");
    menu.className = "md-ticket-menu";
    hideElement(menu);
    const state = { chosen: null };
    let applying = false;
    // Typed text when the menu opens, before the completion replaces it. Outside puts that back and sends nothing.
    let openedValue = input.value;

    function clearMatch() {
      state.chosen = null;
      input.value = "";
      openedValue = "";
      selectInput(input, 0, 0);
      menu.replaceChildren();
      hideElement(menu);
    }

    function typedToken() {
      const raw = String(input.value || "").trim();
      if (!isTicketToken(raw) || !openTicket) return "";
      if (raw === openTicket.id) return "";
      if (activeRepo && raw === `${activeRepo}:${openTicket.id}`) return "";
      return raw;
    }

    function commitTyped() {
      const token = typedToken();
      if (!token) return false;
      clearMatch();
      onAdd({ id: token });
      return true;
    }

    function showMatches() {
      if (applying) return;
      applying = true;
      const wasHidden = menu.hidden;
      const typedValue = input.value;
      const query = typedQuery(input);
      const matches = matchingTickets(query);
      menu.replaceChildren();
      if (!query || matches.length === 0) {
        state.chosen = null;
        hideElement(menu);
        applying = false;
        return;
      }
      if (wasHidden) openedValue = typedValue;
      state.chosen = matches[0].ticket;
      const completion = matches[0].text;
      if (input.value !== completion) input.value = completion;
      selectInput(input, query.length, completion.length);
      for (const match of matches) {
        const option = plainButton("md-ticket-option", match.ticket.title || match.text);
        option.dataset.id = match.ticket.id;
        if (match.ticket.repo && match.ticket.repo !== activeRepo) option.dataset.repo = match.ticket.repo;
        // mousedown would blur the field and drop the click before it chooses the row.
        option.addEventListener("mousedown", (event) => {
          if (event && typeof event.preventDefault === "function") event.preventDefault();
        });
        option.addEventListener("click", (event) => {
          if (event && typeof event.preventDefault === "function") event.preventDefault();
          state.chosen = match.ticket;
          input.value = match.text;
          openedValue = match.text;
          selectInput(input, match.text.length, match.text.length);
          hideElement(menu);
          if (commitOnPick) onAdd(match.ticket);
        });
        menu.appendChild(option);
      }
      showElement(menu);
      applying = false;
    }

    function onMatchInput() {
      if (commitOnPick && input.value === "") {
        state.chosen = null;
        openedValue = "";
        menu.replaceChildren();
        hideElement(menu);
        if (onClear) onClear();
        return;
      }
      showMatches();
    }

    input.addEventListener("input", onMatchInput);
    input.addEventListener("keydown", (event) => {
      if (!event || event.key !== "Enter") return;
      if (typeof event.preventDefault === "function") event.preventDefault();
      if (commitOnPick && !menu.hidden && state.chosen) {
        const ticket = state.chosen;
        hideElement(menu);
        onAdd(ticket);
        return;
      }
      if (acceptTyped && menu.hidden) commitTyped();
    });
    const parts = [input];
    if (buttons) {
      const add = strokeButton("md-ticket-add", "Add", "M12 5v14M5 12h14", options.addTitle);
      const remove = strokeButton("md-ticket-remove", "Remove", "M5 12h14", options.removeTitle);
      add.addEventListener("click", (event) => {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        const ticket = state.chosen;
        if (ticket) {
          clearMatch();
          onAdd(ticket);
          return;
        }
        if (acceptTyped) commitTyped();
      });
      remove.addEventListener("click", (event) => {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        onRemove();
      });
      parts.push(add, remove);
    }
    parts.push(menu);
    picker.append(...parts);
    ticketPickers.push({
      dismissOutside(target) {
        if (menu.hidden) return;
        if (nodeWithin(picker, target)) return;
        input.value = openedValue;
        selectInput(input, openedValue.length, openedValue.length);
        state.chosen = null;
        menu.replaceChildren();
        hideElement(menu);
      },
    });
    bindTicketPointer();
    return picker;
  }

  function buildLinkList(tickets, onRemove) {
    let selected = null;
    const links = document.createElement("div");
    links.className = "md-ticket-links";
    function fill(next) {
      selected = null;
      const rows = [];
      for (const ticket of next || []) {
        const row = plainButton("md-ticket-link", ticket.title || ticket.id);
        row.dataset.id = ticket.id;
        if (ticket.inbound) {
          row.dataset.repo = ticket.repo || "";
          row.dataset.inbound = "true";
        }
        row.addEventListener("click", (event) => {
          if (event && typeof event.preventDefault === "function") event.preventDefault();
          selected = ticket;
          for (const child of links.childNodes) {
            if (!child.classList || !child.classList.contains("md-ticket-link")) continue;
            if (child === row) child.classList.add("md-ticket-selected");
            else child.classList.remove("md-ticket-selected");
          }
        });
        rows.push(row);
      }
      links.replaceChildren(...rows);
    }
    fill(tickets);
    linkFill.set(links, fill);
    return {
      links,
      removeSelected() {
        if (!selected) return;
        onRemove(selected);
      },
    };
  }

  // A bare id and this repo's repo:id are the same local ticket. The stored
  // token stays the row id so remove filters that token. A registered ticket's
  // title comes from foreign. An unregistered token stays the token.
  function knownTicket(token) {
    const parsed = parseTicketToken(token);
    if (parsed && (!parsed.repo || parsed.repo === activeRepo)) {
      const local = ticketList.find((item) => item.id === parsed.id);
      if (local) return { ...local, id: token, title: local.title || token };
    }
    if (parsed && parsed.repo && parsed.repo !== activeRepo) {
      const foreign = foreignList.find((item) => item.repo === parsed.repo && item.id === parsed.id);
      if (foreign && foreign.title) {
        return {
          id: token,
          title: foreign.title,
          created: "",
          parent: foreign.parent,
          depends: foreign.depends,
          rev: foreign.rev,
          repo: foreign.repo,
        };
      }
    }
    return {
      id: token,
      title: token,
      created: "",
      parent: "",
      depends: [],
      rev: 0,
    };
  }

  // A pick in this repo stores a bare id. A pick in another repo stores repo:id.
  function storedToken(chosen) {
    if (!chosen || typeof chosen.id !== "string") return "";
    if (typeof chosen.repo === "string" && chosen.repo && chosen.repo !== activeRepo) return `${chosen.repo}:${chosen.id}`;
    return chosen.id;
  }

  function aimedRepo(chosen) {
    if (!chosen || typeof chosen.repo !== "string" || !chosen.repo || chosen.repo === activeRepo) return "";
    return chosen.repo;
  }

  function linkHere(id) {
    return activeRepo ? `${activeRepo}:${id}` : id;
  }

  function namesLocal(token, id) {
    if (token === id) return true;
    return Boolean(activeRepo) && token === `${activeRepo}:${id}`;
  }

  function namesInbound(token, id) {
    return Boolean(activeRepo) && token === `${activeRepo}:${id}`;
  }

  function inboundMatches(predicate) {
    const rows = [];
    for (const item of inboundList) {
      if (!item || !predicate(item)) continue;
      const foreign = foreignList.find((row) => row.repo === item.repo && row.id === item.id);
      rows.push({
        id: item.id,
        title: item.title || (foreign && foreign.title) || `${item.repo}:${item.id}`,
        repo: item.repo,
        parent: item.parent,
        depends: item.depends,
        inbound: true,
        rev: foreign ? foreign.rev : 0,
        created: "",
      });
    }
    rows.sort((a, b) => {
      if (a.repo < b.repo) return -1;
      if (a.repo > b.repo) return 1;
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });
    return rows;
  }

  function childTicketsOf(ticket) {
    const local = ticketList
      .filter((item) => item.id !== ticket.id && !tokenAbsent(item.parent) && namesLocal(item.parent, ticket.id))
      .sort(compareTickets);
    return local.concat(inboundMatches((item) => !tokenAbsent(item.parent) && namesInbound(item.parent, ticket.id)));
  }

  function blockersOf(ticket) {
    const namesHere = (dep) => !tokenAbsent(dep) && namesLocal(dep, ticket.id);
    const namesHereInbound = (dep) => !tokenAbsent(dep) && namesInbound(dep, ticket.id);
    const local = ticketList
      .filter((item) => item.id !== ticket.id && Array.isArray(item.depends) && item.depends.some(namesHere))
      .sort(compareTickets);
    return local.concat(inboundMatches((item) => Array.isArray(item.depends) && item.depends.some(namesHereInbound)));
  }

  function parentLabel(ticket) {
    const parent = shownParent(ticket);
    if (!parent) return "";
    const known = knownTicket(parent);
    return known.title || parent;
  }

  function ticketStructureKey(ticket) {
    const parts = [ticket.id];
    for (const key of ["parent", "depends", "children", "blocks"]) {
      if (relationShown[key]) parts.push(key);
    }
    return parts.join("\n");
  }

  function activeInForm() {
    const active = typeof document !== "undefined" && document ? document.activeElement : null;
    if (!active || !ticketForm || !nodeWithin(ticketForm, active)) return null;
    return active;
  }

  function markField(input, value) {
    if (!input) return;
    paintedField.set(input, value == null ? "" : String(value));
  }

  function inputUnsaved(input) {
    if (!input || activeInForm() !== input || !paintedField.has(input)) return false;
    return String(input.value || "") !== paintedField.get(input);
  }

  function paintField(input, value) {
    if (!input) return;
    const next = value == null ? "" : String(value);
    if (inputUnsaved(input)) {
      if (String(input.value || "") === next) markField(input, next);
      return;
    }
    if (input.value !== next) input.value = next;
    markField(input, next);
  }

  function paintText(node, value) {
    if (!node) return;
    const next = value == null ? "" : String(value);
    if (node.textContent !== next) node.textContent = next;
  }

  function ticketFieldKey(el) {
    if (!el || !el.classList) return "";
    if (el.classList.contains("md-ticket-assignee")) return "assignee";
    if (el.classList.contains("md-ticket-title-input")) return "title";
    const section = typeof el.closest === "function"
      ? el.closest(".md-ticket-parent, .md-ticket-depends, .md-ticket-children, .md-ticket-blocks")
      : null;
    if (!section || !section.classList) return "";
    if (section.classList.contains("md-ticket-parent")) return "parent";
    if (section.classList.contains("md-ticket-depends")) return "depends";
    if (section.classList.contains("md-ticket-children")) return "children";
    if (section.classList.contains("md-ticket-blocks")) return "blocks";
    return "";
  }

  function heldTicketField() {
    const active = activeInForm();
    const tag = active ? String(active.tagName || "").toUpperCase() : "";
    if (tag !== "INPUT" && tag !== "TEXTAREA") return null;
    const key = ticketFieldKey(active);
    if (!key || !paintedField.has(active)) return null;
    return {
      key,
      value: String(active.value || ""),
      unsaved: String(active.value || "") !== paintedField.get(active),
      start: active.selectionStart,
      end: active.selectionEnd,
    };
  }

  function findHeldInput(key) {
    if (!ticketForm) return null;
    if (key === "assignee") return findDeep(ticketForm, "md-ticket-assignee");
    if (key === "title") return findDeep(ticketForm, "md-ticket-title-input");
    const sectionName = {
      parent: "md-ticket-parent",
      depends: "md-ticket-depends",
      children: "md-ticket-children",
      blocks: "md-ticket-blocks",
    }[key];
    if (!sectionName) return null;
    const section = findElement(ticketForm, (el) => el.classList && el.classList.contains(sectionName));
    return section && findElement(section, (el) => el.classList && el.classList.contains("md-ticket-match"));
  }

  function restoreHeld(held) {
    if (!held) return;
    const input = findHeldInput(held.key);
    if (!input) return;
    if (held.unsaved) input.value = held.value;
    if (held.key === "title") {
      hideElement(findDeep(ticketForm, "md-ticket-heading"));
      showElement(input);
    }
    if (typeof input.focus === "function") input.focus();
    if (Number.isFinite(held.start) && Number.isFinite(held.end)) selectInput(input, held.start, held.end);
  }

  function refreshLinkList(sectionClass, tickets) {
    const section = findElement(ticketForm, (el) => el.classList && el.classList.contains(sectionClass));
    if (!section) return;
    const links = findElement(section, (el) => el.classList && el.classList.contains("md-ticket-links"));
    const fill = links && linkFill.get(links);
    if (typeof fill === "function") fill(tickets);
  }

  // Replacing the input drops the caret. Firefox then paints the remote value.
  function refreshTicketForm(ticket) {
    const form = ticketForm;
    const titleInput = findDeep(form, "md-ticket-title-input");
    if (!inputUnsaved(titleInput)) {
      paintText(findDeep(form, "md-ticket-heading"), ticket.title);
      paintField(titleInput, ticket.title);
    }
    const choice = (className, value) => {
      const select = findDeep(form, className);
      if (!select) return;
      const next = value == null ? "" : String(value);
      if (select.value !== next) select.value = next;
    };
    choice("md-ticket-state", ticket.state);
    choice("md-ticket-type", ticket.type);
    choice("md-ticket-priority", ticket.priority);
    paintField(findDeep(form, "md-ticket-assignee"), ticket.assignee || "");
    paintText(findDeep(form, "md-ticket-reporter"), ticket.reporter);
    paintText(findDeep(form, "md-ticket-created"), ticket.created);
    const parent = findElement(form, (el) => el.classList && el.classList.contains("md-ticket-parent"));
    if (parent) {
      paintField(findElement(parent, (el) => el.classList && el.classList.contains("md-ticket-match")), parentLabel(ticket));
    }
    refreshLinkList("md-ticket-depends", shownDepends(ticket).map(knownTicket));
    refreshLinkList("md-ticket-children", childTicketsOf(ticket));
    refreshLinkList("md-ticket-blocks", blockersOf(ticket));
  }

  function renderTicketForm() {
    const form = ticketForm;
    if (!form || !openTicket || typeof document === "undefined" || typeof document.createElement !== "function") return;
    const ticket = openTicket;
    syncRelationShown(ticket);
    showElement(form);
    const key = ticketStructureKey(ticket);
    if (key === ticketFormKey && findDeep(form, "md-ticket-assignee")) {
      refreshTicketForm(ticket);
      // The body box moves with the form. Cards were placed against the box from before this change.
      layoutComments();
      return;
    }
    const held = heldTicketField();
    ticketFormKey = key;
    ticketPickers.length = 0;
    const heading = document.createElement("div");
    heading.className = "md-ticket-heading";
    heading.textContent = ticket.title;
    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.className = "md-ticket-title-input";
    titleInput.value = ticket.title;
    markField(titleInput, ticket.title);
    if (typeof titleInput.setAttribute === "function") titleInput.setAttribute("type", "text");
    hideElement(titleInput);
    let pendingTitle = null;
    let skipTitleBlur = false;

    function showHeading(text) {
      heading.textContent = text;
      showElement(heading);
      hideElement(titleInput);
    }

    function restoreTitle() {
      pendingTitle = null;
      const title = openTicket ? openTicket.title : "";
      titleInput.value = title;
      markField(titleInput, title);
      showHeading(title);
    }

    function commitTitle() {
      if (titleInput.hidden || !openTicket) return;
      const next = validTicketTitle(titleInput.value);
      if (next == null) {
        restoreTitle();
        return;
      }
      if (next === openTicket.title || next === pendingTitle) {
        showHeading(next === openTicket.title ? openTicket.title : next);
        titleInput.value = heading.textContent;
        markField(titleInput, titleInput.value);
        return;
      }
      pendingTitle = next;
      showHeading(next);
      titleInput.value = next;
      markField(titleInput, next);
      sendTicketSet({ title: next });
    }

    heading.addEventListener("click", () => {
      if (!openTicket) return;
      titleInput.value = heading.textContent;
      markField(titleInput, titleInput.value);
      hideElement(heading);
      showElement(titleInput);
      if (typeof titleInput.focus === "function") titleInput.focus();
    });
    titleInput.addEventListener("keydown", (event) => {
      if (!event) return;
      if (event.key === "Escape") {
        if (typeof event.preventDefault === "function") event.preventDefault();
        skipTitleBlur = true;
        restoreTitle();
        return;
      }
      if (event.key !== "Enter") return;
      if (typeof event.preventDefault === "function") event.preventDefault();
      commitTitle();
    });
    titleInput.addEventListener("blur", () => {
      if (rebuildingTicketForm || skipTitleBlur) {
        skipTitleBlur = false;
        return;
      }
      if (findDeep(ticketForm, "md-ticket-title-input") !== titleInput) return;
      commitTitle();
    });

    function fieldName(text) {
      const name = document.createElement("span");
      name.className = "md-ticket-label";
      name.textContent = text;
      return name;
    }

    function selectField(labelText, className, values, current, onChange) {
      const label = document.createElement("label");
      label.className = "md-ticket-field";
      const select = document.createElement("select");
      select.className = className;
      for (const value of values) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        select.appendChild(option);
      }
      select.value = current;
      select.addEventListener("change", () => onChange(select.value));
      label.append(fieldName(labelText), select);
      return { label, select };
    }

    const stateField = selectField("State", "md-ticket-state", TICKET_STATES, ticket.state, (value) => {
      sendTicketSet({ state: value });
    });
    const typeField = selectField("Type", "md-ticket-type", TICKET_TYPES, ticket.type, (value) => {
      sendTicketSet({ type: value });
    });
    const priorityField = selectField("Priority", "md-ticket-priority", TICKET_PRIORITIES, ticket.priority, (value) => {
      sendTicketSet({ priority: value });
    });
    const assigneeLabel = document.createElement("label");
    assigneeLabel.className = "md-ticket-field";
    const assigneeInput = document.createElement("input");
    assigneeInput.type = "text";
    assigneeInput.className = "md-ticket-assignee";
    assigneeInput.value = ticket.assignee || "";
    markField(assigneeInput, assigneeInput.value);
    if (typeof assigneeInput.setAttribute === "function") assigneeInput.setAttribute("type", "text");
    let skipAssigneeBlur = false;
    function commitAssignee() {
      if (!openTicket) return;
      const raw = String(assigneeInput.value || "");
      if (/[\r\n\t]/.test(raw)) {
        const stored = openTicket.assignee || "";
        assigneeInput.value = stored;
        markField(assigneeInput, stored);
        return;
      }
      const next = raw.trim();
      assigneeInput.value = next;
      markField(assigneeInput, next);
      if (next === (openTicket.assignee || "")) return;
      sendTicketSet({ assignee: next });
    }
    assigneeInput.addEventListener("keydown", (event) => {
      if (!event) return;
      if (event.key === "Escape") {
        if (typeof event.preventDefault === "function") event.preventDefault();
        skipAssigneeBlur = true;
        const stored = openTicket ? (openTicket.assignee || "") : "";
        assigneeInput.value = stored;
        markField(assigneeInput, stored);
        return;
      }
      if (event.key !== "Enter") return;
      if (typeof event.preventDefault === "function") event.preventDefault();
      commitAssignee();
    });
    assigneeInput.addEventListener("blur", () => {
      if (rebuildingTicketForm || skipAssigneeBlur) {
        skipAssigneeBlur = false;
        return;
      }
      if (findDeep(ticketForm, "md-ticket-assignee") !== assigneeInput) return;
      commitAssignee();
    });
    assigneeLabel.append(fieldName("Assignee"), assigneeInput);
    const sized = [stateField.select, typeField.select, priorityField.select];
    const selectWidth = sharedSelectWidth(sized);
    if (selectWidth > 0) paintSelectWidth(sized, selectWidth);

    const parentField = document.createElement("div");
    parentField.className = "md-ticket-field md-ticket-parent";
    const parentShown = parentLabel(ticket);
    const parentPicker = buildTicketPicker({
      commitOnPick: true,
      buttons: false,
      acceptTyped: true,
      value: parentShown,
      onAdd: (chosen) => sendTicketSet({ parent: storedToken(chosen) }),
      onClear: () => sendTicketSet({ parent: "" }),
    });
    parentField.append(fieldName("Parent"), parentPicker);

    const depends = document.createElement("div");
    depends.className = "md-ticket-depends";
    const dependList = buildLinkList(shownDepends(ticket).map(knownTicket), (selected) => {
      const current = openTicket;
      if (!current) return;
      sendTicketSet({ depends: (current.depends || []).filter((id) => id !== selected.id) });
    });
    const dependPicker = buildTicketPicker({
      addTitle: "Add a dependency",
      removeTitle: "Remove a dependency",
      acceptTyped: true,
      onAdd: (chosen) => {
        const current = openTicket;
        if (!current) return;
        const token = storedToken(chosen);
        if (!token) return;
        const ids = (current.depends || []).slice();
        if (!ids.includes(token)) ids.push(token);
        sendTicketSet({ depends: ids });
      },
      onRemove: () => dependList.removeSelected(),
    });
    const dependStack = document.createElement("div");
    dependStack.className = "md-ticket-stack";
    dependStack.append(dependPicker, dependList.links);
    depends.append(fieldName("Depends"), dependStack);

    const children = document.createElement("div");
    children.className = "md-ticket-children";
    const childTickets = childTicketsOf(ticket);
    const childList = buildLinkList(childTickets, (selected) => {
      const fields = {
        path: `tickets/${selected.id}.md`,
        rev: selected.rev,
        parent: "",
      };
      if (selected.inbound && selected.repo) fields.repo = selected.repo;
      sendTicketSet(fields);
    });
    const childPicker = buildTicketPicker({
      addTitle: "Add a child",
      removeTitle: "Remove a child",
      onAdd: (chosen) => {
        const repo = aimedRepo(chosen);
        const fields = {
          path: `tickets/${chosen.id}.md`,
          rev: chosen.rev,
          parent: repo ? linkHere(ticket.id) : ticket.id,
        };
        if (repo) fields.repo = repo;
        sendTicketSet(fields);
      },
      onRemove: () => childList.removeSelected(),
    });
    const childStack = document.createElement("div");
    childStack.className = "md-ticket-stack";
    childStack.append(childPicker, childList.links);
    children.append(fieldName("Children"), childStack);

    function factRow(labelText, valueClass, value) {
      const row = document.createElement("div");
      row.className = "md-ticket-fact";
      const valueNode = document.createElement("div");
      valueNode.className = valueClass;
      valueNode.textContent = value;
      row.append(fieldName(labelText), valueNode);
      return row;
    }

    function idFactRow(id) {
      const row = document.createElement("div");
      row.className = "md-ticket-fact";
      const valueNode = document.createElement("div");
      valueNode.className = "md-ticket-fact-id";
      valueNode.appendChild(document.createTextNode(id));
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "icon-btn md-ticket-copy-id";
      if (typeof copy.setAttribute === "function") {
        copy.setAttribute("type", "button");
        copy.setAttribute("aria-label", "Copy ticket id");
        copy.setAttribute("title", "Copy ticket id");
      }
      const glyph = copyGlyph();
      if (glyph) copy.appendChild(glyph);
      copy.addEventListener("click", (event) => {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        writeClipboard(id);
      });
      valueNode.appendChild(copy);
      row.append(fieldName("Id"), valueNode);
      return row;
    }

    const blockers = blockersOf(ticket);
    const blocks = document.createElement("div");
    blocks.className = "md-ticket-blocks";
    const blockList = buildLinkList(blockers, (selected) => {
      const drop = selected.inbound
        ? (dep) => namesInbound(dep, ticket.id)
        : (dep) => namesLocal(dep, ticket.id);
      const fields = {
        path: `tickets/${selected.id}.md`,
        rev: selected.rev,
        depends: (selected.depends || []).filter((dep) => !drop(dep)),
      };
      if (selected.inbound && selected.repo) fields.repo = selected.repo;
      sendTicketSet(fields);
    });
    const blockPicker = buildTicketPicker({
      addTitle: "Add a block",
      removeTitle: "Remove a block",
      onAdd: (chosen) => {
        const repo = aimedRepo(chosen);
        const token = repo ? linkHere(ticket.id) : ticket.id;
        const ids = (chosen.depends || []).slice();
        if (!ids.includes(token)) ids.push(token);
        const fields = {
          path: `tickets/${chosen.id}.md`,
          rev: chosen.rev,
          depends: ids,
        };
        if (repo) fields.repo = repo;
        sendTicketSet(fields);
      },
      onRemove: () => blockList.removeSelected(),
    });
    const blockStack = document.createElement("div");
    blockStack.className = "md-ticket-stack";
    blockStack.append(blockPicker, blockList.links);
    blocks.append(fieldName("Blocks"), blockStack);

    const fields = document.createElement("div");
    fields.className = "md-ticket-column";
    const left = [heading, titleInput, stateField.label, typeField.label, priorityField.label, assigneeLabel];
    if (relationShown.parent) left.push(parentField);
    if (relationShown.depends) left.push(depends);
    if (relationShown.children) left.push(children);
    if (relationShown.blocks) left.push(blocks);
    fields.append(...left);
    const facts = document.createElement("div");
    facts.className = "md-ticket-column";
    facts.append(
      idFactRow(ticket.id),
      factRow("Reporter", "md-ticket-reporter", ticket.reporter),
      factRow("Created", "md-ticket-created", ticket.created),
    );
    const menuButton = iconButton("menu", "md-ticket-pane-menu");
    if (typeof menuButton.setAttribute === "function") {
      menuButton.setAttribute("aria-label", "Menu");
      menuButton.setAttribute("title", "Open the ticket menu");
      menuButton.setAttribute("aria-haspopup", "menu");
      menuButton.setAttribute("aria-expanded", ticketMenuOpen ? "true" : "false");
    }
    const menuPanel = document.createElement("div");
    menuPanel.className = "md-ticket-pane-panel";
    if (typeof menuPanel.setAttribute === "function") menuPanel.setAttribute("role", "menu");
    if (!ticketMenuOpen) hideElement(menuPanel);
    const copyLink = plainButton("md-ticket-pane-item", "Copy link");
    copyLink.addEventListener("click", (event) => {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      closeTicketMenu();
      const hash = formatHash({ repo: activeRepo, kind: "ticket", id: ticket.id });
      if (!hash) return;
      writeClipboard(absoluteHash(hash));
    });
    const deleteTicket = plainButton("md-ticket-pane-item", "Delete ticket");
    deleteTicket.addEventListener("click", (event) => {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      closeTicketMenu();
      showConfirm(ticket.id, () => emit({ type: "ticket.delete", id: ticket.id }));
    });
    const separator = document.createElement("div");
    separator.className = "md-ticket-pane-sep";
    if (typeof separator.setAttribute === "function") separator.setAttribute("role", "separator");
    const showFields = document.createElement("label");
    showFields.className = "md-ticket-pane-group";
    showFields.textContent = "Show fields";
    menuPanel.append(copyLink, deleteTicket, separator, showFields);
    for (const [key, labelText] of [["parent", "Parent"], ["depends", "Depends"], ["children", "Children"], ["blocks", "Blocks"]]) {
      const choice = document.createElement("label");
      choice.className = "md-ticket-pane-choice";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = relationShown[key] === true;
      if (typeof box.setAttribute === "function") {
        box.setAttribute("type", "checkbox");
        box.setAttribute("data-relation", key);
      }
      box.addEventListener("change", () => {
        relationShown = { ...relationShown, [key]: box.checked === true };
        ticketMenuOpen = true;
        renderTicketForm();
      });
      choice.append(box, document.createTextNode(labelText));
      menuPanel.appendChild(choice);
    }
    menuButton.addEventListener("click", (event) => {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      ticketMenuOpen = !ticketMenuOpen;
      if (ticketMenuOpen) showElement(menuPanel);
      else hideElement(menuPanel);
      if (typeof menuButton.setAttribute === "function") {
        menuButton.setAttribute("aria-expanded", ticketMenuOpen ? "true" : "false");
      }
    });
    menuButton.addEventListener("keydown", onTicketMenuEscape);
    menuPanel.addEventListener("keydown", onTicketMenuEscape);
    rebuildingTicketForm = true;
    try {
      form.replaceChildren(fields, facts, menuButton, menuPanel);
    } finally {
      rebuildingTicketForm = false;
    }
    if (selectWidth > 0) {
      const extra = selectChromeGap(sized);
      if (extra > 0) paintSelectWidth(sized, selectWidth + extra);
    }
    if (held) restoreHeld(held);
    else if (ticket.title === "New ticket") {
      hideElement(heading);
      showElement(titleInput);
      if (typeof titleInput.focus === "function") titleInput.focus();
      selectInput(titleInput, 0, titleInput.value.length);
    }
    // The body box moves with the form. Cards were placed against the box from before this change.
    layoutComments();
  }

  function revertTicketForm() {
    if (!openTicket) return;
    renderTicketForm();
  }

  function settleTicketSet() {
    const index = conflictWaiters.indexOf("ticket");
    if (index >= 0) conflictWaiters.splice(index, 1);
  }

  function dismissTicketForm() {
    openTicket = null;
    relationTicketId = "";
    ticketMenuOpen = false;
    ticketFormKey = "";
    ticketPickers.length = 0;
    if (!ticketForm) return;
    hideElement(ticketForm);
    if (typeof ticketForm.replaceChildren === "function") ticketForm.replaceChildren();
    // Hiding the form lifts the body back up. Place the cards against that box.
    layoutComments();
  }

  function clearOpenTicket() {
    // The open ticket left the broadcast. Drop the mirror and do not ask for it again.
    dismissTicketForm();
    dropPendingEdits();
    expectNewComment = false;
    commentFocus = null;
    hashComment = null;
    pinnedComment = null;
    scrollCommentId = null;
    live = false;
    waitingForFile = true;
    openPath = "";
    dropRaw();
    clearHashForActiveRepo();
    state = createState("");
    bodyCaretReleased = false;
    sentLines = lineSet(state.anchor, state.cursor);
    outstandingLock = null;
    granted = { anchor: state.anchor, cursor: state.cursor };
    render();
    renderTicketTree();
  }

  function applyTicketList(message) {
    const incoming = Array.isArray(message.tickets) ? message.tickets : [];
    const next = [];
    for (const item of incoming) {
      const ticket = normalizeTicket(item);
      if (ticket) next.push(ticket);
    }
    ticketList = next;
    linkPresent = Array.isArray(message.present)
      ? new Set(message.present.filter((item) => typeof item === "string"))
      : null;
    const incomingInbound = Array.isArray(message.inbound) ? message.inbound : [];
    const nextInbound = [];
    for (const item of incomingInbound) {
      const row = normalizeInbound(item);
      if (row) nextInbound.push(row);
    }
    inboundList = nextInbound;
    const incomingForeign = Array.isArray(message.foreign) ? message.foreign : [];
    const nextForeign = [];
    for (const item of incomingForeign) {
      const row = normalizeForeign(item);
      if (row) nextForeign.push(row);
    }
    foreignList = nextForeign;
    if (openTicket && !ticketList.some((ticket) => ticket.id === openTicket.id)) {
      clearOpenTicket();
      return;
    }
    if (openTicket) {
      seedTicketAncestors(openTicket.id);
      renderTicketForm();
    }
    renderTicketTree();
  }

  function applyTicketNotice(message) {
    if (!openTicket || typeof message.path !== "string" || message.path !== openPath) return;
    const nextRev = Number(message.rev);
    if (Number.isFinite(nextRev)) rev = nextRev;
    const next = normalizeTicket({
      id: openTicket.id,
      title: message.title,
      state: message.state,
      type: Object.prototype.hasOwnProperty.call(message, "ticketType") ? message.ticketType : openTicket.type,
      priority: message.priority,
      assignee: message.assignee,
      parent: message.parent,
      depends: message.depends,
      reporter: message.reporter,
      created: message.created,
      rev: Number.isFinite(nextRev) ? nextRev : openTicket.rev,
    });
    if (!next) return;
    openTicket = next;
    const index = ticketList.findIndex((ticket) => ticket.id === next.id);
    if (index >= 0) ticketList[index] = { ...ticketList[index], ...next };
    settleTicketSet();
    renderTicketForm();
    renderTicketTree();
  }

  function syncFileTicket(message) {
    if (message.ticket && typeof message.ticket === "object") {
      const revField = typeof message.ticket.rev === "number" ? message.ticket.rev : message.rev;
      const next = normalizeTicket({ ...message.ticket, rev: revField });
      if (next) {
        openTicket = next;
        seedTicketAncestors(next.id);
        renderTicketForm();
        renderTicketTree();
        return;
      }
    }
    const had = openTicket != null;
    dismissTicketForm();
    if (had) renderTicketTree();
  }

  function ensureTicketForm() {
    const parent = root && root.parentElement;
    if (!parent || typeof document === "undefined" || typeof document.createElement !== "function") return;
    let form = findClassChild(parent, "ticket-form");
    if (!form) {
      form = document.createElement("div");
      form.className = "ticket-form";
      placeNodeBefore(parent, form, root);
    }
    hideElement(form);
    if (typeof form.replaceChildren === "function") form.replaceChildren();
    ticketForm = form;
    if (!ticketFocusBound && typeof form.addEventListener === "function") {
      form.addEventListener("focusin", onTicketFieldFocus, { signal: ac.signal });
      ticketFocusBound = true;
    }
  }

  function ancestorClass(node, className) {
    let current = node && node.nodeType === 1 ? node : node && node.parentElement;
    while (current && current !== ticketForm) {
      if (current.classList && current.classList.contains(className)) return current;
      current = current.parentElement;
    }
    return null;
  }

  function focusReleasesBodyCaret(node) {
    if (!ticketForm || !node || !nodeWithin(ticketForm, node)) return false;
    if (ancestorClass(node, "md-ticket-title-input")) return true;
    if (ancestorClass(node, "md-ticket-state")) return true;
    if (ancestorClass(node, "md-ticket-type")) return true;
    if (ancestorClass(node, "md-ticket-priority")) return true;
    if (ancestorClass(node, "md-ticket-assignee")) return true;
    if (ancestorClass(node, "md-ticket-parent")) return true;
    if (ancestorClass(node, "md-ticket-depends")) return true;
    return false;
  }

  function onTicketFieldFocus(event) {
    if (!focusReleasesBodyCaret(event && event.target)) return;
    dismissBodyCaret();
  }

  function clearTicketBinding(binding) {
    if (!binding) return;
    if (binding.button && binding.onClick && typeof binding.button.removeEventListener === "function") {
      binding.button.removeEventListener("click", binding.onClick);
    }
    if (binding.field && binding.onKey && typeof binding.field.removeEventListener === "function") {
      binding.field.removeEventListener("keydown", binding.onKey);
    }
    if (binding.filterButton && binding.onFilter && typeof binding.filterButton.removeEventListener === "function") {
      binding.filterButton.removeEventListener("click", binding.onFilter);
    }
    if (binding.onChange) {
      for (const box of binding.boxes || []) {
        if (box && typeof box.removeEventListener === "function") box.removeEventListener("change", binding.onChange);
      }
    }
    if (binding.showAll && binding.onShowAll && typeof binding.showAll.removeEventListener === "function") {
      binding.showAll.removeEventListener("click", binding.onShowAll);
    }
  }

  function unbindTickets() {
    releaseTicketDrawer();
    if (ticketChrome) {
      const binding = ticketBindings.get(ticketChrome.button);
      if (binding && binding.onClick === ticketChrome.onClick) {
        clearTicketBinding(binding);
        ticketBindings.delete(binding.button);
      }
      ticketChrome = null;
    }
    if (ticketForm) {
      hideElement(ticketForm);
      ticketFormKey = "";
      if (typeof ticketForm.replaceChildren === "function") ticketForm.replaceChildren();
    }
    const tree = findTicketTree(filesNav());
    if (tree && typeof tree.replaceChildren === "function") tree.replaceChildren();
  }

  function bindTicketChrome(nav) {
    if (!nav || typeof document === "undefined" || typeof document.createElement !== "function") return;
    detachClass(nav, "md-ticket-label");
    detachClass(nav, "md-show-closed");
    detachClass(nav, "md-show-closed-label");
    let block = findClassChild(nav, "ticket-block");
    if (!block) {
      block = document.createElement("div");
      block.className = "ticket-block";
      nav.appendChild(block);
    }
    const { head, heading } = ensurePaneHead(block, "Tickets");
    const button = ensureNavButton(nav, "md-new-ticket", "+");
    placeAfter(head, heading, button);
    const filterButton = ensureFilterButton(nav);
    placeAfter(head, button, filterButton);
    let menu = findClassChild(block, "md-ticket-filter-menu");
    if (!menu) {
      menu = document.createElement("div");
      menu.className = "md-ticket-filter-menu";
    }
    placeAfter(block, head, menu);
    buildFilterMenu(menu);
    applyFilterDefaults(menu);
    hideElement(menu);
    const showAll = findClassChild(menu, "md-ticket-filter-all");
    detachClass(nav, "md-new-ticket-name");
    let drawer = findClassChild(block, "md-ticket-drawer");
    if (!drawer) {
      drawer = document.createElement("div");
      drawer.className = "md-ticket-drawer";
    }
    showElement(drawer);
    placeAfter(block, menu, drawer);
    let tree = findClassChild(drawer, "ticket-tree") || findClassChild(block, "ticket-tree") || findDeep(nav, "ticket-tree");
    if (!tree) {
      tree = document.createElement("div");
      tree.className = "ticket-tree";
    }
    if (tree.parentElement !== drawer) {
      detachNode(tree);
      drawer.appendChild(tree);
    }
    const columns = syncTicketColumns(tree);
    if (columns && columns.parentElement !== tree) placeFirst(tree, columns);
    bindTicketDrawer(block);
    const previous = ticketBindings.get(button);
    clearTicketBinding(previous);
    const onClick = (event) => {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      emit({ type: "ticket.create", title: "New ticket" });
    };
    const onFilter = (event) => {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      if (menu.hidden) showElement(menu);
      else hideElement(menu);
    };
    const onChange = () => {
      renderTicketTree();
    };
    const onShowAll = (event) => {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      for (const box of filterBoxes(menu)) box.checked = true;
      renderTicketTree();
    };
    const boxes = filterBoxes(menu);
    button.addEventListener("click", onClick);
    filterButton.addEventListener("click", onFilter);
    for (const box of boxes) box.addEventListener("change", onChange);
    if (showAll && typeof showAll.addEventListener === "function") showAll.addEventListener("click", onShowAll);
    const binding = { button, onClick, filterButton, filterMenu: menu, onFilter, boxes, onChange, showAll, onShowAll };
    ticketBindings.set(button, binding);
    ticketChrome = binding;
    // The filter sits on every document. A ticket picker does not, so the outside press is bound here.
    bindTicketPointer();
  }

  let newFileButton = null;
  let newFileOnClick = null;

  function hideNameField(field) {
    field.hidden = true;
    if (typeof field.setAttribute === "function") field.setAttribute("hidden", "");
  }

  function fileDrawerEl() {
    return findClassChild(fileBlockEl, "md-file-drawer");
  }

  // A pointer that slips off and comes back inside 200ms keeps the wide list.
  function scheduleHideFileDrawer() {
    if (fileDrawerTimer != null) clearTimeout(fileDrawerTimer);
    fileDrawerTimer = setTimeout(() => {
      fileDrawerTimer = null;
      const panel = fileDrawerEl();
      if (!panel) return;
      // The class has to stay until the width eases back, or the stylesheet transition never runs.
      if (!fileDrawerCompact) {
        if (panel.classList) panel.classList.remove("md-file-wide");
        setStyle(panel, "width", "");
        setStyle(panel, "transition", "");
        return;
      }
      setStyle(panel, "width", fileDrawerCompact);
      fileDrawerTimer = setTimeout(() => {
        fileDrawerTimer = null;
        if (panel.classList) panel.classList.remove("md-file-wide");
        setStyle(panel, "width", "");
        setStyle(panel, "transition", "");
      }, 500);
    }, 200);
  }

  function releaseFileDrawer() {
    if (fileDrawerTimer != null) {
      clearTimeout(fileDrawerTimer);
      fileDrawerTimer = null;
    }
    if (fileBlockEl && typeof fileBlockEl.removeEventListener === "function") {
      if (fileDrawerEnter) fileBlockEl.removeEventListener("pointerenter", fileDrawerEnter);
      if (fileDrawerLeave) fileBlockEl.removeEventListener("pointerleave", fileDrawerLeave);
    }
    fileBlockEl = null;
    fileDrawerEnter = null;
    fileDrawerLeave = null;
  }

  function bindFileDrawer(block) {
    if (!block) return;
    if (fileBlockEl === block && fileDrawerEnter) return;
    releaseFileDrawer();
    fileDrawerEnter = () => {
      if (fileDrawerTimer != null) {
        clearTimeout(fileDrawerTimer);
        fileDrawerTimer = null;
      }
      const panel = fileDrawerEl();
      if (!panel) return;
      const alreadyWide = Boolean(panel.classList && panel.classList.contains("md-file-wide"));
      if (alreadyWide) {
        setStyle(panel, "width", fileDrawerWide);
        return;
      }
      // The head stays in the column. Commit the panel's compact width with the
      // transition off, then ease. Top, height, and left stay put.
      const rect = typeof panel.getBoundingClientRect === "function" ? panel.getBoundingClientRect() : null;
      const width = `${filePaneWidth(panel, rect)}px`;
      fileDrawerCompact = rect && typeof rect.width === "number" && Number.isFinite(rect.width) ? `${rect.width}px` : "";
      fileDrawerWide = width;
      setStyle(panel, "transition", "none");
      if (rect && typeof rect.width === "number" && Number.isFinite(rect.width)) setStyle(panel, "width", `${rect.width}px`);
      if (panel.classList) panel.classList.add("md-file-wide");
      void panel.offsetWidth;
      setStyle(panel, "transition", "");
      setStyle(panel, "width", width);
    };
    fileDrawerLeave = () => {
      scheduleHideFileDrawer();
    };
    fileBlockEl = block;
    if (typeof block.addEventListener === "function") {
      block.addEventListener("pointerenter", fileDrawerEnter);
      block.addEventListener("pointerleave", fileDrawerLeave);
    }
  }

  function unbindNewFile() {
    releaseFileDrawer();
    if (!newFileButton || !newFileOnClick) return;
    const binding = newFileBindings.get(newFileButton);
    if (!binding || binding.onClick !== newFileOnClick) return;
    if (typeof newFileButton.removeEventListener === "function") {
      newFileButton.removeEventListener("click", binding.onClick);
    }
    if (binding.field && typeof binding.field.removeEventListener === "function") {
      binding.field.removeEventListener("keydown", binding.onKey);
    }
    if (binding.deleteButton && binding.onDelete && typeof binding.deleteButton.removeEventListener === "function") {
      binding.deleteButton.removeEventListener("click", binding.onDelete);
    }
    newFileBindings.delete(newFileButton);
  }

  function bindNewFile(nav) {
    if (!nav || typeof document === "undefined" || typeof document.createElement !== "function") return;
    const block = ensureFileBlock(nav);
    const { head, heading } = ensurePaneHead(block, "Files");
    const button = ensureNavButton(nav, "md-new-file", "+");
    placeAfter(head, heading, button);
    let remove = findClassChild(head, "md-file-delete");
    if (!remove) {
      remove = document.createElement("button");
      remove.type = "button";
      remove.className = "icon-btn danger md-file-delete";
      if (typeof remove.setAttribute === "function") {
        remove.setAttribute("type", "button");
        remove.setAttribute("aria-label", "Delete file");
        remove.setAttribute("title", "Delete file");
      }
      const icon = strokeIcon(ICON_PATHS.delete[0]);
      if (icon) remove.appendChild(icon);
    }
    placeAfter(head, button, remove);
    let field = findDeep(nav, "md-new-name");
    if (!field) {
      field = document.createElement("input");
      field.type = "text";
      field.className = "md-new-name";
      field.value = "";
      if (typeof field.setAttribute === "function") field.setAttribute("type", "text");
      hideNameField(field);
    }
    placeAfter(block, head, field);
    const previous = newFileBindings.get(button);
    if (previous && typeof button.removeEventListener === "function") {
      button.removeEventListener("click", previous.onClick);
    }
    if (previous && previous.field && typeof previous.field.removeEventListener === "function") {
      previous.field.removeEventListener("keydown", previous.onKey);
    }
    if (previous && previous.deleteButton && previous.onDelete && typeof previous.deleteButton.removeEventListener === "function") {
      previous.deleteButton.removeEventListener("click", previous.onDelete);
    }
    const onClick = (event) => {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      field.hidden = false;
      if (typeof field.removeAttribute === "function") field.removeAttribute("hidden");
      if (typeof field.focus === "function") field.focus();
    };
    const onKey = (event) => {
      if (!event) return;
      if (event.key === "Escape") {
        if (typeof event.preventDefault === "function") event.preventDefault();
        field.value = "";
        hideNameField(field);
        return;
      }
      if (event.key !== "Enter") return;
      if (typeof event.preventDefault === "function") event.preventDefault();
      const path = createPath(field.value);
      if (!path) return;
      field.value = "";
      hideNameField(field);
      emit({ type: "create", path });
    };
    const onDelete = (event) => {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      if (!openPath || openPath.startsWith("tickets/")) return;
      const path = openPath;
      showConfirm(pathBase(path), () => emit({ type: "delete", path }));
    };
    button.addEventListener("click", onClick);
    field.addEventListener("keydown", onKey);
    if (typeof remove.addEventListener === "function") remove.addEventListener("click", onDelete);
    newFileBindings.set(button, { onClick, onKey, field, deleteButton: remove, onDelete });
    newFileButton = button;
    newFileOnClick = onClick;
    bindFileDrawer(block);
  }

  function readStoredRepo() {
    if (!repoStorage || typeof repoStorage.getItem !== "function") return "";
    const raw = repoStorage.getItem(REPO_KEY);
    return typeof raw === "string" ? raw : "";
  }

  function writeStoredRepo(name) {
    if (!repoStorage || typeof repoStorage.setItem !== "function") return;
    repoStorage.setItem(REPO_KEY, name);
  }

  function deleteStoredRepo() {
    if (!repoStorage || typeof repoStorage.removeItem !== "function") return;
    repoStorage.removeItem(REPO_KEY);
  }

  function blankEditor() {
    // The next file has not arrived. Drop the previous mirror before asking.
    dropPendingEdits();
    clearRefusal();
    conflictWaiters.length = 0;
    fileWaiters.length = 0;
    expectNewComment = false;
    commentFocus = null;
    currentCommentId = null;
    hashComment = null;
    pinnedComment = null;
    scrollCommentId = null;
    unsavedThreads.clear();
    replyDrafts.clear();
    noteDrafts.clear();
    editingNotes.clear();
    live = false;
    waitingForFile = false;
    openPath = "";
    dropRaw();
    rev = 0;
    lockTable = [];
    openDirs.clear();
    expandedTickets.clear();
    fileList = [];
    fileTitles = null;
    draggedMove = null;
    ticketList = [];
    inboundList = [];
    foreignList = [];
    linkPresent = null;
    state = createState("");
    bodyCaretReleased = false;
    sentLines = lineSet(state.anchor, state.cursor);
    outstandingLock = null;
    granted = { anchor: state.anchor, cursor: state.cursor };
    dismissTicketForm();
    const nav = filesNav();
    const files = fileTreeNode();
    if (files && typeof files.replaceChildren === "function") files.replaceChildren();
    const tickets = findTicketTree(nav);
    if (tickets && typeof tickets.replaceChildren === "function") tickets.replaceChildren();
    render();
  }

  function sendRepoFrames(name) {
    emit({ type: "repo", name });
    emit({ type: "list" });
    emit({ type: "tickets" });
  }

  function hashForEntry() {
    if (!activeRepo || !openPath) return "";
    const ticketId = ticketIdFromPath(openPath);
    if (ticketId) return formatHash({ repo: activeRepo, kind: "ticket", id: ticketId });
    return formatHash({ repo: activeRepo, kind: "doc", path: openPath });
  }

  function hashForOpen() {
    if (pinnedComment && pinnedComment.path === openPath && pinnedComment.id) {
      const hash = formatHash({ repo: activeRepo, kind: "comment", path: openPath, id: pinnedComment.id });
      if (hash) return hash;
    }
    return hashForEntry();
  }

  function writeBrowserHash(hash) {
    // The value we just wrote is not a navigation. A later hashchange for it must not open again.
    suppressHash = hash;
    appliedHash = hash;
    const loc = readLocation();
    const history = globalThis.history;
    const pathname = loc && typeof loc.pathname === "string" ? loc.pathname : "";
    const search = loc && typeof loc.search === "string" ? loc.search : "";
    const url = pathname ? `${pathname}${search}${hash}` : hash;
    writingHash = true;
    try {
      if (history && typeof history.replaceState === "function") {
        try {
          history.replaceState(null, "", url);
        } catch {
          // A missing session history still leaves the hash for the next read.
        }
      }
      // replaceState updates a real Location. Assigning it would fire hashchange.
      if (loc && typeof loc === "object" && typeof loc.assign !== "function") loc.hash = hash;
    } finally {
      writingHash = false;
    }
  }

  function publishHash() {
    if (closed || !activeRepo || !openPath) return;
    const next = hashForOpen();
    if (!next) return;
    if (readHash() === next) {
      suppressHash = next;
      appliedHash = next;
      return;
    }
    writeBrowserHash(next);
  }

  function clearHashForActiveRepo() {
    const parsed = parseHash(readHash());
    if (!parsed || parsed.repo !== activeRepo) return;
    writeBrowserHash("");
  }

  function hashSelection(names) {
    if (pendingHash && names.has(pendingHash.repo)) return pendingHash.repo;
    const hash = readHash();
    if (!hash || hash === suppressHash) return "";
    const parsed = parseHash(hash);
    if (!parsed || !names.has(parsed.repo)) return "";
    return parsed.repo;
  }

  function copyCommentLink(id) {
    if (!activeRepo || !openPath || !id) return;
    const hash = formatHash({ repo: activeRepo, kind: "comment", path: openPath, id });
    if (!hash) return;
    writeClipboard(absoluteHash(hash));
  }

  function copyEntryLink() {
    const hash = hashForEntry();
    if (!hash) return;
    writeClipboard(absoluteHash(hash));
  }

  function focusHashedComment(path, text) {
    if (!hashComment) return;
    if (path !== hashComment.path) {
      hashComment = null;
      return;
    }
    const id = hashComment.id;
    hashComment = null;
    const thread = commentThreads(typeof text === "string" ? text : "").find((item) => item && item.id === id);
    if (thread && thread.resolved) showResolved = true;
    currentCommentId = id;
    scrollCommentId = id;
  }

  function hashTargetOpen(parsed) {
    if (!parsed) return false;
    if (parsed.kind === "ticket") return openPath === `tickets/${parsed.id}.md`;
    if (parsed.kind === "doc") return openPath === parsed.path && !pinnedComment;
    if (parsed.kind === "comment") {
      return openPath === parsed.path && !!pinnedComment && pinnedComment.id === parsed.id && pinnedComment.path === parsed.path;
    }
    return false;
  }

  function openDocument(path, commentId, ticket) {
    if (closed || typeof path !== "string" || path === "") return;
    const comment = typeof commentId === "string" && commentId ? commentId : "";
    const same = openPath === path && live && !waitingForFile;
    if (comment) {
      hashComment = { path, id: comment };
      pinnedComment = { path, id: comment };
    } else {
      hashComment = null;
      pinnedComment = null;
    }
    if (same) {
      if (comment) {
        const thread = commentThreads(state.doc).find((item) => item && item.id === comment);
        if (thread && thread.resolved) showResolved = true;
        currentCommentId = comment;
        scrollCommentId = comment;
        render();
      }
      publishHash();
      syncEntryLink();
      return;
    }
    followCaret = null;
    followPath = false;
    openPath = path;
    if (ticket) {
      const id = ticketIdFromPath(path);
      if (id) seedTicketAncestors(id);
    } else seedOpen(path);
    waitingForFile = true;
    emit({ type: "open", path });
    if (ticket) {
      markOpenTicket();
      showTicketDrawer();
    }
    publishHash();
    syncEntryLink();
  }

  function openParsed(parsed) {
    if (!parsed || parsed.repo !== activeRepo) return;
    if (parsed.kind === "ticket") {
      openDocument(`tickets/${parsed.id}.md`, null, true);
      return;
    }
    if (parsed.kind === "doc") {
      openDocument(parsed.path, null, false);
      return;
    }
    if (parsed.kind === "comment") openDocument(parsed.path, parsed.id, false);
  }

  function activateHash(parsed) {
    if (closed || !parsed) return;
    if (sawRepos && !repoNames.has(parsed.repo)) return;
    const hash = formatHash(parsed);
    if (!sawRepos) {
      pendingHash = parsed;
      return;
    }
    if (hash && hash === appliedHash && hashTargetOpen(parsed)) return;
    if (hash) appliedHash = hash;
    if (parsed.repo !== activeRepo) {
      pendingHash = parsed;
      chooseRepo(parsed.repo);
      return;
    }
    openParsed(parsed);
  }

  function onHashChange() {
    if (writingHash || closed) return;
    const hash = readHash();
    if (!hash || hash === suppressHash) return;
    const parsed = parseHash(hash);
    if (!parsed) return;
    if (!sawRepos || !repoNames.has(parsed.repo)) {
      pendingHash = parsed;
      return;
    }
    if (hash === appliedHash && hashTargetOpen(parsed)) return;
    appliedHash = hash;
    if (parsed.repo !== activeRepo) {
      pendingHash = parsed;
      chooseRepo(parsed.repo);
      return;
    }
    openParsed(parsed);
  }

  function followArrivedHash() {
    if (pendingHash) {
      if (repoNames.has(pendingHash.repo)) {
        const parsed = pendingHash;
        pendingHash = null;
        if (parsed.repo !== activeRepo) {
          pendingHash = parsed;
          chooseRepo(parsed.repo);
          return;
        }
        openParsed(parsed);
        return;
      }
      pendingHash = null;
    }
    const hash = readHash();
    if (!hash || hash === suppressHash || hash === appliedHash) return;
    const parsed = parseHash(hash);
    if (!parsed || !repoNames.has(parsed.repo)) return;
    if (parsed.repo !== activeRepo) {
      pendingHash = parsed;
      chooseRepo(parsed.repo);
      return;
    }
    openParsed(parsed);
  }

  function chooseRepo(name) {
    if (typeof name !== "string" || name === "" || name === activeRepo) return;
    const follow = pendingHash && pendingHash.repo === name ? pendingHash : null;
    pendingHash = null;
    if (!follow) clearHashForActiveRepo();
    writeStoredRepo(name);
    activeRepo = name;
    blankEditor();
    if (repoSelect) markRepoSelected(repoSelect, name);
    syncRepoCommit();
    sendRepoFrames(name);
    if (follow) openParsed(follow);
  }

  function markRepoSelected(select, name) {
    let index = -1;
    let at = 0;
    for (const option of select.childNodes || []) {
      if (!option || option.nodeType !== 1) continue;
      const on = option.value === name;
      option.selected = on;
      if (on) {
        index = at;
        if (typeof option.setAttribute === "function") option.setAttribute("selected", "");
      } else if (typeof option.removeAttribute === "function") {
        option.removeAttribute("selected");
      }
      at += 1;
    }
    select.value = name;
    if (index >= 0) select.selectedIndex = index;
  }

  function clearRepoSelection(select) {
    // selectedIndex -1 still paints the first option, so the blank option has to be chosen.
    markRepoSelected(select, "");
  }

  // A stored name is requested once. A later catalog that still lists it does not ask again.
  function applyRepos(message) {
    const select = repoSelect || findDeep(filesNav(), "md-repo");
    if (!select || typeof document === "undefined" || typeof document.createElement !== "function") return;
    const incoming = Array.isArray(message.repos) ? message.repos : [];
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "";
    const options = [blank];
    const names = new Set();
    for (const repo of incoming) {
      if (!repo || typeof repo.name !== "string" || repo.name === "") continue;
      const option = document.createElement("option");
      option.value = repo.name;
      option.textContent = typeof repo.description === "string" ? repo.description : "";
      options.push(option);
      names.add(repo.name);
    }
    if (typeof select.replaceChildren === "function") select.replaceChildren(...options);
    repoNames = names;
    sawRepos = true;
    if (activeRepo && !names.has(activeRepo)) {
      clearHashForActiveRepo();
      blankEditor();
      deleteStoredRepo();
      activeRepo = "";
      clearRepoSelection(select);
      syncRepoCommit();
    }
    if (!activeRepo) {
      const stored = readStoredRepo();
      const pick = hashSelection(names) || (stored && names.has(stored) ? stored : "");
      if (pick) {
        markRepoSelected(select, pick);
        activeRepo = pick;
        if (pick !== stored) writeStoredRepo(pick);
        syncRepoCommit();
        sendRepoFrames(pick);
      } else {
        if (stored) deleteStoredRepo();
        clearRepoSelection(select);
        syncRepoCommit();
      }
    } else {
      markRepoSelected(select, activeRepo);
      syncRepoCommit();
    }
    followArrivedHash();
  }

  function unbindRepoSelect() {
    if (!repoSelect || !repoOnChange) return;
    const binding = repoBindings.get(repoSelect);
    if (!binding || binding.onChange !== repoOnChange) return;
    if (typeof repoSelect.removeEventListener === "function") {
      repoSelect.removeEventListener("change", repoOnChange);
    }
    repoBindings.delete(repoSelect);
    repoSelect = null;
    repoOnChange = null;
  }

  function syncRepoCommit() {
    syncEntryLink();
  }

  function syncEntryLink() {
    const open = activeRepo && openPath;
    if (docLinkButton) {
      if (open) showElement(docLinkButton);
      else hideElement(docLinkButton);
    }
  }

  function unbindDocMenu() {
    if (docLinkButton && docLinkOnClick) {
      const binding = docLinkBindings.get(docLinkButton);
      if (binding === docLinkOnClick && typeof docLinkButton.removeEventListener === "function") {
        docLinkButton.removeEventListener("click", docLinkOnClick);
      }
      if (binding === docLinkOnClick) docLinkBindings.delete(docLinkButton);
    }
    if (docAttachInput && docAttachOnChange && typeof docAttachInput.removeEventListener === "function") {
      docAttachInput.removeEventListener("change", docAttachOnChange);
    }
    docLinkOnClick = null;
    docAttachOnChange = null;
    docMenuBound = false;
  }

  function ensureDocMenu() {
    if (!commentsAside || typeof document === "undefined" || typeof document.createElement !== "function") return;
    if (!docAttachInput || docAttachInput.parentElement !== commentsAside) {
      docAttachInput = findClassChild(commentsAside, "md-attach-input");
    }
    if (!docAttachInput) {
      const input = document.createElement("input");
      input.className = "md-attach-input";
      if (typeof input.setAttribute === "function") {
        input.setAttribute("type", "file");
        input.setAttribute("accept", "image/png,image/jpeg,image/gif,image/webp");
      }
      hideElement(input);
      commentsAside.appendChild(input);
      docAttachInput = input;
    }
    if (!docMenuBound) {
      docAttachOnChange = () => {
        const input = docAttachInput;
        const file = input && input.files && input.files[0];
        if (input) input.value = "";
        if (!file || typeof file.arrayBuffer !== "function") return;
        Promise.resolve(file.arrayBuffer()).then((buf) => {
          if (closed) return;
          sendImage(new Uint8Array(buf));
        }).catch(() => {
          if (!closed) showNotice("not an image");
        });
      };
      if (docAttachInput && typeof docAttachInput.addEventListener === "function") {
        docAttachInput.addEventListener("change", docAttachOnChange);
      }
      docMenuBound = true;
    }
    syncRepoCommit();
  }

  function bindRepoSelect(nav) {
    if (!nav || typeof document === "undefined" || typeof document.createElement !== "function") return;
    // The select sits in the row after the label, so a direct-child search misses it.
    let select = findDeep(nav, "md-repo");
    if (!select) {
      select = document.createElement("select");
      select.className = "md-repo";
    }
    let row = findClassChild(nav, "md-repo-row");
    if (!row) {
      row = document.createElement("div");
      row.className = "md-repo-row";
    }
    placeFirst(nav, row);
    let label = null;
    for (const child of row.childNodes || []) {
      if (child && child.nodeType === 1 && String(child.tagName || "").toUpperCase() === "LABEL") {
        label = child;
        break;
      }
    }
    if (!label) {
      label = document.createElement("label");
      label.appendChild(document.createTextNode("Repo"));
    } else if (label.textContent !== "Repo") {
      label.textContent = "Repo";
    }
    placeFirst(row, label);
    placeAfter(row, label, select);
    const previous = repoBindings.get(select);
    if (previous && typeof select.removeEventListener === "function") {
      select.removeEventListener("change", previous.onChange);
    }
    const onChange = () => chooseRepo(select.value);
    if (typeof select.addEventListener === "function") select.addEventListener("change", onChange);
    repoBindings.set(select, { onChange });
    repoSelect = select;
    repoOnChange = onChange;
  }

  bindRepoSelect(filesNav());
  bindNewFile(filesNav());
  renderFileTree(fileList, false);
  bindTicketChrome(filesNav());
  ensureTicketForm();

  if (active && typeof active.subscribe === "function") {
    unsubscribe = active.subscribe((message) => onMessage(message));
  }

  render();

  return {
    getState() {
      return state;
    },
    focus() {
      commentFocus = null;
      const released = bodyCaretReleased;
      bodyCaretReleased = false;
      root.focus();
      placeCaret();
      if (released) claimLines(state.anchor, state.cursor);
    },
    moveCaret(direction, granularity, extend) {
      moveCaret(direction, granularity, extend);
    },
    destroy() {
      closed = true;
      const view = typeof window !== "undefined" ? window : null;
      if (pictureLayoutFrame && view && typeof view.cancelAnimationFrame === "function") {
        view.cancelAnimationFrame(pictureLayoutFrame);
      }
      pictureLayoutFrame = 0;
      if (pictureObserver) {
        pictureObserver.disconnect();
        pictureObserver = null;
      }
      vimPaintHold = null;
      closeVimLine();
      clearVimMatches();
      hideVimBlockMark();
      cancelGestureRender();
      clearEditTimer();
      clearRefusal();
      if (noticeTimer != null) {
        clearTimeout(noticeTimer);
        noticeTimer = null;
      }
      if (noticeEl && noticeEl.parentElement && typeof noticeEl.parentElement.removeChild === "function") {
        noticeEl.parentElement.removeChild(noticeEl);
      }
      noticeEl = null;
      unsubscribe();
      unbindRepoSelect();
      unbindDocMenu();
      unbindNewFile();
      unbindTickets();
      unbindTreeDrop();
      if (fileMenu) detachNode(fileMenu);
      fileMenu = null;
      fileMenuPathEl = null;
      fileMenuPath = "";
      if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
        document.removeEventListener("selectionchange", onSelectionChange);
      }
      ac.abort();
      if (addCommentButton && addCommentButton.parentElement && typeof addCommentButton.parentElement.removeChild === "function") {
        addCommentButton.parentElement.removeChild(addCommentButton);
      }
    },
  };
}

const loginBindings = new WeakMap();

// Hub hello rejects an empty name and any NUL, CR, LF, "<", or ">".
function usernameAccepted(name) {
  return typeof name === "string" && name.length > 0 && !/[\0\r\n<>]/.test(name);
}

function findElement(node, pred) {
  for (const child of (node && node.childNodes) || []) {
    if (!child || child.nodeType !== 1) continue;
    if (pred(child)) return child;
    const nested = findElement(child, pred);
    if (nested) return nested;
  }
  return null;
}

function findLoginDialog(doc) {
  const body = doc && doc.body;
  if (!body || !body.childNodes) return null;
  for (const child of body.childNodes) {
    if (!child || child.nodeType !== 1 || !child.classList) continue;
    if (String(child.tagName || "").toUpperCase() !== "DIALOG") continue;
    if (child.classList.contains("md-login")) return child;
  }
  return null;
}

function buildLoginDialog(doc) {
  const dialog = doc.createElement("dialog");
  dialog.className = "md-login";
  const form = doc.createElement("form");
  const label = doc.createElement("label");
  // textContent replaces children, so the label text is a node before the input.
  label.appendChild(doc.createTextNode("Username"));
  const input = doc.createElement("input");
  input.className = "md-login-name";
  input.name = "username";
  input.placeholder = "Username";
  input.autocomplete = "username";
  if (typeof input.setAttribute === "function") {
    input.setAttribute("name", "username");
    input.setAttribute("autocomplete", "username");
    input.setAttribute("placeholder", "Username");
  }
  label.appendChild(input);
  const button = doc.createElement("button");
  button.type = "submit";
  button.textContent = "Continue";
  if (typeof button.setAttribute === "function") button.setAttribute("type", "submit");
  form.appendChild(label);
  form.appendChild(button);
  dialog.appendChild(form);
  doc.body.appendChild(dialog);
  return dialog;
}

function showLogin(dialog, input) {
  dialog.open = true;
  if (typeof dialog.showModal === "function") {
    try {
      dialog.showModal();
    } catch {
      // The open property is non-modal, and showModal throws while the dialog is open.
      // Only a modal dialog paints ::backdrop.
      if (typeof dialog.close === "function") dialog.close();
      try {
        dialog.showModal();
      } catch {
        dialog.open = true;
      }
    }
  } else if (typeof dialog.setAttribute === "function") {
    dialog.setAttribute("open", "");
  }
  if (input && typeof input.focus === "function") input.focus();
}

function dismissLogin(dialog, input, blur) {
  // close() leaves the top layer only while the dialog is still open.
  // Clearing open first keeps the backdrop, which then eats clicks.
  if (typeof dialog.close === "function") dialog.close();
  else {
    dialog.open = false;
    if (typeof dialog.removeAttribute === "function") dialog.removeAttribute("open");
  }
  if (blur && input && typeof input.blur === "function") input.blur();
}

function bindLogin(dialog, form, input, storage, connect) {
  const onSubmit = (event) => {
    if (event && typeof event.preventDefault === "function") event.preventDefault();
    const name = String(input && input.value != null ? input.value : "").trim();
    if (!usernameAccepted(name)) return;
    if (storage && typeof storage.setItem === "function") storage.setItem("viewmark.username", name);
    dismissLogin(dialog, input, true);
    connect(name);
  };
  const onCancel = (event) => {
    if (event && typeof event.preventDefault === "function") event.preventDefault();
  };
  const onKey = (event) => {
    if (!event || event.key !== "Escape") return;
    if (typeof event.preventDefault === "function") event.preventDefault();
  };
  const previous = loginBindings.get(dialog);
  if (previous) {
    if (previous.form && typeof previous.form.removeEventListener === "function") {
      previous.form.removeEventListener("submit", previous.onSubmit);
    }
    if (typeof dialog.removeEventListener === "function") {
      dialog.removeEventListener("cancel", previous.onCancel);
      dialog.removeEventListener("keydown", previous.onKey);
    }
  }
  if (form && typeof form.addEventListener === "function") form.addEventListener("submit", onSubmit);
  if (typeof dialog.addEventListener === "function") {
    dialog.addEventListener("cancel", onCancel);
    dialog.addEventListener("keydown", onKey);
  }
  loginBindings.set(dialog, { form, onSubmit, onCancel, onKey });
}

const SESSION_TOKEN = /^[A-Za-z0-9_-]{1,80}$/;
const SESSION_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function mintSessionToken() {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") return cryptoObj.randomUUID();
  let token = "";
  for (let i = 0; i < 32; i += 1) token += SESSION_ALPHABET[Math.floor(Math.random() * SESSION_ALPHABET.length)];
  return token;
}

// One token for this page. Every hello of its transport carries it, including after a drop.
function storedSession(storage) {
  const key = "viewmark.session";
  let current = "";
  if (storage && typeof storage.getItem === "function") {
    const raw = storage.getItem(key);
    if (typeof raw === "string") current = raw;
  }
  if (!SESSION_TOKEN.test(current)) {
    current = mintSessionToken();
    if (storage && typeof storage.setItem === "function") storage.setItem(key, current);
  }
  return current;
}

export function startPage(env = {}) {
  const doc = env.document || globalThis.document;
  if (!doc || typeof doc.getElementById !== "function") return null;
  const root = doc.getElementById("editor");
  if (!root) return null;
  const storage = env.sessionStorage || globalThis.sessionStorage;
  let current = null;

  function shutdown() {
    if (!current) return;
    current.editor.destroy();
    if (typeof current.transport.close === "function") current.transport.close();
    current = null;
  }

  function connect(username) {
    shutdown();
    const transport = createSocketTransport({
      username,
      session: storedSession(storage),
      socketFactory: env.socketFactory,
      location: env.location || globalThis.location,
    });
    // A move inside a held span sends no lock, so the hub still has the caret from
    // the span claim. The same text on the same path keeps this page's caret. Text
    // that changed while the socket was down takes the caret the hub sent. A new
    // path with no caret is an offset in the text, kept by the editor.
    let editor = null;
    let shownPath = "";
    const send = transport.send.bind(transport);
    transport.send = (message) => {
      if (message && message.type === "open" && typeof message.path === "string" && message.path !== shownPath) shownPath = "";
      return send(message);
    };
    const subscribe = transport.subscribe.bind(transport);
    transport.subscribe = (fn) => subscribe((message) => {
      let next = message;
      if (
        editor &&
        next &&
        next.type === "file" &&
        shownPath &&
        (typeof next.path !== "string" || next.path === shownPath) &&
        typeof next.text === "string" &&
        next.text === editor.getState().doc
      ) {
        const state = editor.getState();
        next = { ...next, cursor: state.cursor, anchor: state.anchor };
      }
      if (next && next.type === "file" && typeof next.path === "string") shownPath = next.path;
      fn(next);
    });
    editor = createEditor(root, "", 0, transport, storage);
    current = { transport, editor, username };
  }

  let dialog = findLoginDialog(doc);
  if (!dialog && doc.body && typeof doc.createElement === "function" && typeof doc.createTextNode === "function") {
    dialog = buildLoginDialog(doc);
  }
  const input = dialog && findElement(dialog, (node) => {
    return String(node.tagName || "").toUpperCase() === "INPUT" && node.classList && node.classList.contains("md-login-name");
  });
  const form = dialog && findElement(dialog, (node) => String(node.tagName || "").toUpperCase() === "FORM");
  if (dialog) bindLogin(dialog, form, input, storage, connect);

  let stored = "";
  if (storage && typeof storage.getItem === "function") {
    const raw = storage.getItem("viewmark.username");
    if (typeof raw === "string") stored = raw.trim();
  }
  if (usernameAccepted(stored)) {
    if (storage && typeof storage.setItem === "function") storage.setItem("viewmark.username", stored);
    if (dialog) dismissLogin(dialog, input, false);
    connect(stored);
  } else if (dialog) {
    showLogin(dialog, input);
  }
  return { close: shutdown };
}

function boot() {
  startPage();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
}
