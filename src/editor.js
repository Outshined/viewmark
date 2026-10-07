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
  parseCommentNotes,
  splitCommentNote,
  orderVisibleComments,
  lineIndexAt,
} from "./doc.js";
import { createMemoryTransport, createSocketTransport } from "./session.js";
import { TICKET_PRIORITIES, TICKET_STATES, TICKET_TYPES } from "./ticket.js";

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

function offsetOfLine(doc, index) {
  const text = typeof doc === "string" ? doc : "";
  let line = 0;
  let start = 0;
  for (let i = 0; i <= text.length; i += 1) {
    if (i === text.length || text[i] === "\n") {
      if (line === index) return start;
      line += 1;
      start = i + 1;
      if (i === text.length) break;
    }
  }
  return -1;
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
const REPO_KEY = "viewmark.repo";
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

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
    else for (const part of block.parts) el.appendChild(part.type === "image" ? renderImage(part) : renderRun(part));
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

// A caret sits between characters. Take the word touching that boundary, or
// stay put when both sides are whitespace.
function wordSpan(doc, offset) {
  const at = Math.max(0, Math.min(doc.length, offset));
  if (at > 0 && !/\s/.test(doc[at - 1])) {
    let start = at;
    let end = at;
    while (start > 0 && !/\s/.test(doc[start - 1])) start -= 1;
    while (end < doc.length && !/\s/.test(doc[end])) end += 1;
    return [start, end];
  }
  if (at < doc.length && !/\s/.test(doc[at])) {
    let end = at;
    while (end < doc.length && !/\s/.test(doc[end])) end += 1;
    return [at, end];
  }
  return [at, at];
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
  const expandedTickets = new Set();
  let ticketForm = null;
  const ticketPickers = [];
  let ticketPointerBound = false;
  let ticketChrome = null;
  let ticketBlockEl = null;
  let ticketDrawerEnter = null;
  let ticketDrawerLeave = null;
  let ticketDrawerTimer = null;
  let ticketSort = null;
  const wiredSortButtons = new WeakSet();
  let activeRepo = "";
  let repoSelect = null;
  let repoOnChange = null;
  let docMenuButton = null;
  let docMenuPanel = null;
  let repoCommitButton = null;
  let docLinkButton = null;
  let docMenuOnClick = null;
  let repoCommitOnClick = null;
  let docLinkOnClick = null;
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
  // Create is answered by its own error or by the file from onOpen.
  // A 409 for that create is not a rejected caret grant.
  const conflictWaiters = [];
  const fileWaiters = [];
  // The hub rejects an edit that repeats the mirror rev. Remember the op and
  // send it after this actor's doc advances rev and the caret.
  const pendingEdits = [];
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
  let pasteSeen = false;
  let composing = false;
  let composed = "";

  function lineSet(anchor, cursor) {
    const from = Math.min(anchor, cursor);
    const to = Math.max(anchor, cursor);
    const start = lineIndexAt(state.doc, from);
    const end = lineIndexAt(state.doc, to);
    const lines = [];
    for (let i = start; i <= end; i += 1) lines.push(i);
    return lines;
  }
  sentLines = lineSet(state.anchor, state.cursor);

  function selfName() {
    return typeof active.username === "string" ? active.username : "";
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
    if (type === "edit" || type === "undo" || type === "redo") conflictWaiters.push("edit");
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
    return conflictWaiters.includes("edit");
  }

  function dropPendingEdits() {
    pendingEdits.length = 0;
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
    emit({
      type: "edit",
      anchor: state.anchor,
      cursor: state.cursor,
      ...partial,
    });
  }

  function emitEdit(partial) {
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
  function pointFor(offset) {
    let atEnd = null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.closest(".md-atom") || node.parentElement?.closest(".md-lock")) continue;
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

  function placeCaret() {
    const sel = window.getSelection();
    if (!sel) return;
    // Chromium focuses the editing host when a range is added.
    const active = typeof document !== "undefined" && document ? document.activeElement : null;
    if (active && active.nodeType === 1 && active !== root && !root.contains(active)) return;
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
    if (!sel || sel.rangeCount === 0) return true;
    const holder = sel.anchorNode || sel.getRangeAt(0).commonAncestorContainer;
    if (!holder || !root.contains(holder)) return true;
    const mapped = selectionFromDom(sel);
    if (!mapped) return true;
    state = { ...state, anchor: mapped.anchor, cursor: mapped.cursor };
    return claimLines(mapped.anchor, mapped.cursor);
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
    const stored = record ? splitCommentNote(record.raw).text : "";
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
    emitEdit({ op: "comment.delete", id });
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
      if (child === docMenuButton || child === docMenuPanel) continue;
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
      }
      setStyle(commentsAside, "height", "");
      return;
    }
    const asideRect = elementRect(commentsAside);
    if (!asideRect || typeof cards[0].getBoundingClientRect !== "function") return;
    const spans = findSpans(state.doc);
    // The menu button is out of flow. A hidden row still reports offsetHeight, so it must not raise the floor.
    const menuHeight = docMenuButton && typeof docMenuButton.offsetHeight === "number" ? docMenuButton.offsetHeight : 0;
    let floor = menuHeight + COMMENT_CARD_GAP;
    const resolvedRow = findClassChild(commentsAside, "md-show-resolved");
    if (resolvedRow && !resolvedRow.hidden) {
      const rowHeight = typeof resolvedRow.offsetHeight === "number" ? resolvedRow.offsetHeight : 0;
      floor = Math.max(menuHeight, rowHeight) + COMMENT_CARD_GAP;
    }
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
  }

  function clearCurrentComment() {
    currentCommentId = null;
    if (!commentsAside) return;
    const walk = (node) => {
      if (!node) return;
      if (node.classList && node.classList.contains("md-comment-card")) setCommentActions(node, false);
      if (node.classList && node.classList.contains("md-comment-current")) node.classList.remove("md-comment-current");
      for (const child of node.childNodes || []) walk(child);
    };
    walk(commentsAside);
  }

  function lockNames(block) {
    const start = Number(block.start);
    const end = Number(block.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
    const names = [];
    for (const line of lockTable) {
      if (!line || typeof line.username !== "string" || line.username === "" || line.username === selfName()) continue;
      const at = offsetOfLine(state.doc, line.index);
      if (at >= start && at <= end) names.push(line.username);
    }
    return names;
  }

  function render() {
    const planned = plan(state.doc, state.cursor);
    const nodes = planned.blocks.map((block) => {
      const el = renderBlock(block);
      for (const name of lockNames(block)) {
        const mark = document.createElement("span");
        mark.className = "md-lock";
        mark.contentEditable = "false";
        mark.textContent = name;
        el.appendChild(mark);
      }
      return el;
    });
    root.replaceChildren(...nodes);
    markEditingHighlights();
    renderCommentAside(planned.comments);
    layoutComments();
    if (commentFocus) focusComment(commentFocus.id, commentFocus.start, commentFocus.end, commentFocus.note);
    else placeCaret();
    updateCommentButton();
    if (scrollCommentId) {
      const card = findCommentCard(scrollCommentId);
      scrollCommentId = null;
      if (card && typeof card.scrollIntoView === "function") card.scrollIntoView();
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
    return findClassChild(findClassChild(nav, "file-block"), "file-tree") || findClassChild(nav, "file-tree");
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

  function renderFileTree(files, seed) {
    fileList = Array.isArray(files) ? files : [];
    const nav = filesNav();
    if (!nav || typeof document === "undefined" || typeof document.createElement !== "function") return;
    const block = ensureFileBlock(nav);
    let tree = findClassChild(block, "file-tree") || findClassChild(nav, "file-tree");
    if (!tree) {
      tree = document.createElement("div");
      tree.className = "file-tree";
    }
    const field = findClassChild(block, "md-new-name") || findDeep(block, "md-new-name");
    const head = findClassChild(block, "md-pane-head");
    if (field) placeAfter(block, field, tree);
    else if (head) placeAfter(block, head, tree);
    else block.appendChild(tree);
    bindTreeDrop(tree);
    if (!tree || typeof tree.replaceChildren !== "function") return;
    if (seed) seedOpen(openPath);
    tree.replaceChildren(...renderEntries(buildFileTree(fileList)));
  }

  function clampCaret(pos, length) {
    const value = Number.isFinite(pos) ? Math.trunc(pos) : 0;
    return Math.max(0, Math.min(length, value));
  }

  function shiftPos(pos, message) {
    const from = Number(message.from);
    const to = Number(message.to);
    const inserted = typeof message.inserted === "string" ? message.inserted : "";
    if (!Number.isFinite(from) || !Number.isFinite(to)) return pos;
    const delta = inserted.length - (to - from);
    if (pos >= to) return pos + delta;
    return pos;
  }

  function noteFreshComment(previousDoc, message) {
    if (!expectNewComment) return;
    expectNewComment = false;
    if (message.actor !== selfName()) return;
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
    if (message.type === "file" || message.actor === selfName()) {
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
          if (line && line.username === selfName() && Number.isFinite(line.index)) held.add(line.index);
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
      render();
      return;
    }
    if (message.type === "error") {
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
        if (waiter === "edit") dropPendingEdits();
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
      if (typeof message.path === "string" && message.path) {
        seedOpen(message.path);
        renderFileTree(fileList, false);
      }
    }
    let ownEdit = false;
    if (message.type === "doc") {
      if (waitingForFile) return;
      const nextRev = Number(message.rev);
      if (!Number.isFinite(nextRev) || nextRev !== rev + 1) {
        waitingForFile = true;
        expectNewComment = false;
        dropPendingEdits();
        dropEditWaiters();
        emit({ type: "open", path: openPath });
        return;
      }
      if (message.actor === selfName()) {
        const index = conflictWaiters.indexOf("edit");
        if (index >= 0) {
          conflictWaiters.splice(index, 1);
          ownEdit = true;
        }
      }
    }
    if (message.type === "doc" || message.type === "file") applySnapshot(message);
    if (message.type === "file") syncFileTicket(message);
    if (ownEdit) flushPendingEdit();
  }

  function consumePaste(text) {
    if (pasteSeen) return;
    pasteSeen = true;
    if (!adoptDomSelection()) {
      queueMicrotask(() => {
        pasteSeen = false;
      });
      return;
    }
    if (text) emitEdit({ op: "insert", text });
    queueMicrotask(() => {
      pasteSeen = false;
    });
  }

  function moveCaret(direction, granularity, extend) {
    const sel = window.getSelection();
    if (!sel) return;
    if (sel.rangeCount === 0) placeCaret();
    const beforeCursor = state.cursor;
    const beforeAnchor = state.anchor;
    const before = lineIndexAt(state.doc, beforeCursor);
    // modify("move") on an extended range collapses to the focus and does not advance.
    const caretPoint = pointFor(state.cursor);
    if (caretPoint) sel.collapse(caretPoint.node, caretPoint.offset);
    sel.modify("move", direction, granularity);
    if (sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const landed = mapOffset(range.startContainer, range.startOffset);
    const next = placeMove(state.doc, beforeCursor, landed, direction, granularity);
    const anchor = extend ? beforeAnchor : next;
    state = { ...state, cursor: next, anchor };
    if (!claimLines(anchor, next)) return;
    const after = lineIndexAt(state.doc, state.cursor);
    if (before !== after) render();
    else if (anchor !== next || next !== landed) placeCaret();
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
  // the source line start. The newline sits on the previous line; the hub
  // rejects the splice unless that line is held too.
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
    if (state.anchor === state.cursor && state.cursor > 0 && state.doc[state.cursor - 1] === "\n") {
      return claimLines(state.cursor - 1, state.cursor);
    }
    return true;
  }

  // coveringSplice keeps a shared run of newlines in the prefix, so the
  // inserted break lands after that run. Hold every line the splice touches.
  function claimFollowingBreaks() {
    if (state.anchor !== state.cursor) return true;
    let at = state.cursor;
    while (at < state.doc.length && state.doc[at] === "\n") at += 1;
    if (at === state.cursor) return true;
    return claimLines(state.cursor, at);
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
    if (type === "insertText") {
      if (event.data === "\t") return;
      if (event.data === "\n") {
        if (event.data === composed) return;
        if (!claimFollowingBreaks()) return;
        emitEdit({ op: "insert", text: "\n" });
        return;
      }
      if (event.data && event.data !== composed) emitEdit({ op: "insert", text: event.data });
      return;
    }
    if (type === "insertCompositionText" || type === "insertFromComposition") return;
    if (type === "insertParagraph" || type === "insertLineBreak") {
      if (!claimFollowingBreaks()) return;
      emitEdit({ op: "insert", text: "\n" });
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
        if (start === end) {
          // The normalized splice deletes the later newline and the next line.
          // Backspace the preceding break and hold that line. A leading empty
          // line still deletes forward, but the next line has to be held.
          if (state.cursor > 0) {
            const through = Math.min(state.doc.length, state.cursor + 1);
            if (!claimLines(state.cursor - 1, through)) return;
            emitEdit({ op: "backspace" });
            return;
          }
          if (!claimLines(0, 1)) return;
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
      const edges = wordEdges(state.doc, state.cursor, type === "deleteWordBackward" ? -1 : 1);
      const [from, to] = expandAtoms(state.doc, edges[0], edges[1], state.cursor);
      if (from !== to) emitEdit({ op: "delete", anchor: from, cursor: to });
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
    if (!adoptDomSelection()) return;
    const text = selectedSlice(state);
    event.clipboardData.setData("text/plain", text);
    if (state.anchor !== state.cursor) emitEdit({ op: "delete" });
  });

  listen("compositionstart", () => {
    composing = true;
  });

  listen("compositionend", (event) => {
    composing = false;
    composed = event.data || "";
    if (adoptDomSelection() && composed) emitEdit({ op: "insert", text: composed });
    queueMicrotask(() => {
      composed = "";
    });
  });

  listen("keydown", (event) => {
    commentFocus = null;
    if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      if (!adoptDomSelection()) return;
      emitEdit({ op: "insert", text: "\t" });
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
    if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const extend = event.shiftKey === true && !event.ctrlKey && !event.altKey && !event.metaKey;
      const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
      const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
      moveCaret(forward ? "forward" : "backward", horizontal ? "character" : "line", extend);
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
    state = { ...state, anchor: mapped.anchor, cursor: mapped.cursor };
    if (!claimLines(mapped.anchor, mapped.cursor)) return;
    const after = lineIndexAt(state.doc, state.cursor);
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
    const atom = target?.closest?.(".md-atom");
    if (atom && root.contains(atom)) {
      event.preventDefault();
      if (!keepCurrent) currentCommentId = null;
      const next = atomClickOffset(atom, target);
      state = { ...state, anchor: next, cursor: next };
      if (!claimLines(next, next)) return;
      render();
      return;
    }
    if (!keepCurrent) clearCurrentComment();
    if (typeof document.caretPositionFromPoint !== "function") return;
    const pos = document.caretPositionFromPoint(event.clientX, event.clientY);
    if (!pos) return;
    const offset = mapOffset(pos.offsetNode, pos.offset);
    let anchor = offset;
    let cursor = offset;
    if (event.detail === 2) {
      const span = wordSpan(state.doc, offset);
      anchor = span[0];
      cursor = span[1];
    } else if (event.detail === 3) {
      const span = lineSpan(state.doc, offset);
      anchor = span[0];
      cursor = span[1];
    }
    state = { ...state, anchor, cursor };
    if (!claimLines(anchor, cursor)) return;
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
    window.addEventListener("resize", () => layoutComments(), { signal: ac.signal });
    window.addEventListener("hashchange", () => onHashChange(), { signal: ac.signal });
  }

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

  function onTicketPointerDown(event) {
    const target = event && event.target;
    for (const picker of ticketPickers) picker.dismissOutside(target);
    if (!docMenuPanel || docMenuPanel.hidden) return;
    // Pointerdown on the button or inside the panel belongs to the click handler.
    if (nodeWithin(docMenuPanel, target) || nodeWithin(docMenuButton, target)) return;
    hideElement(docMenuPanel);
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
      valueNode.appendChild(makeIconButton(
        "Delete ticket",
        ICON_PATHS.delete[0],
        "icon-btn danger md-ticket-delete",
        () => showConfirm(id, () => emit({ type: "ticket.delete", id })),
      ));
      row.append(fieldName("Id"), valueNode);
      return row;
    }

    const relied = document.createElement("div");
    relied.className = "md-ticket-relied";
    const reliedBox = document.createElement("div");
    reliedBox.className = "md-ticket-links";
    const reliedTickets = ticketList
      .filter((item) => item.id !== ticket.id && Array.isArray(item.depends) && item.depends.includes(ticket.id))
      .sort(compareTickets);
    if (reliedTickets.length === 0) {
      reliedBox.textContent = "(none)";
    } else {
      for (const other of reliedTickets) {
        const button = plainButton("md-ticket-rely", other.title || other.id);
        button.dataset.id = other.id;
        button.addEventListener("click", (event) => {
          if (event && typeof event.preventDefault === "function") event.preventDefault();
          openDocument(`tickets/${other.id}.md`, null, true);
        });
        reliedBox.appendChild(button);
      }
    }
    relied.append(fieldName("Blocks"), reliedBox);

    const fields = document.createElement("div");
    fields.className = "md-ticket-column";
    fields.append(heading, titleInput, stateField.label, typeField.label, priorityField.label, parentField, depends, children);
    const facts = document.createElement("div");
    facts.className = "md-ticket-column";
    facts.append(
      idFactRow(ticket.id),
      factRow("Reporter", "md-ticket-reporter", ticket.reporter),
      factRow("Created", "md-ticket-created", ticket.created),
      relied,
    );
    form.replaceChildren(fields, facts);
    if (selectWidth > 0) {
      const extra = selectChromeGap(sized);
      if (extra > 0) paintSelectWidth(sized, selectWidth + extra);
    }
    if (ticket.title === "New ticket") {
      hideElement(heading);
      showElement(titleInput);
      if (typeof titleInput.focus === "function") titleInput.focus();
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
    const binding = { button, onClick, filterButton, onFilter, boxes, onChange, showAll, onShowAll };
    ticketBindings.set(button, binding);
    ticketChrome = binding;
  }

  let newFileButton = null;
  let newFileOnClick = null;

  function hideNameField(field) {
    field.hidden = true;
    if (typeof field.setAttribute === "function") field.setAttribute("hidden", "");
  }

  function unbindNewFile() {
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
    if (!docLinkButton) return;
    if (activeRepo && openPath) showElement(docLinkButton);
    else hideElement(docLinkButton);
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
    docMenuOnClick = null;
    repoCommitOnClick = null;
    docLinkOnClick = null;
    docMenuBound = false;
  }

  function ensureDocMenu() {
    if (!commentsAside || typeof document === "undefined" || typeof document.createElement !== "function") return;
    if (!docMenuButton || docMenuButton.parentElement !== commentsAside) {
      docMenuButton = findClassChild(commentsAside, "md-doc-menu");
    }
    if (!docMenuButton) {
      const button = iconButton("menu", "md-doc-menu");
      if (typeof button.setAttribute === "function") button.setAttribute("aria-label", "Menu");
      commentsAside.appendChild(button);
      docMenuButton = button;
    }
    if (!docMenuPanel || docMenuPanel.parentElement !== commentsAside) {
      docMenuPanel = findClassChild(commentsAside, "md-doc-menu-panel");
    }
    if (!docMenuPanel) {
      const panel = document.createElement("div");
      panel.className = "md-doc-menu-panel";
      hideElement(panel);
      commentsAside.appendChild(panel);
      docMenuPanel = panel;
    }
    if (!repoCommitButton || repoCommitButton.parentElement !== docMenuPanel) {
      repoCommitButton = findClassChild(docMenuPanel, "md-doc-commit");
    }
    if (!repoCommitButton) {
      const commit = document.createElement("button");
      commit.type = "button";
      commit.className = "md-doc-commit";
      commit.textContent = "Commit repo";
      if (typeof commit.setAttribute === "function") commit.setAttribute("type", "button");
      hideElement(commit);
      docMenuPanel.appendChild(commit);
      repoCommitButton = commit;
    }
    if (!docLinkButton || docLinkButton.parentElement !== docMenuPanel) {
      docLinkButton = findClassChild(docMenuPanel, "md-doc-link");
    }
    if (!docLinkButton) {
      const entry = document.createElement("button");
      entry.type = "button";
      entry.className = "md-doc-link";
      entry.textContent = "link to this entry";
      if (typeof entry.setAttribute === "function") entry.setAttribute("type", "button");
      hideElement(entry);
      if (repoCommitButton && repoCommitButton.parentElement === docMenuPanel) placeNodeBefore(docMenuPanel, entry, repoCommitButton);
      else docMenuPanel.appendChild(entry);
      docLinkButton = entry;
    }
    if (!docMenuBound) {
      const previousMenu = docMenuBindings.get(docMenuButton);
      if (previousMenu && typeof docMenuButton.removeEventListener === "function") {
        docMenuButton.removeEventListener("click", previousMenu);
      }
      docMenuOnClick = (event) => {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        if (!docMenuPanel) return;
        if (docMenuPanel.hidden) showElement(docMenuPanel);
        else hideElement(docMenuPanel);
      };
      if (typeof docMenuButton.addEventListener === "function") docMenuButton.addEventListener("click", docMenuOnClick);
      docMenuBindings.set(docMenuButton, docMenuOnClick);
      const previousCommit = docCommitBindings.get(repoCommitButton);
      if (previousCommit && typeof repoCommitButton.removeEventListener === "function") {
        repoCommitButton.removeEventListener("click", previousCommit);
      }
      repoCommitOnClick = (event) => {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        if (docMenuPanel) hideElement(docMenuPanel);
        if (!activeRepo) return;
        // A checkpoint is not a conflict waiter and carries no rev.
        emit({ type: "commit" });
      };
      if (typeof repoCommitButton.addEventListener === "function") repoCommitButton.addEventListener("click", repoCommitOnClick);
      docCommitBindings.set(repoCommitButton, repoCommitOnClick);
      const previousLink = docLinkBindings.get(docLinkButton);
      if (previousLink && docLinkButton && typeof docLinkButton.removeEventListener === "function") {
        docLinkButton.removeEventListener("click", previousLink);
      }
      docLinkOnClick = (event) => {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        if (docMenuPanel) hideElement(docMenuPanel);
        copyEntryLink();
      };
      if (docLinkButton && typeof docLinkButton.addEventListener === "function") docLinkButton.addEventListener("click", docLinkOnClick);
      if (docLinkButton) docLinkBindings.set(docLinkButton, docLinkOnClick);
      docMenuBound = true;
    }
    bindTicketPointer();
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
    destroy() {
      closed = true;
      unsubscribe();
      unbindRepoSelect();
      unbindDocMenu();
      unbindNewFile();
      unbindTickets();
      unbindTreeDrop();
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
  dialog.open = false;
  if (typeof dialog.close === "function") dialog.close();
  else if (typeof dialog.removeAttribute === "function") dialog.removeAttribute("open");
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
      socketFactory: env.socketFactory,
      location: env.location || globalThis.location,
    });
    const editor = createEditor(root, "", 0, transport, storage);
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
