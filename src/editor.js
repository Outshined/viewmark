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
  moveCommentMarker,
  commentThreads,
  parseCommentNotes,
  splitCommentNote,
  orderVisibleComments,
  lineIndexAt,
  lockIndexAt,
  lockSpans,
  skipHidden,
  enterInsert,
  enterBreak,
  lineCaret,
} from "./doc.js";
import { createMemoryTransport, createSocketTransport } from "./session.js";
import { TICKET_PRIORITIES, TICKET_STATES, TICKET_TYPES } from "./ticket.js";
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
export function plan(doc, cursor) {
  return documentPlan(doc, cursor);
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
      button.setAttribute("aria-label", className === "md-new-file" ? "New file" : "New ticket");
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
  }
  const svg = iconSvg(action);
  if (svg) button.appendChild(svg);
  return button;
}

const newFileBindings = new WeakMap();
const ticketBindings = new WeakMap();
const repoBindings = new WeakMap();
const docMenuBindings = new WeakMap();
const docCommitBindings = new WeakMap();
const docLinkBindings = new WeakMap();
const docAttachBindings = new WeakMap();
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

function renderRun(part) {
  const marker = renderCommentMarker(part);
  if (marker) return marker;
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

// https stays an address. A data URL is not a file, so it is not requested.
function imageSrc(url, repo) {
  if (typeof url !== "string" || url.length === 0) return "";
  if (url.startsWith("https://") || url.startsWith("http://")) return url;
  if (url.startsWith("data:")) return "";
  if (!repo) return url;
  const parts = url.split("/").filter((part) => part.length > 0).map((part) => encodeURIComponent(part));
  return `/raw/${encodeURIComponent(repo)}/${parts.join("/")}`;
}

function renderImage(image, repo) {
  const el = document.createElement("span");
  el.className = image.comment ? "md-atom md-image md-comment" : "md-atom md-image";
  el.contentEditable = "false";
  el.dataset.start = String(image.start);
  el.dataset.end = String(image.end);
  if (image.comment) el.dataset.comment = image.comment;
  const img = document.createElement("img");
  img.src = imageSrc(image.url, repo);
  img.alt = image.alt;
  img.draggable = false;
  el.appendChild(img);
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
  if (!IMAGE_ONLY_LINE.test(doc.slice(start, end).trim())) return;
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
    for (const part of cell.parts) el.append(renderRun(part));
  } else {
    el.textContent = cell.text;
  }
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
    api.initialize({ startOnLoad: false, securityLevel: "strict", theme: "dark", flowchart: { htmlLabels: false }, suppressErrorRendering: true });
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

// A br, not a text node: an empty text node does not survive in the editing host.
// Up and down stop on this line start. The break after it is pulled onto this
// line; in flow its br would be the next one.
function renderCaretSlot(offset) {
  const el = document.createElement("span");
  el.dataset.start = String(offset);
  el.dataset.end = String(offset);
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

function appendParts(el, block, repo) {
  const share = markerOnly(block);
  if (block.slot != null) el.appendChild(renderCaretSlot(block.slot));
  for (const part of block.parts) {
    const node = part.type === "image" ? renderImage(part, repo) : renderRun(part);
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

function renderBlock(block, repo) {
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
  // The slot is the line's only caret. Tagging the line with it lets a click
  // and the empty-line boundary find the start, while the break still maps the newline.
  if (block.slot != null) {
    el.dataset.start = String(block.slot);
    el.dataset.end = String(block.slot);
  }
  if (block.raw) {
    if (block.empty) el.appendChild(document.createElement("br"));
    else appendParts(el, block, repo);
    return el;
  }
  if (block.empty || block.hr) {
    if (block.empty) el.appendChild(document.createElement("br"));
    return el;
  }
  appendParts(el, block, repo);
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

const IMAGE_ONLY_LINE = /^!\[[^\]]*\]\([^)\s]+\)$/;

// A click takes the whole image line, including the newline after it. The caret
// then sits past that line, so the picture stays drawn and Backspace removes the line.
function wholeImageLine(doc, offset) {
  if (typeof doc !== "string") return null;
  const [start, end] = lineSpan(doc, offset);
  if (!IMAGE_ONLY_LINE.test(doc.slice(start, end).trim())) return null;
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
  let openTicket = null;
  let relationTicketId = "";
  let relationShown = { parent: false, depends: false, children: false, blocks: false };
  let relationHad = { parent: false, depends: false, children: false, blocks: false };
  let ticketMenuOpen = false;
  const expandedTickets = new Set();
  let ticketForm = null;
  const ticketPickers = [];
  let ticketPointerBound = false;
  let ticketChrome = null;
  let ticketBlockEl = null;
  let ticketDrawerEnter = null;
  let ticketDrawerLeave = null;
  let ticketDrawerTimer = null;
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
  let repoCommitButton = null;
  let docLinkButton = null;
  let docAttachButton = null;
  let docAttachInput = null;
  let docMenuOnClick = null;
  let repoCommitOnClick = null;
  let docLinkOnClick = null;
  let docAttachOnClick = null;
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
  const repoStorage = storage || null;
  // Raw is not stored. It applies only to the document that was open when it was turned on.
  let sourceMode = false;
  let rawPath = "";
  let viewToggle = null;
  // Create is answered by its own error or by the file from onOpen.
  // A 409 for that create is not a rejected caret grant.
  const conflictWaiters = [];
  const fileWaiters = [];
  // The hub rejects an edit that repeats the mirror rev. Remember the op and
  // send it after this actor's doc advances rev and the caret. A noop keeps
  // the rev, so the next op goes at once. Silence reopens; the file brings
  // the caret and only then does the queue move.
  const pendingEdits = [];
  let editTimer = null;
  let refusalTimer = null;
  // The refused edit stays marked for one second. render builds new nodes, so the mark is applied there.
  let refusal = null;
  let resumeAfterFile = false;
  let lockTable = [];
  let expectNewComment = false;
  let unsubscribe = () => {};
  let sentLines = [];
  const ac = new AbortController();
  const listen = (type, fn, options = {}) => {
    root.addEventListener(type, fn, { ...options, signal: ac.signal });
  };
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
  // The selection under the press, kept so a drop can move it after the caret has moved.
  let dragRange = null;
  let dragSource = null;
  // The first press of a multi-click. Later presses reuse it after a render
  // would have moved the text under the pointer.
  let gestureOffset = null;
  let gestureArmed = false;
  let gestureTimer = null;
  // True from the click's state write through placeCaret. selectionchange in
  // that window still describes the DOM replaceChildren just tore down.
  let gestureHold = false;
  let pasteSeen = false;
  let pendingAttach = false;
  let noticeTimer = null;
  let noticeEl = null;
  let composing = false;
  let composed = "";
  // placeCaret and moveCaret write the selection from state. The selectionchange
  // those writes fire must not copy that selection back over state.
  let placingCaret = false;
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

  function emit(message, track = true) {
    const framed = { ...message, username: selfName() };
    const type = framed.type;
    if (type === "lock" || type === "edit" || type === "undo" || type === "redo" || type === "open") {
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
    if (type === "edit" || type === "undo" || type === "redo") {
      conflictWaiters.push("edit");
      // The memory transport answers in send. A socket that stays quiet is reopened.
      if (active.memory !== true) armEditTimer();
    }
    if (type === "open") fileWaiters.push("open");
    // The caller puts rev on ticket.set. A later 400 or 409 is a rejected field, not a lost caret.
    if (type === "ticket.set") conflictWaiters.push("ticket");
    if (type === "delete" || type === "ticket.delete") conflictWaiters.push("delete");
    active.send(framed);
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

  function editHeld() {
    return resumeAfterFile || conflictWaiters.includes("edit");
  }

  function dropPendingEdits() {
    pendingEdits.length = 0;
    resumeAfterFile = false;
    clearEditTimer();
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
      resumeAfterFile = true;
      waitingForFile = true;
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
  }

  function sendEdit(partial) {
    if (partial.op === "comment.add" || partial.op === "comment.delete" || partial.op === "comment.resolve") {
      lockThroughEnd();
    }
    const message = {
      type: "edit",
      anchor: state.anchor,
      cursor: state.cursor,
      ...partial,
    };
    // The hub's insert refuses a splice that cuts a comment mark. Raw mode
    // draws that mark, so the key is stored as typed.
    if (sourceMode && message.op === "insert") message.raw = true;
    emit(message);
  }

  function emitEdit(partial) {
    if (boundaryNoop(partial)) return;
    goalX = null;
    rawColumn = null;
    if (!live) return;
    if (editHeld()) {
      pendingEdits.push({ edit: partial });
      return;
    }
    sendEdit(partial);
  }

  function emitHistory(type) {
    if (!live) return;
    if (editHeld()) {
      pendingEdits.push({ history: type });
      return;
    }
    emit({ type });
  }

  function flushPendingEdit() {
    if (editHeld() || pendingEdits.length === 0) return;
    const next = pendingEdits.shift();
    if (next.history) emit({ type: next.history });
    else sendEdit(next.edit);
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

  // The line set is granted when this user already holds it, or when the memory
  // transport accepts the lock before send returns. A 409 puts the caret back.
  function claimLines(anchor, cursor) {
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

  function placePoint(range, point) {
    range.setStart(point.node, point.offset);
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

  // priorTop is the caret before this render replaced the line. A rebuild that
  // keeps the same visual line, or a caret already in view, stays put.
  function placeCaret(priorTop) {
    placingCaret = true;
    let node = null;
    try {
      node = placeCaretFromState();
    } finally {
      placingCaret = false;
    }
    if (!node) return;
    if (priorTop !== undefined) {
      const after = caretRect();
      if (after && caretInView(after)) return;
      if (priorTop != null && after && Number.isFinite(after.top) && Math.abs(after.top - priorTop) <= 3) return;
    }
    scrollCaret(node);
  }

  function scrollCaret(node) {
    const host = (node && node.parentElement) || root;
    if (host && typeof host.scrollIntoView === "function") {
      host.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  function focusEditor() {
    if (root && typeof root.focus === "function") root.focus();
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
      const from = pointFor(visibleSelectionOffset(state.doc, anchor, caret));
      const to = pointFor(visibleSelectionOffset(state.doc, caret, anchor));
      if (from && to) {
        sel.setBaseAndExtent(from.node, from.offset, to.node, to.offset);
        return to.node;
      }
    }
    const point = pointFor(caret);
    if (point) {
      const range = document.createRange();
      placePoint(range, point);
      sel.removeAllRanges();
      sel.addRange(range);
      return point.node;
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
    return null;
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

  function adoptDomSelection() {
    if (gestureHold) return true;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return true;
    const holder = sel.anchorNode || sel.getRangeAt(0).commonAncestorContainer;
    if (!holder || !root.contains(holder)) return true;
    const mapped = selectionFromDom(sel);
    if (!mapped) return true;
    // The drawn range omits glyph-less markers. A cut or paste keeps the
    // source selection, which still owns those markers.
    const next = sourceMode ? mapped : withMarkerEdges(state.doc, state, mapped);
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

  function onSelectionChange() {
    if (closed || placingCaret || composing || gestureHold) return;
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
    const snapped = sourceMode || pointer ? mapped : homeSnap(mapped);
    const next = sourceMode ? snapped : withMarkerEdges(state.doc, state, snapped);
    if (sourceMode || (next.anchor === state.anchor && next.cursor === state.cursor)) goalX = keptX;
    state = { ...state, anchor: next.anchor, cursor: next.cursor };
    if (snapped.anchor !== mapped.anchor || snapped.cursor !== mapped.cursor) placeCaret();
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
    const before = state.doc;
    if (reply) emit({ type: "comment.reply", id, text, path: openPath });
    else emit({ type: "comment.edit", id, note: noteId, rev, text, path: openPath });
    if (state.doc === before) render();
  }

  function onCancel(box) {
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
    if (!replyDrafts.has(id)) replyDrafts.set(id, "");
    const thread = threadById(id);
    const noteId = thread ? nextNoteId(parseCommentNotes(thread.body)) : 0;
    currentCommentId = id;
    commentFocus = { id, note: noteId, start: 0, end: 0 };
    render();
  }

  function onDelete(id) {
    unsavedThreads.delete(id);
    replyDrafts.delete(id);
    if (currentCommentId === id) currentCommentId = null;
    commentFocus = null;
    restoreEditorFocus = true;
    emitEdit({ op: "comment.delete", id });
    focusEditor();
  }

  function onResolve(id) {
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

  function appendAuthor(parent, id, index, withResolve, name, time) {
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
    by.appendChild(author);
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
      appendAuthor(card, comment.id, noteId, false, selfName(), "");
      appendBody(card, comment.id, noteId, stored, "fresh");
      if (comment.id !== currentCommentId) setCommentActions(card, false);
      return card;
    }
    if (records.length === 0 && !replyDrafts.has(comment.id)) {
      const note = document.createElement("div");
      note.className = "md-comment-note";
      appendAuthor(note, comment.id, 0, true, "", "");
      const mode = editingNotes.has(draftKey(comment.id, 0)) ? "edit" : "saved";
      appendBody(note, comment.id, 0, "", mode);
      card.appendChild(note);
    }
    records.forEach((record, index) => {
      const parts = splitCommentNote(record.raw);
      const note = document.createElement("div");
      note.className = "md-comment-note";
      appendAuthor(note, comment.id, record.id, index === 0, parts.author, parts.time);
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
    card.appendChild(makeIconButton(
      "Delete",
      ICON_PATHS.delete[0],
      "icon-btn danger",
      () => onDelete(comment.id),
    ));
    if (comment.id !== currentCommentId) setCommentActions(card, false);
    return card;
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
      if (child === repoCommitButton || child === docAttachButton || child === docAttachInput) continue;
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
    // Absolute cards paint over these. A hidden control still reports a box, so only a shown one counts.
    for (const control of [repoCommitButton, docAttachButton, docAttachInput]) {
      const bottom = shownBottom(control);
      if (bottom > floor) floor = bottom;
    }
    // A card may move down to clear the cards above it, never up over them.
    // A tall closed card shortens so the next anchor keeps a place. The open card stays full height.
    const menuFloor = floor;
    const SHORT = 10 * COMMENT_CARD_GAP;
    const GAP = COMMENT_CARD_GAP;
    const anchorOf = (card) => {
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
      if (rects.length === 0) return null;
      let markTop = rects[0].top;
      for (const rect of rects) if (rect.top < markTop) markTop = rect.top;
      return markTop - asideRect.top;
    };
    const anchors = cards.map((card) => anchorOf(card));
    for (let i = 0; i < cards.length; i += 1) {
      const card = cards[i];
      const anchor = anchors[i];
      const top = anchor == null ? floor : Math.max(floor, menuFloor, anchor);
      setStyle(card, "position", "absolute");
      setStyle(card, "left", "0px");
      setStyle(card, "width", "100%");
      setStyle(card, "margin", "0px");
      // offsetHeight reports the clamped box. Clear the clamp before measuring the card's own height.
      setStyle(card, "max-height", "");
      setStyle(card, "overflow", "");
      const natural = typeof card.offsetHeight === "number" ? card.offsetHeight : (elementRect(card)?.height || 0);
      let nextAnchor = null;
      for (let j = i + 1; j < anchors.length; j += 1) {
        if (anchors[j] != null) {
          nextAnchor = anchors[j];
          break;
        }
      }
      const current = card.classList && card.classList.contains("md-comment-current");
      let used = natural;
      if (!current && natural > SHORT && nextAnchor != null) {
        const nextHome = Math.max(nextAnchor, menuFloor);
        const room = nextHome - top - GAP;
        if (natural + GAP > nextHome - top) used = Math.min(natural, SHORT, Math.max(GAP, room));
      }
      if (used < natural) {
        setStyle(card, "max-height", `${used}px`);
        setStyle(card, "overflow", "hidden");
      }
      setStyle(card, "top", `${top}px`);
      floor = top + used + GAP;
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
        // A middle button pastes the primary selection. Cancelling that press
        // drops the paste, and only the primary button adds a comment.
        if (!event || event.button !== 0) return;
        event.preventDefault();
        const result = addComment(state.doc, state.anchor, state.cursor);
        if (!result) return;
        expectNewComment = true;
        const before = state.doc;
        emitEdit({ op: "comment.add", anchor: state.anchor, cursor: state.cursor });
        // A socket holds the edit until its doc message. Memory applies first,
        // so an unchanged mirror there means the add never happened.
        if (state.doc === before && (active.memory === true || !live)) expectNewComment = false;
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
    // Above the selection, clear of the characters that follow it.
    if (rect && Number.isFinite(rect.top) && Number.isFinite(rect.left)) {
      const height = Number(addCommentButton.offsetHeight);
      const lift = Number.isFinite(height) ? height : 0;
      setStyle(addCommentButton, "left", `${rect.left}px`);
      setStyle(addCommentButton, "top", `${rect.top - lift}px`);
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
    const move = drag && dest != null ? moveCommentMarker(state.doc, drag.id, drag.edge, dest) : null;
    if (!move) {
      if (hoverCommentId) showCommentHandles(hoverCommentId);
      return;
    }
    emitEdit({ op: "insert", text: move.text, anchor: move.from, cursor: move.to });
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
    handleDrag = { id, edge, handle, x: event.clientX, y: event.clientY };
    handle.classList.add("md-comment-handle-dragging");
    setStyle(handle, "pointer-events", "none");
    return true;
  }

  function onRootMouseMove(event) {
    if (handleDrag) {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      moveDraggedHandle(event);
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
    if (handleDrag) {
      moveDraggedHandle(event);
      return;
    }
    if (pointer) return;
    const node = event && event.target;
    if (node && root.contains(node)) return;
    if (!hoverCommentId) return;
    hoverCommentId = null;
    clearCommentHandles();
  }

  function onDocumentMouseUp(event) {
    if (!handleDrag) return;
    const node = event && event.target;
    if (node && root.contains(node)) return;
    finishHandleDrag(event);
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
      classes: ["md-raw", "md-p"],
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

  function syncSourceClass() {
    if (!root.classList) return;
    if (sourceMode) root.classList.add("md-source");
    else root.classList.remove("md-source");
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

  // Last, so a line's child index stays the block it paints. Fixed, once the
  // pane has a box, so the control stays in the visible corner while text scrolls.
  function mountViewToggle() {
    const button = ensureViewToggle();
    if (typeof button.setAttribute === "function") button.setAttribute("aria-pressed", sourceMode ? "true" : "false");
    replaceButtonIcon(button);
    const children = root.childNodes || [];
    const index = typeof children.indexOf === "function" ? children.indexOf(button) : -1;
    if (index < 0 || index !== children.length - 1) {
      if (index >= 0 && typeof children.splice === "function") children.splice(index, 1);
      root.appendChild(button);
    }
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
    const right = Number(rect.right);
    if (!(width > 0) || !(height > 0) || !Number.isFinite(top) || !Number.isFinite(right)) return;
    const inset = 6;
    const visibleTop = top < 0 ? 0 : top;
    const visibleRight = right > viewWidth ? viewWidth : right;
    setStyle(button, "position", "fixed");
    setStyle(button, "top", `${visibleTop + inset}px`);
    setStyle(button, "right", `${viewWidth - visibleRight + inset}px`);
    setStyle(button, "left", "auto");
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
      if (sourceMode) {
        renderSourceView(caretTop());
        mountViewToggle();
        return;
      }
      const planned = plan(state.doc, state.cursor);
      let blocks = planned.blocks;
      if (rawSelectionLines) {
        rawSelectionLines = false;
        blocks = blocksWithSelectionSource(blocks);
      }
      blocks = blocksForCaret(blocks);
      const flashBlock = refusal && !refusal.name ? tightestBlock(blocks, refusal.offset) : null;
      const nodes = blocks.map((block) => {
        const el = renderBlock(block, activeRepo);
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
      markEditingHighlights();
      hideResolvedHighlights();
      markCurrentHighlights();
      renderCommentAside(planned.comments);
      layoutComments();
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
    } finally {
      if (gestureHeld) gestureHold = false;
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
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      hashComment = null;
      pinnedComment = null;
      openPath = file.path;
      seedOpen(openPath);
      waitingForFile = true;
      emit({ type: "open", path: file.path });
      publishHash();
      syncEntryLink();
      renderFileTree(fileList, false);
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
    const kept = keptCaret;
    if (message.type === "doc" && kept && ownActor(message) && message.text === kept.text) {
      keptCaret = null;
      if (kept.anchor !== kept.cursor) rawSelectionLines = true;
      return { cursor: clampCaret(kept.cursor, length), anchor: clampCaret(kept.anchor, length) };
    }
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

  // file and doc replace the mirror. The view does not paint a local edit.
  function applySnapshot(message) {
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
    if (message.type === "file") {
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
    const lines = lineSet(state.anchor, state.cursor);
    sentLines = lines;
    noteFreshComment(previousDoc, message);
    if (message.type === "file") focusHashedComment(message.path, text);
    render();
    if (message.type === "file") publishHash();
    if (!live) return;
    if (message.type === "file" || !sameLines(lines, previousLines)) {
      emit({ type: "lock", anchor: state.anchor, cursor: state.cursor }, false);
    }
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
      dropPendingEdits();
      conflictWaiters.length = 0;
      fileWaiters.length = 0;
      outstandingLock = null;
      live = false;
      if (activeRepo) sendRepoFrames(activeRepo);
      if (openPath) {
        waitingForFile = true;
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
      }
      refreshLockMarks();
      return;
    }
    if (message.type === "noop") {
      // A doc or noop while the file is still out must not release the queue.
      if (waitingForFile || resumeAfterFile) return;
      if (typeof message.path !== "string" || message.path !== openPath) return;
      if (Number(message.rev) !== rev) return;
      clearEditTimer();
      const index = conflictWaiters.indexOf("edit");
      if (index >= 0) conflictWaiters.splice(index, 1);
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
        return;
      }
      if (isConflict(message)) {
        const waiter = conflictWaiters.shift();
        if (waiter === "edit") {
          dropPendingEdits();
          armRefusal(message);
        }
        expectNewComment = false;
        restoreGrantedCaret();
      }
      return;
    }
    if (message.type === "file") {
      if (fileWaiters.length > 0) {
        const waiter = fileWaiters.shift();
        if (waiter === "create") {
          const index = conflictWaiters.indexOf("create");
          if (index >= 0) conflictWaiters.splice(index, 1);
        }
      }
      // Both lists mark openPath. Assign it before this render, or the previous
      // document stays marked beside the ticket this file message just opened.
      if (typeof message.path === "string" && message.path) {
        openPath = message.path;
        seedOpen(message.path);
        renderFileTree(fileList, false);
      }
    }
    let ownEdit = false;
    if (message.type === "doc") {
      clearEditTimer();
      if (waitingForFile) {
        keptCaret = null;
        return;
      }
      const nextRev = Number(message.rev);
      if (!Number.isFinite(nextRev) || nextRev !== rev + 1) {
        keptCaret = null;
        rawSelectionLines = false;
        waitingForFile = true;
        expectNewComment = false;
        dropPendingEdits();
        dropEditWaiters();
        emit({ type: "open", path: openPath });
        return;
      }
      if (ownActor(message)) {
        pendingAttach = false;
        const index = conflictWaiters.indexOf("edit");
        if (index >= 0) {
          conflictWaiters.splice(index, 1);
          ownEdit = true;
        }
      }
    }
    if (message.type === "doc" || message.type === "file") applySnapshot(message);
    if (message.type === "file") syncFileTicket(message);
    if (message.type === "file" && resumeAfterFile) {
      resumeAfterFile = false;
      flushPendingEdit();
    }
    if (ownEdit) flushPendingEdit();
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
    placingCaret = true;
    let landed = null;
    let hangAffinity = false;
    try {
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
    } finally {
      placingCaret = false;
    }
    if (landed == null) return;
    let next = placeMove(state.doc, beforeCursor, landed, direction, granularity);
    // Up and down on a line drawn empty rest on its start.
    if (granularity === "line") next = lineCaret(state.doc, next);
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
    // browser cannot move there. The step is that offset.
    if (forward && next === beforeCursor && state.doc.endsWith("\n")) {
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
    const anchor = extend ? beforeAnchor : next;
    state = { ...state, cursor: next, anchor };
    if (!claimLines(anchor, next)) return;
    const after = lineIndexAt(state.doc, state.cursor);
    const drawn = pointFor(next);
    // modify stops on the marker edge, which is this same offset. The gap's end
    // is where the next letter is drawn, so the caret has to be placed there.
    if (before !== after) render();
    else if (anchor !== next || next !== landed || inRawGap(drawn && drawn.node)) placeCaret();
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
      if (event.data && event.data !== composed) emitEdit({ op: "insert", text: event.data });
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
  }

  // Enter on an item inserts the same kind of marker. A paragraph whose next
  // line would join it inserts the blank line that keeps them apart.
  function emitBreak() {
    const brk = enterBreak(state.doc, state.anchor, state.cursor);
    const partial = { op: "insert", text: brk.text };
    if (typeof brk.anchor === "number") {
      partial.anchor = brk.anchor;
      partial.cursor = brk.cursor;
    }
    if (typeof brk.caret === "number") partial.caret = brk.caret;
    emitEdit(partial);
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
    if (edits && !adoptDomSelection()) return;
    if (sourceMode && rawBeforeInput(type, event)) return;
    if (type === "insertText") {
      if (event.data === "\t") return;
      if (event.data === "\n") {
        if (event.data === composed) return;
        emitBreak();
        return;
      }
      if (event.data && event.data !== composed) emitEdit({ op: "insert", text: event.data });
      return;
    }
    if (type === "insertCompositionText" || type === "insertFromComposition") return;
    if (type === "insertParagraph" || type === "insertLineBreak") {
      emitBreak();
      return;
    }
    if (type === "deleteContentBackward") {
      if (!prepareBackwardDelete()) return;
      emitEdit({ op: "backspace" });
      return;
    }
    if (type === "deleteContentForward") {
      if (state.anchor === state.cursor) {
        const [start, end] = lineSpan(state.doc, state.cursor);
        if (start === end && state.cursor > 0 && state.cursor < state.doc.length) {
          // Delete on an empty line is the backspace of the preceding break,
          // which is the caret the page already sends. A leading empty line
          // still deletes forward. The line after the final newline is not a
          // character, so Delete there changes nothing.
          emitEdit({ op: "backspace" });
          return;
        }
      }
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

  listen("dragover", (event) => {
    if (fileListOf(event.dataTransfer).length === 0) return;
    if (typeof event.preventDefault === "function") event.preventDefault();
  });

  listen("drop", (event) => {
    if (dragSource) return;
    if (fileListOf(event.dataTransfer).length === 0) return;
    if (typeof event.preventDefault === "function") event.preventDefault();
    consumePaste("", event.dataTransfer);
  });

  listen("copy", (event) => {
    event.preventDefault();
    event.clipboardData.setData("text/plain", selectedSlice(state));
  });

  listen("cut", (event) => {
    event.preventDefault();
    if (!adoptDomSelection()) return;
    const text = selectedSlice(state);
    event.clipboardData.setData("text/plain", text);
    if (state.anchor === state.cursor) return;
    if (sourceMode) rawErase(1);
    else emitEdit({ op: "delete" });
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
    if (composed && claimLines(state.anchor, state.cursor)) emitEdit({ op: "insert", text: composed });
    queueMicrotask(() => {
      composed = "";
    });
  });

  listen("keydown", (event) => {
    gestureHold = false;
    commentFocus = null;
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
    if (mod && !event.shiftKey && !event.altKey && (event.key === "a" || event.key === "A")) {
      event.preventDefault();
      state = { ...state, anchor: 0, cursor: state.doc.length };
      if (!claimLines(0, state.doc.length)) return;
      render();
      return;
    }
    if (sourceMode && rawMoveKey(event.key)) {
      event.preventDefault();
      const extend = event.shiftKey === true && !event.ctrlKey && !event.altKey && !event.metaKey;
      moveRawCaret(event.key, extend, event.ctrlKey === true || event.metaKey === true);
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const extend = event.shiftKey === true && !event.ctrlKey && !event.altKey && !event.metaKey;
      const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
      const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
      moveCaret(forward ? "forward" : "backward", horizontal ? "character" : "line", extend);
    }
  });

  listen("keyup", () => {
    if (closed || composing || pointer) return;
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

  function pointOffset(event) {
    const mapped = pointMapped(event);
    if (mapped == null) return null;
    if (sourceMode) return mapped;
    return blankLinePress(event, skipHidden(state.doc, mapped, "nearer"));
  }

  listen("mousedown", (event) => {
    if (beginHandleDrag(event)) return;
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
    // skipHidden snaps a press inside a comment mark to the mark's edge. That
    // edge is the selection boundary when the selection covers the mark, so the
    // unsnapped offset is what says this press is a drag of the selection.
    // Source mode draws the marker, so the caret stays on the byte that was hit.
    const raw = pointMapped(event);
    const skipped = sourceMode || raw == null ? raw : skipHidden(state.doc, raw, "nearer");
    gestureOffset = skipped == null || sourceMode ? skipped : blankLinePress(event, skipped);
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

  listen("mouseup", (event) => {
    if (handleDrag) {
      finishHandleDrag(event);
      return;
    }
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
          gestureOffset = null;
          const before = lineIndexAt(state.doc, state.cursor);
          state = { ...state, anchor: mapped.anchor, cursor: mapped.cursor };
          if (!claimLines(mapped.anchor, mapped.cursor)) return;
          const after = lineIndexAt(state.doc, state.cursor);
          if (before !== after) render();
          else updateCommentButton();
          return;
        }
      }
    }
    if (!composing) claimLines(state.anchor, state.cursor);
  });

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
    try {
      onEditorClick(event);
    } finally {
      releaseBrowserSelection(event);
    }
  });

  function onEditorClick(event) {
    const armed = gestureArmed;
    gestureArmed = false;
    const stored = armed ? gestureOffset : null;
    const target = event.target.nodeType === 1 ? event.target : event.target.parentElement;
    const link = target?.closest?.("a");
    if (link && root.contains(link)) event.preventDefault();
    if (didDrag) {
      didDrag = false;
      gestureOffset = null;
      return;
    }
    if (link && root.contains(link)) {
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
      adoptDomSelection();
      return;
    }
    if (belowLastBlock(event)) {
      const end = state.doc.length;
      if (!keepCurrent) clearCurrentComment();
      if (event.detail === 1) gestureHold = true;
      state = { ...state, anchor: end, cursor: end };
      if (!claimLines(end, end)) {
        if (event.detail === 1) gestureHold = false;
        return;
      }
      render();
      return;
    }
    if (detail === 2 || detail === 3) {
      const atom = target?.closest?.(".md-atom");
      if (atom && root.contains(atom)) event.preventDefault();
      const offset = stored != null ? stored : pointOffset(event);
      if (offset == null) return;
      if (detail === 3) gestureOffset = null;
      if (!keepCurrent) clearCurrentComment();
      const span = detail === 2 ? wordSpan(state.doc, offset) : lineSpan(state.doc, offset);
      state = { ...state, anchor: span[0], cursor: span[1] };
      if (!claimLines(span[0], span[1])) return;
      render();
      return;
    }
    const atom = target?.closest?.(".md-atom");
    if (atom && root.contains(atom)) {
      event.preventDefault();
      if (!keepCurrent) currentCommentId = null;
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
    render();
  }

  listen("auxclick", (event) => {
    const target = event.target.nodeType === 1 ? event.target : event.target.parentElement;
    if (target?.closest?.("a")) event.preventDefault();
  });

  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("selectionchange", onSelectionChange, { signal: ac.signal });
  }
  // The sheet tests store root and document listeners in one map. Window keeps
  // a release outside the editor from replacing the root mouseup handler.
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("mousemove", onDocumentMouseMove, { signal: ac.signal });
    window.addEventListener("mouseup", onDocumentMouseUp, { signal: ac.signal });
  }

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
      const mod = event.ctrlKey || event.metaKey;
      if (mod && !event.altKey && event.key === "Enter") {
        event.preventDefault();
        onSave(box);
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

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("resize", () => {
      layoutComments();
      pinViewToggle();
    }, { signal: ac.signal });
    window.addEventListener("scroll", () => pinViewToggle(), { capture: true, signal: ac.signal });
    window.addEventListener("hashchange", () => onHashChange(), { signal: ac.signal });
  }
  listen("scroll", () => pinViewToggle());

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

  function showTicketDrawer() {
    if (ticketDrawerTimer != null) {
      clearTimeout(ticketDrawerTimer);
      ticketDrawerTimer = null;
    }
    const drawer = ticketDrawerEl();
    if (drawer) showElement(drawer);
  }

  // A pointer that slips off and comes back inside 200ms keeps the wide list.
  function scheduleHideTicketDrawer() {
    if (ticketDrawerTimer != null) clearTimeout(ticketDrawerTimer);
    ticketDrawerTimer = setTimeout(() => {
      ticketDrawerTimer = null;
      const drawer = ticketDrawerEl();
      if (drawer && drawer.classList) drawer.classList.remove("md-ticket-wide");
      setStyle(drawer, "top", "");
      setStyle(drawer, "height", "");
      setStyle(drawer, "width", "");
      setStyle(drawer, "transition", "");
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
    if (ticketDrawerTimer != null) {
      clearTimeout(ticketDrawerTimer);
      ticketDrawerTimer = null;
    }
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
      showTicketDrawer();
      const drawer = ticketDrawerEl();
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
    let target = openTicket;
    if (path !== openPath) {
      target = ticketList.find((item) => `tickets/${item.id}.md` === path) || null;
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
    if (Object.prototype.hasOwnProperty.call(fields, "type")) {
      emit({ type: "ticket.set", path, rev: nextRev, ticketType: fields.type });
      return;
    }
    const payload = { type: "ticket.set", path, rev: nextRev };
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

  function matchingTickets(query) {
    const typed = String(query || "");
    if (!typed || !openTicket) return [];
    const needle = typed.toLowerCase();
    const matches = [];
    for (const ticket of ticketList) {
      if (!ticket || ticket.id === openTicket.id) continue;
      const title = typeof ticket.title === "string" ? ticket.title : "";
      const id = typeof ticket.id === "string" ? ticket.id : "";
      let text = null;
      if (title.toLowerCase().startsWith(needle)) text = title;
      else if (id.toLowerCase().startsWith(needle)) text = id;
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

  function strokeButton(className, label, d) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `icon-btn ${className}`;
    if (typeof button.setAttribute === "function") {
      button.setAttribute("type", "button");
      button.setAttribute("aria-label", label);
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

  function relationPresence(ticket) {
    const id = ticket.id;
    return {
      parent: ticket.parent !== "",
      depends: Array.isArray(ticket.depends) && ticket.depends.length > 0,
      children: ticketList.some((item) => item && item.id !== id && item.parent === id),
      blocks: ticketList.some((item) => item && item.id !== id && Array.isArray(item.depends) && item.depends.includes(id)),
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
    if (!panel || panel.hidden) return;
    if (nodeWithin(panel, target) || nodeWithin(button, target)) return;
    closeTicketMenu();
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
    const picker = document.createElement("div");
    picker.className = "md-ticket-picker";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "md-ticket-match";
    input.value = typeof options.value === "string" ? options.value : "";
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
    const parts = [input];
    if (buttons) {
      const add = strokeButton("md-ticket-add", "Add", "M12 5v14M5 12h14");
      const remove = strokeButton("md-ticket-remove", "Remove", "M5 12h14");
      add.addEventListener("click", (event) => {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        const ticket = state.chosen;
        if (!ticket) return;
        clearMatch();
        onAdd(ticket);
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
    for (const ticket of tickets) {
      const row = plainButton("md-ticket-link", ticket.title || ticket.id);
      row.dataset.id = ticket.id;
      row.addEventListener("click", (event) => {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        selected = ticket;
        for (const child of links.childNodes) {
          if (!child.classList || !child.classList.contains("md-ticket-link")) continue;
          if (child === row) child.classList.add("md-ticket-selected");
          else child.classList.remove("md-ticket-selected");
        }
      });
      links.appendChild(row);
    }
    return {
      links,
      removeSelected() {
        if (!selected) return;
        onRemove(selected);
      },
    };
  }

  function renderTicketForm() {
    const form = ticketForm;
    if (!form || !openTicket || typeof document === "undefined" || typeof document.createElement !== "function") return;
    ticketPickers.length = 0;
    const ticket = openTicket;
    syncRelationShown(ticket);
    showElement(form);
    const heading = document.createElement("div");
    heading.className = "md-ticket-heading";
    heading.textContent = ticket.title;
    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.className = "md-ticket-title-input";
    titleInput.value = ticket.title;
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
      titleInput.value = ticket.title;
      showHeading(ticket.title);
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
        return;
      }
      pendingTitle = next;
      showHeading(next);
      sendTicketSet({ title: next });
    }

    heading.addEventListener("click", () => {
      if (!openTicket) return;
      titleInput.value = heading.textContent;
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
      if (skipTitleBlur) {
        skipTitleBlur = false;
        return;
      }
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
    if (typeof assigneeInput.setAttribute === "function") assigneeInput.setAttribute("type", "text");
    let skipAssigneeBlur = false;
    function commitAssignee() {
      if (!openTicket) return;
      const raw = String(assigneeInput.value || "");
      if (/[\r\n\t]/.test(raw)) {
        assigneeInput.value = openTicket.assignee || "";
        return;
      }
      const next = raw.trim();
      assigneeInput.value = next;
      if (next === (openTicket.assignee || "")) return;
      sendTicketSet({ assignee: next });
    }
    assigneeInput.addEventListener("keydown", (event) => {
      if (!event) return;
      if (event.key === "Escape") {
        if (typeof event.preventDefault === "function") event.preventDefault();
        skipAssigneeBlur = true;
        assigneeInput.value = openTicket ? (openTicket.assignee || "") : "";
        return;
      }
      if (event.key !== "Enter") return;
      if (typeof event.preventDefault === "function") event.preventDefault();
      commitAssignee();
    });
    assigneeInput.addEventListener("blur", () => {
      if (skipAssigneeBlur) {
        skipAssigneeBlur = false;
        return;
      }
      commitAssignee();
    });
    assigneeLabel.append(fieldName("Assignee"), assigneeInput);
    const sized = [stateField.select, typeField.select, priorityField.select];
    const selectWidth = sharedSelectWidth(sized);
    if (selectWidth > 0) paintSelectWidth(sized, selectWidth);

    const parentField = document.createElement("div");
    parentField.className = "md-ticket-field md-ticket-parent";
    const parentTicket = ticket.parent ? ticketList.find((item) => item.id === ticket.parent) : null;
    const parentShown = ticket.parent ? (parentTicket ? (parentTicket.title || parentTicket.id) : ticket.parent) : "";
    const parentPicker = buildTicketPicker({
      commitOnPick: true,
      buttons: false,
      value: parentShown,
      onAdd: (chosen) => sendTicketSet({ parent: chosen.id }),
      onClear: () => sendTicketSet({ parent: "" }),
    });
    parentField.append(fieldName("Parent"), parentPicker);

    function knownTicket(id) {
      return ticketList.find((item) => item.id === id) || {
        id,
        title: id,
        created: "",
        parent: "",
        depends: [],
        rev: 0,
      };
    }

    const depends = document.createElement("div");
    depends.className = "md-ticket-depends";
    const dependList = buildLinkList((ticket.depends || []).map(knownTicket), (selected) => {
      sendTicketSet({ depends: (ticket.depends || []).filter((id) => id !== selected.id) });
    });
    const dependPicker = buildTicketPicker({
      onAdd: (chosen) => {
        const ids = (ticket.depends || []).slice();
        if (!ids.includes(chosen.id)) ids.push(chosen.id);
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
    const childTickets = ticketList
      .filter((item) => item.parent === ticket.id && item.id !== ticket.id)
      .sort(compareTickets);
    const childList = buildLinkList(childTickets, (selected) => {
      sendTicketSet({
        path: `tickets/${selected.id}.md`,
        rev: selected.rev,
        parent: "",
      });
    });
    const childPicker = buildTicketPicker({
      onAdd: (chosen) => {
        sendTicketSet({
          path: `tickets/${chosen.id}.md`,
          rev: chosen.rev,
          parent: ticket.id,
        });
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

    const blockers = ticketList
      .filter((item) => item.id !== ticket.id && Array.isArray(item.depends) && item.depends.includes(ticket.id))
      .sort(compareTickets);
    const blocks = document.createElement("div");
    blocks.className = "md-ticket-blocks";
    const blockList = buildLinkList(blockers, (selected) => {
      sendTicketSet({
        path: `tickets/${selected.id}.md`,
        rev: selected.rev,
        depends: (selected.depends || []).filter((dep) => dep !== ticket.id),
      });
    });
    const blockPicker = buildTicketPicker({
      onAdd: (chosen) => {
        const ids = (chosen.depends || []).slice();
        if (!ids.includes(ticket.id)) ids.push(ticket.id);
        sendTicketSet({
          path: `tickets/${chosen.id}.md`,
          rev: chosen.rev,
          depends: ids,
        });
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
    form.replaceChildren(fields, facts, menuButton, menuPanel);
    if (selectWidth > 0) {
      const extra = selectChromeGap(sized);
      if (extra > 0) paintSelectWidth(sized, selectWidth + extra);
    }
    if (ticket.title === "New ticket") {
      hideElement(heading);
      showElement(titleInput);
      if (typeof titleInput.focus === "function") titleInput.focus();
      selectInput(titleInput, 0, titleInput.value.length);
    }
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
    ticketPickers.length = 0;
    if (!ticketForm) return;
    hideElement(ticketForm);
    if (typeof ticketForm.replaceChildren === "function") ticketForm.replaceChildren();
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
    state = createState("");
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
    if (repoCommitButton) {
      if (activeRepo) showElement(repoCommitButton);
      else hideElement(repoCommitButton);
    }
    syncEntryLink();
  }

  function syncEntryLink() {
    const open = activeRepo && openPath;
    if (docLinkButton) {
      if (open) showElement(docLinkButton);
      else hideElement(docLinkButton);
    }
    if (docAttachButton) {
      if (open) showElement(docAttachButton);
      else hideElement(docAttachButton);
    }
  }

  function unbindDocMenu() {
    if (docMenuButton && docMenuOnClick) {
      const binding = docMenuBindings.get(docMenuButton);
      if (binding === docMenuOnClick && typeof docMenuButton.removeEventListener === "function") {
        docMenuButton.removeEventListener("click", docMenuOnClick);
      }
      if (binding === docMenuOnClick) docMenuBindings.delete(docMenuButton);
    }
    if (repoCommitButton && repoCommitOnClick) {
      const binding = docCommitBindings.get(repoCommitButton);
      if (binding === repoCommitOnClick && typeof repoCommitButton.removeEventListener === "function") {
        repoCommitButton.removeEventListener("click", repoCommitOnClick);
      }
      if (binding === repoCommitOnClick) docCommitBindings.delete(repoCommitButton);
    }
    if (docLinkButton && docLinkOnClick) {
      const binding = docLinkBindings.get(docLinkButton);
      if (binding === docLinkOnClick && typeof docLinkButton.removeEventListener === "function") {
        docLinkButton.removeEventListener("click", docLinkOnClick);
      }
      if (binding === docLinkOnClick) docLinkBindings.delete(docLinkButton);
    }
    if (docAttachButton && docAttachOnClick) {
      const binding = docAttachBindings.get(docAttachButton);
      if (binding === docAttachOnClick && typeof docAttachButton.removeEventListener === "function") {
        docAttachButton.removeEventListener("click", docAttachOnClick);
      }
      if (binding === docAttachOnClick) docAttachBindings.delete(docAttachButton);
    }
    if (docAttachInput && docAttachOnChange && typeof docAttachInput.removeEventListener === "function") {
      docAttachInput.removeEventListener("change", docAttachOnChange);
    }
    docMenuOnClick = null;
    repoCommitOnClick = null;
    docLinkOnClick = null;
    docAttachOnClick = null;
    docAttachOnChange = null;
    docMenuBound = false;
  }

  function ensureDocMenu() {
    if (!commentsAside || typeof document === "undefined" || typeof document.createElement !== "function") return;
    if (!repoCommitButton || repoCommitButton.parentElement !== commentsAside) {
      repoCommitButton = findClassChild(commentsAside, "md-doc-commit");
    }
    if (!repoCommitButton) {
      const commit = document.createElement("button");
      commit.type = "button";
      commit.className = "md-doc-commit";
      commit.textContent = "Commit repo";
      if (typeof commit.setAttribute === "function") commit.setAttribute("type", "button");
      hideElement(commit);
      commentsAside.appendChild(commit);
      repoCommitButton = commit;
    }
    if (!docAttachButton || docAttachButton.parentElement !== commentsAside) {
      docAttachButton = findClassChild(commentsAside, "md-attach");
    }
    if (!docAttachButton) {
      const attach = document.createElement("button");
      attach.type = "button";
      attach.className = "md-attach";
      attach.textContent = "Attach image";
      if (typeof attach.setAttribute === "function") attach.setAttribute("type", "button");
      hideElement(attach);
      placeAfter(commentsAside, repoCommitButton, attach);
      docAttachButton = attach;
    }
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
      placeAfter(commentsAside, docAttachButton, input);
      docAttachInput = input;
    }
    if (!docMenuBound) {
      const previousCommit = docCommitBindings.get(repoCommitButton);
      if (previousCommit && typeof repoCommitButton.removeEventListener === "function") {
        repoCommitButton.removeEventListener("click", previousCommit);
      }
      repoCommitOnClick = (event) => {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        if (!activeRepo) return;
        // A checkpoint is not a conflict waiter and carries no rev.
        emit({ type: "commit" });
      };
      if (typeof repoCommitButton.addEventListener === "function") repoCommitButton.addEventListener("click", repoCommitOnClick);
      docCommitBindings.set(repoCommitButton, repoCommitOnClick);
      const previousAttach = docAttachBindings.get(docAttachButton);
      if (previousAttach && docAttachButton && typeof docAttachButton.removeEventListener === "function") {
        docAttachButton.removeEventListener("click", previousAttach);
      }
      docAttachOnClick = (event) => {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        if (docAttachInput && typeof docAttachInput.click === "function") docAttachInput.click();
      };
      if (docAttachButton && typeof docAttachButton.addEventListener === "function") {
        docAttachButton.addEventListener("click", docAttachOnClick);
      }
      if (docAttachButton) docAttachBindings.set(docAttachButton, docAttachOnClick);
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
      root.focus();
      placeCaret();
    },
    moveCaret(direction, granularity, extend) {
      moveCaret(direction, granularity, extend);
    },
    destroy() {
      closed = true;
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
    // the span claim. The same text on the same path keeps this page's caret. Another
    // path, or text that changed while the socket was down, takes the caret the hub sent.
    let editor = null;
    let shownPath = "";
    const send = transport.send.bind(transport);
    transport.send = (message) => {
      if (message && message.type === "open" && typeof message.path === "string" && message.path !== shownPath) shownPath = "";
      send(message);
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
