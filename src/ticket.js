export const TICKET_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

export const TICKET_STATES = Object.freeze(["new", "triaged", "in progress", "closed"]);

const KEYS = ["title", "state", "parent", "depends", "reporter", "created"];

const CREATED_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const BREAK = /[\r\n\t]/;

function isId(value) {
  if (typeof value !== "string" || value.length !== 8) return false;
  for (let i = 0; i < value.length; i += 1) {
    if (!TICKET_ALPHABET.includes(value[i])) return false;
  }
  return true;
}

function presentId(id) {
  return typeof id === "string" && id.length > 0;
}

export function generateId(random = Math.random) {
  const size = TICKET_ALPHABET.length;
  let id = "";
  for (let i = 0; i < 8; i += 1) {
    let index = Math.floor(random() * size);
    if (!Number.isFinite(index) || index < 0) index = 0;
    else if (index >= size) index = size - 1;
    id += TICKET_ALPHABET[index];
  }
  return id;
}

function parseHeader(header) {
  const lines = header.split("\n");
  if (lines.length !== KEYS.length) return null;
  const values = {};
  for (let i = 0; i < KEYS.length; i += 1) {
    const key = KEYS[i];
    const line = lines[i];
    if (line === `${key}:`) {
      values[key] = "";
      continue;
    }
    const prefix = `${key}: `;
    if (!line.startsWith(prefix)) return null;
    values[key] = line.slice(prefix.length).trim();
  }
  return values;
}

function parseDepends(value) {
  if (value === "") return [];
  const parts = value.split(" ").filter((part) => part.length > 0);
  for (const part of parts) {
    if (!isId(part)) return null;
  }
  return [...new Set(parts)].sort();
}

function validateFields(fields) {
  const title = typeof fields.title === "string" ? fields.title.trim() : null;
  if (title === null || title.length < 1 || title.length > 200 || BREAK.test(title)) return null;

  const state = typeof fields.state === "string" ? fields.state.trim() : "";
  if (!TICKET_STATES.includes(state)) return null;

  const parent = typeof fields.parent === "string" ? fields.parent.trim() : null;
  if (parent === null || (parent !== "" && !isId(parent))) return null;

  if (!Array.isArray(fields.depends)) return null;
  const depends = [];
  for (const dep of fields.depends) {
    if (!isId(dep)) return null;
    depends.push(dep);
  }

  const reporter = typeof fields.reporter === "string" ? fields.reporter.trim() : "";
  if (reporter.length === 0 || BREAK.test(reporter)) return null;

  const created = typeof fields.created === "string" ? fields.created.trim() : "";
  if (!CREATED_RE.test(created)) return null;

  if (typeof fields.body !== "string") return null;

  return {
    title,
    state,
    parent,
    depends: [...new Set(depends)].sort(),
    reporter,
    created,
    body: fields.body,
  };
}

function writeField(key, value) {
  return value === "" ? `${key}:` : `${key}: ${value}`;
}

// The header is six single lines. The first blank line ends it; everything
// after that is markdown and can contain blank lines and header-shaped text.
export function parseTicket(id, text) {
  if (!isId(id) || typeof text !== "string") return null;
  const splitAt = text.indexOf("\n\n");
  if (splitAt < 0) return null;
  const header = parseHeader(text.slice(0, splitAt));
  if (!header) return null;
  const depends = parseDepends(header.depends);
  if (depends === null) return null;
  const fields = validateFields({
    title: header.title,
    state: header.state,
    parent: header.parent,
    depends,
    reporter: header.reporter,
    created: header.created,
    body: text.slice(splitAt + 2),
  });
  if (!fields) return null;
  return { id, ...fields };
}

export function composeTicket(ticket) {
  if (!ticket || typeof ticket !== "object" || !isId(ticket.id)) return null;
  const fields = validateFields(ticket);
  if (!fields) return null;
  const lines = [
    writeField("title", fields.title),
    writeField("state", fields.state),
    writeField("parent", fields.parent),
    writeField("depends", fields.depends.join(" ")),
    writeField("reporter", fields.reporter),
    writeField("created", fields.created),
  ];
  return `${lines.join("\n")}\n\n${fields.body}`;
}

function parentCloses(graph, start) {
  let current = start;
  const seen = new Set();
  while (!seen.has(current)) {
    seen.add(current);
    const node = graph.get(current);
    if (!node) return false;
    const next = node.parent ?? "";
    if (next === "") return false;
    if (next === start) return true;
    current = next;
  }
  return false;
}

function dependsCloses(graph, start) {
  const seen = new Set([start]);
  const pending = [...(graph.get(start)?.depends ?? [])];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === start) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    const node = graph.get(next);
    if (!node || !Array.isArray(node.depends)) continue;
    for (const dep of node.depends) pending.push(dep);
  }
  return false;
}

// A one-node loop is "self", not "cycle", and it is not a link to some other
// ticket. Parent links and depends links are walked separately so a ticket
// may depend on its own parent.
export function rejectLink(tickets, id, parent, depends) {
  const proposedParent = parent ?? "";
  const proposedDepends = depends ?? [];
  const hasId = presentId(id);

  if (hasId && (proposedParent === id || proposedDepends.includes(id))) return "self";

  const graph = new Map();
  for (const ticket of tickets) {
    graph.set(ticket.id, {
      parent: ticket.parent ?? "",
      depends: Array.isArray(ticket.depends) ? [...ticket.depends] : [],
    });
  }
  if (hasId) graph.set(id, { parent: proposedParent, depends: [...proposedDepends] });

  if (proposedParent !== "" && (!graph.has(proposedParent) || proposedParent === id)) return "missing";
  for (const dep of proposedDepends) {
    if (!graph.has(dep) || dep === id) return "missing";
  }

  if (!hasId) return null;
  if (parentCloses(graph, id)) return "cycle";
  if (dependsCloses(graph, id)) return "cycle";
  return null;
}
