export const TICKET_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

export const TICKET_STATES = Object.freeze(["new", "triaged", "in progress", "blocked", "pending review", "closed"]);

export const TICKET_TYPES = Object.freeze(["bug", "enhancement", "task"]);

export const TICKET_PRIORITIES = Object.freeze(["low", "medium", "high"]);

const KEYS = ["title", "state", "type", "priority", "parent", "depends", "reporter", "created"];

const CREATED_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const BREAK = /[\r\n\t]/;

function isId(value) {
  if (typeof value !== "string" || value.length !== 8) return false;
  for (let i = 0; i < value.length; i += 1) {
    if (!TICKET_ALPHABET.includes(value[i])) return false;
  }
  return true;
}

// A letter or digit, then up to 63 more of those, underscore, or hyphen. Same
// shape as a registered repo name, so a token's repo is not a narrower name.
export const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// A bare id, or repo:id. The bare id stays bare: saving does not add a repo.
export function parseTicketToken(value) {
  if (isId(value)) return { repo: "", id: value };
  if (typeof value !== "string") return null;
  const split = value.indexOf(":");
  if (split <= 0 || split !== value.lastIndexOf(":")) return null;
  const repo = value.slice(0, split);
  const id = value.slice(split + 1);
  if (!REPO_NAME.test(repo) || !isId(id)) return null;
  return { repo, id };
}

export function isTicketToken(value) {
  return parseTicketToken(value) !== null;
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

function readField(line, key) {
  if (line === `${key}:`) return "";
  const prefix = `${key}: `;
  if (!line.startsWith(prefix)) return null;
  return line.slice(prefix.length).trim();
}

// Assignee is optional and only legal between priority and parent. An absent
// line is unassigned, so a file that never had one stays byte-identical.
function parseHeader(header) {
  const lines = header.split("\n");
  const values = { assignee: "" };
  let index = 0;
  for (const key of KEYS) {
    if (key === "parent" && index < lines.length) {
      const optional = readField(lines[index], "assignee");
      if (optional !== null) {
        values.assignee = optional;
        index += 1;
      }
    }
    if (index >= lines.length) return null;
    const value = readField(lines[index], key);
    if (value === null) return null;
    values[key] = value;
    index += 1;
  }
  if (index !== lines.length) return null;
  return values;
}

function parseDepends(value) {
  if (value === "") return [];
  const parts = value.split(" ").filter((part) => part.length > 0);
  for (const part of parts) {
    if (!isTicketToken(part)) return null;
  }
  return [...new Set(parts)].sort();
}

function validateFields(fields) {
  const title = typeof fields.title === "string" ? fields.title.trim() : null;
  if (title === null || title.length < 1 || title.length > 200 || BREAK.test(title)) return null;

  const state = typeof fields.state === "string" ? fields.state.trim() : "";
  if (!TICKET_STATES.includes(state)) return null;

  const type = typeof fields.type === "string" ? fields.type.trim() : "";
  if (!TICKET_TYPES.includes(type)) return null;

  const priority = typeof fields.priority === "string" ? fields.priority.trim() : "";
  if (!TICKET_PRIORITIES.includes(priority)) return null;

  let assignee = "";
  if (fields.assignee != null) {
    if (typeof fields.assignee !== "string" || BREAK.test(fields.assignee)) return null;
    assignee = fields.assignee.trim();
  }

  const parent = typeof fields.parent === "string" ? fields.parent.trim() : null;
  if (parent === null || (parent !== "" && !isTicketToken(parent))) return null;

  if (!Array.isArray(fields.depends)) return null;
  const depends = [];
  for (const dep of fields.depends) {
    if (!isTicketToken(dep)) return null;
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
    type,
    priority,
    assignee,
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

// The first blank line ends the header. Everything after that is markdown
// and can contain blank lines and header-shaped text.
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
    type: header.type,
    priority: header.priority,
    assignee: header.assignee,
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
    writeField("type", fields.type),
    writeField("priority", fields.priority),
  ];
  if (fields.assignee !== "") lines.push(writeField("assignee", fields.assignee));
  lines.push(
    writeField("parent", fields.parent),
    writeField("depends", fields.depends.join(" ")),
    writeField("reporter", fields.reporter),
    writeField("created", fields.created),
  );
  return `${lines.join("\n")}\n\n${fields.body}`;
}

function parentCloses(graph, start) {
  let current = start;
  const seen = new Set();
  while (current && !seen.has(current)) {
    seen.add(current);
    const node = graph.get(current);
    if (!node) return false;
    const next = node.parent;
    if (!next) return false;
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
    if (!next) continue;
    if (next === start) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    const node = graph.get(next);
    if (!node || !Array.isArray(node.depends)) continue;
    for (const dep of node.depends) pending.push(dep);
  }
  return false;
}

// A list is one repo with no name. { home, repos, tickets } is every registered repo.
function linkScope(tickets) {
  if (tickets && typeof tickets === "object" && !Array.isArray(tickets)
    && Array.isArray(tickets.tickets) && Array.isArray(tickets.repos)) {
    const registered = new Set();
    for (const name of tickets.repos) {
      if (typeof name === "string") registered.add(name);
    }
    return {
      home: typeof tickets.home === "string" ? tickets.home : "",
      registered,
      list: tickets.tickets,
    };
  }
  return {
    home: "",
    registered: new Set([""]),
    list: Array.isArray(tickets) ? tickets : [],
  };
}

function fileRepo(ticket, home) {
  if (ticket && typeof ticket.repo === "string" && ticket.repo !== "") return ticket.repo;
  return home;
}

function nodeKey(repo, id) {
  return `${repo}:${id}`;
}

// A bare id belongs to the file that stores it. repo:id names that repo.
// An unregistered name is not a node: the walk stops there.
function classify(token, fileRepoName, registered) {
  if (token === "") return "";
  const parsed = parseTicketToken(token);
  if (!parsed) return null;
  const repo = parsed.repo || fileRepoName;
  if (!registered.has(repo)) return "";
  return nodeKey(repo, parsed.id);
}

function namesSelf(token, id, home) {
  if (typeof token !== "string" || !presentId(id)) return false;
  if (token === id) return true;
  return Boolean(home) && token === `${home}:${id}`;
}

// A one-node loop is "self", not "cycle", and it is not a link to some other
// ticket. Parent links and depends links are walked separately so a ticket
// may depend on its own parent. A bare id is qualified with the file's repo.
// "missing" is only an id absent from a registered repo. An unregistered name
// is stored and ends the walk. dropStoredMissing takes a stored missing token
// off before this runs. A missing token the set itself adds is still "missing".
export function rejectLink(tickets, id, parent, depends) {
  const proposedParent = parent ?? "";
  const proposedDepends = depends ?? [];
  const scope = linkScope(tickets);
  const home = scope.home;
  const hasId = presentId(id);

  if (hasId && (namesSelf(proposedParent, id, home) || proposedDepends.some((dep) => namesSelf(dep, id, home)))) {
    return "self";
  }

  const graph = new Map();
  for (const ticket of scope.list) {
    if (!ticket || typeof ticket !== "object" || typeof ticket.id !== "string") continue;
    const repo = fileRepo(ticket, home);
    if (!scope.registered.has(repo)) continue;
    const storedParent = typeof ticket.parent === "string" ? ticket.parent : "";
    const storedDepends = Array.isArray(ticket.depends) ? ticket.depends : [];
    graph.set(nodeKey(repo, ticket.id), {
      parent: classify(storedParent, repo, scope.registered),
      depends: storedDepends.map((dep) => classify(dep, repo, scope.registered)),
    });
  }
  if (hasId) {
    graph.set(nodeKey(home, id), {
      parent: classify(proposedParent, home, scope.registered),
      depends: [...proposedDepends].map((dep) => classify(dep, home, scope.registered)),
    });
  }

  const missing = (token) => {
    if (token === "") return false;
    const key = classify(token, home, scope.registered);
    if (key === "") return false;
    return key === null || !graph.has(key);
  };
  if (missing(proposedParent)) return "missing";
  for (const dep of proposedDepends) {
    if (missing(dep)) return "missing";
  }

  if (!hasId) return null;
  const start = nodeKey(home, id);
  if (parentCloses(graph, start)) return "cycle";
  if (dependsCloses(graph, start)) return "cycle";
  return null;
}

function presentKeys(scope) {
  const present = new Set();
  for (const ticket of scope.list) {
    if (!ticket || typeof ticket !== "object" || typeof ticket.id !== "string") continue;
    const repo = fileRepo(ticket, scope.home);
    if (!scope.registered.has(repo)) continue;
    present.add(nodeKey(repo, ticket.id));
  }
  return present;
}

// A registered repo whose id is absent. Malformed and unregistered tokens are not.
function tokenAbsent(token, home, registered, present) {
  if (typeof token !== "string" || token === "") return false;
  const key = classify(token, home, registered);
  if (key === "" || key === null) return false;
  return !present.has(key);
}

// A stored link whose ticket is gone is removed with the set. A token this
// write adds stays, so rejectLink can still refuse it. An unregistered name stays.
export function dropStoredMissing(tickets, storedParent, storedDepends, parent, depends) {
  const scope = linkScope(tickets);
  const present = presentKeys(scope);
  const gone = (token) => tokenAbsent(token, scope.home, scope.registered, present);
  const nextParent = typeof parent === "string" ? parent : "";
  const nextDepends = Array.isArray(depends) ? depends : [];
  const keptParent = typeof storedParent === "string" ? storedParent : "";
  const keptDepends = new Set(Array.isArray(storedDepends) ? storedDepends : []);
  return {
    parent: nextParent === keptParent && gone(nextParent) ? "" : nextParent,
    depends: nextDepends.filter((dep) => !(keptDepends.has(dep) && gone(dep))),
  };
}
